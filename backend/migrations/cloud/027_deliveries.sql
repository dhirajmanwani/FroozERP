-- 027 (22 Nov 2026): the Delivery module's cloud half -- each order's deliveries, and each
-- branch's delivery settings.
--
-- ## What this carries
--
-- customer_orders.deliveries (JSONB, NULL by default) holds every delivery attempt of the order
-- with its status events, exactly as `backend/customerOrderDeliveries.js` sanitised it from the
-- device's order push. Deliveries travel inside the order's whole-record sync and nowhere else, so
-- this one column is what lets a delivery booked on one counter be seen on the others. NULL means
-- no device has ever sent the field for this order; the push handler keeps the stored value when a
-- push omits it (an older app version), so an old counter cannot wipe them.
--
-- delivery_settings is one row per (company, branch): pickup address and pin, areas with a usual
-- charge, WhatsApp templates and the defaults, as one JSONB object (`backend/deliverySettings.js`
-- decides its shape; no CHECK here, as 023/024/025 decided for their kinds). Written only by the
-- Owner or an Admin through PUT /api/v3/delivery-settings. Timestamps are TIMESTAMPTZ from the
-- start, so 008 never has to retype them (see 026).
--
-- ## Why this file exists
--
-- Every statement below is declared in `initializeDatabase()`, word for word, and the startup
-- bootstrap is switched off on a hosted deployment. Without this file neither the column nor the
-- table reaches the cloud: `verifyDeclaredSchema` refuses to start the backend, and once it did
-- every order push would 500 on the missing column.
--
-- Additive only: no existing row is inserted, updated or deleted. IF NOT EXISTS throughout, so the
-- runner can replay it (it applies the whole list every time). Forward-only. Never edit this file
-- once it has been applied anywhere. Requires 015 (customer_orders).
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS deliveries JSONB;
CREATE TABLE IF NOT EXISTS delivery_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  branch_id INTEGER NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (company_id, branch_id)
);
