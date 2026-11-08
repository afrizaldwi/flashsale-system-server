"use strict";
/**
 * scripts/p4/common.js
 * Utilitas bersama untuk Backup & Restore Database P3 (flashsale_p3)
 *
 * Standar Keamanan & Reliabilitas DRP Kelompok 1:
 * - Fail-closed: Validasi identitas container dan role database wajib lolos.
 * - Isolasi ketat: Hanya menargetkan stack P3 (flashsale_p3), dilarang menyentuh stack P2.
 * - Proteksi data: Snapshot konsisten (custom format -Fc), tidak ada credential yang dicetak.
 */

require("dotenv").config({ path: ".env.p3" });
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync } = require("node:child_process");

const P3_CONFIG = {
  project: "flashsale-p3",
  service: "db-primary",
  environment: "p3",
  dbName: "flashsale_p3",
  dbUser: "p3_admin",
  container: "flashsale-p3-db-primary-1",
  backupDir: path.resolve(process.cwd(), "backups/p3"),
};

function sh(cmd, execFn = execSync) {
  try {
    const stdout = execFn(cmd, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    return {
      ok: true,
      stdout: stdout ? stdout.trim() : "",
      stderr: "",
      code: 0,
    };
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout || "").toString().trim(),
      stderr: (err.stderr || err.message || "").toString().trim(),
      code: err.status || 1,
    };
  }
}

/**
 * Validasi ketat identitas container target:
 * 1. Container harus berjalan (running=true).
 * 2. Label project harus cocok (flashsale-p3).
 * 3. Label service harus cocok (db-primary).
 * 4. Label environment harus cocok (p3).
 */
