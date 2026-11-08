#!/usr/bin/env bash
set -euo pipefail
# ==============================================================================
# scripts/p4/backup.sh
# PostgreSQL Backup Automation Wrapper untuk Stack P3 (flashsale_p3)
#
# Memastikan konsistensi 100% dengan meneruskan seluruh argumen ke backup.js
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[BACKUP ERROR] Node.js is required to execute backup automation." >&2
  exit 127
fi

exec node "${SCRIPT_DIR}/backup.js" "$@"
