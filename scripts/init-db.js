// Membuat database + skema + data awal. Pakai --reset untuk mengembalikan data ke kondisi awal.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const cfg = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
};
const dbName = process.env.DB_NAME || 'flashsale';
const reset = process.argv.includes('--reset');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'db', f), 'utf8');

(async () => {
  const admin = new Client({ ...cfg, database: 'postgres' });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!exists.rows.length) {
    await admin.query(`CREATE DATABASE "${dbName}"`);
    console.log(`Database "${dbName}" dibuat.`);
  }
  await admin.end();

  const db = new Client({ ...cfg, database: dbName });
  await db.connect();
  if (reset) {
    await db.query('DROP TABLE IF EXISTS orders, products, users CASCADE');
    console.log('Tabel lama dihapus (reset).');
  }
  await db.query(read('schema.sql'));
  const { rows } = await db.query('SELECT COUNT(*)::int AS n FROM products');
  if (rows[0].n === 0) {
    await db.query(read('seed.sql'));
    console.log('Data awal dimasukkan.');
  } else {
    console.log('Data sudah ada, seed dilewati (gunakan --reset untuk mengulang).');
  }
  await db.end();
  console.log('Selesai.');
})().catch((e) => { console.error('Gagal:', e.message); process.exit(1); });
