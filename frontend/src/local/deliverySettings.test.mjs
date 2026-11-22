import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_DELIVERY_TEMPLATES } from "./deliveryText.js";
import {
  DEFAULT_DELIVERY_SETTINGS,
  DELIVERY_SETTINGS_SOURCE,
  normalizeDeliverySettings,
  resolveDeliverySettings,
  saveDeliverySettingsFlow,
  syncDeliverySettings,
  usualChargeForArea,
  validateDeliverySettings,
} from "./deliverySettings.js";

const edited = (overrides = {}) => ({
  pickup_address: "Frooz Fruits, 1 Market St",
  pickup_pin: "12.9716,77.5946",
  default_paid_by: "customer",
  default_provider: "uber",
  overdue_minutes: 30,
  areas: [{ id: "a-1", name: "Indiranagar", usual_paise: 6000 }, { id: "a-2", name: "Koramangala", usual_paise: null }],
  templates: { booked: "Booked {name}", picked_up: "On the way {name}", delivered: "Done {name}" },
  ...overrides,
});

/** An in-memory local store and cloud, recording every call. */
const harness = ({ local = null, cloud = null, failRead = false, failWrite = false, failFetch = false, failPush = false } = {}) => {
  const calls = { readLocal: 0, writeLocal: [], fetchCloud: 0, pushCloud: [] };
  const state = { local, cloud };
  return {
    calls,
    state,
    readLocal: async (branchId) => {
      calls.readLocal += 1;
      assert.equal(branchId, "7");
      if (failRead) throw new Error("disk says no");
      return state.local;
    },
    writeLocal: async ({ branchId, settings, dirty }) => {
      calls.writeLocal.push({ branchId, settings, dirty });
      if (failWrite) throw new Error("write refused");
      state.local = { branch_id: branchId, settings, dirty, updated_at: "now" };
    },
    fetchCloud: async () => {
      calls.fetchCloud += 1;
      if (failFetch) throw new Error("Network Error");
      return state.cloud;
    },
    pushCloud: async (settings) => {
      calls.pushCloud.push(settings);
      if (failPush) {
        const error = new Error("Request failed with status code 403");
        error.response = { data: { message: "Only the Owner or an Admin can change delivery settings." } };
        throw error;
      }
      state.cloud = { branch_id: 7, settings, updated_at: "now", source: "branch" };
      return state.cloud;
    },
  };
};

test("defaults match the shared shape and use the default templates", () => {
  assert.deepEqual(normalizeDeliverySettings(null), {
    pickup_address: "",
    pickup_pin: "",
    default_paid_by: "shop",
    default_provider: "rapido",
    overdue_minutes: 45,
    areas: [],
    templates: { ...DEFAULT_DELIVERY_TEMPLATES },
  });
  assert.deepEqual(DEFAULT_DELIVERY_SETTINGS.templates, DEFAULT_DELIVERY_TEMPLATES);
  assert.ok(Object.isFrozen(DEFAULT_DELIVERY_SETTINGS));
  // A fresh copy every time: editing one must not edit the defaults.
  const copy = normalizeDeliverySettings(undefined);
  copy.areas.push({ id: "x", name: "x" });
  assert.equal(normalizeDeliverySettings(undefined).areas.length, 0);
});

