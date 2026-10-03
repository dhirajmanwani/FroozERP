import assert from "node:assert/strict";
import test from "node:test";
import {
  PRICE_LIST_SHARE_ROUTE,
  choosePriceListShareRoute,
  priceListCopySaveOutcome,
  PRICE_LIST_CAPTION_MAX_ROWS,
  PRICE_LIST_LAST_PREPARED_KEY,
  PRICE_LIST_SCHEDULE_DEFAULTS,
  PRICE_LIST_SCHEDULE_KEY,
  PRICE_LIST_STATUS,
  buildPriceList,
  buildPriceListHeader,
  formatPriceListMoney,
  localDateString,
  normalizePriceListSchedule,
  priceListCaption,
  priceListFileName,
  readLastPreparedOn,
  readPriceListSchedule,
  shouldPreparePriceList,
  writeLastPreparedOn,
  writePriceListSchedule,
} from "./dailyPriceList.js";
import { LOCATION_SCOPE_STATUS, UNKNOWN_COUNTER_SCOPE, createCounterScope } from "./locationScope.js";
import { indexProductPhotos } from "./productPhotos.js";

const NOW = new Date("2026-10-03T03:00:00.000Z");
const jpeg = (bytes) => `data:image/jpeg;base64,${Buffer.alloc(bytes, 7).toString("base64")}`;

const memoryStorage = () => {
  const values = new Map();
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
};

const throwingStorage = {
  getItem() { throw new Error("SecurityError"); },
  setItem() { throw new Error("QuotaExceededError"); },
};

test("only products with stock on the shelf are listed; stock 0 and dead lots never appear", () => {
  const products = [
    { id: "p1", product_name: "Apple", unit: "KG", selling_rate: 120 },
    { id: "p2", product_name: "Banana", unit: "DOZEN", selling_rate: 60 },
    { id: "p3", product_name: "Cherry", unit: "KG", selling_rate: 400 },
    { id: "p4", product_name: "Dates", unit: "KG", selling_rate: 300 },
    { id: "p5", product_name: "Fig", unit: "KG", selling_rate: 500 },
    { id: "p6", product_name: "Guava", unit: "KG", selling_rate: 80, active: false },
    { id: "p7", product_name: "Kiwi", unit: "BOX", selling_rate: 90, deleted_at: "2026-09-01" },
  ];
  const inventoryLots = [
    { id: "l1", product_id: "p1", remaining_qty: 10 },
    { id: "l2", product_id: "p2", remaining_qty: 0 },
    { id: "l3", product_id: "p3", remaining_qty: 5, batch_status: "CANCELLED" },
    { id: "l4", product_id: "p4", remaining_qty: 5, expiry_date: "2026-10-01T00:00:00Z" },
    { id: "l5", product_id: "p5", remaining_qty: 4, reserved_qty: 4 },
    { id: "l6", product_id: "p6", remaining_qty: 7 },
    { id: "l7", product_id: "p7", remaining_qty: 7 },
  ];
  const list = buildPriceList({ products, inventoryLots, now: NOW });
  assert.equal(list.status, PRICE_LIST_STATUS.READY);
  assert.equal(list.usable, true);
  assert.deepEqual(list.rows.map((row) => row.name), ["Apple"]);
  assert.equal(list.summary.listed, 1);
  assert.deepEqual(list.summary.skippedNoRate, []);
  assert.ok(Object.isFrozen(list) && Object.isFrozen(list.rows) && Object.isFrozen(list.rows[0]));
});

