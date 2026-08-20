const {
  calculateOverdueDays,
  classifyDueStatus,
  classifyCustomerRisk,
  forecastStockRunout,
  buildReminderDedupKey,
  assertGroundedAnswer,
} = require("./aiBusinessAssistantRules");
const {
  DEFAULT_FROST_SETTINGS,
  FROST_ASSISTANT_NAME,
  FrostServiceLayer,
  classifyBusinessIntent,
} = require("./frostCore");
const {
  containsSensitiveMemory,
  normalizeMemoryType,
  stockOutPrediction,
  salesRangePrediction,
  grossMarginPercent,
  wasteAdjustedMargin,
  dedupeAlertKey,
  dynamicPriceRecommendation,
  purchasePlannerRecommendation,
  wastePreventionScore,
  customerIntelligenceSegment,
  supplierIntelligenceScore,
  businessHealthScore,
} = require("./frostIntelligence");

const DEFAULT_THRESHOLDS = {
  dueSoonDays: 3,
  seriousOverdueDays: 21,
  criticalOverdueDays: 45,
  criticalOutstandingAmount: 100000,
  highOutstandingAmount: 50000,
  lowStockDays: 7,
  slowMovingDays: 30,
  lotAgingDays: 20,
  purchaseBillPendingDays: 3,
  rebateDeadlineDays: 2,
  lowMarginPercent: 8,
  highDiscountPercent: 10,
  highValueBillAmount: 25000,
  expenseSpikeMultiplier: 2,
};

