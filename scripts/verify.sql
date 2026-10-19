-- Query validasi integritas (DRP bagian 9). Jalankan: psql -U postgres -d flashsale -f scripts/verify.sql
-- V1. Stok minus -> harus 0 baris
SELECT id, name, stock FROM products WHERE stock < 0;
-- V2. Order ganda -> harus 0 baris
SELECT idempotency_key, COUNT(*) FROM orders GROUP BY idempotency_key HAVING COUNT(*) > 1;
-- V3. Invarian stok vs order -> kolom selisih harus 0 untuk semua produk
SELECT p.id, p.name, p.initial_stock, p.stock,
       p.initial_stock - p.stock AS terpakai,
       COALESCE(SUM(o.qty), 0) AS terjual,
       (p.initial_stock - p.stock) - COALESCE(SUM(o.qty), 0) AS selisih
FROM products p LEFT JOIN orders o ON o.product_id = p.id
GROUP BY p.id ORDER BY p.id;
