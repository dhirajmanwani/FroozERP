"use strict";

/**
 * FROST's answer used to be twelve `parts.push(...)` lines concatenated in whatever order the
 * facts happened to arrive. Asked "what needs my attention today?" it replied, verbatim:
 *
 *   Period: Today. POS Billing: sales 0, estimated gross profit 0. Accounts: outstanding 23794
 *   across 5 records. Purchases: outstanding 1580.64 across 1 records. Inventory Lots: 3 matching
 *   records. Inventory Lots: 30 matching records. Top details: kalu a17, lilaram, Kaiu Ghantaghar.
 *   Source modules: POS Billing, Accounts, Purchases, Inventory Lots, Sales History.
 *
 * Three things are wrong with that beyond its tone. "Inventory Lots" appears twice with different
 * numbers because two different facts -- low stock and old lots -- carry the same `sourceModule`
 * label, so the sentence names neither of them. `getGrossProfitSummary` is literally
 * `getDailySalesSummary`, so the sales figures are emitted twice for a finance question. And the
 * figures are raw: `23794` is not how anyone reads a rupee amount.
 *
 * So the answer is built here instead, on three rules:
 *
 *  1. Facts are named by their `type`, never by `sourceModule`. Types are unique; labels are not.
 *  2. The fact the question was actually about leads, and the rest follow in a fixed order. The
 *     owner should get his answer in the first sentence.
 *  3. A fact that could not be read says so. A fact that is genuinely zero is dropped only when it
 *     is not the one being asked about -- an unread total and a real zero must never look alike,
 *     which is why `unavailable` is checked before any zero is skipped.
 *
 * The source modules are not repeated in the text: the panel already prints them under every
 * answer, and repeating them was most of what made the old wording read like a machine.
 */

/**
 * Bumped whenever the wording below changes shape.
 *
 * Answers are cached for thirty minutes under a key built from the question, the facts and the
 * provider -- but not from the code that wrote the sentence. So the first rebuild of this file
 * shipped, and the owner asked the same three questions he had asked before and got the old machine
 * wording back, verbatim, while a question he had never asked came back in the new wording. The
 * improvement looked like it had not been deployed. Including this in the cache key makes an old
 * entry unreachable instead of stale.
 */
const ANSWER_FORMAT_VERSION = 5;

/**
 * What FROST says to a question it did not recognise.
 *
 * It says it plainly, because the alternative -- and what it did until now -- is a fluent briefing
 * about something else, which the owner has no way to tell apart from an answer.
 */
const UNCLEAR_REPLY =
  "I did not catch that. Ask me about sales, dues, stock, purchases, rates or waste, in Hindi or English.";

/**
 * What FROST says to a greeting. Short, and carrying no figures at all -- the point is that a
 * greeting does not fetch the books.
 */
const SMALL_TALK_REPLIES = Object.freeze({
  greeting: "Hello. Ask me anything about the shop \u2014 today's sales, who owes money, what stock is low.",
  wellbeing: "All good here. The books are open, so ask away \u2014 sales, dues, stock or waste.",
  thanks: "Anytime.",
  identity: "I am FROST. I read this shop's own books \u2014 sales, dues, purchases, stock and waste \u2014 and answer only from them, so I never make a figure up. Ask in Hindi or English.",
});

const round2 = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round((number + Number.EPSILON) * 100) / 100;
};

/**
 * Indian digit grouping: the last three digits, then pairs. 2345678 reads 23,45,678, not
 * 2,345,678. Written out rather than taken from `Intl` because the backend must produce the same
 * string on every machine regardless of which ICU data node was built with.
 */