function inspectContainerIdentity(
  containerName = P3_CONFIG.container,
  expected = P3_CONFIG,
  execFn = execSync,
) {
  const res = sh(`docker inspect ${containerName}`, execFn);
  if (!res.ok) {
    return {
      ok: false,
      running: false,
      error: `Container '${containerName}' tidak ditemukan atau gagal di-inspect: ${res.stderr || "not found"}`,
    };
  }

  let data;
  try {
    const parsed = JSON.parse(res.stdout);
    data = Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (err) {
    return {
      ok: false,
      running: false,
      error: `Gagal mem-parse JSON docker inspect: ${err.message}`,
    };
  }

  if (!data || !data.State) {
    return {
      ok: false,
      running: false,
      error: `Data state container '${containerName}' kosong`,
    };
  }

  const running = Boolean(data.State.Running);
  if (!running) {
    return {
      ok: false,
      running: false,
      error: `Container '${containerName}' tidak sedang berjalan (status: ${data.State.Status || "unknown"})`,
    };
  }

  const labels = data.Config?.Labels || {};
  const project = (labels["com.docker.compose.project"] || "").trim();
  const service = (labels["com.docker.compose.service"] || "").trim();
  const env = (labels["flashsale.environment"] || "").trim();

  if (expected.project && project !== expected.project) {
    return {
      ok: false,
      running,
      error: `Project label mismatch (aktual: '${project}', diharapkan: '${expected.project}')`,
    };
  }

  if (expected.service && service !== expected.service) {
    return {
      ok: false,
      running,
      error: `Service label mismatch (aktual: '${service}', diharapkan: '${expected.service}')`,
    };
  }

  if (expected.environment && env !== expected.environment) {
    return {
      ok: false,
      running,
      error: `Environment label mismatch (aktual: '${env}', diharapkan: '${expected.environment}')`,
    };
  }

  return { ok: true, running, id: (data.Id || "").slice(0, 12), labels };
}

/**
 * Validasi nama database dan status writer PostgreSQL:
 * 1. Database name WAJIB flashsale_p3 (TIDAK BOLEH flashsale P2).
 * 2. Database WAJIB merupakan writer (pg_is_in_recovery() === 'f').
 */
function verifyDatabaseRole(
  containerName = P3_CONFIG.container,
  expectedDb = P3_CONFIG.dbName,
  dbUser = P3_CONFIG.dbUser,
  execFn = execSync,
) {
  const sql = "SELECT current_database(), pg_is_in_recovery();";
  const cmd = `docker exec ${containerName} psql -U ${dbUser} -d ${expectedDb} -AtXc "${sql}"`;
  const res = sh(cmd, execFn);

  if (!res.ok) {
    return {
      ok: false,
      error: `Gagal menjalankan query role PostgreSQL pada '${containerName}': ${res.stderr || res.stdout}`,
    };
  }

  const parts = res.stdout.split("|");
  if (parts.length < 2) {
    return {
      ok: false,
      error: `Format respons database tidak terduga: '${res.stdout}'`,
    };
  }

  const dbName = parts[0].trim();
  const inRecovery = parts[1].trim();

  if (dbName !== expectedDb) {
    return {
      ok: false,
      dbName,
      inRecovery,
      error: `Database mismatch! Aktual: '${dbName}', diharapkan '${expectedDb}'. Dilarang menargetkan database lain (misal P2).`,
    };
  }

  if (inRecovery === "t") {
    return {
      ok: false,
      dbName,
      inRecovery: true,
      error: `Database '${dbName}' pada '${containerName}' berada dalam mode standby (in_recovery=t)! Backup/restore hanya diizinkan pada primary writer.`,
    };
  }

  if (inRecovery !== "f") {
    return {
      ok: false,
      dbName,
      inRecovery,
      error: `Status recovery database tidak valid: '${inRecovery}' (harus 'f')`,
    };
  }

  return { ok: true, dbName, inRecovery: false };
}

/**
 * Menghitung SHA-256 dari file di host
 */
function calculateFileSha256(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Memvalidasi checksum file backup terhadap file .sha256
 */
function verifyFileChecksum(dumpPath, sha256Path = `${dumpPath}.sha256`) {
  if (!fs.existsSync(dumpPath)) {
    return { ok: false, error: `File backup dump tidak ditemukan: ${dumpPath}` };
  }
  if (!fs.existsSync(sha256Path)) {
    return {
      ok: false,
      error: `File checksum .sha256 tidak ditemukan: ${sha256Path}`,
    };
  }

  const content = fs.readFileSync(sha256Path, "utf8").trim();
  const expectedHash = content.split(/\s+/)[0].trim().toLowerCase();
  const actualHash = calculateFileSha256(dumpPath).toLowerCase();

  if (actualHash !== expectedHash) {
    return {
      ok: false,
      actual: actualHash,
      expected: expectedHash,
      error: `Checksum mismatch! File dump telah termodifikasi atau korup (aktual: ${actualHash}, diharapkan: ${expectedHash})`,
    };
  }

  return { ok: true, actual: actualHash, expected: expectedHash };
}

/**
 * Validasi arsip dump menggunakan pg_restore --list
 */
function validateArchiveTOC(containerName, dumpPath, execFn = execSync) {
  if (!fs.existsSync(dumpPath)) {
    return { ok: false, error: `File dump lokal tidak ditemukan: ${dumpPath}` };
  }

  try {
    // Listing an archive must not copy files into the protected baseline stack.
    const stdout = execFn(`docker exec -i ${containerName} pg_restore --list`, {
      input: fs.readFileSync(dumpPath), encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"], timeout: 30000,
    }).toString();
    const lines = stdout
      .split("\n")
      .filter((l) => l.trim().length > 0 && !l.startsWith(";"));
    return {
      ok: lines.length > 0,
      tocEntriesCount: lines.length,
      rawHeader: stdout.slice(0, 300),
      ...(lines.length ? {} : { error: "pg_restore --list returned an empty archive TOC" }),
    };
  } catch (err) {
    return { ok: false, error: `pg_restore --list gagal memvalidasi arsip: ${(err.stderr || err.message).toString()}` };
  }
}

/**
 * Mem-parse bilangan bulat non-negatif secara ketat (fail-closed).
 * Mengembalikan integer aman >= 0 jika valid, atau null jika tidak valid.
 * Menolak string kosong, tanda minus/plus, pecahan, trailing non-digit, NaN, Infinity.
 */
function parseStrictNonNegativeInt(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (str === "") return null;
  if (!/^\d+$/.test(str)) return null;
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num < 0) return null;
  return num;
}

/**
 * Memeriksa koneksi aktif selain koneksi saat ini.
 * Mengembalikan objek status { ok: boolean, count: number, error: string | null }
 */
function getActiveConnectionCount(
  containerName,
  dbName = P3_CONFIG.dbName,
  dbUser = P3_CONFIG.dbUser,
  execFn = execSync,
) {
  const sql = `SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid();`;
  const res = sh(
    `docker exec ${containerName} psql -U ${dbUser} -d ${dbName} -AtXc "${sql}"`,
    execFn,
  );
  if (!res.ok) {
    return {
      ok: false,
      count: null,
      error: `Gagal membaca koneksi aktif database: ${res.stderr || res.stdout || "Unknown error"}`,
    };
  }
  const count = parseStrictNonNegativeInt(res.stdout);
  if (count === null) {
    return {
      ok: false,
      count: null,
      error: `Output getActiveConnectionCount bukan bilangan bulat non-negatif valid: '${res.stdout}'`,
    };
  }
  return { ok: true, count, error: null };
}

/**
 * Memutus koneksi backend aktif sebelum restore.
 * Mengembalikan objek status { ok: boolean, count: number, error: string | null }
 * Hanya menghitung koneksi yang benar-benar berhasil diputus (pg_terminate_backend bernilai true).
 */
function terminateActiveConnections(
  containerName,
  dbName = P3_CONFIG.dbName,
  dbUser = P3_CONFIG.dbUser,
  execFn = execSync,
) {
  const sql = `SELECT count(*)::int FROM (SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()) t WHERE terminated = true;`;
  const res = sh(
    `docker exec ${containerName} psql -U ${dbUser} -d ${dbName} -AtXc "${sql}"`,
    execFn,
  );
  if (!res.ok) {
    return {
      ok: false,
      count: null,
      error: `Gagal menjalankan query pemutusan koneksi (pg_terminate_backend): ${res.stderr || res.stdout || "Unknown error"}`,
    };
  }
  const count = parseStrictNonNegativeInt(res.stdout);
  if (count === null) {
    return {
      ok: false,
      count: null,
      error: `Output terminateActiveConnections bukan bilangan bulat non-negatif valid: '${res.stdout}'`,
    };
  }
  return { ok: true, count, error: null };
}

function safeUnlinkSync(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.unlinkSync(filePath);
      return;
    } catch (err) {
      if ((err.code === "EBUSY" || err.code === "EPERM") && attempt < 9) {
        const waitTill = Date.now() + 50;
        while (Date.now() < waitTill) {}
      } else {
        throw err;
      }
    }
  }
}

