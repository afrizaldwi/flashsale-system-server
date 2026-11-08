# Konteks untuk penyusunan laporan praktikum Pertemuan 4

Dokumen ini adalah titik masuk bagi ChatGPT untuk membaca repository dan menyusun laporan P4. Source code membuktikan implementasi; hasil runtime harus didukung berkas evidence, bukan disimpulkan dari kode atau test mock. Seluruh waktu pada JSON berformat UTC; tambahkan 7 jam untuk WIB. Dua eksperimen PASSED di bawah berlangsung pada 9 November 2026 WIB.

## Acuan utama

1. [Spesifikasi Arsitektur P1](revisi/Pertemuan_1/Spesifikasi_Arsitektur_P1.docx), versi 1.3, 7 November 2026: terutama §4.4, §5–8 dan NFR-5/NFR-6.
2. [DRP Awal P1](revisi/Pertemuan_1/DRP_Awal_P1.docx), versi 1.1, 7 November 2026: terutama §4–9, skenario wajib T1-B/T2, serta batasan §10.
3. [Koreksi review dan prosedur terbaru](P4_REVIEW_CORRECTIONS.md). Bagian historis dokumen lain tetap disimpan; instruksi clone P4 dan hasil tes lama tidak menggantikan prosedur terbaru.

P4 memperluas aplikasi P3: project `flashsale-p3`, `.env.p3` lokal, `docker-compose.p3.yml`, database `flashsale_p3`, ingress `127.0.0.1:8080`. P4 bukan deployment aplikasi baru bernama flashsale-p4. Jalur clone `flashsale-p4-dr` dipertahankan sebagai riwayat/regresi; eksekusinya dihentikan sebagai jalur resmi.

## Hasil eksperimen utama dan pengulangan

| Ukuran | Run pertama PASSED | Pengulangan oleh pengguna, hasil utama laporan |
| --- | --- | --- |
| Run ID | `27f60e05265e` | `bfe0f3b7c035` |
| Hasil | PASSED | PASSED |
| RTO | 107,395 detik | 110,826 detik |
| Target RTO | <=300 detik | <=300 detik |
| RPO sebelum replay | 0,075 detik | 0,005 detik |
| Target RPO | <=60 detik | <=60 detik |
| Usia snapshot | 23 detik | 170 detik |
| ACK hilang dari snapshot awal | 431 | 319 |
| ACK terselesaikan setelah rekonstruksi | 431, unresolved 0 | 319, unresolved 0 |
| Request ambigu direkonsiliasi | 100 | 100 |
| Order akhir primary dan replica | 100.799 | 101.219 |
| K6 | 100 VU, 60 detik, exit 0 | 100 VU, 60 detik, exit 0 |
| Respons tidak diharapkan | 0 | 0 |
| Stok negatif / order ganda / mismatch stok | 0 / 0 / 0 | 0 / 0 / 0 |

Bukti tercommit untuk masing-masing run berada di [p4-evidence](p4-evidence/manifest.json): mulai dari `summary.json`, lalu `report.json`. Paket ini menyertakan ledger transaksi, summary engine K6, jurnal rekonsiliasi per key, dan hasil SQL ACK akhir.

- [Ringkasan hasil utama](p4-evidence/bfe0f3b7c035/summary.json)
- [Report hasil utama](p4-evidence/bfe0f3b7c035/report.json)
- [Ringkasan hasil pertama](p4-evidence/27f60e05265e/summary.json)
- [Report hasil pertama](p4-evidence/27f60e05265e/report.json)

Ekspor report menghilangkan hanya `k6Result.stdout` dan `k6Result.stderr` yang berulang dan besar. Report asli lokal tidak diubah. Manifest mencatat SHA-256 sumber dan ekspor; file ledger/jurnal/summary K6/SQL akhir disalin byte-for-byte. Dump database, kredensial, manifest runtime .p3 dan helper forensik lokal tidak dipublikasikan. Jangan mengklaim seluruh artefak lokal tersedia di GitHub.

## Definisi pengukuran dan batas klaim

