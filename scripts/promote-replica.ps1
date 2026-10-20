# Windows PowerShell. Failover MANUAL setelah primary lama di-FENCE.
# Usage: $env:FENCING_CONFIRMED='YES'; .\scripts\promote-replica.ps1
$ErrorActionPreference = 'Stop'
if ($env:FENCING_CONFIRMED -ne 'YES') { throw 'Fencing primary lama belum dikonfirmasi. Set FENCING_CONFIRMED=YES setelah memastikan primary dihentikan dan tidak bisa restart.' }
$primaryHost = if ($env:PRIMARY_HOST) { $env:PRIMARY_HOST } else { '127.0.0.1' }
$primaryPort = if ($env:PRIMARY_PORT) { $env:PRIMARY_PORT } else { '5432' }
$replicaPort = if ($env:REPLICA_PORT) { $env:REPLICA_PORT } else { '5433' }
$replicaDir = if ($env:REPLICA_DIR) { $env:REPLICA_DIR } else { Join-Path $env:LOCALAPPDATA 'pg-replica-5433' }
$dbUser = if ($env:PGUSER) { $env:PGUSER } else { 'postgres' }
foreach ($command in @('pg_ctl','pg_isready','psql')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command tidak ditemukan di PATH." }
}
if (-not (Test-Path (Join-Path $replicaDir 'standby.signal'))) { throw 'standby.signal tidak ditemukan. Bukan replica.' }
& pg_isready -q -h $primaryHost -p $primaryPort -d postgres
if ($LASTEXITCODE -eq 0) { throw 'DITOLAK: primary lama masih menerima koneksi. Fencing terlebih dahulu.' }
$before = (& psql -h 127.0.0.1 -p $replicaPort -U $dbUser -d postgres -AtXc 'SELECT pg_is_in_recovery()').Trim()
if ($LASTEXITCODE -ne 0 -or $before -ne 't') { throw 'Target tidak dalam mode standby.' }
& pg_ctl -D $replicaDir -w promote
if ($LASTEXITCODE -ne 0) { throw 'Promote gagal.' }
$after = (& psql -h 127.0.0.1 -p $replicaPort -U $dbUser -d postgres -AtXc 'SELECT pg_is_in_recovery()').Trim()
if ($LASTEXITCODE -ne 0 -or $after -ne 'f') { throw 'Promosi belum terkonfirmasi.' }
Write-Host 'Replica telah menjadi primary baru. STOP backend, edit .env: DB_PORT=5433 dan DB_REPLICA_HOST= (kosong), lalu npm start.'
Write-Host 'Jangan hidupkan primary lama sebagai penulis; lakukan rekonsiliasi dahulu.'
