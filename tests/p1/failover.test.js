"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  inspectContainerState,
  validateFencing,
  validateReplicaForPromotion,
  executePromotion,
  getStackConfig,
  getBackendInventory,
  verifyBackendInstances,
} = require("../../scripts/docker-failover");

test("failover: konfigurasi stack P2 dan P3 terdefinisi dengan benar", () => {
  const p2 = getStackConfig("p2");
  const p3 = getStackConfig("p3");
  assert.equal(p2.primaryContainer, "flashsale-db-primary");
  assert.equal(p2.replicaContainer, "flashsale-db-replica");
  assert.equal(p2.project, "flashsale");
  assert.equal(p2.environment, "p2");
  assert.equal(p3.primaryContainer, "flashsale-p3-db-primary-1");
  assert.equal(p3.replicaContainer, "flashsale-p3-db-replica-1");
  assert.equal(p3.project, "flashsale-p3");
  assert.equal(p3.environment, "p3");
});

test("failover: inspectContainerState menerapkan validasi identitas ketat (fail-closed)", () => {
  const baseData = {
    Id: "abc123456789deadbeef",
    State: { Status: "exited", Running: false },
    Config: {
      Labels: {
        "com.docker.compose.project": "flashsale-p3",
        "com.docker.compose.service": "db-primary",
        "flashsale.environment": "p3",
      },
    },
  };

  const createMock = (overrides = {}) => {
    const data = JSON.parse(JSON.stringify(baseData));
    if (overrides.labels) data.Config.Labels = overrides.labels;
    if (overrides.state) data.State = overrides.state;
    return () => ({ ok: true, stdout: JSON.stringify([data]), stderr: "" });
  };

  const expected = { project: "flashsale-p3", service: "db-primary", environment: "p3" };

  // 1. Identitas valid sempurna
  const resValid = inspectContainerState("db-pri", expected, createMock());
  assert.equal(resValid.identityValid, true);
  assert.equal(resValid.status, "exited");

  // 2. Project label hilang
  const resNoProj = inspectContainerState("db-pri", expected, createMock({
    labels: { "com.docker.compose.service": "db-primary", "flashsale.environment": "p3" },
  }));
  assert.equal(resNoProj.identityValid, false);
  assert.match(resNoProj.error, /Project label/);

  // 3. Service label hilang
  const resNoSvc = inspectContainerState("db-pri", expected, createMock({
    labels: { "com.docker.compose.project": "flashsale-p3", "flashsale.environment": "p3" },
  }));
  assert.equal(resNoSvc.identityValid, false);
  assert.match(resNoSvc.error, /Service label/);

  // 4. Environment label hilang
  const resNoEnv = inspectContainerState("db-pri", expected, createMock({
    labels: { "com.docker.compose.project": "flashsale-p3", "com.docker.compose.service": "db-primary" },
  }));
  assert.equal(resNoEnv.identityValid, false);
  assert.match(resNoEnv.error, /Environment label/);

  // 5. Label kosong (empty string)
  const resEmptyProj = inspectContainerState("db-pri", expected, createMock({
    labels: { "com.docker.compose.project": "   ", "com.docker.compose.service": "db-primary", "flashsale.environment": "p3" },
  }));
  assert.equal(resEmptyProj.identityValid, false);
  assert.match(resEmptyProj.error, /Project label/);

  // 6. Project mismatch
  const resProjMismatch = inspectContainerState("db-pri", expected, createMock({
    labels: { "com.docker.compose.project": "wrong-proj", "com.docker.compose.service": "db-primary", "flashsale.environment": "p3" },
  }));
  assert.equal(resProjMismatch.identityValid, false);
  assert.match(resProjMismatch.error, /Project mismatch/);

  // 7. Service mismatch
  const resSvcMismatch = inspectContainerState("db-pri", expected, createMock({
    labels: { "com.docker.compose.project": "flashsale-p3", "com.docker.compose.service": "db-replica", "flashsale.environment": "p3" },
  }));
  assert.equal(resSvcMismatch.identityValid, false);
  assert.match(resSvcMismatch.error, /Service mismatch/);

  // 8. Environment mismatch
  const resEnvMismatch = inspectContainerState("db-pri", expected, createMock({
    labels: { "com.docker.compose.project": "flashsale-p3", "com.docker.compose.service": "db-primary", "flashsale.environment": "p2" },
  }));
  assert.equal(resEnvMismatch.identityValid, false);
  assert.match(resEnvMismatch.error, /Environment mismatch/);

  // 9. Container not found
  const mockNotFound = () => ({ ok: false, stdout: "", stderr: "Error: No such container: db-pri" });
  const resNotFound = inspectContainerState("db-pri", expected, mockNotFound);
  assert.equal(resNotFound.exists, false);
  assert.equal(resNotFound.status, "not_found");

  // 10. Daemon error
  const mockDaemonErr = () => ({ ok: false, stdout: "", stderr: "Cannot connect to the Docker daemon" });
  const resDaemonErr = inspectContainerState("db-pri", expected, mockDaemonErr);
  assert.equal(resDaemonErr.status, "unknown");
});

