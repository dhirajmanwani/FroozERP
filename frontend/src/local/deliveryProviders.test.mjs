import test from "node:test";
import assert from "node:assert/strict";

import {
  MANUAL_PROVIDER,
  PROVIDER,
  PROVIDER_IDS,
  PROVIDER_LABEL,
  isKnownProvider,
  listProviders,
  providerFor,
} from "./deliveryProviders.js";

test("provider ids and labels match the shared contract", () => {
  assert.deepEqual(PROVIDER, { RAPIDO: "rapido", UBER: "uber", OWN_STAFF: "own_staff", OTHER: "other" });
  assert.deepEqual(PROVIDER_LABEL, { rapido: "Rapido", uber: "Uber", own_staff: "Own staff", other: "Other" });
  assert.deepEqual([...PROVIDER_IDS], ["rapido", "uber", "own_staff", "other"]);
});

test("the only booking mode is manual and no provider claims an API", () => {
  assert.equal(MANUAL_PROVIDER.id, "manual");
  assert.equal(MANUAL_PROVIDER.supportsApi, false);
  for (const provider of listProviders()) {
    assert.equal(provider.supportsApi, false, provider.id);
    assert.equal(provider.bookingMode, "manual");
    assert.ok(provider.bookingHint.length > 20, `${provider.id} has a hint`);
    assert.equal(provider.known, true);
  }
  assert.deepEqual(listProviders().map((provider) => provider.id), [...PROVIDER_IDS]);
});

test("providerFor resolves case-insensitively and reads unknown ids as Other, flagged", () => {
  assert.equal(providerFor("Rapido").id, "rapido");
  assert.equal(providerFor(" UBER ").label, "Uber");
  assert.equal(providerFor("own_staff").label, "Own staff");
  const unknown = providerFor("dunzo");
  assert.equal(unknown.id, "other");
  assert.equal(unknown.known, false);
  assert.equal(providerFor(null).known, false);
  assert.equal(isKnownProvider("rapido"), true);
  assert.equal(isKnownProvider("porter"), false);
  assert.equal(isKnownProvider(""), false);
});
