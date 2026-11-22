import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_DELIVERY_TEMPLATES,
  DELIVERY_PLACEHOLDERS,
  buildCustomerMessage,
  buildRiderCopyText,
  fillDeliveryTemplate,
  formatIndianMobile,
  formatPaise,
  mapLink,
  normalizeIndianMobile,
  pickupMapLink,
  telLink,
  unknownPlaceholders,
  whatsappLink,
} from "./deliveryText.js";

const delivery = (overrides = {}) => ({
  id: "d-1",
  order_id: "o-1",
  attempt_no: 1,
  customer_name: "Asha",
  customer_phone: "98765 43210",
  address: "12 MG Road",
  landmark: "Opp. temple",
  area_name: "Indiranagar",
  map_link: "",
  provider: "rapido",
  rider_name: "Ravi",
  rider_phone: "9123456789",
  tracking_link: "https://rapido.bike/t/abc",
  quoted_paise: 6000,
  final_paise: null,
  paid_by: "shop",
  status: "booked",
  ...overrides,
});
const order = { id: "o-1", order_no: "ORD-42", customer_name: "Asha (order)", customer_mobile: "9000000001", delivery_address: "Order address" };
const settings = { pickup_address: "Frooz Fruits, 1 Market St", pickup_pin: "12.9716,77.5946", templates: {} };

test("normalizeIndianMobile accepts the ways numbers are written and refuses the rest", () => {
  for (const input of ["9876543210", "98765 43210", "+91 98765 43210", "+91-98765-43210", "09876543210", "0091 9876543210", "919876543210"]) {
    assert.equal(normalizeIndianMobile(input), "919876543210", input);
  }
  for (const input of ["", null, undefined, "12345", "1234567890", "+1 415 555 0100", "98765432101234", "abc"]) {
    assert.equal(normalizeIndianMobile(input), "", String(input));
  }
  assert.equal(formatIndianMobile("09876543210"), "+91 98765 43210");
  assert.equal(formatIndianMobile("landline 2222"), "landline 2222", "kept as typed when not a mobile");
});

test("tel: link for the rider QR", () => {
  assert.equal(telLink("98765 43210"), "tel:+919876543210");
  assert.equal(telLink("+91 9123456789"), "tel:+919123456789");
  assert.equal(telLink("12345"), "");
  assert.equal(telLink(""), "");
});

test("wa.me link carries the number and the encoded text, and never opens without a number", () => {
  assert.equal(whatsappLink("9876543210", "Hi Asha & co, 100%"), `https://wa.me/919876543210?text=${encodeURIComponent("Hi Asha & co, 100%")}`);
  assert.equal(whatsappLink("9876543210", ""), "https://wa.me/919876543210");
  assert.equal(whatsappLink("", "Hello"), "");
  assert.equal(whatsappLink("12345", "Hello"), "");
});

