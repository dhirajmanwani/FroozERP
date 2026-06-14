# Phase 1 - Local SQLite Foundation

Implemented on: 2026-06-14

## Scope

This phase adds the native/local foundation only. It does not enable Android, iOS, cloud sync, updater, installer packaging, or local-first POS writes.

## Implemented

- Tauri 2 scaffold under `src-tauri/`.
- Stable application identity:
  - Product: `FroozERP`
  - Company/author: `SRT Company`
  - Bundle identifier: `com.srtcompany.froozerp`
  - Version: `1.0.0`
- Local SQLite database file:
  - `froozerp-local.sqlite3`
  - Stored in the Tauri app data directory at runtime.
- Versioned SQLite migration:
  - `001_local_foundation`
- Local schema migration tracking:
  - `local_schema_migrations`
- Sync foundation tables:
  - `sync_outbox`
  - `sync_state`
  - `sync_conflicts`
- Read-only/local cache foundation tables:
  - `local_categories`
  - `local_products`
  - `local_inventory_lots`
  - `local_customers`
  - `local_settings`
- Sync metadata columns on local cache tables:
  - `id`
  - `branch_id`
  - `counter_id`
  - `device_id`
  - `created_by`
  - `created_at`
  - `updated_at`
  - `version`
  - `sync_status`
  - `deleted_at`
- Rust commands for:
  - Local DB initialize/status
  - Smoke-test key/value persistence
  - Sync outbox enqueue/count
- Frontend local database adapter:
  - `frontend/src/local/localDatabase.js`
  - Browser mode remains inert and does not require SQLite.
- Frontend repository foundation:
  - `frontend/src/local/repositories.js`
- Settings sync section now shows native SQLite readiness when running inside Tauri.

## Preserved Behavior

- Existing browser/web operation still uses the current backend API and PostgreSQL source of truth.
- No POS, sales, purchase, stock, ledger, report, print, or PDF write behavior was switched to SQLite in this phase.
- No production PostgreSQL data is reset, migrated, overwritten, or deleted.

## Verification Commands

Run from the repository root unless noted:

```powershell
npm --prefix frontend run build
node --check backend/server.js
npm run app:build -- --debug
cd src-tauri
cargo test local_db_persists_smoke_value_after_reopen
cargo check
```

The Rust/Tauri checks require Rust/Cargo to be installed on the Windows development machine.

## Remaining For Later Phases

- Native secure token/device identity storage.
- Initial sync download.
- Cloud sync push/pull APIs.
- Local-first POS writes.
- Offline invoice numbering.
- Conflict handling UI.
- Windows installer.
- Android/iOS builds.
- Signed update pipeline.
