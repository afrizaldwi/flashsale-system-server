#!/usr/bin/env bash
set -euo pipefail
# ==============================================================================
# scripts/p4/backup-loop.sh
# PostgreSQL Periodic Backup Automation Loop Wrapper
#
# Memastikan konsistensi 100% dengan meneruskan seluruh argumen ke backup-loop.js
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[BACKUP-LOOP ERROR] Node.js is required to execute backup loop automation." >&2
  exit 127
fi

exec node "${SCRIPT_DIR}/backup-loop.js" "$@"
