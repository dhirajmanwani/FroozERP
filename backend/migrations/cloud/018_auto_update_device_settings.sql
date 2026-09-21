-- The five unattended-update columns, on a hosted database that never receives added columns.
--
-- On 2026-09-21 the shop's cloud would not start at all. Railway's log:
--
--     Database initialization failed Error: This database is behind the code.
--     missing columns (5): device_control_settings.auto_update_days,
--     device_control_settings.auto_update_enabled, ...
--
-- PR #12 added four of these and PR #13 the fifth. All five are declared in
-- `initializeDatabase()`, which is switched off on a hosted deployment
-- (`const runStartupSchemaBootstrap = hostedCloudDeployment ? false : ...`), so on the cloud they
-- had never run and never would. This file is the only way they reach that database.
--
-- This is the third time the same gap has bitten: 014 carried the A-5 login columns, 015 and 016
-- carried Other Charges and Customer Orders, and now this. The difference is that `014` was found
-- from a 500 on `/login` after two weeks in production, and this was found before the deployment
-- went live -- by `verifyDeclaredSchema`, which is exactly the job it was written for. The refusal
-- cost an outage of the *new* version only; the old one kept serving.
--
-- Forward-only. Never edit this file once it has been applied anywhere.

-- Exactly the statements from the startup bootstrap, character for character, so the two paths
-- cannot drift. IF NOT EXISTS keeps this safe to re-run and safe on a database that was
-- bootstrapped locally and already has them.
--
-- The defaults are `AUTO_UPDATE_DEFAULT_SCHEDULE` from `frontend/src/local/autoUpdate.js` written
-- out: switched on, every day, 22:00 (1320) to 06:00 (360). An existing row picks them up, which is
-- the intended answer for a counter whose owner has never opened the setting.
ALTER TABLE device_control_settings ADD COLUMN IF NOT EXISTS auto_update_enabled BOOLEAN DEFAULT TRUE;
ALTER TABLE device_control_settings ADD COLUMN IF NOT EXISTS auto_update_days TEXT DEFAULT '0,1,2,3,4,5,6';
ALTER TABLE device_control_settings ADD COLUMN IF NOT EXISTS auto_update_start_minute INTEGER DEFAULT 1320;
ALTER TABLE device_control_settings ADD COLUMN IF NOT EXISTS auto_update_end_minute INTEGER DEFAULT 360;

-- Holdback is 0 by default, which means "take the release when it is published". That is what was
-- asked for, so an existing row reading back as 0 is the shipped behaviour, not a placeholder.
ALTER TABLE device_control_settings ADD COLUMN IF NOT EXISTS auto_update_holdback_days INTEGER DEFAULT 0;

-- `device_control_settings` itself is not created here. It is declared in `initializeDatabase()`
-- and a hosted database that predates these columns necessarily has it -- which the drift report
-- confirms, since a missing column is only ever reported for a table that exists. If it were
-- absent, a bare ALTER raising `relation "device_control_settings" does not exist` is the louder
-- and better failure: a guarded no-op would leave the deployment refusing to start with no new
-- information.
