# Phase 4C.0 Production Cloud Foundation

## Scope and safety boundary

Phase 4C.0 prepares configuration, identity, status validation, transport policy, migration plans, and a truthful module-readiness audit. It does not deploy a cloud service, apply migrations, enable Android, or claim that full business data sync works.

No database reset, delete, automatic migration, business-row rewrite, or backup cleanup is part of this phase.

## Configuration model

| Purpose | Backend/runtime | Frontend/installed app |
| --- | --- | --- |
| Cloud HTTPS API | `CLOUD_API_URL` | `VITE_CLOUD_API_URL` |
| PostgreSQL | `DATABASE_URL` or `CLOUD_DATABASE_URL` | Not exposed |
| Company | `COMPANY_ID` | `VITE_COMPANY_ID` |
| Branch | `BRANCH_ID` | `VITE_BRANCH_ID` |
| Sub-branch | Runtime migration metadata | `VITE_SUB_BRANCH_ID` |
| Device ID | `DEVICE_ID` | `VITE_DEVICE_ID` or local SQLite identity |
| Device name | `DEVICE_NAME` | `VITE_DEVICE_NAME` or local SQLite identity |
| App mode | `APP_MODE` | `VITE_API_MODE` |

Supported app modes:

- `LOCAL_SINGLE_DEVICE`
- `BRANCH_LAN_SERVER`
- `BRANCH_LAN_CLIENT`
- `CLOUD_PRODUCTION`
- `FIELD_REMOTE_DEVICE`
- `CUSTOM_API_URL`

The existing `FROOZERP_COMPANY_ID` and `FROOZERP_PUBLIC_API_URL` names remain compatibility aliases. Secrets and provider credentials must not be committed.

## Truthful readiness rules

- `CLOUD_PRODUCTION` requires a real hosted HTTPS URL. Localhost, loopback, `.local`, link-local, and private LAN IP ranges are not cloud.
- Backend `cloud_ready=true` additionally requires production mode, cloud deployment type, `APP_MODE=CLOUD_PRODUCTION`, company and deployment identity, a real public cloud API URL, and configured CORS origins.
- A valid health response proves only that the cloud foundation is reachable. It does not prove all business modules synchronize.
- `FIELD_REMOTE_DEVICE` remains explicitly not ready until remote purchase entry, offline storage, stock-arrival handling, and conflict-safe sync are implemented and tested.
- LAN server/client modes remain local network modes and must never be labelled Cloud.
- With no real cloud URL, the owner sees `Cloud Not Configured`.
- The installed Windows app permits outbound HTTPS connections in its CSP so a validated runtime cloud URL can be reached. Scripts remain restricted to the packaged application.

## Owner Settings contract

The owner status summary contains only:

- App Mode
- Branch
- Device
- Internet
- Local Branch Server
- Cloud
- Sync Status
- Pending Sync
- Last Sync

Raw API URLs, database paths, schema versions, queue diagnostics, cursors, and configured identity values remain under Advanced Diagnostics. The mode selector remains owner-facing; conditional raw URL fields are diagnostic.

## Current sync readiness by module

| Module | Phase 4C.0 status | Production limitation |
| --- | --- | --- |
| POS sale create | Foundation implemented | Real hosted multi-device verification pending |
| POS sale edit/cancel | Foundation implemented | Conflict and concurrent-device testing pending |
| Products/categories/reference data | Server-to-local pull foundation | Full bidirectional authoring is not implemented |
| Purchases | Not implemented | No purchase outbox/server handler |
| Field purchase entries | Not implemented | `FIELD_REMOTE_DEVICE` cannot be ready |
| Stock arrivals | Not implemented | No arrival entity handler |
| Supplier/customer ledgers | Not implemented | No independent bidirectional ledger sync |
| Payments | Partial POS transaction posting only | No general payment sync handler |
| Expenses | Not implemented | No offline entity/outbox/server handler |
| Waste | Not implemented | No offline entity/outbox/server handler |
| Returns | Not implemented | No complete offline return sync handler |
| Settings | Not implemented | No versioned settings sync policy |
| Permissions | Not implemented | Remains authoritative on the backend |
| Full stock/lots | Not implemented | No complete bidirectional lot conflict model |

The backend currently accepts only `sync_test` and `pos_sale` push entities. Local pull application currently handles product categories, products/sale rates, and safe test entities. Unsupported entities must continue to be rejected rather than silently accepted.

## Migration plans

- `backend/migrations/cloud/007_cloud_sync_entity_metadata.sql`
- `src-tauri/migrations/sqlite/008_cloud_sync_entity_metadata.sql`

Both plans create separate sync metadata tables containing `company_id`, `branch_id`, `sub_branch_id`, `device_id`, `idempotency_key`, `conflict_status`, `created_by_device_id`, `updated_by_device_id`, `sync_status`, and `synced_at`.

They intentionally do not alter existing business tables. The SQLite plan is intentionally not wired into `src-tauri/src/local_db.rs`, so installing or launching Phase 4C.0 does not apply it.

## Remaining production prerequisites

1. Provision a hosted HTTPS FroozERP API and hosted PostgreSQL.
2. Configure production environment, TLS, CORS, secrets, company identity, and cloud deployment identity.
3. Back up both PostgreSQL and every device SQLite database.
4. Review and deliberately apply migration plans through controlled migration tracking.
5. Implement each missing module behind explicit entity handlers and conflict tests.
6. Verify multiple devices, multiple branches, offline/online recovery, duplicate-operation handling, and data reconciliation.

Until these steps pass against real infrastructure, FroozERP cloud sync is not production-ready.
