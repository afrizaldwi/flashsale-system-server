# Pertemuan 4: Otomasi Backup dan Restore Database (Disaster Recovery Plan)
**Kelompok 1 — Flash Sale E-Commerce System**

Dokumen ini mendokumentasikan implementasi mekanisme otomasi backup dan restore database PostgreSQL pada stack **Pertemuan 3 (P3)** untuk mendukung strategi *Disaster Recovery Plan* (DRP).

---

## 1. Tujuan Backup dan Restore

1. **Kelangsungan Bisnis (*Business Continuity*)**: Memastikan data transaksi flash sale, katalog produk, dan pengguna dapat dipulihkan secara cepat dan akurat saat terjadi kegagalan sistem, korupsi data, atau kehancuran container database primary.
2. **Mitigasi Kehilangan Data (*RPO - Recovery Point Objective*)**: Membatasi batas toleransi data yang hilang dengan target awal perancangan maksimal 1 menit melalui backup berkala serial setiap 30 detik.
3. **Kecepatan Pemulihan (*RTO - Recovery Time Objective*)**: Menetapkan target awal perancangan waktu pemulihan hingga database siap melayani transaksi kembali dalam waktu kurang dari 5 menit.
4. **Integritas dan Konsistensi Data**: Menjamin konsistensi snapshot relasional (tabel `orders`, `products`, `users`) tanpa terjadi anomali stok negatif atau pesanan tak bertuan, sekalipun backup dieksekusi saat lonjakan transaksi checkout sedang berlangsung.
5. **Isolasi Antar-Stack**: Menjamin seluruh prosedur backup dan restore hanya menargetkan database stack P3 (`flashsale_p3`), tanpa menyentuh atau mengontaminasi stack P2 (`flashsale`).

---

## 2. Arsitektur Backup

Arsitektur backup dan restore dirancang dengan prinsip **fail-closed** dan **least privilege**:

```mermaid
graph TD
    subgraph Host["Host Lingkungan (Windows PowerShell / Git Bash)"]
        CronLoop["Backup Loop (30s interval)<br/>scripts/p4/backup-loop.sh -> backup-loop.js"]
        BackupCLI["Backup Automation<br/>scripts/p4/backup.sh -> backup.js"]
        RestoreCLI["Restore Automation<br/>scripts/p4/restore.sh -> restore.js"]
        BackupStorage["Storage Backup Host<br/>backups/p3/*.dump<br/>backups/p3/*.sha256<br/>backups/p3/*.meta.json"]
        LockFile["Atomic Lock File (flag: 'wx')<br/>backups/p3/.backup.lock"]
    end

    subgraph Docker["Docker Engine (flashsale-p3)"]
        Primary["Container Primary (Writer)<br/>flashsale-p3-db-primary-1<br/>Database: flashsale_p3"]
        Replica["Container Replica (Standby)<br/>flashsale-p3-db-replica-1"]
        Backends["Backend Instances (2-6)<br/>flashsale-p3-backend-*"]
    end

    CronLoop -->|Acquire Atomic Lock| LockFile
    CronLoop -->|Trigger Sequential| BackupCLI
    BackupCLI -->|1. Inspect Labels & Role Check| Primary
    BackupCLI -->|2. pg_dump -Fc (Snapshot REPEATABLE READ)| Primary
    Primary -->|3. Docker cp to Host (.tmp)| BackupStorage
    BackupCLI -->|4. pg_restore --list (Validate TOC)| Primary
    BackupStorage -->|5. Finalize .dump + SHA-256 + Meta| BackupStorage

    RestoreCLI -->|Validate Checksum & TOC| BackupStorage
    RestoreCLI -->|Terminate Active Conns (--execute)| Primary
    RestoreCLI -->|pg_restore --clean --if-exists| Primary
    RestoreCLI -->|Fail-Closed Post-Restore Verification| Primary
```

