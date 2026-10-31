#!/bin/sh
set -eu
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  if command -v gosu >/dev/null 2>&1; then exec gosu postgres sh /opt/p3/replica.sh; fi
  exec su-exec postgres sh /opt/p3/replica.sh
fi
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  if [ -n "$(find "$PGDATA" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    echo 'Refusing nonempty, uninitialized replica directory; no files deleted.' >&2
    exit 1
  fi
  export PGPASSWORD="$P3_REPLICATION_PASSWORD"
  pg_basebackup -h db-primary -U p3_replicator -D "$PGDATA" -Xs -R
  # libpq passfile avoids embedding the password in primary_conninfo.
  printf 'db-primary:5432:replication:p3_replicator:%s\n' "$P3_REPLICATION_PASSWORD" > "$PGDATA/p3.pgpass"
  chmod 600 "$PGDATA/p3.pgpass"
  printf "\nprimary_conninfo = 'host=db-primary port=5432 user=p3_replicator passfile=%s/p3.pgpass application_name=p3_replica'\n" "$PGDATA" >> "$PGDATA/postgresql.auto.conf"
elif [ ! -f "$PGDATA/standby.signal" ]; then
  echo 'Refusing existing database without standby.signal; no promotion or overwrite.' >&2
  exit 1
fi
exec postgres -c hot_standby=on -c max_connections=100 -c shared_buffers=128MB -c wal_level=replica
