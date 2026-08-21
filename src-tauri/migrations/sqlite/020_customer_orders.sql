-- Customer orders: received, packed, sent, delivered.
--
-- G7's order half (docs/product-goals.md §G7). Orders already arrive by phone and WhatsApp and are
-- handled from memory and paper. This is the storage for handling them in the app instead, and it
-- is deliberately the half that needs no cloud, no website and no approvals — the website that will
-- one day also feed this table is gated on exposure, and this is not.
--
-- The rules these columns exist to serve live in frontend/src/local/orderLifecycle.js, which is
-- where they are tested. Two of them were ruled by the maintainer on 2026-08-21 and are the reason
-- the shape is what it is:
--
--   * Accepting an order RESERVES stock. Merely recording an order oversells, and selling fruit you
--     do not have costs a refund and a customer. `reserved_at` exists so a reservation can lapse.
--   * Sending CREATES THE BILL. `sale_id` is where that bill is recorded, and its presence is what
--     makes SENT irreversible: undoing a sent order is a sale return, not a status edit.
--
-- Idempotent across restarts by construction (CREATE TABLE / CREATE INDEX ... IF NOT EXISTS) and
-- additionally version-gated by apply_migration() in local_db.rs. Forward-only: never edit this
-- file once it has been applied anywhere.


CREATE TABLE IF NOT EXISTS local_customer_orders (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL UNIQUE,

  -- Where the order came from. PHONE and WHATSAPP are what happens today; WEBSITE is the one this
  -- table is being built ahead of. Recorded rather than assumed, because "how do people actually
  -- order from us" is a question the owner will want answered later and cannot be reconstructed
  -- afterwards.
  source TEXT NOT NULL DEFAULT 'PHONE'
    CHECK (source IN ('PHONE', 'WHATSAPP', 'WEBSITE', 'COUNTER', 'OTHER')),

  -- Nullable on purpose: a first-time caller has no customer record yet, and forcing one to be
  -- created before the order can be written down would mean the order gets written on paper
  -- instead. The name and number are captured either way so the order is always contactable.
  customer_id TEXT,
  customer_name TEXT NOT NULL,
  customer_mobile TEXT,
  delivery_address TEXT,

  status TEXT NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED', 'PACKED', 'SENT', 'DELIVERED', 'CANCELLED', 'RETURNED')),

  -- When the stock was set aside. The lapse is measured from here rather than from created_at so
  -- that returning a lapsed order to RECEIVED restarts the clock instead of leaving it permanently
  -- expired.
  reserved_at TEXT,

  packed_at TEXT,
  sent_at TEXT,
  delivered_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT,

  -- Who is carrying it and how to follow it.
  --
  -- Deliberately free text plus a link, not an integration. Rapido, Porter and Dunzo all have
  -- partner APIs behind onboarding, approval and minimums; storing what was pasted from whichever
  -- app was used works with every provider at once, costs nothing, and answers the customer's only
  -- real question. It also already describes the "own delivery later" case: an employee on a
  -- scooter is a carrier with a phone number and no link.
  carrier TEXT,
  carrier_reference TEXT,
  tracking_url TEXT,
  carrier_contact TEXT,

  -- The bill raised when the order was sent. NULL until then, and set once.
  sale_id TEXT,
  invoice_no TEXT,

  notes TEXT,
  branch_id INTEGER,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS local_customer_order_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  line_index INTEGER NOT NULL,

  -- TEXT, and never compared as a number. Entity ids in this codebase are opaque strings: CLAUDE.md
  -- records that coercing them with Number() silently emptied the Inventory table, because "004"
  -- and 4 are different products.
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  unit TEXT,
  quantity REAL NOT NULL CHECK (quantity > 0),

  -- The rate agreed when the order was taken, which is not necessarily the rate at the counter on
  -- the day it ships. Produce rates move daily; a customer quoted 80 on Monday is owed 80.
  agreed_rate REAL,

  -- Set at pack time when a specific lot is put in the box. NULL while the order is only a promise
  -- against total stock rather than against a particular lot.
  inventory_lot_id TEXT,

  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (order_id, line_index)
);

-- The board's query: "what is open, oldest first". Partial, because a finished or deleted order is
-- never an answer and there will eventually be far more of those than open ones.
CREATE INDEX IF NOT EXISTS idx_local_customer_orders_open
  ON local_customer_orders (reserved_at, created_at)
  WHERE status IN ('RECEIVED', 'PACKED')
    AND deleted_at IS NULL;

-- "How much of this product is spoken for" — asked for every product whenever available stock is
-- shown, including on the POS screen.
CREATE INDEX IF NOT EXISTS idx_local_customer_order_items_product
  ON local_customer_order_items (product_id, order_id);

CREATE INDEX IF NOT EXISTS idx_local_customer_orders_customer
  ON local_customer_orders (customer_id)
  WHERE deleted_at IS NULL;
