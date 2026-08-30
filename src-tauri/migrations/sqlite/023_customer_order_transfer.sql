-- An order can move between branches.
--
-- Migration 022 put customer orders on the sync road. What it did not settle is *which* branch an
-- order belongs to: the order simply inherited the branch of the device that typed it in, and there
-- was no way to move it. The maintainer's ruling (docs/order-routing-decision.md, 2026-08-27) is
-- that an order has two distinct branches and that conflating them is why it could not be moved:
--
--   * **where it was taken** — the branch that answered the phone. Provenance; never changes.
--   * **which branch is fulfilling it** — who packs it, whose stock is reserved, whose counters see
--     it. Authoritative for sync scoping and for stock reservation.
--
-- `branch_id` KEEPS ITS NAME and becomes the fulfilment branch. That is not cosmetic. The server's
-- `logSyncChange` scopes every change row by the branch on the change, and the pull predicate
-- filters on `branch_id`; so as long as fulfilment lives in that column, moving an order is an
-- ordinary field change and the transport needs no modification at all. Naming a new
-- `fulfilment_branch_id` column instead would mean teaching the whole sync road to scope by a
-- different column — much more code, and every line of it a chance to leak an order, with a
-- customer's name, mobile and delivery address on it, to a branch that has no business seeing it.
--
-- `branch_id` is still INTEGER here while every other local table stores branch ids as TEXT, and it
-- is still deliberately NOT rebuilt — for the reasons migration 022 sets out, which have not
-- changed: a SQLite column-type change means rebuilding the table and copying every row, nothing in
-- the codebase joins order `branch_id` against another table's, and the conversion is done at the
-- sync boundary in local_db.rs where the wire value has to be text anyway. The two new branch
-- columns below are TEXT, matching the rest of the codebase and the wire.
--
-- Idempotent across restarts by version-gating in apply_migration(). SQLite has no
-- ADD COLUMN IF NOT EXISTS, so this file is not safe to run twice on its own — the gate is what
-- makes it idempotent, as for every other ALTER-bearing migration here. Forward-only: never edit
-- this file once it has been applied anywhere.


-- Provenance. Who answered the phone, set once when the order is taken and never changed by a
-- transfer. It is not used for sync scoping or for reservation — both of those read `branch_id` —
-- so it is safe for it to name a branch this device is not. It exists so that "we took this order"
-- and "we are packing this order" stop being the same statement.
ALTER TABLE local_customer_orders ADD COLUMN taken_at_branch_id TEXT;

-- Where the order went, recorded on the branch that lost it.
--
-- Set by the pull path when a TRANSFER_OUT change arrives (see
-- `apply_pulled_customer_order_with_tx`). A transfer writes two change-log rows carrying the same
-- entity_version — a TRANSFER_OUT scoped to the old branch and an UPSERT scoped to the new one —
-- because the old branch's devices only pull rows matching their own branch and would otherwise
-- never be told the order had left. They would go on showing it as open work for ever, and two
-- branches would both believe they owed the same customer a delivery.
--
-- TRANSFER_OUT is deliberately not DELETE. "This order was cancelled" and "this order is now the
-- other branch's" are different facts, and a counter told the wrong one rings the wrong customer.
-- The soft delete is what releases the reserved stock — reservations are summed by
-- `reservedQuantityByProduct` over the orders the board loads, and the board loads
-- `deleted_at IS NULL`, so the release falls out of the existing rule rather than being a second
-- mechanism that could disagree with it. These two columns are what stop the order from appearing
-- to have simply vanished.
ALTER TABLE local_customer_orders ADD COLUMN transferred_to_branch_id TEXT;

ALTER TABLE local_customer_orders ADD COLUMN transferred_away_at TEXT;

-- Backfill, and it is not a guess. Every order in any database today was typed in on a device at
-- the branch that is handling it — there was no way to move one — so provenance and fulfilment
-- genuinely coincide on every existing row. Leaving them NULL would claim we do not know where
-- these orders were taken, which is false.
--
-- `taken_at_branch_id` is TEXT and `branch_id` is INTEGER: SQLite applies the target column's
-- affinity on UPDATE, so a numeric branch is stored here as its text form, which is the shape the
-- rest of the codebase and the wire use. Rows with no branch at all stay NULL, which is the honest
-- answer for an order whose branch was never resolved (migration 022 marks those `blocked`).
UPDATE local_customer_orders
SET taken_at_branch_id = branch_id
WHERE taken_at_branch_id IS NULL
  AND branch_id IS NOT NULL;

-- "What has left this branch, and when" — the query behind an operator asking where an order they
-- remember taking has gone. Partial, because a transferred-away order is a small minority of the
-- table and every other row is never an answer.
CREATE INDEX IF NOT EXISTS idx_local_customer_orders_transferred_away
  ON local_customer_orders (transferred_away_at, transferred_to_branch_id)
  WHERE transferred_away_at IS NOT NULL;