test("normalize keeps good values, repairs bad ones, drops unknown keys, reads JSON text", () => {
  const good = normalizeDeliverySettings(edited({ secret: "drop me" }));
  assert.deepEqual(good, edited());
  assert.deepEqual(normalizeDeliverySettings(JSON.stringify(edited())), edited());
  assert.deepEqual(normalizeDeliverySettings("not json"), normalizeDeliverySettings(null));

  const repaired = normalizeDeliverySettings({
    pickup_address: "  Shop  ",
    default_paid_by: "BANK",
    default_provider: "UBER",
    overdue_minutes: 2,
    areas: [
      { name: "  Sector   5 ", usual_paise: "4000" },
      { name: "sector 5", usual_paise: 9999 },
      { id: "dup", name: "HSR", usual_paise: -5 },
      { id: "dup", name: "BTM", usual_paise: "junk" },
      { name: "" },
      "not an area",
    ],
    templates: { booked: "  ", picked_up: "Custom {name}", extra: "x" },
  });
  assert.equal(repaired.pickup_address, "Shop");
  assert.equal(repaired.default_paid_by, "shop");
  assert.equal(repaired.default_provider, "uber");
  assert.equal(repaired.overdue_minutes, 5, "clamped to the cloud's minimum");
  assert.equal(normalizeDeliverySettings({ overdue_minutes: 9000 }).overdue_minutes, 600);
  assert.equal(normalizeDeliverySettings({ overdue_minutes: "" }).overdue_minutes, 45);
  assert.equal(normalizeDeliverySettings({ overdue_minutes: "abc" }).overdue_minutes, 45);
  assert.deepEqual(repaired.areas, [
    { id: "area-sector-5", name: "Sector 5", usual_paise: 4000 },
    { id: "dup", name: "HSR", usual_paise: null },
    { id: "area-btm", name: "BTM", usual_paise: null },
  ]);
  assert.equal(new Set(repaired.areas.map((area) => area.id)).size, repaired.areas.length, "ids are unique");
  assert.equal(repaired.templates.booked, DEFAULT_DELIVERY_TEMPLATES.booked, "blank template = default");
  assert.equal(repaired.templates.picked_up, "Custom {name}");
  assert.ok(!("extra" in repaired.templates));
  assert.equal(normalizeDeliverySettings({ areas: Array.from({ length: 250 }, (_, i) => ({ name: `A${i}` })) }).areas.length, 200);
});

test("validate accepts good settings and names every problem in plain English", () => {
  assert.deepEqual(validateDeliverySettings(edited()), { ok: true, errors: [] });
  assert.equal(validateDeliverySettings({}).ok, true, "everything optional");
  assert.equal(validateDeliverySettings(null).ok, false);

  const bad = validateDeliverySettings(edited({
    pickup_pin: "behind the market",
    default_paid_by: "bank",
    default_provider: "porter",
    overdue_minutes: 2.5,
    areas: [
      { id: "a", name: "Indiranagar", usual_paise: Number.NaN },
      { id: "b", name: "indiranagar", usual_paise: 100 },
      { id: "c", name: "", usual_paise: -1 },
    ],
    templates: { booked: "Hi {nmae}", picked_up: "x".repeat(1001), delivered: 5 },
  }));
  assert.equal(bad.ok, false);
  const all = bad.errors.join("\n");
  assert.match(all, /pickup pin/);
  assert.match(all, /Paid by/);
  assert.match(all, /provider/);
  assert.match(all, /whole number of minutes from 5 to 600/);
  assert.match(all, /usual charge for Indiranagar/);
  assert.match(all, /listed twice/);
  assert.match(all, /Area 3 has no name/);
  assert.match(all, /\{nmae\}/);
  assert.match(all, /longer than 1000/);
  assert.match(all, /delivered message could not be read/);
  assert.equal(validateDeliverySettings({ pickup_address: "x".repeat(501) }).ok, false);
  assert.equal(validateDeliverySettings({ pickup_pin: "https://maps.google.com/?q=1" }).ok, true);
  assert.equal(validateDeliverySettings({ areas: Array.from({ length: 201 }, (_, i) => ({ name: `A${i}` })) }).ok, false);
});

test("usual charge for an area, matched ignoring case and spacing", () => {
  const settings = normalizeDeliverySettings(edited());
  assert.equal(usualChargeForArea(settings, "indiranagar"), 6000);
  assert.equal(usualChargeForArea(settings, "  INDIRANAGAR "), 6000);
  assert.equal(usualChargeForArea(settings, "Koramangala"), null, "area without a usual charge");
  assert.equal(usualChargeForArea(settings, "Mars"), null);
  assert.equal(usualChargeForArea(settings, ""), null);
  assert.equal(usualChargeForArea(null, "Indiranagar"), null);
  assert.equal(usualChargeForArea({ areas: [{ name: "Free zone", usual_paise: 0 }] }, "free zone"), 0, "a usual charge of 0 is real");
});

