-- Other charges on a bill: crate charge, labour charge, delivery charge, and whatever the shop
-- invents next.
--
-- The pricing rules are NOT implemented here or anywhere in Rust. They live in
-- `frontend/src/local/otherCharges.js` and are pinned by `otherCharges.test.mjs`; this file is the
-- offline storage those rules read from and write to, so that a counter with no internet can still
-- price a crate charge. Restating the arithmetic in SQL would give the shop two implementations of
-- the same rule and eventually two different prices for the same crate.
--
-- Nothing is hardcoded to the three charges the maintainer named. A charge type is a row; the unit
-- is whatever the shop typed (kg, km, days, trips); adding "hamali charge" is one INSERT.
--
-- Three of the rules decide the shapes below, and the columns exist to keep them true:
--
--   * **A rate of 0 is a rate.** `flat_rate` and `charge_rate_slabs.rate` allow 0 and are only
--     refused below 0. A shop offering free delivery inside 5 km is a real thing.
--   * **A missing rate is not a rate of 0.** `flat_rate` is NULLABLE and has NO DEFAULT. NULL means
--     "nobody set a price", which `resolveChargeRate` reports as NO_RATE. A `DEFAULT 0` here would
--     turn every half-configured charge into a free one, silently, on every bill.
--   * **A measurement past the top slab has no price.** That refusal is decided in JS from the
--     slabs; the storage's only job is to hand over every slab, in full, so the refusal can be
--     computed. There is deliberately no "fallback rate" column: a column like that is exactly how
--     a 40 km delivery quietly becomes a 15 km one.
--
-- Charges are not taxed. They are added after Mandi Tax, so `other_charges_amount` sits beside
-- `tax_total` on the invoice and never enters `taxable_amount`.
--
-- ## Column names mirror Postgres on purpose
--
-- The cloud side of this feature uses `charge_types`, `charge_rate_slabs`, `sale_charges` and
-- `sales.other_charges_amount`. The tables here carry the same column names — including
-- `local_sale_charges.sale_id`, which holds the local invoice id that every OTHER child table in
-- this schema calls `invoice_id`. The mismatch is deliberate and it is the lesser evil: the sync
-- payload crosses this boundary in both directions on every push and pull, and a translation layer
-- is a place for `charge_type_id` to be renamed into something that no longer matches on the other
-- side. Identifiers are opaque strings and are never coerced to numbers — `"004"` and `4` are
-- different charge types.
--
-- Idempotent across restarts by version-gating in apply_migration(). SQLite has no
-- ADD COLUMN IF NOT EXISTS, so this file is not safe to run twice on its own — the gate is what
-- makes it idempotent, as for every other ALTER-bearing migration here. Forward-only: never edit
-- this file once it has been applied anywhere.


-- A charge the shop has set up. One row per kind of charge, not per bill.
CREATE TABLE IF NOT EXISTS local_charge_types (
  id TEXT PRIMARY KEY,
  cloud_id TEXT,
  company_id TEXT,
  branch_id TEXT,

  charge_name TEXT NOT NULL,
  -- A short code the shop may use on a printed bill. Optional: the maintainer names charges, he
  -- does not code them, and requiring one would be a field to skip past on every new charge.
  charge_code TEXT,

  -- FLAT: one price however much there is of it. SLAB: the price depends on a measurement.
  -- Constrained, because a third value would be priced by neither path and would land on the bill
  -- as nothing at all.
  basis TEXT NOT NULL DEFAULT 'FLAT' CHECK (basis IN ('FLAT', 'SLAB')),

  -- The unit the SHOP named — kg, km, days, trips. Never a fixed list: the whole point is that the
  -- next charge is one the maintainer invents.
  measure_unit TEXT,

  -- NULLABLE, no default, and that is the point. See the header: NULL is "no rate set" and must
  -- reach the POS as a refusal. Only a genuinely-typed 0 means free.
  flat_rate REAL CHECK (flat_rate IS NULL OR flat_rate >= 0),

  active INTEGER NOT NULL DEFAULT 1,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  deleted_at TEXT
);

