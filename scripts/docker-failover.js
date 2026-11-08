"use strict";
/**
 * scripts/docker-failover.js
 * Prosedur Manual Failover PostgreSQL Multi-Container dengan Fail-Closed Validation
 *
 * Standar DRP Kelompok 1 (Pertemuan 1 & 2):
 * 1. Deteksi kegagalan primary dengan validasi fail-closed (status ambigu ditolak).
 * 2. Fencing terhadap primary lama: bukti definitif container primary berhenti/diisolasi
 *    dengan verifikasi identitas project, service, dan environment label.
 *    Status 'not_found' atau 'unknown' TIDAK dianggap aman (fail-closed).
 * 3. Promosi replica menjadi primary baru menggunakan pg_promote(false) asynchronous
 *    dengan polling pg_is_in_recovery() dan deteksi timeout terstruktur.
 * 4. Pengalihan koneksi backend API: panduan recreate container backend yang tepat
 *    (tanpa docker compose restart, tanpa menyentuh volume, menjaga instance count P3).
 * 5. Pencegahan split-brain (dilarang promosi jika status primary ambigu atau masih aktif).
 * 6. Larangan automatic failback tanpa rekonsiliasi.
 * 7. Prosedur reintegrasi primary lama sebagai replica baru via pg_basebackup.
 *
 * Mode:
 *   node scripts/docker-failover.js --plan [p2|p3]       (Default: audit & verifikasi kesiapan)
 *   node scripts/docker-failover.js --promote [p2|p3] --confirm-fenced --allow-promotion
 *   node scripts/docker-failover.js --verify-backend [p2|p3] (Verifikasi pengalihan backend)
 */

const { execSync } = require("node:child_process");

function sh(cmd, timeoutMs = 15000) {
  try {
    const stdout = execSync(cmd, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || "").toString().trim(),
      stderr: (err.stderr || err.message || "").toString().trim(),
    };
  }
}

function getStackConfig(target = "p2") {
  if (target === "p3") {
    return {
      stack: "p3",
      project: "flashsale-p3",
      environment: "p3",
      primaryService: "db-primary",
      replicaService: "db-replica",
      primaryContainer: "flashsale-p3-db-primary-1",
      replicaContainer: "flashsale-p3-db-replica-1",
      dbUser: "p3_admin",
      dbName: "flashsale_p3",
      composeFile: "docker-compose.p3.yml",
      network: "flashsale-p3_p3",
      expectedHostPort: "None (internal network only, accessed via container proxy)",
      baseUrl: "http://127.0.0.1:8080",
    };
  }
  return {
    stack: "p2",
    project: "flashsale",
    environment: "p2",
    primaryService: "db-primary",
    replicaService: "db-replica",
    primaryContainer: "flashsale-db-primary",
    replicaContainer: "flashsale-db-replica",
    dbUser: "postgres",
    dbName: "flashsale",
    composeFile: "docker-compose.yml",
    network: "flashsale-network",
    expectedHostPort: "5433 (replica host port)",
    baseUrl: "http://127.0.0.1",
  };
}

function inspectContainerState(containerName, expectedIdentity = {}, execFn = sh) {
  const res = execFn(`docker inspect ${containerName}`);

  if (!res.ok) {
    if (res.stderr.includes("No such object") || res.stderr.includes("Error: No such container") || res.stderr.includes("not found")) {
      return {
        exists: false,
        running: false,
        status: "not_found",
        id: null,
        labels: {},
        identityValid: false,
        error: "Container tidak ditemukan",
      };
    }
    return {
      exists: null,
      running: null,
      status: "unknown",
      id: null,
      labels: {},
      identityValid: false,
      error: res.stderr || "Docker inspect failed",
    };
  }

  let data;
  try {
    const parsed = JSON.parse(res.stdout);
    data = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    return {
      exists: null,
      running: null,
      status: "unknown",
      id: null,
      labels: {},
      identityValid: false,
      error: `JSON parse inspect failed: ${err.message}`,
    };
  }

  if (!data || !data.State) {
    return {
      exists: false,
      running: false,
      status: "not_found",
      id: null,
      labels: {},
      identityValid: false,
      error: "Container data empty",
    };
  }

  const status = (data.State.Status || "").trim().toLowerCase();
  const running = Boolean(data.State.Running);
  const labels = data.Config?.Labels || {};
  const project = (labels["com.docker.compose.project"] || "").trim();
  const service = (labels["com.docker.compose.service"] || "").trim();
  const env = (labels["flashsale.environment"] || "").trim();
  const cid = (data.Id || "").slice(0, 12);

  // Strict Fail-Closed Identity Validation:
  // 1. com.docker.compose.project wajib tersedia dan cocok
  // 2. com.docker.compose.service wajib tersedia dan cocok
  // 3. flashsale.environment wajib tersedia dan cocok
  // 4. Label kosong, hilang, atau mismatch -> identityValid = false
  let identityValid = true;
  let identityMismatchReason = null;

  if (!project) {
    identityValid = false;
    identityMismatchReason = "Project label ('com.docker.compose.project') missing or empty";
  } else if (expectedIdentity.project && project !== expectedIdentity.project) {
    identityValid = false;
    identityMismatchReason = `Project mismatch (aktual: '${project}', diharapkan: '${expectedIdentity.project}')`;
  } else if (!service) {
    identityValid = false;
    identityMismatchReason = "Service label ('com.docker.compose.service') missing or empty";
  } else if (expectedIdentity.service && service !== expectedIdentity.service) {
    identityValid = false;
    identityMismatchReason = `Service mismatch (aktual: '${service}', diharapkan: '${expectedIdentity.service}')`;
  } else if (!env) {
    identityValid = false;
    identityMismatchReason = "Environment label ('flashsale.environment') missing or empty";
  } else if (expectedIdentity.environment && env !== expectedIdentity.environment) {
    identityValid = false;
    identityMismatchReason = `Environment mismatch (aktual: '${env}', diharapkan: '${expectedIdentity.environment}')`;
  }

  return {
    exists: true,
    running,
    status: identityValid ? status : "identity_mismatch",
    id: cid,
    labels: { project, service, environment: env },
    identityValid,
    error: identityMismatchReason,
  };
}

