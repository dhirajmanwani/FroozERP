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
  "Show the oldest outstanding balances.",
  "Which supplier payments are due?",
  "Which purchase bills are still pending?",
  "What products are low in stock?",
  "What were today's sales and profit?",
  "Which products had unusually low margins?",
  "What were the largest expenses this month?",
  "Which items generated the most waste?",
];

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");
const parsePositiveInteger = (value) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};
const toNumber = (value) => Number(value || 0);
const roundCurrency = (value) => Number(toNumber(value).toFixed(2));
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

const requireAiPermission = async ({ req, res, getPermissionUser, permission, fallbackRoles = ["Owner", "Admin"] }) => {
  const userId = req.query.user_id || req.body?.user_id || req.headers["x-user-id"];
  const user = await getPermissionUser(userId, permission, fallbackRoles);
  if (!user) {
    res.status(403).json({ message: "You do not have permission to use this FROST feature" });
    return null;
  }
  return user;
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
    SELECT payment_mode, SUM(amount) AS amount
    FROM sale_payments sp
    JOIN sales s ON s.id = sp.sale_id
    WHERE s.sale_date BETWEEN $1 AND $2
      AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
    GROUP BY payment_mode
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

const buildDailyBriefing = async (pool, settings, range) => {
  await runAlertRules(pool, settings);
  const [sales, collections, customerOutstanding, supplierOutstanding, pendingPurchases, lowStock, waste, expiringLots, salesRanking, alerts] = await Promise.all([
    getDailySalesSummary(pool, range),
    getCollectionSummary(pool, range),
    getCustomerOutstanding(pool, settings),
    getSupplierOutstanding(pool),
    getPendingPurchaseBills(pool),
    getLowStockProducts(pool),
    getWasteSummary(pool, range),
    getInventoryNearingExpiry(pool, settings),
    getProductSalesRanking(pool, range),
    getStoredAlerts(pool),
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

const registerAiBusinessAssistantRoutes = ({ app, pool, getPermissionUser, requireRateManager }) => {
  const frost = new FrostServiceLayer({ pool });

  app.get("/api/ai/frost/status", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
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
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_settings_manage" });
    if (!user) return;
    return res.json({ assistant: FROST_ASSISTANT_NAME, providers: frost.getProviderOptions() });
  });

  app.get("/api/ai/suggested-questions", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    return res.json({ questions: SUGGESTED_QUESTIONS });
  });

  app.get("/api/ai/settings", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_settings_manage" });
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
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    const settings = await getAiSettings(pool, frost);
    const range = getRange(req.query);
    const briefing = await buildDailyBriefing(pool, settings, range);
    return res.json(briefing);
  });

  app.get("/api/ai/alerts", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    return res.json({ alerts: await getStoredAlerts(pool) });
  });

  app.patch("/api/ai/alerts/:id", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_reminder_manage" });
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
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    return res.json({ reminders: await getReminders(pool) });
  });

  app.post("/api/ai/reminders", async (req, res) => {
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_reminder_manage" });
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
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_reminder_manage" });
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
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
    if (!user) return;
    const settings = await getAiSettings(pool, frost);
    const range = getRange(req.body);
    const classification = classifyBusinessIntent(question);
    if (classification === "SALES_FINANCE" || classification === "CASH_DRAWER" || classification === "SUPPLIER_MARGIN") {
      const allowed = await getPermissionUser(user.id, "ai_financial_insights", ["Owner", "Admin"]);
      if (!allowed) return res.status(403).json({ message: "Financial AI insights require Owner/Admin permission" });
    }
    if (classification === "INVENTORY" || classification === "INVENTORY_EXPIRY") {
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
      approval_required_for_writes: true,
    });
  });

  app.post("/api/ai/query/stream", async (req, res) => {
    const question = cleanText(req.body.question);
    if (!question) return res.status(400).json({ message: "Question is required" });
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
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
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"] });
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
    const user = await requireAiPermission({ req, res, getPermissionUser, permission: "ai_assistant_view", fallbackRoles: ["Owner", "Admin"] });
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
};

module.exports = {
  registerAiBusinessAssistantRoutes,
};
