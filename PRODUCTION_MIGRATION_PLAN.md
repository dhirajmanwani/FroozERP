# FroozERP Production Migration Plan

Last updated: 2026-06-14

This document is Phase 0 for moving FroozERP from the current LAN/web ERP into an offline-first, cloud-synchronised retail ERP with Windows, Android, iOS and web owner-dashboard targets.

Checkpoint before migration work: `f179ee6` (`Checkpoint before production architecture migration`).

## Phase 0 Status

Completed in this phase:

- Audited current frontend, backend, database-init style, device approval foundation, branch/counter foundation, reports, cash book, backups and PWA support.
- Defined the target architecture and migration sequence.
- Defined local SQLite sync metadata, cloud sync contracts and conflict policy.
- Defined platform build gates for Windows, Android and iOS.
- No production business data was deleted, reset or migrated.
- No working POS, inventory, reports, accounts or print code was replaced in this phase.

Not completed in this phase:

- Tauri 2 app shell.
- Local SQLite runtime.
- Offline POS writes.
- Sync APIs.
- Windows/Android/iOS installers.
- Signed update pipeline.

Those are intentionally later phases. They must not be claimed complete until real platform builds and data tests pass.

## Current Codebase Audit

### Frontend

- Location: `frontend/src/App.jsx`, `frontend/src/App.css`.
- Framework: React 19, Vite, Axios.
- Shape: one large React shell with module-style components in `App.jsx`.
- API access: direct Axios calls to `API_URL`, currently browser/web oriented.
- PWA: `frontend/public/manifest.webmanifest` and `frontend/public/sw.js` provide app-shell shortcut behavior only. API data is not cached as a business database.
- Device identity: generated in browser `localStorage` as `froozerp_device_id`.
- Device approval UI exists in Settings.
- Mobile/tablet responsive work exists for dashboard, POS, reports and navigation.

### Backend

- Location: `backend/server.js`.
- Framework: Node.js, Express 5, PostgreSQL `pg`.
- Shape: single server file containing schema bootstrap, migrations via `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, routes, reporting queries and business logic.
- Database: PostgreSQL is the current source of truth.
- Routes cover products, categories, lots, purchases, sales, sales history, sale returns, waste, expenses, accounts, customer/supplier payments, pending bills, reports, cash book, balance sheet, device activation, settings, backup and branch/counter foundation.

### Existing Business Modules

- POS sales with lot-wise stock deduction, payment modes, invoice print/PDF.
- Product/category master.
- Opening stock and inventory lots.
- Stock adjustment/transfer/audit.
- Purchase and pending bill workflow.
- Sales history view/edit/cancel.
- Customer/supplier accounts and ledgers.
- Cash Book / Bank Book reports.
- Balance Sheet / P&L / report center.
- Discounts and sale-rate updates.
- Pending bills.
- Backup settings and safe-shutdown backup foundation.
- Authorized devices, activation codes, branches and counters.

### Current Limitations

- The app is still primarily online/web/LAN. POS writes currently go to PostgreSQL via backend APIs.
- There is no local SQLite database on client devices.
- There is no sync outbox, sync cursor, idempotent operation processor or conflict review module.
- Existing record IDs are mostly database sequential integers. New offline-first entities need UUID/ULID IDs.
- Tauri project scaffolding does not exist.
- Windows/Android/iOS builds do not exist.
- Update metadata/updater APIs do not exist.
- Device approval is browser-local and server-backed, but not yet native secure-storage based.

## Target Architecture

### Device Application

One React/Vite UI packaged through Tauri 2 for:

- Windows desktop.
- Android phone/tablet.
- iPhone/iPad.

Device app responsibilities:

- Native shell and secure storage.
- Local SQLite database.
- Local file/config/log storage.
- Offline POS and operational modules.
- Sync engine.
- Device activation and revocation check.
- Update checker.
- Compact connection/sync status indicator.

### Cloud

Cloud responsibilities:

- Node/Express API, evolved from current backend.
- Central PostgreSQL database.
- Authentication and refresh tokens.
- Device authorization.
- Branch/counter/user permission enforcement.
- Sync push/pull APIs.
- Processed operation idempotency table.
- Update metadata APIs.
- Owner dashboard APIs.
- Backups, restore runbooks and monitoring.

PostgreSQL remains the central cloud database. SQLite is local per authorized device. Mobile/client devices must not run their own PostgreSQL server.

## Target Repository Layout

Recommended future structure:

```text
backend/
  server.js
  migrations/cloud/
  sync/
  services/
frontend/
  src/
  public/
src-tauri/
  tauri.conf.json
  Cargo.toml
  icons/
  capabilities/
  migrations/sqlite/
