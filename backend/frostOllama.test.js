"use strict";

/**
 * FROST's local phrasing layer: what it sends, what it refuses, and what it does when the model
 * is not there.
 *
 * ## What these tests can and cannot prove
 *
 * There is no Ollama in this container and no way to reach one, so every test here drives an
 * injected `fetchImpl`. That proves the request shape, the refusals, the timeout path and the
 * failure codes — which is where the mistakes are. It does **not** prove that a real Ollama
 * accepts this body or that a 3B model phrases well. Both need a run on the owner's machine, and
 * nothing here should be read as evidence that they have happened.
 *
 * ## The failure that matters most
 *
 * A model that is handed figures and asked to phrase them will sometimes add one. That is not
 * caught here — `assertGroundedAnswer` catches it in the route — but the codes in this module are
 * what let the route fall back to the plain wording and say so, instead of returning a 500 or, far
 * worse, an answer with an invented rupee figure in it.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  buildPhrasingMessages,
  describeOllamaFallback,
  phraseWithOllama,
  resolveOllamaBaseUrl,
} = require("./frostOllama");

const okResponse = (content, extra = {}) => ({
  ok: true,
  status: 200,
  async json() {
    return { message: { content }, ...extra };
  },
});

/* ------------------------------------------------------------------ the loopback requirement */

test("a missing base URL uses the loopback default rather than failing", () => {
  assert.deepEqual(resolveOllamaBaseUrl(""), { baseUrl: DEFAULT_OLLAMA_BASE_URL });
  assert.deepEqual(resolveOllamaBaseUrl(undefined), { baseUrl: DEFAULT_OLLAMA_BASE_URL });
});

test("loopback in its several spellings is accepted", () => {
  assert.deepEqual(resolveOllamaBaseUrl("http://127.0.0.1:11434"), { baseUrl: "http://127.0.0.1:11434" });
  assert.deepEqual(resolveOllamaBaseUrl("http://localhost:11434"), { baseUrl: "http://localhost:11434" });
  assert.deepEqual(resolveOllamaBaseUrl("http://[::1]:11434"), { baseUrl: "http://[::1]:11434" });
});

test("a non-loopback host is refused, which is what keeps LOCAL_ONLY at zero connections", () => {
  // The rule is that external connections stay at zero on a LOCAL_ONLY counter. "The base URL is a
  // setting" and "the setting is only ever loopback" are different claims and only the second is
  // safe, so this is enforced here rather than trusted to whoever fills the field in.
  for (const hostile of [
    "http://192.168.1.50:11434",
    "https://ollama.example.com",
    "http://10.0.0.4:11434",
    "http://127.0.0.1.evil.com:11434",
  ]) {
    assert.deepEqual(resolveOllamaBaseUrl(hostile), { error: "FROST_OLLAMA_URL_NOT_LOOPBACK" }, hostile);
  }
});

test("a URL that is not a URL is named as such, never silently replaced by the default", () => {
  // Falling back to the default here would hide the fact that somebody tried to point FROST
  // somewhere else and mistyped it.
  assert.deepEqual(resolveOllamaBaseUrl("not a url"), { error: "FROST_OLLAMA_URL_INVALID" });
  assert.deepEqual(resolveOllamaBaseUrl("file:///etc/passwd"), { error: "FROST_OLLAMA_URL_INVALID" });
  assert.deepEqual(resolveOllamaBaseUrl("ftp://127.0.0.1"), { error: "FROST_OLLAMA_URL_INVALID" });
});

test("phraseWithOllama refuses a non-loopback host before it makes any call at all", async () => {
  let called = false;
  const result = await phraseWithOllama({
    baseUrl: "https://ollama.example.com",
    question: "what were today's sales",
    fetchImpl: async () => {
      called = true;
      return okResponse("anything");
    },
  });
  assert.equal(result.error, "FROST_OLLAMA_URL_NOT_LOOPBACK");
  assert.equal(called, false, "the refusal must come before the request, not after it");
});

/* ------------------------------------------------------------------------- what is sent */