test("rates follow the till exactly: lot rate first, the product's when the lot's is 0", () => {
  const products = [
    { id: "p1", product_name: "Mango Alphonso", unit: "KG", selling_rate: 150 },
    { id: "p2", product_name: "Papaya", unit: "KG", selling_rate: 0, sale_rate: 45 },
    { id: "p3", product_name: "Orange", unit: "KG", selling_rate: 70 },
  ];
  const inventoryLots = [
    { id: "l1", product_id: "p1", remaining_qty: 3, temporary_sale_rate: 130, sale_rate: 160 },
    { id: "l2", product_id: "p2", remaining_qty: 3, temporary_sale_rate: 0, sale_rate: 0 },
    // Copied from the till's `lotSaleRateValue`, `??` and all: a 0 temporary rate stops the lot
    // chain and the product's rate applies, exactly as POS will charge it.
    { id: "l3", product_id: "p3", remaining_qty: 3, temporary_sale_rate: 0, sale_rate: 75 },
  ];
  const list = buildPriceList({ products, inventoryLots, now: NOW });
  const byName = Object.fromEntries(list.rows.map((row) => [row.name, row]));
  assert.equal(byName["Mango Alphonso"].minRate, 130);
  assert.equal(byName["Mango Alphonso"].rateLabel, "₹130 / kg");
  assert.equal(byName.Orange.minRate, 70, "the till charges the product rate here, so the list quotes it");
  // selling_rate 0 is present, so the till reads 0 and never reaches sale_rate: no price to quote.
  assert.equal(byName.Papaya, undefined);
  assert.deepEqual(list.summary.skippedNoRate, ["Papaya"]);
});

test("two lots at different rates show a min–max range; sold-out lots do not widen it", () => {
  const products = [{ id: "p1", product_name: "Apple Shimla", unit: "KG", selling_rate: 110 }];
  const inventoryLots = [
    { id: "a", product_id: "p1", remaining_qty: 5, sale_rate: 120 },
    { id: "b", product_id: "p1", remaining_qty: 2, temporary_sale_rate: 100 },
    { id: "c", product_id: "p1", remaining_qty: 0, sale_rate: 999 },
    { id: "d", product_id: "p1", remaining_qty: 4, status: "EXPIRED", sale_rate: 10 },
  ];
  const [row] = buildPriceList({ products, inventoryLots, now: NOW }).rows;
  assert.equal(row.minRate, 100);
  assert.equal(row.maxRate, 120);
  assert.equal(row.rateLabel, "₹100 – ₹120 / kg");
  assert.equal(row.unit, "kg");
  assert.equal(row.initial, "A");
  assert.equal(row.tint, "#a83a34");
});

test("money keeps paise only when there are any, with Indian grouping", () => {
  assert.equal(formatPriceListMoney(120), "₹120");
  assert.equal(formatPriceListMoney(99.5), "₹99.50");
  assert.equal(formatPriceListMoney(120000), "₹1,20,000");
  assert.equal(formatPriceListMoney(45.678), "₹45.68");
});

test("under a counter scope another shop's lots are excluded; an unknown scope is UNAVAILABLE, not empty", () => {
  const products = [
    { id: "p1", product_name: "Apple", unit: "KG", selling_rate: 120 },
    { id: "p2", product_name: "Grapes", unit: "KG", selling_rate: 90 },
  ];
  const inventoryLots = [
    { id: "r1", product_id: "p1", remaining_qty: 15, branch_id: "2", sale_rate: 125 },
    { id: "m1", product_id: "p1", remaining_qty: 20, branch_id: "1", sale_rate: 999 },
    { id: "m2", product_id: "p2", remaining_qty: 20, branch_id: "1" },
  ];
  const ratanada = createCounterScope({ companyId: "1", branchId: "2", locationName: "Ratanada" });
  const scoped = buildPriceList({ products, inventoryLots, scope: ratanada, now: NOW });
  assert.equal(scoped.status, PRICE_LIST_STATUS.READY);
  assert.deepEqual(scoped.rows.map((row) => [row.name, row.rateLabel]), [["Apple", "₹125 / kg"]]);
  assert.equal(scoped.summary.scopeStatus, LOCATION_SCOPE_STATUS.FOREIGN_ROWS_EXCLUDED);

  const unknown = buildPriceList({ products, inventoryLots, scope: UNKNOWN_COUNTER_SCOPE, now: NOW });
  assert.equal(unknown.status, PRICE_LIST_STATUS.UNAVAILABLE);
  assert.equal(unknown.usable, false);
  assert.deepEqual(unknown.rows, []);
  assert.match(unknown.message, /has not been told which shop it is in/);
});

