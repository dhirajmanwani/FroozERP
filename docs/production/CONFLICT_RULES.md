# Conflict Rules

## Financial Entities

Financial entities must not use silent last-write-wins.

Current Phase 2 behaviour:

- Invalid POS sale sync payloads are rejected as `conflict`.
- The local invoice operation remains in the local outbox with conflict status.
- The server writes a `sync_conflict_log` row for owner review.
- Live sales, stock and payment tables are not mutated by conflicted operations.

## Reference Entities

Reference entities use versioned pull records:

- Product categories.
- Products.
- Sale-rate reference changes.

Reference changes are applied locally through repository/Tauri commands. Future local edits that collide with newer server versions should create local `sync_conflicts` records instead of overwriting financial data.

## Temporary Stock Policy

Multiple offline devices may sell from the same lot. For Phase 2 foundation:

- Server-side POS stock validation is not enabled for live tables yet.
- POS sale sync payloads are staged in `sync_pos_sale_staging`.
- Invalid or impossible payloads are rejected/conflicted.
- Server stock is never silently allowed to go negative through the Phase 2 sync foundation.

True multi-device offline selling from the same lot still requires operational controls or reservation logic in a later phase.