test("the model is given the figures and told not to invent any", () => {
  const messages = buildPhrasingMessages({
    question: "what were today's sales",
    facts: [{ summary: { totalSales: 48250 } }],
    periodLabel: "Today",
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /ONLY those figures/);
  assert.match(messages[0].content, /Never state a number that does not appear/);
  assert.match(messages[0].content, /say plainly that you do not have it/);
  assert.equal(messages[1].role, "user");
  assert.match(messages[1].content, /what were today's sales/);
  assert.match(messages[1].content, /Period: Today/);
  assert.match(messages[1].content, /48250/, "the verified figures must reach the model");
});

test("the request is a non-streaming chat call to the resolved host", async () => {
  const seen = {};
  await phraseWithOllama({
    baseUrl: "http://127.0.0.1:11434",
    model: "llama3.2:3b",
    question: "what were today's sales",
    facts: [{ summary: { totalSales: 48250 } }],
    fetchImpl: async (url, init) => {
      seen.url = url;
      seen.init = init;
      return okResponse("Sales today were 48250.");
    },
  });
  assert.equal(seen.url, "http://127.0.0.1:11434/api/chat");
  assert.equal(seen.init.method, "POST");
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, "llama3.2:3b");
  assert.equal(body.stream, false, "a streamed body would need assembling before it can be checked for grounding");
  assert.ok(Array.isArray(body.messages));
});

test("an unnamed model falls back to the small default", async () => {
  let body;
  await phraseWithOllama({
    question: "anything",
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return okResponse("fine");
    },
  });
  assert.equal(body.model, DEFAULT_OLLAMA_MODEL);
});

test("maxOutputTokens finally does something", async () => {
  // It has been a stored, editable setting that nothing read. This is the first code that honours
  // it, so a stray large value can no longer be typed in with no effect at all.
  let body;
  await phraseWithOllama({
    question: "anything",
    maxOutputTokens: 300,
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return okResponse("fine");
    },
  });
  assert.equal(body.options.num_predict, 300);

  let unlimited;
  await phraseWithOllama({
    question: "anything",
    maxOutputTokens: 0,
    fetchImpl: async (url, init) => {
      unlimited = JSON.parse(init.body);
      return okResponse("fine");
    },
  });
  assert.equal(unlimited.options, undefined, "a zero cap means unset, not a cap of zero tokens");
});

/* ------------------------------------------------------------------------ what comes back */

test("a good reply comes back as the answer, with whatever token counts Ollama reported", async () => {
  const result = await phraseWithOllama({
    question: "what were today's sales",
    fetchImpl: async () => okResponse("Sales today were 48250 rupees.", { prompt_eval_count: 812, eval_count: 47 }),
  });
  assert.equal(result.answer, "Sales today were 48250 rupees.");
  assert.equal(result.inputTokens, 812);
  assert.equal(result.outputTokens, 47);
  assert.equal(result.error, undefined);
});

test("every failure is a named code, never a throw and never a half answer", async () => {
  const cases = [
    ["Ollama not running", async () => { throw Object.assign(new Error("ECONNREFUSED"), { name: "TypeError" }); }, "FROST_OLLAMA_UNREACHABLE"],
    ["the model is not pulled", async () => ({ ok: false, status: 404 }), "FROST_OLLAMA_MODEL_NOT_PULLED"],
    ["Ollama errored", async () => ({ ok: false, status: 500 }), "FROST_OLLAMA_HTTP_ERROR"],
    ["an unreadable body", async () => ({ ok: true, status: 200, async json() { throw new Error("not json"); } }), "FROST_OLLAMA_BAD_RESPONSE"],
    ["an empty answer", async () => okResponse("   "), "FROST_OLLAMA_EMPTY_ANSWER"],
    ["no answer field at all", async () => ({ ok: true, status: 200, async json() { return {}; } }), "FROST_OLLAMA_EMPTY_ANSWER"],
  ];
  for (const [name, fetchImpl, expected] of cases) {
    const result = await phraseWithOllama({ question: "anything", fetchImpl });
    assert.equal(result.error, expected, name);
    assert.equal(result.answer, undefined, `${name} must not return a partial answer`);
  }
});

