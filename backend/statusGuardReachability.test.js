"use strict";

/**
 * No status denylist sits behind an allowlist that has already excluded it.
 *
 * ## Why this exists
 *
 * `requireSyncContext` used to read:
 *
 * ```js
 * if (device.status !== "APPROVED") { return { error: ... }; }
 * if (["DISABLED", "REVOKED"].includes(String(device.status || "").toUpperCase())) {
 *   return { error: { status: 403, message: "Device is disabled or revoked" } };
 * }
 * ```
 *
 * The second `if` could not run. Any status that is not exactly `APPROVED` returned on the line
 * above, so a `DISABLED` or `REVOKED` device never reached it. It read as defence in depth and was
 * a comment pretending to be a check — worse than nothing, because the next person to ask "are
 * revoked devices refused?" finds a line that says yes and stops looking.
 *
 * The shape, not the site, is the bug: an allowlist guard that exits, followed in the same scope by
 * a test against statuses the allowlist has already excluded. This file rejects that shape anywhere
 * in `server.js`. Deleting the one occurrence fixed today; this stops it coming back, and stops the
 * same dead reassurance being written against `users.active`, an order state, or anything else with
 * a status column.
 *
 * ## What counts as a violation
 *
 * An allowlist guard is `if (<subject>.status !== "LITERAL") <exit>` or
 * `if (!["A", "B"].includes(<subject>.status)) <exit>`, where `<exit>` is a `return` or a `throw`,
 * braced or not — a guard that always leaves, so everything after it is reached only by an allowed
 * status. A violation is a later condition, in the same block, testing that same status against
 * literals none of which the guard admits.
 *
 * ## What it cannot check
 *
 * Deliberately silent, rather than guessing, about:
 *
 * - guards whose exit is not their first statement (a conditional `return` inside the block),
 * - `switch` on a status, and destructured status values (`const { status } = device`),
 * - a status read back through a helper call rather than a property access,
 * - a subject reassigned after the guard — the window ends there, because the new value has not
 *   been through the guard.
 *
 * Each of those is a false negative, never a false positive. A check that guesses produces false
 * failures, and a false failure is how a real one gets ignored.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

/**
 * A same-length copy of the source with the *contents* of comments, strings, template literals and
 * regex literals blanked, and their delimiters and all surrounding code left in place. Offsets are
 * preserved, so any position found in the mask indexes the original text unchanged, and — because
 * no bracket survives inside a string — bracket matching over the mask is a plain counter.
 *
 * Regex literals matter here and are not decoration: `server.js` contains
 * `.replace(/[<>:"/\\|?*\x00-\x1F]/g, "")`, whose `"` would otherwise open a string that swallows
 * the rest of the function.
 */
