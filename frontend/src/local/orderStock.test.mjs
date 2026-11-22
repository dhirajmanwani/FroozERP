import test from "node:test";
import assert from "node:assert/strict";

import { createCounterScope, UNKNOWN_COUNTER_SCOPE } from "./locationScope.js";
import {
  ORDER_SHELF_STATUS,
  buildOrderPickList,
  checkOrderAgainstShelf,
  checkOrderQuantity,
  firstLotForSale,
  heldForOrdersNote,
  posLotRate,
  searchOrderPickList,
} from "./orderStock.js";

const NOW = new Date("2026-11-22T10:00:00.000Z");
const NOW_MS = NOW.getTime();

const products = [
  { id: "004", product_name: "Apple", unit: "KG", selling_rate: 150 },
  { id: 4, product_name: "Kiwi", unit: "PCS", selling_rate: 20 },
  { id: "p-mango", product_name: "Mango", unit: "KG", selling_rate: 120 },
  { id: "p-grape", product_name: "Grapes", unit: "KG", selling_rate: 90 },
];
const lots = [
  { id: "L2", product_id: "004", remaining_qty: 4, purchase_date: "2026-11-21", sale_rate: 170 },
  { id: "L1", product_id: "004", remaining_qty: 6, purchase_date: "2026-11-20", sale_rate: 160 },
  { id: "L3", product_id: 4, remaining_qty: 30 },
  // Mango is in the catalogue but every lot is finished: it must not be offered.
  { id: "L4", product_id: "p-mango", remaining_qty: 0, sale_rate: 130 },
  { id: "L5", product_id: "p-grape", remaining_qty: 5, sale_rate: 95 },
];
const shelf = { loaded: true, products, inventoryLots: lots };
const openOrder = (items, status = "RECEIVED") => ({
  id: `o-${Math.random()}`,
  status,
  reserved_at: "2026-11-22T09:00:00.000Z",
  items,
});

test("only products with stock on the shelf are offered, with free quantity and POS's rate", () => {
  const list = buildOrderPickList({ shelf, orders: [], now: NOW, nowMs: NOW_MS });
  assert.equal(list.status, ORDER_SHELF_STATUS.READY);
  assert.deepEqual(list.items.map((item) => item.name), ["Apple", "Grapes", "Kiwi"]);
  const apple = list.items.find((item) => item.name === "Apple");
  assert.equal(apple.onHand, 10);
  assert.equal(apple.available, 10);
  // The oldest lot (L1, 20 Nov) is the one POS offers first, so its rate prefills.
  assert.equal(apple.rate, 160);
  assert.equal(apple.minRate, 160);
  assert.equal(apple.maxRate, 170);
  // Kiwi's lot has no rate of its own, so the product's rate is what POS charges.
  assert.equal(list.items.find((item) => item.name === "Kiwi").rate, 20);
});

test("\"004\" and 4 stay different products, and orders take their hold off the right one", () => {
  const orders = [openOrder([{ product_id: "004", quantity: 3 }]), openOrder([{ product_id: "4", quantity: 25 }])];
  const list = buildOrderPickList({ shelf, orders, now: NOW, nowMs: NOW_MS });
  const apple = list.items.find((item) => item.name === "Apple");
  const kiwi = list.items.find((item) => item.name === "Kiwi");
  assert.equal(apple.reserved, 3);
  assert.equal(apple.available, 7);
  assert.equal(kiwi.reserved, 25);
  assert.equal(kiwi.available, 5);
});

test("a product wholly held for orders leaves the list but is named, never silently missing", () => {
  const orders = [openOrder([{ product_id: "p-grape", quantity: 5 }], "PACKED")];
  const list = buildOrderPickList({ shelf, orders, now: NOW, nowMs: NOW_MS });
  assert.ok(!list.items.some((item) => item.name === "Grapes"));
  assert.deepEqual(list.held.map((item) => item.name), ["Grapes"]);
});

test("sent, cancelled and lapsed orders hold nothing", () => {
  const orders = [
    openOrder([{ product_id: "p-grape", quantity: 5 }], "SENT"),
    openOrder([{ product_id: "p-grape", quantity: 5 }], "CANCELLED"),
    { ...openOrder([{ product_id: "p-grape", quantity: 5 }]), reserved_at: "2026-11-21T09:00:00.000Z" },
  ];
  const list = buildOrderPickList({ shelf, orders, now: NOW, nowMs: NOW_MS });
  assert.equal(list.items.find((item) => item.name === "Grapes").available, 5);
});

test("a shelf that is not loaded is a named state, never an empty list that reads as sold out", () => {
  const loading = buildOrderPickList({ shelf: { loaded: false, products: [], inventoryLots: [] } });
  assert.equal(loading.status, ORDER_SHELF_STATUS.LOADING);
  assert.equal(loading.usable, false);
  assert.notEqual(loading.countLabel, "0");

  const browser = buildOrderPickList({ shelf: null, load: { status: ORDER_SHELF_STATUS.UNAVAILABLE } });
  assert.equal(browser.status, ORDER_SHELF_STATUS.UNAVAILABLE);
  assert.match(browser.message, /desktop app/);
  assert.equal(browser.countLabel, "Unavailable");

  const failed = buildOrderPickList({ shelf: { loaded: false }, load: { status: ORDER_SHELF_STATUS.ERROR, message: "disk locked" } });
  assert.equal(failed.status, ORDER_SHELF_STATUS.ERROR);
  assert.match(failed.message, /could not be read \(disk locked\)/);
});

test("a counter that does not know its shop cannot offer anything, and says why", () => {
  const list = buildOrderPickList({ shelf, scope: UNKNOWN_COUNTER_SCOPE, now: NOW, nowMs: NOW_MS });
  assert.equal(list.status, ORDER_SHELF_STATUS.NO_SHOP);
  assert.equal(list.usable, false);
  assert.match(list.message, /which shop/);
});

