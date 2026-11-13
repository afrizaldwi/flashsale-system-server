# Dokumen Revisi Laporan Praktikum Cloud Computing (Pertemuan 1, 2, dan 3)

**Kelompok 1 — Sistem Flash Sale E-Commerce (Kelas H7D.7)**
- Afrizal Dwi Ahmad — `09010624001`
- Ardhiansyah Primadika Adi — `09020624024`
- Luthfion Hamit Ailan — `09020624036`
- Muhammad Diwan Alfarabi — `09020624050`
- Erridho Ramadhani. S — `09040624085`

---

## BAGIAN I — Revisi Pertemuan 1 (Planning, Arsitektur Master-Slave & DRP Awal)

### 1. Jika salah satu DB mati dan berpindah ke DB satunya, apakah ketika sudah pulih akan kembali ke DB awal atau bagaimana?

Perilaku sistem saat database yang mati kembali pulih dibedakan berdasarkan peran database yang mengalami kegagalan:

#### A. Skenario 1: Database Replica (Slave `:5433`) Mati lalu Pulih Kembali
1. **Saat Replica Mati:** Fungsi `readProducts()` pada `src/db.js` mendeteksi kegagalan koneksi ke Replica dan secara **otomatis mengalihkan (*fallback*) pembacaan katalog `GET /products` ke Database Primary** (`X-Read-From: primary`). Transaksi `POST /checkout` tidak terganggu.
2. **Saat Replica Pulih:** Sistem **secara otomatis kembali membaca dari Replica (`X-Read-From: replica`) tanpa perlu me-restart backend**. Hal ini karena pada setiap pemanggilan `GET /products`, aplikasi terlebih dahulu memeriksa ketersediaan pool Replica dan menjalankan validasi `SELECT pg_is_in_recovery() AS in_recovery`. Begitu Replica kembali aktif dalam mode *hot standby* (`in_recovery = true`), beban baca langsung dikembalikan ke Replica.

#### B. Skenario 2: Database Primary (Master `:5432`) Mati, Dilakukan Failover ke Replica, lalu Primary Lama Pulih Kembali
1. **Saat Primary Mati:** Sistem **tidak melakukan failover otomatis** untuk menghindari risiko *split-brain*. Selama Primary mati, endpoint tulis (`POST /checkout`) dan bacaan konsistensi ketat (`GET /orders/:id`, `GET /stats`, `GET /health`) mengembalikan `HTTP 503`, sedangkan katalog `GET /products` tetap menyala (`HTTP 200`) dari Replica. Operator kemudian menjalankan prosedur *fencing* dan mempromosikan Replica menjadi **Primary Baru** menggunakan `scripts/promote-replica.ps1` (`pg_ctl promote`), lalu mengarahkan konfigurasi `.env` backend ke port Primary baru (`5433`).
2. **Saat Primary Awal (Master Lama) Pulih:** Sistem **TIDAK AKAN langsung kembali (*no automatic failback*) ke DB awal**, dan DB awal **dilarang keras langsung menerima penulisan dari aplikasi**.
3. **Alasan Teknis (Pencegahan *Split-Brain*):**
   - Ketika Replica dipromosikan menjadi Primary baru, PostgreSQL membuka *timeline* baru (`timeline_id` bertambah) dan mulai menerima pesanan baru.
   - Sebaliknya, DB Primary lama masih berada pada *timeline* lama dan berpotensi menyimpan **order ekor (*tail orders*)**, yaitu transaksi yang sudah `COMMIT` di Primary lama sesaat sebelum mati tetapi belum sempat terkirim ke Replica karena replikasi bersifat *asynchronous streaming*.
   - PostgreSQL tidak dapat menggabungkan dua *timeline* yang sudah bercabang secara otomatis. Jika DB awal langsung diaktifkan kembali sebagai Primary, akan terjadi **split-brain** (dua server merasa menjadi master dengan isi data berbeda dan melanggar invarian stok).
4. **Prosedur Penanganan DB Awal yang Pulih (Rekonsiliasi & Pertukaran Peran):**
   - **Langkah 1 — Fencing:** Pastikan container/service Primary lama tetap diisolasi dari jaringan aplikasi (`docker stop` dan `docker update --restart=no`).
   - **Langkah 2 — Isolasi Read-Only & Deteksi Divergensi:** Jalankan data Primary lama di port terpisah yang tidak dikenal backend (misal port `5434`) khusus untuk dibaca. Bandingkan `timeline_id` kedua server melalui `SELECT timeline_id FROM pg_control_checkpoint();`.
   - **Langkah 3 — Rekonsiliasi Order Ekor:** Gunakan skrip `scripts/reconcile-old-primary.js` untuk mencari `idempotency_key` yang hanya tercatat di Primary lama. Putar ulang (*replay*) order ekor tersebut ke Primary baru melalui `POST /checkout` dengan `Idempotency-Key` yang sama:
     - `HTTP 201 CREATED`: Order ekor berhasil diselamatkan ke Primary baru.
     - `HTTP 200 DUPLICATE`: Order ternyata sudah ada di Primary baru (aman berkat constraint `UNIQUE(idempotency_key)`).
     - `HTTP 409 SOLD_OUT`: Stok sudah habis terjual selama masa failover; masuk ke prosedur kompensasi/refund manual.
   - **Langkah 4 — Rebuild DB Awal Menjadi Replica Baru:** Setelah rekonsiliasi selesai, direktori data DB awal dibersihkan dan disalin ulang dari Primary baru menggunakan `pg_basebackup` (`scripts/setup-replica.ps1`). Dengan demikian, **DB awal kini bertukar peran menjadi Replica (Hot Standby)** yang mengikuti Primary baru.

---

### 2. Janjinya Berapa Menit Nyala? (Komitmen SLA / Target RTO & RPO)

Berdasarkan **Dokumen DRP Awal v1.0.2 (§4)** dan **Spesifikasi Arsitektur v1.2 (§3.2 NFR-5)**, target pemulihan sistem ketika terjadi bencana adalah:

- **Target RTO (*Recovery Time Objective*): $\le 5\text{ menit}$**
  Waktu maksimal layanan kembali menyala normal, dihitung sejak kegagalan terdeteksi (`T0`, saat `/health` mengembalikan `HTTP 503` dua kali berturut-turut) hingga layanan kembali sehat (`T1`, saat `/health` mengembalikan `HTTP 200 OK` dan query validasi `/stats` menyatakan `"consistent": true`).
