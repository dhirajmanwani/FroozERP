const MS_PER_DAY = 24 * 60 * 60 * 1000;

const toDateOnly = (value) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
};

const calculateOverdueDays = (dueDate, asOf = new Date()) => {
  const due = toDateOnly(dueDate);
  const today = toDateOnly(asOf);
  if (!due || !today) return null;
  return Math.max(0, Math.floor((today.getTime() - due.getTime()) / MS_PER_DAY));
};

const classifyDueStatus = (dueDate, asOf = new Date(), thresholds = {}) => {
  const due = toDateOnly(dueDate);
  const today = toDateOnly(asOf);
  if (!due || !today) return "NO_DUE_DATE";
  const daysUntilDue = Math.floor((due.getTime() - today.getTime()) / MS_PER_DAY);
  const overdueDays = Math.max(0, -daysUntilDue);
  if (overdueDays >= Number(thresholds.criticalOverdueDays ?? 45)) return "CRITICAL_OUTSTANDING";
  if (overdueDays >= Number(thresholds.seriousOverdueDays ?? 21)) return "SERIOUSLY_OVERDUE";
  if (overdueDays > 0) return "OVERDUE";
  if (daysUntilDue === 0) return "DUE_TODAY";
  if (daysUntilDue <= Number(thresholds.dueSoonDays ?? 3)) return "DUE_SOON";
  return "CURRENT";
};

const classifyCustomerRisk = ({ overdueDays = 0, outstanding = 0 } = {}, thresholds = {}) => {
  const amount = Number(outstanding || 0);
  if (amount <= 0) return "NONE";
  if (overdueDays >= Number(thresholds.criticalOverdueDays ?? 45) || amount >= Number(thresholds.criticalOutstandingAmount ?? 100000)) return "CRITICAL";
  if (overdueDays >= Number(thresholds.seriousOverdueDays ?? 21) || amount >= Number(thresholds.highOutstandingAmount ?? 50000)) return "HIGH";
  if (overdueDays > 0) return "ATTENTION";
  return "NORMAL";
};

const forecastStockRunout = ({ availableStock = 0, dailySales = [], minimumHistoryDays = 3 } = {}) => {
  const stock = Number(availableStock || 0);
  const quantities = (dailySales || []).map((row) => Number(row.quantity || row.qty || 0)).filter((qty) => qty > 0);
  if (quantities.length < Number(minimumHistoryDays || 3)) {
    return { status: "INSUFFICIENT_SALES_HISTORY", daysRemaining: null, averageDailySold: null };
  }
  const averageDailySold = quantities.reduce((sum, qty) => sum + qty, 0) / quantities.length;
  if (averageDailySold <= 0) return { status: "INSUFFICIENT_SALES_HISTORY", daysRemaining: null, averageDailySold: null };
  return {
    status: stock <= 0 ? "OUT_OF_STOCK" : "FORECAST_READY",
    daysRemaining: stock <= 0 ? 0 : Number((stock / averageDailySold).toFixed(1)),
    averageDailySold: Number(averageDailySold.toFixed(3)),
  };
};

const buildReminderDedupKey = ({ companyId = 1, branchId = 1, reminderType, entityType, entityId, dueDate }) =>
  [companyId, branchId, reminderType, entityType, entityId || "none", dueDate || "none"].join(":");

const assertGroundedAnswer = ({ answer = "", facts = [] } = {}) => {
  const unsupportedMoney = answer.match(/(?:₹|Rs\.?|INR)\s*\d[\d,]*(?:\.\d+)?/gi) || [];
  const factText = JSON.stringify(facts || []);
  const numericFacts = new Set((factText.match(/-?\d+(?:\.\d+)?/g) || []).map((value) => Number(value).toFixed(2)));
  return unsupportedMoney.every((amount) => {
    const normalized = amount.replace(/(?:₹|Rs\.?|INR|\s|,)/gi, "");
    return numericFacts.has(Number(normalized).toFixed(2));
  });
};

module.exports = {
  calculateOverdueDays,
  classifyDueStatus,
  classifyCustomerRisk,
  forecastStockRunout,
  buildReminderDedupKey,
  assertGroundedAnswer,
};
