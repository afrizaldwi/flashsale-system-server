"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  SPEC,
  requireConfirmation,
  detectIncident,
  backupCandidates,
  createFreshVolume,
  planDisasterRecovery,
  executeDisasterRecovery,
} = require("../../scripts/p4/p3-dr");
const { recoveryState, databaseVolume } = require("../../scripts/p3/recovery");
const { Docker } = require("../../scripts/p3/docker");
const {
  compareLedgerWithDatabase,
  recordTransaction,
} = require("../../scripts/p4/ledger");
const { performBackup } = require("../../scripts/p4/backup");
const { applyRetentionPolicy } = require("../../scripts/p4/common");
const { spawnSync } = require("node:child_process");
const { lock, sleep, withOperationLock } = require("../../scripts/p3/util");
const { main: p3Main } = require("../../scripts/p3/cli");
const { Controller } = require("../../scripts/p3/controller");

const { archive, fakeRuntime } = require("./helpers/dr-runtime");

test("official P4: explicit ledger replay resolves ACKs with retries and final independent SQL audit", async t => {
  const c = fixture(t); archive(c);
  const runtime = fakeRuntime(c, true), rows = new Map(), http = runtime.http, checkout = runtime.checkout, sql = runtime.docker.sql;
  let repeats = 0;
  runtime.http = async (base, route) => {
    if (route === "/stats") return {status:200,body:{consistent:true,total_orders:rows.size,total_qty_sold:rows.size,
      products:[{id:1,stock:1000-rows.size}]}};
    if (route.startsWith("/orders/")) return {status:200,body:[...rows.values()].find(r=>r.id===Number(route.split("/").at(-1)))};
    return http(base,route);
  };
  runtime.checkout = async (base,payload,key) => {
    if (!key.startsWith("p3-dr-test-vu")) return checkout(base,payload,key);
    if (rows.has(key)) { repeats++; return {status:200,body:{result:"DUPLICATE",order:rows.get(key)}}; }
    const order={id:rows.size+1,idempotency_key:key,...payload,created_at:new Date().toISOString()};rows.set(key,order);
    return {status:201,body:{result:"CREATED",order}};
  };
  runtime.docker.sql = async(service,statement) => statement.includes("WHERE idempotency_key LIKE")
    ? JSON.stringify([...rows.values()]) : sql(service,statement);
  const report=await executeDisasterRecovery({execute:true,config:c,...runtime,confirmPrimary:"a".repeat(64),
    confirmVolume:"flashsale-p3_primary",acknowledgedReplayApproval:"Explicit test operator authorization"});
  assert.equal(report.success,true);
  assert.equal(report.lostTransactions.length,100);
  assert.equal(report.acknowledgementReconciliation.unresolved,0);
  assert.equal(report.finalAcknowledgementAudit.total,100);
  assert.equal(report.finalAcknowledgementAudit.allResolved,true);
  assert.equal(repeats,100);
  assert.equal(recoveryState(c).phase,"validated");
  assert.ok(report.timestamps.t1);
  const journal=fs.readFileSync(path.join(c.root,"results/p4",report.runId,"acknowledgement-reconciliation.jsonl"),"utf8");
  assert.match(journal,/Explicit test operator authorization/);
  assert.match(journal,/INTENT/);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "p3-official-dr-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const c = {
    root,
    runtime: path.join(root, ".p3"),
    envFile: path.join(root, ".env.p3"),
    project: "flashsale-p3",
    port: 8080,
    baseUrl: SPEC.baseUrl,
    values: { P3_ID: "00000000-0000-4000-8000-000000000003" },
    min: 2,
    max: 6,
    poolMax: 10,
    readyTimeout: 100,
  };
  fs.mkdirSync(c.runtime);
  return c;
}
function manifest(c) {
  const runId = "aabbccddeeff";
  const state = {
    project: "flashsale-p3",
    database: "flashsale_p3",
    identity: c.values.P3_ID,
    runId,
    originalPrimary: { id: "a".repeat(64), volume: "flashsale-p3_primary" },
    phase: "validated",
    primaryVolume: `flashsale-p3_primary_recovery_${runId}`,
    replicaVolume: `flashsale-p3_replica_recovery_${runId}`,
  };
  fs.writeFileSync(
    path.join(c.runtime, "recovery.json"),
    JSON.stringify(state),
  );
  return state;
}
test("official P4: immutable container and volume confirmations are both mandatory", () => {
  const target = {
    primary: { Id: "a".repeat(64) },
    volume: "flashsale-p3_primary",
  };
  for (const options of [
    {},
    { confirmPrimary: target.primary.Id },
    { confirmPrimary: target.primary.Id, confirmVolume: "flashsale_primary" },
  ])
    assert.throws(
      () => requireConfirmation(options, target),
      /Explicit confirmation required/,
    );
  requireConfirmation(
    { confirmPrimary: target.primary.Id, confirmVolume: target.volume },
    target,
  );
});
test("official P4: T0 is second consecutive health 503, with reset after a healthy sample", async () => {
  const statuses = [503, 200, 503, 503];
  let i = 0;
  const result = await detectIncident(async () => ({ status: statuses[i++] }), {
    wait: async () => {},
    now: () => `2026-11-08T12:00:0${i}Z`,
  });
  assert.equal(result.detectedAt, "2026-11-08T12:00:04Z");
  assert.deepEqual(
    result.samples.map((s) => s.status),
    statuses,
  );
});
test("official P4: unavailable ingress alone is not a detected database incident", async () => {
  const result = await detectIncident(async () => ({ status: 0 }), {
    wait: async () => {},
    attempts: 3,
  });
  assert.equal(result.detectedAt, null);
});
test("official P4: RPO uses newest lost pre-disaster ACK, preserving loss before replay", () => {
  const tx = (key, second, status = 201) => ({
    idempotencyKey: key,
    status,
    outcome: status === 201 ? "CREATED" : "ERROR",
    timestamp: `2026-11-08T12:00:${second}.000Z`,
  });
  const result = compareLedgerWithDatabase(
    [
      tx("restored", "01"),
      tx("lost-older", "10"),
      tx("lost-newest", "50"),
      tx("post-disaster", "59"),
      tx("failed", "51", 503),
    ],
    [{ idempotencyKey: "restored" }],
    { failureTimestamp: "2026-11-08T12:00:55Z" },
  );
  assert.equal(result.actualRpoSeconds, 5);
  assert.equal(
    result.newestLostAcknowledgedTransaction.idempotencyKey,
    "lost-newest",
  );
  assert.equal(result.missingAcknowledgedTransactions.count, 2);
  assert.equal(result.acknowledgedTransactions.count, 3);
  assert.equal(result.lateAcknowledgements[0].idempotencyKey, "post-disaster");
  assert.equal(
    result.lateAcknowledgements[0].classification,
    "LOST_COMPENSATION_REQUIRED",
  );
});
test("official P4: error-only ledger does not establish RPO zero", () => {
  const r = compareLedgerWithDatabase(
    [
      {
        idempotencyKey: "error",
        status: 503,
        timestamp: "2026-11-08T12:00:00Z",
      },
    ],
    [],
    { failureTimestamp: "2026-11-08T12:00:10Z" },
  );
  assert.equal(r.actualRpoSeconds, null);
});
test("official P4: backup candidates require completed metadata, matching checksum and newest snapshot", (t) => {
  const c = fixture(t);
  archive(c, "flashsale_p3_old.dump", "2026-11-08T12:00:00Z");
  const latest = archive(c, "flashsale_p3_new.dump", "2026-11-08T12:01:00Z");
  assert.equal(backupCandidates(path.dirname(latest))[0].path, latest);
  fs.writeFileSync(latest, "corrupt");
  assert.equal(backupCandidates(path.dirname(latest)).length, 1);
});
test("P4 backup: standalone and scheduled jobs share an exclusive job lock", async (t) => {
  const c = fixture(t),
    dir = path.join(c.root, "backups/p3");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".backup-job.lock"),
    JSON.stringify({ pid: process.pid }),
  );
  await assert.rejects(
    performBackup({ backupDir: dir }, () =>
      assert.fail("overlapping job must not reach Docker"),
    ),
    /Archive lock unavailable/,
  );
});
test("P4 backup: checksum-valid but archive-invalid candidates cannot evict the last usable archive", (t) => {
  const c = fixture(t),
    good = archive(c, "flashsale_p3_20261108_120000.dump");
  archive(c, "flashsale_p3_20261108_120100.dump");
  const result = applyRetentionPolicy(path.dirname(good), 1, {
    validateArchive: (file) => file === good,
  });
  assert.equal(result.pruned.length, 0);
  assert.ok(fs.existsSync(good));
});
test("P3 recovery: manifest preserves project identity and cannot substitute P1/P2 volumes", (t) => {
  const c = fixture(t),
    state = manifest(c);
  assert.equal(databaseVolume(c, "primary"), state.primaryVolume);
  state.primaryVolume = "flashsale_primary";
  fs.writeFileSync(
    path.join(c.runtime, "recovery.json"),
    JSON.stringify(state),
  );
  assert.throws(() => recoveryState(c), /Invalid P3 recovery manifest/);
});
test("P3 recovery: Compose reuses .env.p3 and adds only the verified recovery overlay", async (t) => {
  const c = fixture(t),
    state = manifest(c);
  const docker = new Docker(c, async (command, args, options) => {
    assert.equal(command, "docker");
    assert.ok(args.includes("docker-compose.p3.yml"));
    assert.ok(args.includes("docker-compose.p4-recovery.yml"));
    assert.ok(args.includes(c.envFile));
    assert.equal(options.env.P4_PRIMARY_RECOVERY_VOLUME, state.primaryVolume);
    assert.equal(options.env.P4_REPLICA_RECOVERY_VOLUME, state.replicaVolume);
    return "ok";
  });
  await docker.compose(["config", "--quiet"]);
});
test("official P4: existing recovery volumes are refused without deletion", async () => {
  const calls = [];
  const docker = {
    command: async (args) => {
      calls.push(args);
      return "flashsale-p3_primary_recovery_aabbccddeeff";
    },
  };
  await assert.rejects(
    createFreshVolume(
      docker,
      "flashsale-p3_primary_recovery_aabbccddeeff",
      "aabbccddeeff",
    ),
    /already exists/,
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ["volume", "ls"]);
});