/**
 * Menerapkan kebijakan retensi backup:
 * - Mempertahankan hingga keepCount (default 10) backup valid terbaru (retains up to 10 valid backups).
 * - Menghapus backup tertua ketika jumlah backup valid melebihi batas retensi (> keepCount).
 * - Tidak pernah menghapus backup valid terakhir (bahkan jika keepCount diset rendah).
 * - Suspend seluruh pruning bila restore lock ada, rusak, atau tidak terbaca.
 * - Set lengkap dan metadata VALIDATED, checksum serta TOC wajib valid.
 * - Mutex arsip yang sama menyinkronkan backup, restore, dan retention.
 * - Mencatat setiap penghapusan file ke logFile.
 * - Tidak pernah menghapus file temporary (.tmp) atau file yang tidak terkait (.log, .lock, dll).
 */
function applyRetentionPolicy(backupDir, keepCount = 10, options = {}) {
  const { acquireArchiveLock, assertArchiveLock, restoreLockPresent } = require("./locks");
  if (!fs.existsSync(backupDir)) return { pruned: [], kept: [] };
  const files = () => fs.readdirSync(backupDir).filter((f) => /^flashsale_p3_[a-zA-Z0-9_-]+\.dump$/.test(f));
  const suspended = (reason) => ({ pruned: [], kept: files(), suspended: true, reason });
  // Even an unreadable, malformed, or directory-shaped lock suspends ALL pruning.
  if (restoreLockPresent(backupDir)) return suspended("Restore lock present or unreadable");
  let lease = options.archiveLock;
  let acquired = false;
  try {
    if (!lease) { lease = acquireArchiveLock(backupDir); acquired = true; }
    assertArchiveLock(backupDir, lease);
  } catch (error) { return suspended(error.message); }
  try {
    const parsed = Number(keepCount);
    const minKeep = Number.isInteger(parsed) ? Math.min(10, Math.max(1, parsed)) : 10;
    const logFile = options.logFile || path.join(backupDir, "backup.log");
    const valid = [];
    const validateArchive = options.validateArchive || ((file) => validateArchiveTOC(options.container || P3_CONFIG.container, file, options.execFn).ok);
    for (const file of files()) {
      const dumpPath = path.join(backupDir, file);
      const shaPath = `${dumpPath}.sha256`, metaPath = `${dumpPath}.meta.json`;
      let meta;
      try {
        if (![dumpPath, shaPath, metaPath].every((f) => fs.lstatSync(f).isFile())) continue;
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        const checksum = verifyFileChecksum(dumpPath, shaPath);
        if (!checksum.ok || meta?.status !== "VALIDATED" || meta.database !== "flashsale_p3" ||
            meta.file !== file || meta.sha256 !== checksum.actual ||
            !Number.isSafeInteger(meta.sizeBytes) || meta.sizeBytes <= 0 || meta.sizeBytes !== fs.statSync(dumpPath).size ||
            typeof meta.startTime !== "string" || typeof meta.endTime !== "string" ||
            !Number.isFinite(Date.parse(meta.startTime)) || !Number.isFinite(Date.parse(meta.endTime)) ||
            Date.parse(meta.endTime) < Date.parse(meta.startTime) ||
            !Number.isFinite(meta.durationMs) || meta.durationMs < 0 ||
            !Number.isInteger(meta.tocEntries) || meta.tocEntries < 1 || validateArchive(dumpPath) !== true) continue;
      } catch { continue; }
      valid.push({ file, dumpPath, shaPath, metaPath, time: Date.parse(meta.startTime) });
    }
    valid.sort((a, b) => b.time - a.time || b.file.localeCompare(a.file));
    const kept = valid.slice(0, minKeep).map((v) => v.file), pruned = [];
    for (const candidate of valid.slice(minKeep)) {
      assertArchiveLock(backupDir, lease);
      if (restoreLockPresent(backupDir)) return { pruned, kept: files(), suspended: true, reason: "Restore lock appeared; pruning suspended" };
      if (options.activeRestoreFile === candidate.file) { kept.push(candidate.file); continue; }
      // Windows-safe retries are retained. A valid replacement set is kept first.
      try {
        safeUnlinkSync(candidate.dumpPath);
        safeUnlinkSync(candidate.shaPath);
        safeUnlinkSync(candidate.metaPath);
        pruned.push({ file: candidate.file, reason: `Exceeds retention limit (${minKeep})` });
        fs.appendFileSync(logFile, `[${new Date().toISOString()}] RETENTION_PRUNE file=${candidate.file}\n`, "utf8");
      } catch (error) { throw new Error(`Retention failed for ${candidate.file}: ${error.message}`); }
    }
    return { pruned, kept };
  } finally {
    if (acquired && !lease.release()) throw new Error("Retention archive lock ownership changed or cleanup failed");
  }
}
module.exports = {
  P3_CONFIG,
  sh,
  inspectContainerIdentity,
  verifyDatabaseRole,
  calculateFileSha256,
  verifyFileChecksum,
  validateArchiveTOC,
  parseStrictNonNegativeInt,
  getActiveConnectionCount,
  terminateActiveConnections,
  applyRetentionPolicy,
};
