# Phase 2 - Sync Engine Foundation

Status: `IMPLEMENTED - FINAL INTERACTIVE BROWSER VERIFICATION PENDING`

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
- PostgreSQL POS sync identity migration:
  - `backend/migrations/cloud/003_pos_sync_sale_foundation.sql`
- SQLite local-first POS migration:
  - `src-tauri/migrations/sqlite/003_local_first_pos.sql`
- Local-first Tauri POS checkout command:
  - `pos_sale_complete_local`
- Local POS tables:
  - `local_pos_invoices`
  - `local_pos_invoice_items`
  - `local_stock_movements`
  - `local_payment_postings`
- Local repository-backed sync service:
  - `frontend/src/local/syncService.js`
- Compact sync status UI in Settings.

## Entities Supported In This Slice

- Device registration/sync identity.
- Product category reference pull.
- Product and sale-rate reference pull.
- Safe `sync_test` push/pull.
- Tauri local-first POS sale completion.
- POS sale sync into live PostgreSQL sales, sale item, stock allocation, stock transaction, payment and customer ledger tables.
- POS duplicate prevention through `sync_processed_operations`, `sales.global_id` and `sales.offline_invoice_ref`.
- POS insufficient server stock conflict logging.

## Entities Not Yet Synced

- Purchases.
- Returns.
- Expenses.
- Waste.
- Full offline reports beyond local POS sales, local stock movements and local payment postings.
- Multi-branch workflows.

## Verification Commands Used

```powershell
node --check backend\server.js
npm.cmd --prefix frontend run build
cd src-tauri
%USERPROFILE%\.cargo\bin\cargo.exe check
%USERPROFILE%\.cargo\bin\cargo.exe test
$env:PATH = "$env:USERPROFILE\.cargo\bin;$env:PATH"
npm.cmd --prefix frontend exec tauri -- info
npm.cmd --prefix frontend exec tauri -- build --debug --no-bundle
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

Final Phase 2 POS verification:

```text
local_pos_sale_persists_invoice_stock_payment_and_outbox=passed
SQLite invoice/items/payment/stock movement/outbox persisted after reopen=passed
temporary API POS sale push=accepted
duplicate API POS push=accepted; sale_count remained 1
temporary server lot stock reduced from 10 to 8 exactly once
insufficient server lot stock push=conflict
temporary verification records cleaned up; products/devices/sales/processed ops all returned to 0
existing backend modules after cleanup:
  products=18
  categories=14
  inventory=46
  sales=148
  cash_book_entries=1
```

## Known Limitations

- Browser automation is not installed locally (`playwright` package not found), so automated DevTools console/network inspection was not performed in this pass.
- Existing web modules were regression-checked through backend APIs; final interactive browser confirmation remains manual.
- Tauri local-first POS requires a selected lot for every item in Phase 2. Auto-FIFO local offline checkout is intentionally deferred until local lot allocation is broadened.
- Offline local Sales History visibility is immediate for newly completed local Tauri sales. Full offline Cash Book, Bank Book, customer receivables and historical reports remain server-dependent unless they read the Phase 2 local tables.
