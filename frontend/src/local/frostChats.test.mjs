import assert from "node:assert/strict";
import test from "node:test";

import { buildFrostConversation } from "./frostConversation.js";
import {
  FROST_CHAT_LIST_UNREADABLE,
  FROST_CHAT_SELECTION,
  FROST_CHAT_TITLE_MAX_LENGTH,
  FROST_CHAT_UNTITLED,
  FROST_NEW_CHAT_TITLE,
  FROST_SESSION_ID_MAX_LENGTH,
  buildChatList,
  chatTitleFrom,
  historyFromExchanges,
  newChatSessionId,
  resolveChatSelection,
} from "./frostChats.js";

const NOW = "2026-09-22T07:15:00.123Z";

// -------------------------------------------------------------------------------------------
// Session ids
// -------------------------------------------------------------------------------------------

test("two chats started in the same millisecond are two different chats", () => {
  // A timestamp-only id collides whenever the owner double-taps "new chat", or whenever the panel
  // opens and something else starts a chat in the same tick. Two chats sharing a session id means
  // the second one's answers are written into the first one's thread on the server, and neither
  // conversation is recoverable afterwards.
  const ids = new Set();
  for (let index = 0; index < 500; index += 1) ids.add(newChatSessionId({ nowIso: NOW }));
  assert.equal(ids.size, 500, "every id must be distinct even with the clock frozen");
});

test("a session id is a string that fits the cap", () => {
  for (const nowIso of [NOW, "", null, undefined, "not a date", 12345, {}]) {
    const id = newChatSessionId({ nowIso });
    assert.equal(typeof id, "string");
    assert.ok(id.length > 0, "an empty id is not a session");
    assert.ok(
      id.length <= FROST_SESSION_ID_MAX_LENGTH,
      `id of ${id.length} chars exceeds the ${FROST_SESSION_ID_MAX_LENGTH} cap`,
    );
  }
  assert.equal(typeof newChatSessionId(), "string", "the argument is optional");
});

test("an unreadable clock produces an id that says so rather than one that guesses", () => {
  // Same rule as the greeting: when the time cannot be established, do not pick a plausible one.
  // An id is permanent, and one stamped with a wrong time is worse than one stamped with none.
  const id = newChatSessionId({ nowIso: "not a date" });
  assert.match(id, /nostamp/);
  assert.notEqual(id, newChatSessionId({ nowIso: "not a date" }), "still unique without a clock");
});

test("the id is not a bare timestamp", () => {
  // `Date.now()` as the whole id is the thing this replaces: it collides, and it is guessable by
  // anyone who knows roughly when a chat was started.
  const id = newChatSessionId({ nowIso: NOW });
  assert.doesNotMatch(id, /^\d+$/);
  assert.match(id, /^frost-/, "a readable prefix, so an id in a log is identifiable");
});

// -------------------------------------------------------------------------------------------
// Titles
// -------------------------------------------------------------------------------------------

test("a title is never blank, whatever the question was", () => {
  // A row whose title renders as nothing has no click target: the chat exists, the server will
  // serve it, and the owner cannot reach it.
  for (const question of ["", "   ", "\n\t ", null, undefined, 42, {}, []]) {
    assert.equal(chatTitleFrom(question), FROST_CHAT_UNTITLED);
  }
});

test("a title is trimmed and its whitespace collapsed", () => {
  // A question pasted out of a message carries newlines and runs of spaces. Left alone they eat the
  // whole cap and leave a row that looks empty while being technically non-empty.
  assert.equal(chatTitleFrom("  What did we sell today?  "), "What did we sell today?");
  assert.equal(chatTitleFrom("What did\n\nwe   sell\ttoday?"), "What did we sell today?");
});

