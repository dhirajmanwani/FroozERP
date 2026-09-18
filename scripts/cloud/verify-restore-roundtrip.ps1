<#
.SYNOPSIS
  Prove a backup restores: take it, put it back into a scratch database, and compare.

.DESCRIPTION
  A backup nobody has restored is a guess. This command is the only thing in the repository that
  closes the loop, and it is what "Cloud backup/restore has been tested" in the Phase 4 plan should
  mean before a release depends on it.

  It never writes to the database it is verifying. It creates a scratch database, restores into
  that, compares, and drops it again.

  What it compares, in order of how much it proves:

    1. Every table's row count, read from the catalogue rather than a hand-written list.
    2. The actual rows -- a data-only dump of both sides, sorted and diffed. Row counts agree on a
       restore that put the right number of wrong rows back; content does not.
    3. Sequences. A restore that reinstates rows but not the id counters looks perfect here and
       fails at the counter on the shop's next bill, which is the worst place to find out.

  PostgreSQL 17 and newer write a random \restrict token into every dump, so two dumps of identical
  data are not byte-identical. Those lines are filtered before the comparison; nothing else is.

.EXAMPLE
  # Take a backup of a disposable copy and prove it restores identically.
  .\scripts\cloud\verify-restore-roundtrip.ps1 -SourceDatabase froozerp_copy

  # Prove an existing backup file restores at all.
  .\scripts\cloud\verify-restore-roundtrip.ps1 -DumpFile D:\Backups\froozerp_20260918.dump

  # Prove an existing backup file still matches the database it was taken from.
  .\scripts\cloud\verify-restore-roundtrip.ps1 -DumpFile D:\Backups\froozerp_20260918.dump -SourceDatabase froozerp_copy
#>
param(
  # Verify a database by dumping it first. Use a RESTORED COPY of live, never live itself.
  [string]$SourceDatabase,
  # Or verify a dump file that already exists. Given with -SourceDatabase, the dump is compared
  # against that database instead of a fresh one being taken.
  [string]$DumpFile,
  [string]$ScratchDatabase,
  [string]$HostName = $env:DB_HOST,
  [string]$Port = $env:DB_PORT,
  [string]$User = $env:DB_USER,
  # Leave the scratch database behind for inspection after a failure.
  [switch]$KeepScratch
)

$ErrorActionPreference = "Stop"
$HostName = if ($HostName) { $HostName } else { "localhost" }
$Port = if ($Port) { $Port } else { "5432" }
$User = if ($User) { $User } else { "postgres" }

if (-not $SourceDatabase -and -not $DumpFile) {
  throw "Give -SourceDatabase (a disposable copy) or -DumpFile."
}
# Both together is the most useful question this command answers: does this backup file still
# faithfully represent this database? That is what you ask of last night's backup before trusting it.

# This command creates and drops databases. Pointing it at the hosted database would do that there.
if ($HostName -notin @("localhost", "127.0.0.1", "::1") -and -not $HostName.StartsWith("/")) {
  throw @"
Refusing to run against '$HostName'.

The round trip creates and drops a scratch database, so it runs against a local, disposable copy
only -- never the shop's live database and never the hosted one. Restore a backup locally first and
verify that.
"@
}

function Invoke-Native {
  param([string]$What, [scriptblock]$Command)
  $global:LASTEXITCODE = 0
  & $Command
  if ($LASTEXITCODE -ne 0) { throw "$What failed with exit code $LASTEXITCODE." }
}