function queryPostgres(containerName, user, db, query, execFn = sh) {
  const cmd = `docker exec ${containerName} psql -U ${user} -d ${db} -AtXc "${query}"`;
  const res = execFn(cmd, 15000);
  if (!res.ok) {
    return { success: false, output: null, error: res.stderr || "Query failed" };
  }
  return { success: true, output: res.stdout, error: null };
}

function validateFencing(primaryState, primaryPostgresState) {
  // 1. Status 'not_found' TIDAK boleh otomatis dianggap bukti fencing
  if (primaryState.status === "not_found" || primaryState.exists === false) {
    return {
      fenced: false,
      ambiguous: true,
      reason: "Container primary tidak ditemukan (not_found). Ketidakhadiran container tidak membuktikan bahwa proses database telah di-fence (fail-closed).",
    };
  }

  // 2. Fail-closed: jika status container unknown atau inspect error
  if (primaryState.status === "unknown" || (primaryState.error && primaryState.status !== "identity_mismatch")) {
    return {
      fenced: false,
      ambiguous: true,
      reason: `Pemeriksaan container primary gagal (${primaryState.error}). Status ambigu tidak boleh diasumsikan aman (fail-closed).`,
    };
  }

  // 3. Status 'identity_mismatch'
  if (primaryState.status === "identity_mismatch" || !primaryState.identityValid) {
    return {
      fenced: false,
      ambiguous: true,
      reason: `Identitas container primary tidak sesuai: ${primaryState.error} (fail-closed).`,
    };
  }

  // 4. Jika container masih running:
  if (primaryState.running === true) {
    if (primaryPostgresState && primaryPostgresState.output === "f") {
      return {
        fenced: false,
        ambiguous: false,
        reason: "Container primary masih berjalan aktif dan PostgreSQL melayani transaksi tulis (in_recovery=f). NOT FENCED.",
      };
    }
    return {
      fenced: false,
      ambiguous: true,
      reason: `Container primary masih berstatus RUNNING (status: ${primaryState.status}). Primary belum di-fence.`,
    };
  }

  // 5. Kondisi non-definitif (restarting, paused, dll)
  if (primaryState.status === "restarting" || primaryState.status === "paused") {
    return {
      fenced: false,
      ambiguous: true,
      reason: `Container primary berada dalam status transisi '${primaryState.status}'. Bukan penghentian definitif (fail-closed).`,
    };
  }

  // 6. Hanya container yang benar-benar terhenti secara definitif (exited/stopped) yang diterima
  if (primaryState.running === false && (primaryState.status === "exited" || primaryState.status === "stopped")) {
    // Jika postgres query masih bisa merespons (mis. port proxy lain), tolak
    if (primaryPostgresState && primaryPostgresState.success) {
      return {
        fenced: false,
        ambiguous: true,
        reason: "PostgreSQL primary masih merespons query meskipun container dilaporkan stopped. NOT FENCED.",
      };
    }

    return {
      fenced: true,
      ambiguous: false,
      reason: `Container primary terbukti terhenti secara definitif (status: ${primaryState.status}, running=false). Fenced.`,
    };
  }

  return {
    fenced: false,
    ambiguous: true,
    reason: `Kondisi primary tidak dapat dipastikan (${primaryState.status}). Fail-closed.`,
  };
}

