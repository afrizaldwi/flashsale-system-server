/**
 * Demo: Race Condition / Anti-Overselling Test
 * Skenario: stok = 1, N user beli bersamaan → hanya 1 yang boleh berhasil
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE_URL = 'http://127.0.0.1:8080';
const PRODUCT_ID = __ENV.PRODUCT_ID || 1;
const CONCURRENT_BUYERS = parseInt(__ENV.VUS || '10');

const successOrders = new Counter('success_orders');
const failedOrders  = new Counter('failed_orders');
const oversellRate  = new Rate('oversell_detected');

export const options = {
  scenarios: {
    race: {
      executor: 'shared-iterations',   // semua VU mulai di waktu bersamaan
      vus: CONCURRENT_BUYERS,
      iterations: CONCURRENT_BUYERS,   // tepat 1 iterasi per VU
      maxDuration: '30s',
    },
  },
  thresholds: {
    // oversell tidak boleh pernah terjadi
    oversell_detected: ['rate == 0'],
  },
};

// Setup: reset stok ke 1 sebelum test
export function setup() {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   RACE CONDITION TEST — Anti-Overselling     ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`► Produk ID   : ${PRODUCT_ID}`);
  console.log(`► Pembeli     : ${CONCURRENT_BUYERS} user checkout BERSAMAAN`);
  console.log(`► Stok awal   : akan di-set ke 1`);
  console.log('► Yang boleh berhasil: HANYA 1\n');

  // Reset stok produk ke 1
  const reset = http.post(`${BASE_URL}/admin/reset-stock`, JSON.stringify({
    product_id: parseInt(PRODUCT_ID),
    stock: 1
  }), { headers: { 'Content-Type': 'application/json' } });

  if (reset.status !== 200) {
    console.error(`❌ Gagal reset stok: ${reset.status} ${reset.body}`);
  } else {
    const body = JSON.parse(reset.body);
    console.log(`✅ Stok direset ke: ${body.stock}`);
  }

  // Verifikasi stok
  const check_stock = http.get(`${BASE_URL}/products/${PRODUCT_ID}`);
  const product = JSON.parse(check_stock.body);
  console.log(`► Stok terverifikasi: ${product.stock}\n`);

  return { product_id: parseInt(PRODUCT_ID), stock_before: product.stock };
}

export default function (data) {
  const userId = `user_race_${__VU}`;

  // Semua VU checkout produk yang sama BERSAMAAN
  const payload = JSON.stringify({
    user_id: userId,
    product_id: data.product_id,
    quantity: 1,
  });

  const res = http.post(`${BASE_URL}/checkout`, payload, {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'checkout_race' },
  });

  const isSuccess = res.status === 200;
  const isOutOfStock = res.status === 400 || res.status === 409;

  if (isSuccess) {
    successOrders.add(1);
    const body = JSON.parse(res.body);
    console.log(`✅ BERHASIL  — VU ${__VU} (${userId}): order_id=${body.order_id || body.id}, sisa stok=${body.remaining_stock ?? '?'}`);
  } else if (isOutOfStock) {
    failedOrders.add(1);
    console.log(`⛔ DITOLAK   — VU ${__VU} (${userId}): ${res.status} → ${res.body.substring(0, 80)}`);
  } else {
    failedOrders.add(1);
    console.log(`❌ ERROR     — VU ${__VU} (${userId}): ${res.status} → ${res.body.substring(0, 80)}`);
  }
}

// Teardown: verifikasi DB — stok tidak boleh minus, order tidak boleh > stok awal
export function teardown(data) {
  sleep(1);

  // Cek stok akhir
  const stockRes = http.get(`${BASE_URL}/products/${data.product_id}`);
  const product = JSON.parse(stockRes.body);
  const finalStock = product.stock;

  // Hitung total order di DB
  const ordersRes = http.get(`${BASE_URL}/admin/orders?product_id=${data.product_id}&run=race`);
  let totalOrders = '?';
  let negativeStock = false;
  let oversell = false;

  try {
    const orders = JSON.parse(ordersRes.body);
    totalOrders = orders.count ?? orders.length ?? '?';
  } catch(e) {}

  negativeStock = finalStock < 0;
  oversell = (typeof totalOrders === 'number') && totalOrders > data.stock_before;

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║            HASIL RACE CONDITION TEST         ║');
  console.log('╠══════════════════════════════════════════════╣');
  console.log(`║  Stok awal         : ${data.stock_before}`);
  console.log(`║  Stok akhir        : ${finalStock}  ${finalStock < 0 ? '❌ MINUS!' : finalStock === 0 ? '✅' : '✅'}`);
  console.log(`║  Pembeli bersamaan : ${CONCURRENT_BUYERS} user`);
  console.log(`║  Order berhasil    : (lihat success_orders di summary)`);
  console.log(`║  Order ditolak     : (lihat failed_orders di summary)`);
  console.log(`║  Overselling?      : ${oversell ? '❌ YA — OVERSELL TERJADI!' : '✅ TIDAK — Stok aman'}`);
  console.log(`║  Stok minus?       : ${negativeStock ? '❌ YA — BUG!' : '✅ TIDAK'}`);
  console.log('╚══════════════════════════════════════════════╝\n');

  oversellRate.add(oversell ? 1 : 0);
}

