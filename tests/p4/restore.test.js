"use strict";
/**
 * tests/p4/restore.test.js
 * Unit Test Suite untuk Modul Restore Automation P4 (flashsale_p3)
 *
 * Menguji seluruh skenario fail-closed:
 * - Proteksi dry-run default
 * - Penolakan checksum mismatch
 * - Penolakan identitas container & database role salah
 * - Penolakan jika pemutusan koneksi gagal atau koneksi masih aktif
 * - Penolakan fail-closed verifikasi pasca-restore (query gagal, output kosong, malformed, NaN, negatif)
 * - Keberhasilan restore dengan verifikasi tabel lengkap
 * - Validasi strict non-negative integer & parsing koneksi
 * - Query pemutusan koneksi dan penghitungan terminasi akurat
 * - Pemilihan backup terbaru yang valid (skip corrupt, missing sha256, checksum mismatch)
 * - Perlindungan backup lama agar tidak termodifikasi
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { performRestore, findLatestBackup } = require("../../scripts/p4/restore");
const {
  parseStrictNonNegativeInt,
  getActiveConnectionCount,
  terminateActiveConnections,
} = require("../../scripts/p4/common");

const TEST_RESTORE_DIR = path.resolve(__dirname, "../../tmp-test-restore");

function setupTestBackup() {
  if (fs.existsSync(TEST_RESTORE_DIR)) {
    fs.rmSync(TEST_RESTORE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_RESTORE_DIR, { recursive: true });

  const dumpPath = path.join(TEST_RESTORE_DIR, "flashsale_p3_20261108_120000.dump");
  const content = "VALID_POSTGRESQL_CUSTOM_DUMP_FORMAT";
  fs.writeFileSync(dumpPath, content, "utf8");

  const sha256 = crypto.createHash("sha256").update(Buffer.from(content)).digest("hex");
  fs.writeFileSync(`${dumpPath}.sha256`, `${sha256}  flashsale_p3_20261108_120000.dump\n`, "utf8");

  return { dumpPath, sha256 };
}

function cleanTestDir() {
  if (fs.existsSync(TEST_RESTORE_DIR)) {
    fs.rmSync(TEST_RESTORE_DIR, { recursive: true, force: true });
  }
}

const VALID_INSPECT_JSON = JSON.stringify([
  {
    Id: "123456abcdef",
    State: { Status: "running", Running: true },
    Config: {
      Labels: {
        "com.docker.compose.project": "flashsale-p3",
        "com.docker.compose.service": "db-primary",
        "flashsale.environment": "p3",
      },
    },
  },
]);

test("p4 restore: default adalah dry-run dan tidak memodifikasi database", async () => {
  const { dumpPath, sha256 } = setupTestBackup();
  try {
    let pgRestoreExecuted = false;

    const mockExec = (cmd) => {
      if (cmd.includes("docker inspect")) return VALID_INSPECT_JSON;
      if (cmd.includes("SELECT current_database()")) return "flashsale_p3|f";
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n2; TABLE public products\n";
      if (cmd.includes("SELECT COUNT(*)::int FROM pg_stat_activity")) return "2";
      if (cmd.includes("pg_restore") && !cmd.includes("--list")) {
        pgRestoreExecuted = true;
        return "";
      }
      return "";
    };

    const res = await performRestore(
      {
        backupDir: TEST_RESTORE_DIR,
        file: dumpPath,
        execute: false, // DRY-RUN default
      },
      mockExec,
    );

    assert.equal(res.dryRun, true);
    assert.equal(res.status, "READY");
    assert.equal(res.sha256, sha256);
    assert.equal(res.targetDb, "flashsale_p3");
    assert.equal(res.activeConnections, 2);
    assert.equal(pgRestoreExecuted, false, "Pada mode dry-run, pg_restore aktual DILARANG dieksekusi!");
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: menolak restore jika checksum SHA-256 tidak cocok (file dump termodifikasi)", async () => {
  const { dumpPath } = setupTestBackup();
  try {
    fs.writeFileSync(`${dumpPath}.sha256`, "0000000000000000000000000000000000000000000000000000000000000000  file.dump\n", "utf8");

    const mockExec = () => VALID_INSPECT_JSON;

    await assert.rejects(
      () => performRestore({ backupDir: TEST_RESTORE_DIR, file: dumpPath, execute: false }, mockExec),
      /Checksum mismatch/,
    );
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: menolak jika container target memiliki identitas salah", async () => {
  const { dumpPath } = setupTestBackup();
  try {
    const mockWrongProject = (cmd) => {
      if (cmd.includes("docker inspect")) {
        return JSON.stringify([
          {
            State: { Running: true },
            Config: {
              Labels: {
                "com.docker.compose.project": "flashsale", // P2 project!
                "com.docker.compose.service": "db-primary",
                "flashsale.environment": "p3",
              },
            },
          },
        ]);
      }
      return "";
    };

    await assert.rejects(
      () => performRestore({ backupDir: TEST_RESTORE_DIR, file: dumpPath, execute: false }, mockWrongProject),
      /Project label mismatch/,
    );
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: menolak jika database target bukan flashsale_p3 (mencegah kontaminasi P2)", async () => {
  const { dumpPath } = setupTestBackup();
  try {
    const mockWrongDb = (cmd) => {
      if (cmd.includes("docker inspect")) return VALID_INSPECT_JSON;
      if (cmd.includes("SELECT current_database()")) return "flashsale|f"; // Database P2!
      return "";
    };

    await assert.rejects(
      () => performRestore({ backupDir: TEST_RESTORE_DIR, file: dumpPath, execute: false }, mockWrongDb),
      /Database mismatch/,
    );
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: menolak jika database target berada dalam mode standby recovery", async () => {
  const { dumpPath } = setupTestBackup();
  try {
    const mockStandby = (cmd) => {
      if (cmd.includes("docker inspect")) return VALID_INSPECT_JSON;
      if (cmd.includes("SELECT current_database()")) return "flashsale_p3|t"; // Standby!
      return "";
    };

    await assert.rejects(
      () => performRestore({ backupDir: TEST_RESTORE_DIR, file: dumpPath, execute: false }, mockStandby),
      /mode standby/,
    );
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: menolak restore jika query pemutusan koneksi aktif gagal", async () => {
  const { dumpPath } = setupTestBackup();
  try {
    const mockExecTermFail = (cmd) => {
      if (cmd.includes("docker inspect")) return VALID_INSPECT_JSON;
      if (cmd.includes("SELECT current_database()")) return "flashsale_p3|f";
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n";
      if (cmd.includes("SELECT COUNT(*)::int FROM pg_stat_activity")) return "1";
      if (cmd.includes("pg_terminate_backend")) {
        const err = new Error("permission denied to terminate backend");
        err.stderr = "ERROR: must be member of pg_signal_backend";
        throw err;
      }
      return "";
    };

    await assert.rejects(
      () => performRestore({ backupDir: TEST_RESTORE_DIR, file: dumpPath, execute: true }, mockExecTermFail),
      /Gagal memutus koneksi aktif database/,
    );
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: menolak restore jika masih terdapat koneksi aktif pasca-terminasi", async () => {
  const { dumpPath } = setupTestBackup();
  try {
    let termAttempted = false;
    const mockExecStillConnected = (cmd) => {
      if (cmd.includes("docker inspect")) return VALID_INSPECT_JSON;
      if (cmd.includes("SELECT current_database()")) return "flashsale_p3|f";
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n";
      if (cmd.includes("pg_terminate_backend")) {
        termAttempted = true;
        return "2";
      }
      if (cmd.includes("SELECT COUNT(*)::int FROM pg_stat_activity")) {
        // Pada recheck pasca-terminasi, masih ada 2 koneksi aktif (karena Express pool reconnect)
        return "2";
      }
      return "";
    };

    await assert.rejects(
      () => performRestore({ backupDir: TEST_RESTORE_DIR, file: dumpPath, execute: true }, mockExecStillConnected),
      /Masih terdapat 2 koneksi aktif/,
    );
    assert.equal(termAttempted, true);
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: menolak status SUCCESS jika query verifikasi pasca-restore gagal", async () => {
  const { dumpPath } = setupTestBackup();
  try {
    const mockExecVerifyFail = (cmd) => {
      if (cmd.includes("docker inspect")) return VALID_INSPECT_JSON;
      if (cmd.includes("SELECT current_database()")) return "flashsale_p3|f";
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n";
      if (cmd.includes("pg_terminate_backend")) return "1";
      if (cmd.includes("SELECT COUNT(*)::int FROM pg_stat_activity")) return "0";
      if (cmd.includes("pg_restore") && !cmd.includes("--list")) return "";
      if (cmd.includes("orders_count")) {
        // Query verifikasi gagal dieksekusi (database down atau error)
        const err = new Error("connection to server was lost");
        err.stderr = "FATAL: terminating connection due to administrator command";
        throw err;
      }
      return "";
    };

    await assert.rejects(
      () => performRestore({ backupDir: TEST_RESTORE_DIR, file: dumpPath, execute: true }, mockExecVerifyFail),
      /Verifikasi pasca-restore gagal: query verifikasi database error/,
    );

    // Pastikan tidak ada log RESTORE_SUCCESS tercatat
    const logPath = path.join(TEST_RESTORE_DIR, "restore.log");
    assert.equal(fs.existsSync(logPath), false, "RESTORE_SUCCESS tidak boleh dicatat jika verifikasi gagal");
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: menolak status SUCCESS jika query verifikasi mengembalikan respons kosong atau malformed", async () => {
  const { dumpPath } = setupTestBackup();
  try {
    // 1. Output kosong
    const mockExecEmpty = (cmd) => {
      if (cmd.includes("docker inspect")) return VALID_INSPECT_JSON;
      if (cmd.includes("SELECT current_database()")) return "flashsale_p3|f";
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n";
      if (cmd.includes("pg_terminate_backend")) return "1";
      if (cmd.includes("SELECT COUNT(*)::int FROM pg_stat_activity")) return "0";
      if (cmd.includes("pg_restore") && !cmd.includes("--list")) return "";
      if (cmd.includes("orders_count")) return ""; // Respons kosong!
      return "";
    };

    await assert.rejects(
      () => performRestore({ backupDir: TEST_RESTORE_DIR, file: dumpPath, execute: true }, mockExecEmpty),
      /respons query verifikasi kosong/,
    );

    // 2. Output malformed (bukan 3 kolom angka)
    const mockExecMalformed = (cmd) => {
      if (cmd.includes("docker inspect")) return VALID_INSPECT_JSON;
      if (cmd.includes("SELECT current_database()")) return "flashsale_p3|f";
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n";
      if (cmd.includes("pg_terminate_backend")) return "1";
      if (cmd.includes("SELECT COUNT(*)::int FROM pg_stat_activity")) return "0";
      if (cmd.includes("pg_restore") && !cmd.includes("--list")) return "";
      if (cmd.includes("orders_count")) return "97|NaN|foo"; // Nilai tidak valid!
      return "";
    };

    await assert.rejects(
      () => performRestore({ backupDir: TEST_RESTORE_DIR, file: dumpPath, execute: true }, mockExecMalformed),
      /nilai products_count tidak valid/,
    );
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: eksekusi dengan --execute menjalankan pg_restore dengan opsi lengkap dan verifikasi tabel valid", async () => {
  const { dumpPath, sha256 } = setupTestBackup();
  try {
    let terminatedCalled = false;
    let restoreCmdExecuted = "";

    const mockExec = (cmd) => {
      if (cmd.includes("docker inspect")) return VALID_INSPECT_JSON;
      if (cmd.includes("SELECT current_database()")) return "flashsale_p3|f";
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n2; TABLE public products\n";
      if (cmd.includes("pg_terminate_backend")) {
        terminatedCalled = true;
        return "2";
      }
      if (cmd.includes("SELECT COUNT(*)::int FROM pg_stat_activity")) {
        return "0"; // 0 koneksi aktif pasca-terminasi
      }
      if (cmd.includes("pg_restore") && !cmd.includes("--list")) {
        restoreCmdExecuted = cmd;
        return "";
      }
      if (cmd.includes("orders_count")) {
        return "97|3|5"; // 97 orders, 3 products, 5 users restored
      }
      return "";
    };

    const res = await performRestore(
      {
        backupDir: TEST_RESTORE_DIR,
        file: dumpPath,
        execute: true, // EKSEKUSI AKTUAL
      },
      mockExec,
    );

    assert.equal(res.dryRun, false);
    assert.equal(res.status, "SUCCESS");
    assert.equal(res.sha256, sha256);
    assert.equal(res.tableCounts.orders, 97);
    assert.equal(res.tableCounts.products, 3);
    assert.equal(res.tableCounts.users, 5);
    assert.equal(terminatedCalled, true, "Koneksi backend aktif harus diputus sebelum restore");

    // Periksa opsi pg_restore yang digunakan
    assert.ok(restoreCmdExecuted.includes("--clean"), "pg_restore wajib menyertakan --clean");
    assert.ok(restoreCmdExecuted.includes("--if-exists"), "pg_restore wajib menyertakan --if-exists");
    assert.ok(restoreCmdExecuted.includes("--no-owner"), "pg_restore wajib menyertakan --no-owner");
    assert.ok(restoreCmdExecuted.includes("--no-acl"), "pg_restore wajib menyertakan --no-acl");
    assert.ok(restoreCmdExecuted.includes("--exit-on-error"), "pg_restore wajib menyertakan --exit-on-error");

    // Pastikan log RESTORE_SUCCESS tercatat dengan benar
    const logPath = path.join(TEST_RESTORE_DIR, "restore.log");
    assert.ok(fs.existsSync(logPath));
    const logContent = fs.readFileSync(logPath, "utf8");
    assert.match(logContent, /RESTORE_SUCCESS/);
  } finally {
    cleanTestDir();
  }
});

// =========================================================================
// PENGUJIAN PERBAIKAN B — VALIDASI DATABASE CONNECTION COUNT & TERMINASI
// =========================================================================

test("p4 common: parseStrictNonNegativeInt memvalidasi integer non-negatif secara ketat (fail-closed)", () => {
  // Output 0 valid
  assert.equal(parseStrictNonNegativeInt("0"), 0);
  assert.equal(parseStrictNonNegativeInt(" 0 \n"), 0);

  // Output angka positif valid
  assert.equal(parseStrictNonNegativeInt("42"), 42);
  assert.equal(parseStrictNonNegativeInt(" 12345 "), 12345);

  // Output kosong ditolak
  assert.equal(parseStrictNonNegativeInt(""), null);
  assert.equal(parseStrictNonNegativeInt("   \n"), null);

  // Output "0invalid" ditolak
  assert.equal(parseStrictNonNegativeInt("0invalid"), null);
  assert.equal(parseStrictNonNegativeInt("10abc"), null);
  assert.equal(parseStrictNonNegativeInt("foo10"), null);

  // Output negatif ditolak
  assert.equal(parseStrictNonNegativeInt("-1"), null);
  assert.equal(parseStrictNonNegativeInt("-0"), null);

  // Output malformed ditolak
  assert.equal(parseStrictNonNegativeInt("NaN"), null);
  assert.equal(parseStrictNonNegativeInt("Infinity"), null);
  assert.equal(parseStrictNonNegativeInt("-Infinity"), null);
  assert.equal(parseStrictNonNegativeInt("1.5"), null);
  assert.equal(parseStrictNonNegativeInt(null), null);
  assert.equal(parseStrictNonNegativeInt(undefined), null);
  assert.equal(parseStrictNonNegativeInt("9007199254740992"), null); // Melampaui Number.MAX_SAFE_INTEGER
});

test("p4 common: getActiveConnectionCount menerapkan strict parsing dan menolak output tidak valid", () => {
  const mockValidZero = () => "0\n";
  const resZero = getActiveConnectionCount("test-c", "flashsale_p3", "p3_admin", mockValidZero);
  assert.equal(resZero.ok, true);
  assert.equal(resZero.count, 0);

  const mockValidPositive = () => " 7 \n";
  const resPositive = getActiveConnectionCount("test-c", "flashsale_p3", "p3_admin", mockValidPositive);
  assert.equal(resPositive.ok, true);
  assert.equal(resPositive.count, 7);

  const mockInvalid = () => "0invalid";
  const resInvalid = getActiveConnectionCount("test-c", "flashsale_p3", "p3_admin", mockInvalid);
  assert.equal(resInvalid.ok, false);
  assert.equal(resInvalid.count, null);
  assert.match(resInvalid.error, /bukan bilangan bulat non-negatif valid/);

  const mockFailQuery = () => {
    throw new Error("server closed connection");
  };
  const resFail = getActiveConnectionCount("test-c", "flashsale_p3", "p3_admin", mockFailQuery);
  assert.equal(resFail.ok, false);
  assert.equal(resFail.count, null);
});

test("p4 common: terminateActiveConnections hanya menghitung koneksi yang berhasil diputus dan menolak query gagal", () => {
  let executedSql = "";
  const mockExec = (cmd) => {
    executedSql = cmd;
    return "3\n"; // 3 koneksi berhasil diputus
  };

  const res = terminateActiveConnections("test-c", "flashsale_p3", "p3_admin", mockExec);
  assert.equal(res.ok, true);
  assert.equal(res.count, 3);
  // Verifikasi bahwa SQL hanya menghitung koneksi dengan terminated = true
  assert.ok(executedSql.includes("WHERE terminated = true"), "Query terminasi wajib memfilter terminated = true");

  // Query gagal DILARANG dianggap berhasil (tidak boleh count = 0 dengan ok = true)
  const mockFail = () => {
    const err = new Error("permission denied");
    throw err;
  };
  const resFail = terminateActiveConnections("test-c", "flashsale_p3", "p3_admin", mockFail);
  assert.equal(resFail.ok, false);
  assert.equal(resFail.count, null);
  assert.match(resFail.error, /Gagal menjalankan query pemutusan koneksi/);

  // Output 0invalid ditolak
  const mockMalformed = () => "0invalid";
  const resMalformed = terminateActiveConnections("test-c", "flashsale_p3", "p3_admin", mockMalformed);
  assert.equal(resMalformed.ok, false);
  assert.equal(resMalformed.count, null);
});

// =========================================================================
// PENGUJIAN PERBAIKAN C — PEMILIHAN BACKUP TERBARU YANG VALID
// =========================================================================

test("p4 restore: findLatestBackup memilih backup terbaru dengan checksum dan struktur TOC valid", () => {
  setupTestDir();
  try {
    // Buat 2 backup valid (timestamp 100000 dan 120000)
    const dumpOld = path.join(TEST_RESTORE_DIR, "flashsale_p3_20261108_100000.dump");
    const dumpNew = path.join(TEST_RESTORE_DIR, "flashsale_p3_20261108_120000.dump");
    fs.writeFileSync(dumpOld, "OLD_BACKUP_CONTENT", "utf8");
    fs.writeFileSync(dumpNew, "NEW_BACKUP_CONTENT", "utf8");

    const hashOld = crypto.createHash("sha256").update(Buffer.from("OLD_BACKUP_CONTENT")).digest("hex");
    const hashNew = crypto.createHash("sha256").update(Buffer.from("NEW_BACKUP_CONTENT")).digest("hex");
    fs.writeFileSync(`${dumpOld}.sha256`, `${hashOld}  flashsale_p3_20261108_100000.dump\n`, "utf8");
    fs.writeFileSync(`${dumpNew}.sha256`, `${hashNew}  flashsale_p3_20261108_120000.dump\n`, "utf8");

    const mockExec = (cmd) => {
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n2; TABLE public products\n";
      return "";
    };

    const latest = findLatestBackup(TEST_RESTORE_DIR, "test-container", mockExec);
    assert.equal(latest.ok, true);
    assert.equal(latest.file, "flashsale_p3_20261108_120000.dump");
    assert.equal(latest.sha256, hashNew);
    assert.equal(latest.skipped.length, 0);
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: backup terbaru tanpa checksum .sha256 dilewati dan backup sebelumnya yang valid dipilih", () => {
  setupTestDir();
  try {
    // Backup sebelumnya (valid)
    const dumpValid = path.join(TEST_RESTORE_DIR, "flashsale_p3_20261108_120000.dump");
    fs.writeFileSync(dumpValid, "VALID_CONTENT", "utf8");
    const hashValid = crypto.createHash("sha256").update(Buffer.from("VALID_CONTENT")).digest("hex");
    fs.writeFileSync(`${dumpValid}.sha256`, `${hashValid}  flashsale_p3_20261108_120000.dump\n`, "utf8");

    // Backup terbaru (korup/terhenti: TIDAK ADA file .sha256)
    const dumpNewNoSha = path.join(TEST_RESTORE_DIR, "flashsale_p3_20261108_130000.dump");
    fs.writeFileSync(dumpNewNoSha, "INCOMPLETE_DUMP_WITHOUT_CHECKSUM", "utf8");

    const mockExec = (cmd) => {
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n";
      return "";
    };

    const latest = findLatestBackup(TEST_RESTORE_DIR, "test-container", mockExec);
    assert.equal(latest.ok, true);
    assert.equal(latest.file, "flashsale_p3_20261108_120000.dump", "Backup tanpa checksum harus dilewati dan beralih ke backup valid sebelumnya");
    assert.equal(latest.skipped.length, 1);
    assert.equal(latest.skipped[0].file, "flashsale_p3_20261108_130000.dump");
    assert.match(latest.skipped[0].reason, /File checksum .sha256 tidak ditemukan/);
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: backup terbaru dengan checksum mismatch dilewati dan backup sebelumnya yang valid dipilih", () => {
  setupTestDir();
  try {
    // Backup sebelumnya (valid)
    const dumpValid = path.join(TEST_RESTORE_DIR, "flashsale_p3_20261108_120000.dump");
    fs.writeFileSync(dumpValid, "VALID_CONTENT", "utf8");
    const hashValid = crypto.createHash("sha256").update(Buffer.from("VALID_CONTENT")).digest("hex");
    fs.writeFileSync(`${dumpValid}.sha256`, `${hashValid}  flashsale_p3_20261108_120000.dump\n`, "utf8");

    // Backup terbaru dengan checksum palsu/mismatch
    const dumpNewBadSha = path.join(TEST_RESTORE_DIR, "flashsale_p3_20261108_140000.dump");
    fs.writeFileSync(dumpNewBadSha, "ALTERED_CONTENT", "utf8");
    fs.writeFileSync(`${dumpNewBadSha}.sha256`, "0000000000000000000000000000000000000000000000000000000000000000  bad.dump\n", "utf8");

    const mockExec = (cmd) => {
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n";
      return "";
    };

    const latest = findLatestBackup(TEST_RESTORE_DIR, "test-container", mockExec);
    assert.equal(latest.ok, true);
    assert.equal(latest.file, "flashsale_p3_20261108_120000.dump");
    assert.equal(latest.skipped.length, 1);
    assert.match(latest.skipped[0].reason, /Checksum mismatch/);
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: backup terbaru dengan arsip korup (TOC gagal) dilewati dan backup sebelumnya yang valid dipilih", () => {
  setupTestDir();
  try {
    // Backup sebelumnya (valid)
    const dumpValid = path.join(TEST_RESTORE_DIR, "flashsale_p3_20261108_120000.dump");
    fs.writeFileSync(dumpValid, "VALID_CONTENT", "utf8");
    const hashValid = crypto.createHash("sha256").update(Buffer.from("VALID_CONTENT")).digest("hex");
    fs.writeFileSync(`${dumpValid}.sha256`, `${hashValid}  flashsale_p3_20261108_120000.dump\n`, "utf8");

    // Backup terbaru memiliki checksum valid tetapi arsip korup saat dieksekusi pg_restore --list
    const dumpCorruptTOC = path.join(TEST_RESTORE_DIR, "flashsale_p3_20261108_150000.dump");
    fs.writeFileSync(dumpCorruptTOC, "CORRUPT_TOC_CONTENT", "utf8");
    const hashCorrupt = crypto.createHash("sha256").update(Buffer.from("CORRUPT_TOC_CONTENT")).digest("hex");
    fs.writeFileSync(`${dumpCorruptTOC}.sha256`, `${hashCorrupt}  flashsale_p3_20261108_150000.dump\n`, "utf8");

    let cpCorrupt = false;
    const mockExec = (cmd) => {
      if (cmd.includes("docker cp") && cmd.includes("150000")) {
        cpCorrupt = true;
        return "";
      }
      if (cmd.includes("docker cp") && cmd.includes("120000")) {
        cpCorrupt = false;
        return "";
      }
      if (cmd.includes("pg_restore --list")) {
        if (cpCorrupt) {
          const err = new Error("corrupt archive header");
          err.stderr = "pg_restore: error: did not find magic header";
          throw err;
        }
        return "1; TABLE public orders\n";
      }
      return "";
    };

    const latest = findLatestBackup(TEST_RESTORE_DIR, "test-container", mockExec);
    assert.equal(latest.ok, true);
    assert.equal(latest.file, "flashsale_p3_20261108_120000.dump");
    assert.equal(latest.skipped.length, 1);
    assert.match(latest.skipped[0].reason, /pg_restore --list gagal memvalidasi arsip/);
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: jika seluruh backup tidak valid, pencarian berhenti dengan pesan error yang jelas", async () => {
  setupTestDir();
  try {
    // Hanya ada file tanpa checksum
    const dumpBad = path.join(TEST_RESTORE_DIR, "flashsale_p3_20261108_160000.dump");
    fs.writeFileSync(dumpBad, "ORPHAN_DUMP", "utf8");

    const mockExec = () => VALID_INSPECT_JSON;

    const latest = findLatestBackup(TEST_RESTORE_DIR, "test-container", mockExec);
    assert.equal(latest.ok, false);
    assert.match(latest.error, /Tidak ditemukan backup yang valid/);

    // performRestore otomatis gagal fail-closed jika backup otomatis tidak menemukan file valid
    const mockExecRestore = (cmd) => {
      if (cmd.includes("docker inspect")) return VALID_INSPECT_JSON;
      if (cmd.includes("SELECT current_database()")) return "flashsale_p3|f";
      return "";
    };

    await assert.rejects(
      () => performRestore({ backupDir: TEST_RESTORE_DIR, execute: false }, mockExecRestore),
      /Gagal memilih backup: Tidak ditemukan backup yang valid/,
    );
  } finally {
    cleanTestDir();
  }
});

test("p4 restore: seluruh file backup lama terlindungi dan tidak dihapus selama proses pencarian validitas", () => {
  setupTestDir();
  try {
    const dump1 = path.join(TEST_RESTORE_DIR, "flashsale_p3_20261108_110000.dump");
    const dump2 = path.join(TEST_RESTORE_DIR, "flashsale_p3_20261108_120000.dump");
    fs.writeFileSync(dump1, "CONTENT_1", "utf8");
    fs.writeFileSync(dump2, "CONTENT_2", "utf8");

    // dump2 tidak memiliki sha256 (akan di-skip)
    // dump1 memiliki sha256
    const hash1 = crypto.createHash("sha256").update(Buffer.from("CONTENT_1")).digest("hex");
    fs.writeFileSync(`${dump1}.sha256`, `${hash1}  flashsale_p3_20261108_110000.dump\n`, "utf8");

    const mockExec = (cmd) => {
      if (cmd.includes("pg_restore --list")) return "1; TABLE public orders\n";
      return "";
    };

    findLatestBackup(TEST_RESTORE_DIR, "test-container", mockExec);

    // Pastikan kedua file dump dan checksum tetap ada di disk (tidak ada yang dihapus)
    assert.ok(fs.existsSync(dump1), "Dump 1 harus tetap ada");
    assert.ok(fs.existsSync(dump2), "Dump 2 (yang dilewati) DILARANG dihapus!");
    assert.ok(fs.existsSync(`${dump1}.sha256`), "Checksum file harus tetap ada");
  } finally {
    cleanTestDir();
  }
});

function setupTestDir() {
  if (fs.existsSync(TEST_RESTORE_DIR)) {
    fs.rmSync(TEST_RESTORE_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_RESTORE_DIR, { recursive: true });
}
