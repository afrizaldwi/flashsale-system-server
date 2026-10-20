"use strict";
require("dotenv").config();
const path = require("path");
const express = require("express");
const { primary, readProducts, replicaHealth } = require("./db");
const { isDbUnavailable, sendError } = require("./errors");
const { perProduct } = require("./queries");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "..", "frontend")));

const integer = (n) => Number.isSafeInteger(n) && n > 0;

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

// FR-2, FR-3, FR-4: checkout atomik + idempotent; hanya database primary yang menerima write.
app.post("/checkout", async (req, res) => {
  const key = req.get("Idempotency-Key");
  const { user_id: userId, product_id: productId, qty } = req.body || {};
  if (!key || key.length > 100 || !/^[\x21-\x7E]+$/.test(key)) {
    return res
      .status(400)
      .json({
        error: "BAD_REQUEST",
        message:
          "Idempotency-Key wajib, panjang 1–100 karakter ASCII tanpa spasi.",
      });
  }
  if (!integer(userId) || !integer(productId) || !integer(qty)) {
    return res
      .status(400)
      .json({
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
        ? res
            .status(404)
            .json({
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
    if (client) client.release(releaseError);
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
      : res
          .status(404)
          .json({
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
    failover_mode: "manual",
    time: new Date().toISOString(),
  };
  try {
    const r = await primary.query("SELECT pg_is_in_recovery() AS in_recovery");
    if (r.rows[0].in_recovery) {
      state.status = "degraded";
      state.db = "read_only";
    }
  } catch (_error) {
    state.status = "degraded";
    state.db = "down";
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
    if (client) client.release(releaseError);
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
  app.listen(port, () =>
    console.log(
      `Flash Sale Pertemuan 1 berjalan di http://localhost:${port} (failover: MANUAL)`,
    ),
  );
}
module.exports = app;
