'use strict';
// Verifikasi pada primary: exit code 0 hanya jika invarians benar dan server writable.
require('dotenv').config();
const { Client } = require('pg');
const { perProduct } = require('../src/queries');
const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'flashsale',
});
async function run() {
  try {
    await db.connect();
    const writable = await db.query('SELECT NOT pg_is_in_recovery() AS writable');
    const stats = await db.query(perProduct);
    const neg = stats.rows.filter((r) => r.stock < 0);
    const mismatch = stats.rows.filter((r) => r.selisih !== 0);
    const dup = await db.query('SELECT idempotency_key, COUNT(*)::int AS n FROM orders GROUP BY idempotency_key HAVING COUNT(*) > 1');
    console.table(stats.rows.map(({ name, initial_stock, stock, terjual, selisih }) => ({ name, initial_stock, stock, terjual, selisih })));
    const ok = writable.rows[0].writable && neg.length === 0 && mismatch.length === 0 && dup.rowCount === 0;
    console.log(JSON.stringify({ primary_writable: writable.rows[0].writable, negative_stock: neg.length, duplicate_orders: dup.rowCount, mismatched_products: mismatch.length, consistent: ok }, null, 2));
    if (!ok) process.exitCode = 1;
  } finally { await db.end().catch(() => {}); }
}
run().catch((error) => { console.error('GAGAL:', error.message); process.exitCode = 1; });
