'use strict';
// Alat bantu DRP bagian 7.4 (dipakai ketika dibutuhkan pada Pertemuan 4).
// Default HANYA LAPORAN (dry-run). --apply membutuhkan REVIEWED=YES dan backend
// harus sudah menunjuk primary BARU. Old primary harus dijalankan terisolasi
// dari aplikasi, hanya untuk pembacaan. Tidak otomatis menghapus database.
require('dotenv').config();
const { Client } = require('pg');
const apply = process.argv.includes('--apply');
const reportOnly = !apply;
const newHost = process.env.NEW_PRIMARY_HOST || '127.0.0.1';
const newPort = Number(process.env.NEW_PRIMARY_PORT || 5433);
const oldHost = process.env.OLD_PRIMARY_HOST || '127.0.0.1';
const oldPort = Number(process.env.OLD_PRIMARY_PORT || 5434);
const apiBase = (process.env.RECOVERY_API_URL || 'http://localhost:3000').replace(/\/$/, '');
const base = {
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'flashsale',
  connectionTimeoutMillis: 3000,
};

async function main() {
  if (oldHost === newHost && oldPort === newPort) throw new Error('Old primary dan new primary tidak boleh menunjuk instance yang sama.');
  if (apply && process.env.REVIEWED !== 'YES') throw new Error('Mode --apply memerlukan REVIEWED=YES setelah verifikasi manual.');
  const old = new Client({ ...base, host: oldHost, port: oldPort });
  const current = new Client({ ...base, host: newHost, port: newPort });
  try {
    await old.connect(); await current.connect();
    await old.query('SET default_transaction_read_only = on');
    const check = await current.query('SELECT pg_is_in_recovery() AS recovery');
    if (check.rows[0].recovery) throw new Error('NEW_PRIMARY masih standby, batalkan rekonsiliasi.');
    const oldOrder = await old.query('SELECT idempotency_key, user_id, product_id, qty FROM orders ORDER BY created_at, id');
    const newOrder = await current.query('SELECT idempotency_key FROM orders');
    const known = new Set(newOrder.rows.map(r => r.idempotency_key));
    const pending = oldOrder.rows.filter(o => !known.has(o.idempotency_key));
    console.log(JSON.stringify({ mode: reportOnly ? 'DRY_RUN' : 'APPLY', old_orders: oldOrder.rowCount, new_orders: newOrder.rowCount, tail_orders: pending.length }, null, 2));
    for (const order of pending) {
      if (reportOnly) {
        console.log('PERLU DITINJAU:', order);
        continue;
      }
      // POST /checkout menggunakan order key yang ASLI agar aman dari duplikasi.
      const response = await fetch(`${apiBase}/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': order.idempotency_key },
        body: JSON.stringify({ user_id: order.user_id, product_id: order.product_id, qty: order.qty }),
      });
      const body = await response.json();
      console.log(`${order.idempotency_key}: HTTP ${response.status} ${body.error || body.result || ''}`);
      if (response.status === 409) console.log('  PERLU KOMPENSASI MANUAL: stok tidak mencukupi; review refund/pemberitahuan.');
      if (![200, 201, 409].includes(response.status)) console.log('  BUTUH INVESTIGASI: transaksi gagal atau status tidak pasti.');
    }
    console.log('PENTING: verifikasi /stats, audit pembayaran simulasi, dan jangan menyatukan dua timeline PostgreSQL otomatis.');
  } finally { await old.end().catch(() => {}); await current.end().catch(() => {}); }
}
main().catch((error) => { console.error('RECONCILIATION GAGAL:', error.message); process.exitCode = 1; });
