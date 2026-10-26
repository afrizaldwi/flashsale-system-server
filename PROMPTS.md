# Rekam Penggunaan AI — Pertemuan 1

**Catatan asal:** Disusun dari riwayat prompt yang tercantum pada repository awal; bukan log lengkap setiap interaksi AI. Lengkapi dengan prompt asli dan nama alat AI yang benar-benar dipakai oleh anggota tim.

## Pembuatan aplikasi awal (riwayat repository)
Alat (menurut catatan repository): Claude.

> Sekarang pertemuan pertama dan saya kelompok 1 (Flash Sale E-Commerce). Buatkan aplikasi sederhananya berdasarkan dokumen yang saya kirim.

## Revisi masukan dosen — database master/slave (riwayat repository)
> Pakai saja yang disarankan dosenku.

## Revisi masukan dosen — komponen tetap hidup (riwayat repository)
> Revisi sekali lagi, pokoknya satu server mati semua server lainnya tidak ikut mati.

## Revisi penyelarasan dengan dokumen (permintaan 20 Oktober 2026)
Alat: ChatGPT.

> Kalau begitu berikan saya seluruh source code yang telah di revisi agar sesuai dengan dokumen. Berikan semua filenya agar saya bisa langsung jalankan nanti setelah menginstal dependencies nya.

**Ruang lingkup hasil:** Satu backend di localhost (P1), PostgreSQL primary–replica async, failover MANUAL, checkout atomik, idempotency, health check, integritas data; rancangan Nginx dan Docker dipersiapkan untuk P2, bukan diaktifkan pada P1.

**Status pengujian:** Pemeriksaan sintaks dan unit test dapat dilakukan dari source code ini; pengujian PostgreSQL dan recovery yang sebenarnya harus dilakukan di perangkat praktikum dan hasilnya tidak boleh direkayasa.

## Pertemuan 2 — Containerization (26 Oktober 2026)
Alat: Google Antigravity (Gemini/Claude Sonnet 4.6 Thinking).

> Pertemuan 2: Containerization (Docker). Fokus: Standardisasi environment menggunakan teknologi kontainer.
> 1. Buat Dockerfile untuk aplikasi.
> 2. Buat docker-compose.yml untuk menggabungkan layanan aplikasi dan database.
> 3. Implementasikan arsitektur multi-container dan konfigurasikan Docker Volumes untuk memastikan data persisten (menjadi fondasi DRP).
> baca detailnya pada folder docs fokus pada pertemuan 2

**File yang dibuat:**
- `Dockerfile` — multi-stage build (deps + runtime), user non-root, HEALTHCHECK
- `docker-compose.yml` — 5 service: db-primary, db-replica, backend-1, backend-2, nginx
- `nginx/nginx.conf` — Nginx load balancer round-robin ke 2 backend
- `docker/primary-init.sql` — inisialisasi schema + seed + user replicator
- `docker/primary-postgresql.conf` — WAL streaming replication config
- `docker/primary-pg_hba.conf` — izin koneksi replication dari subnet Docker
- `docker/replica-entrypoint.sh` — pg_basebackup + start hot standby
- `.env.docker` / `.env.docker.example` — konfigurasi Docker
- `.dockerignore` — minimisasi build context

**Ruang lingkup:** Arsitektur sesuai Spesifikasi v1.2 §4.2: Nginx → 2 backend → primary (write) + replica (read/fallback). Volume persisten `pgdata-primary` dan `pgdata-replica` sebagai fondasi DRP Pertemuan 4.
