/**
 * Today's price list: what the shop has on its shelf this morning, and what each item sells for.
 *
 * The owner shares it as a picture to the shop's WhatsApp group every morning, at a time he sets,
 * so the list a customer reads has to be the list the counter will actually bill from. That is why
 * nothing here re-derives stock or rates:
 *
 * - **What is in stock** is `resolveSellableProducts` from `posInventory.js` — the same call POS
 *   renders from, with the same counter scope. A product at stock 0 is never listed (the owner's
 *   explicit rule: a customer who comes in for something on the list and is told it is finished
 *   does not come back), and another shop's crates do not make an item "in stock" here.
 * - **What it sells for** mirrors the POS tile in `App.jsx` (`lotSaleRateValue` and the tile's
 *   min..max range): a lot's own rate when it has one, else the product's, taken over the lots the
 *   counter could actually sell from. A sold-out or expired lot's old price is not today's price.
 *
 * Two departures from the App.jsx rule, both on the side of a correct number: each field is chosen
 * by "first value > 0" rather than with `??` (a `temporary_sale_rate` of 0 used to hide a real
 * `sale_rate` behind it), and a product with no positive rate anywhere is left off the list and
 * *named* in `summary.skippedNoRate` instead of being printed at ₹0.
 *
 * An unknown counter scope, or input that is not a list, comes back as `UNAVAILABLE` with a sentence
 * — never as an empty `READY` list, which would be shared as "nothing in stock today".
 *
 * The schedule helpers below are per device, kept in localStorage by the caller. Pure functions
 * only: no DOM, no network. `App.jsx` draws the picture and opens the share sheet.
 */

import { counterMaySell, resolveScopedLots } from "./locationScope.js";
import { isSellableLot, resolveSellableProducts } from "./posInventory.js";
import { photoForProduct } from "./productPhotos.js";
import { tintFor, shopDateString } from "./catalogueExport.js";
import { finiteOrNull, unitDisplayName, MISSING_VALUE } from "./productMaster.js";
import { canonicalInventoryId } from "./stockInventory.js";

export const PRICE_LIST_STATUS = Object.freeze({
  /** There is a list to share. */
  READY: "READY",
  /** The question was answered and the answer is "nothing in stock with a rate". */
  EMPTY: "EMPTY",
  /** The question could not be answered (unknown counter scope, bad input). Never share this. */
  UNAVAILABLE: "UNAVAILABLE",
});

/** How many items the WhatsApp caption spells out before it says "+N more". */
export const PRICE_LIST_CAPTION_MAX_ROWS = 60;

const isList = Array.isArray;

// First value that is a real number above zero, or null. Not `??`: a 0 or "" must fall through.
const firstPositive = (...values) => {
  for (const value of values) {
    const number = finiteOrNull(value);
    if (number !== null && number > 0) return number;
  }
  return null;
};

/**
 * The POS rate rule, copied exactly from `lotSaleRateValue` in App.jsx, `??` chain included: the
 * list a customer reads must quote what the till will charge. The lot's first *present* rate field
 * wins and falls to the product's rate only when it is not above 0. (The SQLite snapshot emits
 * `temporary_sale_rate` and `sale_rate` from one column, so on a counter the chain never differs.)
 */
export const lotSellingRate = (lot, product) => {
  const lotRate = Number(lot?.temporary_sale_rate ?? lot?.sale_rate ?? lot?.selling_rate ?? 0);
  if (Number.isFinite(lotRate) && lotRate > 0) return lotRate;
  return firstPositive(product?.selling_rate ?? product?.sale_rate ?? 0);
};

const roundMoney = (value) => Math.round(value * 100) / 100;

