"use strict";
/**
 * scripts/docker-failover.js
 * Prosedur Manual Failover PostgreSQL Multi-Container
 * 
 * Standar DRP Kelompok 1 (Pertemuan 1 & 2):
 * 1. Deteksi kegagalan primary
 * 2. Fencing terhadap primary lama (stop container / isolasi)
 * 3. Promosi replica menjadi primary baru (pg_promote)
 * 4. Pengalihan koneksi backend API
 * 5. Pencegahan split-brain
 * 6. Larangan automatic failback tanpa rekonsiliasi
 * 7. Prosedur reintegrasi primary lama sebagai replica baru
 * 
 * Mode:
 *   node scripts/docker-failover.js --plan [p2|p3]       (Default: audit & verifikasi kesiapan)
 *   node scripts/docker-failover.js --promote [p2|p3] --confirm-fenced --allow-promotion
 */

const { execSync } = require("node:child_process");

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 10000 }).trim();
  } catch (err) {
    return null;
  }
}

function getStackConfig(target = "p2") {
  if (target === "p3") {
    return {
      stack: "p3",
      primaryContainer: "flashsale-p3-db-primary-1",
      replicaContainer: "flashsale-p3-db-replica-1",
      dbUser: "p3_admin",
      dbName: "flashsale_p3",
      composeFile: "docker-compose.p3.yml",
      network: "flashsale-p3_p3",
    };
  }
  return {
    stack: "p2",
    primaryContainer: "flashsale-db-primary",
    replicaContainer: "flashsale-db-replica",
    dbUser: "postgres",
    dbName: "flashsale",
    composeFile: "docker-compose.yml",
    network: "flashsale-network",
  };
}

function checkPostgresInContainer(container, user, db, query) {
  const cmd = `docker exec ${container} psql -U ${user} -d ${db} -AtXc "${query}"`;
  return sh(cmd);
}

function isContainerRunning(name) {
  const out = sh(`docker inspect -f "{{.State.Running}}" ${name}`);
  return out === "true";
}

