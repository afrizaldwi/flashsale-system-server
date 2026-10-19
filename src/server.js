require("dotenv").config();
const path = require("path");
const express = require("express");
const pool = require("./db");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "frontend")));

// Kode error PostgreSQL / jaringan yang berarti "database tidak tersedia"
const DB_DOWN_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08003",
  "08006",
  "08001",
  "08004",
]);
function isDbDown(err) {
  if (!err) return false;
  if (DB_DOWN_CODES.has(err.code)) return true;
  return /Connection terminated|timeout exceeded when trying to connect|Client has encountered a connection error|the database system is (starting up|shutting down)/i.test(
    err.message || "",
  );
}
function sendError(res, err) {
  if (process.env.DEBUG_ERR)
    console.error("[sendError]", err.code, err.message);
  if (isDbDown(err)) {
    return res
      .status(503)
      .json({
        error: "DB_UNAVAILABLE",
        message:
          "Database tidak tersedia, coba lagi dengan Idempotency-Key yang sama.",
      });
  }
  console.error("[error]", err);
  return res
    .status(500)
    .json({ error: "INTERNAL", message: "Terjadi kesalahan server." });
}

const isInt = (v) => Number.isInteger(v);

// FR-1: daftar produk
app.get("/products", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, price::float AS price, initial_stock, stock FROM products ORDER BY id",
    );
    res.json(rows);
  } catch (err) {
    sendError(res, err);
  }
});

// FR-2, FR-3, FR-4: checkout atomik + idempotent
app.post("/checkout", async (req, res) => {
  const key = req.get("Idempotency-Key");
  const { user_id, product_id, qty } = req.body || {};

  if (!key || key.length > 100) {
    return res
      .status(400)
      .json({
        error: "BAD_REQUEST",
        message: "Header Idempotency-Key wajib (maks 100 karakter).",
      });
  }
  if (!isInt(user_id) || !isInt(product_id) || !isInt(qty) || qty < 1) {
    return res
      .status(400)
      .json({
        error: "BAD_REQUEST",
        message: "user_id, product_id, qty harus integer dan qty >= 1.",
      });
  }

  let client;
  let releaseErr; // jika koneksi rusak, buang client dari pool (jangan dipakai ulang)
  try {
    // Langkah 2: cek apakah key sudah pernah dipakai
    const existing = await pool.query(
      "SELECT * FROM orders WHERE idempotency_key = $1",
      [key],
    );
    if (existing.rows.length) {
      return res
        .status(200)
        .json({ result: "DUPLICATE", order: existing.rows[0] });
    }

    client = await pool.connect();
    await client.query("BEGIN");

    // Langkah 3: kurangi stok secara atomik. Baris dikunci, kondisi WHERE dievaluasi ulang
    // setelah menunggu kunci (READ COMMITTED) sehingga stok tidak pernah minus.
    const upd = await client.query(
      "UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1",
      [qty, product_id],
    );

    if (upd.rowCount === 0) {
      await client.query("ROLLBACK");
      // Pakai koneksi yang SAMA (jangan pool.query: bisa membuat pool kehabisan koneksi / deadlock)
      const p = await client.query("SELECT 1 FROM products WHERE id = $1", [
        product_id,
      ]);
      if (!p.rows.length)
        return res
          .status(404)
          .json({
            error: "PRODUCT_NOT_FOUND",
            message: "Produk tidak ditemukan.",
          });
      return res
        .status(409)
        .json({ error: "SOLD_OUT", message: "Stok tidak mencukupi." });
    }

    // Langkah 5: insert order di transaksi yang sama
    const ins = await client.query(
      `INSERT INTO orders (user_id, product_id, qty, status, idempotency_key)
       VALUES ($1, $2, $3, 'PAID', $4) RETURNING *`,
      [user_id, product_id, qty, key],
    );
    await client.query("COMMIT");
    return res.status(201).json({ result: "CREATED", order: ins.rows[0] });
  } catch (err) {
    if (isDbDown(err)) releaseErr = err;
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {
        releaseErr = releaseErr || _;
      }
    }

    // Bagian 8.3: key sama masuk bersamaan -> unique violation, transaksi dibatalkan (stok ikut batal)
    if (err.code === "23505") {
      try {
        const dup = await client.query(
          "SELECT * FROM orders WHERE idempotency_key = $1",
          [key],
        );
        if (dup.rows.length)
          return res
            .status(200)
            .json({ result: "DUPLICATE", order: dup.rows[0] });
      } catch (e2) {
        return sendError(res, e2);
      }
    }
    // user_id tidak ada (FK)
    if (err.code === "23503") {
      return res
        .status(400)
        .json({ error: "BAD_REQUEST", message: "user_id tidak valid." });
    }
    return sendError(res, err);
  } finally {
    if (client) client.release(releaseErr);
  }
});

