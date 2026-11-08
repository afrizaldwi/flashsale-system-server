"use strict";
// Official T1-B/T2: extend the existing P3 application, never seed or reset it.
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const { loadConfig } = require("../p3/config");
const { Docker } = require("../p3/docker");
const { Routing } = require("../p3/routing");
const { assertIsolation, verify } = require("../p3/dataset");
const { recoveryState, databaseVolume } = require("../p3/recovery");
const { sleep, waitForOperationLock, readJson, writeJson } = require("../p3/util");
const { acquireRestoreSession } = require("./locks");
const { verifyFileChecksum } = require("./common");
const { startK6Workload, sendCheckoutRequest } = require("./workload");
const { readLedger, compareLedgerWithDatabase } = require("./ledger");
const { observePrimaryUnavailable } = require("./lifecycle");
const { reconcileAcknowledgements } = require("./reconciliation");
const { evaluateSuccess } = require("./success");
const { approvedLedgerReplay, auditAcknowledgedOrders } = require("./ack-replay");

const SPEC = {
  architecture:
    "docs/revisi/Pertemuan_1/Spesifikasi_Arsitektur_P1.docx (v1.3, §§3–6, 8.4)",
  drp: "docs/revisi/Pertemuan_1/DRP_Awal_P1.docx (v1.1, §§4–9)",
  project: "flashsale-p3",
  database: "flashsale_p3",
  composeFile: "docker-compose.p3.yml",
  overlay: "docker-compose.p4-recovery.yml",
  envFile: ".env.p3",
  baseUrl: "http://127.0.0.1:8080",
  rtoConvention:
    "second consecutive health HTTP 503 (T0) to successful checkout and completed integrity audit (T1)",
  rpoConvention:
    "failure injection minus newest acknowledged transaction lost from restored database",
};
function context(options = {}) {
  const c = options.config || loadConfig();
  if (
    c.project !== SPEC.project ||
    c.port !== 8080 ||
    path.basename(c.envFile) !== SPEC.envFile
  )
    throw new Error(
      "Official P4 requires flashsale-p3, .env.p3 and 127.0.0.1:8080",
    );
  return { c, docker: options.docker || new Docker(c) };
}
function dataMount(container) {
  const mounts = (container.Mounts || []).filter(
    (m) => m.Destination === "/var/lib/postgresql/data",
  );
  if (mounts.length !== 1 || mounts[0].Type !== "volume" || !mounts[0].Name)
    throw new Error("Expected exactly one named PostgreSQL data volume");
  return mounts[0].Name;
}
async function inspectTarget(docker) {
  const matches = await docker.list("db-primary");
  if (matches.length !== 1)
    throw new Error("Expected exactly one P3 primary container");
  const primary = matches[0];
  if (dataMount(primary) !== databaseVolume(docker.c, "primary"))
    throw new Error("P3 primary volume mismatch");
  const [volume] = JSON.parse(
    await docker.command(["volume", "inspect", dataMount(primary)]),
  );
  if (
    volume.Name !== dataMount(primary) ||
    volume.Labels?.["com.docker.compose.project"] !== SPEC.project ||
    volume.Labels?.["flashsale.environment"] !== "p3"
  )
    throw new Error("Foreign primary volume");
  return { primary, volume: volume.Name };
}
function requireConfirmation(options, target) {
  if (
    options.confirmPrimary !== target.primary.Id ||
    options.confirmVolume !== target.volume
  )
    throw new Error(
      "Explicit confirmation required: --confirm-primary <full inspected container ID> --confirm-volume <exact inspected volume name>. No database changes performed.",
    );
}
async function getJson(base, route) {
  try {
    const r = await fetch(base + route, { signal: AbortSignal.timeout(4000) });
    const raw = await r.text();
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    return {
      status: r.status,
      body,
      headers: Object.fromEntries(r.headers),
      raw,
    };
  } catch (error) {
    return { status: 0, error: error.message };
  }
}
function backupCandidates(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".dump"))
    .map((file) => {
      const full = path.join(dir, file);
      const checksum = verifyFileChecksum(full);
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(full + ".meta.json", "utf8"));
      } catch {
        return null;
      }
      if (
        !checksum.ok ||
        meta.database !== SPEC.database ||
        meta.status !== "VALIDATED" ||
        meta.sha256 !== checksum.actual ||
        !Number.isFinite(Date.parse(meta.startTime)) ||
        !Number.isFinite(Date.parse(meta.endTime)) ||
        Date.parse(meta.endTime) < Date.parse(meta.startTime)
      )
        return null;
      return { file, path: full, meta, sha256: checksum.actual };
    })
    .filter(Boolean)
    .sort(
      (a, b) => Date.parse(b.meta.startTime) - Date.parse(a.meta.startTime),
    );
}
async function selectBackup(docker, validator, dir) {
  for (const candidate of backupCandidates(dir)) {
    try {
      const toc = await docker.exec(
        validator.Id,
        "db-primary",
        ["pg_restore", "--list"],
        { input: fs.readFileSync(candidate.path) },
      );
      if (toc.split(/\r?\n/).some((l) => /^\d+;/.test(l))) return candidate;
    } catch {
      /* Try the next checksummed, completed archive. */
    }
  }
  throw new Error(
    "No completed P3 backup with valid metadata, SHA-256 and archive TOC",
  );
}
async function planDisasterRecovery(options = {}) {
  const plan = {
    dryRun: true,
    scenario: "T1-B/T2",
    specification: SPEC,
    status: "BLOCKED",
    blockers: [],
    targets: { rtoSeconds: 300, rpoSeconds: 60 },
    protected: [
      "P1/P2 volumes",
      "original P3 primary and replica volumes",
      "historical P4 clone and its original primary volume",
    ],
    steps: [
      "Inspect existing P3 identity and baseline stats",
      "Verify latest backup and trial restore",
      "Run K6 with external ledger",
      "Require acknowledged transactions and confirm immutable target",
      "Delete only confirmed primary; detect two consecutive health 503",
      "Stop workload and keep controller paused",
      "Select latest valid archive and restore into fresh P3 volume",
      "Independently validate primary; reconstruct standby in fresh volume",
      "Reconnect existing backends and P3 routing",
      "Audit transactions and stock; record T1/RTO/RPO; keep original volumes",
    ],
  };
  try {
    const { c, docker } = context(options);
    await docker.preflight();
    const target = await inspectTarget(docker);
    plan.target = {
      primaryId: target.primary.Id,
      primaryVolume: target.volume,
      state: target.primary.State.Status,
    };
    plan.backups = backupCandidates(path.join(c.root, "backups/p3")).map(
      (b) => ({
        file: b.file,
        snapshotLowerBound: b.meta.startTime,
        completedAt: b.meta.endTime,
      }),
    );
    if (!target.primary.State.Running)
      plan.blockers.push(
        "P3 primary is stopped; no service was started by dry-run",
      );
    else {
      await assertIsolation(docker);
      const backup = await selectBackup(
        docker,
        target.primary,
        path.join(c.root, "backups/p3"),
      );
      plan.backup = { file: backup.file, sha256: backup.sha256 };
      const health = await getJson(c.baseUrl, "/health");
      if (health.status !== 200 || health.body?.replica !== "up")
        plan.blockers.push("P3 ingress or replica unhealthy");
    }
    if (!plan.backups.length)
      plan.blockers.push("No valid completed P3 backup metadata/checksum");
    if (!plan.blockers.length) plan.status = "READY_FOR_CONFIRMED_EXECUTION";
  } catch (error) {
    plan.blockers.push(error.message);
  }
  return plan;
}