function validateReplicaForPromotion(replicaState, replicaPostgresState, lsnState = null) {
  if (!replicaState || replicaState.status === "not_found" || replicaState.exists === false) {
    return {
      ready: false,
      reason: "Container replica tidak ditemukan (not_found).",
      freshness: null,
    };
  }
  if (replicaState.status === "unknown" || (replicaState.error && replicaState.status !== "identity_mismatch")) {
    return {
      ready: false,
      reason: `Pemeriksaan container replica gagal (${replicaState.error}). Fail-closed.`,
      freshness: null,
    };
  }
  if (replicaState.status === "identity_mismatch" || !replicaState.identityValid) {
    return {
      ready: false,
      reason: `Identitas container replica tidak valid: ${replicaState.error || "Identity invalid"}. Promosi ditolak.`,
      freshness: null,
    };
  }
  if (!replicaState.running) {
    return {
      ready: false,
      reason: `Container replica tidak berjalan (status: ${replicaState.status}). Promosi ditolak.`,
      freshness: null,
    };
  }
  if (!replicaPostgresState || !replicaPostgresState.success) {
    return {
      ready: false,
      reason: `Pemeriksaan PostgreSQL replica gagal: ${replicaPostgresState ? replicaPostgresState.error : "tidak ada data"}.`,
      freshness: null,
    };
  }
  if (replicaPostgresState.output !== "t") {
    return {
      ready: false,
      reason: `PostgreSQL pada replica tidak berada dalam mode standby (pg_is_in_recovery() = '${replicaPostgresState.output}', diharapkan 't').`,
      freshness: null,
    };
  }

  // Analisis Freshness & WAL Replay Lag
  const freshness = {
    receiveLsn: lsnState?.receiveLsn || null,
    replayLsn: lsnState?.replayLsn || null,
    replayTimestamp: lsnState?.replayTimestamp || null,
    replayLagBytes: lsnState?.replayLagBytes ?? null,
    replaySync: false,
    rpoStatus: "UNKNOWN (Primary lama tidak dapat diakses; WAL yang belum diterima replica tidak dapat dipastikan)",
  };

  if (freshness.receiveLsn && freshness.replayLsn) {
    freshness.replaySync = freshness.receiveLsn === freshness.replayLsn;
  }

  return {
    ready: true,
    reason: "Container replica aktif dan PostgreSQL berada dalam mode hot standby valid (in_recovery=t).",
    freshness,
  };
}

/**
 * Eksekusi promosi PostgreSQL secara asynchronous via pg_promote(false)
 * dengan polling terstruktur pg_is_in_recovery() hingga berubah menjadi 'f'.
 */
function executePromotion(
  container,
  user,
  db,
  execFn = sh,
  options = { maxWaitSeconds: 30, pollIntervalMs: 1000, sleepFn: null }
) {
  const maxWait = options.maxWaitSeconds || 30;
  const pollInterval = options.pollIntervalMs || 1000;
  const sleep = options.sleepFn || ((ms) => {
    // Sinkron sleep sederhana jika tidak disediakan
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  });

  // 1. Memicu promosi asynchronous: pg_promote(false)
  // Parameter wait=false menginstruksikan PostgreSQL untuk segera kembali dengan 't'
  // dan memproses promosi di background tanpa terbentur execSync timeout.
  const promoteRes = queryPostgres(container, user, db, "SELECT pg_promote(false)", execFn);
  if (!promoteRes.success) {
    return {
      success: false,
      inProgress: false,
      timedOut: false,
      error: `Eksekusi pg_promote(false) gagal: ${promoteRes.error}`,
      postRecovery: null,
    };
  }

  if (promoteRes.output !== "t") {
    return {
      success: false,
      inProgress: false,
      timedOut: false,
      error: `pg_promote(false) mengembalikan '${promoteRes.output}', promosi gagal dipicu`,
      postRecovery: null,
    };
  }

  // 2. Polling pg_is_in_recovery() hingga berubah menjadi 'f'
  const startTime = Date.now();
  let lastKnownRecovery = "t";
  let pollAttempts = 0;

  while ((Date.now() - startTime) < maxWait * 1000) {
    pollAttempts++;
    const check = queryPostgres(container, user, db, "SELECT pg_is_in_recovery()", execFn);

    if (check.success && check.output === "f") {
      const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
      return {
        success: true,
        inProgress: false,
        timedOut: false,
        error: null,
        postRecovery: "f",
        elapsedSeconds: Number(elapsedSec),
        attempts: pollAttempts,
      };
    }

    if (check.success) {
      lastKnownRecovery = check.output;
    }

    // Jika ini bukan iterasi terakhir, sleep sebelum polling berikutnya
    if ((Date.now() - startTime + pollInterval) < maxWait * 1000) {
      sleep(pollInterval);
    } else {
      break;
    }
  }

  // 3. Timeout handling & status check aktual
  const finalCheck = queryPostgres(container, user, db, "SELECT pg_is_in_recovery()", execFn);
  if (finalCheck.success && finalCheck.output === "f") {
    return {
      success: true,
      inProgress: false,
      timedOut: false,
      error: null,
      postRecovery: "f",
      attempts: pollAttempts + 1,
    };
  }

  if (finalCheck.success && finalCheck.output === "t") {
    return {
      success: false,
      inProgress: true,
      timedOut: true,
      error: `Timeout (${maxWait}s) tercapai saat promosi masih berlangsung. pg_is_in_recovery() masih bernilai 't'. Periksa log PostgreSQL.`,
      postRecovery: "t",
      attempts: pollAttempts + 1,
    };
  }

  return {
    success: false,
    inProgress: true,
    timedOut: true,
    error: `Timeout (${maxWait}s) tercapai dan status PostgreSQL tidak dapat diverifikasi (${finalCheck.error}). Jangan berasumsi promosi gagal atau berhasil sebelum diverifikasi langsung.`,
    postRecovery: null,
    attempts: pollAttempts + 1,
  };
}

