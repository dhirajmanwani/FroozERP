import assert from "node:assert/strict";
import test from "node:test";

import {
  SPEECH_REFUSALS,
  resolveSpeechPlan,
  speechSupported,
  speechWithNotice,
} from "./frostSpeech.js";
import { buildFrostConversation, latestSpokenTurn } from "./frostConversation.js";

const synthesis = { speak: () => {}, cancel: () => {} };
const utterance = function Utterance() {};
const answer = {
  speaker: "frost",
  kind: "answer",
  speakable: true,
  text: "Sales today are Rs 42,300.00 across 61 bills.",
};

test("a grounded answer is spoken exactly as the server worded it", () => {
  const plan = resolveSpeechPlan({ turn: answer, synthesis, utterance });
  assert.equal(plan.allowed, true);
  assert.equal(plan.text, "Sales today are Rs 42,300.00 across 61 bills.");
});

test("nothing is spoken that was not marked grounded", () => {
  // The rule FROST lives under: a spoken figure must be checkable against the ordinary report.
  // A turn without `speakable` never passed that bar, so there is nothing to read.
  for (const turn of [
    { ...answer, speakable: false },
    { ...answer, speakable: undefined },
    { ...answer, speaker: "owner" },
    { ...answer, text: "   " },
    null,
  ]) {
    const plan = resolveSpeechPlan({ turn, synthesis, utterance });
    assert.equal(plan.allowed, false);
    assert.equal(plan.code, "NOTHING_TO_SAY");
    assert.equal(plan.text, "");
  }
});

test("FROST stays quiet while it is still working", () => {
  // Mid-request the newest turn on screen is the PREVIOUS answer. Reading it out as the reply to
  // the question just asked is a wrong answer delivered confidently, which is worse than silence.
  const plan = resolveSpeechPlan({ turn: answer, synthesis, utterance, loading: true });
  assert.equal(plan.allowed, false);
  assert.equal(plan.code, "BUSY");
  assert.equal(plan.reason, SPEECH_REFUSALS.BUSY);
});

test("a device that cannot speak says so instead of failing silently", () => {
  for (const broken of [null, undefined, {}, { speak: () => {} }, { cancel: () => {} }, { speak: 1, cancel: 2 }]) {
    assert.equal(speechSupported(broken, utterance), false);
    const plan = resolveSpeechPlan({ turn: answer, synthesis: broken, utterance });
    assert.equal(plan.allowed, false);
    assert.equal(plan.code, "UNSUPPORTED");
    assert.ok(plan.reason.length > 0);
  }
  assert.equal(speechSupported(synthesis, utterance), true);
  // A runtime with the synthesiser but no utterance constructor would otherwise crash on
  // `new undefined(...)` rather than say it cannot speak.
  assert.equal(speechSupported(synthesis, undefined), false);
  assert.equal(speechSupported(synthesis, {}), false);
  assert.equal(resolveSpeechPlan({ turn: answer, synthesis, utterance: null }).code, "UNSUPPORTED");
});

test("unsupported is reported ahead of busy, so the message names the real limit", () => {
  const plan = resolveSpeechPlan({ turn: answer, synthesis: null, utterance, loading: true });
  assert.equal(plan.code, "UNSUPPORTED");
});

test("a fallback notice is spoken, not left on screen for someone who is listening", () => {
  const turn = { ...answer, notice: "FROST answered from your data directly; the local model is not running." };
  const plan = resolveSpeechPlan({ turn, synthesis, utterance });
  const spoken = speechWithNotice(plan, turn);
  assert.match(spoken, /42,300/);
  assert.match(spoken, /local model is not running/);

  // No notice means nothing appended, rather than a trailing space or a reassuring sentence.
  assert.equal(speechWithNotice(plan, answer), answer.text);
  assert.equal(speechWithNotice({ allowed: false, text: "" }, turn), "");
});

test("the speech plan reads what the thread actually last said", () => {
  const turns = buildFrostConversation({
    greeting: "Good evening, Dhiraj.",
    brief: ["Two suppliers are overdue"],
    history: [{ id: "c1", question: "Today's sales?", answer: "Sales today are Rs 42,300.00.", facts: [] }],
  });
  const plan = resolveSpeechPlan({ turn: latestSpokenTurn(turns), synthesis, utterance });
  assert.equal(plan.allowed, true);
  assert.match(plan.text, /42,300/);
  assert.doesNotMatch(plan.text, /Good evening/, "the greeting is never read aloud as an answer");
});

test("this module knows nothing about a network, by construction", async () => {
  // Speech that uploaded the shop's figures to a hosted voice service would be an outbound
  // connection, and on a LOCAL_ONLY device it would break the guarantee that mode makes:
  // blocked true, reachedCloud false, external connections zero. The refusal has to be structural
  // rather than a comment, so the module must contain no endpoint and no transport at all.
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("./frostSpeech.js", import.meta.url), "utf8"));
  const code = source.replace(/\/\*\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["fetch(", "axios", "XMLHttpRequest", "http://", "https://", "WebSocket", "RTCPeerConnection"]) {
    assert.equal(code.includes(forbidden), false, `frostSpeech.js must not reference ${forbidden}`);
  }
});
