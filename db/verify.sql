-- DRP bagian 9. Jalankan hanya pada primary yang AKTIF.
-- V1: output harus kosong.
SELECT id, name, stock FROM products WHERE stock < 0;
-- V2: output harus kosong.
SELECT idempotency_key, COUNT(*) FROM orders
GROUP BY idempotency_key HAVING COUNT(*) > 1;
-- V3: semua selisih harus nol.
SELECT p.id, p.name, p.initial_stock, p.stock,
       (p.initial_stock - p.stock) AS terpakai,
       COALESCE(SUM(o.qty), 0)::INT AS terjual,
       ((p.initial_stock - p.stock) - COALESCE(SUM(o.qty), 0)::INT) AS selisih
FROM products p LEFT JOIN orders o ON o.product_id = p.id
GROUP BY p.id ORDER BY p.id;
-- V4: harus false karena ini primary (dapat ditulisi).
SELECT pg_is_in_recovery() AS masih_replica;
