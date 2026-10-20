#!/usr/bin/env bash
# Pertemuan 1 - Bangun PostgreSQL streaming replica untuk demo localhost.
# Jalankan sebagai OS user yang berhak mengelola data directory replica.
# Persyaratan: PostgreSQL 16, primary port 5432 dengan streaming replication aktif,
# akun dengan hak REPLICATION; pg_basebackup, pg_ctl, psql tersedia di PATH.
# Contoh: REPLICA_DIR=/var/lib/postgresql/pg-replica-5433 ./scripts/setup-replica.sh
set -Eeuo pipefail
PRIMARY_HOST="${PRIMARY_HOST:-127.0.0.1}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"
REPLICA_HOST="${REPLICA_HOST:-127.0.0.1}"
REPLICA_PORT="${REPLICA_PORT:-5433}"
REPLICA_DIR="${REPLICA_DIR:-$HOME/pg-replica-5433}"
PGUSER="${PGUSER:-postgres}"

for tool in pg_basebackup pg_ctl psql; do
  command -v "$tool" >/dev/null || { echo "ERROR: $tool tidak ada di PATH. Tambahkan folder bin PostgreSQL 16." >&2; exit 1; }
done
if [ -e "$REPLICA_DIR/PG_VERSION" ]; then
  echo "ERROR: $REPLICA_DIR sudah memuat PostgreSQL. Tidak akan menghapus datanya." >&2
  exit 1
fi
mkdir -p "$REPLICA_DIR"
chmod 700 "$REPLICA_DIR"
echo ">> Membuat base backup dari $PRIMARY_HOST:$PRIMARY_PORT"
pg_basebackup -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$PGUSER" -D "$REPLICA_DIR" -X stream -R -P
# -R membuat standby.signal dan primary_conninfo.
echo "port = $REPLICA_PORT" >> "$REPLICA_DIR/postgresql.auto.conf"
echo "listen_addresses = '$REPLICA_HOST'" >> "$REPLICA_DIR/postgresql.auto.conf"
echo ">> Mulai replica (port $REPLICA_PORT)"
pg_ctl -D "$REPLICA_DIR" -o "-p $REPLICA_PORT" -l "$REPLICA_DIR/replica.log" -w start
result=$(psql -h "$REPLICA_HOST" -p "$REPLICA_PORT" -U "$PGUSER" -d postgres -AtXc 'SELECT pg_is_in_recovery()')
if [ "$result" != 't' ]; then
  echo "ERROR: replica tidak dalam mode recovery (hasil: $result)" >&2
  exit 1
fi
echo ">> OK: replica read-only, streaming dari primary"
