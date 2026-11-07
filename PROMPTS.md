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


## Pertemuan 3 — Stress Testing dan Automatic Scaling (31 Oktober 2026)
Alat: Google Antigravity (Gemini 2.5 Pro / Flash).

> Pertemuan 3: Stress Testing dan Automatic Scaling.
> Fokus: Mengevaluasi batas ketahanan sistem Flash Sale menggunakan Grafana k6 (10, 100, 500, 1000 VU) dan menerapkan autoscaling backend dinamis berbasis CPU (2-6 instance) dengan graceful drain dan dynamic Nginx routing.

**File yang dibuat / diperbarui:**
- `scripts/p3/config.js`, `policy.js`, `controller.js`, `docker.js`, `routing.js`, `collector.js` — Autoscaling controller, hysteresis policy, collector metrik host/VM/DB, dan dynamic Nginx reloader.
- `docker-compose.p3.yml` — Stack terisolasi P3 (flashsale-p3) dengan network dan named volumes tersendiri.
- `tests/load/workload.js` — Skenario k6 bertahap untuk read dan write (POST /checkout) dengan Idempotency-Key.
- `scripts/p3/report.js` — Generator laporan evaluasi performa, komparasi Fixed vs Auto, percentile p95, dan ekstraksi metrik mentah.

---

## Eksekusi Revisi Praktikum Pertemuan 1–3 (8 November 2026)
Alat: Google Antigravity (Gemini 3.8 Flash).

> /goal # Prompt Antigravity — Eksekusi Revisi Praktikum Cloud Computing Pertemuan 1–3
> Peran: Senior Cloud Engineer, DevOps Engineer, PostgreSQL Administrator, dan Software Test Engineer untuk proyek praktikum Cloud Computing Kelompok 1: Flash Sale E-Commerce.
> Prioritas pekerjaan: Membuktikan bahwa sistem benar-benar bekerja sesuai penjelasan laporan, menemukan ketidaksesuaian implementasi, melakukan perbaikan bila diperlukan, dan menghasilkan bukti pengujian yang dapat dipresentasikan kepada dosen.
> Menjawab seluruh revisi dosen untuk Pertemuan 1, Pertemuan 2, dan Pertemuan 3.

**Hasil dan Bukti Eksekusi:**
1. **Validasi Pertemuan 1 (Primary–Replica & Resilience):**
   - Bukti transaksi tulis mengarah ke Primary, pembacaan katalog dari Replica (`X-Read-From: replica`).
   - Simulasi kegagalan replica: `GET /products` otomatis fallback ke Primary (`X-Read-From: primary`), Primary tetap melayani checkout.
   - Simulasi pemulihan replica: `GET /products` otomatis kembali melayani dari Replica (`X-Read-From: replica`).
   - Replikasi PostgreSQL beroperasi asinkron (`state: streaming, sync: async`) dengan lag 0 detik pada kondisi normal.
2. **Validasi Pertemuan 1 & 2 (Manual Failover & Fencing):**
   - Pembuatan skrip `scripts/docker-failover.js` dengan mode audit/plan (`--plan`) dan promosi terproteksi (`--promote --confirm-fenced --allow-promotion`).
   - Fencing requirement: Menolak promosi jika primary lama masih menerima koneksi, guna mencegah split-brain.
   - Pelarangan failback otomatis: Failback otomatis dilarang keras tanpa rekonsiliasi data menggunakan `scripts/reconcile-old-primary.js`.
3. **Validasi Pertemuan 1 & 2 (Backend Resilience):**
   - Pengujian penghentian salah satu backend: Nginx mendeteksi kegagalan melalui `max_fails=2 fail_timeout=5s` dan `proxy_connect_timeout 2s`.
   - Mengukur 4 request gagal dengan HTTP 504 pada fase transisi (karena `proxy_next_upstream off` untuk keamanan checkout), kemudian seluruh request berikutnya dialihkan 100% ke backend yang bertahan (HTTP 200).
   - Menjelaskan perbedaan kegagalan request in-flight vs subsequent requests, serta restart policy `unless-stopped`.
4. **Validasi Pertemuan 3 (Analisis Waktu Error & Bottleneck):**
   - Menemukan detik pertama terjadinya error dari ekstraksi lossless data mentah `k6-samples.ndjson.gz` pada 8 kampanye stress test:
     - 10 VU & 100 VU: 0% error (sempurna pada Fixed maupun Auto).
     - 500 VU: Error pertama terjadi pada **detik ke-0 (0,170s pada Fixed, 0,011s pada Auto)** sejak fase `measure`.
     - 1.000 VU: Error pertama terjadi pada **detik ke-0 (0,000s)** sejak fase `measure`.
     - Jenis error: 100% `dial: connection refused` (code 1212) akibat saturasi TCP socket ingress saat ratusan/ribuan VU masuk serentak. Tidak ada error HTTP 5xx backend crash (0 error 5xx).
   - Pembaruan `scripts/p3/report.js` agar secara otomatis mengekstraksi `first_infrastructure_error` ke dalam `analysis.json`.
   - Dukungan idempotency result `200 DUPLICATE` diperbarui pada `tests/load/workload.js` sebagai valid business response.
   - Pembaruan dokumen revisi laporan `docs/revisi/Pertemuan_3/Laporan_Pertemuan_3_Revisi.docx` dengan data empiris first-error timeline.
