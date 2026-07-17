param(
    [string]$AppPath = "F:\FroozERP\froozerp.exe",
    [string]$EvidenceRoot = "",
    [int]$StartsPerMode = 10,
    [int]$ObserveSeconds = 30
)

$ErrorActionPreference = "Stop"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$PSCommandPath,"-AppPath",$AppPath,"-EvidenceRoot",$EvidenceRoot,"-StartsPerMode",$StartsPerMode,"-ObserveSeconds",$ObserveSeconds) | Out-Null
    exit 0
}

if (-not $EvidenceRoot) { $EvidenceRoot = Join-Path (Get-Location) ".cache\phase4-cold-start-evidence" }
$runRoot = Join-Path $EvidenceRoot (Get-Date -Format "yyyyMMdd-HHmmss")
$null = New-Item -ItemType Directory -Force -Path $runRoot
$controlPath = Join-Path $runRoot "wifi-recovery-control.txt"
$transitionLog = Join-Path $env:APPDATA "com.srtcompany.froozerp\logs\froozerp-startup-transitions.jsonl"
$results = [System.Collections.Generic.List[object]]::new()
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

function Write-Control([string]$value) { Set-Content -LiteralPath $controlPath -Value $value }
function Capture-Frame([string]$dir, [int]$index) {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
    $path = Join-Path $dir ("frame-{0:D5}.jpg" -f $index)
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Jpeg)
    $graphics.Dispose(); $bitmap.Dispose()
    return $path
}
function Has-FatalFrame([string]$path) {
    $bitmap = [System.Drawing.Bitmap]::FromFile($path)
    $found = $false
    for ($x = 0; $x -lt $bitmap.Width -and -not $found; $x += 20) {
        for ($y = 0; $y -lt $bitmap.Height; $y += 20) {
            $pixel = $bitmap.GetPixel($x, $y)
            if ($pixel.R -gt 100 -and $pixel.G -lt 30 -and $pixel.B -lt 30) { $found = $true; break }
        }
    }
    $bitmap.Dispose()
    return $found
}
function Probe-Local {
    $paths = @("/api/health", "/products", "/inventory", "/customers", "/sales", "/purchases", "/accounts", "/settings")
    $probe = @{}
    foreach ($path in $paths) {
        try { $probe[$path] = [int](Invoke-WebRequest -UseBasicParsing -Uri ("http://127.0.0.1:5000" + $path) -TimeoutSec 4).StatusCode }
        catch { $probe[$path] = "FAIL" }
    }
    return $probe
}
function Run-ColdStart([string]$mode, [int]$iteration, [bool]$offline) {
    Get-Process -Name "froozerp" -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Name "froozerp-backend-node" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    $captureDir = Join-Path $runRoot "$mode-$iteration"
    $null = New-Item -ItemType Directory -Force -Path $captureDir
    $process = Start-Process -FilePath $AppPath -PassThru
    $frames = 0; $fatalFrames = 0; $deadline = [DateTimeOffset]::UtcNow.AddSeconds($ObserveSeconds)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        if ($offline) { Write-Control ("DEADLINE={0}" -f [DateTimeOffset]::UtcNow.AddSeconds(80).ToUnixTimeMilliseconds()) }
        if (Has-FatalFrame (Capture-Frame $captureDir $frames)) { $fatalFrames++ }
        $frames++; Start-Sleep -Milliseconds 250
    }
    $fatalTransitions = if (Test-Path $transitionLog) { @((Get-Content $transitionLog | Select-String "fatal-local-runtime")).Count } else { 0 }
    $health = $null; try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:5000/api/health" -TimeoutSec 5 } catch {}
    $owners = @(Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    $results.Add([pscustomobject]@{ mode=$mode; iteration=$iteration; offline=$offline; frames=$frames; fatal_pixel_frames=$fatalFrames; fatal_transition_count=$fatalTransitions; desktop_running=[bool](Get-Process -Id $process.Id -ErrorAction SilentlyContinue); backend_count=@(Get-Process -Name "froozerp-backend-node" -ErrorAction SilentlyContinue).Count; port_5000_owners=$owners; local_health=$health; probes=(Probe-Local); capture_dir=$captureDir })
}

$wifi = Get-NetAdapter | Where-Object { $_.Status -eq "Up" -and ($_.MediaType -eq "Native 802.11" -or $_.Name -match "Wi-?Fi|Wireless" -or $_.InterfaceDescription -match "Wi-?Fi|Wireless|802\.11") } | Select-Object -First 1
if (-not $wifi) { throw "No active Wi-Fi adapter was found." }
$watchdogScript = Join-Path (Get-Location) "scripts\phase4-wifi-recovery.ps1"
$watchdog = Start-Process powershell.exe -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$watchdogScript,"-AdapterName",$wifi.Name,"-ControlPath",$controlPath) -WindowStyle Hidden -PassThru
Write-Control ("DEADLINE={0}" -f [DateTimeOffset]::UtcNow.AddSeconds(80).ToUnixTimeMilliseconds())
if ($watchdog.HasExited) { throw "Wi-Fi recovery watchdog exited before the adapter test began." }
try {
    Get-Process -Name "froozerp" -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-Process -Name "froozerp-backend-node" -ErrorAction SilentlyContinue | Stop-Process -Force
    Disable-NetAdapter -Name $wifi.Name -Confirm:$false
    Set-Content -LiteralPath (Join-Path $runRoot "offline-adapter.txt") -Value $wifi.Name
    for ($i=1; $i -le $StartsPerMode; $i++) { Run-ColdStart "offline" $i $true }
    Enable-NetAdapter -Name $wifi.Name -Confirm:$false
    Start-Sleep -Seconds 20
    for ($i=1; $i -le $StartsPerMode; $i++) { Run-ColdStart "online" $i $false }
}
finally {
    try { Enable-NetAdapter -Name $wifi.Name -Confirm:$false } catch {}
    Write-Control "STOP"
    Get-Process -Id $watchdog.Id -ErrorAction SilentlyContinue | Stop-Process -Force
    $results | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $runRoot "results.json")
    [pscustomobject]@{ run_root=$runRoot; adapter=$wifi.Name; watchdog_pid=$watchdog.Id; starts=$results.Count; fatal_pixel_frames=@($results|Measure-Object fatal_pixel_frames -Sum).Sum; fatal_transition_max=@($results|Measure-Object fatal_transition_count -Maximum).Maximum } | ConvertTo-Json
}
