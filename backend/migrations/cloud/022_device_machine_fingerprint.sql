-- One computer, one ID, one name: `authorized_devices.machine_fp`.
--
-- ## What this carries
--
-- A device id is minted per installation, not per machine. Reinstalling the app, clearing its data
-- or an update that rebuilt its local profile makes the same counter register again under a new
-- id, and the Owner's "Computers & phones" screen then shows that one machine as several boxes.
--
-- The Windows app now sends a stable machine fingerprint beside the device id: a sha256, 64
-- lowercase hex characters, never the raw machine GUID. The backend stores it here (only when it
-- is well-formed, and never erasing a stored value with an absent one) and the scope-management
-- read uses it to fold a machine's ids into one box. NULL means the client did not send one; those
-- rows are listed exactly as before.
--
-- ## Why this file exists
--
-- Both statements are declared in `initializeDatabase()`, which is switched off on a hosted
-- deployment. Without this file the column never reaches the cloud, `verifyDeclaredSchema` refuses
-- to start the backend, and every device registration would 500 on the missing column -- the shape
-- of gap 014, 018, 019, 020 and 021 were each written to close.
--
-- Additive only: no row is inserted, updated or deleted. Forward-only. Never edit this file once
-- it has been applied anywhere.

-- Exactly the statements from the startup bootstrap, so the two paths cannot drift. IF NOT EXISTS
-- keeps this safe to re-run (the runner replays the whole list every time) and safe on a database
-- that was bootstrapped locally and already has them.
ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS machine_fp VARCHAR(80);
CREATE INDEX IF NOT EXISTS authorized_devices_machine_fp_idx ON authorized_devices (machine_fp);
