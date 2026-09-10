"use strict";

/**
 * The device rows a machine leaves behind, and the ones it must never lose.
 *
 * A device id is minted per installation, not per machine, so every reinstall of the same counter
 * registers a new row and leaves the old one APPROVED and posted. The shop's cloud reached eleven
 * rows for one laptop, five of them in a single week.
 *
 * The danger in tidying that up is the opposite of the danger in leaving it: an approval or a
 * posting landing on the wrong row costs an evening, but retiring the row a till is actually using
 * takes that till off the air during trading. So the rules below are mostly about what is refused.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const SCRIPT = path.join(__dirname, "..", "scripts", "retire-devices.mjs");
const modulePath = pathToFileURL(SCRIPT).href;

const NOW = new Date("2026-09-10T00:00:00Z");
const daysAgo = (days) => new Date(NOW.getTime() - days * 86400000).toISOString();

const device = (overrides) => ({
  device_id: "FZDEV-1", device_name: "DELL - FroozERP", status: "APPROVED",
  posted: false, last_seen: null, ...overrides,
});

test("a posted device is never retired, however old it looks", async () => {
  // It may be somebody's till right now. Retiring it to tidy a list is the wrong trade in every
  // case, and no age makes it right.
  const { planRetirement } = await import(modulePath);
  const plan = planRetirement({
    devices: [
      device({ device_id: "LIVE", posted: true, last_seen: daysAgo(400) }),
      device({ device_id: "STALE", last_seen: daysAgo(90) }),
    ],
    now: NOW,
  });
  assert.deepEqual(plan.retire.map((d) => d.device_id), ["STALE"]);
  assert.deepEqual(plan.posted.map((d) => d.device_id), ["LIVE"]);
});

test("a registration that never completed is retirable immediately", async () => {
  // Never seen is not "idle for a while" -- it is a request that was never finished, which is
  // exactly what five of the shop's eleven rows were.
  const { planRetirement } = await import(modulePath);
  const plan = planRetirement({
    devices: [
      device({ device_id: "LIVE", posted: true, last_seen: daysAgo(1) }),
      device({ device_id: "NEVER", status: "PENDING", last_seen: null }),
    ],
    now: NOW,
  });
  assert.deepEqual(plan.retire.map((d) => d.device_id), ["NEVER"]);
});

test("a device that synced recently is left alone", async () => {
  const { planRetirement } = await import(modulePath);
  const plan = planRetirement({
    devices: [
      device({ device_id: "LIVE", posted: true }),
      device({ device_id: "RECENT", last_seen: daysAgo(3) }),
    ],
    now: NOW,
  });
  assert.equal(plan.refused, "NOTHING_TO_RETIRE");
  assert.deepEqual(plan.recentlyActive.map((d) => d.device_id), ["RECENT"]);
});

test("the idle threshold is a boundary, not a feeling", async () => {
  const { planRetirement } = await import(modulePath);
  const at = (days) => planRetirement({
    devices: [
      device({ device_id: "LIVE", posted: true }),
      device({ device_id: "EDGE", last_seen: daysAgo(days) }),
    ],
    now: NOW, idleDays: 30,
  });
  assert.equal(at(29).refused, "NOTHING_TO_RETIRE", "29 days is still recent");
  assert.deepEqual(at(30).retire.map((d) => d.device_id), ["EDGE"], "30 days is idle");
});

test("it refuses to leave the shop with no usable device", async () => {
  // Every row unposted and idle is not a tidying job -- it is a shop that cannot bill. The refusal
  // names the command that fixes the actual problem.
  const { planRetirement } = await import(modulePath);
  const plan = planRetirement({
    devices: [
      device({ device_id: "A", last_seen: daysAgo(90) }),
      device({ device_id: "B", last_seen: null }),
    ],
    now: NOW,
  });
  assert.equal(plan.refused, "WOULD_RETIRE_EVERY_DEVICE");
  assert.match(plan.message, /approve-device/, "the refusal must say what to do instead");
  assert.equal(plan.retire, undefined, "a refusal must not also carry writes");
});

test("rows already retired or refused are not touched again", async () => {
  const { planRetirement, RETIRABLE } = await import(modulePath);
  assert.deepEqual([...RETIRABLE], ["PENDING", "APPROVED"]);
  const plan = planRetirement({
    devices: [
      device({ device_id: "LIVE", posted: true }),
      device({ device_id: "GONE", status: "DISABLED", last_seen: daysAgo(90) }),
      device({ device_id: "NO", status: "REJECTED", last_seen: null }),
    ],
    now: NOW,
  });
  assert.equal(plan.refused, "NOTHING_TO_RETIRE");
});

test("more than one posted row for a machine is reported, not resolved", async () => {
  // Which of two identical posted rows is the real till cannot be known from here. Guessing would
  // be the one mistake that costs trading time.
  const { planRetirement } = await import(modulePath);
  const plan = planRetirement({
    devices: [
      device({ device_id: "A", posted: true, last_seen: daysAgo(1) }),
      device({ device_id: "B", posted: true, last_seen: daysAgo(200) }),
      device({ device_id: "C", last_seen: null }),
    ],
    now: NOW,
  });
  assert.deepEqual(plan.retire.map((d) => d.device_id), ["C"]);
  assert.equal(plan.posted.length, 2, "both stay, and both are shown");
});

test("it disables rather than deletes, and only what it planned", async () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(!/DELETE FROM/i.test(source), "a device row is the record that a machine was approved");
  assert.ok(!/DROP |TRUNCATE/i.test(source));

  const joined = source.replace(/"\s*\+\s*"/g, "");
  const updates = [...joined.matchAll(/UPDATE [^`"]*/g)].map(([text]) => text).filter((t) => t.includes("SET"));
  assert.equal(updates.length, 1, `expected exactly one write, found ${updates.length}`);
  assert.match(updates[0], /status = 'DISABLED'/, "DISABLED is the status the app already uses");
  assert.match(updates[0], /device_id = ANY\(\$1::TEXT\[\]\)/, "it must write only to the planned ids");
  assert.match(updates[0], /status = ANY\(\$2::TEXT\[\]\)/, "and only to rows still in a retirable state");
});

test("it writes nothing without --apply", async () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.match(source, /const apply = argv\.includes\("--apply"\)/);
  const guardAt = source.indexOf("if (!apply)");
  const writeAt = source.indexOf('await client.query("BEGIN")');
  assert.notEqual(guardAt, -1, "the dry-run guard must exist");
  assert.notEqual(writeAt, -1, "the transaction must exist");
  assert.ok(guardAt < writeAt, "the dry run must return before the transaction");
});