- **Target RPO (*Recovery Point Objective*): $\le 1\text{ menit}$**
  Toleransi maksimal data transaksi yang hilang apabila harus melakukan *restore* dari file backup `pg_dump` (jadwal cron setiap 1 menit). Apabila pemulihan dilakukan melalui **Jalur Failover Replica + Rekonsiliasi**, RPO efektif mendekati **0 order hilang** (hanya sebesar jeda replikasi asinkron dalam hitungan milidetik–detik).

#### Tabel Rincian Anggaran Waktu Pemulihan (RTO) per Skenario

| Skenario Kegagalan | Jalur Pemulihan | Estimasi Waktu Nyala | Rincian Tahap Pemulihan |
| :--- | :--- | :---: | :--- |
| **DB Primary mati (Replica sehat)** | **Jalur Failover** (Promosi Replica) | **$\pm 3\text{ menit}$** *(Katalog `/products` tetap nyala 0 menit downtime)* | 1. Deteksi `/health` 503: `0,5 menit`<br>2. Diagnosis & Fencing Primary lama: `0,75 menit`<br>3. Promosi Replica (`pg_ctl promote`): `0,25 menit`<br>4. Ubah `.env` & restart backend: `0,5 menit`<br>5. Validasi integritas (`/stats`): `1,0 menit` |
| **DB Primary & Replica mati / Volume rusak** | **Jalur Recreate / Restore Backup** | **$\pm 4,5\text{ menit}$** | 1. Deteksi insiden: `0,5 menit`<br>2. Diagnosis container & volume: `1,0 menit`<br>3. Buat ulang container DB: `0,5 menit`<br>4. Restore `pg_dump` (jika perlu): `1,0 menit`<br>5. Validasi integritas: `1,0 menit`<br>6. Sambungkan ulang backend: `0,5 menit` |
| **Satu Instance Backend mati** | **Failover Load Balancer Nginx** | **$0\text{ menit}$ (Tanpa Downtime)** | Nginx menandai instance gagal (`max_fails=2`, `fail_timeout=5s`) dan mengalihkan trafik ke instance sehat lainnya. |
| **Load Balancer Nginx mati** | **Docker Auto-Restart / Manual Up** | **Hitungan detik** (otomatis) / **$\le 1\text{ menit}$** (manual) | Otomatis hidup kembali via `restart: unless-stopped` atau manual dengan `docker compose up -d nginx`. |

---

### 3. Kalau Backend Mati Bagaimana?

Penanganan kegagalan layanan Backend API (Skenario Ancaman **T3** pada Dokumen DRP v1.0.2 §7.3 dan Arsitektur v1.2 §4.4, §8.4) meliputi tiga lapisan perlindungan:

1. **Perlindungan Integritas Data (Desain *Stateless Backend* & *Database Atomic Rollback*):**
   - Backend Node.js dirancang sepenuhnya **stateless** — tidak ada data stok, antrean pesanan, maupun state transaksi yang disimpan di memori lokal atau sistem file container backend.
   - Apabila proses backend mati mendadak (*crash* atau kehabisan memori) tepat saat sedang mengeksekusi transaksi `POST /checkout` yang belum mencapai perintah `COMMIT`, PostgreSQL Primary otomatis mendeteksi terputusnya koneksi TCP dari pool backend tersebut, membatalkan transaksi yang menggantung (**automatic `ROLLBACK`**), dan melepaskan kunci baris (*row-level lock*). Dengan demikian, **tidak ada data yang rusak, tidak ada stok yang terpotong tanpa order, dan RPO = 0 (tidak ada data hilang)**.
2. **Ketersediaan Layanan & Mekanisme Pemulihan:**
   - **Pada Arsitektur Pertemuan 1 (1 Instance Backend Localhost):** Jika proses Node.js mati, pengguna akan   menerima error koneksi sementara hingga aplikasi dijalankan kembali (`npm start`). Saat menyala kembali, backend langsung membuat ulang pool koneksi (`pg.Pool`) ke Primary dan Replica dalam hitungan detik.
   - **Pada Arsitektur Pertemuan 2 & 3 (Multi-Backend dengan Load Balancer Nginx):**
     - **Jika 1 instance backend mati:** Layanan **tetap berjalan normal tanpa downtime ($0\text{ detik}$)**. Load balancer Nginx mendeteksi kegagalan upstream dan langsung merutekan seluruh permintaan ke instance backend lain yang masih sehat. Secara bersamaan, Docker Engine otomatis menghidupkan kembali container backend yang mati karena memiliki kebijakan `restart: unless-stopped`.
     - **Jika seluruh instance backend mati bersamaan:** Nginx mengembalikan `HTTP 502 Bad Gateway` selama beberapa detik sambil menunggu Docker merestart container backend hingga lulus *healthcheck* (`/health` atau `/live`).
3. **Penanganan Request Klien yang Terputus Saat Backend Mati (*Idempotent Retry*):**
   - Ketika koneksi klien terputus saat backend crash, klien tidak mengetahui apakah transaksi sudah sempat `COMMIT` di database atau belum.
   - Klien cukup mengulang request `POST /checkout` dengan mengirimkan header **`Idempotency-Key` yang sama**:
     - Jika transaksi sebenarnya **sudah sempat `COMMIT`** sesaat sebelum backend mati, backend akan menemukan `idempotency_key` tersebut di tabel `orders` dan mengembalikan **`HTTP 200 DUPLICATE`** beserta data pesanan yang sudah jadi tanpa mengurangi stok lagi.
     - Jika transaksi **belum sempat `COMMIT`** (sudah di-rollback oleh PostgreSQL), backend akan memprosesnya sebagai transaksi baru dan mengembalikan **`HTTP 201 CREATED`**.

---
---

## BAGIAN II — Revisi Pertemuan 2 (Containerization & Multi-Container Docker)

### 1. Kenapa Backend Tidak Di-scaling?

Terdapat dua penjelasan penting terkait scaling backend pada Pertemuan 2:

1. **Secara Arsitektural Sudah Dilakukan Horizontal Scaling Statis (1 menjadi 2 Instance):**
   Dari Pertemuan 1 yang hanya menjalankan 1 instance backend di localhost, pada Pertemuan 2 layanan backend sebenarnya **sudah digandakan (*scaled out* secara statis) menjadi 2 container aktif (`flashsale-backend-1` dan `flashsale-backend-2`)** yang berjalan paralel di belakang Load Balancer Nginx dengan algoritma *round-robin*.
