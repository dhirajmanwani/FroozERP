-- The POS shelf the owner chose for a product.
--
-- `products.pos_section` in the cloud: 'retail', 'bar' or 'moments' when the owner has put the
-- product on a shelf by hand, NULL when the till should decide by itself (automatic). It reaches a
-- device in product sync payloads and in the reference bootstrap, and the reference snapshot emits
-- it on every product for the frontend to read.
--
-- NULL means "automatic" — every row that predates this migration, and every product the owner
-- never placed. It is never a value to be guessed into: an absent key in a pulled payload keeps
-- whatever is stored, and only an explicit null clears it back to automatic.
--
-- Idempotent across restarts by version-gating in apply_migration(), which skips any version
-- already recorded APPLIED in local_schema_migrations. SQLite has no ADD COLUMN IF NOT EXISTS, so
-- this file is not safe to execute twice on its own — the gate is what makes it idempotent, exactly
-- as for every other ALTER-bearing migration in this directory. Forward-only: never edit this file
-- once it has been applied anywhere. In SQLite an ADD COLUMN with no default is an O(1) catalogue
-- change, not a table rebuild.

ALTER TABLE local_products ADD COLUMN pos_section TEXT;
