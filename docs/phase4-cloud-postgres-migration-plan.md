# FroozERP Phase 4 Cloud PostgreSQL Migration Plan

This document is a non-destructive migration checklist. Do not run cloud import against production until backup, restore and row-count verification have been tested.

## 1. Backup Local PostgreSQL

Required:

- Confirm shop is not actively billing during backup.
- Confirm installed Windows app can still work offline.
- Record current app version.
- Record local SQLite path and size.
- Record pending sync/outbox count.
- Run PostgreSQL dump.

Example:

```powershell
.\scripts\cloud\backup-postgres.ps1 -OutputDir C:\FroozERPBackups\cloud-migration
```

## 2. Export Schema and Data

- Export full schema and data from local PostgreSQL.
- Keep business data, users, devices, lots, sales, purchases, payments and ledgers.
- Do not reset local PostgreSQL.
- Do not delete SQLite.

## 3. Import Into Cloud PostgreSQL

Before import:

- Cloud database must be empty or explicitly prepared for restore.
- Confirm cloud connection string is not committed to repository.
- Confirm SSL/TLS requirements.

Example:

```powershell
.\scripts\cloud\restore-postgres.ps1 -DumpFile C:\FroozERPBackups\cloud-migration\froozerp_YYYYMMDD_HHMMSS.dump
```

## 4. Verify Row Counts

Run row-count verification locally and against cloud.

Core tables to compare:

- users
- branches
- counters
- authorized_devices
- product_categories
- products
- inventory_batches
- sales
- sale_items
- sale_payments
- purchases
- purchase_items
- suppliers
- customers
- expenses
- sync_processed_operations
- sync_change_log

Example:

```powershell
.\scripts\cloud\verify-row-counts.ps1
```

## 5. Functional Verification

- Login works against cloud API.
- Device approval still works.
- Products and lots load.
- Sales History loads.
- POS can create a local sale offline.
- Reconnect sync pushes exactly once.
- Owner dashboard foundation returns live cloud freshness.

## 6. Rollback

Rollback must preserve local data.

- Switch API mode back to `LOCAL_SHOP_SERVER`.
- Keep local PostgreSQL unchanged.
- Keep local SQLite unchanged.
- Preserve pending sync queue.
- Do not delete cloud database until backup is verified.

## 7. Do Not Proceed To Android Until

- Windows app online/offline switch works.
- Sync queue is truthful.
- Duplicate operations are blocked server-side.
- Owner dashboard shows data freshness and device status.
- Cloud backup/restore has been tested.
