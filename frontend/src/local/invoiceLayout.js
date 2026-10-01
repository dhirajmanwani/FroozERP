/**
 * The customer bill, as one presentation model.
 *
 * Every place a sale bill is drawn — the on-screen invoice, the thermal and A4 prints, the PDF
 * (a capture of that same element) and the WhatsApp text — reads this model and nothing else, so
 * they cannot disagree about a single figure. It is derived from the sale as stored; nothing here
 * changes how a bill is priced, discounted or saved.
 *
 * Sources it reads, and why each is safe to read:
 *
 *   - Server sale (`GET /sales/:id`): `sales.*` plus `sale_items` rows carrying `quantity`,
 *     `selling_rate`, `amount` (qty x rate), `discount_amount`, `net_amount`, `lot_discount_type`,
 *     `lot_discount_value`, and one row per lot allocation (`sale_item_id` repeats).
 *   - Local sale (`localSnapshotToInvoice` over the SQLite snapshot): the same header names, and
 *     items whose `amount` and `net_amount` are the SAME column (the line net). That is why the
 *     line gross is taken as net + discount and never from `amount`.
 *
 * The reconcile rule
 * ------------------
 * The printed totals must add up to the stored grand total, to the paisa:
 *
 *     Items total - Total discount + Tax + Other charges +/- Round off = Grand total
 *
 * The stored figures are checked first. When they agree (allowing only the half-paisa float noise a
 * locally computed gross carries), Items total is printed as whatever makes the printed rows foot
 * exactly — which is the stored gross rounded to the paisa. When they do not agree (an old record,
 * a hand-edited row), the breakdown is left off and only the stored grand total is printed. A sum
 * that does not add up is never printed, and a figure is never invented to make one add up.
 *
 * Missing is not zero: a missing figure renders as "—" or not at all, never as ₹0.00.
 */

import { EMPTY_LABEL, labelFor } from "./displayLabels.js";

export const INVOICE_FALLBACK_SHOP_NAME = "FroozERP Retail";
export const INVOICE_FALLBACK_FOOTER = "Thank you for shopping with FEEL THE FREAKIN' FROOZ.";
export const INVOICE_FALLBACK_COMPANY = "SRT Company";
export const INVOICE_WALK_IN_CUSTOMER = "Walk-in Customer";
export const INVOICE_COLUMNS = Object.freeze(["Product", "Qty", "Unit", "Rate", "Amount"]);
// WhatsApp refuses a document caption over 1024 characters; the send fails rather than trims.
export const INVOICE_TEXT_MAX_LENGTH = 1000;

const MINUS = "−";
// Half a paisa, plus float noise. A locally billed gross is qty x rate unrounded, so its stored
// figure can sit up to half a paisa from the paisa the total was rounded to. Anything wider is a
// real disagreement.
const RECONCILE_TOLERANCE = 0.005 + 1e-9;

const moneyFormat = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A finite number, or null. "" and null are missing, not zero. */
export const readAmount = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const firstAmount = (...values) => {
  for (const value of values) {
    const number = readAmount(value);
    if (number !== null) return number;
  }
  return null;
};

