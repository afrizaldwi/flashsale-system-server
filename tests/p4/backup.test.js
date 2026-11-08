"use strict";
/**
 * tests/p4/backup.test.js
 * Unit Test Suite untuk Modul Backup Automation P4 (flashsale_p3)
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performBackup } = require("../../scripts/p4/backup");
const { inspectContainerIdentity, verifyDatabaseRole } = require("../../scripts/p4/common");

const TEST_BACKUP_DIR = path.resolve(__dirname, "../../tmp-test-backup");

function setupTestDir() {
  if (fs.existsSync(TEST_BACKUP_DIR)) {
    fs.rmSync(TEST_BACKUP_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_BACKUP_DIR, { recursive: true });
}

function cleanTestDir() {
  if (fs.existsSync(TEST_BACKUP_DIR)) {
    fs.rmSync(TEST_BACKUP_DIR, { recursive: true, force: true });
  }
}

// Mock inspect payload yang valid
const VALID_INSPECT_JSON = JSON.stringify([
  {
    Id: "abcdef1234567890",
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

test("p4 backup: validasi identitas container menolak project / service / env yang salah", () => {
  // 1. Container tidak berjalan
  const mockStopped = () =>
    JSON.stringify([
      {
        State: { Status: "exited", Running: false },
        Config: { Labels: { "com.docker.compose.project": "flashsale-p3" } },
      },
    ]);
  const resStopped = inspectContainerIdentity("flashsale-p3-db-primary-1", undefined, mockStopped);
  assert.equal(resStopped.ok, false);
  assert.match(resStopped.error, /tidak sedang berjalan/);

  // 2. Project label salah (misal stack p2)
  const mockWrongProject = () =>
    JSON.stringify([
      {
        State: { Running: true },
        Config: {
          Labels: {
            "com.docker.compose.project": "flashsale", // p2 project!
            "com.docker.compose.service": "db-primary",
            "flashsale.environment": "p3",
          },
        },
      },
    ]);
  const resWrongProject = inspectContainerIdentity("flashsale-p3-db-primary-1", undefined, mockWrongProject);
  assert.equal(resWrongProject.ok, false);
  assert.match(resWrongProject.error, /Project label mismatch/);

  // 3. Service label salah
  const mockWrongService = () =>
    JSON.stringify([
      {
        State: { Running: true },
        Config: {
          Labels: {
            "com.docker.compose.project": "flashsale-p3",
            "com.docker.compose.service": "backend", // bukan db-primary!
            "flashsale.environment": "p3",
          },
        },
      },
    ]);
  const resWrongService = inspectContainerIdentity("flashsale-p3-db-primary-1", undefined, mockWrongService);
  assert.equal(resWrongService.ok, false);
  assert.match(resWrongService.error, /Service label mismatch/);
});

test("p4 backup: validasi database menolak database selain flashsale_p3 dan menolak standby", () => {
  // 1. Database name mismatch (misal flashsale P2)
  const mockWrongDb = () => "flashsale|f";
  const resWrongDb = verifyDatabaseRole("flashsale-p3-db-primary-1", "flashsale_p3", "p3_admin", mockWrongDb);
  assert.equal(resWrongDb.ok, false);
  assert.match(resWrongDb.error, /Database mismatch/);

  // 2. Database berada dalam recovery/standby mode (in_recovery=t)
  const mockStandby = () => "flashsale_p3|t";
  const resStandby = verifyDatabaseRole("flashsale-p3-db-primary-1", "flashsale_p3", "p3_admin", mockStandby);
  assert.equal(resStandby.ok, false);
  assert.match(resStandby.error, /mode standby/);

  // 3. Database valid writer
  const mockValid = () => "flashsale_p3|f";
  const resValid = verifyDatabaseRole("flashsale-p3-db-primary-1", "flashsale_p3", "p3_admin", mockValid);
  assert.equal(resValid.ok, true);
  assert.equal(resValid.inRecovery, false);
});

test("p4 backup: backup berhasil membuat file dump, checksum sha256 valid, dan metadata", async () => {
  setupTestDir();
  try {
    const mockExec = (cmd) => {
      if (cmd.includes("docker inspect")) {
        return VALID_INSPECT_JSON;
      }
      if (cmd.includes("SELECT current_database()")) {
        return "flashsale_p3|f";
      }
      if (cmd.includes("pg_dump")) {
        return ""; // pg_dump sukses
      }
      if (cmd.includes("docker cp") && cmd.includes(".tmp")) {
        // Simulasi copy dump file ke host
        const match = cmd.match(/"([^"]+\.tmp)"/);
        if (match) {
          fs.writeFileSync(match[1], "DUMMY_PG_DUMP_CUSTOM_FORMAT_CONTENT", "utf8");
        }
        return "";
      }
      if (cmd.includes("pg_restore --list")) {
        return "; Archive created at 2026-11-08\n; TOC Entries: 32\n1; 1259 16412 TABLE public orders\n2; 1259 16402 TABLE public products\n";
      }
      return "";
    };

    const meta = await performBackup(
      {
        backupDir: TEST_BACKUP_DIR,
      },
      mockExec,
    );

    assert.equal(meta.database, "flashsale_p3");
    assert.equal(meta.status, "VALIDATED");
    assert.equal(meta.tocEntries, 2);
    assert.ok(meta.sha256 && meta.sha256.length === 64);
    assert.ok(fs.existsSync(meta.filePath), "File final dump harus ada");
    assert.ok(fs.existsSync(`${meta.filePath}.sha256`), "File .sha256 harus ada");
    assert.ok(fs.existsSync(`${meta.filePath}.meta.json`), "File .meta.json harus ada");

    // Pastikan file temporary .tmp sudah tidak ada (berganti menjadi .dump)
    const tmpFiles = fs.readdirSync(TEST_BACKUP_DIR).filter((f) => f.endsWith(".tmp"));
    assert.equal(tmpFiles.length, 0, "File temporary harus sudah dibersihkan/direname");
  } finally {
    cleanTestDir();
  }
});
test("p4 backup: backup gagal mempertahankan backup sebelumnya dan membersihkan file temporary", async () => {
  setupTestDir();
  try {
    // 1. Buat backup sebelumnya yang sudah valid
    const existingDump = path.join(TEST_BACKUP_DIR, "flashsale_p3_20261108_010000.dump");
    const existingSha = `${existingDump}.sha256`;
    fs.writeFileSync(existingDump, "PREVIOUS_VALID_BACKUP_DATA", "utf8");
    fs.writeFileSync(existingSha, "abcdef123456  flashsale_p3_20261108_010000.dump\n", "utf8");

    // 2. Jalankan backup baru tetapi pg_dump mengalami crash / gagal
    const mockExecFail = (cmd) => {
      if (cmd.includes("docker inspect")) return VALID_INSPECT_JSON;
      if (cmd.includes("SELECT current_database()")) return "flashsale_p3|f";
      if (cmd.includes("pg_dump")) {
        const err = new Error("pg_dump: error: disk full or connection terminated");
        err.stderr = "pg_dump: error: server closed the connection unexpectedly";
        throw err;
      }
      return "";
    };

    await assert.rejects(
      () => performBackup({ backupDir: TEST_BACKUP_DIR }, mockExecFail),
      /pg_dump gagal/,
    );

    // 3. Verifikasi: Backup sebelumnya tetap ADA dan TIDAK terhapus!
    assert.ok(fs.existsSync(existingDump), "Backup sebelumnya wajib tetap ada");
    assert.ok(fs.existsSync(existingSha), "Checksum backup sebelumnya wajib tetap ada");

    // 4. Verifikasi: Tidak ada sisa file .tmp yang tertinggal
    const tmpFiles = fs.readdirSync(TEST_BACKUP_DIR).filter((f) => f.endsWith(".tmp"));
    assert.equal(tmpFiles.length, 0, "File temporary harus dibersihkan saat error");
  } finally {
    cleanTestDir();
  }
});
test("p4 backup: arsip korup ditolak oleh pg_restore --list dan tidak disimpan sebagai backup final", async () => {
  setupTestDir();
  try {
    const mockExecCorrupt = (cmd) => {
      if (cmd.includes("docker inspect")) return VALID_INSPECT_JSON;
      if (cmd.includes("SELECT current_database()")) return "flashsale_p3|f";
      if (cmd.includes("pg_dump")) return "";
      if (cmd.includes("docker cp") && cmd.includes(".tmp")) {
        const match = cmd.match(/"([^"]+\.tmp)"/);
        if (match) fs.writeFileSync(match[1], "CORRUPTED_TRUNCATED_BINARY", "utf8");
        return "";
      }
      if (cmd.includes("pg_restore --list")) {
        const err = new Error("pg_restore: error: input file appears to be corrupt or not a valid archive");
        err.stderr = "pg_restore: error: did not find magic number in archive header";
        throw err;
      }
      return "";
    };

    await assert.rejects(
      () => performBackup({ backupDir: TEST_BACKUP_DIR }, mockExecCorrupt),
      /Validasi integritas arsip dump gagal/,
    );

    // Tidak ada file .dump final yang disimpan
    const dumpFiles = fs.readdirSync(TEST_BACKUP_DIR).filter((f) => f.endsWith(".dump"));
    assert.equal(dumpFiles.length, 0, "Arsip korup dilarang disimpan sebagai file .dump final");
  } finally {
    cleanTestDir();
  }
});