test("failover: validateFencing menerapkan prinsip fail-closed secara ketat", () => {
  // 1. Status Unknown / error inspect TIDAK boleh dianggap aman
  const unknownState = { exists: null, running: null, status: "unknown", error: "Docker daemon error" };
  const resUnknown = validateFencing(unknownState, null);
  assert.equal(resUnknown.fenced, false, "Status unknown tidak boleh dianggap fenced");
  assert.equal(resUnknown.ambiguous, true, "Status unknown harus ditandai ambigu");
  assert.match(resUnknown.reason, /fail-closed/);

  // 2. Status 'not_found' TIDAK boleh otomatis dianggap bukti fencing
  const notFoundState = { exists: false, running: false, status: "not_found", error: "Container not found" };
  const resNotFound = validateFencing(notFoundState, null);
  assert.equal(resNotFound.fenced, false, "Status not_found tidak boleh dianggap fenced");
  assert.equal(resNotFound.ambiguous, true);
  assert.match(resNotFound.reason, /not_found/);

  // 3. Status 'identity_mismatch' harus ditolak
  const mismatchState = { exists: true, running: false, status: "identity_mismatch", identityValid: false, error: "Project mismatch" };
  const resMismatch = validateFencing(mismatchState, null);
  assert.equal(resMismatch.fenced, false);
  assert.equal(resMismatch.ambiguous, true);

  // 4. Container masih running TIDAK aman
  const runningState = { exists: true, running: true, status: "running", identityValid: true, error: null };
  const pgRunning = { success: true, output: "f", error: null };
  const resRunning = validateFencing(runningState, pgRunning);
  assert.equal(resRunning.fenced, false, "Container running tidak boleh fenced");
  assert.match(resRunning.reason, /NOT FENCED/);

  // 5. Container dalam status transisi (restarting / paused) TIDAK aman
  const restartingState = { exists: true, running: false, status: "restarting", identityValid: true, error: null };
  const resRestarting = validateFencing(restartingState, null);
  assert.equal(resRestarting.fenced, false);
  assert.equal(resRestarting.ambiguous, true);

  // 6. Container terhenti secara definitif (exited) dengan identitas valid terbukti FENCED
  const stoppedState = { exists: true, running: false, status: "exited", identityValid: true, error: null };
  const resStopped = validateFencing(stoppedState, null);
  assert.equal(resStopped.fenced, true, "Stopped container harus berstatus fenced");
  assert.equal(resStopped.ambiguous, false);
});

test("failover: validateReplicaForPromotion memvalidasi identitas dan standby recovery mode", () => {
  // 1. Replica stopped / unknown
  const stoppedReplica = { exists: true, running: false, status: "stopped", error: null };
  const resStopped = validateReplicaForPromotion(stoppedReplica, { success: true, output: "t" });
  assert.equal(resStopped.ready, false, "Replica stopped tidak boleh ready");

  // 2. Query error ke replica
  const runningReplica = { exists: true, running: true, status: "running", identityValid: true, error: null };
  const resQueryError = validateReplicaForPromotion(runningReplica, { success: false, error: "Connection error" });
  assert.equal(resQueryError.ready, false, "Jika query recovery gagal, tidak boleh ready");
  assert.match(resQueryError.reason, /gagal/);

  // 3. Replica bukan standby (sudah primary / in_recovery = 'f')
  const resNotRecovery = validateReplicaForPromotion(runningReplica, { success: true, output: "f" });
  assert.equal(resNotRecovery.ready, false, "Replica bukan standby tidak boleh ready");
  assert.match(resNotRecovery.reason, /tidak berada dalam mode standby/);

  // 4. Replica identity mismatch
  const replicaMismatch = { exists: true, running: true, status: "identity_mismatch", identityValid: false, error: "Service mismatch" };
  const resMismatch = validateReplicaForPromotion(replicaMismatch, { success: true, output: "t" });
  assert.equal(resMismatch.ready, false);
  assert.match(resMismatch.reason, /Identitas container replica tidak valid/);

  // 5. Replica valid dalam recovery mode (in_recovery = 't')
  const resValid = validateReplicaForPromotion(runningReplica, { success: true, output: "t" });
  assert.equal(resValid.ready, true, "Replica standby valid untuk dipromosikan");
});

