# Flash Sale E-Commerce — Cloud Computing Kelompok 1, Pertemuan 2

**Pertemuan 3:** isolated Docker Compose stack, automatic backend scaling, monitoring and k6 tooling are documented in [docs/PERTEMUAN_3.md](docs/PERTEMUAN_3.md). Start with `npm run p3:init`, `npm run p3:config`, and `npm run p3:start`. Pilot/final performance campaigns require explicit execution and have not been run. PowerShell users can use `npm.cmd`.

**Basis rancangan:** Dokumen Spesifikasi Arsitektur v1.2 (§4.1, §5, §6–8) dan Dokumen DRP Awal v1.0.2 (§4, §7, §9). Paket ini menyelaraskan **source code yang digunakan pada Pertemuan 1** dengan rancangan tersebut.

**Perubahan dari repository awal:** Hapus load balancer Node.js (`src/lb.js`) dan mode cluster (`scripts/cluster.js`) dari baseline Pertemuan 1; hilangkan watchdog automatic database failover; gunakan failover **manual** dengan prosedur fencing, promosi, perubahan konfigurasi koneksi dan restart aplikasi. Nginx, 2 backend, Docker dan backup otomatis **belum** dijalankan karena merupakan pekerjaan pertemuan berikutnya.

## Arsitektur yang dijalankan sekarang

```text
Browser / HTML & JavaScript
        |
        v  http://localhost:3000
  Express Backend (1 instance)
        |  POST /checkout, GET /orders/:id, GET /stats -> READ/WRITE PRIMARY
        +-------------------------------> PostgreSQL PRIMARY :5432
        |                                          |
        | GET /products (read-only)                | asynchronous streaming replication
        +-------------------------------> PostgreSQL REPLICA :5433
        |                                            (hot standby)
        + fallback GET /products ke primary jika replica down
```

- Saat PRIMARY down, `/checkout`, `/orders/:id` dan `/stats` mengembalikan **503** (jika DB tidak tersedia); `/products` tetap dapat **200** jika replica sehat.
- `POST /checkout` menggunakan transaksi atomik, `UPDATE ... WHERE stock >= qty`, `UNIQUE(idempotency_key)` dan penguncian per key, sehingga stok tidak menjadi minus dan retry dengan key yang sama tidak menambah order baru.
- Perubahan primary ke replica **tidak otomatis**. Setiap promosi membutuhkan keputusan operator. Lihat prosedur failover di bawah.

## 1. Prasyarat

1. **Node.js 18.17+** (direkomendasikan versi LTS).
2. **PostgreSQL 16** berjalan sebagai PRIMARY di **127.0.0.1:5432**; user contoh `postgres` mempunyai izin CREATE DATABASE dan dapat melakukan pg_basebackup/replikasi.
3. `psql`, `pg_basebackup`, `pg_ctl` dari PostgreSQL 16 tersedia di `PATH` untuk setup replica dan failover. Di Windows, biasanya berada dalam `C:\Program Files\PostgreSQL\16\bin`.
4. Folder sumber proyek (boleh di Windows, Linux atau macOS). Skrip `.sh` untuk bash/Linux dan `.ps1` untuk PowerShell/Windows.

> Perhatian: `npm install` hanya memasang package Node.js. PostgreSQL harus diinstal dan dijalankan terpisah; konfigurasi replikasi bukan tanggung jawab NPM.

## 2. Install dependencies dan konfigurasi

Dari folder proyek:

```bash
npm install
```

Salin file contoh konfigurasi:

**Bash / Git Bash / Linux:**

```bash
cp .env.example .env
```

**Windows PowerShell:**

```powershell
Copy-Item .env.example .env
```

Edit `.env` (file ini **jangan** di-commit). Contoh:

```dotenv
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=flashsale
DB_USER=postgres
DB_PASSWORD=PASSWORD_POSTGRES_LOKAL_ANDA
DB_POOL_MAX=20
DB_REPLICA_HOST=127.0.0.1
DB_REPLICA_PORT=5433
```

