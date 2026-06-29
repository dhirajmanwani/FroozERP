# FroozERP Phase 4B Multi-Device Cloud Readiness

Date: 2026-06-28

## Scope

This is a readiness audit for real cloud sync across multiple FroozERP devices:

- Owner laptop
- Cashier laptop or device
- Purchase entry laptop or device
- Back office laptop
- Future owner mobile app
- Field remote purchase tablet/laptop outside shop LAN
- Future branches and sub-branches

This document does not mark cloud sync as ready. Real cloud requires a hosted backend URL, hosted PostgreSQL, HTTPS, CORS, production environment variables, configured app cloud API URL, and successful multi-device tests.

## Current Mode Status

- `LOCAL_SINGLE_DEVICE` exists for app and backend on the same laptop.
- `BRANCH_LAN_SERVER` exists as a named frontend mode for the branch server computer.
- `BRANCH_LAN_CLIENT` exists as a named frontend mode for same-shop LAN client devices.
- `FIELD_REMOTE_DEVICE` exists as a named frontend mode, but is explicitly not ready until cloud and purchase offline sync are implemented.
- Same-machine local backend is `http://127.0.0.1:5000`.
- LAN shop-server use is possible by setting the local API URL to a main-shop computer IP, such as `http://MAIN-LAPTOP-IP:5000`.
- `CLOUD_PRODUCTION` exists as a frontend mode, but no real cloud API URL is configured.
- `CUSTOM_API_URL` exists for manually supplied backend URLs.

## Environment Requirements

Frontend/app configuration:

- `VITE_API_MODE`
- `VITE_LOCAL_API_URL`
- `VITE_BRANCH_LAN_API_URL`
- `VITE_CLOUD_API_URL`
- `VITE_CUSTOM_API_URL`
- `VITE_BRANCH_SERVER_BIND_HOST`
- `VITE_BRANCH_SERVER_PORT`

Backend/cloud host configuration:

- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT`
- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- `CLOUD_DATABASE_URL` or equivalent provider-managed PostgreSQL URL (not read by the current backend yet)
- `CORS_ORIGINS`
- HTTPS termination at the cloud platform, load balancer, or reverse proxy

Secrets must not be committed to the repository.

## Existing Foundation

- Device identity exists in local SQLite.
- Authorized device records exist in PostgreSQL.
- Users and roles exist in PostgreSQL.
- Branch and counter records exist in PostgreSQL.
- Local outbox exists in SQLite.
- Sync push and pull endpoints exist in the backend.
- Operation idempotency exists through `sync_processed_operations.operation_id`.
- Conflict records exist through `sync_conflict_log`.
- Device sync timestamps and statuses exist on authorized devices.
- Health endpoints exist for backend status checks.

## Safe Schema Foundation Plan

Do not apply destructive migration steps for Phase 4B.1. The following should be introduced only through idempotent additive migrations after a verified database backup:

- `company_id`
- `sub_branch_id`
- explicit `idempotency_key`
- explicit `conflict_status`
- normalized `sync_status`
- `retry_count`
- `error_message`
- `created_at`
- `updated_at`

Current code already has `branch_id`, `device_id`, `user_id`, `operation_id`, local outbox status, and backend processed-operation idempotency through `sync_processed_operations.operation_id`. It does not yet have first-class `company_id`, `sub_branch_id`, `idempotency_key`, or `conflict_status` across business and sync tables.

## Current Sync Coverage

Verified foundation coverage:

- `sync_test`
- `pos_sale` create
- `pos_sale` edit
- `pos_sale` cancel
- Pull to local SQLite for product categories
- Pull to local SQLite for products and sale-rate reference changes
- Pull to local SQLite for sync test records

Not fully covered as bidirectional real cloud sync:

- Products
- Product categories
- Lots
- Stock
- POS sales beyond the current foundation paths
- Edited sales beyond the current foundation paths
- Cancelled sales beyond the current foundation paths
- Purchases
- Pending bills
- Supplier ledgers
- Customer ledgers
- Payments
- Expenses
- Waste
- Returns
- Reports source data
- Settings
- Permissions
- Branches
- Users

## Field Remote Device Stop Point

`FIELD_REMOTE_DEVICE` is required for mandi/purchase trips and other work outside shop LAN. It is not ready in the current product.

Field remote must not depend on a branch LAN IP. It requires:

- Hosted cloud backend URL
- Hosted PostgreSQL
- HTTPS
- CORS
- authenticated user/device/branch/company identity
- purchase offline outbox
- stock arrival sync
- supplier bill draft sync
- payment note sync if permitted
- idempotent purchase operation IDs
- conflict handling when the same purchase/lot is edited from multiple devices

Until those are implemented and verified in the installed app, owner-facing status must remain not ready.

## Multi-Device Risks

- LAN mode is not the same as cloud mode. It only works on the same shop network.
- Real cloud cannot be tested until a hosted backend and hosted PostgreSQL exist.
- `CLOUD_DATABASE_URL` is not consumed by the current backend yet; cloud database configuration currently uses `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`.
- Multi-device offline selling from the same lot can conflict when devices reconnect.
- Stock reservations are not implemented.
- Full owner/admin conflict review UI is not complete.
- Branch/user/device enforcement exists as a foundation, but all business routes need cloud-mode hardening before multi-branch production use.
- Current sync status screen includes Branch and Device in the simple owner rows.

## Required Test Plans

### A. Single-Machine Local Test

1. Configure `LOCAL_SINGLE_DEVICE`.
2. Start backend on `http://127.0.0.1:5000`.
3. Launch installed Windows app.
4. Verify internet status, local server status, Cloud Not Configured, and Cloud sync not active.
5. Turn internet off manually and verify status changes without restart.
6. Create local POS sale while offline if supported.
7. Restore connectivity.
8. Verify pending sync count does not duplicate.

### B. LAN Multi-Device Shop Test

1. Start backend on the main shop computer.
2. Find the main shop computer LAN IP.
3. Allow firewall access to backend port 5000.
4. Configure each shop device API base to `http://MAIN-LAPTOP-IP:5000`.
5. Open `http://MAIN-LAPTOP-IP:5000/api/health` from each device.
6. Verify login and POS/reference data loads on each device.
7. Create a sale on one device.
8. Verify the other devices see the sale/stock update if that workflow is supported by the selected runtime mode.
9. Record limitations clearly: this is same-network shop-server mode, not real cloud.

### C. Real Cloud Multi-Device Test

1. Deploy hosted backend.
2. Configure hosted PostgreSQL.
3. Configure HTTPS and CORS.
4. Configure app as `CLOUD_PRODUCTION` with real `VITE_CLOUD_API_URL`.
5. Verify hosted `/api/health` from a browser outside the shop network.
6. Configure at least three devices to use cloud mode.
7. Device A creates product/lot after that entity sync is implemented.
8. Device B sees product/lot.
9. Device C creates sale.
10. Device A and Device B see updated stock.
11. Device B goes offline, creates sale, then reconnects.
12. Device B pushes the queue once.
13. Other devices pull the update.
14. Duplicate operation submission is processed once only.
15. Conflict handling is verified.
16. Branch/user/device permissions are verified.

## Stop Point

Stop before marking real cloud working until all are true:

- Hosted backend is live.
- Hosted PostgreSQL is connected.
- Hosted `/api/health` works from a normal browser.
- App `CLOUD_PRODUCTION` mode reaches the hosted backend.
- Multiple devices verify push/pull sync.
- Duplicate sync rows are not created.
- Conflict handling is proven with real multi-device cases.
