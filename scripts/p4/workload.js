"use strict";
/**
 * scripts/p4/workload.js
 * P4 Workload Generator & Ledger Stream Runner
 *
 * Mendukung eksekusi beban checkout konkuren (default 100 VUs)
 * dan mencatat seluruh transaksi ke external ledger (JSONL) pada host filesystem.
 */

const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { responseAccepted } = require("./workload-policy");
const {
  DEFAULT_LEDGER_PATH,
  recordTransaction,
  attachLedgerStream,
} = require("./ledger");

async function sendCheckoutRequest(baseUrl, payload, key) {
  return new Promise((resolve) => {
    const url = new URL(`${baseUrl}/checkout`);
    const data = JSON.stringify(payload);
    const startMs = Date.now();
    const finish = (result) => resolve({ ...result,
      requestTimestamp: new Date(startMs).toISOString(), responseTimestamp: new Date().toISOString() });

    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "Idempotency-Key": key,
        },
        timeout: 10000,
      },
      (res) => {
        let bodyRaw = "";
        res.on("data", (chunk) => (bodyRaw += chunk));
        res.on("end", () => {
          let body = null;
          try {
            body = JSON.parse(bodyRaw);
          } catch {}
          finish({
            status: res.statusCode,
            body,
            latencyMs: Date.now() - startMs,
          });
        });
        res.on("error", err => finish({ status: 0, error: err.message, body: null, latencyMs: Date.now() - startMs }));
        res.on("aborted", () => finish({ status: 0, error: "RESPONSE_ABORTED", body: null, latencyMs: Date.now() - startMs }));
      },
    );

    req.on("error", (err) => {
      finish({
        status: 0,
        error: err.message,
        body: null,
        latencyMs: Date.now() - startMs,
      });
    });

    req.on("timeout", () => {
      req.destroy();
      finish({
        status: 0,
        error: "TIMEOUT",
        body: null,
        latencyMs: Date.now() - startMs,
      });
    });

    req.write(data);
    req.end();
  });
}

/**
 * Menjalankan workload checkout berbasis worker pool internal Node.js
 */
async function runNodeWorkload(options = {}) {
  const baseUrl = options.baseUrl || "http://127.0.0.1:8080";
  const ledgerPath = options.ledgerPath || DEFAULT_LEDGER_PATH;
  const vus = Number(options.vus || 100);
  const totalIterations = Number(options.iterations || 200);
  const runId = options.runId || `p4-dr-${Date.now()}`;

  console.log(
    `[P4 WORKLOAD] Memulai checkout generator (${vus} VUs, ${totalIterations} iterations, target: ${baseUrl})`,
  );
  console.log(`[P4 WORKLOAD] Ledger destination: ${ledgerPath}`);

  let completed = 0;
  let currentIndex = 0;
  const activeWorkers = [];

  async function worker(workerId) {
    while (currentIndex < totalIterations) {
      const idx = currentIndex++;
      const key = `${runId}-w${workerId}-i${idx}`;
      const payload = {
        user_id: (idx % 100) + 1,
        product_id: 1,
        qty: 1,
      };

      const res = await sendCheckoutRequest(baseUrl, payload, key);
      recordTransaction(
        {
          idempotencyKey: key,
          timestamp: new Date().toISOString(),
          requestTimestamp: res.requestTimestamp,
          responseTimestamp: res.responseTimestamp,
          userId: payload.user_id,
          productId: payload.product_id,
          qty: payload.qty,
          status: res.status,
          body: res.body,
        },
        ledgerPath,
      );

      completed++;
    }
  }

  for (let w = 1; w <= vus; w++) {
    activeWorkers.push(worker(w));
  }

  await Promise.all(activeWorkers);
  console.log(
    `[P4 WORKLOAD] Selesai: ${completed} transaksi dicatat ke ledger.`,
  );
  return { completed, ledgerPath };
}

/**
 * Memulai workload k6 dengan handshake eksplisit dan bukti partisipasi VU pada ledger
 */
