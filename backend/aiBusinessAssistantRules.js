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

// FROST's one non-negotiable rule: the model phrases, the database answers. No figure may
// originate in generated text.
//
// This used to match only numbers carrying a currency prefix -- /(?:₹|Rs\.?|INR)\s*\d.../ -- while
// the answers it guards are built by `buildDeterministicAnswer`, which emits bare numbers
// ("sales 48250, estimated gross profit 9110"). The match array was therefore always empty,
// `.every()` over an empty array is `true`, and the guard passed everything ever put to it. It read
// like a safety net and caught nothing, which is worse than having none: the route around it says
// `if (!assertGroundedAnswer(...)) return 500`, and that line has never once been able to fire.
//
// `generated` defaults to `true` so a caller that forgets to say gets the strict check rather than
// a silent pass. A deterministic answer is grounded by construction -- we built it out of the facts
// -- and policing our own formatting only produces false alarms, so the route passes
// `generated: false` for that path and the check does real work exactly when a model wrote the
// words.
//
// `allowedText` is for text we inserted ourselves that carries digits of its own, such as the
// period label "01/09/2026 to 20/09/2026". Without it, our own date range would read as an
// ungrounded figure.
const assertGroundedAnswer = ({ answer = "", facts = [], allowedText = "", generated = true } = {}) => {
  if (!generated) return true;
  const normalize = (value) => Number(String(value).replace(/,/g, "")).toFixed(2);
  const numbersIn = (text) => String(text || "").match(/-?\d[\d,]*(?:\.\d+)?/g) || [];
  const grounded = new Set([
    ...numbersIn(JSON.stringify(facts || [])),
    ...numbersIn(allowedText),
  ].map(normalize));
  return numbersIn(answer).every((value) => grounded.has(normalize(value)));
};

module.exports = {
  calculateOverdueDays,
  classifyDueStatus,
  classifyCustomerRisk,
  forecastStockRunout,
  buildReminderDedupKey,
  assertGroundedAnswer,
};