Jika baru memiliki satu PostgreSQL dan belum setup replica, sementara isi `DB_REPLICA_HOST=` (kosong). Aplikasi tetap bekerja, tetapi belum memenuhi demonstrasi master-slave sampai replica disiapkan.

## 3. Inisialisasi database primary

Pastikan PostgreSQL primary telah berjalan, lalu:

```bash
npm run db:init
```

Expected: database `flashsale` dibuat (jika belum ada), tabel `users`, `products`, `orders` dibuat, dan data dummy dimasukkan (100 users, 3 produk).

> `npm run db:reset` **DESTRUKTIF**: menghapus tabel transaksi dan mengembalikan stok awal. Hanya jalankan pada data pengujian; tidak boleh dipakai pada database yang masih dibutuhkan atau setelah promosi hingga kondisi replikasi dipastikan.

## 4. Membuat streaming replica PostgreSQL 16 (wajib untuk demo primary-replica)

### 4A. Aktifkan replikasi pada primary

Di `postgresql.conf` untuk primary :5432, pastikan PostgreSQL mendukung streaming replication (contoh):

```conf
wal_level = replica
max_wal_senders = 10
max_replication_slots = 10
```

Pada `pg_hba.conf`, izinkan akses replication **hanya untuk host latihan yang dipercaya**. Contoh pada localhost (bukan aturan produksi):

```conf
host    replication    postgres    127.0.0.1/32    scram-sha-256
```

Setelah perubahan konfigurasi, restart primary sesuai cara instalasi PostgreSQL Anda. `pg_basebackup` memakai koneksi TCP dan membutuhkan password/otorisasi untuk user database yang digunakan.

**Penting untuk replica setelah dibuat:** proses standby akan melakukan koneksi streaming berulang kali ke primary tanpa input interaktif. Jika `pg_hba.conf` meminta password, buat file **passfile PostgreSQL** untuk user OS yang menjalankan replica, bukan mengandalkan prompt password saat `pg_basebackup` saja. Di Linux file tersebut biasanya `~/.pgpass` milik user OS itu (mode `0600`); pada Windows ada di `%APPDATA%\postgresql\pgpass.conf` untuk user yang menjalankan PostgreSQL replica. Contoh baris (gunakan password yang sebenarnya, simpan hanya di mesin lokal dan jangan commit):

```text
127.0.0.1:5432:replication:postgres:PASSWORD_POSTGRES_LOKAL_ANDA
```

Pastikan file tersebut hanya dapat dibaca pemiliknya; pada Linux `chmod 600 ~/.pgpass`. Pengaturan user/service PostgreSQL bergantung instalasi OS. Verifikasi koneksi dasar lebih dulu:

```bash
psql -h 127.0.0.1 -p 5432 -U postgres -d flashsale -c 'SELECT pg_is_in_recovery();'
```

Hasil pada primary harus `f` (`false`).

### 4B. Buat replica pada port 5433

**Linux / Bash** — jalankan sebagai pemilik data directory (sering kali user OS `postgres`), dengan binary PostgreSQL 16 tersedia di PATH:

```bash
# Jika pengguna saat ini mempunyai izin atas REPLICA_DIR:
./scripts/setup-replica.sh
# Atau atur REPLICA_DIR ke direktori khusus user OS postgres.
```

Pada Ubuntu/Debian dengan PostgreSQL dari paket distro, `pg_ctl` mungkin tidak berada di PATH; tambahkan path PostgreSQL 16, misalnya:

```bash
export PATH="/usr/lib/postgresql/16/bin:$PATH"
```

Jika primary berjalan sebagai user OS `postgres`, Anda mungkin perlu menjalankan skrip sebagai user tersebut (`sudo -u postgres ...`) dengan `REPLICA_DIR` milik user tersebut. **Jangan** menjalankan server PostgreSQL sebagai root. Skrip tidak menghapus directory replica yang sudah ada.

**Windows PowerShell:**