2. **Alasan Belum Menggunakan Dynamic Scaling (`docker compose up --scale`) atau Autoscaling pada Pertemuan 2:**
   - **Pemisahan Tahap Pengembangan (*Separation of Concerns*):** Sesuai peta jalan praktikum (Dokumen Arsitektur v1.2 §11), fokus Pertemuan 2 adalah membangun fondasi kontainerisasi multi-layanan (Dockerfile multi-stage, jaringan terisolasi, replikasi streaming PostgreSQL antar-container, dan persistensi data menggunakan Docker Named Volumes). Sementara itu, *dynamic scaling* otomatis berdasarkan metrik beban baru menjadi cakupan Pertemuan 3.
   - **Batasan Konfigurasi Statis pada `docker-compose.yml` dan `nginx/nginx.conf` Pertemuan 2:**
     - Pada `docker-compose.yml` Pertemuan 2, kedua backend didefinisikan sebagai dua service terpisah (`backend-1` dan `backend-2`) yang masing-masing menggunakan atribut `container_name` statis (`flashsale-backend-1` dan `flashsale-backend-2`). Docker Compose menolak perintah `--scale` pada service yang menetapkan `container_name` secara eksplisit karena akan menimbulkan konflik nama container.
     - Pada `nginx/nginx.conf` Pertemuan 2, daftar server di dalam blok `upstream flashsale_backend` masih ditulis secara statis (`server backend-1:3000; server backend-2:3000;`). Tanpa komponen *controller* yang memperbarui dan me-*reload* konfigurasi upstream Nginx secara dinamis (yang baru diimplementasikan di Pertemuan 3), penambahan container backend tidak akan terdeteksi oleh Nginx.

---

### 2. Detailkan Mana yang Di-scaling!

Berikut adalah rincian komponen mana saja yang di-scale dan tidak di-scale beserta alasan arsitekturalnya:

| Lapisan (Tier) | Service / Container | Jumlah Instance (P2 $\rightarrow$ P3) | Strategi Scaling | Alasan Teknis |
| :--- | :--- | :---: | :--- | :--- |
| **Application Tier (Backend API)** | `backend-1`, `backend-2` (`flashsale-api`) | **P1:** 1 instance<br>**P2:** 2 instance (statis)<br>**P3:** 2 s.d. 6 instance (dinamis/autoscaling) | **Horizontal Scaling (*Scale-Out / Scale-In*)** | Backend bersifat *stateless* (seluruh data berada di PostgreSQL). Penambahan replika container backend mendistribusikan beban pemrosesan HTTP, validasi JSON, dan koneksi pool secara merata melalui Nginx. |
| **Database Read Tier** | `db-replica` (`postgres:16-alpine`) | **1 instance** Hot Standby | **Read Scaling (*Read/Write Splitting*)** | Memisahkan kueri pembacaan katalog produk (`GET /products`) dari server utama melalui *asynchronous streaming replication*, sehingga beban baca tidak menguras CPU dan koneksi di database utama. |
| **Database Write Tier** | `db-primary` (`postgres:16-alpine`) | **1 instance** *(Tidak di-scale horizontal)* | **Single-Master Stateful** | Seluruh transaksi tulis (`POST /checkout`) wajib dipusatkan ke satu node Primary untuk menjamin properti ACID, serialisasi penguncian baris stok (*row-level lock*), dan menghindari konflik *multi-master*. |
| **Ingress / Load Balancer Tier** | `nginx` (`nginx:1.25-alpine`) | **1 instance** *(Tidak di-scale)* | **Single Entrypoint Reverse Proxy** | Menjadi pintu masuk tunggal pada port publik (`:80` di P2, `:8080` di P3) yang sangat ringan karena hanya meneruskan paket HTTP (*reverse proxy*) tanpa menyimpan state aplikasi. |

---

### 3. Analisa Mana yang Bikin Lambat!

Berdasarkan analisis source code (`src/db.js`, `src/server.js`, dan `docker-compose.yml`), terdapat **5 faktor utama penyebab kelambatan (*bottleneck*)** pada sistem:

1. **Overhead 2x Query Berurutan pada Setiap Request `GET /products` (`src/db.js` baris 47–52):**
   ```javascript
   const check = await replica.query("SELECT pg_is_in_recovery() AS in_recovery");
   if (check.rows[0].in_recovery) {
     const result = await replica.query(sql, params);
     return { ...result, source: "replica" };
   }
   ```
   Setiap satu permintaan `GET /products` selalu mengeksekusi **dua query SQL terpisah** ke Replica: pertama mengecek fungsi `pg_is_in_recovery()`, lalu kedua mengambil baris tabel `products`. Hal ini menggandakan jumlah *round-trip* jaringan antara container backend dan container `db-replica` serta menahan koneksi pool dua kali lebih lama.
2. **Antrean Connection Pool Database (`DB_POOL_MAX` Terbatas):**
   Setiap instance backend membatasi jumlah koneksi ke masing-masing database sebesar `DB_POOL_MAX = 20` di P2 (dan `10` per backend di P3 agar 6 backend $\times 10 = 60$ koneksi tidak melampaui `max_connections = 100` di PostgreSQL). Ketika ratusan request masuk secara bersamaan, request yang melebihi kapasitas pool harus mengantre di memori Node.js (`pool.waitingCount > 0`), yang secara langsung menaikkan latensi respon (p95).
3. **Kontensi Kunci Baris (*Hot-Row Lock Contention*) dan Rangkaian 7 Query SQL pada `POST /checkout` (`src/server.js` baris 57–111):**
   Satu transaksi checkout yang berhasil harus mengeksekusi 7 langkah berurutan ke `db-primary`:
   1. Pre-check `SELECT * FROM orders WHERE idempotency_key = $1`
   2. `BEGIN`
   3. Penguncian transaksi `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`
   4. Pengecekan ulang `SELECT * FROM orders WHERE idempotency_key = $1` di dalam transaksi
   5. Pemotongan stok atomik `UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1`
   6. Pencatatan pesanan `INSERT INTO orders ... RETURNING *`
   7. `COMMIT`
   Karena mayoritas pembeli pada flash sale memperebutkan baris produk yang sama (`product_id = 1`), operasi `UPDATE products` menimbulkan **antrean *row-level lock* di PostgreSQL Primary**, di mana transaksi harus menunggu transaksi lain melepaskan kunci baris sebelum dapat melanjutkan `COMMIT`.
