$ErrorActionPreference = 'Stop'
$replicaDir = if ($env:REPLICA_DIR) { $env:REPLICA_DIR } else { Join-Path $env:LOCALAPPDATA 'pg-replica-5433' }
& pg_ctl -D $replicaDir -m fast -w stop
if ($LASTEXITCODE -ne 0) { throw 'Stop replica gagal.' }
Write-Host 'Replica berhenti tanpa menghapus data.'
