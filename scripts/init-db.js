'use strict';
// database dibuat hanya pada primary; --reset secara eksplisit menghapus semua transaksi.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const base = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  connectionTimeoutMillis: 5000,
};
const name = process.env.DB_NAME || 'flashsale';
const reset = process.argv.includes('--reset');
const file = (f) => fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8');

async function main() {
  if (!/^[a-z][a-z0-9_]*$/i.test(name)) throw new Error('DB_NAME harus menggunakan huruf, angka, underscore; diawali huruf.');
  if (reset) console.warn('PERINGATAN: db:reset akan menghapus SEMUA order dan mengembalikan stok awal.');
  const admin = new Client({ ...base, database: 'postgres' });
  try {
    await admin.connect();
    const role = await admin.query('SELECT pg_is_in_recovery() AS standby');
    if (role.rows[0].standby) throw new Error('DB_HOST/DB_PORT mengarah ke replica read-only, bukan primary.');
    const check = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]);
    if (!check.rowCount) {
      await admin.query(`CREATE DATABASE "${name}"`);
      console.log(`Database ${name} dibuat.`);
    }
  } finally { await admin.end().catch(() => {}); }

  const db = new Client({ ...base, database: name });
  try {
    await db.connect();
    if (reset) {
      await db.query('DROP TABLE IF EXISTS orders, products, users CASCADE');
      console.log('Tabel direset.');
    }
    await db.query(file('schema.sql'));
    const count = await db.query('SELECT COUNT(*)::int AS n FROM products');
    if (!count.rows[0].n) {
      await db.query(file('seed.sql'));
      console.log('Seed: 100 pengguna dummy, 3 produk.');
    } else console.log('Data sebelumnya dipertahankan, seed dilewati.');
    console.log('Database siap.');
  } finally { await db.end().catch(() => {}); }
}
main().catch((error) => { console.error('GAGAL:', error.message); process.exitCode = 1; });
