"use strict";
require("dotenv").config();
const { Pool } = require("pg");

const common = {
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "flashsale",
  max: Number(process.env.DB_POOL_MAX || 20),
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 10000,
};
function makePool(host, port, label) {
  const pool = new Pool({ ...common, host, port: Number(port) });
  // Koneksi idle yang terputus tidak boleh menyebabkan proses Node berhenti.
  pool.on("error", (error) =>
    console.error(`[DB:${label}] koneksi idle gagal:`, error.message),
  );
  return pool;
}

const primary = makePool(
  process.env.DB_HOST || "127.0.0.1",
  process.env.DB_PORT || 5432,
  "primary",
);
const replica = process.env.DB_REPLICA_HOST
  ? makePool(
      process.env.DB_REPLICA_HOST,
      process.env.DB_REPLICA_PORT || 5433,
      "replica",
    )
  : null;

// TIDAK ada watchdog atau auto-promotion. Failover mengikuti DRP bagian 7.1.
// Sesudah promote, operator mengedit .env, menonaktifkan konfigurasi replica lama,
// lalu menghentikan & menjalankan ulang backend dengan DB_PORT mengarah ke primary baru.
async function readProducts(sql, params = []) {
  if (replica) {
    try {
      // Guard: jangan melayani data dari server yang bukan standby sebagai replica.
      const check = await replica.query(
        "SELECT pg_is_in_recovery() AS in_recovery",
      );
      if (check.rows[0].in_recovery) {
        const result = await replica.query(sql, params);
        return { ...result, source: "replica" };
      }
      console.warn(
        "[read] host replica tidak dalam mode recovery; baca dari primary",
      );
    } catch (error) {
      console.warn(
        "[read] replica tidak tersedia, fallback ke primary:",
        error.message,
      );
    }
  }
  const result = await primary.query(sql, params);
  return { ...result, source: "primary" };
}

async function replicaHealth() {
  if (!replica) return { replica: "not_configured" };
  try {
    const r = await replica.query(`
      SELECT pg_is_in_recovery() AS in_recovery,
        CASE
          WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
          WHEN pg_last_xact_replay_timestamp() IS NULL THEN NULL
          ELSE GREATEST(0, EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()))
        END::float AS lag_s
    `);
    if (!r.rows[0].in_recovery)
      return { replica: "not_standby", replica_read_only: false };
    return {
      replica: "up",
      replica_read_only: true,
      replica_lag_seconds:
        r.rows[0].lag_s === null
          ? null
          : Number(Number(r.rows[0].lag_s).toFixed(2)),
    };
  } catch (error) {
    return { replica: "down", replica_error: error.code || "CONNECTION_ERROR" };
  }
}

module.exports = { primary, replica, readProducts, replicaHealth };
