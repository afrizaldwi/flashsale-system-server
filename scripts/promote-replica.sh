#!/usr/bin/env bash
# Failover MANUAL sesuai DRP §7.1. Tidak pernah menghentikan primary secara otomatis.
# Operator wajib melakukan FENCING terlebih dahulu dan menyatakan konfirmasi eksplisit:
# FENCING_CONFIRMED=YES ./scripts/promote-replica.sh
# PENTING: primary unreachable != fenced. Gangguan jaringan dapat menyebabkan split-brain.
set -Eeuo pipefail
PRIMARY_HOST="${PRIMARY_HOST:-127.0.0.1}"
PRIMARY_PORT="${PRIMARY_PORT:-5432}"
REPLICA_HOST="${REPLICA_HOST:-127.0.0.1}"
REPLICA_PORT="${REPLICA_PORT:-5433}"
REPLICA_DIR="${REPLICA_DIR:-$HOME/pg-replica-5433}"
PGUSER="${PGUSER:-postgres}"

if [ "${FENCING_CONFIRMED:-}" != 'YES' ]; then
  echo 'DITOLAK: fencing primary lama harus dipastikan dahulu.' >&2
  echo 'Hentikan primary lama dan cegah auto-restart; baru jalankan dengan FENCING_CONFIRMED=YES.' >&2
  exit 1
fi
for tool in pg_ctl psql pg_isready; do
  command -v "$tool" >/dev/null || { echo "ERROR: $tool tidak ditemukan di PATH" >&2; exit 1; }
done
if [ ! -f "$REPLICA_DIR/standby.signal" ]; then
  echo "DITOLAK: standby.signal tidak ditemukan di $REPLICA_DIR" >&2; exit 1
fi
# Penjagaan tambahan di localhost; tetap memerlukan fencing terverifikasi secara operasional.
if pg_isready -q -h "$PRIMARY_HOST" -p "$PRIMARY_PORT" -d postgres; then
  echo "DITOLAK: primary lama $PRIMARY_HOST:$PRIMARY_PORT masih menerima koneksi." >&2
  exit 1
fi
in_recovery=$(psql -h "$REPLICA_HOST" -p "$REPLICA_PORT" -U "$PGUSER" -d postgres -AtXc 'SELECT pg_is_in_recovery()')
if [ "$in_recovery" != 't' ]; then
  echo "DITOLAK: target bukan standby aktif (pg_is_in_recovery()=$in_recovery)" >&2
  exit 1
fi
printf '>> Primary lama harus SUDAH diisolasi, proses promosi dimulai...\n'
pg_ctl -D "$REPLICA_DIR" -w promote
is_primary=$(psql -h "$REPLICA_HOST" -p "$REPLICA_PORT" -U "$PGUSER" -d postgres -AtXc 'SELECT pg_is_in_recovery()')
if [ "$is_primary" != 'f' ]; then
  echo 'ERROR: promosi belum terkonfirmasi (pg_is_in_recovery bukan false)' >&2; exit 1
fi
echo '>> Replica menjadi PRIMARY baru. STOP backend, edit .env:'
echo "   DB_HOST=$REPLICA_HOST"
echo "   DB_PORT=$REPLICA_PORT"
echo '   DB_REPLICA_HOST='
echo '>> Jalankan npm start lagi, cek /health dan npm run db:verify.'
echo '>> Jangan menghidupkan primary lama untuk write; rekonsiliasi dahulu.'
