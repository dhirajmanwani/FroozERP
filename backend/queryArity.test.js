"use strict";

/**
 * Every SQL string binds exactly as many values as it references.
 *
 * ## Why this exists
 *
 * A-7's branch scoping adds `$N` predicates to hundreds of existing queries. The coverage harness
 * in `tenancyCoverage.test.js` proves a query *mentions* the branch; it cannot prove the query still
 * runs, because there is no database here. During A-7 Phase 1 batch 5 a `$3` predicate was added to
 * a query that had no parameter array at all. Postgres would have thrown "there is no parameter $3"
 * the first time anyone opened the Report Center, and every gate in the repo was green.
 *
 * That is the gap this file closes: an arity mismatch between the placeholders in the SQL and the
 * values handed to `pool.query` / `client.query`.
 *
 * ## What it cannot check
 *
 * A query built with `${...}` interpolation can carry placeholders that only exist at runtime —
 * `${saleFilter}` expanding to `AND s.id = $4` is the normal pattern in this file. Those are counted
 * and reported, not guessed at. Silence about them is deliberate: a check that guesses produces
 * false failures, and a false failure is how a real one gets ignored.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

/** Walk from an opening bracket to its match, respecting strings, template literals and comments. */
const findClosing = (text, openIndex) => {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const stack = [pairs[text[openIndex]]];
  let i = openIndex + 1;
  while (i < text.length && stack.length) {
    const ch = text[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (quote === "`" && text[i] === "$" && text[i + 1] === "{") {
          const inner = findClosing(text, i + 1);
          if (inner === -1) return -1;
          i = inner + 1;
          continue;
        }
        if (text[i] === quote) break;
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") { i = text.indexOf("\n", i) + 1 || text.length; continue; }
    if (ch === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i) + 2; continue; }
    if (pairs[ch]) { stack.push(pairs[ch]); i += 1; continue; }
    if (ch === stack[stack.length - 1]) { stack.pop(); i += 1; continue; }
    i += 1;
  }
  return stack.length ? -1 : i - 1;
};

/** Split an argument list on commas that are not inside brackets, strings or template literals. */
const splitTopLevel = (text) => {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") { i += 2; continue; }
    if (ch === "'" || ch === '"' || ch === "`") {
      const closed = findClosing(`(${text.slice(i)}`, 0);
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") { i += 2; continue; }
        if (quote === "`" && text[i] === "$" && text[i + 1] === "{") {
          const inner = findClosing(text, i + 1);
          i = inner === -1 ? text.length : inner + 1;
          continue;
        }
        if (text[i] === quote) break;
        i += 1;
      }
      i += 1;
      void closed;
      continue;
    }
    if ("([{".includes(ch)) { depth += 1; i += 1; continue; }
    if (")]}".includes(ch)) { depth -= 1; i += 1; continue; }
    if (ch === "," && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
    i += 1;
  }
  parts.push(text.slice(start));
  return parts;
};

/** Every `.query(...)` call site with its SQL argument and its values argument. */
const collectQueryCalls = () => {
  const calls = [];
  const pattern = /\b(?:pool|client|db|tx)\.query\s*\(/g;
  let match;
  while ((match = pattern.exec(SOURCE)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = findClosing(SOURCE, open);
    if (close === -1) continue;
    const args = splitTopLevel(SOURCE.slice(open + 1, close)).map((part) => part.trim()).filter(Boolean);
    calls.push({
      line: SOURCE.slice(0, match.index).split("\n").length,
      sql: args[0] || "",
      values: args[1] || null,
    });
    pattern.lastIndex = close;
  }
  return calls;
};

const highestPlaceholder = (sql) =>
  (sql.match(/\$(\d+)/g) || []).reduce((highest, token) => Math.max(highest, Number(token.slice(1))), 0);

/**
 * How many values a call site binds, or null when that cannot be read statically.
 *
 * A **missing** second argument is zero, not unknown — and getting that wrong is why the first
 * version of this file failed to catch the bug it was written for. `pool.query(sql)` with a `$3` in
 * the SQL is broken beyond argument, so treating "no array" as unknowable made the check blind to
 * the single clearest form of the error.
 */
const literalArrayLength = (call) => {
  const { sql, values } = call;
  const looksLikeSqlLiteral = sql.startsWith("`") || sql.startsWith('"') || sql.startsWith("'");
  if (values === null) return looksLikeSqlLiteral ? 0 : null;
  if (!values.startsWith("[") || !values.endsWith("]")) return null;
  const inner = values.slice(1, -1).trim();
  if (!inner) return 0;
  return splitTopLevel(inner).filter((part) => part.trim()).length;
};

const calls = collectQueryCalls();
const isStatic = (call) => !call.sql.includes("${");

test("the scanner actually found the query call sites", () => {
  // Every assertion below passes vacuously if the parser breaks. server.js has hundreds of these.
  assert.ok(calls.length > 200, `expected hundreds of .query() calls, found ${calls.length}`);
});

test("no SQL string references a placeholder it was given no value for", () => {
  // The failure mode this file was written for. A query that says $3 and binds two values throws
  // "there is no parameter $3" at runtime, and passes every other gate in the repo.
  const mismatches = calls
    .filter(isStatic)
    .map((call) => ({ ...call, needs: highestPlaceholder(call.sql), has: literalArrayLength(call) }))
    .filter((call) => call.has !== null && call.needs > call.has)
    .map((call) => `server.js:${call.line} references $${call.needs} but binds ${call.has} value(s)`);
  assert.deepEqual(mismatches, []);
});

test("no SQL string is handed values it never references", () => {
  // The mirror image, and equally fatal: Postgres rejects a bind with more parameters than the
  // statement requires rather than ignoring the extras.
  const mismatches = calls
    .filter(isStatic)
    .map((call) => ({ ...call, needs: highestPlaceholder(call.sql), has: literalArrayLength(call) }))
    .filter((call) => call.has !== null && call.has > call.needs)
    .map((call) => `server.js:${call.line} binds ${call.has} value(s) but references only $${call.needs}`);
  assert.deepEqual(mismatches, []);
});

test("the interpolated queries this cannot check are counted, not ignored", () => {
  // These build their SQL with `${...}`, so their placeholder count only exists at runtime. The
  // number is asserted loosely so that a large jump — a wave of new dynamic SQL — is visible here
  // rather than silently expanding the blind spot.
  const dynamic = calls.filter((call) => !isStatic(call));
  assert.ok(
    dynamic.length < calls.length / 2,
    `${dynamic.length} of ${calls.length} query call sites build SQL dynamically and cannot be checked statically`,
  );
});
