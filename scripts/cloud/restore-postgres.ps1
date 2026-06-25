param(
  [Parameter(Mandatory = $true)]
  [string]$DumpFile,
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

if (!(Test-Path $DumpFile)) {
  throw "Dump file not found: $DumpFile"
}

Write-Host "About to restore PostgreSQL dump."
Write-Host "Target database: $Database Host: $HostName Port: $Port User: $User"
Write-Host "Dump file: $DumpFile"
Write-Host "This script does not drop or create databases. Prepare the target database explicitly before restore."

pg_restore --verbose --host $HostName --port $Port --username $User --dbname $Database $DumpFile

[pscustomobject]@{
  restoredDump = (Resolve-Path $DumpFile).Path
  database = $Database
  host = $HostName
  completedAt = (Get-Date).ToString("s")
} | ConvertTo-Json
