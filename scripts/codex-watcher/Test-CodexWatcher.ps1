[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexWatcher.psm1') -Force

$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-watcher-tests-' + [guid]::NewGuid().ToString('N'))
$sessionRoot = Join-Path $testRoot 'sessions\2026\07\15'
$dataRoot = Join-Path $testRoot 'data'
$logPath = Join-Path $dataRoot 'watcher.log'
New-Item -ItemType Directory -Path $sessionRoot -Force | Out-Null

function Add-JsonLine {
    param([string]$Path, [hashtable]$Value)
    Add-Content -LiteralPath $Path -Encoding UTF8 -Value ($Value | ConvertTo-Json -Compress -Depth 8)
}

function New-Fixture {
    param([string]$Name)
    $path = Join-Path $sessionRoot "rollout-$Name.jsonl"
    Add-JsonLine $path @{ type='session_meta'; payload=@{ cwd=$testRoot; type='session_meta' } }
    return $path
}

$results = New-Object System.Collections.Generic.List[object]
try {
    foreach ($case in @('completion','failure','attention')) {
        Get-ChildItem -LiteralPath $sessionRoot -File -ErrorAction SilentlyContinue | Remove-Item -Force
        $path = New-Fixture -Name $case
        $state = New-CodexWatcherState
        $null = Invoke-CodexWatcherPoll -ProjectPath $testRoot -State $state -LogPath $logPath -SessionRoot (Join-Path $testRoot 'sessions') -ProcessRunningOverride $true -ProjectStampOverride 'p1' -TerminalStampOverride 't1' -NoSend
        Add-JsonLine $path @{ type='event_msg'; payload=@{ type='task_started'; turn_id="turn-$case" } }
        if ($case -eq 'completion') {
            Add-JsonLine $path @{ type='event_msg'; payload=@{ type='task_complete'; turn_id="turn-$case"; last_agent_message='Completed successfully.' } }
            $expected = 'Complete'
        } elseif ($case -eq 'failure') {
            Add-JsonLine $path @{ type='event_msg'; payload=@{ type='task_complete'; turn_id="turn-$case"; last_agent_message='Failed: simulated test failure.' } }
            $expected = 'Failed'
        } else {
            Add-JsonLine $path @{ type='response_item'; payload=@{ type='function_call'; name='shell_command'; arguments='{ "sandbox_permissions": "require_escalated" }' } }
            $expected = 'Attention'
        }
        $events = @(Invoke-CodexWatcherPoll -ProjectPath $testRoot -State $state -LogPath $logPath -SessionRoot (Join-Path $testRoot 'sessions') -ProcessRunningOverride $true -ProjectStampOverride 'p1' -TerminalStampOverride 't1' -NoSend)
        $passed = [bool](@($events | Where-Object { $_.State -eq $expected }).Count -gt 0)
        $results.Add([pscustomobject]@{ Test=$case; Expected=$expected; Passed=$passed })
    }

    Get-ChildItem -LiteralPath $sessionRoot -File -ErrorAction SilentlyContinue | Remove-Item -Force
    $path = New-Fixture -Name 'stuck-recovery'
    $state = New-CodexWatcherState
    $null = Invoke-CodexWatcherPoll -ProjectPath $testRoot -State $state -LogPath $logPath -SessionRoot (Join-Path $testRoot 'sessions') -ProcessRunningOverride $true -ProjectStampOverride 'p1' -TerminalStampOverride 't1' -NoSend
    Add-JsonLine $path @{ type='event_msg'; payload=@{ type='task_started'; turn_id='turn-stuck' } }
    $null = Invoke-CodexWatcherPoll -ProjectPath $testRoot -State $state -LogPath $logPath -SessionRoot (Join-Path $testRoot 'sessions') -ProcessRunningOverride $true -ProjectStampOverride 'p1' -TerminalStampOverride 't1' -NoSend
    $state.LastActivityUtc = [DateTime]::UtcNow.AddMinutes(-16).ToString('o')
    $events = @(Invoke-CodexWatcherPoll -ProjectPath $testRoot -State $state -LogPath $logPath -StuckMinutes 15 -SessionRoot (Join-Path $testRoot 'sessions') -ProcessRunningOverride $true -ProjectStampOverride 'p1' -TerminalStampOverride 't1' -NoSend)
    $firstStuck = [bool](@($events | Where-Object { $_.State -eq 'Stuck' }).Count -gt 0)
    $duplicateEvents = @(Invoke-CodexWatcherPoll -ProjectPath $testRoot -State $state -LogPath $logPath -StuckMinutes 15 -SessionRoot (Join-Path $testRoot 'sessions') -ProcessRunningOverride $true -ProjectStampOverride 'p1' -TerminalStampOverride 't1' -NoSend)
    $deduplicated = [bool](@($duplicateEvents | Where-Object { $_.State -eq 'Stuck' }).Count -eq 0)
    Add-JsonLine $path @{ type='event_msg'; payload=@{ type='token_count'; info=@{} } }
    $recoveryEvents = @(Invoke-CodexWatcherPoll -ProjectPath $testRoot -State $state -LogPath $logPath -StuckMinutes 15 -SessionRoot (Join-Path $testRoot 'sessions') -ProcessRunningOverride $true -ProjectStampOverride 'p1' -TerminalStampOverride 't2' -NoSend)
    $recovered = [bool](@($recoveryEvents | Where-Object { $_.State -eq 'Recovered' }).Count -gt 0)
    $results.Add([pscustomobject]@{ Test='stuck'; Expected='Stuck'; Passed=$firstStuck })
    $results.Add([pscustomobject]@{ Test='stuck-deduplication'; Expected='No duplicate'; Passed=$deduplicated })
    $results.Add([pscustomobject]@{ Test='recovery'; Expected='Recovered'; Passed=$recovered })

    $safeText = New-SafeNotificationText -State 'Test' -ProjectPath $testRoot -LastActivityUtc ([DateTime]::UtcNow) -Diagnostic 'Safe fixture diagnostic.'
    $safePassed = $safeText -notmatch '(?i)token|password|secret|customer|database'
    $results.Add([pscustomobject]@{ Test='safe-payload'; Expected='No sensitive categories'; Passed=$safePassed })

    $results | Format-Table -AutoSize
    if ($results.Passed -contains $false) { throw 'One or more Codex Watcher tests failed.' }
    Write-Output 'ALL TESTS PASSED'
} finally {
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot -Recurse -Force }
}
