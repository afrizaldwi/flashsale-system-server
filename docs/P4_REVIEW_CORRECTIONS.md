# P4: Empat koreksi sebelum DR ulang

Perubahan ini melanjutkan hardening setelah DR gagal pada 8 November 2026. Tidak ada DR aktual, start/stop/recreate container, restore aktual, transaksi pada database aktual, atau cleanup data yang dijalankan. Laporan insiden dan seluruh perubahan pengguna dipertahankan.

## A. K6 tidak memakai recognized status sebagai keberhasilan

`tests/load/p4-dr-workload.js` kini memakai `checks: rate==1` serta Counter `unexpected_responses: count==0`. HTTP 500/502/504 selalu gagal; 503 tanpa `DB_UNAVAILABLE` juga gagal. Respons bisnis yang diterima adalah 201, 200 DUPLICATE dan 409 SOLD_OUT. Dalam mode DR, tiap VU menghentikan checkout setelah respons outage kandidat maupun respons tidak diharapkan, lalu membiarkan K6 menyelesaikan ekspor summary dan threshold.

503 DB_UNAVAILABLE dan transport error adalah **kandidat** outage pada skrip K6. Host runner memverifikasi waktu respons terhadap `failureInjectionRequestedAt` yang didaftarkan oleh orchestrator tepat sebelum injeksi. Tanpa marker, waktu respons valid, atau mode outage, keduanya ditolak. Marker tetap awal permintaan injeksi, bukan bukti primary sudah mati. Penetapan `primaryUnavailableAt` dan T0 tetap memakai bukti lifecycle/health tersendiri.