### Karakteristik Snapshot Konsisten
- **Custom Format (`-Fc`)**: Menggunakan format biner arsip PostgreSQL terkompresi yang mendukung kompresi zlib, metadata TOC (*Table of Contents*), serta fleksibilitas seleksi objek saat restore.
- **Konsistensi ACID Saat Checkout Berlangsung**: `pg_dump` secara otomatis membuka satu transaksi berisolasi `REPEATABLE READ`. Seluruh data yang diekspor terkunci secara konsisten pada satu titik waktu awal snapshot tanpa memblokir pembaca (*readers*) maupun penulis (*writers* / transaksi checkout). Sistem tidak mengklaim isolasi `SERIALIZABLE` karena konfigurasi tersebut tidak diaktifkan secara eksplisit pada engine database.

---

## 3. Mekanisme Backup Otomatis

Implementasi skrip backup (`scripts/p4/backup.js` dan wrapper `scripts/p4/backup.sh`) menjalankan tahapan berikut:

1. **Validasi Identitas Container (Fail-Closed)**:
   - Memeriksa bahwa container `flashsale-p3-db-primary-1` berjalan aktif.
   - Memvalidasi label Docker Compose:
     - `com.docker.compose.project = flashsale-p3`
     - `com.docker.compose.service = db-primary`
     - `flashsale.environment = p3`
2. **Validasi Database & Peran Writer**:
   - Menjalankan `SELECT current_database(), pg_is_in_recovery()`.
   - Memastikan nama database strictly `flashsale_p3` (menolak database `flashsale` milik P2).
   - Memastikan `pg_is_in_recovery() = 'f'` (menolak backup dari replica/standby).
3. **Atomic Write Menggunakan Temporary File**:
   - Dump pertama kali ditulis ke `/tmp/backup_<timestamp>.dump` di dalam container.
   - Disalin ke host sebagai file sementara: `backups/p3/flashsale_p3_<timestamp>.dump.tmp`.
   - File temporary di container langsung dibersihkan.
4. **Validasi Integritas Arsip (TOC Check)**:
   - Menjalankan `pg_restore --list` terhadap file `.tmp`.
   - Jika daftar objek (tabel, relasi, constraint) tidak terbaca atau header korup, file `.tmp` langsung dihapus dan proses dibatalkan.
5. **Finalisasi & Metadata**:
   - File `.tmp` di-rename secara atomik menjadi file final `.dump`.
   - Menghitung nilai hash SHA-256 dari file final dan menyimpannya di file `.dump.sha256`.
   - Menulis metadata lengkap (`.dump.meta.json`): ukuran file, SHA-256, jumlah entitas TOC, waktu mulai, waktu selesai, dan durasi dalam milidetik.
   - Mencatat keberhasilan ke `backups/p3/backup.log`.
6. **Perlindungan Backup yang Sudah Ada**:
   - Jika backup mengalami kegagalan, backup sebelumnya **tidak pernah dihapus** dan tetap aman di direktori penyimpanan.

---

## 4. Mekanisme Backup Loop & Atomic Lock

Skrip `scripts/p4/backup-loop.js` (dan wrapper `scripts/p4/backup-loop.sh`) mengimplementasikan otomasi berkala yang tangguh:

1. **Pembuatan Lock Eksklusif Atomik Sebelum Loop**:
   - Lock file (`backups/p3/.backup.lock`) diperoleh secara atomik sebelum memasuki siklus `while` loop menggunakan opsi Node.js `{ flag: "wx" }` (setara `O_CREAT | O_EXCL` POSIX).
   - Jika lock file sudah ada, kernel sistem operasi langsung menolak pembuatan dengan kode error `EEXIST`, dan proses baru ditolak tanpa menjalankan backup ganda.
   - Isi lock file menyimpan JSON `{ pid, createdAt }`.
2. **Retensi Lock Selama Seluruh Siklus & Masa Jeda**:
   - Atomic lock dipertahankan secara terus-menerus selama proses loop aktif, termasuk saat proses sedang dalam masa jeda (`sleep`) menunggu interval 30 detik berikutnya. Hal ini menjamin dua proses loop tidak dapat bergantian mengambil lock di sela interval.