test("a long question is capped, ellipsis included, and never cut mid-word", () => {
  const question = "What did we sell of alphonso and kesar mangoes across both shops yesterday and the day before";
  const title = chatTitleFrom(question);
  assert.ok(
    title.length <= FROST_CHAT_TITLE_MAX_LENGTH,
    `title of ${title.length} chars exceeds the ${FROST_CHAT_TITLE_MAX_LENGTH} cap`,
  );
  assert.match(title, /…$/, "the cut is marked, so a truncated title is not read as the whole question");
  assert.ok(question.startsWith(title.slice(0, -1)), "the kept text is the question's own opening");
  assert.doesNotMatch(title, / …$/, "no space stranded before the ellipsis");
});

test("a single unbroken word is cut rather than thrown away", () => {
  // The word-boundary preference must not turn a long id-like question into an empty title.
  const title = chatTitleFrom("a".repeat(200));
  assert.ok(title.length <= FROST_CHAT_TITLE_MAX_LENGTH);
  assert.ok(title.length > 10, "cutting back to a word boundary must not leave a stub");
});

test("a question exactly at the cap keeps every character", () => {
  const question = "q".repeat(FROST_CHAT_TITLE_MAX_LENGTH);
  assert.equal(chatTitleFrom(question), question);
});

// -------------------------------------------------------------------------------------------
// The chat list
// -------------------------------------------------------------------------------------------

const listPayload = () => ({
  chats: [
    { session_id: "frost-b", title: "And yesterday?", started_at: "2026-09-21T10:00:00.000Z", last_at: "2026-09-21T10:04:00.000Z", message_count: 4 },
    { session_id: "frost-a", title: "What did we sell today?", started_at: "2026-09-20T09:00:00.000Z", last_at: "2026-09-20T09:02:00.000Z", message_count: 2 },
  ],
});

test("the server's order is the sidebar's order", () => {
  // The list is newest first and is not re-sorted here: `last_at` may be missing on any row, and a
  // sort keyed on a missing field moves chats around the sidebar between loads for no visible reason.
  const chats = buildChatList(listPayload());
  assert.deepEqual(chats.map((chat) => chat.id), ["frost-b", "frost-a"]);
  assert.deepEqual(chats[0], {
    id: "frost-b",
    title: "And yesterday?",
    at: "2026-09-21T10:04:00.000Z",
    messageCount: 4,
  });
});

test("a malformed or missing payload is an empty list, never a thrown error", () => {
  // This crosses a network. A sidebar that throws takes the conversation down with it, and the
  // conversation is the part that still works when the history endpoint does not.
  for (const payload of [undefined, null, "", 0, "chats", { chats: null }, { chats: "nope" }, {}, [], { chats: [null, 7, "x", []] }]) {
    assert.deepEqual(buildChatList(payload), []);
  }
});

test("a payload whose fields throw when read is still an empty list", () => {
  const hostile = { get chats() { throw new Error("boom"); } };
  assert.deepEqual(buildChatList(hostile), []);
});

test("a chat with no usable id is dropped rather than given one", () => {
  // An invented id points at nothing: clicking the row asks the server for a chat that does not
  // exist, and the panel would have to render that 404 as an empty conversation.
  const chats = buildChatList({
    chats: [
      { session_id: "", title: "no id" },
      { session_id: "   ", title: "blank id" },
      { session_id: null, title: "null id" },
      { session_id: 7, title: "numeric id" },
      { session_id: "frost-a", title: "real" },
    ],
  });
  assert.deepEqual(chats.map((chat) => chat.id), ["frost-a"]);
});

test("session ids stay opaque strings", () => {
  // CLAUDE.md's canonical-id rule: "004" and 4 are different entities. An id coerced through a
  // number comes back as a different chat, or as NaN, and the sidebar row stops matching the
  // conversation it opened.
  const [chat] = buildChatList({ chats: [{ session_id: "004", title: "Zero-padded" }] });
  assert.equal(chat.id, "004");
  assert.notEqual(chat.id, 4);
});

