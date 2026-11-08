"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { configureP4Ingress } = require("../../scripts/p4/ingress");
const { validateArchiveTOC } = require("../../scripts/p4/common");
const {
  verifyPreFailureBaseline,
  requireAcknowledgedBaseline,
  waitForPreFailureWorkload,
  collectWorkloadResult,
  findP3BaselineBackup,
} = require("../../scripts/p4/orchestrate-dr");
const crypto = require("node:crypto");

test("p4 baseline: rejects only errors, sold out and false acknowledgements", () => {
  for (const entries of [
    [],
    [{ status: 503, outcome: "ERROR" }],
    [{ status: 0 }],
    [{ status: 409, outcome: "SOLD_OUT" }],
    [{ status: 503, outcome: "CREATED" }],
  ]) {
    assert.throws(
      () => requireAcknowledgedBaseline(entries),
      /No acknowledged checkout/,
    );
  }
  assert.equal(
    requireAcknowledgedBaseline([
      { status: 201, outcome: "CREATED" },
      { status: 200, outcome: "DUPLICATE" },
    ]),
    2,
  );
});

const health = {
  status: 200,
  body: { db: "up", replica: "up", replica_read_only: true },
};
test("p4 baseline: deterministically selects in-stock product and checks checkout before workload", async () => {
  let payload;
  const result = await verifyPreFailureBaseline(
    "http://p4",
    async (url) =>
      url.endsWith("/health")
        ? health
        : {
            status: 200,
            body: [
              { id: 3, stock: 100 },
              { id: 1, stock: 0 },
              { id: 2, stock: 100 },
            ],
          },
    async (_url, data) => {
      payload = data;
      return { status: 201 };
    },
  );
  assert.equal(result.productId, 2);
  assert.equal(payload.product_id, 2);
});

test("p4 baseline: unhealthy replica, failed reads, sold-out dataset and DB_UNAVAILABLE abort", async () => {
  for (const [h, products, checkout] of [
    [{ status: 503 }, { status: 200, body: [] }, { status: 201 }],
    [
      { status: 200, body: { db: "up", replica: "down" } },
      { status: 200, body: [] },
      { status: 201 },
    ],
    [health, { status: 503 }, { status: 201 }],
    [health, { status: 200, body: [{ id: 1, stock: 0 }] }, { status: 201 }],
    [
      health,
      { status: 200, body: [{ id: 1, stock: 100 }] },
      { status: 503, body: { error: "DB_UNAVAILABLE" } },
    ],
  ]) {
    await assert.rejects(
      verifyPreFailureBaseline(
        "http://p4",
        async (url) => (url.endsWith("/health") ? h : products),
        async () => checkout,
      ),
      /P4 BASELINE FAILED/,
    );
  }
});

test("p4 orchestration: pre-T0 handshake or VU failure stops and drains workload", async () => {
  for (const phase of ["handshake", "vus"]) {
    let drained = false;
    const report = { timestamps: {} };
    const runner = {
      waitForHandshake: async () => {
        if (phase === "handshake") throw new Error("handshake failed");
      },
      waitForObservedVUs: async () => {
        throw new Error("vus failed");
      },
      stop: async () => {
        await new Promise((r) => setTimeout(r, 10));
        drained = true;
        return { ok: false, code: 2 };
      },
    };
    await assert.rejects(
      waitForPreFailureWorkload(runner, "unused", report),
      /failed/,
    );
    assert.equal(drained, true);
    assert.equal(report.k6Result.ok, false);
    assert.ok(report.workloadFailure);
    assert.equal(report.timestamps.t0_failureInjectedAt, undefined);
  }
});

test("p4 orchestration: error-only ledger aborts before T0 and awaits shutdown", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-baseline-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = path.join(dir, "ledger.jsonl");
  fs.writeFileSync(
    ledger,
    JSON.stringify({
      idempotencyKey: "error-vu1-iter0",
      status: 503,
      outcome: "ERROR",
    }) + "\n",
  );
  let stopped = false;
  const runner = {
    waitForHandshake: async () => {},
    waitForObservedVUs: async () => {},
    isAlive: () => true,
    stop: async () => {
      stopped = true;
      return { ok: false, code: 1 };
    },
  };
  await assert.rejects(
    waitForPreFailureWorkload(runner, ledger, { timestamps: {} }),
    /No acknowledged/,
  );
  assert.equal(stopped, true);
});