3. **Perlindungan Kepemilikan Lock & Pelepasan Fail-Safe**:
   - Pelepasan lock dibungkus dalam blok `try ... finally` pada lifecycle loop.
   - Lock file hanya dapat dihapus oleh proses yang memilikinya (`releaseLock(lockFile, myPid)`). Proses asing yang bukan pemilik dilarang keras menghapus lock.
4. **Perhitungan Interval Adaptif & Pencegahan Proses Paralel**:
   - Loop mencatat durasi eksekusi backup dan menghitung sisa waktu tidur:
     `remainingSleepMs = Math.max(0, (intervalSeconds * 1000) - cycleDurationMs)`
   - Jika backup berlangsung lebih lama daripada interval (misal backup memakan waktu 35 detik pada interval 30 detik), proses tidak menjalankan backup secara paralel, melainkan melanjutkan ke siklus berikutnya secara serial tanpa penumpukan proses.
5. **Graceful Shutdown Tanpa Pemutusan Paksa**:
   - Menangani sinyal `SIGINT` (Ctrl+C) dan `SIGTERM` secara anggun.
   - Jika sinyal diterima saat backup sedang berlangsung, proses menunggu backup in-flight tersebut selesai terlebih dahulu sebelum melepaskan lock dan keluar. Jika sinyal diterima saat proses sedang tidur (*sleep*), timer dibangunkan seketika agar proses dapat keluar tanpa jeda berlebih.
   - Catatan pengujian: Validasi 1-iterasi loop hanya membuktikan satu siklus backup berjalan dengan aman, bukan pembuktian kestabilan eksekusi berulang dalam jangka waktu panjang.

---

## 5. Mekanisme Restore

Implementasi skrip restore (`scripts/p4/restore.js` dan wrapper `scripts/p4/restore.sh`) mengedepankan prinsip kehati-hatian:

1. **Default DRY-RUN (Simulasi Aman)**:
   - Menjalankan skrip tanpa parameter tambahan hanya melakukan inspeksi kelayakan dan pelaporan rencana pemulihan.
   - Tidak ada data, tabel, atau konfigurasi database yang dimodifikasi.
2. **Pemilihan Backup Terbaru yang Benar-Benar Valid**:
   - Fungsi `findLatestBackup()` memeriksa file `.dump` dari timestamp paling baru ke yang paling lama.
   - Setiap kandidat divalidasi secara berurutan: (1) keberadaan file `.sha256`, (2) kecocokan hash SHA-256, dan (3) integritas struktur arsip via `pg_restore --list`.
   - Jika backup terbaru korup atau belum memiliki checksum (misal proses backup sebelumnya terhenti di tengah jalan), skrip secara otomatis melewati kandidat tersebut dan memilih backup sebelumnya yang valid.
   - Seluruh file backup lama **tidak pernah dihapus atau dimodifikasi** selama proses pencarian.
   - Jika seluruh backup tidak valid, proses restore berhenti dengan pesan error yang jelas.
3. **Flag Eksplisit `--execute`**:
   - Restore aktual hanya dieksekusi jika operator menyertakan flag `--execute`.
4. **Validasi Target Database**:
   - Memastikan container target memiliki label `flashsale-p3`, `db-primary`, dan `p3`.
   - Memastikan database target adalah `flashsale_p3` dan berstatus writer (`in_recovery = 'f'`). Menolak keras database P2.
