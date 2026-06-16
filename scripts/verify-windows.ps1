$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $cargoBin) {
  $env:PATH = "$cargoBin;$env:PATH"
}

Push-Location $root
try {
  node --check backend\server.js
  npm --prefix frontend run build

  Push-Location (Join-Path $root "src-tauri")
  try {
    cargo check
    cargo test
  } finally {
    Pop-Location
  }

  npm --prefix frontend exec tauri -- info | Out-Host
} finally {
  Pop-Location
}
