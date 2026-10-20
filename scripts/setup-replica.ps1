# Windows PowerShell, PostgreSQL 16 utilities (pg_basebackup, pg_ctl, psql) di PATH.
# Jalankan dengan akun yang mempunyai izin menulis REPLICA_DIR dan mengelola PostgreSQL-nya.
# Usage: .\scripts\setup-replica.ps1
$ErrorActionPreference = 'Stop'
$primaryHost = if ($env:PRIMARY_HOST) { $env:PRIMARY_HOST } else { '127.0.0.1' }
$primaryPort = if ($env:PRIMARY_PORT) { $env:PRIMARY_PORT } else { '5432' }
$replicaHost = '127.0.0.1'
$replicaPort = if ($env:REPLICA_PORT) { $env:REPLICA_PORT } else { '5433' }
$replicaDir = if ($env:REPLICA_DIR) { $env:REPLICA_DIR } else { Join-Path $env:LOCALAPPDATA 'pg-replica-5433' }
$dbUser = if ($env:PGUSER) { $env:PGUSER } else { 'postgres' }
foreach ($command in @('pg_basebackup','pg_ctl','psql')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) { throw "$command tidak ditemukan. Tambahkan folder bin PostgreSQL 16 ke PATH." }
}
if (Test-Path (Join-Path $replicaDir 'PG_VERSION')) { throw "Replica sudah ada: $replicaDir. Tidak dihapus otomatis." }
New-Item -ItemType Directory -Force -Path $replicaDir | Out-Null
Write-Host "Membuat streaming replica di $replicaDir"
& pg_basebackup -h $primaryHost -p $primaryPort -U $dbUser -D $replicaDir -X stream -R -P
if ($LASTEXITCODE -ne 0) { throw 'pg_basebackup gagal.' }
Add-Content -Path (Join-Path $replicaDir 'postgresql.auto.conf') -Value "`nport = $replicaPort`nlisten_addresses = '$replicaHost'"
& pg_ctl -D $replicaDir -o "-p $replicaPort" -l (Join-Path $replicaDir 'replica.log') -w start
if ($LASTEXITCODE -ne 0) { throw 'Replica gagal dinyalakan.' }
$recovery = (& psql -h $replicaHost -p $replicaPort -U $dbUser -d postgres -AtXc 'SELECT pg_is_in_recovery()').Trim()
if ($LASTEXITCODE -ne 0 -or $recovery -ne 't') { throw 'Instance baru tidak dalam mode read-only recovery.' }
Write-Host 'OK: streaming replica aktif.'