5. **Pemutusan Koneksi Backend Aktif & Validasi Ketat**:
   - Sebelum restore, koneksi aplikasi aktif diputus menggunakan `pg_terminate_backend`.
   - Query pemutusan koneksi memfilter `WHERE terminated = true` sehingga hanya menghitung koneksi yang benar-benar berhasil diputus.
   - Hasil parsing angka koneksi menggunakan fungsi `parseStrictNonNegativeInt` yang menolak string kosong, bilangan negatif, `0invalid`, `NaN`, atau `Infinity`. Query error tidak pernah diubah menjadi nilai default `0`.
   - Skrip melakukan **pemeriksaan ulang (*re-check*)**: jika masih terdapat koneksi yang menghalangi (misal akibat *connection pool reconnect*), restore langsung dibatalkan secara fail-closed.
6. **Opsi Restorasi `pg_restore`**:
   - `--clean`: Menghapus objek lama sebelum membuat ulang.
   - `--if-exists`: Menggunakan sintaks `DROP ... IF EXISTS` agar tidak error pada database baru.
   - `--no-owner`: Menghindari error hak kepemilikan user saat migrasi.
   - `--no-acl`: Mencegah modifikasi tabel hak akses (*grant/revoke*).
   - `--exit-on-error`: Langsung berhenti jika terjadi kesalahan query restorasi.
7. **Verifikasi Pasca-Restore Fail-Closed**:
   - Menjalankan query hitung baris: `orders_count`, `products_count`, `users_count`.
   - Hasil verifikasi diparse secara ketat: menolak output kosong, format bukan 3 kolom, `NaN`, pecahan, atau bilangan negatif.
   - Status `SUCCESS` hanya dikembalikan jika restorasi dan verifikasi pasca-restore sama-sama lolos.
8. **Proteksi Docker Volume**:
   - Skrip **tidak pernah menghapus atau mereset volume Docker**. Data dipulihkan secara in-place di dalam database PostgreSQL aktif.

---

## 6. Konsistensi Wrapper Bash dan Node.js

Untuk mencegah divergensi aturan validasi (*diverging validation logic*):
- Seluruh logika bisnis diimplementasikan secara terpusat pada modul Node.js (`scripts/p4/backup.js`, `backup-loop.js`, `restore.js`, `common.js`).
- Skrip shell Bash (`backup.sh`, `backup-loop.sh`, `restore.sh`) berfungsi sebagai **wrapper transparan** yang meneruskan seluruh argumen (seperti `--execute` dan `--file`) ke modul Node.js.
- Jika Node.js tidak tersedia pada lingkungan terminal, skrip Bash langsung berhenti dengan kode keluar `127` dan pesan kesalahan yang jelas, tanpa melemahkan validasi checksum, TOC, atau verifikasi pasca-restore.

---

## 7. Panduan Perintah Operasional

### A. Menjalankan Backup
```powershell
# Melalui npm (PowerShell / CMD)
npm.cmd run p4:backup

# Melalui Git Bash
bash scripts/p4/backup.sh

# Melalui Node.js langsung
node scripts/p4/backup.js
```

### B. Menjalankan Backup Berkala (30 Detik)
```powershell
# Melalui npm
npm.cmd run p4:backup-loop

# Melalui Git Bash
bash scripts/p4/backup-loop.sh

# Kustomisasi interval (misal 60 detik)
$env:BACKUP_INTERVAL_SECONDS="60"; npm.cmd run p4:backup-loop
```

### C. Menjalankan Simulasi Restore (Dry-Run Default)
```powershell
# Melalui npm (otomatis memilih backup terbaru)
npm.cmd run p4:restore

# Memilih file tertentu
node scripts/p4/restore.js --file backups/p3/flashsale_p3_YYYYMMDD_HHMMSS.dump

# Melalui Git Bash
bash scripts/p4/restore.sh
```

---

## 8. Prosedur Restore Aktual (9 Langkah Lengkap)

Bila terjadi skenario pemulihan bencana (DRP), ikuti 9 langkah berurutan berikut:

