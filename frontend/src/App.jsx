import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import QRCode from "qrcode";
import "./App.css";

const API_URL = "http://localhost:5000";
const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
});
const receiptCurrency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const roundUi = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const defaultPurchaseRules = {
  mandiTaxRules: [],
  rebateRules: [],
};

const icons = {
  dashboard: "grid",
  products: "box",
  purchase: "cart",
  inventory: "layers",
  returns: "history",
  waste: "alert",
  sales: "receipt",
  "sales-history": "history",
  expenses: "wallet",
  accounts: "users",
  reports: "chart",
  settings: "settings",
  "sale-rates": "trend",
};

const navigationItems = [
  ["dashboard", "Dashboard"],
  ["products", "Products"],
  ["purchase", "Purchase Entry"],
  ["accounts", "Accounts"],
  ["inventory", "Inventory"],
  ["returns", "Sale Returns"],
  ["waste", "Waste Management"],
  ["sales", "POS Billing"],
  ["sales-history", "Sales History"],
  ["sale-rates", "Sale Rate Update"],
  ["expenses", "Expenses"],
  ["reports", "Reports"],
  ["settings", "Settings"],
];

const getErrorMessage = (error, fallback) =>
  error.response?.data?.message || fallback;

const toDateKey = (date) =>
  typeof date === "string" ? date.slice(0, 10) : date.toLocaleDateString("en-CA");

const supplierPaymentModes = [
  ["CASH", "Cash"],
  ["UPI", "UPI"],
  ["BANK_TRANSFER", "Bank Transfer"],
  ["CHEQUE", "Cheque"],
];

const accountTypes = [
  ["CUSTOMER", "Customer"],
  ["SUPPLIER", "Supplier"],
  ["TRANSPORT_VENDOR", "Transport Vendor"],
  ["COMMISSION_AGENT", "Commission Agent"],
  ["STAFF", "Staff"],
  ["OTHER", "Other"],
];

const accountPaymentActions = [
  ["RECEIVE_CUSTOMER", "Receive Payment from Customer"],
  ["PAY_SUPPLIER", "Pay Supplier"],
];

const defaultRolePermissions = {
  Owner: { all: true },
  Admin: { all: true },
  Cashier: { dashboard: true, sales: true, "sales-history": true, accounts: true },
  "Purchase Manager": { dashboard: true, purchase: true, accounts: true, reports: true },
  "Inventory Manager": { dashboard: true, inventory: true, waste: true, reports: true },
};

const modulePermissionMap = {
  dashboard: "dashboard",
  products: "inventory",
  purchase: "purchases",
  accounts: "supplier_accounts",
  inventory: "inventory",
  returns: "billing",
  waste: "waste_management",
  sales: "billing",
  "sales-history": "billing",
  "sale-rates": "discounts",
  expenses: "reports",
  reports: "reports",
  settings: "settings",
};

const ledgerModes = [
  ["ANY", "Any Account Ledger"],
  ["CUSTOMER", "Customer Ledger"],
  ["SUPPLIER", "Supplier Ledger"],
];

const discountTypes = [
  ["FLAT_AMOUNT", "Flat Amount"],
  ["PERCENTAGE", "Percentage"],
];

const dashboardRanges = [
  ["7", "Last 7 Days"],
  ["15", "Last 15 Days"],
  ["30", "Last 30 Days"],
  ["custom", "Custom Range"],
];

const emptyDashboardAnalytics = {
  dateFrom: "",
  dateTo: "",
  days: 7,
  summary: {
    todaySales: 0,
    todayProfit: 0,
    stockValue: 0,
    lowStockItems: 0,
    transactions: 0,
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
  },
  salesTrend: [],
  profitTrend: [],
  expenseTrend: [],
  netProfitTrend: [],
  purchaseSalesComparison: [],
  topSellingProducts: [],
  lowStockItems: [],
  insights: [],
};

const discountPaymentModes = [
  ["ALL", "All"],
  ["CASH", "Cash"],
  ["UPI", "UPI"],
  ["CARD", "Card"],
];

const roundingRules = [
  ["NEAREST_RUPEE", "Nearest rupee"],
  ["ROUND_UP_5", "Round up to ₹5"],
  ["ROUND_UP_10", "Round up to ₹10"],
  ["NO_ROUND", "No rounding"],
];

const defaultBusinessSettings = {
  business_name: "FroozERP Retail",
  brand_name: "FEEL THE FREAKIN' FROOZ",
  company_name: "SRT Company",
  address: "",
  phone_number: "",
  gst_number: "",
  logo_url: "",
  compact_logo_text: "FTF",
  invoice_footer_text: "Thank you for shopping with FEEL THE FREAKIN' FROOZ.",
  default_printer_type: "THERMAL",
  receipt_width: "80MM",
  auto_print_after_billing: false,
};

const defaultSaleRateSettings = {
  desired_margin_percent: 25,
  rounding_rule: "NEAREST_RUPEE",
  suggestion_enabled: true,
  notes: "",
};

const defaultPosSettings = {
  enable_weighing_scale: false,
  scale_connection_type: "MANUAL_FALLBACK",
  scale_com_port: "",
  scale_baud_rate: 9600,
  scale_auto_read: false,
};

const defaultPaymentSettings = {
  business_upi_id: "",
  upi_payee_name: "FEEL THE FREAKIN' FROOZ",
  enable_upi_qr_on_invoice: false,
  show_upi_qr_on_all_bills: false,
};

function BrandLogo({ compact = false, invoice = false }) {
  return (
    <div className={`${invoice ? "brand-lockup brand-lockup-invoice" : "brand-lockup"} ${compact ? "brand-lockup-compact" : ""}`}>
      <span className="brand-monogram">
        <svg aria-hidden="true" viewBox="0 0 48 48">
          <path d="M13 12h21M13 23h16M13 12v24M25 12v24M25 34h11" />
          <path className="brand-monogram-accent" d="M34 12h4M13 36h4" />
        </svg>
      </span>
      {!compact && (
        <span className="brand-copy">
          <strong>FEEL THE FREAKIN&apos; FROOZ</strong>
          <small>by SRT Company</small>
        </span>
      )}
    </div>
  );
}

function Icon({ name, size = 18 }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
    box: <><path d="m21 8-9 5-9-5" /><path d="M3 8l9-5 9 5v8l-9 5-9-5Z" /><path d="M12 13v8" /></>,
    cart: <><circle cx="9" cy="20" r="1" /><circle cx="19" cy="20" r="1" /><path d="M3 4h2l3 11h11l2-7H7" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></>,
    receipt: <><path d="M5 3v18l3-2 4 2 4-2 3 2V3l-3 2-4-2-4 2Z" /><path d="M9 9h6M9 13h6" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v6h6M12 7v5l3 2" /></>,
    wallet: <><path d="M4 5h16v14H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /><path d="M16 12h4M16 12h.01" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
    chart: <><path d="M3 3v18h18" /><path d="m7 16 4-5 4 3 5-7" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.8 1.8 0 0 0 .4 2l.1.1-2.8 2.8-.1-.1a1.8 1.8 0 0 0-2-.4 1.8 1.8 0 0 0-1 1.6v.2h-4V21a1.8 1.8 0 0 0-1-1.6 1.8 1.8 0 0 0-2 .4l-.1.1-2.8-2.8.1-.1a1.8 1.8 0 0 0 .4-2A1.8 1.8 0 0 0 3 14H2.8v-4H3a1.8 1.8 0 0 0 1.6-1 1.8 1.8 0 0 0-.4-2l-.1-.1 2.8-2.8.1.1a1.8 1.8 0 0 0 2 .4A1.8 1.8 0 0 0 10 3v-.2h4V3a1.8 1.8 0 0 0 1 1.6 1.8 1.8 0 0 0 2-.4l.1-.1 2.8 2.8-.1.1a1.8 1.8 0 0 0-.4 2A1.8 1.8 0 0 0 21 10h.2v4H21a1.8 1.8 0 0 0-1.6 1Z" /></>,
    trend: <><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
    rupee: <><path d="M6 4h12M6 8h12M7 4c5 0 6 8 0 8h-1l8 8" /></>,
    alert: <><path d="m12 3 10 18H2Z" /><path d="M12 9v4M12 17h.01" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3M21 19V5a2 2 0 0 0-2-2h-6" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
    barcode: <><path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14M21 5v14" /></>,
    trash: <><path d="M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 14h10l1-14" /></>,
    print: <><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6Z" /></>,
    message: <><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-3.8-1L3 20l1.3-4A8.3 8.3 0 1 1 21 11.5Z" /></>,
    close: <><path d="M18 6 6 18M6 6l12 12" /></>,
  };

  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
    >
      {paths[name]}
    </svg>
  );
}