test("official P4: post-T0 nonzero workload exit still restores primary and standby, with failed final result", async (t) => {
  const c = fixture(t);
  archive(c);
  const runtime = fakeRuntime(c);
  const report = await executeDisasterRecovery({
    execute: true,
    config: c,
    ...runtime,
    confirmPrimary: "a".repeat(64),
    confirmVolume: "flashsale-p3_primary",
  });
  assert.equal(report.success, false);
  assert.equal(report.k6Result.code, 99);
  assert.match(report.workloadFailure, /threshold failed/);
  assert.ok(report.timestamps.restoreCompletedAt);
  assert.ok(report.timestamps.standbyRebuiltAt);
  assert.ok(report.timestamps.integrityAuditCompletedAt);
  assert.equal(report.timestamps.t0, report.timestamps.failureDetectionAt);
  assert.equal(report.timestamps.t1, undefined);
  assert.equal(recoveryState(c).phase, "recovering");
  assert.equal(report.acknowledgementReconciliation.unresolved, 100);
  assert.equal(
    report.rto.elapsedUntilIntegrityAuditSeconds,
    (Date.parse(report.timestamps.integrityAuditCompletedAt) -
      Date.parse(report.timestamps.failureDetectionAt)) /
      1000,
  );
  assert.equal(report.lostTransactions.length, 100);
  assert.ok(runtime.calls.some((args) => args[0] === "routing-verified"));
  assert.ok(
    !runtime.calls.some(
      (args) =>
        args.includes("down") || (args[0] === "volume" && args[1] === "rm"),
    ),
  );
});
test("official P4: absent confirmation performs no destructive/control/database operations", async (t) => {
  const c = fixture(t),
    runtime = fakeRuntime(c);
  await assert.rejects(
    executeDisasterRecovery({ execute: true, config: c, ...runtime }),
    /Explicit confirmation required/,
  );
  assert.ok(
    runtime.calls.every(
      (args) => args[0] === "volume" && args[1] === "inspect",
    ),
  );
  assert.equal(fs.existsSync(path.join(c.runtime, "control.json")), false);
});
test("official P4: pre-T0 readiness failure drains workload, restores control and never deletes primary", async (t) => {
  const c = fixture(t);
  archive(c);
  const runtime = fakeRuntime(c),
    workload = runtime.workload;
  let stopped = false;
  runtime.workload = (options) => {
    const r = workload(options),
      stop = r.stop;
    r.waitForHandshake = async () => {
      throw new Error("handshake timeout");
    };
    r.stop = async () => {
      stopped = true;
      return stop();
    };
    return r;
  };
  await assert.rejects(
    executeDisasterRecovery({
      execute: true,
      config: c,
      ...runtime,
      confirmPrimary: "a".repeat(64),
      confirmVolume: "flashsale-p3_primary",
    }),
    /handshake timeout/,
  );
  assert.equal(stopped, true);
  assert.ok(!runtime.calls.some((args) => args[0] === "rm"));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(c.runtime, "control.json"))).paused,
    false,
  );
  assert.equal(fs.existsSync(path.join(c.runtime, "operation.lock")), false);
});
test("official P4: failed final audit leaves controller paused and never records T1", async (t) => {
  const c = fixture(t);
  archive(c);
  const runtime = fakeRuntime(c, true),
    sql = runtime.docker.sql;
  runtime.docker.sql = async (service, statement) => {
    if (statement.includes("'foreign_orders'"))
      throw new Error("snapshot audit failed");
    return sql(service, statement);
  };
  let failure;
  try {
    await executeDisasterRecovery({
      execute: true,
      config: c,
      ...runtime,
      confirmPrimary: "a".repeat(64),
      confirmVolume: "flashsale-p3_primary",
    });
  } catch (error) {
    failure = error;
  }
  assert.match(failure.message, /snapshot audit failed/);
  assert.equal(failure.report.timestamps.t1, undefined);
  assert.equal(failure.report.requiresManualRecovery, true);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(c.runtime, "control.json"))).paused,
    true,
  );
  assert.equal(recoveryState(c).phase, "recovering");
});
test("official P4: complete mocked recovery records T1 only after the full audit and retains old volumes", async (t) => {
  const c = fixture(t);
  archive(c);
  const runtime = fakeRuntime(c, true, { ordersPresent: true });
  const report = await executeDisasterRecovery({
    execute: true,
    config: c,
    ...runtime,
    confirmPrimary: "a".repeat(64),
    confirmVolume: "flashsale-p3_primary",
  });
  assert.equal(report.success, true);
  assert.equal(
    report.timestamps.t1,
    report.timestamps.integrityAuditCompletedAt,
  );
  assert.ok(
    report.events.findIndex(
      (e) => e.name === "firstSuccessfulRecoveryCheckoutAt",
    ) < report.events.findIndex((e) => e.name === "integrityAuditCompletedAt"),
  );
  assert.equal(recoveryState(c).phase, "validated");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(c.runtime, "control.json"))).paused,
    false,
  );
  assert.ok(
    !runtime.calls.some((args) => args[0] === "volume" && args[1] === "rm"),
  );
});

