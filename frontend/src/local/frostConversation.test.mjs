import assert from "node:assert/strict";
import test from "node:test";

import {
  answerSources,
  buildFrostBrief,
  buildFrostConversation,
  latestSpokenTurn,
} from "./frostConversation.js";

const exchange = (overrides = {}) => ({
  id: "c1",
  question: "What did we sell today?",
  answer: "Sales today are Rs 42,300.00 across 61 bills.",
  facts: [{ sourceModule: "sales" }, { sourceModule: "billing" }, { sourceModule: "sales" }],
  period: { label: "Today" },
  notice: null,
  phrasedBy: "ollama",
  ...overrides,
});

test("an exchange becomes the question and then the answer, in that order", () => {
  const turns = buildFrostConversation({ history: [exchange()] });
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speaker, "owner");
  assert.equal(turns[0].text, "What did we sell today?");
  assert.equal(turns[1].speaker, "frost");
  assert.match(turns[1].text, /42,300/);
  assert.notEqual(turns[0].id, turns[1].id);
});

test("history is stored newest first and reads oldest first", () => {
  // `askAiAssistant` unshifts each new answer. A thread rendered in storage order would put the
  // newest exchange at the top and read backwards, which is the one thing a conversation may not do.
  const turns = buildFrostConversation({
    history: [
      exchange({ id: "newer", question: "And yesterday?", answer: "Yesterday was Rs 38,000.00." }),
      exchange({ id: "older", question: "Today?", answer: "Today is Rs 42,300.00." }),
    ],
  });
  assert.deepEqual(turns.map((turn) => turn.text), [
    "Today?",
    "Today is Rs 42,300.00.",
    "And yesterday?",
    "Yesterday was Rs 38,000.00.",
  ]);
});

test("the greeting and the day's brief open the thread, in that order", () => {
  const turns = buildFrostConversation({
    greeting: "Good evening, Dhiraj.",
    prompt: "Ask me anything about today.",
    brief: ["Two suppliers are overdue", "Alphonso stock is low"],
    periodLabel: "Today",
    history: [exchange()],
  });
  assert.deepEqual(turns.slice(0, 2).map((turn) => turn.kind), ["greeting", "brief"]);
  assert.equal(turns[0].prompt, "Ask me anything about today.");
  assert.deepEqual(turns[1].lines, ["Two suppliers are overdue", "Alphonso stock is low"]);
  assert.equal(turns[1].periodLabel, "Today");
  assert.equal(turns[2].kind, "question");
});

test("an empty panel has no turns rather than a placeholder one", () => {
  assert.deepEqual(buildFrostConversation(), []);
  assert.deepEqual(buildFrostConversation({ history: [], greeting: "", brief: [] }), []);
  // A brief whose every line is blank is not a brief.
  assert.deepEqual(buildFrostConversation({ brief: ["", "   ", null] }), []);
});

test("nothing missing is filled in with something plausible", () => {
  // The rule FROST exists under: every figure it states must be checkable against the ordinary
  // report. A turn invented to fill a gap is unfalsifiable by definition.
  const turns = buildFrostConversation({ history: [exchange({ answer: "", facts: [] })] });
  assert.deepEqual(turns.map((turn) => turn.kind), ["question"]);

  const answerOnly = buildFrostConversation({ history: [exchange({ question: "  " })] });
  assert.deepEqual(answerOnly.map((turn) => turn.kind), ["answer"]);
  assert.deepEqual(answerOnly[0].sources, ["sales", "billing"]);
});

test("the notice survives into the thread", () => {
  // Without it, FROST's own plain wording after the local model failed looks identical to the
  // model working. A degradation that reads as normal operation is the failure mode here.
  const turns = buildFrostConversation({
    history: [exchange({ notice: "FROST answered from your data directly; the local model is not running." })],
  });
  assert.match(turns[1].notice, /local model is not running/);
});

test("source modules are listed once, in the server's order", () => {
  assert.deepEqual(answerSources(exchange()), ["sales", "billing"]);
  assert.deepEqual(answerSources({ facts: [] }), []);
  assert.deepEqual(answerSources({}), []);
  assert.deepEqual(answerSources({ facts: [{ sourceModule: "  " }, { sourceModule: "stock" }] }), ["stock"]);
});

