-- Skema Flash Sale (sesuai Dokumen Spesifikasi Arsitektur bagian 5)
CREATE TABLE IF NOT EXISTS users (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(150) NOT NULL,
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  initial_stock INT NOT NULL CHECK (initial_stock >= 0),
  stock         INT NOT NULL CHECK (stock >= 0)   -- lapis pertahanan skema: stok minus ditolak DB
);

CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  user_id         INT NOT NULL REFERENCES users(id),
  product_id      INT NOT NULL REFERENCES products(id),
  qty             INT NOT NULL CHECK (qty > 0),
  status          VARCHAR(20) NOT NULL DEFAULT 'PAID',
  idempotency_key VARCHAR(100) NOT NULL UNIQUE,   -- cegah pesanan ganda
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_product ON orders(product_id);
