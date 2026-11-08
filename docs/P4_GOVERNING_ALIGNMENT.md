P4 — penyesuaian terhadap dokumen pengatur, 8 November 2026

Dokumen pengatur yang dibaca langsung sebelum perubahan kode:

| Dokumen repository | Versi terverifikasi | Bagian acuan |
| --- | --- | --- |
| `docs/revisi/Pertemuan_1/Spesifikasi_Arsitektur_P1.docx` | 1.3, 7 November 2026 | §3 FR/NFR; §4.3–4.4 infrastruktur P3/P4; §5–6 database/API; §8.4 metrik |
| `docs/revisi/Pertemuan_1/DRP_Awal_P1.docx` | 1.1, 7 November 2026 | §4 target; §5 backup; §6 deteksi; §7.2 T1-B/T2; §8–9 pengujian/audit |

SHA-256 saat pembacaan: Arsitektur `11b02266ae0973daf4b2ef9dc23620d8f3aa93e237a680ffcde4c41632517b2c`; DRP `b39263284e9a9663093f3c6e9d22337ec44885fafd6ae5b06070d4b76505f8c6`. Ekstraksi teks dan hash disimpan di `backups/p4/*-governing.txt`. Dokumen Word dibaca dengan file sharing, tanpa diedit oleh agen; lock file Word dan perubahan dokumen pengguna dibiarkan utuh. PDF v1.0.2/v1.2 tidak digunakan sebagai pengganti.

Konflik yang diperbaiki

| Implementasi sebelumnya | Dampak | Jalur yang berlaku |
| --- | --- | --- |
| Clone `flashsale-p4-dr`, port 8088 dan seeding ulang P4 | Bukan uji wajib pada aplikasi P3 | CLI resmi memakai `flashsale-p3`, `docker-compose.p3.yml`, `.env.p3`, database `flashsale_p3`, port 8080. Tidak deploy, seed, atau reset P3 otomatis. Clone dan bukti lamanya tetap disimpan; eksekusi clone dari API resmi dinonaktifkan. |
| RTO dari waktu injeksi | Deteksi dan injeksi tercampur | Timestamp injeksi dipisahkan. T0 resmi adalah respons `/health` 503 kedua berturut-turut. Respons lain mereset hitungan. |
| RPO dari transaksi terakhir yang dipulihkan | Tidak mengikuti definisi transaksi acknowledged terbaru yang hilang | Cocokkan key ledger dan orders; gunakan usia ACK terbaru yang hilang terhadap waktu injeksi. ACK yang datang sesudah injeksi dicatat dan diklasifikasikan terpisah, termasuk kehilangan/kompensasi. |
| Interval default 30 detik | Berbeda dari rancangan backup ±60 detik | Default 60 detik; tetap serial, dengan lock loop dan lock job bersama untuk backup manual/terjadwal. |
| Pemeriksaan P3 hanya menerima volume asli | Controller menolak hasil recovery pada volume baru | Manifest recovery terverifikasi membuat Compose dan audit P3 menerima hanya pasangan volume recovery yang tepat. Tidak mengubah nama project, network, identitas database atau kredensial. |
| CLI restore dapat menargetkan volume asli | Melanggar pelestarian data forensik | Eksekusi CLI restore memerlukan manifest `recovering`, volume baru, dan konfirmasi ID/volume. Jalur wajib memulihkan ke cluster/database baru dalam volume baru dengan nama database logis tetap `flashsale_p3`. |

Alur resmi dan batas keselamatan

1. Dry-run memvalidasi konfigurasi P3, container/volume, checksum dan metadata backup. Pemeriksaan TOC/database memerlukan P3 berjalan. Dry-run tidak menyalakan layanan yang berhenti.
2. Eksekusi aktual mensyaratkan `--execute`, `--confirm-primary <ID container penuh hasil inspeksi>`, dan `--confirm-volume <nama volume tepat>`. Konfirmasi diperiksa sebelum perubahan database atau control file. Tidak ada eksekusi aktual pada sesi penyesuaian ini.
3. Operasi menunggu `.p3/operation.lock`, lalu menyimpan control state dan pause controller. Startup CLI/controller, tick autoscaling, serta aktuator recover/scale-in/scale-out memakai mutex yang sama. Panggilan bertingkat dalam satu operasi memakai lease bertoken melalui async context; operasi lain tidak boleh meminjamnya. Aksi scale yang sedang berjalan harus selesai sebelum P4 melanjutkan, atau P4 berhenti pada timeout sebelum injeksi. Baseline `/stats`, `/health`, `/products` dan marker database P3 diperiksa tanpa reset dataset.
4. Backup terbaru yang memiliki metadata selesai, SHA-256 cocok dan TOC valid diuji melalui restore ke database sementara dengan nama unik. Hanya database sementara itu yang dibuat/dihapus; database kerja tidak ditimpa.
5. K6 memakai 100 VU, skenario 60 detik, key `p3-dr-*`, dan produk in-stock terendah secara deterministik. Ledger eksternal siap sebelum spawn. Minimal satu ACK dan tidak ada 0/5xx pada baseline diperlukan sebelum insiden. Ini bukan klaim bahwa seluruh matriks NFR-6 telah diuji.
   Gate partisipasi memakai `waitForObservedVUs(100)`: 100 ID pernah terlihat di ledger, bukan bukti 100 VU aktif simultan saat penghapusan. Runner hidup diverifikasi tersendiri. Respons 500/502/504 dan 503 salah klasifikasi menggagalkan workload meskipun exit child 0; kandidat 503 DB_UNAVAILABLE/transport membutuhkan marker outage host. Detail koreksi: [P4_REVIEW_CORRECTIONS.md](P4_REVIEW_CORRECTIONS.md).
