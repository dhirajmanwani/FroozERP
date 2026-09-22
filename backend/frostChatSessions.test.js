"use strict";

/**
 * FROST chats: the grouping key, and the two routes that read it back.
 *
 * ## What was missing
 *
 * `ai_conversations` held one row per question and nothing tied two questions together. The table
 * was an audit trail and only an audit trail, so there was no "chat" to list in a sidebar and
 * nothing to reopen -- the owner's last conversation existed in the database and could not be got
 * at. `session_id` is the key the client mints for a chat and sends back with every follow-up, and
 * `GET /api/ai/conversations` and `GET /api/ai/conversations/:session_id` are the only two readers
 * of it.
 *
 * ## The three failures this pins
 *
 * **1. A caller-supplied id reaching a VARCHAR(80) unchecked.** The id is minted by the client, so
 * it is caller text. Postgres refuses an over-length value outright, and that refusal lands inside
 * `auditQuestion` -- *after* the books have been read and the answer composed -- so the owner would
 * have lost a finished answer to a malformed grouping label. `normalizeChatSessionId` drops the
 * label instead, and the assertions below insist on that direction: stored as NULL, never a 400 and
 * never a 500.
 *
 * **2. Rows that predate the column being dressed up as a chat.** Every existing row has
 * `session_id IS NULL`. Grouping them would produce one sidebar entry containing months of
 * unrelated questions that reads exactly like a conversation nobody had, which is the shape of
 * wrongness CLAUDE.md warns about -- plausible output that cannot be audited by looking at it.
 * They are excluded.
 *
 * **3. Reading somebody else's chat.** Branch scoping is A-7's rule and applies here as it applies
 * everywhere. User scoping is the extra one this feature needs: a sales figure belongs to the shop,
 * but a question belongs to the person who asked it, and two Owners of one branch would otherwise
 * read each other's chats -- including the half-finished ones. Both predicates are driven here with
 * a second branch and a second user whose ids sit one away from the caller's, so a missing
 * predicate shows up as another person's question in the response rather than as a difference in
 * source text.
 *
 * ## How this is tested
 *
 * The responder below stands in for Postgres the way `aiAlertStatusScope.test.js`'s does: it reads
 * the bound values and applies the same predicates the database would, so a query that forgot one
 * returns the extra rows here exactly as it would in production. It is a fixture, not a database --
 * what it proves is that the statement carries the predicate and that the handler shapes what comes
 * back correctly. Whether Postgres agrees about `LEFT JOIN LATERAL` is not answerable without a
 * database and is not claimed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");
const { normalizeChatSessionId, CHAT_SESSION_ID_MAX_LENGTH } = require("./aiBusinessAssistantService");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

/* ------------------------------------------------------------------------ the normaliser alone */

test("a usable chat id survives, trimmed", () => {
  assert.equal(normalizeChatSessionId("chat-2026-09-22-a"), "chat-2026-09-22-a");
  assert.equal(normalizeChatSessionId("  chat-with-spaces  "), "chat-with-spaces");
});

test("anything the column could not hold becomes null rather than an error", () => {
  // Each of these reached `auditQuestion` as a bind value before the normaliser existed. The long
  // one is the only one Postgres would have refused, but it would have refused it after the answer
  // was already composed -- so the owner lost a finished answer to a grouping label.
  assert.equal(normalizeChatSessionId("x".repeat(CHAT_SESSION_ID_MAX_LENGTH + 1)), null);
  assert.equal(normalizeChatSessionId(12345), null);
  assert.equal(normalizeChatSessionId({ session_id: "chat-1" }), null);
  assert.equal(normalizeChatSessionId(["chat-1"]), null);
  assert.equal(normalizeChatSessionId(true), null);
  assert.equal(normalizeChatSessionId(null), null);
  assert.equal(normalizeChatSessionId(undefined), null);
  assert.equal(normalizeChatSessionId(""), null);
  assert.equal(normalizeChatSessionId("   "), null);
});

test("the boundary is inclusive, so a maximum-length id is usable", () => {
  // Off by one here is not cosmetic: it would reject the longest id the column can hold, and the
  // symptom -- one chat in a hundred silently failing to group -- is nearly invisible.
  const exact = "x".repeat(CHAT_SESSION_ID_MAX_LENGTH);
  assert.equal(normalizeChatSessionId(exact), exact);
  assert.equal(CHAT_SESSION_ID_MAX_LENGTH, 80, "the cap must match ai_conversations.session_id");
});

/* --------------------------------------------------------------------------- the fixture shop */

