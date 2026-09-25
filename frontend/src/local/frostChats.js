/**
 * FROST's past chats: the sidebar, the fresh chat the panel opens onto, and the "new chat" button.
 *
 * ## What this replaces
 *
 * The panel had exactly one thread, kept in `aiAssistantData.history`, capped at twenty entries by
 * `askAiAssistant` and persisted alongside everything else the panel holds. So there was no way to
 * start a clean question without scrolling past yesterday's, no way to go back to a conversation
 * that had aged off the end of the cap, and reopening the panel dropped the owner back into the
 * middle of whatever was last asked. `frostConversation.js` made the panel read like a
 * conversation; this module makes it read like an assistant that remembers having had more than
 * one.
 *
 * The shape it has to fit is already fixed at both ends, and this module is the only piece that
 * knows both:
 *
 * - The server sends `GET /api/ai/conversations` (chats, newest first) and
 *   `GET /api/ai/conversations/:session_id` (one chat's exchanges, **oldest first**).
 * - `buildFrostConversation` consumes `history` **newest first**, because that is the order
 *   `askAiAssistant` writes it in — it unshifts each new answer onto the front — and it reverses
 *   internally to render in reading order.
 *
 * Those two orders are opposite. `historyFromExchanges` is where they meet, and getting it wrong
 * renders the whole conversation backwards while every individual turn still looks correct, which
 * is the kind of wrong that survives a glance. The test for it does not assert the order by eye: it
 * feeds the output through `buildFrostConversation` and checks the turns come out in reading order.
 *
 * ## The rule this module works under
 *
 * Everything here crosses a network before it arrives, so every field may be missing, null, or the
 * wrong type. Nothing in this file throws on a malformed payload — a sidebar that throws takes the
 * conversation down with it, and the conversation is the part that works. But nothing here invents
 * a value either: a chat with no readable id is dropped rather than given one, an unreadable
 * message count is `null` rather than `0`, and a list that could not be read reports itself as
 * unreadable rather than as a list with nothing in it. CLAUDE.md: errors must never render as zero,
 * and an empty sidebar beside a failed request is that pitfall in its purest form.
 *
 * ## No network, and no clock of its own
 *
 * This module imports nothing. In particular it does not import `serverTime.js` for
 * `authoritativeUtcNowIso`, which is the house way to get a trustworthy timestamp: that module
 * carries `axios` and a live `/api/time` call, so importing it here would pull a network client
 * into the one part of the panel that has no business making requests, and would force every test
 * of a pure string function to stub `window.localStorage` first (see `serverTime.test.mjs`, which
 * has to). Instead `newChatSessionId` takes `nowIso` the way the rest of this layer takes `now` and
 * `nowMs` — the caller in `App.jsx` already holds `authoritativeUtcNowIso` and passes its result
 * in. The timestamp is only there to make an id readable in a log; the thing that actually makes
 * ids unique is the counter and the random suffix below, neither of which needs a correct clock.
 */

/**
 * The session id cap. Session ids are sent back as a path segment and stored as an opaque key, so
 * they stay short enough to never be the thing that truncates. Ids built here land near forty
 * characters; the cap is headroom, not a target.
 */
export const FROST_SESSION_ID_MAX_LENGTH = 80;

/**
 * The title cap, in characters.
 *
 * The sidebar row is one line at the panel's width, and a question can be a paragraph. Sixty is
 * about what fits before the row wraps or clips, and it includes the ellipsis, so the cap is the
 * real rendered length rather than the length before the marker is added.
 */
export const FROST_CHAT_TITLE_MAX_LENGTH = 60;

/**
 * What a chat is called when its first question cannot be read.
 *
 * A row whose title renders as an empty string is a row with no click target: the chat exists, the
 * server will serve it, and the owner cannot reach it. So a missing title is a visible word, not a
 * blank, and it is deliberately not "New chat" — a chat that is already on the server is not new,
 * and labelling it so would invite the owner to expect it to be empty.
 */
export const FROST_CHAT_UNTITLED = "Untitled chat";