/** "₹1,20,000" for a whole amount, "₹99.50" otherwise. Indian digit grouping. */
export const formatPriceListMoney = (value) => {
  const amount = roundMoney(Number(value));
  const digits = Number.isInteger(amount) ? 0 : 2;
  return `₹${amount.toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

const unitLabel = (unit) => {
  const display = unitDisplayName(unit);
  return display === MISSING_VALUE ? "unit" : display.toLowerCase();
};

/** "₹120 / kg", or "₹100 – ₹120 / kg" when today's lots are priced differently. */
export const priceListRateLabel = (minRate, maxRate, unit) => {
  const low = formatPriceListMoney(minRate);
  const high = formatPriceListMoney(maxRate);
  const price = low === high ? low : `${low} – ${high}`;
  return `${price} / ${unit}`;
};

const productName = (product) => String(product?.product_name ?? product?.name ?? "").trim();

const retiredStatuses = new Set(["INACTIVE", "DISCONTINUED", "DELETED"]);
const isListedProduct = (product) => (
  product?.active !== false
  && !product?.deleted_at
  && !retiredStatuses.has(String(product?.status ?? product?.product_status ?? "ACTIVE").trim().toUpperCase())
);

const unavailable = (message, scopeStatus = null) => Object.freeze({
  status: PRICE_LIST_STATUS.UNAVAILABLE,
  usable: false,
  rows: Object.freeze([]),
  message,
  summary: Object.freeze({ listed: 0, skippedNoRate: Object.freeze([]), scopeStatus }),
});

const skippedSentence = (names) => {
  if (!names.length) return "";
  const shown = names.slice(0, 3).join(", ");
  const more = names.length > 3 ? ` and ${names.length - 3} more` : "";
  return `${names.length} in stock but left off because no selling rate is set: ${shown}${more}.`;
};

/**
 * Build today's list.
 *
 * Returns a frozen `{ status, usable, rows, message, summary }`. `summary.skippedNoRate` names every
 * in-stock product left off for want of a rate, so "Mango is missing from the list" is something
 * the owner reads before sharing rather than hears from a customer.
 */
export const buildPriceList = ({
  products,
  inventoryLots,
  photoIndex = null,
  scope = null,
  now = new Date(),
} = {}) => {
  if (!isList(products)) {
    return unavailable("The product list has not loaded, so today's price list cannot be made yet. Press Sync now or reopen the Dashboard.");
  }
  if (!isList(inventoryLots)) {
    return unavailable("The stock list has not loaded, so today's price list cannot be made yet. Press Sync now or reopen the Dashboard.");
  }

  const sellable = resolveSellableProducts({ products, inventoryLots, now, scope });
  if (!sellable.usable) {
    return unavailable(
      sellable.message || "This counter cannot tell what is on its own shelf, so it cannot make a price list.",
      sellable.status ?? null,
    );
  }

  // The same scope filter `resolveSellableProducts` applied, so the rates come from exactly the
  // lots that made the product count as in stock — summary and detail from one source.
  const scoped = resolveScopedLots(inventoryLots, scope);
  if (!counterMaySell(scoped)) return unavailable(scoped.message, scoped.status ?? null);
  const lotsByProduct = new Map();
  for (const lot of scoped.lots) {
    if (!isSellableLot(lot, now)) continue;
    const key = canonicalInventoryId(lot?.product_id);
    if (!key) continue;
    const list = lotsByProduct.get(key) || [];
    list.push(lot);
    lotsByProduct.set(key, list);
  }

  const rows = [];
  const skippedNoRate = [];
  for (const product of sellable.products) {
    if (!isListedProduct(product)) continue;
    const id = canonicalInventoryId(product?.id);
    const name = productName(product) || id;
    const rates = (lotsByProduct.get(id) || [])
      .map((lot) => lotSellingRate(lot, product))
      .filter((rate) => rate !== null);
    if (!rates.length) {
      skippedNoRate.push(name);
      continue;
    }
    const minRate = roundMoney(Math.min(...rates));
    const maxRate = roundMoney(Math.max(...rates));
    const unit = unitLabel(product?.unit);
    rows.push(Object.freeze({
      id,
      name,
      unit,
      minRate,
      maxRate,
      rateLabel: priceListRateLabel(minRate, maxRate, unit),
      photo: photoForProduct(photoIndex, product),
      tint: tintFor(name),
      initial: name.slice(0, 1).toUpperCase(),
    }));
  }

  const byName = (left, right) => (
    left.localeCompare(right, "en-IN", { sensitivity: "base" })
  );
  rows.sort((left, right) => byName(left.name, right.name) || byName(left.id, right.id));
  skippedNoRate.sort(byName);

  const skippedNote = skippedSentence(skippedNoRate);
  const status = rows.length ? PRICE_LIST_STATUS.READY : PRICE_LIST_STATUS.EMPTY;
  const message = rows.length
    ? skippedNote
    : (skippedNote || "Nothing is in stock on this counter right now, so there is no price list to share.");

  return Object.freeze({
    status,
    usable: true,
    rows: Object.freeze(rows),
    message,
    summary: Object.freeze({
      listed: rows.length,
      skippedNoRate: Object.freeze(skippedNoRate),
      scopeStatus: sellable.status ?? null,
    }),
  });
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const epochOf = (now) => {
  const time = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(time) ? time : Date.now();
};

/** "Sat, 3 Oct 2026" for the shop's own day (IST). Built by hand so it never varies with ICU data. */
export const priceListDateLabel = (now = new Date()) => {
  const [year, month, day] = shopDateString(epochOf(now)).split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return `${WEEKDAYS[weekday]}, ${day} ${MONTHS[month - 1]} ${year}`;
};

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** The heading of the picture: shop name, branch, contact and the day the rates are for. */
export const buildPriceListHeader = ({ businessSettings = {}, branchName = "", now = new Date() } = {}) => {
  const settings = businessSettings && typeof businessSettings === "object" ? businessSettings : {};
  const branch = text(branchName);
  return {
    title: text(settings.business_name) || text(settings.brand_name) || text(settings.company_name) || "FroozERP",
    subtitle: branch ? `Today's prices · ${branch}` : "Today's prices",
    phone: text(settings.phone_number) || text(settings.phone),
    address: text(settings.address),
    dateLabel: priceListDateLabel(now),
  };
};