const toPaise = (value) => (value === null ? null : Math.round(value * 100 + (value >= 0 ? 1e-7 : -1e-7)));
const fromPaise = (paise) => paise / 100;
const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/** 1.5, 2, 0.75, 1.235 — three decimals at most, trailing zeros trimmed. Missing is "—". */
export const formatBillQuantity = (value) => {
  const number = readAmount(value);
  if (number === null) return EMPTY_LABEL;
  // Nudged before rounding so a value like 1.2345, stored as 1.23449999..., rounds half up.
  const rounded = Math.round((number + Math.sign(number) * 1e-9) * 1000) / 1000;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

/** 1,234.50 — grouped, two decimals, no symbol (for columns). Missing is "—". */
export const formatBillNumber = (value) => {
  const number = readAmount(value);
  if (number === null) return EMPTY_LABEL;
  return moneyFormat.format(Math.abs(number) < 0.005 ? 0 : number);
};

/** ₹1,234.50. A negative reads −₹12.00. Missing is "—". */
export const formatBillMoney = (value) => {
  const number = readAmount(value);
  if (number === null) return EMPTY_LABEL;
  const magnitude = moneyFormat.format(Math.abs(number));
  return number <= -0.005 ? `${MINUS}₹${magnitude}` : `₹${magnitude}`;
};

const formatRatePercent = (value) => String(Number(Number(value).toFixed(3)));

// ---------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------

const lineDiscountFrom = (item, quantity, rate, net) => {
  // Prefer what was stored. Server rows carry `discount_amount`; local rows carry `discount` and
  // the snapshot mirrors it into `discount_amount`.
  const stored = firstAmount(item.discount_amount, item.discount);
  if (stored !== null) return { amount: stored, source: "stored" };
  if (quantity !== null && rate !== null && net !== null) {
    const derived = Math.round(quantity * rate * 100) / 100 - net;
    if (derived > 0.005) return { amount: derived, source: "gross-net" };
    return { amount: 0, source: "gross-net" };
  }
  const type = text(item.lot_discount_type).toUpperCase();
  const value = readAmount(item.lot_discount_value);
  if (quantity !== null && rate !== null && value !== null && value > 0) {
    // The till's own arithmetic (`applyLotDiscount`): a per-unit discount, rounded, times quantity.
    const round2 = (number) => Math.round(number * 100) / 100;
    if (type === "PERCENTAGE") return { amount: round2(round2(rate * value / 100) * quantity), source: "type" };
    if (type === "FIXED_AMOUNT") return { amount: round2(Math.min(value, rate) * quantity), source: "type" };
  }
  return { amount: null, source: "none" };
};

const discountLabelFor = (item, quantity, rate, amount) => {
  const type = text(item.lot_discount_type).toUpperCase();
  const value = readAmount(item.lot_discount_value);
  if (type === "PERCENTAGE" && value !== null && value > 0 && value <= 100 && quantity !== null && rate !== null) {
    // Only claim "10%" when 10% is what was actually taken. A discount typed over by hand keeps
    // the lot's type on the row, and a percentage it no longer matches would be a false label.
    // The till rounds the per-unit discount, so allow half a paisa per unit.
    const expected = rate * quantity * value / 100;
    if (Math.abs(expected - amount) <= 0.005 * Math.max(quantity, 1) + 0.01) {
      return `Discount ${formatRatePercent(value)}%`;
    }
  }
  return "Discount";
};

const mergeKeyFor = (item) => text(item.sale_item_id);

/**
 * Server sales return one row per lot a line was drawn from. The customer bought one line, so
 * rows sharing a `sale_item_id` are shown as one. Local rows have no `sale_item_id` and are never
 * merged.
 */
const mergeAllocationRows = (items) => {
  const merged = [];
  const byKey = new Map();
  for (const item of items) {
    const key = mergeKeyFor(item);
    if (!key || !byKey.has(key)) {
      const copy = { ...item, lot_sizes: [text(item.lot_size)].filter(Boolean) };
      merged.push(copy);
      if (key) byKey.set(key, copy);
      continue;
    }
    const target = byKey.get(key);
    const sum = (field) => {
      const left = readAmount(target[field]);
      const right = readAmount(item[field]);
      return left === null || right === null ? null : left + right;
    };
    target.quantity = sum("quantity");
    target.discount_amount = sum("discount_amount");
    target.net_amount = sum("net_amount");
    target.amount = sum("amount");
    const size = text(item.lot_size);
    if (size && !target.lot_sizes.includes(size)) target.lot_sizes.push(size);
  }
  return merged;
};

const buildLine = (item, index, { showItemDiscounts }) => {
  const quantity = readAmount(item.quantity);
  const rate = firstAmount(item.selling_rate, item.rate);
  const storedNet = readAmount(item.net_amount);
  const discountInfo = lineDiscountFrom(item, quantity, rate, storedNet);
  let net = storedNet;
  if (net === null && quantity !== null && rate !== null) {
    net = Math.round(quantity * rate * 100) / 100 - (discountInfo.amount || 0);
  }
  const discountAmount = discountInfo.amount;
  const gross = net !== null && discountAmount !== null ? net + discountAmount : null;
  const hasDiscount = discountAmount !== null && discountAmount >= 0.005;

  const notes = [...(item.lot_sizes || [text(item.lot_size)])].filter(Boolean);
  if (text(item.lot_discount_type).toUpperCase() === "SPECIAL_RATE") notes.push("Special price");

  let discount = null;
  if (hasDiscount && showItemDiscounts) {
    const label = discountLabelFor(item, quantity, rate, discountAmount);
    const amountText = formatBillMoney(-discountAmount);
    discount = { label, amount: discountAmount, amountText, text: `${label} · ${amountText}` };
  }

  return {
    key: text(item.id) || text(item.sale_item_id) || `${text(item.product_id)}-${text(item.inventory_batch_id)}-${index}`,
    product: text(item.product_name) || EMPTY_LABEL,
    note: notes.join(" · "),
    qty: quantity,
    qtyText: formatBillQuantity(quantity),
    unit: labelFor("unit", item.unit),
    rate,
    rateText: formatBillNumber(rate),
    // The Amount column shows the line before its own discount, so the column adds up to
    // Items total and the discount printed under the line is subtracted exactly once, in
    // Total discount. Printing the net here would make every item discount look taken twice.
    amount: gross !== null ? gross : net,
    amountText: formatBillNumber(gross !== null ? gross : net),
    gross,
    net,
    discountAmount: hasDiscount ? discountAmount : 0,
    discount,
  };
};

// ---------------------------------------------------------------------------------------------
// Totals
// ---------------------------------------------------------------------------------------------

/**
 * What the bill-discount row is called. It always prints the bill's whole bill discount; the slab's
 * name is beside it only when the slab gave all of it. A bill that also carries the cashier's own
 * bill discount (`manual_bill_discount`, or a stored rule name the server marked " + extra") reads
 * plain "Bill discount", because the slab's name over the larger amount would claim the slab gave
 * money it did not.
 */
export const MANUAL_BILL_DISCOUNT_RULE_SUFFIX = " + extra";
export const billDiscountLabel = (sale = {}) => {
  const ruleName = text(sale?.discount_rule_name);
  const manual = readAmount(sale?.manual_bill_discount);
  const hasManualPart = (manual !== null && manual >= 0.005) || ruleName.endsWith(MANUAL_BILL_DISCOUNT_RULE_SUFFIX);
  if (!ruleName || hasManualPart) return "Bill discount";
  return `Bill discount · ${ruleName}`;
};

const buildTotals = (sale, lines, settings) => {
  const grandTotal = firstAmount(sale.total_amount, sale.net_total);
  const storedGross = firstAmount(sale.gross_amount, sale.gross_total);
  const storedItemDiscount = firstAmount(sale.item_discount_amount, sale.item_discount_total);
  const lineDiscountSum = lines.every((line) => line.discountAmount !== null)
    ? lines.reduce((sum, line) => sum + (line.discountAmount || 0), 0)
    : null;
  const itemDiscount = storedItemDiscount !== null ? storedItemDiscount : lineDiscountSum;
  // Columns that default to 0 in both schemas. Absent means the record predates them, which is 0.
  const billDiscount = firstAmount(sale.invoice_discount_amount, sale.bill_discount_total) || 0;
  const tax = firstAmount(sale.tax_amount, sale.tax_total) || 0;
  const charges = firstAmount(sale.other_charges_amount) || 0;
  // No sale carries a round-off today. Read if a record ever does; never assumed.
  const roundOff = firstAmount(sale.round_off_amount, sale.round_off) || 0;
  const taxRate = readAmount(sale.mandi_tax_rate);
  const taxable = readAmount(sale.taxable_amount);

  const grandTotalText = formatBillMoney(grandTotal);
  const result = {
    reconciled: false,
    grandTotal,
    grandTotalText,
    itemsTotal: null,
    itemDiscount: null,
    billDiscount: null,
    totalDiscount: null,
    tax: null,
    charges: null,
    roundOff: null,
    rows: [],
    issues: [],
  };
  if (grandTotal === null) {
    result.issues.push("This bill has no stored grand total.");
    return result;
  }
  if (itemDiscount === null) {
    result.issues.push("The item discounts on this bill could not be read, so the breakdown is not shown.");
    return result;
  }

  const discountPaise = toPaise(itemDiscount) + toPaise(billDiscount);
  const othersPaise = -discountPaise + toPaise(tax) + toPaise(charges) + toPaise(roundOff);
  const grandPaise = toPaise(grandTotal);
  const itemsPaise = grandPaise - othersPaise;
  const lineGrossPaise = lines.length > 0 && lines.every((line) => line.gross !== null)
    ? lines.reduce((sum, line) => sum + toPaise(line.gross), 0)
    : null;

  let reconciled = false;
  if (storedGross !== null) {
    const residual = storedGross - itemDiscount - billDiscount + tax + charges + roundOff - grandTotal;
    reconciled = Math.abs(residual) <= RECONCILE_TOLERANCE;
  } else if (lineGrossPaise !== null) {
    reconciled = lineGrossPaise === itemsPaise;
  }
  if (!reconciled) {
    result.issues.push("The stored figures on this bill do not add up to its grand total, so only the grand total is shown.");
    return result;
  }
  if (lineGrossPaise !== null && Math.abs(lineGrossPaise - itemsPaise) > lines.length) {
    result.issues.push("The item lines on this bill do not add up to its items total.");
  }
  if (lineDiscountSum !== null && Math.abs(toPaise(lineDiscountSum) - toPaise(itemDiscount)) > lines.length) {
    result.issues.push("The discounts shown on the item lines do not add up to the bill's item discount.");
  }

  const itemsTotal = fromPaise(itemsPaise);
  const itemDiscountValue = fromPaise(toPaise(itemDiscount));
  const billDiscountValue = fromPaise(toPaise(billDiscount));
  const totalDiscount = fromPaise(discountPaise);
  Object.assign(result, {
    reconciled: true,
    itemsTotal,
    itemDiscount: itemDiscountValue,
    billDiscount: billDiscountValue,
    totalDiscount,
    tax: fromPaise(toPaise(tax)),
    charges: fromPaise(toPaise(charges)),
    roundOff: fromPaise(toPaise(roundOff)),
  });

  const rows = [{ key: "items-total", label: "Items total", amount: itemsTotal, amountText: formatBillMoney(itemsTotal), kind: "row" }];
  if (discountPaise > 0) {
    const both = itemDiscountValue > 0 && billDiscountValue > 0;
    const billLabel = billDiscountLabel(sale);
    rows.push({
      key: "total-discount",
      label: "Total discount",
      note: both ? "" : itemDiscountValue > 0 ? "On items" : billLabel,
      amount: -totalDiscount,
      amountText: formatBillMoney(-totalDiscount),
      kind: "discount",
    });
    if (both) {
      rows.push({ key: "item-discounts", label: "Item discounts", amount: itemDiscountValue, amountText: formatBillMoney(itemDiscountValue), kind: "detail" });
      if (settings.show_bill_discount_row_receipt !== false) {
        rows.push({ key: "bill-discount", label: billLabel, amount: billDiscountValue, amountText: formatBillMoney(billDiscountValue), kind: "detail" });
      }
    }
  }
  if (toPaise(tax) !== 0) {
    const label = taxRate !== null && taxRate > 0 ? `Mandi tax (${formatRatePercent(taxRate)}%)` : "Tax";
    const note = taxable !== null && taxable > 0 && Math.abs(taxable - (itemsTotal - totalDiscount)) >= 0.005
      ? `On ${formatBillMoney(taxable)}`
      : "";
    rows.push({ key: "tax", label, note, amount: result.tax, amountText: formatBillMoney(result.tax), kind: "row" });
  }
  if (toPaise(charges) !== 0) {
    rows.push({ key: "charges", label: "Other charges", amount: result.charges, amountText: formatBillMoney(result.charges), kind: "row" });
  }
  if (toPaise(roundOff) !== 0) {
    const sign = roundOff > 0 ? "+" : "";
    rows.push({ key: "round-off", label: "Round off", amount: result.roundOff, amountText: `${sign}${formatBillMoney(result.roundOff)}`, kind: "row" });
  }
  // Nothing between the items and the grand total: one line saying the same figure twice is noise.
  result.rows = rows.length === 1 ? [] : rows;
  return result;
};

// ---------------------------------------------------------------------------------------------
// Payment
// ---------------------------------------------------------------------------------------------

const VOID_PAYMENT = /CANCEL|VOID|REVERS|FAIL/i;

const buildPayment = (sale) => {
  const rows = (Array.isArray(sale.payments) ? sale.payments : [])
    .filter((payment) => payment && !VOID_PAYMENT.test(text(payment.status)))
    .map((payment) => ({ mode: text(payment.mode || payment.payment_mode).toUpperCase(), amount: readAmount(payment.amount) }))
    .filter((payment) => payment.mode);

  if (rows.length === 0 || rows.some((payment) => payment.amount === null)) {
    // Older records and partial payloads: the mode is known, the split is not. Say the mode and
    // print no amount rather than a paid figure nobody recorded.
    const mode = text(sale.payment_mode);
    const label = mode ? labelFor("paymentMode", mode) : EMPTY_LABEL;
    return {
      modeSummary: label,
      paid: null,
      balanceDue: null,
      rows: mode ? [{ key: "mode", label: "Payment", amountText: label, kind: "mode" }] : [],
    };
  }

  const byMode = new Map();
  for (const payment of rows) byMode.set(payment.mode, (byMode.get(payment.mode) || 0) + payment.amount);
  const paidModes = [...byMode.entries()]
    .filter(([mode]) => mode !== "CREDIT")
    .map(([mode, amount]) => ({ mode, label: labelFor("paymentMode", mode), amount }));
  const creditPaise = toPaise(byMode.get("CREDIT") || 0);
  const paid = fromPaise(paidModes.reduce((sum, entry) => sum + toPaise(entry.amount), 0));
  const balanceDue = creditPaise > 0 ? fromPaise(creditPaise) : 0;

  const lines = [];
  if (paidModes.length === 1 && creditPaise <= 0) {
    lines.push({ key: "paid", label: `Paid · ${paidModes[0].label}`, amount: paid, amountText: formatBillMoney(paid), kind: "paid" });
  } else {
    for (const entry of paidModes) {
      lines.push({ key: `mode-${entry.mode}`, label: entry.label, amount: entry.amount, amountText: formatBillMoney(entry.amount), kind: "mode" });
    }
    lines.push({ key: "paid", label: "Paid", amount: paid, amountText: formatBillMoney(paid), kind: "paid" });
  }
  if (creditPaise > 0) {
    lines.push({ key: "balance-due", label: "Balance due", amount: balanceDue, amountText: formatBillMoney(balanceDue), kind: "due" });
  }
  return {
    modeSummary: [...byMode.keys()].map((mode) => labelFor("paymentMode", mode)).join(" + "),
    paid,
    balanceDue,
    rows: lines,
  };
};

// ---------------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------------

const STATUS_LABELS = Object.freeze({ CANCELLED: "Cancelled", EDITED: "Edited" });

/**
 * @param {object} sale      the invoice object the app already holds (server or local shape)
 * @param {object} settings  business settings (`business_name`, `address`, `phone_number`,
 *                           `gst_number`, `invoice_footer_text`, `company_name`, and the receipt
 *                           switches `show_item_discount_column_receipt`, `show_bill_discount_row_receipt`)
 * @param {object} options   `billDate` and `billTime`, already formatted by the caller, so every
 *                           renderer shows the date exactly as the rest of the app does
 */
export const buildInvoiceLayout = (sale = {}, settings = {}, options = {}) => {
  const safeSale = sale && typeof sale === "object" ? sale : {};
  const safeSettings = settings && typeof settings === "object" ? settings : {};
  const showItemDiscounts = safeSettings.show_item_discount_column_receipt !== false;

  const rawItems = Array.isArray(safeSale.items) ? safeSale.items : [];
  const lines = mergeAllocationRows(rawItems).map((item, index) => buildLine(item, index, { showItemDiscounts }));
  const totals = buildTotals(safeSale, lines, safeSettings);
  const payment = buildPayment(safeSale);

  const status = text(safeSale.sale_status || safeSale.status).toUpperCase();
  const statusLabel = STATUS_LABELS[status] || "";
  const statusNote = status === "CANCELLED"
    ? text(safeSale.cancellation_reason)
    : status === "EDITED" ? text(safeSale.edit_reason) : "";

  const addressLines = text(safeSettings.address).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const phone = text(safeSettings.phone_number);
  const gstin = text(safeSettings.gst_number);

  const savings = totals.reconciled && totals.totalDiscount > 0
    ? { amount: totals.totalDiscount, amountText: formatBillMoney(totals.totalDiscount), text: `You saved ${formatBillMoney(totals.totalDiscount)} on this bill` }
    : null;

  return {
    header: {
      shopName: text(safeSettings.business_name) || INVOICE_FALLBACK_SHOP_NAME,
      addressLines,
      phone,
      phoneText: phone ? `Ph. ${phone}` : "",
      gstin,
      gstinText: gstin ? `GSTIN ${gstin}` : "",
      title: "Tax Invoice",
    },
    meta: {
      billNo: text(safeSale.invoice_no) || text(safeSale.offline_invoice_ref) || EMPTY_LABEL,
      date: text(options.billDate) || EMPTY_LABEL,
      time: text(options.billTime),
      customerName: text(safeSale.customer_name) || INVOICE_WALK_IN_CUSTOMER,
      customerMobile: text(safeSale.customer_mobile),
      cashier: text(safeSale.created_by_name),
      counter: text(safeSale.branch_name),
      status: statusLabel,
      statusNote,
    },
    columns: INVOICE_COLUMNS,
    lines,
    totals,
    payment,
    savings,
    footer: {
      message: text(safeSettings.invoice_footer_text) || INVOICE_FALLBACK_FOOTER,
      poweredBy: `Powered by ${text(safeSettings.company_name) || INVOICE_FALLBACK_COMPANY}`,
    },
    // For the screen only. A customer's copy is not the place to explain a data problem.
    issues: totals.issues,
  };
};

// ---------------------------------------------------------------------------------------------
// Plain-text bill (WhatsApp)
// ---------------------------------------------------------------------------------------------

const plainMoney = (value) => formatBillMoney(value).replace(MINUS, "-");

const lineText = (line) => {
  const rows = [line.product + (line.note ? ` (${line.note})` : "")];
  const unit = line.unit === EMPTY_LABEL ? "" : ` ${line.unit}`;
  const rate = line.rate === null ? "" : ` x ₹${line.rateText}`;
  const amount = line.amount === null ? "" : ` = ₹${line.amountText}`;
  rows.push(`  ${line.qtyText}${unit}${rate}${amount}`);
  if (line.discount) rows.push(`  ${line.discount.label}: ${plainMoney(-line.discount.amount)}`);
  return rows;
};

/**
 * The same bill as plain text, for the WhatsApp caption. WhatsApp caps a document caption at 1024
 * characters and fails the send outright over it, so a long bill lists what fits and points to
 * the attached PDF for the rest. The totals, the grand total and the saving are never the part
 * that gets cut.
 */
export const buildInvoiceText = (layout, { maxLength = INVOICE_TEXT_MAX_LENGTH } = {}) => {
  const { header, meta, lines, totals, payment, savings, footer } = layout;
  const head = [
    `*${header.shopName}*`,
    `${header.title} · Bill ${meta.billNo}`,
    [meta.date === EMPTY_LABEL ? "" : meta.date, meta.time].filter(Boolean).join(" "),
    `Customer: ${meta.customerName}`,
  ].filter(Boolean);
  if (meta.status) head.push(`Status: ${meta.status}`);

  const tail = [];
  for (const row of totals.rows) {
    const label = row.kind === "detail" ? `  ${row.label}` : row.label;
    tail.push(`${label}: ${row.key === "round-off" ? row.amountText.replace(MINUS, "-") : plainMoney(row.amount)}`);
  }
  tail.push(`*Grand total: ${plainMoney(totals.grandTotal)}*`);
  for (const row of payment.rows) {
    tail.push(`${row.label}: ${row.kind === "mode" && row.amount === undefined ? row.amountText : plainMoney(row.amount)}`);
  }
  if (savings) tail.push("", `*${savings.text.replace(MINUS, "-")}*`);
  tail.push("", footer.message);

  const itemBlocks = lines.map(lineText);
  const assemble = (blocks, omitted) => [
    ...head,
    "",
    ...blocks.flat(),
    ...(omitted > 0 ? [`+ ${omitted} more item${omitted === 1 ? "" : "s"} (full bill in the PDF)`] : []),
    "",
    ...tail,
  ].join("\n");

  let shown = itemBlocks.length;
  let message = assemble(itemBlocks, 0);
  while (message.length > maxLength && shown > 0) {
    shown -= 1;
    message = assemble(itemBlocks.slice(0, shown), itemBlocks.length - shown);
  }
  return message;
};
