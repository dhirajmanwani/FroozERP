-- Was the bill paid, before the parcel goes out?
--
-- The maintainer's requirement, 2026-08-22: "when I get an order, the app should ask me first if
-- the bill amount is paid before sending the parcel." Stated for website orders, but it is the same
-- question for the phone and WhatsApp orders arriving today — and the answer has never been recorded
-- anywhere, so a parcel could leave with nobody knowing whether money had changed hands.
--
-- Three answers, not two. "Paid" and "unpaid" would force a lie for the ordinary case where the
-- customer pays the carrier on the doorstep: that is neither, and calling it unpaid would put every
-- cash-on-delivery order on a list of problems. `ON_DELIVERY` is a decision that has been taken;
-- `UNPAID` means nobody has decided yet, and it is the state that must stop a parcel.
--
-- The gate belongs on SENT rather than on PACKED. Packing is reversible and costs nothing; sending
-- is the step that puts goods in a stranger's hands, and it is also the step that raises the bill.
--
-- Idempotent across restarts by version-gating in apply_migration(). SQLite has no
-- ADD COLUMN IF NOT EXISTS, so this file is not safe to run twice on its own — the gate is what
-- makes it idempotent, as for every other ALTER-bearing migration here. Forward-only: never edit
-- this file once it has been applied anywhere.

-- NULL rather than a DEFAULT of 'UNPAID' on purpose. Orders written before this migration were
-- taken under a workflow that never asked the question, and stamping them 'UNPAID' would assert
-- something nobody checked. NULL says "never asked", which is the truth, and the app treats it the
-- same as UNPAID for the purpose of stopping a parcel while still reading differently in a report.
ALTER TABLE local_customer_orders ADD COLUMN payment_state TEXT
  CHECK (payment_state IS NULL OR payment_state IN ('UNPAID', 'PAID', 'ON_DELIVERY'));

-- What was actually taken, which is not always the order total: part payments and advances are
-- normal in this trade, and a boolean would lose the number entirely.
ALTER TABLE local_customer_orders ADD COLUMN amount_paid REAL;

-- How it came in — UPI reference, "cash to Suresh", a bank transfer note. Free text because the
-- useful part is whatever the shop actually wrote down at the time.
ALTER TABLE local_customer_orders ADD COLUMN payment_reference TEXT;

ALTER TABLE local_customer_orders ADD COLUMN payment_marked_at TEXT;

-- "Which parcels went out that nobody has been paid for" — asked whenever the owner chases money.
-- Partial, because a cancelled order is never an answer and settled ones will outnumber the rest.
CREATE INDEX IF NOT EXISTS idx_local_customer_orders_unsettled
  ON local_customer_orders (payment_state, sent_at)
  WHERE payment_state IS NOT 'PAID'
    AND status IN ('SENT', 'DELIVERED')
    AND deleted_at IS NULL;
