"use strict";
/**
 * tests/p4/loop.test.js
 * Unit Test Suite untuk Atomic Lock File & Backup Loop P4
 *
 * Menguji kepemilikan atomic lock, penolakan proses ganda, retensi lock selama
 * menunggu interval, pelepasan lock pada shutdown, dan pencegahan eksekusi paralel.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { acquireLock, releaseLock, startBackupLoop } = require("../../scripts/p4/backup-loop");

const TEST_DIR = path.resolve(__dirname, "../../tmp-test-loop");
const LOCK_FILE = path.join(TEST_DIR, ".backup.lock");
test("p4 loop: same-PID replacement token cannot be released by the previous owner", () => {
  setupTestDir();
  try {
    const lease = acquireLock(LOCK_FILE);
    assert.equal(lease.acquired, true);
    fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, token: "replacement-owner" }));
    assert.equal(releaseLock(LOCK_FILE), false);
    assert.equal(JSON.parse(fs.readFileSync(LOCK_FILE, "utf8")).token, "replacement-owner");
  } finally { cleanTestDir(); }
});

function setupTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
}

function cleanTestDir() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

test("p4 loop: acquireLock secara atomik berhasil untuk proses pertama dan menolak proses kedua (EEXIST)", () => {
  setupTestDir();
  try {
    const pid1 = 1111;
    const pid2 = 2222;

    // 1. Proses 1 mencoba mendapatkan lock
    const res1 = acquireLock(LOCK_FILE, pid1);
    assert.equal(res1.acquired, true);
    assert.equal(res1.ownerPid, pid1);
    assert.ok(fs.existsSync(LOCK_FILE));

    // Isi file harus valid JSON dengan pid 1111
    const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    assert.equal(lockData.pid, pid1);

    // 2. Proses 2 mencoba mendapatkan lock yang sama secara bersamaan -> WAJIB DITOLAK
    const res2 = acquireLock(LOCK_FILE, pid2);
    assert.equal(res2.acquired, false);
    assert.equal(res2.ownerPid, pid1);
    assert.match(res2.error, /Lock sedang dikuasai oleh proses PID 1111/);
  } finally {
    cleanTestDir();
  }
});

test("p4 loop: releaseLock hanya menghapus lock jika PID pemilik cocok dan menolak proses asing", () => {
  setupTestDir();
  try {
    const ownerPid = 5555;
    const strangerPid = 9999;

    acquireLock(LOCK_FILE, ownerPid);
    assert.ok(fs.existsSync(LOCK_FILE));

    // 1. Proses asing mencoba merilis lock -> DITOLAK, file lock tetap ada
    const releasedByStranger = releaseLock(LOCK_FILE, strangerPid);
    assert.equal(releasedByStranger, false);
    assert.ok(fs.existsSync(LOCK_FILE), "Lock file dilarang dihapus oleh proses non-pemilik");

    // 2. Proses pemilik merilis lock -> BERHASIL, file lock terhapus
    const releasedByOwner = releaseLock(LOCK_FILE, ownerPid);
    assert.equal(releasedByOwner, true);
    assert.equal(fs.existsSync(LOCK_FILE), false, "Lock file harus terhapus oleh proses pemilik");
  } finally {
    cleanTestDir();
  }
});

test("p4 loop: startBackupLoop menolak proses kedua jika lock sudah aktif di awal", async () => {
  setupTestDir();
  try {
    const externalPid = 7777;
    acquireLock(LOCK_FILE, externalPid);

    let backupExecuted = false;
    const mockBackupOptions = {
      backupDir: TEST_DIR,
      intervalSeconds: 1,
      maxIterations: 1,
      pid: 8888,
      backupFn: async () => {
        backupExecuted = true;
        return { endTime: new Date().toISOString(), file: "mock.dump", sizeBytes: 100, durationMs: 10 };
      },
    };

    const count = await startBackupLoop(mockBackupOptions);
    assert.equal(count, 0, "Loop harus mengembalikan 0 iterasi jika lock gagal didapat");
    assert.equal(backupExecuted, false, "Backup dilarang dieksekusi jika lock gagal didapat");

    // Lock file masih tetap ada dan tetap milik PID 7777
    assert.ok(fs.existsSync(LOCK_FILE));
    const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, "utf8"));
    assert.equal(lockData.pid, externalPid);
  } finally {
    cleanTestDir();
  }
});

test("p4 loop: lock dipertahankan selama loop berjalan (termasuk saat menunggu interval) dan dilepas saat loop selesai", async () => {
  setupTestDir();
  try {
    const loopPid = 3333;
    let lockExistedDuringIntervalWait = false;
    let iterationsRun = 0;

    const mockBackupOptions = {
      backupDir: TEST_DIR,
      intervalSeconds: 1,
      maxIterations: 2,
      pid: loopPid,
      backupFn: async () => {
        iterationsRun++;
        return { endTime: new Date().toISOString(), file: `mock_${iterationsRun}.dump`, sizeBytes: 100, durationMs: 5 };
      },
      onIterationWait: ({ iterations, lockFile, myPid }) => {
        // Cek bahwa lock file benar-benar ada dan dimiliki oleh loopPid saat menunggu interval
        if (fs.existsSync(lockFile)) {
          const content = JSON.parse(fs.readFileSync(lockFile, "utf8"));
          if (content.pid === myPid) {
            lockExistedDuringIntervalWait = true;
          }
        }
      },
    };

    // Jalankan loop dengan 2 iterasi
    const finishedCount = await startBackupLoop(mockBackupOptions);

    assert.equal(finishedCount, 2);
    assert.equal(iterationsRun, 2);
    assert.equal(lockExistedDuringIntervalWait, true, "Lock WAJIB tetap ada selama jeda menunggu interval");

    // Setelah loop berhenti secara normal, lock file WAJIB terhapus
    assert.equal(fs.existsSync(LOCK_FILE), false, "Lock file harus dilepaskan setelah loop selesai");
  } finally {
    cleanTestDir();
  }
});

test("p4 loop: proses kedua ditolak saat proses pertama sedang tidur menunggu interval (mencegah eksekusi paralel)", async () => {
  setupTestDir();
  try {
    const pid1 = 4441;
    const pid2 = 4442;
    let pid2ExecutionAttempted = false;
    let pid2Result = null;

    const proc1Options = {
      backupDir: TEST_DIR,
      intervalSeconds: 2,
      maxIterations: 2,
      pid: pid1,
      backupFn: async () => {
        return { endTime: new Date().toISOString(), file: "proc1.dump", sizeBytes: 100, durationMs: 10 };
      },
      onIterationWait: async ({ lockFile }) => {
        // Pada saat proses 1 sedang menunggu interval ke-2, proses 2 mencoba berjalan
        const proc2Options = {
          backupDir: TEST_DIR,
          intervalSeconds: 1,
          maxIterations: 1,
          pid: pid2,
          backupFn: async () => {
            pid2ExecutionAttempted = true;
            return { endTime: new Date().toISOString(), file: "proc2.dump", sizeBytes: 100, durationMs: 10 };
          },
        };
        pid2Result = await startBackupLoop(proc2Options);
      },
    };

    await startBackupLoop(proc1Options);

    assert.equal(pid2Result, 0, "Proses 2 harus ditolak (0 iterasi) karena proses 1 memegang lock");
    assert.equal(pid2ExecutionAttempted, false, "Proses 2 DILARANG menjalankan backup paralel!");
    assert.equal(fs.existsSync(LOCK_FILE), false, "Lock dibersihkan setelah proses 1 selesai");
  } finally {
    cleanTestDir();
  }
});