```powershell
# PostgreSQL 16\bin harus ada di PATH sesi PowerShell ini.
.\scripts\setup-replica.ps1
```

Anda dapat mengatur `$env:REPLICA_DIR` sebelum menjalankan skrip. Directory default Windows adalah `%LOCALAPPDATA%\pg-replica-5433`, dan default Linux `$HOME/pg-replica-5433`.

**Periksa** replica setelah setup:

```bash
psql -h 127.0.0.1 -p 5433 -U postgres -d flashsale -c 'SELECT pg_is_in_recovery();'
```

Hasil harus `t` (`true`). Bila koneksi ditolak, periksa port, izin data directory, kredensial dan log replica.

> Catatan: prosedur setup lokal ini mengasumsikan autentikasi PostgreSQL sudah dikonfigurasi sehingga `pg_basebackup` dan proses standby dapat menghubungi primary. Untuk produksi perlu role REPLICATION khusus, TLS, pengamanan rahasia, dan host terpisah. Jangan menyimpan `PGPASSWORD` permanen di source code.

## 5. Jalankan aplikasi

Pastikan kedua instance PostgreSQL aktif (atau kosongkan konfigurasi replica ketika menyiapkan awal), lalu:

```bash
npm start
```

Buka **http://localhost:3000** dan cek endpoint:

```bash
curl http://localhost:3000/health
curl -i http://localhost:3000/products
curl http://localhost:3000/stats
```

Ekspektasi:

- `/health` -> HTTP 200, `db:"up"`, `replica:"up"`, `failover_mode:"manual"` jika kedua DB sehat.
- `/products` -> HTTP 200, response header `X-Read-From: replica` jika standby tersedia; fallback `primary` jika standby down.
- `/stats` -> `consistent:true` jika data sesuai invarian.

Aplikasi sekarang memakai satu instance backend. Jalankan `npm start`, **bukan** `npm run start:cluster` karena versi ini belum menggunakan load balancer.

## 6. Verifikasi transaksi dan unit test

```bash
npm test
npm run db:verify
npm run test:race -- http://localhost:3000 300
```

- `npm test` melakukan unit/static tests. Tidak membutuhkan PostgreSQL.
- `npm run db:verify` membaca data PRIMARY langsung dan menampilkan indikator konsistensi. Tidak mengubah data.
- `npm run test:race` mengirim 300 checkout dengan key berbeda + 20 retry serentak dengan key sama. Ini **integration test sederhana**, bukan pengganti stress test k6/Locust/JMeter Pertemuan 3.
- `test:race` **mengubah stok/order**. Jalankan hanya pada lingkungan data pengujian. Jika stok habis, gunakan reset hanya pada database uji yang boleh dihapus.

## 7. Uji skenario database gagal — MANUAL (opsional di Pertemuan 1)

PENTING: Ini adalah protokol praktik di mesin lokal. **Jangan jalankan pada PostgreSQL yang menyimpan data penting.** Dokumentasikan T0/T1 bila menguji; waktu hasilnya tidak boleh diklaim tanpa pengukuran.

1. Pastikan `npm start` berjalan, `/health` menunjukkan primary dan replica sehat, dan `/stats` konsisten.
2. Simulasikan primary mati dengan menghentikan proses/server PostgreSQL PRIMARY **:5432 saja**, melalui manajer service atau `pg_ctl` sesuai instalasi. **Jangan** hentikan replica :5433.
3. Verifikasi `/health` mendapat 503, sedangkan `/products` masih 200 dari replica; checkout tidak boleh pindah otomatis.
4. **FENCING:** pastikan proses primary lama dihentikan/diisolasi dan tidak akan restart sendiri atau menerima penulisan. Gangguan koneksi jaringan BUKAN bukti fencing. Pada Windows, periksa juga startup/recovery policy service. Tidak boleh ada dua database writable.
5. Hanya setelah fencing berhasil, lakukan promosi replica:

   **Linux / Bash:**
   ```bash
   FENCING_CONFIRMED=YES ./scripts/promote-replica.sh
   ```

   **PowerShell:**
   ```powershell
   $env:FENCING_CONFIRMED = 'YES'
   .\scripts\promote-replica.ps1
   ```

   Skrip menolak promosi apabila primary lama terlihat masih menerima koneksi. Konfirmasi ini tetap tanggung jawab operator dan **bukan fencing otomatis terdistribusi**.

