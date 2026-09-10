import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrapProtocolFor, decideReferenceBootstrap } from "./referenceBootstrapDecision.js";

/**
 * A bootstrap that delivered nothing must be askable again.
 *
 * The shop's DELL held a valid session, an approved assignment, a healthy cloud, an IDLE sync
 * state with no error -- and every business table empty, with no way through any screen in the app
 * to ask the cloud again. It had bootstrapped once, received zero rows because every row on the
 * cloud had `company_id NULL`, and stored the server's high watermark anyway. From then on it only
 * asked for changes newer than that watermark, and the shop's products were older than the log
 * those changes come from.
 *
 * Repairing the cloud did not fix it. The device had stopped asking the question.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

test("a device that has never been filled asks", () => {
  for (const cursor of ["0", "", null, undefined, "  "]) {
    const decision = decideReferenceBootstrap({ cursor, referenceRows: 0 });
    assert.equal(decision.bootstrap, true, `cursor ${JSON.stringify(cursor)} must still bootstrap`);
    assert.equal(decision.reason, "NEVER_BOOTSTRAPPED");
  }
});

test("a device holding a cursor and nothing else asks again", () => {
  // The exact state the DELL was trapped in, and the whole reason this module exists.
  const decision = decideReferenceBootstrap({ cursor: "48213", referenceRows: 0 });
  assert.equal(decision.bootstrap, true);
  assert.equal(decision.reason, "BOOTSTRAP_DELIVERED_NOTHING");
});

test("a filled device does not ask on every pull", () => {
  // The cost of getting this wrong is a full reference transfer on every sync, forever.
  const decision = decideReferenceBootstrap({ cursor: "48213", referenceRows: 108 });
  assert.equal(decision.bootstrap, false);
  assert.equal(decision.reason, "ALREADY_FILLED");
});

test("an unreadable count is not treated as an empty device", () => {
  // `null` means the count could not be read -- an older build, a status that failed. Reading that
  // as zero would make a working counter re-transfer the whole shop on every pull.
  for (const referenceRows of [null, undefined, "", NaN, "not a number"]) {
    assert.equal(
      decideReferenceBootstrap({ cursor: "48213", referenceRows }).bootstrap,
      false,
      `referenceRows ${JSON.stringify(referenceRows)} must not force a bootstrap`,
    );
  }
});

test("a count that arrives as a string still counts", () => {
  // It crosses the Tauri boundary as JSON and has been seen as both.
  assert.equal(decideReferenceBootstrap({ cursor: "48213", referenceRows: "0" }).bootstrap, true);
  assert.equal(decideReferenceBootstrap({ cursor: "48213", referenceRows: "108" }).bootstrap, false);
});

test("the protocol value is the one the route expects, or nothing", () => {
  assert.equal(bootstrapProtocolFor({ cursor: "0", referenceRows: 0 }), "reference-v1");
  assert.equal(bootstrapProtocolFor({ cursor: "48213", referenceRows: 108 }), undefined);
});

test("the sync path asks through this rule, not through the cursor", () => {
  // The bug lived in syncService.js. This module being right is not enough.
  const syncService = fs.readFileSync(path.join(here, "syncService.js"), "utf8");
  assert.ok(
    !syncService.includes('cursor === "0" ? "reference-v1" : undefined'),
    "the cursor test that trapped the device must be gone",
  );
  assert.match(syncService, /bootstrap_protocol: bootstrapProtocolFor\(\{/);
  assert.match(syncService, /referenceRows: localStatus\.referenceRows/);
});

test("the count is carried from Rust all the way to the decision", () => {
  // Three files have to agree or the rule silently receives undefined and never fires -- which
  // looks exactly like the bug it replaces.
  const rust = fs.readFileSync(path.join(here, "..", "..", "..", "src-tauri", "src", "local_db.rs"), "utf8");
  assert.match(rust, /pub reference_rows: i64/, "the Rust status must carry the count");
  assert.match(rust, /SELECT COUNT\(\*\) FROM local_products/, "it must actually count the reference tables");
  assert.match(rust, /local_supplier_references/);
  assert.match(rust, /local_inventory_lots/);

  const localDatabase = fs.readFileSync(path.join(here, "localDatabase.js"), "utf8");
  assert.match(localDatabase, /referenceRows:/, "normalizeStatus must expose it to JS");
  assert.match(localDatabase, /status\?\.reference_rows/, "and must read the field Rust emits");
});
