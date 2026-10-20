"use strict";
// Query yang harus menggunakan primary untuk konsistensi data.
const perProduct = `
  SELECT p.id, p.name, p.initial_stock, p.stock,
         p.initial_stock - p.stock AS terpakai,
         COALESCE(SUM(o.qty), 0)::int AS terjual,
         (p.initial_stock - p.stock) - COALESCE(SUM(o.qty), 0)::int AS selisih
    FROM products p LEFT JOIN orders o ON o.product_id = p.id
   GROUP BY p.id ORDER BY p.id`;
module.exports = { perProduct };