6. Hentikan backend dengan `Ctrl+C`. Edit `.env`:

   ```dotenv
   DB_HOST=127.0.0.1
   DB_PORT=5433
   DB_REPLICA_HOST=
   ```

7. Jalankan ulang:

   ```bash
   npm start
   npm run db:verify
   ```

8. Ulangi permintaan checkout gagal menggunakan **Idempotency-Key yang sama**. Pastikan `consistent:true`, tidak ada stok minus/duplikasi.
9. **Jangan hidupkan primary lama lagi pada port 5432 sebagai penerima tulis**. Jika perlu mengambil transaksi ekor yang hanya ada di primary lama, jalankan salinannya secara **terisolasi dan hanya untuk dibaca**, lalu gunakan alat bantu investigasi bagian 8.

Catatan: Skrip promosi menggunakan `pg_ctl` dari PostgreSQL, perlu dijalankan sebagai OS user yang mempunyai akses ke data directory replica. `FENCING_CONFIRMED=YES` adalah konfirmasi manusia, bukan bukti matematis isolasi. Untuk deployment terdistribusi, fencing membutuhkan kontrol host/jaringan yang kuat.

## 8. Primary lama hidup lagi: jangan langsung digabung

PostgreSQL asynchronous replication membentuk timeline terpisah setelah promotion. Jika primary lama dihidupkan dan ditulisi, dua primary dapat berbeda (*split-brain*). **PostgreSQL tidak menggabungkan dua timeline otomatis.**

Alat bantu `scripts/reconcile-old-primary.js` disertakan untuk rencana pengujian berikutnya; default adalah **dry-run**, membaca `OLD_PRIMARY` dan `NEW_PRIMARY`, menemukan `idempotency_key` yang hanya ada di server lama, lalu melaporkannya tanpa mengubah data.

Konfigurasi opsional untuk investigasi:

```bash
# Sebelumnya: jalankan SALINAN DATA OLD PRIMARY di port 5434 terisolasi,
# tanpa koneksi penulisan aplikasi dan jangan aktifkan primary lama sebagai primary produksi.
OLD_PRIMARY_HOST=127.0.0.1 OLD_PRIMARY_PORT=5434 NEW_PRIMARY_HOST=127.0.0.1 NEW_PRIMARY_PORT=5433 node scripts/reconcile-old-primary.js
```

Pada Windows PowerShell, atur `$env:OLD_PRIMARY_PORT` dan `$env:NEW_PRIMARY_PORT` sebelum perintah `node ...`. Untuk benar-benar mencoba replay, skrip menyediakan `--apply` dengan `REVIEWED=YES`, tetapi **jangan jalankan tanpa review transaksi, pembayaran, dan konsistensi terlebih dahulu**. Kondisi HTTP 409 berarti stok habis dan butuh kompensasi manual. Ini bukan tes recovery yang sudah dilakukan atau dijamin selesai otomatis.

## 9. Peta file

```text
.env.example                  contoh konfigurasi, TANPA rahasia
.gitignore                    cegah commit .env, node_modules, dan dump
package.json                  npm scripts & dependencies
src/server.js                 endpoint API dan checkout atomik
src/db.js                     primary/replica + read fallback (tanpa auto-failover)
src/errors.js                 HTTP 503 ketika DB down
src/queries.js                query invarian stok
frontend/index.html           halaman demo
frontend/style.css            styling halaman
frontend/script.js            aksi UI dan idempotent retry
db/schema.sql                 tabel dan constraint
db/seed.sql                   dummy users & products
db/verify.sql                 query validasi invarian
scripts/init-db.js            init / reset data
scripts/verify-db.js          cek konsistensi via Node.js
scripts/test-race.js          integration test checkout
scripts/setup-replica.sh      setup standby (Bash)
scripts/setup-replica.ps1     setup standby (PowerShell)
scripts/promote-replica.sh    manual promote (Bash)
scripts/promote-replica.ps1   manual promote (PowerShell)
scripts/stop-replica.*        stop standby tanpa menghapus data
scripts/reconcile-old-primary.js   helper investigasi dry-run
tests/core.test.js            test tanpa DB
docs/PEMETAAN_DOKUMEN.md      matriks cakupan sesuai dokumen
PROMPTS.md                    rekam penggunaan AI
backups/.gitkeep              placeholder direktori backup Pertemuan 4
```