test("a model that never answers is abandoned rather than holding the request open", async () => {
  const result = await phraseWithOllama({
    question: "anything",
    timeoutMs: 1000,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  assert.equal(result.error, "FROST_OLLAMA_TIMEOUT");
});

test("a runtime with no fetch says so instead of throwing on undefined", async () => {
  const result = await phraseWithOllama({ question: "anything", fetchImpl: null });
  assert.equal(result.error, "FROST_OLLAMA_FETCH_UNAVAILABLE");
});

/* ----------------------------------------------------------------------- what the owner sees */

test("every failure code has a sentence a shop owner can act on", () => {
  // A code in a panel is a dead end. Each of these says what happened and, implicitly, what to do
  // about it -- start Ollama, pull the model -- and all of them lead with the fact that the answer
  // itself is still correct.
  const codes = [
    "FROST_OLLAMA_UNREACHABLE",
    "FROST_OLLAMA_TIMEOUT",
    "FROST_OLLAMA_MODEL_NOT_PULLED",
    "FROST_OLLAMA_HTTP_ERROR",
    "FROST_OLLAMA_EMPTY_ANSWER",
    "FROST_OLLAMA_BAD_RESPONSE",
    "FROST_OLLAMA_URL_INVALID",
    "FROST_OLLAMA_URL_NOT_LOOPBACK",
    "FROST_OLLAMA_FETCH_UNAVAILABLE",
    "FROST_ANSWER_NOT_GROUNDED",
  ];
  for (const code of codes) {
    const notice = describeOllamaFallback(code);
    assert.ok(notice.length > 20, `${code} has no usable notice`);
    assert.doesNotMatch(notice, /FROST_OLLAMA|undefined/, `${code}'s notice leaks the code itself`);
    assert.match(notice, /FROST answered from your data directly/, `${code} must first say the answer is still good`);
  }
});

test("an unknown code still produces a sentence rather than 'undefined'", () => {
  assert.equal(describeOllamaFallback("SOMETHING_NEW"), "FROST answered from your data directly.");
  assert.equal(describeOllamaFallback(undefined), "FROST answered from your data directly.");
});

/* --------------------------------------------------------------- how the answer route uses it */

const fs = require("node:fs");
const path = require("node:path");

const ROUTE = fs.readFileSync(path.join(__dirname, "aiBusinessAssistantService.js"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");

test("the answer is the deterministic wording until a model improves on it", () => {
  // Written this way round on purpose. If the assignment were the other way -- phrase first, fall
  // back on failure -- then every new failure path added later would have to remember to fall
  // back, and one that forgot would return undefined as the answer.
  assert.match(ROUTE, /let answer = deterministicAnswer;/);
});

test("phrasing runs only when the owner has turned a local model on", () => {
  assert.match(ROUTE, /settings\.frost\.enabled === true && providerKey === "ollama"/);
});

test("a model failure falls back to the plain answer instead of failing the request", () => {
  // The old behaviour on an ungrounded answer was `return res.status(500)`. For an assistant the
  // owner opens between customers, a 500 is worse than a plainer sentence: the figures were always
  // correct and always available.
  const start = ROUTE.indexOf('app.post("/api/ai/query"');
  const body = ROUTE.slice(start, ROUTE.indexOf("const conversationId", start));
  assert.ok(body.includes("notice = describeOllamaFallback"), "a failure must produce a notice");
  assert.doesNotMatch(body, /status\(500\)/, "a model that misbehaves must not take the answer down with it");
});

test("a model that states a figure the books do not contain is audited by name", () => {
  // Swallowing this silently would make a model that invents figures indistinguishable from one
  // that does not. The audit row is how that becomes visible.
  assert.match(ROUTE, /eventType: "FROST_ANSWER_NOT_GROUNDED"/);
});

test("the response tells the client which of the two wordings it got", () => {
  assert.match(ROUTE, /phrased_by: phrasedBy/);
  assert.match(ROUTE, /\n\s*notice,/);
});
