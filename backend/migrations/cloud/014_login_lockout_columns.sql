-- The two columns A-5 added, on a hosted database that never receives added columns.
--
-- On 2026-09-08 every sign-in against the shop's cloud answered 500. The reason, visible only in
-- Railway's log:
--
--     error: column u.failed_login_attempts does not exist  (SQLSTATE 42703)
--
-- The columns are declared. `backend/server.js` has carried
--
--     ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
--     ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMP;
--
-- since A-5. What it does not have is a way for them to reach this database:
--
--     const runStartupSchemaBootstrap = hostedCloudDeployment ? false : ...
--
-- On a hosted deployment the startup bootstrap is off, by design -- it refuses to run schema
-- statements against a live shop's data. The cost, which nobody had priced, is that
-- `initializeDatabase()` is the *only* place those ALTERs live, so on the cloud they have never run
-- and never will. The startup check that follows looks for missing **tables**; `users` exists, so
-- the server starts happily and the absence surfaces later as a runtime error on whichever route
-- reads the column first. Here that route was `/login`, which means the whole shop.
--
-- CLAUDE.md says "Adding a column means editing that startup path". That instruction is incomplete
-- and this file is the correction: on the cloud, adding a column means writing a migration.
--
-- Forward-only. Never edit this file once it has been applied anywhere.

-- Exactly the statements from the startup bootstrap, so the two paths cannot drift. IF NOT EXISTS
-- keeps this safe to re-run and safe on a database that was bootstrapped locally and already has
-- them.
--
-- The counter defaults to 0 rather than NULL for the reason A-5 gives: an existing row's first
-- failed attempt should not have to special-case a null streak.
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_login_at TIMESTAMP;

-- `locked_until` has always existed and is not added here. It is the column A-5 gave something to
-- count into; if it were also missing, `/login` would have named it first.
