import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  DEFAULT_DASHBOARD_ORDER,
  dashboardDropIndex,
  dashboardOrderKey,
  isDefaultDashboardOrder,
  moveDashboardBlock,
  normalizeDashboardOrder,
  nudgeDashboardBlock,
  readDashboardOrder,
  writeDashboardOrder,
} from "./dashboardLayout.js";

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    map,
  };
};

test("the default order starts with the price list the owner sends every morning", () => {
  assert.equal(DEFAULT_DASHBOARD_ORDER[0], "priceList");
  assert.equal(new Set(DEFAULT_DASHBOARD_ORDER).size, DEFAULT_DASHBOARD_ORDER.length);
});

test("a saved order is repaired: unknown and repeated ids go, missing boxes come back in place", () => {
  assert.deepEqual(normalizeDashboardOrder(null), [...DEFAULT_DASHBOARD_ORDER]);
  assert.deepEqual(normalizeDashboardOrder("kpis"), [...DEFAULT_DASHBOARD_ORDER]);
  const repaired = normalizeDashboardOrder(["kpis", "kpis", "gone", 4, "priceList"]);
  assert.equal(repaired.length, DEFAULT_DASHBOARD_ORDER.length);
  // Each missing box comes back right after the box that precedes it by default: "welcome" after
  // "priceList", "graphs" after "kpis", and so on down the chain.
  assert.deepEqual(repaired, ["kpis", "graphs", "highlights", "quickAccess", "priceList", "welcome"]);
  assert.deepEqual(normalizeDashboardOrder(["welcome"]), ["priceList", "welcome", "kpis", "graphs", "highlights", "quickAccess"]);
});

test("moving a box lands it exactly at the asked place and keeps every other box", () => {
  const moved = moveDashboardBlock(DEFAULT_DASHBOARD_ORDER, "quickAccess", 0);
  assert.equal(moved[0], "quickAccess");
  assert.deepEqual(moved.slice(1), DEFAULT_DASHBOARD_ORDER.filter((id) => id !== "quickAccess"));
  const last = moveDashboardBlock(DEFAULT_DASHBOARD_ORDER, "priceList", 99);
  assert.equal(last.at(-1), "priceList");
  assert.deepEqual(moveDashboardBlock(DEFAULT_DASHBOARD_ORDER, "nope", 0), [...DEFAULT_DASHBOARD_ORDER]);
  assert.deepEqual(moveDashboardBlock(DEFAULT_DASHBOARD_ORDER, "kpis", Number.NaN), [...DEFAULT_DASHBOARD_ORDER]);
});

test("one step up or down stops at the ends", () => {
  assert.deepEqual(nudgeDashboardBlock(DEFAULT_DASHBOARD_ORDER, "priceList", -1), [...DEFAULT_DASHBOARD_ORDER]);
  const down = nudgeDashboardBlock(DEFAULT_DASHBOARD_ORDER, "priceList", 1);
  assert.deepEqual(down.slice(0, 2), ["welcome", "priceList"]);
  const lastId = DEFAULT_DASHBOARD_ORDER.at(-1);
  assert.deepEqual(nudgeDashboardBlock(DEFAULT_DASHBOARD_ORDER, lastId, 1), [...DEFAULT_DASHBOARD_ORDER]);
});

test("a dragged box goes after every other box whose middle the pointer has passed", () => {
  const midpoints = [100, 300, 500];
  assert.equal(dashboardDropIndex(midpoints, 50), 0);
  assert.equal(dashboardDropIndex(midpoints, 301), 2);
  assert.equal(dashboardDropIndex(midpoints, 900), 3);
  assert.equal(dashboardDropIndex(midpoints, Number.NaN), null);
  assert.equal(dashboardDropIndex(null, 10), null);
  // Feeding the drop index straight into the move gives the expected order.
  const others = DEFAULT_DASHBOARD_ORDER.filter((id) => id !== "priceList");
  const index = dashboardDropIndex(others.map((_, position) => position * 200 + 100), 450);
  const moved = moveDashboardBlock(DEFAULT_DASHBOARD_ORDER, "priceList", index);
  assert.deepEqual(moved.slice(0, 3), [others[0], others[1], "priceList"]);
});

test("the order is kept per login on this computer, and the default is not stored", () => {
  const storage = memoryStorage();
  const custom = moveDashboardBlock(DEFAULT_DASHBOARD_ORDER, "kpis", 0);
  assert.equal(writeDashboardOrder(storage, 7, custom), true);
  assert.deepEqual(readDashboardOrder(storage, "7"), custom);
  assert.deepEqual(readDashboardOrder(storage, 8), [...DEFAULT_DASHBOARD_ORDER]);
  assert.equal(writeDashboardOrder(storage, 7, DEFAULT_DASHBOARD_ORDER), true);
  assert.equal(storage.map.has(dashboardOrderKey(7)), false);
  assert.equal(isDefaultDashboardOrder(DEFAULT_DASHBOARD_ORDER), true);
  assert.equal(dashboardOrderKey(null), "froozerp.dashboard.order.anyone");
});

test("a broken or locked storage never breaks the Dashboard", () => {
  const storage = memoryStorage();
  storage.setItem(dashboardOrderKey(1), "{not json");
  assert.deepEqual(readDashboardOrder(storage, 1), [...DEFAULT_DASHBOARD_ORDER]);
  const throwing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  assert.deepEqual(readDashboardOrder(throwing, 1), [...DEFAULT_DASHBOARD_ORDER]);
  assert.equal(writeDashboardOrder(throwing, 1, ["kpis"]), false);
  assert.equal(writeDashboardOrder(null, 1, ["kpis"]), false);
});

test("the Dashboard renders its boxes through this order, each with a move handle", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /from "\.\/local\/dashboardLayout"/);
  assert.match(app, /<DashboardBlocks\s+order=\{dashboardOrder\}/);
  for (const id of DEFAULT_DASHBOARD_ORDER) assert.match(app, new RegExp(`${id}:`));
  assert.match(app, /className="dash-handle"/);
});
