/**
 * Words and figures for the stock screens: Purchase Entry, Pending Bills, Waste and Stock
 * Distribution.
 *
 * These are display decisions only. Nothing here changes what is saved or sent; it decides what a
 * person at the counter reads, so that a quantity carries its unit, a failed load never looks like
 * "nothing pending", and a finished pending bill says that it was finished. Kept out of App.jsx so
 * each rule is tested on its own (`stockScreens.test.mjs`).
 */
import { MISSING_VALUE, finiteOrNull, formatOptionalQuantity, unitDisplayName } from "./productMaster.js";

const text = (value) => (value === null || value === undefined ? "" : String(value)).trim();
const unitKey = (unit) => text(unit).toUpperCase();

/** "12.500 Kg", or "—" when the quantity is unknown. A blank unit is left off, never invented. */
export const formatQuantityWithUnit = (value, unit) => {
  const quantity = formatOptionalQuantity(value);
  if (quantity === MISSING_VALUE) return MISSING_VALUE;
  const unitName = unitDisplayName(unit);
  return unitName === MISSING_VALUE ? quantity : `${quantity} ${unitName}`;
};

/**
 * The bill's cost per unit, only when that means something.
 *
 * "Effective Cost / Unit" used to divide the bill's net by the quantity of every item added
 * together, so 10 kg of apples and 4 boxes of kiwi made "14 units" and a figure that was the cost
 * of nothing. Now: one unit across the items → the cost per that unit; more than one → unknown
 * (`mixed`), and the screen shows "—" with the reason. Display only: what is saved is unchanged.
 *
 * `items` are `{ quantity, unit }`; lines with no quantity are not counted.
 */
export const costPerUnitSummary = (items, totalCost) => {
  const counted = (Array.isArray(items) ? items : []).filter((item) => (finiteOrNull(item?.quantity) || 0) > 0);
  const total = finiteOrNull(totalCost);
  if (counted.length === 0 || total === null) return { known: false, reason: "empty", value: null, unit: "", label: "Cost per unit" };
  const units = new Set(counted.map((item) => unitKey(item.unit)));
  if (units.size > 1) return { known: false, reason: "mixed", value: null, unit: "", label: "Cost per unit (mixed units)" };
  const [only] = [...units];
  const quantity = counted.reduce((sum, item) => sum + Number(item.quantity), 0);
  const unitName = only ? unitDisplayName(only) : "";
  return {
    known: true,
    reason: "",
    value: total / quantity,
    unit: unitName,
    label: unitName ? `Cost per ${unitName.toLowerCase()}` : "Cost per unit",
  };
};

/**
 * Is this Purchase Entry finishing a pending bill? A pending bill opened with "Complete Bill" is
 * edited as a completed bill: it was BILL_PENDING and is now being saved as BILL_COMPLETED. That
 * is a completion, not an amendment, and the screen and its messages say so.
 */
export const isPendingBillCompletion = ({ editingPurchaseId = null, billStatus = "", originalBillStatus = "" } = {}) => (
  Boolean(text(editingPurchaseId)) && billStatus === "BILL_COMPLETED" && originalBillStatus === "BILL_PENDING"
);

/**
 * The headings of Purchase Entry's two cards for what the person is doing. One wording each for a
 * new purchase, completing a pending bill and correcting one saved item. No internal numbers in a
 * title beyond the bill's own "#", which staff read off the Pending Bills list.
 */
export const purchaseEntryHeadings = ({ completing = false, editing = false, pending = false, multiFruit = 0, supplierName = "" } = {}) => {
  const supplier = text(supplierName);
  if (completing) {
    return {
      eyebrow: "Complete a pending bill",
      title: supplier ? `Complete the bill from ${supplier}` : "Complete the pending bill",
      subtitle: "Enter the supplier's bill: the final rate, charges and rebate. The stock is already in the shop.",
      itemsEyebrow: "Final rates",
      itemsTitle: multiFruit > 1 ? "Final rate for each fruit" : "Final rate",
      itemsSubtitle: multiFruit > 1
        ? `This arrival has ${multiFruit} fruits. Enter the final purchase rate from the supplier's bill for each one.`
        : "Enter the final purchase rate from the supplier's bill.",
    };
  }
  if (editing) {
    return {
      eyebrow: "Correct a purchase",
      title: "Correct a saved purchase",
      subtitle: "Change one item of a saved purchase. The change is kept in the purchase's history.",
      itemsEyebrow: "Item",
      itemsTitle: "Item to correct",
      itemsSubtitle: "A quantity cannot go below what has already been sold from this lot.",
    };
  }
  return {
    eyebrow: "New purchase",
    title: "Purchase entry",
    subtitle: pending
      ? "Stock that arrived without a bill. Add each fruit; the bill is completed later from Pending Bills."
      : "Choose the supplier, add each fruit on the bill, then save.",
    itemsEyebrow: "Items",
    itemsTitle: "Fruit on this bill",
    itemsSubtitle: "Add every fruit from this supplier before saving.",
  };
};

