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
