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
const mkPool = (host, port, name) => {
  const p = new Pool({ ...base, host, port });
  // Error pada koneksi idle (mis. DB mati) TIDAK boleh menjatuhkan proses backend (NFR-4).
  p.on('error', (err) => console.error(`[pg ${name}] idle client error:`, err.message));
  return p;
};

// Status koneksi database yang sedang dipakai backend ini (bisa berubah saat failover).
const state = {
  primary: mkPool(process.env.DB_HOST || 'localhost', parseInt(process.env.DB_PORT || '5432', 10), 'primary'),
  replica: process.env.DB_REPLICA_HOST
    ? mkPool(process.env.DB_REPLICA_HOST, parseInt(process.env.DB_REPLICA_PORT || '5433', 10), 'replica')
    : null,
  failedOver: false,
  failedOverAt: null,
  primaryFailures: 0,
};

// PRIMARY (master): semua penulisan dan data yang harus akurat. Facade agar server.js selalu
// memakai pool yang AKTIF, termasuk setelah failover.
const primary = {
  query: (...a) => state.primary.query(...a),
  connect: (...a) => state.primary.connect(...a),
};

// REPLICA (slave): hanya baca. Jika replica mati / sudah dipromosikan, bacaan jatuh ke primary.
const hasReplica = () => !!state.replica;
const replicaQuery = (...a) => state.replica.query(...a);

async function readQuery(sql, params) {
  if (state.replica) {
    try {
      return { ...(await state.replica.query(sql, params)), source: 'replica' };
    } catch (err) {
      console.error('[read] replica gagal, fallback ke primary:', err.message);
    }
  }
  return { ...(await state.primary.query(sql, params)), source: 'primary' };
}

// ---------- FAILOVER OTOMATIS ----------
// Watchdog di tiap instance backend: jika primary gagal FAILOVER_THRESHOLD kali berturut-turut,
// replica dipromosikan (pg_promote) dan semua penulisan dialihkan ke replica tersebut.
// Beberapa instance backend aman berjalan bersamaan: yang pertama mempromosikan, yang lain hanya
// mengalihkan koneksi karena replica sudah bukan standby.
const AUTO = process.env.AUTO_FAILOVER !== 'false';
const THRESHOLD = parseInt(process.env.FAILOVER_THRESHOLD || '3', 10);
const INTERVAL = parseInt(process.env.FAILOVER_CHECK_MS || '1000', 10);

async function failover() {
  const rep = state.replica;
  let inRecovery;
  try {
    inRecovery = (await rep.query('SELECT pg_is_in_recovery() AS r')).rows[0].r;
  } catch (err) {
    console.error('[failover] replica juga tidak bisa dihubungi, failover dibatalkan:', err.message);
    return false;
  }
  if (inRecovery) {
    try {
      await rep.query('SELECT pg_promote(true, 30)');
      console.log('[failover] replica DIPROMOSIKAN menjadi primary baru');
    } catch (err) {
      // instance lain mungkin sudah mempromosikan lebih dulu
      const again = (await rep.query('SELECT pg_is_in_recovery() AS r').catch(() => ({ rows: [{ r: true }] }))).rows[0].r;
      if (again) { console.error('[failover] gagal promote:', err.message); return false; }
    }
  } else {
    console.log('[failover] replica sudah menjadi primary (dipromosikan instance lain), mengalihkan koneksi');
  }
  const old = state.primary;
  state.primary = rep;
  state.replica = null;
  state.failedOver = true;
  state.failedOverAt = new Date().toISOString();
  old.end().catch(() => {});
  return true;
}

if (AUTO && state.replica) {
  let busy = false;
  setInterval(async () => {
    if (busy || state.failedOver) return;
    busy = true;
    try {
      try {
        await Promise.race([
          state.primary.query('SELECT 1'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
        ]);
        state.primaryFailures = 0;
      } catch (err) {
        state.primaryFailures++;
        console.error(`[watchdog] primary gagal (${state.primaryFailures}/${THRESHOLD}): ${err.message}`);
        if (state.primaryFailures >= THRESHOLD) await failover();
      }
    } finally { busy = false; }
  }, INTERVAL);
}

const getStatus = () => ({
  failed_over: state.failedOver,
  failed_over_at: state.failedOverAt,
  auto_failover: AUTO && (state.failedOver || !!state.replica),
});

module.exports = { primary, hasReplica, replicaQuery, readQuery, getStatus };