const maskNonCode = (text) => {
  const out = text.split("");
  const blank = (i) => { if (text[i] !== "\n") out[i] = " "; };
  // A `/` opens a regex only where a value may start. After a name, a literal or a closing bracket
  // it is division.
  const REGEX_MAY_FOLLOW = /(?:[({[,;:=!?&|+\-*%^~<>]|\breturn|\bcase|\btypeof|\bin|\bof|\bdo|\belse|\byield|\bawait|\bvoid|\bdelete|\binstanceof|\bnew)\s*$/;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") { blank(i); i += 1; }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      while (i < stop) { blank(i); i += 1; }
      continue;
    }
    if (ch === "/" && REGEX_MAY_FOLLOW.test(out.slice(0, i).join(""))) {
      i += 1;
      let inClass = false;
      while (i < text.length && text[i] !== "\n") {
        if (text[i] === "\\") { blank(i); blank(i + 1); i += 2; continue; }
        if (text[i] === "[") inClass = true;
        else if (text[i] === "]") inClass = false;
        else if (text[i] === "/" && !inClass) { i += 1; break; }
        blank(i);
        i += 1;
      }
      while (i < text.length && /[a-z]/.test(text[i])) i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === "\\") { blank(i); blank(i + 1); i += 2; continue; }
        if (text[i] === quote) { i += 1; break; }
        blank(i);
        i += 1;
      }
      continue;
    }
    if (ch === "`") {
      i += 1;
      let depth = 0;
      while (i < text.length) {
        if (text[i] === "\\") { blank(i); blank(i + 1); i += 2; continue; }
        // `${...}` holds real code, so it is left visible; its braces keep the mask balanced.
        if (text[i] === "$" && text[i + 1] === "{") { depth += 1; i += 2; continue; }
        if (depth > 0) {
          if (text[i] === "}") depth -= 1;
          i += 1;
          continue;
        }
        if (text[i] === "`") { i += 1; break; }
        blank(i);
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return out.join("");
};

/** Index of the bracket closing the one at `openIndex`, counted over the mask. -1 if unbalanced. */
const matchBracket = (mask, openIndex) => {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const close = pairs[mask[openIndex]];
  let depth = 0;
  for (let i = openIndex; i < mask.length; i += 1) {
    if (mask[i] === mask[openIndex]) depth += 1;
    else if (mask[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** Every string literal in a fragment, minus empty ones — `|| ""` is normalisation, not a status. */
const stringLiterals = (fragment) => {
  const found = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
  let match;
  while ((match = pattern.exec(fragment))) {
    const value = match[1] === undefined ? match[2] : match[1];
    if (value !== "") found.push(value);
  }
  return found;
};

/** Split a condition on top-level `&&` / `||`, so an unrelated conjunct contributes no literals. */
const splitConjuncts = (condition, conditionMask) => {
  const parts = [];
  let start = 0;
  let i = 0;
  while (i < condition.length) {
    const ch = conditionMask[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      const close = matchBracket(conditionMask, i);
      i = close === -1 ? condition.length : close + 1;
      continue;
    }
    if ((ch === "&" && conditionMask[i + 1] === "&") || (ch === "|" && conditionMask[i + 1] === "|")) {
      parts.push(condition.slice(start, i));
      i += 2;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push(condition.slice(start));
  return parts;
};

const PROPERTY_PATH = "[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*";

/** Read an allowlist guard out of an `if` condition, or null if the condition is not one. */
const readAllowlistGuard = (condition) => {
  const inequality = new RegExp(`^\\s*(${PROPERTY_PATH})\\.status\\s*!==?\\s*"([^"]+)"\\s*$`).exec(condition);
  if (inequality) return { subject: inequality[1], allowed: [inequality[2]] };

  const negatedIncludes = /^\s*!\s*\[([^\]]*)\]\s*\.includes\s*\(([\s\S]*)\)\s*$/.exec(condition);
  if (negatedIncludes) {
    const subject = new RegExp(`(${PROPERTY_PATH})\\.status\\b`).exec(negatedIncludes[2]);
    const allowed = stringLiterals(negatedIncludes[1]);
    if (subject && allowed.length) return { subject: subject[1], allowed };
  }
  return null;
};

/**
 * Report every status test that an earlier allowlist guard has already made unreachable.
 * Returns `{ subject, allowed, condition, line }` per finding.
 */
const findUnreachableStatusChecks = (source) => {
  const mask = maskNonCode(source);
  const lineOf = (index) => source.slice(0, index).split("\n").length;
  const findings = [];

  const ifPattern = /\bif\s*\(/g;
  let guardMatch;
  while ((guardMatch = ifPattern.exec(mask))) {
    const parenIndex = guardMatch.index + guardMatch[0].length - 1;
    const parenEnd = matchBracket(mask, parenIndex);
    if (parenEnd === -1) continue;
    const guard = readAllowlistGuard(source.slice(parenIndex + 1, parenEnd));
    if (!guard) continue;

    // The guard only makes what follows unreachable if the guard itself always leaves.
    let cursor = parenEnd + 1;
    while (cursor < mask.length && /\s/.test(mask[cursor])) cursor += 1;
    let guardEnd;
    let body;
    if (mask[cursor] === "{") {
      const blockEnd = matchBracket(mask, cursor);
      if (blockEnd === -1) continue;
      body = source.slice(cursor + 1, blockEnd);
      guardEnd = blockEnd;
    } else {
      // `if (...) return x;` — the statement runs to its terminating semicolon.
      let i = cursor;
      while (i < mask.length && mask[i] !== ";") {
        if (mask[i] === "{" || mask[i] === "(" || mask[i] === "[") {
          const close = matchBracket(mask, i);
          if (close === -1) break;
          i = close + 1;
          continue;
        }
        i += 1;
      }
      body = source.slice(cursor, i);
      guardEnd = i;
    }
    if (!/^\s*(return\b|throw\b)/.test(body)) continue;

    // The window runs from the guard to the end of the enclosing block.
    let windowEnd = source.length;
    let depth = 0;
    for (let i = guardEnd + 1; i < mask.length; i += 1) {
      const ch = mask[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        if (depth === 0) { windowEnd = i; break; }
        depth -= 1;
      }
    }

    const escaped = guard.subject.replace(/\./g, "\\.");
    // A reassigned subject has not been through the guard, so the window stops there.
    const reassignAt = new RegExp(`\\b${escaped}\\s*(?:\\.status\\s*)?=[^=]`).exec(
      mask.slice(guardEnd + 1, windowEnd),
    );
    if (reassignAt) windowEnd = guardEnd + 1 + reassignAt.index;

    const windowStart = guardEnd + 1;
    const windowMask = mask.slice(windowStart, windowEnd);
    const tracked = new Map([[guard.subject, "subject"]]);
    const referencesTracked = (fragment) => {
      for (const [name, kind] of tracked) {
        const escapedName = name.replace(/\./g, "\\.");
        const needle = kind === "subject"
          ? new RegExp(`\\b${escapedName}\\.status\\b`)
          : new RegExp(`\\b${escapedName}\\b`);
        if (needle.test(fragment)) return true;
      }
      return false;
    };

    const events = [];
    const aliasPattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
    const nestedIfPattern = /\bif\s*\(/g;
    let hit;
    while ((hit = aliasPattern.exec(windowMask))) {
      events.push({ at: hit.index + hit[0].length, kind: "alias", name: hit[1] });
    }
    while ((hit = nestedIfPattern.exec(windowMask))) {
      events.push({ at: hit.index + hit[0].length - 1, kind: "if" });
    }
    events.sort((a, b) => a.at - b.at);

    for (const event of events) {
      if (event.kind === "alias") {
        const semicolon = windowMask.indexOf(";", event.at);
        const rhs = source.slice(
          windowStart + event.at,
          windowStart + (semicolon === -1 ? windowMask.length : semicolon),
        );
        if (referencesTracked(rhs)) tracked.set(event.name, "alias");
        continue;
      }
      const openIndex = windowStart + event.at;
      const closeIndex = matchBracket(mask, openIndex);
      if (closeIndex === -1) continue;
      const condition = source.slice(openIndex + 1, closeIndex);
      const conditionMask = mask.slice(openIndex + 1, closeIndex);
      for (const conjunct of splitConjuncts(condition, conditionMask)) {
        if (!referencesTracked(conjunct)) continue;
        const literals = stringLiterals(conjunct);
        if (!literals.length) continue;
        if (literals.some((literal) => guard.allowed.includes(literal))) continue;
        findings.push({
          subject: guard.subject,
          allowed: guard.allowed,
          condition: conjunct.trim().replace(/\s+/g, " "),
          line: lineOf(openIndex),
        });
      }
    }
  }
  return findings;
};

const SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("the source scanner stays in sync with server.js", () => {
  // If the mask mistook a regex literal for a string it would blank real code, and this check would
  // go quiet instead of going wrong. Balanced braces is the cheapest proof that it did not.
  const mask = maskNonCode(SOURCE);
  assert.equal(mask.length, SOURCE.length);
  let depth = 0;
  let lowest = 0;
  for (const ch of mask) {
    if (ch === "{") depth += 1;
    else if (ch === "}") { depth -= 1; lowest = Math.min(lowest, depth); }
  }
  assert.equal(depth, 0, "brace depth did not return to zero — the mask lost sync with the file");
  assert.equal(lowest, 0, "brace depth went negative — the mask lost sync with the file");
});

test("no status denylist sits behind an allowlist that already excluded it", () => {
  const findings = findUnreachableStatusChecks(SOURCE);
  const report = findings
    .map((f) => `server.js:${f.line}: \`${f.condition}\` cannot run — an earlier guard already `
      + `returned unless ${f.subject}.status is one of ${f.allowed.map((s) => `"${s}"`).join(", ")}`)
    .join("\n");
  assert.deepEqual(findings, [], `unreachable status checks:\n${report}`);
});

// The fixtures below keep the detector honest. A checker that silently stopped detecting anything
// would leave the assertion above green forever, which is the same failure this whole file exists
// to prevent.

const fixture = (body) => `const handler = async (device) => {\n${body}\n};\n`;

test("it catches the shape that was in requireSyncContext", () => {
  const findings = findUnreachableStatusChecks(fixture(`
  if (device.status !== "APPROVED") {
    return { error: { status: 403, message: "Device is not approved for sync" } };
  }
  if (["DISABLED", "REVOKED"].includes(String(device.status || "").toUpperCase())) {
    return { error: { status: 403, message: "Device is disabled or revoked" } };
  }
`));
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.deepEqual(findings[0].allowed, ["APPROVED"]);
  assert.match(findings[0].condition, /DISABLED/);
});

test("it catches a denylist behind a guard that returns without braces", () => {
  const findings = findUnreachableStatusChecks(fixture(`
  if (device.status !== "APPROVED") return { error: "denied" };
  if (device.status === "REVOKED") return { error: "revoked" };
`));
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.match(findings[0].condition, /REVOKED/);
});

test("it catches a denylist reached through an alias of the same status", () => {
  const findings = findUnreachableStatusChecks(fixture(`
  if (device.status !== "APPROVED") throw new Error("nope");
  const deviceStatus = String(device.status || "").toUpperCase();
  if (deviceStatus === "REVOKED") {
    return { error: "revoked" };
  }
`));
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.match(findings[0].condition, /REVOKED/);
});

test("it catches a denylist behind a multi-value allowlist", () => {
  const findings = findUnreachableStatusChecks(fixture(`
  if (!["APPROVED", "TRIAL"].includes(device.status)) {
    return { error: "not allowed" };
  }
  if (device.status === "TRIAL") return { warn: true };
  if (device.status === "REVOKED") return { error: "revoked" };
`));
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.match(findings[0].condition, /REVOKED/);
});

test("it catches a denylist nested inside a later block", () => {
  const findings = findUnreachableStatusChecks(fixture(`
  if (device.status !== "APPROVED") return { error: "denied" };
  if (device.assigned_branch_id) {
    if (device.status === "DISABLED") return { error: "disabled" };
  }
`));
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.match(findings[0].condition, /DISABLED/);
});

test("it accepts a status test the allowlist still admits", () => {
  const findings = findUnreachableStatusChecks(fixture(`
  if (device.status !== "APPROVED") return { error: "denied" };
  if (device.status === "APPROVED" && device.platform === "Browser") {
    return { ok: true };
  }
`));
  assert.deepEqual(findings, []);
});

test("it accepts an unrelated literal comparison beside the status", () => {
  const findings = findUnreachableStatusChecks(fixture(`
  if (device.status !== "APPROVED") return { error: "denied" };
  if (device.status && device.platform === "Browser") {
    return { ok: true };
  }
`));
  assert.deepEqual(findings, []);
});

test("it accepts the denylist placed before the allowlist", () => {
  const findings = findUnreachableStatusChecks(fixture(`
  if (["DISABLED", "REVOKED"].includes(device.status)) {
    return { error: "revoked" };
  }
  if (device.status !== "APPROVED") {
    return { error: "denied" };
  }
`));
  assert.deepEqual(findings, []);
});

test("it accepts a status branch inside the guard's own body, which is the reachable place for one", () => {
  // This is the `/login` shape: the allowlist rejects, and the rejecting branch decides which
  // refusal to report. Every literal there is reachable.
  const findings = findUnreachableStatusChecks(fixture(`
  if (device.status !== "APPROVED") {
    return {
      code: device.status === "DISABLED" ? "DEVICE_DISABLED" : "DEVICE_PENDING_APPROVAL",
    };
  }
`));
  assert.deepEqual(findings, []);
});

test("it accepts a status test after the subject is reassigned", () => {
  const findings = findUnreachableStatusChecks(fixture(`
  if (device.status !== "APPROVED") return { error: "denied" };
  device = await refreshDevice(device);
  if (device.status === "REVOKED") return { error: "revoked" };
`));
  assert.deepEqual(findings, []);
});

test("it accepts a guard that does not exit, because nothing after it is unreachable", () => {
  const findings = findUnreachableStatusChecks(fixture(`
  if (device.status !== "APPROVED") {
    warnings.push("device not approved");
  }
  if (device.status === "REVOKED") return { error: "revoked" };
`));
  assert.deepEqual(findings, []);
});

test("it accepts a status test outside the guard's block", () => {
  const findings = findUnreachableStatusChecks(`
const handler = async (device) => {
  if (device.status !== "APPROVED") return { error: "denied" };
  return { ok: true };
};
const audit = (device) => {
  if (device.status === "REVOKED") return "revoked";
  return "other";
};
`);
  assert.deepEqual(findings, []);
});

test("it ignores the shape when it appears in a comment or a string", () => {
  const findings = findUnreachableStatusChecks(fixture(`
  // if (device.status !== "APPROVED") { return 1; }
  // if (device.status === "REVOKED") { return 2; }
  const sql = 'if (device.status !== "APPROVED") { return 1; } if (device.status === "REVOKED") {}';
  return sql;
`));
  assert.deepEqual(findings, []);
});

test("it survives a regex literal that contains a quote", () => {
  const findings = findUnreachableStatusChecks(fixture(`
  const safe = device.name.replace(/[<>:"/\\\\|?*]/g, "");
  if (device.status !== "APPROVED") return { error: "denied", safe };
  if (device.status === "REVOKED") return { error: "revoked" };
`));
  assert.equal(findings.length, 1, JSON.stringify(findings));
  assert.match(findings[0].condition, /REVOKED/);
});