for (const scenario of ["390-pre-injection", "19-late"]) {
  test(`official P4: ${scenario} missing ACKs block T1, manifest validation and controller resume even when K6 succeeds`, async t => {
    const c = fixture(t); archive(c);
    const runtime = fakeRuntime(c, true, { ordersPresent: scenario === "19-late" });
    const workload = runtime.workload;
    let ledgerPath;
    runtime.workload = options => {
      ledgerPath = options.ledgerPath;
      const runner = workload(options), active = runner.waitForObservedVUs;
      runner.waitForObservedVUs = async () => {
        await active();
        if (scenario === "390-pre-injection") {
          fs.writeFileSync(ledgerPath, ""); // Isolated temporary test ledger only.
          for (let n = 0; n < 390; n++) recordTransaction({ idempotencyKey: `lost-${n}`, status: 201,
            userId: 1, productId: 1, qty: 1, timestamp: new Date(Date.now() - 20).toISOString() }, ledgerPath);
        }
      };
      return runner;
    };
    const command = runtime.docker.command;
    runtime.docker.command = async (args, options) => {
      const result = await command(args, options);
      if (scenario === "19-late" && args[0] === "rm" && args[1] === "-f")
        for (let n = 0; n < 19; n++) recordTransaction({ idempotencyKey: `late-${n}`, status: 201,
          userId: 1, productId: 1, qty: 1, timestamp: new Date(Date.now() + 100).toISOString() }, ledgerPath);
      return result;
    };
    const report = await executeDisasterRecovery({ execute: true, config: c, ...runtime,
      confirmPrimary: "a".repeat(64), confirmVolume: "flashsale-p3_primary" });
    const missing = scenario === "19-late" ? 19 : 390;
    assert.equal(report.k6Result.ok, true);
    assert.equal(report.acknowledgementReconciliation.unresolved, missing);
    assert.equal(report.reconciliation.acknowledgementLoss.totalMissing, missing);
    assert.equal(report.success, false); assert.equal(report.result, "PARTIAL");
    assert.equal(report.timestamps.t1, undefined); assert.equal(report.rto.seconds, null);
    await assertIncompleteRecovery(c);
    assert.ok(!runtime.calls.some(a => a[0] === "volume" && a[1] === "rm"));
    assert.ok(!runtime.calls.some(a => a[0] === "compose" && a.includes("down")));
  });
}
test("official P4: dry-run against stopped P3 reports blocker without starting services", async (t) => {
  const c = fixture(t);
  archive(c);
  const runtime = fakeRuntime(c),
    list = runtime.docker.list;
  runtime.docker.list = async (service) =>
    (await list(service)).map((v) => ({
      ...v,
      State: { Running: false, Status: "exited" },
    }));
  const plan = await planDisasterRecovery({
    config: c,
    docker: runtime.docker,
  });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.status, "BLOCKED");
  assert.match(plan.blockers[0], /stopped/);
  assert.ok(
    runtime.calls.every(
      (args) => args[0] === "volume" && args[1] === "inspect",
    ),
  );
});

