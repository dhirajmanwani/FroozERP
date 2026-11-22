import test from "node:test";
import assert from "node:assert/strict";

import {
  DELIVERY_SENT_BUT_NOT_PICKED_UP,
  applyDraftArea,
  buildDeliveryBoard,
  deliveryBillCharge,
  deliveryOrderSendPatch,
  deliveryToDraft,
  draftToDeliveryPayload,
  findDeliveryChargeType,
  formToSettings,
  minutesLabel,
  newDeliveryDraft,
  planDeliveryMove,
  resolveDeliverySalesByDay,
  settingsToForm,
} from "./deliveryUi.js";

const settings = {
  pickup_address: "Shop 4, Market Road",
  pickup_pin: "",
  default_paid_by: "customer",
  default_provider: "uber",
  overdue_minutes: 45,
  areas: [{ id: "a1", name: "Kothrud", usual_paise: 6000 }, { id: "a2", name: "Next door", usual_paise: 0 }],
  templates: { booked: "b", picked_up: "p", delivered: "d" },
};

const order = (patch = {}) => ({
  id: "ord-004",
  order_no: "ORD-1",
  status: "PACKED",
  customer_name: "Sunita",
  customer_mobile: "98765 43210",
  delivery_address: "12 Lane",
  deliveries: [],
  ...patch,
});

const at = (iso) => new Date(iso).getTime();

test("a new delivery is prefilled from the order and the settings", () => {
  const draft = newDeliveryDraft({ order: order(), settings });
  assert.equal(draft.order_id, "ord-004");
  assert.equal(draft.customer_name, "Sunita");
  assert.equal(draft.customer_phone, "98765 43210");
  assert.equal(draft.address, "12 Lane");
  assert.equal(draft.provider, "uber");
  assert.equal(draft.paid_by, "customer");
  assert.equal(draft.quoted, "");
});

test("a second attempt keeps the place and the quote, not the rider", () => {
  const previous = { area_name: "Kothrud", landmark: "Temple", map_link: "https://maps.app/x", quoted_paise: 7000, rider_name: "Ravi", paid_by: "shop", provider: "rapido" };
  const draft = newDeliveryDraft({ order: order({ status: "SENT" }), settings, previous });
  assert.equal(draft.area_name, "Kothrud");
  assert.equal(draft.landmark, "Temple");
  assert.equal(draft.quoted, "70");
  assert.equal(draft.rider_name, "");
  assert.equal(draft.paid_by, "shop");
});

test("choosing an area fills the usual charge only into an empty or area-filled quote", () => {
  const blank = newDeliveryDraft({ order: order(), settings });
  const filled = applyDraftArea(blank, "Kothrud", settings);
  assert.equal(filled.quoted, "60");
  // Zero is a real usual charge, not "none".
  assert.equal(applyDraftArea(filled, "Next door", settings).quoted, "0");
  const typed = applyDraftArea({ ...blank, quoted: "85" }, "Kothrud", settings);
  assert.equal(typed.quoted, "85");
  assert.equal(applyDraftArea(filled, "Somewhere new", settings).quoted, "");
});

test("the form becomes a payload in paise, and junk money is refused", () => {
  const draft = { ...newDeliveryDraft({ order: order(), settings }), quoted: "72.50" };
  const saved = draftToDeliveryPayload(draft, { createdBy: "Asha" });
  assert.equal(saved.ok, true);
  assert.equal(saved.delivery.quoted_paise, 7250);
  assert.equal(saved.delivery.order_id, "ord-004");
  assert.equal(saved.delivery.created_by, "Asha");
  assert.equal("id" in saved.delivery, false);
  assert.equal(draftToDeliveryPayload({ ...draft, quoted: "" }).delivery.quoted_paise, null);
  assert.equal(draftToDeliveryPayload({ ...draft, quoted: "abc" }).ok, false);
  assert.equal(draftToDeliveryPayload({ ...draft, address: "", map_link: "" }).ok, false);
});

test("an existing delivery round-trips through the form without losing its id", () => {
  const draft = deliveryToDraft({ id: "d1", order_id: "ord-004", provider: "rapido", paid_by: "customer", quoted_paise: 0, address: "x" });
  assert.equal(draft.quoted, "0");
  const saved = draftToDeliveryPayload(draft);
  assert.equal(saved.delivery.id, "d1");
  assert.equal(saved.delivery.quoted_paise, 0);
});

