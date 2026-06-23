$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $root "release\windows"
$archiveDir = Join-Path $root "release\archive\windows"
$bundleDir = Join-Path $root "src-tauri\target\release\bundle"

New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
New-Item -ItemType Directory -Force -Path $archiveDir | Out-Null

$tauriConfigPath = Join-Path $root "src-tauri\tauri.conf.json"
$tauriConfig = Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json
$version = $tauriConfig.version
$installer = Get-ChildItem -Path $bundleDir -Recurse -File -Include "*.exe" |
  Where-Object { $_.Name -match "FroozERP|froozerp|setup|Setup" } |
  Sort-Object @{ Expression = { $_.Name -like "*$version*" }; Descending = $true }, LastWriteTime -Descending |
  Select-Object -First 1

if (-not $installer) {
  throw "No Windows installer artifact was found under $bundleDir. Run npm run build:windows first."
}

$target = Join-Path $releaseDir "FroozERP-Setup-$version.exe"
Copy-Item -LiteralPath $installer.FullName -Destination $target -Force

$archivedReleaseInstallers = @()
Get-ChildItem -LiteralPath $releaseDir -File -Filter "FroozERP-Setup-*.exe" |
  Where-Object { $_.FullName -ne $target } |
  ForEach-Object {
    $destination = Join-Path $archiveDir $_.Name
    Move-Item -LiteralPath $_.FullName -Destination $destination -Force
    $archivedReleaseInstallers += $destination
  }

[pscustomobject]@{
  source = $installer.FullName
  target = $target
  archivedReleaseInstallers = $archivedReleaseInstallers
  signed = $false
  note = "Unsigned internal-test installer. Production release requires code signing."
} | ConvertTo-Json