/** What the composer calls the chat that has not been asked anything yet. */
export const FROST_NEW_CHAT_TITLE = "New chat";

/** Said when the chat list itself could not be read, in place of an empty sidebar. */
export const FROST_CHAT_LIST_UNREADABLE = "Your past chats could not be loaded. You can still ask FROST a question.";

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** The first of several spellings that carries anything, so a renamed field degrades to the old one. */
const firstText = (...values) => {
  for (const value of values) {
    const found = text(value);
    if (found) return found;
  }
  return "";
};

/**
 * A per-process counter, so two ids made in the same millisecond cannot be the same id.
 *
 * The random suffix alone would almost always do it, and "almost always" is how a chat silently
 * writes its answers into another chat. The counter makes a collision within one running app
 * impossible rather than unlikely; the random part is what keeps two devices, or the same device
 * after a reload, from agreeing on an id by accident.
 */
let sessionSequence = 0;

const randomSuffix = () => {
  // Same shape `repositories.js` and `purchaseSubmission.js` use: the platform generator when the
  // webview offers one, and a plain fallback when it does not, because a missing `crypto` must not
  // be the reason a chat cannot be started.
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string" && uuid.length >= 8) return uuid.replace(/-/g, "").slice(0, 8);
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
};

/**
 * A compact, sortable stamp from an ISO time: `2026-09-22T07:15:00.123Z` becomes `20260922T071500123`.
 *
 * An unreadable time gets the literal `nostamp` rather than the device's own clock. The same rule
 * `frostGreeting.js` follows for the hour: when the time cannot be established, say so, do not pick
 * a plausible one. An id is forever, and one carrying a wrong time is worse than one carrying none.
 */
const compactStamp = (nowIso) => {
  const raw = text(nowIso);
  if (!raw) return "nostamp";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "nostamp";
  return parsed.toISOString().replace(/[-:.]/g, "").replace(/Z$/, "");
};

/**
 * A fresh chat session id.
 *
 * @param {object} [input]
 * @param {string} [input.nowIso] an ISO time; pass `authoritativeUtcNowIso()` from `serverTime.js`,
 *                                which is the clock this app trusts. Defaults to the device clock,
 *                                which is only ever used to make the id readable.
 * @returns {string} at most `FROST_SESSION_ID_MAX_LENGTH` characters
 */
export const newChatSessionId = ({ nowIso = new Date().toISOString() } = {}) => {
  sessionSequence += 1;
  // Bounded by construction rather than by a trailing slice: slicing the end off would cut away the
  // counter and the random suffix, which are the only two parts that make the id unique -- a cap
  // enforced that way would turn every long id into the same id.
  const id = `frost-${compactStamp(nowIso)}-${sessionSequence.toString(36)}-${randomSuffix()}`;
  return id.length <= FROST_SESSION_ID_MAX_LENGTH ? id : id.slice(0, FROST_SESSION_ID_MAX_LENGTH);
};

/**
 * A chat's display title, from its first question.
 *
 * Whitespace is collapsed before the cap is applied, because a question pasted out of a message can
 * carry newlines and runs of spaces that would otherwise eat the whole sixty characters and leave a
 * row that looks blank while being technically non-empty.
 *
 * @param {string} question the first question of the chat, or the title the server already stored
 * @returns {string} never empty
 */
