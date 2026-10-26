-- ─────────────────────────────────────────────────────────────────────────────
-- docker/primary-init.sql
-- Inisialisasi database dan user replikasi untuk PostgreSQL PRIMARY di Docker
-- Pertemuan 2: Containerization (Docker)
-- Kelompok 1, Cloud Computing H7D.7
-- ─────────────────────────────────────────────────────────────────────────────
-- Script ini dijalankan SEKALI saat container primary pertama kali dibuat
-- melalui mekanisme /docker-entrypoint-initdb.d/ PostgreSQL.
-- ─────────────────────────────────────────────────────────────────────────────

-- Buat user replikasi dengan privilege REPLICATION
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'replicator') THEN
    CREATE ROLE replicator WITH REPLICATION LOGIN PASSWORD 'replicatorpass';
  END IF;
END
$$;

-- Konfigurasi pg_hba tidak bisa dilakukan dari SQL, tapi pg_hba.conf
-- sudah dikonfigurasi via environment variable POSTGRES_HOST_AUTH_METHOD
-- atau melalui custom postgresql.conf yang di-mount.

-- Buat database aplikasi
SELECT 'CREATE DATABASE flashsale'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'flashsale')\gexec

-- Hubungkan ke database flashsale untuk membuat schema
\c flashsale

-- Buat tabel sesuai schema.sql (Spesifikasi Arsitektur v1.2, §5)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(150) NOT NULL,
    price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
    initial_stock INT NOT NULL CHECK (initial_stock >= 0),
    stock INT NOT NULL CHECK (stock >= 0)
);

CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    user_id INT NOT NULL REFERENCES users(id),
    product_id INT NOT NULL REFERENCES products(id),
    qty INT NOT NULL CHECK (qty > 0),
    status VARCHAR(20) NOT NULL DEFAULT 'PAID',
    idempotency_key VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_product ON orders(product_id);

-- Seed data dummy
INSERT INTO users(name)
SELECT 'User ' || g FROM generate_series(1, 100) AS g
ON CONFLICT DO NOTHING;

INSERT INTO products(name, price, initial_stock, stock) VALUES
('Smartphone X Pro (Flash Sale)', 2999000, 100, 100),
('Earbuds Wireless ANC', 199000, 500, 500),
('Smartwatch Fit 3', 499000, 50, 50)
ON CONFLICT DO NOTHING;