/**
 * Mengambil inventori backend aktual dan memvalidasi keaslian container
 * Menjamin tidak ada foreign container dan mempertahankan instance count saat recreate.
 */
function getBackendInventory(stack = "p3", execFn = sh) {
  if (stack === "p2") {
    const backendNames = ["flashsale-backend-1", "flashsale-backend-2"];
    const verified = [];
    for (const name of backendNames) {
      const state = inspectContainerState(name, {
        project: "flashsale",
        service: name.replace("flashsale-", ""),
        environment: "p2",
      }, execFn);
      if (state.exists && state.identityValid && state.running) {
        verified.push({ name, id: state.id, state });
      }
    }
    if (verified.length < 2) {
      return {
        ok: false,
        count: verified.length,
        containers: verified.map((v) => v.name),
        error: `Inventory P2 tidak lengkap: ${verified.length}/2 backend berjalan dengan identitas valid`,
      };
    }
    return {
      ok: true,
      count: verified.length,
      containers: verified.map((v) => v.name),
      error: null,
    };
  }

  // P3 Stack: Dynamic instance count
  const res = execFn(
    `docker compose -f docker-compose.p3.yml --env-file .env.p3 ps --format json backend`
  );
  if (!res.ok) {
    return {
      ok: false,
      count: 0,
      containers: [],
      error: `Gagal membaca inventory Docker Compose P3: ${res.stderr || "Command failed"}`,
    };
  }

  const lines = res.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return {
      ok: false,
      count: 0,
      containers: [],
      error: "Tidak ada backend container P3 yang ditemukan",
    };
  }

  const containers = [];
  let foreignCount = 0;
  let runningCount = 0;

  for (const line of lines) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }

    const name = item.Name || item.Names || "";
    const project = item.Project || "";
    const service = item.Service || "";
    const stateStr = (item.State || "").toLowerCase();
    const isRunning = stateStr === "running";

    // Validasi bahwa container benar-benar milik flashsale-p3 service backend
    if (project !== "flashsale-p3" || service !== "backend") {
      foreignCount++;
      continue;
    }

    // Inspect container secara mendalam
    const inspected = inspectContainerState(name, {
      project: "flashsale-p3",
      service: "backend",
      environment: "p3",
    }, execFn);

    if (!inspected.identityValid) {
      foreignCount++;
      continue;
    }

    if (isRunning && inspected.running) {
      runningCount++;
      containers.push(name);
    }
  }

  if (foreignCount > 0) {
    return {
      ok: false,
      count: 0,
      containers,
      error: `Terdeteksi ${foreignCount} container asing atau tidak valid dalam service backend P3 (inventory tidak konsisten)`,
    };
  }

  if (runningCount === 0) {
    return {
      ok: false,
      count: 0,
      containers: [],
      error: "Tidak ada backend instance P3 yang sedang berjalan",
    };
  }

  return {
    ok: true,
    count: runningCount,
    containers,
    error: null,
  };
}

/**
 * Melakukan verifikasi komprehensif terhadap seluruh instance backend yang sedang berjalan
 * Memverifikasi DB connection, identitas DB, writer status (in_recovery=false), dan /health status
 * Exit code 0 HANYA untuk PASS. FAIL atau UNKNOWN mengembalikan status gagal.
 */