6. Run ID dan kedua nama volume recovery dibuat sebelum injeksi; ketidaktersediaan nama volume diperiksa tanpa membuat volume. Setelah semua preflight, ID/mount dan workload diperiksa ulang. Tepat sebelum perintah penghapusan, `.p3/recovery.json` disimpan atomik dengan `phase: recovering`, project/database/marker P3, ID dan volume primary asli, serta kedua nama volume baru. Manifest tetap melindungi startup meskipun proses crash setelah primary dihapus atau hasil penghapusan ambigu. Hanya container primary yang dikonfirmasi dihapus; volume primary asli disimpan. Injeksi dan deteksi dicatat terpisah. Dua health 503 menetapkan T0; kegagalan deteksi membuat laporan gagal, bukan mengganti T0 diam-diam dengan injeksi.
7. Tiap VU berhenti mengirim checkout setelah melihat 503/timeout, lalu tetap hidup hingga skenario selesai normal agar output dan summary terekam. Semua exit nonzero tetap dicatat sebagai kegagalan workload. Kegagalan workload setelah T0 tidak menghentikan urutan restore. Backend kemudian dihentikan sementara untuk fencing penulisan selama restore/audit mandiri.
8. Pilih ulang backup terbaru yang valid; standby lama hanya dipakai untuk membaca TOC arsip. Salinan backup yang dipilih dipertahankan dalam direktori bukti dan checksum diperiksa ulang. Buat dua volume baru dengan nama unik dan label Compose/identitas tepat; volume yang sudah ada ditolak, tidak dihapus atau dipakai ulang.
9. Manifest yang sudah disimpan sebelum injeksi menunjuk volume `flashsale-p3_primary_recovery_<run>` dan `flashsale-p3_replica_recovery_<run>`; manifest tidak dibuat ulang atau dibersihkan saat pembuatan volume/restore gagal. Overlay `docker-compose.p4-recovery.yml` hanya mengganti mount data. Primary hasil restore diperiksa secara mandiri: nama database, marker P3, writable role, stok, key duplikat dan konservasi stok.
10. Standby lama dihentikan dan containernya diganti setelah verifikasi ulang ID/mount; volume replica asli disimpan. `docker/p3/replica.sh` menjalankan `pg_basebackup` pada volume standby baru. Verifikasi kedua role/marker dan mount setelah rekonstruksi.
11. Hidupkan kembali backend yang sama, tunggu `/ready` internal melalui probe P3 pada port 3001, dan gunakan `Routing.apply()` P3 untuk validasi candidate, reload dan verifikasi generation Nginx. Tidak membuat controller/routing kedua untuk P4.
12. Catat health 200 dan checkout recovery 201 secara terpisah. Bandingkan seluruh ACK, termasuk ACK terlambat, sebelum replay; kehilangan awal tetap disimpan. Pisahkan rekonsiliasi ACK dari replay ambiguous. ACK hilang memerlukan investigasi salinan forensik primary asli, persetujuan per key/payload sebelum rekonstruksi idempotent, atau catatan kompensasi bisnis yang selesai. SOLD_OUT tidak diulang tanpa batas. Prosedur dan format bukti: [P4_POST_FAILURE_HARDENING.md](P4_POST_FAILURE_HARDENING.md).
13. Audit aktual menggunakan query P3 pada primary/replica dalam snapshot read-only, WAL replay checkpoint, konservasi stok per produk, jumlah order/qty, duplicate keys, marker/role dan `/stats`. Audit teknis dicatat terpisah. T1 baru dicatat jika checkout valid, audit lengkap, semua ACK terselesaikan/terkompensasi secara eksplisit, dan seluruh syarat DR sukses terpenuhi.
14. Simpan laporan, ledger, summary K6, metadata backup dan jurnal rekonsiliasi dalam `results/p4/<run>/`. Manifest menjadi `validated` hanya jika seluruh pemeriksaan sukses, termasuk K6, T0, batas RTO/RPO, backend bertahan, akses replica, role, integritas dan transaksi. Jika gagal, controller tetap paused, manifest tetap `recovering`, T1 tidak dicatat dan start/scale biasa ditolak. Tidak ada teardown stack P3 atau penghapusan volume otomatis.

