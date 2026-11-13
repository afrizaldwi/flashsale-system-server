"use strict";
require("dotenv").config();
const path = require("path");
const os = require("node:os");
const express = require("express");
const { primary, readProducts, replicaHealth } = require("./db");
const { isDbUnavailable, sendError } = require("./errors");
const { perProduct } = require("./queries");
const db = require("./db");
const { releaseClient } = require("./db-client");
const { installLifecycle } = require("./lifecycle");
const observation =
  process.env.P3_OBSERVABILITY === "1"
    ? require("./observability").createObservability(db.poolStats)
    : null;

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Backend-Id", process.env.HOSTNAME || os.hostname());
  next();
});
if (observation) app.use(observation.middleware);
app.use(express.json({ limit: "32kb" }));

// P5: Jika CDN_URL diset, aset gambar dilayani dari CDN Edge (MinIO + Nginx cache).
// Jika tidak, fallback ke express.static untuk kompatibilitas mundur (P1-P4).
const CDN_URL = process.env.CDN_URL || null;
if (!CDN_URL) {
  // Mode lama (P1–P4): Node.js melayani file statis secara langsung.
  app.use(express.static(path.join(__dirname, "..", "frontend")));
} else {
  // Mode P5: Hanya index.html + script/style dari Node.js;
  // gambar/aset diarahkan ke CDN Edge.
  app.use(express.static(path.join(__dirname, "..", "frontend"), {
    index: ["index.html"],
    // Jangan layani subfolder images — ditangani CDN
    setHeaders: (res) => res.setHeader("X-Served-By", "app-server"),
  }));
  console.log(`[P5] CDN mode aktif: aset statis dari ${CDN_URL}`);
}

// FR-P5: endpoint untuk mendapatkan CDN base URL (digunakan frontend)
app.get("/cdn-config", (_req, res) =>
  res.json({
    cdn_url: CDN_URL || null,
    asset_base: CDN_URL ? `${CDN_URL}/assets` : "/images",
    mode: CDN_URL ? "cdn" : "local",
  })
);

const integer = (n) => Number.isSafeInteger(n) && n > 0;

app.get("/live", (_req, res) => res.json({ live: true }));
app.get("/ready", async (_req, res) => {
  try {
    const state = await db.readiness();
    return res.status(state.ready ? 200 : 503).json(state);
  } catch (_error) {
    return res.status(503).json({ ready: false, error: "DB_UNAVAILABLE" });
  }
});

// FR-1: daftar produk dari replica (dengan fallback primary).
app.get("/products", async (_req, res) => {
  try {
    const result = await readProducts(
      "SELECT id, name, price::float AS price, initial_stock, stock FROM products ORDER BY id",
    );
    return res.set("X-Read-From", result.source).json(result.rows);
  } catch (error) {
    return sendError(res, error);
  }
});

// DEMO: reset stok produk untuk keperluan pengujian race condition
app.post("/admin/reset-stock", async (req, res) => {
  const { product_id, stock } = req.body || {};
  if (!product_id || stock === undefined || stock < 0) {
    return res.status(400).json({ error: "product_id dan stock (>=0) wajib diisi." });
  }
  try {
    const result = await primary.query(
      "UPDATE products SET stock = $1 WHERE id = $2 RETURNING id, name, stock",
      [stock, product_id]
    );
    if (result.rowCount === 0)
      return res.status(404).json({ error: "Produk tidak ditemukan." });
    return res.json({ message: "Stok direset", ...result.rows[0] });
  } catch (error) {
    return sendError(res, error);
  }
});

// DEMO: hitung total order per produk untuk verifikasi anti-overselling
app.get("/admin/orders", async (req, res) => {
  const { product_id } = req.query;
  try {
    const q = product_id
      ? await primary.query(
          "SELECT COUNT(*) AS count FROM orders WHERE product_id = $1 AND status = 'PAID'",
          [product_id]
        )
      : await primary.query("SELECT COUNT(*) AS count FROM orders WHERE status = 'PAID'");
    return res.json({ count: parseInt(q.rows[0].count) });
  } catch (error) {
    return sendError(res, error);
  }
});

