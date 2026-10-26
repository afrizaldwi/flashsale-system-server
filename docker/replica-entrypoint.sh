#!/bin/sh
# replica-entrypoint.sh
# Inisialisasi PostgreSQL Replica (Hot Standby) di Docker
# Pertemuan 2: Containerization (Docker) - Kelompok 1, Cloud Computing H7D.7

set -e

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PRIMARY_HOST="${PRIMARY_HOST:-db-primary}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"
REPLICATION_USER="${REPLICATION_USER:-replicator}"
REPLICATION_PASSWORD="${REPLICATION_PASSWORD:-replicatorpass}"

echo "[replica-init] Menunggu primary siap di ${PRIMARY_HOST}:${PRIMARY_PORT}..."

until pg_isready -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U postgres 2>/dev/null; do
  echo "[replica-init] Primary belum siap, tunggu 2 detik..."
  sleep 2
done

echo "[replica-init] Primary sudah siap."

# Jika data directory sudah ada dan berisi data valid, skip basebackup
if [ -s "$PGDATA/PG_VERSION" ]; then
  echo "[replica-init] Data directory sudah ada, skip pg_basebackup."
else
  echo "[replica-init] Menjalankan pg_basebackup dari ${PRIMARY_HOST}..."

  # Hapus ISI direktori (bukan direktorinya sendiri karena itu mount point volume)
  find "$PGDATA" -mindepth 1 -delete 2>/dev/null || true

  PGPASSWORD="$REPLICATION_PASSWORD" pg_basebackup \
    -h "$PRIMARY_HOST" \
    -p "$PRIMARY_PORT" \
    -U "$REPLICATION_USER" \
    -D "$PGDATA" \
    -P \
    -Xs \
    -R

  echo "[replica-init] pg_basebackup selesai."

  # Tambahkan pengaturan recovery ke postgresql.auto.conf
  cat >> "$PGDATA/postgresql.auto.conf" <<PGCONF

# Replica streaming replication config (Pertemuan 2)
primary_conninfo = 'host=${PRIMARY_HOST} port=${PRIMARY_PORT} user=${REPLICATION_USER} password=${REPLICATION_PASSWORD} application_name=replica1'
hot_standby = on
hot_standby_feedback = on
PGCONF

  echo "[replica-init] Konfigurasi standby selesai."
fi

echo "[replica-init] Menjalankan PostgreSQL standby..."
exec docker-entrypoint.sh postgres \
  -c hot_standby=on \
  -c max_connections=100 \
  -c shared_buffers=128MB \
  -c wal_level=replica