1. **Langkah 1 — Pastikan File Backup Valid**: Pastikan file `.dump` dan `.sha256` tersedia di direktori `backups/p3/`.
2. **Langkah 2 — Verifikasi SHA-256**: Skrip secara otomatis memvalidasi hash SHA-256 dari file arsip terhadap file checksum.
3. **Langkah 3 — Verifikasi TOC Arsip**: Skrip menjalankan `pg_restore --list` untuk membuktikan tabel dan constraint di dalam arsip dapat dibaca.
4. **Langkah 4 — Pastikan Container & Database Target Benar**: Container `flashsale-p3-db-primary-1` harus berjalan aktif dan database `flashsale_p3` berstatus writer (`in_recovery = 'f'`).
5. **Langkah 5 — Hentikan Sementara Trafik Backend P3 Sesuai Kebutuhan**: Karena Express connection pool dapat otomatis melakukan *reconnect*, hentikan sementara trafik request ke backend P3 (atau nonaktifkan routing upstream Nginx) untuk memastikan tidak ada koneksi baru yang masuk.
6. **Langkah 6 — Putuskan Koneksi Aktif**: Skrip memutus koneksi aktif via `pg_terminate_backend` dan melakukan verifikasi ulang bahwa tidak ada koneksi yang tersisa.
7. **Langkah 7 — Jalankan Restore Aktual**: Eksekusi restore dengan menyertakan flag eksplisit `--execute`:
   ```powershell
   node scripts/p4/restore.js --execute
   # atau: bash scripts/p4/restore.sh --execute
   ```
8. **Langkah 8 — Lakukan Verifikasi Pasca-Restore**: Skrip secara fail-closed memeriksa jumlah baris pada tabel `orders`, `products`, dan `users`.
9. **Langkah 9 — Pastikan Aplikasi Kembali Terhubung**: Hubungkan kembali backend dan periksa integritas invarian bisnis melalui endpoint `/stats`:
   ```powershell
   curl.exe -s http://127.0.0.1:8080/stats
   ```
   Pastikan output mengembalikan `"consistent": true` dengan `negative_stock: 0` dan `duplicate_orders: 0`.

---

## 9. Target RTO dan RPO

| Metrik DRP | Definisi | Target Awal Perancangan | Mekanisme Pendukung |
|:---|:---|:---|:---|
| **RPO (Recovery Point Objective)** | Batas toleransi kehilangan data transaksi maksimal | **<= 1 Menit** | Backup otomatis serial setiap 30 detik (`backup-loop.js`). |
| **RTO (Recovery Time Objective)** | Waktu maksimal pemulihan hingga database siap melayani kembali | **<= 5 Menit** | Custom dump format biner (`-Fc`), pg_restore dengan `--clean --if-exists`, pemutusan koneksi otomatis. |

> [!WARNING]
> Angka RTO (<= 5 menit) dan RPO (<= 1 menit) di atas merupakan **target perancangan arsitektur** dan **BELUM dibuktikan secara empiris melalui DR Test aktual**. Pembuktian angka riil waktu pemulihan dan batas kehilangan data transaksi harus dibuktikan melalui pengujian simulasi bencana (Disaster Recovery Test).

---

## 10. Batasan Implementasi

1. **Penyimpanan Host Lokal**: File backup disimpan pada filesystem host lokal (`backups/p3/`). Integrasi dengan penyimpanan cloud off-site (seperti AWS S3 atau Google Cloud Storage) tidak diimplementasikan karena di luar lingkup tugas praktikum perkuliahan.
2. **Recreate Container Mandiri**: Jika container primary terhapus total, operator perlu menjalankan `docker compose -f docker-compose.p3.yml up -d db-primary` sebelum menjalankan skrip restore.
3. **WAL Timeline PostgreSQL**: Restorasi bekerja pada layer SQL objek database via `pg_restore`. Re-seed replica dari primary baru pasca-bencana tetap mengikuti prosedur `pg_basebackup -R`.
4. **Downtime Singkat Saat Restore**: Restore database memutus koneksi backend aktif selama proses berlangsung guna mencegah *lock contention*, sehingga restorasi tidak diklaim tanpa jeda (*zero-downtime restore is not claimed*).
