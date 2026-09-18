<#
.SYNOPSIS
  Restore a custom-format PostgreSQL dump into a prepared, empty database.

.DESCRIPTION
  This command refuses more than it does.

  The failure it exists to prevent is not a restore that stops -- it is a restore that reports
  success and leaves the shop with parents and no children. Restoring into a database the backend
  has already started against does exactly that: `server.js` bootstraps its schema with
  CREATE TABLE IF NOT EXISTS, so the tables are already there with their foreign keys live, and
  pg_restore's COPY then fails on every child table while the parents load fine. Reproduced on
  PostgreSQL 16 against a five-table subset of this schema:

      users=2  products=3  sales=2        <- restored
      inventory_batches=0  sale_items=0   <- silently empty

  Every invoice present, not one line item, no stock, exit status ignored. Two things make that
  impossible now: --single-transaction with --exit-on-error, so a restore is all or nothing, and an
  explicit $LASTEXITCODE check, because $ErrorActionPreference = "Stop" does not apply to native
  executables -- pg_restore returned 1 and the old script still printed its success object.
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$DumpFile,
  [string]$Database = $env:DB_NAME,
  [string]$HostName = $env:DB_HOST,
  [string]$Port = $env:DB_PORT,
  [string]$User = $env:DB_USER,
  # Restore into a database that already holds tables. Off by default: the safe restore target is
  # an empty database, and "the tables are already there" is the condition that produced the
  # half-restore above.
  [switch]$AllowNonEmptyTarget
)

$ErrorActionPreference = "Stop"
$Database = if ($Database) { $Database } else { "froozerp" }
$HostName = if ($HostName) { $HostName } else { "localhost" }
$Port = if ($Port) { $Port } else { "5432" }
$User = if ($User) { $User } else { "postgres" }

if (!(Test-Path $DumpFile)) {
  throw "Dump file not found: $DumpFile"
}
$DumpFile = (Resolve-Path $DumpFile).Path

# A native command's exit status is not an error in PowerShell. Without this, every pg_* failure
# below reads as success.
function Invoke-Native {
  param([string]$What, [scriptblock]$Command)
  $global:LASTEXITCODE = 0
  & $Command
  if ($LASTEXITCODE -ne 0) {
    throw "$What failed with exit code $LASTEXITCODE. Nothing was committed to $Database."
  }
}

Write-Host "Reading the dump before asking the database for anything."
# Whether a dump is intact is knowable without credentials, and a dump that cannot be listed cannot
# be restored. The old script checked only that the file was non-empty, which a dump truncated
# half-way still is.
Invoke-Native "Reading the table of contents of $DumpFile" {
  pg_restore --list $DumpFile | Out-Null
}

Write-Host "About to restore PostgreSQL dump."
Write-Host "Target database: $Database Host: $HostName Port: $Port User: $User"
Write-Host "Dump file: $DumpFile"
Write-Host "This script does not drop or create databases. Prepare the target database explicitly before restore."

$existing = & psql --host $HostName --port $Port --username $User --dbname $Database `
  --tuples-only --no-align --no-psqlrc `
  --command "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname = 'public';"
if ($LASTEXITCODE -ne 0) {
  throw "Could not inspect $Database on $HostName. Refusing to restore into a database whose state is unknown."
}
$existingTables = [int]($existing | Select-Object -Last 1).Trim()

if ($existingTables -gt 0 -and -not $AllowNonEmptyTarget) {
  throw @"
$Database already holds $existingTables table(s) in schema public, so this is not an empty restore target.

This is the case that silently loses data: the tables carry live foreign keys, so the parent tables
restore and the child tables (inventory_batches, sale_items, sale_batch_allocations ...) come back
empty. Every invoice, no line items.

Usually this means the backend has started against this database and bootstrapped its schema.
Restore into a genuinely fresh database instead:

    dropdb  $Database        # only if it holds nothing you need
    createdb $Database
    .\scripts\cloud\restore-postgres.ps1 -DumpFile "$DumpFile"

Pass -AllowNonEmptyTarget only if you have decided the existing contents are disposable. The restore
is still all-or-nothing, so it will fail cleanly rather than half-apply.
"@
}

# --single-transaction with --exit-on-error is what makes a failed restore leave nothing behind.
# --no-owner/--no-acl: the cloud role is not the role that took the dump, and without these the
# ownership statements fail -- which, now that a single error aborts the restore, would stop it.
Invoke-Native "Restoring $DumpFile into $Database" {
  pg_restore --verbose --single-transaction --exit-on-error --no-owner --no-acl `
    --host $HostName --port $Port --username $User --dbname $Database $DumpFile
}

$restoredTables = & psql --host $HostName --port $Port --username $User --dbname $Database `
  --tuples-only --no-align --no-psqlrc `
  --command "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'r' AND n.nspname = 'public';"
if ($LASTEXITCODE -ne 0) {
  throw "Restore reported success but $Database could not be read back. Verify before using it."
}

Write-Host ""
Write-Host "Restore committed. Verify it before the shop relies on it:"
Write-Host "    .\scripts\cloud\verify-row-counts.ps1 -Database $Database -CompareDatabase <source>"

[pscustomobject]@{
  restoredDump = $DumpFile
  database = $Database
  host = $HostName
  tablesInTarget = [int]($restoredTables | Select-Object -Last 1).Trim()
  completedAt = (Get-Date).ToString("s")
} | ConvertTo-Json
