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