export const chatTitleFrom = (question) => {
  // Only a string is a title. A number or an object arriving here is a contract violation, and
  // `String(value)` would paper over it with "[object Object]" in the sidebar.
  const collapsed = text(question).replace(/\s+/g, " ");
  if (!collapsed) return FROST_CHAT_UNTITLED;
  if (collapsed.length <= FROST_CHAT_TITLE_MAX_LENGTH) return collapsed;
  // The ellipsis is inside the cap, so the rendered string is never longer than the cap promises.
  const room = FROST_CHAT_TITLE_MAX_LENGTH - 1;
  const cut = collapsed.slice(0, room);
  const lastSpace = cut.lastIndexOf(" ");
  // Break on a word where one is close enough to the end to be worth it; a title cut mid-word reads
  // as corruption, but a title cut back to half its width reads as a different question.
  const kept = lastSpace > room * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${kept.trimEnd()}…`;
};

/**
 * One row of `GET /api/ai/conversations`, or null when it has no usable id.
 *
 * The id is an opaque string and is compared as one. CLAUDE.md's canonical-id rule is about
 * inventory, but the failure it describes is general: never `Number()` an id, because `"004"` and
 * `4` are different entities, and a session id that round-trips through a number comes back as a
 * different chat or as `NaN`.
 */
const chatRow = (entry) => {
  if (!entry || typeof entry !== "object") return null;
  // Both spellings are accepted for the same reason the daily plan accepts `top_priorities` and
  // `topPriorities`: the server and an older client disagreed once already, and the cost of
  // tolerating it here is one expression.
  const id = firstText(entry.session_id, entry.sessionId, entry.id);
  if (!id) return null;
  const count = Number(entry.message_count ?? entry.messageCount);
  return {
    id,
    title: chatTitleFrom(firstText(entry.title, entry.first_question, entry.question)),
    at: firstText(entry.last_at, entry.lastAt, entry.started_at, entry.startedAt),
    // Null, not zero. A chat the server listed has at least one exchange in it, so "0 messages" is
    // never a true statement about a listed chat -- it can only mean the field did not arrive, and
    // printing it as zero is the "errors must never render as zero" pitfall with a small number
    // instead of a big one. The panel omits the count when this is null.
    messageCount: Number.isFinite(count) ? count : null,
  };
};

/**
 * The chat list the sidebar renders, from the raw `GET /api/ai/conversations` body.
 *
 * Order is preserved exactly as the server sent it (newest first); this module does not re-sort,
 * because `last_at` may be missing on any row and a sort keyed on a missing field silently moves
 * chats around the sidebar between loads.
 *
 * @param {object|Array} payload the response body, or the array inside it
 * @returns {Array<{id: string, title: string, at: string, messageCount: number|null}>} `[]` on anything unreadable
 */
export const buildChatList = (payload) => {
  try {
    const raw = Array.isArray(payload) ? payload : payload?.chats;
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const rows = [];
    for (const entry of raw) {
      const row = chatRow(entry);
      if (!row) continue;
      // A duplicate id would give two sidebar rows the same React key, which renders as one row
      // that flickers between two chats when either is clicked. The first wins, and the list is
      // newest first, so the first is the fresher row.
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    return rows;
  } catch {
    // A hostile or exotic payload (a getter that throws, a Proxy) must not take the panel down.
    return [];
  }
};

/**
 * One exchange from `GET /api/ai/conversations/:session_id` in the shape `askAiAssistant` stores.
 *
 * Field names are `buildFrostConversation`'s, not the server's: `asked_at` becomes `askedAt`, and
 * `period_label` becomes `period.label`, because that is what the conversation builder reads. A
 * mismatch here does not throw and does not blank the thread -- it drops the timestamp and the
 * period label off every turn, which looks like the server stopped sending them.
 */
const historyEntry = (entry, index) => {
  if (!entry || typeof entry !== "object") return null;
  const question = text(entry.question);
  const answer = text(entry.answer);
  // An exchange with neither half is not a turn in any thread. `buildFrostConversation` would emit
  // nothing for it anyway; dropping it here keeps React keys off a row that renders as nothing.
  if (!question && !answer) return null;
  const periodLabel = firstText(entry.period_label, entry.periodLabel, entry.period?.label);
  const built = {
    // A synthesised id is positional, never random: a random key changes on every render, which
    // remounts every turn and throws away scroll position while the owner is reading.
    id: firstText(entry.id, entry.exchange_id) || `exchange-${index}`,
    question,
    answer,
    classification: text(entry.classification),
    facts: Array.isArray(entry.facts) ? entry.facts : [],
    askedAt: firstText(entry.asked_at, entry.askedAt),
    answeredAt: firstText(entry.answered_at, entry.answeredAt),
  };
  // Only attached when there is a label, so a missing period stays missing rather than becoming an
  // empty chip under the answer.
  if (periodLabel) built.period = { label: periodLabel };
  return built;
};

/**
 * The reopened chat as a `history` array `buildFrostConversation` can consume.
 *
 * **The order flips here.** The server sends exchanges oldest first; `history` is newest first,
 * because `askAiAssistant` unshifts onto it and `buildFrostConversation` reverses it back for
 * display. Returning the server's order unchanged would render the whole chat backwards with every
 * turn individually correct.
 *
 * @param {object|Array} payload the response body, or the array inside it
 * @returns {Array<object>} newest first; `[]` on anything unreadable
 */
export const historyFromExchanges = (payload) => {
  try {
    const raw = Array.isArray(payload) ? payload : payload?.exchanges;
    if (!Array.isArray(raw)) return [];
    const entries = [];
    raw.forEach((entry, index) => {
      const built = historyEntry(entry, index);
      if (built) entries.push(built);
    });
    return entries.reverse();
  } catch {
    return [];
  }
};

/** The three states the panel can be in. A caller switches on this rather than on emptiness. */
export const FROST_CHAT_SELECTION = Object.freeze({
  NEW: "new",
  EXISTING: "existing",
  UNREADABLE: "unreadable",
});

/**
 * Which chat is selected, and what the panel should say about it.
 *
 * Three outcomes, and they must stay three:
 *
 * - `existing` — `activeId` is a chat in the list. Load its exchanges.
 * - `new` — a chat that has no rows on the server yet. This is the **normal** state: the panel
 *   opens onto a fresh chat every time, and a fresh chat is not saved until the first answer comes
 *   back. It is not an error and must not be drawn as one.
 * - `unreadable` — the list itself could not be read. The sidebar has nothing to show for a reason
 *   that is not "you have no chats", and CLAUDE.md is explicit that the two may not look alike.
 *   The owner can still ask a question; only the history is missing.
 *
 * The normalised list comes back with the verdict so the sidebar and the selection are derived from
 * one collection rather than two. A panel whose list and whose selected row are filtered separately
 * will eventually disagree, and the disagreement reads as a chat that vanished.
 *
 * @param {object} [input]
 * @param {Array} [input.chats]   the output of `buildChatList`; anything that is not an array is
 *                                treated as unreadable. Pass `[]` before the first load, not null.
 * @param {string} [input.activeId] the session id the panel is on
 * @param {string} [input.failure]  the load error, if the request failed
 * @returns {{status: string, chats: Array, activeId: string, chat: object|null, title: string, message: string}}
 */
export const resolveChatSelection = ({ chats = [], activeId = "", failure = "" } = {}) => {
  const activeKey = text(activeId);
  const failureMessage = text(failure);
  if (failureMessage || !Array.isArray(chats)) {
    return {
      status: FROST_CHAT_SELECTION.UNREADABLE,
      chats: [],
      activeId: activeKey,
      chat: null,
      // The composer still works, so it is still called a chat rather than left blank.
      title: activeKey ? FROST_CHAT_UNTITLED : FROST_NEW_CHAT_TITLE,
      message: failureMessage || FROST_CHAT_LIST_UNREADABLE,
    };
  }
  // Compared as opaque strings on both sides. Never `Number()`, and never `String(id)` against a
  // trimmed id -- a join with one side normalised and the other not is what emptied the Inventory
  // table while every tile above it stayed right.
  const chat = activeKey ? chats.find((entry) => text(entry?.id) === activeKey) || null : null;
  if (chat) {
    return {
      status: FROST_CHAT_SELECTION.EXISTING,
      chats,
      activeId: activeKey,
      chat,
      title: text(chat.title) || FROST_CHAT_UNTITLED,
      message: "",
    };
  }
  return {
    status: FROST_CHAT_SELECTION.NEW,
    chats,
    activeId: activeKey,
    chat: null,
    title: FROST_NEW_CHAT_TITLE,
    message: "",
  };
};
