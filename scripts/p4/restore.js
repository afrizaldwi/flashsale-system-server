"use strict";
/**
 * scripts/p4/restore.js
 * PostgreSQL Restore Automation untuk Stack P3 (flashsale_p3)
 *
 * Ketentuan DRP Kelompok 1:
 * - Default: DRY-RUN (tidak mengubah data atau skema).
 * - Eksekusi aktual WAJIB menggunakan flag eksplisit: --execute.
 * - Memvalidasi SHA-256 checksum dan integritas arsip (pg_restore --list).
 * - Memastikan target database adalah flashsale_p3 dan merupakan primary writer.
 * - Menggunakan opsi: --clean --if-exists --no-owner --no-acl --exit-on-error.
 * - Memutus koneksi backend aktif selama proses restore untuk mencegah deadlock/lock conflict.
 * - Tidak pernah menyentuh volume Docker atau database P2.
 */

const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const {
  P3_CONFIG,
  sh,
  inspectContainerIdentity,
  verifyDatabaseRole,
  verifyFileChecksum,
  validateArchiveTOC,
  parseStrictNonNegativeInt,
  getActiveConnectionCount,
  terminateActiveConnections,
} = require("./common");

/**
 * Memilih backup terbaru yang benar-benar valid:
 * 1. Mengurutkan file .dump dari yang terbaru ke terlama.
 * 2. Memeriksa keberadaan file .sha256.
 * 3. Memvalidasi SHA-256 terhadap isi file dump.
 * 4. Memvalidasi integritas struktur arsip via pg_restore --list (validateArchiveTOC).
 * 5. Jika backup terbaru korup/tidak valid, otomatis lewati dan periksa backup sebelumnya.
 * 6. Mengembalikan backup valid pertama yang ditemukan.
 * 7. Tidak pernah menghapus atau memodifikasi file backup lama.
 */
function findLatestBackup(
  backupDir = P3_CONFIG.backupDir,
  containerName = P3_CONFIG.container,
  execFn = execSync,
) {
  if (!fs.existsSync(backupDir)) {
    return {
      ok: false,
      path: null,
      file: null,
      error: `Direktori backup tidak ditemukan: ${backupDir}`,
      skipped: [],
    };
  }

  // 1. Ambil daftar file .dump dan urutkan berdasarkan timestamp terbaru (descending)
  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.endsWith(".dump") && !f.endsWith(".tmp"))
    .sort()
    .reverse();

  if (files.length === 0) {
    return {
      ok: false,
      path: null,
      file: null,
      error: `Tidak ada file .dump di direktori backup: ${backupDir}`,
      skipped: [],
    };
  }

  const skipped = [];

  for (const file of files) {
    const candidatePath = path.join(backupDir, file);
    const shaPath = `${candidatePath}.sha256`;

    // 2. Periksa keberadaan file checksum .sha256 yang sesuai
    if (!fs.existsSync(shaPath)) {
      skipped.push({
        file,
        reason: `File checksum .sha256 tidak ditemukan (${path.basename(shaPath)})`,
      });
      continue;
    }

    // 3. Validasi SHA-256 terhadap isi file dump
    const checksumCheck = verifyFileChecksum(candidatePath, shaPath);
    if (!checksumCheck.ok) {
      skipped.push({
        file,
        reason: checksumCheck.error,
      });
      continue;
    }

    // 4. Validasi struktur arsip menggunakan helper pg_restore --list
    const tocCheck = validateArchiveTOC(containerName, candidatePath, execFn);
    if (!tocCheck.ok) {
      skipped.push({
        file,
        reason: tocCheck.error,
      });
      continue;
    }

    // 5 & 6. Backup valid terbaru ditemukan!
    return {
      ok: true,
      path: candidatePath,
      file,
      sha256: checksumCheck.actual,
      tocEntries: tocCheck.tocEntriesCount,
      skipped,
    };
  }

  // 7. Jika seluruh backup tidak valid, kembalikan status gagal dengan alasan lengkap
  return {
    ok: false,
    path: null,
    file: null,
    error: `Tidak ditemukan backup yang valid di ${backupDir}. Seluruh ${files.length} kandidat backup dilewati karena tidak memiliki checksum, checksum mismatch, atau arsip korup.`,
    skipped,
  };
}

