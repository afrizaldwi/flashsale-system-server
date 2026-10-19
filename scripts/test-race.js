// Uji race condition + idempotency terhadap API yang sedang berjalan.
// Pemakaian: node scripts/test-race.js [BASE_URL] [JUMLAH_REQUEST]
const BASE = process.argv[2] || "http://localhost:3000";
const N = parseInt(process.argv[3] || "300", 10);
const crypto = require("crypto");

const post = (key, body) =>
  fetch(`${BASE}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

(async () => {
  const before = await (await fetch(`${BASE}/products`)).json();
  const target = before.find((p) => p.stock > 0) || before[0];
  console.log(`Target: ${target.name} (stok awal ${target.stock})`);

  // 1) N pembeli berbeda berebut produk yang sama, serentak
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      post(crypto.randomUUID(), {
        user_id: (i % 100) + 1,
        product_id: target.id,
        qty: 1,
      }),
    ),
  );
  const count = {};
  results.forEach((r) => {
    count[r.status] = (count[r.status] || 0) + 1;
  });
  console.log("Status respons:", count);

  // 2) Satu key dikirim 20x serentak -> harus tepat 1 order
  const sameKey = crypto.randomUUID();
  const before2 = await (await fetch(`${BASE}/stats`)).json();
  const dups = await Promise.all(
    Array.from({ length: 20 }, () =>
      post(sameKey, {
        user_id: 1,
        product_id: before.find((p) => p.id !== target.id).id,
        qty: 1,
      }),
    ),
  );
  const ids = new Set(
    dups.filter((r) => r.body.order).map((r) => r.body.order.id),
  );
  const after2 = await (await fetch(`${BASE}/stats`)).json();
  console.log(
    `Key sama x20 -> order unik: ${ids.size}, order bertambah: ${after2.total_orders - before2.total_orders}`,
  );

  const stats = await (await fetch(`${BASE}/stats`)).json();
  console.log(
    "Stats:",
    JSON.stringify({
      consistent: stats.consistent,
      negative_stock: stats.negative_stock,
      duplicate_orders: stats.duplicate_orders,
      mismatched_products: stats.mismatched_products,
    }),
  );
  const ok =
    stats.consistent &&
    ids.size === 1 &&
    after2.total_orders - before2.total_orders === 1;
  console.log(
    ok ? "LULUS: tidak ada overselling & tidak ada order ganda" : "GAGAL",
  );
  process.exit(ok ? 0 : 1);
})();
