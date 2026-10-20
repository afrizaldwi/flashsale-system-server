"use strict";
const $ = (id) => document.getElementById(id);
const rupiah = (n) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(n);
let lastRequest = null;

function log(message, color = "") {
  const line = document.createElement("div");
  line.className = color;
  line.textContent = `[${new Date().toLocaleTimeString("id-ID")}] ${message}`;
  $("log").prepend(line);
}
async function health() {
  try {
    const response = await fetch("/health");
    const h = await response.json();
    const rep =
      h.replica === "not_configured"
        ? "(tanpa replica)"
        : `(replica: ${h.replica})`;
    $("health").textContent = response.ok
      ? `Primary UP ${rep}`
      : `Primary DOWN ${rep}`;
    $("health").className = `pill ${response.ok ? "ok" : "bad"}`;
  } catch {
    $("health").textContent = "Backend tidak tersedia";
    $("health").className = "pill bad";
  }
}
async function products() {
  try {
    const response = await fetch("/products");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    $("readSource").textContent =
      `Sumber data produk: ${response.headers.get("X-Read-From") || "tidak diketahui"}`;
    $("products").replaceChildren();
    for (const item of data) {
      const card = document.createElement("article");
      card.className = "card";
      const name = document.createElement("h3");
      name.textContent = item.name;
      const price = document.createElement("div");
      price.className = "price";
      price.textContent = rupiah(item.price);
      const pct = item.initial_stock
        ? Math.min(100, Math.max(0, (item.stock / item.initial_stock) * 100))
        : 0;
      const meter = document.createElement("div");
      meter.className = `meter ${item.stock === 0 ? "out" : pct < 20 ? "low" : ""}`;
      const indicator = document.createElement("i");
      indicator.style.width = `${pct}%`;
      meter.append(indicator);
      const info = document.createElement("div");
      info.className = "row";
      const label = document.createElement("span");
      label.textContent = "Sisa stok";
      const count = document.createElement("b");
      count.textContent = `${item.stock} / ${item.initial_stock}`;
      info.append(label, count);
      const buy = document.createElement("div");
      buy.className = "buy";
      const qty = document.createElement("input");
      qty.type = "number";
      qty.min = "1";
      qty.step = "1";
      qty.value = "1";
      qty.setAttribute("aria-label", "Jumlah pembelian");
      const button = document.createElement("button");
      button.textContent = item.stock ? "Beli" : "HABIS";
      button.disabled = !item.stock;
      button.addEventListener("click", () =>
        checkout(item.id, Number(qty.value), item.name),
      );
      buy.append(qty, button);
      card.append(name, price, meter, info, buy);
      $("products").append(card);
    }
  } catch (error) {
    $("readSource").textContent = "Produk tidak tersedia";
    log(`Gagal memuat katalog: ${error.message}`, "bad");
  }
}
async function stats() {
  try {
    const response = await fetch("/stats");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    $("consistent").textContent = `consistent: ${data.consistent}`;
    $("consistent").className = `pill ${data.consistent ? "ok" : "bad"}`;
    $("stats").replaceChildren();
    for (const row of data.products) {
      const tr = document.createElement("tr");
      for (const [i, value] of [
        row.name,
        row.initial_stock,
        row.stock,
        row.terjual,
        row.selisih,
      ].entries()) {
        const td = document.createElement("td");
        td.textContent = value;
        if (i === 4) td.className = value === 0 ? "zero" : "nonzero";
        tr.append(td);
      }
      $("stats").append(tr);
    }
  } catch {
    $("consistent").textContent = "Data primary tidak tersedia";
    $("consistent").className = "pill bad";
    $("stats").replaceChildren();
  }
}
async function send(data) {
  try {
    const response = await fetch("/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": data.key,
      },
      body: JSON.stringify({
        user_id: data.user_id,
        product_id: data.product_id,
        qty: data.qty,
      }),
    });
    const body = await response.json();
    if (response.status === 201)
      log(`201 CREATED — #${body.order.id}, ${data.name} x${data.qty}`, "ok");
    else if (response.status === 200)
      log(`200 DUPLICATE — #${body.order.id}, key sama`, "dup");
    else
      log(
        `${response.status}: ${body.message || body.error || "error"}`,
        "bad",
      );
  } catch {
    log(
      "Koneksi terputus; klik retry dengan key yang sama setelah pulih.",
      "bad",
    );
  }
  refresh();
}
function checkout(productId, qty, name) {
  if (!Number.isSafeInteger(qty) || qty <= 0)
    return log("Qty harus integer positif.", "bad");
  const userId = Number($("user").value);
  lastRequest = {
    key: crypto.randomUUID(),
    user_id: userId,
    product_id: productId,
    qty,
    name,
  };
  $("lastKey").textContent = lastRequest.key.slice(0, 8) + "…";
  $("retry").disabled = false;
  send(lastRequest);
}
function refresh() {
  health();
  products();
  stats();
}
$("retry").addEventListener("click", () => {
  if (lastRequest) send(lastRequest);
});
$("refresh").addEventListener("click", refresh);
for (let i = 1; i <= 100; i++)
  $("user").add(new Option(`User ${i}`, String(i)));
refresh();
setInterval(health, 5000);