// ---- The morning schedule (per device) ------------------------------------------------------

export const PRICE_LIST_SCHEDULE_KEY = "froozerp.priceList.schedule";
export const PRICE_LIST_LAST_PREPARED_KEY = "froozerp.priceList.lastPreparedOn";
export const PRICE_LIST_SCHEDULE_DEFAULTS = Object.freeze({ enabled: false, time: "08:00" });

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** `{ enabled, time }`, always valid: anything unreadable becomes the default. */
export const normalizePriceListSchedule = (raw) => {
  const source = raw && typeof raw === "object" ? raw : {};
  const time = typeof source.time === "string" && TIME_PATTERN.test(source.time.trim())
    ? source.time.trim()
    : PRICE_LIST_SCHEDULE_DEFAULTS.time;
  return { enabled: source.enabled === true, time };
};

export const readPriceListSchedule = (storage) => {
  try {
    const raw = storage?.getItem?.(PRICE_LIST_SCHEDULE_KEY);
    if (typeof raw !== "string" || !raw) return normalizePriceListSchedule(null);
    return normalizePriceListSchedule(JSON.parse(raw));
  } catch {
    return normalizePriceListSchedule(null);
  }
};

/** Returns false when the device would not store it (private window, blocked storage). */
export const writePriceListSchedule = (storage, schedule) => {
  try {
    if (typeof storage?.setItem !== "function") return false;
    storage.setItem(PRICE_LIST_SCHEDULE_KEY, JSON.stringify(normalizePriceListSchedule(schedule)));
    return true;
  } catch {
    return false;
  }
};

/** The device-local day the list was last prepared, "YYYY-MM-DD", or "" when never/unreadable. */
export const readLastPreparedOn = (storage) => {
  try {
    const raw = storage?.getItem?.(PRICE_LIST_LAST_PREPARED_KEY);
    return typeof raw === "string" && DATE_PATTERN.test(raw.trim()) ? raw.trim() : "";
  } catch {
    return "";
  }
};

export const writeLastPreparedOn = (storage, dateString) => {
  try {
    if (typeof storage?.setItem !== "function") return false;
    const value = String(dateString ?? "").trim();
    if (!DATE_PATTERN.test(value)) return false;
    storage.setItem(PRICE_LIST_LAST_PREPARED_KEY, value);
    return true;
  } catch {
    return false;
  }
};

const pad = (number) => String(number).padStart(2, "0");