/** What Purchase Entry says after a save that worked. Names the supplier, never a bare "Saved". */
export const purchaseSavedMessage = ({ completing = false, editing = false, pending = false, queuedOffline = false, supplierName = "" } = {}) => {
  const supplier = text(supplierName);
  const from = supplier ? ` from ${supplier}` : "";
  const forSupplier = supplier ? ` for ${supplier}` : "";
  if (queuedOffline) return `Purchase${forSupplier} saved on this computer. It is sent to the cloud when the connection is back.`;
  if (completing) return `Bill completed${forSupplier}.`;
  if (editing) return `Purchase${forSupplier} corrected.`;
  if (pending) return `Stock arrival${from} saved. The bill is waiting in Pending Bills.`;
  return `Purchase saved${forSupplier}.`;
};

/**
 * How the supplier side of Pending Bills is drawn. The purchases list failing to load used to show
 * "Pending Suppliers 0 · ₹0.00 · No pending purchase bills" -- the screen claimed nothing was owed.
 */
export const pendingPurchasesPresentation = (loadState = {}) => {
  const status = text(loadState?.status) || "idle";
  if (status === "failed") {
    return { kind: "failed", figures: false, message: text(loadState.message) || "The purchases could not be loaded." };
  }
  if (status === "idle" || status === "loading") return { kind: "loading", figures: false, message: "" };
  return { kind: "ready", figures: true, message: "" };
};

/**
 * One pending item in words: "Apple 5.000 Kg × ₹95.00 = ₹475.00". `money` formats rupees.
 * A rate the screen does not know is "rate not set", never ₹0.
 */
export const pendingItemNarration = (purchase, rate, money) => {
  const product = text(purchase?.product_name) || "Item";
  const quantity = formatQuantityWithUnit(purchase?.quantity, purchase?.unit);
  const knownRate = finiteOrNull(rate);
  const knownQuantity = finiteOrNull(purchase?.quantity);
  if (knownRate === null || knownRate <= 0) return `${product} ${quantity}, rate not set`;
  const total = knownQuantity === null ? MISSING_VALUE : money(knownQuantity * knownRate);
  return `${product} ${quantity} × ${money(knownRate)} = ${total}`;
};

/**
 * The badge class for a consignment's status. "Waiting" and "on the way" are not faults and were
 * painted red; "Cancelled" and "Refused" are not successes and were painted green.
 */
const DISTRIBUTION_STATUS_CLASS = Object.freeze({
  DRAFT: "tag",
  APPROVAL_PENDING: "origin-rate",
  APPROVED_RESERVED: "origin-rate",
  DISPATCHED_IN_TRANSIT: "origin-rate",
  RETURN_IN_TRANSIT: "origin-rate",
  PARTIALLY_RECEIVED: "origin-rate",
  DISCREPANCY_RESOLUTION: "stock-low",
  RECEIVED: "stock-ok",
  CLOSED: "stock-ok",
  CANCELLED: "tag",
  REJECTED: "stock-low",
});

/** An unknown status is a fact worth noticing, so it takes the danger tone, never "done". */
export const distributionStatusClass = (status) => DISTRIBUTION_STATUS_CLASS[unitKey(status)] || "stock-low";

/** A lot's own name for people: its lot name, else its batch number, else when it came in. */
export const stockLotName = (lot, formatDate = (value) => text(value).slice(0, 10)) => {
  const name = text(lot?.lot_name) || text(lot?.lot_no) || text(lot?.batch_no);
  if (name) return name;
  const date = text(lot?.purchase_date || lot?.created_at).slice(0, 10);
  return date ? `Lot of ${formatDate(date)}` : "Unnamed lot";
};

/**
 * The "Choose a lot" options for sending stock: product, lot name, date in and what is left with
 * its unit, sorted by product and then oldest first (the lot that should go out first is on top).
 * Never the raw lot id, which means nothing to the person choosing.
 *
 * `available(lot)` is the sendable quantity; `productName(lot)` and `unitFor(lot)` name the product.
 */
export const distributionLotOptions = (lots, { available, productName, unitFor = (lot) => lot?.unit, formatDate } = {}) => (
  (Array.isArray(lots) ? lots : [])
    .map((lot) => {
      const name = text(productName?.(lot)) || text(lot?.product_name) || "Unnamed product";
      const date = text(lot?.purchase_date || lot?.created_at).slice(0, 10);
      const left = formatQuantityWithUnit(available?.(lot), unitFor(lot));
      const ownName = Boolean(text(lot?.lot_name) || text(lot?.lot_no) || text(lot?.batch_no));
      const lotName = stockLotName(lot, formatDate);
      // A lot named after its date already says it; a named lot adds when it came in.
      const dated = ownName && date && formatDate ? ` · in ${formatDate(date)}` : "";
      return {
        id: lot?.id,
        product: name,
        date,
        lotName,
        label: `${name} — ${lotName}${dated} (${left} available)`,
        shortLabel: `${lotName}${dated} (${left} available)`,
      };
    })
    .sort((left, right) => (
      left.product.localeCompare(right.product)
      || (left.date || "9999").localeCompare(right.date || "9999")
      || left.lotName.localeCompare(right.lotName)
    ))
);

/**
 * A product in Waste's dropdown with what is in stock. A product whose lots have not been loaded,
 * or that has none listed, says "—": "Stock 0" read as "there is none", which may be untrue.
 */
export const wasteProductOptionLabel = (product, stockQuantity) => {
  const name = text(product?.product_name) || "Unnamed product";
  const known = finiteOrNull(stockQuantity);
  return `${name} (in stock: ${known === null ? MISSING_VALUE : formatQuantityWithUnit(known, product?.unit)})`;
};