async function performRestore(options = {}, execFn = execSync) {
  // API execution is explicit; flags of an importing process are irrelevant.
  if (options.execute !== true) return performRestoreUnlocked({ ...options, execute: false }, execFn);
  const { acquireRestoreSession } = require("./locks");
  const session = acquireRestoreSession(options.backupDir || P3_CONFIG.backupDir, {
    file: options.file ? path.basename(options.file) : null,
  });
  try {
    const { context } = require("./p3-dr");
    const { recoveryState } = require("../p3/recovery");
    const { withOperationLock, readJson } = require("../p3/util");
    const { c } = context(options);
    return await withOperationLock(c.runtime, async () => {
      const state = recoveryState(c);
      if (!state || state.phase !== "recovering") throw new Error("Restore requires a recovering manifest and fresh recovery volume; original volumes are protected");
      if (readJson(path.join(c.runtime, "control.json"), {}).paused !== true) throw new Error("Pause P3 controller before restore");
      for (const [key, expected] of Object.entries({ project: "flashsale-p3", service: "db-primary", environment: "p3", dbName: "flashsale_p3", dbUser: "p3_admin" })) {
        if (options[key] != null && options[key] !== expected) throw new Error(`Official P3 restore required: invalid ${key}`);
      }
      if (!/^[a-f0-9]{64}$/.test(options.confirmPrimary || "") || options.confirmVolume !== state.primaryVolume)
        throw new Error("Explicit confirmation required: full recovery primary ID and exact fresh volume");
      const requested = options.container || P3_CONFIG.container;
      if (!/^[a-zA-Z0-9_.-]+$/.test(requested)) throw new Error("Invalid target container");
      const assertTarget = (container) => {
        const check = sh(`docker inspect ${container}`, execFn);
        if (!check.ok) throw new Error(`Restore target inspection failed: ${check.stderr}`);
        const data = JSON.parse(check.stdout);
        if (!Array.isArray(data) || data.length !== 1) throw new Error("Expected exactly one restore target");
        const target = data[0], labels = target.Config?.Labels || {};
        const mounts = (target.Mounts || []).filter(m => m.Destination === "/var/lib/postgresql/data");
        if (target.Id !== options.confirmPrimary || target.State?.Running !== true ||
            labels["com.docker.compose.project"] !== "flashsale-p3" || labels["com.docker.compose.service"] !== "db-primary" ||
            labels["flashsale.environment"] !== "p3" || !target.NetworkSettings?.Networks?.["flashsale-p3_p3"] ||
            mounts.length !== 1 || mounts[0].Type !== "volume" || mounts[0].Name !== state.primaryVolume ||
            [state.originalPrimary.volume, state.originalReplica?.volume].includes(mounts[0].Name))
          throw new Error("Restore target ID, identity or fresh recovery volume mismatch");
        return target.Id;
      };
      const id = assertTarget(requested);
      return performRestoreUnlocked({ ...options, container: id, assertTarget: () => assertTarget(id) }, execFn);
    });
  }
  finally { session.release(); }
}