Host menghitung `unexpectedResponseCount` dan memaksa `ok:false` meskipun exit code child 0. Ledger tetap dipersistenkan. Dengan demikian exit K6 0 tidak bisa menutupi respons 502 atau outage sebelum marker. Kebijakan host tersedia dalam `scripts/p4/workload-policy.js`. Format threshold diperiksa terhadap [dokumentasi resmi k6](https://grafana.com/docs/k6/latest/using-k6/thresholds/).

## B. Bukti VU sesuai dengan pengukuran

API dan laporan berubah dari `waitForActiveVUs`/`activeVUsCount` menjadi `waitForObservedVUs`/`observedVUsCount`. Bukti tersebut berarti jumlah ID VU unik yang pernah mengirim hasil transaksi ke ledger. Report `vuParticipation` menyatakan `concurrentActivityAtInjectionProven:false`; terminal result juga menjelaskan batas bukti ini.

Skenario tetap constant-vus 100 VU dan orchestrator masih memeriksa proses K6 hidup sebelum injeksi. Kombinasi konfigurasi, partisipasi historis, dan proses hidup **tidak diklaim** sebagai 100 request simultan atau 100 VU aktif tepat ketika primary dihapus. Tidak ada pengukuran runtime baru yang direka. Call site resmi, helper historis dan fixture test mengikuti nama API baru.

## C. Guard berada pada API performRestore

Eksekusi programatik harus memberi boolean `execute:true` secara eksplisit. Argumen CLI proses pengimpor tidak mengaktifkan restore. CLI hanya mem-parse opsi dan memanggil API yang sama.

Sebelum eksekusi, API memperoleh lock arsip/restore dan shared P3 operation.lock, lalu mensyaratkan:

- Manifest P3 sah dengan phase recovering dan controller paused boolean true.
- Konfirmasi ID primary recovery lengkap dan nama volume recovery tepat.
- Project/service/environment/db/user resmi P3, target berjalan dan network P3 benar.
- Tepat satu mount data berupa fresh recovery volume sesuai manifest, bukan volume primary atau replica asli.

Sesudah inspeksi nama awal, semua perintah diarahkan ke immutable ID. Target diperiksa kembali segera sebelum operasi destruktif pertama. Guard tidak dapat dilewati dengan pemanggilan API langsung atau opsi project clone. Perubahan target pada revalidasi tidak memicu cleanup container. Semua lease dilepas hanya sesuai ownership. Tes restore lama mendapat fixture manifest dan target recovery tiruan; tes tidak membaca atau menulis runtime P3 aktual.

## D. Pengamanan skrip transactional checkout

`scripts/test-transactional-checkout.py` mempertahankan order secara default. `--cleanup` adalah opt-in; `--no-cleanup` tetap kompatibel. Cleanup hanya boleh terjadi bila seluruh pengujian sukses dan tidak ada hasil ambigu.

Skrip memperoleh operation.lock eksklusif dengan PID/token sebelum preflight, memvalidasi konfigurasi/manifest melalui validator Node P3, dan memegang lock sampai futures serta cleanup selesai. Ownership dan manifest diperiksa lagi sebelum tiap checkout dan sebelum SQL cleanup. Lock milik proses lain, lock pengganti, atau lock rusak tidak dihapus. Python memilih menolak stale lock, bukan merebutnya otomatis.

Status 0 dan seluruh HTTP 5xx ditandai ambigu. Pending request dan exception pada future turut memblokir cleanup, termasuk jika exception muncul sebelum daftar hasil selesai diklasifikasikan. Oversell memakai jalur guarded checkout yang sama. Kegagalan assertion lain juga mempertahankan data untuk review. `NEEDS_MANUAL_REVIEW` tidak berarti order boleh dihapus hanya karena koneksi kembali stabil.

## Regresi dan batas validasi

Log akhir: `backups/p4/review-corrections-full.txt` dan `backups/p4/review-corrections-focused.txt`.

| Pemeriksaan | Hasil |
| --- | --- |
| npm.cmd test | 261 total, 254 PASS, 0 FAIL, 7 SKIP |
| Suite terfokus koreksi | 79 total, 78 PASS, 0 FAIL, 1 SKIP |
| git diff --check | PASS |

Regresi baru mencakup evaluasi skrip K6 aktual melalui VM dengan HTTP/metric/check tiruan, child exit 0 dengan respons salah, kandidat outage sebelum/sesudah marker, batas bukti observed VUs, dan penolakan restore API tanpa manifest/konfirmasi/volume/operation lock yang benar. Semua operasi Docker destruktif memakai mock.

Enam SKIP adalah pemeriksaan baseline live P3 yang tidak tersedia. Satu SKIP tambahan adalah runner regresi Python: tidak ada interpreter Python 3 terpasang (`py -3` melaporkan No installed Python found). Tujuh metode unittest Python berbasis mock telah disediakan di `tests/p4/transactional_python_test.py`, tetapi **belum dijalankan**. Tidak ada klaim bahwa sintaks/perilaku runtime Python telah tervalidasi di host ini. Skrip K6 juga belum dieksekusi dengan engine K6 nyata; VM menguji logika skrip dan host child-process tests menguji hasil runner.

Perintah verifikasi aman:

```powershell
npm.cmd test
git diff --check
node --test tests/p4/review-corrections.test.js tests/p4/workload.test.js tests/p4/restore.test.js tests/p4/archive-safety.test.js tests/p4/transactional-python.test.js
```

Setelah Python 3 tersedia, hanya jalankan suite mock untuk menutup batas validasi Python:

```powershell
py -3 -B tests/p4/transactional_python_test.py
```

Jangan menjalankan skrip transactional checkout terhadap P3 sebagai bagian validasi statis ini. Tidak ada commit/push. Hasil DR historis tetap FAILED; keberhasilan DR baru membutuhkan otorisasi dan bukti runtime terpisah.

## Rekonsiliasi ACK dengan persetujuan sebelum eksperimen, 9 November 2026 WIB

Restore snapshot dapat kehilangan ACK yang diterima setelah snapshot. Tanpa rekonsiliasi, pipeline tetap PARTIAL walaupun backend, replica, dan audit teknis sudah sehat. CLI sekarang menyediakan opsi eksplisit `--approve-ack-replay "alasan/persetujuan operator"`; default tetap review tanpa replay ACK hilang.

Opsi ini mengotorisasi rekonstruksi dari ledger eksternal menggunakan key dan payload asli. Setiap key memiliki approval `allowLedgerOnly: true` dengan alasan operator, INTENT yang di-fsync sebelum write, checkout dan retry DUPLICATE dengan ID sama, lookup primary independen melalui GET /orders/:id, serta snapshot primary baru melalui /stats. Audit setiap transaksi membuktikan delta jumlah order/qty dan stok per produk, bukan memakai snapshot cache. Kegagalan menghentikan write selanjutnya dan mempertahankan unresolved. Respons lookup hanya menyimpan kolom order yang relevan, tanpa nama pengguna.

Setelah seluruh replay, query SQL read-only independen mencocokkan semua ACK dengan key/payload unik dan menyimpan final-acknowledged-orders.json. Audit SQL P3 primary/replica, WAL catch-up, endpoint dan seluruh success gate tetap wajib. RPO dan daftar kehilangan awal tetap berasal dari hasil restore sebelum replay. T1/RTO mencakup penyelesaian rekonsiliasi; tidak ada PASS jika ACK belum selesai atau batas waktu gagal. Tidak ada kompensasi finansial otomatis.

Contoh eksekusi setelah dry-run READY, dengan target terbaru:

```powershell
npm.cmd run p4:dr -- --execute --confirm-primary '<ID_PENUH_TERBARU>' --confirm-volume '<VOLUME_TERBARU>' --approve-ack-replay 'Saya menyetujui rekonstruksi ACK dari ledger menggunakan key dan payload asli, retry idempoten, dan audit independen.'
```

Output terminal eksekusi aktual berupa ringkasan dan lokasi bukti. Report JSON, ledger, log K6 dan kehilangan awal tetap disimpan lengkap. Opsi persetujuan tidak mengubah hasil eksperimen lama.

### Bukti runtime lulus

Pada 9 November 2026 WIB, run `27f60e05265e` menghasilkan PASSED dengan opsi persetujuan replay ledger di atas. RTO 107,395 detik, RPO historis sebelum replay 0,075 detik, 431 ACK awalnya hilang dari snapshot kemudian direkonstruksi idempoten, unresolved 0; 100 request ambigu terselesaikan. Audit SQL akhir menemukan seluruh 431 key/payload unik. Semua success gate lulus, T1 tercatat setelah rekonsiliasi dan audit lengkap, manifest validated. Ini membuktikan pemulihan snapshot ditambah rekonstruksi ledger yang disetujui, bukan snapshot tanpa kehilangan ACK. Laporan PARTIAL/FAILED sebelumnya tetap tidak berubah.

Report: `results/p4/27f60e05265e/report.json`; ledger dan summary K6 di direktori yang sama. Bukti persetujuan sebelum injeksi: `backups/p4/approved-dr-1794158942920/authorization.json`. Verifikasi pasca-DR: `backups/p4/success-27f60e05265e/`. Seluruh 191 tes P4 PASS, 0 FAIL, 0 SKIP: `backups/p4/approved-replay-full-tests.txt`.