const formatIndianNumber = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  const negative = number < 0;
  const fixed = Math.abs(round2(number)).toFixed(2);
  const [whole, decimals] = fixed.split(".");
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}` : last3;
  const tail = decimals === "00" ? "" : `.${decimals}`;
  return `${negative ? "-" : ""}${grouped}${tail}`;
};

// The rest of the app writes rupees with the symbol, and an answer that reads differently from
// the screen it sits on invites a second look at a figure that is fine.
const money = (value) => `₹${formatIndianNumber(value)}`;

// Quantities carry 3 decimals, and trailing zeros on a weight read as noise at a fruit counter.
const quantity = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return String(Number(number.toFixed(3)));
};

const nameOf = (row = {}) =>
  row.customer_name || row.supplier_name || row.product_name || row.lot_name || row.category
  || row.invoice_no || row.title || (row.id !== undefined ? `#${row.id}` : "");

const namesOf = (fact, limit = 3) =>
  (Array.isArray(fact.rows) ? fact.rows : [])
    .slice(0, limit)
    .map(nameOf)
    .filter(Boolean);

const listOf = (names) => names.join(", ");

const plural = (count, singular, pluralWord) => `${count} ${Number(count) === 1 ? singular : pluralWord}`;

// What each fact is called when nothing more specific is written for it below. Keyed by `type`
// because two facts can and do share a `sourceModule`.
const FACT_LABELS = Object.freeze({
  overdue_customer_invoices: "overdue customer invoices",
  pending_purchase_bills: "purchase bills still pending",
  inactive_customers: "customers with no purchase in 30+ days",
  high_value_edited_bills: "high-value bills that were edited",
  stock_runout_forecast: "products forecast to run out",
  purchase_recommendations: "purchase suggestions",
  sale_rate_review: "rates worth reviewing",
  product_margin_summary: "products with margin data",
  supplier_margin_summary: "suppliers with margin data",
  profit_advisor: "products in the profit advisor",
  margin_risks: "products on thin margin or wasting",
});

const isUnavailable = (fact) => Boolean(fact?.summary?.unavailable || fact?.summary?.error);

