<#
.SYNOPSIS
  Take a custom-format PostgreSQL dump and prove it can be read back.

.DESCRIPTION
  The old version decided a backup had worked by checking that the file existed and was longer than
  zero bytes. A pg_dump that dies half-way -- disk full, network dropped, server restarted -- leaves
  a file that passes both of those checks and restores into a half-empty shop. It also ignored
  pg_dump's exit status, because $ErrorActionPreference = "Stop" does not apply to native
  executables.

  So: the exit code is checked, the dump is written under a .partial name and only renamed once
  pg_dump has succeeded, and pg_restore --list is run against the finished file. Listing the table
  of contents is the cheapest thing that actually reads the dump's structure rather than its size.

  --no-owner/--no-acl are set at dump time because the role that owns the shop's tables locally is
  not the role the cloud restores as, and ownership statements that cannot apply would otherwise
  abort a restore that is now deliberately all-or-nothing.
#>
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
$partialFile = "$dumpFile.partial"

Write-Host "Creating PostgreSQL backup: $dumpFile"
Write-Host "Database: $Database Host: $HostName Port: $Port User: $User"

$global:LASTEXITCODE = 0
pg_dump --format=custom --verbose --no-owner --no-acl `
  --host $HostName --port $Port --username $User --dbname $Database --file $partialFile
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $partialFile -Force -ErrorAction SilentlyContinue
  throw "pg_dump failed with exit code $LASTEXITCODE. No backup was kept."
}

if (!(Test-Path $partialFile) -or ((Get-Item $partialFile).Length -le 0)) {
  Remove-Item -LiteralPath $partialFile -Force -ErrorAction SilentlyContinue
  throw "Backup produced an empty file."
}

# Read the dump back. A truncated custom-format dump opens cleanly up to the cut, so "the file is
# there and has bytes in it" is not evidence that it restores.
$global:LASTEXITCODE = 0
pg_restore --list $partialFile | Out-Null
if ($LASTEXITCODE -ne 0) {
  Remove-Item -LiteralPath $partialFile -Force -ErrorAction SilentlyContinue
  throw "The dump could not be read back by pg_restore --list, so it is not a usable backup. It has been deleted rather than left looking valid."
}

Move-Item -LiteralPath $partialFile -Destination $dumpFile -Force

Write-Host ""
Write-Host "Backup verified readable. To prove it actually restores, run the round trip:"
Write-Host "    .\scripts\cloud\verify-restore-roundtrip.ps1 -DumpFile `"$dumpFile`" -ScratchDatabase froozerp_roundtrip"

[pscustomobject]@{
  dumpFile = (Resolve-Path $dumpFile).Path
  size = (Get-Item $dumpFile).Length
  verified = "pg_restore --list"
  createdAt = (Get-Date).ToString("s")
} | ConvertTo-Json
