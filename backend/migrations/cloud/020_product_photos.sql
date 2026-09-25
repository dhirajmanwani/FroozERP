-- `product_photos`: one photo per product.
--
-- ## Why a table of its own, and not a column on `products`
--
-- The whole `products` row is copied into `sync_change_log` and `product_audit_trail` on every
-- product edit, and sent to every device in the reference bootstrap. A photo stored on that row
-- would be multiplied into all of them: a 200 KB image, times every price change, times every
-- counter. Kept here, the bytes exist exactly once per product and travel through exactly one
-- route, `GET /api/v3/product-photos`. Nothing may copy `photo_data` into `sync_change_log`,
-- `product_audit_trail` or any other log; the audit row for a photo change records its
-- `content_type` and `byte_size` only.
--
-- ## Why this file exists
--
-- The table is declared in `initializeDatabase()` like everything else, and `initializeDatabase()`
-- is switched off on a hosted deployment. Without this file the table never appears on the cloud,
-- `verifyDeclaredSchema` refuses to start the backend, and that is the fifth time this shape of gap
-- would have been written down (see 014, 015/016, 018 and 019). This file is the only way the
-- table reaches that database.
--
-- Forward-only. Never edit this file once it has been applied anywhere.

-- Exactly the statements from the startup bootstrap, so the two paths cannot drift. IF NOT EXISTS
-- keeps this safe to re-run (the runner replays the whole list every time) and safe on a database
-- that was bootstrapped locally and already has the table.
--
-- `product_id` is the primary key, which is what makes it one photo per product: a second upload
-- replaces the first. ON DELETE CASCADE because a photo of a product that no longer exists is not
-- business data anyone can reach.
--
-- `company_id` is copied from the product when the photo is saved, so the company-scoped list read
-- can be answered from this table's own index. The route also checks the product's own company,
-- so this copy is never the only thing standing between one shop and another shop's photos.
CREATE TABLE IF NOT EXISTS product_photos (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  company_id INTEGER,
  photo_data TEXT NOT NULL,
  content_type VARCHAR(40) NOT NULL,
  byte_size INTEGER NOT NULL,
  updated_by INTEGER,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS product_photos_company_idx
  ON product_photos (company_id);

-- `products` itself is not created here. It is in the 2026-09-21 schema baseline, so the hosted
-- database necessarily has it; if it were absent, the foreign key raising
-- `relation "products" does not exist` is the louder and better failure.