// The one sentence each fact gets. Returning "" means "nothing worth saying"; the caller keeps it
// anyway when the fact is the one being asked about, so a genuine zero is still stated.
const SENTENCES = Object.freeze({
  daily_sales_summary: (fact) => {
    const { billCount = 0, totalSales = 0, estimatedGrossProfit = 0, discountAmount = 0 } = fact.summary || {};
    if (!Number(billCount) && !Number(totalSales)) return "";
    const parts = [`${money(totalSales)} sold over ${plural(Number(billCount), "bill", "bills")}`];
    parts.push(`estimated gross profit ${money(estimatedGrossProfit)}`);
    if (Number(discountAmount) > 0) parts.push(`discount given ${money(discountAmount)}`);
    return `${parts.join(", ")}.`;
  },
  customer_outstanding: (fact) => {
    const { totalOutstanding = 0, count = 0 } = fact.summary || {};
    if (!Number(count)) return "";
    const names = namesOf(fact);
    const tail = names.length ? ` Largest: ${listOf(names)}.` : "";
    return `Customers owe you ${money(totalOutstanding)} across ${plural(Number(count), "account", "accounts")}.${tail}`;
  },
  supplier_outstanding: (fact) => {
    const { totalOutstanding = 0, count = 0 } = fact.summary || {};
    if (!Number(count)) return "";
    const names = namesOf(fact, 2);
    const tail = names.length ? ` Largest: ${listOf(names)}.` : "";
    return `You owe suppliers ${money(totalOutstanding)} across ${plural(Number(count), "account", "accounts")}.${tail}`;
  },
  pending_purchase_bills: (fact) => {
    const count = Number(fact.summary?.count || 0);
    if (!count) return "";
    return `${plural(count, "purchase bill is", "purchase bills are")} still pending.`;
  },
  low_stock_products: (fact) => {
    const count = Number(fact.summary?.count || 0);
    if (!count) return "";
    const names = namesOf(fact);
    const tail = names.length ? ` (${listOf(names)})` : "";
    return `${plural(count, "product is", "products are")} at or below minimum stock${tail}.`;
  },
  inventory_nearing_expiry: (fact) => {
    const count = Number(fact.summary?.count || 0);
    if (!count) return "";
    // The ageing limit is configurable, so it is read back out of the label the query stamped on
    // the fact rather than hard-coded here and quietly disagreeing with Settings.
    const days = /(\d+)\s*days/.exec(String(fact.periodLabel || ""))?.[1];
    const names = namesOf(fact);
    const tail = names.length ? ` (${listOf(names)})` : "";
    return days
      ? `${plural(count, "lot is", "lots are")} older than ${days} days and still unsold${tail}.`
      : `${plural(count, "old lot is", "old lots are")} still unsold${tail}.`;
  },
  expense_summary: (fact) => {
    const total = Number(fact.summary?.totalExpenses || 0);
    if (!total) return "";
    const names = namesOf(fact, 2);
    const tail = names.length ? ` Mostly ${listOf(names)}.` : "";
    return `Expenses ${money(total)}.${tail}`;
  },
  waste_summary: (fact) => {
    const total = Number(fact.summary?.totalWasteCost || 0);
    if (!total) return "";
    const names = namesOf(fact, 2);
    const tail = names.length ? ` Mostly ${listOf(names)}.` : "";
    return `Waste cost ${money(total)}.${tail}`;
  },
  collection_summary: (fact) => {
    const { cash = 0, upi = 0, card = 0 } = fact.summary || {};
    if (!Number(cash) && !Number(upi) && !Number(card)) return "";
    return `Collected ${money(cash)} cash, ${money(upi)} UPI, ${money(card)} card or bank.`;
  },
  cash_drawer_summary: (fact) => {
    const { cashIn = 0, cashOut = 0, expectedDrawerCash = 0 } = fact.summary || {};
    return `Cash in ${money(cashIn)}, cash out ${money(cashOut)}, so the drawer should hold ${money(expectedDrawerCash)}.`;
  },
  product_sales_ranking: (fact) => {
    const top = (fact.summary?.highestSelling || []).filter(Boolean).slice(0, 3);
    if (!top.length) return "";
    const described = top.map((row) => `${nameOf(row)} (${quantity(row.quantity_sold)} ${row.unit || "units"}, ${money(row.sale_amount)})`);
    return `Selling most: ${listOf(described)}.`;
  },
  sale_rate_review: (fact) => {
    const rows = (Array.isArray(fact.rows) ? fact.rows : []).filter(Boolean);
    if (!rows.length) return "";
    // `action_text` is already a whole instruction -- "Reduce ALPHONSO 12/kg" -- written by the
    // pricing layer. Reducing it to a count was throwing away the only part the owner can act on.
    const described = rows.slice(0, 3).map((row) => String(row.action_text || nameOf(row))).filter(Boolean);
    const rest = rows.length > described.length ? ` ${rows.length - described.length} more.` : "";
    return `${plural(rows.length, "rate looks", "rates look")} worth changing: ${listOf(described)}.${rest}`;
  },
  purchase_recommendations: (fact) => {
    const rows = (Array.isArray(fact.rows) ? fact.rows : []).filter(Boolean);
    if (!rows.length) return "";
    const described = rows.slice(0, 3).map((row) =>
      `${quantity(row.recommended_quantity)} ${nameOf(row)}${row.suggested_supplier ? ` from ${row.suggested_supplier}` : ""}`);
    const cost = Number(fact.summary?.estimatedCost || 0);
    const tail = cost > 0 ? ` About ${money(cost)} in all.` : "";
    return `Worth buying: ${listOf(described)}.${tail}`;
  },
  profit_advisor: (fact) => {
    const rows = (Array.isArray(fact.rows) ? fact.rows : []).filter(Boolean);
    const thin = rows
      .filter((row) => Number.isFinite(Number(row.estimated_gross_margin)))
      .sort((a, b) => Number(a.estimated_gross_margin) - Number(b.estimated_gross_margin))
      .slice(0, 3);
    if (!thin.length) return "";
    const described = thin.map((row) => `${nameOf(row)} at ${Number(row.estimated_gross_margin).toFixed(1)}%`);
    return `Thinnest margins: ${listOf(described)}.`;
  },
  margin_risks: (fact) => {
    const rows = (Array.isArray(fact.rows) ? fact.rows : []).filter(Boolean);
    if (!rows.length) return "";
    const described = rows.slice(0, 3).map((row) => nameOf(row)).filter(Boolean);
    return `${plural(rows.length, "product is", "products are")} on thin margin or wasting: ${listOf(described)}.`;
  },
});