test("resolve: dirty local wins, then cloud (or copied), then local, then defaults", () => {
  const local = { settings: edited({ pickup_address: "local" }), dirty: true };
  const cloud = { settings: edited({ pickup_address: "cloud" }), source: "branch" };
  assert.deepEqual(
    [resolveDeliverySettings({ local, cloud }).settings.pickup_address, resolveDeliverySettings({ local, cloud }).source, resolveDeliverySettings({ local, cloud }).dirty],
    ["local", "local", true],
  );
  const clean = { ...local, dirty: false };
  assert.equal(resolveDeliverySettings({ local: clean, cloud }).settings.pickup_address, "cloud");
  assert.equal(resolveDeliverySettings({ local: clean, cloud }).source, DELIVERY_SETTINGS_SOURCE.CLOUD);
  assert.equal(resolveDeliverySettings({ local: null, cloud: { settings: edited(), source: "copied" } }).source, "copied");
  assert.equal(resolveDeliverySettings({ local: clean, cloud: { settings: null, source: "none" } }).settings.pickup_address, "local");
  assert.equal(resolveDeliverySettings({ local: clean, cloud: null }).source, "local");
  assert.deepEqual(resolveDeliverySettings({}), { settings: normalizeDeliverySettings(null), source: "default", dirty: false });
  assert.equal(resolveDeliverySettings({ cloud: { data: { settings: edited(), source: "branch" } } }).source, "cloud", "axios wrapper accepted");
});

test("sync: a dirty local copy is pushed and marked clean", async () => {
  const io = harness({ local: { settings: edited({ pickup_address: "typed offline" }), dirty: true }, cloud: { settings: edited(), source: "branch" } });
  const result = await syncDeliverySettings({ branchId: "7", ...io });
  assert.equal(result.error, null);
  assert.equal(result.dirty, false);
  assert.equal(result.source, "cloud");
  assert.equal(result.settings.pickup_address, "typed offline");
  assert.equal(io.calls.pushCloud.length, 1);
  assert.equal(io.calls.fetchCloud, 0, "a dirty copy is not overwritten by a fetch");
  assert.equal(io.state.local.dirty, false);
});

test("sync: a failed push keeps the dirty copy and reports the error", async () => {
  const io = harness({ local: { settings: edited({ pickup_address: "typed offline" }), dirty: true }, failPush: true });
  const result = await syncDeliverySettings({ branchId: "7", ...io });
  assert.equal(result.dirty, true);
  assert.equal(result.source, "local");
  assert.equal(result.settings.pickup_address, "typed offline");
  assert.match(result.error, /Only the Owner or an Admin/);
  assert.equal(io.calls.writeLocal.length, 0, "the dirty copy is left alone");
});

test("sync: a clean device takes the cloud row and keeps a clean copy", async () => {
  const io = harness({ local: { settings: edited({ pickup_address: "old" }), dirty: false }, cloud: { settings: edited({ pickup_address: "new" }), source: "branch" } });
  const result = await syncDeliverySettings({ branchId: "7", ...io });
  assert.deepEqual([result.settings.pickup_address, result.source, result.dirty, result.error], ["new", "cloud", false, null]);
  assert.equal(io.state.local.settings.pickup_address, "new");
  assert.equal(io.state.local.dirty, false);
});

test("sync: a failed fetch reports the error and never turns into empty settings", async () => {
  const io = harness({ local: { settings: edited({ pickup_address: "kept" }), dirty: false }, failFetch: true });
  const result = await syncDeliverySettings({ branchId: "7", ...io });
  assert.equal(result.settings.pickup_address, "kept");
  assert.equal(result.source, "local");
  assert.match(result.error, /could not be fetched.*Network Error.*copy saved on this computer/);
  assert.equal(io.calls.writeLocal.length, 0);

  const nothing = await syncDeliverySettings({ branchId: "7", ...harness({ failFetch: true }) });
  assert.equal(nothing.source, "default");
  assert.deepEqual(nothing.settings, normalizeDeliverySettings(null));
  assert.match(nothing.error, /default settings/);
});