async function performRestoreUnlocked(options = {}, execFn = execSync) {
  const isExecute = options.execute === true;
  const cfg = {
    execute: isExecute,
    container: options.container || P3_CONFIG.container,
    dbName: options.dbName || P3_CONFIG.dbName,
    dbUser: options.dbUser || P3_CONFIG.dbUser,
    backupDir: options.backupDir || P3_CONFIG.backupDir,
    specifiedFile: options.file || null,
    expectedIdentity: {
      project: options.project || P3_CONFIG.project,
      service: options.service || P3_CONFIG.service,
      environment: options.environment || P3_CONFIG.environment,
    },
  };

  // 1. Tentukan file backup yang akan digunakan (spesifik atau pencarian otomatis terbaru yang valid)
  let dumpPath = cfg.specifiedFile;
  let checksumCheck;
  let tocCheck;

  if (dumpPath) {
    if (!path.isAbsolute(dumpPath)) {
      dumpPath = path.resolve(process.cwd(), dumpPath);
    }
    if (!fs.existsSync(dumpPath)) {
      throw new Error(`File backup tidak ditemukan: ${dumpPath}`);
    }

    // 2. Validasi SHA-256 Checksum untuk specifiedFile
    checksumCheck = verifyFileChecksum(dumpPath);
    if (!checksumCheck.ok) {
      throw new Error(`Integritas backup gagal: ${checksumCheck.error}`);
    }

    // 3. Validasi Identitas Container Target (Fail-Closed)
    const idCheck = inspectContainerIdentity(
      cfg.container,
      cfg.expectedIdentity,
      execFn,
    );
    if (!idCheck.ok) {
      throw new Error(`Validasi container target gagal: ${idCheck.error}`);
    }

    // 4. Validasi Database Target (Wajib flashsale_p3 dan WAJIB primary writer, bukan standby!)
    const roleCheck = verifyDatabaseRole(
      cfg.container,
      cfg.dbName,
      cfg.dbUser,
      execFn,
    );
    if (!roleCheck.ok) {
      throw new Error(`Validasi database target gagal: ${roleCheck.error}`);
    }

    // 5. Validasi Integritas Struktur Arsip via pg_restore --list
    tocCheck = validateArchiveTOC(cfg.container, dumpPath, execFn);
    if (!tocCheck.ok) {
      throw new Error(
        `Validasi arsip backup gagal (pg_restore --list): ${tocCheck.error}`,
      );
    }
  } else {
    // 3. Validasi Identitas Container Target (Fail-Closed)
    const idCheck = inspectContainerIdentity(
      cfg.container,
      cfg.expectedIdentity,
      execFn,
    );
    if (!idCheck.ok) {
      throw new Error(`Validasi container target gagal: ${idCheck.error}`);
    }

    // 4. Validasi Database Target (Wajib flashsale_p3 dan WAJIB primary writer, bukan standby!)
    const roleCheck = verifyDatabaseRole(
      cfg.container,
      cfg.dbName,
      cfg.dbUser,
      execFn,
    );
    if (!roleCheck.ok) {
      throw new Error(`Validasi database target gagal: ${roleCheck.error}`);
    }

    // Otomatis memilih backup terbaru yang valid
    const latestRes = findLatestBackup(cfg.backupDir, cfg.container, execFn);
    if (!latestRes.ok) {
      throw new Error(`Gagal memilih backup: ${latestRes.error}`);
    }

    if (latestRes.skipped && latestRes.skipped.length > 0) {
      console.log(
        `[RESTORE NOTICE] Menemukan ${latestRes.skipped.length} backup terbaru yang korup/tidak lengkap; otomatis beralih ke backup valid: ${latestRes.file}`,
      );
    }

    dumpPath = latestRes.path;
    checksumCheck = { ok: true, actual: latestRes.sha256, expected: latestRes.sha256 };
    tocCheck = { ok: true, tocEntriesCount: latestRes.tocEntries };
  }

  // 6. Cek koneksi backend aktif
  const connCheck = getActiveConnectionCount(
    cfg.container,
    cfg.dbName,
    cfg.dbUser,
    execFn,
  );
  if (!connCheck.ok) {
    throw new Error(`Pemeriksaan koneksi aktif gagal: ${connCheck.error}`);
  }
  const activeConn = connCheck.count;

  const dumpBaseName = path.basename(dumpPath);
  const stats = fs.statSync(dumpPath);

  // Jika DRY-RUN: Tampilkan rencana restore lengkap dan berhenti tanpa memodifikasi database
  if (!cfg.execute) {
    return {
      dryRun: true,
      status: "READY",
      backupFile: dumpBaseName,
      backupPath: dumpPath,
      sizeBytes: stats.size,
      sha256: checksumCheck.actual,
      tocEntries: tocCheck.tocEntriesCount,
      targetContainer: cfg.container,
      targetDb: cfg.dbName,
      activeConnections: activeConn,
      pgRestoreOptions: [
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
      ],
      message:
        "Dry-run sukses. Arsip valid, checksum cocok, target terverifikasi. Tidak ada data yang diubah.",
    };
  }

  // JIKA --execute: Jalankan proses restore aktual
  const startTime = new Date();
  const containerRestoreDump = `/tmp/restore_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.dump`;

  options.assertTarget(); // Revalidate immediately before the first destructive operation.
  try {
    // 7. Putus koneksi backend aktif agar proses DROP/CREATE table tidak terkunci (lock conflict)
    const termRes = terminateActiveConnections(
      cfg.container,
      cfg.dbName,
      cfg.dbUser,
      execFn,
    );
    if (!termRes.ok) {
      throw new Error(
        `Gagal memutus koneksi aktif database: ${termRes.error}. Restore dibatalkan demi keselamatan data.`,
      );
    }

    // 7b. Re-check: Periksa ulang apakah masih ada koneksi aktif yang menghalangi proses pemulihan
    // Karena backend aplikasi (Express connection pool) dapat secara otomatis mencoba reconnect
    const recheckConn = getActiveConnectionCount(
      cfg.container,
      cfg.dbName,
      cfg.dbUser,
      execFn,
    );
    if (!recheckConn.ok) {
      throw new Error(
        `Gagal memverifikasi ulang koneksi aktif sebelum pg_restore: ${recheckConn.error}. Restore dibatalkan.`,
      );
    }
    if (recheckConn.count > 0) {
      throw new Error(
        `Masih terdapat ${recheckConn.count} koneksi aktif ke database '${cfg.dbName}' setelah proses terminasi! ` +
        `Koneksi backend baru terdeteksi (Express pool reconnect). ` +
        `Hentikan sementara trafik backend P3 sebelum menjalankan restore aktual (--execute).`,
      );
    }

    // 8. Salin file dump ke container
    const cpRes = sh(
      `docker cp "${dumpPath}" ${cfg.container}:${containerRestoreDump}`,
      execFn,
    );
    if (!cpRes.ok) {
      throw new Error(
        `Gagal menyalin file dump ke container target: ${cpRes.stderr || cpRes.stdout}`,
      );
    }

    // 9. Eksekusi pg_restore dengan opsi ketat
    const restoreCmd = `docker exec ${cfg.container} pg_restore -U ${cfg.dbUser} -d ${cfg.dbName} --clean --if-exists --no-owner --no-acl --exit-on-error ${containerRestoreDump}`;
    const restoreRes = sh(restoreCmd, execFn);
    if (!restoreRes.ok) {
      throw new Error(
        `pg_restore gagal pada container '${cfg.container}': ${restoreRes.stderr || restoreRes.stdout}`,
      );
    }

    // 10. Verifikasi post-restore: Cek tabel orders, products, users secara ketat (fail-closed)
    const verifySql =
      "SELECT (SELECT COUNT(*) FROM orders) AS orders_count, (SELECT COUNT(*) FROM products) AS products_count, (SELECT COUNT(*) FROM users) AS users_count;";
    const verifyRes = sh(
      `docker exec ${cfg.container} psql -U ${cfg.dbUser} -d ${cfg.dbName} -AtXc "${verifySql}"`,
      execFn,
    );

    if (!verifyRes.ok) {
      throw new Error(
        `Verifikasi pasca-restore gagal: query verifikasi database error (${verifyRes.stderr || verifyRes.stdout || "Unknown error"})`,
      );
    }

    const rawOutput = (verifyRes.stdout || "").trim();
    if (!rawOutput) {
      throw new Error("Verifikasi pasca-restore gagal: respons query verifikasi kosong");
    }

    const parts = rawOutput.split("|");
    if (parts.length !== 3) {
      throw new Error(
        `Verifikasi pasca-restore gagal: format output query tidak sesuai (diharapkan 3 kolom, didapat: '${rawOutput}')`,
      );
    }

    const parseCount = (val, colName) => {
      const num = parseStrictNonNegativeInt(val);
      if (num === null) {
        throw new Error(
          `Verifikasi pasca-restore gagal: nilai ${colName} tidak valid ('${val}')`,
        );
      }
      return num;
    };

    const tableCounts = {
      orders: parseCount(parts[0], "orders_count"),
      products: parseCount(parts[1], "products_count"),
      users: parseCount(parts[2], "users_count"),
    };

    const endTime = new Date();
    const durationMs = endTime - startTime;

    // Catat log restore HANYA setelah seluruh verifikasi berhasil
    const logPath = path.join(cfg.backupDir, "restore.log");
    const logLine = `[${endTime.toISOString()}] RESTORE_SUCCESS file=${dumpBaseName} db=${cfg.dbName} duration=${durationMs}ms orders=${tableCounts.orders} products=${tableCounts.products} users=${tableCounts.users}\n`;
    try {
      fs.appendFileSync(logPath, logLine, "utf8");
    } catch {}

    return {
      dryRun: false,
      status: "SUCCESS",
      backupFile: dumpBaseName,
      backupPath: dumpPath,
      sizeBytes: stats.size,
      sha256: checksumCheck.actual,
      targetContainer: cfg.container,
      targetDb: cfg.dbName,
      terminatedConnections: termRes.count,
      tableCounts,
      durationMs,
      completedAt: endTime.toISOString(),
    };
  } finally {
    // Bersihkan file dump sementara di container
    sh(`docker exec ${cfg.container} rm -f ${containerRestoreDump}`, execFn);
  }
}

