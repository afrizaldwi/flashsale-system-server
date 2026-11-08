"use strict";
/**
 * scripts/reconcile-old-primary.js
 * Alat bantu DRP Rekonsiliasi Transaksi Tertinggal (Tail Orders) Pasca-Failover
 *
 * Standar DRP Kelompok 1:
 * - Default HANYA LAPORAN (dry-run).
 * - Mode --apply membutuhkan flag REVIEWED=YES setelah verifikasi manual operator.
 * - Old primary harus dijalankan terisolasi dari aplikasi dan dalam mode READ-ONLY.
 * - Menggunakan Idempotency-Key asli sehingga tidak menimbulkan pesanan ganda.
 * - TIDAK menggabungkan dua timeline WAL PostgreSQL secara otomatis.
 * - Konflik stok (HTTP 409) dan error tidak dikenal ditandai untuk penanganan manual.
 *
 * PENTING - ISOLASI STACK P2 vs P3:
 * - P2 menggunakan database 'flashsale' pada host port 5432 / 5433.
 * - P3 menggunakan database 'flashsale_p3' di dalam network internal Docker (p3).
 *   P3 TIDAK mempublikasikan port ke host dan TIDAK BOLEH mengakses port 5432/5433 P2.
 *   Konektivitas P3 dilakukan secara aman melalui mekanisme Docker Exec pada container P3.
 *
 * Penggunaan:
 *   node scripts/reconcile-old-primary.js [--stack p2|p3]             (Dry-Run Audit)
 *   node scripts/reconcile-old-primary.js [--stack p2|p3] --apply     (Memerlukan REVIEWED=YES)
 */

require("dotenv").config();
const { execSync } = require("node:child_process");
const { ResilientClient: Client } = require("../src/db-client");

const DRP_STACKS = {
  p2: {
    stack: "p2",
    expectedDb: "flashsale",
    defaultUser: "postgres",
    defaultPass: process.env.POSTGRES_PASSWORD || "P@ssw0rd",
    connectionMethod: "tcp",
    oldHost: "127.0.0.1",
    oldPort: 5432,
    newHost: "127.0.0.1",
    newPort: 5433,
    apiBase: "http://127.0.0.1",
  },
  p3: {
    stack: "p3",
    expectedDb: "flashsale_p3",
    defaultUser: "p3_admin",
    defaultPass: process.env.P3_DB_PASSWORD || "",
    connectionMethod: "docker_exec",
    oldContainer: "flashsale-p3-db-primary-1",
    newContainer: "flashsale-p3-db-replica-1",
    apiBase: "http://127.0.0.1:8080",
  },
};

function getReconcileConfig(args = process.argv.slice(2)) {
  const isP3 = args.includes("p3") || args.includes("--stack=p3") || (args.includes("--stack") && args[args.indexOf("--stack") + 1] === "p3");
  const stack = isP3 ? "p3" : "p2";
  const def = DRP_STACKS[stack];
  const apply = args.includes("--apply");
  const confirmFenced = args.includes("--confirm-fenced") || process.env.FENCING_CONFIRMED === "YES";

  if (!def) {
    throw new Error(`Stack tidak dikenal: '${stack}'. Gunakan 'p2' atau 'p3'.`);
  }

  const cfg = {
    stack,
    apply,
    reportOnly: !apply,
    confirmFenced,
    fencedProof: Boolean(confirmFenced),
    expectedDb: def.expectedDb,
    connectionMethod: def.connectionMethod,
    apiBase: (process.env.RECOVERY_API_URL || def.apiBase).replace(/\/$/, ""),
    dbUser: process.env.DB_USER || def.defaultUser,
    dbPassword: process.env.DB_PASSWORD || def.defaultPass,
    dbName: process.env.DB_NAME || def.expectedDb,
    reviewed: process.env.REVIEWED === "YES" || args.includes("--reviewed"),
  };

  if (stack === "p2") {
    cfg.oldHost = process.env.OLD_PRIMARY_HOST || def.oldHost;
    cfg.oldPort = Number(process.env.OLD_PRIMARY_PORT || def.oldPort);
    cfg.newHost = process.env.NEW_PRIMARY_HOST || def.newHost;
    cfg.newPort = Number(process.env.NEW_PRIMARY_PORT || def.newPort);
  } else {
    cfg.oldContainer = process.env.OLD_PRIMARY_CONTAINER || def.oldContainer;
    cfg.newContainer = process.env.NEW_PRIMARY_CONTAINER || def.newContainer;
  }

  // Validasi isolasi: Jangan izinkan P3 menggunakan koneksi TCP port P2
  if (stack === "p3" && (process.env.OLD_PRIMARY_PORT === "5432" || process.env.NEW_PRIMARY_PORT === "5433")) {
    throw new Error("P3 dilarang mengakses port 5432/5433 milik P2 (cross-stack contamination). Gunakan docker_exec.");
  }

  return cfg;
}

