-- The record behind in-app device activation: one row per `.lic` file ever issued.
--
-- ## Why this table exists
--
-- Offline activation already worked end to end -- `src-tauri/src/entitlement.rs` verifies a
-- signed `.lic`, `src-tauri/tools/sign_activation.rs` can make one -- but only from a maintainer's
-- own machine, by hand, with no memory of what was handed out. The maintainer asked for the other
-- half: "jese me khud hi activate kr sku, koi b device, aur uska time frame b add kr saku, aur
-- track b" -- issue it himself, for any device, with a chosen time frame, and be able to look up
-- afterwards what was issued. This table is the "track b".
--
-- ## What a row is, and what it is not
--
-- A row is evidence that a licence was *issued*. It is not a licence that is *in force*. The
-- decoder on the device is the only authority on that, and it is offline by design: a device that
-- holds a valid file will keep working whatever this table says. So there is deliberately no
-- `status` column and no revocation here. A status column would be a second definition of
-- something already defined by the signed dates, and CLAUDE.md records what happens when one
-- thing has two definitions.
--
-- The live/grace/expired reading is derived from `expires_on` and `grace_until` wherever it is
-- shown, so it cannot go stale in storage.
--
-- ## Why there is no foreign key to `authorized_devices`
--
-- `scripts/retire-devices.mjs` deletes device rows, and that is correct -- a retired counter
-- should leave the device list. The record of a licence issued to it must outlive that, which is
-- exactly what a foreign key would prevent. `device_name` is therefore captured at issue time
-- rather than joined at read time: it answers "which machine was this for" even after the device
-- row is gone, and it answers it with the name that was true on the day.
--
-- Forward-only. Never edit this file once it has been applied anywhere.

-- The entitlement serial is a single global counter, not a per-device one. `local_entitlement` on
-- the device keys its ledger on the serial alone ("SELECT 1 FROM local_entitlement WHERE
-- entitlement_serial = ?1", local_db.rs), so two licences that share a serial are two licences the
-- device cannot tell apart. One counter for the whole installation makes that impossible.
--
-- The ceiling is not decoration: `entitlement_serial` is a u32 on the wire (entitlement.rs), so a
-- sequence allowed past 4294967295 would eventually hand out a number that cannot be encoded. It
-- refuses instead of wrapping, because a wrapped serial would silently collide with a live one.
CREATE SEQUENCE IF NOT EXISTS activation_licence_serial_seq
  AS BIGINT MINVALUE 1 MAXVALUE 4294967295 START WITH 1 NO CYCLE;

CREATE TABLE IF NOT EXISTS activation_licences (
  id SERIAL PRIMARY KEY,
  entitlement_serial BIGINT UNIQUE NOT NULL,
  device_id VARCHAR(160) NOT NULL,
  device_name VARCHAR(160),
  company_id INTEGER,
  branch_id INTEGER,
  key_id INTEGER NOT NULL,
  format_version INTEGER NOT NULL,
  valid_days INTEGER NOT NULL,
  issued_on DATE NOT NULL,
  expires_on DATE NOT NULL,
  grace_until DATE NOT NULL,
  -- The public half of the signing key, so a file can be traced to the key that signed it after a
  -- key rotation. The private seed is an environment variable on the server and is never stored,
  -- never logged and never returned.
  public_key_hex VARCHAR(64) NOT NULL,
  -- The file itself. It is device-bound and useless anywhere else, and keeping it means a lost
  -- copy is re-downloaded rather than re-issued -- a re-issue would burn a serial and supersede
  -- the licence already on the machine.
  lic_text TEXT NOT NULL,
  issued_by INTEGER REFERENCES users(id),
  issued_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS activation_licences_device_idx
  ON activation_licences (device_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS activation_licences_company_idx
  ON activation_licences (company_id, issued_at DESC);