Pengukuran yang dilaporkan

Koordinasi arsip: backup, restore/trial restore dan retensi memakai mutex eksklusif `.backup-job.lock`. Restore menambahkan `.restore.lock` eksklusif berisi token unik dan PID; kegagalan memperoleh salah satu lock menghentikan operasi. Pelepasan harus cocok dengan token dan PID, tidak menghapus lock pengganti milik proses lain. Tidak ada penghapusan stale archive lock otomatis. Backup loop memiliki `.backup.lock` sendiri dan hanya memperoleh mutex arsip selama satu job, bukan selama tidur antar-siklus.

Retensi menerima hanya satu set lengkap `.dump`/`.sha256`/`.meta.json`: status `VALIDATED`, identitas/nama file, ukuran, waktu, durasi, jumlah TOC, checksum metadata/sidecar, dan TOC aktual harus valid. Maksimal 10 set valid terbaru dipertahankan; minimal satu tetap ada sebelum pruning. Kehadiran `.restore.lock` menghentikan seluruh pruning, termasuk bila file rusak atau tidak terbaca. File sementara, arsip invalid dan file tidak terkait dibiarkan untuk inspeksi. Retry penghapusan Windows dipertahankan. Lock arsip crash yang tertinggal membutuhkan pemeriksaan operator; tidak direbut otomatis.

- Semua event UTC: K6 start/handshake, error checkout pertama, injeksi, deteksi/T0, pemilihan backup, restore mulai/selesai, standby selesai, health 200, checkout recovery pertama, audit selesai/T1.
- `failureInjectionRequestedAt` adalah awal permintaan penghapusan, bukan bukti primary sudah mati. `primaryUnavailableAt` berasal dari Docker die event dengan ID tepat atau state stopped/FinishedAt yang terverifikasi. Bukti lifecycle disimpan; bukti tidak lengkap menggagalkan validasi. ACK dipisah menjadi sebelum injeksi, jendela shutdown, dan sesudah primary tidak tersedia; tanpa bukti lifecycle, ACK sesudah injeksi tetap berstatus waktu belum pasti.
- RTO resmi = `(T1 - failureDetectionAt) / 1000`, target 300 detik. Injeksi tetap tercatat terpisah agar convention dapat diaudit.
- RPO resmi = `(failureInjectionAt - newestLostPreIncidentAcknowledgement) / 1000`, target 60 detik; tanpa ACK yang hilang nilainya 0 hanya jika ada bukti ACK valid. Ledger kosong/error-only menghasilkan RPO belum terukur (`null`). ACK terlambat dicatat sebagai kategori tersendiri, bukan dibuang.
- Request UTC dan response UTC disimpan terpisah; pengakuan klien memakai waktu respons. Kehilangan diukur sebelum replay dan tidak dihapus dari laporan setelah replay berhasil. Usia snapshot backup juga dilaporkan sebagai indikator terpisah.
- Timestamp awal backup adalah lower bound konservatif sebelum `pg_dump`, bukan klaim timestamp exported snapshot yang persis. Metadata menyertakan completion, durasi, ukuran, checksum dan status. Retensi produksi memeriksa TOC serta checksum sebelum menghitung arsip valid, dan mempertahankan 10 yang terbaru.

Pemetaan NFR v1.3 — ID tidak diubah

