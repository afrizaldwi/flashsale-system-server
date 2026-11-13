/**
 * Demo Race Condition: N user beli produk bersamaan saat stok = 1
 * Skenario: Stok tinggal 1, lalu 2 atau lebih user checkout bersamaan.
 * Jalankan: node scripts/demo/race-condition-demo.js [product_id] [concurrent_buyers] [stock_to_set]
 */
const http = require("http");

const BASE_URL = "http://127.0.0.1:8080";
const PRODUCT_ID = parseInt(process.argv[2]) || 1;
const CONCURRENT_BUYERS = parseInt(process.argv[3]) || 2; // default 2 user seperti skenario user
const STOCK_TO_SET = parseInt(process.argv[4]) || 1;      // default stok 1

function request(method, path, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      "Content-Type": "application/json",
      ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      ...headers,
    };

    const options = {
      hostname: "127.0.0.1",
      port: 8080,
      path,
      method,
      headers: reqHeaders,
    };

    const start = Date.now();
    const req = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => (raw += chunk));
      res.on("end", () => {
        const ms = Date.now() - start;
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw), ms });
        } catch {
          resolve({ status: res.statusCode, body: raw, ms });
        }
      });
    });

    req.on("error", (e) => resolve({ status: 0, body: { error: e.message }, ms: Date.now() - start }));
    if (data) req.write(data);
    req.end();
  });
}

async function getProducts() {
  const res = await request("GET", "/products");
  return Array.isArray(res.body) ? res.body : [];
}

async function resetStock(productId, stock) {
  const res = await request("POST", "/admin/reset-stock", { product_id: productId, stock });
  if (res.status === 200) {
    console.log(`✅ Stok Produk ID ${productId} berhasil di-reset ke: ${res.body.stock}`);
    return true;
  }
  console.log(`⚠️ Gagal reset stok via API (${res.status}):`, res.body);
  return false;
}

async function main() {
  console.log("\n" + "═".repeat(65));
  console.log("   UJI RACE CONDITION: STOK TINGGAL 1 DIBELI BERSAMAAN");
  console.log("═".repeat(65));
  console.log(`► Target Produk ID   : ${PRODUCT_ID}`);
  console.log(`► Jumlah Pembeli     : ${CONCURRENT_BUYERS} User (serentak)`);
  console.log(`► Stok Diset Awal    : ${STOCK_TO_SET}`);
  console.log("═".repeat(65) + "\n");

  // 1. Cek produk dan reset stok
  console.log("📋 [LANGKAH 1] Mengatur stok awal...");
  await resetStock(PRODUCT_ID, STOCK_TO_SET);

  const products = await getProducts();
  const prod = products.find((p) => p.id === PRODUCT_ID);
  if (!prod) {
    console.error(`❌ Produk dengan ID ${PRODUCT_ID} tidak ditemukan!`);
    process.exit(1);
  }
  console.log(`   Nama Produk : "${prod.name}"`);
  console.log(`   Stok Awal   : ${prod.stock} unit\n`);

  // 2. Kirim request serentak
  console.log(`📋 [LANGKAH 2] Mengirim ${CONCURRENT_BUYERS} request checkout bersamaan...`);
  console.log(`   Skenario: User 1 dan User 2 menekan tombol 'Beli' di milidetik yang sama.`);

  const batchTimestamp = Date.now();
  const checkoutPromises = Array.from({ length: CONCURRENT_BUYERS }, (_, i) => {
    const userId = (i % 15) + 1; // Menggunakan User ID 1..15 yang valid di database
    const idempotencyKey = `demo-race-${batchTimestamp}-u${userId}-${i}`;
    
    return request(
      "POST",
      "/checkout",
      { user_id: userId, product_id: PRODUCT_ID, qty: 1 },
      { "Idempotency-Key": idempotencyKey }
    ).then((res) => ({
      userId,
      idempotencyKey,
      status: res.status,
      body: res.body,
      ms: res.ms,
    }));
  });

  // Eksekusi paralel sesungguhnya
  const results = await Promise.all(checkoutPromises);

  // 3. Analisis Transaksi
  console.log("\n📋 [LANGKAH 3] Hasil Penerimaan Transaksi oleh Server:");
  let successCount = 0;
  let soldOutCount = 0;
  let otherErrorCount = 0;

  results.forEach((r) => {
    if (r.status === 201) {
      successCount++;
      const order = r.body?.order;
      console.log(`   [User ${r.userId}] ✅ HTTP 201 CREATED  — TRANSAKSI BERHASIL! (Order ID: ${order?.id}, Waktu: ${r.ms}ms)`);
    } else if (r.status === 409 && (r.body?.error === "SOLD_OUT" || r.body?.message?.includes("Stok") || r.body?.message?.includes("stok"))) {
      soldOutCount++;
      console.log(`   [User ${r.userId}] ⛔ HTTP 409 CONFLICT — DITOLAK (Pesan: "${r.body?.message}", Waktu: ${r.ms}ms)`);
    } else {
      otherErrorCount++;
      console.log(`   [User ${r.userId}] ❌ HTTP ${r.status}          — GAGAL (Response: ${JSON.stringify(r.body)}, Waktu: ${r.ms}ms)`);
    }
  });

  // 4. Verifikasi DB
  console.log("\n📋 [LANGKAH 4] Verifikasi Integritas Database Pasca Transaksi:");
  const productsAfter = await getProducts();
  const prodAfter = productsAfter.find((p) => p.id === PRODUCT_ID);

  console.log(`   • Stok Awal           : ${STOCK_TO_SET}`);
  console.log(`   • Total Checkout Masuk: ${CONCURRENT_BUYERS}`);
  console.log(`   • Transaksi Berhasil  : ${successCount}`);
  console.log(`   • Transaksi Ditolak   : ${soldOutCount}`);
  console.log(`   • Stok Tersisa di DB  : ${prodAfter?.stock}`);

  console.log("\n" + "═".repeat(65));
  console.log("   EVALUASI & PENJELASAN PROSES");
  console.log("═".repeat(65));

  if (successCount === STOCK_TO_SET && prodAfter?.stock === 0 && soldOutCount === (CONCURRENT_BUYERS - STOCK_TO_SET)) {
    console.log("🎉 STATUS: INTEGRITAS DATA TERJAMIN (PASS)");
    console.log(`1. Hanya tepat ${successCount} transaksi yang berhasil dibuat.`);
    console.log(`2. Sisa ${soldOutCount} pengguna yang kalah balapan langsung mendapat HTTP 409 (SOLD OUT).`);
    console.log(`3. Stok tidak minus (stok = ${prodAfter?.stock}), tidak terjadi overselling!`);
  } else if (prodAfter?.stock < 0) {
    console.log("💥 STATUS: OVERSELLING / STOK MINUS TERDETEKSI! (FAIL)");
  } else {
    console.log(`⚠️ Status: successCount=${successCount}, soldOutCount=${soldOutCount}, stock=${prodAfter?.stock}`);
  }
  console.log("═".repeat(65) + "\n");
}

main().catch(console.error);
