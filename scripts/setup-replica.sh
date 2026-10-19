#!/usr/bin/env bash
# Membuat REPLICA (slave) PostgreSQL via streaming replication dari PRIMARY (master) yang sedang berjalan.
# Pemakaian:  PGBIN=/usr/lib/postgresql/16/bin ./scripts/setup-replica.sh
# Variabel (opsional): PRIMARY_HOST, PRIMARY_PORT, REPLICA_PORT, REPLICA_DIR, PGUSER
set -euo pipefail
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PRIMARY_HOST="${PRIMARY_HOST:-localhost}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"
REPLICA_PORT="${REPLICA_PORT:-5433}"
REPLICA_DIR="${REPLICA_DIR:-$HOME/pg-replica}"
PGUSER="${PGUSER:-postgres}"

[ -e "$REPLICA_DIR/PG_VERSION" ] && { echo "Replica sudah ada di $REPLICA_DIR (hapus foldernya untuk membuat ulang)"; exit 1; }
mkdir -p "$REPLICA_DIR"; chmod 700 "$REPLICA_DIR"

echo ">> Menyalin data dari primary ($PRIMARY_HOST:$PRIMARY_PORT) ..."
"$PGBIN/pg_basebackup" -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -U "$PGUSER" \
  -D "$REPLICA_DIR" -X stream -R -P        # -R: tulis standby.signal + primary_conninfo

echo ">> Menyalakan replica di port $REPLICA_PORT ..."
"$PGBIN/pg_ctl" -D "$REPLICA_DIR" -o "-p $REPLICA_PORT" -l "$REPLICA_DIR/replica.log" -w start
"$PGBIN/psql" -h localhost -p "$REPLICA_PORT" -U "$PGUSER" -d postgres -Atc "SELECT 'replica read-only = ' || pg_is_in_recovery()"
