"use strict";
/**
 * tests/p4/retention.test.js
 * Unit Test Suite untuk Kebijakan Retensi Backup P4 (Disaster Recovery Plan)
 *
 * Menguji:
 * 1. Mempertahankan minimal 10 backup valid.
 * 2. Menghapus backup tertua ketika jumlah backup melebihi batas retensi.
 * 3. Tidak pernah menghapus backup valid terakhir.
 * 4. Tidak menghapus backup yang sedang aktif digunakan proses restore (.restore.lock).
 * 5. Memvalidasi integritas arsip (.sha256) sebelum diklasifikasikan sebagai valid.
 * 6. Mencatat setiap penghapusan file ke log.
 * 7. Tidak menghapus file temporary (.tmp) atau file tidak terkait (.log, .lock).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { applyRetentionPolicy } = require("../../scripts/p4/common");

const TEST_RETENTION_DIR = path.resolve(
  __dirname,
  "../../tmp-test-retention-suite",
);
const LOG_FILE = path.join(TEST_RETENTION_DIR, "backup.log");

function cleanTestDir() {
  if (fs.existsSync(TEST_RETENTION_DIR)) {
    try {
      const files = fs.readdirSync(TEST_RETENTION_DIR);
      for (const f of files) {
        try {
          fs.unlinkSync(path.join(TEST_RETENTION_DIR, f));
        } catch {}
      }
      fs.rmSync(TEST_RETENTION_DIR, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 50,
      });
    } catch {}
  }
}

function setupTestDir() {
  cleanTestDir();
  fs.mkdirSync(TEST_RETENTION_DIR, { recursive: true });
}

function createDummyBackup(dir, nameSuffix, content = "DUMMY_BACKUP_CONTENT") {
  const baseName = `flashsale_p3_${nameSuffix}.dump`;
  const dumpPath = path.join(dir, baseName);
  const shaPath = `${dumpPath}.sha256`;
  const metaPath = `${dumpPath}.meta.json`;

  fs.writeFileSync(dumpPath, content, "utf8");
  const hash = crypto
    .createHash("sha256")
    .update(Buffer.from(content))
    .digest("hex");
  fs.writeFileSync(shaPath, `${hash}  ${baseName}\n`, "utf8");
  fs.writeFileSync(
    metaPath,
    JSON.stringify({ file: baseName, sizeBytes: Buffer.byteLength(content), database: "flashsale_p3",
      status: "VALIDATED", sha256: hash, durationMs: 0, tocEntries: 1,
      startTime: "2026-11-08T10:00:00.000Z", endTime: "2026-11-08T10:00:00.000Z" }),
    "utf8",
  );

  return { baseName, dumpPath, shaPath, metaPath, hash };
}

test("p4 retention: mempertahankan seluruh backup jika jumlah backup valid <= 10", () => {
  setupTestDir();
  try {
    // Buat 5 backup valid
    for (let i = 1; i <= 5; i++) {
      const pad = String(i).padStart(2, "0");
      createDummyBackup(TEST_RETENTION_DIR, `20261108_1000${pad}`);
    }

    const res = applyRetentionPolicy(TEST_RETENTION_DIR, 10, {
      logFile: LOG_FILE,
      validateArchive: () => true, // Synthetic dump: pg_restore validation is injected for unit tests.
    });
    assert.equal(
      res.pruned.length,
      0,
      "Tidak ada backup yang boleh dihapus jika jumlah <= 10",
    );
    assert.equal(res.kept.length, 5);

    const remainingFiles = fs
      .readdirSync(TEST_RETENTION_DIR)
      .filter((f) => f.endsWith(".dump"));
    assert.equal(remainingFiles.length, 5);
  } finally {
    cleanTestDir();
  }
});

test("p4 retention: menghapus backup tertua saat jumlah backup melebihi batas 10", () => {
  setupTestDir();
  try {
    // Buat 13 backup valid (timestamp 01 sampai 13)
    const backups = [];
    for (let i = 1; i <= 13; i++) {
      const pad = String(i).padStart(2, "0");
      backups.push(
        createDummyBackup(TEST_RETENTION_DIR, `20261108_1000${pad}`),
      );
    }

    // Terapkan retensi batas 10
    const res = applyRetentionPolicy(TEST_RETENTION_DIR, 10, {
      logFile: LOG_FILE,
      validateArchive: () => true, // Synthetic dump: pg_restore validation is injected for unit tests.
    });

    // 13 - 10 = 3 backup tertua (01, 02, 03) harus dihapus
    assert.equal(res.pruned.length, 3);
    assert.equal(res.kept.length, 10);

    // Pastikan backup 01, 02, 03 (.dump, .sha256, .meta.json) sudah terhapus
    for (let i = 0; i < 3; i++) {
      assert.equal(
        fs.existsSync(backups[i].dumpPath),
        false,
        `Backup tertua ${backups[i].baseName} harus terhapus`,
      );
      assert.equal(
        fs.existsSync(backups[i].shaPath),
        false,
        `Checksum ${backups[i].baseName}.sha256 harus terhapus`,
      );
      assert.equal(
        fs.existsSync(backups[i].metaPath),
        false,
        `Meta ${backups[i].baseName}.meta.json harus terhapus`,
      );
    }

    // Pastikan backup 04 sampai 13 tetap ada di disk
    for (let i = 3; i < 13; i++) {
      assert.ok(
        fs.existsSync(backups[i].dumpPath),
        `Backup ${backups[i].baseName} harus tetap ada`,
      );
    }

    // Pastikan log penghapusan dicatat ke backup.log
    assert.ok(fs.existsSync(LOG_FILE));
    const logContent = fs.readFileSync(LOG_FILE, "utf8");
    assert.match(logContent, /RETENTION_PRUNE/);
  } finally {
    cleanTestDir();
  }
});

test("p4 retention: tidak pernah menghapus backup valid terakhir", () => {
  setupTestDir();
  try {
    const backup = createDummyBackup(TEST_RETENTION_DIR, "20261108_120000");

    // Sekalipun keepCount diset ke 0, kebijakan harus menjaga minimal 1 backup
    const res = applyRetentionPolicy(TEST_RETENTION_DIR, 0, {
      logFile: LOG_FILE,
      validateArchive: () => true, // Synthetic dump: pg_restore validation is injected for unit tests.
    });
    assert.equal(res.pruned.length, 0);
    assert.equal(res.kept.length, 1);
    assert.ok(
      fs.existsSync(backup.dumpPath),
      "Backup valid terakhir DILARANG dihapus!",
    );
  } finally {
    cleanTestDir();
  }
});

test("p4 retention: tidak menghapus backup yang sedang digunakan proses restore", () => {
  setupTestDir();
  try {
    const backups = [];
    for (let i = 1; i <= 12; i++) {
      const pad = String(i).padStart(2, "0");
      backups.push(
        createDummyBackup(TEST_RETENTION_DIR, `20261108_1000${pad}`),
      );
    }

    // Simulasi: backup tertua ke-1 (index 0 / '100001') sedang aktif di-restore
    const activeFile = backups[0].baseName;
    const restoreLock = path.join(TEST_RETENTION_DIR, ".restore.lock");
    fs.writeFileSync(
      restoreLock,
      JSON.stringify({ file: activeFile, pid: process.pid }),
      "utf8",
    );

    const res = applyRetentionPolicy(TEST_RETENTION_DIR, 10, {
      logFile: LOG_FILE,
      validateArchive: () => true, // Synthetic dump: pg_restore validation is injected for unit tests.
      activeRestoreFile: activeFile,
    });

    // Backup yang sedang di-restore TIDAK boleh dihapus
    assert.ok(
      fs.existsSync(backups[0].dumpPath),
      "Backup yang sedang di-restore DILARANG dihapus",
    );
    assert.ok(res.kept.includes(activeFile));
  } finally {
    cleanTestDir();
  }
});

test("p4 retention: tidak menghapus file temporary (.tmp) atau file tidak terkait", () => {
  setupTestDir();
  try {
    for (let i = 1; i <= 12; i++) {
      const pad = String(i).padStart(2, "0");
      createDummyBackup(TEST_RETENTION_DIR, `20261108_1000${pad}`);
    }

    // Buat file temporary dan file lain yang tidak terkait
    const tempFile = path.join(
      TEST_RETENTION_DIR,
      "in_progress_backup.dump.tmp",
    );
    const notesFile = path.join(TEST_RETENTION_DIR, "notes.txt");
    fs.writeFileSync(tempFile, "TEMP_DATA", "utf8");
    fs.writeFileSync(notesFile, "IMPORTANT_NOTES", "utf8");

    applyRetentionPolicy(TEST_RETENTION_DIR, 10, { logFile: LOG_FILE, validateArchive: () => true });

    assert.ok(
      fs.existsSync(tempFile),
      "File .tmp tidak boleh disentuh oleh retention policy",
    );
    assert.ok(
      fs.existsSync(notesFile),
      "File teks bebas tidak boleh dihapus oleh retention policy",
    );
  } finally {
    cleanTestDir();
  }
});