if (require.main === module) {
  (async () => {
    const value = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
    return performRestore({ execute: process.argv.includes("--execute"), file: value("--file"),
      confirmPrimary: value("--confirm-primary"), confirmVolume: value("--confirm-volume") });
  })()
    .then((res) => {
      if (res.dryRun) {
        console.log(
          "===========================================================================",
        );
        console.log(
          "[DRY-RUN RESTORE] Simulasi Rencana Restore Database P3 (flashsale_p3)",
        );
        console.log(
          "===========================================================================",
        );
        console.log(`- File Backup        : ${res.backupFile}`);
        console.log(`- Lokasi Arsip       : ${res.backupPath}`);
        console.log(
          `- Ukuran File        : ${(res.sizeBytes / 1024).toFixed(2)} KB`,
        );
        console.log(`- SHA-256 Checksum   : ${res.sha256} [VALID]`);
        console.log(
          `- Objek TOC          : ${res.tocEntries} entitas arsip tervalidasi`,
        );
        console.log(`- Target Container   : ${res.targetContainer}`);
        console.log(`- Target Database    : ${res.targetDb}`);
        console.log(
          `- Koneksi Aktif      : ${res.activeConnections} koneksi (akan diputus saat --execute)`,
        );
        console.log(
          `- Opsi pg_restore    : ${res.pgRestoreOptions.join(" ")}`,
        );
        console.log(
          "---------------------------------------------------------------------------",
        );
        console.log("[STATUS: SIAP UNTUK RESTORE]");
        console.log(
          "Semua validasi integritas, checksum, identitas container, dan role database LOLOS.",
        );
        console.log(
          "TIDAK ADA PERUBAHAN DATA YANG DILAKUKAN PADA DATABASE (DRY-RUN).",
        );
        console.log(
          "Untuk mengeksekusi restore aktual, jalankan dengan flag --execute:",
        );
        console.log("  npm run p4:dr  # inspect the P3 fresh-volume recovery plan first");
        console.log("In-place restore onto the original primary volume is prohibited by DRP v1.1.");
        console.log(
          "===========================================================================",
        );
        process.exit(0);
      } else {
        console.log(
          "===========================================================================",
        );
        console.log(
          "[RESTORE SUKSES] PostgreSQL Database flashsale_p3 Berhasil Dipulihkan!",
        );
        console.log(
          "===========================================================================",
        );
        console.log(`- File Sumber        : ${res.backupFile}`);
        console.log(`- Target Container   : ${res.targetContainer}`);
        console.log(`- Target Database    : ${res.targetDb}`);
        console.log(`- Durasi Restore     : ${res.durationMs} ms`);
        console.log(`- Tabel Orders       : ${res.tableCounts.orders} baris`);
        console.log(`- Tabel Products     : ${res.tableCounts.products} baris`);
        console.log(`- Tabel Users        : ${res.tableCounts.users} baris`);
        console.log(`- Waktu Selesai      : ${res.completedAt}`);
        console.log(
          "===========================================================================",
        );
        process.exit(0);
      }
    })
    .catch((err) => {
      console.error(
        "===========================================================================",
      );
      console.error("[RESTORE GAGAL]", err.message);
      console.error(
        "===========================================================================",
      );
      process.exit(1);
    });
}

module.exports = { performRestore, findLatestBackup };
