Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

function Get-CodexWatcherDataRoot {
    Join-Path $env:LOCALAPPDATA 'CodexWatcher'
}

function Get-CodexWatcherPaths {
    param([string]$DataRoot = (Get-CodexWatcherDataRoot))

    [pscustomobject]@{
        DataRoot  = $DataRoot
        StatePath = Join-Path $DataRoot 'state.json'
        LogPath   = Join-Path $DataRoot 'watcher.log'
    }
}

function ConvertTo-Hashtable {
    param($InputObject)
    if ($null -eq $InputObject) { return $null }
    if ($InputObject -is [System.Collections.IDictionary]) {
        $result = @{}
        foreach ($key in $InputObject.Keys) { $result[$key] = ConvertTo-Hashtable $InputObject[$key] }
        return $result
    }
    if ($InputObject -is [pscustomobject]) {
        $result = @{}
        foreach ($property in $InputObject.PSObject.Properties) {
            $result[$property.Name] = ConvertTo-Hashtable $property.Value
        }
        return $result
    }
    if (($InputObject -is [System.Collections.IEnumerable]) -and -not ($InputObject -is [string])) {
        return @($InputObject | ForEach-Object { ConvertTo-Hashtable $_ })
    }
    return $InputObject
}

function New-CodexWatcherState {
    @{
        Version             = 1
        SessionPath         = ''
        SessionOffset       = 0
        ActiveTurnId        = ''
        ActiveTask          = $false
        LastActivityUtc     = [DateTime]::UtcNow.ToString('o')
        LastProjectStampUtc = ''
        LastTerminalStamp   = ''
        LastState           = 'Idle'
        StuckEpisode        = 0
        IsStuck             = $false
        Notifications       = @{}
        LastNotificationUtc = ''
        LastError           = ''
        LastPollUtc         = ''
        WatcherPid          = $PID
    }
}

function Read-CodexWatcherState {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return New-CodexWatcherState }
    try {
        $state = ConvertTo-Hashtable (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json)
        $defaults = New-CodexWatcherState
        foreach ($key in $defaults.Keys) {
            if (-not $state.ContainsKey($key)) { $state[$key] = $defaults[$key] }
        }
        if (-not ($state.Notifications -is [hashtable])) { $state.Notifications = @{} }
        return $state
    } catch {
        return New-CodexWatcherState
    }
}

function Save-CodexWatcherState {
    param([Parameter(Mandatory)][hashtable]$State, [Parameter(Mandatory)][string]$Path)
    if ($State.Notifications.Count -gt 500) {
        $retained = @{}
        $State.Notifications.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 500 | ForEach-Object { $retained[$_.Key] = $_.Value }
        $State.Notifications = $retained
    }
    $directory = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    $temporary = "$Path.tmp"
    $State | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Write-CodexWatcherLog {
    param(
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][ValidateSet('INFO','WARN','ERROR')][string]$Level,
        [Parameter(Mandatory)][string]$Message,
        [int]$MaxBytes = 1048576,
        [int]$Keep = 5
    )
    $directory = Split-Path -Parent $LogPath
    if (-not (Test-Path -LiteralPath $directory)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
    if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -ge $MaxBytes) {
        for ($index = $Keep - 1; $index -ge 1; $index--) {
            $source = "$LogPath.$index"
            $destination = "$LogPath.$($index + 1)"
            if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination $destination -Force }
        }
        Move-Item -LiteralPath $LogPath -Destination "$LogPath.1" -Force
    }
    $safeMessage = $Message -replace '[\r\n]+', ' ' -replace '(?i)(token|password|secret|authorization)\s*[:=]\s*\S+', '$1=[REDACTED]'
    Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ('{0} [{1}] {2}' -f [DateTime]::UtcNow.ToString('o'), $Level, $safeMessage)
}

function Get-CodexSessionRoot {
    Join-Path $env:USERPROFILE '.codex\sessions'
}