- T0: respons `/health` HTTP 503 kedua berturut-turut. Timestamp permintaan injeksi dan bukti Docker primary mati dicatat terpisah.
- T1: checkout recovery berhasil, seluruh ACK/request ambigu terselesaikan, serta audit stok, order, role, routing dan replica selesai. RTO = (T1 - T0)/1000. Waktu rekonsiliasi termasuk RTO.
- RPO: jarak waktu injeksi dengan ACK sebelum injeksi terbaru yang hilang dari hasil restore awal. ACK terlambat diklasifikasikan terpisah dan tetap diaudit. RPO disimpan sebelum replay, tidak dihitung ulang menjadi nol setelah replay.
- RPO kecil tidak berarti hanya sedikit order hilang. Pada run utama, 319 ACK memang tidak ada pada snapshot awal. Snapshot berusia 170 detik adalah ukuran terpisah; jangan menyebutnya RPO 170 detik, dan jangan mengklaim backup selalu berumur <=60 detik.
- PASSED membuktikan strategi **restore snapshot ditambah rekonstruksi ledger yang disetujui**, bukan dump saja memulihkan seluruh transaksi. Ledger host adalah sumber recovery tambahan yang harus tetap tersedia dan dipercaya.
- Rekonstruksi ACK memerlukan opsi eksplisit `--approve-ack-replay` dengan alasan operator. Default tanpa opsi tetap review-only. Approval dicatat per key; INTENT di-fsync sebelum write. Replay memakai key/payload asli, retry wajib DUPLICATE dengan ID yang sama, lookup primary independen dan snapshot stok baru memeriksa tiap transaksi. Audit SQL akhir mencocokkan semua key/payload unik, diikuti audit primary/replica. Tidak ada kompensasi finansial atau pengubahan stok SQL manual.
- K6 tidak menganggap HTTP 500/502/504 sukses. 503 DB_UNAVAILABLE dan transport error hanya diterima sebagai outage sesuai marker host. HTTP error akibat outage tidak boleh disamakan dengan `unexpectedResponses`; gunakan kedua metrik sesuai artinya.
- K6 constant-vus dikonfigurasi 100 VU. Gate 100 ID VU teramati dalam ledger membuktikan partisipasi, bukan 100 checkout simultan pada titik injeksi; `concurrentActivityAtInjectionProven` bernilai false.

## Alur implementasi yang dilaporkan

1. Verifikasi identitas P3, primary/replica, baseline, target container/volume; tidak reset dataset.
2. Validasi metadata/SHA-256/TOC backup terbaru dan trial restore ke database sementara.
3. Ambil shared operation lock, pause controller, mulai K6 dan ledger eksternal, verifikasi ACK/VU.
4. Simpan intent recovery sebelum menghapus hanya primary terkonfirmasi. Pertahankan volume sumber. Catat lifecycle dan dua health 503, bukti backend bertahan serta katalog replica.
5. Selesaikan workload, fence penulisan, pilih dan pin backup valid. Restore pada volume primary baru; audit mandiri lalu bangun ulang standby dengan pg_basebackup pada volume baru.
6. Aktifkan backend yang sama, readiness dan routing P3. Audit kehilangan sebelum replay, rekonsiliasi yang disetujui, retry request ambigu, audit SQL ACK akhir dan integritas primary/replica.
7. Catat T1 hanya jika seluruh gate lulus; simpan report/ledger/summary. Manifest validated untuk sukses; kegagalan tetap recovering dan controller paused. Tidak ada down -v atau penghapusan volume sumber otomatis.

| Implementasi | Lokasi |
| --- | --- |
| Orchestrator resmi, timestamp, konfirmasi, output ringkas | `scripts/p4/p3-dr.js` |
| Entry CLI dan helper clone historis | `scripts/p4/orchestrate-dr.js` |
| Persetujuan replay ledger dan audit ACK | `scripts/p4/ack-replay.js`, `reconciliation.js`, `success.js` |
| Ledger, kebijakan respons dan runner K6 | `scripts/p4/ledger.js`, `workload.js`, `workload-policy.js`, `tests/load/p4-dr-workload.js` |
| Backup, scheduler, retensi, checksum/TOC, lock | `scripts/p4/backup.js`, `backup-loop.js`, `common.js`, `locks.js` |
| Lifecycle Docker dan pemilihan volume recovery | `scripts/p4/lifecycle.js`, `scripts/p3/recovery.js`, `docker-compose.p4-recovery.yml` |
| Rebuild standby dan checkpoint cepat | `docker/p3/replica.sh` |
| Backend bertahan saat koneksi PostgreSQL gagal | `src/db-client.js`, `src/db.js`, `src/server.js` |
| Audit primary/replica dan koordinasi controller | `scripts/p3/dataset.js`, `docker.js`, `controller.js`, `util.js` |