/**
 * The caller is user 7 of branch 2. Everything that must not come back belongs to user 8 of the
 * same branch or to user 7 of branch 1 -- neighbours, not strangers, because a missing predicate
 * leaks a neighbour.
 */
const CALLER = { userId: 7, branchId: 2 };

const CONVERSATIONS = [
  // The caller's older chat.
  { id: 101, branch_id: 2, user_id: 7, session_id: "chat-morning", question: "What was today's sales?", classification: "SALES_FINANCE", period_label: "Today", created_at: "2026-09-20T04:00:00.000Z" },
  { id: 102, branch_id: 2, user_id: 7, session_id: "chat-morning", question: "And gross profit?", classification: "SALES_FINANCE", period_label: "Today", created_at: "2026-09-20T04:05:00.000Z" },
  // The caller's newer chat, whose second question was never answered.
  { id: 103, branch_id: 2, user_id: 7, session_id: "chat-evening", question: "Which items are low in stock?", classification: "INVENTORY", period_label: "Today", created_at: "2026-09-21T13:00:00.000Z" },
  { id: 104, branch_id: 2, user_id: 7, session_id: "chat-evening", question: "Which of those expire this week?", classification: "INVENTORY_EXPIRY", period_label: "Today", created_at: "2026-09-21T13:02:00.000Z" },
  // Asked before the column existed. Not a chat.
  { id: 105, branch_id: 2, user_id: 7, session_id: null, question: "Who owes me money?", classification: "PAYMENTS", period_label: "Today", created_at: "2026-09-01T09:00:00.000Z" },
  // The other Owner of the same shop.
  { id: 106, branch_id: 2, user_id: 8, session_id: "chat-colleague", question: "What did I pay the mango supplier?", classification: "PAYMENTS", period_label: "Today", created_at: "2026-09-21T15:00:00.000Z" },
  // The other shop.
  { id: 107, branch_id: 1, user_id: 7, session_id: "chat-other-branch", question: "Market Yard cash position?", classification: "CASH_DRAWER", period_label: "Today", created_at: "2026-09-21T16:00:00.000Z" },
];

/** The assistant reply for each conversation. 104 deliberately has none. */
const ASSISTANT_MESSAGES = {
  101: { content: "Today's sales were 12,400.00.", facts_used: [{ type: "daily_sales" }], created_at: "2026-09-20T04:00:02.000Z" },
  102: { content: "Gross profit was 2,150.00.", facts_used: [{ type: "gross_profit" }], created_at: "2026-09-20T04:05:02.000Z" },
  103: { content: "Four items are below their reorder level.", facts_used: [{ type: "low_stock" }], created_at: "2026-09-21T13:00:03.000Z" },
  106: { content: "You paid 18,000.00 to Shree Fruits.", facts_used: [], created_at: "2026-09-21T15:00:02.000Z" },
  107: { content: "Market Yard holds 9,000.00 in cash.", facts_used: [], created_at: "2026-09-21T16:00:02.000Z" },
};

/** What an unscripted statement answers. See `call` below for why this is not `undefined`. */
const EMPTY = { rows: [], rowCount: 0 };

const PERMISSION_USER = {
  rows: [{ id: 7, full_name: "Rahul", username: "rahul", branch_id: 2, role_name: "Owner", permissions: {} }],
  rowCount: 1,
};

/**
 * Apply the list query's predicates the way the database would.
 *
 * Reads `branch_id`, `user_id` and the NULL exclusion off the *bound values and the SQL text*, not
 * off the caller's intention, so a statement that drops a predicate returns the rows it would
 * really return.
 */
const applyListQuery = (sql, values) => {
  const [branchId, userId] = values;
  const matches = CONVERSATIONS.filter((row) => {
    if (/c\.branch_id = \$1/.test(sql) && row.branch_id !== branchId) return false;
    if (/c\.user_id = \$2/.test(sql) && row.user_id !== userId) return false;
    if (/c\.session_id IS NOT NULL/.test(sql) && row.session_id === null) return false;
    return true;
  });
  const bySession = new Map();
  for (const row of [...matches].sort((a, b) => (a.created_at < b.created_at ? -1 : 1) || a.id - b.id)) {
    const existing = bySession.get(row.session_id);
    if (!existing) {
      bySession.set(row.session_id, {
        session_id: row.session_id,
        title: row.question,
        started_at: row.created_at,
        last_at: row.created_at,
        message_count: 1,
      });
      continue;
    }
    existing.last_at = row.created_at;
    existing.message_count += 1;
  }
  const rows = [...bySession.values()].sort((a, b) => (a.last_at < b.last_at ? 1 : -1)).slice(0, 30);
  return { rows, rowCount: rows.length };
};

