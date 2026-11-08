#!/usr/bin/env bash
set -euo pipefail
# ==============================================================================
# scripts/p4/restore.sh
# PostgreSQL Restore Automation Wrapper untuk Stack P3 (flashsale_p3)
#
# Memastikan konsistensi 100% dengan meneruskan seluruh argumen ke restore.js
# Mendukung --execute, --file, serta seluruh opsi restore.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[RESTORE ERROR] Node.js is required to execute restore automation." >&2
  exit 127
fi

exec node "${SCRIPT_DIR}/restore.js" "$@"
