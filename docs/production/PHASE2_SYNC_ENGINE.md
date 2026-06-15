# Phase 2 - Sync Engine Foundation

Status: `IN PROGRESS`

Started from checkpoint tag: `phase1-local-sqlite-passed`

## Scope Completed

- PostgreSQL sync foundation migration:
  - `backend/migrations/cloud/002_sync_engine_foundation.sql`
- SQLite sync foundation migration:
  - `src-tauri/migrations/sqlite/002_sync_engine_foundation.sql`
- Backend health endpoint:
  - `GET /api/health`
- Backend sync endpoints:
  - `POST /api/sync/register-device`
  - `POST /api/sync/push`
  - `GET /api/sync/pull`
  - `GET /api/sync/status`
- Server idempotency table:
  - `sync_processed_operations`
- Server cursor/change log:
  - `sync_change_log`
- Server conflict table:
  - `sync_conflict_log`
- Safe server test entity:
  - `sync_test_entities`
- Controlled POS sync foundation table:
  - `sync_pos_sale_staging`
- Local repository-backed sync service:
  - `frontend/src/local/syncService.js`
- Compact sync status UI in Settings.

## Entities Supported In This Slice

- Device registration/sync identity.
- Product category reference pull.
- Product and sale-rate reference pull.
- Safe `sync_test` push/pull.
- POS sale foundation is staged only in `sync_pos_sale_staging`; live POS still uses the current online API.

## Entities Not Yet Synced

- Full local-first POS invoice creation into live PostgreSQL sales tables.
- Purchases.
- Returns.
- Expenses.
- Waste.
- Full ledgers/accounts.
- Multi-branch workflows.

## Verification Commands Used

```powershell
node --check backend\server.js
npm.cmd --prefix frontend run build
cd src-tauri
%USERPROFILE%\.cargo\bin\cargo.exe check
```

Backend test instance:

```powershell
$env:PORT='5050'
node backend\server.js
```

Safe API checks:

```powershell
Invoke-RestMethod http://127.0.0.1:5050/api/health
POST http://127.0.0.1:5050/api/sync/push
GET  http://127.0.0.1:5050/api/sync/pull
GET  http://127.0.0.1:5050/api/sync/status
```

Observed safe test result:

```text
health=ok
sync_test push=accepted
duplicate sync_test push=accepted from processed operation
pull returned changes and next_cursor
invalid POS sale foundation operation=conflict
```

## Known Limitations

- Phase 2 foundation is not marked passed yet.
- Live POS is not switched to local-first writes in this slice.
- POS sale sync currently stages controlled payloads for review instead of writing live sales/stock/payment tables.
- Browser automation remains unreliable on this Windows machine; manual browser verification is still required for final Phase 2 pass.