const genericSentence = (fact) => {
  const count = Number(fact.summary?.count);
  if (!Number.isFinite(count) || count <= 0) return "";
  const label = FACT_LABELS[fact.type];
  if (!label) return "";
  const names = namesOf(fact, 2);
  const tail = names.length ? ` (${listOf(names)})` : "";
  return `${count} ${label}${tail}.`;
};

// The fact each intent is actually about, leading. Anything not named here keeps the order the
// query layer produced, after the named ones.
const LEAD_ORDER = Object.freeze({
  SALES_FINANCE: ["daily_sales_summary", "product_sales_ranking", "collection_summary", "expense_summary"],
  PROFIT_RANKING: ["product_sales_ranking", "product_margin_summary"],
  PAYMENTS: ["customer_outstanding", "supplier_outstanding", "pending_purchase_bills"],
  CASH_DRAWER: ["cash_drawer_summary", "collection_summary"],
  INVENTORY: ["low_stock_products", "inventory_nearing_expiry", "waste_summary", "product_sales_ranking"],
  INVENTORY_EXPIRY: ["inventory_nearing_expiry", "low_stock_products"],
  LOSS_REVIEW: ["expense_summary", "waste_summary", "margin_risks"],
  PURCHASE_PLANNING: ["purchase_recommendations", "low_stock_products", "supplier_outstanding"],
  SALE_RATE_REVIEW: ["sale_rate_review", "profit_advisor"],
  SUPPLIER_MARGIN: ["supplier_margin_summary", "supplier_outstanding"],
  CUSTOMER_ACTIVITY: ["inactive_customers", "customer_outstanding"],
  BUSINESS_BRIEFING: ["daily_sales_summary", "customer_outstanding", "supplier_outstanding", "low_stock_products", "inventory_nearing_expiry"],
});

/**
 * Drops facts whose `type` has already been seen. `getGrossProfitSummary` is an alias for
 * `getDailySalesSummary`, so a finance question arrives holding the same fact twice; saying it
 * twice is how the old answer got its repeated figures.
 */
const dedupeByType = (facts) => {
  const seen = new Set();
  return (Array.isArray(facts) ? facts : []).filter((fact) => {
    if (!fact || typeof fact !== "object" || !fact.type) return false;
    if (seen.has(fact.type)) return false;
    seen.add(fact.type);
    return true;
  });
};

const orderForIntent = (facts, classification) => {
  const order = LEAD_ORDER[classification] || LEAD_ORDER.BUSINESS_BRIEFING;
  const rank = (fact) => {
    const index = order.indexOf(fact.type);
    return index === -1 ? order.length : index;
  };
  return facts
    .map((fact, index) => ({ fact, index }))
    .sort((a, b) => rank(a.fact) - rank(b.fact) || a.index - b.index)
    .map(({ fact }) => fact);
};

const sentenceFor = (fact) => {
  if (!fact) return "";
  if (isUnavailable(fact)) {
    const label = FACT_LABELS[fact.type] || String(fact.sourceModule || fact.type).toLowerCase();
    return `${label} could not be read just now, so this answer is incomplete.`;
  }
  const writer = SENTENCES[fact.type];
  const sentence = writer ? writer(fact) : "";
  return sentence || genericSentence(fact);
};