release/
  windows/
  android/
  ios/
docs/
  production/
```

The current codebase can start with `src-tauri/` and `docs/production/` while gradually extracting backend services from `backend/server.js`.

## Platform Build Strategy

### Windows

Target:

- Tauri 2 Windows app.
- Signed-ready installer.
- Output under `release/windows/`.

Acceptance gate:

- `npm run tauri build` or equivalent succeeds on Windows.
- Installer installs FroozERP.
- App data path preserves SQLite DB, activation, config and unsynced outbox across updates.
- Uninstall must not silently delete business data.

### Android

Target:

- Same React UI in Tauri Android.
- Debug APK for internal testing.
- Release APK/AAB after signing setup.

Acceptance gate:

- APK installs on Android device/tablet.
- Login/activation works.
- POS creates local sale offline.
- App restart preserves local sale and stock.
- Reconnect syncs without duplicate sale.

### iOS/iPadOS

Target:

- Same React UI in Tauri iOS.
- iPhone owner dashboard and iPad POS.

Acceptance gate:

- iOS project opens on macOS/Xcode.
- Simulator build succeeds.
- Device/TestFlight build requires Apple signing and provisioning.

Important: iOS cannot use arbitrary self-installing app updates. Distribution must use TestFlight, App Store or an approved Apple business distribution method.

## Local SQLite Foundation

Every device must keep an application SQLite database. Browser cache is not acceptable as the business database.

### Required Local Metadata Columns

Every synchronisable entity created after this migration should have:

```text
id                  UUID/ULID primary key
branch_id           UUID/ULID or mapped cloud id
counter_id          nullable UUID/ULID
device_id           stable device UUID
created_by          user id
created_at          local timestamp
updated_at          local timestamp
version             integer
sync_status         PENDING | SYNCED | CONFLICT | FAILED
deleted_at          nullable timestamp
```

Legacy cloud integer IDs can be mapped during migration. New offline records must not depend on device-local sequential IDs.

### Local Sync Tables

```sql
CREATE TABLE sync_outbox (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
);

CREATE TABLE sync_state (
  device_id TEXT PRIMARY KEY,
  last_server_cursor TEXT,
  last_successful_sync_at TEXT,
  current_sync_status TEXT NOT NULL DEFAULT 'IDLE',
  last_error TEXT
);

CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_payload TEXT NOT NULL,
  server_payload TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'OPEN',
  resolved_by TEXT,
  resolution_notes TEXT
);
```

### Local-First Write Rule

All supported offline business writes must:

1. Validate locally.
2. Write local transaction in SQLite.
3. Update local derived stock/account view transactionally.
4. Insert a sync operation in `sync_outbox`.
5. Show success immediately.
6. Sync in the background when online.

POS must not wait for internet if the sale is locally valid.

## Sync API Design

### Push API

Proposed endpoint:

```http
POST /sync/push
```

Payload:

```json
{
  "device_id": "device-uuid",
  "branch_id": "branch-uuid",
  "operations": [
    {
      "operation_id": "uuid",
      "entity_type": "sale",
      "entity_id": "uuid",
      "operation_type": "CREATE",
      "timestamp": "2026-06-14T10:00:00+05:30",
      "version": 1,
      "payload": {}
    }
  ]
}
```

Server rules:

- Validate device approval and branch access.
- Process operations transactionally.
- Store `operation_id` in a processed operations table.
- If the same operation is pushed again, return the original acknowledgement.
- Never duplicate sales, payments, stock movements, purchases, returns or expenses.

### Pull API

Proposed endpoint:

```http
GET /sync/pull?device_id=...&cursor=...
```

Server response:

```json
{
  "next_cursor": "server-cursor",
  "changes": [
    {
      "entity_type": "product",
      "entity_id": "uuid",
      "operation_type": "UPSERT",
      "version": 5,
      "payload": {}
    }
  ]
}
```

Client rules:

- Apply changes in one SQLite transaction.
- Update cursor only after successful application.
- Queue conflicts into `sync_conflicts`.

## Entity Sync Classification

### Immutable Financial / Stock Transactions

Must not be silently overwritten:

- Sales.
- Sale payments.
- Customer receipts.
- Supplier payments.
- Purchases.
- Stock adjustments.
- Stock movements.
- Sale returns.
- Expenses.
- Ledger postings.

Edits must be represented as amendments, reversals or conflict-review records.

### Master Data

Can use version/timestamp with audit history:

- Product remarks.
- Category names.
- Customer/supplier non-financial details.
- Settings with low accounting risk.

### Sensitive Conflict Entities

Need explicit conflict review:

- Sale rates changed offline on multiple devices.
- Lot metadata used by offline sales.
- Discounts changed offline on multiple devices.
- Device/role/branch permissions.

### Derived Balances

Do not sync as source of truth:

- Customer balance.
- Supplier balance.
- Lot balance.
- Cash balance.
- Bank balance.
- Dashboard totals.

These must be derived from transactions.

## Stock Sync Policy

Never sync stock by replacing total quantity.

Use stock movement operations:

- SALE_OUT
- SALE_RETURN_IN
- PURCHASE_IN
- WASTE_OUT
- ADJUSTMENT_IN
- ADJUSTMENT_OUT
- TRANSFER_IN
- TRANSFER_OUT

Server calculates lot and product balances.

Offline overselling policy must be decided before Phase 3:

- Strict: block if local lot balance insufficient.
- Server conflict: allow local sale, but sync may enter conflict if another device depleted stock first.
- Owner override: allow only privileged role and flag conflict/provisional stock.

Recommended first production policy: strict local check plus server conflict review if cross-device offline sales oversell the same lot.

## Invoice Number Policy

Offline devices need device-safe temporary references:

```text
FZ-OFF-{deviceShort}-{YYYYMMDD}-{localSequence}
```

Cloud may assign an official central invoice number after sync:

```text
FZ-{YYYYMMDD}-{centralSequence}
```

Both must be stored:

- `offline_invoice_no`
- `official_invoice_no`

Printed offline bill should clearly show the offline reference and later preserve traceability after official sync.

## Device Activation Flow

1. Install app.
2. Generate device identity in native secure storage.
3. Show activation screen.
4. Owner approves device or issues one-time activation code.
5. Server assigns branch, counter, role/access profile.
6. Device downloads initial data.
7. Device verifies counts/checksums.
8. POS is enabled only after initial sync succeeds.

Disabled/revoked devices:

- Must not sync.
- Must not pull new data.
- Must lock when they next contact the server.
- Limitation: a permanently offline revoked device cannot be remotely locked until it reconnects.

## Cloud Owner Dashboard

Cloud dashboard should show:

- Today's sales.
- Cash sales.
- UPI/bank collections.
- Customer credit.
- Cash in hand.
- Bank balance.
- Customer receivables.
- Supplier payables.
- Stock value.
- Low stock.
- Pending sync devices.
- Last sync per device.
- Recent invoices.
- Recent expenses.
- Branch summary foundation.

When a branch/device is offline, the UI must show `Last synced at ...` and must not imply live data.

## Update System

Versioning: semantic versioning (`MAJOR.MINOR.PATCH`).

Cloud update metadata table should include:

```text
platform
current_version
latest_version
minimum_supported_version
mandatory
title
release_notes
published_at
download_reference
checksum
signature
```

Rules:

- Check updates at startup and periodically.
- Mandatory updates can block only after pending local data is protected.
- Before update: local DB checkpoint and outbox preservation.
- Windows: Tauri updater with signed artifacts.
- Android: Play update flow or secure release notification. No insecure silent APK install.
- iOS: TestFlight/App Store/business distribution only.

## Migration Strategy

### Cloud PostgreSQL

Move from startup `ALTER TABLE` bootstrap toward versioned migrations:

```text
backend/migrations/cloud/001_initial_current_baseline.sql
backend/migrations/cloud/002_sync_foundation.sql
backend/migrations/cloud/003_update_metadata.sql
```

Add a `schema_migrations` table:

```sql
CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  checksum TEXT NOT NULL,
  status TEXT NOT NULL
);
```

### Local SQLite

Add local migration tracking:

```sql
CREATE TABLE local_schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL,
  checksum TEXT NOT NULL,
  status TEXT NOT NULL
);
```

Migration rules:

- Backup/checkpoint before migration.
- Transactional where supported.
- Never reset production data.
- Never silently drop business columns/tables.
- Log success/failure.
- Block incompatible app versions from writing.

## Security Requirements

- HTTPS for cloud APIs.
- No database credentials in frontend or Tauri UI code.
- Secure token storage through native storage.
- Refresh-token strategy.
- Role-based permissions.
- Branch/device enforcement on every write.
- Rate limiting on auth/sync APIs.
- Input validation.
- Audit logging.
- Signed update artifacts where supported.
- Local database encryption strategy documented before production.

## Testing Gates

### Offline POS

- Complete multiple sales offline.
- Restart app.
- Verify sales remain.
- Verify stock remains correct.

### Reconnect Sync

- Sync offline sales.
- Verify no duplicates.
- Verify cloud totals.
- Verify stock.

### Multiple Devices

- Device A and Device B sell same lot offline.
- Verify server policy handles conflict/oversell.
- Do not silently corrupt stock.

### Updates

- Update app with pending outbox operations.
- Verify pending data remains.
- Verify migrations run.
- Verify recovery instructions if update fails.

### Activation

- Unapproved device blocked.
- Approved device initial sync succeeds.
- Revoked device blocked after reconnect.

### Platform Builds

- Windows installer build.
- Android APK/AAB build.
- iOS simulator/device build where macOS/Xcode/signing are available.

## Implementation Phases

### Phase 1 - Local SQLite Foundation

Goal:

- Add local DB abstraction and SQLite schema without changing production writes yet.

Deliverables:

- Tauri project scaffold.
- Local SQLite migrations.
- Repository/data-access layer.
- Device identity through secure storage.
- Read-only local cache for products/categories/lots/settings.
- Build still passes for web.

Exit gate:

- Existing web app still works.
- Local SQLite can initialize and migrate.
- No POS write behavior is changed until tested.

### Phase 2 - Device Activation and Initial Sync

Goal:

- Native device activation and initial data download.

Deliverables:

- Initial sync API.
- Device checksums/count verification.
- Activation progress screen.
- Branch/counter assignment stored locally.

Exit gate:

- New test device cannot use app before activation.
- Activated test device downloads initial data and can open owner dashboard.

### Phase 3 - Offline POS Local-First Writes

Goal:

- POS sale writes locally first.

Deliverables:

- Local sale transaction schema.
- Local stock movement schema.
- Local customer credit handling.
- `sync_outbox` creation.
- Offline sale print with offline invoice reference.

Exit gate:

- Create sale offline.
- Restart app.
- Sale and stock are still correct locally.

### Phase 4 - Push/Pull Sync Engine

Goal:

- Sync local operations to cloud and pull cloud changes.

Deliverables:

- `/sync/push`.
- `/sync/pull`.
- Processed operation idempotency.
- Sync status indicator.
- Conflict table and conflict UI foundation.

Exit gate:

- Repeated push does not duplicate sale.
- Pull applies changes transactionally.
- Pending count reaches zero after successful sync.

### Phase 5 - Operational Modules Offline

Goal:

- Extend local-first writes beyond POS.

Scope:

- Expenses.
- Waste.
- Customer payments.
- Sale returns where safe.
- Stock lookups.
- Pending bills lookup.
- Cash book from local data.

Exit gate:

- Each module has offline write, restart persistence and sync verification.

### Phase 6 - Windows App and Installer

Goal:

- Production-ready Windows desktop build.

Deliverables:

- `src-tauri` Windows config.
- Installer output in `release/windows/`.
- App data preservation documented and tested.

Exit gate:

- Installer succeeds.
- Update reinstall preserves SQLite and pending outbox.

### Phase 7 - Android App

Goal:

- Android tablet POS and owner phone dashboard.

Deliverables:

- Debug APK.
- Signed release APK/AAB setup docs.
- Android secure storage.
- Android SQLite path.

Exit gate:

- APK installs and offline POS test passes.

### Phase 8 - iOS/iPad App

Goal:

- iOS project build foundation.

Deliverables:

- Tauri iOS project.
- Xcode signing docs.
- TestFlight/App Store docs.

Exit gate:

- Simulator build succeeds where macOS/Xcode are available.

### Phase 9 - Update Pipeline

Goal:

- Versioned releases and update metadata.

Deliverables:

- Update metadata API.
- Owner/System Admin UI.
- Tauri updater metadata for Windows.
- Platform-specific update docs.

Exit gate:

- Optional update notification works.
- Mandatory update protects pending local data.

## Release Risk Register

- Current single-file backend makes sync and migration work risky unless service boundaries are introduced gradually.
- Current integer IDs cannot safely support offline-created entities without ID-mapping work.
- Local SQLite and PostgreSQL schemas must be intentionally different where needed, not blindly copied.
- Offline stock conflict policy must be accepted by owner before enabling offline POS on multiple devices.
- iOS production release cannot be verified on Windows; macOS/Xcode/signing are required.
- Silent mobile binary updates are not acceptable.
- Local database encryption must be selected and tested before storing sensitive business data on mobile.

## Immediate Next Step

Start Phase 1 only:

1. Scaffold `src-tauri/` with stable bundle id `com.srtcompany.froozerp`.
2. Add app metadata and version `1.0.0`.
3. Add local SQLite migration files and repository interface.
4. Keep current web/backend behavior unchanged.
5. Build web app.
6. If Tauri dependencies are not locally installed, document the blocker and do not claim native builds complete.
