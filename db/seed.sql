-- Data dummy, hanya dimasukkan pada database kosong.
INSERT INTO users(name)
SELECT 'User ' || g FROM generate_series(1, 100) AS g;

INSERT INTO products(name, price, initial_stock, stock) VALUES
('Smartphone X Pro (Flash Sale)', 2999000, 100, 100),
('Earbuds Wireless ANC', 199000, 500, 500),
('Smartwatch Fit 3', 499000, 50, 50);