4. **Transaksi `REPEATABLE READ` dengan 4 Query Agregasi pada `GET /stats` (`src/server.js` baris 200–213):**
   Endpoint `/stats` membuka transaksi `REPEATABLE READ READ ONLY` di Primary dan menjalankan 4 query agregasi (`LEFT JOIN`, `GROUP BY`, `SUM`, `COUNT`) terhadap tabel `products` dan `orders`. Semakin banyak jumlah baris order yang masuk, waktu eksekusi agregasi ini meningkat secara linear.
5. **Penyajian Aset Statis Frontend Masih Melalui Backend Node.js (`src/server.js` baris 19):**
   Pada Pertemuan 2, middleware `app.use(express.static(...))` masih menyajikan file `index.html`, `style.css`, dan `script.js` langsung dari proses Node.js (belum dipisahkan ke Nginx/CDN lokal yang baru dijadwalkan pada Pertemuan 5), sehingga request aset statis turut membebani *event loop* backend.

---

### 4. Taruh `docker-compose.yml` di Laporannya!

Berikut adalah kode lengkap `docker-compose.yml` Pertemuan 2 untuk dilampirkan di laporan Pertemuan 2:

```yaml
# ─────────────────────────────────────────────────────────────────────────────
# docker-compose.yml
# Pertemuan 2: Containerization (Docker)
# Kelompok 1, Cloud Computing H7D.7
# ─────────────────────────────────────────────────────────────────────────────

services:

  # ── PostgreSQL PRIMARY ──────────────────────────────────────────────────────
  db-primary:
    image: postgres:16-alpine
    container_name: flashsale-db-primary
    restart: unless-stopped
    env_file: .env.docker
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_HOST_AUTH_METHOD: "scram-sha-256"
    volumes:
      - pgdata-primary:/var/lib/postgresql/data
      - ./docker/primary-init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro
      - ./docker/primary-postgresql.conf:/etc/postgresql/postgresql.conf:ro
      - ./docker/primary-pg_hba.conf:/etc/postgresql/pg_hba.conf:ro
    command: >
      postgres
        -c config_file=/etc/postgresql/postgresql.conf
        -c hba_file=/etc/postgresql/pg_hba.conf
    ports:
      - "5432:5432"
    networks:
      - flashsale-net
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d flashsale"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s

  # ── PostgreSQL REPLICA (Hot Standby) ────────────────────────────────────────
  db-replica:
    image: postgres:16-alpine
    container_name: flashsale-db-replica
    restart: unless-stopped
    env_file: .env.docker
    environment:
      PRIMARY_HOST: db-primary
      PRIMARY_PORT: "5432"
      PGDATA: /var/lib/postgresql/data
    volumes:
      - pgdata-replica:/var/lib/postgresql/data
      - ./docker/replica-entrypoint.sh:/docker-replica-entrypoint.sh:ro
    entrypoint: ["/bin/sh", "/docker-replica-entrypoint.sh"]
    ports:
      - "5433:5432"
    networks:
      - flashsale-net
    depends_on:
      db-primary:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d flashsale"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 40s

  # ── Backend Instance 1 ──────────────────────────────────────────────────────
  backend-1:
    build:
      context: .
      dockerfile: Dockerfile
    image: flashsale-api:latest
    container_name: flashsale-backend-1
    restart: unless-stopped
    env_file: .env.docker
    environment:
      PORT: 3000
      DB_HOST: db-primary
      DB_PORT: 5432
      DB_NAME: ${POSTGRES_DB}
      DB_USER: ${POSTGRES_USER}
      DB_PASSWORD: ${POSTGRES_PASSWORD}
      DB_POOL_MAX: 20
      DB_REPLICA_HOST: db-replica
      DB_REPLICA_PORT: 5432
    networks:
      - flashsale-net
    depends_on:
      db-primary:
        condition: service_healthy
      db-replica:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 30s

  # ── Backend Instance 2 ──────────────────────────────────────────────────────
  backend-2:
    build:
      context: .
      dockerfile: Dockerfile
    image: flashsale-api:latest
    container_name: flashsale-backend-2
    restart: unless-stopped
    env_file: .env.docker
    environment:
      PORT: 3000
      DB_HOST: db-primary
      DB_PORT: 5432
      DB_NAME: ${POSTGRES_DB}
      DB_USER: ${POSTGRES_USER}
      DB_PASSWORD: ${POSTGRES_PASSWORD}
      DB_POOL_MAX: 20
      DB_REPLICA_HOST: db-replica
      DB_REPLICA_PORT: 5432
    networks:
      - flashsale-net
    depends_on:
      db-primary:
        condition: service_healthy
      db-replica:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost:3000/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 3
      start_period: 30s

  # ── Nginx Load Balancer ─────────────────────────────────────────────────────
  nginx:
    image: nginx:1.25-alpine
    container_name: flashsale-nginx
    restart: unless-stopped
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro
    ports:
      - "80:80"
    networks:
      - flashsale-net
    depends_on:
      backend-1:
        condition: service_healthy
      backend-2:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://localhost/nginx-health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s

# ── Networks ────────────────────────────────────────────────────────────────
networks:
  flashsale-net:
    driver: bridge
    name: flashsale-network

# ── Volumes (Persistensi Data — Fondasi DRP Pertemuan 4) ───────────────────
volumes:
  pgdata-primary:
    name: flashsale-pgdata-primary
    driver: local
  pgdata-replica:
    name: flashsale-pgdata-replica
    driver: local
```

---

### 5. Analisis Kenapa Produk (`GET /products`) Diambil dari Replica!

Pengambilan daftar produk (`GET /products`) dari PostgreSQL Replica (`db-replica`) dirancang berdasarkan empat alasan teknis utama:

1. **Dominasi Trafik Baca pada Flash Sale (*Read-Heavy Workload*):**
   Pada sistem e-commerce flash sale, perbandingan antara jumlah pengguna yang melihat/memuat ulang katalog produk (`GET /products`) dengan jumlah pengguna yang menekan tombol beli (`POST /checkout`) sangat timpang (rasio baca umumnya mencapai 80%–95% dari total trafik).