async function assertIncompleteRecovery(c) {
  const state = recoveryState(c);
  assert.equal(state.phase, "recovering");
  assert.equal(state.originalPrimary.id, "a".repeat(64));
  assert.equal(state.originalPrimary.volume, "flashsale-p3_primary");
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.runtime, "control.json"))).paused, true);
  const docker = new Docker(c, async () => assert.fail("Incomplete recovery must block normal Docker mutation"));
  await assert.rejects(docker.preflight(), /Incomplete P4 recovery/);
  await assert.rejects(docker.scaleOut(c.min), /Incomplete P4 recovery/);
  await assert.rejects(p3Main(["start"], { config: c, docker }), /Incomplete P4 recovery/);
  await assert.rejects(p3Main(["resume"], { config: c, docker }), /Incomplete P4 recovery/);
  assert.equal(recoveryState(c).phase, "recovering");
}

test("P0: hard crash immediately after simulated primary deletion leaves a valid manifest and paused controller", async (t) => {
  const c = fixture(t);
  const child = spawnSync(process.execPath, [path.join(__dirname, "helpers/crash-after-delete.js"), c.root], {
    encoding: "utf8", windowsHide: true, timeout: 10000,
  });
  assert.equal(child.status, 73, child.stderr);
  // The child never executed finally. Normal startup reclaims only the dead
  // operation mutex, then rejects the still-recovering manifest.
  assert.ok(fs.existsSync(path.join(c.runtime, "operation.lock")));
  await assertIncompleteRecovery(c);
});

