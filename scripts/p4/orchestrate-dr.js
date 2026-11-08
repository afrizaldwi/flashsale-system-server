"use strict";
/**
 * scripts/p4/orchestrate-dr.js
 * Official CLI/API delegates to p3-dr.js (Architecture v1.3, DRP v1.1).
 *
 * Default is a read-only plan for the existing flashsale-p3 on port 8080.
 * Execute requires explicit immutable container ID and volume confirmations.
 * The historical clone implementation below is retained for audit/regression
 * evidence; its execution is not exported. It does not satisfy the official DR test.
 */

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { execSync } = require("node:child_process");
const {
  P3_CONFIG,
  sh,
  inspectContainerIdentity,
  verifyDatabaseRole,
  calculateFileSha256,
  validateArchiveTOC,
} = require("./common");
const { findLatestBackup, performRestore } = require("./restore");
const {
  readLedger,
  compareLedgerWithDatabase,
  recordTransaction,
} = require("./ledger");
const {
  runK6Workload,
  startK6Workload,
  sendCheckoutRequest,
} = require("./workload");
const { configureP4Ingress } = require("./ingress");

const DR_CONFIG = {
  project: "flashsale-p4-dr",
  composeFile: "docker-compose.p4-dr.yml",
  recoveryComposeFile: "docker-compose.p4-dr.recovery.yml",
  service: "db-primary",
  environment: "p4-dr",
  dbName: "flashsale_p3",
  dbUser: "p3_admin",
  primaryContainer: "flashsale-p4-dr-db-primary-1",
  replicaContainer: "flashsale-p4-dr-db-replica-1",
  backendContainer1: "flashsale-p4-dr-backend-1",
  backendContainer2: "flashsale-p4-dr-backend-2",
  nginxContainer: "flashsale-p4-dr-nginx-1",
  primaryVolume: "flashsale-p4-dr-primary",
  primaryRecoveryVolume: "flashsale-p4-dr-primary-recovery",
  replicaVolume: "flashsale-p4-dr-replica",
  replicaRecoveryVolume: "flashsale-p4-dr-replica-recovery",
  network: "flashsale-p4-dr",
  port: 8088,
  baseUrl: "http://127.0.0.1:8088",
  p3BackupDir: path.resolve(process.cwd(), "backups/p3"),
  p4BackupDir: path.resolve(process.cwd(), "backups/p4"),
  ledgerDir: path.resolve(process.cwd(), "backups/p4/ledger"),
  reportFile: path.resolve(process.cwd(), "backups/p4/dr-report.json"),
};

/**
 * Menjalankan perintah Docker / Compose dengan validasi status keluar (fail-closed)
 */
function execDocker(cmd, execFn = execSync, description = "") {
  const res = sh(cmd, execFn);
  if (!res.ok) {
    const desc = description ? `[${description}] ` : "";
    throw new Error(
      `${desc}Perintah Docker gagal (Exit code: ${res.status}):\n` +
        `Command: ${cmd}\n` +
        `Stderr : ${res.stderr || "tidak ada"}\n` +
        `Stdout : ${res.stdout || "tidak ada"}`,
    );
  }
  return res;
}

/**
 * Helper HTTP GET JSON
 */
function httpGetJson(urlStr, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let body = null;
        try {
          body = JSON.parse(data);
        } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          raw: data,
        });
      });
    });
    req.on("error", (e) =>
      resolve({ status: 0, error: e.message, body: null }),
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, error: "TIMEOUT", body: null });
    });
  });
}

/**
 * Validasi ketat bahwa container adalah milik stack DR terisolasi (flashsale-p4-dr)
 */
function assertDrContainerIsolation(
  containerName,
  expectedProject = DR_CONFIG.project,
  execFn = execSync,
) {
  if (!containerName || typeof containerName !== "string") {
    throw new Error("Container name wajib disertakan untuk validasi isolasi");
  }

  const res = sh(`docker inspect ${containerName}`, execFn);
  if (!res.ok) {
    throw new Error(
      `Container DR '${containerName}' tidak ditemukan: ${res.stderr || res.stdout}`,
    );
  }
  let data;
  try {
    const parsed = JSON.parse(res.stdout);
    data = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    throw new Error(`Gagal parse inspect JSON container: ${err.message}`);
  }

  const project = (
    data.Config?.Labels?.["com.docker.compose.project"] || ""
  ).trim();
  const env = (data.Config?.Labels?.["flashsale.environment"] || "").trim();

  if (project !== expectedProject) {
    throw new Error(
      `ISOLATION BREACH PREVENTED: Target container memiliki project '${project}', diharapkan '${expectedProject}'. Eksekusi dibatalkan untuk melindungi stack lain!`,
    );
  }
  if (env !== "p4-dr") {
    throw new Error(
      `ISOLATION BREACH PREVENTED: Target container '${containerName}' memiliki environment '${env}', bukan 'p4-dr'!`,
    );
  }
  return true;
}

/**
 * Validasi ketat bahwa volume adalah milik stack DR terisolasi
 */
function assertDrVolumeIsolation(volumeName, execFn = execSync) {
  if (!volumeName || typeof volumeName !== "string") {
    throw new Error("Volume name wajib disertakan untuk validasi isolasi");
  }

  const lower = volumeName.toLowerCase();
  if (
    lower === "pgdata-primary" ||
    lower === "pgdata-replica" ||
    lower.startsWith("pgdata-p3") ||
    lower.startsWith("flashsale-p3") ||
    lower === "primary" ||
    lower === "replica"
  ) {
    throw new Error(
      `ISOLATION BREACH PREVENTED: Volume '${volumeName}' adalah volume production/baseline P3/P2! Dilarang disentuh.`,
    );
  }

  if (!lower.startsWith("flashsale-p4-dr") && !lower.startsWith("p4-dr")) {
    throw new Error(
      `ISOLATION BREACH PREVENTED: Volume '${volumeName}' tidak memiliki prefix isolated DR 'flashsale-p4-dr'!`,
    );
  }

  const res = sh(`docker volume inspect ${volumeName}`, execFn);
  if (!res.ok) {
    throw new Error(
      `Volume DR '${volumeName}' tidak ditemukan: ${res.stderr || res.stdout}`,
    );
  }

  let data;
  try {
    const parsed = JSON.parse(res.stdout);
    data = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    throw new Error(`Gagal parse inspect JSON volume: ${err.message}`);
  }

  const labels = data.Labels || {};
  const env = (labels["flashsale.environment"] || "").trim();
  const project = (labels["com.docker.compose.project"] || "").trim();

  if (env !== "p4-dr" && project !== DR_CONFIG.project) {
    throw new Error(
      `ISOLATION BREACH PREVENTED: Volume '${volumeName}' tidak memiliki label environment 'p4-dr' atau project '${DR_CONFIG.project}'!`,
    );
  }
  return true;
}

/**
 * Validasi ketat bahwa network adalah milik stack DR terisolasi
 */
