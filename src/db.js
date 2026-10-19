require('dotenv').config();
const { Pool } = require('pg');

const base = {
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'flashsale',
  max: parseInt(process.env.DB_POOL_MAX || '20', 10),   // pool <= 20 per server DB
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 10000,
};

// PRIMARY (master): semua penulisan (checkout) dan data yang harus akurat (/stats, /orders).
const primary = new Pool({
  ...base,
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
});

// REPLICA (slave): hanya baca (daftar produk). Opsional.
const hasReplica = !!process.env.DB_REPLICA_HOST;
const replica = hasReplica
  ? new Pool({
      ...base,
      host: process.env.DB_REPLICA_HOST,
      port: parseInt(process.env.DB_REPLICA_PORT || '5433', 10),
    })
  : null;

// Error pada koneksi idle (mis. DB mati) TIDAK boleh menjatuhkan proses backend (NFR-4).
primary.on('error', (err) => console.error('[pg primary] idle client error:', err.message));
if (replica) replica.on('error', (err) => console.error('[pg replica] idle client error:', err.message));

// Baca dari replica; jika replica mati, otomatis jatuh ke primary (read failover).
async function readQuery(sql, params) {
  if (replica) {
    try {
      return { ...(await replica.query(sql, params)), source: 'replica' };
    } catch (err) {
      console.error('[read] replica gagal, fallback ke primary:', err.message);
    }
  }
  return { ...(await primary.query(sql, params)), source: 'primary' };
}

module.exports = { primary, replica, hasReplica, readQuery };
