"use strict";

/**
 * FROST's phrasing layer, running on a model on this machine.
 *
 * The owner chose a local model over a paid API: FROST is his alone, so the model only has to run
 * where he signs in, and the counters need nothing. Ollama listens on loopback, which is what makes
 * this compatible with a rule the rest of the app takes seriously.
 *
 * ## The one thing this module is for
 *
 * The database answers; the model phrases. Every figure FROST states has already been read out of
 * the books by one of 45 SQL queries before this module is called. Nothing here computes anything.
 * The model is handed those figures and asked to say them in a sentence, and if it says a number
 * that is not among them, `assertGroundedAnswer` catches it and the caller falls back to the plain
 * wording. A model that phrases cannot be trusted not to embellish, so it is not trusted.
 *
 * ## Loopback, by construction and not by policy
 *
 * CLAUDE.md requires LOCAL_ONLY mode to hold external connections at zero. A call to 127.0.0.1 is
 * not an external connection — but "the base URL is a setting" and "the setting is only ever
 * loopback" are different claims, and only the second is safe. So `resolveOllamaBaseUrl` refuses
 * any host that is not loopback rather than trusting whoever typed it. Pointing FROST at a model on
 * another machine is then a deliberate code change with this comment in front of it, not a typo in
 * a settings field that quietly starts sending the shop's figures over the network.
 *
 * `frostCore.js`'s voice path is the cautionary case: it calls `api.openai.com` with a raw `fetch`
 * from inside the backend process, which the desktop gateway's LOCAL_ONLY block never sees. It is
 * unreachable today only because no key is configured. This module must not add a second one.
 */

/** Where Ollama listens when nobody has said otherwise. */
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";

/**
 * A small instruct model is the right size here. FROST is not reasoning — the thinking already
 * happened in SQL — it is turning a row of figures into a sentence.
 */
const DEFAULT_OLLAMA_MODEL = "llama3.2:3b";

/** A local model that has not answered in this long is not going to; the caller falls back. */
const DEFAULT_TIMEOUT_MS = 20000;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * The base URL to call, or a named refusal.
 *
 * Returns `{ baseUrl }` or `{ error }`. The error is a code the caller can audit and show, never a
 * silent fall-through to the default — a misconfigured host that quietly became "the usual one"
 * would hide the fact that somebody had tried to point this somewhere else.
 */
const resolveOllamaBaseUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return { baseUrl: DEFAULT_OLLAMA_BASE_URL };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: "FROST_OLLAMA_URL_INVALID" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "FROST_OLLAMA_URL_INVALID" };
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    // Not a validation nicety. This is the line that keeps a LOCAL_ONLY counter's external
    // connection count at zero no matter what is typed into the settings field.
    return { error: "FROST_OLLAMA_URL_NOT_LOOPBACK" };
  }
  return { baseUrl: `${parsed.protocol}//${parsed.host}` };
};

/**
 * What the model is told, and what it is given.
 *
 * The facts go in as JSON rather than as prose because the model's job is to read values out of
 * them, not to parse English. The instruction is short on purpose: a long prompt asking a 3B model
 * to behave itself buys less than a grounding check that rejects the answer afterwards.
 */
const buildPhrasingMessages = ({ question, facts = [], periodLabel = "" }) => [
  {
    role: "system",
    content: [
      "You are FROST, the assistant inside a fruit shop's accounting software.",
      "You will be given verified figures that were read from the shop's own database.",
      "Answer the owner's question using ONLY those figures.",
      "Never state a number that does not appear in the data you were given. Never estimate, project or round.",
      "If the data does not contain what was asked, say plainly that you do not have it.",
      "Reply in two or three short sentences. Plain words. The owner reads Hindi and English.",
      "Amounts are Indian rupees.",
    ].join(" "),
  },
  {
    role: "user",
    content: [
      `Question: ${question}`,
      periodLabel ? `Period: ${periodLabel}` : "",
      "Verified figures:",
      JSON.stringify(facts),
    ].filter(Boolean).join("\n"),
  },
];

/**
 * Ask the local model to phrase an answer.
 *
 * Returns `{ answer, model }` on success, or `{ error }` with a code. It never throws and never
 * returns a partial answer: every failure — no Ollama running, an unknown model, a timeout, a
 * malformed body, an empty reply — comes back as a code so the caller can fall back to the
 * deterministic wording and audit what happened. An assistant that goes silent when the model is
 * down is worse than one that answers plainly.
 */