test("\"004\" and 4 stay different products", () => {
  const products = [
    { id: "004", product_name: "Lychee", unit: "KG", selling_rate: 200 },
    { id: 4, product_name: "Pear", unit: "KG", selling_rate: 150 },
  ];
  const inventoryLots = [{ id: "l1", product_id: 4, remaining_qty: 6 }];
  const list = buildPriceList({ products, inventoryLots, now: NOW });
  assert.deepEqual(list.rows.map((row) => [row.id, row.name]), [["4", "Pear"]]);
});

test("a product known on this device only by its global id still gets its photo", () => {
  const photo = jpeg(30);
  const photoIndex = indexProductPhotos([{ product_id: 12, product_global_id: "product-12", photo }]);
  const products = [
    { id: "product-12", product_name: "pomegranate", unit: "KG", selling_rate: 180 },
    { id: "product-13", product_name: "Watermelon", unit: "PIECE", selling_rate: 60 },
  ];
  const inventoryLots = [
    { id: "l1", product_id: "product-12", remaining_qty: 3 },
    { id: "l2", product_id: "product-13", remaining_qty: 3 },
  ];
  const rows = buildPriceList({ products, inventoryLots, photoIndex, now: NOW }).rows;
  assert.equal(rows[0].name, "pomegranate");
  assert.equal(rows[0].photo, photo);
  assert.equal(rows[0].initial, "P");
  assert.equal(rows[1].photo, null);
  assert.equal(rows[1].rateLabel, "₹60 / piece");
});

test("an in-stock product without any rate is left off and named, not shown at ₹0", () => {
  const products = [
    { id: "p1", product_name: "Chikoo", unit: "KG", selling_rate: 0 },
    { id: "p2", product_name: "banana", unit: "DOZEN", selling_rate: 60 },
  ];
  const inventoryLots = [
    { id: "l1", product_id: "p1", remaining_qty: 4, sale_rate: "" },
    { id: "l2", product_id: "p2", remaining_qty: 4 },
  ];
  const list = buildPriceList({ products, inventoryLots, now: NOW });
  assert.deepEqual(list.rows.map((row) => row.name), ["banana"]);
  assert.deepEqual(list.summary.skippedNoRate, ["Chikoo"]);
  assert.match(list.message, /no selling rate is set: Chikoo/);

  const onlyUnpriced = buildPriceList({ products: [products[0]], inventoryLots, now: NOW });
  assert.equal(onlyUnpriced.status, PRICE_LIST_STATUS.EMPTY);
  assert.deepEqual(onlyUnpriced.summary.skippedNoRate, ["Chikoo"]);
});

test("rows sort by name ignoring case", () => {
  const products = ["mango", "Apple", "banana"].map((name, index) => ({ id: `p${index}`, product_name: name, unit: "KG", selling_rate: 50 }));
  const inventoryLots = products.map((product) => ({ id: `l-${product.id}`, product_id: product.id, remaining_qty: 1 }));
  assert.deepEqual(buildPriceList({ products, inventoryLots, now: NOW }).rows.map((row) => row.name), ["Apple", "banana", "mango"]);
});

test("nothing in stock is EMPTY; input that is not a list is UNAVAILABLE, never an empty READY", () => {
  const empty = buildPriceList({ products: [{ id: "p1", product_name: "Apple", selling_rate: 1 }], inventoryLots: [], now: NOW });
  assert.equal(empty.status, PRICE_LIST_STATUS.EMPTY);
  assert.equal(empty.usable, true);
  assert.match(empty.message, /Nothing is in stock/);

  for (const input of [
    { products: null, inventoryLots: [] },
    { products: [], inventoryLots: undefined },
    { products: { id: 1 }, inventoryLots: [] },
    {},
  ]) {
    const list = buildPriceList({ ...input, now: NOW });
    assert.equal(list.status, PRICE_LIST_STATUS.UNAVAILABLE);
    assert.equal(list.usable, false);
    assert.match(list.message, /has not loaded/);
  }
  assert.equal(buildPriceList().status, PRICE_LIST_STATUS.UNAVAILABLE);
});

