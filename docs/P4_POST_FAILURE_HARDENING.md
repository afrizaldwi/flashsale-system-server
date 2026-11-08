# P4: Perbaikan setelah DR gagal, 8 November 2026

Koreksi lanjutan K6/VU, guard API restore, dan cleanup transactional checkout beserta hasil validasi terbaru tersedia dalam [P4_REVIEW_CORRECTIONS.md](P4_REVIEW_CORRECTIONS.md). Angka 237/231/6 di bagian validasi dokumen ini adalah hasil sesi hardening awal sebelum koreksi lanjutan.

Acuan tetap Spesifikasi Arsitektur P1 v1.3 bagian 3–6/8.4 dan DRP P1 v1.1 bagian 4–9. Jalur resmi tetap `flashsale-p3`, `docker-compose.p3.yml`, `.env.p3`, database `flashsale_p3`, ingress `127.0.0.1:8080`. Target RTO ≤300 detik dan RPO ≤60 detik tidak diubah. Tidak ada DR aktual ulang pada pekerjaan ini.

## Bukti insiden yang dipertahankan

Sumber lokal: `results/p4/03bf75dd3f2c/report.json`, `transactions.jsonl`, `k6-summary.json`. Berkas asli tidak ditulis ulang.

| Hasil aktual run tersebut | Nilai |
| --- | ---: |
| ACK HTTP 201 sebelum injeksi | 390 |
| ACK tersebut ditemukan pada restore awal | 0 |
| ACK sebelum injeksi hilang | 390 |
| ACK terlambat, dahulu LOST_COMPENSATION_REQUIRED | 19 |
| Total ACK tidak ditemukan pada restore awal | 409 |
| Transaksi ambiguous | 98.133 |
| RPO menurut konvensi yang sudah berlaku | 0,037 detik |
| Usia snapshot yang dilaporkan | 38 detik |
| T0 | Tidak terdeteksi |
| RTO resmi | Tidak dapat dinyatakan selesai |
| Hasil | FAILED |

Marker injeksi `09:38:57.187Z` dicatat sebelum `docker rm -f` selesai. Sembilan belas ACK terlambat diterima `09:38:57.214Z`–`09:38:57.248Z`. Belum ada bukti lifecycle dalam run lama untuk menetapkan tepat kapan primary tidak tersedia. ACK tersebut mungkin berada dalam jendela shutdown; keberadaan commit-nya pada volume asli belum dibuktikan. Jangan menganggap ACK tersebut pasti terjadi setelah PostgreSQL berhenti.

RPO lama memakai waktu injeksi dikurangi ACK hilang paling baru sebelum injeksi. Jarak 0,037 detik bisa kecil sekalipun 390 ACK hilang. Konvensi tetap dipertahankan, tetapi kehilangan ACK dilaporkan sebagai jumlah dan daftar transaksi tersendiri. Keberhasilan replay 98.133 transaksi ambiguous tidak menyelesaikan 409 ACK yang dikeluarkan dari daftar ambiguous.

Laporan lama mencatat `success:false`, checkout/products 502, dan kedua backend tidak hidup. T1 yang dahulu ditulis oleh kode lama tidak memenuhi pemulihan bisnis lengkap; bukti historis tetap disimpan, bukan dikoreksi diam-diam.

## Akar masalah dan perbaikan backend

`pg.Pool` sudah memiliki listener error idle. Namun listener idle dilepas saat client di-checkout; checkout dan `/stats` memegang Client selama beberapa query transaksi. Event error Client di celah tersebut dapat menjadi `Unhandled 'error' event` dan mematikan Node. Observasi pengguna menyebut `read ECONNRESET` dan `Connection terminated unexpectedly`, `OOMKilled=false`, serta RestartCount 0 pada inspeksi; ini tidak membuktikan OOM.

`src/db-client.js` menyediakan Client dengan listener sepanjang umur koneksi. Client rusak ditandai, query berikutnya ditolak, dan `releaseClient` membuang koneksi rusak pada finally. Listener tidak melepaskan client di tengah transaksi sehingga tidak terjadi double-release. Error query/rollback tetap diteruskan ke handler HTTP. Seluruh pool aplikasi, termasuk readiness, menggunakan Client tersebut; helper Client langsung memakai kelas yang sama. Tidak ada handler uncaughtException yang menelan error, pool pengganti tanpa batas, promosi, atau loop reconnect baru.

`/live` mengembalikan 200 selama proses hidup; `/ready` mengikuti kesiapan writer. Saat primary tidak tersedia, `/health` dan checkout memberi 503, checkout `DB_UNAVAILABLE`. `/products` tetap menggunakan standby sehat dan header `X-Read-From: replica`. Pool yang sama membuat koneksi baru ketika database kembali. Penghentian backend terencana dalam prosedur DR untuk fencing restore tetap terpisah dari crash backend akibat gangguan koneksi.

