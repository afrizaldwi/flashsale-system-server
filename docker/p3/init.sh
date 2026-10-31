#!/bin/sh
set -eu
export PGPASSWORD="$POSTGRES_PASSWORD"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v replication_password="$P3_REPLICATION_PASSWORD" -v environment_id="$P3_ID" <<'SQL'
SELECT format('CREATE ROLE p3_replicator WITH REPLICATION LOGIN PASSWORD %L', :'replication_password') \gexec
CREATE TABLE p3_environment (id UUID PRIMARY KEY, project TEXT NOT NULL CHECK (project = 'flashsale-p3'));
INSERT INTO p3_environment VALUES (:'environment_id', 'flashsale-p3');
\i /opt/p3/schema.sql
INSERT INTO users(name) SELECT 'P3 User ' || g FROM generate_series(1,100) g;
INSERT INTO products(name,price,initial_stock,stock) VALUES
('P3 Hot Product',2999000,10000000,10000000),
('P3 Secondary',199000,10000000,10000000),
('P3 Third',499000,10000000,10000000);
SQL
printf '\nhost replication p3_replicator all scram-sha-256\n' >> "$PGDATA/pg_hba.conf"