function App() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState(null);
  const [activeView, setActiveView] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [products, setProducts] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [salesHistory, setSalesHistory] = useState([]);
  const [saleReturns, setSaleReturns] = useState([]);
  const [wasteEntries, setWasteEntries] = useState([]);
  const [purchaseRules, setPurchaseRules] = useState(defaultPurchaseRules);
  const [settingsRules, setSettingsRules] = useState(defaultPurchaseRules);
  const [settingsData, setSettingsData] = useState({
    businessSettings: defaultBusinessSettings,
    saleRateSettings: defaultSaleRateSettings,
    posSettings: defaultPosSettings,
    paymentSettings: defaultPaymentSettings,
    discountRules: [],
    roles: [],
    users: [],
    updateCenter: {},
    syncSettings: {},
    backupSettings: {},
    canManageSettings: false,
  });
  const [discountRules, setDiscountRules] = useState([]);
  const [saleRates, setSaleRates] = useState([]);
  const [saleRateHistory, setSaleRateHistory] = useState([]);
  const [saleDesiredMargin, setSaleDesiredMargin] = useState("25");
  const [suppliers, setSuppliers] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [accountLedger, setAccountLedger] = useState({ account: null, ledger: [] });
  const [accountPayments, setAccountPayments] = useState([]);
  const [accountOutstanding, setAccountOutstanding] = useState({
    customerOutstanding: [],
    supplierOutstanding: [],
    totalReceivable: 0,
    totalPayable: 0,
  });
  const [reportsData, setReportsData] = useState({
    salesReport: [],
    purchaseReport: [],
    supplierOutstandingReport: [],
    customerOutstandingReport: [],
    discountReport: [],
    expenseReport: [],
    paymentReport: [],
    paymentModeSummary: [],
    returnReport: [],
    returnReasonReport: [],
    wasteReport: [],
    wasteProductReport: [],
    mostWastedProducts: [],
    pendingPurchaseBillsReport: [],
    stockWithoutBillReport: [],
    provisionalProfitSalesReport: [],
    balanceSheet: {},
    profitLoss: {},
  });
  const [expenses, setExpenses] = useState([]);
  const [dashboardRange, setDashboardRange] = useState("7");
  const [dashboardCustomRange, setDashboardCustomRange] = useState({
    date_from: toDateKey(new Date()),
    date_to: toDateKey(new Date()),
  });
  const [dashboardAnalytics, setDashboardAnalytics] = useState(emptyDashboardAnalytics);
  const [supplierDashboard, setSupplierDashboard] = useState({
    todaySales: 0,
    todayProfit: 0,
    stockValue: 0,
    lowStockItems: 0,
    transactions: 0,
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
    total_supplier_outstanding: 0,
    total_rebate_received: 0,
    todays_supplier_payments: 0,
  });

  const [productName, setProductName] = useState("");
  const [sellingRate, setSellingRate] = useState("");
  const [productBarcode, setProductBarcode] = useState("");
  const [productOriginType, setProductOriginType] = useState("LOCAL");
  const [productCategory, setProductCategory] = useState("Fruit");
  const [productMinimumStock, setProductMinimumStock] = useState("");
  const [productActive, setProductActive] = useState(true);
  const [editingProductId, setEditingProductId] = useState(null);
  const [unit, setUnit] = useState("");
  const [purchaseSupplierId, setPurchaseSupplierId] = useState("");
  const [purchaseProductId, setPurchaseProductId] = useState("");
  const [purchaseQuantity, setPurchaseQuantity] = useState("");
  const [purchaseRateInput, setPurchaseRateInput] = useState("");
  const [purchaseFreightCharges, setPurchaseFreightCharges] = useState("");
  const [purchaseLabourCharges, setPurchaseLabourCharges] = useState("");
  const [purchaseOtherCharges, setPurchaseOtherCharges] = useState("");
  const [purchasePaidAmount, setPurchasePaidAmount] = useState("");
  const [purchaseBillStatus, setPurchaseBillStatus] = useState("BILL_COMPLETED");
  const [purchaseDate, setPurchaseDate] = useState(toDateKey(new Date()));
  const [temporarySaleRate, setTemporarySaleRate] = useState("");
  const [expectedPurchaseRate, setExpectedPurchaseRate] = useState("");
  const [purchaseBillNumber, setPurchaseBillNumber] = useState("");
  const [purchaseBillDate, setPurchaseBillDate] = useState("");
  const [purchaseType, setPurchaseType] = useState("CREDIT");
  const [purchasePaymentMode, setPurchasePaymentMode] = useState("CASH");
  const [purchasePaymentReference, setPurchasePaymentReference] = useState("");
  const [purchaseRebateRuleId, setPurchaseRebateRuleId] = useState("");
  const [purchasePaymentDate, setPurchasePaymentDate] = useState("");
  const [purchaseRemarks, setPurchaseRemarks] = useState("");
  const [purchaseItemRemarks, setPurchaseItemRemarks] = useState("");
  const [purchaseCart, setPurchaseCart] = useState([]);
  const [editingPurchaseItemIndex, setEditingPurchaseItemIndex] = useState(null);
  const [editingPurchaseId, setEditingPurchaseId] = useState(null);
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [editingSale, setEditingSale] = useState(null);
  const [changeHistory, setChangeHistory] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [accountLedgerFocusKey, setAccountLedgerFocusKey] = useState("");

  const rolePermissionMap = useMemo(() => {
    const map = new Map();
    for (const role of settingsData.roles || []) map.set(role.role_name || role.role, role.permissions || {});
    return map;
  }, [settingsData.roles]);

  const hasModuleAccess = (view) => {
    if (!user) return false;
    const roleName = user.role;
    const defaultPermissions = defaultRolePermissions[roleName] || {};
    if (defaultPermissions.all || defaultPermissions[view]) return true;
    const permissionKey = modulePermissionMap[view];
    const permissions = rolePermissionMap.get(roleName);
    if (view === "accounts" && permissions) {
      return Boolean(permissions.customer_payments || permissions.supplier_payments || permissions.supplier_accounts);
    }
    if (!permissions || !permissionKey || permissionKey === "dashboard") return view === "dashboard";
    return Boolean(permissions[permissionKey]);
  };

  const kpis = useMemo(() => {
    const today = toDateKey(new Date());
    const todaysSales = salesHistory.filter((sale) => toDateKey(sale.sale_date) === today);
    const total = (items, key) =>
      items.reduce((sum, item) => sum + Number(item[key] || 0), 0);
    const stockValue = inventory.reduce(
      (sum, item) => sum + Number(item.remaining_qty || 0) * Number(item.effective_cost_per_unit || item.purchase_rate || 0),
      0
    );
    const stockByProduct = inventory.reduce((stock, item) => {
      stock.set(item.product_name, (stock.get(item.product_name) || 0) + Number(item.remaining_qty || 0));
      return stock;
    }, new Map());
    const lowStockItems = [...stockByProduct.values()].filter((quantity) => quantity <= 5).length;
    const analyticsSummary = dashboardAnalytics.summary || {};
    const metrics = {
      todaySales: supplierDashboard.todaySales ?? total(todaysSales, "amount"),
      todayProfit: supplierDashboard.todayProfit ?? total(todaysSales, "profit"),
      stockValue: supplierDashboard.stockValue ?? stockValue,
      lowStockItems: supplierDashboard.lowStockItems ?? lowStockItems,
      transactions: supplierDashboard.transactions ?? todaysSales.length,
      supplierOutstanding: supplierDashboard.supplierOutstanding ?? supplierDashboard.total_supplier_outstanding ?? 0,
      customerOutstanding: analyticsSummary.customerOutstanding ?? supplierDashboard.customerOutstanding ?? 0,
      todayExpenses: analyticsSummary.todayExpenses ?? supplierDashboard.todayExpenses ?? 0,
      todayReturns: analyticsSummary.todayReturns ?? supplierDashboard.todayReturns ?? 0,
      monthlyReturns: analyticsSummary.monthlyReturns ?? supplierDashboard.monthlyReturns ?? 0,
      todayWaste: analyticsSummary.todayWaste ?? supplierDashboard.todayWaste ?? 0,
      monthlyWaste: analyticsSummary.monthlyWaste ?? supplierDashboard.monthlyWaste ?? 0,
      wastePercentage: analyticsSummary.wastePercentage ?? supplierDashboard.wastePercentage ?? 0,
      totalRebateReceived: supplierDashboard.totalRebateReceived ?? supplierDashboard.total_rebate_received ?? 0,
      todaySupplierPayments: supplierDashboard.todaySupplierPayments ?? supplierDashboard.todays_supplier_payments ?? 0,
    };

    return [
      ["Today's Sales", currency.format(Number(metrics.todaySales || 0)), "rupee"],
      ["Today's Profit", currency.format(Number(metrics.todayProfit || 0)), "trend"],
      ["Stock Value", currency.format(Number(metrics.stockValue || 0)), "layers"],
      ["Supplier Outstanding", currency.format(Number(metrics.supplierOutstanding || 0)), "wallet"],
      ["Customer Outstanding", currency.format(Number(metrics.customerOutstanding || 0)), "users"],
      ["Today's Expenses", currency.format(Number(metrics.todayExpenses || 0)), "wallet"],
      ["Total Rebate Received", currency.format(Number(metrics.totalRebateReceived || 0)), "trend"],
      ["Today's Supplier Payments", currency.format(Number(metrics.todaySupplierPayments || 0)), "rupee"],
      ["Today's Returns", currency.format(Number(metrics.todayReturns || 0)), "history"],
      ["Monthly Returns", currency.format(Number(metrics.monthlyReturns || 0)), "history"],
      ["Today's Waste", currency.format(Number(metrics.todayWaste || 0)), "alert"],
      ["Monthly Waste", currency.format(Number(metrics.monthlyWaste || 0)), "alert"],
      ["Waste Percentage", `${Number(metrics.wastePercentage || 0).toFixed(2)}%`, "chart"],
      ["Low Stock Items", Number(metrics.lowStockItems || 0), "alert"],
      ["Transactions", Number(metrics.transactions || 0), "receipt"],
    ];
  }, [dashboardAnalytics, inventory, salesHistory, supplierDashboard]);

  const activeSuppliers = useMemo(
    () => suppliers.filter((supplier) =>
      supplier.active !== false &&
      !["TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(supplier.supplier_type)
    ),
    [suppliers]
  );

  const selectedPurchaseProduct = useMemo(
    () => products.find((product) => String(product.id) === purchaseProductId),
    [products, purchaseProductId]
  );

  const purchaseSummary = useMemo(() => {
    const quantity = Number(purchaseQuantity || 0);
    const rate = Number(purchaseRateInput || 0);
    if (purchaseBillStatus === "BILL_PENDING") {
      const expectedRate = Number(expectedPurchaseRate || 0);
      return {
        basicAmount: quantity * expectedRate,
        mandiTaxPercent: 0,
        mandiTaxAmount: 0,
        freightCharges: 0,
        labourCharges: 0,
        otherCharges: 0,
        grossAmount: quantity * expectedRate,
        rebatePercent: 0,
        rebateAmount: 0,
        netPayable: 0,
        balanceAmount: 0,
        effectiveCostPerUnit: expectedRate,
        paymentStatus: "Bill Pending",
      };
    }
    const otherCharges = Number(purchaseOtherCharges || 0);
    const paidAmount = purchaseType === "CASH" ? Number(purchasePaidAmount || 0) : 0;
    const freightCharges = Number(purchaseFreightCharges || 0);
    const labourCharges = Number(purchaseLabourCharges || 0);
    const mandiTaxPercent = Number(purchaseRules.mandiTaxRules.find((rule) => rule.origin_type === (selectedPurchaseProduct?.origin_type || "LOCAL"))?.tax_percent || 0);
    const rebateRule = purchaseRules.rebateRules.find((rule) => String(rule.id) === purchaseRebateRuleId);
    const rebatePercent = Number(rebateRule?.rebate_percent || 0);
    const basicAmount = quantity * rate;
    const mandiTaxAmount = basicAmount * mandiTaxPercent / 100;
    const grossAmount = basicAmount + mandiTaxAmount + freightCharges + labourCharges + otherCharges;
    const rebateAmount = grossAmount * rebatePercent / 100;
    const netPayable = grossAmount - rebateAmount;
    return {
      basicAmount,
      mandiTaxPercent,
      mandiTaxAmount,
      freightCharges,
      labourCharges,
      otherCharges,
      grossAmount,
      rebatePercent,
      rebateAmount,
      netPayable,
      balanceAmount: Math.max(netPayable - paidAmount, 0),
      effectiveCostPerUnit: quantity > 0 ? netPayable / quantity : 0,
      paymentStatus: netPayable > 0 && paidAmount >= netPayable ? "Paid" : paidAmount > 0 ? "Partial" : "Pending",
    };
  }, [expectedPurchaseRate, purchaseBillStatus, purchaseFreightCharges, purchaseLabourCharges, purchaseOtherCharges, purchasePaidAmount, purchaseQuantity, purchaseRateInput, purchaseRebateRuleId, purchaseRules, purchaseType, selectedPurchaseProduct]);

  const purchaseCartSummary = useMemo(() => {
    const items = editingPurchaseId ? [{
      quantity: Number(purchaseQuantity || 0),
      purchase_rate: Number(purchaseRateInput || 0),
      expected_purchase_rate: Number(expectedPurchaseRate || 0),
      origin_type: selectedPurchaseProduct?.origin_type || "LOCAL",
    }] : purchaseCart;
    const itemCount = items.length;
    const receivedQuantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    if (purchaseBillStatus === "BILL_PENDING") {
      const provisionalCost = items.reduce(
        (sum, item) => sum + Number(item.quantity || 0) * Number(item.expected_purchase_rate || 0),
        0
      );
      return {
        itemCount,
        receivedQuantity,
        basicAmount: provisionalCost,
        mandiTaxPercent: 0,
        mandiTaxAmount: 0,
        freightCharges: 0,
        labourCharges: 0,
        otherCharges: 0,
        grossAmount: provisionalCost,
        rebatePercent: 0,
        rebateAmount: 0,
        netPayable: 0,
        balanceAmount: 0,
        effectiveCostPerUnit: receivedQuantity > 0 ? provisionalCost / receivedQuantity : 0,
        paymentStatus: "Bill Pending",
      };
    }
    const basicAmount = items.reduce(
      (sum, item) => sum + Number(item.quantity || 0) * Number(item.purchase_rate || 0),
      0
    );
    const mandiTaxAmount = items.reduce((sum, item) => {
      const origin = item.origin_type || "LOCAL";
      const rule = purchaseRules.mandiTaxRules.find((taxRule) => taxRule.origin_type === origin);
      return sum + Number(item.quantity || 0) * Number(item.purchase_rate || 0) * Number(rule?.tax_percent || 0) / 100;
    }, 0);
    const freightCharges = Number(purchaseFreightCharges || 0);
    const labourCharges = Number(purchaseLabourCharges || 0);
    const otherCharges = Number(purchaseOtherCharges || 0);
    const grossAmount = basicAmount + mandiTaxAmount + freightCharges + labourCharges + otherCharges;
    const rebateRule = purchaseRules.rebateRules.find((rule) => String(rule.id) === purchaseRebateRuleId);
    const rebatePercent = Number(rebateRule?.rebate_percent || 0);
    const rebateAmount = grossAmount * rebatePercent / 100;
    const netPayable = grossAmount - rebateAmount;
    const paidAmount = purchaseType === "CASH" ? Number(purchasePaidAmount || 0) : 0;
    return {
      itemCount,
      receivedQuantity,
      basicAmount,
      mandiTaxPercent: "Mixed",
      mandiTaxAmount,
      freightCharges,
      labourCharges,
      otherCharges,
      grossAmount,
      rebatePercent,
      rebateAmount,
      netPayable,
      balanceAmount: Math.max(netPayable - paidAmount, 0),
      effectiveCostPerUnit: receivedQuantity > 0 ? netPayable / receivedQuantity : 0,
      paymentStatus: netPayable > 0 && paidAmount >= netPayable ? "Paid" : paidAmount > 0 ? "Partial" : "Pending",
    };
  }, [editingPurchaseId, expectedPurchaseRate, purchaseBillStatus, purchaseCart, purchaseFreightCharges, purchaseLabourCharges, purchaseOtherCharges, purchasePaidAmount, purchaseQuantity, purchaseRateInput, purchaseRebateRuleId, purchaseRules, purchaseType, selectedPurchaseProduct]);

  const loadProducts = async () => {
    const response = await axios.get(`${API_URL}/products`);
    setProducts(response.data);
  };

  const loadPurchaseRules = async () => {
    const response = await axios.get(`${API_URL}/purchase-rules`);
    setPurchaseRules(response.data);
  };

  const loadPurchases = async () => {
    const response = await axios.get(`${API_URL}/purchases`);
    setPurchases(response.data);
  };

  const loadSettingsData = async (currentUser = user) => {
    const response = await axios.get(`${API_URL}/settings`, { params: { user_id: currentUser?.id } });
    const data = response.data;
    const nextSaleRateSettings = { ...defaultSaleRateSettings, ...(data.saleRateSettings || {}) };
    setSettingsData({
      businessSettings: { ...defaultBusinessSettings, ...(data.businessSettings || {}) },
      saleRateSettings: nextSaleRateSettings,
      posSettings: { ...defaultPosSettings, ...(data.posSettings || {}) },
      paymentSettings: { ...defaultPaymentSettings, ...(data.paymentSettings || {}) },
      discountRules: data.discountRules || [],
      roles: data.roles || [],
      users: data.users || [],
      updateCenter: data.updateCenter || {},
      syncSettings: data.syncSettings || {},
      backupSettings: data.backupSettings || {},
      canManageSettings: Boolean(data.canManageSettings),
    });
    setSettingsRules({
      mandiTaxRules: data.mandiTaxRules || [],
      rebateRules: data.rebateRules || [],
    });
    setDiscountRules((data.discountRules || []).filter((rule) => rule.active !== false));
    setSaleDesiredMargin(String(nextSaleRateSettings.desired_margin_percent || 25));
  };

  const loadDiscountRules = async () => {
    const response = await axios.get(`${API_URL}/settings/discount-rules`);
    setDiscountRules(response.data);
  };

  const loadSaleRates = async (desiredMargin = saleDesiredMargin) => {
    const [ratesResponse, historyResponse] = await Promise.all([
      axios.get(`${API_URL}/sale-rates`, { params: { user_id: user.id, desired_margin: desiredMargin } }),
      axios.get(`${API_URL}/sale-rate-history`, { params: { user_id: user.id } }),
    ]);
    setSaleRates(ratesResponse.data);
    setSaleRateHistory(historyResponse.data);
  };

  const loadSupplierData = async (search = "") => {
    const params = search ? { search } : {};
    const suppliersResponse = await axios.get(`${API_URL}/suppliers`, { params });
    setSuppliers(suppliersResponse.data);
  };

  const loadCustomerData = async (search = "") => {
    const params = search ? { search } : {};
    const customersResponse = await axios.get(`${API_URL}/customers`, { params });
    setCustomers(customersResponse.data);
  };

  const loadAccounts = async () => {
    const response = await axios.get(`${API_URL}/accounts`);
    setAccounts(response.data);
  };

  const loadAccountLedger = async (accountKey = "") => {
    const response = await axios.get(`${API_URL}/accounts/ledger`, {
      params: accountKey ? { account_key: accountKey } : {},
    });
    setAccountLedger(response.data);
  };

  const loadAccountOutstanding = async () => {
    const response = await axios.get(`${API_URL}/accounts/outstanding`);
    setAccountOutstanding(response.data);
  };

  const loadAccountPayments = async (accountKey = "") => {
    const response = await axios.get(`${API_URL}/accounts/payments`, {
      params: accountKey ? { account_key: accountKey } : {},
    });
    setAccountPayments(response.data);
  };

  const loadReports = async (params = {}) => {
    const response = await axios.get(`${API_URL}/reports/summary`, { params });
    setReportsData(response.data);
  };

  const loadExpenses = async () => {
    const response = await axios.get(`${API_URL}/expenses`);
    setExpenses(response.data);
  };

  const loadSalesHistory = async () => {
    const response = await axios.get(`${API_URL}/sales`);
    setSalesHistory(response.data);
  };

  const loadSaleReturns = async () => {
    const response = await axios.get(`${API_URL}/sale-returns`);
    setSaleReturns(response.data);
  };

  const loadWasteEntries = async () => {
    const response = await axios.get(`${API_URL}/waste-entries`);
    setWasteEntries(response.data);
  };

  const getDashboardParams = (range = dashboardRange, customRange = dashboardCustomRange) => {
    if (range === "custom") {
      return customRange.date_from && customRange.date_to
        ? { date_from: customRange.date_from, date_to: customRange.date_to }
        : { days: 7 };
    }
    return { days: range };
  };

  const loadDashboardAnalytics = async (range = dashboardRange, customRange = dashboardCustomRange) => {
    const response = await axios.get(`${API_URL}/dashboard-analytics`, {
      params: getDashboardParams(range, customRange),
    });
    setDashboardAnalytics(response.data);
    if (response.data.summary) setSupplierDashboard(response.data.summary);
  };

  const loadDashboardData = async () => {
    const [inventoryResponse, salesResponse, supplierMetricsResponse, analyticsResponse] = await Promise.all([
      axios.get(`${API_URL}/inventory`),
      axios.get(`${API_URL}/sales`),
      axios.get(`${API_URL}/dashboard-metrics`),
      axios.get(`${API_URL}/dashboard-analytics`, { params: getDashboardParams() }),
    ]);
    setInventory(inventoryResponse.data);
    setSalesHistory(salesResponse.data);
    setSupplierDashboard(supplierMetricsResponse.data);
    setDashboardAnalytics(analyticsResponse.data);
  };

  const changeDashboardRange = async (range) => {
    try {
      setDashboardRange(range);
      if (range !== "custom") await loadDashboardAnalytics(range, dashboardCustomRange);
    } catch (error) {
      alert(getErrorMessage(error, "Dashboard analytics failed"));
    }
  };

  const applyDashboardCustomRange = async () => {
    try {
      setDashboardRange("custom");
      await loadDashboardAnalytics("custom", dashboardCustomRange);
    } catch (error) {
      alert(getErrorMessage(error, "Dashboard analytics failed"));
    }
  };

  const login = async () => {
    try {
      const response = await axios.post(`${API_URL}/login`, { username, password });
      setUser(response.data);
      await Promise.all([loadProducts(), loadDashboardData(), loadPurchaseRules(), loadPurchases(), loadSupplierData(), loadCustomerData(), loadAccounts(), loadAccountOutstanding(), loadAccountPayments(), loadSaleReturns(), loadWasteEntries(), loadSettingsData(response.data)]);
    } catch (error) {
      alert(getErrorMessage(error, "Login Failed"));
    }
  };

  const addProduct = async () => {
    try {
      const wasEditing = Boolean(editingProductId);
      const normalizedName = productName.trim().toLowerCase();
      const duplicateProduct = products.find((product) =>
        product.product_name?.trim().toLowerCase() === normalizedName &&
        Number(product.id) !== Number(editingProductId || 0)
      );
      if (duplicateProduct) {
        alert("This product already exists.");
        return;
      }
      const payload = {
        product_name: productName,
        selling_rate: sellingRate,
        unit,
        barcode: productBarcode,
        origin_type: productOriginType,
        category: productCategory,
        minimum_stock: productMinimumStock,
        active: productActive,
        created_by: user.id,
        updated_by: user.id,
      };
      if (editingProductId) {
        await axios.put(`${API_URL}/products/${editingProductId}`, payload);
      } else {
        await axios.post(`${API_URL}/products`, payload);
      }
      setProductName("");
      setSellingRate("");
      setUnit("");
      setProductBarcode("");
      setProductOriginType("LOCAL");
      setProductCategory("Fruit");
      setProductMinimumStock("");
      setProductActive(true);
      setEditingProductId(null);
      await loadProducts();
      alert(wasEditing ? "Product Updated" : "Product Added");
    } catch (error) {
      alert(getErrorMessage(error, "Error Adding Product"));
    }
  };

  const resetPurchaseForm = () => {
    setPurchaseSupplierId("");
    setPurchaseProductId("");
    setPurchaseQuantity("");
    setPurchaseRateInput("");
    setPurchaseFreightCharges("");
    setPurchaseLabourCharges("");
    setPurchaseOtherCharges("");
    setPurchasePaidAmount("");
    setPurchaseBillStatus("BILL_COMPLETED");
    setPurchaseDate(toDateKey(new Date()));
    setTemporarySaleRate("");
    setExpectedPurchaseRate("");
    setPurchaseBillNumber("");
    setPurchaseBillDate("");
    setPurchaseType("CREDIT");
    setPurchasePaymentMode("CASH");
    setPurchasePaymentReference("");
    setPurchaseRebateRuleId("");
    setPurchasePaymentDate("");
    setPurchaseRemarks("");
    setPurchaseItemRemarks("");
    setPurchaseCart([]);
    setEditingPurchaseItemIndex(null);
    setEditingPurchaseId(null);
  };

  const resetPurchaseItemFields = () => {
    setPurchaseProductId("");
    setPurchaseQuantity("");
    setPurchaseRateInput("");
    setTemporarySaleRate("");
    setExpectedPurchaseRate("");
    setPurchaseItemRemarks("");
    setEditingPurchaseItemIndex(null);
  };

  const addPurchaseCartItem = () => {
    if (editingPurchaseId) return;
    const product = selectedPurchaseProduct;
    const quantity = Number(purchaseQuantity || 0);
    const purchaseRate = Number(purchaseRateInput || 0);
    const temporaryRate = Number(temporarySaleRate || 0);
    const expectedRate = Number(expectedPurchaseRate || 0);
    if (!purchaseSupplierId) {
      alert("Select supplier before adding purchase items.");
      return;
    }
    if (!product || quantity <= 0) {
      alert("Select product and enter quantity.");
      return;
    }
    if (purchaseBillStatus === "BILL_PENDING" && temporaryRate <= 0) {
      alert("Pending bill stock requires a temporary sale rate.");
      return;
    }
    if (purchaseBillStatus === "BILL_COMPLETED" && purchaseRate <= 0) {
      alert("Completed bill items require a purchase rate.");
      return;
    }
    const item = {
      product_id: product.id,
      product_name: product.product_name,
      unit: product.unit,
      origin_type: product.origin_type || "LOCAL",
      quantity,
      purchase_rate: purchaseBillStatus === "BILL_PENDING" ? expectedRate : purchaseRate,
      temporary_sale_rate: temporaryRate,
      expected_purchase_rate: expectedRate,
      remarks: purchaseItemRemarks,
    };
    setPurchaseCart((currentCart) => {
      const nextCart = [...currentCart];
      if (editingPurchaseItemIndex !== null) {
        nextCart[editingPurchaseItemIndex] = item;
      } else {
        const existingIndex = nextCart.findIndex((cartItem) => Number(cartItem.product_id) === Number(item.product_id));
        if (existingIndex >= 0) {
          nextCart[existingIndex] = {
            ...nextCart[existingIndex],
            ...item,
            quantity: Number(nextCart[existingIndex].quantity || 0) + quantity,
          };
        } else {
          nextCart.push(item);
        }
      }
      return nextCart;
    });
    resetPurchaseItemFields();
  };

  const editPurchaseCartItem = (index) => {
    const item = purchaseCart[index];
    if (!item) return;
    setEditingPurchaseItemIndex(index);
    setPurchaseProductId(String(item.product_id));
    setPurchaseQuantity(String(item.quantity || ""));
    setPurchaseRateInput(String(item.purchase_rate || ""));
    setTemporarySaleRate(String(item.temporary_sale_rate || ""));
    setExpectedPurchaseRate(String(item.expected_purchase_rate || ""));
    setPurchaseItemRemarks(item.remarks || "");
  };

  const removePurchaseCartItem = (index) => {
    setPurchaseCart((currentCart) => currentCart.filter((_, itemIndex) => itemIndex !== index));
    if (editingPurchaseItemIndex === index) resetPurchaseItemFields();
  };

  const savePurchase = async () => {
    try {
      const wasEditing = Boolean(editingPurchaseId);
      const reason = editingPurchaseId ? window.prompt("Enter purchase edit reason") : "";
      if (editingPurchaseId && !reason?.trim()) return;
      const payload = {
        supplier_id: purchaseSupplierId,
        product_id: purchaseProductId,
        quantity: purchaseQuantity,
        purchase_rate: purchaseRateInput,
        purchase_bill_status: purchaseBillStatus,
        purchase_date: purchaseDate,
        temporary_sale_rate: temporarySaleRate,
        expected_purchase_rate: expectedPurchaseRate,
        freight_charges: purchaseFreightCharges,
        labour_charges: purchaseLabourCharges,
        other_charges: purchaseOtherCharges,
        paid_amount: purchaseType === "CASH" ? purchasePaidAmount : 0,
        rebate_rule_id: purchaseRebateRuleId,
        payment_date: purchasePaymentDate || null,
        purchase_type: purchaseType,
        payment_mode: purchaseType === "CASH" ? purchasePaymentMode : null,
        payment_reference_number: purchaseType === "CASH" ? purchasePaymentReference : null,
        bill_number: purchaseBillNumber,
        bill_date: purchaseBillDate || null,
        branch_id: user.branch_id,
        created_by: user.id,
        edited_by: user.id,
        reason,
        remarks: purchaseRemarks,
      };
      if (editingPurchaseId && purchaseBillStatus === "BILL_COMPLETED" && purchases.find((purchase) => Number(purchase.id) === Number(editingPurchaseId))?.purchase_bill_status === "BILL_PENDING") {
        await axios.post(`${API_URL}/purchase/${editingPurchaseId}/complete-bill`, payload);
      } else if (editingPurchaseId) {
        await axios.put(`${API_URL}/purchase/${editingPurchaseId}`, payload);
      } else {
        if (purchaseCart.length === 0) {
          alert("Add at least one purchase item before saving.");
          return;
        }
        await axios.post(`${API_URL}/purchase-bill`, { ...payload, items: purchaseCart });
      }
      resetPurchaseForm();
      await Promise.all([loadDashboardData(), loadPurchases(), loadSupplierData(), loadAccounts(), loadAccountOutstanding()]);
      alert(purchaseBillStatus === "BILL_PENDING" ? "Stock Arrival Saved - Bill Pending" : wasEditing ? "Purchase Updated" : "Purchase Saved");
    } catch (error) {
      alert(getErrorMessage(error, "Purchase Error"));
    }
  };

  const loadInvoice = async (saleId) => {
    try {
      const response = await axios.get(`${API_URL}/sales/${saleId}`);
      setSelectedInvoice(response.data);
    } catch (error) {
      alert(getErrorMessage(error, "Error Loading Invoice"));
    }
  };

  const loadSaleForEdit = async (saleId) => {
    try {
      const response = await axios.get(`${API_URL}/sales/${saleId}`);
      setEditingSale(response.data);
    } catch (error) {
      alert(getErrorMessage(error, "Error Loading Invoice"));
    }
  };

  const loadChangeHistory = async (saleId) => {
    try {
      const response = await axios.get(`${API_URL}/sales/${saleId}/audit`);
      setChangeHistory({ saleId, rows: response.data });
    } catch (error) {
      alert(getErrorMessage(error, "Error Loading Change History"));
    }
  };

  const cancelSale = async (sale) => {
    const reason = window.prompt(`Enter cancellation reason for ${sale.invoice_no || `#${sale.id}`}`);
    if (!reason?.trim()) return;
    try {
      await axios.post(`${API_URL}/sales/${sale.id}/cancel`, { reason, cancelled_by: user.id });
      await Promise.all([loadSalesHistory(), loadDashboardData()]);
      alert("Invoice cancelled");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to cancel invoice"));
    }
  };

  const selectPurchaseProduct = (event) => {
    const productId = event.target.value;
    setPurchaseProductId(productId);
    if (!productId) setPurchaseRateInput("");
  };

  const editProduct = (product) => {
    setProductName(product.product_name);
    setSellingRate(product.selling_rate);
    setUnit(product.unit);
    setProductBarcode(product.barcode || "");
    setProductOriginType(product.origin_type || "LOCAL");
    setProductCategory(product.category || "Fruit");
    setProductMinimumStock(product.minimum_stock || "");
    setProductActive(product.active !== false);
    setEditingProductId(product.id);
  };

  const cancelProductEdit = () => {
    setProductName("");
    setSellingRate("");
    setUnit("");
    setProductBarcode("");
    setProductOriginType("LOCAL");
    setProductCategory("Fruit");
    setProductMinimumStock("");
    setProductActive(true);
    setEditingProductId(null);
  };

  const deactivateProduct = async (product) => {
    const reason = window.prompt(`Enter reason to deactivate/cancel ${product.product_name}`);
    if (!reason?.trim()) return;
    try {
      await axios.post(`${API_URL}/products/${product.id}/cancel`, { reason, cancelled_by: user.id });
      await Promise.all([loadProducts(), loadDashboardData()]);
      alert("Product marked inactive");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update product status"));
    }
  };

  const editPurchase = (purchase) => {
    setEditingPurchaseId(purchase.id);
    setPurchaseBillStatus(purchase.purchase_bill_status || "BILL_COMPLETED");
    setPurchaseDate(toDateKey(purchase.purchase_date || new Date()));
    setPurchaseSupplierId(String(purchase.supplier_id || ""));
    setPurchaseProductId(String(purchase.product_id || ""));
    setPurchaseQuantity(String(purchase.quantity || ""));
    setPurchaseRateInput(String(purchase.purchase_rate || ""));
    setTemporarySaleRate(String(purchase.temporary_sale_rate || ""));
    setExpectedPurchaseRate(String(purchase.expected_purchase_rate || purchase.purchase_rate || ""));
    setPurchaseFreightCharges(String(purchase.freight_charges || 0));
    setPurchaseLabourCharges(String(purchase.labour_charges || 0));
    setPurchaseOtherCharges(String(purchase.other_charges || 0));
    setPurchasePaidAmount(String(purchase.paid_amount || ""));
    setPurchaseType(purchase.purchase_type || "CREDIT");
    setPurchasePaymentMode(purchase.payment_mode || "CASH");
    setPurchasePaymentReference(purchase.payment_reference_number || "");
    setPurchaseRebateRuleId(String(purchase.rebate_rule_id || ""));
    setPurchasePaymentDate(purchase.payment_date ? toDateKey(purchase.payment_date) : "");
    setPurchaseBillNumber(purchase.bill_number || "");
    setPurchaseBillDate(purchase.bill_date ? toDateKey(purchase.bill_date) : "");
    setPurchaseRemarks(purchase.remarks || "");
    setPurchaseItemRemarks(purchase.item_remarks || "");
    setPurchaseCart([]);
    setEditingPurchaseItemIndex(null);
    setActiveView("purchase");
  };

  const completePendingPurchase = (purchase) => {
    editPurchase({
      ...purchase,
      purchase_bill_status: "BILL_COMPLETED",
      purchase_rate: purchase.expected_purchase_rate || purchase.purchase_rate || "",
    });
    setPurchaseBillStatus("BILL_COMPLETED");
    setPurchaseType("CREDIT");
    setPurchasePaidAmount("");
    setPurchasePaymentMode("CASH");
    setPurchasePaymentReference("");
    setPurchaseBillDate(toDateKey(new Date()));
  };

  const cancelPurchase = async (purchase) => {
    const reason = window.prompt(`Enter cancellation reason for Purchase #${purchase.id}`);
    if (!reason?.trim()) return;
    try {
      await axios.post(`${API_URL}/purchase/${purchase.id}/cancel`, { reason, cancelled_by: user.id });
      await Promise.all([loadPurchases(), loadDashboardData(), loadSupplierData(), loadAccounts(), loadAccountOutstanding()]);
      alert("Purchase cancelled");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to cancel purchase"));
    }
  };

  const openSupplierLedgerFromReport = async (purchase) => {
    const supplierId = Number(purchase.supplier_id || 0);
    if (!supplierId) {
      alert("Supplier account is not linked to this purchase.");
      return;
    }
    const accountKey = `SUPPLIER-${supplierId}`;
    setAccountLedgerFocusKey(accountKey);
    setActiveView("accounts");
    await loadAccountLedger(accountKey);
  };

  const navigate = async (view) => {
    if (!hasModuleAccess(view)) {
      alert("Your role does not have access to this module.");
      return;
    }
    setSidebarOpen(false);
    setActiveView(view);
    try {
      if (view === "inventory") {
        const response = await axios.get(`${API_URL}/inventory`);
        setInventory(response.data);
      }
      if (view === "sales-history") {
        await loadSalesHistory();
      }
      if (view === "sales") await loadDiscountRules();
      if (["purchase", "accounts"].includes(view)) {
        await loadSupplierData();
      }
      if (view === "purchase") await loadPurchases();
      if (view === "accounts") {
        await Promise.all([loadAccounts(), loadCustomerData(), loadSupplierData(), loadAccountOutstanding()]);
      }
      if (view === "reports") await loadReports();
      if (view === "expenses") await loadExpenses();
      if (view === "returns") await loadSaleReturns();
      if (view === "waste") await loadWasteEntries();
      if (view === "dashboard") await loadDashboardData();
      if (view === "settings") await loadSettingsData();
      if (view === "sale-rates") await loadSaleRates();
    } catch (error) {
      alert(getErrorMessage(error, "Error Loading Data"));
    }
  };

  if (!user) {
    return (
      <main className="login-page">
        <section className="login-panel">
          <div className="login-brand">
            <BrandLogo />
          </div>
          <div className="login-copy">
            <span className="eyebrow">Business Management</span>
            <h1>Welcome back</h1>
            <p>Sign in to manage your retail operations.</p>
          </div>
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && login()}
            />
          </label>
          <button className="primary-button login-button" onClick={login}>Sign In</button>
        </section>
      </main>
    );
  }

  const activeLabel = navigationItems.find(([view]) => view === activeView)?.[1];
  const canManageRates = ["Owner", "Admin"].includes(user.role);
  const canEditSales = ["Owner", "Admin"].includes(user.role);

  return (
    <main className="erp-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <BrandLogo />
        </div>
        <span className="sidebar-section">Main Menu</span>
        <nav className="sidebar-nav">
          {navigationItems.filter(([view]) => hasModuleAccess(view) && (canManageRates || view !== "sale-rates")).map(([view, label]) => (
            <button
              className={activeView === view ? "nav-item nav-item-active" : "nav-item"}
              key={view}
              onClick={() => navigate(view)}
            >
              <Icon name={icons[view]} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-profile" onClick={() => setProfileOpen(true)} role="button" tabIndex={0} onKeyDown={(event) => event.key === "Enter" && setProfileOpen(true)}>
          <div className="user-avatar">{user.full_name.charAt(0)}</div>
          <div>
            <strong>{user.full_name}</strong>
            <small>{user.role}</small>
          </div>
          <button aria-label="Log out" className="logout-button" onClick={(event) => { event.stopPropagation(); setUser(null); }}>
            <Icon name="logout" size={17} />
          </button>
        </div>
      </aside>

      <button
        aria-label="Close sidebar"
        className={`sidebar-overlay ${sidebarOpen ? "sidebar-overlay-visible" : ""}`}
        onClick={() => setSidebarOpen(false)}
      />

      <section className="content-shell">
        <header className="topbar">
          <div className="topbar-heading">
            <button
              aria-label="Open sidebar"
              className="mobile-menu"
              onClick={() => setSidebarOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <BrandLogo compact />
            <div>
              <span className="eyebrow">Retail Operations Workspace</span>
              <h1>{activeLabel}</h1>
            </div>
          </div>
          <div className="branch-pill">
            <span className="status-dot" />
            {user.branch}
          </div>
        </header>

        <div className="content-area">
          {activeView === "dashboard" && (
            <>
              <section className="welcome-banner">
                <div>
                  <BrandLogo />
                  <span className="eyebrow">Retail Intelligence</span>
                  <h2>Good to see you, {user.full_name.split(" ")[0]}.</h2>
                  <p>Monitor today's performance and keep your inventory moving.</p>
                </div>
                <button className="primary-button" onClick={() => navigate("sales")}>
                  <Icon name="receipt" /> New POS Bill
                </button>
              </section>
              <section className="kpi-grid">
                {kpis.map(([label, value, icon]) => (
                  <article className="kpi-card" key={label}>
                    <div className="kpi-icon"><Icon name={icon} size={20} /></div>
                    <div>
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </div>
                  </article>
                ))}
              </section>
              <DashboardAnalytics
                analytics={dashboardAnalytics}
                customRange={dashboardCustomRange}
                onApplyCustomRange={applyDashboardCustomRange}
                onCustomRangeChange={setDashboardCustomRange}
                onNavigate={navigate}
                onRangeChange={changeDashboardRange}
                range={dashboardRange}
              />
              <section className="content-card">
                <div className="card-heading">
                  <div>
                    <span className="eyebrow">Quick Access</span>
                    <h2>Daily Operations</h2>
                  </div>
                </div>
                <div className="quick-grid">
                  {[["sales", "POS Billing"], ["purchase", "New Purchase"], ["accounts", "Accounts"], ["inventory", "View Inventory"]].map(([view, label]) => (
                    <button className="quick-action" key={view} onClick={() => navigate(view)}>
                      <Icon name={icons[view]} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}

          {activeView === "products" && (
            <ModuleCard eyebrow="Catalog" title="Product Management" subtitle="Add retail products and maintain pricing details.">
              <div className="form-grid">
                <Field label="Product Name"><input value={productName} onChange={(event) => setProductName(event.target.value)} /></Field>
                <Field label="Selling Rate"><input type="number" min="0" step="0.01" value={sellingRate} onChange={(event) => setSellingRate(event.target.value)} /></Field>
                <Field label="Unit"><input value={unit} onChange={(event) => setUnit(event.target.value)} /></Field>
                <Field label="Barcode (Optional)"><input value={productBarcode} onChange={(event) => setProductBarcode(event.target.value)} /></Field>
                <Field label="Category"><input value={productCategory} onChange={(event) => setProductCategory(event.target.value)} /></Field>
                <Field label="Minimum Stock"><input type="number" min="0" step="0.001" value={productMinimumStock} onChange={(event) => setProductMinimumStock(event.target.value)} /></Field>
                <Field label="Origin Type">
                  <select value={productOriginType} onChange={(event) => setProductOriginType(event.target.value)}>
                    <option value="LOCAL">Local</option>
                    <option value="IMPORTED">Imported</option>
                  </select>
                </Field>
                <label className="check-field"><input type="checkbox" checked={productActive} onChange={(event) => setProductActive(event.target.checked)} /><span>Active Product</span></label>
              </div>
              <div className="button-row">
                <button className="primary-button" onClick={addProduct}>{editingProductId ? "Update Product" : "Add Product"}</button>
                {editingProductId && <button className="secondary-button" onClick={cancelProductEdit}>Cancel Edit</button>}
              </div>
              <DataTable headers={["Product", "Category", "Barcode", "Origin", "Selling Rate", "Minimum Stock", "Unit", "Status", ""]}>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td className="primary-cell">{product.product_name}</td>
                    <td>{product.category || "Fruit"}</td>
                    <td>{product.barcode || "-"}</td>
                    <td><span className="tag">{product.origin_type || "LOCAL"}</span></td>
                    <td>{currency.format(Number(product.selling_rate))}</td>
                    <td>{product.minimum_stock || 0}</td>
                    <td><span className="tag">{product.unit}</span></td>
                    <td><span className={product.active !== false ? "stock-ok" : "stock-low"}>{product.active !== false ? "Active" : "Inactive"}</span></td>
                    <td>
                      <div className="button-row table-actions-row">
                        <button className="table-action" onClick={() => editProduct(product)}>Edit</button>
                        <button className="remove-button" disabled={product.active === false} onClick={() => deactivateProduct(product)}>Deactivate</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </DataTable>
            </ModuleCard>
          )}

          {activeView === "purchase" && (
            <section className="settings-layout">
              <ModuleCard eyebrow="Procurement" title={editingPurchaseId ? `Add / Edit Purchase #${editingPurchaseId}` : "Purchase Entry"} subtitle={editingPurchaseId ? "Amend one historical purchase item with inventory protection." : "Select supplier once, add multiple fruit items, then save one purchase workflow."}>
                <div className="form-grid supplier-form-grid">
                  <Field label="Entry Type">
                    <select value={purchaseBillStatus} onChange={(event) => setPurchaseBillStatus(event.target.value)} disabled={Boolean(editingPurchaseId && purchases.find((purchase) => Number(purchase.id) === Number(editingPurchaseId))?.purchase_bill_status !== "BILL_PENDING")}>
                      <option value="BILL_COMPLETED">Completed Bill</option>
                      <option value="BILL_PENDING">Stock Arrival / Pending Bill</option>
                    </select>
                  </Field>
                  <Field label="Supplier Account">
                    <select value={purchaseSupplierId} onChange={(event) => setPurchaseSupplierId(event.target.value)}>
                      <option value="">Select saved supplier</option>
                      {activeSuppliers.map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.supplier_name}{supplier.firm_name ? ` - ${supplier.firm_name}` : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={purchaseBillStatus === "BILL_PENDING" ? "Arrival Date" : "Purchase Date"}><input type="date" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} /></Field>
                  {purchaseBillStatus === "BILL_COMPLETED" && (
                    <>
                      <Field label="Bill Number"><input value={purchaseBillNumber} onChange={(event) => setPurchaseBillNumber(event.target.value)} /></Field>
                      <Field label="Bill Date"><input type="date" value={purchaseBillDate} onChange={(event) => setPurchaseBillDate(event.target.value)} /></Field>
                    </>
                  )}
                </div>
              </ModuleCard>

              <ModuleCard eyebrow={editingPurchaseId ? "Purchase Item Amendment" : "Purchase Cart"} title={editingPurchaseId ? "Edit Purchase Item" : "Add Fruit Items"} subtitle={editingPurchaseId ? "Quantity reductions are blocked if stock from this batch has already been sold." : "Add all products from this supplier before saving the bill."}>
                <div className="form-grid supplier-form-grid">
                  <Field label="Product">
                    <select value={purchaseProductId} onChange={selectPurchaseProduct}>
                      <option value="">Select product</option>
                      {products.filter((product) => product.active !== false).map((product) => <option key={product.id} value={product.id}>{product.product_name} ({product.unit})</option>)}
                    </select>
                  </Field>
                  <Field label="Quantity"><input type="number" min="0" step="0.001" value={purchaseQuantity} onChange={(event) => setPurchaseQuantity(event.target.value)} /></Field>
                  {purchaseBillStatus === "BILL_PENDING" ? (
                    <>
                      <Field label="Temporary Sale Rate"><input type="number" min="0" step="0.01" value={temporarySaleRate} onChange={(event) => setTemporarySaleRate(event.target.value)} /></Field>
                      <Field label="Expected Purchase Rate"><input type="number" min="0" step="0.01" value={expectedPurchaseRate} onChange={(event) => setExpectedPurchaseRate(event.target.value)} /></Field>
                    </>
                  ) : (
                    <Field label="Purchase Rate"><input type="number" min="0" step="0.01" value={purchaseRateInput} onChange={(event) => setPurchaseRateInput(event.target.value)} /></Field>
                  )}
                  <Field label="Origin Type"><input value={selectedPurchaseProduct?.origin_type || "Select product"} readOnly /></Field>
                  <Field label="Item Remarks"><input value={purchaseItemRemarks} onChange={(event) => setPurchaseItemRemarks(event.target.value)} /></Field>
                </div>
                {!editingPurchaseId && (
                  <div className="button-row">
                    <button className="secondary-button" onClick={addPurchaseCartItem}>{editingPurchaseItemIndex !== null ? "Update Item" : "Add Item"}</button>
                    {editingPurchaseItemIndex !== null && <button className="secondary-button" onClick={resetPurchaseItemFields}>Cancel Item Edit</button>}
                  </div>
                )}
                {!editingPurchaseId && (
                  <DataTable headers={["Product", "Qty", "Unit", "Origin", "Purchase / Expected Rate", "Temp Sale Rate", "Remarks", "Actions"]}>
                    {purchaseCart.map((item, index) => (
                      <tr key={`${item.product_id}-${index}`}>
                        <td className="primary-cell">{item.product_name}</td>
                        <td>{item.quantity}</td>
                        <td>{item.unit}</td>
                        <td><span className="origin-rate">{item.origin_type}</span></td>
                        <td>{currency.format(Number(item.purchase_rate || item.expected_purchase_rate || 0))}</td>
                        <td>{item.temporary_sale_rate ? currency.format(Number(item.temporary_sale_rate)) : "-"}</td>
                        <td>{item.remarks || "-"}</td>
                        <td>
                          <div className="button-row table-actions-row">
                            <button className="table-action" onClick={() => editPurchaseCartItem(index)}>Edit</button>
                            <button className="remove-button" onClick={() => removePurchaseCartItem(index)}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                )}
                {!editingPurchaseId && purchaseCart.length === 0 && <div className="cart-empty">No purchase items added yet.</div>}
              </ModuleCard>

              <ModuleCard eyebrow="Bill Details" title="Charges, Rebate and Payment" subtitle="These values are allocated across items by value when the bill is saved.">
                {purchaseBillStatus === "BILL_COMPLETED" && (
                  <div className="form-grid supplier-form-grid">
                    <Field label="Freight Charges"><input type="number" min="0" step="0.01" value={purchaseFreightCharges} onChange={(event) => setPurchaseFreightCharges(event.target.value)} /></Field>
                    <Field label="Labour Charges"><input type="number" min="0" step="0.01" value={purchaseLabourCharges} onChange={(event) => setPurchaseLabourCharges(event.target.value)} /></Field>
                    <Field label="Other Charges"><input type="number" min="0" step="0.01" value={purchaseOtherCharges} onChange={(event) => setPurchaseOtherCharges(event.target.value)} /></Field>
                    <Field label="Payment Timing / Rebate Rule">
                      <select value={purchaseRebateRuleId} onChange={(event) => setPurchaseRebateRuleId(event.target.value)}>
                        <option value="">Select rebate rule</option>
                        {purchaseRules.rebateRules.map((rule) => <option key={rule.id} value={rule.id}>{rule.rule_name} - {rule.pay_within_days} days - {rule.rebate_percent}%</option>)}
                      </select>
                    </Field>
                    <Field label="Payment Type">
                      <select value={purchaseType} onChange={(event) => setPurchaseType(event.target.value)}>
                        <option value="CREDIT">Credit Purchase</option>
                        <option value="CASH">Cash Purchase</option>
                      </select>
                    </Field>
                    {purchaseType === "CASH" && (
                      <>
                        <Field label="Payment Mode">
                          <select value={purchasePaymentMode} onChange={(event) => setPurchasePaymentMode(event.target.value)}>
                            {supplierPaymentModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                          </select>
                        </Field>
                        <Field label="Paid Amount"><input type="number" min="0" step="0.01" value={purchasePaidAmount} onChange={(event) => setPurchasePaidAmount(event.target.value)} /></Field>
                        <Field label="Payment Reference"><input value={purchasePaymentReference} onChange={(event) => setPurchasePaymentReference(event.target.value)} /></Field>
                        <Field label="Payment Date"><input type="date" value={purchasePaymentDate} onChange={(event) => setPurchasePaymentDate(event.target.value)} /></Field>
                      </>
                    )}
                  </div>
                )}
                <Field label="Bill Remarks"><textarea value={purchaseRemarks} onChange={(event) => setPurchaseRemarks(event.target.value)} /></Field>
                {activeSuppliers.length === 0 && <p className="form-note">No active supplier accounts found. Add New Supplier before saving a purchase.</p>}
                {purchaseBillStatus === "BILL_PENDING" && <p className="form-note">Purchase bill pending. Inventory will increase immediately and profit from this stock will be provisional until the bill is completed.</p>}
                <PurchaseSummary summary={editingPurchaseId ? purchaseSummary : purchaseCartSummary} />
                <div className="button-row">
                  <button className="primary-button" onClick={savePurchase}>{purchaseBillStatus === "BILL_PENDING" ? editingPurchaseId ? "Update Arrival Entry" : "Save Stock Arrival" : editingPurchaseId ? "Complete / Update Purchase" : "Save Purchase"}</button>
                  {editingPurchaseId && <button className="secondary-button" onClick={resetPurchaseForm}>Cancel Amendment</button>}
                  <button className="secondary-button" onClick={() => navigate("accounts")}>Add New Supplier</button>
                </div>
              </ModuleCard>
            </section>
          )}

          {activeView === "accounts" && (
            <AccountsModule
              accounts={accounts}
              accountLedger={accountLedger}
              accountPayments={accountPayments}
              accountOutstanding={accountOutstanding}
              ledgerFocusKey={accountLedgerFocusKey}
              onLedgerLoad={loadAccountLedger}
              onPaymentsLoad={loadAccountPayments}
              onReload={async () => {
                await Promise.all([
                  loadAccounts(),
                  loadSupplierData(),
                  loadCustomerData(),
                  loadAccountOutstanding(),
                  loadAccountPayments(),
                  loadDashboardData(),
                ]);
              }}
              user={user}
            />
          )}

          {activeView === "inventory" && (
            <ModuleCard eyebrow="Stock Control" title="Inventory Batches" subtitle="Review current quantities and batch-level purchase details.">
              <DataTable headers={["Batch", "Product", "Purchased", "Remaining", "Purchase Rate", "Landed Cost", "Mandi Tax", "Freight", "Labour", "Other", "Rebate", "Net Payable", "Balance", "Supplier", "Date"]}>
                {inventory.map((item) => (
                  <tr key={item.id}>
                    <td><span className="batch-id">{item.batch_no}</span></td>
                    <td className="primary-cell">{item.product_name}</td>
                    <td>{item.purchase_qty}</td>
                    <td><span className={Number(item.remaining_qty) <= 5 ? "stock-low" : "stock-ok"}>{item.remaining_qty}</span></td>
                    <td>{currency.format(Number(item.purchase_rate))}</td>
                    <td>{currency.format(Number(item.effective_cost_per_unit || item.purchase_rate))}</td>
                    <td>{currency.format(Number(item.mandi_tax_amount || 0))}</td>
                    <td>{currency.format(Number(item.freight_charges || 0))}</td>
                    <td>{currency.format(Number(item.labour_charges || 0))}</td>
                    <td>{currency.format(Number(item.other_charges || 0))}</td>
                    <td>{currency.format(Number(item.rebate_amount || 0))}</td>
                    <td>{currency.format(Number(item.net_payable || 0))}</td>
                    <td>{currency.format(Number(item.balance_amount || 0))}</td>
                    <td>{item.supplier_name}</td>
                    <td>{item.purchase_date}</td>
                  </tr>
                ))}
              </DataTable>
            </ModuleCard>
          )}

          {activeView === "returns" && (
            <SaleReturnModule
              onReload={async () => {
                await Promise.all([loadSaleReturns(), loadDashboardData(), loadSalesHistory()]);
              }}
              returns={saleReturns}
              salesHistory={salesHistory}
              user={user}
            />
          )}

          {activeView === "waste" && (
            <WasteManagementModule
              entries={wasteEntries}
              inventory={inventory}
              onReload={async () => {
                await Promise.all([loadWasteEntries(), loadDashboardData()]);
              }}
              products={products}
              user={user}
            />
          )}

          {activeView === "sales" && (
            <PosBilling
              customers={customers.filter((customer) => customer.active !== false)}
              discountRules={discountRules}
              inventory={inventory}
              onInvoice={setSelectedInvoice}
              onSaved={loadDashboardData}
              paymentSettings={settingsData.paymentSettings}
              posSettings={settingsData.posSettings}
              printSettings={settingsData.businessSettings}
              products={products.filter((product) => product.active !== false)}
              user={user}
            />
          )}

          {activeView === "sales-history" && (
            <ModuleCard eyebrow="Revenue" title="Sales History" subtitle="Review completed sales, costs, and realized profit.">
              <DataTable headers={["Invoice", "Date", "Status", "Customer", "Items", "Payment", "Gross", "Discount", "Net Amount", "Cost", "Profit", "Actions"]}>
                {salesHistory.map((sale) => (
                  <tr key={sale.id}>
                    <td><span className="batch-id">{sale.invoice_no || `#${sale.id}`}</span></td>
                    <td>{sale.sale_date}</td>
                    <td><span className={sale.sale_status === "CANCELLED" ? "stock-low" : sale.sale_status === "EDITED" ? "origin-rate" : "stock-ok"}>{sale.sale_status || "COMPLETED"}</span></td>
                    <td>{sale.customer_name || "Walk-in Customer"}</td>
                    <td className="primary-cell">{sale.item_summary}</td>
                    <td><span className="tag">{sale.payment_mode}</span></td>
                    <td>{currency.format(Number(sale.gross_amount || sale.amount))}</td>
                    <td>{currency.format(Number(sale.item_discount_amount || 0) + Number(sale.invoice_discount_amount || 0))}</td>
                    <td>{currency.format(Number(sale.amount))}</td>
                    <td>{currency.format(Number(sale.cost_amount))}</td>
                    <td className="profit-cell">{currency.format(Number(sale.profit))}</td>
                    <td>
                      <div className="button-row table-actions-row">
                        <button className="table-action" onClick={() => loadInvoice(sale.id)}>View</button>
                        <button className="table-action" disabled={!canEditSales || sale.sale_status === "CANCELLED"} onClick={() => loadSaleForEdit(sale.id)}>Edit</button>
                        <button className="remove-button" disabled={!canEditSales || sale.sale_status === "CANCELLED"} onClick={() => cancelSale(sale)}>Cancel</button>
                        <button className="secondary-button" onClick={() => loadChangeHistory(sale.id)}>History</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </DataTable>
            </ModuleCard>
          )}

          {activeView === "sale-rates" && canManageRates && (
            <SaleRateManager
              history={saleRateHistory}
              onReload={async () => { await Promise.all([loadProducts(), loadSaleRates()]); }}
              onRefresh={loadSaleRates}
              rates={saleRates}
              desiredMargin={saleDesiredMargin}
              setDesiredMargin={setSaleDesiredMargin}
              user={user}
            />
          )}

          {activeView === "settings" && (
            <SettingsModule
              canManage={canManageRates}
              onReload={async () => { await Promise.all([loadSettingsData(), loadPurchaseRules(), loadDiscountRules()]); }}
              settingsData={settingsData}
              rules={settingsRules}
              user={user}
            />
          )}

          {activeView === "reports" && (
            <ReportsModule
              data={reportsData}
              onCancelPurchase={cancelPurchase}
              onCompletePurchase={completePendingPurchase}
              onEditPurchase={editPurchase}
              onOpenSupplierLedger={openSupplierLedgerFromReport}
              onReload={loadReports}
            />
          )}

          {activeView === "expenses" && (
            <ExpensesModule
              expenses={expenses}
              onReload={loadExpenses}
              user={user}
            />
          )}
        </div>
      </section>
      {selectedInvoice && <InvoiceModal invoice={selectedInvoice} onClose={() => setSelectedInvoice(null)} paymentSettings={settingsData.paymentSettings} printSettings={settingsData.businessSettings} />}
      {editingSale && (
        <SaleEditModal
          invoice={editingSale}
          onClose={() => setEditingSale(null)}
          onSaved={async () => {
            setEditingSale(null);
            await Promise.all([loadSalesHistory(), loadDashboardData()]);
          }}
          products={products.filter((product) => product.active !== false)}
          user={user}
        />
      )}
      {changeHistory && <ChangeHistoryModal history={changeHistory} onClose={() => setChangeHistory(null)} />}
      {profileOpen && <UserProfilePanel onClose={() => setProfileOpen(false)} onLogout={() => setUser(null)} user={user} />}
    </main>
  );
}

function ReportToolbar({ onPdfExport, onPrint, title }) {
  return (
    <div className="report-toolbar no-print">
      <strong>{title}</strong>
      <div className="button-row">
        <button className="secondary-button" onClick={onPrint}><Icon name="print" /> Print</button>
        <button className="secondary-button" onClick={onPdfExport || onPrint}>PDF Export</button>
      </div>
    </div>
  );
}

function UserProfilePanel({ onClose, onLogout, user }) {
  const [passwordDraft, setPasswordDraft] = useState({ password: "", confirm_password: "" });
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const savePassword = async () => {
    try {
      await axios.put(`${API_URL}/users/${user.id}/password`, {
        ...passwordDraft,
        updated_by: user.id,
      });
      setPasswordDraft({ password: "", confirm_password: "" });
      setShowPasswordForm(false);
      alert("Password changed");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to change password"));
    }
  };
  return (
    <div className="modal-backdrop">
      <section className="invoice-modal profile-panel">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">User Profile</span>
            <strong>{user.full_name}</strong>
          </div>
          <button aria-label="Close profile" className="remove-button" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="sale-edit-body">
          <div className="purchase-summary-grid supplier-payment-preview">
            <SummaryMetric label="Role" value={user.role} featured />
            <SummaryMetric label="Branch" value={user.branch || "Main Branch"} />
            <SummaryMetric label="Last Login" value={user.last_login_at ? new Date(user.last_login_at).toLocaleString("en-IN") : "Not recorded"} />
            <SummaryMetric label="Device" value="Local Counter" />
          </div>
          <div className="form-grid supplier-form-grid">
            <Field label="Username"><input disabled value={user.username || ""} /></Field>
            <Field label="Mobile"><input disabled value={user.mobile_number || ""} /></Field>
            <Field label="Email"><input disabled value={user.email || ""} /></Field>
            <Field label="Joining Date"><input disabled value={user.joining_date ? toDateKey(user.joining_date) : ""} /></Field>
            <Field label="Notes"><textarea disabled value={user.notes || ""} /></Field>
          </div>
          {showPasswordForm && (
            <div className="form-grid settings-add-grid">
              <Field label="New Password"><input type="password" value={passwordDraft.password} onChange={(event) => setPasswordDraft({ ...passwordDraft, password: event.target.value })} /></Field>
              <Field label="Confirm Password"><input type="password" value={passwordDraft.confirm_password} onChange={(event) => setPasswordDraft({ ...passwordDraft, confirm_password: event.target.value })} /></Field>
            </div>
          )}
          <div className="button-row">
            <button className="secondary-button" onClick={() => setShowPasswordForm((visible) => !visible)}>{showPasswordForm ? "Cancel Password Change" : "Change Password"}</button>
            {showPasswordForm && <button className="primary-button" onClick={savePassword}>Save Password</button>}
            <button className="remove-button" onClick={onLogout}>Logout</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function PrintableReport({ beforePdfExport, beforePrint, children, title }) {
  const [printTarget, setPrintTarget] = useState(false);
  const printReport = () => {
    if (beforePrint && beforePrint() === false) return;
    setPrintTarget(true);
    setTimeout(() => {
      window.print();
      setTimeout(() => setPrintTarget(false), 250);
    }, 50);
  };
  const exportReport = () => {
    if (beforePdfExport && beforePdfExport() === false) return;
    setPrintTarget(true);
    setTimeout(() => {
      window.print();
      setTimeout(() => setPrintTarget(false), 250);
    }, 50);
  };
  return (
    <section className={`print-section ${printTarget ? "print-target" : ""}`}>
      <ReportToolbar onPdfExport={exportReport} onPrint={printReport} title={title} />
      <div className="print-area report-paper">
        <header className="report-print-header">
          <BrandLogo invoice />
          <div>
            <strong>{title}</strong>
            <span>{new Date().toLocaleString("en-IN")}</span>
          </div>
        </header>
        {children}
      </div>
    </section>
  );
}

function ReportsModule({ data = {}, onCancelPurchase, onCompletePurchase, onEditPurchase, onOpenSupplierLedger, onReload }) {
  const [range, setRange] = useState("today");
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [selectedReport, setSelectedReport] = useState("");
  const [clubPurchaseItems, setClubPurchaseItems] = useState(false);
  const [purchasePrintNarration, setPurchasePrintNarration] = useState(false);
  const [purchaseFilters, setPurchaseFilters] = useState({
    supplier: "",
    product: "",
    status: "ACTIVE",
    paymentType: "",
    date: "",
  });
  const [customRange, setCustomRange] = useState({
    date_from: toDateKey(new Date()),
    date_to: toDateKey(new Date()),
  });
  const refreshReports = async () => {
    const params = range === "custom" ? customRange : { range };
    await onReload(params);
  };
  const matchesSearch = (row) => !search.trim() || Object.values(row || {}).some((value) =>
    String(value ?? "").toLowerCase().includes(search.trim().toLowerCase())
  );
  const filterRows = (rows) => {
    const safeRows = Array.isArray(rows)
      ? rows
      : Array.isArray(rows?.data)
        ? rows.data
        : Array.isArray(rows?.rows)
          ? rows.rows
          : Array.isArray(rows?.items)
            ? rows.items
            : [];
    return safeRows.filter(matchesSearch);
  };
  const totalOf = (rows, key) => rows.reduce((sum, row) => sum + Number(row[key] || 0), 0);
  const money = (value) => currency.format(Number(value || 0));
  const number = (value) => Number(value || 0).toLocaleString("en-IN");
  const stockRows = filterRows(data.stockReport);
  const lowStockRows = stockRows.filter((row) => Number(row.current_stock || 0) <= Number(row.minimum_stock || 0));
  const ledgerRows = filterRows(data.ledgerReport);
  const customerLedgerRows = ledgerRows.filter((row) => String(row.transaction_type || "").includes("Customer"));
  const supplierLedgerRows = ledgerRows.filter((row) => String(row.transaction_type || "").includes("Supplier"));
  const salesChanges = filterRows(data.salesChangeReport);
  const editedBills = salesChanges.filter((row) => row.sale_status === "EDITED" || row.edited_at);
  const cancelledBills = salesChanges.filter((row) => row.sale_status === "CANCELLED" || row.cancelled_at);
  const purchaseChanges = filterRows(data.purchaseChangeReport);
  const wasteProductRows = filterRows(data.wasteProductReport);
  const purchaseHistoryRawRows = filterRows(data.purchaseHistoryReport);
  const purchaseSuppliers = [...new Map(purchaseHistoryRawRows.map((row) => [String(row.supplier_id || row.supplier_name), row])).values()];
  const purchaseProducts = [...new Map(purchaseHistoryRawRows.map((row) => [String(row.product_id || row.product_name), row])).values()];
  const purchaseStatusLabel = (row) => {
    if (row.purchase_status === "CANCELLED") return "Cancelled";
    if (row.purchase_bill_status === "BILL_PENDING") return "Pending Bill";
    return "Completed Bill";
  };
  const purchaseCharges = (row) => (
    Number(row.mandi_tax_amount || 0) +
    Number(row.freight_charges || 0) +
    Number(row.labour_charges || 0) +
    Number(row.other_charges || 0)
  );
  const purchaseItemBasic = (row) => Number(row.item_basic_amount || 0) || Number(row.quantity || 0) * Number(row.purchase_rate || row.expected_purchase_rate || 0);
  const purchaseItemNarration = (row) => {
    const product = row.product_name || "Item";
    const qty = Number(row.quantity || 0).toLocaleString("en-IN");
    const unit = row.unit || "";
    const rate = Number(row.purchase_rate || row.expected_purchase_rate || 0);
    return `${product} ${qty}${unit ? ` ${unit}` : ""} @ ${money(rate)} = ${money(purchaseItemBasic(row))}`;
  };
  const filteredPurchaseHistoryRows = purchaseHistoryRawRows.filter((row) => {
    if (purchaseFilters.supplier && String(row.supplier_id || "") !== purchaseFilters.supplier) return false;
    if (purchaseFilters.product && String(row.product_id || "") !== purchaseFilters.product) return false;
    if (purchaseFilters.paymentType && row.purchase_type !== purchaseFilters.paymentType) return false;
    if (purchaseFilters.date && toDateKey(row.purchase_date) !== purchaseFilters.date) return false;
    if (purchaseFilters.status === "CANCELLED") return row.purchase_status === "CANCELLED";
    if (purchaseFilters.status === "BILL_PENDING") return row.purchase_status !== "CANCELLED" && row.purchase_bill_status === "BILL_PENDING";
    if (purchaseFilters.status === "BILL_COMPLETED") return row.purchase_status !== "CANCELLED" && row.purchase_bill_status === "BILL_COMPLETED";
    return row.purchase_status !== "CANCELLED";
  });
  const groupedPurchaseHistoryRows = (() => {
    if (!clubPurchaseItems) return filteredPurchaseHistoryRows.map((row) => ({
      ...row,
      display_key: `item-${row.id}-${row.item_id || row.product_id}`,
      item_summary: purchaseItemNarration(row),
      item_narration: purchaseItemNarration(row),
      gross_total: Number(row.gross_amount || 0) || purchaseItemBasic(row) + purchaseCharges(row),
      charges_total: purchaseCharges(row),
      rebate_total: Number(row.rebate_amount || 0),
      net_total: Number(row.net_payable || row.item_net_payable || 0),
      paid_total: Number(row.paid_amount || 0),
      balance_total: Number(row.balance_amount || 0),
      status_label: purchaseStatusLabel(row),
      source_rows: [row],
    }));
    const groups = new Map();
    for (const row of filteredPurchaseHistoryRows) {
      const key = `${toDateKey(row.purchase_date)}-${row.supplier_id || row.supplier_name}`;
      const existing = groups.get(key) || {
        ...row,
        display_key: `club-${key}`,
        quantity: 0,
        gross_total: 0,
        charges_total: 0,
        rebate_total: 0,
        net_total: 0,
        paid_total: 0,
        balance_total: 0,
        source_rows: [],
      };
      existing.source_rows.push(row);
      existing.gross_total += Number(row.gross_amount || 0) || purchaseItemBasic(row) + purchaseCharges(row);
      existing.charges_total += purchaseCharges(row);
      existing.rebate_total += Number(row.rebate_amount || 0);
      existing.net_total += Number(row.net_payable || row.item_net_payable || 0);
      existing.paid_total += Number(row.paid_amount || 0);
      existing.balance_total += Number(row.balance_amount || 0);
      groups.set(key, existing);
    }
    return [...groups.values()].map((group) => {
      const itemSummary = group.source_rows
        .slice(0, 3)
        .map((row) => `${row.product_name} ${Number(row.quantity || 0).toLocaleString("en-IN")}${row.unit ? row.unit.toLowerCase() : ""}`)
        .join(", ");
      const extraCount = Math.max(group.source_rows.length - 3, 0);
      const statuses = new Set(group.source_rows.map(purchaseStatusLabel));
      return {
        ...group,
        item_summary: `${itemSummary}${extraCount ? ` +${extraCount} more` : ""}`,
        item_narration: group.source_rows.map(purchaseItemNarration).join("\n"),
        status_label: statuses.size > 1 ? "Mixed" : [...statuses][0],
      };
    });
  })();
  const purchaseDateTotals = groupedPurchaseHistoryRows.reduce((totals, row) => {
    const date = toDateKey(row.purchase_date);
    const current = totals.get(date) || { net: 0, gross: 0 };
    current.net += row.status_label === "Cancelled" ? 0 : Number(row.net_total || 0);
    current.gross += row.status_label === "Cancelled" ? 0 : Number(row.gross_total || 0);
    totals.set(date, current);
    return totals;
  }, new Map());
  const reports = {
    salesByDate: {
      title: "Sales by Date",
      rows: filterRows(data.salesReport),
      summary: (rows) => [["Sales", money(totalOf(rows, "total_sales")), true], ["Cash", money(totalOf(rows, "cash_sales"))], ["UPI", money(totalOf(rows, "upi_sales"))], ["Profit", money(totalOf(rows, "total_profit"))]],
      headers: ["Date", "Transactions", "Sales", "Cash", "UPI", "Bank/Card", "Cost", "Profit"],
      render: (row) => <tr key={row.sale_date}><td>{row.sale_date}</td><td>{row.transaction_count}</td><td>{money(row.total_sales)}</td><td>{money(row.cash_sales)}</td><td>{money(row.upi_sales)}</td><td>{money(row.bank_card_sales)}</td><td>{money(row.total_cost)}</td><td className="profit-cell">{money(row.total_profit)}</td></tr>,
    },
    salesByProduct: {
      title: "Sales by Product",
      rows: filterRows(data.salesProductReport),
      summary: (rows) => [["Revenue", money(totalOf(rows, "revenue")), true], ["Quantity Sold", number(totalOf(rows, "quantity_sold"))], ["Profit", money(totalOf(rows, "profit"))]],
      headers: ["Product", "Quantity", "Revenue", "Cost", "Profit"],
      render: (row) => <tr key={row.product_name}><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{number(row.quantity_sold)}</td><td>{money(row.revenue)}</td><td>{money(row.cost)}</td><td className="profit-cell">{money(row.profit)}</td></tr>,
    },
    salesByCustomer: {
      title: "Sales by Customer",
      rows: filterRows(data.salesCustomerReport),
      summary: (rows) => [["Sales", money(totalOf(rows, "total_sales")), true], ["Invoices", number(totalOf(rows, "invoice_count"))], ["Profit", money(totalOf(rows, "total_profit"))]],
      headers: ["Customer", "Mobile", "Invoices", "Sales", "Profit"],
      render: (row) => <tr key={`${row.customer_name}-${row.customer_mobile}`}><td className="primary-cell">{row.customer_name}</td><td>{row.customer_mobile || "-"}</td><td>{row.invoice_count}</td><td>{money(row.total_sales)}</td><td className="profit-cell">{money(row.total_profit)}</td></tr>,
    },
    salesHistory: {
      title: "Sales History",
      rows: filterRows(data.salesHistoryReport),
      summary: (rows) => [["Net Sales", money(totalOf(rows, "total_amount")), true], ["Invoices", rows.length], ["Profit", money(totalOf(rows, "profit"))]],
      headers: ["Invoice", "Date", "Status", "Customer", "Payment", "Gross", "Discount", "Net", "Profit"],
      render: (row) => <tr key={row.id}><td><span className="batch-id">{row.invoice_no || `#${row.id}`}</span></td><td>{row.sale_date}</td><td>{row.sale_status}</td><td>{row.customer_name}</td><td>{row.payment_mode}</td><td>{money(row.gross_amount)}</td><td>{money(row.discount_amount)}</td><td>{money(row.total_amount)}</td><td className="profit-cell">{money(row.profit)}</td></tr>,
    },
    editedBills: {
      title: "Edited Bills",
      rows: editedBills,
      summary: (rows) => [["Edited Bills", rows.length, true], ["Total Amount", money(totalOf(rows, "total_amount"))]],
      headers: ["Invoice", "Date", "Amount", "Edited By", "Edited At", "Reason"],
      render: (row) => <tr key={row.id}><td>{row.invoice_no || `#${row.id}`}</td><td>{row.sale_date}</td><td>{money(row.total_amount)}</td><td>{row.changed_by_name || "-"}</td><td>{row.edited_at ? new Date(row.edited_at).toLocaleString("en-IN") : "-"}</td><td>{row.edit_reason || "-"}</td></tr>,
    },
    cancelledBills: {
      title: "Cancelled Bills",
      rows: cancelledBills,
      summary: (rows) => [["Cancelled Bills", rows.length, true], ["Cancelled Amount", money(totalOf(rows, "total_amount"))]],
      headers: ["Invoice", "Date", "Amount", "Cancelled By", "Cancelled At", "Reason"],
      render: (row) => <tr key={row.id}><td>{row.invoice_no || `#${row.id}`}</td><td>{row.sale_date}</td><td>{money(row.total_amount)}</td><td>{row.changed_by_name || "-"}</td><td>{row.cancelled_at ? new Date(row.cancelled_at).toLocaleString("en-IN") : "-"}</td><td>{row.cancellation_reason || "-"}</td></tr>,
    },
    provisionalProfitSales: {
      title: "Provisional Profit Sales",
      rows: filterRows(data.provisionalProfitSalesReport),
      summary: (rows) => [["Sales", money(totalOf(rows, "total_amount")), true], ["Provisional Profit", money(totalOf(rows, "profit"))], ["Invoices", rows.length]],
      headers: ["Invoice", "Date", "Customer", "Payment", "Products", "Amount", "Cost", "Provisional Profit"],
      render: (row) => <tr key={row.id}><td>{row.invoice_no}</td><td>{row.sale_date}</td><td>{row.customer_name}</td><td>{row.payment_mode}</td><td>{row.products || "-"}</td><td>{money(row.total_amount)}</td><td>{money(row.total_cost)}</td><td className="profit-cell">{money(row.profit)}</td></tr>,
    },
    discountReport: {
      title: "Discount Report",
      rows: filterRows(data.discountReport),
      summary: (rows) => [["Total Discount", money(totalOf(rows, "total_discount")), true], ["Bill Discount", money(totalOf(rows, "bill_discount"))], ["Invoices", number(totalOf(rows, "invoice_count"))]],
      headers: ["Date", "Payment", "Invoices", "Item Discount", "Bill Discount", "Total Discount"],
      render: (row) => <tr key={`${row.sale_date}-${row.payment_mode}`}><td>{row.sale_date}</td><td>{row.payment_mode}</td><td>{row.invoice_count}</td><td>{money(row.item_discount)}</td><td>{money(row.bill_discount)}</td><td className="profit-cell">{money(row.total_discount)}</td></tr>,
    },
    purchasesByDate: {
      title: "Purchases by Date",
      rows: filterRows(data.purchaseReport),
      summary: (rows) => [["Net Purchases", money(totalOf(rows, "net_purchase")), true], ["Paid", money(totalOf(rows, "paid_amount"))], ["Balance", money(totalOf(rows, "balance_amount"))]],
      headers: ["Date", "Bills", "Gross", "Rebate", "Net", "Paid", "Balance"],
      render: (row) => <tr key={row.purchase_date}><td>{row.purchase_date}</td><td>{row.purchase_count}</td><td>{money(row.gross_purchase)}</td><td>{money(row.rebate_received)}</td><td>{money(row.net_purchase)}</td><td>{money(row.paid_amount)}</td><td className="balance-cell">{money(row.balance_amount)}</td></tr>,
    },
    purchasesByProduct: {
      title: "Purchases by Product",
      rows: filterRows(data.purchaseProductReport),
      summary: (rows) => [["Net Purchases", money(totalOf(rows, "net_purchase")), true], ["Quantity", number(totalOf(rows, "quantity_purchased"))], ["Mandi Tax", money(totalOf(rows, "mandi_tax"))]],
      headers: ["Product", "Quantity", "Net Purchase", "Mandi Tax", "Rebate"],
      render: (row) => <tr key={row.product_name}><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{number(row.quantity_purchased)}</td><td>{money(row.net_purchase)}</td><td>{money(row.mandi_tax)}</td><td>{money(row.rebate)}</td></tr>,
    },
    purchasesBySupplier: {
      title: "Purchases by Supplier",
      rows: filterRows(data.purchaseSupplierReport),
      summary: (rows) => [["Net Purchases", money(totalOf(rows, "net_purchase")), true], ["Purchases", number(totalOf(rows, "purchase_count"))], ["Balance", money(totalOf(rows, "balance_amount"))]],
      headers: ["Supplier", "Bills", "Gross", "Rebate", "Net", "Paid", "Balance"],
      render: (row) => <tr key={row.supplier_name}><td className="primary-cell">{row.supplier_name}</td><td>{row.purchase_count}</td><td>{money(row.gross_purchase)}</td><td>{money(row.rebate_received)}</td><td>{money(row.net_purchase)}</td><td>{money(row.paid_amount)}</td><td className="balance-cell">{money(row.balance_amount)}</td></tr>,
    },
    purchaseOutstanding: {
      title: "Purchase Outstanding",
      rows: filterRows(data.supplierOutstandingReport),
      summary: (rows) => [["Outstanding", money(totalOf(rows, "outstanding_balance")), true], ["Purchases", money(totalOf(rows, "total_purchases"))], ["Paid", money(totalOf(rows, "total_paid"))]],
      headers: ["Supplier", "Purchases", "Paid", "Rebate", "Outstanding"],
      render: (row) => <tr key={row.id}><td className="primary-cell">{row.supplier_name}</td><td>{money(row.total_purchases)}</td><td>{money(row.total_paid)}</td><td>{money(row.total_rebate_received)}</td><td className="balance-cell">{money(row.outstanding_balance)}</td></tr>,
    },
    purchaseHistory: {
      title: "Purchase History",
      rows: groupedPurchaseHistoryRows,
      summary: (rows) => [
        ["Rows", rows.length, true],
        ["Gross Total", money(rows.filter((row) => row.status_label !== "Cancelled").reduce((sum, row) => sum + Number(row.gross_total || 0), 0))],
        ["Net Total", money(rows.filter((row) => row.status_label !== "Cancelled").reduce((sum, row) => sum + Number(row.net_total || 0), 0))],
        ["Balance", money(rows.filter((row) => row.status_label !== "Cancelled").reduce((sum, row) => sum + Number(row.balance_total || 0), 0))],
      ],
      headers: ["Date", "Supplier / Firm Name", "Items", "Gross Total", "Charges", "Rebate", "Net Total", "Paid", "Balance", "Status", "Actions"],
      render: (row) => (
        <tr key={row.display_key}>
          <td className="primary-cell" onDoubleClick={() => setPurchaseFilters((current) => ({ ...current, date: toDateKey(row.purchase_date) }))}>{toDateKey(row.purchase_date)}</td>
          <td className="primary-cell" onDoubleClick={() => onOpenSupplierLedger?.(row)}>{row.supplier_name}<small className="cell-note">{row.firm_name || "Double-click for supplier ledger"}</small></td>
          <td className="primary-cell purchase-items-cell" onDoubleClick={() => onEditPurchase?.(row.source_rows?.[0] || row)}>
            <span title={row.item_narration}>{row.item_summary}</span>
            <small className="cell-note">{clubPurchaseItems ? `${row.source_rows.length} item${row.source_rows.length === 1 ? "" : "s"}` : `${number(row.quantity)} ${row.unit || ""}`}</small>
          </td>
          <td>{money(row.gross_total)}</td>
          <td>{money(row.charges_total)}</td>
          <td>{money(row.rebate_total)}</td>
          <td>{money(row.net_total)}</td>
          <td>{money(row.paid_total)}</td>
          <td className="balance-cell">{money(row.balance_total)}</td>
          <td><span className={row.status_label === "Cancelled" ? "stock-low" : row.status_label === "Pending Bill" ? "origin-rate" : "stock-ok"}>{row.status_label}</span></td>
          <td>
            <div className="button-row table-actions-row">
              <button className="table-action" disabled={row.status_label === "Cancelled"} onClick={() => onEditPurchase?.(row.source_rows?.[0] || row)}>Add / Edit Purchase</button>
              {row.status_label === "Pending Bill" && <button className="primary-button" disabled={clubPurchaseItems} onClick={() => onCompletePurchase?.(row.source_rows?.[0] || row)}>Complete Bill</button>}
              <button className="remove-button" disabled={row.status_label === "Cancelled" || clubPurchaseItems} onClick={() => onCancelPurchase?.(row.source_rows?.[0] || row)}>Cancel</button>
            </div>
          </td>
        </tr>
      ),
    },
    purchaseEditCancel: {
      title: "Purchase Edit / Cancel Report",
      rows: purchaseChanges,
      summary: (rows) => [["Changed Purchases", rows.length, true], ["Cancelled", rows.filter((row) => row.purchase_status === "CANCELLED").length], ["Edited", rows.filter((row) => row.purchase_status === "EDITED").length]],
      headers: ["Purchase", "Date", "Supplier", "Status", "Amount", "Changed By", "Reason"],
      render: (row) => <tr key={row.id}><td>#{row.id}</td><td>{row.purchase_date}</td><td>{row.supplier_name}</td><td>{row.purchase_status}</td><td>{money(row.net_payable)}</td><td>{row.changed_by_name || "-"}</td><td>{row.cancellation_reason || row.edit_reason || "-"}</td></tr>,
    },
    pendingPurchaseBills: {
      title: "Pending Purchase Bills",
      rows: filterRows(data.pendingPurchaseBillsReport),
      summary: (rows) => [["Pending Bills", rows.length, true], ["Quantity", number(totalOf(rows, "quantity"))], ["Remaining", number(totalOf(rows, "remaining_qty"))]],
      headers: ["Purchase", "Date", "Supplier", "Product", "Qty", "Remaining", "Temp Sale Rate", "Expected Rate", "Remarks"],
      render: (row) => <tr key={row.id}><td>#{row.id}</td><td>{row.purchase_date}</td><td>{row.supplier_name}</td><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{number(row.quantity)}</td><td>{number(row.remaining_qty)}</td><td>{money(row.temporary_sale_rate)}</td><td>{money(row.expected_purchase_rate)}</td><td>{row.remarks || "-"}</td></tr>,
    },
    stockWithoutBill: {
      title: "Stock Received Without Bill",
      rows: filterRows(data.stockWithoutBillReport),
      summary: (rows) => [["Batches", rows.length, true], ["Received Qty", number(totalOf(rows, "purchase_qty"))], ["Remaining Qty", number(totalOf(rows, "remaining_qty"))]],
      headers: ["Arrival Date", "Batch", "Supplier", "Product", "Received", "Remaining", "Temp Sale Rate", "Expected Rate"],
      render: (row) => <tr key={row.id}><td>{row.arrival_date}</td><td><span className="batch-id">{row.batch_no}</span></td><td>{row.supplier_name}</td><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{number(row.purchase_qty)}</td><td>{number(row.remaining_qty)}</td><td>{money(row.temporary_sale_rate)}</td><td>{money(row.expected_purchase_rate)}</td></tr>,
    },
    customerLedger: {
      title: "Customer Ledger",
      rows: customerLedgerRows,
      summary: (rows) => [["Debits", money(totalOf(rows, "debit")), true], ["Credits", money(totalOf(rows, "credit"))], ["Rows", rows.length]],
      headers: ["Date", "Type", "Customer", "Debit", "Credit", "Status", "Remarks"],
      render: (row, index) => <tr key={`${row.date}-${index}`}><td>{row.date}</td><td>{row.transaction_type}</td><td className="primary-cell">{row.party_name}</td><td>{money(row.debit)}</td><td>{money(row.credit)}</td><td>{row.status || "-"}</td><td>{row.remarks || "-"}</td></tr>,
    },
    supplierLedger: {
      title: "Supplier Ledger",
      rows: supplierLedgerRows,
      summary: (rows) => [["Debits", money(totalOf(rows, "debit")), true], ["Credits", money(totalOf(rows, "credit"))], ["Rows", rows.length]],
      headers: ["Date", "Type", "Supplier", "Debit", "Credit", "Status", "Remarks"],
      render: (row, index) => <tr key={`${row.date}-${index}`}><td>{row.date}</td><td>{row.transaction_type}</td><td className="primary-cell">{row.party_name}</td><td>{money(row.debit)}</td><td>{money(row.credit)}</td><td>{row.status || "-"}</td><td>{row.remarks || "-"}</td></tr>,
    },
    accountStatement: {
      title: "Account Statement",
      rows: ledgerRows,
      summary: (rows) => [["Debits", money(totalOf(rows, "debit")), true], ["Credits", money(totalOf(rows, "credit"))], ["Rows", rows.length]],
      headers: ["Date", "Type", "Account", "Debit", "Credit", "Status", "Remarks"],
      render: (row, index) => <tr key={`${row.date}-${index}`}><td>{row.date}</td><td>{row.transaction_type}</td><td className="primary-cell">{row.party_name}</td><td>{money(row.debit)}</td><td>{money(row.credit)}</td><td>{row.status || "-"}</td><td>{row.remarks || "-"}</td></tr>,
    },
    paymentReport: {
      title: "Payment Report",
      rows: filterRows(data.paymentReport),
      summary: (rows) => [["Payments", money(totalOf(rows, "payment_amount")), true], ["Rebates", money(totalOf(rows, "rebate_amount"))], ["Entries", rows.length]],
      headers: ["Date", "Type", "Party", "Payment", "Rebate", "Mode", "Status", "Reference"],
      render: (row, index) => <tr key={`${row.payment_date}-${index}`}><td>{row.payment_date}</td><td>{row.payment_type}</td><td className="primary-cell">{row.party_name}</td><td>{money(row.payment_amount)}</td><td>{money(row.rebate_amount)}</td><td>{row.payment_mode}</td><td>{row.cancelled ? "Cancelled" : "Active"}</td><td>{row.reference_number || "-"}</td></tr>,
    },
    paymentModeSummary: {
      title: "Payment Mode Summary",
      rows: filterRows(data.paymentModeSummary),
      summary: (rows) => [["Total Amount", money(totalOf(rows, "total_amount")), true], ["Transactions", number(totalOf(rows, "transaction_count"))], ["Modes", new Set(rows.map((row) => row.payment_mode)).size]],
      headers: ["Date", "Source", "Payment Mode", "Transactions", "Total Amount"],
      render: (row, index) => <tr key={`${row.transaction_date}-${row.source}-${row.payment_mode}-${index}`}><td>{row.transaction_date}</td><td>{row.source}</td><td><span className="tag">{row.payment_mode}</span></td><td>{row.transaction_count}</td><td className="primary-cell">{money(row.total_amount)}</td></tr>,
    },
    receivableReport: {
      title: "Receivable Report",
      rows: filterRows(data.customerOutstandingReport),
      summary: (rows) => [["Receivable", money(totalOf(rows, "outstanding_balance")), true], ["Sales", money(totalOf(rows, "total_sales"))], ["Paid", money(totalOf(rows, "total_paid"))]],
      headers: ["Customer", "Type", "Sales", "Paid", "Outstanding"],
      render: (row) => <tr key={row.id}><td className="primary-cell">{row.customer_name}</td><td>{row.customer_type}</td><td>{money(row.total_sales)}</td><td>{money(row.total_paid)}</td><td className="balance-cell">{money(row.outstanding_balance)}</td></tr>,
    },
    payableReport: {
      title: "Payable Report",
      rows: filterRows(data.supplierOutstandingReport),
      summary: (rows) => [["Payable", money(totalOf(rows, "outstanding_balance")), true], ["Purchases", money(totalOf(rows, "total_purchases"))], ["Paid", money(totalOf(rows, "total_paid"))]],
      headers: ["Supplier", "Purchases", "Paid", "Rebate", "Outstanding"],
      render: (row) => <tr key={row.id}><td className="primary-cell">{row.supplier_name}</td><td>{money(row.total_purchases)}</td><td>{money(row.total_paid)}</td><td>{money(row.total_rebate_received)}</td><td className="balance-cell">{money(row.outstanding_balance)}</td></tr>,
    },
    returnHistory: {
      title: "Sale Return History",
      rows: filterRows(data.returnHistoryReport),
      summary: (rows) => [["Return Value", money(totalOf(rows, "total_return_amount")), true], ["Returns", rows.length]],
      headers: ["Return No", "Date", "Invoice", "Customer", "Refund", "Value", "Reason", "Items"],
      render: (row) => <tr key={row.return_no}><td>{row.return_no}</td><td>{row.return_date}</td><td>{row.invoice_no || "-"}</td><td>{row.customer_name}</td><td>{row.refund_type}</td><td>{money(row.total_return_amount)}</td><td>{row.return_reason}</td><td>{row.items || "-"}</td></tr>,
    },
    returnValue: {
      title: "Return Value Report",
      rows: filterRows(data.returnReport),
      summary: (rows) => [["Return Value", money(totalOf(rows, "return_value")), true], ["Return Quantity", number(totalOf(rows, "return_quantity"))], ["Returns", number(totalOf(rows, "return_count"))]],
      headers: ["Date", "Returns", "Return Quantity", "Return Value"],
      render: (row) => <tr key={row.return_date}><td>{row.return_date}</td><td>{row.return_count}</td><td>{number(row.return_quantity)}</td><td>{money(row.return_value)}</td></tr>,
    },
    returnReason: {
      title: "Return Reason Analysis",
      rows: filterRows(data.returnReasonReport),
      summary: (rows) => [["Return Value", money(totalOf(rows, "return_value")), true], ["Returns", number(totalOf(rows, "return_count"))]],
      headers: ["Reason", "Returns", "Return Value"],
      render: (row) => <tr key={row.return_reason}><td className="primary-cell">{row.return_reason}</td><td>{row.return_count}</td><td>{money(row.return_value)}</td></tr>,
    },
    dailyWaste: {
      title: "Daily Waste",
      rows: filterRows(data.wasteReport),
      summary: (rows) => [["Waste Cost", money(totalOf(rows, "waste_cost")), true], ["Waste Quantity", number(totalOf(rows, "waste_quantity"))], ["Entries", number(totalOf(rows, "entry_count"))]],
      headers: ["Date", "Type", "Entries", "Quantity", "Cost"],
      render: (row) => <tr key={`${row.waste_date}-${row.waste_type}`}><td>{row.waste_date}</td><td>{row.waste_type}</td><td>{row.entry_count}</td><td>{number(row.waste_quantity)}</td><td>{money(row.waste_cost)}</td></tr>,
    },
    monthlyWaste: {
      title: "Monthly Waste",
      rows: filterRows(data.wasteReport),
      summary: (rows) => [["Waste Cost", money(totalOf(rows, "waste_cost")), true], ["Waste Quantity", number(totalOf(rows, "waste_quantity"))], ["Entries", number(totalOf(rows, "entry_count"))]],
      headers: ["Date", "Type", "Entries", "Quantity", "Cost"],
      render: (row) => <tr key={`${row.waste_date}-${row.waste_type}`}><td>{row.waste_date}</td><td>{row.waste_type}</td><td>{row.entry_count}</td><td>{number(row.waste_quantity)}</td><td>{money(row.waste_cost)}</td></tr>,
    },
    productWiseWaste: {
      title: "Product Wise Waste",
      rows: wasteProductRows,
      summary: (rows) => [["Waste Cost", money(totalOf(rows, "waste_cost")), true], ["Waste Quantity", number(totalOf(rows, "waste_quantity"))], ["Products", rows.length]],
      headers: ["Product", "Quantity", "Cost"],
      render: (row) => <tr key={row.product_name}><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{number(row.waste_quantity)}</td><td>{money(row.waste_cost)}</td></tr>,
    },
    mostWastedProducts: {
      title: "Most Wasted Products",
      rows: wasteProductRows.slice(0, 10),
      summary: (rows) => [["Waste Cost", money(totalOf(rows, "waste_cost")), true], ["Waste Quantity", number(totalOf(rows, "waste_quantity"))], ["Products", rows.length]],
      headers: ["Product", "Quantity", "Cost"],
      render: (row) => <tr key={row.product_name}><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{number(row.waste_quantity)}</td><td>{money(row.waste_cost)}</td></tr>,
    },
    wasteCost: {
      title: "Waste Cost Report",
      rows: filterRows(data.wasteReport),
      summary: (rows) => [["Waste Cost", money(totalOf(rows, "waste_cost")), true], ["Waste Quantity", number(totalOf(rows, "waste_quantity"))]],
      headers: ["Date", "Type", "Quantity", "Cost"],
      render: (row) => <tr key={`${row.waste_date}-${row.waste_type}`}><td>{row.waste_date}</td><td>{row.waste_type}</td><td>{number(row.waste_quantity)}</td><td>{money(row.waste_cost)}</td></tr>,
    },
    currentStock: {
      title: "Current Stock",
      rows: stockRows,
      summary: (rows) => [["Stock Value", money(totalOf(rows, "stock_value")), true], ["Products", rows.length], ["Low Stock", lowStockRows.length]],
      headers: ["Product", "Category", "Stock", "Minimum", "Unit", "Value"],
      render: (row) => <tr key={row.product_id}><td className="primary-cell">{row.product_name}</td><td>{row.category}</td><td>{number(row.current_stock)}</td><td>{row.minimum_stock || 0}</td><td>{row.unit}</td><td>{money(row.stock_value)}</td></tr>,
    },
    lowStock: {
      title: "Low Stock",
      rows: lowStockRows,
      summary: (rows) => [["Low Stock Items", rows.length, true], ["Stock Value", money(totalOf(rows, "stock_value"))]],
      headers: ["Product", "Category", "Stock", "Minimum", "Unit", "Value"],
      render: (row) => <tr key={row.product_id}><td className="primary-cell">{row.product_name}</td><td>{row.category}</td><td className="stock-low">{number(row.current_stock)}</td><td>{row.minimum_stock || 0}</td><td>{row.unit}</td><td>{money(row.stock_value)}</td></tr>,
    },
    stockMovement: {
      title: "Stock Movement",
      rows: filterRows(data.stockMovementReport),
      summary: (rows) => [["Quantity", number(totalOf(rows, "quantity")), true], ["Movements", number(totalOf(rows, "movement_count"))]],
      headers: ["Date", "Product", "Type", "Quantity", "Count", "Remarks"],
      render: (row, index) => <tr key={`${row.movement_date}-${row.product_name}-${row.transaction_type}-${index}`}><td>{row.movement_date}</td><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{row.transaction_type}</td><td>{number(row.quantity)}</td><td>{row.movement_count}</td><td>{row.remarks || "-"}</td></tr>,
    },
    stockValuation: {
      title: "Stock Valuation",
      rows: stockRows,
      summary: (rows) => [["Stock Value", money(totalOf(rows, "stock_value")), true], ["Products", rows.length]],
      headers: ["Product", "Stock", "Unit", "Value"],
      render: (row) => <tr key={row.product_id}><td className="primary-cell">{row.product_name}</td><td>{number(row.current_stock)}</td><td>{row.unit}</td><td>{money(row.stock_value)}</td></tr>,
    },
    profitLoss: {
      title: "Profit & Loss",
      rows: [data.profitLoss || {}].filter(matchesSearch),
      summary: (rows) => [["Net Profit", money(rows[0]?.netProfit), true], ["Gross Profit", money(rows[0]?.grossProfit)], ["Expenses", money(rows[0]?.expenses)]],
      headers: ["Sales Revenue", "Cash Sales", "UPI Sales", "Bank/Card Sales", "Purchase Cost", "Expenses", "Rebate", "Gross Profit", "Net Profit"],
      render: (row) => <tr key="profit-loss"><td>{money(row.salesRevenue)}</td><td>{money(row.cashSales)}</td><td>{money(row.upiSales)}</td><td>{money(row.bankCardSales)}</td><td>{money(row.purchaseCost)}</td><td>{money(row.expenses)}</td><td>{money(row.supplierRebateReceived)}</td><td>{money(row.grossProfit)}</td><td className="profit-cell">{money(row.netProfit)}</td></tr>,
    },
    balanceSheet: {
      title: "Balance Sheet",
      rows: [data.balanceSheet || {}].filter(matchesSearch),
      summary: (rows) => [["Net Position", money(rows[0]?.netPosition), true], ["Inventory", money(rows[0]?.inventory)], ["Supplier Payable", money(rows[0]?.supplierPayable)]],
      headers: ["Cash", "Bank", "Inventory", "Customer Receivable", "Supplier Payable", "Net Position"],
      render: (row) => <tr key="balance-sheet"><td>{money(row.cash)}</td><td>{money(row.bank)}</td><td>{money(row.inventory)}</td><td>{money(row.customerReceivable)}</td><td>{money(row.supplierPayable)}</td><td className="profit-cell">{money(row.netPosition)}</td></tr>,
    },
    dayToDay: {
      title: "Day-to-Day Transaction Report",
      rows: filterRows(data.dayToDayReport),
      summary: (rows) => [["Sales", money(totalOf(rows, "sales")), true], ["Cash Sales", money(totalOf(rows, "cash_sales"))], ["UPI Sales", money(totalOf(rows, "upi_sales"))], ["Net Profit", money(totalOf(rows, "net_profit"))]],
      headers: ["Date", "Transactions", "Sales", "Cash", "UPI", "Bank/Card", "Customer Receipts", "Supplier Payments", "Purchases", "Expenses", "Returns", "Waste", "Net Profit"],
      render: (row) => <tr key={row.date}><td>{row.date}</td><td>{row.transactions}</td><td>{money(row.sales)}</td><td>{money(row.cash_sales)}</td><td>{money(row.upi_sales)}</td><td>{money(row.bank_card_sales)}</td><td>{money(Number(row.customer_cash_receipts || 0) + Number(row.customer_upi_receipts || 0) + Number(row.customer_bank_card_receipts || 0))}</td><td>{money(Number(row.supplier_cash_payments || 0) + Number(row.supplier_upi_payments || 0) + Number(row.supplier_bank_payments || 0))}</td><td>{money(row.purchases)}</td><td>{money(row.expenses)}</td><td>{money(row.returns)}</td><td>{money(row.waste)}</td><td className="profit-cell">{money(row.net_profit)}</td></tr>,
    },
    expenseReport: {
      title: "Expense Report",
      rows: filterRows(data.expenseReport),
      summary: (rows) => [["Expenses", money(totalOf(rows, "total_expense")), true], ["Entries", number(totalOf(rows, "expense_count"))]],
      headers: ["Date", "Category", "Payment", "Entries", "Amount"],
      render: (row) => <tr key={`${row.expense_date}-${row.category}-${row.payment_mode}`}><td>{row.expense_date}</td><td>{row.category}</td><td>{row.payment_mode}</td><td>{row.expense_count}</td><td>{money(row.total_expense)}</td></tr>,
    },
  };
  const categories = [
    { id: "sales", title: "Sales Reports", icon: "receipt", description: "Invoices, products, customers, discounts and bill changes.", reports: ["salesByDate", "salesByProduct", "salesByCustomer", "salesHistory", "editedBills", "cancelledBills", "provisionalProfitSales", "discountReport"] },
    { id: "purchase", title: "Purchase Reports", icon: "cart", description: "Unified purchase history with item narration, bill status, payments and amendment actions.", reports: ["purchaseHistory"] },
    { id: "accounts", title: "Accounts & Ledger", icon: "users", description: "Customer ledger, supplier ledger, statements, payments and balances.", reports: ["customerLedger", "supplierLedger", "accountStatement", "paymentReport", "paymentModeSummary", "receivableReport", "payableReport"] },
    { id: "returns", title: "Sale Returns", icon: "history", description: "Return history, value and reason analysis.", reports: ["returnHistory", "returnValue", "returnReason"] },
    { id: "waste", title: "Waste Management", icon: "alert", description: "Daily, monthly, product-wise and cost-focused waste analysis.", reports: ["dailyWaste", "monthlyWaste", "productWiseWaste", "mostWastedProducts", "wasteCost"] },
    { id: "inventory", title: "Inventory", icon: "layers", description: "Current stock, low stock, movement and valuation.", reports: ["currentStock", "lowStock", "stockMovement", "stockValuation"] },
    { id: "financial", title: "Financial Reports", icon: "wallet", description: "Profit and loss, balance sheet, day-to-day and expense reports.", reports: ["profitLoss", "balanceSheet", "dayToDay", "expenseReport"] },
  ];
  const currentCategory = categories.find((category) => category.id === selectedCategory);
  const currentReport = reports[selectedReport];
  const renderFilters = () => (
    <div className={selectedReport === "purchaseHistory" ? "ledger-toolbar purchase-history-toolbar" : "ledger-toolbar"}>
      <Field label="Report Range">
        <select value={range} onChange={(event) => setRange(event.target.value)}>
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="week">This Week</option>
          <option value="month">This Month</option>
          <option value="custom">Custom Date Range</option>
        </select>
      </Field>
      {range === "custom" && (
        <>
          <Field label="Date From"><input type="date" value={customRange.date_from} onChange={(event) => setCustomRange({ ...customRange, date_from: event.target.value })} /></Field>
          <Field label="Date To"><input type="date" value={customRange.date_to} onChange={(event) => setCustomRange({ ...customRange, date_to: event.target.value })} /></Field>
        </>
      )}
      <Field label="Search / Filter"><input placeholder="Search this report" value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
      {selectedReport === "purchaseHistory" && (
        <>
          <Field label="Supplier">
            <select value={purchaseFilters.supplier} onChange={(event) => setPurchaseFilters({ ...purchaseFilters, supplier: event.target.value })}>
              <option value="">All suppliers</option>
              {purchaseSuppliers.map((row) => <option key={row.supplier_id || row.supplier_name} value={row.supplier_id || ""}>{row.supplier_name}{row.firm_name ? ` - ${row.firm_name}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Product">
            <select value={purchaseFilters.product} onChange={(event) => setPurchaseFilters({ ...purchaseFilters, product: event.target.value })}>
              <option value="">All products</option>
              {purchaseProducts.map((row) => <option key={row.product_id || row.product_name} value={row.product_id || ""}>{row.product_name}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={purchaseFilters.status} onChange={(event) => setPurchaseFilters({ ...purchaseFilters, status: event.target.value })}>
              <option value="ACTIVE">Active Bills</option>
              <option value="BILL_PENDING">Pending Bill</option>
              <option value="BILL_COMPLETED">Completed Bill</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </Field>
          <Field label="Payment Type">
            <select value={purchaseFilters.paymentType} onChange={(event) => setPurchaseFilters({ ...purchaseFilters, paymentType: event.target.value })}>
              <option value="">All payment types</option>
              <option value="CASH">Cash</option>
              <option value="CREDIT">Credit</option>
              <option value="PENDING_BILL">Pending Bill</option>
            </select>
          </Field>
          <Field label="Exact Date">
            <input type="date" value={purchaseFilters.date} onChange={(event) => setPurchaseFilters({ ...purchaseFilters, date: event.target.value })} />
          </Field>
          <label className="check-field report-check-field">
            <input checked={clubPurchaseItems} type="checkbox" onChange={(event) => setClubPurchaseItems(event.target.checked)} />
            <span>Club Items</span>
          </label>
          <button className="secondary-button" onClick={() => setPurchaseFilters({ supplier: "", product: "", status: "ACTIVE", paymentType: "", date: "" })}>Clear Purchase Filters</button>
        </>
      )}
      <button className="secondary-button" onClick={refreshReports}>Refresh</button>
    </div>
  );
  if (currentReport) {
    const rows = currentReport.rows || [];
    const handlePurchaseReportPrintOption = () => {
      if (selectedReport !== "purchaseHistory") return true;
      setPurchasePrintNarration(window.confirm("Print narration/details also?"));
      return true;
    };
    const renderPurchaseHistoryRows = () => {
      const renderedRows = [];
      rows.forEach((row, index) => {
        const date = toDateKey(row.purchase_date);
        const nextDate = rows[index + 1] ? toDateKey(rows[index + 1].purchase_date) : "";
        renderedRows.push(currentReport.render(row, index));
        if (date !== nextDate) {
          const total = purchaseDateTotals.get(date) || { net: 0, gross: 0 };
          renderedRows.push(
            <tr className="date-total-row" key={`date-total-${date}`}>
              <td colSpan="6">Net Purchase Total for {date}</td>
              <td>{money(total.gross)}</td>
              <td colSpan="2" className="balance-cell">{money(total.net)}</td>
              <td colSpan="2">Cancelled purchases excluded</td>
            </tr>
          );
        }
      });
      return renderedRows;
    };
    return (
      <section className="settings-layout">
        <ModuleCard eyebrow="Report View" title={currentReport.title} subtitle="Single report workspace with filters, summary, print and export controls.">
          <div className="button-row">
            <button className="secondary-button" onClick={() => setSelectedReport("")}>Back to {currentCategory?.title || "Report List"}</button>
            <button className="secondary-button" onClick={() => { setSelectedReport(""); setSelectedCategory(""); }}>Back to Report Center</button>
          </div>
          {renderFilters()}
        </ModuleCard>
        <ModuleCard eyebrow={currentCategory?.title || "Reports"} title={currentReport.title} subtitle={`${rows.length} row${rows.length === 1 ? "" : "s"} found.`}>
          <PrintableReport beforePdfExport={handlePurchaseReportPrintOption} beforePrint={handlePurchaseReportPrintOption} title={currentReport.title}>
            <div className="purchase-summary-grid supplier-payment-preview">
              {(currentReport.summary?.(rows) || []).map(([label, value, featured]) => <SummaryMetric featured={featured} key={label} label={label} value={value} />)}
            </div>
            <DataTable headers={currentReport.headers}>
              {selectedReport === "purchaseHistory" ? renderPurchaseHistoryRows() : rows.map((row, index) => currentReport.render(row, index))}
            </DataTable>
            {selectedReport === "purchaseHistory" && purchasePrintNarration && (
              <section className="purchase-print-narration">
                <h3>Purchase Item Narration</h3>
                {rows.map((row) => (
                  <article key={`narration-${row.display_key}`}>
                    <strong>{toDateKey(row.purchase_date)} - {row.supplier_name}</strong>
                    <pre>{row.item_narration}</pre>
                  </article>
                ))}
              </section>
            )}
            {rows.length === 0 && <div className="cart-empty">No records found for the selected filters.</div>}
          </PrintableReport>
        </ModuleCard>
      </section>
    );
  }
  if (currentCategory) {
    return (
      <section className="settings-layout">
        <ModuleCard eyebrow="Report Category" title={currentCategory.title} subtitle={currentCategory.description}>
          <div className="button-row">
            <button className="secondary-button" onClick={() => setSelectedCategory("")}>Back to Report Center</button>
          </div>
        </ModuleCard>
        <section className="report-center-grid">
          {currentCategory.reports.map((reportId) => {
            const report = reports[reportId];
            if (!report) return null;
            return (
              <button className="report-menu-card" key={reportId} onClick={() => { setSearch(""); setSelectedReport(reportId); }}>
                <Icon name={currentCategory.icon} size={22} />
                <strong>{report.title}</strong>
                <span>Open report workspace</span>
              </button>
            );
          })}
        </section>
      </section>
    );
  }
  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Report Center" title="Business Report Center" subtitle="Choose a report category first. Each report opens in its own focused workspace.">
        <div className="purchase-summary-grid supplier-payment-preview">
          <SummaryMetric label="Categories" value={categories.length} featured />
          <SummaryMetric label="Available Reports" value={Object.keys(reports).length} />
          <SummaryMetric label="Current Range" value={range === "custom" ? "Custom" : range} />
        </div>
      </ModuleCard>
      <section className="report-center-grid">
        {categories.map((category) => (
          <button className="report-category-card" key={category.id} onClick={() => setSelectedCategory(category.id)}>
            <span className="report-category-icon"><Icon name={category.icon} size={24} /></span>
            <strong>{category.title}</strong>
            <span>{category.description}</span>
            <em>{category.reports.length} reports</em>
          </button>
        ))}
      </section>
    </section>
  );
}

function SaleReturnModule({ onReload, returns, salesHistory, user }) {
  const [invoiceId, setInvoiceId] = useState("");
  const [returnOptions, setReturnOptions] = useState({ sale: null, items: [] });
  const [returnDate, setReturnDate] = useState(toDateKey(new Date()));
  const [refundType, setRefundType] = useState("CASH_REFUND");
  const [returnReason, setReturnReason] = useState("");
  const [quantities, setQuantities] = useState({});
  const activeInvoices = salesHistory.filter((sale) => sale.sale_status !== "CANCELLED");

  const loadReturnOptions = async (saleId) => {
    setInvoiceId(saleId);
    setQuantities({});
    if (!saleId) {
      setReturnOptions({ sale: null, items: [] });
      return;
    }
    const response = await axios.get(`${API_URL}/sale-returns/options/${saleId}`);
    setReturnOptions(response.data);
  };

  const selectedItems = returnOptions.items
    .map((item) => ({ ...item, return_quantity: Number(quantities[item.sale_item_id] || 0) }))
    .filter((item) => item.return_quantity > 0);
  const totalReturnValue = selectedItems.reduce((sum, item) => (
    sum + (Number(item.net_amount || 0) / Number(item.sold_quantity || 1)) * Number(item.return_quantity || 0)
  ), 0);

  const saveReturn = async () => {
    try {
      await axios.post(`${API_URL}/sale-returns`, {
        sale_id: Number(invoiceId),
        customer_name: returnOptions.sale?.customer_name,
        customer_mobile: returnOptions.sale?.customer_mobile,
        return_date: returnDate,
        refund_type: refundType,
        return_reason: returnReason,
        branch_id: user.branch_id,
        created_by: user.id,
        items: selectedItems.map((item) => ({
          sale_item_id: item.sale_item_id,
          return_quantity: item.return_quantity,
        })),
      });
      setInvoiceId("");
      setReturnOptions({ sale: null, items: [] });
      setReturnReason("");
      setQuantities({});
      await onReload();
      alert("Sale return saved and inventory restored");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save sale return"));
    }
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Sale Return / Refund" title="Return Entry" subtitle="Create a separate return record without editing the original invoice.">
        <div className="form-grid supplier-form-grid">
          <Field label="Select Invoice">
            <select value={invoiceId} onChange={(event) => loadReturnOptions(event.target.value)}>
              <option value="">Select invoice</option>
              {activeInvoices.map((sale) => <option key={sale.id} value={sale.id}>{sale.invoice_no || `Invoice #${sale.id}`} - {sale.customer_name || "Walk-in"} - {currency.format(Number(sale.amount || 0))}</option>)}
            </select>
          </Field>
          <Field label="Customer"><input readOnly value={returnOptions.sale?.customer_name || ""} /></Field>
          <Field label="Return Date"><input type="date" value={returnDate} onChange={(event) => setReturnDate(event.target.value)} /></Field>
          <Field label="Refund Option">
            <select value={refundType} onChange={(event) => setRefundType(event.target.value)}>
              <option value="CASH_REFUND">Cash Refund</option>
              <option value="UPI_REFUND">UPI Refund</option>
              <option value="CREDIT_NOTE">Credit Note</option>
              <option value="FUTURE_ADJUSTMENT">Adjustment Against Future Sale</option>
            </select>
          </Field>
          <Field label="Return Reason"><textarea value={returnReason} onChange={(event) => setReturnReason(event.target.value)} /></Field>
        </div>
        <DataTable headers={["Product", "Sold", "Already Returned", "Returnable", "Return Quantity", "Rate", "Return Value"]}>
          {returnOptions.items.map((item) => {
            const quantity = Number(quantities[item.sale_item_id] || 0);
            const value = (Number(item.net_amount || 0) / Number(item.sold_quantity || 1)) * quantity;
            return (
              <tr key={item.sale_item_id}>
                <td className="primary-cell">{item.product_name}<small className="cell-note">{item.unit}</small></td>
                <td>{Number(item.sold_quantity || 0).toLocaleString("en-IN")}</td>
                <td>{Number(item.returned_quantity || 0).toLocaleString("en-IN")}</td>
                <td>{Number(item.returnable_quantity || 0).toLocaleString("en-IN")}</td>
                <td><input className="table-input" min="0" max={Number(item.returnable_quantity || 0)} step="0.001" type="number" value={quantities[item.sale_item_id] || ""} onChange={(event) => setQuantities({ ...quantities, [item.sale_item_id]: event.target.value })} /></td>
                <td>{currency.format(Number(item.selling_rate || 0))}</td>
                <td>{currency.format(value)}</td>
              </tr>
            );
          })}
        </DataTable>
        <div className="purchase-summary-grid supplier-payment-preview">
          <SummaryMetric label="Selected Items" value={selectedItems.length} />
          <SummaryMetric label="Return Value" value={currency.format(totalReturnValue)} featured />
          <SummaryMetric label="Refund Mode" value={refundType.replaceAll("_", " ")} />
        </div>
        <button className="primary-button" onClick={saveReturn}>Save Return / Refund</button>
      </ModuleCard>
      <ModuleCard eyebrow="Return History" title="Sale Return History" subtitle="Returned goods, refund modes and reasons remain separate from original invoices.">
        <DataTable headers={["Return No", "Date", "Invoice", "Customer", "Refund", "Value", "Reason", "Items"]}>
          {returns.map((entry) => (
            <tr key={entry.id}>
              <td><span className="batch-id">{entry.return_no}</span></td>
              <td>{toDateKey(entry.return_date)}</td>
              <td>{entry.invoice_no}</td>
              <td className="primary-cell">{entry.customer_name || "Walk-in"}</td>
              <td><span className="tag">{entry.refund_type}</span></td>
              <td>{currency.format(Number(entry.total_return_amount || 0))}</td>
              <td>{entry.return_reason}</td>
              <td>{(entry.items || []).map((item) => `${item.product_name} x ${item.return_quantity}`).join(", ")}</td>
            </tr>
          ))}
        </DataTable>
      </ModuleCard>
    </section>
  );
}

function WasteManagementModule({ entries, inventory, onReload, products, user }) {
  const [draft, setDraft] = useState({
    product_id: "",
    quantity: "",
    waste_type: "DAAGI",
    waste_date: toDateKey(new Date()),
    remarks: "",
  });
  const stockByProduct = inventory.reduce((stock, item) => {
    stock.set(Number(item.product_id), (stock.get(Number(item.product_id)) || 0) + Number(item.remaining_qty || 0));
    return stock;
  }, new Map());
  const mostWasted = [...entries].reduce((map, entry) => {
    const current = map.get(entry.product_name) || { product_name: entry.product_name, quantity: 0, cost: 0 };
    current.quantity += Number(entry.quantity || 0);
    current.cost += Number(entry.cost_amount || 0);
    map.set(entry.product_name, current);
    return map;
  }, new Map());
  const mostWastedProducts = [...mostWasted.values()].sort((left, right) => right.quantity - left.quantity).slice(0, 5);
  const saveWaste = async () => {
    try {
      await axios.post(`${API_URL}/waste-entries`, {
        ...draft,
        product_id: Number(draft.product_id),
        quantity: Number(draft.quantity || 0),
        branch_id: user.branch_id,
        created_by: user.id,
      });
      setDraft({ product_id: "", quantity: "", waste_type: "DAAGI", waste_date: toDateKey(new Date()), remarks: "" });
      await onReload();
      alert("Waste entry saved and stock reduced");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save waste entry"));
    }
  };
  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Waste Management" title="Waste Entry" subtitle="Record Daagi, sampling, personal use and other fruit waste with automatic FIFO stock reduction.">
        <div className="form-grid supplier-form-grid">
          <Field label="Product">
            <select value={draft.product_id} onChange={(event) => setDraft({ ...draft, product_id: event.target.value })}>
              <option value="">Select product</option>
              {products.filter((product) => product.active !== false).map((product) => <option key={product.id} value={product.id}>{product.product_name} - Stock {stockByProduct.get(Number(product.id)) || 0}</option>)}
            </select>
          </Field>
          <Field label="Quantity"><input min="0" step="0.001" type="number" value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: event.target.value })} /></Field>
          <Field label="Waste Type">
            <select value={draft.waste_type} onChange={(event) => setDraft({ ...draft, waste_type: event.target.value })}>
              <option value="DAAGI">Daagi</option>
              <option value="SAMPLING">Sampling</option>
              <option value="PERSONAL_USE">Personal Use</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
          <Field label="Date"><input type="date" value={draft.waste_date} onChange={(event) => setDraft({ ...draft, waste_date: event.target.value })} /></Field>
          <Field label="Remarks"><textarea value={draft.remarks} onChange={(event) => setDraft({ ...draft, remarks: event.target.value })} /></Field>
        </div>
        <button className="primary-button" onClick={saveWaste}>Save Waste Entry</button>
      </ModuleCard>
      <ModuleCard eyebrow="Business Intelligence" title="Most Wasted Products" subtitle="Highlights products causing the highest waste quantity.">
        <div className="top-product-list">
          {mostWastedProducts.length ? mostWastedProducts.map((item) => (
            <article className="top-product-row" key={item.product_name}>
              <div><strong>{item.product_name}</strong><span>{item.quantity.toLocaleString("en-IN")} quantity wasted</span></div>
              <strong>{currency.format(item.cost)}</strong>
            </article>
          )) : <div className="empty-inline">No waste entries yet.</div>}
        </div>
      </ModuleCard>
      <ModuleCard eyebrow="Waste History" title="Waste Register" subtitle="Waste quantity and FIFO cost are stored for daily and monthly reporting.">
        <DataTable headers={["Date", "Product", "Type", "Quantity", "Cost", "Remarks"]}>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{toDateKey(entry.waste_date)}</td>
              <td className="primary-cell">{entry.product_name}<small className="cell-note">{entry.unit}</small></td>
              <td><span className="tag">{entry.waste_type}</span></td>
              <td>{Number(entry.quantity || 0).toLocaleString("en-IN")}</td>
              <td>{currency.format(Number(entry.cost_amount || 0))}</td>
              <td>{entry.remarks || "-"}</td>
            </tr>
          ))}
        </DataTable>
      </ModuleCard>
    </section>
  );
}

function ExpensesModule({ expenses, onReload, user }) {
  const emptyExpense = {
    expense_date: toDateKey(new Date()),
    category: "",
    amount: "",
    payment_mode: "CASH",
    reference_number: "",
    vendor_name: "",
    remarks: "",
    active: true,
  };
  const [draft, setDraft] = useState(emptyExpense);
  const [editingId, setEditingId] = useState(null);
  const totalActiveExpenses = expenses
    .filter((expense) => expense.active !== false)
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);

  const saveExpense = async () => {
    try {
      const payload = {
        ...draft,
        amount: Number(draft.amount || 0),
        branch_id: user.branch_id,
        created_by: user.id,
      };
      if (editingId) await axios.put(`${API_URL}/expenses/${editingId}`, payload);
      else await axios.post(`${API_URL}/expenses`, payload);
      setDraft(emptyExpense);
      setEditingId(null);
      await onReload();
      alert(editingId ? "Expense updated" : "Expense saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save expense"));
    }
  };
  const editExpense = (expense) => {
    setEditingId(expense.id);
    setDraft({
      expense_date: toDateKey(expense.expense_date),
      category: expense.category || "",
      amount: expense.amount || "",
      payment_mode: expense.payment_mode || "CASH",
      reference_number: expense.reference_number || "",
      vendor_name: expense.vendor_name || "",
      remarks: expense.remarks || "",
      active: expense.active !== false,
    });
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Operating Costs" title="Expenses" subtitle="Record and manage daily operating expenses.">
        <div className="purchase-summary-grid supplier-payment-preview">
          <SummaryMetric label="Active Expense Total" value={currency.format(totalActiveExpenses)} featured />
          <SummaryMetric label="Expense Entries" value={expenses.length} />
        </div>
        <div className="form-grid supplier-form-grid">
          <Field label="Expense Date"><input type="date" value={draft.expense_date} onChange={(event) => setDraft({ ...draft, expense_date: event.target.value })} /></Field>
          <Field label="Category"><input value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} /></Field>
          <Field label="Amount"><input min="0" step="0.01" type="number" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} /></Field>
          <Field label="Payment Mode">
            <select value={draft.payment_mode} onChange={(event) => setDraft({ ...draft, payment_mode: event.target.value })}>
              {supplierPaymentModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Reference Number"><input value={draft.reference_number} onChange={(event) => setDraft({ ...draft, reference_number: event.target.value })} /></Field>
          <Field label="Vendor Name"><input value={draft.vendor_name} onChange={(event) => setDraft({ ...draft, vendor_name: event.target.value })} /></Field>
          <label className="check-field"><input checked={draft.active} type="checkbox" onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>Active</span></label>
          <Field label="Remarks"><textarea value={draft.remarks} onChange={(event) => setDraft({ ...draft, remarks: event.target.value })} /></Field>
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={saveExpense}>{editingId ? "Update Expense" : "Save Expense"}</button>
          {editingId && <button className="secondary-button" onClick={() => { setEditingId(null); setDraft(emptyExpense); }}>Cancel Edit</button>}
        </div>
      </ModuleCard>
      <ModuleCard eyebrow="Expense Register" title="Recent Expenses" subtitle="Expense rows remain available for reporting and review.">
        <DataTable headers={["Date", "Category", "Vendor", "Mode", "Amount", "Status", "Reference", "Remarks", ""]}>
          {expenses.map((expense) => (
            <tr key={expense.id}>
              <td>{expense.expense_date}</td>
              <td className="primary-cell">{expense.category}</td>
              <td>{expense.vendor_name || "-"}</td>
              <td><span className="tag">{expense.payment_mode}</span></td>
              <td>{currency.format(Number(expense.amount || 0))}</td>
              <td><span className={expense.active !== false ? "stock-ok" : "stock-low"}>{expense.active !== false ? "Active" : "Inactive"}</span></td>
              <td>{expense.reference_number || "-"}</td>
              <td>{expense.remarks || "-"}</td>
              <td><button className="table-action" onClick={() => editExpense(expense)}>Edit</button></td>
            </tr>
          ))}
        </DataTable>
      </ModuleCard>
    </section>
  );
}

function AccountsModule({ accounts, accountLedger, accountOutstanding, accountPayments, ledgerFocusKey, onLedgerLoad, onPaymentsLoad, onReload, user }) {
  const emptyAccount = {
    account_name: "",
    account_type: "CUSTOMER",
    firm_name: "",
    mobile_number: "",
    alternate_number: "",
    address: "",
    city: "",
    gst_number: "",
    bank_name: "",
    account_number: "",
    ifsc_code: "",
    upi_id: "",
    opening_balance: "",
    active: true,
    notes: "",
  };
  const [tab, setTab] = useState(() => (["Owner", "Admin", "Purchase Manager"].includes(user.role) ? "master" : "payments"));
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(emptyAccount);
  const [editingKey, setEditingKey] = useState("");
  const [ledgerMode, setLedgerMode] = useState("ANY");
  const [ledgerAccountKey, setLedgerAccountKey] = useState("");
  const [ledgerDateRange, setLedgerDateRange] = useState({ date_from: "", date_to: "" });
  const [payment, setPayment] = useState({
    payment_action: user.role === "Purchase Manager" ? "PAY_SUPPLIER" : "RECEIVE_CUSTOMER",
    account_key: "",
    payment_date: toDateKey(new Date()),
    amount: "",
    rebate_amount: "",
    payment_mode: "CASH",
    reference_number: "",
    remarks: "",
  });
  const [editingPaymentKey, setEditingPaymentKey] = useState("");
  const [paymentAudit, setPaymentAudit] = useState(null);
  const [receiptPayment, setReceiptPayment] = useState(null);
  const canManageAllAccounts = ["Owner", "Admin"].includes(user.role);
  const canUseSupplierPayments = canManageAllAccounts || user.role === "Purchase Manager";
  const canUseCustomerPayments = canManageAllAccounts || user.role === "Cashier";
  const accountTabs = [
    ...(canManageAllAccounts || user.role === "Purchase Manager" ? [["master", "Account Master"]] : []),
    ["ledger", "Ledger"],
    ["payments", "Payments"],
    ...(canManageAllAccounts || user.role === "Purchase Manager" ? [["outstanding", "Outstanding"]] : []),
  ];
  const paymentActionOptions = accountPaymentActions.filter(([value]) =>
    value === "RECEIVE_CUSTOMER" ? canUseCustomerPayments : canUseSupplierPayments
  );
  const filteredAccounts = accounts.filter((account) =>
    account.account_name.toLowerCase().includes(search.toLowerCase()) ||
    String(account.mobile_number || "").includes(search)
  );
  const ledgerAccounts = accounts.filter((account) =>
    ledgerMode === "ANY" ||
    (ledgerMode === "CUSTOMER" && account.account_type === "CUSTOMER") ||
    (ledgerMode === "SUPPLIER" && ["SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(account.account_type))
  );
  const paymentAccounts = accounts.filter((account) =>
    payment.payment_action === "RECEIVE_CUSTOMER"
      ? account.account_type === "CUSTOMER"
      : ["SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(account.account_type)
  );
  const selectedPaymentAccount = accounts.find((account) => account.account_key === payment.account_key);
  const isSupplierPayment = payment.payment_action !== "RECEIVE_CUSTOMER";
  const paymentAmount = Number(payment.amount || 0);
  const rebateAmount = isSupplierPayment ? Number(payment.rebate_amount || 0) : 0;
  const outstandingBefore = selectedPaymentAccount
    ? Number(isSupplierPayment ? selectedPaymentAccount.payable_balance : selectedPaymentAccount.receivable_balance)
    : 0;
  const outstandingAfter = Math.max(0, roundUi(outstandingBefore - paymentAmount - rebateAmount));
  const selectedCustomerSummary = selectedPaymentAccount && selectedPaymentAccount.account_type === "CUSTOMER"
    ? {
      totalSales: Number(selectedPaymentAccount.total_sales || 0),
      totalPaid: Number(selectedPaymentAccount.total_paid || 0),
      outstanding: Number(selectedPaymentAccount.receivable_balance || 0),
    }
    : null;
  const selectedSupplierSummary = selectedPaymentAccount && isSupplierPayment
    ? {
      totalPurchases: Number(selectedPaymentAccount.total_purchases || 0),
      totalPaid: Number(selectedPaymentAccount.total_paid || 0),
      totalRebate: Number(selectedPaymentAccount.total_rebate_received || 0),
      outstanding: Number(selectedPaymentAccount.payable_balance || 0),
    }
    : null;
  const printableLedgerRows = (accountLedger.ledger || []).filter((row) =>
    (!ledgerDateRange.date_from || toDateKey(row.date) >= ledgerDateRange.date_from) &&
    (!ledgerDateRange.date_to || toDateKey(row.date) <= ledgerDateRange.date_to)
  );

  const saveAccount = async () => {
    try {
      const payload = { ...draft, opening_balance: Number(draft.opening_balance || 0) };
      const normalizedName = payload.account_name.trim().toLowerCase();
      const normalizedMobile = String(payload.mobile_number || "");
      const normalizedFirm = String(payload.firm_name || "").trim().toLowerCase();
      const duplicate = accounts.find((account) => {
        if (account.account_key === editingKey) return false;
        if (payload.account_type === "CUSTOMER") {
          return account.account_type === "CUSTOMER" &&
            account.account_name.trim().toLowerCase() === normalizedName &&
            String(account.mobile_number || "") === normalizedMobile;
        }
        if (["SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(payload.account_type)) {
          return ["SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(account.account_type) &&
            (account.account_name.trim().toLowerCase() === normalizedName ||
              (normalizedFirm && String(account.firm_name || "").trim().toLowerCase() === normalizedFirm));
        }
        return false;
      });
      if (duplicate) {
        alert(payload.account_type === "CUSTOMER" ? "This customer already exists." : "This supplier already exists.");
        return;
      }
      if (editingKey) await axios.put(`${API_URL}/accounts/${editingKey}`, payload);
      else await axios.post(`${API_URL}/accounts`, payload);
      setDraft(emptyAccount);
      setEditingKey("");
      await onReload();
      alert(editingKey ? "Account updated" : "Account saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save account"));
    }
  };
  const editAccount = (account) => {
    setEditingKey(account.account_key);
    setDraft({
      account_name: account.account_name || "",
      account_type: account.account_type || "OTHER",
      firm_name: account.firm_name || "",
      mobile_number: account.mobile_number || "",
      alternate_number: account.alternate_number || "",
      address: account.address || "",
      city: account.city || "",
      gst_number: account.gst_number || "",
      bank_name: account.bank_name || "",
      account_number: account.account_number || "",
      ifsc_code: account.ifsc_code || "",
      upi_id: account.upi_id || "",
      opening_balance: account.opening_balance || "",
      active: account.active !== false,
      notes: account.notes || "",
    });
    setTab("master");
  };
  const loadLedger = async (accountKey) => {
    setLedgerAccountKey(accountKey);
    await onLedgerLoad(accountKey);
  };

  useEffect(() => {
    if (!ledgerFocusKey) return;
    setTab("ledger");
    setLedgerMode(ledgerFocusKey.startsWith("SUPPLIER-") ? "SUPPLIER" : "ANY");
    setLedgerAccountKey(ledgerFocusKey);
  }, [ledgerFocusKey]);
  const savePayment = async () => {
    try {
      const payload = {
        ...payment,
        amount: Number(payment.amount || 0),
        payment_amount: Number(payment.amount || 0),
        rebate_amount: isSupplierPayment ? Number(payment.rebate_amount || 0) : 0,
        branch_id: user.branch_id,
        created_by: user.id,
        edited_by: user.id,
      };
      let response;
      if (editingPaymentKey) {
        const reason = window.prompt("Enter reason for editing this payment");
        if (!reason) return;
        response = await axios.put(`${API_URL}/accounts/payments/${editingPaymentKey}`, { ...payload, reason });
      } else {
        response = await axios.post(`${API_URL}/accounts/payments`, payload);
      }
      setReceiptPayment({
        ...response.data,
        payment_key: editingPaymentKey || `${isSupplierPayment ? "SUPPLIER" : "CUSTOMER"}-${response.data.id}`,
        payment_source: isSupplierPayment ? "SUPPLIER" : "CUSTOMER",
        account_key: payment.account_key,
        account_name: selectedPaymentAccount?.account_name,
        account_type: selectedPaymentAccount?.account_type,
        outstanding_before: outstandingBefore,
        outstanding_after: outstandingAfter,
      });
      setEditingPaymentKey("");
      setPayment((current) => ({ ...current, amount: "", rebate_amount: "", reference_number: "", remarks: "" }));
      await onReload();
      alert(editingPaymentKey ? "Payment updated" : "Payment saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save payment"));
    }
  };
  const editPayment = (row) => {
    setEditingPaymentKey(row.payment_key);
    setPayment({
      payment_action: row.payment_source === "CUSTOMER" ? "RECEIVE_CUSTOMER" : "PAY_SUPPLIER",
      account_key: row.account_key,
      payment_date: toDateKey(row.payment_date),
      amount: row.payment_amount || "",
      rebate_amount: row.rebate_amount || "",
      payment_mode: row.payment_mode || "CASH",
      reference_number: row.reference_number || "",
      remarks: row.remarks || "",
    });
    setTab("payments");
  };
  const cancelPayment = async (row) => {
    const reason = window.prompt(`Enter cancellation reason for ${row.account_name} payment`);
    if (!reason) return;
    try {
      await axios.post(`${API_URL}/accounts/payments/${row.payment_key}/cancel`, { reason, cancelled_by: user.id });
      await onReload();
      alert("Payment cancelled");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to cancel payment"));
    }
  };
  const viewPaymentHistory = async (row) => {
    try {
      const response = await axios.get(`${API_URL}/accounts/payments/${row.payment_key}/audit`);
      setPaymentAudit({ payment: row, rows: response.data });
    } catch (error) {
      alert(getErrorMessage(error, "Unable to load payment history"));
    }
  };
  const refreshPaymentsForSelection = async (accountKey) => {
    setPayment({ ...payment, account_key: accountKey });
    await onPaymentsLoad(accountKey);
  };

  return (
    <section className="settings-layout">
      <section className="settings-banner">
        <div>
          <span className="eyebrow">Unified Accounts</span>
          <h2>Accounts</h2>
          <p>Customers, suppliers, vendors, staff and other account ledgers in one workspace.</p>
        </div>
      </section>
      <div className="account-tabs">
        {accountTabs.map(([value, label]) => (
          <button className={tab === value ? "account-tab account-tab-active" : "account-tab"} key={value} onClick={() => setTab(value)}>{label}</button>
        ))}
      </div>

      {tab === "master" && (
        <>
          <ModuleCard eyebrow="Account Master" title="Create / Edit Account" subtitle="Use account type to control purchase, POS, ledger and payment behavior.">
            <div className="form-grid supplier-form-grid">
              <Field label="Account Type">
                <select value={draft.account_type} onChange={(event) => setDraft({ ...draft, account_type: event.target.value })}>
                  {accountTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Field>
              <Field label="Account Name"><input value={draft.account_name} onChange={(event) => setDraft({ ...draft, account_name: event.target.value })} /></Field>
              <Field label="Firm Name"><input value={draft.firm_name} onChange={(event) => setDraft({ ...draft, firm_name: event.target.value })} /></Field>
              <Field label="Mobile"><input value={draft.mobile_number} onChange={(event) => setDraft({ ...draft, mobile_number: event.target.value.replace(/\D/g, "") })} /></Field>
              <Field label="Alternate Number"><input value={draft.alternate_number} onChange={(event) => setDraft({ ...draft, alternate_number: event.target.value.replace(/\D/g, "") })} /></Field>
              <Field label="City"><input value={draft.city} onChange={(event) => setDraft({ ...draft, city: event.target.value })} /></Field>
              <Field label="GST Number"><input value={draft.gst_number} onChange={(event) => setDraft({ ...draft, gst_number: event.target.value })} /></Field>
              <Field label="Bank Name"><input value={draft.bank_name} onChange={(event) => setDraft({ ...draft, bank_name: event.target.value })} /></Field>
              <Field label="Account Number"><input value={draft.account_number} onChange={(event) => setDraft({ ...draft, account_number: event.target.value })} /></Field>
              <Field label="IFSC"><input value={draft.ifsc_code} onChange={(event) => setDraft({ ...draft, ifsc_code: event.target.value })} /></Field>
              <Field label="UPI ID"><input value={draft.upi_id} onChange={(event) => setDraft({ ...draft, upi_id: event.target.value })} /></Field>
              <Field label="Opening Balance"><input min="0" step="0.01" type="number" value={draft.opening_balance} onChange={(event) => setDraft({ ...draft, opening_balance: event.target.value })} /></Field>
              <label className="check-field"><input checked={draft.active} type="checkbox" onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>Active</span></label>
              <Field label="Address"><textarea value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} /></Field>
              <Field label="Notes"><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></Field>
            </div>
            <div className="button-row">
              <button className="primary-button" onClick={saveAccount}>{editingKey ? "Update Account" : "Add Account"}</button>
              {editingKey && <button className="secondary-button" onClick={() => { setDraft(emptyAccount); setEditingKey(""); }}>Cancel Edit</button>}
            </div>
          </ModuleCard>
          <ModuleCard eyebrow="Account List" title="All Accounts" subtitle="Inactive accounts remain in history and can be reactivated.">
            <div className="ledger-toolbar">
              <Field label="Search"><input placeholder="Search account or mobile" value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
              <button className="secondary-button" onClick={onReload}>Refresh</button>
            </div>
            <DataTable headers={["Account", "Type", "Mobile", "Opening", "Receivable", "Payable", "Status", ""]}>
              {filteredAccounts.map((account) => (
                <tr key={account.account_key}>
                  <td className="primary-cell">{account.account_name}<small className="cell-note">{account.firm_name || account.city || account.address || "-"}</small></td>
                  <td><span className="tag">{account.account_type}</span></td>
                  <td>{account.mobile_number || "-"}</td>
                  <td>{currency.format(Number(account.opening_balance || 0))}</td>
                  <td>{currency.format(Number(account.receivable_balance || 0))}</td>
                  <td>{currency.format(Number(account.payable_balance || 0))}</td>
                  <td><span className={account.active !== false ? "stock-ok" : "stock-low"}>{account.active !== false ? "Active" : "Inactive"}</span></td>
                  <td><button className="table-action" onClick={() => editAccount(account)}>Edit</button></td>
                </tr>
              ))}
            </DataTable>
          </ModuleCard>
        </>
      )}

      {tab === "ledger" && (
        <ModuleCard eyebrow="Ledger" title="Account Ledger" subtitle="Select customer, supplier or any account to review debit, credit and balance.">
          <div className="ledger-toolbar">
            <Field label="Ledger Type">
              <select value={ledgerMode} onChange={(event) => setLedgerMode(event.target.value)}>
                {ledgerModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Account">
              <select value={ledgerAccountKey} onChange={(event) => loadLedger(event.target.value)}>
                <option value="">Select account</option>
                {ledgerAccounts.map((account) => <option key={account.account_key} value={account.account_key}>{account.account_name} - {account.account_type}</option>)}
              </select>
            </Field>
            <button className="secondary-button" onClick={() => loadLedger(ledgerAccountKey)}>Refresh Ledger</button>
          </div>
          <div className="ledger-toolbar">
            <Field label="Statement From"><input type="date" value={ledgerDateRange.date_from} onChange={(event) => setLedgerDateRange({ ...ledgerDateRange, date_from: event.target.value })} /></Field>
            <Field label="Statement To"><input type="date" value={ledgerDateRange.date_to} onChange={(event) => setLedgerDateRange({ ...ledgerDateRange, date_to: event.target.value })} /></Field>
            <button className="secondary-button" onClick={() => window.print()}><Icon name="print" /> Print Statement</button>
            <button className="secondary-button" onClick={() => window.print()}>PDF Export</button>
          </div>
          <div className="print-area report-paper">
            <header className="report-print-header">
              <BrandLogo invoice />
              <div>
                <strong>{accountLedger.account?.account_name || accountLedger.account?.supplier_name || accountLedger.account?.customer_name || "Account Ledger"}</strong>
                <span>Ledger Statement</span>
              </div>
            </header>
            <div className="purchase-summary-grid supplier-payment-preview">
              <SummaryMetric label="Opening Balance" value={currency.format(Number(printableLedgerRows[0]?.balance || 0) - Number(printableLedgerRows[0]?.debit || 0) + Number(printableLedgerRows[0]?.credit || 0))} />
              <SummaryMetric label="Closing Balance" value={currency.format(Number(printableLedgerRows.at(-1)?.balance || 0))} featured />
            </div>
            <DataTable headers={["Date", "Transaction Type", "Debit", "Credit", "Balance", "Remarks"]}>
              {printableLedgerRows.map((row, index) => (
                <tr key={`${row.date}-${row.transaction_type}-${index}`}>
                  <td>{row.date}</td>
                  <td><span className="tag">{row.transaction_type}</span></td>
                  <td>{currency.format(Number(row.debit || 0))}</td>
                  <td>{currency.format(Number(row.credit || 0))}</td>
                  <td className="balance-cell">{currency.format(Number(row.balance || 0))}</td>
                  <td>{row.remarks || "-"}</td>
                </tr>
              ))}
            </DataTable>
          </div>
        </ModuleCard>
      )}

      {tab === "payments" && (
        <ModuleCard eyebrow="Payments" title="Account Payments" subtitle="Receive customer payments, pay suppliers, or record supplier rebates.">
          <div className="purchase-summary-grid supplier-payment-preview">
            {selectedSupplierSummary ? (
              <>
                <SummaryMetric label="Total Purchase" value={currency.format(selectedSupplierSummary.totalPurchases)} />
                <SummaryMetric label="Total Paid" value={currency.format(selectedSupplierSummary.totalPaid)} />
                <SummaryMetric label="Total Rebate Received" value={currency.format(selectedSupplierSummary.totalRebate)} positive />
                <SummaryMetric label="Outstanding Payable" value={currency.format(selectedSupplierSummary.outstanding)} featured />
              </>
            ) : selectedCustomerSummary ? (
              <>
                <SummaryMetric label="Total Sales" value={currency.format(selectedCustomerSummary.totalSales)} />
                <SummaryMetric label="Total Received" value={currency.format(selectedCustomerSummary.totalPaid)} />
                <SummaryMetric label="Outstanding Receivable" value={currency.format(selectedCustomerSummary.outstanding)} featured />
                <SummaryMetric label="Account Type" value="Customer" />
              </>
            ) : (
              <>
                <SummaryMetric label="Selected Account" value="None" />
                <SummaryMetric label="Outstanding Before" value={currency.format(0)} />
                <SummaryMetric label="Payment Impact" value={currency.format(0)} />
                <SummaryMetric label="Outstanding After" value={currency.format(0)} featured />
              </>
            )}
          </div>
          <div className="form-grid">
            <Field label="Payment Action">
              <select value={payment.payment_action} onChange={(event) => setPayment({ ...payment, payment_action: event.target.value, account_key: "", rebate_amount: "" })}>
                {paymentActionOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Account">
              <select value={payment.account_key} onChange={(event) => refreshPaymentsForSelection(event.target.value)}>
                <option value="">Select account</option>
                {paymentAccounts.map((account) => <option key={account.account_key} value={account.account_key}>{account.account_name} - {account.account_type}</option>)}
              </select>
            </Field>
            <Field label="Payment Date"><input type="date" value={payment.payment_date} onChange={(event) => setPayment({ ...payment, payment_date: event.target.value })} /></Field>
            <Field label={isSupplierPayment ? "Payment Amount" : "Payment Amount / Receipt"}><input min="0" step="0.01" type="number" value={payment.amount} onChange={(event) => setPayment({ ...payment, amount: event.target.value })} /></Field>
            {isSupplierPayment && <Field label="Rebate Received"><input min="0" step="0.01" type="number" value={payment.rebate_amount} onChange={(event) => setPayment({ ...payment, rebate_amount: event.target.value })} /></Field>}
            <Field label="Payment Mode">
              <select value={payment.payment_mode} onChange={(event) => setPayment({ ...payment, payment_mode: event.target.value })}>
                {supplierPaymentModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Reference Number"><input value={payment.reference_number} onChange={(event) => setPayment({ ...payment, reference_number: event.target.value })} /></Field>
            <Field label="Remarks"><textarea value={payment.remarks} onChange={(event) => setPayment({ ...payment, remarks: event.target.value })} /></Field>
          </div>
          <div className="purchase-summary-grid supplier-payment-preview">
            <SummaryMetric label={isSupplierPayment ? "Outstanding Payable Before" : "Outstanding Receivable Before"} value={currency.format(outstandingBefore)} />
            <SummaryMetric label="Payment Amount" value={currency.format(paymentAmount)} />
            {isSupplierPayment && <SummaryMetric label="Rebate Received" value={currency.format(rebateAmount)} positive />}
            <SummaryMetric label="Balance After Payment" value={currency.format(outstandingAfter)} featured />
          </div>
          <div className="button-row">
            <button className="primary-button" onClick={savePayment}>{editingPaymentKey ? "Update Payment" : "Save Payment"}</button>
            {editingPaymentKey && <button className="secondary-button" onClick={() => { setEditingPaymentKey(""); setPayment({ payment_action: "RECEIVE_CUSTOMER", account_key: "", payment_date: toDateKey(new Date()), amount: "", rebate_amount: "", payment_mode: "CASH", reference_number: "", remarks: "" }); }}>Cancel Edit</button>}
          </div>
          <div className="ledger-toolbar">
            <button className="secondary-button" onClick={() => onPaymentsLoad(payment.account_key)}>Refresh Payment History</button>
            <button className="secondary-button" onClick={() => onPaymentsLoad()}>Show All Payments</button>
          </div>
          <DataTable headers={["Date", "Party", "Type", "Payment", "Rebate", "Mode", "Status", "Reference", "Remarks", "Actions"]}>
            {(accountPayments || []).map((row) => (
              <tr key={row.payment_key}>
                <td>{toDateKey(row.payment_date)}</td>
                <td className="primary-cell">{row.account_name}</td>
                <td><span className="tag">{row.payment_source}</span></td>
                <td>{currency.format(Number(row.payment_amount || 0))}</td>
                <td>{Number(row.rebate_amount || 0) ? currency.format(Number(row.rebate_amount || 0)) : "-"}</td>
                <td><span className="tag">{row.payment_mode}</span></td>
                <td><span className={row.cancelled ? "stock-low" : "stock-ok"}>{row.cancelled ? "Cancelled" : "Active"}</span></td>
                <td>{row.reference_number || "-"}</td>
                <td>{row.cancellation_reason || row.edit_reason || row.remarks || "-"}</td>
                <td className="table-actions-row">
                  <button className="table-action" disabled={row.cancelled} onClick={() => editPayment(row)}>Edit</button>
                  <button className="remove-button" disabled={row.cancelled} onClick={() => cancelPayment(row)}>Cancel</button>
                  <button className="table-action" onClick={() => viewPaymentHistory(row)}>History</button>
                  <button className="table-action" onClick={() => setReceiptPayment(row)}>Print</button>
                </td>
              </tr>
            ))}
          </DataTable>
        </ModuleCard>
      )}

      {tab === "outstanding" && (
        <ModuleCard eyebrow="Outstanding" title="Receivable and Payable Summary" subtitle="Customer outstanding and supplier outstanding in one place.">
          <div className="purchase-summary-grid supplier-payment-preview">
            <SummaryMetric label="Total Receivable" value={currency.format(Number(accountOutstanding.totalReceivable || 0))} featured />
            <SummaryMetric label="Total Payable" value={currency.format(Number(accountOutstanding.totalPayable || 0))} featured />
            <SummaryMetric label="Customer Accounts" value={(accountOutstanding.customerOutstanding || []).length} />
            <SummaryMetric label="Supplier Accounts" value={(accountOutstanding.supplierOutstanding || []).length} />
          </div>
          <DataTable headers={["Account", "Type", "Receivable", "Payable", "Status"]}>
            {[...(accountOutstanding.customerOutstanding || []), ...(accountOutstanding.supplierOutstanding || [])].map((account) => (
              <tr key={account.account_key}>
                <td className="primary-cell">{account.account_name}</td>
                <td><span className="tag">{account.account_type}</span></td>
                <td>{currency.format(Number(account.receivable_balance || 0))}</td>
                <td>{currency.format(Number(account.payable_balance || 0))}</td>
                <td><span className={account.active !== false ? "stock-ok" : "stock-low"}>{account.active !== false ? "Active" : "Inactive"}</span></td>
              </tr>
            ))}
          </DataTable>
        </ModuleCard>
      )}
      {receiptPayment && <PaymentReceiptModal payment={receiptPayment} onClose={() => setReceiptPayment(null)} />}
      {paymentAudit && <PaymentAuditModal audit={paymentAudit} onClose={() => setPaymentAudit(null)} />}
    </section>
  );
}

function SettingsModule({ canManage, onReload, rules, settingsData, user }) {
  return (
    <section className="settings-layout">
      <section className="settings-banner">
        <div>
          <span className="eyebrow">System Controls</span>
          <h2>Settings</h2>
          <p>{canManage ? "Owner/Admin controls are active." : "Read-only access. Owner/Admin approval is required for changes."}</p>
        </div>
        <span className={canManage ? "stock-ok" : "stock-low"}>{canManage ? "Manager Access" : "Read Only"}</span>
      </section>
      <BusinessSettingsSection businessSettings={settingsData.businessSettings} canManage={canManage} key={settingsData.businessSettings?.updated_at || "business-settings"} onReload={onReload} user={user} />
      <PosSettingsSection canManage={canManage} key={settingsData.posSettings?.updated_at || "pos-settings"} onReload={onReload} posSettings={settingsData.posSettings} user={user} />
      <PaymentSettingsSection canManage={canManage} key={settingsData.paymentSettings?.updated_at || "payment-settings"} onReload={onReload} paymentSettings={settingsData.paymentSettings} user={user} />
      <MandiTaxSettings canManage={canManage} onReload={onReload} rules={rules.mandiTaxRules} user={user} />
      <RebateSettings canManage={canManage} onReload={onReload} rules={rules.rebateRules} user={user} />
      <SaleRateSettingsSection canManage={canManage} key={settingsData.saleRateSettings?.updated_at || "sale-rate-settings"} onReload={onReload} saleRateSettings={settingsData.saleRateSettings} user={user} />
      <DiscountSettings canManage={canManage} discountRules={settingsData.discountRules} onReload={onReload} user={user} />
      <PermissionSettings canManage={canManage} key={JSON.stringify(settingsData.roles || [])} onReload={onReload} roles={settingsData.roles} user={user} />
      <UserManagementSection canManage={canManage} key={JSON.stringify(settingsData.users || [])} onReload={onReload} roles={settingsData.roles} user={user} users={settingsData.users || []} />
      <UpdateCenterSection canManage={canManage} key={settingsData.updateCenter?.updated_at || "update-center"} onReload={onReload} updateCenter={settingsData.updateCenter} user={user} />
      <SyncSettingsSection canManage={canManage} key={settingsData.syncSettings?.updated_at || "sync-settings"} onReload={onReload} syncSettings={settingsData.syncSettings} user={user} />
      <BackupSettings backupSettings={settingsData.backupSettings} />
    </section>
  );
}

function BusinessSettingsSection({ businessSettings, canManage, onReload, user }) {
  const [draft, setDraft] = useState({ ...defaultBusinessSettings, ...businessSettings });
  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/business`, { ...draft, updated_by: user.id });
      await onReload();
      alert("Business settings updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update business settings"));
    }
  };

  return (
    <ModuleCard eyebrow="Business Settings" title="Business Identity" subtitle="Invoice and application identity details for the retail operation.">
      <div className="form-grid supplier-form-grid">
        <Field label="Business Name"><input disabled={!canManage} value={draft.business_name || ""} onChange={(event) => updateDraft("business_name", event.target.value)} /></Field>
        <Field label="Brand Name"><input disabled={!canManage} value={draft.brand_name || ""} onChange={(event) => updateDraft("brand_name", event.target.value)} /></Field>
        <Field label="Company Name"><input disabled={!canManage} value={draft.company_name || ""} onChange={(event) => updateDraft("company_name", event.target.value)} /></Field>
        <Field label="Phone Number"><input disabled={!canManage} value={draft.phone_number || ""} onChange={(event) => updateDraft("phone_number", event.target.value)} /></Field>
        <Field label="GST Number"><input disabled={!canManage} value={draft.gst_number || ""} onChange={(event) => updateDraft("gst_number", event.target.value)} /></Field>
        <Field label="Logo URL / Path"><input disabled={!canManage} value={draft.logo_url || ""} onChange={(event) => updateDraft("logo_url", event.target.value)} /></Field>
        <Field label="Compact Logo Text"><input disabled={!canManage} value={draft.compact_logo_text || ""} onChange={(event) => updateDraft("compact_logo_text", event.target.value)} /></Field>
        <Field label="Default Printer Type">
          <select disabled={!canManage} value={draft.default_printer_type || "THERMAL"} onChange={(event) => updateDraft("default_printer_type", event.target.value)}>
            <option value="THERMAL">POS / Thermal</option>
            <option value="A4">A4</option>
          </select>
        </Field>
        <Field label="Receipt Width">
          <select disabled={!canManage} value={draft.receipt_width || "80MM"} onChange={(event) => updateDraft("receipt_width", event.target.value)}>
            <option value="58MM">58mm</option>
            <option value="80MM">80mm</option>
          </select>
        </Field>
        <label className="check-field"><input checked={draft.auto_print_after_billing === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("auto_print_after_billing", event.target.checked)} /><span>Auto print after billing</span></label>
        <Field label="Address"><textarea disabled={!canManage} value={draft.address || ""} onChange={(event) => updateDraft("address", event.target.value)} /></Field>
        <Field label="Invoice Footer Text"><textarea disabled={!canManage} value={draft.invoice_footer_text || ""} onChange={(event) => updateDraft("invoice_footer_text", event.target.value)} /></Field>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={save}>Save Business Settings</button>
    </ModuleCard>
  );
}

function PosSettingsSection({ canManage, onReload, posSettings, user }) {
  const [draft, setDraft] = useState({ ...defaultPosSettings, ...posSettings });
  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/pos`, { ...draft, updated_by: user.id });
      await onReload();
      alert("POS settings updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update POS settings"));
    }
  };
  return (
    <ModuleCard eyebrow="POS Settings" title="Weighing Scale Integration" subtitle="Hardware integration foundation for USB, serial, Bluetooth and manual fallback billing.">
      <div className="form-grid supplier-form-grid">
        <label className="check-field"><input checked={draft.enable_weighing_scale === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("enable_weighing_scale", event.target.checked)} /><span>Enable weighing scale mode</span></label>
        <Field label="Connection Type">
          <select disabled={!canManage} value={draft.scale_connection_type || "MANUAL_FALLBACK"} onChange={(event) => updateDraft("scale_connection_type", event.target.value)}>
            <option value="USB">USB</option>
            <option value="SERIAL">Serial</option>
            <option value="BLUETOOTH">Bluetooth</option>
            <option value="MANUAL_FALLBACK">Manual Fallback</option>
          </select>
        </Field>
        <Field label="COM Port"><input disabled={!canManage} placeholder="Example: COM3" value={draft.scale_com_port || ""} onChange={(event) => updateDraft("scale_com_port", event.target.value)} /></Field>
        <Field label="Baud Rate"><input disabled={!canManage} min="1" type="number" value={draft.scale_baud_rate || 9600} onChange={(event) => updateDraft("scale_baud_rate", event.target.value)} /></Field>
        <label className="check-field"><input checked={draft.scale_auto_read === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("scale_auto_read", event.target.checked)} /><span>Auto-read weight when hardware support is available</span></label>
      </div>
      <p className="form-note">Browser-based hardware reading is prepared but not enabled until a supported local bridge or Web Serial workflow is connected. Manual quantity entry remains available.</p>
      <button className="primary-button" disabled={!canManage} onClick={save}>Save POS Settings</button>
    </ModuleCard>
  );
}

function PaymentSettingsSection({ canManage, onReload, paymentSettings, user }) {
  const [draft, setDraft] = useState({ ...defaultPaymentSettings, ...paymentSettings });
  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/payment`, { ...draft, updated_by: user.id });
      await onReload();
      alert("Payment settings updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update payment settings"));
    }
  };
  return (
    <ModuleCard eyebrow="Payment Settings" title="UPI QR on Invoice" subtitle="Database-backed UPI configuration used by POS invoices, receipts, print and WhatsApp workflows.">
      <div className="form-grid supplier-form-grid">
        <Field label="Business UPI ID"><input disabled={!canManage} placeholder="name@bank" value={draft.business_upi_id || ""} onChange={(event) => updateDraft("business_upi_id", event.target.value)} /></Field>
        <Field label="Payee Name"><input disabled={!canManage} value={draft.upi_payee_name || ""} onChange={(event) => updateDraft("upi_payee_name", event.target.value)} /></Field>
        <label className="check-field"><input checked={draft.enable_upi_qr_on_invoice === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("enable_upi_qr_on_invoice", event.target.checked)} /><span>Enable UPI QR on UPI invoices</span></label>
        <label className="check-field"><input checked={draft.show_upi_qr_on_all_bills === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("show_upi_qr_on_all_bills", event.target.checked)} /><span>Show UPI QR on all bills</span></label>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={save}>Save Payment Settings</button>
    </ModuleCard>
  );
}

function MandiTaxSettings({ canManage, onReload, rules, user }) {
  const [newRule, setNewRule] = useState({ origin_type: "", tax_percent: "", active: true });
  const addRule = async () => {
    try {
      await axios.post(`${API_URL}/settings/mandi-tax-rules`, { ...newRule, updated_by: user.id });
      setNewRule({ origin_type: "", tax_percent: "", active: true });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to add mandi tax rule"));
    }
  };
  return (
    <ModuleCard eyebrow="Mandi Tax Settings" title="Origin-Based Mandi Tax" subtitle="Database-backed tax percentages for local and imported fruit purchases.">
      <div className="form-grid settings-add-grid">
        <Field label="Origin Type"><input disabled={!canManage} placeholder="LOCAL or IMPORTED" value={newRule.origin_type} onChange={(event) => setNewRule({ ...newRule, origin_type: event.target.value.toUpperCase() })} /></Field>
        <Field label="Tax Percentage"><input disabled={!canManage} min="0" step="0.001" type="number" value={newRule.tax_percent} onChange={(event) => setNewRule({ ...newRule, tax_percent: event.target.value })} /></Field>
        <label className="check-field"><input disabled={!canManage} checked={newRule.active} type="checkbox" onChange={(event) => setNewRule({ ...newRule, active: event.target.checked })} /><span>Active</span></label>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={addRule}>Add Mandi Tax Rule</button>
      <DataTable headers={["Origin Type", "Tax Percentage", "Status", ""]}>
        {rules.map((rule) => <MandiRuleRow canManage={canManage} key={rule.id} onReload={onReload} rule={rule} user={user} />)}
      </DataTable>
    </ModuleCard>
  );
}

function RebateSettings({ canManage, onReload, rules, user }) {
  const [newRule, setNewRule] = useState({ rule_name: "", pay_within_days: "", rebate_percent: "", active: true });
  const addRebateRule = async () => {
    try {
      await axios.post(`${API_URL}/settings/rebate-rules`, { ...newRule, updated_by: user.id });
      setNewRule({ rule_name: "", pay_within_days: "", rebate_percent: "", active: true });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to add rebate rule"));
    }
  };
  return (
    <ModuleCard eyebrow="Supplier Rebate Settings" title="Payment-Speed Rebate Slabs" subtitle="Owner/Admin can change payment days, rebate percentages and active status from software.">
      <div className="form-grid settings-add-grid">
        <Field label="Rule Name"><input disabled={!canManage} value={newRule.rule_name} onChange={(event) => setNewRule({ ...newRule, rule_name: event.target.value })} /></Field>
        <Field label="Pay Within Days"><input disabled={!canManage} min="0" type="number" value={newRule.pay_within_days} onChange={(event) => setNewRule({ ...newRule, pay_within_days: event.target.value })} /></Field>
        <Field label="Rebate Percentage"><input disabled={!canManage} min="0" step="0.001" type="number" value={newRule.rebate_percent} onChange={(event) => setNewRule({ ...newRule, rebate_percent: event.target.value })} /></Field>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={addRebateRule}>Add Rebate Rule</button>
      <DataTable headers={["Rule", "Pay Within Days", "Rebate Percentage", "Status", ""]}>
        {rules.map((rule) => <RebateRuleRow canManage={canManage} key={rule.id} onReload={onReload} rule={rule} user={user} />)}
      </DataTable>
    </ModuleCard>
  );
}

function SaleRateSettingsSection({ canManage, onReload, saleRateSettings, user }) {
  const [draft, setDraft] = useState({ ...defaultSaleRateSettings, ...saleRateSettings });
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/sale-rate`, { ...draft, updated_by: user.id });
      await onReload();
      alert("Sale rate settings updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update sale rate settings"));
    }
  };
  return (
    <ModuleCard eyebrow="Sale Rate Settings" title="Sale Rate Suggestions" subtitle="Default margin and rounding controls used by owner-approved rate updates.">
      <div className="form-grid settings-add-grid">
        <Field label="Desired Margin %"><input disabled={!canManage} min="0" step="0.1" type="number" value={draft.desired_margin_percent || ""} onChange={(event) => setDraft({ ...draft, desired_margin_percent: event.target.value })} /></Field>
        <Field label="Rounding Rule">
          <select disabled={!canManage} value={draft.rounding_rule || "NEAREST_RUPEE"} onChange={(event) => setDraft({ ...draft, rounding_rule: event.target.value })}>
            {roundingRules.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <label className="check-field"><input disabled={!canManage} checked={draft.suggestion_enabled !== false} type="checkbox" onChange={(event) => setDraft({ ...draft, suggestion_enabled: event.target.checked })} /><span>Suggestions Active</span></label>
        <Field label="Notes"><textarea disabled={!canManage} value={draft.notes || ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></Field>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={save}>Save Sale Rate Settings</button>
    </ModuleCard>
  );
}

function DiscountSettings({ canManage, discountRules, onReload, user }) {
  const [newRule, setNewRule] = useState({
    rule_name: "",
    minimum_bill_amount: "",
    maximum_bill_amount: "",
    discount_type: "FLAT_AMOUNT",
    discount_value: "",
    payment_mode: "ALL",
    active: true,
  });
  const addRule = async () => {
    try {
      await axios.post(`${API_URL}/settings/discount-rules`, { ...newRule, updated_by: user.id });
      setNewRule({ rule_name: "", minimum_bill_amount: "", maximum_bill_amount: "", discount_type: "FLAT_AMOUNT", discount_value: "", payment_mode: "ALL", active: true });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to add discount rule"));
    }
  };
  return (
    <ModuleCard eyebrow="Overall Sale Discount Settings" title="Bill-Level Discount Slabs" subtitle="Automatic POS invoice discounts based on total bill amount and optional payment mode.">
      <div className="form-grid discount-rule-grid">
        <Field label="Rule Name"><input disabled={!canManage} value={newRule.rule_name} onChange={(event) => setNewRule({ ...newRule, rule_name: event.target.value })} /></Field>
        <Field label="Minimum Bill Amount"><input disabled={!canManage} min="0" step="0.01" type="number" value={newRule.minimum_bill_amount} onChange={(event) => setNewRule({ ...newRule, minimum_bill_amount: event.target.value })} /></Field>
        <Field label="Maximum Bill Amount"><input disabled={!canManage} min="0" step="0.01" type="number" value={newRule.maximum_bill_amount} onChange={(event) => setNewRule({ ...newRule, maximum_bill_amount: event.target.value })} /></Field>
        <Field label="Discount Type">
          <select disabled={!canManage} value={newRule.discount_type} onChange={(event) => setNewRule({ ...newRule, discount_type: event.target.value })}>
            {discountTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="Discount Value"><input disabled={!canManage} min="0" step="0.01" type="number" value={newRule.discount_value} onChange={(event) => setNewRule({ ...newRule, discount_value: event.target.value })} /></Field>
        <Field label="Payment Mode">
          <select disabled={!canManage} value={newRule.payment_mode} onChange={(event) => setNewRule({ ...newRule, payment_mode: event.target.value })}>
            {discountPaymentModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <label className="check-field"><input disabled={!canManage} checked={newRule.active} type="checkbox" onChange={(event) => setNewRule({ ...newRule, active: event.target.checked })} /><span>Active</span></label>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={addRule}>Add Discount Slab</button>
      <DataTable headers={["Rule", "Range", "Type", "Value", "Payment", "Status", ""]}>
        {discountRules.map((rule) => <DiscountRuleRow canManage={canManage} key={rule.id} onReload={onReload} rule={rule} user={user} />)}
      </DataTable>
    </ModuleCard>
  );
}

function MandiRuleRow({ canManage, onReload, rule, user }) {
  const [taxPercent, setTaxPercent] = useState(rule.tax_percent);
  const [active, setActive] = useState(rule.active);
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/mandi-tax-rules/${rule.id}`, {
        tax_percent: Number(taxPercent),
        active,
        updated_by: user.id,
      });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update mandi tax rule"));
    }
  };
  const remove = async () => {
    try {
      await axios.delete(`${API_URL}/settings/mandi-tax-rules/${rule.id}`, { data: { updated_by: user.id } });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to delete mandi tax rule"));
    }
  };
  return (
    <tr>
      <td className="primary-cell">{rule.origin_type}</td>
      <td><input className="table-input" disabled={!canManage} min="0" step="0.001" type="number" value={taxPercent} onChange={(event) => setTaxPercent(event.target.value)} /></td>
      <td><label className="check-field"><input checked={active} disabled={!canManage} type="checkbox" onChange={(event) => setActive(event.target.checked)} /><span>{active ? "Active" : "Inactive"}</span></label></td>
      <td><div className="button-row"><button className="table-action" disabled={!canManage} onClick={save}>Save</button><button className="remove-button" disabled={!canManage} onClick={remove}><Icon name="trash" size={15} /></button></div></td>
    </tr>
  );
}

function RebateRuleRow({ canManage, onReload, rule, user }) {
  const [draft, setDraft] = useState(rule);
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/rebate-rules/${rule.id}`, { ...draft, updated_by: user.id });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update rebate rule"));
    }
  };
  const remove = async () => {
    try {
      await axios.delete(`${API_URL}/settings/rebate-rules/${rule.id}`, { data: { updated_by: user.id } });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to delete rebate rule"));
    }
  };
  return (
    <tr>
      <td><input className="settings-table-input" disabled={!canManage} value={draft.rule_name} onChange={(event) => setDraft({ ...draft, rule_name: event.target.value })} /></td>
      <td><input className="table-input" disabled={!canManage} min="0" type="number" value={draft.pay_within_days} onChange={(event) => setDraft({ ...draft, pay_within_days: event.target.value })} /></td>
      <td><input className="table-input" disabled={!canManage} min="0" step="0.001" type="number" value={draft.rebate_percent} onChange={(event) => setDraft({ ...draft, rebate_percent: event.target.value })} /></td>
      <td><label className="check-field"><input checked={draft.active} disabled={!canManage} type="checkbox" onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>{draft.active ? "Active" : "Inactive"}</span></label></td>
      <td><div className="button-row"><button className="table-action" disabled={!canManage} onClick={save}>Save</button><button className="remove-button" disabled={!canManage} onClick={remove}><Icon name="trash" size={15} /></button></div></td>
    </tr>
  );
}

function DiscountRuleRow({ canManage, onReload, rule, user }) {
  const [draft, setDraft] = useState(rule);
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/discount-rules/${rule.id}`, { ...draft, updated_by: user.id });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update discount rule"));
    }
  };
  const remove = async () => {
    try {
      await axios.delete(`${API_URL}/settings/discount-rules/${rule.id}`, { data: { updated_by: user.id } });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to delete discount rule"));
    }
  };
  return (
    <tr>
      <td><input className="settings-table-input" disabled={!canManage} value={draft.rule_name} onChange={(event) => setDraft({ ...draft, rule_name: event.target.value })} /></td>
      <td>
        <div className="table-range-inputs">
          <input className="table-input" disabled={!canManage} min="0" step="0.01" type="number" value={draft.minimum_bill_amount} onChange={(event) => setDraft({ ...draft, minimum_bill_amount: event.target.value })} />
          <input className="table-input" disabled={!canManage} min="0" step="0.01" type="number" value={draft.maximum_bill_amount || ""} onChange={(event) => setDraft({ ...draft, maximum_bill_amount: event.target.value })} />
        </div>
      </td>
      <td><select className="settings-table-input" disabled={!canManage} value={draft.discount_type} onChange={(event) => setDraft({ ...draft, discount_type: event.target.value })}>{discountTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
      <td><input className="table-input" disabled={!canManage} min="0" step="0.01" type="number" value={draft.discount_value} onChange={(event) => setDraft({ ...draft, discount_value: event.target.value })} /></td>
      <td><select className="settings-table-input" disabled={!canManage} value={draft.payment_mode} onChange={(event) => setDraft({ ...draft, payment_mode: event.target.value })}>{discountPaymentModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
      <td><label className="check-field"><input checked={draft.active} disabled={!canManage} type="checkbox" onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>{draft.active ? "Active" : "Inactive"}</span></label></td>
      <td><div className="button-row"><button className="table-action" disabled={!canManage} onClick={save}>Save</button><button className="remove-button" disabled={!canManage} onClick={remove}><Icon name="trash" size={15} /></button></div></td>
    </tr>
  );
}

const permissionLabels = [
  ["settings", "Settings"],
  ["discounts", "Discounts"],
  ["mandi_tax", "Mandi Tax"],
  ["rebate_rules", "Rebate Rules"],
  ["supplier_payments", "Supplier Payments"],
  ["customer_payments", "Customer Payments"],
  ["sale_edit", "Sale Edit"],
  ["invoice_cancellation", "Invoice Cancellation"],
  ["reports", "Reports"],
  ["purchases", "Purchases"],
  ["supplier_accounts", "Supplier Accounts"],
  ["inventory", "Inventory"],
  ["waste_management", "Waste Management"],
  ["billing", "Billing"],
];

function PermissionSettings({ canManage, onReload, roles, user }) {
  const [drafts, setDrafts] = useState(() => {
    const next = {};
    for (const role of roles || []) next[role.role_name] = role.permissions || {};
    return next;
  });
  const toggle = (roleName, key) => {
    setDrafts((current) => ({
      ...current,
      [roleName]: { ...(current[roleName] || {}), [key]: !current[roleName]?.[key] },
    }));
  };
  const saveRole = async (roleName) => {
    try {
      await axios.put(`${API_URL}/settings/role-permissions/${encodeURIComponent(roleName)}`, {
        permissions: drafts[roleName] || {},
        updated_by: user.id,
      });
      await onReload();
      alert("Role permissions updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update role permissions"));
    }
  };
  return (
    <ModuleCard eyebrow="Role Management" title="Permission Matrix" subtitle="Owner/Admin can control access to billing, settings, tax, rebates, payments, reports and inventory functions.">
      <DataTable headers={["Role", ...permissionLabels.map(([, label]) => label), ""]}>
        {(roles || []).map((role) => (
          <tr key={role.role_name}>
            <td className="primary-cell">{role.role_name}</td>
            {permissionLabels.map(([key]) => (
              <td key={key}>
                <input checked={Boolean(drafts[role.role_name]?.[key])} disabled={!canManage || role.role_name === "Owner"} type="checkbox" onChange={() => toggle(role.role_name, key)} />
              </td>
            ))}
            <td><button className="table-action" disabled={!canManage || role.role_name === "Owner"} onClick={() => saveRole(role.role_name)}>Save</button></td>
          </tr>
        ))}
      </DataTable>
    </ModuleCard>
  );
}

function UserManagementSection({ canManage, onReload, roles = [], user, users = [] }) {
  const emptyForm = {
    full_name: "",
    username: "",
    mobile_number: "",
    email: "",
    role: "Cashier",
    password: "",
    confirm_password: "",
    joining_date: toDateKey(new Date()),
    active: true,
    notes: "",
  };
  const [draft, setDraft] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [passwordTarget, setPasswordTarget] = useState(null);
  const roleNames = (roles || []).map((role) => role.role_name).filter(Boolean);
  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const startEdit = (item) => {
    setEditingId(item.id);
    setDraft({
      full_name: item.full_name || "",
      username: item.username || "",
      mobile_number: item.mobile_number || "",
      email: item.email || "",
      role: item.role || "Cashier",
      password: "",
      confirm_password: "",
      joining_date: toDateKey(item.joining_date || new Date()),
      active: item.active !== false,
      notes: item.notes || "",
    });
  };
  const resetForm = () => {
    setEditingId(null);
    setDraft(emptyForm);
  };
  const saveUser = async () => {
    try {
      const duplicate = users.find((item) =>
        Number(item.id) !== Number(editingId || 0) &&
        (
          item.username?.trim().toLowerCase() === draft.username.trim().toLowerCase() ||
          (draft.mobile_number && item.mobile_number === draft.mobile_number) ||
          (draft.email && item.email?.trim().toLowerCase() === draft.email.trim().toLowerCase())
        )
      );
      if (duplicate) {
        if (duplicate.username?.trim().toLowerCase() === draft.username.trim().toLowerCase()) alert("This username already exists.");
        else if (draft.mobile_number && duplicate.mobile_number === draft.mobile_number) alert("This mobile number already exists.");
        else alert("This email already exists.");
        return;
      }
      if (!draft.full_name.trim() || !draft.username.trim() || !draft.role) {
        alert("Enter full name, username and role.");
        return;
      }
      if (!editingId && (draft.password.length < 4 || draft.password !== draft.confirm_password)) {
        alert("Enter matching password with at least 4 characters.");
        return;
      }
      const payload = { ...draft, updated_by: user.id };
      if (editingId) await axios.put(`${API_URL}/users/${editingId}`, payload);
      else await axios.post(`${API_URL}/users`, payload);
      resetForm();
      await onReload();
      alert(editingId ? "User updated" : "User added");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save user"));
    }
  };
  const changePassword = async () => {
    if (!passwordTarget) return;
    try {
      await axios.put(`${API_URL}/users/${passwordTarget.id}/password`, {
        password: passwordTarget.password,
        confirm_password: passwordTarget.confirm_password,
        updated_by: user.id,
      });
      setPasswordTarget(null);
      alert("Password updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update password"));
    }
  };
  const userAction = async (item, action) => {
    try {
      if (action === "delete") {
        const response = await axios.delete(`${API_URL}/users/${item.id}`, { data: { updated_by: user.id } });
        alert(response.data.message || "User removed");
      } else {
        await axios.post(`${API_URL}/users/${item.id}/${action}`, { updated_by: user.id });
      }
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update user status"));
    }
  };
  return (
    <ModuleCard eyebrow="User Management" title="Owner User Administration" subtitle="Add, edit, reset password, deactivate and protect user records with transaction history.">
      <div className="form-grid supplier-form-grid">
        <Field label="Full Name"><input disabled={!canManage} value={draft.full_name} onChange={(event) => updateDraft("full_name", event.target.value)} /></Field>
        <Field label="Username"><input disabled={!canManage} value={draft.username} onChange={(event) => updateDraft("username", event.target.value)} /></Field>
        <Field label="Mobile"><input disabled={!canManage} value={draft.mobile_number} onChange={(event) => updateDraft("mobile_number", event.target.value)} /></Field>
        <Field label="Email"><input disabled={!canManage} type="email" value={draft.email} onChange={(event) => updateDraft("email", event.target.value)} /></Field>
        <Field label="Role">
          <select disabled={!canManage} value={draft.role} onChange={(event) => updateDraft("role", event.target.value)}>
            {(roleNames.length ? roleNames : ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"]).map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
        </Field>
        <Field label="Joining Date"><input disabled={!canManage} type="date" value={draft.joining_date} onChange={(event) => updateDraft("joining_date", event.target.value)} /></Field>
        {!editingId && <Field label="Password"><input disabled={!canManage} type="password" value={draft.password} onChange={(event) => updateDraft("password", event.target.value)} /></Field>}
        {!editingId && <Field label="Confirm Password"><input disabled={!canManage} type="password" value={draft.confirm_password} onChange={(event) => updateDraft("confirm_password", event.target.value)} /></Field>}
        <label className="check-field"><input checked={draft.active} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("active", event.target.checked)} /><span>Active user</span></label>
        <Field label="Notes"><textarea disabled={!canManage} value={draft.notes} onChange={(event) => updateDraft("notes", event.target.value)} /></Field>
      </div>
      <div className="button-row">
        <button className="primary-button" disabled={!canManage} onClick={saveUser}>{editingId ? "Update User" : "Add User"}</button>
        {editingId && <button className="secondary-button" onClick={resetForm}>Cancel Edit</button>}
      </div>
      <DataTable headers={["Name", "Username", "Role", "Mobile", "Last Login", "Status", "Actions"]}>
        {users.map((item) => (
          <tr key={item.id}>
            <td className="primary-cell">{item.full_name}<small className="cell-note">{item.email || "No email"}</small></td>
            <td>{item.username}</td>
            <td><span className="tag">{item.role}</span></td>
            <td>{item.mobile_number || "-"}</td>
            <td>{item.last_login_at ? new Date(item.last_login_at).toLocaleString("en-IN") : "Not recorded"}</td>
            <td><span className={item.active ? "stock-ok" : "stock-low"}>{item.active ? "Active" : "Inactive"}</span></td>
            <td>
              <div className="button-row table-actions-row">
                <button className="table-action" disabled={!canManage} onClick={() => startEdit(item)}>Edit</button>
                <button className="table-action" disabled={!canManage} onClick={() => setPasswordTarget({ id: item.id, name: item.full_name, password: "", confirm_password: "" })}>Password</button>
                {item.active ? <button className="secondary-button" disabled={!canManage || item.id === user.id} onClick={() => userAction(item, "deactivate")}>Deactivate</button> : <button className="secondary-button" disabled={!canManage} onClick={() => userAction(item, "reactivate")}>Reactivate</button>}
                <button className="remove-button" disabled={!canManage || item.id === user.id} onClick={() => userAction(item, "delete")}><Icon name="trash" size={15} /></button>
              </div>
            </td>
          </tr>
        ))}
      </DataTable>
      {passwordTarget && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Reset Password</span>
                <strong>{passwordTarget.name}</strong>
              </div>
              <button aria-label="Close password reset" className="remove-button" onClick={() => setPasswordTarget(null)}><Icon name="close" /></button>
            </div>
            <div className="sale-edit-body">
              <div className="form-grid settings-add-grid">
                <Field label="New Password"><input type="password" value={passwordTarget.password} onChange={(event) => setPasswordTarget({ ...passwordTarget, password: event.target.value })} /></Field>
                <Field label="Confirm Password"><input type="password" value={passwordTarget.confirm_password} onChange={(event) => setPasswordTarget({ ...passwordTarget, confirm_password: event.target.value })} /></Field>
              </div>
              <button className="primary-button" onClick={changePassword}>Save Password</button>
            </div>
          </section>
        </div>
      )}
    </ModuleCard>
  );
}

function UpdateCenterSection({ canManage, onReload, updateCenter, user }) {
  const [draft, setDraft] = useState(updateCenter || {});
  const [message, setMessage] = useState("");
  const status = draft.update_status || "READY_FOR_FUTURE_UPDATES";
  const updateAvailable = ["UPDATE_AVAILABLE", "DOWNLOAD_READY_FUTURE", "DOWNLOADED"].includes(status);
  const updateDownloaded = ["DOWNLOADED", "INSTALL_READY_FUTURE"].includes(status);
  const save = async (status) => {
    try {
      const response = await axios.put(`${API_URL}/settings/update-center`, {
        ...draft,
        update_status: status || draft.update_status,
        updated_by: user.id,
      });
      setDraft(response.data);
      await onReload();
      const nextMessage = status === "NO_UPDATE_AVAILABLE" ? "No update available" : "Update center saved";
      setMessage(nextMessage);
      alert(nextMessage);
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update update center"));
    }
  };
  return (
    <ModuleCard eyebrow="Updates" title="Update Center" subtitle="Future-ready local update metadata. Online delivery is intentionally not enabled yet.">
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric label="Current Version" value={draft.current_version || "1.0.0"} featured />
        <SummaryMetric label="Release Date" value={draft.release_date ? toDateKey(draft.release_date) : toDateKey(new Date())} />
        <SummaryMetric label="Status" value={status} />
      </div>
      {!updateAvailable && <p className="form-note">{message || "No update available"}</p>}
      <div className="form-grid supplier-form-grid">
        <Field label="Current Version"><input disabled={!canManage} value={draft.current_version || ""} onChange={(event) => setDraft({ ...draft, current_version: event.target.value })} /></Field>
        <Field label="Release Date"><input disabled={!canManage} type="date" value={toDateKey(draft.release_date || new Date())} onChange={(event) => setDraft({ ...draft, release_date: event.target.value })} /></Field>
        <Field label="Changelog"><textarea disabled={!canManage} value={draft.changelog || ""} onChange={(event) => setDraft({ ...draft, changelog: event.target.value })} /></Field>
      </div>
      <div className="button-row">
        <button className="secondary-button" disabled={!canManage} onClick={() => save("NO_UPDATE_AVAILABLE")}>Check for Updates</button>
        <button className="secondary-button" disabled={!canManage || !updateAvailable || updateDownloaded} onClick={() => save("DOWNLOADED")}>Download Update</button>
        {updateDownloaded && <button className="primary-button" disabled={!canManage} onClick={() => save("INSTALL_READY_FUTURE")}>Install Update</button>}
      </div>
    </ModuleCard>
  );
}

function SyncSettingsSection({ canManage, onReload, syncSettings, user }) {
  const [draft, setDraft] = useState(syncSettings || {});
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  const [statusMessage, setStatusMessage] = useState("");
  useEffect(() => {
    const updateOnlineStatus = () => setOnline(navigator.onLine);
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);
  const save = async () => {
    try {
      const response = await axios.put(`${API_URL}/settings/sync-status`, {
        device_display_name: draft.device_display_name || "Main Counter Device",
        updated_by: user.id,
      });
      setDraft((current) => ({ ...current, ...response.data }));
      await onReload();
      setStatusMessage("Device display name saved");
      alert("Device display name saved");
    } catch (error) {
      setStatusMessage(getErrorMessage(error, "Unable to save device display name"));
      alert(getErrorMessage(error, "Unable to save device display name"));
    }
  };
  const pending = Number(draft.pending_count || 0);
  const autoStatus = pending > 0 ? "Sync Pending" : online ? "Online" : "Offline";
  return (
    <ModuleCard eyebrow="Sync Settings" title="Offline Sync Architecture" subtitle="Local database, sync queue and status indicator are prepared. Cloud sync delivery is not enabled yet.">
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric label="Auto Sync Status" value={autoStatus} featured />
        <SummaryMetric label="Pending Queue" value={pending} />
        <SummaryMetric label="Last Sync Time" value={draft.last_sync_at ? new Date(draft.last_sync_at).toLocaleString("en-IN") : "Not synced"} />
      </div>
      {statusMessage && <p className="form-note">{statusMessage}</p>}
      <div className="form-grid supplier-form-grid">
        <Field label="Device ID"><input disabled value={draft.device_id || "LOCAL-STORE"} /></Field>
        <Field label="Device Display Name"><input disabled={!canManage} value={draft.device_display_name || ""} onChange={(event) => setDraft({ ...draft, device_display_name: event.target.value })} /></Field>
        <label className="check-field"><input checked={draft.sync_enabled === true} disabled type="checkbox" /><span>Enable future sync option is view-only until cloud sync is enabled</span></label>
        <Field label="Notes"><textarea disabled value={draft.notes || "Cloud sync is prepared but not enabled yet."} /></Field>
      </div>
      <p className="form-note">Cloud sync is prepared but not enabled yet. Status, pending queue and last sync time are maintained by the system.</p>
      <button className="primary-button" disabled={!canManage} onClick={save}>Save Device Name</button>
    </ModuleCard>
  );
}

function BackupSettings({ backupSettings }) {
  return (
    <ModuleCard eyebrow="Backup Settings" title="Backup Readiness" subtitle="Prepared structure for future export/import backup workflows.">
      <div className="purchase-summary-grid">
        <SummaryMetric label="Export Structure" value={backupSettings?.exportReady ? "Ready" : "Pending"} featured />
        <SummaryMetric label="Import Workflow" value={backupSettings?.importReady ? "Ready" : "Future"} />
        <SummaryMetric label="Last Backup" value={backupSettings?.lastBackupAt || "Not yet recorded"} />
      </div>
      <p className="form-note">{backupSettings?.note || "Backup actions will be implemented in a future release."}</p>
    </ModuleCard>
  );
}

function SaleRateManager({ desiredMargin, history, onRefresh, onReload, rates, setDesiredMargin, user }) {
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState("");
  const [category, setCategory] = useState("");
  const [draftRates, setDraftRates] = useState({});
  const [selectedSuggested, setSelectedSuggested] = useState({});
  const [confirmUpdates, setConfirmUpdates] = useState(null);
  const categories = [...new Set(rates.map((rate) => rate.category).filter(Boolean))];
  const filteredRates = rates.filter((rate) =>
    rate.product_name.toLowerCase().includes(search.toLowerCase()) &&
    (!origin || rate.origin_type === origin) &&
    (!category || rate.category === category)
  );

  const buildRateUpdates = () => Object.entries(draftRates)
    .map(([productId, value]) => {
      const rate = rates.find((item) => String(item.id) === String(productId));
      return rate ? {
        product_id: Number(productId),
        product_name: rate.product_name,
        old_rate: Number(rate.selling_rate || 0),
        new_selling_rate: Number(value),
      } : null;
    })
    .filter(Boolean);

  const requestSaveRates = () => {
    const updates = buildRateUpdates();
    if (updates.length === 0) {
      alert("Select at least one product rate to update.");
      return;
    }
    const invalid = updates.find((update) => !Number.isFinite(update.new_selling_rate) || update.new_selling_rate <= 0);
    if (invalid) {
      alert("New Rate must be greater than 0 for every selected product.");
      return;
    }
    setConfirmUpdates(updates);
  };

  const saveRates = async () => {
    const updates = confirmUpdates || buildRateUpdates();
    const invalid = updates.find((update) => !Number.isFinite(update.new_selling_rate) || update.new_selling_rate <= 0);
    if (updates.length === 0 || invalid) {
      alert("Select valid rates before saving.");
      return;
    }
    const payloadUpdates = updates.map((update) => ({
      product_id: update.product_id,
      new_selling_rate: update.new_selling_rate,
    }));
    try {
      await axios.post(`${API_URL}/sale-rates/bulk`, { updates: payloadUpdates, changed_by: user.id });
      setDraftRates({});
      setSelectedSuggested({});
      setConfirmUpdates(null);
      await onReload();
      alert(`${updates.length} selling rate${updates.length === 1 ? "" : "s"} updated successfully.`);
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update selling rates"));
    }
  };

  const toggleSuggestedRate = (rate, checked) => {
    setSelectedSuggested((current) => ({ ...current, [rate.id]: checked }));
    setDraftRates((current) => {
      const next = { ...current };
      if (checked) next[rate.id] = Number(rate.suggested_selling_rate || 0);
      else delete next[rate.id];
      return next;
    });
  };

  const selectVisibleSuggestedRates = () => {
    const selected = {};
    const drafts = {};
    for (const rate of filteredRates) {
      selected[rate.id] = true;
      drafts[rate.id] = Number(rate.suggested_selling_rate || 0);
    }
    setSelectedSuggested((current) => ({ ...current, ...selected }));
    setDraftRates((current) => ({ ...current, ...drafts }));
  };

  const allVisibleSelected = filteredRates.length > 0 && filteredRates.every((rate) => Boolean(selectedSuggested[rate.id]));
  const toggleAllVisible = (checked) => {
    if (checked) {
      selectVisibleSuggestedRates();
      return;
    }
    const visibleIds = new Set(filteredRates.map((rate) => String(rate.id)));
    setSelectedSuggested((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !visibleIds.has(String(id)))));
    setDraftRates((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !visibleIds.has(String(id)))));
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Owner Controls" title="Daily Sale Rate Update" subtitle="Review landed costs, suggested rates, and approve daily selling-rate changes. Suggestions never auto-apply.">
        <div className="rate-toolbar">
          <input placeholder="Search products" value={search} onChange={(event) => setSearch(event.target.value)} />
          <select value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="">All Origins</option><option value="LOCAL">Local</option><option value="IMPORTED">Imported</option></select>
          <select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All Categories</option>{categories.map((item) => <option key={item}>{item}</option>)}</select>
          <input min="0" placeholder="Desired margin %" step="0.1" type="number" value={desiredMargin} onChange={(event) => setDesiredMargin(event.target.value)} />
          <button className="secondary-button" onClick={() => onRefresh(desiredMargin)}>Refresh Suggestions</button>
          <button className="secondary-button" onClick={selectVisibleSuggestedRates}>Select Visible Suggestions</button>
          <button className="primary-button" onClick={requestSaveRates}>Save Rates</button>
        </div>
        <DataTable headers={[
          <label className="table-check-label"><input checked={allVisibleSelected} type="checkbox" onChange={(event) => toggleAllVisible(event.target.checked)} /> Select All Suggested Rates</label>,
          "Product", "Origin", "Current Rate", "Suggested Rate", "New Rate", "Latest Purchase Cost", "Stock", "Pending Bill Stock", "Margin %", "Updated", "Updated By",
        ]}>
          {filteredRates.map((rate) => {
            const sellingRate = Number(draftRates[rate.id] || rate.selling_rate);
            const cost = Number(rate.latest_effective_cost || 0);
            const margin = sellingRate > 0 ? ((sellingRate - cost) / sellingRate) * 100 : 0;
            return (
              <tr key={rate.id}>
                <td><input checked={Boolean(selectedSuggested[rate.id])} type="checkbox" onChange={(event) => toggleSuggestedRate(rate, event.target.checked)} /></td>
                <td className="primary-cell">{rate.product_name}<small className="cell-note">{rate.category}</small></td>
                <td><span className="tag">{rate.origin_type}</span></td>
                <td>{currency.format(Number(rate.selling_rate))}</td>
                <td className="profit-cell">{currency.format(Number(rate.suggested_selling_rate))}</td>
                <td><input className="table-input" min="0" step="0.01" type="number" value={draftRates[rate.id] || ""} onChange={(event) => setDraftRates({ ...draftRates, [rate.id]: event.target.value })} /></td>
                <td>{currency.format(cost)}</td>
                <td>{rate.current_stock}</td>
                <td>{Number(rate.pending_bill_stock || 0) > 0 ? <span className="stock-low">{rate.pending_bill_stock} - provisional profit</span> : "-"}</td>
                <td><span className={margin < 15 ? "stock-low" : "stock-ok"}>{margin.toFixed(1)}%</span></td>
                <td>{rate.selling_rate_updated_at ? new Date(rate.selling_rate_updated_at).toLocaleDateString("en-IN") : "-"}</td>
                <td>{rate.updated_by_name || "-"}</td>
              </tr>
            );
          })}
        </DataTable>
      </ModuleCard>
      <ModuleCard eyebrow="Audit Trail" title="Sale Rate History" subtitle="Every approved selling-rate change is stored for reporting and accountability.">
        <DataTable headers={["Changed At", "Product", "Old Rate", "New Rate", "Changed By", "Reason"]}>
          {history.map((item) => <tr key={item.id}><td>{new Date(item.changed_at).toLocaleString("en-IN")}</td><td className="primary-cell">{item.product_name}</td><td>{currency.format(Number(item.old_selling_rate))}</td><td className="profit-cell">{currency.format(Number(item.new_selling_rate))}</td><td>{item.changed_by_name}</td><td>{item.reason || "-"}</td></tr>)}
        </DataTable>
      </ModuleCard>
      {confirmUpdates && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Confirm Sale Rate Update</span>
                <strong>Are you sure you want to update selected sale rates?</strong>
              </div>
              <button aria-label="Close confirmation" className="remove-button" onClick={() => setConfirmUpdates(null)}><Icon name="close" /></button>
            </div>
            <div className="sale-edit-body">
              <div className="purchase-summary-grid supplier-payment-preview">
                <SummaryMetric label="Selected Products" value={confirmUpdates.length} featured />
              </div>
              <DataTable headers={["Product", "Old Rate", "New Rate"]}>
                {confirmUpdates.map((update) => (
                  <tr key={update.product_id}>
                    <td className="primary-cell">{update.product_name}</td>
                    <td>{currency.format(update.old_rate)}</td>
                    <td className="profit-cell">{currency.format(update.new_selling_rate)}</td>
                  </tr>
                ))}
              </DataTable>
              <div className="button-row">
                <button className="primary-button" onClick={saveRates}>Confirm Save Rates</button>
                <button className="secondary-button" onClick={() => setConfirmUpdates(null)}>Cancel</button>
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

const calculateDiscountFromRule = (rule, subtotal) => {
  if (!rule || subtotal <= 0) return 0;
  const value = Number(rule.discount_value || 0);
  const amount = rule.discount_type === "PERCENTAGE" ? subtotal * value / 100 : value;
  return Math.min(amount, subtotal);
};

const getMatchingDiscountRule = (rules, subtotal, paymentMode) => {
  if (subtotal <= 0) return null;
  const matches = rules
    .filter((rule) =>
      rule.active !== false &&
      Number(rule.minimum_bill_amount || 0) <= subtotal &&
      (!rule.maximum_bill_amount || Number(rule.maximum_bill_amount) >= subtotal) &&
      (rule.payment_mode === "ALL" || rule.payment_mode === paymentMode)
    )
    .sort((left, right) => {
      if (left.payment_mode === paymentMode && right.payment_mode !== paymentMode) return -1;
      if (right.payment_mode === paymentMode && left.payment_mode !== paymentMode) return 1;
      return Number(right.minimum_bill_amount || 0) - Number(left.minimum_bill_amount || 0) || Number(right.discount_value || 0) - Number(left.discount_value || 0);
    });
  return matches[0] || null;
};

function PosBilling({ customers = [], discountRules = [], inventory, onInvoice, onSaved, paymentSettings = {}, posSettings = {}, printSettings = {}, products, user }) {
  const [search, setSearch] = useState("");
  const [barcode, setBarcode] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [cart, setCart] = useState([]);
  const [paymentMode, setPaymentMode] = useState("CASH");
  const [quantityMode, setQuantityMode] = useState(posSettings.enable_weighing_scale ? "SCALE" : "MANUAL");
  const [scaleMessage, setScaleMessage] = useState("");
  const [mixedPayments, setMixedPayments] = useState({ CASH: "", UPI: "", CARD: "" });
  const [customer, setCustomer] = useState({ name: "", mobile: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [lastInvoice, setLastInvoice] = useState(null);
  const searchRef = useRef(null);
  const barcodeRef = useRef(null);
  const quantityRefs = useRef({});

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const effectiveQuantityMode = posSettings.enable_weighing_scale ? quantityMode : "MANUAL";

  const stockByProduct = useMemo(
    () => inventory.reduce((stock, batch) => {
      stock.set(batch.product_id, (stock.get(batch.product_id) || 0) + Number(batch.remaining_qty || 0));
      return stock;
    }, new Map()),
    [inventory]
  );

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return products.slice(0, 8);
    return products
      .filter((product) => product.product_name.toLowerCase().includes(query))
      .slice(0, 8);
  }, [products, search]);

  const totals = useMemo(() => {
    const gross = cart.reduce((sum, item) => sum + item.quantity * Number(item.selling_rate), 0);
    const itemDiscount = cart.reduce((sum, item) => sum + Number(item.discount_amount || 0), 0);
    const subtotalAfterItemDiscounts = Math.max(gross - itemDiscount, 0);
    const discountRule = getMatchingDiscountRule(discountRules, subtotalAfterItemDiscounts, paymentMode);
    const invoiceDiscountAmount = calculateDiscountFromRule(discountRule, subtotalAfterItemDiscounts);
    return {
      gross,
      itemDiscount,
      invoiceDiscount: invoiceDiscountAmount,
      discount: itemDiscount + invoiceDiscountAmount,
      total: Math.max(gross - itemDiscount - invoiceDiscountAmount, 0),
      itemCount: cart.reduce((sum, item) => sum + Number(item.quantity), 0),
      discountRule,
    };
  }, [cart, discountRules, paymentMode]);

  const addProduct = (product) => {
    const availableStock = stockByProduct.get(product.id) || 0;
    const currentItem = cart.find((item) => item.product_id === product.id);
    const nextQuantity = Number(currentItem?.quantity || 0) + 1;
    if (availableStock < nextQuantity) {
      alert(`Insufficient stock for ${product.product_name}. Available quantity: ${availableStock}`);
      return;
    }

    setCart((items) => currentItem
      ? items.map((item) => item.product_id === product.id ? { ...item, quantity: nextQuantity } : item)
      : [...items, {
        product_id: product.id,
        product_name: product.product_name,
        unit: product.unit,
        selling_rate: Number(product.selling_rate),
        quantity: 1,
        discount_amount: 0,
      }]
    );
    setSearch("");
    setHighlightedIndex(0);
    setTimeout(() => {
      const input = quantityRefs.current[product.id];
      input?.focus();
      input?.select();
    }, 0);
  };

  const updateCartItem = (productId, field, value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return;
    if (field === "quantity" && number > (stockByProduct.get(productId) || 0)) {
      alert(`Only ${stockByProduct.get(productId) || 0} units are available.`);
      return;
    }
    setCart((items) => items.map((item) => item.product_id === productId ? { ...item, [field]: value } : item));
  };

  const completeQuantityEntry = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    setSearch("");
    setHighlightedIndex(0);
    searchRef.current?.focus();
  };

  const removeCartItem = (productId) => {
    setCart((items) => items.filter((item) => item.product_id !== productId));
  };

  const scanBarcode = () => {
    const code = barcode.trim();
    if (!code) return;
    const product = products.find((item) => item.barcode === code);
    if (!product) {
      alert(`No product is assigned to barcode ${code}`);
      barcodeRef.current?.focus();
    } else {
      addProduct(product);
    }
    setBarcode("");
  };

  const readScaleWeight = () => {
    setScaleMessage("Scale not connected - enter quantity manually.");
    const lastItem = cart.at(-1);
    if (lastItem) {
      const input = quantityRefs.current[lastItem.product_id];
      input?.focus();
      input?.select();
    }
  };

  const selectCustomer = (customerId) => {
    const selected = customers.find((item) => String(item.id) === String(customerId));
    if (!selected) {
      setCustomer({ name: "", mobile: "", notes: "" });
      return;
    }
    setCustomer({
      name: selected.customer_name || "",
      mobile: selected.mobile_number || "",
      notes: selected.notes || "",
    });
  };

  const checkout = async (printAfterSave = false) => {
    if (saving) return;
    if (cart.length === 0) {
      alert("Add at least one product before checkout.");
      return;
    }
    if (customer.mobile && !/^\d{10,15}$/.test(customer.mobile)) {
      alert("Enter a valid customer mobile number.");
      return;
    }
    if (totals.invoiceDiscount > totals.gross - totals.itemDiscount) {
      alert("Invoice discount cannot exceed the cart subtotal.");
      return;
    }

    const payments = paymentMode === "MIXED"
      ? Object.entries(mixedPayments)
        .filter(([, amount]) => Number(amount) > 0)
        .map(([mode, amount]) => ({ mode, amount: Number(amount) }))
      : [{ mode: paymentMode, amount: totals.total }];
    const paidAmount = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
    if (Math.abs(paidAmount - totals.total) > 0.01) {
      alert("Payment amounts must match the invoice total.");
      return;
    }

    setSaving(true);
    try {
      const response = await axios.post(`${API_URL}/sales`, {
        items: cart.map((item) => ({
          product_id: item.product_id,
          quantity: Number(item.quantity),
          discount_amount: Number(item.discount_amount || 0),
        })),
        customer,
        invoice_discount: Number(totals.invoiceDiscount || 0),
        discount_rule_id: totals.discountRule?.id || null,
        payments,
        branch_id: user.branch_id,
        created_by: user.id,
      });
      setCart([]);
      setMixedPayments({ CASH: "", UPI: "", CARD: "" });
      setCustomer({ name: "", mobile: "", notes: "" });
      await onSaved();
      setLastInvoice(response.data.sale);
      onInvoice(response.data.sale);
      if (printAfterSave || printSettings.auto_print_after_billing === true) {
        setTimeout(() => window.print(), 250);
      }
    } catch (error) {
      alert(getErrorMessage(error, "Unable to complete checkout"));
    } finally {
      setSaving(false);
    }
  };

  const handleSearchKeys = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.min(index + 1, searchResults.length - 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(index - 1, 0));
    }
    if (event.key === "Enter" && searchResults[highlightedIndex]) {
      event.preventDefault();
      addProduct(searchResults[highlightedIndex]);
    }
  };

  const handleShortcuts = (event) => {
    if (event.key === "F2") {
      event.preventDefault();
      searchRef.current?.focus();
    }
    if (event.key === "F3") {
      event.preventDefault();
      barcodeRef.current?.focus();
    }
    if (event.key === "F4") {
      event.preventDefault();
      checkout(true);
    }
  };

  const printLastInvoice = () => {
    if (!lastInvoice) {
      alert("Save a bill before printing.");
      return;
    }
    onInvoice(lastInvoice);
    setTimeout(() => window.print(), 250);
  };

  return (
    <section className="pos-layout" onKeyDown={handleShortcuts}>
      <div className="pos-main">
        <section className="content-card pos-search-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Retail Counter</span>
              <h2>POS Billing</h2>
              <p>Search products or scan a barcode to build the invoice.</p>
            </div>
            <span className="shortcut-hint">F2 Search - F3 Barcode - F4 Checkout</span>
          </div>
          <div className="pos-mode-panel">
            <Field label="Quantity Mode">
              <select value={effectiveQuantityMode} onChange={(event) => setQuantityMode(event.target.value)}>
                <option value="MANUAL">Manual</option>
                <option disabled={!posSettings.enable_weighing_scale} value="SCALE">Weighing Scale Mode</option>
              </select>
            </Field>
            <button className="secondary-button" disabled={effectiveQuantityMode !== "SCALE"} onClick={readScaleWeight}>Read Weight</button>
            <span className={effectiveQuantityMode === "SCALE" ? "stock-low" : "stock-ok"}>
              {effectiveQuantityMode === "SCALE" ? (scaleMessage || "Scale mode ready - manual fallback active") : "Manual quantity entry"}
            </span>
          </div>
          <div className="pos-inputs">
            <label className="icon-input">
              <Icon name="search" />
              <input
                placeholder="Search product name"
                ref={searchRef}
                value={search}
                onChange={(event) => { setSearch(event.target.value); setHighlightedIndex(0); }}
                onKeyDown={handleSearchKeys}
              />
            </label>
            <label className="icon-input">
              <Icon name="barcode" />
              <input
                placeholder="Scan barcode"
                ref={barcodeRef}
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && scanBarcode()}
              />
            </label>
          </div>
          <div className="product-results">
            {searchResults.map((product, index) => {
              const stock = stockByProduct.get(product.id) || 0;
              return (
                <button
                  className={index === highlightedIndex ? "product-result product-result-active" : "product-result"}
                  key={product.id}
                  onClick={() => addProduct(product)}
                >
                  <span>
                    <strong>{product.product_name}</strong>
                    <small>{product.barcode || "No barcode"} - {currency.format(Number(product.selling_rate))}/{product.unit}</small>
                  </span>
                  <em className={stock <= 5 ? "stock-low" : "stock-ok"}>{stock} in stock</em>
                </button>
              );
            })}
          </div>
        </section>

        <section className="content-card cart-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Current Invoice</span>
              <h2>Shopping Cart</h2>
            </div>
            <span className="cart-count">{totals.itemCount} items</span>
          </div>
          {cart.length === 0 ? (
            <div className="cart-empty">Search or scan a product to begin billing.</div>
          ) : (
            <div className="table-wrap cart-table">
              <table>
                <thead><tr><th>Product</th><th>Rate</th><th>Qty</th><th>Item Discount</th><th>Total</th><th /></tr></thead>
                <tbody>
                  {cart.map((item) => (
                    <tr key={item.product_id}>
                      <td className="primary-cell">{item.product_name}<small className="cell-note">{stockByProduct.get(item.product_id) || 0} {item.unit} available</small></td>
                      <td>{currency.format(item.selling_rate)}</td>
                      <td><input className="table-input" min="0.001" ref={(node) => { quantityRefs.current[item.product_id] = node; }} step="0.001" type="number" value={item.quantity} onChange={(event) => updateCartItem(item.product_id, "quantity", event.target.value)} onKeyDown={completeQuantityEntry} /></td>
                      <td><input className="table-input" min="0" step="0.01" type="number" value={item.discount_amount} onChange={(event) => updateCartItem(item.product_id, "discount_amount", event.target.value)} /></td>
                      <td className="primary-cell">{currency.format(item.quantity * item.selling_rate - Number(item.discount_amount || 0))}</td>
                      <td><button aria-label={`Remove ${item.product_name}`} className="remove-button" onClick={() => removeCartItem(item.product_id)}><Icon name="trash" size={16} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <aside className="checkout-card">
        <span className="eyebrow">Checkout</span>
        <h2>Invoice Summary</h2>
        <div className="checkout-section">
          <Field label="Saved Customer Account">
            <select onChange={(event) => selectCustomer(event.target.value)} defaultValue="">
              <option value="">Walk-in Customer</option>
              {customers.map((item) => <option key={item.id} value={item.id}>{item.customer_name}{item.mobile_number ? ` - ${item.mobile_number}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Customer Name"><input placeholder="Walk-in customer" value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} /></Field>
          <Field label="Mobile Number"><input inputMode="numeric" placeholder="Optional for WhatsApp" value={customer.mobile} onChange={(event) => setCustomer({ ...customer, mobile: event.target.value.replace(/\D/g, "") })} /></Field>
          <Field label="Notes"><textarea placeholder="Optional notes" value={customer.notes} onChange={(event) => setCustomer({ ...customer, notes: event.target.value })} /></Field>
        </div>
        <div className="checkout-section">
          <div className="discount-preview">
            <span>Automatic Bill Discount</span>
            <strong>{currency.format(totals.invoiceDiscount)}</strong>
            <small>{totals.discountRule ? totals.discountRule.rule_name : "No active slab matched"}</small>
          </div>
          <Field label="Payment Mode">
            <select value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)}>
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="CARD">Card</option>
              <option value="MIXED">Mixed Payment</option>
            </select>
          </Field>
          {paymentSettings.enable_upi_qr_on_invoice && paymentSettings.business_upi_id && ["UPI", "MIXED"].includes(paymentMode) && (
            <p className="form-note">UPI QR will be printed for {paymentSettings.business_upi_id} on this invoice.</p>
          )}
          {paymentMode === "MIXED" && (
            <div className="mixed-grid">
              {Object.keys(mixedPayments).map((mode) => (
                <Field key={mode} label={mode}><input min="0" step="0.01" type="number" value={mixedPayments[mode]} onChange={(event) => setMixedPayments({ ...mixedPayments, [mode]: event.target.value })} /></Field>
              ))}
            </div>
          )}
        </div>
        <div className="totals">
          <TotalLine label="Gross Total" value={totals.gross} />
          <TotalLine label="Item Discount" value={-totals.itemDiscount} />
          <TotalLine label="Bill Discount" value={-totals.invoiceDiscount} />
          <TotalLine label="Tax" value={0} muted />
          <TotalLine label="Net Payable" value={totals.total} total />
        </div>
        <div className="button-row checkout-actions">
          <button className="primary-button checkout-button" disabled={saving} onClick={() => checkout(false)}>
            <Icon name="receipt" /> {saving ? "Saving..." : "Save Bill"}
          </button>
          <button className="secondary-button" disabled={!lastInvoice || saving} onClick={printLastInvoice}>
            <Icon name="print" /> Print Bill
          </button>
          <button className="primary-button" disabled={saving} onClick={() => checkout(true)}>
            <Icon name="print" /> Save & Print
          </button>
        </div>
      </aside>
    </section>
  );
}

function TotalLine({ label, muted, total, value }) {
  return <div className={`${total ? "total-line total-line-main" : "total-line"} ${muted ? "total-line-muted" : ""}`}><span>{label}</span><strong>{currency.format(value)}</strong></div>;
}

function ThermalTotalLine({ label, total, value }) {
  return <div className={total ? "total-line total-line-main" : "total-line"}><span>{label}</span><strong>{receiptCurrency.format(value)}</strong></div>;
}

function SaleEditModal({ invoice, onClose, onSaved, products, user }) {
  const [items, setItems] = useState(() => (invoice.items || []).map((item) => ({
    product_id: item.product_id,
    product_name: item.product_name,
    unit: item.unit,
    quantity: item.quantity,
    selling_rate: item.selling_rate,
    discount_amount: item.discount_amount || 0,
  })));
  const [customer, setCustomer] = useState({
    name: invoice.customer_name || "",
    mobile: invoice.customer_mobile || "",
    notes: invoice.customer_notes || "",
  });
  const [paymentMode, setPaymentMode] = useState(invoice.payment_mode === "MIXED" ? "CASH" : invoice.payment_mode || "CASH");
  const [invoiceDiscount, setInvoiceDiscount] = useState(invoice.invoice_discount_amount || 0);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const canChangeRate = user.role === "Owner";
  const selectedIds = new Set(items.map((item) => Number(item.product_id)));
  const availableProducts = products.filter((product) => !selectedIds.has(Number(product.id)));
  const gross = items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.selling_rate || 0), 0);
  const itemDiscount = items.reduce((sum, item) => sum + Number(item.discount_amount || 0), 0);
  const netPayable = Math.max(gross - itemDiscount - Number(invoiceDiscount || 0), 0);

  const updateItem = (index, field, value) => {
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item));
  };
  const addItem = (productId) => {
    const product = products.find((item) => String(item.id) === String(productId));
    if (!product) return;
    setItems((current) => [...current, {
      product_id: product.id,
      product_name: product.product_name,
      unit: product.unit,
      quantity: 1,
      selling_rate: product.selling_rate,
      discount_amount: 0,
    }]);
  };
  const removeItem = (index) => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
  const save = async () => {
    if (saving) return;
    if (!reason.trim()) {
      alert("Edit reason is required.");
      return;
    }
    if (items.length === 0) {
      alert("Invoice must contain at least one item.");
      return;
    }
    if (customer.mobile && !/^\d{10,15}$/.test(customer.mobile)) {
      alert("Enter a valid customer mobile number.");
      return;
    }
    setSaving(true);
    try {
      await axios.put(`${API_URL}/sales/${invoice.id}`, {
        items: items.map((item) => ({
          product_id: Number(item.product_id),
          quantity: Number(item.quantity),
          selling_rate: Number(item.selling_rate),
          discount_amount: Number(item.discount_amount || 0),
        })),
        customer,
        invoice_discount: Number(invoiceDiscount || 0),
        payments: [{ mode: paymentMode, amount: netPayable }],
        branch_id: invoice.branch_id || user.branch_id,
        edited_by: user.id,
        reason,
      });
      await onSaved();
      alert("Invoice updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update invoice"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section className="invoice-modal sale-edit-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">Edit Completed Sale</span>
            <strong>{invoice.invoice_no}</strong>
          </div>
          <div className="invoice-actions">
            <button className="primary-button" disabled={saving} onClick={save}>{saving ? "Saving..." : "Save Edit"}</button>
            <button aria-label="Close editor" className="remove-button" onClick={onClose}><Icon name="close" /></button>
          </div>
        </div>
        <div className="sale-edit-body">
          <div className="form-grid supplier-form-grid">
            <Field label="Customer Name"><input value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} /></Field>
            <Field label="Mobile Number"><input inputMode="numeric" value={customer.mobile} onChange={(event) => setCustomer({ ...customer, mobile: event.target.value.replace(/\D/g, "") })} /></Field>
            <Field label="Payment Mode">
              <select value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)}>
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="CARD">Card</option>
              </select>
            </Field>
            <Field label="Bill Discount"><input min="0" step="0.01" type="number" value={invoiceDiscount} onChange={(event) => setInvoiceDiscount(event.target.value)} /></Field>
            <Field label="Customer Notes"><textarea value={customer.notes} onChange={(event) => setCustomer({ ...customer, notes: event.target.value })} /></Field>
            <Field label="Edit Reason"><textarea value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
          </div>
          <div className="sale-edit-add-row">
            <select defaultValue="" onChange={(event) => { addItem(event.target.value); event.target.value = ""; }}>
              <option value="">Add item</option>
              {availableProducts.map((product) => <option key={product.id} value={product.id}>{product.product_name}</option>)}
            </select>
          </div>
          <DataTable headers={["Product", "Qty", "Rate", "Discount", "Net", ""]}>
            {items.map((item, index) => (
              <tr key={`${item.product_id}-${index}`}>
                <td className="primary-cell">{item.product_name}<small className="cell-note">{item.unit}</small></td>
                <td><input className="table-input" min="0.001" step="0.001" type="number" value={item.quantity} onChange={(event) => updateItem(index, "quantity", event.target.value)} /></td>
                <td><input className="settings-table-input" disabled={!canChangeRate} min="0.01" step="0.01" type="number" value={item.selling_rate} onChange={(event) => updateItem(index, "selling_rate", event.target.value)} /></td>
                <td><input className="table-input" min="0" step="0.01" type="number" value={item.discount_amount} onChange={(event) => updateItem(index, "discount_amount", event.target.value)} /></td>
                <td>{currency.format(Number(item.quantity || 0) * Number(item.selling_rate || 0) - Number(item.discount_amount || 0))}</td>
                <td><button className="remove-button" onClick={() => removeItem(index)}><Icon name="trash" size={15} /></button></td>
              </tr>
            ))}
          </DataTable>
          <section className="purchase-summary sale-edit-summary">
            <div className="purchase-summary-grid">
              <SummaryMetric label="Gross Total" value={currency.format(gross)} />
              <SummaryMetric label="Item Discount" value={currency.format(itemDiscount)} />
              <SummaryMetric label="Bill Discount" value={currency.format(Number(invoiceDiscount || 0))} />
              <SummaryMetric label="Net Payable" value={currency.format(netPayable)} featured />
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

const formatSaleAuditLines = (row) => {
  if (row.action === "CANCEL") {
    return [
      "Invoice Cancelled",
      `Reason: ${row.reason || "-"}`,
      `Cancelled By: ${row.edited_by_name || "-"}`,
      `Cancelled At: ${row.edited_at ? new Date(row.edited_at).toLocaleString("en-IN") : "-"}`,
    ];
  }
  const oldValue = row.old_value || {};
  const newValue = row.new_value || {};
  const oldSale = oldValue.sale || {};
  const newSale = newValue.sale || {};
  const lines = [];
  const addMoneyChange = (label, key) => {
    if (Number(oldSale[key] || 0) !== Number(newSale[key] || 0)) {
      lines.push(`${label}: ${currency.format(Number(oldSale[key] || 0))} -> ${currency.format(Number(newSale[key] || 0))}`);
    }
  };
  if ((oldSale.customer_name || "") !== (newSale.customer_name || "")) lines.push(`Customer: ${oldSale.customer_name || "Walk-in"} -> ${newSale.customer_name || "Walk-in"}`);
  if ((oldSale.payment_mode || "") !== (newSale.payment_mode || "")) lines.push(`Payment Mode: ${oldSale.payment_mode || "-"} -> ${newSale.payment_mode || "-"}`);
  addMoneyChange("Gross Total", "gross_amount");
  addMoneyChange("Discount", "invoice_discount_amount");
  addMoneyChange("Net Amount", "total_amount");
  const oldItems = new Map((oldValue.items || []).map((item) => [String(item.product_id), item]));
  const newItems = new Map((newValue.items || []).map((item) => [String(item.product_id), item]));
  for (const [productId, oldItem] of oldItems) {
    const newItem = newItems.get(productId);
    if (!newItem) {
      lines.push(`Removed: Product #${productId}, ${Number(oldItem.quantity || 0)} units, ${currency.format(Number(oldItem.amount || 0))}`);
      continue;
    }
    if (Number(oldItem.quantity || 0) !== Number(newItem.quantity || 0)) {
      lines.push(`Item Product #${productId} Quantity: ${Number(oldItem.quantity || 0)} -> ${Number(newItem.quantity || 0)}`);
    }
    if (Number(oldItem.selling_rate || 0) !== Number(newItem.selling_rate || 0)) {
      lines.push(`Item Product #${productId} Rate: ${currency.format(Number(oldItem.selling_rate || 0))} -> ${currency.format(Number(newItem.selling_rate || 0))}`);
    }
    if (Number(oldItem.net_amount || oldItem.amount || 0) !== Number(newItem.net_amount || newItem.amount || 0)) {
      lines.push(`Item Product #${productId} Amount: ${currency.format(Number(oldItem.net_amount || oldItem.amount || 0))} -> ${currency.format(Number(newItem.net_amount || newItem.amount || 0))}`);
    }
  }
  for (const [productId, newItem] of newItems) {
    if (!oldItems.has(productId)) {
      lines.push(`Added: Product #${productId}, ${Number(newItem.quantity || 0)} units, ${currency.format(Number(newItem.net_amount || newItem.amount || 0))}`);
    }
  }
  return lines.length ? lines : ["No business fields changed."];
};

function ChangeHistoryModal({ history, onClose }) {
  return (
    <div className="modal-backdrop">
      <section className="invoice-modal change-history-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">Sale Audit Trail</span>
            <strong>Invoice #{history.saleId}</strong>
          </div>
          <button aria-label="Close history" className="remove-button" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="sale-edit-body">
          <DataTable headers={["Action", "Edited At", "Edited By", "Reason", "Readable Changes"]}>
            {history.rows.map((row) => (
              <tr key={row.id}>
                <td><span className="tag">{row.action}</span></td>
                <td>{new Date(row.edited_at).toLocaleString("en-IN")}</td>
                <td>{row.edited_by_name || "-"}</td>
                <td>{row.reason}</td>
                <td><div className="audit-readable">{formatSaleAuditLines(row).map((line) => <span key={line}>{line}</span>)}</div></td>
              </tr>
            ))}
          </DataTable>
          {history.rows.length === 0 && <div className="cart-empty">No changes recorded for this invoice.</div>}
        </div>
      </section>
    </div>
  );
}

const formatPaymentAuditLines = (row) => {
  const oldValue = row.old_value || {};
  const newValue = row.new_value || {};
  if (row.action === "CANCEL") {
    return [
      "Payment Cancelled",
      `Reason: ${row.reason || "-"}`,
      `Cancelled By: ${row.edited_by_name || "-"}`,
      `Cancelled At: ${row.edited_at ? new Date(row.edited_at).toLocaleString("en-IN") : "-"}`,
    ];
  }
  const fields = [
    ["payment_date", "Date", (value) => toDateKey(value || "")],
    ["payment_amount", "Payment Amount", (value) => currency.format(Number(value || 0))],
    ["rebate_amount", "Rebate Amount", (value) => currency.format(Number(value || 0))],
    ["payment_mode", "Payment Mode", (value) => value || "-"],
    ["reference_number", "Reference", (value) => value || "-"],
    ["remarks", "Remarks", (value) => value || "-"],
  ];
  const lines = fields
    .filter(([key]) => String(oldValue[key] ?? "") !== String(newValue[key] ?? ""))
    .map(([key, label, formatter]) => `${label}: ${formatter(oldValue[key])} -> ${formatter(newValue[key])}`);
  return lines.length ? lines : ["No payment fields changed."];
};

function PaymentAuditModal({ audit, onClose }) {
  return (
    <div className="modal-backdrop">
      <section className="invoice-modal change-history-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">Payment Audit Trail</span>
            <strong>{audit.payment.account_name}</strong>
          </div>
          <button aria-label="Close payment history" className="remove-button" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="sale-edit-body">
          <DataTable headers={["Action", "Edited At", "Edited By", "Reason", "Readable Changes"]}>
            {audit.rows.map((row) => (
              <tr key={row.id}>
                <td><span className="tag">{row.action}</span></td>
                <td>{new Date(row.edited_at).toLocaleString("en-IN")}</td>
                <td>{row.edited_by_name || "-"}</td>
                <td>{row.reason}</td>
                <td><div className="audit-readable">{formatPaymentAuditLines(row).map((line) => <span key={line}>{line}</span>)}</div></td>
              </tr>
            ))}
          </DataTable>
          {audit.rows.length === 0 && <div className="cart-empty">No edits or cancellations recorded for this payment.</div>}
        </div>
      </section>
    </div>
  );
}

function PaymentReceiptModal({ payment, onClose }) {
  const paymentAmount = Number(payment.payment_amount || 0);
  const rebateAmount = Number(payment.rebate_amount || 0);
  const totalImpact = paymentAmount + rebateAmount;
  return (
    <div className="modal-backdrop">
      <section className="invoice-modal">
        <div className="invoice-toolbar no-print">
          <div>
            <span className="eyebrow">Payment Receipt</span>
            <strong>{payment.account_name || "Account Payment"}</strong>
          </div>
          <div className="invoice-actions">
            <button className="secondary-button" onClick={() => window.print()}><Icon name="print" /> Print Receipt</button>
            <button className="secondary-button" onClick={() => window.print()}>Save PDF</button>
            <button aria-label="Close receipt" className="remove-button" onClick={onClose}><Icon name="close" /></button>
          </div>
        </div>
        <article className="invoice-paper print-area">
          <header className="invoice-header">
            <BrandLogo invoice />
            <div className="invoice-meta">
              <strong>Payment Receipt</strong>
              <span>Receipt #{payment.payment_key || payment.id}</span>
              <span>{payment.payment_date ? new Date(payment.payment_date).toLocaleDateString("en-IN") : toDateKey(new Date())}</span>
            </div>
          </header>
          <section className="invoice-customer">
            <div><small>Party Name</small><strong>{payment.account_name || "-"}</strong><span>{payment.account_type || payment.payment_source || "-"}</span></div>
            <div><small>Payment Mode</small><strong>{payment.payment_mode || "-"}</strong><span>{payment.reference_number || "No reference"}</span></div>
          </section>
          <section className="receipt-summary">
            <TotalLine label="Outstanding Before" value={Number(payment.outstanding_before || 0)} />
            <TotalLine label="Payment Amount" value={paymentAmount} />
            {rebateAmount > 0 && <TotalLine label="Rebate Received" value={rebateAmount} />}
            <TotalLine label="Total Balance Reduction" value={totalImpact} />
            <TotalLine label="Outstanding After" value={Number(payment.outstanding_after || 0)} total />
          </section>
          <p className="invoice-footer">{payment.remarks || "Thank you. This receipt is generated from FroozERP Accounts."}</p>
        </article>
      </section>
    </div>
  );
}

function InvoiceModal({ invoice, onClose, paymentSettings = {}, printSettings = {} }) {
  const [printMode, setPrintMode] = useState(printSettings.default_printer_type === "A4" ? "A4" : "THERMAL");
  const [upiQrDataUrl, setUpiQrDataUrl] = useState("");
  const activePrintMode = printMode === "A4" ? "A4" : "THERMAL";
  const invoicePayments = invoice.payments || [];
  const hasUpiPayment = invoice.payment_mode === "UPI" || invoice.payment_mode === "MIXED" || invoicePayments.some((payment) => (payment.mode || payment.payment_mode) === "UPI");
  const shouldShowUpiQr = paymentSettings.enable_upi_qr_on_invoice === true && paymentSettings.business_upi_id && (hasUpiPayment || paymentSettings.show_upi_qr_on_all_bills === true);
  const upiPayload = shouldShowUpiQr ? [
    "upi://pay?",
    `pa=${encodeURIComponent(paymentSettings.business_upi_id)}`,
    `&pn=${encodeURIComponent(paymentSettings.upi_payee_name || "FEEL THE FREAKIN' FROOZ")}`,
    `&am=${encodeURIComponent(Number(invoice.total_amount || 0).toFixed(2))}`,
    "&cu=INR",
    `&tn=${encodeURIComponent(`FroozERP-Invoice-${invoice.invoice_no || invoice.id}`)}`,
  ].join("") : "";
  useEffect(() => {
    let active = true;
    if (!upiPayload) return undefined;
    QRCode.toDataURL(upiPayload, { errorCorrectionLevel: "M", margin: 1, width: activePrintMode === "THERMAL" ? 120 : 160 })
      .then((url) => active && setUpiQrDataUrl(url))
      .catch(() => active && setUpiQrDataUrl(""));
    return () => {
      active = false;
    };
  }, [activePrintMode, upiPayload]);
  const printWithMode = (mode) => {
    setPrintMode(mode);
    setTimeout(() => window.print(), 100);
  };
  const sendWhatsApp = () => {
    if (!invoice.customer_mobile) {
      alert("Add a customer mobile number to send this invoice on WhatsApp.");
      return;
    }
    const message = [
      "Thank you for shopping with FEEL THE FREAKIN' FROOZ. Your invoice is ready.",
      `Invoice: ${invoice.invoice_no}`,
      `Amount: ${currency.format(Number(invoice.total_amount))}`,
      "We appreciate your business.",
      "",
      "Please attach the saved invoice PDF to this chat.",
    ].join("\n");
    window.open(`https://wa.me/${invoice.customer_mobile}?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="modal-backdrop">
      <section className="invoice-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">Invoice Saved</span>
            <strong>{invoice.invoice_no}</strong>
          </div>
          <div className="invoice-actions">
            <button className="secondary-button" onClick={() => printWithMode("THERMAL")}><Icon name="print" /> POS Thermal Print</button>
            <button className="secondary-button" onClick={() => printWithMode("A4")}><Icon name="print" /> A4 Invoice Print</button>
            <button className="secondary-button" onClick={() => printWithMode("A4")}>PDF Export</button>
            <button className="whatsapp-button" onClick={sendWhatsApp}><Icon name="message" /> Send on WhatsApp</button>
            <button aria-label="Close invoice" className="remove-button" onClick={onClose}><Icon name="close" /></button>
          </div>
        </div>
        <article className={`invoice-paper ${activePrintMode === "A4" ? "invoice-a4" : "invoice-thermal"} ${printSettings.receipt_width === "58MM" ? "invoice-58mm" : "invoice-80mm"}`}>
          <header className="invoice-header">
            <BrandLogo invoice />
            <div className="invoice-meta">
              <strong>Tax Invoice</strong>
              <span>{printSettings.business_name || "FroozERP Retail"}</span>
              <span>{invoice.invoice_no}</span>
              <span>{new Date(invoice.created_at).toLocaleString("en-IN")}</span>
            </div>
          </header>
          <section className="invoice-customer">
            <div><small>Billed To</small><strong>{invoice.customer_name || "Walk-in Customer"}</strong><span>{invoice.customer_mobile || "No mobile number"}</span></div>
            <div><small>Payment</small><strong>{invoice.payment_mode}</strong><span>{invoice.branch_name || "SRT Retail Store"}</span></div>
            <div><small>Status</small><strong>{invoice.sale_status || "COMPLETED"}</strong><span>{invoice.cancellation_reason || invoice.edit_reason || "No changes recorded"}</span></div>
          </section>
          <table className="invoice-table">
            <thead><tr><th>Item</th><th>Qty</th><th>Rate</th><th>Discount</th><th>Amount</th></tr></thead>
            <tbody>
              {invoice.items?.map((item) => (
                <tr key={item.product_id || item.id}>
                  <td>{item.product_name}</td>
                  <td>{item.quantity} {item.unit}</td>
                  <td>{receiptCurrency.format(Number(item.selling_rate))}</td>
                  <td>{receiptCurrency.format(Number(item.discount_amount || 0))}</td>
                  <td>{receiptCurrency.format(Number(item.net_amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <section className="invoice-total-box">
            <ThermalTotalLine label="Gross Total" value={Number(invoice.gross_amount)} />
            <ThermalTotalLine label="Discount" value={-(Number(invoice.item_discount_amount) + Number(invoice.invoice_discount_amount))} />
            <ThermalTotalLine label="Tax" value={Number(invoice.tax_amount || 0)} />
            <ThermalTotalLine label="Net Payable" total value={Number(invoice.total_amount)} />
          </section>
          {shouldShowUpiQr && upiQrDataUrl && (
            <section className="upi-qr-box">
              <img alt="UPI payment QR" src={upiQrDataUrl} />
              <div>
                <strong>Scan to pay</strong>
                <span>{paymentSettings.business_upi_id}</span>
                <small>{receiptCurrency.format(Number(invoice.total_amount || 0))} - {invoice.invoice_no}</small>
              </div>
            </section>
          )}
          <footer className="invoice-footer">
            <strong>Thank you for shopping with FEEL THE FREAKIN&apos; FROOZ.</strong>
            <span>We appreciate your business.</span>
            <small>GST-ready invoice - Powered by SRT Company</small>
          </footer>
        </article>
      </section>
    </div>
  );
}

function PurchaseSummary({ summary }) {
  return (
    <section className="purchase-summary">
      <div className="purchase-summary-heading">
        <div>
          <span className="eyebrow">Landed Cost Preview</span>
          <h3>Purchase Calculation</h3>
        </div>
        <span className="origin-rate">Mandi Tax {summary.mandiTaxPercent}%</span>
      </div>
      <div className="purchase-summary-grid">
        <SummaryMetric label="Basic Amount" value={currency.format(summary.basicAmount)} />
        <SummaryMetric label={`Mandi Tax (${summary.mandiTaxPercent}%)`} value={currency.format(summary.mandiTaxAmount)} />
        <SummaryMetric label="Freight Charges" value={currency.format(summary.freightCharges)} />
        <SummaryMetric label="Labour Charges" value={currency.format(summary.labourCharges)} />
        <SummaryMetric label="Other Charges" value={currency.format(summary.otherCharges)} />
        <SummaryMetric label="Gross Amount" value={currency.format(summary.grossAmount)} />
        <SummaryMetric label={`Supplier Rebate (${summary.rebatePercent}%)`} value={`-${currency.format(summary.rebateAmount)}`} positive />
        <SummaryMetric label="Net Payable" value={currency.format(summary.netPayable)} featured />
        <SummaryMetric label="Pending Balance" value={currency.format(summary.balanceAmount)} />
        <SummaryMetric label="Payment Status" value={summary.paymentStatus} />
        <SummaryMetric label="Effective Cost / Unit" value={currency.format(summary.effectiveCostPerUnit)} featured />
      </div>
    </section>
  );
}

const chartSize = { width: 640, height: 250, padding: 34 };
const chartCurrency = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
  notation: "compact",
});

const formatChartDate = (date) =>
  new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

const formatChartMoney = (value) => `INR ${chartCurrency.format(Number(value || 0))}`;

const getChartPoints = (data, valueKey, maxValue) => {
  const innerWidth = chartSize.width - chartSize.padding * 2;
  const innerHeight = chartSize.height - chartSize.padding * 2;
  return data.map((row, index) => {
    const x = chartSize.padding + (data.length > 1 ? (index / (data.length - 1)) * innerWidth : innerWidth / 2);
    const y = chartSize.height - chartSize.padding - (Number(row[valueKey] || 0) / maxValue) * innerHeight;
    return { x, y, value: Number(row[valueKey] || 0), date: row.date };
  });
};

function ChartFrame({ children, empty, subtitle, title }) {
  return (
    <section className="chart-card">
      <div className="chart-card-heading">
        <div>
          <span className="eyebrow">{subtitle}</span>
          <h3>{title}</h3>
        </div>
      </div>
      {empty ? <div className="chart-empty">No values recorded for this period.</div> : children}
    </section>
  );
}

function LineChart({ color = "#f59e0b", data, subtitle, title, valueKey }) {
  const rows = data || [];
  const maxValue = Math.max(1, ...rows.map((row) => Number(row[valueKey] || 0)));
  const points = getChartPoints(rows, valueKey, maxValue);
  const pointString = points.map((point) => `${point.x},${point.y}`).join(" ");

  return (
    <ChartFrame empty={!rows.length} subtitle={subtitle} title={title}>
      <svg className="chart-svg" role="img" viewBox={`0 0 ${chartSize.width} ${chartSize.height}`}>
        {[0.25, 0.5, 0.75].map((mark) => (
          <line
            className="chart-grid-line"
            key={mark}
            x1={chartSize.padding}
            x2={chartSize.width - chartSize.padding}
            y1={chartSize.padding + mark * (chartSize.height - chartSize.padding * 2)}
            y2={chartSize.padding + mark * (chartSize.height - chartSize.padding * 2)}
          />
        ))}
        <polyline className="chart-line-glow" points={pointString} style={{ stroke: color }} />
        <polyline className="chart-line" points={pointString} style={{ stroke: color }} />
        {points.map((point) => (
          <circle className="chart-point" cx={point.x} cy={point.y} key={`${point.date}-${point.x}`} r="4" style={{ fill: color }}>
            <title>{`${formatChartDate(point.date)}: ${formatChartMoney(point.value)}`}</title>
          </circle>
        ))}
        <text className="chart-axis-label" x={chartSize.padding} y={chartSize.height - 8}>{rows[0] ? formatChartDate(rows[0].date) : ""}</text>
        <text className="chart-axis-label chart-axis-label-end" x={chartSize.width - chartSize.padding} y={chartSize.height - 8}>{rows.at(-1) ? formatChartDate(rows.at(-1).date) : ""}</text>
        <text className="chart-axis-label" x={chartSize.padding} y="20">{formatChartMoney(maxValue)}</text>
      </svg>
    </ChartFrame>
  );
}

function BarChart({ color = "#f59e0b", data, subtitle, title, valueKey }) {
  const rows = data || [];
  const maxValue = Math.max(1, ...rows.map((row) => Number(row[valueKey] || 0)));
  const innerWidth = chartSize.width - chartSize.padding * 2;
  const innerHeight = chartSize.height - chartSize.padding * 2;
  const barSlot = rows.length ? innerWidth / rows.length : innerWidth;
  return (
    <ChartFrame empty={!rows.length} subtitle={subtitle} title={title}>
      <svg className="chart-svg" role="img" viewBox={`0 0 ${chartSize.width} ${chartSize.height}`}>
        {[0.25, 0.5, 0.75].map((mark) => (
          <line
            className="chart-grid-line"
            key={mark}
            x1={chartSize.padding}
            x2={chartSize.width - chartSize.padding}
            y1={chartSize.padding + mark * innerHeight}
            y2={chartSize.padding + mark * innerHeight}
          />
        ))}
        {rows.map((row, index) => {
          const value = Number(row[valueKey] || 0);
          const height = (value / maxValue) * innerHeight;
          const x = chartSize.padding + index * barSlot + barSlot * 0.18;
          const y = chartSize.height - chartSize.padding - height;
          return (
            <rect className="chart-bar" height={Math.max(height, value > 0 ? 3 : 0)} key={row.date} rx="5" style={{ fill: color }} width={barSlot * 0.64} x={x} y={y}>
              <title>{`${formatChartDate(row.date)}: ${formatChartMoney(value)}`}</title>
            </rect>
          );
        })}
        <text className="chart-axis-label" x={chartSize.padding} y={chartSize.height - 8}>{rows[0] ? formatChartDate(rows[0].date) : ""}</text>
        <text className="chart-axis-label chart-axis-label-end" x={chartSize.width - chartSize.padding} y={chartSize.height - 8}>{rows.at(-1) ? formatChartDate(rows.at(-1).date) : ""}</text>
        <text className="chart-axis-label" x={chartSize.padding} y="20">{formatChartMoney(maxValue)}</text>
      </svg>
    </ChartFrame>
  );
}

function DualLineChart({ data, firstKey, firstLabel, secondKey, secondLabel, subtitle, title }) {
  const rows = data || [];
  const maxValue = Math.max(1, ...rows.flatMap((row) => [Number(row[firstKey] || 0), Number(row[secondKey] || 0)]));
  const firstPoints = getChartPoints(rows, firstKey, maxValue);
  const secondPoints = getChartPoints(rows, secondKey, maxValue);
  return (
    <ChartFrame empty={!rows.length} subtitle={subtitle} title={title}>
      <div className="chart-legend">
        <span><i className="legend-dot legend-dot-sales" />{firstLabel}</span>
        <span><i className="legend-dot legend-dot-purchase" />{secondLabel}</span>
      </div>
      <svg className="chart-svg" role="img" viewBox={`0 0 ${chartSize.width} ${chartSize.height}`}>
        {[0.25, 0.5, 0.75].map((mark) => (
          <line
            className="chart-grid-line"
            key={mark}
            x1={chartSize.padding}
            x2={chartSize.width - chartSize.padding}
            y1={chartSize.padding + mark * (chartSize.height - chartSize.padding * 2)}
            y2={chartSize.padding + mark * (chartSize.height - chartSize.padding * 2)}
          />
        ))}
        <polyline className="chart-line" points={firstPoints.map((point) => `${point.x},${point.y}`).join(" ")} style={{ stroke: "#f59e0b" }} />
        <polyline className="chart-line" points={secondPoints.map((point) => `${point.x},${point.y}`).join(" ")} style={{ stroke: "#38bdf8" }} />
        {[...firstPoints, ...secondPoints].map((point, index) => (
          <circle className="chart-point" cx={point.x} cy={point.y} key={`${point.date}-${index}`} r="3.5" style={{ fill: index < firstPoints.length ? "#f59e0b" : "#38bdf8" }}>
            <title>{`${formatChartDate(point.date)}: ${formatChartMoney(point.value)}`}</title>
          </circle>
        ))}
        <text className="chart-axis-label" x={chartSize.padding} y={chartSize.height - 8}>{rows[0] ? formatChartDate(rows[0].date) : ""}</text>
        <text className="chart-axis-label chart-axis-label-end" x={chartSize.width - chartSize.padding} y={chartSize.height - 8}>{rows.at(-1) ? formatChartDate(rows.at(-1).date) : ""}</text>
        <text className="chart-axis-label" x={chartSize.padding} y="20">{formatChartMoney(maxValue)}</text>
      </svg>
    </ChartFrame>
  );
}

function DashboardAnalytics({ analytics, customRange, onApplyCustomRange, onCustomRangeChange, onNavigate, onRangeChange, range }) {
  const data = analytics || emptyDashboardAnalytics;
  const topProducts = data.topSellingProducts || [];
  const lowStockItems = data.lowStockItems || [];
  const insights = data.insights || [];

  return (
    <section className="dashboard-analytics">
      <section className="content-card analytics-toolbar">
        <div>
          <span className="eyebrow">Owner Analytics</span>
          <h2>Business Graphs</h2>
          <p>Day-wise sales, profit, expenses and stock movement from live FroozERP records.</p>
        </div>
        <div className="dashboard-range-controls">
          <div className="range-buttons">
            {dashboardRanges.map(([value, label]) => (
              <button className={range === value ? "range-button range-button-active" : "range-button"} key={value} onClick={() => onRangeChange(value)} type="button">
                {label}
              </button>
            ))}
          </div>
          {range === "custom" && (
            <div className="dashboard-custom-range">
              <input type="date" value={customRange.date_from} onChange={(event) => onCustomRangeChange((current) => ({ ...current, date_from: event.target.value }))} />
              <input type="date" value={customRange.date_to} onChange={(event) => onCustomRangeChange((current) => ({ ...current, date_to: event.target.value }))} />
              <button className="primary-button" onClick={onApplyCustomRange} type="button">Apply</button>
            </div>
          )}
        </div>
      </section>

      <section className="chart-grid">
        <LineChart color="#f59e0b" data={data.salesTrend} subtitle="Revenue" title="Daily Sales Trend" valueKey="sales" />
        <LineChart color="#22c55e" data={data.profitTrend} subtitle="FIFO Landed Cost" title="Daily Profit Trend" valueKey="grossProfit" />
        <BarChart color="#fb7185" data={data.expenseTrend} subtitle="Operating Cost" title="Daily Expense Trend" valueKey="expenses" />
        <LineChart color="#a78bfa" data={data.netProfitTrend} subtitle="Profit After Expenses" title="Net Profit Trend" valueKey="netProfit" />
        <DualLineChart
          data={data.purchaseSalesComparison}
          firstKey="sales"
          firstLabel="Sales"
          secondKey="purchases"
          secondLabel="Purchases"
          subtitle="Movement"
          title="Purchase vs Sales Comparison"
        />
      </section>

      <section className="dashboard-side-grid">
        <section className="content-card insight-panel">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Owner Insights</span>
              <h2>What Changed</h2>
            </div>
          </div>
          <div className="insight-list">
            {insights.length ? insights.map((insight) => <p key={insight}>{insight}</p>) : <p>No insights available yet.</p>}
          </div>
        </section>

        <section className="content-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Products</span>
              <h2>Top Selling Products</h2>
            </div>
          </div>
          <div className="top-product-list">
            {topProducts.length ? topProducts.map((product) => (
              <article className="top-product-row" key={product.product_id}>
                <div>
                  <strong>{product.product_name}</strong>
                  <span>{Number(product.quantity_sold || 0).toLocaleString("en-IN")} {product.unit || "units"} sold</span>
                </div>
                <strong>{currency.format(Number(product.revenue || 0))}</strong>
              </article>
            )) : <div className="empty-inline">No product sales in this period.</div>}
          </div>
        </section>

        <section className="content-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Inventory</span>
              <h2>Low Stock Alerts</h2>
            </div>
            <button className="secondary-button" onClick={() => onNavigate("inventory")} type="button">Open Inventory</button>
          </div>
          <div className="low-stock-list">
            {lowStockItems.length ? lowStockItems.map((item) => (
              <button className="low-stock-row" key={item.product_id} onClick={() => onNavigate("inventory")} type="button">
                <div>
                  <strong>{item.product_name}</strong>
                  <span>Minimum {Number(item.minimum_stock || 0).toLocaleString("en-IN")} {item.unit || ""}</span>
                </div>
                <strong>{Number(item.current_stock || 0).toLocaleString("en-IN")} left</strong>
              </button>
            )) : <div className="empty-inline">No low stock products right now.</div>}
          </div>
        </section>
      </section>
    </section>
  );
}

function SummaryMetric({ featured = false, label, positive = false, value }) {
  return (
    <div className={featured ? "summary-metric summary-metric-featured" : "summary-metric"}>
      <span>{label}</span>
      <strong className={positive ? "profit-cell" : ""}>{value}</strong>
    </div>
  );
}

function Field({ children, label }) {
  return <label><span>{label}</span>{children}</label>;
}

function ModuleCard({ children, eyebrow, subtitle, title }) {
  return (
    <section className="content-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function DataTable({ children, headers }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{headers.map((header, index) => <th key={typeof header === "string" ? header : index}>{header}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export default App;