// FR-2, FR-3, FR-4: checkout atomik + idempotent; hanya database primary yang menerima write.
app.post("/checkout", async (req, res) => {
  const key = req.get("Idempotency-Key");
  const { user_id: userId, product_id: productId, qty } = req.body || {};
  if (!key || key.length > 100 || !/^[\x21-\x7E]+$/.test(key)) {
    return res.status(400).json({
      error: "BAD_REQUEST",
      message:
        "Idempotency-Key wajib, panjang 1–100 karakter ASCII tanpa spasi.",
    });
  }
  if (!integer(userId) || !integer(productId) || !integer(qty)) {
    return res.status(400).json({
      error: "BAD_REQUEST",
      message: "user_id, product_id, qty harus integer positif.",
    });
  }

  let client;
  let releaseError;
  try {
    // Pre-check mengoptimalkan retry; UNIQUE constraint tetap proteksi utama saat request serentak.
    const existing = await primary.query(
      "SELECT * FROM orders WHERE idempotency_key = $1",
      [key],
    );
    if (existing.rows.length)
      return res
        .status(200)
        .json({ result: "DUPLICATE", order: existing.rows[0] });

    client = await primary.connect();
    await client.query("BEGIN");
    // Serialisasikan request dengan key sama. Tanpa ini, retry serentak pada stok terakhir
    // dapat memperoleh SOLD_OUT alih-alih DUPLICATE sebelum transaksi pertama commit.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [key],
    );
    const existingInsideTx = await client.query(
      "SELECT * FROM orders WHERE idempotency_key = $1",
      [key],
    );
    if (existingInsideTx.rows.length) {
      await client.query("COMMIT");
      return res
        .status(200)
        .json({ result: "DUPLICATE", order: existingInsideTx.rows[0] });
    }
    // UPDATE atomik: menjamin stock >= 0 walaupun request bersamaan.
    const changed = await client.query(
      "UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1",
      [qty, productId],
    );
    if (changed.rowCount === 0) {
      await client.query("ROLLBACK");
      const found = await client.query("SELECT 1 FROM products WHERE id = $1", [
        productId,
      ]);
      return found.rowCount === 0
        ? res.status(404).json({
            error: "PRODUCT_NOT_FOUND",
            message: "Produk tidak ditemukan.",
          })
        : res
            .status(409)
            .json({ error: "SOLD_OUT", message: "Stok tidak mencukupi." });
    }

    const inserted = await client.query(
      `
      INSERT INTO orders (user_id, product_id, qty, status, idempotency_key)
      VALUES ($1, $2, $3, 'PAID', $4) RETURNING *`,
      [userId, productId, qty, key],
    );
    await client.query("COMMIT");
    return res.status(201).json({ result: "CREATED", order: inserted.rows[0] });
  } catch (error) {
    if (isDbUnavailable(error)) releaseError = error;
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = rollbackError;
      }
    }
    // UNIQUE(idempotency_key) menangani dua request bersamaan dengan key yang sama.
    if (error.code === "23505") {
      try {
        // Query dengan client dalam transaksi yang telah di-rollback tidak memboroskan pool.
        const duplicate = await client.query(
          "SELECT * FROM orders WHERE idempotency_key = $1",
          [key],
        );
        if (duplicate.rows.length)
          return res
            .status(200)
            .json({ result: "DUPLICATE", order: duplicate.rows[0] });
      } catch (other) {
        return sendError(res, other);
      }
    }
    if (error.code === "23503")
      return res
        .status(400)
        .json({ error: "BAD_REQUEST", message: "user_id tidak ditemukan." });
    return sendError(res, error);
  } finally {
    if (client) releaseClient(client, releaseError);
  }
});

