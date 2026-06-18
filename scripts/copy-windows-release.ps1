$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root "release\windows"
$bundleDir = Join-Path $root "src-tauri\target\release\bundle"

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null

$installer = Get-ChildItem -Path $bundleDir -Recurse -File -Include "*.exe" |
  Where-Object { $_.Name -match "FroozERP|froozerp|setup|Setup" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $installer) {
  throw "No Windows installer artifact was found under $bundleDir. Run npm run build:windows first."
}

$tauriConfigPath = Join-Path $root "src-tauri\tauri.conf.json"
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
$version = $tauriConfig.version
$target = Join-Path $releaseDir "FroozERP-Setup-$version.exe"
Copy-Item -LiteralPath $installer.FullName -Destination $target -Force

[pscustomobject]@{
  source = $installer.FullName
  target = $target
  signed = $false
  note = "Unsigned internal-test installer. Production release requires code signing."
} | ConvertTo-Json