/** The device's own calendar day, "YYYY-MM-DD" — the clock the owner set the time against. */
export const localDateString = (now = new Date()) => {
  const date = now instanceof Date ? now : new Date(now);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

/**
 * Is it time to prepare today's list?
 *
 * Due from the set minute onwards, not only *at* it: a laptop that was asleep at 08:00 and opened at
 * 10:30 still prepares that morning's list. The backend backup scheduler compares minutes for
 * equality, and so silently skips a whole day whenever its one minute is missed; this does not.
 * Once prepared, `lastPreparedOn` holds today and nothing repeats until tomorrow.
 */
export const shouldPreparePriceList = ({ now = new Date(), schedule, lastPreparedOn } = {}) => {
  const date = now instanceof Date ? now : new Date(now);
  const today = localDateString(date);
  const { enabled, time } = normalizePriceListSchedule(schedule);
  if (!enabled) return { due: false, today, reason: "The morning price list is switched off." };
  const [hours, minutes] = time.split(":").map(Number);
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();
  if (minuteOfDay < hours * 60 + minutes) {
    return { due: false, today, reason: `Not yet ${time}.` };
  }
  if (String(lastPreparedOn ?? "").trim() === today) {
    return { due: false, today, reason: "Today's price list has already been prepared." };
  }
  return { due: true, today, reason: `It is past ${time} and today's list has not been prepared.` };
};

// ---- Sharing --------------------------------------------------------------------------------

/** The text sent with the picture: shop, day, then one line per item. */
export const priceListCaption = ({ header = {}, rows = [] } = {}) => {
  const list = isList(rows) ? rows : [];
  const lines = [
    text(header?.title) || "FroozERP",
    `Today's prices – ${text(header?.dateLabel) || priceListDateLabel(new Date())}`,
    "",
  ];
  for (const row of list.slice(0, PRICE_LIST_CAPTION_MAX_ROWS)) {
    lines.push(`${row?.name ?? ""} – ${row?.rateLabel ?? ""}`);
  }
  if (list.length > PRICE_LIST_CAPTION_MAX_ROWS) {
    lines.push(`+${list.length - PRICE_LIST_CAPTION_MAX_ROWS} more`);
  }
  return lines.join("\n").trim();
};

/** `Frooz_PriceList_2026-10-03.png`, dated by the device's own day. */
export const priceListFileName = (now = new Date()) => `Frooz_PriceList_${localDateString(now)}.png`;

/**
 * How the Share button hands the picture over.
 *
 * The browser's share window (`navigator.share`) is only used in a real browser that says it can
 * share a picture: on a phone that is the share sheet with WhatsApp in it. Inside the FroozERP app
 * (the Windows counter app, and the phone app) it is never used. Its webview either has no share
 * window at all or opens one that never answers, and on 3 Oct 2026 the owner's first press of the
 * button on the counter app did nothing he could see. There the picture is copied and saved instead,
 * which is a thing the app can finish and say it finished.
 */
export const PRICE_LIST_SHARE_ROUTE = Object.freeze({
  NATIVE_SHARE: "native-share",
  COPY_AND_SAVE: "copy-and-save",
});

export const choosePriceListShareRoute = ({ appShell = false, canShareFiles = false } = {}) => (
  appShell !== true && canShareFiles === true ? PRICE_LIST_SHARE_ROUTE.NATIVE_SHARE : PRICE_LIST_SHARE_ROUTE.COPY_AND_SAVE
);

/** A browser share window gets this long to answer before the picture is copied and saved instead. */
export const PRICE_LIST_SHARE_TIMEOUT_MS = 20000;

/** What the owner reads after the picture was copied and/or saved. Says only what actually happened. */
export const priceListCopySaveOutcome = ({ copied = false, saved = false, fileName = "" } = {}) => {
  if (copied && saved) {
    return { tone: "ok", text: `Picture copied. Open WhatsApp, open your group, press Ctrl+V, then Send. A copy is also saved in Downloads as ${fileName}.` };
  }
  if (copied) {
    return { tone: "ok", text: "Picture copied. Open WhatsApp, open your group, press Ctrl+V, then Send." };
  }
  if (saved) {
    return { tone: "ok", text: `Picture saved in Downloads as ${fileName}. Open your WhatsApp group, attach it from Downloads, then Send.` };
  }
  return { tone: "error", text: "The picture could neither be copied nor saved on this computer. Copy as text still works." };
};
