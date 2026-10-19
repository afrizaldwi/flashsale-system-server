# Flash Sale E-Commerce - Praktikum Cloud Computing (Kelompok 1)

Pertemuan 1: aplikasi berjalan di localhost. Node.js + Express + PostgreSQL 16 (primary + replica), 2 instance backend di belakang load balancer, failover database otomatis, frontend HTML/JS vanilla.
Mengikuti *Dokumen Spesifikasi Arsitektur* dan *DRP Awal*.

## Struktur
```
src/server.js      API (products, checkout, orders, health, stats)
src/db.js          pool koneksi pg (maks 20) + watchdog failover otomatis primary -> replica
src/lb.js          load balancer (round-robin, health check, retry ke backend lain)
db/schema.sql      skema + constraint (CHECK stock>=0, UNIQUE idempotency_key)
db/seed.sql        100 user, 3 produk
frontend/index.html  UI (disajikan oleh backend)
scripts/init-db.js   buat DB + skema + seed (--reset untuk ulang)
scripts/test-race.js uji overselling & idempotency
scripts/verify.sql   query validasi V1-V3 dari DRP
scripts/setup-replica.sh   buat replica (slave) via streaming replication
scripts/promote-replica.sh failover manual (cadangan): replica -> primary
scripts/cluster.js   jalankan 2 backend (:3001, :3002) + load balancer (:3000)
backups/             tujuan pg_dump (Pertemuan 4)
```

## Menjalankan
Prasyarat: Node.js 18+, PostgreSQL 16 berjalan di localhost:5432.
```bash
npm install
cp .env.example .env        # sesuaikan DB_USER / DB_PASSWORD
npm run db:init             # buat database flashsale + data awal
npm start                   # 1 backend saja: http://localhost:3000
npm run start:cluster       # 2 backend + load balancer: http://localhost:3000
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
- **Failover database otomatis**: tiap backend memeriksa primary tiap 1 detik (`FAILOVER_CHECK_MS`). Setelah 3 kali gagal berturut-turut (`FAILOVER_THRESHOLD`), replica dipromosikan dengan `pg_promote()` dan semua penulisan dialihkan ke sana, tanpa restart dan tanpa mengubah `.env`. Dengan 2 backend, yang pertama mempromosikan dan yang lain hanya mengalihkan koneksi. Ada jeda 503 untuk penulisan selama kira-kira 3-4 detik. `AUTO_FAILOVER=false` mematikan fitur ini; `promote-replica.sh` tetap tersedia untuk cara manual.
- Setelah failover tidak ada replica lagi (bacaan jatuh ke primary baru). **Primary lama jangan dihidupkan kembali** sebagai penerima tulis (risiko dua primary / split-brain); bangun ulang sebagai replica dengan `setup-replica.sh`.
- Replikasi asinkron: order yang baru commit di primary bisa belum sampai ke replica saat primary mati (RPO > 0 kecil). Retry dengan Idempotency-Key yang sama tetap aman.
- Replica bukan pengganti backup: `DROP TABLE` ikut tereplikasi. Karena itu `pg_dump` tetap dipakai (Pertemuan 4).

Setup (primary harus sudah jalan; `wal_level` default sudah cukup):
```bash
PGBIN=/usr/lib/postgresql/16/bin ./scripts/setup-replica.sh   # replica di port 5433
```
Kosongkan `DB_REPLICA_HOST` di `.env` jika tidak memakai replica.

## Server dobel + Load balancer (satu server mati, yang lain tetap jalan)
```
Browser -> LB :3000 -> backend-1 :3001 --\                    /--> PRIMARY :5432 --replikasi--> REPLICA :5433
                    \-> backend-2 :3002 --/-- (tulis / baca) --/
```
- Load balancer membagi request bergantian (round-robin), memeriksa `/health` tiap backend tiap 1 detik, dan mengeluarkan backend yang mati dari rotasi. Jika backend mati di tengah request, request diulang ke backend lain (aman karena `Idempotency-Key`). Header `X-Instance` menunjukkan backend yang melayani; `GET /lb/status` menunjukkan status tiap backend.
- Backend yang menjawab 503 karena **database** bermasalah tetap dianggap hidup (prosesnya sehat).
- Keterbatasan: load balancer itu sendiri masih satu proses (di produksi dipasang LB ganda / cloud LB), dan primary + replica + backend masih di satu mesin.

| Yang mati | Akibatnya |
|---|---|
| backend-1 atau backend-2 | Tidak ada. LB mengalihkan semua request ke backend yang hidup. |
| Replica | Tidak ada. `/products` dibaca dari primary. |
| Primary | Penulisan 503 selama ~3-4 detik, lalu replica otomatis menjadi primary dan checkout jalan lagi. |
| Load balancer | Semua berhenti (masih satu proses). |

Demo: `npm run start:cluster`, lalu `kill <PID backend-1>` saat `npm run test:race` berjalan; stop primary dengan `pg_ctl stop -m immediate`.

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
