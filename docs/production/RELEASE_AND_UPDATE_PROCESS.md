# Release And Update Process

## Version

Initial Windows production version:

```text
1.0.0
```

Bundle identifier:

```text
com.srtcompany.froozerp
```

Do not change the bundle identifier after release without a migration plan for local data and updater identity.

## Build Commands

```powershell
npm.cmd run verify:windows
npm.cmd run build:windows
npm.cmd run release:windows
```

Output:

```text
release/windows/FroozERP-Setup-1.0.0.exe
```

## Update Foundation

The application includes an owner/admin Software Updates panel in Settings. It shows:

- current version
- latest known version
- update status
- release title
- release notes
- published date
- last checked time
- download/install state
- update errors

The update feed is intentionally configurable:

```text
VITE_UPDATE_FEED_URL
window.__FROOZERP_UPDATE_FEED_URL__
```

No fake public update URL is hardcoded.

## Update Feed Contract

The local update foundation expects a hosted JSON feed with fields such as:

```json
{
  "version": "1.0.1",
  "title": "FroozERP 1.0.1",
  "notes": "Release notes",
  "published_at": "2026-06-16T00:00:00Z",
  "mandatory": false
}
```

Real end-to-end updates require hosted signed release artifacts and metadata. Until that release infrastructure exists, the app can check configured metadata but cannot safely install a production update.

## Pre-Update Safety Rules

Before installing updates:

- check local database health
- preserve the SQLite database
- preserve pending outbox operations
- preserve device identity and activation
- avoid updates while a transaction is being committed
- run local migrations transactionally after update
- record migration success/failure

## Signing And Publishing

Only an authorised release process should publish FroozERP binaries. Ordinary staff must not upload installers or update artifacts.

Production requirements:

- code-sign the Windows installer
- sign updater artifacts
- publish checksums
- host update metadata on the approved production feed
- document rollback/recovery procedures

## Current Limitation

The Phase 3 installer is an unsigned internal-test installer. Real update installation was not tested because no hosted signed update feed exists yet.