-- "Up to and including this measurement, charge this rate."
--
-- `upto_value > 0`: a slab with no usable threshold cannot be matched by any measurement, and
-- normaliseSlabs() drops it rather than sorting it into an arbitrary place. Storing one would only
-- make the two sides disagree about how many slabs a charge has.
--
-- `rate >= 0` and NOT NULL: 0 is a valid rate, absent is not. An absent rate on a slab that a
-- measurement matches would price that bracket at nothing.
CREATE TABLE IF NOT EXISTS local_charge_rate_slabs (
  id TEXT PRIMARY KEY,
  cloud_id TEXT,
  charge_type_id TEXT NOT NULL REFERENCES local_charge_types(id) ON DELETE CASCADE,
  upto_value REAL NOT NULL CHECK (upto_value > 0),
  rate REAL NOT NULL CHECK (rate >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  version INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'synced',
  deleted_at TEXT
);

-- What a particular bill was actually charged.
--
-- Every field a bill needs to explain itself later is copied onto the row rather than joined back
-- to the charge type: the name, the unit, the measurement, the rate and whether the number was
-- typed by hand. A charge type renamed or re-slabbed next month must not silently rewrite what a
-- customer was told in March, and `charge_type_id` alone cannot survive the charge type being
-- deleted. So the id is kept (nullable — a hand-entered charge may not have one) AND the facts are
-- kept beside it.
--
-- `quantity` and `measurement` are different numbers, and conflating them is the arithmetic
-- mistake this shape invites: four 10 kg crates is 4 x 40, not one 4 kg crate. They are separate
-- columns for that reason, and `measurement` is nullable because a flat charge has none.
--
-- `rate` is NOT NULL. A charge that could not price itself never becomes a row here — the POS
-- shows the refusal instead. There is no such thing as a stored charge line with no rate.
CREATE TABLE IF NOT EXISTS local_sale_charges (
  id TEXT PRIMARY KEY,
  -- The local invoice this charge is on. Named `sale_id` to match the cloud column; it holds the
  -- same value that every other child table here calls `invoice_id`.
  sale_id TEXT NOT NULL REFERENCES local_pos_invoices(id) ON DELETE CASCADE,
  line_index INTEGER NOT NULL DEFAULT 0,

  charge_type_id TEXT,
  charge_name TEXT NOT NULL,
  measure_unit TEXT,
  measurement REAL,
  quantity REAL NOT NULL DEFAULT 1 CHECK (quantity > 0),
  rate REAL NOT NULL CHECK (rate >= 0),
  amount REAL NOT NULL CHECK (amount >= 0),

  -- The number was typed by a person, not derived from a slab. This is how a shop prices the 40 km
  -- trip today instead of after a settings change, and a bill has to be able to say where its
  -- number came from.
  manual INTEGER NOT NULL DEFAULT 0,
  -- Which slab priced it, when one did. Kept so a bill can be explained after the slabs move.
  slab_upto REAL,

  entity_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (sale_id, line_index)
);

-- What the charges on this bill add up to. Sits beside tax_total and outside taxable_amount:
-- charges land after Mandi Tax and never enter it.
--
-- DEFAULT 0 is right here and wrong on `flat_rate`, and the difference is worth saying: a bill with
-- no charge lines genuinely had no charges, so 0 is the true total. A charge type with no rate has
-- not been priced at all, and 0 would be a lie about it.
ALTER TABLE local_pos_invoices ADD COLUMN other_charges_amount REAL NOT NULL DEFAULT 0;

-- "What is on this bill" — asked every time a bill is reloaded, reprinted, edited or pushed.
CREATE INDEX IF NOT EXISTS idx_local_sale_charges_sale
  ON local_sale_charges (sale_id, line_index);

-- "What are this charge's slabs, smallest first" — the read behind every priced crate and every
-- refused delivery. Ordered by threshold because that is the order the matching rule needs.
CREATE INDEX IF NOT EXISTS idx_local_charge_rate_slabs_type
  ON local_charge_rate_slabs (charge_type_id, upto_value)
  WHERE deleted_at IS NULL;

-- "What charges can this counter offer" — the POS panel's own query.
CREATE INDEX IF NOT EXISTS idx_local_charge_types_active
  ON local_charge_types (active, charge_name)
  WHERE deleted_at IS NULL;