test("another shop's lots are not this counter's stock", () => {
  const scope = createCounterScope({ branchId: "B1", operationalLocationId: "LOC1", source: "test" });
  const scopedShelf = {
    loaded: true,
    products,
    inventoryLots: [
      { id: "A", product_id: "004", remaining_qty: 6, branch_id: "B1", operational_location_id: "LOC1" },
      { id: "B", product_id: "004", remaining_qty: 50, branch_id: "B2", operational_location_id: "LOC2" },
    ],
  };
  const list = buildOrderPickList({ shelf: scopedShelf, scope, now: NOW, nowMs: NOW_MS });
  assert.equal(list.status, ORDER_SHELF_STATUS.READY);
  assert.equal(list.items.find((item) => item.name === "Apple").onHand, 6);
});

test("an empty shelf says so in words, distinct from everything being held", () => {
  const bare = buildOrderPickList({ shelf: { loaded: true, products, inventoryLots: [] }, now: NOW, nowMs: NOW_MS });
  assert.equal(bare.items.length, 0);
  assert.match(bare.message, /Nothing on this counter's shelf has stock/);
  const allHeld = buildOrderPickList({
    shelf: { loaded: true, products, inventoryLots: [{ id: "x", product_id: "p-grape", remaining_qty: 2 }] },
    orders: [openOrder([{ product_id: "p-grape", quantity: 2 }])],
    now: NOW,
    nowMs: NOW_MS,
  });
  assert.match(allHeld.message, /already held for open orders \(Grapes\)/);
});

test("POS's rate rule: the lot's rate, else the product's; a zero temporary rate is no rate", () => {
  assert.equal(posLotRate({ temporary_sale_rate: 0, sale_rate: 80 }, { selling_rate: 50 }), 80);
  assert.equal(posLotRate({ temporary_sale_rate: 75, sale_rate: 80 }, { selling_rate: 50 }), 75);
  assert.equal(posLotRate({}, { selling_rate: 50 }), 50);
  assert.equal(posLotRate(null, { selling_rate: 50 }), 50);
});

test("the first lot for sale is the oldest, then by lot name, with undated lots last", () => {
  assert.equal(firstLotForSale([
    { id: "c", lot_name: "Lot 10", purchase_date: "2026-11-20" },
    { id: "b", lot_name: "Lot 9", purchase_date: "2026-11-20" },
    { id: "a", lot_name: "Lot 1" },
  ]).id, "b");
  assert.equal(firstLotForSale([]), null);
});

test("search matches name, category and unit", () => {
  const list = buildOrderPickList({ shelf, now: NOW, nowMs: NOW_MS });
  assert.deepEqual(searchOrderPickList(list.items, "app").map((item) => item.name), ["Apple"]);
  assert.equal(searchOrderPickList(list.items, "").length, list.items.length);
  assert.deepEqual(searchOrderPickList(list.items, "pcs").map((item) => item.name), ["Kiwi"]);
});

test("a quantity above what is free is refused, naming the free amount and the held amount", () => {
  const list = buildOrderPickList({ shelf, orders: [openOrder([{ product_id: "004", quantity: 3 }])], now: NOW, nowMs: NOW_MS });
  const apple = list.items.find((item) => item.name === "Apple");
  assert.deepEqual(checkOrderQuantity({ item: apple, quantity: "7" }), { ok: true, level: "", message: "" });
  const over = checkOrderQuantity({ item: apple, quantity: "7.5" });
  assert.equal(over.ok, false);
  assert.equal(over.message, "Only 7 Kg of Apple is free (3 Kg of the 10 Kg on the shelf is held for other orders).");
  // Two lines of the same item are checked together.
  assert.equal(checkOrderQuantity({ item: apple, quantity: "4", otherLines: 4 }).ok, false);
  assert.equal(checkOrderQuantity({ item: apple, quantity: "" }).ok, true, "blank is for Save to name, not this check");
  assert.equal(checkOrderQuantity({ item: apple, quantity: "-1" }).ok, false);
  assert.equal(checkOrderQuantity({ item: null, quantity: "1" }).ok, false);
});

test("Save checks every line against the shelf, adding up repeated items", () => {
  const list = buildOrderPickList({ shelf, now: NOW, nowMs: NOW_MS });
  assert.deepEqual(checkOrderAgainstShelf([{ product_id: "004", quantity: 4 }, { product_id: "4", quantity: 2 }], list), { ok: true, message: "" });
  assert.equal(checkOrderAgainstShelf([{ product_id: "004", quantity: 6 }, { product_id: "004", quantity: 6 }], list).ok, false);
  const gone = checkOrderAgainstShelf([{ product_id: "p-mango", product_name: "Mango", quantity: 1 }], list);
  assert.equal(gone.ok, false);
  assert.match(gone.message, /^Mango is no longer free on the shelf/);
  const unread = checkOrderAgainstShelf([{ product_id: "004", quantity: 1 }], buildOrderPickList({ shelf: null }));
  assert.equal(unread.ok, false);
});

test("the POS tile's note: held and free, nothing when nothing is held, and over-promising said plainly", () => {
  assert.equal(heldForOrdersNote({ onHand: 14.5, reserved: 2, unit: "KG" }), "12.5 Kg free · 2 Kg held for orders");
  assert.equal(heldForOrdersNote({ onHand: 14.5, reserved: 0, unit: "KG" }), "");
  assert.equal(heldForOrdersNote({ onHand: 5, reserved: 12, unit: "KG" }), "Orders hold 12 Kg, more than is here");
});