function findPendingOrders(oldOrders = [], newOrders = []) {
  const known = new Set(newOrders.map((r) => r.idempotency_key).filter(Boolean));
  const pending = [];
  const unidentifiable = [];

  for (const o of oldOrders) {
    if (!o.idempotency_key || typeof o.idempotency_key !== "string" || !o.idempotency_key.trim()) {
      unidentifiable.push(o);
    } else if (!known.has(o.idempotency_key)) {
      pending.push(o);
    }
  }

  pending.unidentifiable = unidentifiable;
  return pending;
}

function classifyReconcileOutcome(status, body = {}) {
  if (status === 201 && (body.result === "CREATED" || body.order?.id)) {
    return {
      action: "RECOVERED",
      description: "Berhasil dipulihkan ke primary baru.",
      needsCompensation: false,
      needsInvestigation: false,
    };
  }
  if (status === 200 && (body.result === "DUPLICATE" || body.order?.id)) {
    return {
      action: "ALREADY_COMMITTED",
      description: "Pesanan sudah tercatat di primary baru (idempotent).",
      needsCompensation: false,
      needsInvestigation: false,
    };
  }
  if (status === 409 && (body.error === "SOLD_OUT" || body.message?.includes("Stok"))) {
    return {
      action: "STOCK_EXHAUSTED",
      description: "Stok habis pada primary baru. PERLU KOMPENSASI MANUAL (refund/pemberitahuan).",
      needsCompensation: true,
      needsInvestigation: false,
    };
  }
  return {
    action: "UNKNOWN_OUTCOME",
    description: `Respons tidak terduga HTTP ${status}: ${body.message || body.error || "error"}. BUTUH INVESTIGASI.`,
    needsCompensation: false,
    needsInvestigation: true,
  };
}

/**
 * Preflight HTTP ke endpoint health API destination.
 * Memvalidasi identitas database (expectedDb) dan bahwa API terhubung ke primary writer (bukan standby).
 */
async function verifyTargetApi(apiBase, expectedDb, fetchFn = fetch) {
  let res, body;
  try {
    res = await fetchFn(`${apiBase}/health`, { method: "GET" });
    body = await res.json();
  } catch (err) {
    throw new Error(`Preflight API destination ke ${apiBase}/health gagal: ${err.message}`);
  }

  if (res.status !== 200 || body.status !== "ok" || body.db !== "up") {
    throw new Error(
      `Preflight API destination gagal: HTTP ${res.status}, status='${body?.status}', db='${body?.db}'`
    );
  }

  // Validasi identitas database
  if (body.database && body.database !== expectedDb) {
    throw new Error(
      `API destination database mismatch: target API (${apiBase}) terhubung ke database '${body.database}', diharapkan '${expectedDb}'. Dibatalkan untuk mencegah kontaminasi lintas stack!`
    );
  }

  // Validasi bahwa API terhubung ke primary writer, bukan standby
  if (body.in_recovery === true) {
    throw new Error(
      `API destination target (${apiBase}) terhubung ke database standby (in_recovery=true); target API wajib terhubung ke primary writer!`
    );
  }

  return {
    ok: true,
    database: body.database,
    db_server_ip: body.db_server_ip,
    db_host: body.db_host,
    in_recovery: body.in_recovery,
  };
}

/**
 * Adapter database untuk membaca orders dengan isolasi stack terjamin.
 */
class DbAdapter {
  static create(cfg, execFn = execSync) {
    if (cfg.connectionMethod === "docker_exec") {
      return new DockerExecAdapter(cfg, execFn);
    }
    return new TcpClientAdapter(cfg);
  }
}