app.get("/orders/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!integer(id))
    return res
      .status(400)
      .json({ error: "BAD_REQUEST", message: "ID pesanan tidak valid." });
  try {
    const result = await primary.query(
      `
      SELECT o.*, p.name AS product_name, u.name AS user_name
        FROM orders o JOIN products p ON p.id=o.product_id JOIN users u ON u.id=o.user_id
       WHERE o.id=$1`,
      [id],
    );
    return result.rows.length
      ? res.json(result.rows[0])
      : res.status(404).json({
          error: "ORDER_NOT_FOUND",
          message: "Pesanan tidak ditemukan.",
        });
  } catch (error) {
    return sendError(res, error);
  }
});

// Primary down: /health 503, tetapi status replica masih dilaporkan.
app.get("/health", async (_req, res) => {
  const state = {
    status: "ok",
    db: "up",
    database: null,
    in_recovery: null,
    server_ip: null,
    db_server_ip: null,
    db_host: process.env.DB_HOST || "unknown",
    failover_mode: "manual",
    time: new Date().toISOString(),
  };
  try {
    const r = await primary.query(
      "SELECT current_database() AS database, pg_is_in_recovery() AS in_recovery, host(inet_server_addr()) AS server_ip"
    );
    state.database = r.rows[0].database;
    state.in_recovery = r.rows[0].in_recovery;
    const dbIp = (r.rows[0].server_ip || "").replace(/\/.*$/, "");
    state.server_ip = dbIp;
    state.db_server_ip = dbIp;
    if (r.rows[0].in_recovery) {
      state.status = "degraded";
      state.db = "read_only";
    }
  } catch (_error) {
    state.status = "degraded";
    state.db = "down";
    state.database = null;
    state.in_recovery = null;
    state.server_ip = null;
    state.db_server_ip = null;
  }
  Object.assign(state, await replicaHealth());
  return res.status(state.db === "up" ? 200 : 503).json(state);
});

app.get("/stats", async (_req, res) => {
  let client;
  let releaseError;
  try {
    client = await primary.connect();
    // Seluruh metrik dibaca pada snapshot yang sama, sekalipun checkout berlangsung serentak.
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    const products = await client.query(perProduct);
    const neg = await client.query(
      "SELECT COUNT(*)::int AS n FROM products WHERE stock < 0",
    );
    const dups = await client.query(
      "SELECT COUNT(*)::int AS n FROM (SELECT idempotency_key FROM orders GROUP BY idempotency_key HAVING COUNT(*) > 1) dup",
    );
    const total = await client.query(
      "SELECT COUNT(*)::int AS orders, COALESCE(SUM(qty),0)::int AS qty FROM orders",
    );
    await client.query("COMMIT");
    const mismatched = products.rows.filter((p) => p.selisih !== 0).length;
    const negative = neg.rows[0].n;
    const duplicate = dups.rows[0].n;
    return res.json({
      consistent: negative === 0 && duplicate === 0 && mismatched === 0,
      negative_stock: negative,
      duplicate_orders: duplicate,
      mismatched_products: mismatched,
      total_orders: total.rows[0].orders,
      total_qty_sold: total.rows[0].qty,
      products: products.rows,
    });
  } catch (error) {
    if (isDbUnavailable(error)) releaseError = error;
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = rollbackError;
      }
    }
    return sendError(res, error);
  } finally {
    if (client) releaseClient(client, releaseError);
  }
});

// Error JSON parsing tidak boleh membunuh proses.
app.use((error, _req, res, _next) => {
  if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
    return res
      .status(400)
      .json({ error: "BAD_REQUEST", message: "JSON tidak valid." });
  }
  return sendError(res, error);
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  const server = app.listen(port, () =>
    console.log(
      `Flash Sale Pertemuan 1 berjalan di http://localhost:${port} (failover: MANUAL)`,
    ),
  );
  const management = observation?.listen(db.readiness);
  installLifecycle(server, {
    management,
    close: db.close,
    onDrain: () => observation?.drain(),
    onClosed: () => observation?.close(),
  });
}
module.exports = app;