async function psql(docker, container, db, sql) {
  return docker.exec(container.Id, "db-primary", [
    "psql",
    "-U",
    "p3_admin",
    "-d",
    db,
    "-XAtq",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ]);
}
async function trialRestore(docker, primary, backup, runId) {
  const database = `p4_trial_${runId}`;
  await docker.exec(primary.Id, "db-primary", [
    "createdb",
    "-U",
    "p3_admin",
    "-T",
    "template0",
    database,
  ]);
  try {
    await docker.exec(
      primary.Id,
      "db-primary",
      [
        "pg_restore",
        "-U",
        "p3_admin",
        "-d",
        database,
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
      ],
      { input: fs.readFileSync(backup.path), timeout: 120000 },
    );
    const audit = JSON.parse(
      await psql(
        docker,
        primary,
        database,
        `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT json_build_object('negative_stock',(SELECT count(*) FROM products WHERE stock<0),'duplicate_orders',(SELECT count(*) FROM (SELECT idempotency_key FROM orders GROUP BY 1 HAVING count(*)>1) d),'mismatches',(SELECT count(*) FROM products p WHERE initial_stock-stock<>COALESCE((SELECT sum(qty) FROM orders o WHERE o.product_id=p.id),0)),'orders',(SELECT count(*) FROM orders),'products',(SELECT count(*) FROM products),'identity',(SELECT id::text FROM p3_environment WHERE project='flashsale-p3')); COMMIT;`,
      ),
    );
    if (
      audit.negative_stock !== 0 ||
      audit.duplicate_orders !== 0 ||
      audit.mismatches !== 0 ||
      audit.products < 1 ||
      audit.identity !== docker.c.values.P3_ID
    )
      throw new Error("Trial restore identity/integrity failed");
    return audit;
  } finally {
    await docker.exec(primary.Id, "db-primary", [
      "dropdb",
      "-U",
      "p3_admin",
      database,
    ]);
  }
}
async function detectIncident(
  probe,
  {
    wait = sleep,
    now = () => new Date().toISOString(),
    attempts = 20,
    interval = 250,
  } = {},
) {
  const samples = [];
  let consecutive = 0;
  for (let i = 0; i < attempts; i++) {
    const response = await probe();
    const sample = {
      at: now(),
      status: response.status,
      db: response.body?.db,
      replica: response.body?.replica,
    };
    samples.push(sample);
    consecutive = response.status === 503 ? consecutive + 1 : 0;
    if (consecutive === 2) return { detectedAt: sample.at, samples };
    await wait(interval);
  }
  return {
    detectedAt: null,
    samples,
    error: "Two consecutive health 503 responses not observed",
  };
}
async function createFreshVolume(docker, name, runId) {
  if (
    !new RegExp(`^flashsale-p3_(primary|replica)_recovery_${runId}$`).test(name)
  )
    throw new Error("Unsafe recovery volume name");
  const existing = (
    await docker.command(["volume", "ls", "--format", "{{.Name}}"])
  ).split(/\s+/);
  if (existing.includes(name))
    throw new Error(
      "Recovery volume already exists; refusing reuse or deletion",
    );
  const logical = name.startsWith("flashsale-p3_primary_")
    ? "p4-primary-recovery"
    : "p4-replica-recovery";
  await docker.command([
    "volume",
    "create",
    "--label",
    "com.docker.compose.project=flashsale-p3",
    "--label",
    `com.docker.compose.volume=${logical}`,
    "--label",
    "flashsale.environment=p3",
    "--label",
    "flashsale.recovery=p4",
    "--label",
    `flashsale.dr.run=${runId}`,
    name,
  ]);
  const [volume] = JSON.parse(
    await docker.command(["volume", "inspect", name]),
  );
  if (
    volume.Name !== name ||
    volume.Labels?.["com.docker.compose.project"] !== SPEC.project ||
    volume.Labels?.["com.docker.compose.volume"] !== logical ||
    volume.Labels?.["flashsale.environment"] !== "p3" ||
    volume.Labels?.["flashsale.dr.run"] !== runId
  )
    throw new Error("Created recovery volume identity mismatch");
}
async function onlyRunning(docker, service, volume) {
  const matches = (await docker.list(service)).filter((c) => c.State.Running);
  if (matches.length !== 1 || (volume && dataMount(matches[0]) !== volume))
    throw new Error(`Invalid recovered ${service} membership/mount`);
  return matches[0];
}
async function waitApplication(docker, report, http = getJson, pause = sleep) {
  const deadline = Date.now() + 30000;
  let health;
  do {
    health = await http(docker.c.baseUrl, "/health");
    if (
      health.status === 200 &&
      health.body?.db === "up" &&
      health.body?.replica === "up" &&
      health.body?.replica_read_only === true
    ) {
      report.timestamps.health200At = new Date().toISOString();
      return health;
    }
    await pause(250);
  } while (Date.now() < deadline);
  throw new Error("Recovered application health/read-only standby not ready");
}