2. **Melindungi Kapasitas Database Primary (*Read/Write Splitting*):**
   Jika ribuan permintaan `GET /products` per detik diarahkan ke Database Primary, maka *connection pool* dan CPU Primary akan habis terpakai hanya untuk melayani pembacaan katalog. Akibatnya, transaksi pembayaran `POST /checkout` yang membutuhkan penguncian baris dan penulisan WAL (*Write-Ahead Log*) di Primary akan mengalami antrean panjang atau *timeout*. Dengan mengalihkan `GET /products` ke Replica (`X-Read-From: replica`), beban kerja Primary dikhususkan untuk transaksi tulis (`POST /checkout`) serta pembacaan yang menuntut akurasi mutlak (`GET /orders/:id` dan `GET /stats`).
3. **Keamanan terhadap *Overselling* Walaupun Terdapat *Replication Lag*:**
   Karena replikasi menggunakan mode *asynchronous streaming*, nilai stok yang terbaca di Replica dapat tertinggal beberapa milidetik dari Primary (*eventual consistency*). Namun, ketertinggalan tampilan ini **sama sekali tidak menimbulkan risiko *overselling* (stok minus)** karena angka di `/products` hanya digunakan untuk tampilan antarmuka pengguna, sedangkan **validasi dan pengurangan stok yang sah tetap diputuskan secara atomik di Database Primary** (`UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $1`) saat checkout.
4. **Redundansi dan *Graceful Degradation* (Ketersediaan Tinggi):**
   - **Saat Replica gagal/mati:** Fungsi `readProducts()` pada `src/db.js` otomatis menangkap pengecualian dan mengalihkan pembacaan `/products` ke Primary (`X-Read-From: primary`), sehingga pengguna tidak merasakan error.
   - **Saat Primary gagal/mati:** Meskipun fitur checkout sementara mengembalikan `HTTP 503` hingga operator menyelesaikan promosi failover, pengguna tetap dapat mengakses halaman katalog produk secara normal (`HTTP 200`, `X-Read-From: replica`).

---
---

## BAGIAN III — Revisi Pertemuan 3 (Stress Testing & Automatic Scaling)

### 1. Letakkan Code Auto Scaling di Laporan!

Berikut adalah kode implementasi *automatic scaling* pada proyek Pertemuan 3 yang terdiri atas **Logika Evaluasi Kebijakan (`scripts/p3/policy.js`)** dan **Eksekutor Controller & Docker (`scripts/p3/controller.js` dan `scripts/p3/docker.js`)**:

#### A. Kode Kebijakan Autoscaling Berbasis CPU (`scripts/p3/policy.js`)

```javascript
"use strict";
// Pure policy: elapsed-time windows, not a count of successful polling calls.
function decide(state, sample, c, now) {
  const next = { ...state };
  const hold = (reason) => ({ action: "hold", reason, state: next });
  if (
    !sample.valid ||
    !Number.isFinite(sample.time) ||
    !Number.isFinite(sample.cpu) ||
    !Number.isFinite(sample.hostCpu) ||
    !Number.isFinite(sample.hostMemory) ||
    !Number.isInteger(sample.count) ||
    sample.count < c.min ||
    sample.count > c.max ||
    now - sample.time > c.stale ||
    sample.time > now ||
    !sample.databaseHealthy
  ) {
    next.highSince = null;
    next.lowSince = null;
    return hold("missing-stale-metrics-or-database-unhealthy");
  }
  if (Number.isFinite(state.lastSample) && sample.time <= state.lastSample) {
    next.highSince = null;
    next.lowSince = null;
    return hold("duplicate-or-out-of-order-sample");
  }
  if (state.lastSample && sample.time - state.lastSample > c.stale) {
    next.highSince = null;
    next.lowSince = null;
  }
  next.lastSample = sample.time;
  if (sample.cpu >= c.outCpu) {
    next.highSince ??= now;
    next.lowSince = null;
  } else if (sample.cpu < c.inCpu && !sample.poolWaiting) {
    next.lowSince ??= now;
    next.highSince = null;
  } else {
    next.lowSince = null;
    next.highSince = null;
  }
  if (!sample.enabled) {
    next.highSince = null;
    next.lowSince = null;
    return hold("fixed-mode");
  }
  if (now < (state.cooldownUntil || 0)) return hold("cooldown");
  if (
    next.highSince !== null &&
    next.highSince !== undefined &&
    now - next.highSince >= c.outWindow
  ) {
    if (sample.count >= c.max) return hold("maximum-replicas");
    if (sample.hostCpu >= 90 || sample.hostMemory >= 85)
      return hold("host-capacity");
    return {
      action: "out",
      target: sample.count + 1,
      reason: "sustained-high-cpu",
      state: next,
    };
  }
  if (
    next.lowSince !== null &&
    next.lowSince !== undefined &&
    now - next.lowSince >= c.inWindow &&
    sample.count > c.min
  ) {
    if ((sample.cpu * sample.count) / (sample.count - 1) >= 50)
      return hold("projected-utilization");
    return {
      action: "in",
      target: sample.count - 1,
      reason: "sustained-low-cpu",
      state: next,
    };
  }
  return hold("observation-window");
}
function afterAction(state, direction, c, now) {
  return {
    ...state,
    highSince: null,
    lowSince: null,
    cooldownUntil: now + (direction === "in" ? c.inCooldown : c.outCooldown),
  };
}
module.exports = { decide, afterAction };
```

#### B. Kode Eksekutor Scale-Out, Graceful Drain Scale-In, dan Dynamic Nginx Reload (`scripts/p3/docker.js` & `scripts/p3/controller.js`)

```javascript
// 1. Fungsi Scale-Out (scripts/p3/docker.js)
// Menambah jumlah container backend tanpa membuat ulang container DB atau backend yang sedang berjalan
async scaleOut(target) {
  if (!Number.isInteger(target) || target < this.c.min || target > this.c.max)
    throw new Error("Unsafe target");
  await this.preflight();
  if ((await this.list("backend")).length > target)
    throw new Error(
      "Refusing Compose shrink on scale-out; reconcile stopped/orphaned backends explicitly",
    );
  return this.compose(
    [
      "up",
      "-d",
      "--no-deps",
      "--no-recreate",
      "--no-build",
      "--scale",
      `backend=${target}`,
      "backend",
    ],
    { timeout: 120000 },
  );
}

// 2. Fungsi Scale-In dengan Graceful Drain (scripts/p3/controller.js)
// Mengeluarkan kandidat backend dari Nginx, menunggu request & pool selesai, lalu menghentikan container
async scaleIn(containers, target) {
  const candidate = [...containers].sort((a, b) => ordinal(b) - ordinal(a))[0];
  const original = this.routed;
  const remaining = original.filter((b) => b.id !== candidate.Id);
  if (remaining.length < target || remaining.length < this.c.min)
    throw new Error("Unsafe drain membership");

  this.state.pending = { action: "in", id: candidate.Id, target };
  this.save();
  let terminationStarted = false;
  try {
    const transaction = await this.routing.apply(remaining);
    this.routed = remaining;
    const deadline = Date.now() + this.c.drainTimeout;
    let drained = false;
    while (Date.now() < deadline) {
      if (
        (await this.routing.workersGone(transaction)) &&
        idle(await this.docker.probe(candidate))
      ) {
        drained = true;
        break;
      }
      await sleep(500);
    }
    if (!drained) throw new Error("Drain timeout");
    terminationStarted = true;
    this.state.pending.phase = "terminating";
    this.save();
    await this.docker.removeBackend(candidate.Id);
    this.state.desired = target;
    this.state.pending = null;
  } finally {
    this.save();
  }
}
```

