const assert = require("node:assert/strict");
const test = require("node:test");
const { CLOUD_NOT_CONFIGURED_MESSAGE, CLOUD_UNAVAILABLE_MESSAGE, normalizeCloudProxyError } = require("./cloudProxyError");

test("desktop gateway sanitizes DNS and timeout failures", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]) {
    const result = normalizeCloudProxyError({ cause: { code } });
    assert.equal(result.status, 503);
    assert.equal(result.payload.code, "CLOUD_UNAVAILABLE");
    assert.equal(result.payload.message, CLOUD_UNAVAILABLE_MESSAGE);
    assert.doesNotMatch(JSON.stringify(result.payload), /ENOTFOUND|railway\.app/);
  }
});

test("desktop gateway converts upstream 502 to structured cloud unavailable", () => {
  const result = normalizeCloudProxyError({ status: 502 });
  assert.equal(result.status, 503);
  assert.equal(result.payload.failure_kind, "CLOUD_UNAVAILABLE");
});

test("an unconfigured cloud target is reported distinctly from an outage", () => {
  const result = normalizeCloudProxyError({ code: "CLOUD_NOT_CONFIGURED" });
  assert.equal(result.status, 503);
  assert.equal(result.payload.code, "CLOUD_NOT_CONFIGURED");
  assert.equal(result.payload.failure_kind, "CLOUD_NOT_CONFIGURED");
  assert.equal(result.payload.cloud_connected, false);
  assert.equal(result.payload.message, CLOUD_NOT_CONFIGURED_MESSAGE);
  assert.notEqual(result.payload.message, CLOUD_UNAVAILABLE_MESSAGE);
  assert.doesNotMatch(JSON.stringify(result.payload), /railway\.app|https?:\/\//);
});

test("Local Only policy returns a clean structured cloud pause", () => {
  const result = normalizeCloudProxyError({ code: "APP_LOCAL_ONLY" });
  assert.equal(result.status, 503);
  assert.equal(result.payload.code, "APP_LOCAL_ONLY");
  assert.equal(result.payload.failure_kind, "CLOUD_UNAVAILABLE");
  assert.doesNotMatch(result.payload.message, /ENOTFOUND|502|railway\.app/);
});
