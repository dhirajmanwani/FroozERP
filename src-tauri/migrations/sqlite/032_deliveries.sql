-- Deliveries: getting a packed order to the customer by Rapido, Uber or the shop's own staff.
--
-- Built ON TOP OF customer orders (migration 020), not beside them. An order is a delivery when it
-- has a row here; there is deliberately no `is_delivery` flag on `local_customer_orders`, because
-- that table syncs and a second way of saying the same thing would one day disagree with this one.
--
-- Booking stays manual. Rapido and Uber partner APIs sit behind onboarding and minimums, so the
-- operator books in the provider's own app and pastes back the rider, the tracking link and the
-- booking reference. The rules for which move follows which, the closing charge and the overdue
-- flag live in frontend/src/local/deliveryLifecycle.js, where they are tested; local_db.rs re-checks
-- the legal move and the reason rule before writing, because those two guard money and history.
--
-- Sync: deliveries travel INSIDE the order's own sync record (`deliveries` on the customer_order
-- payload), so a delivery change bumps the order's entity_version and queues the whole order in the
-- same transaction. There is no separate delivery entity on the wire. `synced_at` is informational.
--
-- Money is INTEGER paise. `final_paise` NULL means "same as quoted"; closing a delivery with a blank
-- final writes quoted into final, so a closed delivery always states what it cost.
--
-- No FOREIGN KEY clauses, the same choice migration 020 made for its lines: foreign-key enforcement
-- is per connection in SQLite and most connections in local_db.rs do not turn it on, so a declared
-- constraint would be enforced on some paths and not others. The application code that writes these
-- rows is the one place that keeps them consistent. Ids are opaque TEXT (uuid v4), never numbers.
--
-- Delivery settings (pickup address, areas with their usual charge, WhatsApp templates, default
-- paid-by) are one JSON document per branch. Areas live inside it, so there is no delivery_areas
-- table: they sync per branch together with the rest of the settings. It is not stored in the
-- shared settings table, which is wiped and refilled from the cloud on every refresh.
--
-- Idempotent across restarts by construction (CREATE TABLE / CREATE INDEX ... IF NOT EXISTS) and
-- additionally version-gated by apply_migration() in local_db.rs. Forward-only: never edit this file
-- once it has been applied anywhere.


CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  -- `local_customer_orders.id`, as TEXT.
  order_id TEXT NOT NULL,
  -- 1 for the first try; a failed delivery may be followed by attempt 2, and so on.
  attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),

  -- The drop. Copied from the order when the delivery starts and editable after, because the
  -- address a customer gives on the phone is often not the one the rider needs.
  customer_name TEXT,
  customer_phone TEXT,
  address TEXT,
  landmark TEXT,
  area_name TEXT,
  map_link TEXT,

  provider TEXT NOT NULL DEFAULT 'rapido'
    CHECK (provider IN ('rapido', 'uber', 'own_staff', 'other')),
  rider_name TEXT,
  rider_phone TEXT,
  tracking_link TEXT,
  booking_ref TEXT,

  quoted_paise INTEGER CHECK (quoted_paise IS NULL OR quoted_paise >= 0),
  final_paise INTEGER CHECK (final_paise IS NULL OR final_paise >= 0),
  paid_by TEXT NOT NULL DEFAULT 'shop'
    CHECK (paid_by IN ('shop', 'customer')),

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'booked', 'picked_up', 'delivered', 'closed', 'cancelled', 'failed')),
  -- Required (non-blank) for cancelled and failed; enforced in local_db.rs.
  status_reason TEXT,

  booked_at TEXT,
  picked_up_at TEXT,
  delivered_at TEXT,
  closed_at TEXT,
  cancelled_at TEXT,
  failed_at TEXT,

  notes TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  synced_at TEXT,

  UNIQUE (order_id, attempt_no)
);

-- Every move, oldest first. `from_status` is NULL on the creation event. No CHECK on the statuses
-- here: an event is history, and a pulled event naming a status this build does not know must not
-- abort the pull that carries it.
CREATE TABLE IF NOT EXISTS delivery_events (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  at TEXT NOT NULL,
  by_user TEXT,
  note TEXT
);

CREATE TABLE IF NOT EXISTS local_delivery_settings (
  branch_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  -- 1 while this device holds a change the cloud has not accepted yet.
  dirty INTEGER NOT NULL DEFAULT 0 CHECK (dirty IN (0, 1)),
  updated_at TEXT
);

-- "The deliveries of this order": read for every order on the board and in every outbox payload.
CREATE INDEX IF NOT EXISTS idx_deliveries_order
  ON deliveries (order_id);

-- The board and the reports: by status, most recently touched.
CREATE INDEX IF NOT EXISTS idx_deliveries_status_updated
  ON deliveries (status, updated_at);

CREATE INDEX IF NOT EXISTS idx_delivery_events_delivery_at
  ON delivery_events (delivery_id, at);
