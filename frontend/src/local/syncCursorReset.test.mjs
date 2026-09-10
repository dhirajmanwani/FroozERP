import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decideReferenceBootstrap } from "./referenceBootstrapDecision.js";

/**
 * The one-way door in the bootstrap, and the way back out of it.
 *
 * ## The trap
 *
 * `syncService.js` requests the reference bootstrap only while the cursor is still zero:
 *
 *     bootstrap_protocol: cursor === "0" ? "reference-v1" : undefined
 *
 * The bootstrap is the only thing that fills a device from the cloud. Applying it stores the
 * server's high watermark as the cursor, and from then on the device asks only for changes after
 * that point, read from `sync_change_log`. The shop's existing products, suppliers and lots are
 * not in that log -- they are older than it. They can arrive by bootstrap or not at all.
 *
 * So a bootstrap that returns zero rows is a one-way door, and the DELL walked through it: the
 * cloud's rows had no company id, none matched, nothing was sent, and the watermark was recorded
 * anyway. Valid session, healthy cloud, approved assignment, no error -- and no way through any
 * screen in the app to ask again. Repairing the cloud afterwards does nothing by itself, because
 * the device has stopped asking the question whose answer holds the data.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(here, "..", "..", "..", "scripts", "reset-sync-cursor.mjs");
const modulePath = new URL(`file://${SCRIPT}`).href;

test("setting the cursor to zero still causes a bootstrap", () => {
  // The gate this script was written against has since been replaced: the app now also asks again
  // when it holds a cursor and no reference rows at all, so a device on a current build recovers
  // from an empty bootstrap by itself and never needs this.
  //
  // The script is not therefore dead. It is the escape hatch for a device running a build older
  // than that fix -- which is every counter until the next installer reaches it, including the one
  // this was written for. What it depends on is narrower now, and this is that dependency: a zero
  // cursor must still mean "ask for everything".
  const decision = decideReferenceBootstrap({ cursor: "0", referenceRows: 0 });
  assert.equal(decision.bootstrap, true, "the reset only helps while a zero cursor asks for a bootstrap");
  assert.equal(decision.reason, "NEVER_BOOTSTRAPPED");

  const syncService = fs.readFileSync(path.join(here, "syncService.js"), "utf8");
  assert.match(
    syncService,
    /bootstrap_protocol: bootstrapProtocolFor\(\{/,
    "the pull must still decide through the shared rule",
  );
});

test("a device that has already bootstrapped is offered the reset", async () => {
  const { planReset } = await import(modulePath);
  const plan = planReset({
    syncRows: [{ device_id: "FZDEV-1", last_pull_cursor: "48213" }],
    pendingOperations: 0,
  });
  assert.equal(plan.refused, undefined);
  assert.deepEqual(plan.rows, [{ device_id: "FZDEV-1", from: "48213" }]);
});

test("a cursor already at zero is left alone", async () => {
  // Re-running must not report a successful reset of nothing: the next question the maintainer
  // asks is "did it work", and a false yes sends them looking in the wrong place.
  const { planReset } = await import(modulePath);
  for (const cursor of ["0", "", null, undefined]) {
    assert.equal(
      planReset({ syncRows: [{ device_id: "FZDEV-1", last_pull_cursor: cursor }], pendingOperations: 0 }).refused,
      "ALREADY_ZERO",
      `cursor ${JSON.stringify(cursor)} is already a bootstrap-requesting state`,
    );
  }
});

test("a device with no sync state is told it will bootstrap anyway", async () => {
  const { planReset } = await import(modulePath);
  assert.equal(planReset({ syncRows: [], pendingOperations: 0 }).refused, "NO_SYNC_STATE");
});

test("unpushed work is reported and not touched", async () => {
  // The pull cursor has no bearing on the outbox, but a maintainer about to reset sync state on a
  // shop's till needs to be told that in the same breath, not reassured afterwards.
  const { planReset } = await import(modulePath);
  const plan = planReset({
    syncRows: [{ device_id: "FZDEV-1", last_pull_cursor: "9" }],
    pendingOperations: 4,
  });
  assert.equal(plan.pendingOperations, 4);

  const source = fs.readFileSync(SCRIPT, "utf8");
  const writes = [...source.matchAll(/db\.prepare\(\s*"([^"]*(?:UPDATE|DELETE|INSERT)[^"]*)"/gi)]
    .map(([, sql]) => sql);
  assert.ok(writes.length >= 2, `expected the two writes, found ${writes.length}`);
  for (const sql of writes) {
    assert.ok(
      !/sync_outbox/i.test(sql),
      `the reset must never write to the outbox: ${sql.slice(0, 70)}`,
    );
  }
  assert.ok(
    writes.some((sql) => /UPDATE sync_state/i.test(sql)),
    "the cursor must actually be reset",
  );
});

test("it writes nothing without --apply", async () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.match(source, /const apply = argv\.includes\("--apply"\)/);
  assert.ok(
    source.indexOf("if (!apply)") < source.indexOf('db.exec("BEGIN")'),
    "the dry-run check must come before the transaction that writes",
  );
});

test("it never drops a table or deletes business rows", async () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  const deletes = [...source.matchAll(/DELETE FROM (\w+)/gi)].map(([, table]) => table);
  assert.deepEqual(deletes, ["local_kv"], "only the bootstrap-applied note may be removed");
  assert.ok(!/\bDROP\s+TABLE\b/i.test(source));
  assert.ok(!/\bTRUNCATE\b/i.test(source));
});