// A zero on the fact the question was about is the answer, so it is stated rather than skipped.
// This is the same rule as "errors must never render as zero", read the other way round: a real
// zero has to be visible as a real zero, not as a fact that quietly did not appear.
const ZERO_SENTENCES = Object.freeze({
  daily_sales_summary: "no sales yet.",
  customer_outstanding: "no customer dues.",
  supplier_outstanding: "nothing owed to suppliers.",
  pending_purchase_bills: "no purchase bill pending.",
  low_stock_products: "no product is below minimum stock.",
  inventory_nearing_expiry: "no lot is past the ageing limit.",
  expense_summary: "no expense recorded.",
  waste_summary: "no waste recorded.",
  collection_summary: "nothing collected.",
  product_sales_ranking: "nothing sold to rank.",
});

const zeroSentenceFor = (fact) => {
  if (!fact) return "";
  if (ZERO_SENTENCES[fact.type]) return ZERO_SENTENCES[fact.type];
  const label = FACT_LABELS[fact.type];
  return label ? `no ${label}.` : "";
};

const NOTHING_FOUND = Object.freeze({
  SALES_FINANCE: "no sales recorded.",
  PROFIT_RANKING: "no sales to rank.",
  PAYMENTS: "nothing outstanding either way.",
  CASH_DRAWER: "no cash movement recorded.",
  INVENTORY: "stock is above minimum everywhere and no lot is overdue.",
  INVENTORY_EXPIRY: "no lot is past the ageing limit.",
  LOSS_REVIEW: "no expense or waste recorded.",
  PURCHASE_PLANNING: "nothing is due for reorder.",
  SALE_RATE_REVIEW: "no rate needs a change.",
  SUPPLIER_MARGIN: "no supplier margin data.",
  CUSTOMER_ACTIVITY: "every customer has bought recently.",
  BUSINESS_BRIEFING: "nothing needs attention.",
});

/**
 * The answer, as sentences. The period always leads, because Report Center has already taught this
 * codebase what an invisible date filter costs.
 */
const buildDeterministicAnswer = (classification, facts, range = {}, smallTalkKind = "", reminderTitle = "") => {
  // No period, no figures, no source list. A greeting is answered as a greeting.
  if (classification === "SMALL_TALK") {
    return SMALL_TALK_REPLIES[smallTalkKind] || SMALL_TALK_REPLIES.greeting;
  }
  if (classification === "UNCLEAR") return UNCLEAR_REPLY;
  if (classification === "REMINDER_CREATE") {
    // Deliberately a statement of what FROST can do, not a claim that it is done. This route reads;
    // the reminder is written by the panel through the permission-gated reminders route, and it may
    // be refused. Saying "saved" here would be a lie on every refusal, and the owner would find out
    // weeks later by not being reminded.
    const title = String(reminderTitle || "").trim();
    return title
      ? `I can remember this for you: "${title}".`
      : "Tell me what to remind you about, and I will keep it.";
  }
  const period = String(range.label || "Today");
  const ordered = orderForIntent(dedupeByType(facts), classification);
  const sentences = ordered.map(sentenceFor).filter(Boolean);
  // The leading fact is the one the question was about, so it speaks even when its figure is zero.
  const leadZero = sentenceFor(ordered[0]) ? "" : zeroSentenceFor(ordered[0]);
  const all = leadZero ? [leadZero, ...sentences] : sentences;
  if (!all.length) {
    return `${period}: ${NOTHING_FOUND[classification] || NOTHING_FOUND.BUSINESS_BRIEFING}`;
  }
  return `${period}: ${all.join(" ")}`;
};

module.exports = {
  ANSWER_FORMAT_VERSION,
  FACT_LABELS,
  SMALL_TALK_REPLIES,
  UNCLEAR_REPLY,
  LEAD_ORDER,
  buildDeterministicAnswer,
  dedupeByType,
  formatIndianNumber,
  money,
  orderForIntent,
  quantity,
};
