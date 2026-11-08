"use strict";
/**
 * scripts/p4/backup-loop.js
 * PostgreSQL Periodic Backup Loop untuk Stack P3 (flashsale_p3)
 *
 * Standar Keandalan DRP Kelompok 1:
 * - Interval default 60 detik (target DRP, bukan jaminan RPO).
 * - Pembuatan lock file secara atomik eksklusif (flag: "wx" / O_CREAT | O_EXCL).
 * - Mencegah eksekusi backup paralel / race condition antar-proses.
 * - Lock hanya boleh dirilis oleh pemilik lease dengan PID dan token yang cocok.
 * - Perhitungan sisa interval dinamis berdasarkan durasi eksekusi backup.
 * - Penanganan penghentian proses secara anggun (SIGINT / SIGTERM).
 * - Kegagalan backup tidak pernah menghapus backup yang sudah ada.
 */

const fs = require("node:fs");
const path = require("node:path");
const { P3_CONFIG } = require("./common");
const { performBackup } = require("./backup");

/**
 * Memperoleh lock file secara atomik menggunakan exclusive creation flag "wx".
 * Jika file sudah ada, melempar EEXIST dan mengembalikan { acquired: false }.
 */
const { acquireOwnedLock } = require("./locks");
const ownedLoopLocks = new Map();
function acquireLock(lockFile, myPid = process.pid) {
  const key = `${path.resolve(lockFile)}:${myPid}`;
  try {
    const lease = acquireOwnedLock(lockFile, { operation: "backup-loop" }, myPid);
    ownedLoopLocks.set(key, lease);
    return { acquired: true, ownerPid: myPid, token: lease.token, error: null };
  } catch (error) {
    let existingPid = null;
    try { existingPid = JSON.parse(fs.readFileSync(lockFile, "utf8")).pid; } catch {}
    return { acquired: false, ownerPid: existingPid,
      error: `Lock sedang dikuasai oleh proses PID ${existingPid || "unknown"}: ${error.message}` };
  }
}
function releaseLock(lockFile, myPid = process.pid) {
  const key = `${path.resolve(lockFile)}:${myPid}`;
  const lease = ownedLoopLocks.get(key);
  if (!lease) return false;
  ownedLoopLocks.delete(key);
  return lease.release();
}
async function startBackupLoop(options = {}) {
  const intervalSeconds = Number(
    options.intervalSeconds || process.env.BACKUP_INTERVAL_SECONDS || 60,
  );
  const backupDir = options.backupDir || P3_CONFIG.backupDir;
  const maxIterations = options.maxIterations || Infinity;
  const myPid = options.pid || process.pid;
  const lockFile = path.join(backupDir, ".backup.lock");
  const loopLogFile = path.join(backupDir, "backup-loop.log");

  fs.mkdirSync(backupDir, { recursive: true });

  // 1. Ambil atomic lock menggunakan exclusive creation flag "wx" SEBELUM loop dimulai
  const lockRes = acquireLock(lockFile, myPid);
  if (!lockRes.acquired) {
    console.log(
      `[${new Date().toISOString()}] [SKIP] Tidak dapat memperoleh lock: ${lockRes.error}. Backup loop ditolak untuk mencegah proses bersamaan.`,
    );
    return 0;
  }

  let isRunning = true;
  let iterations = 0;
  let sleepTimer = null;
  let sleepResolve = null;

  const requestShutdown = () => {
    if (!isRunning) return;
    isRunning = false;
    console.log(
      "\n[BACKUP-LOOP] Sinyal penghentian diterima. Menunggu siklus saat ini selesai...",
    );
    // Jika sedang dalam masa jeda (sleep), bangunkan segera
    if (sleepTimer) {
      clearTimeout(sleepTimer);
      sleepTimer = null;
    }
    if (sleepResolve) {
      sleepResolve();
      sleepResolve = null;
    }
  };

  const sigintHandler = () => requestShutdown();
  const sigtermHandler = () => requestShutdown();

  process.on("SIGINT", sigintHandler);
  process.on("SIGTERM", sigtermHandler);

  console.log(
    "===========================================================================",
  );
  console.log(
    `[BACKUP-LOOP] Memulai PostgreSQL Backup Automation Loop (Interval: ${intervalSeconds}s)`,
  );
  console.log(
    `- Target Stack   : P3 (${P3_CONFIG.container} -> ${P3_CONFIG.dbName})`,
  );
  console.log(`- Direktori      : ${backupDir}`);
  console.log(`- Lock File      : ${lockFile}`);
  console.log(`- Process PID    : ${myPid}`);
  console.log(
    "[BACKUP-LOOP] Tekan Ctrl+C untuk menghentikan proses secara aman.",
  );
  console.log(
    "===========================================================================",
  );

  try {
    while (isRunning && iterations < maxIterations) {
      iterations++;
      const cycleStartTime = Date.now();
      const nowStr = new Date().toISOString();

      try {
        console.log(
          `[${nowStr}] [START] Menjalankan backup otomatis #${iterations} (PID: ${myPid})...`,
        );

        const backupFn =
          typeof options.backupFn === "function"
            ? options.backupFn
            : (opts) => performBackup(opts, options.execFn);
        const meta = await backupFn(options);
        const successLog = `[${meta.endTime}] SUCCESS iter=${iterations} file=${meta.file} size=${meta.sizeBytes}B duration=${meta.durationMs}ms\n`;
        try {
          fs.appendFileSync(loopLogFile, successLog, "utf8");
        } catch {}
        console.log(
          `[${meta.endTime}] [SUCCESS] Backup #${iterations} selesai: ${meta.file} (${(meta.sizeBytes / 1024).toFixed(2)} KB, ${meta.durationMs}ms)`,
        );
      } catch (err) {
        const failLog = `[${new Date().toISOString()}] FAILURE iter=${iterations} error="${err.message}"\n`;
        try {
          fs.appendFileSync(loopLogFile, failLog, "utf8");
        } catch {}
        console.error(
          `[${new Date().toISOString()}] [FAILURE] Backup #${iterations} gagal: ${err.message}`,
        );
      }

      if (iterations < maxIterations && isRunning) {
        // Hitung sisa waktu tidur berdasarkan durasi eksekusi backup
        const cycleDurationMs = Date.now() - cycleStartTime;
        const targetIntervalMs = intervalSeconds * 1000;
        const remainingSleepMs = Math.max(0, targetIntervalMs - cycleDurationMs);

        // Hook untuk pengujian unit testing (verifikasi lock saat menunggu interval)
        if (typeof options.onIterationWait === "function") {
          try {
            options.onIterationWait({ iterations, lockFile, myPid });
          } catch {}
        }

        if (remainingSleepMs > 0) {
          await new Promise((resolve) => {
            sleepResolve = resolve;
            sleepTimer = setTimeout(() => {
              sleepTimer = null;
              sleepResolve = null;
              resolve();
            }, remainingSleepMs);
          });
        } else {
          // Durasi backup melebihi target interval; lanjutkan siklus berikutnya secara serial tanpa jeda berlebih
          await new Promise((resolve) => {
            sleepResolve = resolve;
            sleepTimer = setTimeout(() => {
              sleepTimer = null;
              sleepResolve = null;
              resolve();
            }, 50);
          });
        }
      }
    }
  } finally {
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
    console.log("[BACKUP-LOOP] Membersihkan lock file...");
    const released = releaseLock(lockFile, myPid);
    if (released) {
      console.log("[BACKUP-LOOP] Lock file berhasil dibersihkan.");
    }
    console.log("[BACKUP-LOOP] Backup loop dihentikan secara normal.");
  }

  return iterations;
}

if (require.main === module) {
  startBackupLoop().catch((err) => {
    console.error("[BACKUP-LOOP ERROR]", err.message);
    process.exit(1);
  });
}

module.exports = { acquireLock, releaseLock, startBackupLoop };
