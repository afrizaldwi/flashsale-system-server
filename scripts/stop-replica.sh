#!/usr/bin/env bash
# Opsional: hentikan replica lokal (bukan primary). Tidak menghapus data.
set -Eeuo pipefail
REPLICA_DIR="${REPLICA_DIR:-$HOME/pg-replica-5433}"
pg_ctl -D "$REPLICA_DIR" -m fast -w stop