---

### 2. Alasan Kenapa Pakai k6!

Pemilihan **Grafana k6** dibandingkan tool alternatif seperti Apache JMeter atau Locust didasari oleh pertimbangan teknis berikut:

1. **Overhead CPU & Memori Sangat Rendah pada Pengujian *Single-Host* (Berbasis Go / Goroutines):**
   Pada lingkungan praktikum ini, *load generator* dan seluruh container Docker (Nginx, 2–6 Backend, PostgreSQL Primary & Replica) berjalan di satu mesin fisik (*host* Windows) yang sama. Apache JMeter berjalan di atas JVM dan mengalokasikan *1 OS thread per Virtual User* yang dapat menghabiskan RAM serta CPU host saat diuji pada 1.000 VU. Sebaliknya, **k6 dikompilasi menggunakan bahasa Go (Golang)** dan memanfaatkan *goroutines* ringan. Sebagaimana terbukti pada **Gambar 19** di laporan Pertemuan 3, saat membangkitkan **1.000 VU**, proses generator k6 hanya memakai sekitar **`0,7` hingga `1,0` core CPU**, sehingga tidak memonopoli sumber daya mesin yang dibutuhkan oleh container backend dan database.
2. **Skrip Pengujian Berbasis JavaScript (*Test-as-Code*) yang Seragam dengan Stack Aplikasi:**
   Karena backend dan controller proyek ini dibangun menggunakan Node.js (JavaScript), penggunaan skrip k6 (`tests/load/workload.js`) menjaga keseragaman bahasa pemrograman di seluruh repositori. Berbeda dengan file XML `.jmx` pada JMeter yang sulit dibaca di Git, skrip JavaScript k6 memudahkan pembuatan logika pengujian terprogram seperti pembuatan `Idempotency-Key` deterministik (`${runId}-${vu}-${iteration}`), validasi struktur payload JSON, serta pemisahan metrik berdasarkan tag (`phase`, `endpoint`, `outcome`).
3. **Kemampuan *Real-Time Streaming* Sampel Time-Series Terkompresi (`--out json=k6-samples.ndjson.gz`):**
   k6 mampu mengekspor setiap sampel request individual secara langsung ke file NDJSON terkompresi *gzip* dengan resolusi waktu per detik. Hal ini memungkinkan skrip analisis (`scripts/p3/report.js`) menghitung persentil ke-95 (p95) secara eksak (bukan rata-rata persentil) dan memetakan kurva *throughput*, latensi, serta *error rate* detik demi detik secara berdampingan dengan log *autoscaling*.

---

### 3. Code Testing-nya Mana? Yang 100 Mana, yang 1.000 Mana?

Pengujian beban menggunakan file skrip k6 `tests/load/workload.js` yang dipanggil oleh orchestrator `scripts/p3/run.js`. Skrip dirancang secara **berparameter (*parameterized*)** melalui environment variable `P3_VUS` dan `P3_CALIBRATION_SECONDS`.

#### A. Konfigurasi Spesifik Pengujian 100 VU vs 1.000 VU

1. **Konfigurasi Saat Menjalankan Skenario 100 VU (`--vus 100 --seconds 120`):**
   - **Perintah Eksekusi:**
     ```powershell
     node scripts/p3/run.js --campaign stress --mode fixed --vus 100 --seconds 120 --execute
     node scripts/p3/run.js --campaign stress --mode auto  --vus 100 --seconds 120 --execute
     ```
   - **Konfigurasi Skenario k6 yang Dijalankan (`P3_VUS=100`):**
     ```javascript
     export const options = {
       scenarios: {
         workload: {
           executor: "constant-vus",
           vus: 100,             // 100 Virtual Users aktif secara konstan
           duration: "120s",     // Durasi pengujian 120 detik (2 menit)
           gracefulStop: "30s",
         },
       },
       summaryTrendStats: ["avg", "min", "med", "max", "p(95)"],
       thresholds: { "validation_error{phase:measure}": ["rate==0"] },
     };
     ```

2. **Konfigurasi Saat Menjalankan Skenario 1.000 VU (`--vus 1000 --seconds 120`):**
   - **Perintah Eksekusi:**
     ```powershell
     node scripts/p3/run.js --campaign stress --mode fixed --vus 1000 --seconds 120 --execute
     node scripts/p3/run.js --campaign stress --mode auto  --vus 1000 --seconds 120 --execute
     ```
   - **Konfigurasi Skenario k6 yang Dijalankan (`P3_VUS=1000`):**
     ```javascript
     export const options = {
       scenarios: {
         workload: {
           executor: "constant-vus",
           vus: 1000,            // 1.000 Virtual Users aktif secara konstan
           duration: "120s",     // Durasi pengujian 120 detik (2 menit)
           gracefulStop: "30s",
         },
       },
       summaryTrendStats: ["avg", "min", "med", "max", "p(95)"],
       thresholds: { "validation_error{phase:measure}": ["rate==0"] },
     };
     ```

#### B. Kode Lengkap Skrip Pengujian k6 (`tests/load/workload.js`)