test("the same chat listed twice renders once", () => {
  // Two rows with one id give two React rows the same key, which renders as one row that flickers
  // between two chats whenever either is clicked.
  const chats = buildChatList({
    chats: [
      { session_id: "frost-a", title: "First", message_count: 9 },
      { session_id: "frost-a", title: "Stale duplicate", message_count: 1 },
    ],
  });
  assert.equal(chats.length, 1);
  assert.equal(chats[0].title, "First", "the fresher row wins, and the list is newest first");
});

test("an unreadable message count is null, not zero", () => {
  // A chat the server listed has at least one exchange in it, so "0 messages" can only mean the
  // field did not arrive. Printing it as zero is the errors-must-never-render-as-zero pitfall
  // wearing a small number.
  const chats = buildChatList({
    chats: [
      { session_id: "a", message_count: undefined },
      { session_id: "b", message_count: "many" },
      { session_id: "c", message_count: null },
      { session_id: "d", message_count: 0 },
      { session_id: "e", message_count: 3 },
    ],
  });
  assert.deepEqual(chats.map((chat) => chat.messageCount), [null, null, null, 0, 3]);
});

test("a chat with no title still has a name", () => {
  const chats = buildChatList({ chats: [{ session_id: "a" }, { session_id: "b", title: "  " }] });
  assert.deepEqual(chats.map((chat) => chat.title), [FROST_CHAT_UNTITLED, FROST_CHAT_UNTITLED]);
});

test("a chat that has only ever been started falls back to its start time", () => {
  // `last_at` is null until the first answer lands. Without the fallback the row would sort and
  // read as though it had no time at all.
  const [chat] = buildChatList({ chats: [{ session_id: "a", started_at: "2026-09-22T07:00:00.000Z", last_at: null }] });
  assert.equal(chat.at, "2026-09-22T07:00:00.000Z");
});

// -------------------------------------------------------------------------------------------
// Reopening a chat: the order flip
// -------------------------------------------------------------------------------------------

const exchangesPayload = () => ({
  session_id: "frost-a",
  title: "What did we sell today?",
  exchanges: [
    { id: "x1", question: "Today?", answer: "Today is Rs 42,300.00.", classification: "BUSINESS_BRIEFING", period_label: "Today", facts: [{ sourceModule: "sales" }], asked_at: "2026-09-22T07:00:00.000Z", answered_at: "2026-09-22T07:00:02.000Z" },
    { id: "x2", question: "And yesterday?", answer: "Yesterday was Rs 38,000.00.", classification: "BUSINESS_BRIEFING", period_label: "Yesterday", facts: [], asked_at: "2026-09-22T07:01:00.000Z", answered_at: "2026-09-22T07:01:02.000Z" },
  ],
});

test("a reopened chat reads forwards, not backwards", () => {
  // The two ends disagree on purpose: the server sends exchanges oldest first, and `history` is
  // newest first because `askAiAssistant` unshifts onto it. Hand the server's order straight to
  // `buildFrostConversation` and the whole chat renders backwards while every individual turn still
  // looks right -- the kind of wrong that survives a glance. So this is asserted by actually
  // rendering the thread, not by reading the array.
  const turns = buildFrostConversation({ history: historyFromExchanges(exchangesPayload()) });
  assert.deepEqual(turns.map((turn) => turn.text), [
    "Today?",
    "Today is Rs 42,300.00.",
    "And yesterday?",
    "Yesterday was Rs 38,000.00.",
  ]);
});

test("a reopened chat and a live one render identically", () => {
  // The panel replaces `history` wholesale when a chat is opened, so whatever comes out of here has
  // to be the same shape `askAiAssistant` writes. Anything else and the turns lose their timestamps
  // and their period label, which looks like the server stopped sending them.
  const [, answer] = buildFrostConversation({ history: historyFromExchanges(exchangesPayload()) });
  assert.equal(answer.kind, "answer");
  assert.equal(answer.periodLabel, "Today");
  assert.equal(answer.at, "2026-09-22T07:00:02.000Z");
  assert.deepEqual(answer.sources, ["sales"]);
  assert.equal(answer.chitchat, false);

  const [question] = buildFrostConversation({ history: historyFromExchanges(exchangesPayload()) });
  assert.equal(question.at, "2026-09-22T07:00:00.000Z");
});

