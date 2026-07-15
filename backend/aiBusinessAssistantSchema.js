const REQUIRED_AI_TABLES = Object.freeze([
  "ai_settings", "ai_alerts", "ai_reminders", "ai_conversations", "ai_messages",
  "ai_fact_snapshots", "ai_action_proposals", "ai_audit_log", "ai_cache", "ai_token_usage",
  "ai_engine_events", "frost_memories", "frost_prediction_runs", "frost_predictions",
  "frost_prediction_accuracy",
]);

const AI_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ai_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1), company_id INTEGER, branch_id INTEGER REFERENCES branches(id),
  thresholds JSONB NOT NULL DEFAULT '{}'::jsonb, ai_provider_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  frost_settings JSONB NOT NULL DEFAULT '{}'::jsonb, updated_by INTEGER REFERENCES users(id), updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_alerts (
  id SERIAL PRIMARY KEY, company_id INTEGER, branch_id INTEGER REFERENCES branches(id), dedup_key VARCHAR(240) UNIQUE NOT NULL,
  alert_type VARCHAR(80) NOT NULL, severity VARCHAR(20) NOT NULL DEFAULT 'INFO', status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  source_module VARCHAR(80) NOT NULL, linked_entity_type VARCHAR(80), linked_entity_id VARCHAR(120), title VARCHAR(220) NOT NULL,
  message TEXT NOT NULL, facts JSONB NOT NULL DEFAULT '{}'::jsonb, detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at TIMESTAMP, acknowledged_by INTEGER REFERENCES users(id), snoozed_until TIMESTAMP, resolved_at TIMESTAMP,
  resolved_by INTEGER REFERENCES users(id), owner_notes TEXT, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ai_alerts_status_severity_idx ON ai_alerts (status, severity, detected_at DESC);
CREATE TABLE IF NOT EXISTS ai_reminders (
  id SERIAL PRIMARY KEY, company_id INTEGER, branch_id INTEGER REFERENCES branches(id), dedup_key VARCHAR(240) UNIQUE NOT NULL,
  reminder_type VARCHAR(80) NOT NULL, priority VARCHAR(20) NOT NULL DEFAULT 'ATTENTION', status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  due_at TIMESTAMP, linked_entity_type VARCHAR(80), linked_entity_id VARCHAR(120), title VARCHAR(220) NOT NULL, message TEXT NOT NULL,
  draft_message TEXT, owner_notes TEXT, created_by INTEGER REFERENCES users(id), acknowledged_at TIMESTAMP,
  acknowledged_by INTEGER REFERENCES users(id), snoozed_until TIMESTAMP, resolved_at TIMESTAMP, resolved_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ai_reminders_status_due_idx ON ai_reminders (status, due_at, priority);
CREATE TABLE IF NOT EXISTS ai_conversations (
  id SERIAL PRIMARY KEY, company_id INTEGER, branch_id INTEGER REFERENCES branches(id), user_id INTEGER REFERENCES users(id),
  device_id VARCHAR(160), question TEXT NOT NULL, classification VARCHAR(80) NOT NULL, period_label VARCHAR(120), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_messages (
  id SERIAL PRIMARY KEY, conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE CASCADE, role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL, facts_used JSONB DEFAULT '[]'::jsonb, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_fact_snapshots (
  id SERIAL PRIMARY KEY, conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE CASCADE, fact_type VARCHAR(80) NOT NULL,
  source_module VARCHAR(80) NOT NULL, period_label VARCHAR(120), facts JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_action_proposals (
  id SERIAL PRIMARY KEY, conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE SET NULL, proposed_action VARCHAR(120) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb, approval_status VARCHAR(30) NOT NULL DEFAULT 'PENDING_OWNER_APPROVAL',
  proposed_by INTEGER REFERENCES users(id), approved_by INTEGER REFERENCES users(id), approved_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_audit_log (
  id SERIAL PRIMARY KEY, company_id INTEGER, branch_id INTEGER REFERENCES branches(id), user_id INTEGER REFERENCES users(id), device_id VARCHAR(160),
  event_type VARCHAR(80) NOT NULL, question TEXT, verified_facts JSONB DEFAULT '[]'::jsonb, answer TEXT,
  suggested_action JSONB DEFAULT '{}'::jsonb, approval_status VARCHAR(30) DEFAULT 'READ_ONLY', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ai_cache (
  id SERIAL PRIMARY KEY, cache_key VARCHAR(80) UNIQUE NOT NULL, engine_key VARCHAR(80) NOT NULL, provider_key VARCHAR(80) NOT NULL,
  request_hash VARCHAR(80) NOT NULL, request_payload JSONB NOT NULL DEFAULT '{}'::jsonb, response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMP NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ai_cache_expires_idx ON ai_cache (expires_at);
CREATE TABLE IF NOT EXISTS ai_token_usage (
  id SERIAL PRIMARY KEY, conversation_id INTEGER REFERENCES ai_conversations(id) ON DELETE SET NULL, engine_key VARCHAR(80) NOT NULL,
  provider_key VARCHAR(80) NOT NULL, model VARCHAR(120), input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  estimated_cost NUMERIC(14, 6) NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ai_token_usage_created_idx ON ai_token_usage (created_at DESC);
CREATE TABLE IF NOT EXISTS ai_engine_events (
  id SERIAL PRIMARY KEY, engine_key VARCHAR(80) NOT NULL, event_type VARCHAR(80) NOT NULL, status VARCHAR(40) NOT NULL DEFAULT 'READY',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb, created_by INTEGER REFERENCES users(id), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS frost_memories (
  id SERIAL PRIMARY KEY, company_id INTEGER, branch_id INTEGER REFERENCES branches(id), memory_type VARCHAR(80) NOT NULL, entity_type VARCHAR(80),
  entity_id VARCHAR(120), title VARCHAR(220) NOT NULL, content TEXT NOT NULL, source_type VARCHAR(80) NOT NULL DEFAULT 'owner_statement',
  source_reference TEXT, confidence NUMERIC(5, 2) NOT NULL DEFAULT 0, approval_status VARCHAR(40) NOT NULL DEFAULT 'PENDING_OWNER_APPROVAL',
  approved_by INTEGER REFERENCES users(id), created_by INTEGER REFERENCES users(id), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_used_at TIMESTAMP, is_active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS frost_memories_lookup_idx ON frost_memories (memory_type, entity_type, entity_id, approval_status, is_active);
CREATE TABLE IF NOT EXISTS frost_prediction_runs (
  id SERIAL PRIMARY KEY, company_id INTEGER, branch_id INTEGER REFERENCES branches(id), prediction_scope VARCHAR(80) NOT NULL,
  period_label VARCHAR(120), data_used JSONB NOT NULL DEFAULT '{}'::jsonb, run_status VARCHAR(40) NOT NULL DEFAULT 'COMPLETED',
  created_by INTEGER REFERENCES users(id), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS frost_predictions (
  id SERIAL PRIMARY KEY, run_id INTEGER REFERENCES frost_prediction_runs(id) ON DELETE SET NULL, company_id INTEGER,
  branch_id INTEGER REFERENCES branches(id), prediction_type VARCHAR(80) NOT NULL, entity_type VARCHAR(80), entity_id VARCHAR(120),
  title VARCHAR(220) NOT NULL, prediction_period VARCHAR(120), prediction_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence NUMERIC(5, 2) NOT NULL DEFAULT 0, reason TEXT, minimum_data_requirement TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS frost_predictions_type_idx ON frost_predictions (prediction_type, created_at DESC);
CREATE TABLE IF NOT EXISTS frost_prediction_accuracy (
  id SERIAL PRIMARY KEY, prediction_id INTEGER REFERENCES frost_predictions(id) ON DELETE CASCADE,
  actual_payload JSONB NOT NULL DEFAULT '{}'::jsonb, accuracy_score NUMERIC(6, 3), evaluated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
`;

const findMissingAiTables = async (queryable) => {
  const result = await queryable.query(
    `SELECT required.table_name FROM unnest($1::text[]) AS required(table_name)
     WHERE to_regclass(format('public.%I', required.table_name)) IS NULL ORDER BY required.table_name`,
    [REQUIRED_AI_TABLES]
  );
  return result.rows.map((row) => row.table_name);
};

async function ensureAiBusinessAssistantSchema(pool) {
  const initialMissing = await findMissingAiTables(pool);
  if (initialMissing.length === 0) return { created: false, missingBefore: [] };
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(1179405881)");
    const missingBefore = await findMissingAiTables(client);
    if (missingBefore.length > 0) await client.query(AI_SCHEMA_SQL);
    const missingAfter = await findMissingAiTables(client);
    if (missingAfter.length > 0) throw new Error(`FROST schema migration incomplete: ${missingAfter.join(", ")}`);
    return { created: missingBefore.length > 0, missingBefore };
  } finally {
    await client.query("SELECT pg_advisory_unlock(1179405881)").catch(() => null);
    client.release();
  }
}

module.exports = { AI_SCHEMA_SQL, REQUIRED_AI_TABLES, ensureAiBusinessAssistantSchema };
