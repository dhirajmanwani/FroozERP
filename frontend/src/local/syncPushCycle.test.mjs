import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  REPLAY_IDENTITY_FIELDS,
  purchaseReplayBody,
  runPushCycle,
  runPushThenPull,
} from "./syncPushCycle.js";

const sale = (id) => ({ operation_id: id, entity_type: "sale", payload: { total: 10 } });
const purchase = (id, payload = {}) => ({ operation_id: id, entity_type: "purchase_grn", payload });
const accepted = (id) => ({ operation_id: id, status: "accepted" });

/** An in-memory outbox recording what got settled and what went back to pending. */
const harness = ({ pushRegular, replayPurchase } = {}) => {
  const applied = [];
  const released = [];
  return {
    applied,
    released,
    io: {
      now: () => "2026-10-04T00:00:00.000Z",
      pushRegular: pushRegular || (async (ops) => ({ acknowledgements: ops.map((op) => accepted(op.operation_id)), serverTime: "t1" })),
      replayPurchase: replayPurchase || (async (op) => ({ acknowledgement: accepted(op.operation_id), serverTime: "t2" })),
      applyAcks: async (acks, serverTime) => {
        applied.push(...acks.map((ack) => ack.operation_id));
        return { pendingOperations: 0, serverTime };
      },
      release: async (ids, message) => { released.push(...ids.map((id) => ({ id, message }))); },
    },
  };
};

const sessionRefused = () => Object.assign(new Error("Request failed with status code 403"), { response: { status: 403 } });

test("sales the server accepted stay synced when a purchase replay then throws", async () => {
  const h = harness({ replayPurchase: async () => { throw sessionRefused(); } });
  await assert.rejects(
    runPushCycle({ ...h.io, operations: [sale("s1"), sale("s2"), purchase("p1"), purchase("p2")] }),
    /403/,
  );
  assert.deepEqual(h.applied, ["s1", "s2"], "the sale acks are applied before any purchase is replayed");
  assert.deepEqual(h.released.map((entry) => entry.id), ["p1", "p2"], "only the purchases go back to pending");
});

test("a purchase accepted before a later one throws is not released", async () => {
  let calls = 0;
  const h = harness({
    replayPurchase: async (op) => {
      calls += 1;
      if (calls === 2) throw new Error("Network Error");
      return { acknowledgement: accepted(op.operation_id) };
    },
  });
  await assert.rejects(runPushCycle({ ...h.io, operations: [purchase("p1"), purchase("p2"), purchase("p3")] }));
  assert.deepEqual(h.applied, ["p1"]);
  assert.deepEqual(h.released.map((entry) => entry.id), ["p2", "p3"]);
});

test("a failed /api/sync/push releases everything, as before", async () => {
  const h = harness({ pushRegular: async () => { throw new Error("Network Error"); } });
  await assert.rejects(runPushCycle({ ...h.io, operations: [sale("s1"), purchase("p1")] }));
  assert.deepEqual(h.applied, []);
  assert.deepEqual(h.released.map((entry) => entry.id).sort(), ["p1", "s1"]);
});

test("an operation a 200 response did not acknowledge is released, not left syncing", async () => {
  const h = harness({ pushRegular: async () => ({ acknowledgements: [accepted("s1"), accepted("not-sent")] }) });
  const result = await runPushCycle({ ...h.io, operations: [sale("s1"), sale("s2")] });
  assert.deepEqual(h.applied, ["s1"], "an ack for something not sent is not ours to apply");
  assert.deepEqual(h.released.map((entry) => entry.id), ["s2"]);
  assert.deepEqual(result.unacknowledged, ["s2"]);
  assert.match(h.released[0].message, /did not acknowledge/);
});

test("a clean push settles everything and releases nothing", async () => {
  const h = harness();
  const result = await runPushCycle({ ...h.io, operations: [sale("s1"), purchase("p1")] });
  assert.deepEqual(h.applied, ["s1", "p1"]);
  assert.deepEqual(h.released, []);
  assert.equal(result.acknowledgementCount, 2);
  assert.equal(result.serverTime, "t2");
});

test("a replayed purchase carries no identity of its own; the session is the only identity", () => {
  const body = purchaseReplayBody(purchase("op-1", {
    user_id: 7, device_id: "FZDEV-OLD", company_id: 1, branch_id: 2, supplier_id: 9, items: [{ quantity: 1 }],
  }));
  for (const field of REPLAY_IDENTITY_FIELDS) assert.equal(Object.hasOwn(body, field), false, `${field} must not be sent`);
  assert.equal(body.queued_by_user_id, "7", "the author is kept as data");
  assert.equal(body.supplier_id, 9);
  assert.deepEqual(body.items, [{ quantity: 1 }]);
  assert.equal(body.idempotency_key, "op-1");
  assert.equal(body.operation_id, "op-1");
});

test("a failed push still lets the pull run, unless the cloud is unreachable", async () => {
  const pulls = [];
  const pullOnce = async () => { pulls.push(1); return { hasMore: pulls.length < 2 }; };
  const result = await runPushThenPull({
    push: async () => { throw sessionRefused(); },
    pullOnce,
    pullAfterPushFailure: () => true,
  });
  assert.equal(result.pullCompleted, true);
  assert.match(result.pushError.message, /403/, "the push failure is still handed back to be reported");
  assert.equal(pulls.length, 2, "the pull loop runs to the end");

  const offline = runPushThenPull({
    push: async () => { throw new Error("Network Error"); },
    pullOnce: async () => assert.fail("no pull when offline"),
    pullAfterPushFailure: () => false,
  });
  await assert.rejects(offline, /Network Error/);
});

test("when both fail, the push error is reported with the pull's attached", async () => {
  await assert.rejects(
    runPushThenPull({
      push: async () => { throw sessionRefused(); },
      pullOnce: async () => { throw new Error("pull broke"); },
      pullAfterPushFailure: () => true,
    }),
    (error) => /403/.test(error.message) && /pull broke/.test(error.pullError.message),
  );
});

test("syncService wires these in, and LOCAL_ONLY still stops before any of it", () => {
  const source = fs.readFileSync(new URL("./syncService.js", import.meta.url), "utf8");
  assert.match(source, /purchaseReplayBody\(operation\)/);
  assert.doesNotMatch(source, /\.\.\.\(operation\.payload \|\| \{\}\)/, "the raw payload spread must not come back");
  assert.match(source, /await runPushCycle\(\{/);
  assert.match(source, /await runPushThenPull\(\{/);
  assert.match(source, /pullAfterPushFailure: \(error\) => !error\?\.froozConnectivity && classifySyncError\(error, apiUrl\)\.online/);
  const syncNow = source.slice(source.indexOf("export async function syncNow"), source.indexOf("export async function initialPullForApprovedDevice"));
  assert.ok(
    syncNow.indexOf("cloudAccessDisabledByOwner()") < syncNow.indexOf("runPushThenPull"),
    "LOCAL_ONLY must return before the push/pull cycle",
  );
  assert.match(syncNow, /syncStage: "failed",\s*pullCompleted,/, "a failed cycle reports whether the pull finished");
  assert.match(syncNow, /syncStage: "idle",[^\n]*pullCompleted \}/);
});