class DockerExecAdapter {
  constructor(cfg, execFn = execSync) {
    this.cfg = cfg;
    this.execFn = execFn;
  }

  querySql(container, sql, readOnly = false) {
    const envOpt = readOnly ? '-e PGOPTIONS="-c default_transaction_read_only=on" ' : "";
    const cmd = `docker exec ${envOpt}${container} psql -U ${this.cfg.dbUser} -d ${this.cfg.dbName} -AtXc "${sql}"`;
    try {
      const out = this.execFn(cmd, { encoding: "utf8", timeout: 15000 });
      return { success: true, output: out.trim(), error: null };
    } catch (err) {
      return { success: false, output: null, error: (err.stderr || err.message || "").toString().trim() };
    }
  }

  async validateAndFetch() {
    // 1. Validasi database identity dan status role pada old container
    const oldCheck = this.querySql(
      this.cfg.oldContainer,
      "SELECT current_database(), pg_is_in_recovery(), current_setting('default_transaction_read_only')"
    );
    if (!oldCheck.success) {
      throw new Error(`Gagal menghubungi old primary container (${this.cfg.oldContainer}): ${oldCheck.error}`);
    }
    const [oldDb, oldRecovery, oldReadOnly] = oldCheck.output.split("|");
    if (oldDb !== this.cfg.expectedDb) {
      throw new Error(`Database mismatch pada old container: aktual '${oldDb}', diharapkan '${this.cfg.expectedDb}'`);
    }

    // Evaluasi status read-write dan fencing old primary
    const isOldStandby = oldRecovery === "t";
    const isFencedConfirmed = this.cfg.fencedProof === true || process.env.FENCING_CONFIRMED === "YES" || this.cfg.confirmFenced === true;

    if (!isOldStandby && !isFencedConfirmed) {
      if (this.cfg.apply) {
        throw new Error(
          `Old primary container (${this.cfg.oldContainer}) masih berstatus read-write tanpa konfirmasi fencing definitif (FENCING_CONFIRMED=YES)! ` +
          `default_transaction_read_only=on bukan bukti fencing definitif. Mode --apply ditolak untuk mencegah split-brain.`
        );
      } else {
        console.warn(
          `[PERINGATAN FENCING] Old primary container (${this.cfg.oldContainer}) berstatus read-write. ` +
          `default_transaction_read_only=on atau sesi transaksi lokal BUKAN bukti fencing definitif. ` +
          `Pembacaan tail orders dilanjutkan dalam transaksi READ ONLY untuk keperluan audit/inspeksi.`
        );
      }
    }

    // 2. Validasi database identity dan status writer pada new container
    const newCheck = this.querySql(this.cfg.newContainer, "SELECT current_database(), pg_is_in_recovery()");
    if (!newCheck.success) {
      throw new Error(`Gagal menghubungi new primary container (${this.cfg.newContainer}): ${newCheck.error}`);
    }
    const [newDb, newRecovery] = newCheck.output.split("|");
    if (newDb !== this.cfg.expectedDb) {
      throw new Error(`Database mismatch pada new container: aktual '${newDb}', diharapkan '${this.cfg.expectedDb}'`);
    }
    if (this.cfg.apply) {
      if (newRecovery === "t") {
        throw new Error(`Target new container (${this.cfg.newContainer}) masih berstatus standby recovery mode! Batalkan --apply.`);
      }
      if (newRecovery !== "f") {
        throw new Error(`Role target new container tidak dapat dipastikan (pg_is_in_recovery: '${newRecovery}'). Batalkan --apply.`);
      }
    } else {
      if (newRecovery === "t") {
        console.warn(`[INFORMASI AUDIT] Target new container (${this.cfg.newContainer}) berstatus standby. Pembacaan orders dilakukan untuk audit/inspeksi.`);
      }
    }

    // 3. Fetch orders dari old container dengan proteksi sesi transaksi read-only
    const oldOrdersRaw = this.querySql(
      this.cfg.oldContainer,
      "BEGIN TRANSACTION READ ONLY; SELECT COALESCE(json_agg(o), '[]'::json) FROM (SELECT id, idempotency_key, user_id, product_id, qty, created_at FROM orders ORDER BY created_at, id) o; COMMIT;",
      true
    );
    if (!oldOrdersRaw.success) {
      throw new Error(`Gagal membaca orders dari old container: ${oldOrdersRaw.error}`);
    }

    // 4. Fetch orders dari new container
    const newOrdersRaw = this.querySql(
      this.cfg.newContainer,
      "SELECT COALESCE(json_agg(o), '[]'::json) FROM (SELECT idempotency_key FROM orders) o"
    );
    if (!newOrdersRaw.success) {
      throw new Error(`Gagal membaca orders dari new container: ${newOrdersRaw.error}`);
    }

    // Parsing JSON output (ekstrak hasil json_agg)
    const extractJson = (raw) => {
      const match = raw.match(/\[.*\]/s);
      return match ? JSON.parse(match[0]) : [];
    };

    const oldOrders = extractJson(oldOrdersRaw.output);
    const newOrders = extractJson(newOrdersRaw.output);

    return { oldOrders, newOrders, oldDb, newDb };
  }