Perilaku pg.Pool dan Client diperiksa terhadap implementasi dependency lokal serta dokumentasi resmi [Client events](https://node-postgres.com/apis/client) dan [Pool release/error events](https://node-postgres.com/apis/pool).

## Timeline dan pembukuan ACK

Laporan baru menyediakan `failureInjectionRequestedAt`, `primaryUnavailableAt`, `failureDetectionAt`, `k6FirstErrorAt`, `restoreStartedAt`, `restoreCompletedAt`, `standbyRebuiltAt`, `firstSuccessfulRecoveryCheckoutAt`, dan `integrityAuditCompletedAt`. Nilai belum teramati tetap null. Alias `failureInjectionAt` dipertahankan untuk kompatibilitas dan rumus RPO.

Sesudah penghapusan, observer mengambil riwayat Docker `die` untuk ID immutable yang dikonfirmasi dan memverifikasi container sudah tidak ada atau tidak berjalan. Timestamp event nanodetik diparse tanpa kehilangan presisi integer. State stopped dengan FinishedAt dapat menjadi bukti alternatif. Awal perintah rm bukan bukti kematian. Bila bukti hilang, akses Docker ditolak, ID salah, atau container masih berjalan, waktu unavailability tidak diklaim dan validasi gagal.

T0 tetap respons kedua dari dua health 503 berurutan. HTTP 502, timeout dan koneksi ingress gagal tidak menggantikan T0. Liveness serta StartedAt/RestartCount dibandingkan sebelum dan sesudah beban untuk mendeteksi crash/restart selama outage.

`allAcknowledgedTransactions` deduplikasi transaksi logis memakai Idempotency-Key asli, dengan ACK pertama per key. Masing-masing menyimpan payload, status, order ID, waktu request/response, kategori waktu, dan keberadaan pada recovery. `acknowledgementLoss` melaporkan kehilangan sebelum injeksi, selama jendela shutdown, sesudah primary tidak tersedia, total ACK sesudah primary tidak tersedia, kategori waktu belum pasti, dan total hilang. `lostTransactions` mencakup seluruh ACK hilang, termasuk late ACK; daftar lama sebelum injeksi juga tetap tersedia.

## Investigasi forensik primary asli

Prosedur ini disediakan untuk pekerjaan operator yang diotorisasi terpisah. Tidak dijalankan pada sesi perbaikan ini.

1. Catat ID/volume primary dan replica asli dari manifest/laporan insiden. Simpan hash laporan, ledger, backup, dan metadata. Pastikan primary asli tetap fenced, tidak terhubung kembali sebagai writer aplikasi, dan tidak ada container berjalan yang menulis volume sumber.
2. Buat volume salinan dengan nama baru yang belum ada. Gunakan helper sementara terisolasi (`--network none`, tanpa port host, root filesystem read-only, tanpa hak tambahan) yang memasang volume asli **read-only** dan tujuan salinan writable. Salin data lengkap beserta permission/ownership, WAL dan symlink yang relevan. Jangan menjalankan PostgreSQL pada sumber; mount read-only database yang crash lalu menjalankan PostgreSQL bukan metode recovery yang aman.
3. Buat manifest hash isi file sumber dan salinan sebelum PostgreSQL dijalankan; bandingkan, simpan bukti identitas mount read-only dan hasilnya. Jika sumber berubah atau salinan tidak cocok, hentikan investigasi. Simpan salinan awal sebagai bukti dan gunakan salinan kerja tambahan jika diperlukan. Tidak ada rsync arah balik atau perubahan pada sumber.
4. Hanya salinan kerja boleh menjalankan PostgreSQL versi mayor yang sama untuk crash recovery. Gunakan container terpisah, `--network none`, tanpa publish port, socket lokal saja (`listen_addresses=''`), dan session default read-only. Crash recovery memang menulis salinan kerja; inilah alasan volume asli tidak boleh dijalankan. Tidak ada promosi, koneksi replikasi ke cluster aktif atau failback.
5. Melalui exec lokal container forensik, ekspor dalam `BEGIN READ ONLY` data `id,idempotency_key,user_id,product_id,qty,created_at` dari orders. Verifikasi database dan marker P3; simpan JSON array di host dan SHA-256 ekspornya. Bandingkan key, payload, ID dan timestamp dengan ledger serta ekspor recovery. Catat selisih waktu bila clock tidak konsisten; jangan memperkirakan commit yang tidak dibuktikan.
6. Simpan provenance: `originalVolume`, `copyVolume`, `originalMountedReadOnly:true`, `isolated:true`, `verifiedBy`, `exportedAt`, `exportFile`, `exportSha256`. Ini adalah attestasi operator beserta bukti hash, bukan klaim bahwa software sudah membuktikan asal fisik ekspor. Modul tidak membuka atau memodifikasi volume asli.

## Rekonsiliasi ACK dan kompensasi

`scripts/p4/reconcile-acknowledged.js` menyediakan review offline dan jalur `--apply-approved` untuk penggunaan operator berikutnya. Jalur apply tersedia dalam kode tetapi tidak dieksekusi pada sesi ini. Mode apply memerlukan manifest recovery terverifikasi, controller paused, mutex operasi P3, role/marker/integritas benar, ID primary recovery lengkap dan nama volume recovery yang tepat. Volume primary asli tidak boleh sedang dipasang oleh container berjalan. Tidak ada start/stop/container removal atau SQL write langsung dalam modul ini.

Default orchestrator hanya mereview ACK hilang; tidak otomatis membuat order pengganti. Review approval memakai key dan payload asli:

```json
{
  "approvals": [{
    "idempotencyKey": "original-key", "action": "REPLAY",
    "userId": 2, "productId": 1, "qty": 2,
    "approvedBy": "operator", "reason": "Payload dan bukti tail order sudah diperiksa"
  }],
  "compensations": []
}
```

Tambahkan provenance forensik di properti `forensic` setelah salinan diverifikasi. Loader memeriksa hash file ekspor; replay dari old primary memerlukan tepat satu order dengan key/payload/ID cocok dan waktu order tidak lebih baru dari ACK. Jika order tidak ditemukan pada keduanya, replay berbasis ledger memerlukan `allowLedgerOnly:true` secara eksplisit pada persetujuan per key; payload hilang tidak diisi dengan user/product/qty rekaan.

Sebelum POST checkout, jurnal append-only menyimpan INTENT lengkap dan di-fsync. Rekonstruksi menggunakan API checkout atomik dengan Idempotency-Key asli, kemudian memeriksa tepat satu order dengan payload/ID benar dan audit konservasi stok. Percobaan berikutnya memakai key yang sama; UNIQUE/advisory lock/UPDATE bersyarat aplikasi tetap melindungi duplicate dan decrement ganda. Jurnal OUTCOME menyimpan respons, bukti awal, hasil lookup/audit dan alasan kegagalan. Crash setelah POST tetap meninggalkan intent untuk diperiksa kembali; jangan mengganti key.

Hasil yang tersedia: `PRESENT_IN_RECOVERED`, `RECOVERED_FROM_OLD_PRIMARY`, `REPLAYED_IDEMPOTENTLY`, `BUSINESS_COMPENSATION_REQUIRED`, `UNRESOLVED`. SOLD_OUT langsung menjadi kebutuhan kompensasi, tanpa loop retry. Kompensasi hanya dianggap selesai dengan catatan `idempotencyKey`, `status:COMPLETED`, `approvedBy`, `reference`, `resolution`, dan `completedAt`. Record tersebut harus merujuk tindakan bisnis yang benar-benar telah disetujui dan selesai; modul tidak melakukan refund/payment atau operasi keuangan lain. Status pending atau field tidak lengkap tetap unresolved.

Semua hasil menyimpan original status/order ID/payload/timestamps, match forensik/recovery, action, result, compensation status, timestamp dan alasan unresolved. Laporan baru tidak menulis ulang insiden lama. Rekonsiliasi belakangan tidak mengubah hasil DR historis, T1 lama, atau manifest menjadi validated secara otomatis.

## Syarat sukses dan batas klaim

Evaluator terpusat mewajibkan K6 sukses, bukti T0 yang benar, bukti lifecycle primary, RTO/RPO dalam target, backend tetap hidup tanpa restart, checkout 503 DB_UNAVAILABLE saat outage, baca replica tetap 200, tepat satu writer dan satu standby, audit database/aplikasi/konsistensi stok lulus, seluruh ACK present/recovered/terkompensasi lengkap, dan bukti outcome untuk seluruh replay ambiguous. SOLD_OUT tanpa kompensasi selesai tidak lulus.

ACK belum terselesaikan membuat success false/result PARTIAL sesudah infrastruktur pulih; exception menjadi FAILED. Manifest tetap recovering dan controller paused. Tidak ada T1 pemulihan bisnis; `rto.seconds` tetap null, sedangkan `elapsedUntilIntegrityAuditSeconds` hanya durasi sampai audit teknis. T1 dan validated hanya dicatat setelah semua pemeriksaan sukses. Volume asli selalu dipertahankan; recovery memakai volume baru. Tidak ada failback otomatis.

## Berkas yang berubah pada perbaikan ini

| Berkas | Tujuan |
| --- | --- |
| `src/db-client.js`, `src/db.js`, `src/server.js` | Lifecycle Client/Pool, release rusak, live/ready |
| `scripts/init-db.js`, `scripts/verify-db.js`, `scripts/reconcile-old-primary.js` | Client langsung memakai listener yang sama |
| `scripts/docker-failover.js` | Listener pool pada probe sekali jalan |
| `scripts/p4/lifecycle.js`, `scripts/p4/p3-dr.js` | Bukti Docker/timeline, ACK accounting/reconciliation, manifest dan controller gate |
| `scripts/p4/ledger.js`, `scripts/p4/workload.js`, `tests/load/p4-dr-workload.js` | Payload/timestamp/error classification, respons terputus |
| `scripts/p4/reconciliation.js`, `scripts/p4/reconcile-acknowledged.js`, `scripts/p4/success.js` | Jurnal/review/apply dengan approval dan evaluator hasil |
| `tests/p4/backend-resilience.test.js`, `tests/p4/helpers/backend-resilience.js` | Proses backend nyata, pg.Pool nyata, transport DB tiruan |
| `tests/p4/acknowledgement-recovery.test.js` | Timeline, forensik, replay/kompensasi dan syarat sukses |
| `tests/p4/p3-dr.test.js`, `tests/p4/helpers/dr-runtime.js`, `tests/p4/workload.test.js` | Alur DR mock, kehilangan 390/19 ACK, metadata fixture dan bukti abnormal exit |
| `docs/PERTEMUAN_4.md`, `docs/P4_GOVERNING_ALIGNMENT.md`, dokumen ini | Hasil insiden dan prosedur berlaku |

Dokumen DOCX governing, hasil insiden asli, dataset dan volume aktual tidak diubah. Perubahan pengguna yang sudah ada dipertahankan. Tidak ada branch baru, commit atau push.

## Validasi aman

Hasil regresi akhir dicatat setelah seluruh perubahan kode. Log lokal: `backups/p4/post-failure-full-tests.txt` dan `backups/p4/post-failure-targeted.txt`. Semua operasi destruktif di test memakai driver tiruan; proses backend diuji sebagai child process pada port ephemeral dengan transport DB tiruan. Enam integrasi live diperiksa ketersediaannya lalu dilewati bila stack/Docker tidak dapat diakses. Skip bukan PASS recovery aktual.

| Pemeriksaan akhir | Hasil aktual |
| --- | --- |
| `npm.cmd test` | 237 total: 231 PASS, 0 FAIL, 6 SKIP |
| Suite terfokus empat file pada perintah di bawah | 67 PASS, 0 FAIL, 0 SKIP |
| `git diff --check` | PASS, exit 0 |
| Compose `config --quiet` | PASS, exit 0; peringatan akses `.docker/config.json` pengguna ditolak |

Ada 28 regresi baru: 3 proses backend, 22 accounting/lifecycle/rekonsiliasi/gate, 2 alur orchestrator untuk 390/19 ACK hilang, dan 1 persistensi ledger ketika workload exit abnormal. Skenario rekonstruksi memverifikasi duplicate prevention serta konservasi stok; jalur apply diuji dengan Docker/API tiruan, termasuk penolakan volume asli aktif dan konfirmasi target salah.

Enam SKIP mencakup inspeksi container P3, role primary, role standby, routing katalog replica, health aplikasi, dan invariants bisnis live. Pemeriksaan ketersediaan tidak berhasil; sesi ini tidak menyimpulkan keadaan aktual container dari hasil skip. Peringatan Compose berasal dari pembacaan konfigurasi pengguna, bukan penolakan auto-review atau permintaan otorisasi untuk mengubah Docker.

Perintah aman untuk pemeriksaan berikutnya, tanpa start atau perubahan database:

```powershell
npm.cmd test
git diff --check
docker compose --env-file .env.p3 -f docker-compose.p3.yml config --quiet
node --test tests/p4/backend-resilience.test.js tests/p4/acknowledgement-recovery.test.js tests/p4/p3-dr.test.js tests/p4/workload.test.js
```

Review offline setelah operator menyediakan ekspor orders recovery JSON array yang dibaca tanpa write:

```powershell
node scripts/p4/reconcile-acknowledged.js --ledger results/p4/03bf75dd3f2c/transactions.jsonl --recovered-orders <ekspor-orders-recovery.json> --output <laporan-review-baru.json> --injection-at 2026-11-08T09:38:57.187Z
```

Placeholder harus diganti path nyata; output wajib baru. Jangan mengisi primary-unavailable-at run lama dengan perkiraan. Jangan menambahkan flag apply pada verifikasi offline. Forensik dan rekonsiliasi aktual membutuhkan otorisasi tersendiri. Kode baru belum diterapkan dengan recreate/restart backend aktual; ketahanan outage dan pemulihan nyata baru dapat dibuktikan oleh uji runtime yang diotorisasi kemudian. DR gagal sebelumnya tetap FAILED.