function startK6Workload(options = {}) {
  const baseUrl = options.baseUrl || "http://127.0.0.1:8080";
  const ledgerPath = options.ledgerPath || DEFAULT_LEDGER_PATH;
  const targetVUs = Number(options.vus || 100);
  const duration = options.duration || "60s";
  const runId = options.runId || `p4-dr-k6-${Date.now()}`;
  const scriptPath = path.resolve(
    __dirname,
    "../../tests/load/p4-dr-workload.js",
  );

  console.log(
    `[P4 K6 WORKLOAD] Memulai K6 (${targetVUs} VUs, durasi ${duration}, target: ${baseUrl})...`,
  );

  const observedVUs = new Set();
  let outageRequestedAt = null;
  let unexpectedResponseCount = 0;
  const seen = new Set();
  let handshakeReceived = false;
  let handshakeData = null;
  let stdoutRaw = "";
  let stderrRaw = "";
  let closed = false;
  let exited = false;
  let failure = null;
  let stopping = false;
  let stopTimer;
  const k6Proc = (options.spawn || spawn)(
    "k6",
    [
      "run",
      "--log-format=json",
      ...(options.summaryPath ? ["--summary-export", options.summaryPath] : []),
      scriptPath,
    ],
    {
      env: {
        ...process.env,
        P4_BASE_URL: baseUrl,
        P4_RUN_ID: runId,
        P4_VUS: String(targetVUs),
        P4_DURATION: duration,
        P4_PRODUCT_ID: String(options.productId || 1),
        P4_STOP_AFTER_OUTAGE: options.stopAfterOutage ? "1" : "0",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // close occurs only after both pipes drain; never settle on exit alone.
  let settle;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  function requestStop() {
    if (closed || exited || stopping) return;
    stopping = true;
    try {
      k6Proc.kill("SIGINT");
    } catch (err) {
      failure ||= err;
    }
    if (!stopTimer) {
      stopTimer = setTimeout(() => {
        if (!closed && !exited) {
          try {
            k6Proc.kill("SIGKILL");
          } catch (err) {
            failure ||= err;
          }
        }
      }, options.stopGraceMs ?? 2000);
    }
  }
  const parsers = ["stdout", "stderr"].map((name) =>
    attachLedgerStream(k6Proc[name], ledgerPath, {
      seen,
      write: options.recordTransaction,
      onChunk: (text) => {
        if (name === "stdout") stdoutRaw += text;
        else stderrRaw += text;
      },
      onLine: (line) => {
        if (line.includes("[K6_HANDSHAKE]")) {
          handshakeReceived = true;
          handshakeData = line.trim();
        }
      },
      onEntry: (entry) => {
        const match = entry.idempotencyKey.match(/-vu(\d+)-iter/);
        if (match) observedVUs.add(Number(match[1]));
        if (!responseAccepted(entry, options.stopAfterOutage ? outageRequestedAt : null)) unexpectedResponseCount++;
        options.onEntry?.(entry);
      },
      onError: (err) => {
        failure ||= new Error(`K6 ledger/output failure: ${err.message}`);
        requestStop();
      },
    }),
  );
  k6Proc.on("error", (err) => {
    failure ||= err;
    requestStop();
  });
  k6Proc.on("exit", () => {
    exited = true;
  });
  k6Proc.on("close", (code, signal) => {
    for (const parser of parsers) parser?.flush();
    if (!handshakeReceived)
      failure ||= new Error("K6 exited before startup handshake");
    closed = true;
    clearTimeout(stopTimer);
    settle({
      ok: code === 0 && !failure && unexpectedResponseCount === 0,
      code,
      signal,
      error: failure?.message || (unexpectedResponseCount ? `Unexpected or out-of-window checkout responses: ${unexpectedResponseCount}` : null),
      stdout: stdoutRaw,
      stderr: stderrRaw,
      observedVUsCount: observedVUs.size,
      vuEvidence: "distinct VU IDs observed in persisted ledger; not concurrent activity at injection",
      unexpectedResponseCount,
      outageRequestedAt,
      ledgerPath,
      handshakeReceived,
    });
  });

  async function waitUntil(predicate, label, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    try {
      while (true) {
        if (unexpectedResponseCount) throw new Error(`Unexpected or out-of-window checkout responses: ${unexpectedResponseCount}`);
        if (
          failure ||
          closed ||
          exited ||
          k6Proc.exitCode !== null ||
          k6Proc.signalCode != null
        ) {
          const result = await promise;
          throw new Error(
            `K6 berhenti prematur saat menunggu ${label} (exit code: ${result.code}): ${result.error || result.stderr || result.stdout}`,
          );
        }
        if (predicate()) return;
        if (Date.now() >= deadline)
          throw new Error(`Timeout (${timeoutMs}ms) menunggu K6 ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } catch (err) {
      failure ||= err;
      requestStop();
      const result = await promise;
      throw new Error(
        `${err.message}\nstdout: ${result.stdout}\nstderr: ${result.stderr}\nerror: ${result.error || ""}`,
      );
    }
  }
  const controller = {
    proc: k6Proc,
    promise,
    isAlive: () =>
      !closed &&
      !exited &&
      !stopping &&
      !failure &&
      unexpectedResponseCount === 0 &&
      k6Proc.exitCode === null &&
      k6Proc.signalCode == null,
    getObservedVUsCount: () => observedVUs.size,
    markOutageRequested: (at) => {
      if (outageRequestedAt || !Number.isFinite(Date.parse(at))) throw new Error("Invalid or repeated outage marker");
      outageRequestedAt = at;
    },
    hasHandshake: () => handshakeReceived,
    waitForHandshake: async (timeoutMs = 15000) => {
      await waitUntil(() => handshakeReceived, "startup handshake", timeoutMs);
      return { ok: true, data: handshakeData };
    },
    waitForObservedVUs: async (minVUs = targetVUs, timeoutMs = 25000) => {
      await waitUntil(
        () => observedVUs.size >= minVUs,
        `${minVUs} distinct observed VUs (historical participation)`,
        timeoutMs,
      );
      return { ok: true, observedVUsCount: observedVUs.size,
        concurrentActivityAtInjectionProven: false };
    },
    stop: () => {
      requestStop();
      return promise;
    },
  };
  return controller;
}

/**
 * Menjalankan workload menggunakan k6 jika terpasang di host
 */
function runK6Workload(options = {}) {
  const controller = startK6Workload(options);
  return controller.promise;
}

module.exports = {
  sendCheckoutRequest,
  runNodeWorkload,
  startK6Workload,
  runK6Workload,
};