## 10. Target kegiatan selanjutnya

| Pertemuan | Deliverable | Status paket |
|---|---|---|
| 1 | Arsitektur, DRP awal, frontend/backend localhost, Git | ✅ Source code disiapkan, uji runtime lokal oleh tim |
| 2 | Dockerfile, docker-compose, Nginx load balancer 2 backend, volumes | ✅ **Diterapkan** — lihat bagian 11 |
| 3 | k6/Locust/JMeter 10,100,500,1000 VU | Belum diterapkan |
| 4 | `pg_dump` terjadwal, **hapus container DB saat load test**, restore dari backup dan ukur RTO/RPO; uji failover opsional | Belum diterapkan |
| 5 | Pisahkan static file ke Nginx/MinIO CDN lokal | Belum diterapkan |

**RTO ≤5 menit, RPO ≤1 menit adalah target DRP**, bukan hasil tes yang sudah terbukti. Interval backup 1 menit pun tidak otomatis membuktikan RPO 1 menit tanpa memperhitungkan durasi backup, failure, dan data akhir yang belum masuk dump.

## 11. Pertemuan 2 — Docker & Nginx

### Arsitektur Container

```text
Browser / HTTP Client
        │  :80
        ▼
  [flashsale-nginx]        — Nginx 1.25 (load balancer round-robin)
        │
   ┌────┴────┐
   ▼         ▼
[backend-1] [backend-2]    — Node.js 18 (2 instance API)
   │         │
   └────┬────┘
        │  koneksi DB
   ┌────┴──────────────────┐
   ▼                       ▼
[db-primary] :5432     [db-replica] :5432
  PostgreSQL 16 PRIMARY    PostgreSQL 16 HOT STANDBY
  (write + read)           (read only, streaming replication)
        │
  pgdata-primary           pgdata-replica
  (Docker Volume)          (Docker Volume)
```

### Prasyarat

- **Docker Desktop** versi 24+ (atau Docker Engine + Compose plugin v2)
- Port yang bebas di host: **80** (Nginx), **5432** (primary debug), **5433** (replica debug)

### Cara Menjalankan

**1. Salin file konfigurasi:**

```powershell
Copy-Item .env.docker.example .env.docker
# Edit .env.docker dan ganti password jika perlu (default sudah cukup untuk lokal)
```

**2. Build image dan jalankan semua container:**

```bash
docker compose --env-file .env.docker up --build -d
```

**3. Cek status container:**

```bash
docker compose ps
```

Semua container harus berstatus `healthy` setelah sekitar 40–60 detik.

**4. Verifikasi endpoint:**

```bash
# Melalui Nginx (port 80) — load balanced ke backend-1 atau backend-2
curl http://localhost/health
curl http://localhost/products
curl http://localhost/stats

# Cek header X-Read-From untuk memastikan replica digunakan
curl -i http://localhost/products | findstr X-Read-From
```

Ekspektasi `/health`:
```json
{
  "status": "ok",
  "db": "up",
  "replica": "up",
  "failover_mode": "manual"
}
```

### Perintah Docker Berguna

