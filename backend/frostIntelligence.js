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

const clampScore = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value || 0)));

const priorityFromScore = (score = 0) => {
  const value = Number(score || 0);
  if (value >= 80) return "CRITICAL";
  if (value >= 60) return "HIGH";
  if (value >= 35) return "ATTENTION";
  return "INFO";
};

const dynamicPriceRecommendation = ({
  sellingRate = 0,
  purchaseCost = 0,
  availableStock = 0,
  averageDailySale = 0,
  wasteProbability = 0,
  demandTrend = 0,
} = {}) => {
  const sale = Number(sellingRate || 0);
  const cost = Number(purchaseCost || 0);
  if (sale <= 0 || cost <= 0) {
    return { action: "KEEP", changeAmount: 0, confidence: 0.2, priority: "INFO", reason: "Insufficient rate or cost data." };
  }
  const margin = grossMarginPercent({ sellingRate: sale, purchaseCost: cost });
  const daysOfStock = Number(averageDailySale || 0) > 0 ? Number(availableStock || 0) / Number(averageDailySale || 0) : null;
  let action = "KEEP";
  let changeAmount = 0;
  let reason = "Rate appears balanced for current margin, stock and demand.";
  let riskScore = 20;
  if (margin < 12 && demandTrend >= 0) {
    action = "INCREASE";
    changeAmount = Math.max(1, Math.round(sale * 0.04));
    reason = "Low margin with stable or rising demand.";
    riskScore = 70;
  } else if ((daysOfStock !== null && daysOfStock > 8) || Number(wasteProbability || 0) >= 0.55) {
    action = "REDUCE";
    changeAmount = Math.max(1, Math.round(sale * 0.03));
    reason = "Stock or waste risk is high; a controlled reduction may improve movement.";
    riskScore = 62;
  }
  const expectedRevenueImpact = action === "KEEP" ? 0 : Number((changeAmount * Number(averageDailySale || 0) * 7 * (action === "INCREASE" ? 1 : -1)).toFixed(2));
  const expectedProfitImpact = action === "KEEP" ? 0 : Number((expectedRevenueImpact - (action === "REDUCE" ? 0 : 0)).toFixed(2));
  return {
    action,
    changeAmount,
    margin,
    daysOfStock: daysOfStock === null ? null : Number(daysOfStock.toFixed(1)),
    expectedRevenueImpact,
    expectedProfitImpact,
    confidence: clampScore(0.45 + Math.min(Number(averageDailySale || 0), 10) * 0.025 + Math.min(Math.abs(Number(demandTrend || 0)), 1) * 0.1, 0, 0.82),
    priority: priorityFromScore(riskScore),
    reason,
  };
};

const purchasePlannerRecommendation = ({
  availableStock = 0,
  pendingPurchaseQty = 0,
  averageDailySale = 0,
  targetStockDays = 7,
  purchaseCost = 0,
  sellingRate = 0,
} = {}) => {
  const velocity = Number(averageDailySale || 0);
  if (velocity <= 0) {
    return { status: "INSUFFICIENT_DATA", recommendedQuantity: 0, reason: "Needs sales velocity before purchase planning." };
  }
  const required = velocity * Number(targetStockDays || 7);
  const gap = Math.max(0, required - Number(availableStock || 0) - Number(pendingPurchaseQty || 0));
  const margin = grossMarginPercent({ sellingRate, purchaseCost });
  return {
    status: gap > 0 ? "RECOMMENDED" : "WAIT",
    recommendedQuantity: Number(gap.toFixed(2)),
    expectedCost: Number((gap * Number(purchaseCost || 0)).toFixed(2)),
    expectedMargin: margin,
    expectedStockDays: Number(((Number(availableStock || 0) + Number(pendingPurchaseQty || 0) + gap) / velocity).toFixed(1)),
    confidence: velocity >= 3 ? 0.7 : 0.52,
    priority: gap > velocity * 3 ? "HIGH" : gap > 0 ? "ATTENTION" : "INFO",
    reason: gap > 0 ? "Projected stock is below target coverage." : "Existing and pending stock cover the target period.",
  };
};

const wastePreventionScore = ({ ageDays = 0, remainingRatio = 0, averageDailySale = 0 } = {}) => {
  const age = Number(ageDays || 0);
  const remaining = Number(remainingRatio || 0);
  const velocity = Number(averageDailySale || 0);
  const score = clampScore(age * 5 + remaining * 45 - velocity * 4);
  const colorStatus = score >= 75 ? "Red" : score >= 55 ? "Orange" : score >= 32 ? "Yellow" : "Green";
  return {
    freshnessScore: clampScore(100 - score),
    expiryRisk: score >= 55 ? "HIGH" : score >= 32 ? "ATTENTION" : "LOW",
    wasteProbability: Number((score / 100).toFixed(2)),
    colorStatus,
    sellingPriority: colorStatus === "Red" ? "Priority Sale" : colorStatus === "Orange" ? "Move Front Display" : colorStatus === "Yellow" ? "Bundle Offer" : "Normal FIFO",
    discountRecommendation: colorStatus === "Red" ? "Flash Sale" : colorStatus === "Orange" ? "Small discount review" : "No discount needed",
  };
};

const customerIntelligenceSegment = ({ daysSincePurchase = null, purchaseCount = 0, lifetimeValue = 0, averageBasketValue = 0 } = {}) => {
  if (daysSincePurchase !== null && Number(daysSincePurchase) >= 30) return { segment: "INACTIVE", recommendation: "Customer inactive; review follow-up.", risk: "HIGH" };
  if (Number(lifetimeValue || 0) >= 50000 || Number(averageBasketValue || 0) >= 5000) return { segment: "VIP", recommendation: "Call VIP customer with seasonal basket.", risk: "LOW" };
  if (Number(purchaseCount || 0) >= 6) return { segment: "GROWING", recommendation: "Offer seasonal basket.", risk: "LOW" };
  return { segment: "REGULAR", recommendation: "Likely to return with normal service.", risk: "INFO" };
};

const supplierIntelligenceScore = ({ marginPercent = 0, returnPercent = 0, costIncreasePercent = 0, purchaseCount = 0 } = {}) => {
  const score = clampScore(65 + Number(marginPercent || 0) * 0.5 - Number(returnPercent || 0) * 1.2 - Math.max(0, Number(costIncreasePercent || 0)) * 0.9 + Math.min(Number(purchaseCount || 0), 20) * 0.5);
  return {
    score: Number(score.toFixed(1)),
    recommendation: score >= 75 ? "Preferred supplier" : score < 45 ? "Avoid supplier" : Number(costIncreasePercent || 0) > 8 ? "Price negotiation opportunity" : "Monitor supplier",
    reliability: score >= 75 ? "HIGH" : score >= 50 ? "MEDIUM" : "LOW",
  };
};

const businessHealthScore = ({ salesScore = 50, profitScore = 50, inventoryScore = 50, cashFlowScore = 50, wasteScore = 50, customerScore = 50, supplierScore = 50, outstandingScore = 50 } = {}) => {
  const score = clampScore((salesScore + profitScore + inventoryScore + cashFlowScore + wasteScore + customerScore + supplierScore + outstandingScore) / 8);
  return {
    score: Number(score.toFixed(1)),
    color: score >= 70 ? "Green" : score >= 45 ? "Yellow" : "Red",
  };
};

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
  dynamicPriceRecommendation,
  purchasePlannerRecommendation,
  wastePreventionScore,
  customerIntelligenceSegment,
  supplierIntelligenceScore,
  businessHealthScore,
};
