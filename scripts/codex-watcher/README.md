# Codex Watcher (Windows)

Codex Watcher is a user-level PowerShell monitor for this repository. It sends metadata-only Telegram notifications when the active Codex turn completes, fails, needs attention, appears stuck, or recovers. It does not read or change FroozERP production data or business logic.

## Credentials

Create a Telegram bot with BotFather, send that bot a message, then obtain the numeric chat ID from Telegram's `getUpdates` response. Store both values as **user-level** environment variables; never put them in this repository:

```powershell
[Environment]::SetEnvironmentVariable('CODEX_WATCHER_TELEGRAM_BOT_TOKEN', '<bot token>', 'User')
[Environment]::SetEnvironmentVariable('CODEX_WATCHER_TELEGRAM_CHAT_ID', '<numeric chat id>', 'User')
```

Close and reopen PowerShell after setting them, or use the management script directly because it reads the user-level environment store.

## Commands

Run from the repository root:

```powershell
# Test the Telegram route before installation
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-watcher\Manage-CodexWatcher.ps1 SendTestNotification

# Install and start at user login (normal user; no administrator required)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-watcher\Manage-CodexWatcher.ps1 Install

# Inspect status
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-watcher\Manage-CodexWatcher.ps1 Status

# Pause and resume
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-watcher\Manage-CodexWatcher.ps1 Pause
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-watcher\Manage-CodexWatcher.ps1 Resume

# Send a test at any time
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-watcher\Manage-CodexWatcher.ps1 SendTestNotification

# Uninstall task, copied runtime, state, and logs (add -KeepData to preserve state/logs)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-watcher\Manage-CodexWatcher.ps1 Uninstall

# Run local simulated-state tests; Telegram is not contacted
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codex-watcher\Test-CodexWatcher.ps1
```

The scheduled task is named `Codex Watcher - FroozERP`. Runtime files, state, and rotated logs live under `%LOCALAPPDATA%\CodexWatcher`; no credentials are copied there. Task Scheduler restarts the watcher one minute after an unexpected exit, and the watcher also contains per-poll error isolation.

## Detection and privacy

- Completion: structured `task_complete` in the matching `%USERPROFILE%\.codex\sessions\...\rollout-*.jsonl` file.
- Failure: structured `turn_aborted`, or a narrow failure indicator in `task_complete.last_agent_message`.
- Attention: structured approval/input tool metadata, `require_escalated`, or conservative assistant-only login/browser/UAC wording.
- Stuck: an active turn and Codex app-server process must both exist, with no session, project file/Git, or relevant Codex-child terminal activity for 15 minutes. One alert is sent per stuck episode.
- Recovery: meaningful activity resumes after a stuck alert.

Only laptop name, project path, branch, last activity time, state, and a fixed diagnostic are sent. Source/log text, command output, credentials, database contents, and business/customer data are never included. Notification keys and state cooldowns suppress duplicates; the local log rotates at 1 MiB with five retained generations.

The installed Codex build exposes reliable task start/completion events but no dedicated approval/login event in the inspected sessions. Attention detection is therefore best-effort and deliberately conservative. Process/activity fallback can identify inactivity, but it cannot prove that the model is logically stuck.
