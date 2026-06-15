# Sync API

All sync APIs are served by the existing Node/Express backend. Devices never connect directly to PostgreSQL.

## Health

`GET /api/health`

Returns:

```json
{ "status": "ok", "server_time": "2026-06-15T18:28:46.000Z" }
```

## Register Device

`POST /api/sync/register-device`

```json
{
  "device_id": "FZDEV-...",
  "device_name": "Main Counter",
  "platform": "tauri-windows",
  "app_version": "1.0.0",
  "branch_id": "1"
}
```

Disabled, revoked, pending or unapproved devices cannot sync.

## Push

`POST /api/sync/push`

```json
{
  "user_id": 1,
  "device_id": "FZDEV-...",
  "branch_id": 1,
  "client_timestamp": "2026-06-15T18:28:46.000Z",
  "operations": [
    {
      "operation_id": "uuid-or-stable-id",
      "entity_type": "sync_test",
      "entity_id": "phase2-test-1",
      "operation_type": "UPSERT",
      "version": 1,
      "payload": { "value": "safe test" },
      "created_at": "2026-06-15T18:28:46.000Z"
    }
  ]
}
```

Response:

```json
{
  "acknowledgements": [
    {
      "operation_id": "uuid-or-stable-id",
      "status": "accepted",
      "server_entity_version": 1,
      "server_updated_at": "2026-06-15T18:28:46.916Z",
      "error_code": null,
      "message": "Accepted"
    }
  ]
}
```

Idempotency is enforced by `sync_processed_operations.operation_id`.

### POS Sale Push

`entity_type: "pos_sale"` writes a local-first POS sale to the server after the Tauri SQLite transaction has already completed.

Required payload fields:

```json
{
  "invoice_global_id": "invoice-uuid",
  "offline_invoice_ref": "OFF-20260616-0001",
  "branch_id": "1",
  "device_id": "FZDEV-...",
  "user_id": "1",
  "customer": { "account_id": "", "name": "Walk-in Customer", "mobile": "" },
  "bill_date": "2026-06-16",
  "bill_datetime": "2026-06-16T10:00",
  "payment_mode": "CASH",
  "gross_total": 20,
  "item_discount_total": 0,
  "bill_discount_total": 0,
  "tax_total": 0,
  "net_total": 20,
  "items": [
    {
      "product_id": 1,
      "inventory_batch_id": 10,
      "lot_id": "10",
      "quantity": 2,
      "selling_rate": 10,
      "discount_amount": 0
    }
  ],
  "payments": [
    { "posting_id": "posting-uuid", "mode": "CASH", "amount": 20 }
  ]
}
```

Server behavior:

- Checks `sync_processed_operations.operation_id` before processing.
- Checks existing `sales.global_id` and `sales.offline_invoice_ref` before creating a sale.
- Validates device, branch, user, product, selected lot, payment and stock.
- Creates sale header, sale items, batch allocations, stock transactions, payment rows and customer ledger rows in the same PostgreSQL transaction.
- Rejects insufficient stock as `conflict` and records `sync_conflict_log`.
- Never allows POS sync stock to become silently negative.

## Pull

`GET /api/sync/pull?cursor=0&device_id=<id>&branch_id=1&user_id=1&limit=50`

Response:

```json
{
  "changes": [
    {
      "change_id": 1,
      "entity_type": "product",
      "entity_id": "product-1",
      "operation_type": "UPSERT",
      "version": 1,
      "payload": {},
      "updated_at": "2026-06-15T18:28:46.916Z"
    }
  ],
  "next_cursor": "1",
  "server_time": "2026-06-15T18:28:46.916Z",
  "has_more": false
}
```

Local devices update their cursor only after SQLite transaction application succeeds.
