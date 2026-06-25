param(
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

$tables = @(
  "users",
  "branches",
  "counters",
  "authorized_devices",
  "product_categories",
  "products",
  "inventory_batches",
  "sales",
  "sale_items",
  "sale_payments",
  "purchases",
  "purchase_items",
  "suppliers",
  "customers",
  "expenses",
  "sync_processed_operations",
  "sync_change_log"
)

$results = foreach ($table in $tables) {
  $query = "SELECT '$table' AS table_name, COUNT(*) AS row_count FROM $table;"
  try {
    $output = psql --host $HostName --port $Port --username $User --dbname $Database --tuples-only --no-align --command $query
    $parts = $output -split "\|"
    [pscustomobject]@{ table = $parts[0]; rowCount = [int]$parts[1]; status = "ok" }
  } catch {
    [pscustomobject]@{ table = $table; rowCount = $null; status = "failed"; error = $_.Exception.Message }
  }
}

$results | ConvertTo-Json
