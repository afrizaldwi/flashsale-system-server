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


---

## Pertemuan 4 — Backup & Restore Automation (8 November 2026)
Alat: Google Antigravity (Gemini 3.8 Flash).

> # IMPLEMENTASI PERTEMUAN 4 — BACKUP & RESTORE AUTOMATION
> Peran: Cloud Engineer dan DevOps Engineer untuk proyek praktikum Cloud Computing Kelompok 1 — Flash Sale E-Commerce.
> Tujuan: Mengimplementasikan mekanisme backup database otomatis dan restore database untuk mendukung Disaster Recovery Plan (DRP).
> Target awal: RTO <= 5 menit, RPO <= 1 menit, Backup berkala setiap 30 detik.
> Komponen yang dibuat:
> 1. backup.sh & backup.js (format custom -Fc, snapshot konsisten, validasi pg_restore --list, SHA-256, atomic temp file, proteksi backup sebelumnya).
> 2. backup-loop.sh & backup-loop.js (interval 30s, serial execution lock file, graceful shutdown).
> 3. restore.sh & restore.js (default dry-run, flag eksplisit --execute, validasi checksum SHA-256, opsi pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error, isolasi stack flashsale_p3, pemutusan koneksi backend aktif).
> 4. Unit tests di tests/p4/ (11 test case baru, verifikasi fail-closed, checksum mismatch, role check, dan dry-run safety).
> 5. Dokumentasi lengkap docs/PERTEMUAN_4.md.

**Hasil dan Bukti Eksekusi:**
- Modul backup dan restore diimplementasikan di `scripts/p4/` dengan dukungan lintas shell (PowerShell via Node/npm dan Git Bash via Shell Script).
- Backup runtime riil terverifikasi: `flashsale_p3_20261108_100556.dump` (11.10 KB, 28 entitas TOC tervalidasi, durasi 1.2s, SHA-256 valid).
- Restore runtime dry-run terverifikasi: simulasi sukses tanpa modifikasi data aktual pada database.
- Backup loop terverifikasi: interval 30 detik, lock file `.backup.lock` mencegah proses konkuren, log dicatat di `backup-loop.log`.
- Test suite keseluruhan meningkat dari 80 menjadi **91 test PASS (100%)** tanpa kegagalan.
- Database baseline tetap terjaga konsisten (`consistent: true`, 0 negative stock, 0 duplicate orders).

---

## Final Review & Hardening Pertemuan 4 — Backup & Restore Automation (8 November 2026)
Alat: Google Antigravity (Gemini 3.8 Flash).

> # FINAL REVISI PERTEMUAN 4 — BACKUP & RESTORE AUTOMATION
> Fokus pekerjaan:
> 1. Kepemilikan atomic lock pada backup loop (diperoleh sebelum while-loop, dipertahankan selama loop & jeda interval, dilepas hanya di finally oleh PID pemilik, graceful shutdown tanpa memutus paksa backup in-flight).
> 2. Validasi ketat connection count & terminasi (strict integer parsing Number.isSafeInteger() non-negatif, penolakan "0invalid", query terminasi hanya menghitung koneksi yang bernilai true).
> 3. Pemilihan backup terbaru yang valid (skip dump tanpa .sha256, checksum mismatch, atau TOC corrupt, beralih ke backup valid sebelumnya tanpa menghapus file lama).
> 4. Sinkronisasi dokumentasi dan pengujian regresi menyeluruh (98 -> 109 PASS).

**Hasil dan Bukti Eksekusi Aktual:**
1. **Peningkatan Unit Test Suite (`npm test`):**
   - Total test suite bertambah menjadi **109 test PASS (100%)**:
     - 20 test suite P1 (failover & rekonsiliasi)
     - 60 test suite P2/P3 (resilience, autoscaling, dynamic routing, concurrency)
     - 29 test suite P4 (5 backup, 5 loop, 19 restore/connection/validation)
2. **Atomic Lock Loop Terverifikasi:**
   - Lock file `.backup.lock` dibuat menggunakan flag `wx` (`O_CREAT | O_EXCL`) sebelum loop dimulai.
   - Pengujian membuktikan proses kedua ditolak (`EEXIST`) saat proses pertama sedang tidur menunggu interval berikutnya (mencegah backup paralel).
   - Pelepasan lock dijamin oleh blok `finally` dan hanya diizinkan untuk PID pemilik.
   - Pengujian 1-iterasi loop runtime membuktikan siklus backup tunggal berhasil tanpa kebocoran lock file. Catatan: Pengujian 1-iterasi ini hanya memvalidasi satu siklus backup, bukan kestabilan eksekusi berulang dalam jangka waktu panjang.
3. **Validasi Strict Connection Count & Terminasi:**
   - Fungsi `parseStrictNonNegativeInt` menolak format malformed (`0invalid`, `NaN`, bilangan negatif, string kosong).
   - Query pemutusan koneksi menggunakan `WHERE terminated = true` sehingga hanya mencatat jumlah koneksi yang benar-benar berhasil diputus.
   - Query error atau anomali tidak lagi di-fallback menjadi `0`, melainkan menghentikan proses secara fail-closed.
4. **Pemilihan Backup Otomatis Terverifikasi:**
   - Skrip `restore.js` secara otomatis memeriksa kandidat dump dari yang paling baru.
   - Kandidat tanpa `.sha256`, checksum mismatch, atau arsip korup otomatis dilewati ke backup sebelumnya yang valid.
   - Seluruh file backup lama tetap terlindungi dan tidak dihapus selama proses pencarian.
5. **Verifikasi Runtime & Integritas Data:**
   - Runtime backup: `flashsale_p3_20261108_105337.dump` (11.10 KB, 28 entitas TOC valid, SHA-256 valid).
   - Runtime dry-run restore: rencana pemulihan tervalidasi sukses tanpa perubahan data pada database aktif.
   - Integritas data live di `http://127.0.0.1:8080/stats` tetap konsisten (`consistent: true`, 97 total orders, 0 mismatch).
   - Catatan DRP: Target RTO <= 5 menit dan RPO <= 1 menit merupakan target desain arsitektur dan belum dibuktikan melalui Disaster Recovery Test aktual (penghapusan container/volume secara destruktif). Restore aktual wajib dijalankan secara manual dengan flag eksplisit `--execute`.
