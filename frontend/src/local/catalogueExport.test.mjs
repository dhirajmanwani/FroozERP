import test from "node:test";
import assert from "node:assert/strict";

import {
  CATALOGUE_FORMAT_VERSION,
  STOCK_TRUSTED_FOR_HOURS,
  buildCatalogue,
  catalogueFilename,
  describeExport,
  shopDateString,
  tintFor,
} from "./catalogueExport.js";

const NOW = Date.parse("2026-08-22T11:00:00+05:30");

const build = (overrides = {}) => buildCatalogue({ nowMs: NOW, ...overrides });

test("a product with no readable rate is left out, not published at zero", () => {
  const { catalogue, summary } = build({
    products: [
      { id: "1", product_name: "Mango", sale_rate: 240 },
      { id: "2", product_name: "Orange", sale_rate: 0 },
      { id: "3", product_name: "Apple", sale_rate: null },
      { id: "4", product_name: "Guava", sale_rate: "  " },
    ],
  });
  assert.deepEqual(catalogue.products.map((row) => row.name), ["Mango"]);
  assert.deepEqual(summary.skippedNoRate.sort(), ["Apple", "Guava", "Orange"]);
});

test("a rate arriving as a numeric string is still a rate", () => {
  // Postgres hands NUMERIC back as a string, and this file is built from data that
  // has been through that on its way to the device.
  const { catalogue } = build({ products: [{ id: "1", product_name: "Mango", sale_rate: "240.50" }] });
  assert.equal(catalogue.products[0].ratePerKg, 240.5);
});

test("a temporary rate beats the standing one, because that is what temporary means", () => {
  const { catalogue } = build({
    products: [{ id: "1", product_name: "Mango", sale_rate: 240, temporary_sale_rate: 199 }],
  });
  assert.equal(catalogue.products[0].ratePerKg, 199);
});

test("no lots at all means genuinely nothing left, and says zero", () => {
  const { catalogue } = build({ products: [{ id: "1", product_name: "Mango", sale_rate: 240 }], lots: [] });
  assert.equal(catalogue.products[0].availableKg, 0);
});

test("lots with unreadable quantities publish no quantity at all", () => {
  // The site renders a missing availableKg as "we could not check". Publishing 0
  // here would tell every customer the fruit is sold out on the strength of a
  // column we failed to read - the exact failure this whole path exists to avoid.
  for (const broken of [null, undefined, NaN, Infinity, "", "  ", {}, true]) {
    const { catalogue } = build({
      products: [{ id: "1", product_name: "Mango", sale_rate: 240 }],
      lots: [{ product_id: "1", balance_qty: broken }],
    });
    const row = catalogue.products[0];
    assert.equal(Object.hasOwn(row, "availableKg"), false, `quantity ${String(broken)} must not publish a number`);
  }
});

test("a readable lot alongside an unreadable one publishes what is readable", () => {
  const { catalogue } = build({
    products: [{ id: "1", product_name: "Mango", sale_rate: 240 }],
    lots: [
      { product_id: "1", balance_qty: 10 },
      { product_id: "1", balance_qty: "broken" },
      { product_id: "1", balance_qty: 5.25 },
    ],
  });
  assert.equal(catalogue.products[0].availableKg, 15.25);
});

test("a zero quantity is a real zero and is published as one", () => {
  // The case a ?? chain gets wrong.
  const { catalogue } = build({
    products: [{ id: "1", product_name: "Mango", sale_rate: 240 }],
    lots: [{ product_id: "1", balance_qty: 0 }],
  });
  assert.equal(catalogue.products[0].availableKg, 0);
});

test("product ids stay opaque strings and are never coerced", () => {
  const { catalogue } = build({
    products: [
      { id: "004", product_name: "Mango", sale_rate: 240 },
      { id: 4, product_name: "Apple", sale_rate: 185 },
    ],
    lots: [{ product_id: "004", balance_qty: 12 }],
  });
  const mango = catalogue.products.find((row) => row.name === "Mango");
  const apple = catalogue.products.find((row) => row.name === "Apple");
  assert.equal(mango.id, "004");
  assert.equal(apple.id, "4");
  // The lot belongs to "004" only. If ids were coerced, both would claim it.
  assert.equal(mango.availableKg, 12);
  assert.equal(apple.availableKg, 0);
});

