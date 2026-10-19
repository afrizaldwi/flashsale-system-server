#!/usr/bin/env bash
# FAILOVER manual: promosikan replica menjadi primary baru saat primary mati.
# Setelah ini ubah .env backend: DB_PORT=<port replica> dan kosongkan DB_REPLICA_HOST, lalu restart backend.
set -euo pipefail
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
REPLICA_DIR="${REPLICA_DIR:-$HOME/pg-replica}"
"$PGBIN/pg_ctl" -D "$REPLICA_DIR" -w promote
echo "Replica sekarang menjadi PRIMARY. Arahkan backend ke port replica lalu restart."