| ID | Persyaratan | Bukti/pemeriksaan yang tersedia; batas klaim |
| --- | --- | --- |
| NFR-1 | Stok tidak negatif; CHECK dan UPDATE atomik | Logika transaksi/schema tetap; lifecycle koneksi backend diperkuat dan audit negative stock tetap wajib setelah restore/replay. |
| NFR-2 | initial_stock − stock = SUM(qty) per produk | Query snapshot primary/replica dan `/stats`; T1 ditolak jika mismatch. |
| NFR-3 | Key unik, retry tanpa order ganda | Kontrak checkout tetap; duplicate query, replay key asli dan pemeriksaan order ID/repeat response. |
| NFR-4 | Backend hidup saat DB gagal, error terstruktur | Perilaku outage diverifikasi sebelum maintenance stop backend; tidak mengubah API untuk meloloskan DR. |
| NFR-5 | RTO ≤300s, RPO ≤60s dari uji aktual | Checkpoint dan rumus diselaraskan; **belum diukur pada uji destruktif P3**. |
| NFR-6 | 10/100/500/1.000 VU, 1–3 menit, throughput/p95/error/first-error | Skrip/matriks P3 dipertahankan; K6 DR mengekspor summary dan ledger timestamp. Matriks performa penuh tidak dijalankan pada sesi ini. |
| NFR-7 | Satu backend gagal tidak mematikan semuanya | Arsitektur/controller/routing P3 dipertahankan; tidak mengklaim uji kegagalan backend baru. |
| NFR-8 | Standby read-only, rebuildable, lag diperhitungkan | `pg_basebackup`, role/marker, WAL catch-up, perbandingan snapshot dan header replica. |
| NFR-9 | Backup terpisah, checksum, retensi, restore test | `backups/p3/`, checksum/TOC, retensi 10, lock, trial restore. |
| NFR-10 | Tidak reset/hapus volume asing otomatis | Tidak seed/reset; nama/label/mount/ID diverifikasi; tidak ada volume rm atau down -v pada jalur resmi. |
| NFR-11 | Satu writable primary, fencing sebelum promosi | T1-B menghapus primary terkonfirmasi sebelum replacement; dua role diperiksa. Tidak ada promosi atau failback otomatis. |
| NFR-12 | Bukti dan prompt dapat diaudit | Laporan run, ledger/summary, metadata, ekstraksi/hash dokumen, tes dan catatan PROMPTS. |

Skenario terpisah

- T1-A merecreate primary dengan volume asli; tidak dijalankan oleh T1-B/T2.
- T1-C tetap merupakan runbook tambahan DRP; pergantian role setelah promosi belum diotomasi pada jalur T1-B. Rekonsiliasi ACK kini tersedia melalui review eksplisit, jurnal dan API checkout; forensik volume membutuhkan salinan terisolasi serta verifikasi operator. Menjalankan `pg_ctl promote` saja bukan pemulihan lengkap. Tidak ada promosi/failback yang dijalankan atau diklaim berhasil.
- FR-1 sampai FR-13 dan kontrak API tetap memakai implementasi P1–P3. Tidak menambahkan auth/payment/shipping, multi-item, multi-region, HA otomatis, atau fitur P5.

Status validasi sesi ini

- Review keselamatan terbaru: `npm.cmd test` menghasilkan **209 tes; 203 passed, 0 failed, 6 skipped**, tanpa cancelled/todo. Ada 30 regresi baru: 8 pada pipeline/sinkronisasi P3, 21 pada arsip/lock/retensi, dan 1 pada kepemilikan lock loop. Crash diuji dengan child process nyata yang keluar tanpa `finally`, tetapi seluruh Docker/HTTP pada pipeline tetap simulasi. Ini **bukan bukti recovery runtime aktual**.
- Enam skip adalah pemeriksaan live P3: identitas container, role primary, role standby, read routing, health, dan business invariants. P3 tetap berhenti; review ini tidak menyalakan layanan untuk menjalankan pemeriksaan tersebut.
- Dry-run sesi penyesuaian sebelumnya: exit 0, status **BLOCKED** karena primary P3 `exited`. Enam arsip memiliki metadata/checksum yang cocok; TOC dan database P3 belum dapat diperiksa saat primary berhenti. Review keselamatan ini tidak menjalankan DR aktual.
- Compose P3 dan Compose P3 + overlay recovery: valid, exit 0. Variabel volume dalam validasi hanya diberikan kepada proses `config`, tanpa membuat volume.
- P3 tidak dinyalakan, dihentikan, dihapus atau direstore pada sesi penyesuaian ini. P2 dan clone P4 juga tidak dimutasi. Volume primary/replica asli tetap ada. Pengecualian enam file `/tmp` P3 dari sesi debugging sebelumnya tetap tercatat di laporan historis; tidak dibersihkan pada sesi ini.
- Bukti review terbaru: `backups/p4/safety-full-tests.txt`, `backups/p4/safety-targeted.txt`, dan [P4_SAFETY_REVIEW.md](P4_SAFETY_REVIEW.md). Bukti penyesuaian sebelumnya tetap disimpan di `backups/p4/alignment-tests.txt` dan `backups/p4/governing-dry-run.txt`.

Perintah aman berikutnya dari PowerShell

```powershell
npm.cmd test
docker compose --project-name flashsale-p3 --env-file .env.p3 -f docker-compose.p3.yml config --quiet
npm.cmd run p4:dr
npm.cmd run p3:status
```

P3 harus dihidupkan dan diverifikasi sebagai langkah operator tersendiri sebelum uji aktual. Setelah seluruh persiapan/bukti siap, operator harus meninjau ulang ID container dan nama volume terkini dari dry-run dan memberi konfirmasi eksplisit. Jangan menyalin ID lama dari laporan untuk eksekusi baru. Tidak ada instruksi untuk mengeksekusi injeksi diberikan sebagai langkah aman di atas.