test("products the shop has withdrawn are not published", () => {
  const { catalogue } = build({
    products: [
      { id: "1", product_name: "Mango", sale_rate: 240 },
      { id: "2", product_name: "Old Stock", sale_rate: 100, status: "INACTIVE" },
      { id: "3", product_name: "Gone", sale_rate: 100, status: "discontinued" },
    ],
  });
  assert.deepEqual(catalogue.products.map((row) => row.name), ["Mango"]);
});

test("the newest lot is the one the arrival date comes from", () => {
  const { catalogue } = build({
    products: [{ id: "1", product_name: "Mango", sale_rate: 240 }],
    lots: [
      { product_id: "1", balance_qty: 5, purchase_date: "2026-08-19T06:00:00+05:30" },
      { product_id: "1", balance_qty: 5, purchase_date: "2026-08-22T04:00:00+05:30" },
      { product_id: "1", balance_qty: 5, purchase_date: "2026-08-20T06:00:00+05:30" },
    ],
  });
  assert.equal(catalogue.products[0].arrivedAt, new Date("2026-08-22T04:00:00+05:30").toISOString());
});

test("the file carries what the site needs to distrust it later", () => {
  const { catalogue } = build({ products: [{ id: "1", product_name: "Mango", sale_rate: 240 }] });
  assert.equal(catalogue.formatVersion, CATALOGUE_FORMAT_VERSION);
  assert.equal(catalogue.stockTrustedForHours, STOCK_TRUSTED_FOR_HOURS);
  assert.equal(catalogue.generatedAt, new Date(NOW).toISOString());
});

test("the rate date is the shop's day, not the exporting machine's", () => {
  // 11pm UTC on the 21st is already the 22nd in Jodhpur. A file exported then must
  // not tell customers it carries the previous day's rates.
  const lateUtc = Date.parse("2026-08-21T23:00:00Z");
  assert.equal(shopDateString(lateUtc), "2026-08-22");
  const { catalogue } = buildCatalogue({
    nowMs: lateUtc,
    products: [{ id: "1", product_name: "Mango", sale_rate: 240 }],
  });
  assert.equal(catalogue.ratesSetOn, "2026-08-22");
  assert.equal(catalogueFilename(lateUtc), "frooz-catalogue-2026-08-22.json");
});

test("produce colours match on whole words and fall back rather than guess wrong", () => {
  assert.equal(tintFor("Alphonso Mango"), tintFor("Banganapalli Mango"));
  assert.notEqual(tintFor("Kashmiri Apple"), tintFor("Alphonso Mango"));
  // "Pineapple" contains "apple" but is not one. Whole-word matching keeps them apart.
  assert.notEqual(tintFor("Pineapple"), tintFor("Kashmiri Apple"));
  // Nothing known about it, so it gets the neutral green rather than a wrong colour.
  assert.equal(tintFor("Rambutan"), tintFor("Something Unheard Of"));
});

test("the summary tells the person what will and will not be on the website", () => {
  const { summary } = build({
    products: [
      { id: "1", product_name: "Mango", sale_rate: 240 },
      { id: "2", product_name: "Orange", sale_rate: 0 },
      { id: "3", product_name: "Apple", sale_rate: 185 },
    ],
    lots: [{ product_id: "3", balance_qty: "broken" }],
  });
  const text = describeExport(summary);
  assert.match(text, /2 items ready/);
  assert.match(text, /Orange/);
  assert.match(text, /stock not confirmed/);
});

test("an export with nothing sellable says so instead of producing an empty shop", () => {
  const { summary } = build({ products: [{ id: "1", product_name: "Mango", sale_rate: 0 }] });
  assert.match(describeExport(summary), /Nothing could be published/);
});

test("products come out in a stable order", () => {
  const { catalogue } = build({
    products: [
      { id: "1", product_name: "Watermelon", sale_rate: 32 },
      { id: "2", product_name: "Apple", sale_rate: 185 },
      { id: "3", product_name: "Mango", sale_rate: 240 },
    ],
  });
  assert.deepEqual(catalogue.products.map((row) => row.name), ["Apple", "Mango", "Watermelon"]);
});