test("sync: an unreadable local copy is never overwritten by the cloud", async () => {
  const io = harness({ failRead: true, cloud: { settings: edited({ pickup_address: "cloud" }), source: "branch" } });
  const result = await syncDeliverySettings({ branchId: "7", ...io });
  assert.equal(result.settings.pickup_address, "cloud");
  assert.match(result.error, /could not be read.*disk says no/);
  assert.equal(io.calls.writeLocal.length, 0);
});

test("sync: a local write failure is reported but the settings still come back", async () => {
  const io = harness({ cloud: { settings: edited({ pickup_address: "cloud" }), source: "branch" }, failWrite: true });
  const result = await syncDeliverySettings({ branchId: "7", ...io });
  assert.equal(result.settings.pickup_address, "cloud");
  assert.match(result.error, /offline use.*write refused/);
});

test("sync: a branch with no cloud row and nothing local gets defaults; copied templates are kept locally", async () => {
  const none = harness({ cloud: { branch_id: 7, settings: null, updated_at: null, source: "none" } });
  const result = await syncDeliverySettings({ branchId: "7", ...none });
  assert.deepEqual([result.source, result.error], ["default", null]);
  assert.equal(none.calls.writeLocal.length, 0);

  const copied = harness({ cloud: { settings: edited({ pickup_address: "", areas: [] }), source: "copied" } });
  const fromCopy = await syncDeliverySettings({ branchId: "7", ...copied });
  assert.equal(fromCopy.source, "copied");
  assert.equal(fromCopy.settings.templates.booked, "Booked {name}");
  assert.equal(copied.state.local.dirty, false);
});

test("sync in LOCAL_ONLY (no cloud functions) makes no cloud call", async () => {
  const io = harness({ local: { settings: edited(), dirty: true } });
  const result = await syncDeliverySettings({ branchId: "7", readLocal: io.readLocal, writeLocal: io.writeLocal });
  assert.deepEqual([result.source, result.dirty, result.error], ["local", true, null]);
  assert.equal(io.calls.pushCloud.length + io.calls.fetchCloud, 0);
});

test("save flow: local dirty first, then push, then clean", async () => {
  const io = harness();
  const result = await saveDeliverySettingsFlow({ branchId: "7", settings: edited(), writeLocal: io.writeLocal, pushCloud: io.pushCloud });
  assert.deepEqual([result.saved, result.pushed, result.error], [true, true, null]);
  assert.deepEqual(io.calls.writeLocal.map((call) => call.dirty), [true, false]);
  assert.deepEqual(io.calls.pushCloud[0], normalizeDeliverySettings(edited()));
});

test("save flow: a failed push still saves locally, dirty, and says so", async () => {
  const io = harness({ failPush: true });
  const result = await saveDeliverySettingsFlow({ branchId: "7", settings: edited(), writeLocal: io.writeLocal, pushCloud: io.pushCloud });
  assert.deepEqual([result.saved, result.pushed], [true, false]);
  assert.match(result.error, /Saved on this computer, but not yet in the cloud/);
  assert.equal(io.state.local.dirty, true);
});

test("save flow: invalid settings and a failed local write save nothing", async () => {
  const io = harness();
  const invalid = await saveDeliverySettingsFlow({ branchId: "7", settings: edited({ overdue_minutes: 1 }), writeLocal: io.writeLocal, pushCloud: io.pushCloud });
  assert.deepEqual([invalid.saved, invalid.pushed], [false, false]);
  assert.ok(invalid.errors.length > 0);
  assert.equal(io.calls.writeLocal.length + io.calls.pushCloud.length, 0);

  const broken = harness({ failWrite: true });
  const failed = await saveDeliverySettingsFlow({ branchId: "7", settings: edited(), writeLocal: broken.writeLocal, pushCloud: broken.pushCloud });
  assert.deepEqual([failed.saved, failed.pushed], [false, false]);
  assert.match(failed.error, /could not be saved on this computer/);
  assert.equal(broken.calls.pushCloud.length, 0, "never pushed without the local copy");

  const localOnly = await saveDeliverySettingsFlow({ branchId: "7", settings: edited(), writeLocal: harness().writeLocal });
  assert.deepEqual([localOnly.saved, localOnly.pushed, localOnly.error], [true, false, null]);
});
