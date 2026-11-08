"use strict";
/**
 * scripts/p4/backup.js
 * PostgreSQL Backup Automation untuk Stack P3 (flashsale_p3)
 *
 * Menggunakan PostgreSQL pg_dump dengan format custom (-Fc).
 * Konsistensi snapshot level REPEATABLE READ terjamin secara bawaan oleh pg_dump
 * sekalipun transaksi checkout sedang berlangsung serentak.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const {
  P3_CONFIG,
  sh,
  inspectContainerIdentity,
  verifyDatabaseRole,
  calculateFileSha256,
  validateArchiveTOC,
} = require("./common");

function formatTimestamp(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = d.getFullYear();
  const m = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const h = pad(d.getHours());
  const min = pad(d.getMinutes());
  const s = pad(d.getSeconds());
  return `${y}${m}${day}_${h}${min}${s}`;
}

async function performBackup(options = {}, execFn = execSync) {
  const cfg = {
    container: options.container || P3_CONFIG.container,
    dbName: options.dbName || P3_CONFIG.dbName,
    dbUser: options.dbUser || P3_CONFIG.dbUser,
    backupDir: options.backupDir || P3_CONFIG.backupDir,
    expectedIdentity: {
      project: options.project || P3_CONFIG.project,
      service: options.service || P3_CONFIG.service,
      environment: options.environment || P3_CONFIG.environment,
    },
  };

  const startTime = new Date();
  const timestampStr = formatTimestamp(startTime);

  // 1. Validasi Identitas Container (Fail-Closed)
  const idCheck = inspectContainerIdentity(
    cfg.container,
    cfg.expectedIdentity,
    execFn,
  );
  if (!idCheck.ok) {
    throw new Error(`Validasi container gagal: ${idCheck.error}`);
  }

  // 2. Validasi Database & Peran Writer (Fail-Closed: Tolak standby & tolak P2)
  const roleCheck = verifyDatabaseRole(
    cfg.container,
    cfg.dbName,
    cfg.dbUser,
    execFn,
  );
  if (!roleCheck.ok) {
    throw new Error(`Validasi database gagal: ${roleCheck.error}`);
  }

  // 3. Pastikan direktori backup host tersedia
  fs.mkdirSync(cfg.backupDir, { recursive: true });

  const dumpBaseName = `${cfg.dbName}_${timestampStr}.dump`;
  const tempHostPath = path.join(cfg.backupDir, `${dumpBaseName}.tmp`);
  const finalHostPath = path.join(cfg.backupDir, dumpBaseName);
  const sha256HostPath = `${finalHostPath}.sha256`;
  const metaHostPath = `${finalHostPath}.meta.json`;
  const logHostPath = path.join(cfg.backupDir, "backup.log");

  const containerTempDump = `/tmp/backup_${timestampStr}_${Math.random().toString(36).slice(2, 8)}.dump`;

  try {
    // 4. Eksekusi pg_dump dengan format custom (-Fc) di dalam container primary
    // pg_dump menjamin konsistensi ACID snapshot level REPEATABLE READ saat transaksi konkuren berjalan
    const dumpCmd = `docker exec ${cfg.container} pg_dump -U ${cfg.dbUser} -d ${cfg.dbName} -Fc -f ${containerTempDump}`;
    const dumpRes = sh(dumpCmd, execFn);
    if (!dumpRes.ok) {
      throw new Error(
        `pg_dump gagal pada container '${cfg.container}': ${dumpRes.stderr || dumpRes.stdout}`,
      );
    }

    // 5. Salin arsip dump dari container ke temporary file host
    const cpRes = sh(
      `docker cp ${cfg.container}:${containerTempDump} "${tempHostPath}"`,
      execFn,
    );
    if (!cpRes.ok) {
      throw new Error(
        `Gagal menyalin backup dari container ke host: ${cpRes.stderr || cpRes.stdout}`,
      );
    }

    // 6. Validasi integritas arsip menggunakan pg_restore --list
    const tocCheck = validateArchiveTOC(cfg.container, tempHostPath, execFn);
    if (!tocCheck.ok) {
      throw new Error(
        `Validasi integritas arsip dump gagal (pg_restore --list): ${tocCheck.error}`,
      );
    }

    // 7. Berhasil: Rename temporary file menjadi final dump file
    fs.renameSync(tempHostPath, finalHostPath);

    // 8. Hitung SHA-256 dan ukuran file
    const sha256 = calculateFileSha256(finalHostPath);
    const stats = fs.statSync(finalHostPath);
    const endTime = new Date();
    const durationMs = endTime - startTime;

    // 9. Simpan file checksum .sha256 (format standar: <hash>  <filename>)
    fs.writeFileSync(sha256HostPath, `${sha256}  ${dumpBaseName}\n`, "utf8");

    // 10. Simpan metadata JSON
    const metadata = {
      database: cfg.dbName,
      container: cfg.container,
      file: dumpBaseName,
      filePath: finalHostPath,
      sizeBytes: stats.size,
      sha256: sha256,
      tocEntries: tocCheck.tocEntriesCount,
      format: "CUSTOM (-Fc)",
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationMs: durationMs,
      status: "VALIDATED",
    };
    fs.writeFileSync(metaHostPath, JSON.stringify(metadata, null, 2), "utf8");

    // 11. Catat ke backup.log
    const logLine = `[${endTime.toISOString()}] SUCCESS file=${dumpBaseName} size=${stats.size}B duration=${durationMs}ms sha256=${sha256.slice(0, 12)}...\n`;
    fs.appendFileSync(logHostPath, logLine, "utf8");

    return metadata;
  } catch (err) {
    // PENTING: Bersihkan temporary file pada host dan container jika gagal.
    // JANGAN PERNAH menghapus backup sebelumnya yang sudah valid!
    if (fs.existsSync(tempHostPath)) {
      try {
        fs.unlinkSync(tempHostPath);
      } catch {}
    }
    const logLine = `[${new Date().toISOString()}] FAILED database=${cfg.dbName} error="${err.message}"\n`;
    try {
      fs.appendFileSync(logHostPath, logLine, "utf8");
    } catch {}
    throw err;
  } finally {
    // Bersihkan file sementara di container
    sh(`docker exec ${cfg.container} rm -f ${containerTempDump}`, execFn);
  }
}

if (require.main === module) {
  performBackup()
    .then((meta) => {
      console.log(
        "===========================================================================",
      );
      console.log(
        "[BACKUP SUKSES] PostgreSQL Database Backup P3 Berhasil Dibuat & Tervalidasi",
      );
      console.log(`- Database       : ${meta.database}`);
      console.log(`- Container      : ${meta.container}`);
      console.log(`- File           : ${meta.file}`);
      console.log(
        `- Ukuran         : ${(meta.sizeBytes / 1024).toFixed(2)} KB (${meta.sizeBytes} bytes)`,
      );
      console.log(`- SHA-256        : ${meta.sha256}`);
      console.log(
        `- TOC Entries    : ${meta.tocEntries} objek tervalidasi (pg_restore --list)`,
      );
      console.log(`- Durasi         : ${meta.durationMs} ms`);
      console.log(`- Waktu Mulai    : ${meta.startTime}`);
      console.log(`- Waktu Selesai  : ${meta.endTime}`);
      console.log(
        "===========================================================================",
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error(
        "===========================================================================",
      );
      console.error("[BACKUP GAGAL]", err.message);
      console.error(
        "===========================================================================",
      );
      process.exit(1);
    });
}

module.exports = { performBackup, formatTimestamp };
