param(
  [string]$OutputDir = ".\backups\cloud-migration",
  [string]$Database = $env:DB_NAME,
  [string]$HostName = $env:DB_HOST,
  [string]$Port = $env:DB_PORT,
  [string]$User = $env:DB_USER
)

$ErrorActionPreference = "Stop"
$Database = if ($Database) { $Database } else { "froozerp" }
$HostName = if ($HostName) { $HostName } else { "localhost" }
$Port = if ($Port) { $Port } else { "5432" }
$User = if ($User) { $User } else { "postgres" }

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd_HHmmss"
$dumpFile = Join-Path $OutputDir "froozerp_$stamp.dump"

Write-Host "Creating PostgreSQL backup: $dumpFile"
Write-Host "Database: $Database Host: $HostName Port: $Port User: $User"
pg_dump --format=custom --verbose --host $HostName --port $Port --username $User --dbname $Database --file $dumpFile

if (!(Test-Path $dumpFile) -or ((Get-Item $dumpFile).Length -le 0)) {
  throw "Backup failed or produced an empty file."
}

[pscustomobject]@{
  dumpFile = (Resolve-Path $dumpFile).Path
  size = (Get-Item $dumpFile).Length
  createdAt = (Get-Date).ToString("s")
} | ConvertTo-Json