test("picked up while packed plans the order's Send with the carrier fields", () => {
  const delivery = { id: "d1", status: "booked", provider: "rapido", rider_phone: "9876543210", tracking_link: "https://t", booking_ref: "RB12" };
  const plan = planDeliveryMove({ order: order(), delivery, to: "picked_up", byUser: "Asha" });
  assert.equal(plan.ok, true);
  assert.equal(plan.orderTo, "SENT");
  assert.deepEqual(plan.orderPatch, { carrier: "Rapido", carrier_contact: "9876543210", tracking_url: "https://t", carrier_reference: "RB12" });
  assert.equal(plan.patch.by_user, "Asha");
  // Already sent: pressing again only moves the delivery.
  assert.equal(planDeliveryMove({ order: order({ status: "SENT" }), delivery, to: "picked_up" }).orderTo, null);
  assert.match(DELIVERY_SENT_BUT_NOT_PICKED_UP, /press Picked up again/);
});

test("delivered moves a sent order to delivered; failed leaves it alone and needs a reason", () => {
  const delivery = { id: "d1", status: "picked_up", provider: "uber" };
  assert.equal(planDeliveryMove({ order: order({ status: "SENT" }), delivery, to: "delivered" }).orderTo, "DELIVERED");
  assert.equal(planDeliveryMove({ order: order({ status: "SENT" }), delivery, to: "failed" }).ok, false);
  const failed = planDeliveryMove({ order: order({ status: "SENT" }), delivery, to: "failed", reason: " not reachable " });
  assert.equal(failed.ok, true);
  assert.equal(failed.orderTo, null);
  assert.equal(failed.patch.status_reason, "not reachable");
});

test("closing: blank final is the quote, a typed final wins, junk is refused", () => {
  const delivery = { id: "d1", status: "delivered", quoted_paise: 6000, final_paise: null };
  assert.equal(planDeliveryMove({ delivery, to: "closed", finalInput: "" }).patch.final_paise, 6000);
  assert.equal(planDeliveryMove({ delivery, to: "closed", finalInput: "0" }).patch.final_paise, 0);
  assert.equal(planDeliveryMove({ delivery, to: "closed", finalInput: "x" }).ok, false);
});

test("the send patch leaves out blank rider fields instead of writing empty text", () => {
  assert.deepEqual(deliveryOrderSendPatch({ provider: "own_staff" }), { carrier: "Own staff" });
});

test("a customer-paid delivery charge goes on the bill under the Delivery charge type", () => {
  const types = [{ id: "c1", charge_name: "Crate" }, { id: "c2", charge_name: "Delivery charge", basis: "SLAB" }];
  assert.equal(findDeliveryChargeType(types).id, "c2");
  const billed = deliveryBillCharge({ delivery: { paid_by: "customer", quoted_paise: 6050 }, chargeTypes: types });
  assert.deepEqual(billed.charges, [{ charge_type_id: "c2", quantity: 1, measurement: "", manualAmount: "60.50" }]);
  // Shop pays: nothing on the bill, nothing said.
  assert.deepEqual(deliveryBillCharge({ delivery: { paid_by: "shop", quoted_paise: 6050 }, chargeTypes: types }).charges, []);
});

test("no Delivery charge set up is said on POS with the amount, never skipped silently", () => {
  const missing = deliveryBillCharge({ delivery: { paid_by: "customer", quoted_paise: 6000 }, chargeTypes: [{ id: "c1", charge_name: "Crate" }] });
  assert.deepEqual(missing.charges, []);
  assert.match(missing.note, /Rs 60/);
  assert.match(missing.note, /NOT on this bill/);
  const noAmount = deliveryBillCharge({ delivery: { paid_by: "customer", quoted_paise: null }, chargeTypes: [] });
  assert.match(noAmount.note, /no amount was entered/);
  const inactive = findDeliveryChargeType([{ id: "c9", charge_name: "Delivery", active: false }]);
  assert.equal(inactive, null);
});