test("the header names the shop and the shop's own day", () => {
  const header = buildPriceListHeader({
    businessSettings: { business_name: " ", brand_name: "Frooz", company_name: "SRT Company", phone_number: "98290 00000", address: "Ratanada, Jodhpur" },
    branchName: "Ratanada",
    // 20:00 UTC on 2 Oct is 01:30 on 3 Oct in the shop.
    now: new Date("2026-10-02T20:00:00.000Z"),
  });
  assert.deepEqual(header, {
    title: "Frooz",
    subtitle: "Today's prices · Ratanada",
    phone: "98290 00000",
    address: "Ratanada, Jodhpur",
    dateLabel: "Sat, 3 Oct 2026",
  });
  assert.equal(buildPriceListHeader({ now: NOW }).title, "FroozERP");
  assert.equal(buildPriceListHeader({ businessSettings: null, now: NOW }).subtitle, "Today's prices");
});

test("schedule normalisation: enabled only when true, time only when a real HH:MM", () => {
  assert.deepEqual(PRICE_LIST_SCHEDULE_DEFAULTS, { enabled: false, time: "08:00" });
  assert.ok(Object.isFrozen(PRICE_LIST_SCHEDULE_DEFAULTS));
  assert.deepEqual(normalizePriceListSchedule({ enabled: true, time: "07:45" }), { enabled: true, time: "07:45" });
  assert.deepEqual(normalizePriceListSchedule({ enabled: "true", time: "23:59" }), { enabled: false, time: "23:59" });
  for (const time of ["24:00", "7:45", "08:60", "", "noon", null, 800]) {
    assert.equal(normalizePriceListSchedule({ enabled: true, time }).time, "08:00", `time ${time}`);
  }
  assert.deepEqual(normalizePriceListSchedule(null), { enabled: false, time: "08:00" });
});

test("schedule storage round-trips, and a throwing or missing storage never throws", () => {
  const storage = memoryStorage();
  assert.deepEqual(readPriceListSchedule(storage), { enabled: false, time: "08:00" });
  assert.equal(writePriceListSchedule(storage, { enabled: true, time: "06:30" }), true);
  assert.deepEqual(JSON.parse(storage.values.get(PRICE_LIST_SCHEDULE_KEY)), { enabled: true, time: "06:30" });
  assert.deepEqual(readPriceListSchedule(storage), { enabled: true, time: "06:30" });
  storage.setItem(PRICE_LIST_SCHEDULE_KEY, "{not json");
  assert.deepEqual(readPriceListSchedule(storage), { enabled: false, time: "08:00" });

  assert.equal(readLastPreparedOn(storage), "");
  assert.equal(writeLastPreparedOn(storage, "2026-10-03"), true);
  assert.equal(storage.values.get(PRICE_LIST_LAST_PREPARED_KEY), "2026-10-03");
  assert.equal(readLastPreparedOn(storage), "2026-10-03");
  assert.equal(writeLastPreparedOn(storage, "yesterday"), false);

  for (const broken of [throwingStorage, null, undefined, {}]) {
    assert.deepEqual(readPriceListSchedule(broken), { enabled: false, time: "08:00" });
    assert.equal(writePriceListSchedule(broken, { enabled: true, time: "06:30" }), false);
    assert.equal(readLastPreparedOn(broken), "");
    assert.equal(writeLastPreparedOn(broken, "2026-10-03"), false);
  }
});

