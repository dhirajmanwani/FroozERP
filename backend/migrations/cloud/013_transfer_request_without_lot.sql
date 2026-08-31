-- A branch can ask another branch for stock without naming the crate.
--
-- `docs/stock-distribution-decision.md` records the maintainer's ruling that branches may request
-- stock from each other, with the branch that holds the stock deciding whether to accept.
--
-- The engine already had the direction: `initiation_mode = 'DESTINATION_REQUESTED'`, where the
-- *source* branch performs approve and reject. What it did not have was a way to write the request
-- down. `inventory_transfer_items.source_lot_id` was `NOT NULL`, so the asking branch had to name
-- the exact inventory lot it wanted -- a lot belonging to the other branch, which its device
-- deliberately cannot see. The stock scoping that makes a counter safe is precisely what made the
-- request unfillable.
--
-- The business answer is also the simpler one. A person asks for "10 kg of apples"; the branch
-- holding the fruit decides which crates to send, because it is the one standing in front of them.
-- Lots are not interchangeable -- each carries its own purchase cost, and that cost travels with
-- the fruit and lands in the receiving branch's margin -- so *which* crate still has to be recorded.
-- It is recorded at approval instead of at request.
--
-- Forward-only. Never edit this file once it has been applied anywhere.

-- Nullable, not dropped. An approved item still names its lot, and every row written before this
-- migration keeps the one it has.
ALTER TABLE inventory_transfer_items ALTER COLUMN source_lot_id DROP NOT NULL;

-- The rule the column can no longer enforce on its own, stated where it cannot be forgotten:
-- stock may not be reserved, dispatched or received against an item that names no crate. Without
-- this a NULL lot silently means "nothing moved", because `applyTransferStockEffect` joins items to
-- `inventory_batches` and an unallocated row simply vanishes from the result set -- the transfer
-- would advance through approve and dispatch having moved no fruit at all, and reported success.
ALTER TABLE inventory_transfer_items
  DROP CONSTRAINT IF EXISTS inventory_transfer_items_allocated_before_movement;
ALTER TABLE inventory_transfer_items
  ADD CONSTRAINT inventory_transfer_items_allocated_before_movement
  CHECK (
    source_lot_id IS NOT NULL
    OR (
      approved_quantity = 0
      AND reserved_quantity = 0
      AND dispatched_quantity = 0
      AND received_quantity = 0
    )
  );

-- "Which requests are still waiting for somebody to choose crates" -- the queue the approving
-- branch works from.
CREATE INDEX IF NOT EXISTS inventory_transfer_items_unallocated_idx
  ON inventory_transfer_items (transfer_id)
  WHERE source_lot_id IS NULL;
