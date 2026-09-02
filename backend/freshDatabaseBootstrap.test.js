"use strict";

/**
 * The startup schema must be able to build a database that does not exist yet.
 *
 * ## The bug this was written for
 *
 * `ai_settings` carries a foreign key to `branches(id)` and its seed inserts `branch_id = 1`. The
 * row that creates branch 1 sat **143 lines below it**. On every database anybody had ever run this
 * against, branch 1 already existed and the order did not matter. On a genuinely empty PostgreSQL
 * the bootstrap aborted on a foreign key violation, so a new cloud database could not be created at
 * all -- which is the one moment this path has to work: a new server, a restore from nothing, or a
 * disaster.
 *
 * It was found by running the real bootstrap against an empty PostgreSQL, not by reading the code,
 * and no test in this repo could have caught it: every backend test runs against a scripted fake
 * client that answers queries without enforcing a single constraint.
 *
 * ## What this file can and cannot do
 *
 * It cannot run PostgreSQL. So it checks the one property that failure reduces to: **a seed row
 * must not be written before the row it points at.** That is a statement about the order of
 * statements in one string, which is exactly what source text can prove.
 *
 * A real check needs a real database. `scripts/multibranch/` holds the harnesses for that, and the
 * bootstrap is now known to survive an empty one -- but nothing here runs it, so this ordering
 * guard is what stands between that finding and its return.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

/** Where a statement first appears, or -1. */
const at = (needle) => SOURCE.indexOf(needle);

test("the default branch is seeded before anything points at it", () => {
  const branchSeed = at("INSERT INTO branches (id, branch_name, location)");
  assert.ok(branchSeed > 0, "the default branch seed has been renamed or removed");

  // Every seed that carries a foreign key to branches(id). Each must come after the branch exists.
  const dependents = [
    ["ai_settings", "INSERT INTO ai_settings (id, company_id, branch_id"],
    ["counters", "INSERT INTO counters (id, branch_id, counter_name"],
  ];

  for (const [name, statement] of dependents) {
    const position = at(statement);
    assert.ok(position > 0, `${name}'s seed has been renamed or removed`);
    assert.ok(
      position > branchSeed,
      `${name} is seeded before branch 1 exists. On a database that already has branch 1 this `
      + "passes unnoticed; on an empty one the whole bootstrap aborts on a foreign key violation "
      + "and no new cloud database can be created.",
    );
  }
});

test("the branch seed is idempotent, because startup runs on every boot", () => {
  const seed = SOURCE.slice(
    at("INSERT INTO branches (id, branch_name, location)"),
    at("INSERT INTO branches (id, branch_name, location)") + 200,
  );
  assert.match(
    seed,
    /ON CONFLICT \(id\) DO NOTHING/,
    "this statement runs on every start; without ON CONFLICT the second boot fails",
  );
});

test("only one statement seeds the default branch", () => {
  // The fix moved the seed rather than copying it. Two copies would drift: one gains a column or a
  // name change and the other does not, and which one wins depends on which runs first.
  const occurrences = SOURCE.split("INSERT INTO branches (id, branch_name, location)").length - 1;
  assert.equal(occurrences, 1, `found ${occurrences} default-branch seeds; there must be exactly one`);
});