// FR-5: detail pesanan
app.get("/orders/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res
      .status(400)
      .json({
        error: "BAD_REQUEST",
        message: "ID pesanan harus integer positif.",
      });
  }
  try {
    const { rows } = await pool.query(
      `SELECT o.*, p.name AS product_name, u.name AS user_name
         FROM orders o JOIN products p ON p.id = o.product_id JOIN users u ON u.id = o.user_id
        WHERE o.id = $1`,
      [id],
    );
    if (!rows.length)
      return res
        .status(404)
        .json({
          error: "ORDER_NOT_FOUND",
          message: "Pesanan tidak ditemukan.",
        });
    res.json(rows[0]);
  } catch (err) {
    sendError(res, err);
  }
});

// FR-6: health check mencerminkan status DB
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "up", time: new Date().toISOString() });
  } catch (err) {
    res
      .status(503)
      .json({ status: "degraded", db: "down", time: new Date().toISOString() });
  }
});

// FR-7: statistik / verifikasi invarian (dipakai sebagai bukti DR Test)
app.get("/stats", async (req, res) => {
  try {
    const perProduct = await pool.query(`
      SELECT p.id, p.name, p.initial_stock, p.stock,
             p.initial_stock - p.stock AS terpakai,
             COALESCE(SUM(o.qty), 0)::int AS terjual,
             (p.initial_stock - p.stock) - COALESCE(SUM(o.qty), 0)::int AS selisih
        FROM products p LEFT JOIN orders o ON o.product_id = p.id
       GROUP BY p.id ORDER BY p.id`);
    const neg = await pool.query(
      "SELECT COUNT(*)::int AS n FROM products WHERE stock < 0",
    );
    const dup = await pool.query(`SELECT COUNT(*)::int AS n FROM (
        SELECT idempotency_key FROM orders GROUP BY idempotency_key HAVING COUNT(*) > 1) t`);
    const tot = await pool.query(
      "SELECT COUNT(*)::int AS orders, COALESCE(SUM(qty),0)::int AS qty FROM orders",
    );

    const negative_stock = neg.rows[0].n;
    const duplicate_orders = dup.rows[0].n;
    const mismatched = perProduct.rows.filter((r) => r.selisih !== 0).length;

    res.json({
      consistent:
        negative_stock === 0 && duplicate_orders === 0 && mismatched === 0,
      negative_stock,
      duplicate_orders,
      mismatched_products: mismatched,
      total_orders: tot.rows[0].orders,
      total_qty_sold: tot.rows[0].qty,
      products: perProduct.rows,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Jaring pengaman: backend tidak boleh mati karena error tak terduga
process.on("unhandledRejection", (e) =>
  console.error("[unhandledRejection]", e),
);
process.on("uncaughtException", (e) => console.error("[uncaughtException]", e));

const PORT = parseInt(process.env.PORT || "3000", 10);
app.listen(PORT, () =>
  console.log(`Flash Sale API berjalan di http://localhost:${PORT}`),
);