for (const stage of ["before-volume-creation", "volume-creation", "restore"]) {
  test(`P0: ${stage} exception preserves recovery intent, original volume identity and pause`, async (t) => {
    const c = fixture(t); archive(c);
    const runtime = fakeRuntime(c, true), command = runtime.docker.command, exec = runtime.docker.exec;
    let deleted = false;
    runtime.docker.command = async (args, options) => {
      if (deleted && stage === "before-volume-creation" && args[0] === "volume" && args[1] === "ls") throw new Error(stage);
      if (stage === "volume-creation" && args[0] === "volume" && args[1] === "create") throw new Error(stage);
      if (args[0] === "rm" && args[1] === "-f") {
        const state = recoveryState(c);
        assert.equal(state.phase, "recovering");
        assert.equal(state.originalPrimary.id, args[2]);
        deleted = true;
      }
      return command(args, options);
    };
    runtime.docker.exec = async (id, service, args, options) => {
      if (stage === "restore" && args[0] === "pg_restore" && args.includes("--clean")) throw new Error(stage);
      return exec(id, service, args, options);
    };
    await assert.rejects(executeDisasterRecovery({ execute: true, config: c, ...runtime,
      confirmPrimary: "a".repeat(64), confirmVolume: "flashsale-p3_primary" }), new RegExp(stage));
    await assertIncompleteRecovery(c);
    assert.equal(fs.existsSync(path.join(c.runtime, "operation.lock")), false);
    assert.equal(fs.existsSync(path.join(c.root, "backups/p3/.restore.lock")), false);
    assert.equal(fs.existsSync(path.join(c.root, "backups/p3/.backup-job.lock")), false);
    assert.ok(!runtime.calls.some((args) => args[0] === "volume" && args[1] === "rm"));
  });
}

