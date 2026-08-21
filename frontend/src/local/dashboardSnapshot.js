import { isProvisionalLot, provisionalStockNote, summariseLotCostStatus } from "./provisionalLotCost.js";
const numberValue = (value) => Number(value || 0);

const dateKey = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.slice(0, 10);
};

const roundMoney = (value) => Math.round((numberValue(value) + Number.EPSILON) * 100) / 100;

const rangeBounds = ({ range = "7", customRange = {}, today } = {}) => {
  const end = dateKey(customRange.date_to) || today;
  if (range === "custom" && customRange.date_from && customRange.date_to) {
    return { from: dateKey(customRange.date_from), to: dateKey(customRange.date_to) };
  }
  const days = Math.max(numberValue(range) || 7, 1);
  const fromDate = new Date(`${end}T00:00:00.000Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - days + 1);
  return { from: fromDate.toISOString().slice(0, 10), to: end };
};

export function buildLocalDashboardSnapshot({ inventoryLots = [], sales = [], range = "7", customRange = {}, today } = {}) {
  const todayKey = dateKey(today) || new Date().toISOString().slice(0, 10);
  const bounds = rangeBounds({ range, customRange, today: todayKey });
  const activeSales = sales.filter((sale) => String(sale.sale_status || sale.status || "COMPLETED").toUpperCase() !== "CANCELLED");
  const todaySales = activeSales.filter((sale) => dateKey(sale.sale_date || sale.bill_date) === todayKey);
  const rangedSales = activeSales.filter((sale) => {
    const key = dateKey(sale.sale_date || sale.bill_date);
    return key && key >= bounds.from && key <= bounds.to;
  });

  const stockByProduct = new Map();
  const lotCosts = new Map();
  let stockValue = 0;
  // Stock awaiting a supplier bill has no real cost yet, and multiplying its placeholder zero into
  // the headline made the total quietly short — 18.2% of units on the measured snapshot. It is
  // counted separately and reported beside the figure rather than silently folded into it.
  const costStatusSummary = summariseLotCostStatus(inventoryLots);
  for (const lot of inventoryLots) {
    const quantity = numberValue(lot.remaining_qty ?? lot.balance_qty);
    const cost = numberValue(lot.effective_cost_per_unit ?? lot.purchase_rate ?? lot.cost_rate);
    const productKey = String(lot.product_id || lot.product_name || lot.id || "unknown");
    // The lot still counts as stock on hand — it is physically there — but not as value.
    if (!isProvisionalLot(lot)) stockValue += quantity * cost;
    stockByProduct.set(productKey, {
      productId: lot.product_id,
      productName: lot.product_name || "Unnamed product",
      quantity: numberValue(stockByProduct.get(productKey)?.quantity) + quantity,
      minimumStock: numberValue(lot.minimum_stock ?? 5),
      unit: lot.unit || "",
    });
    lotCosts.set(String(lot.id), cost);
  }

  const daily = new Map();
  const productSales = new Map();
  let todayProfit = 0;
  for (const sale of rangedSales) {
    const key = dateKey(sale.sale_date || sale.bill_date);
    const amount = numberValue(sale.total_amount ?? sale.net_total ?? sale.amount);
    let profit = numberValue(sale.profit);
    if (!profit && Array.isArray(sale.items)) {
      profit = sale.items.reduce((sum, item) => {
        const quantity = numberValue(item.quantity);
        const revenue = numberValue(item.net_amount ?? item.amount ?? (numberValue(item.rate ?? item.selling_rate) * quantity));
        const cost = lotCosts.get(String(item.lot_id || item.inventory_batch_id)) || 0;
        const productKey = String(item.product_id || item.product_name || "unknown");
        const current = productSales.get(productKey) || { productId: item.product_id, productName: item.product_name || "Unnamed product", quantity: 0, sales: 0 };
        current.quantity += quantity;
        current.sales += revenue;
        current.unit = item.unit || current.unit || "";
        productSales.set(productKey, current);
        return sum + revenue - (cost * quantity);
      }, 0);
    }
    const row = daily.get(key) || { date: key, sales: 0, grossProfit: 0, transactions: 0 };
    row.sales += amount;
    row.grossProfit += profit;
    row.transactions += 1;
    daily.set(key, row);
    if (key === todayKey) todayProfit += profit;
  }

  const lowStockRows = [...stockByProduct.values()]
    .filter((item) => item.quantity <= item.minimumStock)
    .sort((a, b) => a.quantity - b.quantity)
    .map((item) => ({ product_id: item.productId, product_name: item.productName, current_stock: item.quantity, remaining_qty: item.quantity, minimum_stock: item.minimumStock, unit: item.unit }));
  const salesTrend = [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)).map((row) => ({ ...row, sales: roundMoney(row.sales), grossProfit: roundMoney(row.grossProfit) }));
  const summary = {
    todaySales: roundMoney(todaySales.reduce((sum, sale) => sum + numberValue(sale.total_amount ?? sale.net_total ?? sale.amount), 0)),
    todayProfit: roundMoney(todayProfit),
    stockValue: roundMoney(stockValue),
    // Carried beside the figure so a caller cannot render the total without the caveat available.
    // Empty string when nothing is awaiting a bill, so the common case shows no note at all.
    stockValueNote: provisionalStockNote(costStatusSummary),
    provisionalStockUnits: costStatusSummary.provisionalUnits,
    provisionalStockLots: costStatusSummary.provisionalLotCount,
    lowStockItems: lowStockRows.length,
    transactions: todaySales.length,
    supplierOutstanding: 0,
    customerOutstanding: 0,
    todayExpenses: 0,
    todayReturns: 0,
    monthlyReturns: 0,
    todayWaste: 0,
    monthlyWaste: 0,
    wastePercentage: 0,
    totalRebateReceived: 0,
    todaySupplierPayments: 0,
  };

  return {
    metrics: summary,
    analytics: {
      dateFrom: bounds.from,
      dateTo: bounds.to,
      days: Math.max(Math.round((new Date(`${bounds.to}T00:00:00Z`) - new Date(`${bounds.from}T00:00:00Z`)) / 86400000) + 1, 1),
      summary,
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
