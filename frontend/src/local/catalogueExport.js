/**
 * Builds the file the public website reads.
 *
 * The storefront in `website/` is deliberately static: it has no backend, nothing of
 * this system is exposed to the internet, and that is the whole reason it can go
 * live while the exposure gates in `docs/auth-hardening-plan.md` are still open.
 * The price of that is that its stock and rates are a *snapshot*, written by this
 * module and uploaded by a person.
 *
 * Everything that follows exists to keep that snapshot honest, because a shop front
 * that confidently sells what is no longer on the shelf costs a customer for good.
 *
 * Pure functions only. `App.jsx` turns the result into a file.
 */

import { canonicalInventoryId } from "./stockInventory.js";

/** Bumped when the shape changes in a way the site has to know about. */
export const CATALOGUE_FORMAT_VERSION = 1;

/**
 * How long the site is allowed to believe a stock figure.
 *
 * Produce moves during a trading day. Past this, the site stops asserting quantities
 * and falls back to its "we could not check" state - which it already knows how to
 * render - rather than quoting a number from yesterday morning. Rates are different:
 * they are set once a day and printed on a board, so they stay shown, with their date.
 */
export const STOCK_TRUSTED_FOR_HOURS = 12;

/**
 * Cosmetic only. The card shows the produce's own colour behind its initial until
 * there are real photographs. Matching is on whole words in the product name, and an
 * unmatched product gets the neutral green rather than a wrong colour - a mango that
 * looks like an apple is worse than one that looks like nothing.
 */
const PRODUCE_TINTS = Object.freeze([
  [["mango"], "#c8862f"],
  [["apple"], "#a83a34"],
  [["orange", "kinnow", "santra"], "#c2691f"],
  [["grape", "grapes"], "#7c9a3c"],
  [["pomegranate", "anar"], "#96233a"],
  [["banana", "kela"], "#c9a52c"],
  [["papaya"], "#c26a2c"],
  [["watermelon", "tarbuj", "melon"], "#2f7a44"],
  [["guava", "amrud"], "#6f8f4a"],
  [["lime", "lemon", "mosambi", "nimbu"], "#8a9c2e"],
  [["pineapple"], "#c39a24"],
  [["strawberry", "cherry"], "#a52a3d"],
  [["chikoo", "sapota", "date"], "#8a6337"],
  [["coconut", "nariyal"], "#7a6a4a"],
]);

const NEUTRAL_TINT = "#2f5a41";

/** The tint for a product name, or the neutral green when nothing matches. */
export function tintFor(name) {
  const words = String(name ?? "").toLowerCase().split(/[^a-z]+/).filter(Boolean);
  for (const [keys, tint] of PRODUCE_TINTS) {
    if (keys.some((key) => words.includes(key))) return tint;
  }
  return NEUTRAL_TINT;
}

/**
 * A number we are willing to publish, or `null`.
 *
 * Explicit and finite, never a `??` chain: several of these fields are legitimately
 * zero, and `Number("")` is `0`, so a blank column would otherwise be published to
 * customers as "sold out".
 */
function readNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstNumber(...candidates) {
  for (const candidate of candidates) {
    const parsed = readNumber(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function readTimestamp(value) {
  if (!value) return null;
  const parsed = Date.parse(typeof value === "string" ? value.trim() : value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A date in the shop's own day, as `YYYY-MM-DD`. IST has no daylight saving. */
export function shopDateString(epochMs, offsetMinutes = 330) {
  const shifted = new Date(epochMs + offsetMinutes * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

function isSellable(product) {
  const status = String(product?.status ?? product?.product_status ?? "ACTIVE").toUpperCase();
  return status !== "INACTIVE" && status !== "DISCONTINUED" && status !== "DELETED";
}

/**
 * The price the shop is selling at today.
 *
 * A temporary rate beats the standing one when it is set - that is what "temporary"
 * means in this system. A product with no readable rate is left out of the file
 * entirely rather than published at zero; the caller is told how many, so this is
 * visible rather than silent.
 */
function rateFor(product) {
  const rate = firstNumber(
    product?.temporary_sale_rate,
    product?.sale_rate,
    product?.selling_rate,
    product?.rate,
  );
  return rate !== null && rate > 0 ? rate : null;
}

function quantityOf(lot) {
  return firstNumber(lot?.balance_qty, lot?.remaining_qty, lot?.available_qty);
}

/**
 * Total stock for a product, and whether we actually know it.
 *
 * `known: false` is not the same as `kg: 0`, and the difference is the point. A
 * product whose lots carry unreadable quantities has unknown stock; a product with
 * no lots at all genuinely has none. The site renders those two differently.
 */
function stockFor(lots) {
  if (lots.length === 0) return { kg: 0, known: true };
  let total = 0;
  let readable = 0;
  for (const lot of lots) {
    const quantity = quantityOf(lot);
    if (quantity === null) continue;
    readable += 1;
    total += quantity;
  }
  if (readable === 0) return { kg: null, known: false };
  return { kg: Number(Math.max(0, total).toFixed(3)), known: true };
}

/** When the newest lot of this product came in. */
function arrivedAtFor(lots) {
  let newest = null;
  for (const lot of lots) {
    const at = readTimestamp(lot?.purchase_date ?? lot?.arrival_date ?? lot?.created_at);
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest === null ? null : new Date(newest).toISOString();
}

/**
 * Build the catalogue the website reads.
 *
 * Returns `{ catalogue, summary }`. The summary is what the person doing the export
 * is shown, so that "12 products, 2 left out because they have no rate today" is
 * something they see rather than something they find out from a customer.
 */
export function buildCatalogue({
  products = [],
  lots = [],
  shop = {},
  nowMs = Date.now(),
  shopUtcOffsetMinutes = 330,
} = {}) {
  const lotsByProduct = new Map();
  for (const lot of Array.isArray(lots) ? lots : []) {
    const key = canonicalInventoryId(lot?.product_id);
    if (!key) continue;
    const current = lotsByProduct.get(key) || [];
    current.push(lot);
    lotsByProduct.set(key, current);
  }

  const rows = [];
  const skippedNoRate = [];
  const skippedNoId = [];

  for (const product of Array.isArray(products) ? products : []) {
    if (!isSellable(product)) continue;

    const id = canonicalInventoryId(product?.id ?? product?.product_id);
    if (!id) {
      skippedNoId.push(String(product?.product_name ?? product?.name ?? "unnamed"));
      continue;
    }

    const name = String(product?.product_name ?? product?.name ?? "").trim();
    if (!name) {
      skippedNoId.push(id);
      continue;
    }

    const ratePerKg = rateFor(product);
    if (ratePerKg === null) {
      skippedNoRate.push(name);
      continue;
    }

    const productLots = lotsByProduct.get(id) || [];
    const stock = stockFor(productLots);
    const arrivedAt = arrivedAtFor(productLots);
    const variety = String(product?.product_category ?? product?.category_name ?? "").trim();

    const row = {
      id,
      name,
      initial: name.slice(0, 1).toUpperCase(),
      tint: tintFor(name),
      ratePerKg,
    };
    if (variety) row.variety = variety;
    // Only written when known. Its absence is what makes the site say it could not
    // check, instead of showing a zero nobody measured.
    if (stock.known) row.availableKg = stock.kg;
    if (arrivedAt) row.arrivedAt = arrivedAt;
    rows.push(row);
  }

  rows.sort((left, right) => left.name.localeCompare(right.name, "en-IN"));

  const catalogue = {
    formatVersion: CATALOGUE_FORMAT_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    // The site refuses to quote a stock figure older than this, and says so.
    stockTrustedForHours: STOCK_TRUSTED_FOR_HOURS,
    ratesSetOn: shopDateString(nowMs, shopUtcOffsetMinutes),
    shop: {
      name: String(shop?.name ?? "Frooz"),
      branch: String(shop?.branch ?? ""),
      phone: String(shop?.phone ?? ""),
      address: String(shop?.address ?? ""),
      openText: String(shop?.openText ?? ""),
    },
    products: rows,
  };

  return {
    catalogue,
    summary: {
      published: rows.length,
      withoutStock: rows.filter((row) => !Object.hasOwn(row, "availableKg")).length,
      skippedNoRate,
      skippedNoId,
      // Without a number, the site's order button opens WhatsApp with nobody to
      // send to. Silent, and only discovered when a customer gives up.
      missingShopPhone: catalogue.shop.phone.trim() === "",
    },
  };
}

/** `frooz-catalogue-2026-08-22.json` - dated, so an old upload is obvious. */
export function catalogueFilename(nowMs = Date.now(), shopUtcOffsetMinutes = 330) {
  return `frooz-catalogue-${shopDateString(nowMs, shopUtcOffsetMinutes)}.json`;
}

/** One plain sentence for the person doing the export. No jargon. */
export function describeExport(summary) {
  if (!summary || summary.published === 0) {
    return "Nothing could be published. Check that today's sale rates are set.";
  }
  const parts = [`${summary.published} ${summary.published === 1 ? "item" : "items"} ready for the website`];
  if (summary.missingShopPhone) {
    parts.push(
      "This branch has no phone number saved, so the website's order button will not know who to message. Add one in Settings first",
    );
  }
  if (summary.skippedNoRate.length > 0) {
    const names = summary.skippedNoRate.slice(0, 3).join(", ");
    const more = summary.skippedNoRate.length > 3 ? ` and ${summary.skippedNoRate.length - 3} more` : "";
    parts.push(`${summary.skippedNoRate.length} left out because today's rate is not set: ${names}${more}`);
  }
  if (summary.withoutStock > 0) {
    parts.push(`${summary.withoutStock} will show as "stock not confirmed"`);
  }
  return `${parts.join(". ")}.`;
}