const phraseWithOllama = async ({
  baseUrl,
  model,
  question,
  facts = [],
  periodLabel = "",
  maxOutputTokens,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
} = {}) => {
  const resolved = resolveOllamaBaseUrl(baseUrl);
  if (resolved.error) return { error: resolved.error };
  if (typeof fetchImpl !== "function") return { error: "FROST_OLLAMA_FETCH_UNAVAILABLE" };

  const chosenModel = String(model || "").trim() || DEFAULT_OLLAMA_MODEL;
  const options = {};
  // `num_predict` is Ollama's output cap. `maxOutputTokens` has been a stored setting that nothing
  // read since it was added; this is the first thing that honours it.
  const cap = Number(maxOutputTokens);
  if (Number.isFinite(cap) && cap > 0) options.num_predict = Math.floor(cap);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
  let response;
  try {
    response = await fetchImpl(`${resolved.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model: chosenModel,
        stream: false,
        messages: buildPhrasingMessages({ question, facts, periodLabel }),
        ...(Object.keys(options).length ? { options } : {}),
      }),
    });
  } catch (error) {
    // An abort and a refused connection are different things to the owner: one means the model is
    // slow, the other means Ollama is not running. Both fall back, but the audit should say which.
    return { error: error?.name === "AbortError" ? "FROST_OLLAMA_TIMEOUT" : "FROST_OLLAMA_UNREACHABLE" };
  } finally {
    clearTimeout(timer);
  }

  if (!response || typeof response.ok !== "boolean") return { error: "FROST_OLLAMA_BAD_RESPONSE" };
  if (!response.ok) {
    // 404 from Ollama's chat endpoint means the model name is not pulled on this machine, which is
    // the most likely first-run failure and deserves its own code rather than a generic HTTP one.
    return { error: response.status === 404 ? "FROST_OLLAMA_MODEL_NOT_PULLED" : "FROST_OLLAMA_HTTP_ERROR", status: response.status };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { error: "FROST_OLLAMA_BAD_RESPONSE" };
  }

  const answer = String(body?.message?.content || "").trim();
  if (!answer) return { error: "FROST_OLLAMA_EMPTY_ANSWER" };
  return {
    answer,
    model: chosenModel,
    inputTokens: Number.isFinite(Number(body?.prompt_eval_count)) ? Number(body.prompt_eval_count) : null,
    outputTokens: Number.isFinite(Number(body?.eval_count)) ? Number(body.eval_count) : null,
  };
};

/** What the owner is told when the model could not phrase the answer. Never a blank panel. */
const OLLAMA_FALLBACK_NOTICES = {
  FROST_OLLAMA_UNREACHABLE: "FROST answered from your data directly; the local model is not running.",
  FROST_OLLAMA_TIMEOUT: "FROST answered from your data directly; the local model took too long.",
  FROST_OLLAMA_MODEL_NOT_PULLED: "FROST answered from your data directly; that model is not installed on this machine.",
  FROST_OLLAMA_HTTP_ERROR: "FROST answered from your data directly; the local model returned an error.",
  FROST_OLLAMA_EMPTY_ANSWER: "FROST answered from your data directly; the local model returned nothing.",
  FROST_OLLAMA_BAD_RESPONSE: "FROST answered from your data directly; the local model's reply could not be read.",
  FROST_OLLAMA_URL_INVALID: "FROST answered from your data directly; the local model address is not a valid URL.",
  FROST_OLLAMA_URL_NOT_LOOPBACK: "FROST answered from your data directly; the local model must run on this machine.",
  FROST_OLLAMA_FETCH_UNAVAILABLE: "FROST answered from your data directly; this server cannot reach a local model.",
  FROST_ANSWER_NOT_GROUNDED: "FROST answered from your data directly; the local model's wording contained a figure that is not in your books.",
};

const describeOllamaFallback = (code) =>
  OLLAMA_FALLBACK_NOTICES[code] || "FROST answered from your data directly.";

module.exports = {
  DEFAULT_OLLAMA_BASE_URL,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_TIMEOUT_MS,
  OLLAMA_FALLBACK_NOTICES,
  buildPhrasingMessages,
  describeOllamaFallback,
  phraseWithOllama,
  resolveOllamaBaseUrl,
};