  async close() {}
}

class TcpClientAdapter {
  constructor(cfg) {
    this.cfg = cfg;
    this.baseClient = {
      user: cfg.dbUser,
      password: cfg.dbPassword,
      database: cfg.dbName,
      connectionTimeoutMillis: 4000,
    };
    this.old = new Client({ ...this.baseClient, host: cfg.oldHost, port: cfg.oldPort });
    this.current = new Client({ ...this.baseClient, host: cfg.newHost, port: cfg.newPort });
  }

  async validateAndFetch() {
    await this.old.connect();
    await this.current.connect();

    // 1. Validasi database identity dan status role
    const oldDbRes = await this.old.query(
      "SELECT current_database() AS db, pg_is_in_recovery() AS in_recovery, current_setting('default_transaction_read_only') AS read_only"
    );
    const newDbRes = await this.current.query(
      "SELECT current_database() AS db, pg_is_in_recovery() AS in_recovery"
    );

    const oldDb = oldDbRes.rows[0]?.db;
    const oldRecovery = oldDbRes.rows[0]?.in_recovery;
    const oldReadOnlySetting = oldDbRes.rows[0]?.read_only;

    const newDb = newDbRes.rows[0]?.db;
    const inRecovery = newDbRes.rows[0]?.in_recovery;

    if (oldDb !== this.cfg.expectedDb || newDb !== this.cfg.expectedDb) {
      throw new Error(`Database identity mismatch! Diharapkan '${this.cfg.expectedDb}', didapat old='${oldDb}', new='${newDb}'`);
    }

    // Old primary evaluasi status read-write dan fencing
    const isOldStandby = oldRecovery === true || oldRecovery === "t";
    const isFencedConfirmed = this.cfg.fencedProof === true || process.env.FENCING_CONFIRMED === "YES" || this.cfg.confirmFenced === true;

    if (!isOldStandby && !isFencedConfirmed) {
      if (this.cfg.apply) {
        throw new Error(
          `Old primary (${this.cfg.oldHost}:${this.cfg.oldPort}) masih berstatus read-write tanpa bukti fencing definitif (FENCING_CONFIRMED=YES)! ` +
          `default_transaction_read_only=on atau koneksi sesi lokal BUKAN bukti fencing definitif. ` +
          `Mode --apply dibatalkan untuk mencegah split-brain.`
        );
      } else {
        console.warn(
          `[PERINGATAN FENCING] Old primary (${this.cfg.oldHost}:${this.cfg.oldPort}) berstatus read-write. ` +
          `default_transaction_read_only=on atau sesi lokal BUKAN bukti fencing definitif. ` +
          `Pembacaan dilanjutkan dalam BEGIN TRANSACTION READ ONLY untuk audit/inspeksi.`
        );
      }
    }

    if (this.cfg.apply) {
      if (inRecovery === true) {
        throw new Error("Target NEW_PRIMARY masih dalam mode standby; batalkan rekonsiliasi.");
      }
      if (inRecovery !== false) {
        throw new Error(`Role NEW_PRIMARY tidak dapat dipastikan (in_recovery=${inRecovery}); batalkan.`);
      }
    } else {
      if (inRecovery === true) {
        console.warn(`[INFORMASI AUDIT] Target NEW_PRIMARY (${this.cfg.newHost}:${this.cfg.newPort}) berstatus standby; pembacaan data dilakukan untuk inspeksi audit.`);
      }
    }

    // Terapkan default_transaction_read_only dan verifikasi pada sesi lokal
    await this.old.query("SET default_transaction_read_only = on");
    const verifyRo = await this.old.query("SHOW transaction_read_only");
    if (verifyRo.rows[0]?.transaction_read_only !== "on") {
      throw new Error("Gagal menetapkan koneksi old primary menjadi read-only; batalkan rekonsiliasi.");
    }

    await this.old.query("BEGIN TRANSACTION READ ONLY");
    let oldOrderRes;
    try {
      oldOrderRes = await this.old.query(
        "SELECT id, idempotency_key, user_id, product_id, qty, created_at FROM orders ORDER BY created_at, id"
      );
    } finally {
      await this.old.query("COMMIT");
    }

    const newOrderRes = await this.current.query("SELECT idempotency_key FROM orders");

    return {
      oldOrders: oldOrderRes.rows,
      newOrders: newOrderRes.rows,
      oldDb,
      newDb,
    };
  }