function Get-SessionCwd {
    param([Parameter(Mandatory)][string]$Path)
    try {
        $stream = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
        try {
            $reader = New-Object System.IO.StreamReader($stream)
            try {
                for ($index = 0; $index -lt 5 -and -not $reader.EndOfStream; $index++) {
                    $line = $reader.ReadLine()
                    $entry = $line | ConvertFrom-Json
                    if ($entry.type -eq 'session_meta' -and $entry.payload.cwd) { return [string]$entry.payload.cwd }
                }
            } finally { $reader.Dispose() }
        } finally { $stream.Dispose() }
    } catch {}
    return ''
}

function Find-ActiveCodexSession {
    param([Parameter(Mandatory)][string]$ProjectPath, [string]$SessionRoot = (Get-CodexSessionRoot))
    if (-not (Test-Path -LiteralPath $SessionRoot)) { return $null }
    $normalizedProject = [System.IO.Path]::GetFullPath($ProjectPath).TrimEnd('\')
    $recent = Get-ChildItem -LiteralPath $SessionRoot -Filter 'rollout-*.jsonl' -File -Recurse -Depth 4 -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 20
    foreach ($file in $recent) {
        $cwd = Get-SessionCwd -Path $file.FullName
        if ($cwd -and ([System.IO.Path]::GetFullPath($cwd).TrimEnd('\') -ieq $normalizedProject)) { return $file }
    }
    return $null
}

function Get-JsonlTailLines {
    param([Parameter(Mandatory)][string]$Path, [int]$MaxBytes = 4194304)
    $stream = [System.IO.File]::Open($Path, 'Open', 'Read', 'ReadWrite')
    try {
        $start = [Math]::Max(0, $stream.Length - $MaxBytes)
        $null = $stream.Seek($start, [System.IO.SeekOrigin]::Begin)
        $reader = New-Object System.IO.StreamReader($stream)
        try {
            if ($start -gt 0) { $null = $reader.ReadLine() }
            $lines = New-Object System.Collections.Generic.List[string]
            while (-not $reader.EndOfStream) { $lines.Add($reader.ReadLine()) }
            return $lines.ToArray()
        } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Initialize-SessionState {
    param([Parameter(Mandatory)][hashtable]$State, [Parameter(Mandatory)][System.IO.FileInfo]$Session)
    $activeTurns = @{}
    foreach ($line in (Get-JsonlTailLines -Path $Session.FullName)) {
        try {
            $entry = $line | ConvertFrom-Json
            if ($entry.payload.type -eq 'task_started') { $activeTurns[[string]$entry.payload.turn_id] = $true }
            if ($entry.payload.type -in @('task_complete','turn_aborted')) { $activeTurns.Remove([string]$entry.payload.turn_id) }
        } catch {}
    }
    $State.SessionPath = $Session.FullName
    $State.SessionOffset = $Session.Length
    $State.ActiveTurnId = if ($activeTurns.Count -gt 0) { [string]($activeTurns.Keys | Select-Object -Last 1) } else { '' }
    $State.ActiveTask = [bool]($activeTurns.Count -gt 0)
    $State.LastActivityUtc = $Session.LastWriteTimeUtc.ToString('o')
}

function Read-NewSessionLines {
    param([Parameter(Mandatory)][hashtable]$State)
    if (-not $State.SessionPath -or -not (Test-Path -LiteralPath $State.SessionPath)) { return @() }
    $stream = [System.IO.File]::Open($State.SessionPath, 'Open', 'Read', 'ReadWrite')
    try {
        if ([int64]$State.SessionOffset -gt $stream.Length) { $State.SessionOffset = 0 }
        $null = $stream.Seek([int64]$State.SessionOffset, [System.IO.SeekOrigin]::Begin)
        $reader = New-Object System.IO.StreamReader($stream)
        try {
            $lines = New-Object System.Collections.Generic.List[string]
            while (-not $reader.EndOfStream) { $lines.Add($reader.ReadLine()) }
            $State.SessionOffset = $stream.Length
            return $lines.ToArray()
        } finally { $reader.Dispose() }
    } finally { $stream.Dispose() }
}

function Test-FailureSummary {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    return $Text -match '(?is)^\s*(failed|failure|blocked|error\b|unable to complete|could not complete|i could not|i couldn''t)' -or
        $Text -match '(?i)\b(tests? failed|task (?:was )?not completed|build failed|command failed)\b'
}

function Get-EntryAttentionKind {
    param($Entry)
    $payload = $Entry.payload
    if ($null -eq $payload) { return '' }
    $type = [string]$payload.type
    if ($type -match '(?i)approval_request|request_user_input') { return 'manual approval or input' }
    if ($Entry.type -in @('response_item','event_msg')) {
        if ($type -in @('function_call','custom_tool_call')) {
            $name = [string]$payload.name
            $arguments = if ($payload.arguments) { [string]$payload.arguments } elseif ($payload.input) { [string]$payload.input } else { '' }
            if ($name -match '(?i)request_user_input') { return 'manual input' }
            if ($arguments -match '(?i)require_escalated|sandbox_permissions.{0,40}require_escalated') { return 'manual approval or UAC' }
        }
        if ($type -eq 'agent_message') {
            $message = [string]$payload.message
            if ($message -match '(?i)\b(please|you(?:''ll| will)? need to)\b.{0,80}\b(log ?in|sign ?in|authenticate|browser|uac|approve|approval)\b') {
                return 'login or browser interaction'
            }
        }
    }
    return ''
}

function Get-SessionEvents {
    param([Parameter(Mandatory)][hashtable]$State, [Parameter(Mandatory)][string[]]$Lines)
    $events = New-Object System.Collections.Generic.List[object]
    foreach ($line in $Lines) {
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        try { $entry = $line | ConvertFrom-Json } catch { continue }
        $State.LastActivityUtc = [DateTime]::UtcNow.ToString('o')
        $type = [string]$entry.payload.type
        if ($type -eq 'task_started') {
            $State.ActiveTurnId = [string]$entry.payload.turn_id
            $State.ActiveTask = $true
            $State.LastState = 'Active'
            continue
        }
        $attentionKind = Get-EntryAttentionKind -Entry $entry
        if ($attentionKind) {
            $events.Add([pscustomobject]@{ State='Attention'; Diagnostic="Structured task metadata indicates $attentionKind is required."; KeySuffix=$attentionKind })
        }
        if ($type -eq 'turn_aborted') {
            $State.ActiveTask = $false
            $State.LastState = 'Failed'
            $events.Add([pscustomobject]@{ State='Failed'; Diagnostic='The Codex session emitted a structured turn_aborted event.'; KeySuffix=[string]$entry.payload.turn_id })
        }
        if ($type -eq 'task_complete') {
            $State.ActiveTask = $false
            $turnId = [string]$entry.payload.turn_id
            if (Test-FailureSummary -Text ([string]$entry.payload.last_agent_message)) {
                $State.LastState = 'Failed'
                $events.Add([pscustomobject]@{ State='Failed'; Diagnostic='The task completed with a narrow failure indicator in its final status.'; KeySuffix=$turnId })
            } else {
                $State.LastState = 'Complete'
                $events.Add([pscustomobject]@{ State='Complete'; Diagnostic='The Codex session emitted a structured task_complete event.'; KeySuffix=$turnId })
            }
        }
    }
    return $events.ToArray()
}

function Get-ProjectActivityStamp {
    param([Parameter(Mandatory)][string]$ProjectPath)
    $latest = $null
    try {
        $relativePaths = @(& git -C $ProjectPath ls-files -co --exclude-standard 2>$null)
        foreach ($relativePath in $relativePaths) {
            if ($relativePath -match '^(release|backups|release-candidates|scripts/codex-watcher)/') { continue }
            $fullPath = Join-Path $ProjectPath $relativePath
            if (Test-Path -LiteralPath $fullPath -PathType Leaf) {
                $item = Get-Item -LiteralPath $fullPath
                if ($null -eq $latest -or $item.LastWriteTimeUtc -gt $latest.LastWriteTimeUtc) { $latest = $item }
            }
        }
    } catch {
        $latest = Get-ChildItem -LiteralPath $ProjectPath -File -Depth 4 -Recurse -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch '\\(\.git|node_modules|dist|target|release|backups|\.cache|release-candidates|codex-watcher)\\' } |
            Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    }
    $gitPaths = @((Join-Path $ProjectPath '.git\index'), (Join-Path $ProjectPath '.git\HEAD'))
    foreach ($path in $gitPaths) {
        if (Test-Path -LiteralPath $path) {
            $item = Get-Item -LiteralPath $path
            if ($null -eq $latest -or $item.LastWriteTimeUtc -gt $latest.LastWriteTimeUtc) { $latest = $item }
        }
    }
    if ($null -eq $latest) { return '' }
    return $latest.LastWriteTimeUtc.ToString('o')
}

function Get-CodexProcessSnapshot {
    param([Parameter(Mandatory)][string]$ProjectPath)
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
    $codexRoots = @($all | Where-Object { $_.Name -ieq 'codex.exe' -and $_.CommandLine -match '\bapp-server\b' })
    $rootIds = @($codexRoots | ForEach-Object { [int]$_.ProcessId })
    $descendantIds = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($id in $rootIds) { $null = $descendantIds.Add($id) }
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($process in $all) {
            if ($descendantIds.Contains([int]$process.ParentProcessId) -and -not $descendantIds.Contains([int]$process.ProcessId)) {
                $null = $descendantIds.Add([int]$process.ProcessId); $changed = $true
            }
        }
    }
    $projectIds = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($process in $all) {
        if ($descendantIds.Contains([int]$process.ProcessId) -and ([string]$process.CommandLine).IndexOf($ProjectPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            $null = $projectIds.Add([int]$process.ProcessId)
        }
    }
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($process in $all) {
            if ($projectIds.Contains([int]$process.ParentProcessId) -and -not $projectIds.Contains([int]$process.ProcessId)) {
                $null = $projectIds.Add([int]$process.ProcessId); $changed = $true
            }
        }
    }
    $terminalNames = @('powershell.exe','pwsh.exe','cmd.exe','conhost.exe','node.exe','node_repl.exe','codex-command-runner-0.144.2.exe')
    $terminals = @($all | Where-Object {
        ($terminalNames -contains ([string]$_.Name).ToLowerInvariant()) -and
        $projectIds.Contains([int]$_.ProcessId) -and
        ([string]$_.CommandLine).IndexOf('CodexWatcher.ps1', [StringComparison]::OrdinalIgnoreCase) -lt 0
    })
    $stampParts = @($terminals | Sort-Object ProcessId | ForEach-Object {
        '{0}:{1}:{2}:{3}:{4}' -f $_.ProcessId,$_.KernelModeTime,$_.UserModeTime,$_.ReadTransferCount,$_.WriteTransferCount
    })
    [pscustomobject]@{
        Running       = [bool]($codexRoots.Count -gt 0)
        ProcessCount  = $codexRoots.Count
        TerminalCount = $terminals.Count
        TerminalStamp = ($stampParts -join '|')
    }
}

function Get-GitBranchSafe {
    param([Parameter(Mandatory)][string]$ProjectPath)
    try {
        $branch = (& git -C $ProjectPath branch --show-current 2>$null | Select-Object -First 1)
        if ([string]::IsNullOrWhiteSpace($branch)) { return '(detached or unavailable)' }
        return ([string]$branch).Trim()
    } catch { return '(unavailable)' }
}

function New-SafeNotificationText {
    param(
        [Parameter(Mandatory)][string]$State,
        [Parameter(Mandatory)][string]$ProjectPath,
        [Parameter(Mandatory)][datetime]$LastActivityUtc,
        [Parameter(Mandatory)][string]$Diagnostic
    )
    $branch = Get-GitBranchSafe -ProjectPath $ProjectPath
    @(
        "Codex Watcher: $State",
        "Laptop: $env:COMPUTERNAME",
        "Project: $ProjectPath",
        "Branch: $branch",
        "Last activity: $($LastActivityUtc.ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss zzz'))",
        "State: $State",
        "Diagnostic: $Diagnostic"
    ) -join "`n"
}

function Send-TelegramNotification {
    param([Parameter(Mandatory)][string]$Text)
    $token = [Environment]::GetEnvironmentVariable('CODEX_WATCHER_TELEGRAM_BOT_TOKEN', 'User')
    $chatId = [Environment]::GetEnvironmentVariable('CODEX_WATCHER_TELEGRAM_CHAT_ID', 'User')
    if ([string]::IsNullOrWhiteSpace($token) -or [string]::IsNullOrWhiteSpace($chatId)) {
        throw 'Telegram user-level environment variables are not configured.'
    }
    $uri = 'https://api.telegram.org/bot{0}/sendMessage' -f $token
    $response = Invoke-RestMethod -Method Post -Uri $uri -ContentType 'application/x-www-form-urlencoded' -Body @{
        chat_id = $chatId
        text = $Text
        disable_web_page_preview = 'true'
    } -TimeoutSec 20
    if (-not $response.ok) { throw 'Telegram API did not confirm the notification.' }
    return $true
}

function Test-NotificationAllowed {
    param(
        [Parameter(Mandatory)][hashtable]$State,
        [Parameter(Mandatory)][string]$Key,
        [Parameter(Mandatory)][string]$NotificationState,
        [int]$CooldownMinutes = 5
    )
    if ($State.Notifications.ContainsKey($Key)) { return $false }
    if ($State.LastNotificationUtc -and $NotificationState -eq 'Attention') {
        $last = [DateTime]::Parse($State.LastNotificationUtc).ToUniversalTime()
        if (([DateTime]::UtcNow - $last).TotalMinutes -lt $CooldownMinutes) { return $false }
    }
    return $true
}

function Publish-CodexWatcherEvent {
    param(
        [Parameter(Mandatory)][hashtable]$State,
        [Parameter(Mandatory)]$Event,
        [Parameter(Mandatory)][string]$ProjectPath,
        [Parameter(Mandatory)][string]$LogPath,
        [switch]$NoSend
    )
    $turn = if ($State.ActiveTurnId) { $State.ActiveTurnId } else { 'no-turn' }
    $key = '{0}|{1}|{2}|{3}' -f $State.SessionPath,$turn,$Event.State,$Event.KeySuffix
    if (-not (Test-NotificationAllowed -State $State -Key $key -NotificationState $Event.State)) { return $false }
    $activity = [DateTime]::Parse($State.LastActivityUtc).ToUniversalTime()
    $text = New-SafeNotificationText -State $Event.State -ProjectPath $ProjectPath -LastActivityUtc $activity -Diagnostic $Event.Diagnostic
    try {
        if (-not $NoSend) { $null = Send-TelegramNotification -Text $text }
        $State.Notifications[$key] = [DateTime]::UtcNow.ToString('o')
        $State.LastNotificationUtc = [DateTime]::UtcNow.ToString('o')
        Write-CodexWatcherLog -LogPath $LogPath -Level INFO -Message "Notification state=$($Event.State) keyHash=$($key.GetHashCode()) sent=$(-not $NoSend)"
        return $true
    } catch {
        $State.LastError = $_.Exception.Message
        Write-CodexWatcherLog -LogPath $LogPath -Level ERROR -Message "Notification state=$($Event.State) failed: $($_.Exception.Message)"
        return $false
    }
}

function Invoke-CodexWatcherPoll {
    param(
        [Parameter(Mandatory)][string]$ProjectPath,
        [Parameter(Mandatory)][hashtable]$State,
        [Parameter(Mandatory)][string]$LogPath,
        [int]$StuckMinutes = 15,
        [string]$SessionRoot = (Get-CodexSessionRoot),
        [Nullable[bool]]$ProcessRunningOverride,
        [string]$ProjectStampOverride,
        [string]$TerminalStampOverride,
        [switch]$NoSend
    )
    $events = New-Object System.Collections.Generic.List[object]
    $session = Find-ActiveCodexSession -ProjectPath $ProjectPath -SessionRoot $SessionRoot
    if ($null -ne $session -and $State.SessionPath -ne $session.FullName) {
        Initialize-SessionState -State $State -Session $session
        Write-CodexWatcherLog -LogPath $LogPath -Level INFO -Message "Monitoring session=$($session.Name) activeTask=$($State.ActiveTask)"
    } elseif ($null -ne $session) {
        $newLines = @(Read-NewSessionLines -State $State)
        if ($newLines.Count -gt 0) {
            foreach ($event in (Get-SessionEvents -State $State -Lines $newLines)) { $events.Add($event) }
        }
    }

    $projectStamp = if ($PSBoundParameters.ContainsKey('ProjectStampOverride')) { $ProjectStampOverride } else { Get-ProjectActivityStamp -ProjectPath $ProjectPath }
    if ($projectStamp -and $State.LastProjectStampUtc -and $projectStamp -ne $State.LastProjectStampUtc) {
        $State.LastActivityUtc = [DateTime]::UtcNow.ToString('o')
    }
    $State.LastProjectStampUtc = $projectStamp

    if ($PSBoundParameters.ContainsKey('ProcessRunningOverride')) {
        $running = [bool]$ProcessRunningOverride
        $terminalStamp = $TerminalStampOverride
    } else {
        $snapshot = Get-CodexProcessSnapshot -ProjectPath $ProjectPath
        $running = $snapshot.Running
        $terminalStamp = $snapshot.TerminalStamp
    }
    if ($terminalStamp -and $State.LastTerminalStamp -and $terminalStamp -ne $State.LastTerminalStamp) {
        $State.LastActivityUtc = [DateTime]::UtcNow.ToString('o')
    }
    $State.LastTerminalStamp = $terminalStamp

    $lastActivity = [DateTime]::Parse($State.LastActivityUtc).ToUniversalTime()
    $idleMinutes = ([DateTime]::UtcNow - $lastActivity).TotalMinutes
    if ($State.IsStuck -and $idleMinutes -lt $StuckMinutes) {
        $State.IsStuck = $false
        $State.LastState = 'Recovered'
        $events.Add([pscustomobject]@{ State='Recovered'; Diagnostic='Meaningful Codex, terminal, log, or project activity resumed after a stuck alert.'; KeySuffix=[string]$State.StuckEpisode })
    } elseif (-not $State.IsStuck -and $State.ActiveTask -and $running -and $idleMinutes -ge $StuckMinutes) {
        $State.IsStuck = $true
        $State.StuckEpisode = [int]$State.StuckEpisode + 1
        $State.LastState = 'Stuck'
        $events.Add([pscustomobject]@{ State='Stuck'; Diagnostic="Codex is running with an active task, but no meaningful activity was observed for at least $StuckMinutes minutes."; KeySuffix=[string]$State.StuckEpisode })
    }

    foreach ($event in $events) {
        $null = Publish-CodexWatcherEvent -State $State -Event $event -ProjectPath $ProjectPath -LogPath $LogPath -NoSend:$NoSend
    }
    $State.LastPollUtc = [DateTime]::UtcNow.ToString('o')
    $State.WatcherPid = $PID
    return $events.ToArray()
}

Export-ModuleMember -Function @(
    'Find-ActiveCodexSession','Get-CodexProcessSnapshot','Get-CodexSessionRoot','Get-CodexWatcherDataRoot',
    'Get-CodexWatcherPaths','Invoke-CodexWatcherPoll','New-CodexWatcherState','New-SafeNotificationText',
    'Read-CodexWatcherState','Save-CodexWatcherState','Send-TelegramNotification','Write-CodexWatcherLog'
)
