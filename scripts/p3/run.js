"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { loadConfig } = require("./config");
const { Docker } = require("./docker");
const { Controller } = require("./controller");
const { verify, reset, assertIsolation } = require("./dataset");
const { execute, readJson, writeJson, sleep, lock } = require("./util");
const { storagePlan, checkStorage } = require("./storage");
function parse(args) {
  const result = {
    campaign: "smoke",
    mode: "fixed",
    workload: "read",
    execute: false,
    vus: 10,
    seconds: 120,
  };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--execute") result.execute = true;
    else if (
      ["--campaign", "--mode", "--workload", "--vus", "--seconds"].includes(
        key,
      ) &&
      args[i + 1]
    )
      result[key.slice(2)] = args[++i];
    else throw new Error(`Unknown argument ${key}`);
  }
  if (
    ![
      "smoke",
      "pilot",
      "final",
      "lifecycle",
      "soldout",
      "idempotency",
      "calibration",
      "stress",
    ].includes(result.campaign) ||
    !["fixed", "auto"].includes(result.mode) ||
    !["read", "write", "mixed"].includes(result.workload)
  )
    throw new Error("Invalid run options");
  result.vus = Number(result.vus);
  result.seconds = Number(result.seconds);
  if (result.campaign === "lifecycle" && result.workload !== "read")
    throw new Error("Lifecycle is read-only");
  if (
    ["calibration", "stress"].includes(result.campaign) &&
    (result.workload !== "read" ||
      !Number.isInteger(result.vus) ||
      result.vus < 1 ||
      result.vus > (result.campaign === "stress" ? 1000 : 100) ||
      !Number.isInteger(result.seconds) ||
      result.seconds < 30 ||
      result.seconds > 180)
  )
    throw new Error("Calibration/stress requires read-only workload, bounded VU and 30–180 seconds");
  if (
    result.campaign === "smoke" &&
    (result.mode !== "fixed" || result.workload !== "read")
  )
    throw new Error("Smoke is fixed, 2 VU, read-only for five seconds");
  return result;
}
function matrix(campaign) {
  if (!["pilot", "final"].includes(campaign)) return [];
  const jobs = [];
  for (
    let repetition = 1;
    repetition <= (campaign === "final" ? 3 : 1);
    repetition++
  )
    for (const workload of ["read", "write", "mixed"])
      for (const vus of [10, 100, 500, 1000])
        for (const mode of repetition % 2
          ? ["fixed", "auto"]
          : ["auto", "fixed"])
          jobs.push({ repetition, workload, vus, mode });
  return jobs;
}
async function waitIdle(docker, c) {
  const deadline = Date.now() + c.drainTimeout;
  while (Date.now() < deadline) {
    const results = await Promise.all(
      (await docker.list("backend"))
        .filter((c) => c.State.Running)
        .map((b) => docker.probe(b)),
    );
    if (results.length >= c.min && results.every(require("./controller").idle))
      return;
    await sleep(500);
  }
  throw new Error("Requests/transactions have not drained; reset refused");
}
async function one(c, docker, job, profile, root) {
  const readOnly = ["smoke", "calibration", "stress", "lifecycle"].includes(profile);
  const id = `p3-${randomUUID()}`,
    directory = path.join(root, id);
  fs.mkdirSync(directory, { recursive: true });
  const controlFile = path.join(c.runtime, "control.json");
  const priorControl = readJson(controlFile, { enabled: true });
  const abort = new AbortController();
  const controller = new Controller(c, docker);
  controller.collector.directory = directory;
  const manifest = {
    id,
    profile,
    ...job,
    started: new Date().toISOString(),
    status: "preparing",
    project: c.project,
    environment_id: c.values.P3_ID,
    settings: {
      quota: c.quota,
      pool: c.poolMax,
      min: c.min,
      max: c.max,
      outCpu: c.outCpu,
      inCpu: c.inCpu,
      interval: c.interval,
      outWindow: c.outWindow,
      inWindow: c.inWindow,
      outCooldown: c.outCooldown,
      inCooldown: c.inCooldown,
    },
    measurement_seconds:
      profile === "smoke" ? 5 : profile === "pilot" ? 30 : 180,
  };
  if (profile === "lifecycle") { manifest.lifecycle_timing = c.lifecycle; manifest.measurement_seconds = c.lifecycle.total_seconds; }
  if (["calibration", "stress"].includes(profile)) {
    manifest.measurement_seconds = c.calibrationSeconds;
    manifest.feasibility_only = profile === "calibration";
  }
  manifest.storage = checkStorage(directory, storagePlan(job.vus,
    profile === "lifecycle" ? c.lifecycle.total_seconds : ["calibration", "stress"].includes(profile) ? c.calibrationSeconds : profile === "smoke" ? 5 : profile === "pilot" ? 100 : 330));
  writeJson(path.join(directory, "manifest.json"), manifest);
  let task, controllerError, k6child;
  const interrupt = () => {
    abort.abort();
    k6child?.kill();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const eventSource = path.join(c.runtime, "scaling-events.ndjson");
  const eventOffset = fs.existsSync(eventSource)
    ? fs.statSync(eventSource).size
    : 0;
  try {
    writeJson(controlFile, { enabled: false, paused: true });
    await assertIsolation(docker);
    await controller.recover();
    let backends = await docker.list("backend");
    while (backends.length > c.min) {
      await controller.scaleIn(backends, backends.length - 1);
      backends = await docker.list("backend");
    }
    await waitIdle(docker, c);
    const before = readOnly
      ? await verify(docker)
      : await reset(docker, {
          allowReset: true,
          runId: id,
          stock:
            profile === "soldout"
              ? 100
              : profile === "idempotency"
                ? 100
                : 10000000,
        });
    writeJson(path.join(directory, "db-before.json"), before);
    if (!before.consistent) throw new Error("Pre-run DB verification failed");
    manifest.versions = {
      node: process.version,
      k6: await execute("k6", ["version"]),
      docker: await docker.command([
        "version",
        "--format",
        "{{.Client.Version}}/{{.Server.Version}}",
      ]),
      compose: await docker.command(["compose", "version"]),
    };
    manifest.images = (await docker.list()).map((b) => ({
      service: b.Config.Labels["com.docker.compose.service"],
      image: b.Image,
    }));
    manifest.host = {
      cpus: require("node:os").cpus().length,
      memory: require("node:os").totalmem(),
    };
    manifest.measurement_start_seconds = readOnly
      ? 0
      : profile === "pilot"
        ? 30
        : 90;
    await controller.collector.sample(); // Prime VM/process counters before workload measurement.
    manifest.status = "running";
    manifest.workload_started = new Date().toISOString();
    writeJson(path.join(directory, "manifest.json"), manifest);
    writeJson(controlFile, { enabled: job.mode === "auto", paused: false });
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    task = controller
      .run({ signal: abort.signal, onReady: resolveReady })
      .catch((error) => {
        controllerError = error;
        rejectReady(error);
        abort.abort();
        k6child?.kill();
      });
    await ready;
    if (controllerError) throw controllerError;
    const special = ["lifecycle", "soldout", "idempotency"].includes(profile);
    const script =
      profile === "lifecycle"
        ? "lifecycle.js"
        : special
          ? "transactions.js"
          : "workload.js";
    const env = {
      ...process.env,
      P3_BASE_URL: c.baseUrl,
      P3_RUN_ID: id,
      P3_WORKLOAD: job.workload,
      P3_PROFILE: profile,
      P3_VUS: String(job.vus),
      P3_TRANSACTION_TEST: profile,
      P3_SUMMARY: path.join(directory, "k6-summary.json"),
    };
    if (profile === "lifecycle")
      env.P3_LIFECYCLE_LOW_SECONDS = String(c.lifecycle.low_seconds);
    if (["calibration", "stress"].includes(profile))
      env.P3_CALIBRATION_SECONDS = String(c.calibrationSeconds);
    const start = Date.now();
    let k6Error;
    try {
      await execute(
        "k6",
        [
          "run",
          "--out",
          `json=${path.join(directory, "k6-samples.ndjson.gz")}`,
          path.join(c.root, "tests/load", script),
        ],
        {
          env,
          cwd: c.root,
          timeout:
            profile === "lifecycle"
              ? c.lifecycle.process_timeout_ms
              : ["calibration", "stress"].includes(profile)
                ? (c.calibrationSeconds + 90) * 1000
                : profile === "final"
                  ? 390000
                  : profile === "pilot"
                    ? 160000
                    : 90000,
          stdoutFile: path.join(directory, "k6.stdout.log"),
          stderrFile: path.join(directory, "k6.stderr.log"),
          onSpawn: (child) => {
            k6child = child;
            controller.collector.generatorPid = child.pid;
            manifest.workload_started = new Date().toISOString();
            writeJson(path.join(directory, "manifest.json"), manifest);
          },
        },
      );
    } catch (error) {
      k6Error = error;
    }
    manifest.elapsed_ms = Date.now() - start;
    writeJson(controlFile, { enabled: false, paused: true });
    abort.abort();
    await task;
    if (controllerError) throw controllerError;
    await waitIdle(docker, c);
    const after = await verify(docker);
    writeJson(path.join(directory, "db-after.json"), after);
    if (!after.consistent)
      throw new Error("Post-run database invariants failed");
    if (!readOnly)
      await require("./reconcile").reconcile(docker, directory, id);
    if (
      readOnly &&
      JSON.stringify(after.primary) !== JSON.stringify(before.primary)
    )
      throw new Error("Read-only run changed P3 data");
    if (
      profile === "soldout" &&
      (after.primary.orders !== 100 || after.primary.products[0].stock !== 0)
    )
      throw new Error("Sold-out count mismatch");
    if (profile === "idempotency" && after.primary.orders !== 1)
      throw new Error("Idempotency produced more/less than one order");
    if (profile === "lifecycle") {
      const events = fs
        .readFileSync(eventSource)
        .subarray(eventOffset)
        .toString()
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map(JSON.parse)
        .filter((e) => e.source === "policy" && Date.parse(e.time) >= Date.parse(manifest.workload_started));
      if (
        !events.some(
          (e) => e.type === "scale-complete" && e.direction === "out",
        ) ||
        !events.some(
          (e) => e.type === "scale-complete" && e.direction === "in",
        ) ||
        (await docker.list("backend")).length !== c.min
      )
        throw new Error(
          "Lifecycle did not prove automatic scale-out and return to minimum",
        );
    }
    if (k6Error) throw k6Error;
    manifest.status = "completed";
  } catch (error) {
    manifest.status = "invalid";
    manifest.error = error.message;
    throw error;
  } finally {
    abort.abort();
    if (task) await task;
    let cleanupError;
    if (
      profile === "calibration" &&
      manifest.status === "completed" &&
      !controllerError
    ) {
      controller.cancelled = () => false;
      try {
        let backends = await docker.list("backend");
        while (backends.length > c.min) {
          await controller.scaleIn(backends, backends.length - 1);
          backends = await docker.list("backend");
        }
      } catch (error) {
        cleanupError = error;
        manifest.status = "invalid";
        manifest.cleanup_error = error.message;
      }
    }
    writeJson(controlFile, priorControl);
    if (fs.existsSync(eventSource))
      fs.writeFileSync(
        path.join(directory, "scaling-events.ndjson"),
        fs.readFileSync(eventSource).subarray(eventOffset),
      );
    manifest.finished = new Date().toISOString();
    writeJson(path.join(directory, "manifest.json"), manifest);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (cleanupError) throw cleanupError;
  }
  return directory;
}
async function main(args = process.argv.slice(2)) {
  const options = parse(args);
  const jobs = matrix(options.campaign);
  if (!jobs.length)
    jobs.push({
      repetition: 1,
      workload: options.workload,
      vus:
        options.campaign === "smoke"
          ? 2
          : ["calibration", "stress"].includes(options.campaign)
            ? options.vus
            : 1000,
      mode: options.campaign === "lifecycle" ? "auto" : options.mode,
    });
  if (!options.execute) {
    console.log(
      JSON.stringify(
        {
          dry_run: true,
          campaign: options.campaign,
          runs: jobs.length,
          jobs,
          storage_estimates: jobs.map((job) => storagePlan(job.vus,
            options.campaign === "lifecycle" ? loadConfig().lifecycle.total_seconds :
            ["calibration", "stress"].includes(options.campaign) ? options.seconds : options.campaign === "smoke" ? 5 : options.campaign === "pilot" ? 100 : 330)),
          ...(["calibration", "stress"].includes(options.campaign)
            ? {
                seconds: options.seconds,
                read_only: true,
                feasibility_only: options.campaign === "calibration",
              }
            : {}),
          ...(options.campaign === "lifecycle"
            ? { lifecycle_timing: loadConfig().lifecycle }
            : {}),
        },
        null,
        2,
      ),
    );
    return;
  }
  const c = loadConfig(),
    docker = new Docker(c);
  c.calibrationSeconds = options.seconds;
  await docker.preflight();
  const release = lock(path.join(c.runtime, "runner.lock"));
  try {
    const checkController = lock(path.join(c.runtime, "controller.lock"));
    checkController();
    if (!["smoke", "calibration"].includes(options.campaign)) {
      const others = JSON.parse(
        await docker
          .command(["ps", "--format", "{{json .}}"])
          .then((s) => `[${s.split(/\r?\n/).filter(Boolean).join(",")}]`),
      );
      if (
        others.some(
          (c) =>
            !(c.Labels || "")
              .split(",")
              .includes("com.docker.compose.project=flashsale-p3"),
        )
      )
        throw new Error(
          "Non-P3 containers are running; stop them manually before a performance campaign. Runner never stops P2.",
        );
    }
    const root = path.join(
      c.root,
      "results/p3",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${options.campaign}`,
    );
    for (let i = 0; i < jobs.length; i++) {
      console.log(
        `[P3] Run ${i + 1}/${jobs.length}: ${JSON.stringify(jobs[i])}`,
      );
      await one(c, docker, jobs[i], options.campaign, root);
      if (i < jobs.length - 1) await sleep(60000);
    }
    await require("./report").report(root);
    console.log(`Results: ${root}`);
  } finally {
    release();
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { parse, matrix, one, main };
