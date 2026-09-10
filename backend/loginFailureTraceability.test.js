"use strict";

/**
 * A 500 from `/login` has to be findable.
 *
 * ## What it cost
 *
 * On 2026-09-08 the shop's device, freshly rebuilt after its local database was cleared, could not
 * sign in. Everything the maintainer could see said this:
 *
 *     status 500, code "", message "Login Error"
 *
 * "Login Error" names the screen, not the fault. There was no code to look up, nothing to quote,
 * and no way to connect the attempt to anything on the server — the real exception had gone to
 * `console.error` inside a catch, which on Railway means scrolling a live log to the minute the
 * click happened and hoping to recognise it.
 *
 * That was the third time in two days that the answer existed only where nobody was looking. The
 * Dockerfile's eight filenames were the first, and "Local Only" with no statement of where the mode
 * came from was the second. The lesson is the same each time and it is not "log more": it is that a
 * failure a person can see must carry a handle that reaches the record of it.
 *
 * ## What is pinned
 *
 * Not the wording. The three properties that make the failure traceable:
 *
 *   - a stable `code`, so the app can branch on it and a person can search for it;
 *   - an `incident_id` in the response **and** in the log line, which is the handle;
 *   - no leak of the underlying error, because an unhandled exception can carry column names, host
 *     names and query text, and a sign-in route is the last place to disclose them.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SERVER = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

/** The `/login` catch block, as source text. */
const loginCatch = () => {
  const marker = 'return res.status(500).json({';
  const at = SERVER.indexOf('code: "LOGIN_FAILED"');
  assert.notEqual(at, -1, "the login failure response must still exist");
  const start = SERVER.lastIndexOf("} catch (error) {", at);
  assert.notEqual(start, -1);
  assert.ok(SERVER.indexOf(marker, start) !== -1);
  return SERVER.slice(start, SERVER.indexOf("});", at) + 3);
};

test("the failure carries a code a caller can act on", () => {
  // `code: ""` is what the app received, and a client cannot branch on an empty string. Every other
  // refusal in this server names itself; this one did not.
  assert.match(loginCatch(), /code: "LOGIN_FAILED"/);
});

test("the same incident id reaches both the response and the log", () => {
  // The whole point. An id in the log that the user never sees is not a handle, and an id in the
  // response that never appears in the log is worse than none — it looks like a lead and is not.
  const block = loginCatch();
  assert.match(block, /const incidentId = crypto\.randomUUID\(\)/, "the id must be generated per failure");
  assert.match(block, /console\.error\(`\[login-error\] incident=\$\{incidentId\}`/, "and written to the log");
  assert.match(block, /incident_id: incidentId/, "and returned to the caller");
  assert.match(block, /Quote reference \$\{incidentId\}/, "and named in words the person reading the screen can act on");
});

test("the underlying error is never disclosed to the caller", () => {
  // An unhandled exception on this path can be a database error naming columns, hosts or query
  // text. It belongs in the log and nowhere else.
  const block = loginCatch();
  const response = block.slice(block.indexOf("return res.status(500)"));
  assert.doesNotMatch(response, /error\.message|error\.stack|String\(error\)|\$\{error/, "the error must not be echoed");
});

test("the log line is still there to be searched", () => {
  // If the console.error were ever dropped as noise, the id would point at nothing.
  assert.match(SERVER, /\[login-error\] incident=/);
});

test("no route answers with the bare string this replaced", () => {
  // `{ message: "Login Error" }` was two words that named the screen. If it reappears anywhere it
  // will be just as unsearchable as it was here.
  //
  // Comment lines are stripped first: the block above quotes the old shape on purpose so the reader
  // can see what changed, and a guard that forbids describing the bug it prevents is a guard that
  // gets the explanation deleted instead.
  const code = SERVER.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  assert.doesNotMatch(code, /message: "Login Error"/);
});