```javascript
import http from "k6/http";
import { sleep, check } from "k6";
import exec from "k6/execution";
import { Counter, Rate, Trend } from "k6/metrics";

const base = __ENV.P3_BASE_URL || "http://127.0.0.1:8080";
const runId = __ENV.P3_RUN_ID;
const workload = __ENV.P3_WORKLOAD || "read";
const profile = __ENV.P3_PROFILE || "final";
const vus = Number(__ENV.P3_VUS || 10);
const calibrationSeconds = Number(__ENV.P3_CALIBRATION_SECONDS || 120);
if (
  ["calibration", "stress"].includes(profile) &&
  (workload !== "read" ||
    vus < 1 ||
    vus > (profile === "stress" ? 1000 : 100) ||
    !Number.isInteger(calibrationSeconds) ||
    calibrationSeconds < 30 ||
    calibrationSeconds > 180)
)
  throw new Error(
    "Bounded read-only calibration requires 1–100 VU and 30–180 seconds",
  );
if (
  !/^p3-[a-z0-9-]{1,60}$/.test(runId || "") ||
  !["read", "write", "mixed"].includes(workload)
)
  throw new Error("Invalid run identity/workload");
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base))
  throw new Error("P3 ingress must be local Nginx");
const timing =
  ["calibration", "stress"].includes(profile)
    ? [0, 0, 0, calibrationSeconds, 0]
    : profile === "smoke"
      ? [0, 0, 0, 5, 0]
      : profile === "pilot"
        ? [10, 10, 10, 30, 10]
        : [30, 30, 30, 180, 30];
const start = timing.slice(0, 3).reduce((a, b) => a + b, 0) * 1000;
const end = start + timing[3] * 1000;
export const options = {
  scenarios: {
    workload:
      profile === "smoke" || ["calibration", "stress"].includes(profile)
        ? {
            executor: "constant-vus",
            vus,
            duration: `${timing[3]}s`,
            gracefulStop: "30s",
          }
        : {
            executor: "ramping-vus",
            startVUs: Math.min(10, vus),
            gracefulRampDown: "30s",
            gracefulStop: "30s",
            stages: [
              { duration: `${timing[0]}s`, target: Math.min(10, vus) },
              { duration: `${timing[1]}s`, target: vus },
              { duration: `${timing[2]}s`, target: vus },
              { duration: `${timing[3]}s`, target: vus },
              { duration: `${timing[4]}s`, target: 0 },
            ],
          },
  },
  summaryTrendStats: ["avg", "min", "med", "max", "p(95)"],
  thresholds: { "validation_error{phase:measure}": ["rate==0"] },
};
const attempts = new Counter("measured_attempts");
const successes = new Counter("successful_requests");
const checkoutSuccess = new Counter("checkout_created");
const allCreated = new Counter("checkout_created_all");
const allAttempts = new Counter("checkout_attempts_all");
const infra = new Rate("infrastructure_error");
const invalid = new Rate("validation_error");
const soldout = new Rate("business_sold_out");
const latency = new Trend("measured_duration", true);
const waiting = new Trend("measured_ttfb", true);
const http5xx = new Counter("http_5xx_count");
const timeouts = new Counter("timeout_count");
const connectionErrors = new Counter("connection_error_count");
http.setResponseCallback(http.expectedStatuses(200, 201, 409));

export default function () {
  const iteration = exec.vu.iterationInScenario;
  const offset = exec.vu.idInTest + iteration;
  const write =
    workload === "write" || (workload === "mixed" && offset % 5 === 0);
  const phase =
    exec.instance.currentTestRunDuration >= start &&
    exec.instance.currentTestRunDuration < end
      ? "measure"
      : "transition";
  const endpoint = write ? "checkout" : "products";
  const tags = { phase, endpoint };
  const key = `${runId}-${exec.vu.idInTest}-${iteration}`;
  const product = offset % 100 < 80 ? 1 : offset % 100 < 95 ? 2 : 3;
  const response = write
    ? http.post(
        `${base}/checkout`,
        JSON.stringify({
          user_id: (offset % 100) + 1,
          product_id: product,
          qty: 1,
        }),
        {
          timeout: "15s",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": key,
          },
          tags: { ...tags, name: "POST /checkout" },
        },
      )
    : http.get(`${base}/products`, {
        timeout: "15s",
        tags: { ...tags, name: "GET /products" },
      });
  let body;
  try {
    body = response.json();
  } catch (_) {
    body = null;
  }
  const exhausted =
    write && response.status === 409 && body?.error === "SOLD_OUT";
  const ok = write
    ? response.status === 201 && body?.result === "CREATED" && !!body?.order?.id
    : response.status === 200 && Array.isArray(body) && body.length === 3;
  const infrastructure = response.status === 0 || response.status >= 500;
  const outcome = ok
    ? "success"
    : exhausted
      ? "sold_out"
      : infrastructure
        ? "infrastructure_error"
        : "unexpected";
  const resultTags = { ...tags, outcome };
  invalid.add(!ok && !exhausted && !infrastructure, tags);
  check(
    response,
    {
      "valid business or infrastructure outcome": () =>
        ok || exhausted || infrastructure,
    },
    tags,
  );
  infra.add(infrastructure, tags);
  soldout.add(exhausted, tags);
  allCreated.add(write && ok ? 1 : 0, tags);
  allAttempts.add(write ? 1 : 0, tags);
  if (phase === "measure") {
    attempts.add(1, tags);
    successes.add(ok ? 1 : 0, tags);
    checkoutSuccess.add(write && ok ? 1 : 0, tags);
    http5xx.add(response.status >= 500 ? 1 : 0, tags);
    timeouts.add(response.error_code === 1050 ? 1 : 0, tags);
    connectionErrors.add(
      response.status === 0 && response.error_code !== 1050 ? 1 : 0,
      tags,
    );
    latency.add(response.timings.duration, resultTags);
    waiting.add(response.timings.waiting, resultTags);
  }
  if (write && infrastructure)
    console.warn(
      JSON.stringify({
        type: "ambiguous_checkout",
        key,
        status: response.status,
        error_code: response.error_code,
      }),
    );
  sleep(0.1);
}
export function handleSummary(data) {
  return {
    [__ENV.P3_SUMMARY || "k6-summary.json"]: JSON.stringify(data, null, 2),
  };
}
```

---

### 4. Analisis Detik dan Menit Ke Berapa Error Terjadi!

Berdasarkan data log `p3-scale-in-evidence.ndjson` dan kurva *time-series* per detik pada laporan Pertemuan 3 (**Gambar 10, Gambar 11, Gambar 12, Gambar 13, Gambar 20, dan Gambar 21**), berikut adalah rincian **detik, menit, dan jam terjadinya error infrastruktur** pada masing-masing tingkat beban selama 120 detik (2 menit) pengujian:

#### A. Tabel Kronologi Waktu Terjadinya Error per Tingkat VU

| Skenario Pengujian | Error Rate Agregat | Rentang Detik & Menit Terjadinya Error | Waktu Absolut (UTC / WIB) | Detail Perilaku Kurva per Detik |
| :--- | :---: | :--- | :--- | :--- |
| **10 VU — Fixed & Auto** | **0,00%** | **Tidak ada error** (Detik ke-0 s.d. ke-120 / Menit `00:00` – `02:00`) | `03:33:01Z` – `03:37:36Z` (`10:33` – `10:37 WIB`) | Kurva error rata `0%` sepanjang 2 menit penuh. |
| **100 VU — Fixed & Auto** | **0,00%** | **Tidak ada error** (Detik ke-0 s.d. ke-120 / Menit `00:00` – `02:00`) | `03:23:58Z` – `03:28:48Z` (`10:23` – `10:28 WIB`) | Kurva error rata `0%` sepanjang 2 menit penuh, termasuk saat *scale-out* berlangsung pada **detik ke-61 s.d. detik ke-70** (`03:27:45Z` – `03:27:54Z`). |
| **500 VU — Auto** *(Lihat Gambar 10)* | **1,39%** | **Detik ke-0 s.d. Detik ke-2** *(Menit ke-0, hanya 2 detik pertama)* | `03:41:14Z` – `03:41:16Z` (`10:41:14` – `10:41:16 WIB`) | - **Detik ke-0:** Error melonjak ke puncak **90,7%**.<br>- **Detik ke-1 s.d. ke-2:** Error turun tajam menuju 0%.<br>- **Detik ke-3 s.d. ke-121 (Menit `00:03` – `02:01`):** Error stabil **0,0%** hingga selesai. |
| **500 VU — Fixed** | **2,15%** | **Detik ke-0 s.d. Detik ke-3** *(Menit ke-0, hanya 3 detik pertama)* | `03:38:32Z` – `03:38:35Z` (`10:38:32` – `10:38:35 WIB`) | Error hanya muncul pada 3 detik pertama saat 500 VU membuka koneksi serentak; **mulai detik ke-4 s.d. ke-120 error menjadi 0,0%**. |
| **1.000 VU — Auto** *(Lihat Gambar 11, 12, 13)* | **22,11%** | **Detik ke-0 s.d. Detik ke-8** *(Menit ke-0 detik 00 s.d. detik 08)* | `03:47:01Z` – `03:47:09Z` (`10:47:01` – `10:47:09 WIB`) | - **Detik ke-0 s.d. ke-6:** Error sangat tinggi di kisaran **85% – 96,7%** (dengan lonjakan percobaan request `4.630 req/s` pada Gambar 11).<br>- **Detik ke-7 s.d. ke-8:** Latensi p95 menyentuh puncak **4.527,7 ms** (Gambar 12) saat antrean koneksi mulai terurai, lalu kurva error jatuh ke 0%.<br>- **Detik ke-9 s.d. ke-122 (Menit `00:09` – `02:02`):** Error stabil **0,0%** sampai pengujian berakhir. |
| **1.000 VU — Fixed** *(Lihat Gambar 20 & 21)* | **52,27%** | **Detik ke-0 s.d. Detik ke-33** *(Menit ke-0 detik 00 s.d. detik 33)* | `03:44:05Z` – `03:44:38Z` (`10:44:05` – `10:44:38 WIB`) | - **Detik ke-0 s.d. ke-30:** Error bertahan di **88% – 99,5%** selama setengah menit pertama (total percobaan mencapai `3.290 req/s` karena request gagal berulang cepat).<br>- **Detik ke-31 s.d. ke-33:** Error turun drastis menuju 0%.<br>- **Detik ke-34 s.d. ke-122 (Menit `00:34` – `02:02`):** Error stabil **0,0%** hingga selesai. |

#### B. Penjelasan Teknis Mengapa Error Terjadi Tepat di Detik-Detik Awal (Fase Inisiasi Koneksi)

1. **Ledakan Koneksi Serentak (*TCP SYN Burst*) pada Detik ke-0:**
   Karena profil `stress` pada `tests/load/workload.js` menggunakan `executor: "constant-vus"` tanpa fase *ramp-up* (`timing = [0, 0, 0, 120, 0]`), seluruh **500 VU** atau **1.000 VU** langsung melakukan *TCP three-way handshake* secara bersamaan pada **detik ke-0** ke alamat `127.0.0.1:8080`.
2. **Penolakan Koneksi pada Lapisan Port-Forwarding (`connectex / connection refused`):**
   Antrean *socket listen backlog* pada jembatan jaringan Windows Host menuju Docker Desktop Linux VM dan Nginx langsung penuh pada detik ke-0, sehingga sebagian koneksi baru ditolak seketika oleh sistem operasi (`status = 0`, `connection refused`).
3. **Mengapa Error Berhenti Menjadi 0% Setelah Detik ke-3 (500 VU), Detik ke-9 (Auto 1.000 VU), dan Detik ke-34 (Fixed 1.000 VU)?**
   Begitu setiap Virtual User berhasil mendapatkan satu koneksi TCP yang mapan, k6 dan Nginx mempertahankan koneksi tersebut menggunakan fitur **HTTP/1.1 Keep-Alive** (`keepalive 32` dan `proxy_set_header Connection ""`). Akibatnya, pada iterasi-iterasi berikutnya (mulai detik ke-9 hingga detik ke-122 pada Auto 1.000 VU), tidak ada lagi pembuatan koneksi TCP baru dan **tingkat error koneksi turun menjadi 0%**.
4. **Hubungan Waktu Error dengan Waktu Eksekusi Scale-Out:**
   Pada pengujian **Auto 1.000 VU**, error terjadi pada **detik ke-0 s.d. detik ke-8** (`03:47:01Z` – `03:47:09Z`), sedangkan keputusan *scale-out* dari 2 ke 3 backend baru terjadi pada **detik ke-58** (`03:47:59.290Z`), mulai dieksekusi pada **detik ke-60 / menit ke-1** (`03:48:01.219Z`), dan selesai aktif di Nginx pada **detik ke-73 / menit ke-1 detik ke-13** (`03:48:14.510Z`). Hal ini membuktikan secara akurat bahwa berhentinya error setelah detik ke-8 disebabkan oleh stabilnya penggunaan ulang koneksi (*HTTP Keep-Alive*), bukan karena penambahan backend ketiga.

