# Device Sync

## Local Identity

The frontend continues to use the existing FroozERP device id from browser/native storage:

- `device_id`
- `device_name`
- `platform`
- `app_version`
- `branch_id`

Native SQLite stores Phase 2 local device and sync metadata in:

- `local_device_identity`
- `sync_state`
- `sync_outbox`
- `local_pos_invoices`
- `local_pos_invoice_items`
- `local_stock_movements`
- `local_payment_postings`

## Server Identity

The existing `authorized_devices` table is extended with:

- `platform`
- `app_version`
- `last_sync_at`
- `sync_status`

Allowed sync statuses:

- `PENDING`
- `APPROVED`
- `DISABLED`
- `REVOKED`

Only approved devices may push or pull.

## Branch Rule

Phase 2 uses `Main Branch` as branch `1`. Sync requests must carry:

- `branch_id`
- `device_id`

The server rejects requests where the device is not assigned to the requested branch.

## Local-First POS Device Rule

In the Tauri desktop runtime, POS checkout writes to SQLite first and queues a `pos_sale` outbox operation. The browser/web runtime continues to use the existing online `/sales` route so the same sale is not saved directly to PostgreSQL and then pushed again.

Phase 2 requires selected lot IDs for local-first POS sale items. If a Tauri checkout item does not have a selected lot, the checkout is stopped locally with a clear message.
