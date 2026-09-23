/**
 * Whether FROST may say something out loud, and what exactly it is allowed to say.
 *
 * ## Two rules, and they are not style preferences
 *
 * **Only already-grounded text is ever spoken.** Every figure FROST states has to be checkable
 * against the ordinary report, because FROST computes from SQL and a model only re-words the
 * result. Speech is a second rendering of an answer that already passed that bar, so this module
 * reads the answer text the server sent and never composes, summarises or rounds anything. If a
 * turn is not marked speakable, there is nothing to say and the control is refused with a reason.
 *
 * **Speech never leaves the machine.** The speech synthesis this permits is the browser's own,
 * which runs on the device against the system voices. A cloud speech provider would be an outbound
 * connection carrying the shop's figures to a third party, and on a LOCAL_ONLY device it would
 * break the guarantee that the mode makes: blocked true, reachedCloud false, external connections
 * zero. So `resolveSpeechPlan` returns text for a local synthesiser and has no concept of an
 * endpoint. A future provider that uploads audio or text does not belong behind this function.
 *
 * The OpenAI Realtime path that used to sit beside this -- a microphone streamed to a third party
 * and answered by a model that could not read the books -- has been removed. Live voice
 * (`frostLiveVoice.js`) now hears a question on the device, asks it through the typed route, and
 * speaks the answer through `resolveSpeechPlan` here: reading a verified answer aloud is the version
 * of "talk to me" that cannot state a number nobody can check.
 */

export const SPEECH_REFUSALS = Object.freeze({
  UNSUPPORTED: "This device cannot read answers aloud. The text stays on screen.",
  NOTHING_TO_SAY: "FROST has not answered anything yet.",
  BUSY: "FROST is still working that out. Ask again once the answer is on screen.",
});

/**
 * Whether the runtime can speak at all.
 *
 * Takes the object rather than reaching for a global, so the decision is testable without a
 * browser and so a caller in a non-browser context cannot crash on `window`.
 */
export const speechSupported = (synthesis, utterance) =>
  Boolean(synthesis)
  && typeof synthesis.speak === "function"
  && typeof synthesis.cancel === "function"
  // The constructor is checked too, because a runtime with `speechSynthesis` but no
  // `SpeechSynthesisUtterance` would pass a check on the synthesiser alone and then throw on
  // `new undefined(...)` -- an unsupported device crashing instead of saying it cannot speak.
  && typeof utterance === "function";

const spokenText = (turn) => {
  if (!turn || turn.speaker !== "frost" || turn.speakable !== true) return "";
  const text = typeof turn.text === "string" ? turn.text.trim() : "";
  return text;
};

/**
 * What to speak, or why not.
 *
 * @param {object} input
 * @param {object|null} input.turn      the turn to read, from `latestSpokenTurn`
 * @param {object|null} input.synthesis the browser's `speechSynthesis`, or null
 * @param {Function|null} input.utterance the `SpeechSynthesisUtterance` constructor, or null
 * @param {boolean} input.loading       true while a request is in flight
 * @returns {{allowed: boolean, text: string, reason: string, code: string}}
 */
export const resolveSpeechPlan = ({ turn = null, synthesis = null, utterance = null, loading = false } = {}) => {
  if (!speechSupported(synthesis, utterance)) {
    return { allowed: false, text: "", code: "UNSUPPORTED", reason: SPEECH_REFUSALS.UNSUPPORTED };
  }
  // Checked before the turn, because during a request the newest turn on screen is the *previous*
  // answer. Reading it aloud as though it were the reply to the question just asked is worse than
  // saying nothing: it is a wrong answer delivered confidently.
  if (loading === true) {
    return { allowed: false, text: "", code: "BUSY", reason: SPEECH_REFUSALS.BUSY };
  }
  const text = spokenText(turn);
  if (!text) {
    return { allowed: false, text: "", code: "NOTHING_TO_SAY", reason: SPEECH_REFUSALS.NOTHING_TO_SAY };
  }
  return { allowed: true, text, code: "", reason: "" };
};

/**
 * The notice a spoken answer must carry with it, when it has one.
 *
 * An answer FROST worded itself after the local model failed is a degradation, and one that sounds
 * completely normal read aloud. So the notice is spoken too rather than left on screen where the
 * owner, who is listening rather than looking, will not see it.
 */
export const speechWithNotice = (plan, turn) => {
  if (!plan?.allowed) return "";
  const notice = typeof turn?.notice === "string" ? turn.notice.trim() : "";
  return notice ? `${plan.text} ${notice}` : plan.text;
};
