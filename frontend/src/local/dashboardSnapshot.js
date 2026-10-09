import { isProvisionalLot, provisionalStockNote, summariseLotCostStatus } from "./provisionalLotCost.js";
import { canonicalInventoryId } from "./stockInventory.js";

const numberValue = (value) => Number(value || 0);

const dateKey = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.slice(0, 10);
};

const roundMoney = (value) => Math.round((numberValue(value) + Number.EPSILON) * 100) / 100;

export const rangeBounds = ({ range = "7", customRange = {}, today } = {}) => {
  if (range === "custom" && customRange.date_from && customRange.date_to) {
    return { from: dateKey(customRange.date_from), to: dateKey(customRange.date_to) };
  }
  // A preset range always ends today. It used to end at `customRange.date_to` whenever one was
  // left over from an earlier custom pick, so "Last 7 days" silently meant "the 7 days before
  // some old date" while the date inputs (bound only in custom mode) looked empty.
  const end = today;
  const days = Math.max(numberValue(range) || 7, 1);
  const fromDate = new Date(`${end}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - days + 1);
  return { from: fromDate.toISOString().slice(0, 10), to: end };
};

/**
 * The local sales a dashboard build needs: the selected range and today (Today's Sales and Today's
 * Profit are about today whatever range is chosen), as one inclusive YYYY-MM-DD window for
 * `pos_sale_list_local_range`. The 200-bill list it replaces silently dropped older bills, so a
 * 30-day trend on a busy counter showed only its last few days.
 */
export const localSalesWindow = ({ range = "7", customRange = {}, today } = {}) => {
  const todayKey = dateKey(today) || new Date().toISOString().slice(0, 10);
  const bounds = rangeBounds({ range, customRange, today: todayKey });
  const from = bounds.from && bounds.from < todayKey ? bounds.from : todayKey;
  const to = bounds.to && bounds.to > todayKey ? bounds.to : todayKey;
  return { fromDate: from, toDate: to };
};

// Lots the server leaves out of stock (`batch_status <> 'CANCELLED'`, plus INACTIVE): they are not
// fruit on the shelf, so they must not be valued or reported as low stock.
const EXCLUDED_LOT_STATUSES = new Set(["CANCELLED", "INACTIVE"]);
const isStockLot = (lot) => !EXCLUDED_LOT_STATUSES.has(
  String(lot?.batch_status || lot?.status || "ACTIVE").trim().toUpperCase(),
);

// `null`/`""` are "not set", not zero — `Number(null)` is 0 and would read as a real threshold.
const finiteOrNull = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const DEFAULT_MINIMUM_STOCK = 5;

/** Dashboard metrics this layer never computes; each is emitted as `null`, never 0. */
export const LOCAL_UNCOMPUTED_METRICS = Object.freeze([
  "supplierOutstanding",
  "customerOutstanding",
  "todayExpenses",
  "todayReturns",
  "monthlyReturns",
  "todayWaste",
  "monthlyWaste",
  "wastePercentage",
  "totalRebateReceived",
  "todaySupplierPayments",
]);

const profitNoteFor = ({ units, lines }) => {
  if (!lines) return "";
  return `${units.toFixed(3)} units on ${lines} sale line${lines === 1 ? "" : "s"} came from stock with no `
    + "known cost (awaiting a supplier bill, or a lot this device does not hold) and are not included in this profit.";
};

/**
 * Build the dashboard from the device's own data.
 *
 * Figures this layer does not compute (outstanding balances, expenses, returns, waste, rebates,
 * supplier payments) are `null`, never 0: a zero there would read as "none today" when the truth is
 * "this device does not know". The renderer shows `null` as a dash.
 *
 * Profit counts only sale lines whose cost is known. A line drawn from a provisional lot (supplier
 * bill still pending, placeholder cost 0) or from a lot this device does not hold would otherwise
 * be booked at 100% margin; it is left out of profit entirely — revenue and cost — and the
 * shortfall is described in `profitNote` (`""` when nothing was left out). Sales totals and
 * top-selling products still include those lines: the money was taken, only its margin is unknown.
 */
export function buildLocalDashboardSnapshot({
  inventoryLots = [],
  products = [],
  sales = [],
  range = "7",
  customRange = {},
  today,
} = {}) {
  const todayKey = dateKey(today) || new Date().toISOString().slice(0, 10);
  const bounds = rangeBounds({ range, customRange, today: todayKey });
  const activeSales = sales.filter((sale) => String(sale.sale_status || sale.status || "COMPLETED").toUpperCase() !== "CANCELLED");
  const todaySales = activeSales.filter((sale) => dateKey(sale.sale_date || sale.bill_date) === todayKey);
  const rangedSales = activeSales.filter((sale) => {
    const key = dateKey(sale.sale_date || sale.bill_date);
    return key && key >= bounds.from && key <= bounds.to;
  });

  const productMinimums = new Map();
  for (const product of Array.isArray(products) ? products : []) {
    const minimum = finiteOrNull(product?.minimum_stock);
    if (minimum !== null) productMinimums.set(canonicalInventoryId(product.id), minimum);
  }

  const stockLots = (Array.isArray(inventoryLots) ? inventoryLots : []).filter(isStockLot);
  const stockByProduct = new Map();
  // Every lot's cost, cancelled ones included: a sale made before a cancellation still had a cost.
  const lotCosts = new Map();
  for (const lot of Array.isArray(inventoryLots) ? inventoryLots : []) {
    lotCosts.set(canonicalInventoryId(lot.id), {
      cost: numberValue(lot.effective_cost_per_unit ?? lot.purchase_rate ?? lot.cost_rate),
      provisional: isProvisionalLot(lot),
    });
  }
  let stockValue = 0;
  // Stock awaiting a supplier bill has no real cost yet, and multiplying its placeholder zero into
  // the headline made the total quietly short — 18.2% of units on the measured snapshot. It is
  // counted separately and reported beside the figure rather than silently folded into it.
  const costStatusSummary = summariseLotCostStatus(stockLots);
  for (const lot of stockLots) {
    const quantity = numberValue(lot.remaining_qty ?? lot.balance_qty);
    const cost = numberValue(lot.effective_cost_per_unit ?? lot.purchase_rate ?? lot.cost_rate);
    const productKey = canonicalInventoryId(lot.product_id) || String(lot.product_name || lot.id || "unknown");
    // The lot still counts as stock on hand — it is physically there — but not as value.
    if (!isProvisionalLot(lot)) stockValue += quantity * cost;
    const minimumStock = finiteOrNull(lot.minimum_stock)
      ?? productMinimums.get(canonicalInventoryId(lot.product_id))
      ?? DEFAULT_MINIMUM_STOCK;
    stockByProduct.set(productKey, {
      productId: lot.product_id,
      productName: lot.product_name || "Unnamed product",
      quantity: numberValue(stockByProduct.get(productKey)?.quantity) + quantity,
      minimumStock,
      unit: lot.unit || "",
    });
  }

  // Profit of one sale from the lines whose cost is known; see the function comment.
  const unpricedToday = { units: 0, lines: 0 };
  const unpricedRange = { units: 0, lines: 0 };
  const saleProfit = (sale, unpriced) => {
    const stated = numberValue(sale.profit);
    if (stated || !Array.isArray(sale.items)) return stated;
    return sale.items.reduce((sum, item) => {
      const quantity = numberValue(item.quantity);
      const revenue = numberValue(item.net_amount ?? item.amount ?? (numberValue(item.rate ?? item.selling_rate) * quantity));
      const lotCost = lotCosts.get(canonicalInventoryId(item.lot_id || item.inventory_batch_id));
      if (!lotCost || lotCost.provisional) {
        unpriced.units += quantity;
        unpriced.lines += 1;
        return sum;
      }
      return sum + revenue - (lotCost.cost * quantity);
    }, 0);
  };

  const daily = new Map();
  const productSales = new Map();
  for (const sale of rangedSales) {
    const key = dateKey(sale.sale_date || sale.bill_date);
    const amount = numberValue(sale.total_amount ?? sale.net_total ?? sale.amount);
    const profit = saleProfit(sale, unpricedRange);
    for (const item of Array.isArray(sale.items) ? sale.items : []) {
      const quantity = numberValue(item.quantity);
      const revenue = numberValue(item.net_amount ?? item.amount ?? (numberValue(item.rate ?? item.selling_rate) * quantity));
      const productKey = canonicalInventoryId(item.product_id) || String(item.product_name || "unknown");
      const current = productSales.get(productKey) || { productId: item.product_id, productName: item.product_name || "Unnamed product", quantity: 0, sales: 0 };
      current.quantity += quantity;
      current.sales += revenue;
      current.unit = item.unit || current.unit || "";
      productSales.set(productKey, current);
    }
    const row = daily.get(key) || { date: key, sales: 0, grossProfit: 0, transactions: 0 };
    row.sales += amount;
    row.grossProfit += profit;
    row.transactions += 1;
    daily.set(key, row);
  }
  // Today's Profit is about today whatever range is selected — a "last 7 days ending last month"
  // custom range used to make it 0.
  const todayProfit = todaySales.reduce((sum, sale) => sum + saleProfit(sale, unpricedToday), 0);

  const lowStockRows = [...stockByProduct.values()]
    .filter((item) => item.quantity <= item.minimumStock)
    .sort((a, b) => a.quantity - b.quantity)
    .map((item) => ({ product_id: item.productId, product_name: item.productName, current_stock: item.quantity, remaining_qty: item.quantity, minimum_stock: item.minimumStock, unit: item.unit }));
  const salesTrend = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).map((row) => ({ ...row, sales: roundMoney(row.sales), grossProfit: roundMoney(row.grossProfit) }));
  const summary = {
    todaySales: roundMoney(todaySales.reduce((sum, sale) => sum + numberValue(sale.total_amount ?? sale.net_total ?? sale.amount), 0)),
    todayProfit: roundMoney(todayProfit),
    // Today's figure; the range's own caveat is on `analytics.profitNote`.
    profitNote: profitNoteFor(unpricedToday),
    stockValue: roundMoney(stockValue),
    // Carried beside the figure so a caller cannot render the total without the caveat available.
    // Empty string when nothing is awaiting a bill, so the common case shows no note at all.
    stockValueNote: provisionalStockNote(costStatusSummary),
    provisionalStockUnits: costStatusSummary.provisionalUnits,
    provisionalStockLots: costStatusSummary.provisionalLotCount,
    lowStockItems: lowStockRows.length,
    transactions: todaySales.length,
    // Not computed by the local layer. `null` means "unknown here", and renders as a dash.
    ...Object.fromEntries(LOCAL_UNCOMPUTED_METRICS.map((key) => [key, null])),
  };

  return {
    metrics: summary,
    analytics: {
      dateFrom: bounds.from,
      dateTo: bounds.to,
      days: Math.max(Math.round((new Date(`${bounds.to}T00:00:00Z`) - new Date(`${bounds.from}T00:00:00Z`)) / 86400000) + 1, 1),
      summary,
      profitNote: profitNoteFor(unpricedRange),
      salesTrend,
      profitTrend: salesTrend,
      expenseTrend: [],
      netProfitTrend: salesTrend.map((row) => ({ date: row.date, netProfit: row.grossProfit })),
      purchaseSalesComparison: salesTrend.map((row) => ({ date: row.date, sales: row.sales, purchases: 0 })),
      topSellingProducts: [...productSales.values()].sort((a, b) => b.sales - a.sales).slice(0, 10).map((item) => ({
        product_id: item.productId,
        product_name: item.productName,
        quantity_sold: item.quantity,
        revenue: roundMoney(item.sales),
        unit: item.unit || "",
      })),
      lowStockItems: lowStockRows,
      insights: [],
    },
  };
}