function assertDrNetworkIsolation(networkName, execFn = execSync) {
  if (!networkName || typeof networkName !== "string") {
    throw new Error("Network name wajib disertakan untuk validasi isolasi");
  }

  const lower = networkName.toLowerCase();
  if (
    lower === "flashsale-network" ||
    lower === "p3-network" ||
    lower === "bridge" ||
    lower === "host" ||
    lower === "none"
  ) {
    throw new Error(
      `ISOLATION BREACH PREVENTED: Network '${networkName}' adalah network baseline/host!`,
    );
  }

  if (!lower.startsWith("flashsale-p4-dr") && !lower.startsWith("p4-dr")) {
    throw new Error(
      `ISOLATION BREACH PREVENTED: Network '${networkName}' tidak memiliki nama isolated DR 'flashsale-p4-dr'!`,
    );
  }

  const res = sh(`docker network inspect ${networkName}`, execFn);
  if (!res.ok) {
    throw new Error(
      `Network DR '${networkName}' tidak ditemukan: ${res.stderr || res.stdout}`,
    );
  }

  let data;
  try {
    const parsed = JSON.parse(res.stdout);
    data = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    throw new Error(`Gagal parse inspect JSON network: ${err.message}`);
  }

  const labels = data.Labels || {};
  const env = (labels["flashsale.environment"] || "").trim();

  if (
    env !== "p4-dr" &&
    data.Name !== "flashsale-p4-dr" &&
    data.Name !== "p4-dr"
  ) {
    throw new Error(
      `ISOLATION BREACH PREVENTED: Network '${networkName}' tidak memiliki label environment 'p4-dr'!`,
    );
  }
  return true;
}

function assertDrIsolation(
  containerName,
  expectedProject = DR_CONFIG.project,
  execFn = execSync,
) {
  return assertDrContainerIsolation(containerName, expectedProject, execFn);
}

/**
 * Membuat backup pra-bencana langsung dari database primary P4 terisolasi
 */
