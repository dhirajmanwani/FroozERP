[CmdletBinding()]
param(
    [Parameter(Mandatory, Position=0)]
    [ValidateSet('Install','SendTestNotification','Pause','Resume','Uninstall','Status','RunOnce')]
    [string]$Command,
    [string]$ProjectPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$TaskName = 'Codex Watcher - FroozERP',
    [switch]$KeepData
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'CodexWatcher.psm1') -Force
$dataRoot = Get-CodexWatcherDataRoot
$installRoot = Join-Path $dataRoot 'app'
$paths = Get-CodexWatcherPaths -DataRoot $dataRoot

function Assert-TelegramConfiguration {
    $token = [Environment]::GetEnvironmentVariable('CODEX_WATCHER_TELEGRAM_BOT_TOKEN', 'User')
    $chat = [Environment]::GetEnvironmentVariable('CODEX_WATCHER_TELEGRAM_CHAT_ID', 'User')
    if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($chat)) {
        throw 'Set both CODEX_WATCHER_TELEGRAM_BOT_TOKEN and CODEX_WATCHER_TELEGRAM_CHAT_ID as user-level environment variables first.'
    }
}

switch ($Command) {
    'Install' {
        Assert-TelegramConfiguration
        if (-not (Test-Path -LiteralPath $installRoot)) { New-Item -ItemType Directory -Path $installRoot -Force | Out-Null }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'CodexWatcher.ps1') -Destination $installRoot -Force
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'CodexWatcher.psm1') -Destination $installRoot -Force
        $watcher = Join-Path $installRoot 'CodexWatcher.ps1'
        $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ProjectPath "{1}"' -f $watcher,$ProjectPath
        $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
        $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
        $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'User-level Telegram notifications for active Codex task state.' -Force | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        Write-Output "Installed and started scheduled task: $TaskName"
    }
    'SendTestNotification' {
        Assert-TelegramConfiguration
        $text = New-SafeNotificationText -State 'Test' -ProjectPath $ProjectPath -LastActivityUtc ([DateTime]::UtcNow) -Diagnostic 'User-requested Codex Watcher test; no task or business content included.'
        $null = Send-TelegramNotification -Text $text
        Write-Output 'Telegram test notification sent successfully.'
    }
    'Pause' {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Disable-ScheduledTask -TaskName $TaskName | Out-Null
        Write-Output "Paused scheduled task: $TaskName"
    }
    'Resume' {
        Enable-ScheduledTask -TaskName $TaskName | Out-Null
        Start-ScheduledTask -TaskName $TaskName
        Write-Output "Resumed scheduled task: $TaskName"
    }
    'Uninstall' {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        if (-not $KeepData -and (Test-Path -LiteralPath $dataRoot)) { Remove-Item -LiteralPath $dataRoot -Recurse -Force }
        Write-Output "Uninstalled scheduled task: $TaskName"
    }
    'Status' {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        $info = if ($task) { Get-ScheduledTaskInfo -TaskName $TaskName } else { $null }
        $state = Read-CodexWatcherState -Path $paths.StatePath
        [pscustomobject]@{
            TaskName = $TaskName
            Installed = [bool]($null -ne $task)
            SchedulerState = if ($task) { [string]$task.State } else { 'NotInstalled' }
            LastTaskResult = if ($info) { $info.LastTaskResult } else { $null }
            WatcherState = $state.LastState
            LastActivityUtc = $state.LastActivityUtc
            LastPollUtc = $state.LastPollUtc
            ActiveTask = $state.ActiveTask
            SessionPath = $state.SessionPath
            LogPath = $paths.LogPath
            TelegramConfigured = [bool](-not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('CODEX_WATCHER_TELEGRAM_BOT_TOKEN','User')) -and -not [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable('CODEX_WATCHER_TELEGRAM_CHAT_ID','User')))
            LastError = $state.LastError
        } | Format-List
    }
    'RunOnce' {
        & (Join-Path $PSScriptRoot 'CodexWatcher.ps1') -ProjectPath $ProjectPath -Once
    }
}