async function main() {
  const args = process.argv.slice(2);
  const isP3 = args.includes("p3");
  const targetStack = isP3 ? "p3" : "p2";
  const cfg = getStackConfig(targetStack);

  const isPromote = args.includes("--promote");
  const isFencedConfirmed = args.includes("--confirm-fenced");
  const isPromotionAllowed = args.includes("--allow-promotion");

  console.log("=".repeat(70));
  console.log(`[DRP Failover] PostgreSQL Multi-Container Failover Manager`);
  console.log(`Target Stack: ${cfg.stack.toUpperCase()} (Primary: ${cfg.primaryContainer}, Replica: ${cfg.replicaContainer})`);
  console.log("=".repeat(70));

  // 1. Audit Primary
  console.log("\n[Langkah 1: Deteksi Status Primary]");
  const primaryRunning = isContainerRunning(cfg.primaryContainer);
  let primaryRecovery = null;
  let replicationStatus = null;

  if (primaryRunning) {
    primaryRecovery = checkPostgresInContainer(cfg.primaryContainer, cfg.dbUser, cfg.dbName, "SELECT pg_is_in_recovery()");
    replicationStatus = checkPostgresInContainer(cfg.primaryContainer, cfg.dbUser, cfg.dbName, "SELECT count(*) FROM pg_stat_replication");
    console.log(`  - Status Container: RUNNING`);
    console.log(`  - Postgres pg_is_in_recovery(): ${primaryRecovery} (t=standby, f=primary/writer)`);
    console.log(`  - Active Replication Clients: ${replicationStatus}`);
  } else {
    console.log(`  - Status Container: STOPPED / UNREACHABLE (Primary Fenced/Down)`);
  }

  // 2. Audit Replica
  console.log("\n[Langkah 2: Deteksi Status Replica (Kandidat Promosi)]");
  const replicaRunning = isContainerRunning(cfg.replicaContainer);
  let replicaRecovery = null;
  let replicaLsn = null;

  if (replicaRunning) {
    replicaRecovery = checkPostgresInContainer(cfg.replicaContainer, cfg.dbUser, cfg.dbName, "SELECT pg_is_in_recovery()");
    replicaLsn = checkPostgresInContainer(cfg.replicaContainer, cfg.dbUser, cfg.dbName, "SELECT pg_last_wal_receive_lsn() || ' / ' || pg_last_wal_replay_lsn()");
    console.log(`  - Status Container: RUNNING`);
    console.log(`  - Postgres pg_is_in_recovery(): ${replicaRecovery} (Wajib 't' untuk dipromosikan)`);
    console.log(`  - WAL Receive/Replay LSN: ${replicaLsn}`);
  } else {
    console.log(`  - Status Container: STOPPED / UNREACHABLE`);
  }

  // 3. Fencing Check
  console.log("\n[Langkah 3: Validasi Fencing & Pencegahan Split-Brain]");
  if (primaryRunning && primaryRecovery === "f") {
    console.log(`  [PERINGATAN KRITIS] Primary lama masih aktif dan dapat menerima write!`);
    console.log(`  Fencing WAJIB dilakukan sebelum promosi replica untuk mencegah Split-Brain:`);
    console.log(`  Jalankan: docker stop ${cfg.primaryContainer}`);
    if (isPromote) {
      console.error("\n[DITOLAK] Promosi digagalkan karena primary lama belum di-fence!");
      process.exit(1);
    }
  } else {
    console.log(`  [OK] Primary lama terisolasi / tidak menerima write.`);
  }

  // 4. Failover Execution or Plan
  if (!isPromote) {
    console.log("\n[Langkah 4: Rencana Eksekusi Manual Failover (Dry-Run / Plan Mode)]");
    console.log("  Untuk mengeksekusi failover jika primary mengalami bencana:");
    console.log(`  1. Fencing: docker stop ${cfg.primaryContainer}`);
    console.log(`  2. Promosi: node scripts/docker-failover.js --promote ${cfg.stack} --confirm-fenced --allow-promotion`);
    console.log(`  3. Alihkan koneksi backend ke replica (${cfg.replicaContainer})`);
    console.log(`  4. Dilarang menghidupkan primary lama secara otomatis (Pencegahan Split-Brain)`);
    console.log(`  5. Rekonsiliasi & reintegrasi primary lama menggunakan scripts/reconcile-old-primary.js`);
    console.log("\n[KESIMPULAN AUDIT]");
    if (primaryRunning && replicaRunning && replicaRecovery === "t") {
      console.log("  Sistem dalam kondisi normal: Streaming replication aktif, Hot Standby siap sebagai failover target.");
    } else {
      console.log(`  Primary Running: ${primaryRunning}, Replica Ready: ${replicaRunning && replicaRecovery === "t"}`);
    }
    return;
  }

  // Promotion branch
  if (!isFencedConfirmed || !isPromotionAllowed) {
    console.error("\n[DITOLAK] Mode --promote membutuhkan flag --confirm-fenced dan --allow-promotion!");
    process.exit(1);
  }

  if (!replicaRunning || replicaRecovery !== "t") {
    console.error("\n[DITOLAK] Target replica tidak dalam kondisi hot standby (recovery mode)!");
    process.exit(1);
  }

  console.log("\n[Langkah 4: Mengeksekusi Promosi Replica]");
  console.log(`  Menjalankan pg_promote() pada ${cfg.replicaContainer}...`);
  const promoteResult = checkPostgresInContainer(cfg.replicaContainer, cfg.dbUser, cfg.dbName, "SELECT pg_promote()");
  console.log(`  Hasil pg_promote(): ${promoteResult}`);

  const postRecovery = checkPostgresInContainer(cfg.replicaContainer, cfg.dbUser, cfg.dbName, "SELECT pg_is_in_recovery()");
  if (postRecovery === "f") {
    console.log(`  [SUKSES] Container ${cfg.replicaContainer} berhasil dipromosikan menjadi PRIMARY BARU!`);
    console.log(`  pg_is_in_recovery() sekarang bernilai: false`);
    console.log("\n[Langkah 5: Prosedur Pasca-Promosi (Tindakan Lanjutan)]");
    console.log(`  1. Alihkan konfigurasi backend agar mengarah ke ${cfg.replicaContainer}`);
    console.log(`  2. Kosongkan parameter DB_REPLICA_HOST (karena saat ini belum ada standby baru)`);
    console.log(`  3. Mulai ulang backend API`);
    console.log(`  4. JANGAN menghidupkan kembali ${cfg.primaryContainer} sebelum rekonsiliasi data!`);
    console.log(`  5. Jalankan: node scripts/reconcile-old-primary.js untuk audit order yang tertinggal.`);
  } else {
    console.error(`  [GAGAL] Promosi belum terkonfirmasi. Status recovery masih: ${postRecovery}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error failover execution:", err.message);
  process.exit(1);
});
