# Windows Installation

## Installer

Internal-test installer:

```text
release/windows/FroozERP-Setup-1.0.0.exe
```

Build command:

```powershell
npm.cmd run build:windows
npm.cmd run release:windows
```

This is the **release** build and it requires `TAURI_SIGNING_PRIVATE_KEY`, because it also produces
the signed artifacts the update feed needs. To build an installer for a machine you have in front of
you — no key, no update artifacts, same app — use `npm.cmd run build:windows:local` instead. See
`RELEASE_AND_UPDATE_PROCESS.md`, "Build Commands".

Verification command:

```powershell
npm.cmd run verify:windows
```

## Install Location

The Tauri NSIS installer uses per-machine installation mode.

Observed installation path:

```text
C:\Program Files\FroozERP\FroozERP.exe
```

Observed shortcuts:

- `C:\ProgramData\Microsoft\Windows\Start Menu\Programs\FroozERP.lnk`
- `C:\Users\Public\Desktop\FroozERP.lnk`

## Runtime Behaviour

The installed app loads the built React frontend from the Tauri package. It must not require:

- `npm run dev`
- a Vite server on port `5173`
- a frontend terminal
- a manually started backend for offline-supported local-first operations

The installed app launch test confirmed port `5173` was not listening before or after startup.

## Local Data Preservation

The installer must preserve:

- SQLite database
- pending sync outbox operations
- device identity
- activation/registration state
- app settings
- recovery logs where present

Observed local database path:

```text
C:\Users\DellPc\AppData\Roaming\com.srtcompany.froozerp\froozerp-local.sqlite3
```

Repair reinstall preserved the database file size and timestamp.

## Uninstall And Recovery

Uninstall must not be treated as permission to silently delete local business data. If a future uninstall option removes local data, it must:

- clearly warn the owner/admin
- identify the database path
- preserve or export pending sync operations first
- document the recovery path

## Signing

The generated installer is currently unsigned. A production customer release requires:

- SRT Company code-signing certificate
- signed installer
- signed updater artifacts
- release checksums
- documented publisher-controlled release process
