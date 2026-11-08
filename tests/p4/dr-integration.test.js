"use strict";
const { restoreOptions, restoreInspect } = require("./helpers/restore-runtime");
/**
 * tests/p4/dr-integration.test.js
 * Integration Test Suite untuk Disaster Recovery (Pertemuan 4)
 *
 * Terbagi menjadi 3 bagian yang terpisah secara tegas:
 * BAGIAN 1: Pengujian Unit/Mock Pipeline Pemulihan Menggunakan Fungsi Produksi Asli
 *   - Menguji modul produksi riil: verifyDatabaseRole, verifyAllBusinessInvariants,
 *     performTrialRestore, verifySingleWritablePrimary, cleanupRecoveryVolumes, performRestore.
 *   - Tidak menggunakan implementasi dummy lokal.
 *
 * BAGIAN 2: Pengujian Integrasi Non-Destruktif Lingkungan P4 Terisolasi (P4 DR Environment)
 *   - Menguji integritas konfigurasi docker-compose.p4-dr.yml dan override docker-compose.p4-dr.recovery.yml.
 *   - Memverifikasi isolasi port (8088), volume mapping recovery, dan skrip k6 workload.
 *
 * BAGIAN 3: Verifikasi Pra-Kondisi Stack Baseline P3 Live (Live P3 Baseline Check)
 *   - Pemeriksaan non-destruktif terhadap baseline stack P3 (port 8080).
 *   - Ditegaskan sebagai verifikasi baseline pra-kondisi P3, bukan pengujian pemulihan P4.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

const {
  verifyDatabaseRole,
  inspectContainerIdentity,
} = require("../../scripts/p4/common");
const { performRestore } = require("../../scripts/p4/restore");
const { compareLedgerWithDatabase } = require("../../scripts/p4/ledger");
const {
  DR_CONFIG,
  verifyAllBusinessInvariants,
  performTrialRestore,
  verifySingleWritablePrimary,
  cleanupRecoveryVolumes,
  assertDrContainerIsolation,
  assertDrVolumeIsolation,
  assertDrNetworkIsolation,
} = require("../../scripts/p4/orchestrate-dr");

// =========================================================================
// BAGIAN 1: PENGUJIAN MOCK PIPELINE PEMULIHAN MENGGUNAKAN FUNGSI PRODUKSI ASLI
// =========================================================================

const TEST_INTEGRATION_DIR = path.resolve(
  __dirname,
  "../../tmp-test-dr-integration",
);

function setupDir() {
  if (fs.existsSync(TEST_INTEGRATION_DIR)) {
    try {
      fs.rmSync(TEST_INTEGRATION_DIR, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    } catch {}
  }
  fs.mkdirSync(TEST_INTEGRATION_DIR, { recursive: true });

  const dumpPath = path.join(
    TEST_INTEGRATION_DIR,
    "flashsale_p4_pre_disaster_20261108_120000.dump",
  );
  const content = "VALID_DUMP_BINARY_P4";
  fs.writeFileSync(dumpPath, content, "utf8");
  const sha = crypto
    .createHash("sha256")
    .update(Buffer.from(content))
    .digest("hex");
  fs.writeFileSync(
    `${dumpPath}.sha256`,
    `${sha}  flashsale_p4_pre_disaster_20261108_120000.dump\n`,
    "utf8",
  );

  return { dumpPath, sha };
}

function cleanDir() {
  if (fs.existsSync(TEST_INTEGRATION_DIR)) {
    try {
      fs.rmSync(TEST_INTEGRATION_DIR, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    } catch {}
  }
}

// 1. Restorasi backup ke clean isolated database menggunakan performRestore asli
test("dr integration (mock): performRestore produksi memanggil pg_restore dengan opsi lengkap (--clean, --if-exists, dll)", async () => {
  const { dumpPath } = setupDir();
  try {
    const executedCommands = [];
    const mockExec = (cmd) => {
      executedCommands.push(cmd);
      if (cmd.includes("docker inspect")) return restoreInspect();
      if (cmd.includes("SELECT current_database(), pg_is_in_recovery()"))
        return "flashsale_p3|f\n";
      if (cmd.includes("pg_stat_activity")) {
        if (cmd.includes("pg_terminate_backend")) return "2\n";
        return "0\n";
      }
      if (cmd.includes("pg_restore -l") || cmd.includes("pg_restore --list"))
        return "1; TABLE public orders\n";
      if (cmd.includes("pg_restore")) return "";
      if (cmd.includes("orders_count")) return "100|3|5\n";
      return "";
    };

    const res = await performRestore(
      {
        container: "flashsale-p3-db-primary-1",
        dbName: "flashsale_p3",
        dbUser: "p3_admin",
        file: dumpPath,
        backupDir: TEST_INTEGRATION_DIR,
        project: "flashsale-p3",
        service: "db-primary",
        environment: "p3",
        ...restoreOptions(TEST_INTEGRATION_DIR), execute: true,
      },
      mockExec,
    );

    assert.equal(res.status, "SUCCESS");
    assert.equal(res.dryRun, false);
    assert.equal(res.tableCounts.orders, 100);

    const pgRestoreCmd = executedCommands.find(
      (c) => c.includes("pg_restore") && c.includes("--clean"),
    );
    assert.ok(
      pgRestoreCmd,
      "Perintah pg_restore dengan opsi --clean harus dijalankan",
    );
    assert.ok(pgRestoreCmd.includes("--clean"));
    assert.ok(pgRestoreCmd.includes("--if-exists"));
    assert.ok(pgRestoreCmd.includes("--no-owner"));
    assert.ok(pgRestoreCmd.includes("--no-acl"));
    assert.ok(pgRestoreCmd.includes("--exit-on-error"));
  } finally {
    cleanDir();
  }
});

// 2. Validasi peran primary menggunakan verifyDatabaseRole asli
test("dr integration (mock): verifyDatabaseRole produksi memvalidasi writer non-recovery dan menolak standby/mismatch", () => {
  const mockPrimary = () => "flashsale_p3|f\n";
  const resOk = verifyDatabaseRole(
    "flashsale-p4-dr-db-primary-1",
    "flashsale_p3",
    "p3_admin",
    mockPrimary,
  );
  assert.equal(resOk.ok, true);
  assert.equal(resOk.inRecovery, false);

  const mockStandby = () => "flashsale_p3|t\n";
  const resStandby = verifyDatabaseRole(
    "flashsale-p4-dr-db-replica-1",
    "flashsale_p3",
    "p3_admin",
    mockStandby,
  );
  assert.equal(resStandby.ok, false);
  assert.equal(resStandby.inRecovery, true);

  const mockWrongDb = () => "flashsale|f\n";
  const resWrong = verifyDatabaseRole(
    "flashsale-p4-dr-db-primary-1",
    "flashsale_p3",
    "p3_admin",
    mockWrongDb,
  );
  assert.equal(resWrong.ok, false);
  assert.ok(resWrong.error.includes("Database mismatch"));
});

// 3. Validasi single writable primary menggunakan verifySingleWritablePrimary asli
test("dr integration (mock): verifySingleWritablePrimary produksi memastikan tepat ada 1 primary writer dan 1 standby", () => {
  // Case A: Sehat (1 primary writer, 1 standby replica)
  const mockHealthyCluster = (cmd) => {
    if (cmd.includes("flashsale-p4-dr-db-primary-1")) return "flashsale_p3|f\n";
    if (cmd.includes("flashsale-p4-dr-db-replica-1")) return "flashsale_p3|t\n";
    return "";
  };
  const verified = verifySingleWritablePrimary(
    ["flashsale-p4-dr-db-primary-1", "flashsale-p4-dr-db-replica-1"],
    "p3_admin",
    "flashsale_p3",
    mockHealthyCluster,
  );
  assert.equal(verified, true);

  // Case B: Split-Brain Terdeteksi (2 primary writer) -> WAJIB MELEMPARKAN ERROR
  const mockSplitBrain = () => "flashsale_p3|f\n";
  assert.throws(
    () =>
      verifySingleWritablePrimary(
        ["flashsale-p4-dr-db-primary-1", "flashsale-p4-dr-db-replica-1"],
        "p3_admin",
        "flashsale_p3",
        mockSplitBrain,
      ),
    /SPLIT-BRAIN \/ PRIMARY COUNT ANOMALY: Ditemukan 2 writable primary/,
  );
});

// 4. Verifikasi invarian bisnis menggunakan verifyAllBusinessInvariants asli
test("dr integration (mock): verifyAllBusinessInvariants produksi menolak stok negatif dan pesanan ganda", () => {
  // Skenario Bersih
  const mockClean = () => "0|0|0|t|150\n";
  const cleanRes = verifyAllBusinessInvariants(
    "flashsale-p4-dr-db-primary-1",
    "p3_admin",
    "flashsale_p3",
    mockClean,
  );
  assert.equal(cleanRes.consistent, true);
  assert.equal(cleanRes.negativeStock, 0);
  assert.equal(cleanRes.duplicateOrders, 0);

  // Skenario Stok Negatif
  const mockCorruptStock = () => "2|0|0|t|150\n";
  const stockRes = verifyAllBusinessInvariants(
    "flashsale-p4-dr-db-primary-1",
    "p3_admin",
    "flashsale_p3",
    mockCorruptStock,
  );
  assert.equal(stockRes.consistent, false);
  assert.equal(stockRes.negativeStock, 2);

  // Skenario Pesanan Ganda
  const mockCorruptDup = () => "0|3|0|t|150\n";
  const dupRes = verifyAllBusinessInvariants(
    "flashsale-p4-dr-db-primary-1",
    "p3_admin",
    "flashsale_p3",
    mockCorruptDup,
  );
  assert.equal(dupRes.consistent, false);
  assert.equal(dupRes.duplicateOrders, 3);
});

// 5. Uji performTrialRestore produksi dengan pemisahan DROP/CREATE dan pengecekan ketat
test("dr integration (mock): performTrialRestore produksi menjalankan query DROP & CREATE terpisah dan memvalidasi baris", () => {
  const executed = [];
  const mockExec = (cmd) => {
    executed.push(cmd);
    if (cmd.includes("DROP DATABASE")) return "";
    if (cmd.includes("CREATE DATABASE")) return "";
    if (cmd.includes("docker cp")) return "";
    if (cmd.includes("pg_restore")) return "";
    if (cmd.includes("orders_count")) return "100|3|5\n";
    if (cmd.includes("stock < 0")) return "0|0\n";
    return "";
  };

  const trialRes = performTrialRestore(
    "flashsale-p4-dr-db-primary-1",
    "/path/to/test.dump",
    "p3_admin",
    mockExec,
  );
  assert.equal(trialRes.ok, true);
  assert.equal(trialRes.consistent, true);
  assert.equal(trialRes.ordersCount, 100);
  assert.equal(trialRes.productsCount, 3);

  // Verifikasi DROP dan CREATE dijalankan sebagai perintah terpisah
  const dropCmd = executed.find((c) =>
    c.includes("DROP DATABASE IF EXISTS flashsale_p3_trial_verify"),
  );
  const createCmd = executed.find((c) =>
    c.includes("CREATE DATABASE flashsale_p3_trial_verify"),
  );
  assert.ok(dropCmd, "Perintah DROP DATABASE terpisah harus dieksekusi");
  assert.ok(createCmd, "Perintah CREATE DATABASE terpisah harus dieksekusi");
  assert.notEqual(
    dropCmd,
    createCmd,
    "DROP dan CREATE dilarang digabung dalam 1 statement",
  );
});

// 6. Pembersihan recovery volume menggunakan cleanupRecoveryVolumes asli menolak menyentuh volume primer asli
test("dr integration (mock): cleanupRecoveryVolumes produksi menolak keras menghapus volume primer asli", () => {
  const deletedVolumes = [];
  const mockExec = (cmd) => {
    if (cmd.includes("docker volume rm")) {
      deletedVolumes.push(cmd);
      return "";
    }
    if (cmd.includes("docker volume inspect")) {
      return JSON.stringify([
        {
          Name: "flashsale-p4-dr-primary-recovery",
          Labels: {
            "com.docker.compose.project": "flashsale-p4-dr",
            "flashsale.environment": "p4-dr",
          },
        },
      ]);
    }
    return "";
  };

  cleanupRecoveryVolumes(mockExec);

  // Pastikan volume asli TIDAK PERNAH masuk dalam perintah penghapusan
  const deletedOriginal = deletedVolumes.find(
    (c) =>
      c.includes("flashsale-p4-dr-primary ") ||
      c.endsWith("flashsale-p4-dr-primary"),
  );
  assert.equal(
    deletedOriginal,
    undefined,
    "Volume primer asli flashsale-p4-dr-primary DILARANG KERAS dihapus!",
  );
});

// 7. Ledger comparison menggunakan compareLedgerWithDatabase produksi
test("dr integration (mock): compareLedgerWithDatabase produksi menghitung RPO aktual dan memfilter error", () => {
  const baseTime = 1731040000000;
  const failureTime = baseTime + 10000;

  const ledgerEntries = [
    {
      idempotencyKey: "tx-p4-1",
      timestamp: new Date(baseTime + 1000).toISOString(),
      productId: 1,
      qty: 1,
      status: 201,
      outcome: "CREATED",
      orderId: 101,
    },
    {
      idempotencyKey: "tx-p4-2",
      timestamp: new Date(baseTime + 2000).toISOString(),
      productId: 1,
      qty: 1,
      status: 201,
      outcome: "CREATED",
      orderId: 102,
    },
    {
      idempotencyKey: "tx-p4-3",
      timestamp: new Date(baseTime + 6000).toISOString(),
      productId: 1,
      qty: 1,
      status: 201,
      outcome: "CREATED",
      orderId: 103,
    },
    {
      idempotencyKey: "tx-p4-4",
      timestamp: new Date(baseTime + 10500).toISOString(),
      status: 503,
      outcome: "ERROR",
      body: { error: "DB_UNAVAILABLE" },
    },
  ];

  const dbOrders = [
    {
      id: "101",
      idempotency_key: "tx-p4-1",
      created_at: new Date(baseTime + 1000).toISOString(),
    },
    {
      id: "102",
      idempotency_key: "tx-p4-2",
      created_at: new Date(baseTime + 2000).toISOString(),
    },
  ];

  const evalResult = compareLedgerWithDatabase(ledgerEntries, dbOrders, {
    failureTimestamp: new Date(failureTime).toISOString(),
  });

  assert.equal(evalResult.acknowledgedTransactions.count, 3);
  assert.equal(evalResult.restoredTransactions.count, 2);
  assert.equal(evalResult.missingAcknowledgedTransactions.count, 1);
  assert.equal(evalResult.actualRpoSeconds, 4); // disaster - newest lost ACK, DRP v1.1
});

// =========================================================================
// BAGIAN 2: PENGUJIAN INTEGRASI NON-DESTRUKTIF LINGKUNGAN P4 TERISOLASI
// =========================================================================

test("dr integration (p4 env): docker-compose.p4-dr.yml tervalidasi dengan port terisolasi 8088, network p4-dr, dan volume recovery", () => {
  const composePath = path.resolve(__dirname, "../../docker-compose.p4-dr.yml");
  assert.ok(fs.existsSync(composePath), "docker-compose.p4-dr.yml wajib ada");

  const content = fs.readFileSync(composePath, "utf8");
  assert.ok(
    content.includes("name: flashsale-p4-dr"),
    "Project name harus flashsale-p4-dr",
  );
  assert.ok(
    content.includes("8088") && content.includes(":80"),
    "Ingress port harus terisolasi pada 8088",
  );
  assert.ok(
    content.includes("flashsale-p4-dr-primary-recovery"),
    "Volume primary recovery harus didefinisikan",
  );
  assert.ok(
    content.includes("flashsale-p4-dr-replica-recovery"),
    "Volume replica recovery harus didefinisikan",
  );
  assert.ok(
    content.includes("flashsale.environment: p4-dr"),
    "Label environment p4-dr harus ada",
  );
});

test("dr integration (p4 env): docker-compose.p4-dr.recovery.yml me-mount volume recovery bersih dan tidak me-mount volume primer asli", () => {
  const recoveryPath = path.resolve(
    __dirname,
    "../../docker-compose.p4-dr.recovery.yml",
  );
  assert.ok(
    fs.existsSync(recoveryPath),
    "docker-compose.p4-dr.recovery.yml wajib ada",
  );

  const content = fs.readFileSync(recoveryPath, "utf8");
  assert.ok(
    content.includes("p4-dr-primary-recovery:/var/lib/postgresql/data"),
    "Primary recovery harus di-mount ke db-primary",
  );
  assert.ok(
    content.includes("p4-dr-replica-recovery:/var/lib/postgresql/data"),
    "Replica recovery harus di-mount ke db-replica",
  );
  assert.ok(
    !content.includes("p4-dr-primary:"),
    "Volume asli p4-dr-primary DILARANG dimount pada recovery override!",
  );
});

test("dr integration (p4 env): skrip k6 workload memuat handshake [K6_HANDSHAKE] dan opsi threshold disaster recovery", () => {
  const k6ScriptPath = path.resolve(
    __dirname,
    "../../tests/load/p4-dr-workload.js",
  );
  assert.ok(
    fs.existsSync(k6ScriptPath),
    "tests/load/p4-dr-workload.js wajib ada",
  );

  const content = fs.readFileSync(k6ScriptPath, "utf8");
  assert.ok(
    content.includes("[K6_HANDSHAKE]"),
    "k6 script harus memancarkan startup handshake",
  );
  assert.ok(
    content.includes("constant-vus"),
    "k6 scenario harus menggunakan executor constant-vus",
  );
  assert.ok(
    content.includes("[LEDGER]"),
    "k6 script harus memancarkan structured log [LEDGER]",
  );
});

// =========================================================================
// BAGIAN 3: VERIFIKASI PRA-KONDISI STACK BASELINE P3 LIVE (NON-DESTRUCTIVE)
// =========================================================================

function isLiveP3StackAvailable() {
  try {
    const primaryName = execSync(
      "docker ps --filter name=flashsale-p3-db-primary-1 --format {{.Names}}",
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return primaryName.includes("flashsale-p3-db-primary-1");
  } catch {
    return false;
  }
}

async function isP3HttpAvailable() {
  try {
    const res = await fetch("http://127.0.0.1:8080/health", {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

test("dr integration (p3 live baseline): inspeksi container live P3 memverifikasi isolasi label stack dan service running", (t) => {
  if (!isLiveP3StackAvailable()) {
    t.skip(
      "Docker stack flashsale-p3 tidak aktif. Melewati live container inspection test.",
    );
    return;
  }

  const primaryState = inspectContainerIdentity("flashsale-p3-db-primary-1", {
    project: "flashsale-p3",
    service: "db-primary",
    environment: "p3",
  });
  assert.equal(primaryState.ok, true);
  assert.equal(primaryState.running, true);
  assert.equal(
    primaryState.labels["com.docker.compose.project"],
    "flashsale-p3",
  );

  const replicaState = inspectContainerIdentity("flashsale-p3-db-replica-1", {
    project: "flashsale-p3",
    service: "db-replica",
    environment: "p3",
  });
  assert.equal(replicaState.ok, true);
  assert.equal(replicaState.running, true);
});

test("dr integration (p3 live baseline): validasi peran live primary berstatus writer non-recovery (in_recovery=f)", (t) => {
  if (!isLiveP3StackAvailable()) {
    t.skip(
      "Docker stack flashsale-p3 tidak aktif. Melewati live primary role test.",
    );
    return;
  }

  const role = verifyDatabaseRole(
    "flashsale-p3-db-primary-1",
    "flashsale_p3",
    "p3_admin",
  );
  assert.equal(role.ok, true);
  assert.equal(role.dbName, "flashsale_p3");
  assert.equal(role.inRecovery, false);
});

test("dr integration (p3 live baseline): validasi peran live replica berstatus standby recovery (in_recovery=t)", (t) => {
  if (!isLiveP3StackAvailable()) {
    t.skip(
      "Docker stack flashsale-p3 tidak aktif. Melewati live replica role test.",
    );
    return;
  }

  const role = verifyDatabaseRole(
    "flashsale-p3-db-replica-1",
    "flashsale_p3",
    "p3_admin",
  );
  assert.equal(role.ok, false);
  assert.equal(role.inRecovery, true);
  assert.equal(role.dbName, "flashsale_p3");
});

test("dr integration (p3 live baseline): validasi read-replica routing via Nginx mengembalikan HTTP 200 dan header X-Read-From: replica", async (t) => {
  if (!isLiveP3StackAvailable() || !(await isP3HttpAvailable())) {
    t.skip(
      "Live HTTP stack http://127.0.0.1:8080 tidak aktif. Melewati read-replica routing test.",
    );
    return;
  }

  const res = await fetch("http://127.0.0.1:8080/products", {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-read-from"), "replica");
});

test("dr integration (p3 live baseline): validasi backend live healthcheck mengembalikan status ok, db up, dan replica status", async (t) => {
  if (!isLiveP3StackAvailable() || !(await isP3HttpAvailable())) {
    t.skip(
      "Live HTTP stack http://127.0.0.1:8080 tidak aktif. Melewati live healthcheck test.",
    );
    return;
  }

  const res = await fetch("http://127.0.0.1:8080/health", {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(res.status, 200);

  const health = await res.json();
  assert.equal(health.status, "ok");
  assert.equal(health.db, "up");
  assert.equal(health.replica, "up");
  assert.equal(health.replica_read_only, true);
});

test("dr integration (p3 live baseline): validasi endpoint /stats live memastikan 9 invarian bisnis konsisten (0 stok negatif, 0 duplikasi)", async (t) => {
  if (!isLiveP3StackAvailable() || !(await isP3HttpAvailable())) {
    t.skip(
      "Live HTTP stack http://127.0.0.1:8080 tidak aktif. Melewati live business invariants test.",
    );
    return;
  }

  const res = await fetch("http://127.0.0.1:8080/stats", {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(res.status, 200);

  const stats = await res.json();
  assert.equal(stats.consistent, true);
  assert.equal(stats.negative_stock, 0);
  assert.equal(stats.duplicate_orders, 0);
  assert.equal(stats.mismatched_products, 0);
  assert.equal(stats.total_orders, stats.total_qty_sold);
});
