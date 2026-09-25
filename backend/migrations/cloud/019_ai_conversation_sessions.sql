-- `ai_conversations.session_id`: the column that turns a run of separate questions into a chat.
--
-- FROST wrote one `ai_conversations` row per question and nothing tied two questions together, so
-- there was no "past chat" to list or reopen -- only an audit trail. `session_id` is the grouping
-- key the client mints for a chat and sends back with every follow-up, and the two new read routes
-- (`GET /api/ai/conversations` and `GET /api/ai/conversations/:session_id`) exist only because of
-- it.
--
-- It is declared in `initializeDatabase()` like everything else, and `initializeDatabase()` is
-- switched off on a hosted deployment
-- (`const runStartupSchemaBootstrap = hostedCloudDeployment ? false : ...`). So on the cloud the
-- column would never appear, and `verifyDeclaredSchema` -- which now refuses to start on a
-- declared-but-absent column -- would stop the backend booting at all rather than waiting to 500
-- on the first owner who opened the chat sidebar. That is the fourth time this shape of gap has
-- been written down: 014 carried the A-5 login columns after two weeks of 500s on every cloud
-- sign-in, 015 and 016 carried Other Charges and Customer Orders after a reference bootstrap that
-- could not fill a rebuilt device, and 018 carried the unattended-update columns after two days
-- with the backend refusing to boot. This file is the only way the column reaches that database.
--
-- Forward-only. Never edit this file once it has been applied anywhere.

-- Exactly the statements from the startup bootstrap, character for character, so the two paths
-- cannot drift. IF NOT EXISTS keeps this safe to re-run and safe on a database that was
-- bootstrapped locally and already has it.
--
-- Nullable with no default, deliberately and permanently. Every row written before this column
-- existed belongs to no chat, and backfilling one would gather unrelated questions under a single
-- heading that reads like a conversation nobody had. `GET /api/ai/conversations` excludes NULL for
-- that reason; those rows keep their place in the audit trail, which is the job they were written
-- for.
ALTER TABLE ai_conversations ADD COLUMN IF NOT EXISTS session_id VARCHAR(80);

-- The list query groups by session inside one branch and one user and orders by time, so the index
-- leads with the two predicates that are always present. Without it the sidebar's query is a
-- sequential scan over the whole audit trail, which grows by a row per question and is never
-- pruned.
CREATE INDEX IF NOT EXISTS ai_conversations_session_idx
  ON ai_conversations (branch_id, user_id, session_id, created_at);

-- `ai_conversations` itself is not created here. It is declared in `initializeDatabase()` and is in
-- the 2026-09-21 schema baseline, so the hosted database necessarily has it. If it were absent, a
-- bare ALTER raising `relation "ai_conversations" does not exist` is the louder and better failure:
-- a guarded no-op would leave the deployment refusing to start with no new information.
