[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ProjectPath,
    [int]$PollSeconds = 20,
    [int]$StuckMinutes = 15,
    [string]$DataRoot,
    [switch]$Once,
    [switch]$NoSend
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexWatcher.psm1') -Force

if (-not (Test-Path -LiteralPath $ProjectPath -PathType Container)) { throw "Project path does not exist: $ProjectPath" }
if (-not $DataRoot) { $DataRoot = Get-CodexWatcherDataRoot }
$paths = Get-CodexWatcherPaths -DataRoot $DataRoot
$state = Read-CodexWatcherState -Path $paths.StatePath
Write-CodexWatcherLog -LogPath $paths.LogPath -Level INFO -Message "Watcher started pid=$PID project=$ProjectPath pollSeconds=$PollSeconds stuckMinutes=$StuckMinutes"

do {
    try {
        $null = Invoke-CodexWatcherPoll -ProjectPath $ProjectPath -State $state -LogPath $paths.LogPath -StuckMinutes $StuckMinutes -NoSend:$NoSend
        Save-CodexWatcherState -State $state -Path $paths.StatePath
    } catch {
        $state.LastError = $_.Exception.Message
        Write-CodexWatcherLog -LogPath $paths.LogPath -Level ERROR -Message "Poll failed: $($_.Exception.Message)"
        try { Save-CodexWatcherState -State $state -Path $paths.StatePath } catch {}
    }
    if (-not $Once) { Start-Sleep -Seconds $PollSeconds }
} while (-not $Once)