test("small talk reopened is still small talk", () => {
  // `classification` is what suppresses the "No source modules reported" footer. Dropping it in the
  // mapping prints a warning about nothing under "Hello.".
  const history = historyFromExchanges({
    exchanges: [{ id: "x", question: "hi", answer: "Hello.", classification: "SMALL_TALK", facts: [] }],
  });
  const [, answer] = buildFrostConversation({ history });
  assert.equal(answer.chitchat, true);
});

test("a malformed or missing exchanges payload is an empty history, never a thrown error", () => {
  for (const payload of [undefined, null, "", 0, { exchanges: null }, { exchanges: "nope" }, {}, [], { exchanges: [null, 3, "x"] }]) {
    assert.deepEqual(historyFromExchanges(payload), []);
  }
  assert.deepEqual(historyFromExchanges({ get exchanges() { throw new Error("boom"); } }), []);
});

test("an exchange with neither a question nor an answer is dropped", () => {
  // It would render as no turns at all, so keeping it only puts a React key on a row that draws
  // nothing.
  const history = historyFromExchanges({
    exchanges: [{ id: "empty" }, { id: "blank", question: "  ", answer: "" }, { id: "real", question: "Today?" }],
  });
  assert.deepEqual(history.map((entry) => entry.id), ["real"]);
});

test("an exchange with no id gets a positional one, not a random one", () => {
  // A random React key changes on every render, which remounts every turn and throws away the
  // owner's scroll position mid-read.
  const first = historyFromExchanges({ exchanges: [{ question: "Today?" }, { question: "Yesterday?" }] });
  const second = historyFromExchanges({ exchanges: [{ question: "Today?" }, { question: "Yesterday?" }] });
  assert.deepEqual(first.map((entry) => entry.id), second.map((entry) => entry.id));
  assert.equal(new Set(first.map((entry) => entry.id)).size, 2, "and positional ids do not collide");
});

test("a missing period label leaves no period rather than an empty one", () => {
  const [entry] = historyFromExchanges({ exchanges: [{ id: "x", question: "Today?", answer: "Rs 1.00", period_label: "  " }] });
  assert.equal(entry.period, undefined);
  const [withLabel] = historyFromExchanges({ exchanges: [{ id: "x", question: "Today?", answer: "Rs 1.00", period_label: "Last 7 days" }] });
  assert.deepEqual(withLabel.period, { label: "Last 7 days" });
});

test("facts that are not a list become an empty list", () => {
  // `answerSources` reads `facts` directly, and a string there would be iterated character by
  // character into a source footer made of letters.
  const [entry] = historyFromExchanges({ exchanges: [{ id: "x", question: "Today?", answer: "Rs 1.00", facts: "sales" }] });
  assert.deepEqual(entry.facts, []);
});

// -------------------------------------------------------------------------------------------
// Which chat is open
// -------------------------------------------------------------------------------------------

test("a brand-new chat with no rows on the server is normal, not an error", () => {
  // The panel opens onto a fresh chat every time, and a fresh chat is not saved until the first
  // answer comes back. Treating "not in the list" as a failure would make every single opening of
  // the panel look broken.
  const chats = buildChatList(listPayload());
  const fresh = resolveChatSelection({ chats, activeId: newChatSessionId({ nowIso: NOW }) });
  assert.equal(fresh.status, FROST_CHAT_SELECTION.NEW);
  assert.equal(fresh.chat, null);
  assert.equal(fresh.title, FROST_NEW_CHAT_TITLE);
  assert.equal(fresh.message, "");
  assert.deepEqual(fresh.chats.map((chat) => chat.id), ["frost-b", "frost-a"], "the sidebar still lists the past chats");
});

