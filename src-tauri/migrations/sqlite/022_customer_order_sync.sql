-- Customer orders join the sync road.
--
-- Orders written by migration 020 stop on the device that took them: `save_customer_order_at` and
-- `set_customer_order_status_at` write their rows and enqueue nothing, so an order taken at one
-- counter is invisible at every other counter and in the cloud. This migration adds the three
-- things the device half of that road needs, and one thing the pull half needs so that it can
-- never again lose a change without saying so.
--
-- Idempotent across restarts by version-gating in apply_migration(). SQLite has no
-- ADD COLUMN IF NOT EXISTS, so this file is not safe to run twice on its own — the gate is what
-- makes it idempotent, as for every other ALTER-bearing migration here. Forward-only: never edit
-- this file once it has been applied anywhere.
--
-- `branch_id` is deliberately NOT rebuilt here. It is INTEGER on this table while every other local
-- table uses TEXT, which is wrong, but changing a SQLite column's type means rebuilding the table
-- and copying every row — and nothing in the codebase joins order `branch_id` against another
-- table's, so the mismatch cannot currently produce a wrong answer. The conversion is done at the
-- sync boundary in local_db.rs instead, where the wire value has to be text anyway. A table rebuild
-- is a bigger risk than the problem it would solve.


-- The version the sync contract is built on: a monotonically increasing integer per order, bumped
-- on every local mutation, carried on the outbox row and compared by the pull path before an
-- incoming copy is allowed to overwrite a local one. Without it, a status change racing an older
-- copy of the same order from another device would be decided by arrival order, and the losing
-- change would be the one that happened last.
ALTER TABLE local_customer_orders ADD COLUMN entity_version INTEGER NOT NULL DEFAULT 1;

-- Where this order stands with the cloud. Three values, and the third is the point:
--
--   'pending' — an outbox row exists for the current entity_version and is waiting to be pushed.
--   'synced'  — this copy came from, or has been confirmed by, the cloud.
--   'blocked' — deliberately NOT queued, with `sync_blocked_reason` saying why.
--
-- 'blocked' exists because the server's logSyncChange throws on a change with no branch id, and a
-- push batch is one Postgres transaction: one branchless order would discard the acknowledgements
-- for every other operation in the batch. So an order whose branch cannot be resolved must not be
-- allowed onto the outbox at all. It must also not vanish into a silent never-synced state, which
-- is the failure CLAUDE.md names — an error has to have a name. This column is that name.
ALTER TABLE local_customer_orders ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (sync_status IN ('pending', 'synced', 'blocked'));

ALTER TABLE local_customer_orders ADD COLUMN sync_blocked_reason TEXT;

-- Orders written before this migration have no outbox row and never will until something touches
-- them again. Leaving them 'pending' would claim they were queued, which is not true. They are
-- marked blocked with the actual reason, and the next status change re-attempts the enqueue.
UPDATE local_customer_orders
SET sync_status = 'blocked',
    sync_blocked_reason = 'Written before customer orders could sync. It will be queued the next time its status changes.'
WHERE sync_status = 'pending';

-- "Which orders are not going anywhere" — the query a person needs when the board looks fine and
-- the cloud is empty.
CREATE INDEX IF NOT EXISTS idx_local_customer_orders_sync_blocked
  ON local_customer_orders (sync_status, created_at)
  WHERE sync_status = 'blocked'
    AND deleted_at IS NULL;


-- Changes the pull path could not apply, kept rather than dropped.
--
-- `apply_change_with_tx` ended in `_ => {}`: an entity_type this build does not recognise was
-- discarded with no error and no log, while `apply_pull_changes_at` advanced the pull cursor in the
-- same transaction regardless. A change consumed by that arm was never offered again — so a server
-- that started emitting a new entity type would have its rows destroyed on every older device while
-- sync went on reporting itself healthy.
--
-- The fix is not to make an unknown type fatal: a device running older code still has to be able to
-- sync everything else it does understand. The fix is that nothing is thrown away silently. The
-- change is written here in full, so it is visible, countable, and replayable after an upgrade.
--
-- The id is derived from the change rather than from the clock so that a replay of the same change
-- updates the existing row instead of accumulating duplicates.
CREATE TABLE IF NOT EXISTS local_unapplied_changes (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  version INTEGER,
  -- The whole change as it arrived. This is the part that makes the row a recovery path and not
  -- just a complaint: an upgraded build can read these back and apply them.
  payload TEXT NOT NULL,
  updated_at TEXT,
  reason TEXT NOT NULL,
  detail TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  seen_count INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_local_unapplied_changes_type
  ON local_unapplied_changes (entity_type, last_seen_at);