test("p4 orchestration: post-T0 nonzero exit remains a failure without throwing before recovery", async () => {
  const report = {
    timestamps: { t0_failureInjectedAt: new Date().toISOString() },
  };
  const result = await collectWorkloadResult(
    {
      promise: Promise.resolve({
        ok: false,
        code: 99,
        handshakeReceived: true,
        stderr: "threshold failed",
      }),
    },
    report,
  );
  assert.equal(result.ok, false);
  assert.equal(report.k6Result.code, 99);
  assert.match(report.workloadFailure, /threshold failed/);
  assert.ok(report.timestamps.k6FinishedAt);
});

function container(service, ip) {
  return {
    Config: {
      Labels: {
        "com.docker.compose.project": "flashsale-p4-dr",
        "flashsale.environment": "p4-dr",
        "com.docker.compose.service": service,
      },
    },
    State: { Running: true, Health: { Status: "healthy" } },
    NetworkSettings: { Networks: { "flashsale-p4-dr": { IPAddress: ip } } },
  };
}
test("p4 ingress: discovers two actual IPs, validates candidate before activating routing", () => {
  const calls = [];
  configureP4Ingress((args, input) => {
    calls.push({ args, input });
    if (args[0] === "ps") return "id1\nid2\n";
    if (args[0] === "inspect")
      return JSON.stringify([
        container("nginx", "172.21.0.2"),
        container("backend", "172.21.0.5"),
        container("backend", "172.21.0.6"),
      ]);
    return "";
  });
  assert.match(calls[2].input, /server 172\.21\.0\.5:3000/);
  assert.match(calls[2].input, /server 172\.21\.0\.6:3000/);
  assert.match(calls[2].args.at(-1), /nginx -t/);
  assert.match(calls[3].args.at(-1), /nginx -s reload/);
  assert.match(calls[2].input, /proxy_next_upstream off/);
});

test("p4 ingress: wrong project or unhealthy backend blocks all writes", () => {
  for (const invalid of ["project", "health"]) {
    const containers = [
      container("nginx", "172.21.0.2"),
      container("backend", "172.21.0.5"),
      container("backend", "172.21.0.6"),
    ];
    if (invalid === "project")
      containers[1].Config.Labels["com.docker.compose.project"] =
        "flashsale-p3";
    else containers[1].State.Health.Status = "unhealthy";
    assert.throws(
      () =>
        configureP4Ingress((args) => {
          if (args[0] === "ps") return "id1\nid2";
          if (args[0] === "inspect") return JSON.stringify(containers);
          assert.fail("must not modify nginx");
        }),
      /validation failed/,
    );
  }
});

test("p4 archive validation: streams binary input without copying or deleting container files", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-toc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "archive.dump");
  const bytes = Buffer.from([0x50, 0x47, 0x44, 0x4d, 0x50, 0xff, 0x00]);
  fs.writeFileSync(file, bytes);
  const calls = [];
  const result = validateArchiveTOC(
    "flashsale-p4-dr-db-primary-1",
    file,
    (cmd, options) => {
      calls.push(cmd);
      assert.deepEqual(options.input, bytes);
      return "; header\n1; TABLE public orders\n";
    },
  );
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0],
    "docker exec -i flashsale-p4-dr-db-primary-1 pg_restore --list",
  );
});

test("p4 preflight: validates P3 backup using verified P4 tool without accessing P3 container", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p4-baseline-archive-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bytes = Buffer.from("PGDMP-binary-fixture");
  const file = path.join(dir, "flashsale_p3_20261108_120000.dump");
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(
    `${file}.sha256`,
    crypto.createHash("sha256").update(bytes).digest("hex"),
  );
  const result = findP3BaselineBackup({ p3BackupDir: dir }, (cmd, options) => {
    assert.ok(!cmd.includes("flashsale-p3"));
    assert.ok(!cmd.includes("docker cp"));
    if (cmd.startsWith("docker inspect"))
      return JSON.stringify([container("db-primary", "172.21.0.3")]);
    assert.equal(
      cmd,
      "docker exec -i flashsale-p4-dr-db-primary-1 pg_restore --list",
    );
    assert.deepEqual(options.input, bytes);
    return "1; TABLE public orders\n";
  });
  assert.equal(result.ok, true);
  assert.equal(result.validationContainer, "flashsale-p4-dr-db-primary-1");
});
