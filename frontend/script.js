const $ = (id) => document.getElementById(id);
const rupiah = (n) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(n);
let last = null; // request checkout terakhir (untuk simulasi retry klien)

function log(msg, cls = "") {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = `[${new Date().toLocaleTimeString("id-ID")}] ${msg}`;
  $("log").prepend(d);
}

async function checkHealth() {
  try {
    const r = await fetch("/health");
    const ok = r.ok;
    $("health").textContent = ok ? "server ✓ DB up" : "DB DOWN (503)";
    $("health").className = "pill " + (ok ? "ok" : "bad");
  } catch {
    $("health").textContent = "server tidak terjangkau";
    $("health").className = "pill bad";
  }
}

async function loadProducts() {
  try {
    const r = await fetch("/products");
    if (!r.ok) throw new Error(r.status);
    const list = await r.json();
    $("products").innerHTML = "";
    for (const p of list) {
      const pct = p.initial_stock ? (p.stock / p.initial_stock) * 100 : 0;
      const cls = p.stock === 0 ? "out" : pct < 20 ? "low" : "";
      const el = document.createElement("div");
      el.className = "card";
      el.innerHTML = `
        <h3></h3><div class="price">${rupiah(p.price)}</div>
        <div class="meter ${cls}"><i style="width:${pct}%"></i></div>
        <div class="row"><span>Sisa stok</span><b>${p.stock} / ${p.initial_stock}</b></div>
        <div class="buy"><input type="number" min="1" value="1" aria-label="Jumlah"><button ${p.stock === 0 ? "disabled" : ""}>${p.stock === 0 ? "HABIS" : "Beli"}</button></div>`;
      el.querySelector("h3").textContent = p.name;
      el.querySelector("button").onclick = () =>
        checkout(p.id, parseInt(el.querySelector("input").value, 10), p.name);
      $("products").append(el);
    }
  } catch (e) {
    log("Gagal memuat produk (DB mungkin mati)", "bad");
  }
}

async function loadStats() {
  try {
    const r = await fetch("/stats");
    if (!r.ok) throw new Error(r.status);
    const s = await r.json();
    $("consistent").textContent = s.consistent
      ? "consistent: true"
      : "consistent: FALSE";
    $("consistent").className = "pill " + (s.consistent ? "ok" : "bad");
    $("stats").innerHTML = s.products
      .map(
        (p) =>
          `<tr><td>${p.name.replace(/</g, "&lt;")}</td><td>${p.initial_stock}</td><td>${p.stock}</td><td>${p.terjual}</td><td class="${p.selisih === 0 ? "zero" : "nonzero"}">${p.selisih}</td></tr>`,
      )
      .join("");
  } catch {
    $("consistent").textContent = "tidak tersedia";
    $("consistent").className = "pill bad";
  }
}

async function send(req) {
  try {
    const r = await fetch("/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": req.key,
      },
      body: JSON.stringify({
        user_id: req.user_id,
        product_id: req.product_id,
        qty: req.qty,
      }),
    });
    const b = await r.json();
    if (r.status === 201)
      log(`201 CREATED  order #${b.order.id} — ${req.name} x${req.qty}`, "ok");
    else if (r.status === 200)
      log(
        `200 DUPLICATE order #${b.order.id} (key sama, tidak dibuat ulang)`,
        "dup",
      );
    else log(`${r.status} ${b.error}: ${b.message}`, "bad");
  } catch {
    log("Jaringan gagal / server tidak terjangkau", "bad");
  }
  refreshAll();
}

function checkout(product_id, qty, name) {
  if (!Number.isInteger(qty) || qty < 1)
    return log("Jumlah tidak valid", "bad");
  last = {
    key: crypto.randomUUID(),
    user_id: parseInt($("user").value, 10),
    product_id,
    qty,
    name,
  };
  $("lastKey").textContent = last.key.slice(0, 8) + "…";
  $("retry").disabled = false;
  send(last);
}

$("retry").onclick = () => last && send(last);
$("refresh").onclick = () => refreshAll();
function refreshAll() {
  checkHealth();
  loadProducts();
  loadStats();
}

for (let i = 1; i <= 100; i++) $("user").add(new Option("User " + i, i));
refreshAll();
setInterval(checkHealth, 5000);
