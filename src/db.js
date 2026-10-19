require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "5432", 10),
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "flashsale",
  max: parseInt(process.env.DB_POOL_MAX || "20", 10), // pool <= 20 sesuai spesifikasi
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 10000,
});

// Error pada koneksi idle (mis. DB mati) TIDAK boleh menjatuhkan proses backend (NFR-4).
pool.on("error", (err) => {
  console.error("[pg pool] idle client error:", err.message);
});

module.exports = pool;