test("failover: executePromotion berhasil saat pg_promote(false) sukses dan recovery berubah menjadi false", () => {
  let promoteCalledWith = null;
  let recoveryChecks = 0;

  const mockExec = (cmd) => {
    if (cmd.includes("pg_promote(false)")) {
      promoteCalledWith = "pg_promote(false)";
      return { ok: true, stdout: "t", stderr: "" };
    }
    if (cmd.includes("pg_is_in_recovery()")) {
      recoveryChecks++;
      return { ok: true, stdout: recoveryChecks >= 2 ? "f" : "t", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const res = executePromotion("test-replica", "postgres", "flashsale", mockExec, {
    maxWaitSeconds: 10,
    pollIntervalMs: 5,
    sleepFn: () => {},
  });

  assert.equal(promoteCalledWith, "pg_promote(false)");
  assert.equal(res.success, true);
  assert.equal(res.postRecovery, "f");
  assert.equal(res.inProgress, false);
});

test("failover: executePromotion gagal saat pg_promote(false) ditolak postgres", () => {
  const mockExecReject = (cmd) => {
    if (cmd.includes("pg_promote(false)")) {
      return { ok: false, stdout: "", stderr: "permission denied for function pg_promote" };
    }
    return { ok: true, stdout: "t", stderr: "" };
  };

  const res = executePromotion("test-replica", "postgres", "flashsale", mockExecReject, {
    maxWaitSeconds: 5,
    pollIntervalMs: 5,
    sleepFn: () => {},
  });

  assert.equal(res.success, false);
  assert.equal(res.inProgress, false);
  assert.match(res.error, /permission denied/);
});

test("failover: executePromotion mendeteksi timeout saat promosi masih berlangsung di background", () => {
  const mockExecStillReplaying = (cmd) => {
    if (cmd.includes("pg_promote(false)")) {
      return { ok: true, stdout: "t", stderr: "" };
    }
    if (cmd.includes("pg_is_in_recovery()")) {
      return { ok: true, stdout: "t", stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const res = executePromotion("test-replica", "postgres", "flashsale", mockExecStillReplaying, {
    maxWaitSeconds: 0.05,
    pollIntervalMs: 10,
    sleepFn: () => {},
  });

  assert.equal(res.success, false);
  assert.equal(res.inProgress, true);
  assert.equal(res.timedOut, true);
  assert.match(res.error, /Timeout/);
  assert.equal(res.postRecovery, "t");
});

test("failover: executePromotion menangani kondisi hasil pemeriksaan postgres tidak tersedia saat timeout", () => {
  const mockExecDbUnavail = (cmd) => {
    if (cmd.includes("pg_promote(false)")) {
      return { ok: true, stdout: "t", stderr: "" };
    }
    if (cmd.includes("pg_is_in_recovery()")) {
      return { ok: false, stdout: "", stderr: "FATAL: the database system is shutting down" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const res = executePromotion("test-replica", "postgres", "flashsale", mockExecDbUnavail, {
    maxWaitSeconds: 0.05,
    pollIntervalMs: 10,
    sleepFn: () => {},
  });

  assert.equal(res.success, false);
  assert.equal(res.inProgress, true);
  assert.match(res.error, /tidak dapat diverifikasi/);
});

test("failover: getBackendInventory mendeteksi jumlah instance dinamis (2, 3, 6) dan menolak anomali", () => {
  const makeComposePsOutput = (count) => {
    const lines = [];
    for (let i = 1; i <= count; i++) {
      lines.push(JSON.stringify({
        Name: `flashsale-p3-backend-${i}`,
        Project: "flashsale-p3",
        Service: "backend",
        State: "running",
      }));
    }
    return lines.join("\n");
  };

  const mockExecForCount = (count) => (cmd) => {
    if (cmd.includes("docker compose") && cmd.includes("ps --format json backend")) {
      return { ok: true, stdout: makeComposePsOutput(count), stderr: "" };
    }
    if (cmd.includes("docker inspect")) {
      return {
        ok: true,
        stdout: JSON.stringify([{
          Id: "test-id",
          State: { Status: "running", Running: true },
          Config: {
            Labels: {
              "com.docker.compose.project": "flashsale-p3",
              "com.docker.compose.service": "backend",
              "flashsale.environment": "p3",
            },
          },
        }]),
        stderr: "",
      };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  // 1. Dua backend
  const inv2 = getBackendInventory("p3", mockExecForCount(2));
  assert.equal(inv2.ok, true);
  assert.equal(inv2.count, 2);

  // 2. Tiga backend
  const inv3 = getBackendInventory("p3", mockExecForCount(3));
  assert.equal(inv3.ok, true);
  assert.equal(inv3.count, 3);

  // 3. Enam backend
  const inv6 = getBackendInventory("p3", mockExecForCount(6));
  assert.equal(inv6.ok, true);
  assert.equal(inv6.count, 6);

  // 4. Tidak ada backend (0 backend)
  const inv0 = getBackendInventory("p3", () => ({
    ok: true,
    stdout: "",
    stderr: "",
  }));
  assert.equal(inv0.ok, false);
  assert.match(inv0.error, /Tidak ada backend/);

  // 5. Container asing / inconsistent labels
  const mockExecForeign = (cmd) => {
    if (cmd.includes("ps --format json backend")) {
      return {
        ok: true,
        stdout: JSON.stringify({ Name: "rogue-container", Project: "alien-project", Service: "backend", State: "running" }),
        stderr: "",
      };
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  const invForeign = getBackendInventory("p3", mockExecForeign);
  assert.equal(invForeign.ok, false);
  assert.match(invForeign.error, /container asing/);
});

test("failover: verifyBackendInstances membedakan kondisi PASS, FAIL, dan UNKNOWN", () => {
  const cfg = getStackConfig("p3");

  // 1. Semua backend sukses terverifikasi (PASS)
  const mockPass = (cmd) => {
    if (cmd.includes("docker inspect --format") && cmd.includes("flashsale-p3-db-replica-1")) {
      return { ok: true, stdout: "172.20.0.4\n", stderr: "" };
    }
    if (cmd.includes("ps --format json backend")) {
      return {
        ok: true,
        stdout: JSON.stringify({ Name: "flashsale-p3-backend-1", Project: "flashsale-p3", Service: "backend", State: "running" }),
        stderr: "",
      };
    }
    if (cmd.includes("docker inspect flashsale-p3-backend-1")) {
      return {
        ok: true,
        stdout: JSON.stringify([{
          Id: "b1",
          State: { Status: "running", Running: true },
          Config: {
            Labels: { "com.docker.compose.project": "flashsale-p3", "com.docker.compose.service": "backend", "flashsale.environment": "p3" },
          },
        }]),
        stderr: "",
      };
    }
    if (cmd.includes("node -e")) {
      return {
        ok: true,
        stdout: JSON.stringify({ ok: true, db_name: "flashsale_p3", in_recovery: false, db_host: "db-replica", server_ip: "172.20.0.4", backend_id: "b1" }),
        stderr: "",
      };
    }
    if (cmd.includes("wget")) {
      return { ok: true, stdout: JSON.stringify({ status: "ok", db: "up" }), stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const vPass = verifyBackendInstances(cfg, "db-replica", mockPass);
  assert.equal(vPass.status, "PASS");
  assert.equal(vPass.results.length, 1);
  assert.equal(vPass.results[0].pass, true);

  // 2. Database gagal koneksi (FAIL)
  const mockFailConn = (cmd) => {
    if (cmd.includes("ps --format json backend")) {
      return {
        ok: true,
        stdout: JSON.stringify({ Name: "flashsale-p3-backend-1", Project: "flashsale-p3", Service: "backend", State: "running" }),
        stderr: "",
      };
    }
    if (cmd.includes("docker inspect")) {
      return {
        ok: true,
        stdout: JSON.stringify([{
          Id: "b1",
          State: { Status: "running", Running: true },
          Config: { Labels: { "com.docker.compose.project": "flashsale-p3", "com.docker.compose.service": "backend", "flashsale.environment": "p3" } },
        }]),
        stderr: "",
      };
    }
    if (cmd.includes("node -e")) {
      return { ok: false, stdout: JSON.stringify({ ok: false, error: "ECONNREFUSED" }), stderr: "ECONNREFUSED" };
    }
    if (cmd.includes("wget")) {
      return { ok: true, stdout: JSON.stringify({ status: "degraded", db: "down" }), stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const vFailConn = verifyBackendInstances(cfg, "db-replica", mockFailConn);
  assert.equal(vFailConn.status, "FAIL");
  assert.equal(vFailConn.results[0].pass, false);

  // 3. PostgreSQL masih standby (FAIL)
  const mockFailStandby = (cmd) => {
    if (cmd.includes("ps --format json backend") || cmd.includes("docker inspect")) {
      return mockPass(cmd);
    }
    if (cmd.includes("node -e")) {
      return {
        ok: true,
        stdout: JSON.stringify({ ok: true, db_name: "flashsale_p3", in_recovery: true, db_host: "db-replica", server_ip: "172.20.0.4", backend_id: "b1" }),
        stderr: "",
      };
    }
    if (cmd.includes("wget")) {
      return { ok: true, stdout: JSON.stringify({ status: "degraded", db: "read_only" }), stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  const vFailStandby = verifyBackendInstances(cfg, "db-replica", mockFailStandby);
  assert.equal(vFailStandby.status, "FAIL");
  assert.equal(vFailStandby.results[0].pass, false);
  assert.match(vFailStandby.results[0].failures[0], /masih standby/);

  // 4. Inventory tidak dapat diverifikasi (UNKNOWN)
  const mockUnknown = () => ({ ok: false, stdout: "", stderr: "Docker daemon connection error" });
  const vUnknown = verifyBackendInstances(cfg, "db-replica", mockUnknown);
  assert.equal(vUnknown.status, "UNKNOWN");
});

test("failover: verifyBackendInstances mendeteksi backend masih terhubung ke primary lama (DB_HOST atau IP mismatch)", () => {
  const cfg = getStackConfig("p3");

  const createMock = (probeOverride = {}) => (cmd) => {
    // Mock target container inspect IP: target replica adalah 172.20.0.4
    if (cmd.includes("docker inspect --format") && cmd.includes("flashsale-p3-db-replica-1")) {
      return { ok: true, stdout: "172.20.0.4\n", stderr: "" };
    }
    // Mock inventory compose ps
    if (cmd.includes("ps --format json backend")) {
      return {
        ok: true,
        stdout: JSON.stringify({ Name: "flashsale-p3-backend-1", Project: "flashsale-p3", Service: "backend", State: "running" }),
        stderr: "",
      };
    }
    // Mock container inspect backend
    if (cmd.includes("docker inspect flashsale-p3-backend-1")) {
      return {
        ok: true,
        stdout: JSON.stringify([{
          Id: "b1",
          State: { Status: "running", Running: true },
          Config: {
            Labels: { "com.docker.compose.project": "flashsale-p3", "com.docker.compose.service": "backend", "flashsale.environment": "p3" },
          },
        }]),
        stderr: "",
      };
    }
    // Mock node -e probe
    if (cmd.includes("node -e")) {
      const probeData = Object.assign({
        ok: true,
        db_name: "flashsale_p3",
        in_recovery: false,
        db_host: "db-primary", // default: masih primary lama
        server_ip: "172.20.0.2", // IP primary lama
        backend_id: "b1",
      }, probeOverride);
      return { ok: true, stdout: JSON.stringify(probeData), stderr: "" };
    }
    // Mock health HTTP
    if (cmd.includes("wget")) {
      return { ok: true, stdout: JSON.stringify({ status: "ok", db: "up" }), stderr: "" };
    }
    return { ok: true, stdout: "", stderr: "" };
  };

  // Skenario 1: Backend masih menggunakan DB_HOST=db-primary dan server_ip=172.20.0.2 (keduanya lama)
  const mockBothOld = createMock({ db_host: "db-primary", server_ip: "172.20.0.2" });
  const resBothOld = verifyBackendInstances(cfg, "db-replica", mockBothOld);
  assert.equal(resBothOld.status, "FAIL");
  assert.equal(resBothOld.results[0].pass, false);
  const failTextsBoth = resBothOld.results[0].failures.join(" ");
  assert.match(failTextsBoth, /DB_HOST mismatch/);
  assert.match(failTextsBoth, /Target database IP mismatch/);
  assert.match(failTextsBoth, /backend masih terhubung ke primary lama/);

  // Skenario 2: DB_HOST sudah 'db-replica', namun pool belum di-restart sehingga server_ip masih ke primary lama (172.20.0.2)
  const mockStalePool = createMock({ db_host: "db-replica", server_ip: "172.20.0.2" });
  const resStalePool = verifyBackendInstances(cfg, "db-replica", mockStalePool);
  assert.equal(resStalePool.status, "FAIL");
  assert.equal(resStalePool.results[0].pass, false);
  const failTextsPool = resStalePool.results[0].failures.join(" ");
  assert.doesNotMatch(failTextsPool, /DB_HOST mismatch/);
  assert.match(failTextsPool, /Target database IP mismatch/);
  assert.match(failTextsPool, /koneksi aktif ke '172.20.0.2', diharapkan '172.20.0.4'/);

  // Skenario 3: Backend benar-benar terhubung ke replica baru (db_host='db-replica', server_ip='172.20.0.4')
  const mockSwitched = createMock({ db_host: "db-replica", server_ip: "172.20.0.4" });
  const resSwitched = verifyBackendInstances(cfg, "db-replica", mockSwitched);
  assert.equal(resSwitched.status, "PASS");
  assert.equal(resSwitched.results[0].pass, true);
  assert.equal(resSwitched.results[0].failures.length, 0);
  assert.equal(resSwitched.results[0].dbHost, "db-replica");
  assert.equal(resSwitched.results[0].serverIp, "172.20.0.4");

  // Skenario 4: Docker inspect IP untuk target container database gagal (IP tidak tersedia) -> UNKNOWN/FAIL
  const mockInspectIpFail = (cmd) => {
    if (cmd.includes("docker inspect --format") && cmd.includes("flashsale-p3-db-replica-1")) {
      return { ok: false, stdout: "", stderr: "No such container" };
    }
    return createMock()(cmd);
  };
  const resInspectFail = verifyBackendInstances(cfg, "db-replica", mockInspectIpFail);
  assert.equal(resInspectFail.status, "UNKNOWN");
  assert.match(resInspectFail.message, /Gagal memperoleh IP container database target/);
});

test("failover: validateReplicaForPromotion memvalidasi replication freshness dan menandai RPO UNKNOWN jika primary terisolasi", () => {
  const runningReplica = { exists: true, running: true, status: "running", identityValid: true, error: null };
  const pgRunning = { success: true, output: "t" };

  // 1. Freshness dengan WAL in-sync
  const lsnSync = {
    receiveLsn: "0/306E900",
    replayLsn: "0/306E900",
    replayTimestamp: "2026-11-08 00:00:00+00",
  };
  const resSync = validateReplicaForPromotion(runningReplica, pgRunning, lsnSync);
  assert.equal(resSync.ready, true);
  assert.equal(resSync.freshness.replaySync, true);
  assert.match(resSync.freshness.rpoStatus, /UNKNOWN/);

  // 2. Freshness dengan WAL replay pending (receive != replay)
  const lsnLag = {
    receiveLsn: "0/3070000",
    replayLsn: "0/306E900",
    replayTimestamp: "2026-11-08 00:00:00+00",
  };
  const resLag = validateReplicaForPromotion(runningReplica, pgRunning, lsnLag);
  assert.equal(resLag.ready, true);
  assert.equal(resLag.freshness.replaySync, false);
  assert.match(resLag.freshness.rpoStatus, /UNKNOWN/);

  // 3. Tanpa data LSN (primary mati total, LSN null) -> RPO tetap UNKNOWN
  const resNoLsn = validateReplicaForPromotion(runningReplica, pgRunning, null);
  assert.equal(resNoLsn.ready, true);
  assert.equal(resNoLsn.freshness.replaySync, false);
  assert.match(resNoLsn.freshness.rpoStatus, /UNKNOWN/);
});
