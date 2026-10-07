import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createSingleFlight } from "./syncSingleFlight.js";

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("a normal request joins the cycle already running", async () => {
  const flight = createSingleFlight();
  const gate = deferred();
  let starts = 0;
  const task = async () => {
    starts += 1;
    await gate.promise;
    return starts;
  };
  const first = flight.run(task);
  const second = flight.run(task);
  assert.equal(first, second);
  gate.resolve();
  assert.equal(await first, 1);
  assert.equal(starts, 1);
  assert.equal(flight.isRunning(), false);
});

test("a forced request that finds a cycle running waits for it, then runs one more", async () => {
  const flight = createSingleFlight();
  const gates = [deferred(), deferred()];
  const events = [];
  let starts = 0;
  const task = async () => {
    const n = starts;
    starts += 1;
    events.push(`start ${n}`);
    await gates[n].promise;
    events.push(`end ${n}`);
    return n;
  };
  const background = flight.run(task);
  await tick();
  const forced = flight.run(task, { force: true });
  assert.notEqual(forced, background);
  await tick();
  assert.equal(starts, 1, "the follow-up does not overlap the running cycle");
  gates[0].resolve();
  assert.equal(await background, 0);
  await tick();
  assert.equal(starts, 2);
  gates[1].resolve();
  assert.equal(await forced, 1, "the forced caller gets the cycle that started after its request");
  assert.deepEqual(events, ["start 0", "end 0", "start 1", "end 1"]);
});

test("forced requests made while a follow-up waits share it", async () => {
  const flight = createSingleFlight();
  const gate = deferred();
  let starts = 0;
  const task = async () => {
    starts += 1;
    if (starts === 1) await gate.promise;
    return starts;
  };
  flight.run(task);
  const a = flight.run(task, { force: true });
  const b = flight.run(task, { force: true });
  assert.equal(a, b);
  gate.resolve();
  assert.equal(await a, 2);
  assert.equal(starts, 2);
});

test("a forced request with nothing running starts straight away", async () => {
  const flight = createSingleFlight();
  let starts = 0;
  assert.equal(await flight.run(async () => { starts += 1; return "ok"; }, { force: true }), "ok");
  assert.equal(starts, 1);
});

test("a failed running cycle still lets the forced follow-up run", async () => {
  const flight = createSingleFlight();
  const gate = deferred();
  let starts = 0;
  const task = async () => {
    starts += 1;
    if (starts === 1) {
      await gate.promise;
      throw new Error("push failed");
    }
    return "second";
  };
  const first = flight.run(task);
  const forced = flight.run(task, { force: true });
  gate.resolve();
  await assert.rejects(first, /push failed/);
  assert.equal(await forced, "second");
});

test("syncNow routes through the single flight and re-checks Local Only when the cycle starts", () => {
  const source = fs.readFileSync(new URL("./syncService.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /runningSync/);
  assert.match(source, /export async function syncNow\(\{ apiUrl, user, deviceInfo, branchId, force = false \}\)/);
  const body = source.slice(source.indexOf("export async function syncNow("), source.indexOf("export async function initialPullForApprovedDevice"));
  const flightAt = body.indexOf("return syncFlight.run(async () => {");
  assert.ok(flightAt > 0);
  const inner = body.slice(flightAt);
  assert.ok(inner.indexOf("cloudAccessDisabledByOwner()") < inner.indexOf("initialiseSync("), "Local Only is checked inside the cycle before anything is sent");
  assert.match(body, /\{ force: force === true \}/);
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const runSync = app.slice(app.indexOf("const runSyncNow = async"), app.indexOf("const changeConnectivityMode = async"));
  assert.match(runSync, /branchId: user\.branch_id \|\| 1,\n\s+force,\n\s+\}\);/);
});