/** The detail query, including the LEFT JOIN that must keep an unanswered question. */
const applyDetailQuery = (sql, values) => {
  const [branchId, userId, sessionId] = values;
  const rows = CONVERSATIONS
    .filter((row) => {
      if (/c\.branch_id = \$1/.test(sql) && row.branch_id !== branchId) return false;
      if (/c\.user_id = \$2/.test(sql) && row.user_id !== userId) return false;
      return row.session_id === sessionId;
    })
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1) || a.id - b.id)
    .slice(0, 50)
    .map((row) => {
      const message = ASSISTANT_MESSAGES[row.id] || null;
      // A LEFT JOIN yields the conversation row with NULLs where the message would have been. An
      // inner join would drop it entirely, which is the behaviour under test.
      return {
        id: row.id,
        question: row.question,
        classification: row.classification,
        period_label: row.period_label,
        asked_at: row.created_at,
        answer: message ? message.content : null,
        facts: message ? message.facts_used : null,
        answered_at: message ? message.created_at : null,
      };
    });
  return { rows, rowCount: rows.length };
};

let app;

const sessionToken = ({ userId = CALLER.userId, branchId = CALLER.branchId } = {}) => issueDeviceSession({
  userId,
  deviceId: "FZDEV-FROST-CHATS",
  companyId: 1,
  branchId,
  role: "Owner",
  secret: TEST_SIGNING_KEY,
});

/**
 * Drive one FROST request and hand back the response plus every statement it ran.
 *
 * Only the permission lookup and the three `ai_conversations` statements are answered. Everything
 * else FROST touches on the way past -- settings, fact queries, cache, token usage, audit rows --
 * answers emptily, so a missing side effect cannot be mistaken for the behaviour under test.
 */
const call = async (method, url, { userId, branchId, body } = {}) => {
  if (!app) app = loadServerApp();
  const inserted = [];
  const statements = [];
  setQueryResponder((sql, values = []) => {
    statements.push({ sql, values });
    if (/FROM\s+users\s+u\s+JOIN\s+roles\s+r/i.test(sql)) return PERMISSION_USER;
    if (/INSERT INTO ai_conversations/i.test(sql)) {
      inserted.push(values);
      return { rows: [{ id: 999 }], rowCount: 1 };
    }
    if (/GROUP BY c\.session_id/i.test(sql)) return applyListQuery(sql, values);
    if (/LEFT JOIN LATERAL/i.test(sql)) return applyDetailQuery(sql, values);
    // Empty rows, not `undefined`. The stub *rejects* an unscripted statement when nothing is
    // recording, so falling through would turn every settings read, fact query and audit write on
    // the way past into a 500 and hide whichever behaviour the test was about.
    return EMPTY;
  });
  try {
    const response = await probe(
      app,
      method,
      url,
      { authorization: `Bearer ${sessionToken({ userId, branchId })}`, "content-type": "application/json" },
      body,
    );
    return { response, statements, inserted };
  } finally {
    clearQueryResponder();
  }
};

/* ------------------------------------------------------------------- storing the chat id */