  async close() {
    await this.old.end().catch(() => {});
    await this.current.end().catch(() => {});
  }
}

async function runReconciliation(cfg = getReconcileConfig()) {
  if (cfg.stack === "p2" && cfg.oldHost === cfg.newHost && cfg.oldPort === cfg.newPort) {
    throw new Error(
      `Old primary (${cfg.oldHost}:${cfg.oldPort}) dan new primary (${cfg.newHost}:${cfg.newPort}) tidak boleh menunjuk instance yang sama.`
    );
  }

  if (cfg.apply && !cfg.reviewed) {
    throw new Error(
      "Mode --apply memerlukan konfirmasi variabel lingkungan REVIEWED=YES setelah verifikasi manual operator."
    );
  }

  // Preflight HTTP ke API destination:
  // Mode --apply WAJIB berhasil lolos validasi database dan primary writer sebelum mengirim transaksi
  const fetchImpl = cfg.fetchFn || fetch;
  let apiPreflight = null;
  if (cfg.apply) {
    apiPreflight = await verifyTargetApi(cfg.apiBase, cfg.expectedDb, fetchImpl);
  } else {
    try {
      apiPreflight = await verifyTargetApi(cfg.apiBase, cfg.expectedDb, fetchImpl);
    } catch (preErr) {
      apiPreflight = { verified: false, error: preErr.message };
    }
  }

  const adapter = DbAdapter.create(cfg);

  try {
    const { oldOrders, newOrders, oldDb, newDb } = await adapter.validateAndFetch();
    const pending = findPendingOrders(oldOrders, newOrders);
    const unidentifiable = pending.unidentifiable || [];

    const counts = {
      recovered: 0,
      already_committed: 0,
      stock_exhausted: 0,
      unknown_outcome: 0,
      unidentifiable: unidentifiable.length,
    };

    const summary = {
      mode: cfg.reportOnly ? "DRY_RUN (Audit Only)" : "APPLY (Replay to New Primary)",
      stack: cfg.stack.toUpperCase(),
      database_verified: oldDb,
      connection_method: cfg.connectionMethod,
      old_target: cfg.stack === "p2" ? `${cfg.oldHost}:${cfg.oldPort}` : cfg.oldContainer,
      new_target: cfg.stack === "p2" ? `${cfg.newHost}:${cfg.newPort}` : cfg.newContainer,
      api_base: cfg.apiBase,
      api_preflight: apiPreflight,
      old_orders_count: oldOrders.length,
      new_orders_count: newOrders.length,
      tail_orders_count: pending.length,
      unidentifiable_orders_count: unidentifiable.length,
    };

    console.log("=".repeat(75));
    console.log("[RECONCILIATION AUDIT - VERIFIKASI IDENTITAS STACK]");
    console.log(JSON.stringify(summary, null, 2));
    console.log("=".repeat(75));

    if (unidentifiable.length > 0) {
      console.log(`\n[PERINGATAN] Ditemukan ${unidentifiable.length} order pada old primary tanpa Idempotency-Key:`);
      for (const u of unidentifiable) {
        console.log(`  - [ORDER TIDAK TERIDENTIFIKASI] ID: ${u.id || "N/A"} | User: ${u.user_id} | Product: ${u.product_id} | Qty: ${u.qty} -> BUTUH PEMERIKSAAN MANUAL`);
      }
    }

    if (pending.length === 0 && unidentifiable.length === 0) {
      console.log("\n[OK] Tidak ada tail orders yang tertinggal. Seluruh transaksi sudah tersinkronisasi.");
      return {
        summary,
        pending: [],
        unidentifiable: [],
        applied: [],
        counts,
        finalStatus: "COMPLETE",
        exitCode: 0,
      };
    }

    if (pending.length > 0) {
      console.log(`\nDitemukan ${pending.length} transaksi pada old primary yang belum tercatat di new primary:`);
    }
    const results = [];

    for (const order of pending) {
      if (cfg.reportOnly) {
        console.log(`  - [PERLU DITINJAU] Key: ${order.idempotency_key} | User: ${order.user_id} | Product: ${order.product_id} | Qty: ${order.qty}`);
        continue;
      }

      let status = 0, body = {};
      try {
        const response = await fetchImpl(`${cfg.apiBase}/checkout`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": order.idempotency_key,
          },
          body: JSON.stringify({
            user_id: order.user_id,
            product_id: order.product_id,
            qty: order.qty,
          }),
        });
        status = response.status;
        body = await response.json();
      } catch (reqErr) {
        status = 0;
        body = { error: reqErr.message };
      }

      const outcome = classifyReconcileOutcome(status, body);
      if (outcome.action === "RECOVERED") counts.recovered++;
      else if (outcome.action === "ALREADY_COMMITTED") counts.already_committed++;
      else if (outcome.action === "STOCK_EXHAUSTED") counts.stock_exhausted++;
      else counts.unknown_outcome++;

      console.log(`  - Key: ${order.idempotency_key} -> HTTP ${status} [${outcome.action}]: ${outcome.description}`);
      results.push({ order, status, body, outcome });
    }

    let finalStatus = "COMPLETE";
    let exitCode = 0;

    if (cfg.reportOnly) {
      finalStatus = "COMPLETE";
      exitCode = 0;
      console.log("\n[AUDIT SELESAI] Mode dry-run selesai. Tidak ada transaksi yang dikirim atau dipulihkan.");
    } else {
      if (counts.stock_exhausted > 0 || counts.unknown_outcome > 0 || unidentifiable.length > 0) {
        finalStatus = "PARTIAL";
        exitCode = 1;
        console.log(`\n[STATUS: PARTIAL] Rekonsiliasi selesai dengan hasil parsial. Perlu penanganan manual:`);
        console.log(`  - Recovered: ${counts.recovered}`);
        console.log(`  - Already Committed: ${counts.already_committed}`);
        console.log(`  - Stock Exhausted: ${counts.stock_exhausted}`);
        console.log(`  - Unknown Outcome: ${counts.unknown_outcome}`);
        if (unidentifiable.length > 0) {
          console.log(`  - Unidentifiable (Needs Manual Review): ${unidentifiable.length}`);
        }
      } else {
        finalStatus = "COMPLETE";
        exitCode = 0;
        console.log(`\n[STATUS: COMPLETE] Seluruh ${pending.length} tail orders berhasil dipulihkan secara penuh.`);
      }
    }

    console.log("\n[PERINGATAN DRP KELOMPOK 1]");
    console.log("1. Periksa endpoint /stats pada primary baru untuk memverifikasi konsistensi invarian stok.");
    console.log("2. JANGAN PERNAH menyatukan dua timeline WAL PostgreSQL secara otomatis (timeline merge is forbidden).");
    console.log("3. Setelah rekonsiliasi selesai, inisialisasi ulang old primary dari new primary via pg_basebackup.");

    return {
      summary,
      pending,
      applied: results,
      counts,
      finalStatus,
      exitCode,
    };
  } finally {
    await adapter.close();
  }
}

module.exports = {
  getReconcileConfig,
  findPendingOrders,
  classifyReconcileOutcome,
  verifyTargetApi,
  runReconciliation,
  DbAdapter,
  DockerExecAdapter,
  TcpClientAdapter,
  DRP_STACKS,
};

if (require.main === module) {
  runReconciliation()
    .then((res) => {
      process.exit(res.exitCode);
    })
    .catch((err) => {
      console.error("RECONCILIATION GAGAL:", err.message);
      process.exit(1);
    });
}