```bash
# Lihat log semua container
docker compose logs -f

# Log container tertentu
docker compose logs -f nginx
docker compose logs -f db-primary
docker compose logs -f backend-1

# Hentikan semua (data volume tetap ada)
docker compose down

# Hentikan dan HAPUS volume (data hilang — hanya untuk reset total)
docker compose down -v

# Rebuild image setelah perubahan kode
docker compose --env-file .env.docker up --build -d

# Masuk ke shell container primary
docker exec -it flashsale-db-primary psql -U postgres -d flashsale

# Cek replikasi di primary
docker exec flashsale-db-primary psql -U postgres -c "SELECT * FROM pg_stat_replication;"

# Cek replica masih standby
docker exec flashsale-db-replica psql -U postgres -d flashsale -c "SELECT pg_is_in_recovery();"
```

### Docker Volumes (Fondasi DRP)

| Volume | Container | Isi | Persisten |
|---|---|---|---|
| `flashsale-pgdata-primary` | db-primary | Data PostgreSQL primary | ✅ Tetap ada saat `docker compose down` |
| `flashsale-pgdata-replica` | db-replica | Data PostgreSQL replica | ✅ Tetap ada saat `docker compose down` |

Data tidak hilang saat container direstart atau dihentikan. Hanya `docker compose down -v` atau `docker volume rm` yang akan menghapus data.

### Peta File Docker

```text
Dockerfile                        multi-stage build Node.js 18 alpine
docker-compose.yml                definisi 5 service + 2 volume + 1 network
nginx/nginx.conf                  load balancer round-robin ke backend-1 & backend-2
docker/primary-init.sql           init schema, seed, user replicator (dijalankan sekali)
docker/primary-postgresql.conf    WAL streaming replication config
docker/primary-pg_hba.conf        izin koneksi dari subnet Docker
docker/replica-entrypoint.sh     pg_basebackup + start hot standby
.env.docker                       konfigurasi runtime (tidak di-commit)
.env.docker.example               template yang aman di-commit
.dockerignore                     file yang dikecualikan dari build context
```

### Troubleshooting Docker

- **`db-replica` stuck `starting`**: primary belum healthy. Tunggu atau cek `docker compose logs db-primary`.
- **`permission denied` saat pg_basebackup**: user replicator belum dibuat. Hapus volume replica dan coba ulang: `docker volume rm flashsale-pgdata-replica && docker compose up -d db-replica`.
- **Port 80 sudah dipakai**: ganti port host di `docker-compose.yml`, baris `ports: "80:80"` jadi misalnya `"8080:80"`.
- **Port 5432/5433 sudah dipakai** oleh PostgreSQL lokal: hapus `ports:` dari service db-primary/db-replica di compose, atau hentikan service PostgreSQL lokal terlebih dahulu.
- **Image lama**: jalankan `docker compose build --no-cache` untuk rebuild dari awal.

## Troubleshooting singkat

- `ECONNREFUSED 5432`: pastikan service primary PostgreSQL berjalan dan port cocok.
- `password authentication failed`: ganti `DB_PASSWORD` di `.env` sesuai password role PostgreSQL. Setup replica menggunakan kredensial PostgreSQL yang sesuai (bukan otomatis membaca `.env` Node).
- `replica: down`: cek setup/port 5433, `pg_hba.conf`, password, dan file `replica.log`.
- `pg_basebackup: permission denied`: jalankan sebagai user OS yang berhak menulis directory replica; jangan chmod sembarang directory primary.
- `pg_ctl command not found`: tambahkan folder `bin` PostgreSQL 16 ke PATH.
- `permission denied for database`: gunakan role yang punya izin CREATE DATABASE atau buat database lebih dahulu sebagai admin.
- `EADDRINUSE: 3000`: masih ada proses lain memakai port 3000; hentikan proses tersebut atau ubah PORT di `.env`.
- `npm run test:race` gagal karena stok sudah habis: data pengujian telah berubah; hanya lakukan reset bila database pengujian boleh dihapus.

**Batasan verifikasi paket:** kode telah diperiksa statis (syntax lint sederhana + unit test Node), tetapi uji terhadap PostgreSQL 16, primary-replica, dan DRP harus dilakukan di perangkat lokal dengan dependensi yang terpasang.
