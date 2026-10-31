#!/bin/sh
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD" PGCONNECT_TIMEOUT=2 PGOPTIONS='-c statement_timeout=2000'
expected=f
[ "$1" = replica ] && expected=t
actual=$(psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -XAtqc 'SELECT pg_is_in_recovery()')
[ "$actual" = "$expected" ]
