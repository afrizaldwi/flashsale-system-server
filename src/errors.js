"use strict";
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
  "08001",
  "08003",
  "08004",
  "08006",
  "53300",
  "53400",
  "25006",
]);
function isDbUnavailable(error) {
  if (!error) return false;
  return (
    DB_DOWN_CODES.has(error.code) ||
    /Connection terminated|connection error|timeout exceeded|the database system is (starting up|shutting down)|sorry, too many clients/i.test(
      error.message || "",
    )
  );
}
function sendError(res, error) {
  if (isDbUnavailable(error)) {
    return res.status(503).json({
      error: "DB_UNAVAILABLE",
      message:
        "Database tidak tersedia. Ulangi permintaan dengan Idempotency-Key yang sama setelah pulih.",
    });
  }
  console.error("[server error]", error);
  return res
    .status(500)
    .json({ error: "INTERNAL", message: "Terjadi kesalahan server." });
}
module.exports = { isDbUnavailable, sendError };
