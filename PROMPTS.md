# Prompt AI untuk Laporan Mingguan (Pertemuan 1)

Alat: Claude. Masukan: Dokumen Spesifikasi Arsitektur dan Dokumen DRP Awal Kelompok 1 (format .docx).

Prompt:
> Sekarang pertemuan pertama dan saya kelompok 1 (Flash Sale E-Commerce). Buatkan aplikasi sederhananya berdasarkan dokumen yang saya kirim.

Catatan verifikasi tim: kode diuji dengan PostgreSQL 16 lokal (300 dan 1000 request serentak, key sama 20x, DB dimatikan lalu dihidupkan).
Satu bug ditemukan saat pengujian (pool starvation di jalur stok habis) dan sudah diperbaiki; lihat bagian Catatan desain di README.

Revisi setelah masukan dosen ("kok tidak ada master dan slave server?"):
> Pakai saja yang disarankan dosenku.

Hasil: arsitektur primary-replica (streaming replication), baca dari replica, failover manual. Diuji: replica mati (fallback baca), primary mati (503), promote replica lalu checkout normal.

Revisi kedua (satu server mati tidak boleh mematikan server lain):
> Revisi sekali lagi, pokoknya satu server mati semua server lainnya tidak ikut mati.

Hasil: 2 instance backend di belakang load balancer (`src/lb.js`), failover database otomatis (watchdog + `pg_promote()` di `src/db.js`).
Diuji dengan PostgreSQL 16 lokal: (1) backend-1 dimatikan saat 60 checkout berjalan -> 60/60 sukses (201); (2) primary dimatikan saat checkout berjalan -> ~4 detik 503, replica otomatis dipromosikan, checkout normal lagi, `/stats` consistent=true, tanpa order ganda dan stok minus.
