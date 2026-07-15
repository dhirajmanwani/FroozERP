const assert = require("node:assert/strict");
const test = require("node:test");
const { AI_SCHEMA_SQL, REQUIRED_AI_TABLES, ensureAiBusinessAssistantSchema } = require("./aiBusinessAssistantSchema");

test("FROST schema migration is additive and contains every required table", () => {
  assert.doesNotMatch(AI_SCHEMA_SQL, /^\s*(DROP|TRUNCATE|DELETE)\b/im);
  for (const table of REQUIRED_AI_TABLES) assert.match(AI_SCHEMA_SQL, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
});

test("existing FROST schema does not acquire a migration lock", async () => {
  let connected = false;
  const result = await ensureAiBusinessAssistantSchema({
    query: async () => ({ rows: [] }),
    connect: async () => { connected = true; },
  });
  assert.equal(result.created, false);
  assert.equal(connected, false);
});
