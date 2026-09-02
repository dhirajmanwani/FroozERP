"use strict";

/**
 * The read-only command that says where a deployment stands.
 *
 * `scripts/show-setup.mjs` exists because the state that decides what is possible next is spread
 * across four tables, and reading it out of a hosting provider's table browser means scrolling a
 * grid sideways one table at a time and assembling the answer in your head.
 *
 * The part worth testing is `nextStep`. Three situations look nearly identical in a table and mean
 * different things:
 *
 *   - no counters and no approved machine -- the bootstrap command cannot run yet
 *   - no counters but a machine ready     -- the bootstrap command is the next step
 *   - counters exist, nothing posted      -- the bootstrap command is the wrong answer; use the app
 *
 * Getting that wrong sends somebody to a command that will refuse them, at the exact moment they
 * are least able to tell a refusal from a fault.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SCRIPT = path.join(__dirname, "..", "scripts", "show-setup.mjs");
const loadScript = () => import(require("node:url").pathToFileURL(SCRIPT).href);

const APPROVED = { device_id: "FZDEV-1", status: "APPROVED", posted_counter_id: null };
const COUNTER = { id: 1, location_name: "Main Branch Counter", active: true };

test("with no counters and no approved machine, it does not send you to a command that would refuse", async () => {
  const { nextStep } = await loadScript();
  const line = nextStep({ counters: [], devices: [{ ...APPROVED, status: "PENDING" }] });
  assert.match(line, /Approve a machine first/);
  assert.doesNotMatch(line, /^No counters yet/, "the bootstrap command cannot run without an approved machine");
});

test("with no counters but a machine ready, it names the bootstrap command", async () => {
  const { nextStep } = await loadScript();
  const line = nextStep({ counters: [], devices: [APPROVED] });
  assert.match(line, /bootstrap-first-counter\.mjs/);
  assert.match(line, /docs\/first-counter-setup\.md/, "and the page that explains it");
});

test("once a counter exists, it stops pointing at the bootstrap command", async () => {
  // The command refuses a second run by design. Recommending it here would be recommending a
  // refusal.
  const { nextStep } = await loadScript();
  const posted = nextStep({ counters: [COUNTER], devices: [{ ...APPROVED, posted_counter_id: 1 }] });
  assert.doesNotMatch(posted, /bootstrap-first-counter/);
  assert.match(posted, /Branches & Counters/);

  const unposted = nextStep({ counters: [COUNTER], devices: [APPROVED] });
  assert.doesNotMatch(unposted, /bootstrap-first-counter/);
  assert.match(unposted, /no machine is posted/);
});

test("a closed counter does not count as being set up", async () => {
  // A deployment whose only counter was retired is back to needing a first one. Counting it would
  // leave somebody staring at "set up" with an app that refuses to sell.
  const { nextStep } = await loadScript();
  const line = nextStep({ counters: [{ ...COUNTER, active: false }], devices: [APPROVED] });
  assert.match(line, /bootstrap-first-counter\.mjs/);
});

test("it only ever reads", async () => {
  // It is pointed at the live shop database by design, so this is the guarantee that matters more
  // than anything it prints.
  const source = fs.readFileSync(SCRIPT, "utf8");
  for (const forbidden of ["INSERT", "UPDATE ", "DELETE", "ALTER", "DROP", "BEGIN", "COMMIT", "TRUNCATE"]) {
    assert.ok(
      !source.toUpperCase().includes(`${forbidden}`) || !new RegExp(`client\\.query\\([^)]*${forbidden}`, "i").test(source),
      `show-setup.mjs must never ${forbidden}`,
    );
  }
  const queries = source.match(/client\.query\(\s*[`"]([^`"]*)/g) || [];
  assert.ok(queries.length >= 4, "expected the four reads");
  for (const query of queries) {
    assert.match(query, /SELECT/i, `every query must be a SELECT: ${query}`);
  }
});

test("the queries do not run concurrently on one client", async () => {
  // `pg` deprecates a second query on a client already executing one, and refuses it in pg 9.
  // Found by running this: the first version used Promise.all and warned on every invocation.
  // Comments stripped first -- the comment explaining why there is no Promise.all contains the
  // words "Promise.all", and a checker that cannot tell code from the prose about it is a checker
  // that fires on its own documentation.
  const code = fs.readFileSync(SCRIPT, "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  assert.doesNotMatch(code, /Promise\.all/, "one client, one query at a time");
});