test("the list is due from the set minute onwards, once a day, and catches up after a missed minute", () => {
  const at = (hours, minutes) => new Date(2026, 9, 3, hours, minutes);
  const schedule = { enabled: true, time: "08:00" };

  const off = shouldPreparePriceList({ now: at(9, 0), schedule: { enabled: false, time: "08:00" }, lastPreparedOn: "" });
  assert.equal(off.due, false);
  assert.match(off.reason, /switched off/);

  const early = shouldPreparePriceList({ now: at(7, 59), schedule, lastPreparedOn: "2026-10-02" });
  assert.equal(early.due, false);
  assert.match(early.reason, /Not yet 08:00/);

  const onTime = shouldPreparePriceList({ now: at(8, 0), schedule, lastPreparedOn: "2026-10-02" });
  assert.deepEqual(onTime, { due: true, today: "2026-10-03", reason: onTime.reason });

  const catchUp = shouldPreparePriceList({ now: at(13, 27), schedule, lastPreparedOn: "2026-10-02" });
  assert.equal(catchUp.due, true, "a laptop opened hours after the set time still prepares today's list");

  const done = shouldPreparePriceList({ now: at(13, 27), schedule, lastPreparedOn: "2026-10-03" });
  assert.equal(done.due, false);
  assert.match(done.reason, /already been prepared/);

  const malformed = shouldPreparePriceList({ now: at(7, 30), schedule: { enabled: true, time: "7:30" }, lastPreparedOn: "" });
  assert.equal(malformed.due, false, "a malformed time falls back to 08:00, not to midnight");
  assert.equal(shouldPreparePriceList({ now: at(8, 1), schedule: { enabled: true, time: "25:00" }, lastPreparedOn: "" }).due, true);

  assert.equal(shouldPreparePriceList({ now: at(9, 0) }).due, false);
});

