const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_FROST_SETTINGS,
  FROST_ASSISTANT_NAME,
  FrostProviderRegistry,
  FrostServiceLayer,
  actionRequiresApproval,
  classifyBusinessIntent,
  estimateCost,
  estimateTokens,
  maskProviderConfig,
} = require("./frostCore");

test("FROST has a permanent assistant identity", () => {
  assert.equal(DEFAULT_FROST_SETTINGS.assistantName, FROST_ASSISTANT_NAME);
  assert.equal(FROST_ASSISTANT_NAME, "FROST");
});

test("business language routes to controlled ERP services", () => {
  assert.equal(classifyBusinessIntent("How much cash should be in the drawer?"), "CASH_DRAWER");
  assert.equal(classifyBusinessIntent("Which fruits are close to expiry?"), "INVENTORY_EXPIRY");
  assert.equal(classifyBusinessIntent("Which supplier gives the best margins?"), "SUPPLIER_MARGIN");
  assert.equal(classifyBusinessIntent("Which customers haven't purchased recently?"), "CUSTOMER_ACTIVITY");
});

test("write-like FROST actions require owner approval", () => {
  assert.equal(actionRequiresApproval("VIEW"), false);
  assert.equal(actionRequiresApproval("OPEN_LEDGER"), false);
  assert.equal(actionRequiresApproval("REMIND"), true);
  assert.equal(actionRequiresApproval("PURCHASE"), true);
});

test("provider registry exposes replaceable provider interfaces", () => {
  const registry = new FrostProviderRegistry();
  const keys = registry.list().map((provider) => provider.key).sort();
  assert.deepEqual(keys, ["anthropic", "azure_openai", "ollama", "openai"]);
});

test("unknown provider falls back to deterministic runtime", () => {
  const runtime = new FrostProviderRegistry().buildRuntime({ providerKey: "missing", enabled: true });
  assert.equal(runtime.configured, false);
  assert.equal(runtime.providerKey, "deterministic");
});

test("token estimates and costs are deterministic", () => {
  assert.equal(estimateTokens("12345678"), 2);
  assert.equal(estimateCost({ providerKey: "deterministic", inputTokens: 100, outputTokens: 100 }), 0);
});

test("provider config masks secrets for UI and audit", () => {
  assert.deepEqual(maskProviderConfig({ api_key: "abc", model: "x", endpoint: "https://example.test" }), {
    api_key: "configured",
    model: "x",
    endpoint: "https://example.test",
  });
});

test("the cache key changes when the answer wording changes", () => {
  // Answers are cached for thirty minutes. The key was built from the question, the facts, the range
  // and the provider -- but not from the code that wrote the sentence, so the rebuilt wording was
  // invisible: the owner asked the same three questions he had asked before and got the old machine
  // wording back verbatim, while a question he had never asked came back in the new wording.
  const frost = new FrostServiceLayer({ pool: null });
  const base = { engine: "conversation", question: "what needs my attention today?", facts: [{ type: "x" }], range: { label: "Today" }, providerKey: "deterministic" };
  assert.notEqual(
    frost.buildCacheKey({ ...base, answerFormat: 1 }),
    frost.buildCacheKey({ ...base, answerFormat: 2 }),
  );
  assert.equal(
    frost.buildCacheKey({ ...base, answerFormat: 2 }),
    frost.buildCacheKey({ ...base, answerFormat: 2 }),
  );
});