test("map link: stored http(s) link, else coordinates, else an address search, else blank", () => {
  assert.equal(mapLink({ map_link: "https://maps.app.goo.gl/xyz" }), "https://maps.app.goo.gl/xyz");
  assert.equal(mapLink({ map_link: "12.97,77.59", address: "ignored" }), `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("12.97,77.59")}`);
  assert.equal(
    mapLink({ map_link: "", address: "12 MG Road", landmark: "Opp. temple", area_name: "Indiranagar" }),
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("12 MG Road, Opp. temple, Indiranagar")}`,
  );
  assert.equal(mapLink({ map_link: "javascript:alert(1)", address: "12 MG Road" }), `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("12 MG Road")}`);
  assert.equal(mapLink({}), "");
  assert.equal(mapLink(), "");
});

test("pickup map link comes only from a URL or a lat,lng pin", () => {
  assert.equal(pickupMapLink({ pickup_pin: "https://maps.google.com/?q=shop" }), "https://maps.google.com/?q=shop");
  assert.equal(pickupMapLink({ pickup_pin: " 12.9716 , 77.5946 " }), `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("12.9716,77.5946")}`);
  assert.equal(pickupMapLink({ pickup_pin: "near the market" }), "");
  assert.equal(pickupMapLink({ pickup_pin: "123,456" }), "", "out-of-range coordinates");
  assert.equal(pickupMapLink(null), "");
});

test("rider copy text: pickup, drop, order number; blank facts left out", () => {
  const block = buildRiderCopyText({ delivery: delivery(), order, settings, shopName: "Frooz Fruits" });
  const lines = block.split("\n");
  assert.equal(lines[0], "PICKUP");
  assert.ok(lines.includes("Frooz Fruits"));
  assert.ok(lines.includes("Frooz Fruits, 1 Market St"));
  assert.ok(lines.some((line) => line.startsWith("Pin: https://www.google.com/maps/")));
  assert.ok(lines.includes("DROP"));
  assert.ok(lines.includes("Asha"), "the delivery's name wins over the order's");
  assert.ok(lines.includes("Phone: +91 98765 43210"));
  assert.ok(lines.includes("12 MG Road"));
  assert.ok(lines.includes("Landmark: Opp. temple"));
  assert.ok(lines.includes("Area: Indiranagar"));
  assert.ok(lines.some((line) => line.startsWith("Map: https://www.google.com/maps/search/")));
  assert.ok(lines.includes("Order: ORD-42"));
  assert.ok(!/Collect/.test(block), "shop-paid: nothing to collect");

  const bare = buildRiderCopyText({ delivery: delivery({ customer_name: "", customer_phone: "", address: "", landmark: "", area_name: "" }), order: { order_no: "ORD-9", customer_name: "Order Name", customer_mobile: "9000000001", delivery_address: "Order address" } });
  assert.ok(!bare.includes("PICKUP"), "no pickup block without pickup details");
  assert.ok(bare.includes("Order Name") && bare.includes("Order address") && bare.includes("+91 90000 00001"), "falls back to the order");
  assert.ok(!bare.includes("Landmark:") && !bare.includes("Area:"));
});

test("rider copy text says what to collect when the customer pays", () => {
  assert.match(buildRiderCopyText({ delivery: delivery({ paid_by: "customer", final_paise: 7550 }), order }), /Collect delivery charge from customer: ₹75\.50/);
  assert.match(buildRiderCopyText({ delivery: delivery({ paid_by: "customer", quoted_paise: 6000 }), order }), /Collect delivery charge from customer: ₹60$/m);
  const unknownCharge = buildRiderCopyText({ delivery: delivery({ paid_by: "customer", quoted_paise: null }), order });
  assert.match(unknownCharge, /Delivery charge: paid by the customer/);
  assert.ok(!unknownCharge.includes("₹0"), "an unknown charge is never ₹0");
});

test("placeholders and defaults", () => {
  assert.deepEqual([...DELIVERY_PLACEHOLDERS], ["{name}", "{order_no}", "{tracking_link}", "{rider_name}", "{rider_phone}", "{amount}", "{shop}"]);
  for (const kind of ["booked", "picked_up", "delivered"]) {
    assert.ok(DEFAULT_DELIVERY_TEMPLATES[kind].includes("{name}"), kind);
    assert.deepEqual(unknownPlaceholders(DEFAULT_DELIVERY_TEMPLATES[kind]), [], kind);
  }
  assert.deepEqual(unknownPlaceholders("Hi {nmae}, {name} {Order_No} {}"), ["{nmae}", "{Order_No}", "{}"]);
});

test("fillDeliveryTemplate fills every placeholder, drops lines left empty, keeps unknown ones", () => {
  const filled = fillDeliveryTemplate(
    "Hi {name}, order {order_no} from {shop}.\nRider: {rider_name} {rider_phone}\nTrack: {tracking_link}\nPay {amount}\nThanks!\nOops {nmae}",
    { name: "Asha", "{order_no}": "ORD-1", shop: "Frooz", rider_name: "Ravi", rider_phone: "", tracking_link: "", amount: "₹60" },
  );
  assert.equal(filled, "Hi Asha, order ORD-1 from Frooz.\nRider: Ravi\nPay ₹60\nThanks!\nOops {nmae}");
  assert.equal(fillDeliveryTemplate("Hi {name}, your order {order_no} is here.", { order_no: "ORD-1" }), "Hi, your order ORD-1 is here.");
  assert.equal(fillDeliveryTemplate("{name} {name}", { name: "A" }), "A A", "every occurrence");
  assert.equal(fillDeliveryTemplate("", {}), "");
  assert.equal(fillDeliveryTemplate(null), "");
});

test("buildCustomerMessage uses the branch template, else the default", () => {
  const booked = buildCustomerMessage({ kind: "booked", delivery: delivery(), order, settings, shopName: "Frooz Fruits" });
  assert.match(booked, /Hi Asha, aapka order ORD-42/);
  assert.match(booked, /Rider: Ravi \+91 91234 56789/);
  assert.match(booked, /Track: https:\/\/rapido\.bike\/t\/abc/);
  assert.ok(!booked.includes("Delivery charge"), "shop-paid: amount line dropped");
  assert.match(booked, /- Frooz Fruits$/);

  const customerPays = buildCustomerMessage({ kind: "booked", delivery: delivery({ paid_by: "customer" }), order, settings, shopName: "Frooz" });
  assert.match(customerPays, /Delivery charge: ₹60/);

  const own = buildCustomerMessage({ kind: "picked_up", delivery: delivery({ tracking_link: "", rider_name: "", rider_phone: "" }), order, settings, shopName: "Frooz" });
  assert.ok(!own.includes("Track:") && !own.includes("Rider:"));

  const custom = buildCustomerMessage({ kind: "delivered", delivery: delivery(), order, settings: { templates: { delivered: "Done {name}! {amount}" } }, shopName: "Frooz" });
  assert.equal(custom, "Done Asha!");

  const blankTemplate = buildCustomerMessage({ kind: "delivered", delivery: delivery(), order, settings: { templates: { delivered: "  " } }, shopName: "Frooz" });
  assert.match(blankTemplate, /deliver ho gaya/, "blank means the default");

  assert.equal(buildCustomerMessage({ kind: "weird", delivery: delivery(), order }), "");
  assert.match(buildCustomerMessage({ kind: "booked", delivery: delivery({ tracking_link: "javascript:alert(1)" }), order }), /^(?![\s\S]*javascript)/, "only web links are sent");
});

test("formatPaise", () => {
  assert.equal(formatPaise(6000), "₹60");
  assert.equal(formatPaise(125075), "₹1,250.75");
  assert.equal(formatPaise(10000000), "₹1,00,000");
  assert.equal(formatPaise(null), "");
  assert.equal(formatPaise(Number.NaN), "");
});
