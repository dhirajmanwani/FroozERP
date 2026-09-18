<#
.SYNOPSIS
  Count every table in a database, and optionally prove two databases agree.

.DESCRIPTION
  Two bugs made the old version of this script able to pass while the data was gone.

  It counted a hand-written list of 17 tables. `server.js` creates 88. Everything outside the list
  -- sale_batch_allocations, customer_ledger, customer_payments, supplier_payments,
  stock_transactions, lot_discounts, sale_returns among them -- could be empty and this script had
  nothing to say about it. A backup verification whose table list is maintained by hand drifts the
  moment a migration adds a table, which is exactly when a restore is most likely to be happening.
  The list is now read from the database.

  Worse, a failure counted as zero. The per-table try/catch never fired, because a native command
  returning non-zero is not a PowerShell error, so a psql that could not connect left $output empty,
  `[int]$null` produced 0, and the row was reported as `{ rowCount = 0; status = "ok" }`. A dead
  connection reported every table as an honest empty table. That is the failure CLAUDE.md names
  directly: errors must never render as zero. A table that could not be counted is now `status =
  "failed"` with a null count, and the script exits non-zero.

  With -CompareDatabase it does the thing the migration runbook actually needs -- compares two
  databases and fails on any difference -- instead of printing one side's numbers for a human to
  eyeball against numbers printed earlier.
#>
param(
  [string]$Database = $env:DB_NAME,
  [string]$HostName = $env:DB_HOST,
  [string]$Port = $env:DB_PORT,
  [string]$User = $env:DB_USER,
  # When given, counts both databases and fails unless every table matches.
  [string]$CompareDatabase
)

$ErrorActionPreference = "Stop"
$Database = if ($Database) { $Database } else { "froozerp" }
$HostName = if ($HostName) { $HostName } else { "localhost" }
$Port = if ($Port) { $Port } else { "5432" }
$User = if ($User) { $User } else { "postgres" }

function Invoke-Psql {
  param([string]$Db, [string]$Query)
  $global:LASTEXITCODE = 0
  $output = & psql --host $HostName --port $Port --username $User --dbname $Db `
    --tuples-only --no-align --no-psqlrc --field-separator '|' --command $Query 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "psql failed against '$Db' (exit $LASTEXITCODE): $($output -join ' ')"
  }
  return @($output | Where-Object { $_ -ne "" })
}

# One statement, counted server-side. Reading the table list from the catalogue is the point: a
# table added by a migration is covered the day it exists, with nobody remembering to add it here.
$COUNT_ALL = @"
SELECT c.relname,
       (xpath('/row/c/text()',
         query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
         FALSE, TRUE, '')))[1]::text::bigint AS row_count
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = 'public'
ORDER BY c.relname;
"@

function Get-Counts {
  param([string]$Db)
  $counts = [ordered]@{}
  foreach ($line in (Invoke-Psql -Db $Db -Query $COUNT_ALL)) {
    $parts = $line -split "\|"
    if ($parts.Count -lt 2) { throw "Unreadable count row from '$Db': $line" }
    # No [int] on a possibly-empty string. An unparseable count is a failure, not a zero.
    $parsed = 0L
    if (-not [long]::TryParse($parts[1].Trim(), [ref]$parsed)) {
      throw "Could not read a row count for table '$($parts[0])' in '$Db' (got '$($parts[1])')."
    }
    $counts[$parts[0].Trim()] = $parsed
  }
  if ($counts.Count -eq 0) { throw "'$Db' reported no tables at all. That is a connection or schema problem, not an empty database." }
  return $counts
}

$primary = Get-Counts -Db $Database
Write-Host "Counted $($primary.Count) tables in $Database."

if (-not $CompareDatabase) {
  ($primary.GetEnumerator() | ForEach-Object {
    [pscustomobject]@{ table = $_.Key; rowCount = $_.Value; status = "ok" }
  }) | ConvertTo-Json
  exit 0
}

$secondary = Get-Counts -Db $CompareDatabase
Write-Host "Counted $($secondary.Count) tables in $CompareDatabase."

$differences = @()
foreach ($table in ($primary.Keys + $secondary.Keys | Sort-Object -Unique)) {
  $left = if ($primary.Contains($table)) { $primary[$table] } else { $null }
  $right = if ($secondary.Contains($table)) { $secondary[$table] } else { $null }
  if ($left -ne $right) {
    $differences += [pscustomobject]@{
      table = $table
      source = $left
      target = $right
      note = if ($null -eq $left) { "missing from ${Database}" }
             elseif ($null -eq $right) { "missing from ${CompareDatabase}" }
             else { "row counts differ" }
    }
  }
}

if ($differences.Count -gt 0) {
  Write-Host ""
  Write-Host "MISMATCH between ${Database} and ${CompareDatabase}:" -ForegroundColor Red
  Write-Host ("  {0,-40} {1,12} {2,12}" -f "table", $Database, $CompareDatabase)
  foreach ($d in $differences) {
    $left = if ($null -eq $d.source) { "-" } else { $d.source }
    $right = if ($null -eq $d.target) { "-" } else { $d.target }
    Write-Host ("  {0,-40} {1,12} {2,12}   {3}" -f $d.table, $left, $right, $d.note)
  }
  throw "$($differences.Count) table(s) differ. Do not treat this restore as verified."
}

Write-Host "All $($primary.Count) tables match between $Database and $CompareDatabase."
[pscustomobject]@{
  database = $Database
  comparedWith = $CompareDatabase
  tablesCompared = $primary.Count
  identical = $true
  checkedAt = (Get-Date).ToString("s")
} | ConvertTo-Json
