const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_FROST_SETTINGS,
  FROST_ASSISTANT_NAME,
  FrostProviderRegistry,
  estimateCost,
  estimateTokens,
  maskProviderConfig,
} = require("./frostCore");

test("FROST has a permanent assistant identity", () => {
  assert.equal(DEFAULT_FROST_SETTINGS.assistantName, FROST_ASSISTANT_NAME);
  assert.equal(FROST_ASSISTANT_NAME, "FROST");
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