## Riwayat kegagalan dan perbaikan

Jangan menutupi hasil gagal atau menggantinya dengan hasil replay belakangan. Run `03bf75dd3f2c` FAILED: backend crash akibat event error PostgreSQL Client yang tidak ditangani, HTTP 502, serta 409 ACK belum pulih. Run `7335f3c22883` FAILED pada bootstrap replica karena checkpoint spread pg_basebackup berlangsung 118,618 detik, melampaui healthcheck; 435 ACK kemudian dipulihkan. Koreksi `--checkpoint=fast` diuji secara terisolasi dan diterapkan.

Run `9463e0eb4291` dan `cb9cae52b08c` PARTIAL: audit teknis lulus tetapi masing-masing 379 dan 511 ACK baru sesudah snapshot belum terselesaikan. Investigasi salinan forensik membuktikan key/payload/ID sumber; pemulihan operasional kemudian menyelesaikan ACK tersebut. Ini mendorong opsi persetujuan replay ledger sebelum eksperimen, tanpa melemahkan gate. Dua run PASSED di atas memakai opsi tersebut. Angka riwayat ini adalah konteks remediasi lokal; paket bukti tercommit difokuskan pada dua eksperimen PASSED, bukan ekspor seluruh bukti forensik historis.

## Validasi perangkat lunak

Pemeriksaan sebelum commit: `npm.cmd test` menghasilkan **271 tes PASS, 0 FAIL, 0 SKIP**. [Log lengkap](p4-evidence/full-tests.txt). Ini mencakup tes unit, mock pipeline dan pemeriksaan baseline live; jangan menyebut 271 tes tersebut sebagai 271 eksperimen bencana nyata. Suite P4 terakhir sebelum run sukses berisi 191 tes PASS. Perbedaan jumlah adalah cakupan suite penuh vs P4.

## Kebutuhan laporan yang belum dibuktikan lengkap oleh paket ini

- Run DR ini menguji 100 VU selama 60 detik. Matriks 10/100/500/1.000 VU selama 1–3 menit pada DRP §8.1/NFR-6 tidak boleh dianggap seluruhnya selesai dari dua run ini. Bukti P3 harus ditinjau tersendiri bila digunakan sebagai lampiran.
- Scheduler 60 detik pernah diuji berulang pada sesi persiapan, tetapi tidak terbukti terus aktif selama dua run PASSED. Backup run utama berusia 170 detik. Ini harus menjadi batasan yang disebutkan, bukan klaim penjadwalan sudah terpenuhi sepanjang eksperimen.
- Screenshot insiden dan grafik yang diwajibkan Arsitektur §4.4.4/DRP §8.1 harus berasal dari bukti aktual. Jangan membuat screenshot seolah-olah merekam kejadian yang sudah lewat.
- Summary K6 memuat agregat latency/p95/RPS/error. Ledger memuat timestamp request/response sehingga kurva per interval dapat dihitung dengan label sebagai turunan ledger. Jangan menyebut agregat sebagai raw time series K6, atau membandingkan RPS outage+VU idle dengan throughput steady-state tanpa penjelasan.
- Skenario failover manual/promosi replica, Nginx crash, P5 CDN dan HA multi-host tidak dibuktikan oleh run T1-B/T2 ini.

## Instruksi siap diberikan kepada ChatGPT

> Susun laporan praktikum Pertemuan 4 Kelompok 1 berdasarkan dokumen P1 yang berlaku, source code, dan docs/p4-evidence. Gunakan run bfe0f3b7c035 sebagai hasil utama dan 27f60e05265e sebagai hasil pendukung. Pisahkan rancangan, implementasi, pengujian mock, eksperimen nyata, riwayat gagal, dan pemulihan operasional. Jelaskan restore snapshot ditambah replay ledger berotorisasi, 319 ACK awalnya hilang, RTO 110,826 detik dan RPO sebelum replay 0,005 detik, serta snapshot berusia 170 detik. Tampilkan tabel timeline, audit transaksi/stok, metrik K6, analisis akar masalah, perbandingan target dan batasan. Jangan mengarang screenshot, grafik, hasil matriks VU, atau mengklaim semua kewajiban dokumen sudah lengkap. Cantumkan sumber berkas setiap hasil. Tanyakan kebutuhan format institusi/identitas anggota bila tidak tersedia pada dokumen.