test("the board groups by status, puts late cards first, and never drops an unknown status", () => {
  const nowMs = at("2026-11-22T10:00:00.000Z");
  const orders = [
    order({ id: "o1", deliveries: [{ id: "d1", attempt_no: 1, status: "pending", created_at: "2026-11-22T09:50:00.000Z", events: [] }] }),
    order({ id: "o2", deliveries: [{ id: "d2", attempt_no: 1, status: "pending", created_at: "2026-11-22T08:00:00.000Z", events: [] }] }),
    order({ id: "o3", status: "SENT", deliveries: [
      { id: "d3", attempt_no: 1, status: "failed", failed_at: "2026-11-22T08:00:00.000Z" },
      { id: "d4", attempt_no: 2, status: "delivered", delivered_at: "2026-11-22T09:00:00.000Z" },
    ] }),
    order({ id: "o4", status: "DELIVERED", deliveries: [{ id: "d5", attempt_no: 1, status: "closed", closed_at: "2026-11-20T09:00:00.000Z" }] }),
    order({ id: "o5", deliveries: [{ id: "d6", attempt_no: 1, status: "lost", created_at: "2026-11-22T09:00:00.000Z" }] }),
  ];
  const board = buildDeliveryBoard({ orders, nowMs, overdueMinutes: 45 });
  const pending = board.columns.find((column) => column.key === "pending");
  assert.deepEqual(pending.cards.map((card) => card.delivery.id), ["d2", "d1"]);
  assert.equal(pending.cards[0].overdue, true);
  assert.equal(pending.cards[0].minutes, 120);
  assert.deepEqual(board.columns.find((column) => column.key === "to_close").cards.map((card) => card.delivery.id), ["d4"]);
  assert.equal(board.openCount, 2);
  assert.equal(board.overdueCount, 1);
  assert.equal(board.toCloseCount, 1);
  assert.equal(board.problems.length, 1);
  assert.match(board.problems[0].message, /unknown status \(lost\)/);
});

test("minutes read as m or h mm", () => {
  assert.equal(minutesLabel(5), "5m");
  assert.equal(minutesLabel(65), "1h 05m");
  assert.equal(minutesLabel(null), "");
});

test("sales per day come from the loaded bills for the same range, or are unavailable (null), never 0", () => {
  const rows = [
    { sale_date: "2026-11-21T06:00:00.000Z", total_amount: 100.1, sale_status: "COMPLETED" },
    { sale_date: "2026-11-21T07:00:00.000Z", total_amount: 200.2, sale_status: "COMPLETED" },
    { sale_date: "2026-11-21T07:00:00.000Z", total_amount: 999, sale_status: "CANCELLED" },
  ];
  const range = { dateFrom: "2026-11-21", dateTo: "2026-11-21", loadedFrom: "2026-11-21", loadedTo: "2026-11-21" };
  assert.deepEqual(resolveDeliverySalesByDay({ rows, ...range }), { "2026-11-21": 300.3 });
  assert.deepEqual(resolveDeliverySalesByDay({ rows: [], ...range }), {});
  assert.equal(resolveDeliverySalesByDay({ rows, ...range, loadError: "boom" }), null);
  assert.equal(resolveDeliverySalesByDay({ rows, ...range, loadedTo: "2026-11-22" }), null);
  assert.equal(resolveDeliverySalesByDay({ rows: undefined, ...range }), null);
  assert.equal(resolveDeliverySalesByDay({ rows: [{ sale_date: "", total_amount: 5 }], ...range }), null);
});

test("the settings form round-trips, drops blank area rows and refuses bad values", () => {
  const form = settingsToForm(settings);
  assert.equal(form.areas[1].usual, "0");
  assert.equal(form.overdue_minutes, "45");
  const back = formToSettings({ ...form, areas: [...form.areas, { id: "", name: "", usual: "" }] });
  assert.equal(back.ok, true);
  assert.deepEqual(back.settings.areas, settings.areas);
  assert.equal(back.settings.overdue_minutes, 45);
  assert.equal(formToSettings({ ...form, overdue_minutes: "" }).ok, false);
  assert.equal(formToSettings({ ...form, areas: [{ id: "", name: "", usual: "50" }] }).ok, false);
  assert.equal(formToSettings({ ...form, areas: [{ id: "", name: "A", usual: "x" }] }).ok, false);
  assert.equal(formToSettings({ ...form, areas: [{ id: "", name: "A", usual: "1" }, { id: "", name: "a", usual: "2" }] }).ok, false);
});