const SUGGESTED_QUESTIONS = [
  "What needs my attention today?",
  "Which customer payments are overdue?",
  "What supplier bills are pending?",
  "Which items are low in stock?",
  "Which stock lots are aging or likely to expire?",
  "What was today's sales and gross profit?",
  "Which items generated the most profit this month?",
  "Where did I lose money this month?",
  "Which customers have become inactive?",
  "What should I purchase tomorrow?",
  "What is my current cash, bank, receivable and payable position?",
  "Which sale rates may need revision?",
];

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");
const parsePositiveInteger = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const toNumber = (value) => Number(value || 0);
const roundCurrency = (value) => Number(toNumber(value).toFixed(2));
const clampNumber = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Number(value || 0)));
const toDateKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
};
const addDays = (date, days) => {
  const next = new Date(`${toDateKey(date)}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return toDateKey(next);
};

const getRange = (query = {}) => {
  const today = toDateKey(new Date());
  const range = String(query.range || "today").toLowerCase();
  if (query.date_from && query.date_to) {
    return { dateFrom: toDateKey(query.date_from), dateTo: toDateKey(query.date_to), label: `${toDateKey(query.date_from)} to ${toDateKey(query.date_to)}` };
  }
  if (range === "yesterday") {
    const yesterday = addDays(today, -1);
    return { dateFrom: yesterday, dateTo: yesterday, label: "Yesterday" };
  }
  if (range === "last_7_days" || range === "7") return { dateFrom: addDays(today, -6), dateTo: today, label: "Last 7 Days" };
  if (range === "this_month" || range === "month") return { dateFrom: today.slice(0, 8) + "01", dateTo: today, label: "This Month" };
  return { dateFrom: today, dateTo: today, label: "Today" };
};

const maskPhone = (value) => {
  const text = cleanText(value);
  if (text.length < 4) return "";
  return `${"*".repeat(Math.max(0, text.length - 4))}${text.slice(-4)}`;
};

const severityFromRisk = (risk) => {
  if (risk === "CRITICAL" || risk === "CRITICAL_OUTSTANDING") return "CRITICAL";
  if (risk === "HIGH" || risk === "SERIOUSLY_OVERDUE") return "HIGH";
  if (risk === "ATTENTION" || risk === "OVERDUE" || risk === "DUE_TODAY") return "ATTENTION";
  return "INFO";
};

const normalizeRoleName = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, "_");
const isOwnerIdentity = (identity = {}) => identity.is_owner === true || normalizeRoleName(identity.role) === "OWNER";
const buildFrostPolicy = (identity = {}, actionClass = "READ_ONLY") => {
  const authenticated = identity.authenticated === true;
  if (!authenticated) {
    return {
      allowed: false,
      actionClass,
      approvalRequired: false,
      reason: "Authentication is required.",
      errorCode: "AUTHENTICATION_REQUIRED",
    };
  }
  if (actionClass === "READ_ONLY") {
    return { allowed: true, actionClass, approvalRequired: false, reason: "Read-only business information." };
  }
  if (actionClass === "SAFE_PERSONAL_WRITE") {
    return { allowed: true, actionClass, approvalRequired: false, reason: "Safe personal FROST action." };
  }
  if (actionClass === "BUSINESS_WRITE") {
    return {
      allowed: true,
      actionClass,
      approvalRequired: true,
      reason: "Business data changes require a structured confirmation before execution.",
    };
  }
  return {
    allowed: isOwnerIdentity(identity),
    actionClass,
    approvalRequired: true,
    reason: "High-risk actions require authenticated Owner confirmation.",
    errorCode: isOwnerIdentity(identity) ? null : "OWNER_CONFIRMATION_REQUIRED",
  };
};

const requireAiPermission = async ({ req, res, getPermissionUser, getCanonicalIdentity, permission, fallbackRoles = ["Owner", "Admin"], actionClass = "READ_ONLY" }) => {
  // A-4: the caller is whoever the signed session says, and nothing else.
  //
  // This read used to be `req.query.user_id || req.body?.user_id || req.headers["x-user-id"]`,
  // which is the *opposite* precedence to the one `submittedIdentityFrom` uses when it checks a
  // request against its token (header first). A signed-in Cashier could therefore send
  // `x-user-id: <own id>` — satisfying the substitution check — alongside `?user_id: <owner id>`,
  // and every one of these 42 routes would run with Owner authority. The substitution check is not
  // a substitute for reading the verified claim.
  const userId = req?.auth?.userId;
  if (!userId) {
    // Unreachable behind the default-deny gate, and deliberately not a fallback to a request field:
    // if this ever runs unauthenticated it must refuse rather than resurrect the hole above.
    res.status(401).json({
      code: "FROST_SESSION_REQUIRED",
      message: "An authenticated session is required for FROST features",
      action_class: actionClass,
    });
    return null;
  }
  const user = await getPermissionUser(userId, permission, fallbackRoles);
  if (!user) {
    res.status(403).json({
      code: "FROST_PERMISSION_DENIED",
      message: "You do not have permission to use this FROST feature",
      action_class: actionClass,
    });
    return null;
  }
  const identity = getCanonicalIdentity
    ? await getCanonicalIdentity({ userId: user.id, sessionId: req.body?.session_id || req.headers["x-session-id"] })
    : {
        user_id: user.id,
        username: user.username || "",
        role: normalizeRoleName(user.role_name),
        is_owner: normalizeRoleName(user.role_name) === "OWNER",
        branch_id: user.branch_id || 1,
        permissions: user.permissions || {},
        authenticated: true,
        session_id: `local-user-${user.id}`,
      };
  const policy = buildFrostPolicy(identity, actionClass);
  if (!policy.allowed) {
    res.status(policy.errorCode === "AUTHENTICATION_REQUIRED" ? 401 : 403).json({
      code: policy.errorCode || "FROST_ACTION_NOT_ALLOWED",
      message: policy.reason,
      identity,
      policy,
    });
    return null;
  }
  return { ...user, identity, frostPolicy: policy };
};

const getAiSettings = async (pool, frost = new FrostServiceLayer({ pool })) => {
  const result = await pool.query("SELECT * FROM ai_settings WHERE id = 1");
  const row = result.rows[0] || {};
  const frostSettings = await frost.getSettings();
  return {
    ...row,
    thresholds: { ...DEFAULT_THRESHOLDS, ...(row.thresholds || {}) },
    frost: { ...DEFAULT_FROST_SETTINGS, ...(row.frost_settings || {}), assistantName: FROST_ASSISTANT_NAME },
    provider: frostSettings.provider,
    providers: frostSettings.providers,
    engines: frostSettings.engines,
    cache: frostSettings.cache,
  };
};

const buildFact = (type, sourceModule, periodLabel, rows, summary = {}) => ({
  type,
  sourceModule,
  periodLabel,
  rows,
  summary,
  metadata: {
    source_module: sourceModule,
    period: periodLabel,
    record_count: Array.isArray(rows) ? rows.length : 0,
    last_refreshed_at: new Date().toISOString(),
  },
});

const getCustomerOutstanding = async (pool, settings) => {
  const result = await pool.query(`
    WITH credit_sales AS (
      SELECT
        COALESCE(s.customer_id, c.id) AS customer_id,
        MAX(COALESCE(c.customer_name, s.customer_name, 'Walk-in Customer')) AS customer_name,
        MAX(c.mobile_number) AS mobile_number,
        SUM(CASE WHEN s.payment_mode = 'CREDIT' AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED' THEN s.total_amount ELSE 0 END) AS credit_amount,
        MIN(CASE WHEN s.payment_mode = 'CREDIT' AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED' THEN s.sale_date END) AS oldest_invoice_date,
        MIN(CASE WHEN s.payment_mode = 'CREDIT' AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED' THEN s.due_date END) AS oldest_due_date
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      GROUP BY COALESCE(s.customer_id, c.id)
    ),
    payments AS (
      SELECT customer_id, SUM(payment_amount) AS paid_amount, MAX(payment_date) AS last_payment_date
      FROM customer_payments
      WHERE cancelled IS DISTINCT FROM TRUE
      GROUP BY customer_id
    ),
    returns AS (
      SELECT s.customer_id, SUM(sr.total_return_amount) AS returned_amount
      FROM sale_returns sr
      JOIN sales s ON s.id = sr.sale_id
      WHERE sr.refund_type IN ('CREDIT_NOTE', 'FUTURE_ADJUSTMENT')
      GROUP BY s.customer_id
    )
    SELECT
      cs.customer_id,
      cs.customer_name,
      cs.mobile_number,
      cs.oldest_invoice_date,
      cs.oldest_due_date,
      COALESCE(p.last_payment_date, NULL) AS last_payment_date,
      GREATEST(COALESCE(cs.credit_amount, 0) - COALESCE(p.paid_amount, 0) - COALESCE(r.returned_amount, 0), 0) AS outstanding_amount
    FROM credit_sales cs
    LEFT JOIN payments p ON p.customer_id = cs.customer_id
    LEFT JOIN returns r ON r.customer_id = cs.customer_id
    WHERE GREATEST(COALESCE(cs.credit_amount, 0) - COALESCE(p.paid_amount, 0) - COALESCE(r.returned_amount, 0), 0) > 0
    ORDER BY outstanding_amount DESC, oldest_due_date NULLS LAST
    LIMIT 50
  `);
  const rows = result.rows.map((row) => {
    const overdueDays = calculateOverdueDays(row.oldest_due_date);
    const risk = classifyCustomerRisk({ overdueDays: overdueDays || 0, outstanding: row.outstanding_amount }, settings.thresholds);
    return {
      ...row,
      mobile_number: maskPhone(row.mobile_number),
      outstanding_amount: roundCurrency(row.outstanding_amount),
      overdue_days: overdueDays,
      due_status: classifyDueStatus(row.oldest_due_date, new Date(), settings.thresholds),
      risk_classification: risk,
      promised_payment_date: null,
      average_payment_delay_days: null,
    };
  });
  return buildFact("customer_outstanding", "Accounts", "Current outstanding", rows, {
    totalOutstanding: roundCurrency(rows.reduce((sum, row) => sum + row.outstanding_amount, 0)),
    count: rows.length,
  });
};

const getOverdueCustomerInvoices = async (pool, settings) => {
  const outstanding = await getCustomerOutstanding(pool, settings);
  const rows = outstanding.rows.filter((row) => ["OVERDUE", "SERIOUSLY_OVERDUE", "CRITICAL_OUTSTANDING"].includes(row.due_status));
  return buildFact("overdue_customer_invoices", "Customer Ledgers", "Current outstanding", rows, {
    totalOverdue: roundCurrency(rows.reduce((sum, row) => sum + row.outstanding_amount, 0)),
    count: rows.length,
  });
};

const getSupplierOutstanding = async (pool) => {
  const result = await pool.query(`
    SELECT
      p.supplier_id,
      COALESCE(s.supplier_name, p.supplier_name, 'Supplier') AS supplier_name,
      MIN(COALESCE(p.bill_date, p.purchase_date)) AS oldest_purchase_date,
      SUM(COALESCE(p.balance_amount, 0)) AS outstanding_amount,
      COUNT(*) FILTER (WHERE p.purchase_bill_status = 'BILL_PENDING') AS pending_bill_count
    FROM purchases p
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
      AND COALESCE(p.balance_amount, 0) > 0
    GROUP BY p.supplier_id, COALESCE(s.supplier_name, p.supplier_name, 'Supplier')
    ORDER BY outstanding_amount DESC
    LIMIT 50
  `);
  const rows = result.rows.map((row) => ({ ...row, outstanding_amount: roundCurrency(row.outstanding_amount) }));
  return buildFact("supplier_outstanding", "Purchases", "Current outstanding", rows, {
    totalOutstanding: roundCurrency(rows.reduce((sum, row) => sum + row.outstanding_amount, 0)),
    count: rows.length,
  });
};

const getPendingPurchaseBills = async (pool) => {
  const result = await pool.query(`
    SELECT p.id, p.supplier_id, COALESCE(s.supplier_name, p.supplier_name, 'Supplier') AS supplier_name,
           p.purchase_date, p.bill_number, p.net_payable, p.balance_amount, p.purchase_bill_status,
           DATE_PART('day', CURRENT_DATE::timestamp - COALESCE(p.purchase_date, CURRENT_DATE)::timestamp)::INTEGER AS pending_days
    FROM purchases p
    LEFT JOIN suppliers s ON s.id = p.supplier_id
    WHERE COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
      AND p.purchase_bill_status = 'BILL_PENDING'
    ORDER BY p.purchase_date, p.id
    LIMIT 50
  `);
  const rows = result.rows.map((row) => ({ ...row, net_payable: roundCurrency(row.net_payable), balance_amount: roundCurrency(row.balance_amount) }));
  return buildFact("pending_purchase_bills", "Pending Bills", "Current pending purchase bills", rows, { count: rows.length });
};

const getLowStockProducts = async (pool) => {
  const result = await pool.query(`
    SELECT p.id, p.product_name, p.category, p.unit, COALESCE(p.minimum_stock, 0) AS minimum_stock,
           COALESCE(SUM(CASE WHEN COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED' THEN ib.remaining_qty ELSE 0 END), 0) AS available_stock,
           COUNT(ib.id) FILTER (WHERE COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED') AS lot_count
    FROM products p
    LEFT JOIN inventory_batches ib ON ib.product_id = p.id
    WHERE p.active IS DISTINCT FROM FALSE
    GROUP BY p.id
    HAVING COALESCE(SUM(CASE WHEN COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED' THEN ib.remaining_qty ELSE 0 END), 0) <= GREATEST(COALESCE(p.minimum_stock, 0), 0)
    ORDER BY available_stock ASC, p.product_name
    LIMIT 50
  `);
  const rows = result.rows.map((row) => ({
    ...row,
    available_stock: Number(row.available_stock || 0),
    minimum_stock: Number(row.minimum_stock || 0),
    severity: Number(row.available_stock || 0) <= 0 ? "CRITICAL" : "HIGH",
  }));
  return buildFact("low_stock_products", "Inventory Lots", "Current stock", rows, { count: rows.length });
};

const getStockRunoutForecast = async (pool) => {
  const productResult = await pool.query(`
    SELECT p.id, p.product_name, p.unit, COALESCE(SUM(ib.remaining_qty), 0) AS available_stock
    FROM products p
    LEFT JOIN inventory_batches ib ON ib.product_id = p.id AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
    WHERE p.active IS DISTINCT FROM FALSE
    GROUP BY p.id
    ORDER BY p.product_name
    LIMIT 50
  `);
  const rows = [];
  for (const product of productResult.rows) {
    const salesResult = await pool.query(`
      SELECT s.sale_date, SUM(si.quantity) AS quantity
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE si.product_id = $1
        AND s.sale_date >= CURRENT_DATE - INTERVAL '14 days'
        AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
      GROUP BY s.sale_date
      ORDER BY s.sale_date DESC
    `, [product.id]);
    rows.push({
      ...product,
      available_stock: Number(product.available_stock || 0),
      forecast: forecastStockRunout({ availableStock: product.available_stock, dailySales: salesResult.rows }),
    });
  }
  return buildFact("stock_runout_forecast", "Inventory Lots", "Last 14 days sales", rows, { count: rows.length });
};

const getDailySalesSummary = async (pool, range) => {
  const result = await pool.query(`
    SELECT COUNT(*)::INTEGER AS bill_count,
           COALESCE(SUM(total_amount), 0) AS total_sales,
           COALESCE(SUM(profit), 0) AS estimated_profit,
           COALESCE(SUM(invoice_discount_amount + item_discount_amount), 0) AS discount_amount
    FROM sales
    WHERE sale_date BETWEEN $1 AND $2
      AND COALESCE(sale_status, 'COMPLETED') <> 'CANCELLED'
  `, [range.dateFrom, range.dateTo]);
  return buildFact("daily_sales_summary", "POS Billing", range.label, [], {
    billCount: Number(result.rows[0]?.bill_count || 0),
    totalSales: roundCurrency(result.rows[0]?.total_sales),
    estimatedGrossProfit: roundCurrency(result.rows[0]?.estimated_profit),
    discountAmount: roundCurrency(result.rows[0]?.discount_amount),
  });
};

const getGrossProfitSummary = async (pool, range) => getDailySalesSummary(pool, range);

const getExpenseSummary = async (pool, range) => {
  const result = await pool.query(`
    SELECT category, COALESCE(SUM(amount), 0) AS total_amount, COUNT(*)::INTEGER AS expense_count
    FROM expenses
    WHERE expense_date BETWEEN $1 AND $2 AND COALESCE(status, 'ACTIVE') <> 'CANCELLED'
    GROUP BY category
    ORDER BY total_amount DESC
    LIMIT 20
  `, [range.dateFrom, range.dateTo]);
  const rows = result.rows.map((row) => ({ ...row, total_amount: roundCurrency(row.total_amount) }));
  return buildFact("expense_summary", "Expenses", range.label, rows, {
    totalExpenses: roundCurrency(rows.reduce((sum, row) => sum + row.total_amount, 0)),
  });
};

const getWasteSummary = async (pool, range) => {
  const result = await pool.query(`
    SELECT p.product_name, SUM(w.quantity) AS waste_quantity, SUM(w.cost_amount) AS cost_amount
    FROM waste_entries w
    LEFT JOIN products p ON p.id = w.product_id
    WHERE w.waste_date BETWEEN $1 AND $2
    GROUP BY p.product_name
    ORDER BY cost_amount DESC NULLS LAST, waste_quantity DESC
    LIMIT 20
  `, [range.dateFrom, range.dateTo]);
  const rows = result.rows.map((row) => ({ ...row, waste_quantity: Number(row.waste_quantity || 0), cost_amount: roundCurrency(row.cost_amount) }));
  return buildFact("waste_summary", "Waste", range.label, rows, {
    totalWasteCost: roundCurrency(rows.reduce((sum, row) => sum + row.cost_amount, 0)),
  });
};

const getProductSalesRanking = async (pool, range) => {
  const result = await pool.query(`
    SELECT p.id AS product_id, p.product_name, p.unit,
           SUM(si.quantity) AS quantity_sold,
           SUM(si.amount) AS sale_amount,
           SUM(si.profit) AS profit_amount
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    LEFT JOIN products p ON p.id = si.product_id
    WHERE s.sale_date BETWEEN $1 AND $2
      AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
    GROUP BY p.id, p.product_name, p.unit
    ORDER BY quantity_sold DESC
    LIMIT 20
  `, [range.dateFrom, range.dateTo]);
  const rows = result.rows.map((row) => ({
    ...row,
    quantity_sold: Number(row.quantity_sold || 0),
    sale_amount: roundCurrency(row.sale_amount),
    profit_amount: roundCurrency(row.profit_amount),
  }));
  return buildFact("product_sales_ranking", "Sales History", range.label, rows, {
    highestSelling: rows.slice(0, 5),
    lowestSelling: rows.slice(-5).reverse(),
  });
};

const getInventoryNearingExpiry = async (pool, settings) => {
  const agingDays = Number(settings.thresholds.lotAgingDays || 20);
  const result = await pool.query(`
    SELECT ib.id, ib.product_id, p.product_name, ib.lot_name, ib.lot_size, ib.purchase_date,
           ib.remaining_qty, ib.unit,
           DATE_PART('day', CURRENT_DATE::timestamp - COALESCE(ib.purchase_date, CURRENT_DATE)::timestamp)::INTEGER AS lot_age_days
    FROM inventory_batches ib
    LEFT JOIN products p ON p.id = ib.product_id
    WHERE COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
      AND COALESCE(ib.remaining_qty, 0) > 0
      AND COALESCE(ib.purchase_date, CURRENT_DATE) <= CURRENT_DATE - ($1::TEXT || ' days')::interval
    ORDER BY lot_age_days DESC, ib.remaining_qty DESC
    LIMIT 30
  `, [agingDays]);
  const rows = result.rows.map((row) => ({ ...row, remaining_qty: Number(row.remaining_qty || 0) }));
  return buildFact("inventory_nearing_expiry", "Inventory Lots", `Lots older than ${agingDays} days`, rows, { count: rows.length });
};

const getCustomerActivitySummary = async (pool) => {
  const result = await pool.query(`
    SELECT c.id AS customer_id, c.customer_name, MAX(s.sale_date) AS last_purchase_date,
           DATE_PART('day', CURRENT_DATE::timestamp - MAX(s.sale_date)::timestamp)::INTEGER AS days_since_purchase,
           COUNT(s.id)::INTEGER AS purchase_count,
           COALESCE(SUM(s.total_amount), 0) AS total_sales
    FROM customers c
    LEFT JOIN sales s ON s.customer_id = c.id AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
    WHERE c.active IS DISTINCT FROM FALSE AND c.system_account IS DISTINCT FROM TRUE
    GROUP BY c.id, c.customer_name
    HAVING MAX(s.sale_date) IS NULL OR MAX(s.sale_date) <= CURRENT_DATE - INTERVAL '30 days'
    ORDER BY last_purchase_date NULLS FIRST, total_sales DESC
    LIMIT 30
  `);
  const rows = result.rows.map((row) => ({ ...row, total_sales: roundCurrency(row.total_sales) }));
  return buildFact("inactive_customers", "Customer Ledgers", "No purchase in 30+ days", rows, { count: rows.length });
};

const getCashDrawerSummary = async (pool, range) => {
  const result = await pool.query(`
    WITH cash_in AS (
      SELECT COALESCE(SUM(sp.amount), 0) AS amount
      FROM sale_payments sp
      JOIN sales s ON s.id = sp.sale_id
      WHERE s.sale_date BETWEEN $1 AND $2
        AND sp.payment_mode = 'CASH'
        AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
      UNION ALL
      SELECT COALESCE(SUM(payment_amount), 0) AS amount
      FROM customer_payments
      WHERE payment_date BETWEEN $1 AND $2 AND payment_mode = 'CASH' AND cancelled IS DISTINCT FROM TRUE
    ),
    cash_out AS (
      SELECT COALESCE(SUM(amount), 0) AS amount
      FROM expenses
      WHERE expense_date BETWEEN $1 AND $2 AND payment_mode = 'CASH' AND COALESCE(status, 'ACTIVE') <> 'CANCELLED'
      UNION ALL
      SELECT COALESCE(SUM(payment_amount), 0) AS amount
      FROM supplier_payments
      WHERE payment_date BETWEEN $1 AND $2 AND payment_mode = 'CASH' AND cancelled IS DISTINCT FROM TRUE
    )
    SELECT
      (SELECT COALESCE(SUM(amount), 0) FROM cash_in) AS cash_in,
      (SELECT COALESCE(SUM(amount), 0) FROM cash_out) AS cash_out
  `, [range.dateFrom, range.dateTo]);
  const cashIn = roundCurrency(result.rows[0]?.cash_in);
  const cashOut = roundCurrency(result.rows[0]?.cash_out);
  return buildFact("cash_drawer_summary", "Payments", range.label, [], {
    cashIn,
    cashOut,
    expectedDrawerCash: roundCurrency(cashIn - cashOut),
  });
};

const getSupplierMarginSummary = async (pool, range) => {
  const result = await pool.query(`
    SELECT COALESCE(sup.supplier_name, ib.supplier_name, 'Supplier') AS supplier_name,
           SUM(si.amount) AS sale_amount,
           SUM(si.cost_amount) AS cost_amount,
           SUM(si.profit) AS profit_amount,
           CASE WHEN SUM(si.amount) > 0 THEN (SUM(si.profit) / SUM(si.amount)) * 100 ELSE 0 END AS margin_percent
    FROM sale_batch_allocations siba
    JOIN sale_items si ON si.id = siba.sale_item_id
    JOIN sales s ON s.id = si.sale_id
    LEFT JOIN inventory_batches ib ON ib.id = siba.inventory_batch_id
    LEFT JOIN suppliers sup ON sup.id = ib.supplier_id
    WHERE s.sale_date BETWEEN $1 AND $2
      AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
    GROUP BY COALESCE(sup.supplier_name, ib.supplier_name, 'Supplier')
    ORDER BY margin_percent DESC, profit_amount DESC
    LIMIT 20
  `, [range.dateFrom, range.dateTo]);
  const rows = result.rows.map((row) => ({
    ...row,
    sale_amount: roundCurrency(row.sale_amount),
    cost_amount: roundCurrency(row.cost_amount),
    profit_amount: roundCurrency(row.profit_amount),
    margin_percent: Number(toNumber(row.margin_percent).toFixed(2)),
  }));
  return buildFact("supplier_margin_summary", "Purchases", range.label, rows, { count: rows.length });
};

const getMemoryRows = async (pool, query = {}) => {
  const values = [];
  const filters = ["company_id = 1"];
  if (query.status) {
    values.push(String(query.status).toUpperCase());
    filters.push(`approval_status = $${values.length}`);
  }
  if (query.type) {
    values.push(normalizeMemoryType(query.type));
    filters.push(`memory_type = $${values.length}`);
  }
  if (query.entity_type) {
    values.push(cleanText(query.entity_type));
    filters.push(`entity_type = $${values.length}`);
  }
  if (query.search) {
    values.push(`%${cleanText(query.search).toLowerCase()}%`);
    filters.push(`(LOWER(title) LIKE $${values.length} OR LOWER(content) LIKE $${values.length})`);
  }
  const result = await pool.query(
    `
    SELECT *
    FROM frost_memories
    WHERE ${filters.join(" AND ")}
    ORDER BY approval_status = 'PENDING_OWNER_APPROVAL' DESC, updated_at DESC, id DESC
    LIMIT 200
    `,
    values
  );
  return result.rows;
};

const buildMemoryDraftFromText = (text = "") => {
  const content = cleanText(text);
  const lower = content.toLowerCase();
  let memoryType = "approved_ai_observations";
  let entityType = "";
  if (lower.includes("prefer")) memoryType = "owner_preferences";
  if (lower.includes("customer") || lower.includes("traders")) {
    memoryType = "customer_notes";
    entityType = "customer";
  }
  if (lower.includes("supplier")) {
    memoryType = "supplier_notes";
    entityType = "supplier";
  }
  if (lower.includes("stock") || lower.includes("purchase") || lower.includes("mango") || lower.includes("apple")) {
    memoryType = "product_notes";
    entityType = "product";
  }
  if (lower.includes("usually") || lower.includes("normally")) memoryType = "recurring_patterns";
  return {
    memory_type: memoryType,
    entity_type: entityType,
    title: content.slice(0, 90) || "FROST memory proposal",
    content,
    confidence: lower.includes("remember") ? 0.85 : 0.55,
  };
};

const getInventoryPredictions = async (pool) => {
  const productResult = await pool.query(`
    SELECT p.id, p.product_name, p.unit, COALESCE(p.minimum_stock, 0) AS minimum_stock,
           COALESCE(SUM(CASE WHEN COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED' THEN ib.remaining_qty ELSE 0 END), 0) AS available_stock
    FROM products p
    LEFT JOIN inventory_batches ib ON ib.product_id = p.id
    WHERE p.active IS DISTINCT FROM FALSE
    GROUP BY p.id
    ORDER BY p.product_name
    LIMIT 80
  `);
  const predictions = [];
  for (const product of productResult.rows) {
    const salesResult = await pool.query(`
      SELECT s.sale_date, SUM(si.quantity) AS quantity
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE si.product_id = $1
        AND s.sale_date >= CURRENT_DATE - INTERVAL '21 days'
        AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
      GROUP BY s.sale_date
      ORDER BY s.sale_date
    `, [product.id]);
    const prediction = stockOutPrediction({ availableStock: product.available_stock, dailySales: salesResult.rows });
    predictions.push({
      type: "inventory_stockout",
      entity_type: "product",
      entity_id: product.id,
      title: `${product.product_name} stock forecast`,
      product_name: product.product_name,
      prediction_period: prediction.predictionPeriod || "Next 7 days",
      data_used: { sales_days: salesResult.rows.length, available_stock: Number(product.available_stock || 0), minimum_stock: Number(product.minimum_stock || 0) },
      confidence: prediction.confidence || 0,
      reason: prediction.reason,
      minimum_data_requirement: prediction.minimumDataRequirement,
      recommendation: prediction.status === "READY" && prediction.daysUntilStockOut <= 7 ? "Review purchase or transfer stock." : "No urgent reorder prediction.",
      payload: prediction,
    });
  }
  return predictions;
};

const getSalesPredictions = async (pool) => {
  const result = await pool.query(`
    SELECT sale_date, SUM(total_amount) AS amount, SUM(profit) AS profit
    FROM sales
    WHERE sale_date >= CURRENT_DATE - INTERVAL '35 days'
      AND COALESCE(sale_status, 'COMPLETED') <> 'CANCELLED'
    GROUP BY sale_date
    ORDER BY sale_date
  `);
  const nextDay = salesRangePrediction({ dailySales: result.rows, minimumDataDays: 7, periodLabel: "Next day" });
  const nextWeek = salesRangePrediction({ dailySales: result.rows, minimumDataDays: 14, periodLabel: "Next 7 days" });
  return [
    {
      type: "sales_next_day",
      title: "Next-day expected sales range",
      prediction_period: "Next day",
      data_used: { sales_days: result.rows.length },
      confidence: nextDay.confidence || 0,
      reason: nextDay.reason,
      minimum_data_requirement: nextDay.minimumDataRequirement,
      recommendation: nextDay.status === "READY" ? "Use this as a planning range, not an exact forecast." : "Collect more sales history before forecasting.",
      payload: nextDay,
    },
    {
      type: "sales_next_7_days",
      title: "Next-7-day expected sales range",
      prediction_period: "Next 7 days",
      data_used: { sales_days: result.rows.length },
      confidence: nextWeek.confidence || 0,
      reason: nextWeek.reason,
      minimum_data_requirement: nextWeek.minimumDataRequirement,
      recommendation: nextWeek.status === "READY" ? "Compare purchases and staffing against this range." : "Insufficient history for weekly range.",
      payload: nextWeek,
    },
  ];
};

const getCashflowPredictions = async (pool, settings) => {
  const [customers, suppliers, pending] = await Promise.all([
    getCustomerOutstanding(pool, settings),
    getSupplierOutstanding(pool),
    getPendingPurchaseBills(pool),
  ]);
  const projectedIn = customers.summary.totalOutstanding * 0.35;
  const projectedOut = suppliers.summary.totalOutstanding + pending.rows.reduce((sum, row) => sum + Number(row.balance_amount || 0), 0);
  return [{
    type: "cashflow_7_day",
    title: "Projected cash requirement",
    prediction_period: "Next 7 days",
    data_used: { customer_outstanding: customers.summary.totalOutstanding, supplier_outstanding: suppliers.summary.totalOutstanding, pending_purchase_bills: pending.summary.count },
    confidence: customers.summary.count + suppliers.summary.count >= 2 ? 0.55 : 0.25,
    reason: "Receivable and payable balances with conservative expected collection ratio.",
    minimum_data_requirement: "At least customer or supplier balances",
    recommendation: projectedOut > projectedIn ? "Review collections before supplier payouts." : "Cashflow pressure appears manageable.",
    payload: { expectedCustomerCollectionsRange: [roundCurrency(projectedIn * 0.5), roundCurrency(projectedIn)], projectedCashRequirement: roundCurrency(projectedOut), projectedShortfallRisk: projectedOut > projectedIn ? "ATTENTION" : "LOW" },
  }];
};

const getWastePredictions = async (pool) => {
  const result = await pool.query(`
    SELECT p.id AS product_id, p.product_name, SUM(w.quantity) AS waste_quantity, SUM(w.cost_amount) AS waste_cost,
           COUNT(DISTINCT w.waste_date)::INTEGER AS waste_days
    FROM waste_entries w
    LEFT JOIN products p ON p.id = w.product_id
    WHERE w.waste_date >= CURRENT_DATE - INTERVAL '21 days'
    GROUP BY p.id, p.product_name
    ORDER BY waste_cost DESC NULLS LAST
    LIMIT 30
  `);
  return result.rows.map((row) => ({
    type: "waste_trend",
    entity_type: "product",
    entity_id: row.product_id,
    title: `${row.product_name || "Product"} waste trend`,
    prediction_period: "Next 7 days",
    data_used: { waste_days: row.waste_days, waste_quantity: Number(row.waste_quantity || 0), waste_cost: roundCurrency(row.waste_cost) },
    confidence: Number(row.waste_days || 0) >= 3 ? 0.55 : 0.25,
    reason: Number(row.waste_days || 0) >= 3 ? "Repeated waste entries in recent 21 days." : "Insufficient repeated waste history.",
    minimum_data_requirement: "3 waste days in last 21 days",
    recommendation: Number(row.waste_days || 0) >= 3 ? "Investigate lot quality, pricing, and movement." : "Monitor further before acting.",
    payload: { status: Number(row.waste_days || 0) >= 3 ? "READY" : "INSUFFICIENT_DATA" },
  }));
};

const getProfitAdvisorRows = async (pool) => {
  const result = await pool.query(`
    SELECT p.id AS product_id, p.product_name, p.selling_rate,
           COALESCE(AVG(NULLIF(ib.purchase_rate, 0)), 0) AS avg_purchase_cost,
           COALESCE(SUM(CASE WHEN s.sale_date >= CURRENT_DATE - INTERVAL '30 days' AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED' THEN si.quantity ELSE 0 END), 0) AS recent_sales_quantity,
           COALESCE(SUM(CASE WHEN w.waste_date >= CURRENT_DATE - INTERVAL '30 days' THEN w.quantity ELSE 0 END), 0) AS recent_waste_quantity,
           COALESCE(SUM(CASE WHEN w.waste_date >= CURRENT_DATE - INTERVAL '30 days' THEN w.cost_amount ELSE 0 END), 0) AS recent_waste_cost
    FROM products p
    LEFT JOIN inventory_batches ib ON ib.product_id = p.id AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
    LEFT JOIN sale_items si ON si.product_id = p.id
    LEFT JOIN sales s ON s.id = si.sale_id
    LEFT JOIN waste_entries w ON w.product_id = p.id
    WHERE p.active IS DISTINCT FROM FALSE
    GROUP BY p.id, p.product_name, p.selling_rate
    ORDER BY p.product_name
    LIMIT 100
  `);
  return result.rows.map((row) => {
    const margin = grossMarginPercent({ sellingRate: row.selling_rate, purchaseCost: row.avg_purchase_cost });
    const adjusted = wasteAdjustedMargin({
      saleAmount: Number(row.selling_rate || 0) * Number(row.recent_sales_quantity || 0),
      costAmount: Number(row.avg_purchase_cost || 0) * Number(row.recent_sales_quantity || 0),
      wasteCost: row.recent_waste_cost,
    });
    const action = margin !== null && margin < 10
      ? "review sale rate"
      : Number(row.recent_waste_quantity || 0) > 0
        ? "review waste cause"
        : "monitor margin";
    return {
      product_id: row.product_id,
      product_name: row.product_name,
      current_purchase_cost: roundCurrency(row.avg_purchase_cost),
      current_selling_rate: roundCurrency(row.selling_rate),
      estimated_gross_margin: margin,
      waste_adjusted_margin: adjusted,
      recent_sales_quantity: Number(row.recent_sales_quantity || 0),
      recent_waste: Number(row.recent_waste_quantity || 0),
      proposed_action: action,
      expected_impact_range: margin !== null && margin < 10 ? "May protect margin; not enough evidence to estimate exact sales lift." : "Operational review only.",
      confidence: margin === null ? 0.2 : 0.55,
      assumptions: ["Last 30 days sales and waste", "Average active lot purchase cost"],
    };
  });
};

const getAutonomousProductMetrics = async (pool) => {
  const result = await pool.query(`
    WITH stock AS (
      SELECT product_id,
             SUM(CASE WHEN COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED' THEN remaining_qty ELSE 0 END) AS available_stock,
             AVG(NULLIF(purchase_rate, 0)) AS avg_purchase_cost,
             MAX(supplier_name) AS suggested_supplier
      FROM inventory_batches
      GROUP BY product_id
    ),
    sales30 AS (
      SELECT si.product_id, SUM(si.quantity) AS sold_qty, SUM(si.amount) AS sale_amount,
             SUM(si.cost_amount) AS cost_amount, SUM(si.profit) AS profit_amount,
             COUNT(DISTINCT s.sale_date) AS sale_days
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.sale_date >= CURRENT_DATE - INTERVAL '30 days'
        AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
      GROUP BY si.product_id
    ),
    sales7 AS (
      SELECT si.product_id, SUM(si.quantity) AS sold_qty
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.sale_date >= CURRENT_DATE - INTERVAL '7 days'
        AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
      GROUP BY si.product_id
    ),
    waste30 AS (
      SELECT product_id, SUM(quantity) AS waste_qty, SUM(cost_amount) AS waste_cost
      FROM waste_entries
      WHERE waste_date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY product_id
    ),
    pending AS (
      SELECT pi.product_id, SUM(pi.quantity) AS pending_qty
      FROM purchase_items pi
      JOIN purchases pu ON pu.id = pi.purchase_id
      WHERE COALESCE(pu.purchase_status, '') IN ('BILL_PENDING', 'PENDING')
      GROUP BY pi.product_id
    )
    SELECT p.id AS product_id, p.product_name, p.unit, p.selling_rate, p.minimum_stock,
           COALESCE(stock.available_stock, 0) AS available_stock,
           COALESCE(stock.avg_purchase_cost, 0) AS avg_purchase_cost,
           COALESCE(stock.suggested_supplier, '') AS suggested_supplier,
           COALESCE(sales30.sold_qty, 0) AS sold_qty_30,
           COALESCE(sales7.sold_qty, 0) AS sold_qty_7,
           COALESCE(sales30.sale_amount, 0) AS sale_amount_30,
           COALESCE(sales30.cost_amount, 0) AS cost_amount_30,
           COALESCE(sales30.profit_amount, 0) AS profit_amount_30,
           COALESCE(sales30.sale_days, 0) AS sale_days_30,
           COALESCE(waste30.waste_qty, 0) AS waste_qty_30,
           COALESCE(waste30.waste_cost, 0) AS waste_cost_30,
           COALESCE(pending.pending_qty, 0) AS pending_purchase_qty
    FROM products p
    LEFT JOIN stock ON stock.product_id = p.id
    LEFT JOIN sales30 ON sales30.product_id = p.id
    LEFT JOIN sales7 ON sales7.product_id = p.id
    LEFT JOIN waste30 ON waste30.product_id = p.id
    LEFT JOIN pending ON pending.product_id = p.id
    WHERE p.active IS DISTINCT FROM FALSE
    ORDER BY p.product_name
    LIMIT 120
  `);
  return result.rows.map((row) => {
    const averageDailySale = Number(row.sold_qty_30 || 0) / 30;
    const recentAverageDailySale = Number(row.sold_qty_7 || 0) / 7;
    const demandTrend = averageDailySale > 0 ? (recentAverageDailySale - averageDailySale) / averageDailySale : 0;
    const wasteProbability = Number(row.sold_qty_30 || 0) + Number(row.waste_qty_30 || 0) > 0
      ? Number(row.waste_qty_30 || 0) / (Number(row.sold_qty_30 || 0) + Number(row.waste_qty_30 || 0))
      : 0;
    return {
      ...row,
      selling_rate: roundCurrency(row.selling_rate),
      available_stock: Number(row.available_stock || 0),
      avg_purchase_cost: roundCurrency(row.avg_purchase_cost),
      average_daily_sale: Number(averageDailySale.toFixed(3)),
      demand_trend: Number(demandTrend.toFixed(3)),
      waste_probability: Number(wasteProbability.toFixed(3)),
      margin_percent: grossMarginPercent({ sellingRate: row.selling_rate, purchaseCost: row.avg_purchase_cost }),
    };
  });
};

const getDynamicPricingIntelligence = async (pool) => {
  const rows = await getAutonomousProductMetrics(pool);
  return rows.map((row) => {
    const recommendation = dynamicPriceRecommendation({
      sellingRate: row.selling_rate,
      purchaseCost: row.avg_purchase_cost,
      availableStock: row.available_stock,
      averageDailySale: row.average_daily_sale,
      wasteProbability: row.waste_probability,
      demandTrend: row.demand_trend,
    });
    const verb = recommendation.action === "INCREASE" ? "Increase" : recommendation.action === "REDUCE" ? "Reduce" : "Keep";
    const actionText = recommendation.action === "KEEP"
      ? `Keep ${row.product_name} unchanged`
      : `${verb} ${row.product_name} ${roundCurrency(recommendation.changeAmount)}/${row.unit || "unit"}`;
    return {
      product_id: row.product_id,
      product_name: row.product_name,
      current_selling_rate: row.selling_rate,
      current_purchase_rate: row.avg_purchase_cost,
      current_stock: row.available_stock,
      margin_percent: row.margin_percent,
      waste_probability: row.waste_probability,
      seasonal_demand: row.demand_trend,
      action: recommendation.action,
      action_text: actionText,
      reason: recommendation.reason,
      expected_revenue_impact: roundCurrency(recommendation.expectedRevenueImpact),
      expected_profit_impact: roundCurrency(recommendation.expectedProfitImpact),
      confidence: recommendation.confidence,
      priority: recommendation.priority,
      action_class: "READ_ONLY",
      approval_required: false,
      confirmation_required_for_execution: true,
    };
  }).sort((a, b) => Number(b.confidence) - Number(a.confidence)).slice(0, 50);
};

const getSmartPurchasePlanner = async (pool) => {
  const rows = await getAutonomousProductMetrics(pool);
  return rows.map((row) => {
    const recommendation = purchasePlannerRecommendation({
      availableStock: row.available_stock,
      pendingPurchaseQty: row.pending_purchase_qty,
      averageDailySale: row.average_daily_sale,
      purchaseCost: row.avg_purchase_cost,
      sellingRate: row.selling_rate,
    });
    return {
      product_id: row.product_id,
      product_name: row.product_name,
      recommended_quantity: recommendation.recommendedQuantity || 0,
      suggested_supplier: row.suggested_supplier || "Review latest supplier",
      expected_cost: roundCurrency(recommendation.expectedCost),
      expected_margin: recommendation.expectedMargin,
      expected_stock_days: recommendation.expectedStockDays || null,
      current_stock: row.available_stock,
      pending_purchase_qty: Number(row.pending_purchase_qty || 0),
      average_daily_sale: row.average_daily_sale,
      status: recommendation.status,
      priority: recommendation.priority || "INFO",
      confidence: recommendation.confidence || 0,
      reason: recommendation.reason,
      action_class: "READ_ONLY",
      approval_required: false,
      confirmation_required_for_execution: true,
    };
  }).filter((item) => item.status !== "WAIT").sort((a, b) => Number(b.recommended_quantity) - Number(a.recommended_quantity)).slice(0, 50);
};

const getWastePreventionIntelligence = async (pool) => {
  const velocityRows = await getAutonomousProductMetrics(pool);
  const velocity = new Map(velocityRows.map((row) => [Number(row.product_id), row.average_daily_sale]));
  const result = await pool.query(`
    SELECT ib.id AS lot_id, ib.product_id, p.product_name, ib.batch_no, ib.purchase_qty, ib.remaining_qty,
           ib.purchase_rate, ib.purchase_date, ib.supplier_name,
           (CURRENT_DATE - ib.purchase_date)::INTEGER AS age_days
    FROM inventory_batches ib
    JOIN products p ON p.id = ib.product_id
    WHERE COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
      AND COALESCE(ib.remaining_qty, 0) > 0
    ORDER BY ib.purchase_date, ib.id
    LIMIT 120
  `);
  return result.rows.map((row) => {
    const remainingRatio = Number(row.purchase_qty || 0) > 0 ? Number(row.remaining_qty || 0) / Number(row.purchase_qty || 0) : 0;
    const risk = wastePreventionScore({ ageDays: row.age_days, remainingRatio, averageDailySale: velocity.get(Number(row.product_id)) || 0 });
    return {
      lot_id: row.lot_id,
      product_id: row.product_id,
      product_name: row.product_name,
      batch_no: row.batch_no,
      supplier_name: row.supplier_name,
      purchase_date: row.purchase_date,
      remaining_qty: Number(row.remaining_qty || 0),
      freshness_score: risk.freshnessScore,
      expiry_risk: risk.expiryRisk,
      waste_probability: risk.wasteProbability,
      selling_priority: risk.sellingPriority,
      discount_recommendation: risk.discountRecommendation,
      color_status: risk.colorStatus,
      action_class: "READ_ONLY",
      approval_required: false,
      confirmation_required_for_execution: true,
    };
  });
};

const getCustomerIntelligence = async (pool) => {
  const result = await pool.query(`
    SELECT c.id AS customer_id, c.customer_name,
           COUNT(DISTINCT s.id) AS purchase_count,
           MAX(s.sale_date) AS last_purchase_date,
           COALESCE(SUM(s.total_amount), 0) AS lifetime_value,
           CASE WHEN COUNT(DISTINCT s.id) > 0 THEN COALESCE(SUM(s.total_amount), 0) / COUNT(DISTINCT s.id) ELSE 0 END AS average_basket_value,
           STRING_AGG(DISTINCT p.product_name, ', ' ORDER BY p.product_name) AS favourite_fruits
    FROM customers c
    LEFT JOIN sales s ON s.customer_id = c.id AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
    LEFT JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN products p ON p.id = si.product_id
    WHERE c.active IS DISTINCT FROM FALSE
    GROUP BY c.id, c.customer_name
    ORDER BY lifetime_value DESC, c.customer_name
    LIMIT 80
  `);
  return result.rows.map((row) => {
    const daysSincePurchase = row.last_purchase_date ? Math.floor((Date.now() - new Date(row.last_purchase_date).getTime()) / 86400000) : null;
    const segment = customerIntelligenceSegment({
      daysSincePurchase,
      purchaseCount: row.purchase_count,
      lifetimeValue: row.lifetime_value,
      averageBasketValue: row.average_basket_value,
    });
    return {
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      favourite_fruits: row.favourite_fruits || "Not enough product history",
      purchase_frequency: Number(row.purchase_count || 0),
      average_basket_value: roundCurrency(row.average_basket_value),
      lifetime_value: roundCurrency(row.lifetime_value),
      last_purchase_date: row.last_purchase_date,
      days_since_purchase: daysSincePurchase,
      segment: segment.segment,
      risk: segment.risk,
      recommendation: segment.recommendation,
      expected_future_value: roundCurrency(Number(row.average_basket_value || 0) * Math.min(Number(row.purchase_count || 0) + 1, 6)),
      action_class: "READ_ONLY",
      approval_required: false,
      confirmation_required_for_execution: true,
    };
  });
};

const getSupplierIntelligence = async (pool) => {
  const result = await pool.query(`
    WITH supplier_profit AS (
      SELECT COALESCE(sup.id, ib.supplier_id) AS supplier_id,
             COALESCE(sup.supplier_name, ib.supplier_name, 'Supplier') AS supplier_name,
             SUM(si.profit) AS profit_amount,
             SUM(si.amount) AS sale_amount
      FROM sale_batch_allocations siba
      JOIN sale_items si ON si.id = siba.sale_item_id
      LEFT JOIN inventory_batches ib ON ib.id = siba.inventory_batch_id
      LEFT JOIN suppliers sup ON sup.id = ib.supplier_id
      GROUP BY COALESCE(sup.id, ib.supplier_id), COALESCE(sup.supplier_name, ib.supplier_name, 'Supplier')
    ),
    supplier_purchases AS (
      SELECT COALESCE(s.id, ib.supplier_id) AS supplier_id,
             COALESCE(s.supplier_name, ib.supplier_name, 'Supplier') AS supplier_name,
             AVG(ib.purchase_rate) AS average_purchase_rate,
             COUNT(DISTINCT ib.id) AS purchase_count,
             MIN(ib.purchase_rate) AS lowest_rate,
             MAX(ib.purchase_rate) AS highest_rate
      FROM inventory_batches ib
      LEFT JOIN suppliers s ON s.id = ib.supplier_id
      GROUP BY COALESCE(s.id, ib.supplier_id), COALESCE(s.supplier_name, ib.supplier_name, 'Supplier')
    )
    SELECT COALESCE(sp.supplier_id, pp.supplier_id) AS supplier_id,
           COALESCE(sp.supplier_name, pp.supplier_name) AS supplier_name,
           COALESCE(pp.average_purchase_rate, 0) AS average_purchase_rate,
           COALESCE(pp.purchase_count, 0) AS purchase_count,
           COALESCE(sp.profit_amount, 0) AS profit_contribution,
           CASE WHEN COALESCE(sp.sale_amount, 0) > 0 THEN (sp.profit_amount / sp.sale_amount) * 100 ELSE 0 END AS margin_percent,
           CASE WHEN COALESCE(pp.lowest_rate, 0) > 0 THEN ((pp.highest_rate - pp.lowest_rate) / pp.lowest_rate) * 100 ELSE 0 END AS cost_spread_percent
    FROM supplier_profit sp
    FULL OUTER JOIN supplier_purchases pp ON pp.supplier_id IS NOT DISTINCT FROM sp.supplier_id AND pp.supplier_name = sp.supplier_name
    ORDER BY profit_contribution DESC, purchase_count DESC
    LIMIT 80
  `);
  return result.rows.map((row) => {
    const score = supplierIntelligenceScore({
      marginPercent: row.margin_percent,
      costIncreasePercent: row.cost_spread_percent,
      purchaseCount: row.purchase_count,
    });
    return {
      supplier_id: row.supplier_id,
      supplier_name: row.supplier_name,
      average_purchase_rate: roundCurrency(row.average_purchase_rate),
      quality: "Use return and waste history for manual review",
      delivery_timing: "Not enough delivery timestamp data",
      payment_behaviour: "Review supplier ledger",
      return_percent: 0,
      reliability: score.reliability,
      profit_contribution: roundCurrency(row.profit_contribution),
      supplier_score: score.score,
      recommendation: score.recommendation,
      action_class: "READ_ONLY",
      approval_required: false,
      confirmation_required_for_execution: true,
    };
  });
};

const getProfitOptimizer = async (pool) => {
  const products = await getProfitAdvisorRows(pool);
  const supplierRows = await getSupplierIntelligence(pool);
  const topOpportunities = products.filter((item) => ["review sale rate", "review waste cause"].includes(item.proposed_action)).slice(0, 8);
  return {
    overall: {
      estimated_monthly_gain: roundCurrency(topOpportunities.reduce((sum, item) => sum + Math.max(0, Number(item.current_selling_rate || 0) - Number(item.current_purchase_cost || 0)) * Math.max(1, Number(item.recent_sales_quantity || 0)) * 0.05, 0)),
    },
    top_profit_opportunities: topOpportunities,
    top_loss_areas: products.filter((item) => Number(item.estimated_gross_margin || 0) < 10).slice(0, 8),
    highest_margin_fruits: [...products].sort((a, b) => Number(b.estimated_gross_margin || 0) - Number(a.estimated_gross_margin || 0)).slice(0, 8),
    lowest_margin_fruits: [...products].sort((a, b) => Number(a.estimated_gross_margin || 999) - Number(b.estimated_gross_margin || 999)).slice(0, 8),
    supplier_profitability: supplierRows.slice(0, 8),
    action_class: "READ_ONLY",
    approval_required: false,
    confirmation_required_for_execution: true,
  };
};

const getCashFlowPredictor = async (pool, settings) => {
  const base = (await getCashflowPredictions(pool, settings))[0];
  const requirement = Number(base.payload.projectedCashRequirement || 0);
  const collectionHigh = Number(base.payload.expectedCustomerCollectionsRange?.[1] || 0);
  const windows = [
    ["Today", 1],
    ["Tomorrow", 2],
    ["7 Days", 7],
    ["30 Days", 30],
  ];
  return windows.map(([label, days]) => ({
    period: label,
    incoming_cash: roundCurrency(collectionHigh * (days / 7)),
    outgoing_cash: roundCurrency(requirement * (days / 7)),
    working_capital: roundCurrency(collectionHigh * (days / 7) - requirement * (days / 7)),
    future_shortage: collectionHigh < requirement,
    supplier_payments_due: roundCurrency(requirement * (days / 7)),
    collection_expectations: roundCurrency(collectionHigh * (days / 7)),
    confidence: base.confidence,
    reason: base.reason,
  }));
};

const getDemandForecast = async (pool) => {
  const rows = await getAutonomousProductMetrics(pool);
  return rows.map((row) => ({
    product_id: row.product_id,
    product_name: row.product_name,
    expected_sales_7_days: Number((row.average_daily_sale * 7).toFixed(2)),
    expected_purchase: Math.max(0, Number((row.average_daily_sale * 7 - row.available_stock - Number(row.pending_purchase_qty || 0)).toFixed(2))),
    stock_shortage_warning: row.available_stock < row.average_daily_sale * 3,
    slow_moving: row.average_daily_sale < 0.1 && row.available_stock > 0,
    weekly_trend: row.demand_trend,
    monthly_trend: row.average_daily_sale,
    seasonality: "Recent trend only; festival calendar not configured",
    confidence: row.sale_days_30 >= 7 ? 0.62 : 0.35,
  })).sort((a, b) => Number(b.stock_shortage_warning) - Number(a.stock_shortage_warning) || b.expected_sales_7_days - a.expected_sales_7_days).slice(0, 60);
};

const getBusinessHealth = async (pool, settings) => {
  const range = getRange({ range: "today" });
  const [sales, lowStock, waste, customers, suppliers, cashflow] = await Promise.all([
    getDailySalesSummary(pool, range),
    getLowStockProducts(pool),
    getWasteSummary(pool, range),
    getCustomerIntelligence(pool),
    getSupplierIntelligence(pool),
    getCashFlowPredictor(pool, settings),
  ]);
  const salesScore = clampNumber(Number(sales.summary.totalSales || 0) > 0 ? 75 : 40, 0, 100);
  const profitScore = clampNumber(Number(sales.summary.estimatedGrossProfit || 0) > 0 ? 70 : 35, 0, 100);
  const inventoryScore = clampNumber(100 - lowStock.summary.count * 8, 0, 100);
  const wasteScore = clampNumber(100 - Number(waste.summary.totalWasteCost || 0) / 100, 0, 100);
  const customerScore = clampNumber(100 - customers.filter((item) => item.segment === "INACTIVE").length * 4, 0, 100);
  const supplierScoreValue = suppliers.length ? suppliers.reduce((sum, row) => sum + Number(row.supplier_score || 0), 0) / suppliers.length : 55;
  const cashFlowScore = cashflow[0]?.future_shortage ? 45 : 70;
  const outstandingScore = cashflow[0]?.future_shortage ? 45 : 70;
  const health = businessHealthScore({ salesScore, profitScore, inventoryScore, cashFlowScore, wasteScore, customerScore, supplierScore: supplierScoreValue, outstandingScore });
  return {
    ...health,
    components: { salesScore, profitScore, inventoryScore, cashFlowScore, wasteScore, customerScore, supplierScore: supplierScoreValue, outstandingScore },
    reason: "Weighted deterministic score across sales, profit, inventory, cashflow, waste, customers, suppliers and outstanding risk.",
  };
};

const buildOwnerDecisionCenterFromParts = ({ pricing, purchases, waste, customers, suppliers, profit, cashflow, demand, health }) => ({
  health,
  critical_alerts: [...waste.filter((item) => item.color_status === "Red"), ...demand.filter((item) => item.stock_shortage_warning)].slice(0, 8),
  warnings: pricing.filter((item) => ["HIGH", "ATTENTION"].includes(item.priority)).slice(0, 8),
  todays_opportunities: demand.filter((item) => item.expected_sales_7_days > 0).slice(0, 6),
  profit_opportunities: profit.top_profit_opportunities,
  waste_alerts: waste.filter((item) => item.color_status !== "Green").slice(0, 8),
  stock_alerts: purchases.slice(0, 8),
  payment_alerts: cashflow.filter((item) => item.future_shortage),
  purchase_suggestions: purchases.slice(0, 8),
  customer_opportunities: customers.filter((item) => ["VIP", "INACTIVE", "GROWING"].includes(item.segment)).slice(0, 8),
  supplier_opportunities: suppliers.filter((item) => item.recommendation !== "Monitor supplier").slice(0, 8),
  approval_policy: "All actions are recommendations only. Owner must approve, reject, modify or schedule.",
});

const getOwnerDecisionCenter = async (pool, settings) => {
  const [pricing, purchases, waste, customers, suppliers, profit, cashflow, demand, health] = await Promise.all([
    getDynamicPricingIntelligence(pool),
    getSmartPurchasePlanner(pool),
    getWastePreventionIntelligence(pool),
    getCustomerIntelligence(pool),
    getSupplierIntelligence(pool),
    getProfitOptimizer(pool),
    getCashFlowPredictor(pool, settings),
    getDemandForecast(pool),
    getBusinessHealth(pool, settings),
  ]);
  return buildOwnerDecisionCenterFromParts({ pricing, purchases, waste, customers, suppliers, profit, cashflow, demand, health });
};

const getPurchaseRecommendationFact = async (pool) => {
  const rows = await getSmartPurchasePlanner(pool);
  return buildFact("purchase_recommendations", "Purchase Planner", "Next purchase review", rows, {
    count: rows.length,
    estimatedCost: roundCurrency(rows.reduce((sum, row) => sum + Number(row.expected_cost || 0), 0)),
  });
};

const getSaleRateReviewFact = async (pool) => {
  const rows = (await getDynamicPricingIntelligence(pool)).filter((item) => item.action !== "KEEP");
  return buildFact("sale_rate_review", "Sale Rate Update", "Current pricing review", rows, {
    count: rows.length,
    estimatedProfitImpact: roundCurrency(rows.reduce((sum, row) => sum + Number(row.expected_profit_impact || 0), 0)),
  });
};

const getProductMarginSummary = async (pool, range) => {
  const result = await pool.query(`
    SELECT p.id AS product_id, p.product_name,
           SUM(si.amount) AS sale_amount,
           SUM(si.cost_amount) AS cost_amount,
           SUM(si.profit) AS profit_amount,
           CASE WHEN SUM(si.amount) > 0 THEN (SUM(si.profit) / SUM(si.amount)) * 100 ELSE 0 END AS margin_percent
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    LEFT JOIN products p ON p.id = si.product_id
    WHERE s.sale_date BETWEEN $1 AND $2
      AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
    GROUP BY p.id, p.product_name
    ORDER BY margin_percent ASC, sale_amount DESC
    LIMIT 30
  `, [range.dateFrom, range.dateTo]);
  const rows = result.rows.map((row) => ({
    ...row,
    sale_amount: roundCurrency(row.sale_amount),
    cost_amount: roundCurrency(row.cost_amount),
    profit_amount: roundCurrency(row.profit_amount),
    margin_percent: Number(toNumber(row.margin_percent).toFixed(2)),
  }));
  return buildFact("product_margin_summary", "Reports", range.label, rows, { count: rows.length });
};

const getHighValueEditedBills = async (pool, settings, range) => {
  const result = await pool.query(`
    SELECT id, invoice_no, sale_date, total_amount, sale_status, edited_at, cancelled_at, edit_reason, cancellation_reason
    FROM sales
    WHERE sale_date BETWEEN $1 AND $2
      AND (sale_status IN ('EDITED', 'CANCELLED') OR edited_at IS NOT NULL OR cancelled_at IS NOT NULL)
      AND total_amount >= $3
    ORDER BY total_amount DESC, sale_date DESC
    LIMIT 30
  `, [range.dateFrom, range.dateTo, settings.thresholds.highValueBillAmount]);
  const rows = result.rows.map((row) => ({ ...row, total_amount: roundCurrency(row.total_amount) }));
  return buildFact("high_value_edited_bills", "Sales History", range.label, rows, { count: rows.length });
};

const getCollectionSummary = async (pool, range) => {
  const result = await pool.query(`
    SELECT sp.payment_mode, SUM(sp.amount) AS amount
    FROM sale_payments sp
    JOIN sales s ON s.id = sp.sale_id
    WHERE s.sale_date BETWEEN $1 AND $2
      AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
    GROUP BY sp.payment_mode
  `, [range.dateFrom, range.dateTo]);
  const customerPayments = await pool.query(`
    SELECT payment_mode, SUM(payment_amount) AS amount
    FROM customer_payments
    WHERE payment_date BETWEEN $1 AND $2 AND cancelled IS DISTINCT FROM TRUE
    GROUP BY payment_mode
  `, [range.dateFrom, range.dateTo]);
  const rows = [...result.rows, ...customerPayments.rows].map((row) => ({ ...row, amount: roundCurrency(row.amount) }));
  return buildFact("collection_summary", "Payments", range.label, rows, {
    cash: roundCurrency(rows.filter((row) => row.payment_mode === "CASH").reduce((sum, row) => sum + row.amount, 0)),
    upi: roundCurrency(rows.filter((row) => row.payment_mode === "UPI").reduce((sum, row) => sum + row.amount, 0)),
    card: roundCurrency(rows.filter((row) => ["CARD", "BANK_TRANSFER"].includes(row.payment_mode)).reduce((sum, row) => sum + row.amount, 0)),
  });
};

const upsertAlert = async (pool, alert) => {
  await pool.query(`
    INSERT INTO ai_alerts (company_id, branch_id, dedup_key, alert_type, severity, source_module, linked_entity_type, linked_entity_id, title, message, facts, detected_at, updated_at)
    VALUES (1, 1, $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (dedup_key)
    DO UPDATE SET severity = EXCLUDED.severity, message = EXCLUDED.message, facts = EXCLUDED.facts, updated_at = CURRENT_TIMESTAMP
    WHERE ai_alerts.status <> 'RESOLVED'
  `, [
    alert.dedupKey,
    alert.type,
    alert.severity,
    alert.sourceModule,
    alert.entityType,
    String(alert.entityId || ""),
    alert.title,
    alert.message,
    JSON.stringify(alert.facts || {}),
  ]);
};

const runAlertRules = async (pool, settings) => {
  const [customerOutstanding, pendingPurchases, lowStock] = await Promise.all([
    getCustomerOutstanding(pool, settings),
    getPendingPurchaseBills(pool),
    getLowStockProducts(pool),
  ]);
  for (const row of customerOutstanding.rows.filter((item) => ["OVERDUE", "SERIOUSLY_OVERDUE", "CRITICAL_OUTSTANDING"].includes(item.due_status))) {
    await upsertAlert(pool, {
      dedupKey: `customer-overdue:${row.customer_id || row.customer_name}`,
      type: "CUSTOMER_PAYMENT_OVERDUE",
      severity: severityFromRisk(row.risk_classification),
      sourceModule: "Accounts",
      entityType: "customer",
      entityId: row.customer_id,
      title: `${row.customer_name} payment overdue`,
      message: `${row.customer_name} has outstanding ${row.outstanding_amount} from ${row.oldest_due_date || "no due date"}.`,
      facts: row,
    });
  }
  for (const row of pendingPurchases.rows.filter((item) => Number(item.pending_days || 0) >= settings.thresholds.purchaseBillPendingDays)) {
    await upsertAlert(pool, {
      dedupKey: `purchase-pending:${row.id}`,
      type: "PURCHASE_BILL_PENDING",
      severity: "ATTENTION",
      sourceModule: "Pending Bills",
      entityType: "purchase",
      entityId: row.id,
      title: `Purchase bill pending for ${row.supplier_name}`,
      message: `Purchase #${row.id} is pending for ${row.pending_days} days.`,
      facts: row,
    });
  }
  for (const row of lowStock.rows) {
    await upsertAlert(pool, {
      dedupKey: `low-stock:${row.id}`,
      type: Number(row.available_stock || 0) <= 0 ? "ZERO_STOCK" : "LOW_STOCK",
      severity: row.severity,
      sourceModule: "Inventory Lots",
      entityType: "product",
      entityId: row.id,
      title: `${row.product_name} stock needs attention`,
      message: `${row.product_name} has ${row.available_stock} ${row.unit || ""} available against minimum ${row.minimum_stock}.`,
      facts: row,
    });
  }
};

const getStoredAlerts = async (pool) => {
  const result = await pool.query(`
    SELECT *
    FROM ai_alerts
    WHERE status <> 'RESOLVED'
      AND (snoozed_until IS NULL OR snoozed_until <= CURRENT_TIMESTAMP)
    ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'ATTENTION' THEN 3 ELSE 4 END, detected_at DESC
    LIMIT 100
  `);
  return result.rows;
};

const getReminders = async (pool) => {
  const result = await pool.query(`
    SELECT *
    FROM ai_reminders
    WHERE status <> 'RESOLVED'
    ORDER BY due_at NULLS LAST, CASE priority WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 WHEN 'ATTENTION' THEN 3 ELSE 4 END, id DESC
    LIMIT 100
  `);
  return result.rows;
};

const emptyBriefingFact = (type, sourceModule, periodLabel, summary = {}, error = "") => buildFact(
  type,
  sourceModule,
  periodLabel,
  [],
  { ...summary, unavailable: Boolean(error), error }
);

const safeBriefingFact = async (label, fallback, producer) => {
  try {
    return await producer();
  } catch (error) {
    console.warn("FROST briefing fact unavailable", { label, message: error.message });
    return { ...fallback, summary: { ...(fallback.summary || {}), unavailable: true, error: error.message } };
  }
};

const buildDailyBriefing = async (pool, settings, range) => {
  await runAlertRules(pool, settings).catch((error) => {
    console.warn("FROST alert rules skipped during briefing", error.message);
  });
  const [sales, collections, customerOutstanding, supplierOutstanding, pendingPurchases, lowStock, waste, expiringLots, salesRanking, alerts] = await Promise.all([
    safeBriefingFact("sales", emptyBriefingFact("daily_sales_summary", "POS Billing", range.label, { billCount: 0, totalSales: 0, estimatedGrossProfit: 0, discountAmount: 0 }), () => getDailySalesSummary(pool, range)),
    safeBriefingFact("collections", emptyBriefingFact("collection_summary", "Payments", range.label, { totalCollected: 0, count: 0 }), () => getCollectionSummary(pool, range)),
    safeBriefingFact("customerOutstanding", emptyBriefingFact("customer_outstanding", "Accounts", "Current branch", { totalOutstanding: 0, count: 0 }), () => getCustomerOutstanding(pool, settings)),
    safeBriefingFact("supplierOutstanding", emptyBriefingFact("supplier_outstanding", "Accounts", "Current branch", { totalOutstanding: 0, count: 0 }), () => getSupplierOutstanding(pool)),
    safeBriefingFact("pendingPurchases", emptyBriefingFact("pending_purchase_bills", "Purchases", "Pending bills", { count: 0, estimatedValue: 0 }), () => getPendingPurchaseBills(pool)),
    safeBriefingFact("lowStock", emptyBriefingFact("low_stock_products", "Inventory Lots", "Current stock", { count: 0 }), () => getLowStockProducts(pool)),
    safeBriefingFact("waste", emptyBriefingFact("waste_summary", "Waste", range.label, { totalWasteCost: 0 }), () => getWasteSummary(pool, range)),
    safeBriefingFact("expiringLots", emptyBriefingFact("inventory_nearing_expiry", "Inventory Lots", "Aging lots", { count: 0 }), () => getInventoryNearingExpiry(pool, settings)),
    safeBriefingFact("salesRanking", emptyBriefingFact("product_sales_ranking", "Sales History", range.label, { highestSelling: [], lowestSelling: [] }), () => getProductSalesRanking(pool, range)),
    getStoredAlerts(pool).catch((error) => {
      console.warn("FROST stored alerts unavailable during briefing", error.message);
      return [];
    }),
  ]);
  const recommendations = [];
  if (alerts.some((alert) => alert.severity === "CRITICAL")) recommendations.push("Review critical alerts before new credit sales.");
  if (pendingPurchases.rows.length) recommendations.push("Complete oldest pending purchase bills so stock costing stays final.");
  if (lowStock.rows.length) recommendations.push("Reorder or transfer low-stock products before POS demand is affected.");
  if (expiringLots.rows.length) recommendations.push("Review aging fruit lots and move near-expiry stock before wastage increases.");
  if (!recommendations.length) recommendations.push("No urgent deterministic action found for this period.");
  const insightCards = [
    {
      id: "revenue",
      priority: "Information",
      title: "Revenue",
      value: sales.summary.totalSales,
      sourceModule: "POS Billing",
      actions: ["View"],
    },
    {
      id: "receivables",
      priority: customerOutstanding.summary.totalOutstanding > 0 ? "Warning" : "Information",
      title: "Outstanding Receivables",
      value: customerOutstanding.summary.totalOutstanding,
      sourceModule: "Accounts",
      actions: ["View", "Open Ledger", "Remind"],
    },
    {
      id: "low-stock",
      priority: lowStock.summary.count > 0 ? "Critical" : "Information",
      title: "Low Stock",
      value: lowStock.summary.count,
      sourceModule: "Inventory Lots",
      actions: ["View", "Purchase", "Ignore"],
    },
    {
      id: "expiry",
      priority: expiringLots.summary.count > 0 ? "Warning" : "Information",
      title: "Inventory Nearing Expiry",
      value: expiringLots.summary.count,
      sourceModule: "Inventory Lots",
      actions: ["View", "Purchase", "Ignore"],
    },
    {
      id: "waste",
      priority: waste.summary.totalWasteCost > 0 ? "Warning" : "Information",
      title: "High Waste",
      value: waste.summary.totalWasteCost,
      sourceModule: "Waste",
      actions: ["View", "Ignore"],
    },
    {
      id: "opportunity",
      priority: "Opportunity",
      title: "Best Selling Fruits",
      value: salesRanking.summary.highestSelling?.[0]?.product_name || "No sales yet",
      sourceModule: "Sales History",
      actions: ["View", "Purchase"],
    },
  ];
  return {
    period: range,
    cards: {
      sales: sales.summary,
      collections: collections.summary,
      customerOutstanding: customerOutstanding.summary,
      supplierOutstanding: supplierOutstanding.summary,
      pendingPurchases: pendingPurchases.summary,
      lowStock: lowStock.summary,
      waste: waste.summary,
      expiringLots: expiringLots.summary,
      highestSelling: salesRanking.summary.highestSelling || [],
      lowestSelling: salesRanking.summary.lowestSelling || [],
    },
    insightCards,
    alerts: alerts.slice(0, 8),
    recommendations: recommendations.slice(0, 3),
    sourceModules: ["POS Billing", "Payments", "Accounts", "Purchases", "Inventory Lots", "Waste", "Sales History", "AI Alerts"],
  };
};

const classifyQuestion = (question) => {
  const text = question.toLowerCase();
  if (text.includes("overdue") || text.includes("oldest outstanding") || text.includes("customer payment")) return "CUSTOMER_OUTSTANDING";
  if (text.includes("supplier") || text.includes("purchase bill") || text.includes("pending purchase")) return "SUPPLIER_PURCHASE";
  if (text.includes("low stock") || text.includes("run out") || text.includes("waste")) return "INVENTORY";
  if (text.includes("margin") || text.includes("profit") || text.includes("sales") || text.includes("expense") || text.includes("collection")) return "FINANCIAL";
  return "ATTENTION";
};

const factsForQuestion = async (pool, classification, settings, range) => {
  if (classification === "CUSTOMER_OUTSTANDING") return [await getCustomerOutstanding(pool, settings), await getOverdueCustomerInvoices(pool, settings)];
  if (classification === "SUPPLIER_PURCHASE") return [await getSupplierOutstanding(pool), await getPendingPurchaseBills(pool)];
  if (classification === "INVENTORY") return [await getLowStockProducts(pool), await getStockRunoutForecast(pool), await getWasteSummary(pool, range)];
  if (classification === "FINANCIAL") return [
    await getDailySalesSummary(pool, range),
    await getGrossProfitSummary(pool, range),
    await getExpenseSummary(pool, range),
    await getProductMarginSummary(pool, range),
    await getHighValueEditedBills(pool, settings, range),
    await getCollectionSummary(pool, range),
  ];
  return [
    await getCustomerOutstanding(pool, settings),
    await getPendingPurchaseBills(pool),
    await getLowStockProducts(pool),
    await getDailySalesSummary(pool, range),
  ];
};

const factsForBusinessIntent = async (pool, intent, settings, range) => {
  if (intent === "CASH_DRAWER") return [await getCashDrawerSummary(pool, range), await getCollectionSummary(pool, range)];
  if (intent === "PURCHASE_PLANNING") return [await getPurchaseRecommendationFact(pool), await getLowStockProducts(pool), await getSupplierOutstanding(pool)];
  if (intent === "SALE_RATE_REVIEW") return [await getSaleRateReviewFact(pool), await getProfitAdvisorRows(pool).then((rows) => buildFact("profit_advisor", "Profit Advisor", "Last 30 days", rows, { count: rows.length }))];
  if (intent === "LOSS_REVIEW") return [await getExpenseSummary(pool, range), await getWasteSummary(pool, range), await getProfitAdvisorRows(pool).then((rows) => buildFact("margin_risks", "Profit Advisor", "Last 30 days", rows.filter((item) => Number(item.estimated_gross_margin || 0) < 10 || Number(item.recent_waste || 0) > 0), { count: rows.length }))];
  if (intent === "PROFIT_RANKING") return [await getProductSalesRanking(pool, { ...range, label: range.label || "Selected period" }), await getProductMarginSummary(pool, range)];
  if (intent === "PAYMENTS") return [await getCustomerOutstanding(pool, settings), await getSupplierOutstanding(pool), await getPendingPurchaseBills(pool)];
  if (intent === "CUSTOMER_ACTIVITY") return [await getCustomerActivitySummary(pool), await getCustomerOutstanding(pool, settings)];
  if (intent === "INVENTORY_EXPIRY") return [await getInventoryNearingExpiry(pool, settings), await getLowStockProducts(pool)];
  if (intent === "SUPPLIER_MARGIN") return [await getSupplierMarginSummary(pool, range), await getSupplierOutstanding(pool)];
  if (intent === "SALES_FINANCE") return [await getDailySalesSummary(pool, range), await getGrossProfitSummary(pool, range), await getExpenseSummary(pool, range), await getCollectionSummary(pool, range), await getProductSalesRanking(pool, range)];
  if (intent === "INVENTORY") return [await getLowStockProducts(pool), await getInventoryNearingExpiry(pool, settings), await getWasteSummary(pool, range), await getProductSalesRanking(pool, range)];
  return [await getDailySalesSummary(pool, range), await getCustomerOutstanding(pool, settings), await getSupplierOutstanding(pool), await getLowStockProducts(pool), await getInventoryNearingExpiry(pool, settings), await getProductSalesRanking(pool, range)];
};

const buildDeterministicAnswer = (classification, facts, range) => {
  const parts = [`Period: ${range.label}.`];
  for (const fact of facts) {
    if (fact.summary.totalOutstanding !== undefined) parts.push(`${fact.sourceModule}: outstanding ${fact.summary.totalOutstanding} across ${fact.summary.count || 0} records.`);
    if (fact.summary.totalSales !== undefined) parts.push(`${fact.sourceModule}: sales ${fact.summary.totalSales}, estimated gross profit ${fact.summary.estimatedGrossProfit}.`);
    if (fact.summary.totalExpenses !== undefined) parts.push(`${fact.sourceModule}: expenses ${fact.summary.totalExpenses}.`);
    if (fact.summary.totalWasteCost !== undefined) parts.push(`${fact.sourceModule}: waste cost ${fact.summary.totalWasteCost}.`);
    if (fact.summary.count !== undefined && fact.summary.totalOutstanding === undefined && fact.summary.totalSales === undefined) parts.push(`${fact.sourceModule}: ${fact.summary.count} matching records.`);
  }
  const firstRows = facts.flatMap((fact) => fact.rows.slice(0, 3).map((row) => ({ fact, row }))).slice(0, 3);
  if (firstRows.length) {
    parts.push(`Top details: ${firstRows.map(({ row }) => row.customer_name || row.supplier_name || row.product_name || row.invoice_no || row.title || `#${row.id}`).join(", ")}.`);
  }
  parts.push("Source modules: " + [...new Set(facts.map((fact) => fact.sourceModule))].join(", ") + ".");
  if (classification === "ATTENTION" && !firstRows.length) parts.push("No urgent deterministic issue was found from the available data.");
  return parts.join(" ");
};

const auditQuestion = async ({ pool, user, deviceId, question, classification, range, facts, answer }) => {
  const conversation = await pool.query(`
    INSERT INTO ai_conversations (company_id, branch_id, user_id, device_id, question, classification, period_label)
    VALUES (1, $1, $2, $3, $4, $5, $6)
    RETURNING id
  `, [user.branch_id || 1, user.id, deviceId || "", question, classification, range.label]);
  const conversationId = conversation.rows[0].id;
  await pool.query("INSERT INTO ai_messages (conversation_id, role, content) VALUES ($1, 'user', $2)", [conversationId, question]);
  await pool.query("INSERT INTO ai_messages (conversation_id, role, content, facts_used) VALUES ($1, 'assistant', $2, $3::jsonb)", [conversationId, answer, JSON.stringify(facts)]);
  for (const fact of facts) {
    await pool.query(`
      INSERT INTO ai_fact_snapshots (conversation_id, fact_type, source_module, period_label, facts)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `, [conversationId, fact.type, fact.sourceModule, fact.periodLabel, JSON.stringify(fact)]);
  }
  await pool.query(`
    INSERT INTO ai_audit_log (company_id, branch_id, user_id, device_id, event_type, question, verified_facts, answer, approval_status)
    VALUES (1, $1, $2, $3, 'AI_QUERY', $4, $5::jsonb, $6, 'READ_ONLY')
  `, [user.branch_id || 1, user.id, deviceId || "", question, JSON.stringify(facts), answer]);
  return conversationId;
};

const registerAiBusinessAssistantRoutes = ({ app, pool, getPermissionUser, getCanonicalIdentity, requireRateManager }) => {
  const frost = new FrostServiceLayer({ pool });

  app.get("/api/ai/frost/status", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    const [settings, usage] = await Promise.all([frost.getSettings(), frost.getUsageSummary()]);
    return res.json({
      assistant: FROST_ASSISTANT_NAME,
      frost: settings.frost,
      engines: settings.engines,
      provider: settings.provider,
      providers: settings.providers,
      cache: settings.cache,
      usage,
    });
  });

  app.get("/api/ai/providers", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_settings_manage" });
    if (!user) return;
    return res.json({ assistant: FROST_ASSISTANT_NAME, providers: frost.getProviderOptions() });
  });

  app.get("/api/ai/suggested-questions", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    return res.json({ questions: SUGGESTED_QUESTIONS });
  });

  app.get("/api/ai/settings", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_settings_manage" });
    if (!user) return;
    const settings = await getAiSettings(pool, frost);
    const usage = await frost.getUsageSummary();
    return res.json({
      assistant: FROST_ASSISTANT_NAME,
      thresholds: settings.thresholds,
      frost: settings.frost,
      provider: settings.provider,
      providers: settings.providers,
      engines: settings.engines,
      cache: settings.cache,
      usage,
    });
  });

  app.put("/api/ai/settings", async (req, res) => {
    const manager = await requireRateManager(req.body.updated_by || req.body.user_id);
    if (!manager) return res.status(403).json({ message: "Only Owner/Admin can manage AI settings" });
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(req.body.thresholds || {}) };
    const result = await frost.updateSettings({
      thresholds,
      frostSettings: req.body.frost || {
        providerKey: req.body.provider_key || req.body.providerKey,
        model: req.body.model,
        enabled: req.body.ai_provider_enabled === true,
        streamingEnabled: req.body.streaming_enabled !== false,
        cacheEnabled: req.body.cache_enabled !== false,
        voicePrepared: true,
      },
      updatedBy: manager.id,
    });
    return res.json(result);
  });

  app.get("/api/ai/briefing", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    const settings = await getAiSettings(pool, frost);
    const range = getRange(req.query);
    const briefing = await buildDailyBriefing(pool, settings, range);
    return res.json(briefing);
  });

  app.get("/api/ai/alerts", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    return res.json({ alerts: await getStoredAlerts(pool) });
  });

  app.patch("/api/ai/alerts/:id", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_reminder_manage", actionClass: "SAFE_PERSONAL_WRITE" });
    if (!user) return;
    const id = parsePositiveInteger(req.params.id);
    const action = cleanText(req.body.action).toUpperCase();
    const ownerNotes = cleanText(req.body.owner_notes);
    let query = "";
    if (action === "ACKNOWLEDGE") query = "UPDATE ai_alerts SET status = 'ACKNOWLEDGED', acknowledged_by = $2, acknowledged_at = CURRENT_TIMESTAMP, owner_notes = COALESCE(NULLIF($3, ''), owner_notes), updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *";
    if (action === "SNOOZE") query = "UPDATE ai_alerts SET status = 'SNOOZED', snoozed_until = COALESCE($4::timestamp, CURRENT_TIMESTAMP + INTERVAL '1 day'), owner_notes = COALESCE(NULLIF($3, ''), owner_notes), updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *";
    if (action === "RESOLVE") query = "UPDATE ai_alerts SET status = 'RESOLVED', resolved_by = $2, resolved_at = CURRENT_TIMESTAMP, owner_notes = COALESCE(NULLIF($3, ''), owner_notes), updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *";
    if (!id || !query) return res.status(400).json({ message: "Valid alert id and action are required" });
    const result = await pool.query(query, [id, user.id, ownerNotes, req.body.snoozed_until || null]);
    return res.json(result.rows[0]);
  });

  app.get("/api/ai/reminders", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    return res.json({ reminders: await getReminders(pool) });
  });

  app.get("/api/ai/memory", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin"] });
    if (!user) return;
    const memories = await getMemoryRows(pool, req.query);
    return res.json({ memories });
  });

  app.post("/api/ai/memory/propose", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin"] });
    if (!user) return;
    const draft = req.body.content ? { ...buildMemoryDraftFromText(req.body.content), ...req.body } : req.body;
    if (containsSensitiveMemory(`${draft.title || ""} ${draft.content || ""}`)) {
      return res.status(400).json({ message: "FROST memory cannot store secrets, API keys, passwords or payment credentials" });
    }
    const result = await pool.query(`
      INSERT INTO frost_memories (
        company_id, branch_id, memory_type, entity_type, entity_id, title, content,
        source_type, source_reference, confidence, approval_status, created_by
      )
      VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, 'PENDING_OWNER_APPROVAL', $10)
      RETURNING *
    `, [
      user.branch_id || 1,
      normalizeMemoryType(draft.memory_type),
      cleanText(draft.entity_type),
      cleanText(draft.entity_id),
      cleanText(draft.title || "FROST memory proposal"),
      cleanText(draft.content),
      cleanText(draft.source_type || "owner_statement"),
      cleanText(draft.source_reference || ""),
      Number(draft.confidence || 0.55),
      user.id,
    ]);
    await frost.audit({ userId: user.id, deviceId: req.body.device_id || "", eventType: "FROST_MEMORY_PROPOSED", answer: "FROST memory proposed", suggestedAction: result.rows[0], approvalStatus: "PENDING_OWNER_APPROVAL" });
    return res.status(201).json(result.rows[0]);
  });

  app.post("/api/ai/memory/:id/approve", async (req, res) => {
    const manager = await requireRateManager(req.body.user_id || req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner/Admin can approve FROST memories" });
    const id = parsePositiveInteger(req.params.id);
    const result = await pool.query(`
      UPDATE frost_memories
      SET approval_status = 'APPROVED', approved_by = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [id, manager.id]);
    await frost.audit({ userId: manager.id, eventType: "FROST_MEMORY_APPROVED", answer: "FROST memory approved", suggestedAction: result.rows[0], approvalStatus: "APPROVED" });
    return res.json(result.rows[0]);
  });

  app.patch("/api/ai/memory/:id", async (req, res) => {
    const manager = await requireRateManager(req.body.user_id || req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner/Admin can edit FROST memories" });
    const id = parsePositiveInteger(req.params.id);
    if (containsSensitiveMemory(`${req.body.title || ""} ${req.body.content || ""}`)) {
      return res.status(400).json({ message: "FROST memory cannot store secrets, API keys, passwords or payment credentials" });
    }
    const result = await pool.query(`
      UPDATE frost_memories
      SET memory_type = COALESCE($2, memory_type),
          entity_type = COALESCE($3, entity_type),
          entity_id = COALESCE($4, entity_id),
          title = COALESCE($5, title),
          content = COALESCE($6, content),
          confidence = COALESCE($7, confidence),
          is_active = COALESCE($8, is_active),
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `, [
      id,
      req.body.memory_type ? normalizeMemoryType(req.body.memory_type) : null,
      req.body.entity_type === undefined ? null : cleanText(req.body.entity_type),
      req.body.entity_id === undefined ? null : cleanText(req.body.entity_id),
      req.body.title === undefined ? null : cleanText(req.body.title),
      req.body.content === undefined ? null : cleanText(req.body.content),
      req.body.confidence === undefined ? null : Number(req.body.confidence),
      req.body.is_active === undefined ? null : req.body.is_active === true,
    ]);
    await frost.audit({ userId: manager.id, eventType: "FROST_MEMORY_UPDATED", answer: "FROST memory updated", suggestedAction: result.rows[0] });
    return res.json(result.rows[0]);
  });

  app.delete("/api/ai/memory/:id", async (req, res) => {
    const manager = await requireRateManager(req.body.user_id || req.query.user_id);
    if (!manager) return res.status(403).json({ message: "Only Owner/Admin can delete FROST memories" });
    const id = parsePositiveInteger(req.params.id);
    const result = await pool.query("DELETE FROM frost_memories WHERE id = $1 RETURNING *", [id]);
    await frost.audit({ userId: manager.id, eventType: "FROST_MEMORY_DELETED", answer: "FROST memory deleted", suggestedAction: { id } });
    return res.json({ deleted: Boolean(result.rows[0]), memory: result.rows[0] || null });
  });

  app.get("/api/ai/predictions/inventory", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_inventory_insights", fallbackRoles: ["Owner", "Admin", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    return res.json({ predictions: await getInventoryPredictions(pool) });
  });

  app.get("/api/ai/predictions/sales", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_financial_insights", fallbackRoles: ["Owner", "Admin"] });
    if (!user) return;
    return res.json({ predictions: await getSalesPredictions(pool) });
  });

  app.get("/api/ai/predictions/cashflow", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_financial_insights", fallbackRoles: ["Owner", "Admin"] });
    if (!user) return;
    const settings = await getAiSettings(pool, frost);
    return res.json({ predictions: await getCashflowPredictions(pool, settings) });
  });

  app.get("/api/ai/predictions/waste", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_inventory_insights", fallbackRoles: ["Owner", "Admin", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    return res.json({ predictions: await getWastePredictions(pool) });
  });

  app.get("/api/ai/predictions", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin"] });
    if (!user) return;
    const settings = await getAiSettings(pool, frost);
    const [inventory, sales, cashflow, waste] = await Promise.all([
      getInventoryPredictions(pool),
      getSalesPredictions(pool),
      getCashflowPredictions(pool, settings),
      getWastePredictions(pool),
    ]);
    return res.json({ predictions: { inventory, sales, cashflow, waste } });
  });

  app.get("/api/ai/profit-advisor", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_financial_insights", fallbackRoles: ["Owner", "Admin"] });
    if (!user) return;
    return res.json({ recommendations: await getProfitAdvisorRows(pool) });
  });

  app.get("/api/ai/profit-advisor/products/:id", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_financial_insights", fallbackRoles: ["Owner", "Admin"] });
    if (!user) return;
    const productId = parsePositiveInteger(req.params.id);
    const rows = await getProfitAdvisorRows(pool);
    return res.json(rows.find((row) => Number(row.product_id) === Number(productId)) || null);
  });

  app.get("/api/ai/daily-plan", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin"] });
    if (!user) return;
    const settings = await getAiSettings(pool, frost);
    const range = getRange(req.query);
    const [briefing, predictions, profit] = await Promise.all([
      buildDailyBriefing(pool, settings, range),
      getInventoryPredictions(pool),
      getProfitAdvisorRows(pool),
    ]);
    return res.json({
      period: range,
      topPriorities: briefing.recommendations,
      overdueCollections: briefing.cards.customerOutstanding,
      supplierPaymentsDue: briefing.cards.supplierOutstanding,
      purchaseBills: briefing.cards.pendingPurchases,
      stockLikelyToRunOut: predictions.filter((item) => item.payload?.status === "READY" && item.payload?.daysUntilStockOut <= 7).slice(0, 5),
      saleRateReview: profit.filter((item) => item.proposed_action === "review sale rate").slice(0, 5),
      wasteReview: profit.filter((item) => item.proposed_action === "review waste cause").slice(0, 5),
      expectedCashRequirement: (await getCashflowPredictions(pool, settings))[0],
      recommendedActions: ["Start with critical stock and overdue collections.", "Review margin risks before changing rates.", "Approve only the actions you want FROST to execute later."],
    });
  });

  const requireOwnerIntelligence = async (req, res) => requireAiPermission({
    req,
    res,
    getPermissionUser,
    permission: "ai_financial_insights",
    fallbackRoles: ["Owner", "Admin"],
  });

  app.get("/api/ai/intelligence/pricing", async (req, res) => {
    const user = await requireOwnerIntelligence(req, res);
    if (!user) return;
    return res.json({ recommendations: await getDynamicPricingIntelligence(pool), action_class: "READ_ONLY", approval_required: false });
  });

  app.get("/api/ai/intelligence/purchase-planner", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_inventory_insights", fallbackRoles: ["Owner", "Admin", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    return res.json({ recommendations: await getSmartPurchasePlanner(pool), action_class: "READ_ONLY", approval_required: false });
  });

  app.get("/api/ai/intelligence/waste-prevention", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_inventory_insights", fallbackRoles: ["Owner", "Admin", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    return res.json({ lots: await getWastePreventionIntelligence(pool), action_class: "READ_ONLY", approval_required: false });
  });

  app.get("/api/ai/intelligence/customers", async (req, res) => {
    const user = await requireOwnerIntelligence(req, res);
    if (!user) return;
    return res.json({ customers: await getCustomerIntelligence(pool), action_class: "READ_ONLY", approval_required: false });
  });

  app.get("/api/ai/intelligence/suppliers", async (req, res) => {
    const user = await requireOwnerIntelligence(req, res);
    if (!user) return;
    return res.json({ suppliers: await getSupplierIntelligence(pool), action_class: "READ_ONLY", approval_required: false });
  });

  app.get("/api/ai/intelligence/profit-optimizer", async (req, res) => {
    const user = await requireOwnerIntelligence(req, res);
    if (!user) return;
    return res.json(await getProfitOptimizer(pool));
  });

  app.get("/api/ai/intelligence/cashflow", async (req, res) => {
    const user = await requireOwnerIntelligence(req, res);
    if (!user) return;
    const settings = await getAiSettings(pool, frost);
    return res.json({ predictions: await getCashFlowPredictor(pool, settings), action_class: "READ_ONLY", approval_required: false });
  });

  app.get("/api/ai/intelligence/demand", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_inventory_insights", fallbackRoles: ["Owner", "Admin", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    return res.json({ forecasts: await getDemandForecast(pool), action_class: "READ_ONLY", approval_required: false });
  });

  app.get("/api/ai/intelligence/health", async (req, res) => {
    const user = await requireOwnerIntelligence(req, res);
    if (!user) return;
    const settings = await getAiSettings(pool, frost);
    return res.json({ health: await getBusinessHealth(pool, settings) });
  });

  app.get("/api/ai/intelligence/decision-center", async (req, res) => {
    const user = await requireOwnerIntelligence(req, res);
    if (!user) return;
    const settings = await getAiSettings(pool, frost);
    return res.json(await getOwnerDecisionCenter(pool, settings));
  });

  app.get("/api/ai/autonomous", async (req, res) => {
    const user = await requireOwnerIntelligence(req, res);
    if (!user) return;
    const settings = await getAiSettings(pool, frost);
    const [pricing, purchases, waste, customers, suppliers, profit, cashflow, demand, health] = await Promise.all([
      getDynamicPricingIntelligence(pool),
      getSmartPurchasePlanner(pool),
      getWastePreventionIntelligence(pool),
      getCustomerIntelligence(pool),
      getSupplierIntelligence(pool),
      getProfitOptimizer(pool),
      getCashFlowPredictor(pool, settings),
      getDemandForecast(pool),
      getBusinessHealth(pool, settings),
    ]);
    const decisionCenter = buildOwnerDecisionCenterFromParts({ pricing, purchases, waste, customers, suppliers, profit, cashflow, demand, health });
    return res.json({
      pricing,
      purchases,
      waste,
      customers,
      suppliers,
      profit,
      cashflow,
      demand,
      health,
      decisionCenter,
      policy: "FROST never changes prices, creates purchases, sends messages, updates inventory or modifies financial data without owner approval.",
    });
  });

  app.post("/api/ai/reminders", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_reminder_manage", actionClass: "SAFE_PERSONAL_WRITE" });
    if (!user) return;
    const reminderType = cleanText(req.body.reminder_type || "OWNER_NOTE").toUpperCase();
    const entityType = cleanText(req.body.linked_entity_type || "manual");
    const entityId = cleanText(req.body.linked_entity_id || "");
    const dueAt = req.body.due_at || null;
    const dedupKey = buildReminderDedupKey({ reminderType, entityType, entityId, dueDate: dueAt || toDateKey() });
    const result = await pool.query(`
      INSERT INTO ai_reminders (company_id, branch_id, dedup_key, reminder_type, priority, due_at, linked_entity_type, linked_entity_id, title, message, draft_message, owner_notes, created_by)
      VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (dedup_key)
      DO UPDATE SET updated_at = CURRENT_TIMESTAMP, owner_notes = COALESCE(EXCLUDED.owner_notes, ai_reminders.owner_notes)
      RETURNING *
    `, [
      user.branch_id || 1,
      dedupKey,
      reminderType,
      cleanText(req.body.priority || "ATTENTION").toUpperCase(),
      dueAt,
      entityType,
      entityId,
      cleanText(req.body.title || "AI reminder"),
      cleanText(req.body.message || "Follow up required"),
      cleanText(req.body.draft_message || ""),
      cleanText(req.body.owner_notes || ""),
      user.id,
    ]);
    return res.status(201).json(result.rows[0]);
  });

  app.patch("/api/ai/reminders/:id", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_reminder_manage", actionClass: "SAFE_PERSONAL_WRITE" });
    if (!user) return;
    const id = parsePositiveInteger(req.params.id);
    const action = cleanText(req.body.action).toUpperCase();
    const ownerNotes = cleanText(req.body.owner_notes);
    let query = "";
    if (action === "ACKNOWLEDGE") query = "UPDATE ai_reminders SET status = 'ACKNOWLEDGED', acknowledged_by = $2, acknowledged_at = CURRENT_TIMESTAMP, owner_notes = COALESCE(NULLIF($3, ''), owner_notes), updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *";
    if (action === "SNOOZE") query = "UPDATE ai_reminders SET status = 'SNOOZED', snoozed_until = COALESCE($4::timestamp, CURRENT_TIMESTAMP + INTERVAL '1 day'), owner_notes = COALESCE(NULLIF($3, ''), owner_notes), updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *";
    if (action === "RESOLVE") query = "UPDATE ai_reminders SET status = 'RESOLVED', resolved_by = $2, resolved_at = CURRENT_TIMESTAMP, owner_notes = COALESCE(NULLIF($3, ''), owner_notes), updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *";
    if (!id || !query) return res.status(400).json({ message: "Valid reminder id and action are required" });
    const result = await pool.query(query, [id, user.id, ownerNotes, req.body.snoozed_until || null]);
    return res.json(result.rows[0]);
  });

  app.post("/api/ai/query", async (req, res) => {
    const question = cleanText(req.body.question);
    if (!question) return res.status(400).json({ message: "Question is required" });
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    const settings = await getAiSettings(pool, frost);
    const range = getRange(req.body);
    const classification = classifyBusinessIntent(question);
    if (["SALES_FINANCE", "CASH_DRAWER", "SUPPLIER_MARGIN", "PROFIT_RANKING", "LOSS_REVIEW", "SALE_RATE_REVIEW"].includes(classification)) {
      const allowed = await getPermissionUser(user.id, "ai_financial_insights", ["Owner", "Admin"]);
      if (!allowed) return res.status(403).json({ message: "Financial AI insights require Owner/Admin permission" });
    }
    if (["INVENTORY", "INVENTORY_EXPIRY", "PURCHASE_PLANNING"].includes(classification)) {
      const allowed = await getPermissionUser(user.id, "ai_inventory_insights", ["Owner", "Admin", "Purchase Manager", "Inventory Manager"]);
      if (!allowed) return res.status(403).json({ message: "Inventory AI insights are not enabled for this role" });
    }
    const facts = await factsForBusinessIntent(pool, classification, settings, range);
    const providerKey = settings.provider?.key || "deterministic";
    const cacheKey = frost.buildCacheKey({ engine: "conversation", question, facts, range, providerKey });
    const cached = settings.frost.cacheEnabled !== false ? await frost.getCache(cacheKey) : null;
    const cachedPayload = cached?.response_payload || null;
    const providerAnswer = cachedPayload?.answer || null;
    const answer = providerAnswer || buildDeterministicAnswer(classification, facts, range);
    if (!assertGroundedAnswer({ answer, facts })) return res.status(500).json({ message: "AI answer was not grounded in verified facts" });
    const conversationId = await auditQuestion({
      pool,
      user,
      deviceId: req.body.device_id || req.headers["x-device-id"],
      question,
      classification,
      range,
      facts,
      answer,
    });
    const usage = await frost.recordTokenUsage({
      conversationId,
      engine: "conversation",
      providerKey,
      model: settings.frost.model || "",
      inputPayload: { question, facts, range },
      outputText: answer,
    });
    if (!cachedPayload && settings.frost.cacheEnabled !== false) {
      await frost.setCache({
        cacheKey,
        engine: "conversation",
        providerKey,
        requestPayload: { question, facts, range },
        responsePayload: { answer, facts, period: range },
      });
    }
    return res.json({
      assistant: FROST_ASSISTANT_NAME,
      conversation_id: conversationId,
      classification,
      period: range,
      answer,
      facts,
      provider: settings.provider,
      cached: Boolean(cachedPayload),
      usage,
      action_class: "READ_ONLY",
      approval_required: false,
      approval_required_for_writes: true,
    });
  });

  app.post("/api/ai/query/stream", async (req, res) => {
    const question = cleanText(req.body.question);
    if (!question) return res.status(400).json({ message: "Question is required" });
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    const settings = await getAiSettings(pool, frost);
    const range = getRange(req.body);
    const classification = classifyBusinessIntent(question);
    const facts = await factsForBusinessIntent(pool, classification, settings, range);
    const answer = buildDeterministicAnswer(classification, facts, range);
    const conversationId = await auditQuestion({
      pool,
      user,
      deviceId: req.body.device_id || req.headers["x-device-id"],
      question,
      classification,
      range,
      facts,
      answer,
    });
    const usage = await frost.recordTokenUsage({
      conversationId,
      engine: "conversation",
      providerKey: settings.provider?.key || "deterministic",
      model: settings.frost.model || "",
      inputPayload: { question, facts, range },
      outputText: answer,
    });
    res.write(`event: meta\ndata: ${JSON.stringify({ assistant: FROST_ASSISTANT_NAME, conversation_id: conversationId, period: range, provider: settings.provider, usage })}\n\n`);
    for (const chunk of answer.match(/.{1,160}(\s|$)/g) || [answer]) {
      res.write(`event: delta\ndata: ${JSON.stringify({ text: chunk.trim() })}\n\n`);
    }
    res.write(`event: done\ndata: ${JSON.stringify({ done: true })}\n\n`);
    return res.end();
  });

  app.post("/api/ai/actions/propose", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"], actionClass: "BUSINESS_WRITE" });
    if (!user) return;
    const actionType = cleanText(req.body.action_type || req.body.action || "").toUpperCase().replace(/\s+/g, "_");
    if (!actionType) return res.status(400).json({ message: "Action type is required" });
    const proposal = await frost.createActionProposal({
      conversationId: parsePositiveInteger(req.body.conversation_id),
      actionType,
      payload: req.body.payload || {},
      proposedBy: user.id,
    });
    return res.status(201).json({
      proposal,
      approval_required: proposal.approval_status === "PENDING_OWNER_APPROVAL",
      message: proposal.approval_status === "PENDING_OWNER_APPROVAL"
        ? "FROST has prepared this action for owner approval. Nothing was executed."
        : "FROST recorded this read-only action.",
    });
  });

  app.post("/api/ai/voice/session", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin"] });
    if (!user) return;
    try {
      const session = await frost.createRealtimeSession({
        userId: user.id,
        deviceId: req.body.device_id || req.headers["x-device-id"],
        providerKey: req.body.provider_key || "openai",
      });
      return res.json(session);
    } catch (error) {
      console.error("FROST voice session error", error);
      return res.status(500).json({ configured: false, message: "Unable to prepare FROST voice session" });
    }
  });

  app.get("/api/ai/voice/status", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin"] });
    if (!user) return;
    const apiKeyConfigured = Boolean(String(process.env.OPENAI_API_KEY || "").trim());
    const provider = String(process.env.AI_PROVIDER || "openai").trim() || "openai";
    const model = String(process.env.AI_REALTIME_MODEL || process.env.AI_VOICE_MODEL || "gpt-realtime").trim();
    return res.json({
      configured: apiKeyConfigured,
      provider,
      status: apiKeyConfigured ? "Ready" : "Provider not configured",
      model: apiKeyConfigured ? model : "",
      supports_transcription: apiKeyConfigured,
      supports_speech: apiKeyConfigured,
      message: apiKeyConfigured
        ? "FROST Voice provider is configured. Test microphone and transcription in the installed app."
        : "Voice provider is not configured. Open Settings > Integrations > Voice.",
    });
  });

  app.post("/api/ai/voice/transcribe", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin"] });
    if (!user) return;
    if (!String(process.env.OPENAI_API_KEY || "").trim()) {
      return res.status(503).json({
        configured: false,
        code: "VOICE_PROVIDER_NOT_CONFIGURED",
        status: "Provider not configured",
        message: "Voice provider is not configured. Open Settings > Integrations > Voice.",
        text_fallback_available: true,
      });
    }
    return res.status(501).json({
      configured: true,
      code: "VOICE_TRANSCRIPTION_UPLOAD_NOT_IMPLEMENTED",
      status: "Error",
      message: "Server-side audio upload transcription is not enabled in this build. Use the installed app text fallback or Realtime voice session.",
      text_fallback_available: true,
    });
  });

  app.post("/api/ai/voice/speak", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, getCanonicalIdentity, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin"] });
    if (!user) return;
    if (!String(process.env.OPENAI_API_KEY || "").trim()) {
      return res.status(503).json({
        configured: false,
        code: "VOICE_PROVIDER_NOT_CONFIGURED",
        status: "Provider not configured",
        message: "Voice provider is not configured. Open Settings > Integrations > Voice.",
        text_fallback_available: true,
      });
    }
    return res.status(501).json({
      configured: true,
      code: "VOICE_SPEECH_OUTPUT_NOT_IMPLEMENTED",
      status: "Error",
      message: "Server-side speech output is not enabled in this build. Use the installed app text answer or Realtime voice session.",
      text_fallback_available: true,
    });
  });
};

module.exports = {
  registerAiBusinessAssistantRoutes,
  buildFrostPolicy,
  normalizeRoleName,
};
