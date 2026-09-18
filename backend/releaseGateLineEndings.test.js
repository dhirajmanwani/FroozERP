"use strict";

/**
 * The release gate must not depend on which kind of newline a file happens to have.
 *
 * ## What happened
 *
 * On 2026-09-17 the release workflow failed at "Verify updater safety gates" with:
 *
 *     Update safety verification failed:
 *     - The release workflow no longer runs `npm run build:windows`.
 *
 * about a workflow whose eleventh step is, verbatim, `run: npm run build:windows`. The check was
 *
 *     releaseWorkflow.includes("npm run build:windows\n")
 *
 * and the trailing newline is load-bearing: without it, `build:windows:local` would satisfy the
 * check, which is the exact confusion the gate exists to prevent. But the release is built on a
 * Windows runner, where `actions/checkout` writes CRLF, so the file said
 * `npm run build:windows\r\n` and the check asked for `\n`.
 *
 * ## Why it hid for ten days
 *
 * The check was added on 2026-09-07. Every gate in this repository runs on Linux, where it passed
 * every time. The release workflow is the one thing that runs only on Windows, and it had not been
 * run since August — so the first Windows execution of this check was also its first failure, at
 * the moment a release was wanted.
 *
 * That is the shape to guard: a rule that is only ever exercised in one environment, asserted with
 * a string comparison that another environment writes differently.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const GATE = fs.readFileSync(path.join(REPO, "scripts", "verify-update-safety.mjs"), "utf8");
const WORKFLOW = fs.readFileSync(
  path.join(REPO, ".github", "workflows", "windows-updater-release.yml"),
  "utf8",
);

/** The workflow as a Windows runner receives it. */
const asCrlf = (text) => text.replace(/\r?\n/g, "\r\n");
/** And as a Linux runner receives it, whatever it is on disk here. */
const asLf = (text) => text.replace(/\r?\n/g, "\n");

test("the release-build check matches the workflow under either line ending", () => {
  const pattern = /npm run build:windows(\r?\n|$)/;
  assert.ok(pattern.test(asLf(WORKFLOW)), "the check must pass on a Linux checkout");
  assert.ok(pattern.test(asCrlf(WORKFLOW)), "the check must pass on a Windows checkout — this is the one that failed");
});

test("the trailing newline is still required, so build:windows:local cannot satisfy it", () => {
  // The reason the newline is in the pattern at all. Losing it would make the gate pass for the
  // unsigned local build, and every published release would then carry no update.
  const pattern = /npm run build:windows(\r?\n|$)/;
  assert.equal(pattern.test("        run: npm run build:windows:local\r\n"), false);
  assert.equal(pattern.test("        run: npm run build:windows:local\n"), false);
});

test("no gate in verify-update-safety compares against a bare \\n again", () => {
  const offenders = [...GATE.matchAll(/\.includes\(\s*"[^"]*\\n[^"]*"\s*\)/g)].map((match) => match[0]);
  assert.deepEqual(
    offenders,
    [],
    `a newline inside includes() is a Windows-only failure waiting to happen:\n${offenders.join("\n")}`,
  );
});

test("the workflow still contains the step the gate is checking for", () => {
  // Belt and braces: if someone renames the build step, the gate should fail for the real reason
  // rather than this suite passing on a pattern that matches nothing.
  assert.match(WORKFLOW, /run: npm run build:windows(\r?\n|$)/, "the release build step is gone");
  assert.doesNotMatch(WORKFLOW, /run: npm run build:windows:local/, "the release must not build unsigned");
});
