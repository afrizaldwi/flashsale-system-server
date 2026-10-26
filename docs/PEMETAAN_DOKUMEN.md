# Pemetaan source code ke dokumen Kelompok 1

Basis: **Spesifikasi Arsitektur v1.2** dan **DRP Awal v1.0.2** yang dilampirkan.

| Ketentuan | Implementasi paket ini | Tahap |
|---|---|---|
| Arsitektur satu backend localhost, primary :5432, replica :5433 (Arsitektur §4.1) | `src/server.js`, `src/db.js`, `scripts/setup-replica.*` | P1 |
| FR-1 — /products dari replica + fallback | `src/db.js` / `src/server.js` | P1 |
| FR-2 s.d. FR-4 — transaksi checkout, anti-oversell, idempotency | `src/server.js`, `db/schema.sql` | P1 |
| FR-5 — GET /orders/:id | `src/server.js` | P1 |
| FR-6 — /health status primary dan replica | `src/server.js`, `src/db.js` | P1 |
| FR-7 — /stats invarian stok | `src/queries.js`, `scripts/verify-db.js`, `db/verify.sql` | P1 |
| DRP §7.1 — manual promotion | `scripts/promote-replica.sh` dan `.ps1` | P1 (uji opsional) |
| DRP §7.4 — penanganan primary lama | Prosedur operator + helper `scripts/reconcile-old-primary.js` dry-run | Rencana P4, BELUM tervalidasi |
| Nginx load balancer + 2 backend (Arsitektur §4.2) | `nginx/nginx.conf`, service `nginx` di `docker-compose.yml` | **P2 ✓** |
| Dockerfile, docker-compose, Docker Volumes | `Dockerfile`, `docker-compose.yml`, `docker/`, `.env.docker` | **P2 ✓** |
| Stress test 10/100/500/1000 VU | **Belum dilakukan** | P3 |
| Backup otomatis berkala, restore dan DR Test utama dari dump | **Belum dibuat/diuji** | P4 |
| File storage/CDN statis Nginx atau MinIO | **Belum dibuat** | P5 |


## Perhatian atas klaim waktu dan keamanan
- RTO ≤5 menit dan RPO ≤1 menit adalah **target**, bukan hasil pengukuran paket ini.
- Failover manual tidak sama dengan failover otomatis. Setelah primary mati, `/checkout`, `/orders/:id`, `/stats` mengembalikan 503 sampai operator melakukan recovery.
- `FENCING_CONFIRMED=YES` adalah konfirmasi operator, **bukan** sistem fencing terdistribusi. Cek port saja tidak membuktikan primary terisolasi ketika terjadi network partition.
- Memulai kembali primary lama setelah failover tanpa pembatasan dapat menyebabkan split-brain. Database lama hanya boleh dibuka terisolasi untuk investigasi/rekonsiliasi.
- Replikasi asinkron dapat kehilangan transaksi paling akhir yang belum terkirim ke replica. `Idempotency-Key` mencegah duplikasi ketika retry, **tidak menjamin tidak ada kehilangan data**.
- Data order yang tidak berhasil diselamatkan karena stok sudah habis (HTTP 409) memerlukan prosedur kompensasi, bukan ditandai sukses.