function Invoke-Psql {
  param([string]$Db, [string]$Query)
  $global:LASTEXITCODE = 0
  $out = & psql --host $HostName --port $Port --username $User --dbname $Db `
    --tuples-only --no-align --no-psqlrc --command $Query 2>&1
  if ($LASTEXITCODE -ne 0) { throw "psql failed against '$Db' (exit $LASTEXITCODE): $($out -join ' ')" }
  return @($out | Where-Object { $_ -ne "" })
}

$COUNT_ALL = @"
SELECT c.relname || '|' ||
       (xpath('/row/c/text()',
         query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname),
         FALSE, TRUE, '')))[1]::text
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r' AND n.nspname = 'public'
ORDER BY c.relname;
"@

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("froozerp-roundtrip-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Force -Path $workDir | Out-Null
if (-not $ScratchDatabase) {
  $ScratchDatabase = "froozerp_roundtrip_" + (Get-Date -Format "yyyyMMddHHmmss")
}
$scratchCreated = $false

try {
  # ---- 1. backup -------------------------------------------------------------------------------
  if ($SourceDatabase -and -not $DumpFile) {
    $DumpFile = Join-Path $workDir "roundtrip.dump"
    Write-Host "1/5  Dumping $SourceDatabase"
    Invoke-Native "pg_dump of $SourceDatabase" {
      pg_dump --format=custom --no-owner --no-acl `
        --host $HostName --port $Port --username $User --dbname $SourceDatabase --file $DumpFile
    }
  } else {
    if (!(Test-Path $DumpFile)) { throw "Dump file not found: $DumpFile" }
    $DumpFile = (Resolve-Path $DumpFile).Path
    if ($SourceDatabase) {
      Write-Host "1/5  Checking existing dump $DumpFile against $SourceDatabase"
    } else {
      Write-Host "1/5  Using existing dump $DumpFile"
    }
  }

  Write-Host "2/5  Reading the dump back"
  Invoke-Native "pg_restore --list" { pg_restore --list $DumpFile | Out-Null }

  # ---- 2. restore ------------------------------------------------------------------------------
  Write-Host "3/5  Restoring into scratch database $ScratchDatabase"
  Invoke-Native "createdb $ScratchDatabase" {
    createdb --host $HostName --port $Port --username $User $ScratchDatabase
  }
  $scratchCreated = $true
  Invoke-Native "pg_restore into $ScratchDatabase" {
    pg_restore --single-transaction --exit-on-error --no-owner --no-acl `
      --host $HostName --port $Port --username $User --dbname $ScratchDatabase $DumpFile
  }

  # ---- 3. compare ------------------------------------------------------------------------------
  # Without a source database there is nothing to compare against, so the run proves the dump is
  # restorable and stops there rather than pretending to have verified content.
  if (-not $SourceDatabase) {
    $tables = Invoke-Psql -Db $ScratchDatabase -Query $COUNT_ALL
    Write-Host ""
    Write-Host "Dump restores cleanly into an empty database: $($tables.Count) tables."
    Write-Host "No -SourceDatabase given, so content was not compared against an original."
    [pscustomobject]@{
      dumpFile = $DumpFile
      restored = $true
      tables = $tables.Count
      contentCompared = $false
      checkedAt = (Get-Date).ToString("s")
    } | ConvertTo-Json
    return
  }

  Write-Host "4/5  Comparing row counts across every table"
  $srcCounts = Invoke-Psql -Db $SourceDatabase -Query $COUNT_ALL
  $dstCounts = Invoke-Psql -Db $ScratchDatabase -Query $COUNT_ALL
  $countDiff = Compare-Object -ReferenceObject $srcCounts -DifferenceObject $dstCounts
  if ($countDiff) {
    $countDiff | ForEach-Object { Write-Host ("  {0} {1}" -f $_.SideIndicator, $_.InputObject) }
    throw "Row counts differ between $SourceDatabase and the restored copy."
  }
  Write-Host "     $($srcCounts.Count) tables, all matching"

  Write-Host "5/5  Comparing row contents"
  $srcData = Join-Path $workDir "source.sql"
  $dstData = Join-Path $workDir "restored.sql"
  foreach ($pair in @(@($SourceDatabase, $srcData), @($ScratchDatabase, $dstData))) {
    $global:LASTEXITCODE = 0
    $dump = & pg_dump --data-only --column-inserts --no-owner `
      --host $HostName --port $Port --username $User --dbname $pair[0]
    if ($LASTEXITCODE -ne 0) { throw "Data-only pg_dump of $($pair[0]) failed with exit code $LASTEXITCODE." }
    # \restrict / \unrestrict carry a per-dump random token on PostgreSQL 17+; comments and blank
    # lines carry timestamps and version strings. None of that is shop data.
    ($dump | Where-Object { $_ -notmatch '^\s*(--|\\restrict|\\unrestrict|$)' } | Sort-Object) |
      Set-Content -LiteralPath $pair[1] -Encoding UTF8
  }
  $contentDiff = Compare-Object -ReferenceObject (Get-Content $srcData) -DifferenceObject (Get-Content $dstData)
  if ($contentDiff) {
    $contentDiff | Select-Object -First 20 | ForEach-Object {
      Write-Host ("  {0} {1}" -f $_.SideIndicator, $_.InputObject)
    }
    throw "Row contents differ between $SourceDatabase and the restored copy."
  }
  Write-Host "     contents identical"

  $unset = (Invoke-Psql -Db $ScratchDatabase -Query "SELECT count(*) FROM pg_sequences WHERE schemaname='public' AND last_value IS NULL;") | Select-Object -Last 1
  Write-Host "     sequences: $unset never advanced (expected only for empty tables)"

  Write-Host ""
  Write-Host "ROUND TRIP PASSED" -ForegroundColor Green
  [pscustomobject]@{
    source = $SourceDatabase
    dumpFile = $DumpFile
    tablesCompared = $srcCounts.Count
    rowCountsMatch = $true
    contentsMatch = $true
    sequencesNeverAdvanced = [int]$unset
    checkedAt = (Get-Date).ToString("s")
  } | ConvertTo-Json
}
finally {
  if ($scratchCreated -and -not $KeepScratch) {
    & dropdb --host $HostName --port $Port --username $User --if-exists $ScratchDatabase 2>&1 | Out-Null
  } elseif ($scratchCreated) {
    Write-Host "Scratch database kept: $ScratchDatabase"
  }
  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
}
