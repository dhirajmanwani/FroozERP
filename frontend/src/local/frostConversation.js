/**
 * FROST's panel as a conversation, rather than a latest-answer box with the rest behind a tab.
 *
 * ## What this replaces
 *
 * The panel used to render `data.history[0]` — the most recent answer only — inside the "Ask FROST"
 * tab, and put every earlier exchange behind a separate "History" tab. So the two halves of one
 * conversation lived on two different screens, and the thing an assistant is actually for, the
 * thread of what was asked and what came back, existed nowhere. Asking a follow-up meant losing
 * sight of the answer it followed up on.
 *
 * `data.history` already carries everything a thread needs. It is stored newest-first and capped at
 * twenty entries by `askAiAssistant`. This module turns it into turns in reading order and adds
 * nothing to it: every word FROST says in the thread is a word the server sent.
 *
 * ## Why the greeting and the briefing are turns
 *
 * An empty assistant that says nothing until spoken to reads as broken, and the panel's own
 * greeting and daily brief were previously two more separate places to look. As the opening turns
 * they do the job a person expects: FROST says hello, says what today looks like, and then waits.
 *
 * ## The rule this module must not break
 *
 * Every figure FROST states has to be checkable against the ordinary report, because FROST computes
 * from SQL and only *phrases* the result. So nothing here composes a number, reformats one, or
 * fills a gap with a plausible value. A missing field yields a turn that is absent, never a turn
 * that is invented.
 */

/** A stable id for a turn, so React keys do not shift as the thread grows. */
const turnId = (entry, suffix) => `${entry?.id ?? "turn"}-${suffix}`;

const text = (value) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed;
};

/**
 * The distinct source modules behind an answer, in the order the server listed them.
 *
 * This is the line that lets the owner check a figure against the ordinary report, so it is derived
 * from `facts` rather than written by hand, and an answer with no facts gets no line rather than a
 * reassuring default.
 */
export const answerSources = (entry) => {
  const facts = Array.isArray(entry?.facts) ? entry.facts : [];
  const seen = [];
  for (const fact of facts) {
    const name = text(fact?.sourceModule);
    if (name && !seen.includes(name)) seen.push(name);
  }
  return seen;
};

/**
 * One exchange becomes two turns: what was asked, then what came back.
 *
 * The answer turn carries the notice, which is how the owner learns the local model was not running
 * and FROST fell back to its own plain wording. Losing that notice would make a degradation look
 * exactly like normal operation.
 */
const exchangeTurns = (entry) => {
  const turns = [];
  const question = text(entry?.question);
  if (question) {
    turns.push({
      id: turnId(entry, "ask"),
      speaker: "owner",
      kind: "question",
      text: question,
      at: text(entry?.askedAt),
    });
  }
  // A question that failed used to leave the thread entirely: only the error strip changed, and
  // the question itself was never recorded. So the thread showed a conversation in which that
  // question was never asked, which is the "errors must never render as zero" pitfall wearing
  // different clothes -- a failure rendered as an absence.
  const failure = text(entry?.failureMessage);
  if (failure) {
    turns.push({
      id: turnId(entry, "failure"),
      speaker: "frost",
      kind: "failure",
      text: failure,
      at: text(entry?.answeredAt),
      speakable: false,
    });
    return turns;
  }
  const answer = text(entry?.answer);
  if (answer) {
    turns.push({
      id: turnId(entry, "answer"),
      speaker: "frost",
      kind: "answer",
      text: answer,
      notice: text(entry?.notice),
      sources: answerSources(entry),
      // A greeting is the one answer that legitimately reads no books. Without this the panel prints
      // "No source modules reported" under "Hello.", which is a warning about nothing -- and that
      // default has to stay for every other answer, where no facts really is an anomaly.
      chitchat: text(entry?.classification) === "SMALL_TALK",
      periodLabel: text(entry?.period?.label),
      phrasedBy: text(entry?.phrasedBy),
      at: text(entry?.answeredAt),
      // Kept so the answer can be spoken without re-deriving which text is the grounded one.
      // `frostSpeech.js` reads this and nothing else.
      speakable: true,
    });
  }
  return turns;
};