test("speaking picks the last grounded thing FROST said, never the greeting", () => {
  const greetingOnly = buildFrostConversation({ greeting: "Good morning." });
  assert.equal(latestSpokenTurn(greetingOnly), null, "a greeting is not an answer");

  const turns = buildFrostConversation({
    greeting: "Good morning.",
    brief: ["Two suppliers are overdue"],
    history: [exchange()],
  });
  const spoken = latestSpokenTurn(turns);
  assert.equal(spoken.kind, "answer");
  assert.match(spoken.text, /42,300/);

  // With no answer yet, the brief is the last grounded thing said, and it came from the books.
  const briefOnly = buildFrostConversation({ greeting: "Good morning.", brief: ["Two suppliers are overdue"] });
  assert.equal(latestSpokenTurn(briefOnly).kind, "brief");

  assert.equal(latestSpokenTurn([]), null);
  assert.equal(latestSpokenTurn(), null);
});

// -------------------------------------------------------------------------------------------
// The two things the thread used to lose: a question in flight, and a question that failed
// -------------------------------------------------------------------------------------------

test("the question being asked right now appears at the end, with a thinking turn", () => {
  // Without this the panel took the question and showed nothing until the answer landed. On a slow
  // cloud that is several seconds of looking like the send did not work.
  const turns = buildFrostConversation({
    history: [exchange()],
    pending: { question: "And the overdue suppliers?", askedAt: "2026-09-21T19:40:00.000Z" },
  });
  assert.deepEqual(turns.slice(-2).map((turn) => turn.kind), ["question", "thinking"]);
  assert.equal(turns[turns.length - 2].text, "And the overdue suppliers?");
  assert.equal(turns[turns.length - 2].at, "2026-09-21T19:40:00.000Z");
  assert.equal(turns[turns.length - 1].speaker, "frost");
});

test("a thinking turn is never spoken aloud", () => {
  const turns = buildFrostConversation({ pending: { question: "Today's sales?" } });
  assert.equal(latestSpokenTurn(turns), null);
});

test("nothing pending means no pending turns", () => {
  for (const pending of [null, undefined, {}, { question: "   " }]) {
    assert.deepEqual(buildFrostConversation({ history: [exchange()], pending }).length, 2);
  }
});

test("a question that failed stays in the thread with the reason", () => {
  // It used to vanish: only the error strip changed, so the thread showed a conversation in which
  // that question was never asked. A failure rendered as an absence is the same pitfall as an
  // error rendered as zero.
  const turns = buildFrostConversation({
    history: [exchange({ answer: "", failureMessage: "FROST requires cloud access." })],
  });
  assert.deepEqual(turns.map((turn) => turn.kind), ["question", "failure"]);
  assert.equal(turns[1].text, "FROST requires cloud access.");
  assert.equal(turns[1].speakable, false);
});

test("a failure is never read aloud as though it were an answer", () => {
  const turns = buildFrostConversation({
    greeting: "Good evening.",
    history: [exchange({ answer: "", failureMessage: "FROST requires cloud access." })],
  });
  assert.equal(latestSpokenTurn(turns), null);
});

test("a failure wins over a stale answer on the same entry", () => {
  // If an entry ever carried both, showing the old answer beside a failure would be the worst of
  // both: a figure presented as current that the failure says could not be refreshed.
  const turns = buildFrostConversation({
    history: [exchange({ failureMessage: "The cloud did not answer." })],
  });
  assert.deepEqual(turns.map((turn) => turn.kind), ["question", "failure"]);
  assert.doesNotMatch(JSON.stringify(turns), /42,300/);
});

test("the daily plan's two spellings never print the same line twice", () => {
  // The owner saw "Start with: Collect from kalu a17" three times over: the cloud sends
  // `top_priorities`, an older shape sends `topPriorities`, and the panel concatenated both along
  // with the briefing's own recommendations.
  const lines = buildFrostBrief({
    dailyPlan: {
      top_priorities: ["Collect from kalu a17", "Check old apple lots"],
      topPriorities: ["Collect from kalu a17", "Check old apple lots"],
      can_wait: ["Review supplier rates"],
    },
    recommendations: ["Start with: Collect from kalu a17"],
  });
  assert.deepEqual(lines, [
    "Start with: Collect from kalu a17",
    "Start with: Check old apple lots",
    "Can wait: Review supplier rates",
  ]);
});

test("the camel spelling is used when it is the only one carrying lines", () => {
  assert.deepEqual(
    buildFrostBrief({ dailyPlan: { top_priorities: [], topPriorities: ["Pay Mandi Traders"] } }),
    ["Start with: Pay Mandi Traders"],
  );
});

test("a missing daily plan produces no lines rather than throwing", () => {
  assert.deepEqual(buildFrostBrief(), []);
  assert.deepEqual(buildFrostBrief({ dailyPlan: null, recommendations: null }), []);
});