test("P3/P4 coordination: existing operation finishes before injection and no resume/scale starts during recovery", async (t) => {
  const c = fixture(t); archive(c);
  const releaseScale = lock(path.join(c.runtime, "operation.lock"));
  let scaleFinished = false, guarded = false;
  const timer = setTimeout(() => { scaleFinished = true; releaseScale(); }, 30);
  t.after(() => clearTimeout(timer));
  const runtime = fakeRuntime(c, true, { ordersPresent: true }), command = runtime.docker.command;
  runtime.docker.command = async (args, options) => {
    if (args[0] === "rm" && args[1] === "-f") {
      assert.equal(scaleFinished, true);
      await assert.rejects(p3Main(["resume"], { config: c, docker: runtime.docker }), /Already running/);
      const callsBefore = runtime.calls.length;
      await new Controller(c, runtime.docker).tick(); // Paused: no metrics/routing/scale actions.
      assert.equal(runtime.calls.length, callsBefore);
      guarded = true;
    }
    return command(args, options);
  };
  const report = await executeDisasterRecovery({ execute: true, config: c, ...runtime,
    confirmPrimary: "a".repeat(64), confirmVolume: "flashsale-p3_primary" });
  assert.equal(guarded, true);
  assert.equal(report.success, true);
  assert.equal(recoveryState(c).phase, "validated");
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.runtime, "control.json"))).paused, false);
});

test("P3 coordination: controller startup recovery waits for the shared operation mutex", async (t) => {
  const c = fixture(t), events = [];
  const release = lock(path.join(c.runtime, "operation.lock"));
  const controller = new Controller(c, fakeRuntime(c).docker);
  const abort = new AbortController();
  controller.recover = async () => { events.push("recover"); };
  const run = controller.run({ signal: abort.signal, onReady: () => abort.abort() });
  await sleep(15);
  assert.deepEqual(events, []);
  events.push("existing-operation-completed");
  release();
  await run;
  assert.deepEqual(events, ["existing-operation-completed", "recover"]);
});
test("P3 coordination: direct benchmark scale actuators cannot bypass an existing DR operation", async (t) => {
  const c = fixture(t), release = lock(path.join(c.runtime, "operation.lock"));
  const docker = new Docker(c, async () => assert.fail("no actuator command while DR owns the mutex"));
  try {
    await assert.rejects(docker.scaleOut(3), /Already running/);
    await assert.rejects(new Controller(c, docker).scaleIn([], 2), /Already running/);
    await assert.rejects(new Controller(c, docker).recover(), /Already running/);
  } finally { release(); }
});
test("P3 coordination: nested actuator calls reuse only the owning async operation lease", async (t) => {
  const c = fixture(t), docker = new Docker(c);
  let composed = false;
  docker.preflight = async () => {};
  docker.list = async () => [];
  docker.compose = async () => { composed = true; };
  await withOperationLock(c.runtime, async () => {
    const owner = fs.readFileSync(path.join(c.runtime, "operation.lock"), "utf8");
    await docker.scaleOut(3);
    assert.equal(fs.readFileSync(path.join(c.runtime, "operation.lock"), "utf8"), owner);
  });
  assert.equal(composed, true);
  assert.equal(fs.existsSync(path.join(c.runtime, "operation.lock")), false);
});