/**
 * The whole panel as turns, oldest first.
 *
 * @param {object} input
 * @param {Array} input.history       `data.history`, newest first, as `askAiAssistant` stores it
 * @param {string} input.greeting     the time-of-day line from `frostGreeting.js`
 * @param {string} input.prompt       the one-line invitation under the greeting
 * @param {Array<string>} input.brief the day's recommendations, already computed from the books
 * @param {string} input.periodLabel  which period those recommendations describe
 * @param {object|null} input.pending the question sent but not yet answered
 * @returns {Array<object>} turns in reading order
 */
export const buildFrostConversation = ({
  history = [],
  greeting = "",
  prompt = "",
  brief = [],
  periodLabel = "",
  pending = null,
} = {}) => {
  const turns = [];
  const greetingText = text(greeting);
  if (greetingText) {
    turns.push({
      id: "frost-greeting",
      speaker: "frost",
      kind: "greeting",
      text: greetingText,
      prompt: text(prompt),
      speakable: false,
    });
  }
  const briefLines = (Array.isArray(brief) ? brief : []).map(text).filter(Boolean);
  if (briefLines.length > 0) {
    turns.push({
      id: "frost-brief",
      speaker: "frost",
      kind: "brief",
      lines: briefLines,
      periodLabel: text(periodLabel),
      // The brief is read from the books like any answer, so it may be spoken. `text` is what a
      // speech layer reads, so it is the same lines joined, never a summary of them.
      text: briefLines.join(". "),
      speakable: true,
    });
  }
  const entries = Array.isArray(history) ? [...history].reverse() : [];
  for (const entry of entries) turns.push(...exchangeTurns(entry));
  // The question in flight, last, so it reads where it was asked. It is not in `history` because
  // `history` is persisted to localStorage and an unanswered question is not a record of anything.
  // Without it the panel accepted a question and showed nothing until the answer landed, which on a
  // slow cloud is several seconds of looking like the send did not work.
  const pendingQuestion = text(pending?.question);
  if (pendingQuestion) {
    turns.push({
      id: "frost-pending-ask",
      speaker: "owner",
      kind: "question",
      text: pendingQuestion,
      at: text(pending?.askedAt),
    });
    turns.push({
      id: "frost-pending-answer",
      speaker: "frost",
      kind: "thinking",
      text: "",
      speakable: false,
    });
  }
  return turns;
};

/**
 * The most recent thing FROST said that may be spoken aloud.
 *
 * Used by the speak-aloud control, which must never read the greeting: saying "Good evening" out
 * loud when the owner asked for the day's sales is the kind of thing that makes an assistant feel
 * broken rather than helpful.
 */
export const latestSpokenTurn = (turns = []) => {
  const list = Array.isArray(turns) ? turns : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const turn = list[index];
    if (turn?.speaker === "frost" && turn?.speakable === true && text(turn?.text)) return turn;
  }
  return null;
};

/**
 * The lines that open the conversation: what FROST would say if asked how today looks.
 *
 * The daily plan is served under two spellings -- `top_priorities` from the cloud and
 * `topPriorities` from an older shape -- and the panel used to concatenate both plus the briefing's
 * own recommendations. When more than one of them was populated the owner saw the same three
 * sentences printed two and three times over, which reads as a bug in the books rather than in the
 * wording.
 *
 * So: one spelling wins, and the whole list is de-duplicated on the text the owner will actually
 * read. Nothing is dropped that is not a repeat.
 */
export const buildFrostBrief = ({ dailyPlan = null, recommendations = [] } = {}) => {
  const plan = dailyPlan && typeof dailyPlan === "object" ? dailyPlan : {};
  const listOf = (value) => (Array.isArray(value) ? value.map(text).filter(Boolean) : []);
  // Whichever spelling actually carries lines, never both.
  const priorities = listOf(plan.top_priorities).length ? listOf(plan.top_priorities) : listOf(plan.topPriorities);
  const lines = [
    ...priorities.slice(0, 5).map((item) => `Start with: ${item}`),
    ...listOf(recommendations),
    ...listOf(plan.can_wait).slice(0, 3).map((item) => `Can wait: ${item}`),
  ];
  const seen = new Set();
  return lines.filter((line) => {
    const key = line.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
