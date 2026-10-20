'use strict';
// Integration test, memerlukan npm start + PostgreSQL.
// Cara: npm run test:race -- http://localhost:3000 300
const { randomUUID } = require('crypto');
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const count = Number(process.argv[3] || 300);
if (!Number.isInteger(count) || count < 1 || count > 10000) {
  console.error('Jumlah request harus 1–10000.'); process.exit(2);
}
const get = async (route) => {
  const response = await fetch(base + route);
  if (!response.ok) throw new Error(`${route} -> ${response.status}`);
  return response.json();
};
const post = async (key, productId, userId = 1) => {
  const response = await fetch(base + '/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify({ user_id: userId, product_id: productId, qty: 1 }),
  });
  return { status: response.status, body: await response.json() };
};
(async () => {
  const products = await get('/products');
  // Gunakan dua produk yang MASIH memiliki stok, bukan selalu produk indeks 0 dan 1.
  // Stok produk pertama bisa habis akibat pengujian sebelumnya tanpa merusak data.
  const [popular, secondary] = products.filter((p) => Number(p.stock) > 0);
  if (!popular || !secondary) {
    const summary = products.map((p) => `${p.name}: ${p.stock}`).join(', ');
    throw new Error(`Test memerlukan minimal dua produk berbeda dengan stok > 0. Stok saat ini: ${summary}. Gunakan database khusus UJI jika perlu reset.`);
  }
  console.log(`Produk race: ${popular.name} (stok ${popular.stock}); produk idempotency: ${secondary.name} (stok ${secondary.stock})`);
  const before = await get('/stats');
  const rush = await Promise.all(Array.from({ length: count }, (_, i) => post(randomUUID(), popular.id, i % 100 + 1)));
  const codes = {};
  rush.forEach(({ status }) => { codes[status] = (codes[status] || 0) + 1; });
  console.log('Checkout paralel:', codes);

  const key = randomUUID();
  const previous = await get('/stats');
  const retries = await Promise.all(Array.from({ length: 20 }, () => post(key, secondary.id)));
  const after = await get('/stats');
  const unique = new Set(retries.filter((r) => r.body.order).map((r) => r.body.order.id));
  const newOrder = after.total_orders - previous.total_orders;
  console.log('Idempotency test: order unik', unique.size, '; pertambahan order', newOrder);
  console.log('Statistik akhir:', JSON.stringify({ consistent: after.consistent, negative_stock: after.negative_stock, duplicate_orders: after.duplicate_orders, mismatched_products: after.mismatched_products }));
  const ok = after.consistent && unique.size === 1 && newOrder === 1 &&
    rush.every((r) => [201, 409].includes(r.status)) && after.total_orders >= before.total_orders;
  console.log(ok ? 'LULUS' : 'GAGAL');
  if (!ok) process.exitCode = 1;
})().catch((error) => { console.error('GAGAL:', error); process.exitCode = 1; });
