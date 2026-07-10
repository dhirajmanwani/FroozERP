const MEMORY_TYPES = new Set([
  "owner_preferences",
  "customer_notes",
  "supplier_notes",
  "product_notes",
  "employee_notes",
  "branch_notes",
  "business_rules",
  "recurring_patterns",
  "important_decisions",
  "approved_ai_observations",
]);

const SENSITIVE_PATTERN = /(password|passcode|api[_\s-]?key|secret|token|database_url|credential|card number|cvv|pin|upi pin)/i;

const normalizeMemoryType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return MEMORY_TYPES.has(normalized) ? normalized : "approved_ai_observations";
};

const containsSensitiveMemory = (value = "") => SENSITIVE_PATTERN.test(String(value || ""));

const confidenceLabel = (score = 0) => {
  const value = Number(score || 0);
  if (value >= 0.8) return "High";
  if (value >= 0.55) return "Medium";
  if (value > 0) return "Low";
  return "Insufficient data";
};

const movingAverage = (values = []) => {
  const numeric = values.map(Number).filter((value) => Number.isFinite(value));
  if (!numeric.length) return null;
  return numeric.reduce((sum, value) => sum + value, 0) / numeric.length;
};

const weightedAverage = (values = []) => {
  const numeric = values.map(Number).filter((value) => Number.isFinite(value));
  if (!numeric.length) return null;
  const totalWeight = numeric.reduce((sum, _value, index) => sum + index + 1, 0);
  return numeric.reduce((sum, value, index) => sum + value * (index + 1), 0) / totalWeight;
};

const stockOutPrediction = ({ availableStock = 0, dailySales = [], minimumDataDays = 3 } = {}) => {
  const quantities = dailySales.map((row) => Number(row.quantity || row.qty || 0)).filter((value) => value > 0);
  if (quantities.length < minimumDataDays) {
    return {
      status: "INSUFFICIENT_DATA",
      confidence: 0,
      reason: `Needs at least ${minimumDataDays} sale days; found ${quantities.length}.`,
      minimumDataRequirement: `${minimumDataDays} days with sales`,
    };
  }
  const averageDailySold = weightedAverage(quantities);
  const daysUntilStockOut = averageDailySold > 0 ? Number((Number(availableStock || 0) / averageDailySold).toFixed(1)) : null;
  return {
    status: "READY",
    predictionPeriod: "Next 7 days",
    averageDailySold: Number(averageDailySold.toFixed(3)),
    daysUntilStockOut,
    likelyLowStockDate: daysUntilStockOut === null ? null : new Date(Date.now() + Math.ceil(daysUntilStockOut) * 86400000).toISOString().slice(0, 10),
    confidence: quantities.length >= 7 ? 0.75 : 0.55,
    confidenceLabel: confidenceLabel(quantities.length >= 7 ? 0.75 : 0.55),
    reason: "Weighted recent daily sales divided into available stock.",
    minimumDataRequirement: `${minimumDataDays} days with sales`,
  };
};

const salesRangePrediction = ({ dailySales = [], minimumDataDays = 7, periodLabel = "Next day" } = {}) => {
  const amounts = dailySales.map((row) => Number(row.amount || row.total_sales || 0)).filter((value) => value > 0);
  if (amounts.length < minimumDataDays) {
    return {
      status: "INSUFFICIENT_DATA",
      confidence: 0,
      reason: `Needs at least ${minimumDataDays} sales days; found ${amounts.length}.`,
      minimumDataRequirement: `${minimumDataDays} days with sales`,
    };
  }
  const avg = weightedAverage(amounts);
  const spread = Math.max(avg * 0.18, 1);
  return {
    status: "READY",
    predictionPeriod: periodLabel,
    expectedRange: { low: Number((avg - spread).toFixed(2)), high: Number((avg + spread).toFixed(2)) },
    confidence: amounts.length >= 21 ? 0.72 : 0.56,
    confidenceLabel: confidenceLabel(amounts.length >= 21 ? 0.72 : 0.56),
    reason: "Recent weighted moving average with a conservative range.",
    minimumDataRequirement: `${minimumDataDays} days with sales`,
  };
};

const grossMarginPercent = ({ sellingRate = 0, purchaseCost = 0 } = {}) => {
  const sale = Number(sellingRate || 0);
  const cost = Number(purchaseCost || 0);
  if (sale <= 0) return null;
  return Number((((sale - cost) / sale) * 100).toFixed(2));
};

const wasteAdjustedMargin = ({ saleAmount = 0, costAmount = 0, wasteCost = 0 } = {}) => {
  const sale = Number(saleAmount || 0);
  if (sale <= 0) return null;
  return Number((((sale - Number(costAmount || 0) - Number(wasteCost || 0)) / sale) * 100).toFixed(2));
};

const isInactiveCustomer = ({ lastPurchaseDate, asOf = new Date(), inactiveDays = 30 } = {}) => {
  if (!lastPurchaseDate) return true;
  const last = new Date(lastPurchaseDate);
  if (Number.isNaN(last.getTime())) return true;
  return ((new Date(asOf).getTime() - last.getTime()) / 86400000) >= inactiveDays;
};

const supplierCostIncrease = ({ previousCost = 0, currentCost = 0, thresholdPercent = 10 } = {}) => {
  const previous = Number(previousCost || 0);
  const current = Number(currentCost || 0);
  if (previous <= 0 || current <= 0) return { status: "INSUFFICIENT_DATA", increasePercent: null };
  const increasePercent = ((current - previous) / previous) * 100;
  return {
    status: increasePercent >= thresholdPercent ? "INCREASE_DETECTED" : "NORMAL",
    increasePercent: Number(increasePercent.toFixed(2)),
  };
};

const dedupeAlertKey = ({ rule, entityType, entityId, branchId = 1 }) =>
  [branchId, rule, entityType || "none", entityId || "none"].join(":");

module.exports = {
  MEMORY_TYPES,
  containsSensitiveMemory,
  normalizeMemoryType,
  confidenceLabel,
  movingAverage,
  weightedAverage,
  stockOutPrediction,
  salesRangePrediction,
  grossMarginPercent,
  wasteAdjustedMargin,
  isInactiveCustomer,
  supplierCostIncrease,
  dedupeAlertKey,
};