test("the chat id is stored with the question and echoed back", async () => {
  const { response, inserted } = await call("POST", "/api/ai/query", {
    body: { question: "Which items are low in stock?", session_id: "chat-evening" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.session_id, "chat-evening");
  assert.equal(inserted.length, 1, "the question must have been written exactly once");
  assert.ok(inserted[0].includes("chat-evening"), `the id must be bound into the insert: ${JSON.stringify(inserted[0])}`);
});

test("a question with no chat id is still answered and still audited", async () => {
  // The feature is additive. A client that never sends an id -- the panel as it shipped -- must
  // keep working, and its rows must keep reaching the audit trail.
  const { response, inserted } = await call("POST", "/api/ai/query", {
    body: { question: "Which items are low in stock?" },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.session_id, null);
  assert.equal(inserted.length, 1);
  assert.ok(inserted[0].includes(null), "the insert must bind NULL, not undefined or an empty string");
});

test("an over-long or non-string chat id is stored as null, not refused", async () => {
  // The whole point of falling back rather than erroring: the owner asked a question and waited for
  // it. Losing the answer over a grouping label would be the wrong trade, and a 500 from inside
  // `auditQuestion` is what an unchecked bind would actually have produced.
  for (const hostile of ["x".repeat(200), 12345, { nested: true }, ["chat-1"], false]) {
    const { response, inserted } = await call("POST", "/api/ai/query", {
      body: { question: "Which items are low in stock?", session_id: hostile },
    });
    assert.equal(response.status, 200, `a ${typeof hostile} id must not fail the request`);
    assert.equal(response.body.session_id, null, `a ${typeof hostile} id must be reported as stored: null`);
    assert.ok(inserted[0].includes(null), "and must reach the insert as NULL");
  }
});

/* ---------------------------------------------------------------------------- the chat list */

test("the list returns one entry per chat, newest first, titled by the first question", async () => {
  const { response } = await call("GET", "/api/ai/conversations");
  assert.equal(response.status, 200);
  const { chats } = response.body;
  assert.deepEqual(chats.map((chat) => chat.session_id), ["chat-evening", "chat-morning"]);

  const [evening, morning] = chats;
  // The *first* question, not the most recent one. A sidebar titled by the latest message renames
  // itself under the owner as he types, which is how a chat he is looking for stops being findable.
  assert.equal(morning.title, "What was today's sales?");
  assert.equal(evening.title, "Which items are low in stock?");
  assert.equal(morning.message_count, 2);
  assert.equal(evening.message_count, 2);
  assert.equal(morning.started_at, "2026-09-20T04:00:00.000Z");
  assert.equal(morning.last_at, "2026-09-20T04:05:00.000Z");
});

test("questions asked before the feature existed are not dressed up as a chat", async () => {
  const { response, statements } = await call("GET", "/api/ai/conversations");
  const sessions = response.body.chats.map((chat) => chat.session_id);
  assert.ok(!sessions.includes(null), "a NULL session must never appear as a chat");
  assert.equal(
    response.body.chats.reduce((total, chat) => total + chat.message_count, 0),
    4,
    "the pre-feature row must not be counted into any chat either",
  );
  const list = statements.find(({ sql }) => /GROUP BY c\.session_id/i.test(sql));
  assert.match(list.sql, /c\.session_id IS NOT NULL/, "the exclusion belongs in the query, not in the mapping");
});

test("the list carries the verified branch and the verified user, and binds them", async () => {
  const { statements } = await call("GET", "/api/ai/conversations");
  const list = statements.find(({ sql }) => /GROUP BY c\.session_id/i.test(sql));
  assert.match(list.sql, /c\.branch_id = \$1/, "A-7: FROST reads one branch");
  assert.match(list.sql, /c\.user_id = \$2/, "and a question belongs to the person who asked it");
  assert.deepEqual(list.values, [CALLER.branchId, CALLER.userId]);
});

test("another user's chat in the same shop is never listed", async () => {
  // User 8 is an Owner of branch 2, exactly like the caller. Branch scoping alone would hand their
  // chat over, which is why the user predicate is not decoration.
  const { response } = await call("GET", "/api/ai/conversations");
  const sessions = response.body.chats.map((chat) => chat.session_id);
  assert.ok(!sessions.includes("chat-colleague"), "branch scoping alone is not enough here");
});

test("another branch's chat is never listed", async () => {
  const { response } = await call("GET", "/api/ai/conversations");
  const sessions = response.body.chats.map((chat) => chat.session_id);
  assert.ok(!sessions.includes("chat-other-branch"));
});

test("signing in as the other user shows their chat and only theirs", async () => {
  // The mirror image, so the test above cannot be passing because the query returns nothing at all.
  const { response } = await call("GET", "/api/ai/conversations", { userId: 8, branchId: 2 });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.chats.map((chat) => chat.session_id), ["chat-colleague"]);
});

/* -------------------------------------------------------------------------- reopening a chat */

test("a chat reopens oldest question first, with its answers and facts", async () => {
  const { response } = await call("GET", "/api/ai/conversations/chat-morning");
  assert.equal(response.status, 200);
  assert.equal(response.body.session_id, "chat-morning");
  assert.equal(response.body.title, "What was today's sales?");

  const { exchanges } = response.body;
  assert.equal(exchanges.length, 2);
  assert.deepEqual(exchanges.map((exchange) => exchange.id), [101, 102]);
  assert.equal(exchanges[0].question, "What was today's sales?");
  assert.equal(exchanges[0].answer, "Today's sales were 12,400.00.");
  assert.equal(exchanges[0].classification, "SALES_FINANCE");
  assert.equal(exchanges[0].period_label, "Today");
  assert.deepEqual(exchanges[0].facts, [{ type: "daily_sales" }]);
  assert.equal(exchanges[0].asked_at, "2026-09-20T04:00:00.000Z");
  assert.equal(exchanges[0].answered_at, "2026-09-20T04:00:02.000Z");
});

test("a question that was never answered still appears, with an empty answer", async () => {
  // Conversation 104 has no assistant message: the model was down, or the process went away between
  // the two inserts. An inner join would delete it from the transcript, and the owner would find a
  // question he remembers asking simply gone -- a failure rendering as an absence, which is the
  // rule CLAUDE.md states and the hardest place to notice it broken.
  const { response } = await call("GET", "/api/ai/conversations/chat-evening");
  assert.equal(response.status, 200);
  const { exchanges } = response.body;
  assert.deepEqual(exchanges.map((exchange) => exchange.id), [103, 104]);

  const unanswered = exchanges[1];
  assert.equal(unanswered.question, "Which of those expire this week?");
  assert.equal(unanswered.answer, "", "an empty string, never null and never a missing key");
  assert.deepEqual(unanswered.facts, []);
  assert.equal(unanswered.answered_at, null, "and it must be visible that no answer ever landed");
});

test("the detail query carries the verified branch, the verified user and the requested chat", async () => {
  const { statements } = await call("GET", "/api/ai/conversations/chat-morning");
  const detail = statements.find(({ sql }) => /LEFT JOIN LATERAL/i.test(sql));
  assert.match(detail.sql, /c\.branch_id = \$1/);
  assert.match(detail.sql, /c\.user_id = \$2/);
  assert.match(detail.sql, /c\.session_id = \$3/);
  assert.deepEqual(detail.values, [CALLER.branchId, CALLER.userId, "chat-morning"]);
});

test("another user's chat is not readable by its id", async () => {
  // The ids are strings the client chose, so guessing one is not far-fetched. The refusal is a 404
  // rather than a 403 on purpose: "forbidden" would confirm the chat exists.
  const { response } = await call("GET", "/api/ai/conversations/chat-colleague");
  assert.equal(response.status, 404);
  assert.ok(response.body?.message, "and says what was not found");
});

test("another branch's chat is not readable by its id", async () => {
  const { response } = await call("GET", "/api/ai/conversations/chat-other-branch");
  assert.equal(response.status, 404);
});

test("an unknown chat is a 404, not an empty success", async () => {
  // `res.json({ exchanges: [] })` would be HTTP 200, and the panel would open an empty thread that
  // looks like a chat whose messages were lost.
  const { response } = await call("GET", "/api/ai/conversations/chat-that-never-existed");
  assert.equal(response.status, 404);
  assert.ok(response.body?.message);
});

test("an id too long to be stored is not found rather than queried", async () => {
  // Symmetry with the write side: an id the column could not hold cannot name a chat, so it is
  // answered without a statement that could never match.
  const { response, statements } = await call("GET", `/api/ai/conversations/${"x".repeat(200)}`);
  assert.equal(response.status, 404);
  assert.equal(
    statements.filter(({ sql }) => /LEFT JOIN LATERAL/i.test(sql)).length,
    0,
    "an unusable id must not reach the database",
  );
});

/* ------------------------------------------------------------------------------- the gate */

test("both routes refuse a caller with no session", async () => {
  // They are mounted behind the app-wide default-deny (A-4), and this is the assertion that says so
  // rather than assuming it. A read of every question the Owner has ever asked is not a public route.
  if (!app) app = loadServerApp();
  for (const url of ["/api/ai/conversations", "/api/ai/conversations/chat-morning"]) {
    const response = await probe(app, "GET", url, { "content-type": "application/json" });
    assert.equal(response.status, 401, `${url} answered ${response.status} without a session`);
  }
});

test("both routes refuse a caller the permission lookup does not return", async () => {
  // `getPermissionUser` answering no rows is how a non-Owner arrives here. FROST is the Owner's
  // assistant -- see `frostOwnerOnlyAccess.test.js` -- and these two routes read the most personal
  // thing it holds.
  if (!app) app = loadServerApp();
  setQueryResponder(() => EMPTY);
  try {
    for (const url of ["/api/ai/conversations", "/api/ai/conversations/chat-morning"]) {
      const response = await probe(
        app,
        "GET",
        url,
        { authorization: `Bearer ${sessionToken()}`, "content-type": "application/json" },
      );
      assert.equal(response.status, 403, `${url} answered ${response.status} for a caller with no permission row`);
      assert.equal(response.body.code, "FROST_PERMISSION_DENIED");
    }
  } finally {
    clearQueryResponder();
  }
});
