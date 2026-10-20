"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isDbUnavailable } = require("../src/errors");
const { perProduct } = require("../src/queries");
const source = (name) =>
  fs.readFileSync(path.join(__dirname, "..", name), "utf8");

test("error koneksi dan penutupan DB diklasifikasikan sebagai unavailable", () => {
  for (const code of ["ECONNREFUSED", "08006", "57P01", "ETIMEDOUT"]) {
    assert.equal(isDbUnavailable({ code, message: "" }), true);
  }
  assert.equal(isDbUnavailable({ code: "23505", message: "duplicate" }), false);
});
test("query verifikasi menghitung ketidaksesuaian stok terhadap order", () => {
  assert.match(perProduct, /initial_stock\s*-\s*p\.stock/);
  assert.match(perProduct, /SUM\(o\.qty\)/);
  assert.match(perProduct, /AS selisih/);
});
test("skema melindungi stok nonnegatif dan idempotency key unik", () => {
  const schema = source("db/schema.sql");
  assert.match(schema, /CHECK \(stock >= 0\)/);
  assert.match(schema, /idempotency_key VARCHAR\(100\) NOT NULL UNIQUE/);
});
test("automatic failover tidak ada pada konfigurasi Pertemuan 1", () => {
  const db = source("src/db.js");
  assert.doesNotMatch(db, /pg_promote\(/);
  assert.doesNotMatch(db, /setInterval\(/);
});