async function executeDisasterRecovery(options = {}) {
  if (options.acknowledgedReplayApproval !== undefined &&
      (typeof options.acknowledgedReplayApproval !== "string" || !options.acknowledgedReplayApproval.trim()))
    throw new Error("ACK replay requires an explicit nonempty operator approval");
  if (!options.execute) return planDisasterRecovery(options);
  const { c, docker } = context(options);
  const http = options.http || getJson;
  const checkoutRequest = options.checkout || sendCheckoutRequest;
  const workload = options.workload || startK6Workload;
  const pause = options.pause || sleep;
  const applyRouting =
    options.applyRouting || ((ready) => new Routing(docker).apply(ready));
  await docker.preflight();
  const target = await inspectTarget(docker);
  requireConfirmation(options, target); // Must precede every database/control-file mutation.
  if (!target.primary.State.Running)
    throw new Error(
      "Start and verify P3 separately before the confirmed DR test",
    );
  const runId = randomBytes(6).toString("hex");
  const state = {
    project: SPEC.project, database: SPEC.database, identity: c.values.P3_ID,
    runId, originalPrimary: { id: target.primary.Id, volume: target.volume },
    primaryVolume: `flashsale-p3_primary_recovery_${runId}`,
    replicaVolume: `flashsale-p3_replica_recovery_${runId}`, phase: "recovering",
  };
  const directory = path.join(c.root, "results/p4", runId);
  const reportFile = path.join(directory, "report.json");
  const report = {
    scenario: "T1-B/T2",
    specification: SPEC,
    runId,
    success: false,
    timestamps: Object.fromEntries([
      "failureInjectionRequestedAt", "primaryUnavailableAt", "failureDetectionAt", "k6FirstErrorAt",
      "restoreStartedAt", "restoreCompletedAt", "standbyRebuiltAt",
      "firstSuccessfulRecoveryCheckoutAt", "integrityAuditCompletedAt",
    ].map(name => [name, null])),
    events: [],
    originalPrimary: { id: target.primary.Id, volume: target.volume },
  };
  const event = (name) => {
    const at = new Date().toISOString();
    report.timestamps[name] = at;
    report.events.push({ name, at });
    writeJson(reportFile, report);
    return at;
  };
  const release = await waitForOperationLock(c.runtime, { timeoutMs: options.operationTimeoutMs ?? 90000 });
  const controlFile = path.join(c.runtime, "control.json");
  let previousControl;
  let runner,
    restoreSession,
    manifestPersisted = false,
    workloadFinalized = false,
    injected = false,
    completed = false;
  try {
    previousControl = readJson(controlFile, { enabled: true, paused: false });
    writeJson(controlFile, { ...previousControl, paused: true });
    event("controllerPausedAt");
    await assertIsolation(docker);
    const originalReplica = await onlyRunning(
      docker,
      "db-replica",
      databaseVolume(c, "replica"),
    );
    report.originalReplica = {
      id: originalReplica.Id,
      volume: dataMount(originalReplica),
    };
    const backends = (await docker.list("backend")).filter(
      (b) => b.State.Running,
    );
    if (backends.length < c.min || backends.length > c.max)
      throw new Error("P3 backend membership outside configured range");
    const baseline = await http(c.baseUrl, "/stats");
    const health = await http(c.baseUrl, "/health");
    const products = await http(c.baseUrl, "/products");
    if (
      baseline.status !== 200 ||
      baseline.body?.consistent !== true ||
      health.status !== 200 ||
      health.body?.db !== "up" ||
      health.body?.replica !== "up" ||
      health.body?.replica_read_only !== true ||
      products.status !== 200 ||
      products.headers?.["x-read-from"] !== "replica"
    )
      throw new Error("P3 baseline stats, health or replica routing failed");
    report.baselineStats = baseline.body;
    report.baselineHealth = health.body;
    const product = products.body
      .filter((p) => Number(p.stock) > 0)
      .sort((a, b) => a.id - b.id)[0];
    if (!product)
      throw new Error(
        "No in-stock P3 product; no dataset reset will be attempted",
      );
    const backupDir = path.join(c.root, "backups/p3");
    restoreSession = acquireRestoreSession(backupDir, { runId, purpose: "trial-restore" });
    const pretestBackup = await selectBackup(docker, target.primary, backupDir);
    event("pretestBackupSelectedAt");
    report.trialRestore = await trialRestore(docker, target.primary, pretestBackup, runId);
    restoreSession.release();
    restoreSession = null;
    event("trialRestoreCompletedAt");
    const ledgerPath = path.join(directory, "transactions.jsonl");
    fs.writeFileSync(ledgerPath, "", { flag: "wx" });
    event("k6StartAt");
    runner = workload({
      baseUrl: c.baseUrl,
      ledgerPath,
      vus: 100,
      duration: "60s",
      runId: `p3-dr-${runId}`,
      productId: product.id,
      stopAfterOutage: true,
      summaryPath: path.join(directory, "k6-summary.json"),
      onEntry: (tx) => {
        if (
          !report.timestamps.firstCheckoutErrorAt &&
          (tx.status === 0 || tx.status >= 500)
        )
          report.timestamps.k6FirstErrorAt = report.timestamps.firstCheckoutErrorAt =
            tx.responseTimestamp || tx.timestamp;
      },
    });
    await runner.waitForHandshake();
    event("k6HandshakeAt");
    report.vuParticipation = await runner.waitForObservedVUs(100);
    const preFailure = readLedger(ledgerPath);
    if (
      preFailure.malformedCount ||
      !preFailure.entries.some((e) => e.acknowledged === true) ||
      preFailure.entries.some((e) => e.status === 0 || e.status >= 500) ||
      !runner.isAlive()
    )
      throw new Error(
        "No valid acknowledged/error-free K6 baseline before incident",
      );
    await pause(1000);
    const current = await inspectTarget(docker);
    if (
      current.primary.Id !== target.primary.Id ||
      current.volume !== target.volume ||
      !runner.isAlive()
    )
      throw new Error(
        "Primary identity or live workload changed before injection",
      );
    const existingVolumes = (await docker.command(["volume", "ls", "--format", "{{.Name}}"])).split(/\s+/);
    if ([state.primaryVolume, state.replicaVolume].some((name) => existingVolumes.includes(name))) throw new Error("Recovery volume already exists before injection");
    state.originalReplica = report.originalReplica;
    state.preparedAt = new Date().toISOString();
    // Commit the recovery intent BEFORE deleting the original primary. Startup
    // and autoscaling must see it even if this process never reaches finally.
    writeJson(path.join(c.runtime, "recovery.json"), state);
    manifestPersisted = true;
    report.recovery = state;
    event("failureInjectionRequestedAt");
    runner.markOutageRequested(report.timestamps.failureInjectionRequestedAt);
    report.timestamps.failureInjectionAt = report.timestamps.failureInjectionRequestedAt; // Historical RPO convention.
    // Mark before awaiting removal: an ambiguous CLI failure must not skip mandatory recovery.
    injected = true;
    try {
      await docker.command(["rm", "-f", target.primary.Id]);
    } catch (error) {
      report.injectionError = error.message;
      throw error;
    }
    report.primaryUnavailability = await observePrimaryUnavailable(docker, target.primary.Id, report.timestamps.failureInjectionRequestedAt);
    report.timestamps.primaryUnavailableAt = report.primaryUnavailability.primaryUnavailableAt || null;
    event("primaryUnavailabilityVerifiedAt");
    const detection = await detectIncident(() => http(c.baseUrl, "/health"), {
      wait: pause,
    });
    report.detection = detection;
    report.timestamps.failureDetectionAt = detection.detectedAt;
    report.timestamps.t0 = detection.detectedAt;
    const outageProducts = await http(c.baseUrl, "/products");
    const outageCheckout = await checkoutRequest(
      c.baseUrl,
      { user_id: 1, product_id: product.id, qty: 1 },
      `p3-dr-${runId}-outage`,
    );
    const backendLiveness = [];
    for (const backend of backends) {
      try {
        const inspected = await docker.inspect(backend.Id, "backend");
        backendLiveness.push({
          id: backend.Id,
          live: (await docker.probe(backend, "/live")).live === true,
          processSurvived: inspected.State?.Running === true &&
            !!backend.State?.StartedAt && inspected.State.StartedAt === backend.State.StartedAt &&
            inspected.RestartCount === backend.RestartCount && inspected.State.OOMKilled !== true,
          startedAtBefore: backend.State?.StartedAt, startedAtAfter: inspected.State?.StartedAt,
          restartCountBefore: backend.RestartCount, restartCountAfter: inspected.RestartCount,
        });
      } catch (error) {
        backendLiveness.push({
          id: backend.Id,
          live: false,
          error: error.message,
        });
      }
    }
    report.outage = {
      checkoutStatus: outageCheckout.status,
      checkoutError: outageCheckout.body?.error,
      productsStatus: outageProducts.status,
      readFrom: outageProducts.headers?.["x-read-from"],
      backendLiveness,
    };
    // Allow the bounded K6 scenario to drain naturally; every nonzero exit remains a failure.
    report.k6Result = await runner.promise;
    event("k6FinishedAt");
    if (!report.k6Result.ok)
      report.workloadFailure =
        report.k6Result.error || `K6 exit ${report.k6Result.code}`;
    for (const entry of report.outage.backendLiveness) {
      try {
        const after = await docker.inspect(entry.id, "backend");
        entry.processSurvived = entry.processSurvived && after.State.Running === true &&
          after.State.StartedAt === entry.startedAtBefore && after.RestartCount === entry.restartCountBefore;
      } catch (error) { entry.processSurvived = false; entry.error = error.message; }
    }

    // Fence application writers while the fresh primary is restored and audited.
    for (const backend of backends) await docker.inspect(backend.Id, "backend");
    await docker.command(
      ["stop", "--time", "100", ...backends.map((b) => b.Id)],
      { timeout: 120000 },
    );
    event("writersStoppedAt");

    // Standby remains available as a pg_restore validator while the old primary is fenced.
    const validator = { ...originalReplica };
    const validationDocker = Object.create(docker);
    validationDocker.exec = (id, _service, args, opts) =>
      docker.exec(id, "db-replica", args, opts);
    restoreSession = acquireRestoreSession(backupDir, { runId, purpose: "disaster-restore" });
    const selected = await selectBackup(validationDocker, validator, backupDir);
    const pinned = path.join(directory, selected.file);
    fs.copyFileSync(selected.path, pinned, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(
      selected.path + ".sha256",
      pinned + ".sha256",
      fs.constants.COPYFILE_EXCL,
    );
    if (!verifyFileChecksum(pinned).ok)
      throw new Error("Pinned backup checksum mismatch");
    selected.path = pinned;
    report.selectedBackup = {
      file: selected.file,
      sha256: selected.sha256,
      ...selected.meta,
    };
    event("backupSelectedAt");
    await createFreshVolume(docker, state.primaryVolume, runId);
    await createFreshVolume(docker, state.replicaVolume, runId);
    event("restoreStartedAt");
    await docker.compose(["up", "-d", "--no-deps", "--wait", "db-primary"], {
      timeout: 120000,
    });
    const primary = await onlyRunning(
      docker,
      "db-primary",
      state.primaryVolume,
    );
    await docker.exec(
      primary.Id,
      "db-primary",
      [
        "pg_restore",
        "-U",
        "p3_admin",
        "-d",
        SPEC.database,
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
      ],
      { input: fs.readFileSync(selected.path), timeout: 120000 },
    );
    if (
      (await docker.sql(
        "db-primary",
        "SELECT current_database() || '|' || pg_is_in_recovery();",
      )) !== "flashsale_p3|false"
    )
      throw new Error("Recovered primary database/role mismatch");
    await assertIsolation(docker, ["db-primary"]); // Standby still uses its preserved original volume until reconstruction.
    report.primaryAudit = JSON.parse(
      await psql(
        docker,
        primary,
        SPEC.database,
        "SELECT json_build_object('negative_stock',(SELECT count(*) FROM products WHERE stock<0),'duplicate_orders',(SELECT count(*) FROM (SELECT idempotency_key FROM orders GROUP BY 1 HAVING count(*)>1) d),'mismatches',(SELECT count(*) FROM products p WHERE initial_stock-stock<>COALESCE((SELECT sum(qty) FROM orders o WHERE o.product_id=p.id),0)));",
      ),
    );
    if (Object.values(report.primaryAudit).some((v) => v !== 0))
      throw new Error("Independent recovered-primary audit failed");
    event("restoreCompletedAt");
    restoreSession.release();
    restoreSession = null;
    const oldReplica = await docker.inspect(originalReplica.Id, "db-replica");
    if (dataMount(oldReplica) !== report.originalReplica.volume)
      throw new Error("Standby identity changed");
    await docker.command(["stop", "--time", "30", oldReplica.Id]);
    await docker.command(["rm", oldReplica.Id]); // Original replica volume is retained.
    await docker.compose(["up", "-d", "--no-deps", "--wait", "db-replica"], {
      timeout: 120000,
    });
    await onlyRunning(docker, "db-replica", state.replicaVolume);
    await assertIsolation(docker);
    event("standbyRebuiltAt");
    await docker.compose(["start", "backend"], { timeout: 120000 });
    const ready = [];
    for (const backend of (await docker.list("backend")).filter(
      (b) => b.State.Running,
    )) {
      const deadline = Date.now() + c.readyTimeout;
      let healthy = false;
      do {
        try {
          healthy = (await docker.probe(backend, "/ready")).ready === true;
        } catch {}
        if (!healthy) await pause(250);
      } while (!healthy && Date.now() < deadline);
      if (!healthy) throw new Error("Recovered backend not ready");
      ready.push({
        id: backend.Id,
        ip: backend.NetworkSettings.Networks[`${c.project}_p3`].IPAddress,
      });
    }
    if (ready.length !== backends.length)
      throw new Error("Recovered backend membership changed");
    await applyRouting(ready);
    report.recoveryHealth = (
      await waitApplication(docker, report, http, pause)
    ).body;
    const checkout = await checkoutRequest(
      c.baseUrl,
      { user_id: 1, product_id: product.id, qty: 1 },
      `p3-dr-${runId}-recovered`,
    );
    if (checkout.status !== 201)
      throw new Error("First recovered checkout failed");
    event("firstSuccessfulRecoveryCheckoutAt");
    const recoveredOrders = JSON.parse(
      await docker.sql(
        "db-primary",
        "SELECT COALESCE(json_agg(o),'[]'::json) FROM (SELECT id,idempotency_key,user_id,product_id,qty,created_at FROM orders) o;",
      ),
    );
    const ledger = readLedger(ledgerPath);
    if (ledger.malformedCount || !ledger.entries.length)
      throw new Error("Missing or malformed external ledger");
    report.reconciliation = compareLedgerWithDatabase(
      ledger.entries,
      recoveredOrders,
      {
        failureTimestamp: report.timestamps.failureInjectionAt,
        failureInjectionRequestedAt: report.timestamps.failureInjectionRequestedAt,
        primaryUnavailableAt: report.timestamps.primaryUnavailableAt,
        backupTimestamp: selected.meta.startTime,
      },
    );
    report.preInjectionLostTransactions =
      report.reconciliation.missingAcknowledgedTransactions.transactions.map(
        (tx) => ({ ...tx, classification: "LOST_COMPENSATION_REQUIRED" }),
      );
    report.lostTransactions = report.reconciliation.allAcknowledgedTransactions.transactions
      .filter(tx => tx.recoveryPresence === "MISSING_FROM_RECOVERED")
      .map(tx => ({ ...tx, classification: "LOST_COMPENSATION_REQUIRED" }));
    report.lateAcknowledgements = report.reconciliation.lateAcknowledgements;
    const approvedReplay = options.acknowledgedReplayApproval
      ? await approvedLedgerReplay({
          transactions: report.reconciliation.allAcknowledgedTransactions.transactions,
          approval: options.acknowledgedReplayApproval, baseUrl: c.baseUrl, http, checkout: checkoutRequest,
        })
      : {};
    report.acknowledgementReconciliation = await reconcileAcknowledgements({
      transactions: report.reconciliation.allAcknowledgedTransactions.transactions,
      recoveredOrders,
      // Default is review only. No missing ACK is silently replayed or compensated.
      ...(options.acknowledgementReview || {}),
      journalPath: path.join(directory, "acknowledgement-reconciliation.jsonl"),
      checkout: (payload, key) => checkoutRequest(c.baseUrl, payload, key),
      lookup: async (key) => JSON.parse(await docker.sql("db-primary",
        `SELECT COALESCE(json_agg(o),'[]'::json) FROM (SELECT id,idempotency_key,user_id,product_id,qty,created_at FROM orders WHERE idempotency_key=convert_from(decode('${Buffer.from(String(key)).toString("base64")}','base64'),'UTF8')) o;`)),
      audit: () => verify(docker),
      ...approvedReplay,
    });
    // RPO is fixed before replay; later replay must not erase evidence of acknowledged loss.
    report.replays = [];
    for (const tx of report.reconciliation.ambiguousTransactions.transactions) {
      const payload = {
        user_id: tx.userId || 1,
        product_id: tx.productId,
        qty: tx.qty,
      };
      const first = await checkoutRequest(
        c.baseUrl,
        payload,
        tx.idempotencyKey,
      );
      const second = [200, 201].includes(first.status)
        ? await checkoutRequest(c.baseUrl, payload, tx.idempotencyKey)
        : null;
      report.replays.push({
        key: tx.idempotencyKey,
        status: first.status,
        repeatStatus: second?.status,
        sameOrder:
          second?.body?.order?.id != null &&
          second.body.order.id === first.body?.order?.id,
        classification:
          first.status === 409
            ? "SOLD_OUT_COMPENSATION_REQUIRED"
            : [200, 201].includes(first.status) &&
                second?.status === 200 &&
                second?.body?.order?.id === first.body?.order?.id
              ? "RECONCILED"
              : "UNRESOLVED",
      });
    }
    report.integrity = await verify(docker); // Includes WAL catch-up and primary/replica comparison.
    if (options.acknowledgedReplayApproval) {
      const rows = JSON.parse(await docker.sql("db-primary",
        `BEGIN READ ONLY; SELECT COALESCE(json_agg(o),'[]'::json) FROM (SELECT id,idempotency_key,user_id,product_id,qty,created_at FROM orders WHERE idempotency_key LIKE 'p3-dr-${runId}-%') o; COMMIT;`));
      report.finalAcknowledgementAudit = auditAcknowledgedOrders(report.reconciliation.allAcknowledgedTransactions.transactions, rows);
      writeJson(path.join(directory, "final-acknowledged-orders.json"), rows);
      if (!report.finalAcknowledgementAudit.allResolved) throw new Error("Independent final SQL ACK audit failed");
    }
    await assertIsolation(docker);
    // Explicit membership and role checks, independent from inventory names.
    await onlyRunning(docker, "db-primary", state.primaryVolume);
    await onlyRunning(docker, "db-replica", state.replicaVolume);
    report.roles = { writablePrimaries: 1, standbys: 1 };
    const stats = await http(c.baseUrl, "/stats");
    report.applicationAudit = stats.body;
    const reads = await http(c.baseUrl, "/products");
    if (
      !report.integrity.consistent ||
      stats.status !== 200 ||
      stats.body?.consistent !== true ||
      reads.status !== 200 ||
      reads.headers?.["x-read-from"] !== "replica"
    )
      throw new Error("Final transaction/stock/replica audit failed");
    event("integrityAuditCompletedAt");
    report.rto = {
      convention: SPEC.rtoConvention,
      seconds: report.timestamps.t0
        ? (Date.parse(report.timestamps.integrityAuditCompletedAt) -
            Date.parse(report.timestamps.t0)) /
          1000
        : null,
      targetSeconds: 300,
    };
    report.rpo = {
      convention: SPEC.rpoConvention,
      seconds: report.reconciliation.actualRpoSeconds,
      targetSeconds: 60,
      snapshotAgeSeconds: report.reconciliation.restorePointAgeSeconds,
    };
    // Fully drain and finalize the workload before any manifest validation.
    report.k6Result = await runner.stop();
    workloadFinalized = true;
    report.validation = evaluateSuccess(report);
    report.success = report.validation.success;
    report.result = report.success ? "PASSED" : "PARTIAL";
    report.requiresManualRecovery = !report.success;
    if (!report.success) {
      report.rto.elapsedUntilIntegrityAuditSeconds = report.rto.seconds;
      report.rto.seconds = null; // No completed business recovery / no T1.
      return report; // Keep recovering manifest and pause.
    }
    report.timestamps.t1 = report.timestamps.integrityAuditCompletedAt;
    writeJson(path.join(c.runtime, "recovery.json"), {
      ...state,
      phase: "validated",
    });
    completed = true;
    return report;
  } catch (error) {
    report.success = false;
    delete report.timestamps.t1;
    report.result = "FAILED";
    report.error = error.message;
    report.requiresManualRecovery = injected || manifestPersisted;
    throw Object.assign(error, { report });
  } finally {
    try {
    if (runner && !workloadFinalized) {
      try { report.k6Result = await runner.stop(); }
      catch (error) { report.k6Result = { ok: false, error: `Workload cleanup failed: ${error.message}` }; }
      if (!report.k6Result.ok)
        report.workloadFailure =
          report.k6Result.error || `K6 exit ${report.k6Result.code}`;
      if (!report.k6Result.ok) {
        report.success = false;
        report.result = "FAILED";
        delete report.timestamps.t1;
      }
    }
    // After an incomplete incident, remain paused and leave all evidence and volumes intact.
    if (restoreSession) restoreSession.release();
    if (previousControl && ((!injected && !manifestPersisted) || completed)) writeJson(controlFile, previousControl);
    } finally {
      try { writeJson(reportFile, report); }
      finally { release(); }
    }
  }
}
function summarizeDisasterRecovery(report, root = process.cwd()) {
  if (report.dryRun) return report;
  const directory = path.join(root, "results/p4", report.runId);
  return {
    runId: report.runId,
    result: report.result,
    success: report.success,
    requiresManualRecovery: report.requiresManualRecovery,
    error: report.error,
    evidence: {
      report: path.join(directory, "report.json"),
      ledger: path.join(directory, "transactions.jsonl"),
      k6Summary: path.join(directory, "k6-summary.json"),
    },
    workload: {
      ok: report.k6Result?.ok,
      exitCode: report.k6Result?.code,
      unexpectedResponses: report.k6Result?.unexpectedResponseCount,
    },
    acknowledgements: {
      total: report.reconciliation?.allAcknowledgedTransactions?.count,
      missingBeforeReplay: report.lostTransactions?.length,
      unresolved: report.acknowledgementReconciliation?.unresolved,
    },
    ambiguous: {
      total: report.replays?.length,
      unresolved: report.replays?.filter(r => r.classification !== "RECONCILED").length,
    },
    rto: report.rto,
    rpo: report.rpo,
    checks: report.validation?.checks,
    failures: report.validation?.failures,
    nextAction: report.acknowledgementReconciliation?.unresolved > 0
      ? "Keep P3 paused. Review preserved-source forensic evidence and reconcile missing ACKs before another DR run. Full evidence remains in report.json."
      : undefined,
  };
}
async function main(args = process.argv.slice(2)) {
  const value = (key) => {
    const i = args.indexOf(key);
    return i < 0 ? undefined : args[i + 1];
  };
  const result = await executeDisasterRecovery({
    execute: args.includes("--execute"),
    confirmPrimary: value("--confirm-primary"),
    confirmVolume: value("--confirm-volume"),
    acknowledgedReplayApproval: value("--approve-ack-replay"),
  });
  console.log(JSON.stringify(summarizeDisasterRecovery(result), null, 2));
  if (!result.dryRun && !result.success) process.exitCode = 1;
  return result;
}
module.exports = {
  SPEC,
  context,
  dataMount,
  inspectTarget,
  requireConfirmation,
  backupCandidates,
  selectBackup,
  detectIncident,
  createFreshVolume,
  planDisasterRecovery,
  executeDisasterRecovery,
  summarizeDisasterRecovery,
  main,
};
