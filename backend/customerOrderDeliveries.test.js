"use strict";

/**
 * `sanitizeOrderDeliveries`: the cloud's check of the deliveries a device carries inside a
 * customer order push (Delivery module contract, 22 Nov 2026).
 *
 * Pinned: absent/null keeps what is stored (value null, never []); an array is sanitised to the
 * contract's shape or refused with a reason that names the delivery and the field; zero paise is a
 * real amount; ids stay opaque strings; cancelled/failed need a reason.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sanitizeOrderDeliveries,
  DELIVERY_FIELDS,
  DELIVERY_STATUSES,
  DELIVERY_PROVIDERS,
  DELIVERY_PAID_BY,
} = require("./customerOrderDeliveries");

const ORDER_ID = "ORD-2026-11-22-0001";

const delivery = (overrides = {}) => ({
  id: "4a0b7c1e-1d2f-4c3a-9b8e-000000000001",
  order_id: ORDER_ID,
  attempt_no: 1,
  customer_name: " Rekha ",
  customer_phone: "9876543210",
  address: "12 Mandi Road",
  landmark: "Near the temple",
  area_name: "Ratanada",
  map_link: "https://maps.google.com/?q=1,2",
  provider: "rapido",
  rider_name: "Suresh",
  rider_phone: "9000000000",
  tracking_link: "https://rapido.bike/t/abc",
  booking_ref: "RP-1",
  quoted_paise: 0,
  final_paise: null,
  paid_by: "customer",
  status: "booked",
  status_reason: null,
  booked_at: "2026-11-22T06:00:00.000Z",
  picked_up_at: null,
  delivered_at: null,
  closed_at: null,
  cancelled_at: null,
  failed_at: null,
  notes: "",
  created_by: "7",
  created_at: "2026-11-22T05:50:00.000Z",
  updated_at: "2026-11-22T06:00:00.000Z",
  events: [
    { id: "ev-1", delivery_id: "4a0b7c1e-1d2f-4c3a-9b8e-000000000001", from_status: null, to_status: "pending", at: "2026-11-22T05:50:00.000Z", by_user: "7", note: null },
    { id: "ev-2", delivery_id: "4a0b7c1e-1d2f-4c3a-9b8e-000000000001", from_status: "pending", to_status: "booked", at: "2026-11-22T06:00:00.000Z", by_user: "7", note: "Booked on Rapido" },
  ],
  ...overrides,
});

test("vocabulary matches the shared contract", () => {
  assert.deepEqual([...DELIVERY_STATUSES], ["pending", "booked", "picked_up", "delivered", "closed", "cancelled", "failed"]);
  assert.deepEqual([...DELIVERY_PROVIDERS], ["rapido", "uber", "own_staff", "other"]);
  assert.deepEqual([...DELIVERY_PAID_BY], ["shop", "customer"]);
});

test("absent or null deliveries mean keep what is stored, never an empty list", () => {
  assert.deepEqual(sanitizeOrderDeliveries(undefined, { orderId: ORDER_ID }), { value: null });
  assert.deepEqual(sanitizeOrderDeliveries(null, { orderId: ORDER_ID }), { value: null });
  assert.deepEqual(sanitizeOrderDeliveries([], { orderId: ORDER_ID }), { value: [] }, "an empty array is the sender's truth");
});

test("a valid delivery comes back in the contract's shape, trimmed, with zero paise kept", () => {
  const result = sanitizeOrderDeliveries([delivery({ junk: "dropped", synced_at: "x", order_no: "ORD-1" })], { orderId: ORDER_ID });
  assert.equal(result.error, undefined, result.error);
  const [stored] = result.value;
  assert.deepEqual(Object.keys(stored), [...DELIVERY_FIELDS], "exactly the contract's fields, in order");
  assert.equal(stored.customer_name, "Rekha");
  assert.equal(stored.quoted_paise, 0, "a free delivery is 0 paise, not null");
  assert.equal(stored.final_paise, null);
  assert.equal(stored.notes, null, "blank text is null");
  assert.equal(stored.order_id, ORDER_ID);
  assert.equal(stored.events.length, 2);
  assert.deepEqual(stored.events[0], {
    id: "ev-1", delivery_id: stored.id, from_status: null, to_status: "pending",
    at: "2026-11-22T05:50:00.000Z", by_user: "7", note: null,
  });
});

test("order_id and delivery_id are filled when absent, and statuses are case-folded", () => {
  const raw = delivery({ order_id: undefined, status: "BOOKED", provider: "Own_Staff", paid_by: "SHOP" });
  raw.events = raw.events.map(({ delivery_id, ...event }) => event);
  const [stored] = sanitizeOrderDeliveries([raw], { orderId: ORDER_ID }).value;
  assert.equal(stored.order_id, ORDER_ID);
  assert.equal(stored.status, "booked");
  assert.equal(stored.provider, "own_staff");
  assert.equal(stored.paid_by, "shop");
  assert.ok(stored.events.every((event) => event.delivery_id === stored.id));
});

test("deliveries are stored in attempt order", () => {
  const result = sanitizeOrderDeliveries([
    delivery({ id: "d-2", attempt_no: 2, events: [] }),
    delivery({ id: "d-1", attempt_no: 1, status: "failed", status_reason: "Customer not home", events: [] }),
  ], { orderId: ORDER_ID });
  assert.deepEqual(result.value.map((entry) => entry.id), ["d-1", "d-2"]);
});

test("long free text is capped, not refused", () => {
  const [stored] = sanitizeOrderDeliveries([delivery({ notes: "n".repeat(5000), address: "a".repeat(2000) })], { orderId: ORDER_ID }).value;
  assert.equal(stored.notes.length, 2000);
  assert.equal(stored.address.length, 1000);
});

test("ids stay opaque strings: '004' is kept, a numeric id is refused", () => {
  const [stored] = sanitizeOrderDeliveries([delivery({ id: "004", events: [] })], { orderId: ORDER_ID }).value;
  assert.equal(stored.id, "004");
  assert.match(sanitizeOrderDeliveries([delivery({ id: 4, events: [] })], { orderId: ORDER_ID }).error, /delivery 1 is missing id/);
});

test("every broken rule is refused with a reason naming the delivery and the field", () => {
  const cases = [
    ["not a list", { deliveries: "x" }, /must be a list/],
    ["not an object", { deliveries: [42] }, /delivery 1 is not an object/],
    ["no id", { deliveries: [delivery({ id: " " })] }, /delivery 1 is missing id/],
    ["another order", { deliveries: [delivery({ order_id: "ORD-OTHER" })] }, /belongs to another order/],
    ["attempt 0", { deliveries: [delivery({ attempt_no: 0 })] }, /invalid attempt_no/],
    ["attempt 1.5", { deliveries: [delivery({ attempt_no: 1.5 })] }, /invalid attempt_no/],
    ["status", { deliveries: [delivery({ status: "lost" })] }, /unsupported status/],
    ["no status", { deliveries: [delivery({ status: "" })] }, /unsupported status/],
    ["provider", { deliveries: [delivery({ provider: "porter" })] }, /unsupported provider/],
    ["paid_by", { deliveries: [delivery({ paid_by: "nobody" })] }, /unsupported paid_by/],
    ["negative paise", { deliveries: [delivery({ quoted_paise: -1 })] }, /quoted_paise must be whole paise/],
    ["fractional paise", { deliveries: [delivery({ final_paise: 10.5 })] }, /final_paise must be whole paise/],
    ["huge paise", { deliveries: [delivery({ final_paise: 1e12 })] }, /final_paise must be whole paise/],
    ["junk paise", { deliveries: [delivery({ quoted_paise: "eighty" })] }, /quoted_paise must be whole paise/],
    ["timestamp", { deliveries: [delivery({ booked_at: "yesterday-ish" })] }, /booked_at is not a valid timestamp/],
    ["cancelled no reason", { deliveries: [delivery({ status: "cancelled", status_reason: "  " })] }, /cancelled without a reason/],
    ["failed no reason", { deliveries: [delivery({ status: "failed" })] }, /failed without a reason/],
    ["text type", { deliveries: [delivery({ rider_name: 12 })] }, /rider_name must be text/],
    ["duplicate id", { deliveries: [delivery({ events: [] }), delivery({ attempt_no: 2, events: [] })] }, /delivery 2 repeats id/],
    ["duplicate attempt", { deliveries: [delivery({ events: [] }), delivery({ id: "d-2", events: [] })] }, /delivery 2 repeats attempt_no 1/],
    ["events not list", { deliveries: [delivery({ events: {} })] }, /events must be a list/],
    ["event no id", { deliveries: [delivery({ events: [{ to_status: "pending", at: "2026-11-22T05:50:00Z" }] })] }, /event 1 is missing id/],
    ["event to_status", { deliveries: [delivery({ events: [{ id: "e", to_status: "gone", at: "2026-11-22T05:50:00Z" }] })] }, /unsupported to_status/],
    ["event from_status", { deliveries: [delivery({ events: [{ id: "e", from_status: "x", to_status: "booked", at: "2026-11-22T05:50:00Z" }] })] }, /unsupported from_status/],
    ["event at", { deliveries: [delivery({ events: [{ id: "e", to_status: "booked" }] })] }, /event 1 at is not a valid timestamp/],
    ["event other delivery", { deliveries: [delivery({ events: [{ id: "e", delivery_id: "zzz", to_status: "booked", at: "2026-11-22T05:50:00Z" }] })] }, /belongs to another delivery/],
    ["event duplicate", { deliveries: [delivery({ events: [{ id: "e", to_status: "pending", at: "2026-11-22T05:50:00Z" }, { id: "e", to_status: "booked", at: "2026-11-22T05:50:00Z" }] })] }, /repeats id e/],
  ];
  for (const [name, { deliveries }, expected] of cases) {
    const result = sanitizeOrderDeliveries(deliveries, { orderId: ORDER_ID });
    assert.ok(result.error, `${name}: expected a refusal`);
    assert.match(result.error, expected, `${name}: ${result.error}`);
  }
});

test("too many deliveries or events are refused, not truncated", () => {
  const many = Array.from({ length: 51 }, (_, index) => delivery({ id: `d-${index}`, attempt_no: index + 1, events: [] }));
  assert.match(sanitizeOrderDeliveries(many, { orderId: ORDER_ID }).error, /more than 50 deliveries/);
  const events = Array.from({ length: 51 }, (_, index) => ({ id: `e-${index}`, to_status: "pending", at: "2026-11-22T05:50:00Z" }));
  assert.match(sanitizeOrderDeliveries([delivery({ events })], { orderId: ORDER_ID }).error, /more than 50 events/);
});

test("every status is accepted, with a reason where one is required", () => {
  for (const status of DELIVERY_STATUSES) {
    const reason = status === "cancelled" || status === "failed" ? "Rider cancelled" : null;
    const result = sanitizeOrderDeliveries([delivery({ status, status_reason: reason, events: [] })], { orderId: ORDER_ID });
    assert.equal(result.error, undefined, `${status}: ${result.error}`);
  }
});