test("no chat id at all is also a new chat", () => {
  for (const activeId of ["", "   ", null, undefined]) {
    assert.equal(resolveChatSelection({ chats: [], activeId }).status, FROST_CHAT_SELECTION.NEW);
  }
  assert.equal(resolveChatSelection().status, FROST_CHAT_SELECTION.NEW, "the argument is optional");
});

test("an id that is in the list selects that chat", () => {
  const selection = resolveChatSelection({ chats: buildChatList(listPayload()), activeId: "frost-a" });
  assert.equal(selection.status, FROST_CHAT_SELECTION.EXISTING);
  assert.equal(selection.chat.id, "frost-a");
  assert.equal(selection.title, "What did we sell today?");
});

test("a failed list is distinguishable from an empty one", () => {
  // CLAUDE.md: errors must never render as zero. "You have no past chats" and "your past chats
  // could not be loaded" are opposite facts, and a sidebar that draws both as nothing tells the
  // owner their history is gone.
  const empty = resolveChatSelection({ chats: [], activeId: "" });
  const failed = resolveChatSelection({ chats: [], activeId: "", failure: "Network Error" });
  assert.equal(empty.status, FROST_CHAT_SELECTION.NEW);
  assert.equal(empty.message, "");
  assert.equal(failed.status, FROST_CHAT_SELECTION.UNREADABLE);
  assert.equal(failed.message, "Network Error");
  assert.notEqual(empty.status, failed.status);
});

test("a list that is not a list is unreadable, not empty", () => {
  // `buildChatList` returns [] for a malformed payload, so a caller that skipped it and passed the
  // raw body through must not have that read as "no chats yet".
  for (const chats of [null, "nope", 0, { chats: [] }]) {
    const selection = resolveChatSelection({ chats, activeId: "frost-a" });
    assert.equal(selection.status, FROST_CHAT_SELECTION.UNREADABLE);
    assert.equal(selection.message, FROST_CHAT_LIST_UNREADABLE);
    assert.deepEqual(selection.chats, []);
  }
  // `undefined` is the one exception, because it is what an omitted argument looks like and the
  // parameter default takes it. A caller with a list it could not read passes what it got -- null,
  // the raw body, whatever -- or passes `failure`; it does not pass nothing.
  assert.equal(resolveChatSelection({ activeId: "frost-a" }).status, FROST_CHAT_SELECTION.NEW);
});

test("an unreadable list still names the chat the owner is in", () => {
  // The composer works whether or not the history loaded, so the header must not go blank.
  assert.equal(resolveChatSelection({ chats: null }).title, FROST_NEW_CHAT_TITLE);
  assert.equal(resolveChatSelection({ chats: null, activeId: "frost-a" }).title, FROST_CHAT_UNTITLED);
});

test("the selected id is matched as an opaque string", () => {
  // Never Number(), and never String(id) on one side against a trimmed id on the other. A join with
  // one side normalised and the other not is what silently emptied the Inventory table while every
  // tile above it stayed correct.
  const chats = buildChatList({ chats: [{ session_id: "004", title: "Zero-padded" }] });
  assert.equal(resolveChatSelection({ chats, activeId: "004" }).status, FROST_CHAT_SELECTION.EXISTING);
  assert.equal(resolveChatSelection({ chats, activeId: " 004 " }).status, FROST_CHAT_SELECTION.EXISTING, "whitespace is trimmed on both sides");
  assert.equal(resolveChatSelection({ chats, activeId: "4" }).status, FROST_CHAT_SELECTION.NEW, "4 is not 004");
});

test("a chat row with a broken title does not leave the header blank", () => {
  const selection = resolveChatSelection({ chats: [{ id: "frost-a", title: "   " }], activeId: "frost-a" });
  assert.equal(selection.status, FROST_CHAT_SELECTION.EXISTING);
  assert.equal(selection.title, FROST_CHAT_UNTITLED);
});