function createP4PreDisasterBackup(options = {}, execFn = execSync) {
  const container = options.container || DR_CONFIG.primaryContainer;
  const dbUser = options.dbUser || DR_CONFIG.dbUser;
  const dbName = options.dbName || DR_CONFIG.dbName;
  const backupDir = options.backupDir || DR_CONFIG.p4BackupDir;

  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  const dumpFilename = `flashsale_p4_pre_disaster_${timestamp}.dump`;
  const dumpTmpPath = path.join(backupDir, `${dumpFilename}.tmp`);
  const dumpFinalPath = path.join(backupDir, dumpFilename);
  const shaPath = `${dumpFinalPath}.sha256`;
  const metaPath = `${dumpFinalPath}.meta.json`;

  const containerTmpDump = `/tmp/backup_p4_${timestamp}.dump`;

  // 1. pg_dump di dalam container DR
  const dumpCmd = `docker exec ${container} pg_dump -U ${dbUser} -d ${dbName} -Fc -f ${containerTmpDump}`;
  const dumpRes = sh(dumpCmd, execFn);
  if (!dumpRes.ok) {
    throw new Error(
      `Gagal membuat backup P4 di container: ${dumpRes.stderr || dumpRes.stdout}`,
    );
  }

  // 2. Salin ke host .tmp
  const cpRes = sh(
    `docker cp ${container}:${containerTmpDump} "${dumpTmpPath}"`,
    execFn,
  );
  sh(`docker exec ${container} rm -f ${containerTmpDump}`, execFn);
  if (!cpRes.ok) {
    throw new Error(
      `Gagal menyalin backup P4 ke host: ${cpRes.stderr || cpRes.stdout}`,
    );
  }

  // 3. Validasi TOC
  const tocRes = validateArchiveTOC(container, dumpTmpPath, execFn);
  if (!tocRes.ok) {
    try {
      fs.unlinkSync(dumpTmpPath);
    } catch {}
    throw new Error(`Validasi TOC backup P4 gagal: ${tocRes.error}`);
  }

  // 4. Finalisasi rename & SHA-256
  fs.renameSync(dumpTmpPath, dumpFinalPath);
  const sha = calculateFileSha256(dumpFinalPath);
  fs.writeFileSync(
    shaPath,
    `${sha}  ${path.basename(dumpFinalPath)}\n`,
    "utf8",
  );

  const meta = {
    file: dumpFilename,
    path: dumpFinalPath,
    sourceContainer: container,
    sourceDatabase: dbName,
    sha256: sha,
    entitiesCount: tocRes.entitiesCount,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");

  return meta;
}

/**
 * Pembersihan khusus volume recovery (flashsale-p4-dr-primary-recovery & flashsale-p4-dr-replica-recovery).
 * DILARANG KERAS menghapus volume asli primary (flashsale-p4-dr-primary).
 */
function cleanupRecoveryVolumes(execFn = execSync) {
  const allowedRecoveryVolumes = [
    DR_CONFIG.primaryRecoveryVolume,
    DR_CONFIG.replicaRecoveryVolume,
  ];

  for (const vol of allowedRecoveryVolumes) {
    if (vol === DR_CONFIG.primaryVolume || vol === "flashsale-p4-dr-primary") {
      throw new Error(
        `SAFETY VIOLATION: Dilarang keras menghapus volume asli '${vol}'! Volume asli harus dikarantina untuk forensik.`,
      );
    }
    try {
      assertDrVolumeIsolation(vol, execFn);
      execDocker(
        `docker volume rm -f ${vol}`,
        execFn,
        `Cleanup Recovery Volume ${vol}`,
      );
    } catch (err) {
      if (
        !err.message.includes("tidak ditemukan") &&
        !err.message.includes("No such volume")
      ) {
        throw err;
      }
    }
  }
}

/**
 * Memverifikasi bahwa container benar-benar me-mount volume yang diharapkan
 */
function verifyContainerVolumeMount(
  containerName,
  expectedVolumeSource,
  execFn = execSync,
) {
  const inspectRes = execDocker(
    `docker inspect ${containerName}`,
    execFn,
    `Inspect Mounts ${containerName}`,
  );
  let data;
  try {
    const parsed = JSON.parse(inspectRes.stdout);
    data = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    throw new Error(
      `Gagal parse JSON inspect mounts container '${containerName}': ${err.message}`,
    );
  }

  const mounts = data.Mounts || [];
  const found = mounts.find(
    (m) =>
      m.Destination === "/var/lib/postgresql/data" &&
      (m.Name === expectedVolumeSource ||
        m.Source?.includes(expectedVolumeSource)),
  );

  if (!found) {
    const actualMounts = mounts
      .map((m) => `${m.Destination} -> ${m.Name || m.Source}`)
      .join(", ");
    throw new Error(
      `VOLUME MOUNT MISMATCH: Container '${containerName}' tidak me-mount volume '${expectedVolumeSource}'!\n` +
        `Aktual mounts: [${actualMounts}]`,
    );
  }
  return true;
}

/**
 * Memastikan tepat terdapat satu primary writable di seluruh stack DR
 */
function verifySingleWritablePrimary(
  containers = [DR_CONFIG.primaryContainer, DR_CONFIG.replicaContainer],
  dbUser = DR_CONFIG.dbUser,
  expectedDb = DR_CONFIG.dbName,
  execFn = execSync,
) {
  let writableCount = 0;
  let standbyCount = 0;
  const details = [];

  for (const c of containers) {
    const role = verifyDatabaseRole(c, expectedDb, dbUser, execFn);
    details.push({ container: c, role });
    if (role.ok && !role.inRecovery) {
      writableCount++;
    } else if (role.inRecovery) {
      standbyCount++;
    }
  }

  if (writableCount !== 1) {
    throw new Error(
      `SPLIT-BRAIN / PRIMARY COUNT ANOMALY: Ditemukan ${writableCount} writable primary (harus tepat 1)! Detail: ${JSON.stringify(details)}`,
    );
  }
  if (standbyCount !== 1) {
    throw new Error(
      `REPLICA COUNT ANOMALY: Ditemukan ${standbyCount} standby replica (harus tepat 1)! Detail: ${JSON.stringify(details)}`,
    );
  }
  return true;
}

/**
 * Uji coba restorasi pada database terpisah (Phase A trial)
 */
function performTrialRestore(
  containerName,
  dumpPath,
  dbUser = "p3_admin",
  execFn = execSync,
) {
  const trialDb = "flashsale_p3_trial_verify";
  const containerDump = `/tmp/trial_restore_${Date.now()}.dump`;

  // 1. Separate DROP DATABASE
  execDocker(
    `docker exec ${containerName} psql -U ${dbUser} -d postgres -c "DROP DATABASE IF EXISTS ${trialDb};"`,
    execFn,
    "Trial Restore - Drop Old DB",
  );

  // 2. Separate CREATE DATABASE
  execDocker(
    `docker exec ${containerName} psql -U ${dbUser} -d postgres -c "CREATE DATABASE ${trialDb};"`,
    execFn,
    "Trial Restore - Create Fresh DB",
  );

  // 3. Salin dump ke container
  execDocker(
    `docker cp "${dumpPath}" ${containerName}:${containerDump}`,
    execFn,
    "Trial Restore - Copy Dump",
  );

  try {
    // 4. pg_restore
    execDocker(
      `docker exec ${containerName} pg_restore -U ${dbUser} -d ${trialDb} --no-owner --no-acl --exit-on-error ${containerDump}`,
      execFn,
      "Trial Restore - pg_restore",
    );

    // 5. Query table counts to verify data was actually restored
    const countSql =
      "SELECT " +
      "(SELECT COUNT(*) FROM orders) AS orders_count, " +
      "(SELECT COUNT(*) FROM products) AS products_count, " +
      "(SELECT COUNT(*) FROM users) AS users_count;";
    const countRes = execDocker(
      `docker exec ${containerName} psql -U ${dbUser} -d ${trialDb} -AtXc "${countSql}"`,
      execFn,
      "Trial Restore - Table Counts",
    );

    const parts = (countRes.stdout || "").trim().split("|");
    if (parts.length < 3) {
      throw new Error(
        `Trial restore verification query returned malformed output: '${countRes.stdout}'`,
      );
    }
    const orders = Number(parts[0]);
    const products = Number(parts[1]);
    const users = Number(parts[2]);

    if (
      !Number.isSafeInteger(orders) ||
      orders < 0 ||
      !Number.isSafeInteger(products) ||
      products <= 0
    ) {
      throw new Error(
        `Trial restore verification failed: invalid table counts (orders=${orders}, products=${products})`,
      );
    }

    // 6. Verify database consistency (negative stock, duplicate orders)
    const checkSql =
      "SELECT " +
      "(SELECT COUNT(*) FROM products WHERE stock < 0), " +
      "(SELECT COUNT(*) FROM (SELECT idempotency_key FROM orders GROUP BY idempotency_key HAVING COUNT(*) > 1) t);";
    const checkRes = execDocker(
      `docker exec ${containerName} psql -U ${dbUser} -d ${trialDb} -AtXc "${checkSql}"`,
      execFn,
      "Trial Restore - Consistency Invariants",
    );
    const checkParts = (checkRes.stdout || "").trim().split("|");
    const negStock = Number(checkParts[0] || 0);
    const dupOrders = Number(checkParts[1] || 0);
    if (negStock !== 0 || dupOrders !== 0) {
      throw new Error(
        `Trial restore database consistency failed: negative_stock=${negStock}, duplicate_orders=${dupOrders}`,
      );
    }

    return {
      ok: true,
      trialDatabase: trialDb,
      ordersCount: orders,
      productsCount: products,
      usersCount: users,
      consistent: true,
    };
  } finally {
    try {
      sh(`docker exec ${containerName} rm -f ${containerDump}`, execFn);
    } catch {}
    try {
      execDocker(
        `docker exec ${containerName} psql -U ${dbUser} -d postgres -c "DROP DATABASE IF EXISTS ${trialDb};"`,
        execFn,
        "Trial Restore - Cleanup DB",
      );
    } catch {}
  }
}

/**
 * Verifikasi perilaku sistem saat primary mengalami outage (Phase C)
 */
async function probePrimaryFailureBehavior(baseUrl = DR_CONFIG.baseUrl) {
  // 1. POST /checkout should return 503
  const checkoutRes = await sendCheckoutRequest(
    baseUrl,
    { user_id: 999, product_id: 1, qty: 1 },
    `probe-failure-${Date.now()}`,
  );

  // 2. GET /health should return 503
  const healthRes = await httpGetJson(`${baseUrl}/health`);

  // 3. GET /products should return 200 via replica with X-Read-From: replica
  const productsRes = await httpGetJson(`${baseUrl}/products`);
  const readFrom = productsRes.headers?.["x-read-from"] || null;

  const expectedBehaviorSatisfied =
    checkoutRes.status === 503 &&
    healthRes.status === 503 &&
    productsRes.status === 200 &&
    readFrom === "replica";

  return {
    checkoutStatus: checkoutRes.status,
    healthStatus: healthRes.status,
    productsStatus: productsRes.status,
    productsReadFrom: readFrom,
    expectedBehaviorSatisfied,
  };
}

/**
 * Re-play transaksi yang berstatus ambiguous (503/timeout saat crash) dengan Idempotency-Key asli (Phase F)
 */
async function replayAmbiguousTransactions(baseUrl, ambiguousList = []) {
  const replayResults = [];
  for (const tx of ambiguousList) {
    const res = await sendCheckoutRequest(
      baseUrl,
      {
        user_id: tx.userId || 1,
        product_id: tx.productId || 1,
        qty: tx.qty || 1,
      },
      tx.idempotencyKey,
    );
    replayResults.push({
      idempotencyKey: tx.idempotencyKey,
      status: res.status,
      body: res.body,
    });
  }
  return replayResults;
}

/**
 * Verifikasi 9 Invarian Bisnis langsung pada database riil
 */
function verifyAllBusinessInvariants(
  container,
  dbUser = "p3_admin",
  dbName = "flashsale_p3",
  execFn = execSync,
) {
  const sql =
    "SELECT " +
    "(SELECT COUNT(*) FROM products WHERE stock < 0) AS neg_stock, " +
    "(SELECT COUNT(*) FROM (SELECT idempotency_key FROM orders GROUP BY idempotency_key HAVING COUNT(*) > 1) t) AS dup_orders, " +
    "(SELECT COUNT(*) FROM products p WHERE (p.initial_stock - p.stock) != COALESCE((SELECT SUM(qty) FROM orders WHERE product_id = p.id), 0)) AS mismatched, " +
    "(SELECT NOT pg_is_in_recovery()) AS is_writer, " +
    "(SELECT COUNT(*) FROM orders) AS total_orders;";

  const res = sh(
    `docker exec ${container} psql -U ${dbUser} -d ${dbName} -AtXc "${sql}"`,
    execFn,
  );
  if (!res.ok) {
    throw new Error(
      `Gagal memverifikasi invarian bisnis: ${res.stderr || res.stdout}`,
    );
  }
  const parts = (res.stdout || "").trim().split("|");
  const negativeStock = Number(parts[0] || 0);
  const duplicateOrders = Number(parts[1] || 0);
  const mismatchedProducts = Number(parts[2] || 0);
  const isWriter = parts[3] === "t";
  const totalOrders = Number(parts[4] || 0);

  const consistent =
    negativeStock === 0 &&
    duplicateOrders === 0 &&
    mismatchedProducts === 0 &&
    isWriter;

  return {
    consistent,
    negativeStock,
    duplicateOrders,
    mismatchedProducts,
    isWriter,
    totalOrders,
  };
}

/**
 * Simulasi rencana Disaster Recovery (DRY-RUN DEFAULT)
 */
function findP3BaselineBackup(options = {}, execFn = execSync) {
  const identity = inspectContainerIdentity(
    DR_CONFIG.primaryContainer,
    {
      project: DR_CONFIG.project,
      service: "db-primary",
      environment: "p4-dr",
    },
    execFn,
  );
  // pg_restore reads the host archive through stdin and never touches database data.
  const validator = identity.ok
    ? DR_CONFIG.primaryContainer
    : P3_CONFIG.container;
  return {
    ...findLatestBackup(
      options.p3BackupDir || options.backupDir || DR_CONFIG.p3BackupDir,
      validator,
      execFn,
    ),
    validationContainer: validator,
  };
}

function planDisasterRecovery(options = {}, execFn = execSync) {
  const p3LatestBackup = findP3BaselineBackup(options, execFn);

  const steps = [
    {
      step: 1,
      phase: "Phase A – Preflight",
      title: "Verifikasi Lingkungan P3-Equivalent & Trial Restore",
      source: `Backup: ${p3LatestBackup.file || "backups/p3/flashsale_p3_baseline.dump"} (Baseline P3)`,
      target: `Container: ${DR_CONFIG.primaryContainer}, Database: ${DR_CONFIG.dbName}`,
      desc: "Menyiapkan stack clone terisolasi (2 backend, Nginx, primary, replica asinkron), memvalidasi peran database, dan menjalankan trial restore pada database temporer 'flashsale_p3_trial_verify' dengan pengecekan exit code, table counts, dan konsistensi data.",
      status: p3LatestBackup.ok ? "READY" : "MISSING_BACKUP",
      backupFile: p3LatestBackup.file || null,
    },
    {
      step: 2,
      phase: "Phase A – Preflight",
      title:
        "Pencatatan Baseline Stats, Ledger & Pembuatan Backup Pra-Bencana P4",
      source: `Container: ${DR_CONFIG.primaryContainer}, Database: ${DR_CONFIG.dbName}`,
      target: `Host: backups/p4/flashsale_p4_pre_disaster_<timestamp>.dump`,
      desc: "Mencatat status /stats awal, menginisialisasi ledger eksternal, dan mengambil backup konsisten langsung dari database P4 sebagai dataset pemulihan tunggal.",
    },
    {
      step: 3,
      phase: "Phase B – Checkout Stress Testing",
      title: "Checkout Stress Testing Menggunakan k6 (100 VUs Baseline)",
      command: `k6 run tests/load/p4-dr-workload.js -e P4_BASE_URL=${DR_CONFIG.baseUrl} -e P4_VUS=100`,
      ledger: path.join(DR_CONFIG.ledgerDir, "transactions.jsonl"),
      desc: "Menjalankan k6 checkout stress testing aktif (100 VUs) dengan startup handshake [K6_HANDSHAKE], konfirmasi 100 VUs aktif, Idempotency-Key unik, dan streaming structured log [LEDGER] ke host filesystem.",
    },
    {
      step: 4,
      phase: "Phase C – Primary Failure Injection",
      title:
        "Force Delete Primary Container Saat k6 Berjalan (Volume Asli Dikarantina)",
      simulatedTarget: DR_CONFIG.primaryContainer,
      simulatedVolume: `${DR_CONFIG.primaryVolume} (PRESERVED & QUARANTINED — NEVER DELETED)`,
      destructiveCommands: [`docker rm -f ${DR_CONFIG.primaryContainer}`],
      desc: "Mencatat T0 dan mematikan paksa HANYA container primary saat k6 aktif mengirim request (100 VUs terkonfirmasi). Nginx, pool backend (2 instances), dan replica TETAP BERJALAN. Volume asli TIDAK DIHAPUS dan bertahan melewati seluruh pengujian dan teardown untuk inspeksi forensik.",
    },
    {
      step: 5,
      phase: "Phase C – Primary Failure Verification",
      title: "Verifikasi Perilaku Sistem Saat Primary Down",
      expectedResponses: {
        checkout: "HTTP 503 (DB_UNAVAILABLE)",
        health: "HTTP 503 (db: down, replica: up)",
        products: "HTTP 200 (X-Read-From: replica)",
      },
      desc: "Membuktikan checkout 503, health 503, dan products 200 via replica. Pelanggaran outage dicatat sebagai kegagalan; pemulihan database tetap wajib diselesaikan sebelum laporan akhir gagal.",
    },
    {
      step: 6,
      phase: "Phase D – Recovery Preparation",
      title: "Penghentian Trafik Tulis & Pembuatan Volume Recovery Baru",
      recoveryVolume: DR_CONFIG.primaryRecoveryVolume,
      desc: "Menghentikan stress test k6 setelah failure tercatat, memverifikasi k6 aktif saat crash, mengunci ledger, dan membuat volume pemulihan bersih baru 'flashsale-p4-dr-primary-recovery'. Volume asli 'flashsale-p4-dr-primary' tetap utuh dan dikarantina.",
    },
    {
      step: 7,
      phase: "Phase D – Database Restoration",
      title:
        "Restorasi Database Primary Menggunakan Dedicated Recovery Compose Override",
      source: `Backup: backups/p4/flashsale_p4_pre_disaster_*.dump (Consistent Dataset P4)`,
      target: `Container: ${DR_CONFIG.primaryContainer}, Volume: ${DR_CONFIG.primaryRecoveryVolume} via ${DR_CONFIG.recoveryComposeFile}`,
      desc: "Menjalankan primary service menggunakan file override resmi 'docker-compose.p4-dr.recovery.yml' sehingga me-mount 'flashsale-p4-dr-primary-recovery'. Menjalankan pg_restore format biner (-Fc) dengan opsi lengkap --clean --if-exists --no-owner --no-acl --exit-on-error, memvalidasi mount dan status writable (pg_is_in_recovery() = false).",
    },
    {
      step: 8,
      phase: "Phase D – Replica Reconstruction",
      title: "Rekonstruksi Standby Replica Menggunakan Volume Recovery Bersih",
      command: `docker compose -f ${DR_CONFIG.composeFile} -f ${DR_CONFIG.recoveryComposeFile} up -d db-replica --wait`,
      target: `Volume: ${DR_CONFIG.replicaRecoveryVolume}`,
      desc: "Membangun ulang replica menggunakan volume pemulihan bersih baru 'flashsale-p4-dr-replica-recovery' (bukan volume lama) via pg_basebackup streaming dari primary yang telah pulih. Memvalidasi mount, mode standby (pg_is_in_recovery() = true), dan memastikan tepat ada 1 primary writable.",
    },
    {
      step: 9,
      phase: "Phase E – Recovery Validation (T1 & RTO)",
      title: "Penyambungan Backend & Validasi Pemulihan Lengkap",
      probe: `${DR_CONFIG.baseUrl}/health`,
      desc: "Menyambungkan kembali pool backend via recovery override, memulihkan routing Nginx, dan mencatat T1 serta RTO (T1 - T0 <= 300s) HANYA saat 8 syarat terpenuhi: /health 200, checkout 201, /stats consistent=true, primary writable, replica standby, replica streaming up, read routing replica 200, dan 9 invarian bisnis lolos.",
    },
    {
      step: 10,
      phase: "Phase F – Transaction Reconciliation",
      title:
        "Rekonsiliasi Transaksi, Replay Ambiguous, 9 Invarian, & Teardown Tanpa Menghapus Volume Primer",
      cleanupCommand: `docker compose -p ${DR_CONFIG.project} -f ${DR_CONFIG.composeFile} -f ${DR_CONFIG.recoveryComposeFile} down`,
      desc: "Membandingkan ledger vs database, memvalidasi bahwa ledger tidak kosong, melakukan replay transaksi ambiguous dengan Idempotency-Key asli (memastikan duplicate response tanpa double decrement), memverifikasi 9 invarian, lalu teardown DR stack menggunakan 'docker compose down' TANPA flag -v. Volume primer asli flashsale-p4-dr-primary tetap bertahan untuk investigasi forensik.",
    },
  ];

  return {
    dryRun: true,
    status: p3LatestBackup.ok
      ? "READY_FOR_EXECUTION"
      : "BLOCKED_BY_MISSING_P3_BACKUP",
    datasetConsistency: {
      strategy:
        "Consistent Isolated Dataset (Baseline P3 -> P4 Seed -> P4 Workload -> P4 Backup -> P4 Restore)",
      p3BaselineSource: p3LatestBackup.file || "backups/p3/*.dump",
      p4PreDisasterBackupTarget:
        "backups/p4/flashsale_p4_pre_disaster_<timestamp>.dump",
      restorationTarget: DR_CONFIG.primaryContainer,
      recoveryComposeOverride: DR_CONFIG.recoveryComposeFile,
    },
    isolatedEnvironment: {
      project: DR_CONFIG.project,
      composeFile: DR_CONFIG.composeFile,
      recoveryComposeFile: DR_CONFIG.recoveryComposeFile,
      ingressPort: DR_CONFIG.port,
      primaryVolume: DR_CONFIG.primaryVolume,
      primaryRecoveryVolume: DR_CONFIG.primaryRecoveryVolume,
      replicaVolume: DR_CONFIG.replicaVolume,
      replicaRecoveryVolume: DR_CONFIG.replicaRecoveryVolume,
      network: DR_CONFIG.network,
      containers: [
        DR_CONFIG.primaryContainer,
        DR_CONFIG.replicaContainer,
        DR_CONFIG.backendContainer1,
        DR_CONFIG.backendContainer2,
        DR_CONFIG.nginxContainer,
      ],
    },
    protectedEnvironments: [
      {
        name: "flashsale-p3 (Production Baseline)",
        port: 8080,
        volume: "primary",
        status: "UNTOUCHED",
      },
      { name: "flashsale (P2 Stack)", port: 5432, status: "UNTOUCHED" },
      {
        name: "flashsale-p4-dr-primary (Original DR Primary Volume)",
        status: "PRESERVED_AND_QUARANTINED",
      },
    ],
    exactDestructiveCommands: [
      `docker rm -f ${DR_CONFIG.primaryContainer}`,
      `docker compose -p ${DR_CONFIG.project} -f ${DR_CONFIG.composeFile} -f ${DR_CONFIG.recoveryComposeFile} down`,
      `docker volume rm -f ${DR_CONFIG.primaryRecoveryVolume} ${DR_CONFIG.replicaRecoveryVolume}`,
    ],
    p3LatestVerifiedBackup: p3LatestBackup,
    steps,
    message: p3LatestBackup.ok
      ? "DRY-RUN BERHASIL: Backup baseline tervalidasi. Tidak ada container atau volume yang dihapus."
      : "DRY-RUN BLOCKED: Backup baseline belum dapat divalidasi. Tidak ada container atau volume yang dihapus.",
  };
}

/**
 * Menjalankan skenario Disaster Recovery aktual (--execute)
 */
async function verifyPreFailureBaseline(
  baseUrl,
  get = httpGetJson,
  checkout = sendCheckoutRequest,
) {
  const health = await get(`${baseUrl}/health`);
  if (
    health.status !== 200 ||
    health.body?.db !== "up" ||
    health.body?.replica !== "up" ||
    health.body?.replica_read_only !== true
  ) {
    throw new Error(
      `P4 BASELINE FAILED: primary/replica health: ${JSON.stringify(health)}`,
    );
  }
  const products = await get(`${baseUrl}/products`);
  if (products.status !== 200 || !Array.isArray(products.body)) {
    throw new Error(
      `P4 BASELINE FAILED: product reads: ${JSON.stringify(products)}`,
    );
  }
  const product = products.body
    .filter((p) => Number(p.stock) > 1)
    .sort((a, b) => Number(a.id) - Number(b.id))[0];
  if (!product)
    throw new Error(
      "P4 BASELINE FAILED: no in-stock product with stock remaining after probe",
    );
  const result = await checkout(
    baseUrl,
    { user_id: 1, product_id: product.id, qty: 1 },
    `p4-baseline-${Date.now()}`,
  );
  if (
    result.status !== 201 &&
    !(result.status === 200 && result.body?.result === "DUPLICATE")
  ) {
    throw new Error(`P4 BASELINE FAILED: checkout: ${JSON.stringify(result)}`);
  }
  return {
    productId: Number(product.id),
    health: health.body,
    checkoutStatus: result.status,
  };
}

function requireAcknowledgedBaseline(entries) {
  const acknowledged = entries.filter(
    (tx) =>
      (tx.status === 201 && tx.outcome === "CREATED") ||
      (tx.status === 200 && tx.outcome === "DUPLICATE"),
  );
  if (!acknowledged.length)
    throw new Error(
      "WORKLOAD ERROR: No acknowledged checkout before T0 (201 CREATED or 200 DUPLICATE required)",
    );
  return acknowledged.length;
}

async function collectWorkloadResult(runner, report, stop = false) {
  const result = await (stop ? runner.stop() : runner.promise);
  report.k6Result = result;
  report.timestamps.k6FinishedAt = new Date().toISOString();
  if (!result.ok)
    report.workloadFailure =
      result.error ||
      `K6 exit=${result.code} signal=${result.signal}: ${result.stderr || ""}`;
  return result;
}

async function waitForPreFailureWorkload(runner, ledgerPath, report) {
  try {
    await runner.waitForHandshake(15000);
    await runner.waitForObservedVUs(100, 25000);
    const ledger = readLedger(ledgerPath);
    report.preFailureAcknowledgedTransactions = requireAcknowledgedBaseline(
      ledger.entries,
    );
    if (ledger.malformedCount)
      throw new Error("WORKLOAD ERROR: malformed pre-failure ledger");
    if (!runner.isAlive())
      throw new Error(
        "WORKLOAD ERROR: K6 stopped before primary failure injection",
      );
    return ledger;
  } catch (err) {
    await collectWorkloadResult(runner, report, true);
    report.workloadFailure ||= err.message;
    throw err;
  }
}

async function executeDisasterRecovery(options = {}, execFn = execSync) {
  const isExecute = Boolean(
    options.execute || process.argv.includes("--execute"),
  );
  if (!isExecute) {
    return planDisasterRecovery(options, execFn);
  }

  const report = {
    executedAt: new Date().toISOString(),
    mode: "EXECUTE",
    project: DR_CONFIG.project,
    port: DR_CONFIG.port,
    datasetConsistency: {},
    timestamps: {},
    steps: [],
    invariants: {},
    rto: null,
    rpo: null,
    success: false,
  };

  console.log(
    "===========================================================================",
  );
  console.log(
    "[DR ORCHESTRATION] Memulai Eksekusi Disaster Recovery Terisolasi",
  );
  console.log(`- Target Project          : ${DR_CONFIG.project}`);
  console.log(`- Target Ingress          : ${DR_CONFIG.baseUrl}`);
  console.log(
    `- Original Primary Volume : ${DR_CONFIG.primaryVolume} (PRESERVED & QUARANTINED)`,
  );
  console.log(`- Primary Recovery Volume : ${DR_CONFIG.primaryRecoveryVolume}`);
  console.log(`- Replica Recovery Volume : ${DR_CONFIG.replicaRecoveryVolume}`);
  console.log(
    "===========================================================================",
  );

  const ledgerFile = path.join(
    DR_CONFIG.ledgerDir,
    `dr_transactions_${Date.now()}.jsonl`,
  );
  let k6Runner;

  try {
    // 1. Preflight: Baseline P3 Backup Discovery & Trial Restore
    const p3LatestBackup = findP3BaselineBackup(options, execFn);
    if (!p3LatestBackup.ok) {
      throw new Error(
        `Tidak ditemukan backup baseline P3 yang valid: ${p3LatestBackup.error}`,
      );
    }
    report.datasetConsistency.p3BaselineBackup = p3LatestBackup.file;
    console.log(
      `[FASE A - 1] Backup baseline P3 tervalidasi: ${p3LatestBackup.file}`,
    );

    // Bersihkan hanya volume recovery lama jika ada (jangan sentuh volume asli)
    cleanupRecoveryVolumes(execFn);

    // Deploy clone terisolasi (2 backends, primary, replica, nginx)
    console.log(
      `[FASE A - 2] Memulai stack clone terisolasi ${DR_CONFIG.project} (2 backends)...`,
    );
    execDocker(
      `docker compose -p ${DR_CONFIG.project} -f ${DR_CONFIG.composeFile} up -d --scale backend=2 --wait`,
      execFn,
      "Deploy Initial DR Stack",
    );
    report.timestamps.stackStartedAt = new Date().toISOString();

    assertDrContainerIsolation(
      DR_CONFIG.primaryContainer,
      DR_CONFIG.project,
      execFn,
    );
    assertDrContainerIsolation(
      DR_CONFIG.replicaContainer,
      DR_CONFIG.project,
      execFn,
    );
    assertDrVolumeIsolation(DR_CONFIG.primaryVolume, execFn);
    assertDrNetworkIsolation(DR_CONFIG.network, execFn);
    report.ingress = configureP4Ingress(options.dockerRun);

    // Seeding awal dari baseline P3
    console.log(`[FASE A - 3] Seeding database P4 dari baseline P3...`);
    await performRestore(
      {
        container: DR_CONFIG.primaryContainer,
        dbName: DR_CONFIG.dbName,
        dbUser: DR_CONFIG.dbUser,
        backupDir: DR_CONFIG.p3BackupDir,
        file: p3LatestBackup.path,
        project: DR_CONFIG.project,
        service: "db-primary",
        environment: "p4-dr",
        execute: true,
      },
      execFn,
    );

    // Trial restore pada database terpisah
    console.log(
      `[FASE A - 4] Menjalankan restore trial pada database temporer...`,
    );
    const trialRes = performTrialRestore(
      DR_CONFIG.primaryContainer,
      p3LatestBackup.path,
      DR_CONFIG.dbUser,
      execFn,
    );
    if (!trialRes.ok || !trialRes.consistent) {
      throw new Error(
        `Trial restore pada database temporer gagal: ${JSON.stringify(trialRes)}`,
      );
    }
    report.trialRestore = trialRes;
    console.log(
      `[FASE A - 4 SUKSES] Trial restore berhasil diverifikasi (orders: ${trialRes.ordersCount}, products: ${trialRes.productsCount}).`,
    );

    // Nginx worker reload and backend pools may need a moment after the seed restore.
    let baseline;
    for (let attempt = 0; attempt < 20; attempt++) {
      const health = await httpGetJson(`${DR_CONFIG.baseUrl}/health`);
      if (
        health.status === 200 &&
        health.body?.db === "up" &&
        health.body?.replica === "up"
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    baseline = await verifyPreFailureBaseline(DR_CONFIG.baseUrl);
    report.baseline = baseline;

    // Buat backup pra-bencana dari database P4 (Single Consistent Dataset)
    console.log(
      `[FASE A - 5] Mengambil backup pra-bencana langsung dari database P4...`,
    );
    const p4BackupMeta = createP4PreDisasterBackup(
      {
        container: DR_CONFIG.primaryContainer,
        dbName: DR_CONFIG.dbName,
        dbUser: DR_CONFIG.dbUser,
        backupDir: DR_CONFIG.p4BackupDir,
      },
      execFn,
    );
    report.datasetConsistency.p4PreDisasterBackup = p4BackupMeta.file;
    console.log(
      `[FASE A - 5 SUKSES] Backup P4 tersimpan: ${p4BackupMeta.file}`,
    );

    // Fase B: Stress testing k6 (100 VUs) dengan handshake dan pelacakan aktif
    console.log(
      `[FASE B] Memulai checkout stress testing aktif menggunakan k6 (100 VUs)...`,
    );
    k6Runner = startK6Workload({
      baseUrl: DR_CONFIG.baseUrl,
      ledgerPath: ledgerFile,
      vus: 100,
      duration: "30s",
      runId: `p4-k6-${Date.now()}`,
      productId: baseline.productId,
    });

    console.log("[FASE B] Menunggu K6 startup handshake...");
    const preFailureLedger = await waitForPreFailureWorkload(
      k6Runner,
      ledgerFile,
      report,
    );
    console.log(
      `[FASE B SUKSES] 100 VUs aktif terkonfirmasi. ${preFailureLedger.entries.length} transaksi tercatat di ledger.`,
    );

    // Konfirmasi k6 masih berjalan aktif saat failure diinjeksi
    if (!k6Runner.isAlive()) {
      throw new Error(
        "WORKLOAD ERROR: Proses k6 berhenti prematur sebelum kegagalan diinjeksi!",
      );
    }

    // Fase C: Injeksi Kegagalan Primary saat k6 berjalan aktif
    console.log(
      `[FASE C] PRIMARY FAILURE INJECTION: Menghapus container primary saat k6 aktif...`,
    );
    const t0 = Date.now();
    report.timestamps.t0_failureInjectedAt = new Date(t0).toISOString();

    // Hapus HANYA container primary. Volume asli TETAP DIJAGA & DIKARANTINA.
    execDocker(
      `docker rm -f ${DR_CONFIG.primaryContainer}`,
      execFn,
      "Force Remove Primary Container",
    );
    const k6RunningDuringFailure = k6Runner.isAlive();
    report.k6RunningDuringFailure = k6RunningDuringFailure;
    console.log(
      `[FASE C INFO] Container primary dihapus. Nginx, backend pool, dan replica tetap berjalan.`,
    );

    // Verifikasi perilaku saat primary outage
    let failureBehavior;
    try {
      failureBehavior = await probePrimaryFailureBehavior(DR_CONFIG.baseUrl);
    } catch (err) {
      failureBehavior = {
        expectedBehaviorSatisfied: false,
        error: err.message,
      };
    }
    report.failureBehavior = failureBehavior;
    console.log(
      `[FASE C VERIFIKASI] Status outage: checkout=${failureBehavior.checkoutStatus}, health=${failureBehavior.healthStatus}, products=${failureBehavior.productsStatus} (from ${failureBehavior.productsReadFrom})`,
    );

    if (!failureBehavior.expectedBehaviorSatisfied) {
      report.outageError =
        `OUTAGE BEHAVIOR VIOLATION: Perilaku sistem saat outage tidak memenuhi syarat!\n` +
        `Expected: checkout=503, health=503, products=200 via replica.\n` +
        `Actual: checkout=${failureBehavior.checkoutStatus}, health=${failureBehavior.healthStatus}, products=${failureBehavior.productsStatus}, readFrom=${failureBehavior.productsReadFrom}`;
    }

    // Tunggu k6 selesai mencatat semua in-flight request ke ledger
    // After T0, workload failure must be reported while database recovery continues.
    await collectWorkloadResult(k6Runner, report);

    // Fase D: Recovery dengan dedicated recovery Compose override
    console.log(
      `[FASE D] Menyiapkan volume recovery baru '${DR_CONFIG.primaryRecoveryVolume}'...`,
    );
    try {
      execDocker(
        `docker volume rm -f ${DR_CONFIG.primaryRecoveryVolume}`,
        execFn,
        "Remove Old Primary Recovery Volume",
      );
    } catch {}
    execDocker(
      `docker volume create --name ${DR_CONFIG.primaryRecoveryVolume} --label com.docker.compose.project=${DR_CONFIG.project} --label flashsale.environment=p4-dr`,
      execFn,
      "Create Fresh Primary Recovery Volume",
    );

    // Start primary container dengan recovery compose override
    console.log(
      `[FASE D] Menjalankan primary container dengan volume recovery override...`,
    );
    execDocker(
      `docker compose -p ${DR_CONFIG.project} -f ${DR_CONFIG.composeFile} -f ${DR_CONFIG.recoveryComposeFile} up -d db-primary --wait`,
      execFn,
      "Start Primary with Recovery Override",
    );

    // Verifikasi bahwa primary benar-benar me-mount volume recovery
    verifyContainerVolumeMount(
      DR_CONFIG.primaryContainer,
      DR_CONFIG.primaryRecoveryVolume,
      execFn,
    );

    // Restore backup P4 ke primary recovery
    console.log(
      `[FASE D] Melakukan restore database dari backup pra-bencana ${p4BackupMeta.file}...`,
    );
    await performRestore(
      {
        container: DR_CONFIG.primaryContainer,
        dbName: DR_CONFIG.dbName,
        dbUser: DR_CONFIG.dbUser,
        backupDir: DR_CONFIG.p4BackupDir,
        file: p4BackupMeta.path,
        project: DR_CONFIG.project,
        service: "db-primary",
        environment: "p4-dr",
        execute: true,
      },
      execFn,
    );

    // Verifikasi primary writable
    const primaryRole = verifyDatabaseRole(
      DR_CONFIG.primaryContainer,
      DR_CONFIG.dbName,
      DR_CONFIG.dbUser,
      execFn,
    );
    if (!primaryRole.ok || primaryRole.inRecovery) {
      throw new Error("Primary recovery gagal: database bukan primary writer!");
    }

    // Rekonstruksi replica via pg_basebackup pada volume recovery replica baru
    console.log(
      `[FASE D] Membangun ulang replica pada volume recovery '${DR_CONFIG.replicaRecoveryVolume}' via pg_basebackup...`,
    );
    execDocker(
      `docker rm -f ${DR_CONFIG.replicaContainer}`,
      execFn,
      "Remove Old Replica Container",
    );
    try {
      execDocker(
        `docker volume rm -f ${DR_CONFIG.replicaRecoveryVolume}`,
        execFn,
        "Remove Old Replica Recovery Volume",
      );
    } catch {}
    execDocker(
      `docker volume create --name ${DR_CONFIG.replicaRecoveryVolume} --label com.docker.compose.project=${DR_CONFIG.project} --label flashsale.environment=p4-dr`,
      execFn,
      "Create Fresh Replica Recovery Volume",
    );

    execDocker(
      `docker compose -p ${DR_CONFIG.project} -f ${DR_CONFIG.composeFile} -f ${DR_CONFIG.recoveryComposeFile} up -d db-replica --wait`,
      execFn,
      "Start Replica with Recovery Override",
    );

    // Verifikasi replica mount dan role
    verifyContainerVolumeMount(
      DR_CONFIG.replicaContainer,
      DR_CONFIG.replicaRecoveryVolume,
      execFn,
    );
    const replicaRole = verifyDatabaseRole(
      DR_CONFIG.replicaContainer,
      DR_CONFIG.dbName,
      DR_CONFIG.dbUser,
      execFn,
    );
    if (replicaRole.inRecovery !== true) {
      throw new Error(
        "Replica reconstruction failed: replica is not in standby mode!",
      );
    }

    // Verifikasi tepat ada satu writable primary di DR stack
    verifySingleWritablePrimary(
      [DR_CONFIG.primaryContainer, DR_CONFIG.replicaContainer],
      DR_CONFIG.dbUser,
      DR_CONFIG.dbName,
      execFn,
    );

    // Reconnect backend pool via recovery override
    console.log(`[FASE D] Menyambungkan ulang backend pool ke primary baru...`);
    execDocker(
      `docker compose -p ${DR_CONFIG.project} -f ${DR_CONFIG.composeFile} -f ${DR_CONFIG.recoveryComposeFile} restart backend`,
      execFn,
      "Restart Backend Pool",
    );

    // Fase E: Validasi Pemulihan Lengkap (T1 & RTO)
    console.log(
      "[FASE E] Memvalidasi 8 syarat pemulihan lengkap untuk pencatatan T1...",
    );
    const healthPostRecovery = await httpGetJson(`${DR_CONFIG.baseUrl}/health`);
    const healthOk =
      healthPostRecovery.status === 200 &&
      healthPostRecovery.body?.status === "ok" &&
      healthPostRecovery.body?.db === "up";

    const newCheckoutRes = await sendCheckoutRequest(
      DR_CONFIG.baseUrl,
      { user_id: 1, product_id: baseline.productId, qty: 1 },
      `post-recovery-verification-${Date.now()}`,
    );
    const checkoutOk = newCheckoutRes.status === 201;

    const statsPostRecovery = await httpGetJson(`${DR_CONFIG.baseUrl}/stats`);
    const statsOk =
      statsPostRecovery.status === 200 &&
      statsPostRecovery.body?.consistent === true;

    const primRolePost = verifyDatabaseRole(
      DR_CONFIG.primaryContainer,
      DR_CONFIG.dbName,
      DR_CONFIG.dbUser,
      execFn,
    );
    const primOk = primRolePost.ok && !primRolePost.inRecovery;

    const replRolePost = verifyDatabaseRole(
      DR_CONFIG.replicaContainer,
      DR_CONFIG.dbName,
      DR_CONFIG.dbUser,
      execFn,
    );
    const replOk = replRolePost.inRecovery === true;

    const replStreamingOk = healthPostRecovery.body?.replica === "up";

    const productsPostRecovery = await httpGetJson(
      `${DR_CONFIG.baseUrl}/products`,
    );
    const prodRoutingOk =
      productsPostRecovery.status === 200 &&
      productsPostRecovery.headers?.["x-read-from"] === "replica";

    const invariants = verifyAllBusinessInvariants(
      DR_CONFIG.primaryContainer,
      DR_CONFIG.dbUser,
      DR_CONFIG.dbName,
      execFn,
    );
    const invariantsOk =
      invariants.consistent &&
      invariants.negativeStock === 0 &&
      invariants.duplicateOrders === 0 &&
      invariants.mismatchedProducts === 0;

    const allConditionsMet =
      healthOk &&
      checkoutOk &&
      statsOk &&
      primOk &&
      replOk &&
      replStreamingOk &&
      prodRoutingOk &&
      invariantsOk;

    if (!allConditionsMet) {
      throw new Error(
        `T1 VALIDATION FAILED: Tidak semua 8 syarat pemulihan terpenuhi!\n` +
          `healthOk=${healthOk}, checkoutOk=${checkoutOk}, statsOk=${statsOk}, primOk=${primOk}, ` +
          `replOk=${replOk}, replStreamingOk=${replStreamingOk}, prodRoutingOk=${prodRoutingOk}, invariantsOk=${invariantsOk}`,
      );
    }

    const t1 = Date.now();
    report.timestamps.t1_recoveryCompletedAt = new Date(t1).toISOString();
    const rtoSeconds = Math.round((t1 - t0) / 1000);
    report.rto = {
      actualSeconds: rtoSeconds,
      targetSeconds: 300,
      achieved: rtoSeconds <= 300,
      validatedConditions: {
        healthOk,
        checkoutOk,
        statsOk,
        primOk,
        replOk,
        replStreamingOk,
        prodRoutingOk,
        invariantsOk,
      },
    };
    console.log(
      `[FASE E SUKSES] T1 tercatat. RTO Aktual: ${rtoSeconds}s (Target: <= 300s).`,
    );

    // Fase F: Rekonsiliasi Transaksi, Ambiguous Replay, & 9 Invarian Bisnis
    console.log(
      `[FASE F] Menjalankan rekonsiliasi transaksi berbasis Idempotency-Key...`,
    );
    const dbOrdersRes = execDocker(
      `docker exec ${DR_CONFIG.primaryContainer} psql -U ${DR_CONFIG.dbUser} -d ${DR_CONFIG.dbName} -AtXc "SELECT id, idempotency_key, created_at FROM orders;"`,
      execFn,
      "Fetch Orders for Reconciliation",
    );
    const dbOrders = (dbOrdersRes.stdout || "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [id, idempotencyKey, createdAt] = line.split("|");
        return { id, idempotencyKey, createdAt };
      });

    const ledgerData = readLedger(ledgerFile);
    if (!ledgerData.entries || ledgerData.entries.length === 0) {
      throw new Error(
        "EMPTY_LEDGER_ERROR: Empty transaction ledger must never be interpreted as proof of RPO = 0!",
      );
    }

    const rpoEval = compareLedgerWithDatabase(ledgerData.entries, dbOrders, {
      failureTimestamp: new Date(t0).toISOString(),
      backupTimestamp: p4BackupMeta.createdAt,
    });

    report.rpo = {
      actualSeconds: rpoEval.actualRpoSeconds,
      restorePointAgeSeconds: rpoEval.restorePointAgeSeconds,
      targetSeconds: 60,
      achieved: rpoEval.actualRpoSeconds <= 60,
      acknowledgedTransactions: rpoEval.acknowledgedTransactions,
      restoredTransactions: rpoEval.restoredTransactions,
      missingAcknowledgedTransactions: rpoEval.missingAcknowledgedTransactions,
      duplicateTransactions: rpoEval.duplicateTransactions,
      ambiguousTransactions: rpoEval.ambiguousTransactions,
      lastRecoverableAcknowledgedTransaction:
        rpoEval.lastRecoverableAcknowledgedTransaction,
    };

    // Replay ambiguous transactions untuk membuktikan idempotent handling
    if (rpoEval.ambiguousTransactions.count > 0) {
      console.log(
        `[FASE F] Mereplay ${rpoEval.ambiguousTransactions.count} transaksi ambiguous...`,
      );
      const replayResults = await replayAmbiguousTransactions(
        DR_CONFIG.baseUrl,
        rpoEval.ambiguousTransactions.transactions,
      );
      report.replayResults = replayResults;
    }

    // Verifikasi final invarian pasca-replay
    const finalInvariants = verifyAllBusinessInvariants(
      DR_CONFIG.primaryContainer,
      DR_CONFIG.dbUser,
      DR_CONFIG.dbName,
      execFn,
    );
    report.invariants = finalInvariants;

    // Kriteria Sukses Akhir yang Ketat
    report.success =
      report.k6Result.ok &&
      report.rto.achieved &&
      report.rpo.achieved &&
      finalInvariants.consistent &&
      finalInvariants.negativeStock === 0 &&
      finalInvariants.duplicateOrders === 0 &&
      failureBehavior.expectedBehaviorSatisfied &&
      ledgerData.entries.length > 0;

    console.log(
      "===========================================================================",
    );
    console.log(
      `[DR TEST SELESAI] Hasil: ${report.success ? "SUKSES" : "GAGAL"}`,
    );
    console.log(
      `- RTO Aktual     : ${report.rto.actualSeconds} detik (Target: <= 300s)`,
    );
    console.log(
      `- RPO Aktual     : ${report.rpo.actualSeconds} detik (Target: <= 60s)`,
    );
    console.log(`- Consistent     : ${finalInvariants.consistent}`);
    console.log(`- Negative Stock : ${finalInvariants.negativeStock}`);
    console.log(`- Duplicates     : ${finalInvariants.duplicateOrders}`);
    console.log(
      "===========================================================================",
    );

    // Normal Teardown: Menggunakan 'docker compose down' TANPA -v
    // Volume asli primary (flashsale-p4-dr-primary) TETAP UTUH untuk inspeksi forensik!
    console.log(
      "[TEARDOWN] Menjalankan 'docker compose down' (tanpa -v) untuk menjaga volume primer asli...",
    );
    execDocker(
      `docker compose -p ${DR_CONFIG.project} -f ${DR_CONFIG.composeFile} -f ${DR_CONFIG.recoveryComposeFile} down`,
      execFn,
      "Teardown DR Services",
    );

    // Bersihkan hanya volume pemulihan setelah verifikasi identitas
    cleanupRecoveryVolumes(execFn);

    fs.mkdirSync(path.dirname(DR_CONFIG.reportFile), { recursive: true });
    fs.writeFileSync(
      DR_CONFIG.reportFile,
      JSON.stringify(report, null, 2),
      "utf8",
    );

    return report;
  } catch (err) {
    if (k6Runner) {
      await collectWorkloadResult(k6Runner, report, true);
    }
    report.error = err.message;
    report.failedAt = new Date().toISOString();
    try {
      fs.mkdirSync(path.dirname(DR_CONFIG.reportFile), { recursive: true });
      fs.writeFileSync(
        DR_CONFIG.reportFile,
        JSON.stringify(report, null, 2),
        "utf8",
      );
    } catch {}
    throw err;
  }
}

if (require.main === module) {
  require("./p3-dr")
    .main()
    .catch((error) => {
      console.error("[P4 P3 DR ERROR]", error.message);
      process.exitCode = 1;
    });
}

module.exports = {
  DR_CONFIG: require("./p3-dr").SPEC,
  execDocker,
  cleanupRecoveryVolumes,
  verifyContainerVolumeMount,
  verifySingleWritablePrimary,
  assertDrIsolation,
  assertDrContainerIsolation,
  assertDrVolumeIsolation,
  assertDrNetworkIsolation,
  createP4PreDisasterBackup,
  performTrialRestore,
  probePrimaryFailureBehavior,
  verifyAllBusinessInvariants,
  replayAmbiguousTransactions,
  // Historical clone helpers remain for regression evidence, not the official P4 path.
  legacyIsolated: {
    DR_CONFIG,
    planDisasterRecovery,
    executeDisasterRecovery: async () => {
      throw new Error(
        "Isolated clone DR execution retired by Architecture v1.3; use the confirmed P3 scenario",
      );
    },
  },
  planDisasterRecovery: (...args) =>
    require("./p3-dr").planDisasterRecovery(...args),
  executeDisasterRecovery: (...args) =>
    require("./p3-dr").executeDisasterRecovery(...args),
  verifyPreFailureBaseline,
  requireAcknowledgedBaseline,
  waitForPreFailureWorkload,
  collectWorkloadResult,
  findP3BaselineBackup,
};
