# Flash Sale E-Commerce - Praktikum Cloud Computing (Kelompok 1)

Pertemuan 1: aplikasi berjalan di localhost. Node.js + Express + PostgreSQL 16 (primary + replica), frontend HTML/JS vanilla.
Mengikuti *Dokumen Spesifikasi Arsitektur* dan *DRP Awal*.

## Struktur
```
src/server.js      API (products, checkout, orders, health, stats)
src/db.js          pool koneksi pg (maks 20)
db/schema.sql      skema + constraint (CHECK stock>=0, UNIQUE idempotency_key)
db/seed.sql        100 user, 3 produk
frontend/index.html  UI (disajikan oleh backend)
scripts/init-db.js   buat DB + skema + seed (--reset untuk ulang)
scripts/test-race.js uji overselling & idempotency
scripts/verify.sql   query validasi V1-V3 dari DRP
scripts/setup-replica.sh   buat replica (slave) via streaming replication
scripts/promote-replica.sh failover manual: replica -> primary
backups/             tujuan pg_dump (Pertemuan 4)
```

## Menjalankan
Prasyarat: Node.js 18+, PostgreSQL 16 berjalan di localhost:5432.
```bash
npm install
cp .env.example .env        # sesuaikan DB_USER / DB_PASSWORD
npm run db:init             # buat database flashsale + data awal
npm start                   # http://localhost:3000
```
Reset data ke kondisi awal: `npm run db:reset`.

## Primary-Replica (Master-Slave)
```
Browser -> Backend --tulis (checkout, orders, stats)--> PRIMARY :5432 --streaming replication--> REPLICA :5433
                   \--baca (/products)---------------------------------------------------------^ (read-only)
```
- **Primary**: semua penulisan dan data yang harus akurat (`/checkout`, `/orders`, `/stats`).
- **Replica**: hanya baca. `/products` dibaca dari replica (header `X-Read-From: replica`). Jika replica mati, bacaan otomatis jatuh ke primary.
- `/health` melaporkan status primary (menentukan 200/503) dan replica (`replica`, `replica_lag_seconds`).
- **Failover bersifat manual**: jika primary mati, `./scripts/promote-replica.sh`, ubah `.env` (`DB_PORT` ke port replica, kosongkan `DB_REPLICA_HOST`), restart backend. Failover otomatis butuh Patroni/repmgr (di luar lingkup).
- Replikasi asinkron: order yang baru commit di primary bisa belum sampai ke replica saat primary mati (RPO > 0 kecil). Retry dengan Idempotency-Key yang sama tetap aman.
- Replica bukan pengganti backup: `DROP TABLE` ikut tereplikasi. Karena itu `pg_dump` tetap dipakai (Pertemuan 4).

Setup (primary harus sudah jalan; `wal_level` default sudah cukup):
```bash
PGBIN=/usr/lib/postgresql/16/bin ./scripts/setup-replica.sh   # replica di port 5433
```
Kosongkan `DB_REPLICA_HOST` di `.env` jika tidak memakai replica.

## Uji cepat
```bash
npm run test:race           # 300 pembeli serentak + 1 key dikirim 20x
curl localhost:3000/health
curl localhost:3000/stats   # "consistent": true
psql -U postgres -d flashsale -f scripts/verify.sql
```

## API
| Method | Endpoint | Respons |
|---|---|---|
| GET | /products | 200, 503 |
| POST | /checkout (header `Idempotency-Key`, body `user_id, product_id, qty`) | 201 dibuat, 200 duplikat, 400, 404, 409 stok habis, 503 |
| GET | /orders/:id | 200, 400, 404, 503 |
| GET | /health | 200, 503 |
| GET | /stats | 200, 503 |

## Catatan desain
- Stok dikurangi dengan `UPDATE ... SET stock = stock - $1 WHERE id=$2 AND stock >= $1` di dalam satu transaksi bersama INSERT order.
- `UNIQUE(idempotency_key)` + penanganan error 23505 mencegah pesanan ganda.
- Saat DB mati backend tetap hidup dan membalas 503.
- Semua query dalam satu transaksi memakai koneksi yang sama. Memanggil `pool.query` saat memegang koneksi transaksi bisa membuat pool (maks 20) kehabisan koneksi saat beban tinggi.