function verifyBackendInstances(cfg, expectedDbHost = null, execFn = sh) {
  const inv = getBackendInventory(cfg.stack, execFn);
  if (!inv.ok || inv.containers.length === 0) {
    return {
      status: "UNKNOWN",
      message: `Inventory backend ${cfg.stack.toUpperCase()} tidak dapat diverifikasi: ${inv.error || "Container not found"}`,
      results: [],
    };
  }

  // Jika expectedDbHost dispesifikasikan, cari target IP container database yang diharapkan
  let targetContainerName = null;
  let expectedTargetIp = null;
  if (expectedDbHost) {
    targetContainerName = (expectedDbHost === cfg.replicaService || expectedDbHost === "db-replica")
      ? cfg.replicaContainer
      : ((expectedDbHost === cfg.primaryService || expectedDbHost === "db-primary")
        ? cfg.primaryContainer
        : expectedDbHost);
    const ipRes = execFn(`docker inspect --format "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}" ${targetContainerName}`);
    if (!ipRes.ok || !ipRes.stdout.trim()) {
      return {
        status: "UNKNOWN",
        message: `Gagal memperoleh IP container database target '${targetContainerName}' (${ipRes.stderr || "inspect failed"}). Verifikasi backend ditolak (fail-closed).`,
        results: [],
      };
    }
    expectedTargetIp = ipRes.stdout.trim();
  }

  const results = [];
  let allPass = true;

  for (const cname of inv.containers) {
    // 1. Eksekusi probe node di dalam container backend (termasuk inet_server_addr() dan DB_HOST aktual)
    const probeScript = [
      "const { Pool } = require('pg');",
      "const pool = new Pool({",
      "  host: process.env.DB_HOST,",
      "  port: process.env.DB_PORT || 5432,",
      "  database: process.env.DB_NAME,",
      "  user: process.env.DB_USER,",
      "  password: process.env.DB_PASSWORD,",
      "  connectionTimeoutMillis: 3000",
      "});",
      "pool.query('SELECT current_database() AS db_name, pg_is_in_recovery() AS in_recovery, host(inet_server_addr()) AS server_ip')",
      "  .then(r => {",
      "    console.log(JSON.stringify({",
      "      ok: true,",
      "      db_name: r.rows[0].db_name,",
      "      in_recovery: r.rows[0].in_recovery,",
      "      server_ip: (r.rows[0].server_ip || '').replace(/\\/.*$/, ''),",
      "      db_host: process.env.DB_HOST,",
      "      backend_id: process.env.HOSTNAME || ''",
      "    }));",
      "    return pool.end();",
      "  })",
      "  .catch(e => {",
      "    console.log(JSON.stringify({",
      "      ok: false,",
      "      error: e.message,",
      "      code: e.code,",
      "      db_host: process.env.DB_HOST,",
      "      backend_id: process.env.HOSTNAME || ''",
      "    }));",
      "    return pool.end();",
      "  });",
    ].join(" ");

    const execRes = execFn(`docker exec ${cname} node -e "${probeScript}"`);
    let probe = null;
    try {
      probe = JSON.parse(execRes.stdout);
    } catch (err) {
      probe = { ok: false, error: `Probe parse error: ${err.message}`, output: execRes.stdout };
    }

    // 2. Query endpoint /health di dalam container
    const healthCmd = `docker exec ${cname} wget -qO- http://127.0.0.1:3000/health`;
    const healthRes = execFn(healthCmd);
    let healthJson = null;
    let healthHttpOk = false;
    try {
      healthJson = JSON.parse(healthRes.stdout);
      healthHttpOk = healthJson.status === "ok" && healthJson.db === "up";
    } catch {
      healthHttpOk = false;
    }

    // Evaluasi aturan ketat
    let nodePass = true;
    const failures = [];

    if (!probe || !probe.ok) {
      nodePass = false;
      failures.push(`DB connection failed (${probe ? probe.error : execRes.stderr})`);
    } else {
      if (probe.db_name !== cfg.dbName) {
        nodePass = false;
        failures.push(`DB name mismatch (aktual: '${probe.db_name}', diharapkan: '${cfg.dbName}')`);
      }
      if (probe.in_recovery !== false) {
        nodePass = false;
        failures.push(`PostgreSQL masih standby (pg_is_in_recovery: ${probe.in_recovery}); backend belum terhubung ke primary writer!`);
      }
      if (expectedDbHost) {
        if (probe.db_host !== expectedDbHost) {
          nodePass = false;
          failures.push(`DB_HOST mismatch (aktual: '${probe.db_host}', diharapkan: '${expectedDbHost}') - backend masih mengarah ke host database lama!`);
        }
        if (!probe.server_ip) {
          nodePass = false;
          failures.push("Probe backend tidak menghasilkan server_ip koneksi database aktif.");
        } else if (expectedTargetIp && probe.server_ip !== expectedTargetIp) {
          nodePass = false;
          failures.push(`Target database IP mismatch (koneksi aktif ke '${probe.server_ip}', diharapkan '${expectedTargetIp}' [${targetContainerName}]) - backend masih terhubung ke primary lama!`);
        }
      }

      // Validasi terhadap informasi health pool aplikasi yang sesungguhnya
      if (healthJson) {
        if (healthJson.database && healthJson.database !== cfg.dbName) {
          nodePass = false;
          failures.push(`Application pool database mismatch: '${healthJson.database}', diharapkan '${cfg.dbName}'`);
        }
        if (healthJson.in_recovery === true) {
          nodePass = false;
          failures.push("Application pool melaporkan database berada dalam mode standby (in_recovery=true); bukan writer!");
        }
        const appPoolIp = healthJson.db_server_ip || healthJson.server_ip;
        if (expectedTargetIp && appPoolIp && appPoolIp !== expectedTargetIp) {
          nodePass = false;
          failures.push(`Application pool DB IP mismatch (pool terhubung ke '${appPoolIp}', diharapkan '${expectedTargetIp}' [${targetContainerName}])`);
        }
      }
    }

    if (!healthHttpOk) {
      nodePass = false;
      failures.push(`/health status bukan 'ok' atau db bukan 'up' (${healthRes.stdout || healthRes.stderr})`);
    }

    if (!nodePass) {
      allPass = false;
    }

    results.push({
      container: cname,
      backendId: probe?.backend_id || cname,
      dbHost: probe?.db_host || "unknown",
      serverIp: probe?.server_ip || "unknown",
      dbName: probe?.db_name || "unknown",
      inRecovery: probe?.in_recovery,
      healthDb: healthJson?.db,
      pass: nodePass,
      failures,
    });
  }

  return {
    status: allPass ? "PASS" : "FAIL",
    message: allPass
      ? `Seluruh ${results.length} backend instance terverifikasi menggunakan database writer target ${expectedDbHost ? `(${expectedDbHost})` : 'aktif'}.`
      : `Verifikasi backend gagal: satu atau lebih backend tidak menggunakan primary baru atau masih terhubung ke primary lama.`,
    results,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const isP3 = args.includes("p3") || args.includes("--p3");
  const targetStack = isP3 ? "p3" : "p2";
  const cfg = getStackConfig(targetStack);

  const isPromote = args.includes("--promote");
  const isFencedConfirmed = args.includes("--confirm-fenced");
  const isPromotionAllowed = args.includes("--allow-promotion");
  const isVerifyBackend = args.includes("--verify-backend");

  const hostArgIdx = args.indexOf("--expected-db-host");
  const expectedDbHost = hostArgIdx !== -1 && args[hostArgIdx + 1] ? args[hostArgIdx + 1] : null;

  console.log("=".repeat(75));
  console.log("[DRP Failover] PostgreSQL Multi-Container Failover Manager (Fail-Closed)");
  console.log(`Target Stack: ${cfg.stack.toUpperCase()} (Primary: ${cfg.primaryContainer}, Replica: ${cfg.replicaContainer})`);
  console.log("=".repeat(75));

  // Mode Verifikasi Backend Pasca Pengalihan
  if (isVerifyBackend) {
    console.log("\n[VERIFIKASI PENGALIHAN KONEKSI SELURUH BACKEND]");
    if (expectedDbHost) {
      console.log(`Target Database Expected: ${expectedDbHost}`);
    }
    const verification = verifyBackendInstances(cfg, expectedDbHost);
    console.log(`\nStatus Keseluruhan: [${verification.status}] - ${verification.message}`);
    for (const r of verification.results) {
      console.log(`\n  - Container: ${r.container} (Backend ID: ${r.backendId})`);
      console.log(`    * DB Host        : ${r.dbHost}`);
      console.log(`    * Server IP      : ${r.serverIp}`);
      console.log(`    * DB Name        : ${r.dbName}`);
      console.log(`    * in_recovery    : ${r.inRecovery}`);
      console.log(`    * Health DB      : ${r.healthDb}`);
      console.log(`    * Status Node    : ${r.pass ? "PASS" : "FAIL"}`);
      if (!r.pass && r.failures && r.failures.length) {
        for (const f of r.failures) {
          console.error(`      [!] ${f}`);
        }
      }
    }

    if (verification.status === "PASS") {
      console.log("\n[VERIFIKASI SUKSES] Seluruh backend aktif menggunakan primary baru.");
      process.exit(0);
    } else {
      console.error(`\n[VERIFIKASI GAGAL] Status verifikasi: ${verification.status}. Batalkan atau perbaiki konfigurasi backend.`);
      process.exit(1);
    }
  }

  // 1. Inspect Primary State
  console.log(`\n[Langkah 1: Pemeriksaan Status Container Primary (${cfg.primaryContainer})]`);
  const primaryState = inspectContainerState(cfg.primaryContainer, {
    project: cfg.project,
    service: cfg.primaryService,
    environment: cfg.environment,
  });

  let primaryPostgres = null;
  if (primaryState.running === true) {
    primaryPostgres = queryPostgres(cfg.primaryContainer, cfg.dbUser, cfg.dbName, "SELECT pg_is_in_recovery()");
    console.log(`  - Status Container: RUNNING (Status: ${primaryState.status}, ID: ${primaryState.id})`);
    console.log(`  - Identitas Label : ${primaryState.identityValid ? "VALID" : "MISMATCH"}`);
    console.log(`  - Postgres pg_is_in_recovery(): ${primaryPostgres.output ?? "QUERY_FAILED"} (Harus gagal/mati untuk fencing)`);
  } else if (primaryState.running === false && primaryState.exists) {
    console.log(`  - Status Container: STOPPED (Status: ${primaryState.status}, ID: ${primaryState.id})`);
  } else if (primaryState.status === "not_found") {
    console.log(`  - Status Container: NOT_FOUND`);
  } else {
    console.log(`  - Status Container: UNKNOWN / INSPECT_FAILED (${primaryState.error})`);
  }

  // 2. Inspect Replica State
  console.log(`\n[Langkah 2: Pemeriksaan Status Container Replica (${cfg.replicaContainer})]`);
  const replicaState = inspectContainerState(cfg.replicaContainer, {
    project: cfg.project,
    service: cfg.replicaService,
    environment: cfg.environment,
  });

  let replicaPostgres = null;
  let lsnInfo = null;
  if (replicaState.running === true) {
    replicaPostgres = queryPostgres(cfg.replicaContainer, cfg.dbUser, cfg.dbName, "SELECT pg_is_in_recovery()");
    const lsnCheck = queryPostgres(
      cfg.replicaContainer,
      cfg.dbUser,
      cfg.dbName,
      "SELECT COALESCE(pg_last_wal_receive_lsn()::text, 'none') || '|' || COALESCE(pg_last_wal_replay_lsn()::text, 'none') || '|' || COALESCE(pg_last_xact_replay_timestamp()::text, 'none')"
    );
    if (lsnCheck.success && lsnCheck.output) {
      const parts = lsnCheck.output.split("|");
      lsnInfo = {
        receiveLsn: parts[0] !== "none" ? parts[0] : null,
        replayLsn: parts[1] !== "none" ? parts[1] : null,
        replayTimestamp: parts[2] !== "none" ? parts[2] : null,
      };
    }
    console.log(`  - Status Container: RUNNING (Status: ${replicaState.status}, ID: ${replicaState.id})`);
    console.log(`  - Postgres pg_is_in_recovery(): ${replicaPostgres.output ?? "QUERY_FAILED"} (Wajib 't' untuk dipromosikan)`);
    console.log(`  - WAL Receive/Replay LSN: ${lsnInfo?.receiveLsn ?? "none"} / ${lsnInfo?.replayLsn ?? "none"}`);
    if (lsnInfo?.replayTimestamp) {
      console.log(`  - Last Replay Timestamp : ${lsnInfo.replayTimestamp}`);
    }
  } else if (replicaState.running === false && replicaState.exists) {
    console.log(`  - Status Container: STOPPED (Status: ${replicaState.status})`);
  } else {
    console.log(`  - Status Container: UNKNOWN / INSPECT_FAILED (${replicaState.error})`);
  }

  // 3. Fencing Validation (Fail-Closed)
  console.log("\n[Langkah 3: Validasi Fencing & Pencegahan Split-Brain]");
  const fencing = validateFencing(primaryState, primaryPostgres);
  if (!fencing.fenced) {
    console.log(`  [PERINGATAN FENCING] ${fencing.reason}`);
    console.log(`  Fencing definitif WAJIB dilakukan sebelum promosi untuk mencegah Split-Brain:`);
    console.log(`  Perintah fencing: docker stop ${cfg.primaryContainer}`);
    if (isPromote) {
      console.error("\n[DITOLAK - FAIL-CLOSED] Promosi dibatalkan: primary belum di-fence secara terbukti.");
      process.exit(1);
    }
  } else {
    console.log(`  [OK - FENCED] ${fencing.reason}`);
  }

  // 4. Validate Replica Readiness
  console.log("\n[Langkah 4: Validasi Kesiapan Replica untuk Promosi]");
  const replicaCheck = validateReplicaForPromotion(replicaState, replicaPostgres, lsnInfo);
  if (!replicaCheck.ready) {
    console.log(`  [REPLICA TIDAK SIAP] ${replicaCheck.reason}`);
    if (isPromote) {
      console.error("\n[DITOLAK - FAIL-CLOSED] Promosi dibatalkan: replica tidak dalam kondisi siap dipromosikan.");
      process.exit(1);
    }
  } else {
    console.log(`  [OK - REPLICA SIAP] ${replicaCheck.reason}`);
    if (replicaCheck.freshness) {
      console.log(`  - Replay Synchronization : ${replicaCheck.freshness.replaySync ? 'IN_SYNC_WITH_RECEIVED_WAL' : 'REPLAY_PENDING'}`);
      console.log(`  - Status RPO (Data Loss) : ${replicaCheck.freshness.rpoStatus}`);
    }
  }

  // 5. Failover Execution or Plan
  if (!isPromote) {
    console.log("\n[Langkah 5: Rencana Eksekusi Manual Failover (Mode Audit / Plan)]");
    console.log("  Jika terjadi bencana pada primary, ikuti prosedur resmi DRP:");
    console.log(`  1. Fencing Primary Lama:`);
    console.log(`     docker stop ${cfg.primaryContainer}`);
    console.log(`  2. Promosi Replica Menjadi Primary Baru:`);
    console.log(`     node scripts/docker-failover.js --promote ${cfg.stack} --confirm-fenced --allow-promotion`);
    console.log(`  3. Pengalihan Koneksi Backend API (Prosedur Recreate Bersih):`);
    const inv = getBackendInventory(cfg.stack);
    const backendCount = inv.ok ? inv.count : (cfg.stack === "p3" ? "<actual_count>" : 2);
    if (cfg.stack === "p2") {
      console.log(`     - Edit .env.docker: set DB_HOST=db-replica dan kosongkan DB_REPLICA_HOST=`);
      console.log(`     - Recreate backend (tanpa menyentuh volume / DB):`);
      console.log(`       docker compose --env-file .env.docker up -d --no-deps --force-recreate backend-1 backend-2`);
    } else {
      console.log(`     - Edit .env.p3: set P3_DB_HOST=db-replica dan kosongkan P3_DB_REPLICA_HOST=`);
      console.log(`     - Recreate backend dengan mempertahankan jumlah instance aktif (${backendCount} instance):`);
      console.log(`       docker compose -f docker-compose.p3.yml --env-file .env.p3 up -d --no-deps --force-recreate --scale backend=${backendCount} backend`);
    }
    console.log(`  4. Verifikasi Pengalihan:`);
    console.log(`     node scripts/docker-failover.js --verify-backend ${cfg.stack}`);
    console.log(`  5. Pencegahan Split-Brain & Larangan Automatic Failback:`);
    console.log(`     - Dilarang keras menyalakan primary lama sebagai writer.`);
    console.log(`     - Jalankan mode read-only untuk audit: node scripts/reconcile-old-primary.js --stack ${cfg.stack}`);
    console.log(`  6. Reintegrasi Primary Lama:`);
    console.log(`     - Inisialisasi ulang PGDATA primary lama dari primary baru via pg_basebackup -R.`);

    console.log("\n[BATASAN TEKNIS DRP]");
    console.log("  Failover ini adalah failover manual terkoordinasi. Pengalihan backend membutuhkan");
    console.log("  intervensi operator dan BUKAN failover otomatis tanpa downtime (zero downtime tidak diklaim).");
    return;
  }

  // Promotion execution branch
  if (!isFencedConfirmed || !isPromotionAllowed) {
    console.error("\n[DITOLAK] Promosi membutuhkan konfirmasi eksplisit:");
    console.error("  Wajib menyertakan: --confirm-fenced dan --allow-promotion");
    process.exit(1);
  }

  console.log("\n[Langkah 5: Mengeksekusi Promosi Asynchronous Replica]");
  console.log(`  Menjalankan pg_promote(false) pada container ${cfg.replicaContainer}...`);
  const promoResult = executePromotion(cfg.replicaContainer, cfg.dbUser, cfg.dbName);

  if (promoResult.success) {
    console.log(`  [SUKSES] Container ${cfg.replicaContainer} berhasil dipromosikan menjadi PRIMARY BARU!`);
    console.log(`  pg_is_in_recovery() terkonfirmasi: ${promoResult.postRecovery} (writer aktif) dalam ${promoResult.elapsedSeconds || 1} detik.`);
    console.log("\n[Langkah Tindak Lanjut Wajib Operator]");
    const inv = getBackendInventory(cfg.stack);
    const backendCount = inv.ok ? inv.count : (cfg.stack === "p3" ? "<actual_count>" : 2);
    if (cfg.stack === "p2") {
      console.log("  1. Edit .env.docker: set DB_HOST=db-replica dan DB_REPLICA_HOST=");
      console.log("  2. Recreate backend tanpa restart DB: docker compose --env-file .env.docker up -d --no-deps --force-recreate backend-1 backend-2");
    } else {
      console.log("  1. Edit .env.p3: set P3_DB_HOST=db-replica dan P3_DB_REPLICA_HOST=");
      console.log(`  2. Recreate backend P3: docker compose -f docker-compose.p3.yml --env-file .env.p3 up -d --no-deps --force-recreate --scale backend=${backendCount} backend`);
    }
    console.log(`  3. Verifikasi pengalihan: node scripts/docker-failover.js --verify-backend ${cfg.stack}`);
    console.log(`  4. JANGAN menyalakan container ${cfg.primaryContainer} sebelum data direkonsiliasi.`);
    console.log(`  5. Jalankan: node scripts/reconcile-old-primary.js --stack ${cfg.stack} untuk memeriksa tail orders.`);
  } else {
    console.error(`  [GAGAL PROMOSI] ${promoResult.error}`);
    if (promoResult.inProgress) {
      console.error("  PERHATIAN: Promosi mungkin masih berlangsung di background. Periksa status pg_is_in_recovery() secara manual sebelum mengambil tindakan lanjutan.");
    }
    process.exit(1);
  }
}

// Export modul untuk testing
module.exports = {
  inspectContainerState,
  queryPostgres,
  validateFencing,
  validateReplicaForPromotion,
  executePromotion,
  getStackConfig,
  getBackendInventory,
  verifyBackendInstances,
};

if (require.main === module) {
  main().catch((err) => {
    console.error("Error failover execution:", err.message);
    process.exit(1);
  });
}
