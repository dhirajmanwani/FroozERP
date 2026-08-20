import test from "node:test";
import assert from "node:assert/strict";

import { consumeStashedSessionForReload, stashSessionForReload } from "./reloadSessionBridge.js";

/** A minimal in-memory stand-in for `sessionStorage`, scoped to one test. */
const fakeSessionStorage = () => {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    _store: store,
  };
};

const withSessionStorage = (impl, fn) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { value: impl, configurable: true });
  try {
    return fn();
  } finally {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else delete globalThis.sessionStorage;
  }
};

test("a stashed session is read back intact", () => {
  withSessionStorage(fakeSessionStorage(), () => {
    const user = { id: 7, username: "owner", device_session_token: "v1.a.b" };
    stashSessionForReload(user, { nowMs: 1_000 });
    const restored = consumeStashedSessionForReload({ nowMs: 1_200 });
    assert.deepEqual(restored, user);
  });
});

test("reading it removes it — this is a one-shot relay, not storage", () => {
  withSessionStorage(fakeSessionStorage(), () => {
    stashSessionForReload({ id: 1 }, { nowMs: 1_000 });
    assert.notEqual(consumeStashedSessionForReload({ nowMs: 1_000 }), null);
    assert.equal(
      consumeStashedSessionForReload({ nowMs: 1_000 }),
      null,
      "a second read must find nothing — otherwise a leftover value could resurrect a session later",
    );
  });
});

test("a session older than the reload window is refused, not resurrected", () => {
  // The bridge exists for one setTimeout(..., 500) reload. Anything far outside that shape is
  // exactly the case this module must not paper over — a crash or a hand-reopened tab must land on
  // the login screen, not silently sign someone back in from a stale value.
  withSessionStorage(fakeSessionStorage(), () => {
    stashSessionForReload({ id: 1 }, { nowMs: 0 });
    assert.equal(consumeStashedSessionForReload({ nowMs: 31_000 }), null);
  });
});

test("a clock that moved backwards is treated as unusable, not as fresh", () => {
  withSessionStorage(fakeSessionStorage(), () => {
    stashSessionForReload({ id: 1 }, { nowMs: 10_000 });
    assert.equal(consumeStashedSessionForReload({ nowMs: 1_000 }), null);
  });
});

test("there is nothing to restore when nothing was stashed", () => {
  withSessionStorage(fakeSessionStorage(), () => {
    assert.equal(consumeStashedSessionForReload(), null);
  });
});

test("malformed storage content fails closed rather than throwing", () => {
  withSessionStorage(fakeSessionStorage(), () => {
    globalThis.sessionStorage.setItem("froozerp_reload_session_bridge_v1", "not json");
    assert.equal(consumeStashedSessionForReload(), null);
  });
  withSessionStorage(fakeSessionStorage(), () => {
    globalThis.sessionStorage.setItem("froozerp_reload_session_bridge_v1", JSON.stringify({ user: "not an object" }));
    assert.equal(consumeStashedSessionForReload(), null);
  });
  withSessionStorage(fakeSessionStorage(), () => {
    globalThis.sessionStorage.setItem("froozerp_reload_session_bridge_v1", JSON.stringify({ user: { id: 1 } }));
    assert.equal(consumeStashedSessionForReload(), null, "a missing timestamp must not read as fresh");
  });
});

test("stashing with no user, or no storage available, never throws", () => {
  withSessionStorage(fakeSessionStorage(), () => {
    assert.doesNotThrow(() => stashSessionForReload(null));
    assert.doesNotThrow(() => stashSessionForReload(undefined));
    assert.equal(consumeStashedSessionForReload(), null, "nothing should have been written");
  });
  withSessionStorage(undefined, () => {
    assert.doesNotThrow(() => stashSessionForReload({ id: 1 }));
    assert.doesNotThrow(() => consumeStashedSessionForReload());
  });
});

test("a storage that throws on access degrades to no restore, not a crash", () => {
  const hostile = {
    get getItem() { throw new Error("access denied"); },
  };
  withSessionStorage(hostile, () => {
    assert.doesNotThrow(() => consumeStashedSessionForReload());
    assert.equal(consumeStashedSessionForReload(), null);
  });
});