test("local dates and the file name use the device's own day", () => {
  assert.equal(localDateString(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(priceListFileName(new Date(2026, 9, 3, 8, 0)), "Frooz_PriceList_2026-10-03.png");
});

test("the WhatsApp caption lists each item and stops at the row limit", () => {
  const header = { title: "Frooz", dateLabel: "Sat, 3 Oct 2026" };
  const short = priceListCaption({ header, rows: [{ name: "Apple", rateLabel: "₹120 / kg" }, { name: "Banana", rateLabel: "₹50 – ₹60 / dozen" }] });
  assert.equal(short, "Frooz\nToday's prices – Sat, 3 Oct 2026\n\nApple – ₹120 / kg\nBanana – ₹50 – ₹60 / dozen");

  const rows = Array.from({ length: PRICE_LIST_CAPTION_MAX_ROWS + 7 }, (_, index) => ({ name: `Item ${index + 1}`, rateLabel: "₹10 / kg" }));
  const lines = priceListCaption({ header, rows }).split("\n");
  assert.equal(PRICE_LIST_CAPTION_MAX_ROWS, 60);
  assert.equal(lines.at(-2), "Item 60 – ₹10 / kg");
  assert.equal(lines.at(-1), "+7 more");
  assert.equal(lines.length, 3 + 60 + 1);

  const exact = priceListCaption({ header, rows: rows.slice(0, 60) });
  assert.doesNotMatch(exact, /more/);
});

// ---------------------------------------------------------------------------------------------
// Wiring: the panel is the first thing on the Dashboard, and the reminder never sends anything
// ---------------------------------------------------------------------------------------------

const appSource = (await import("node:fs")).readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("the price list sits at the top of the Dashboard, above the welcome banner", () => {
  const start = appSource.indexOf('activeView === "dashboard" && hasModuleAccess("dashboard") && (');
  const panel = appSource.indexOf("<DailyPriceListPanel", start);
  const banner = appSource.indexOf('className="welcome-banner"', start);
  assert.ok(start > 0 && panel > start && panel < banner);
  // On a counter: this computer's own shelf and scope, read the way POS reads them, so the list
  // cannot quote another shop's stock and does not wait for POS to be opened first.
  const props = appSource.slice(panel, banner);
  assert.match(props, /inventoryLots=\{isTauriRuntime\(\) \? priceListShelf\.inventoryLots : inventory\}/);
  assert.match(props, /scope=\{isTauriRuntime\(\) \? priceListShelf\.scope : null\}/);
  assert.match(props, /loading=\{isTauriRuntime\(\) && /);
});

test("the Dashboard reads the shelf with the POS scope ladder and never replaces the app's lists", () => {
  const start = appSource.indexOf('if (!user?.id || activeView !== "dashboard" || !isTauriRuntime()) return undefined;');
  assert.ok(start > 0);
  const effect = appSource.slice(start, appSource.indexOf("}, [activeView, deviceInfo.device_id, lastReferenceSyncAt, localDbStatus, posRefreshToken, user?.id, user?.username]);", start));
  assert.match(effect, /loadLocalReferenceSnapshot\(/);
  assert.match(effect, /resolveCounterScope\(snapshot\)/);
  assert.match(effect, /selectLocalPosInventory\(snapshot, \{\}, scope\)/);
  assert.doesNotMatch(effect, /setProducts\(|setInventory\(|setPosShelf\(|axios|fetch\(/);
  // A failed read is an error on the panel, never an empty list.
  assert.match(effect, /status: "error"/);
});

test("the morning reminder only notifies; it makes no request and sends nothing", () => {
  const start = appSource.indexOf("shouldPreparePriceList({ schedule: priceListSchedule");
  const effect = appSource.slice(start, appSource.indexOf("}, [notify, priceListSchedule, user]);", start));
  assert.ok(start > 0);
  assert.match(effect, /notify\(\{/);
  assert.match(effect, /writeLastPreparedOn\(storage, decision\.today\)/);
  assert.doesNotMatch(effect, /axios|fetch\(|API_URL|whatsapp\/send/i);
});

// ---------------------------------------------------------------------------------------------
// Share route: inside the FroozERP app the browser share window is never used (3 Oct 2026)
// ---------------------------------------------------------------------------------------------

test("the app (counter or phone) always copies and saves; only a real browser opens the share window", () => {
  assert.equal(choosePriceListShareRoute({ appShell: true, canShareFiles: true }), PRICE_LIST_SHARE_ROUTE.COPY_AND_SAVE);
  assert.equal(choosePriceListShareRoute({ appShell: true, canShareFiles: false }), PRICE_LIST_SHARE_ROUTE.COPY_AND_SAVE);
  assert.equal(choosePriceListShareRoute({ appShell: false, canShareFiles: true }), PRICE_LIST_SHARE_ROUTE.NATIVE_SHARE);
  assert.equal(choosePriceListShareRoute({ appShell: false, canShareFiles: false }), PRICE_LIST_SHARE_ROUTE.COPY_AND_SAVE);
  assert.equal(choosePriceListShareRoute({ appShell: false, canShareFiles: "yes" }), PRICE_LIST_SHARE_ROUTE.COPY_AND_SAVE);
  assert.equal(choosePriceListShareRoute(), PRICE_LIST_SHARE_ROUTE.COPY_AND_SAVE);
});

test("the outcome says only what actually happened, and a total failure is an error", () => {
  const both = priceListCopySaveOutcome({ copied: true, saved: true, fileName: "Frooz_PriceList_2026-10-03.png" });
  assert.equal(both.tone, "ok");
  assert.match(both.text, /Ctrl\+V/);
  assert.match(both.text, /Frooz_PriceList_2026-10-03\.png/);
  const copiedOnly = priceListCopySaveOutcome({ copied: true, saved: false, fileName: "x.png" });
  assert.doesNotMatch(copiedOnly.text, /Downloads/);
  const savedOnly = priceListCopySaveOutcome({ copied: false, saved: true, fileName: "x.png" });
  assert.doesNotMatch(savedOnly.text, /Ctrl\+V/);
  assert.match(savedOnly.text, /Downloads/);
  assert.equal(priceListCopySaveOutcome({ copied: false, saved: false }).tone, "error");
});

test("the share button never waits on a share window without a time limit, and never uses it in the app", () => {
  const start = appSource.indexOf("const share = async () => {");
  const body = appSource.slice(start, appSource.indexOf("const copyText = async", start));
  assert.match(body, /choosePriceListShareRoute\(\{\s*appShell: isDesktopShell\(\)/);
  assert.match(body, /Promise\.race\(\[\s*navigator\.share/);
  assert.match(body, /PRICE_LIST_SHARE_TIMEOUT_MS/);
  assert.match(body, /priceListCopySaveOutcome\(\{ copied, saved, fileName \}\)/);
});
