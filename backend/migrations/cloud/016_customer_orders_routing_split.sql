-- The four statements migration 015 left behind.
--
-- 015 copied the `CREATE TABLE` for five tables out of `initializeDatabase()` and stopped there.
-- But a table in that function is not only its CREATE TABLE: `customer_orders` is followed by an
-- added column, a backfill, two ALTER COLUMNs and a third index, and those carry the whole order
-- routing split. Copying the CREATE alone reproduced the table as it looked before that work.
--
-- The drift checker found the added column the moment 015 landed -- it hides columns of a table
-- that does not exist yet, so `customer_orders.taken_at_branch_id` only became visible once the
-- table did. It cannot see the other three at all: it compares tables and columns, so a column
-- that exists with the wrong nullability and the wrong default reads to it as present.
--
-- ## What the two ALTER COLUMNs are for
--
-- 015 created `branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id)`, which is what the
-- bootstrap's CREATE TABLE still says. The statements below are the correction that follows it:
-- an unassigned order -- a website order, a WhatsApp to the company number -- has no fulfilment
-- branch yet, and `NOT NULL DEFAULT 1` answers that by inventing branch 1. That is exactly the
-- confusion `docs/order-routing-decision.md` exists to prevent. A NULL that admits there is no
-- answer is safer than a default that fabricates one, and it is also what keeps unassigned orders
-- off the sync road for free: `logSyncChange` already throws without a branch id.
--
-- So between 015 and this file the hosted database would have accepted an unassigned order onto
-- branch 1 and put it on the sync road. No such order can have been written yet -- the table was
-- empty when 015 created it, and the module that writes them has never reached a device -- but the
-- window is the reason this is a separate migration applied immediately rather than an edit to 015.
--
-- Both ALTER COLUMNs are idempotent: dropping a NOT NULL that is already dropped, or a default
-- that is already absent, is a no-op in Postgres. So is the backfill, which is bounded by its
-- WHERE clause.
--
-- Copied verbatim from `initializeDatabase()`, and `backend/schemaDrift.test.js` now compares
-- every statement in that function that names a table these migrations create -- not just its
-- CREATE TABLE -- so the same omission cannot be made again.
--
-- Forward-only. Never edit this file once it has been applied anywhere.

-- One field was doing two jobs. See docs/order-routing-decision.md: an order has a branch that
-- *took* it and a branch that is *fulfilling* it, and conflating them is why an order could
-- never be moved. "branch_id" keeps its name and becomes the fulfilment branch -- because
-- "logSyncChange" and the pull predicate both scope by that column, so fulfilment living there
-- is what makes a transfer an ordinary field change instead of a new transport.
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS taken_at_branch_id INTEGER REFERENCES branches(id);

-- Provenance for every row written before the split. Not a guess: an order could only be typed
-- in on a device at the branch that was handling it, so for existing rows the two genuinely
-- coincide.
UPDATE customer_orders SET taken_at_branch_id = branch_id
 WHERE taken_at_branch_id IS NULL AND branch_id IS NOT NULL;

-- An unassigned order -- a website order, a WhatsApp to the company number -- has no fulfilment
-- branch yet. "NOT NULL DEFAULT 1" answered that question by inventing branch 1, which is
-- exactly the confusion the routing decision exists to prevent. A NULL that admits there is no
-- answer is safer than a default that fabricates one, and it is also what keeps unassigned
-- orders off the sync road for free: "logSyncChange" already throws without a branch id.
ALTER TABLE customer_orders ALTER COLUMN branch_id DROP NOT NULL;
ALTER TABLE customer_orders ALTER COLUMN branch_id DROP DEFAULT;

CREATE INDEX IF NOT EXISTS customer_orders_unassigned_idx
  ON customer_orders (company_id, created_at)
  WHERE branch_id IS NULL AND deleted_at IS NULL;
