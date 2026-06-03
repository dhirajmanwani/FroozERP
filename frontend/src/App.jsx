import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import "./App.css";

const API_URL = "http://localhost:5000";
const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
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
};

const defaultSaleRateSettings = {
  desired_margin_percent: 25,
  rounding_rule: "NEAREST_RUPEE",
  suggestion_enabled: true,
  notes: "",
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
  const [purchaseRules, setPurchaseRules] = useState(defaultPurchaseRules);
  const [settingsRules, setSettingsRules] = useState(defaultPurchaseRules);
  const [settingsData, setSettingsData] = useState({
    businessSettings: defaultBusinessSettings,
    saleRateSettings: defaultSaleRateSettings,
    discountRules: [],
    roles: [],
    backupSettings: {},
    canManageSettings: false,
  });
  const [discountRules, setDiscountRules] = useState([]);
  const [saleRates, setSaleRates] = useState([]);
  const [saleRateHistory, setSaleRateHistory] = useState([]);
  const [saleDesiredMargin, setSaleDesiredMargin] = useState("25");
  const [suppliers, setSuppliers] = useState([]);
  const [customers, setCustomers] = useState([]);
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
  const [purchaseType, setPurchaseType] = useState("CREDIT");
  const [purchasePaymentMode, setPurchasePaymentMode] = useState("CASH");
  const [purchasePaymentReference, setPurchasePaymentReference] = useState("");
  const [purchaseRebateRuleId, setPurchaseRebateRuleId] = useState("");
  const [purchasePaymentDate, setPurchasePaymentDate] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [editingSale, setEditingSale] = useState(null);
  const [changeHistory, setChangeHistory] = useState(null);

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
  }, [purchaseFreightCharges, purchaseLabourCharges, purchaseOtherCharges, purchasePaidAmount, purchaseQuantity, purchaseRateInput, purchaseRebateRuleId, purchaseRules, purchaseType, selectedPurchaseProduct]);

  const loadProducts = async () => {
    const response = await axios.get(`${API_URL}/products`);
    setProducts(response.data);
  };

  const loadPurchaseRules = async () => {
    const response = await axios.get(`${API_URL}/purchase-rules`);
    setPurchaseRules(response.data);
  };

  const loadSettingsData = async (currentUser = user) => {
    const response = await axios.get(`${API_URL}/settings`, { params: { user_id: currentUser?.id } });
    const data = response.data;
    const nextSaleRateSettings = { ...defaultSaleRateSettings, ...(data.saleRateSettings || {}) };
    setSettingsData({
      businessSettings: { ...defaultBusinessSettings, ...(data.businessSettings || {}) },
      saleRateSettings: nextSaleRateSettings,
      discountRules: data.discountRules || [],
      roles: data.roles || [],
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
      await Promise.all([loadProducts(), loadDashboardData(), loadPurchaseRules(), loadSupplierData(), loadCustomerData(), loadAccounts(), loadAccountOutstanding(), loadAccountPayments(), loadSettingsData(response.data)]);
    } catch (error) {
      alert(getErrorMessage(error, "Login Failed"));
    }
  };

  const addProduct = async () => {
    try {
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
      alert(editingProductId ? "Product Updated" : "Product Added");
    } catch (error) {
      alert(getErrorMessage(error, "Error Adding Product"));
    }
  };

  const savePurchase = async () => {
    try {
      await axios.post(`${API_URL}/purchase`, {
        supplier_id: purchaseSupplierId,
        product_id: purchaseProductId,
        quantity: purchaseQuantity,
        purchase_rate: purchaseRateInput,
        freight_charges: purchaseFreightCharges,
        labour_charges: purchaseLabourCharges,
      other_charges: purchaseOtherCharges,
      paid_amount: purchaseType === "CASH" ? purchasePaidAmount : 0,
      rebate_rule_id: purchaseRebateRuleId,
      payment_date: purchasePaymentDate || null,
      purchase_type: purchaseType,
      payment_mode: purchaseType === "CASH" ? purchasePaymentMode : null,
      payment_reference_number: purchaseType === "CASH" ? purchasePaymentReference : null,
      branch_id: user.branch_id,
      created_by: user.id,
      });
      setPurchaseSupplierId("");
      setPurchaseProductId("");
      setPurchaseQuantity("");
      setPurchaseRateInput("");
      setPurchaseFreightCharges("");
      setPurchaseLabourCharges("");
      setPurchaseOtherCharges("");
      setPurchasePaidAmount("");
      setPurchaseType("CREDIT");
      setPurchasePaymentMode("CASH");
      setPurchasePaymentReference("");
      setPurchaseRebateRuleId("");
      setPurchasePaymentDate("");
      await Promise.all([loadDashboardData(), loadSupplierData(), loadAccounts(), loadAccountOutstanding()]);
      alert("Purchase Saved");
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

  const navigate = async (view) => {
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
      if (view === "accounts") {
        await Promise.all([loadAccounts(), loadCustomerData(), loadSupplierData(), loadAccountOutstanding()]);
      }
      if (view === "reports") await loadReports();
      if (view === "expenses") await loadExpenses();
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
          {navigationItems.filter(([view]) => canManageRates || view !== "sale-rates").map(([view, label]) => (
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
        <div className="sidebar-profile">
          <div className="user-avatar">{user.full_name.charAt(0)}</div>
          <div>
            <strong>{user.full_name}</strong>
            <small>{user.role}</small>
          </div>
          <button aria-label="Log out" className="logout-button" onClick={() => setUser(null)}>
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
                    <td><button className="table-action" onClick={() => editProduct(product)}>Edit</button></td>
                  </tr>
                ))}
              </DataTable>
            </ModuleCard>
          )}

          {activeView === "purchase" && (
            <ModuleCard eyebrow="Procurement" title="Purchase Entry" subtitle="Record incoming stock and supplier purchase details.">
              <div className="form-grid">
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
                <Field label="Product">
                  <select value={purchaseProductId} onChange={selectPurchaseProduct}>
                    <option value="">Select product</option>
                    {products.map((product) => <option key={product.id} value={product.id}>{product.product_name}</option>)}
                  </select>
                </Field>
                <Field label="Quantity"><input type="number" min="0" step="0.001" value={purchaseQuantity} onChange={(event) => setPurchaseQuantity(event.target.value)} /></Field>
                <Field label="Purchase Rate"><input type="number" min="0" step="0.01" value={purchaseRateInput} onChange={(event) => setPurchaseRateInput(event.target.value)} /></Field>
                <Field label="Freight Charges"><input type="number" min="0" step="0.01" value={purchaseFreightCharges} onChange={(event) => setPurchaseFreightCharges(event.target.value)} /></Field>
                <Field label="Labour Charges"><input type="number" min="0" step="0.01" value={purchaseLabourCharges} onChange={(event) => setPurchaseLabourCharges(event.target.value)} /></Field>
                <Field label="Other Charges"><input type="number" min="0" step="0.01" value={purchaseOtherCharges} onChange={(event) => setPurchaseOtherCharges(event.target.value)} /></Field>
                <Field label="Payment Timing / Rebate Rule">
                  <select value={purchaseRebateRuleId} onChange={(event) => setPurchaseRebateRuleId(event.target.value)}>
                    <option value="">Select rebate rule</option>
                    {purchaseRules.rebateRules.map((rule) => <option key={rule.id} value={rule.id}>{rule.rule_name} - {rule.pay_within_days} days - {rule.rebate_percent}%</option>)}
                  </select>
                </Field>
                <Field label="Purchase Type">
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
              {activeSuppliers.length === 0 && <p className="form-note">No active supplier accounts found. Add New Supplier before saving a purchase.</p>}
              <PurchaseSummary summary={purchaseSummary} />
              <div className="button-row">
                <button className="primary-button" onClick={savePurchase}>Save Purchase</button>
                <button className="secondary-button" onClick={() => navigate("accounts")}>Add New Supplier</button>
              </div>
            </ModuleCard>
          )}

          {activeView === "accounts" && (
            <AccountsModule
              accounts={accounts}
              accountLedger={accountLedger}
              accountPayments={accountPayments}
              accountOutstanding={accountOutstanding}
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

          {activeView === "sales" && (
            <PosBilling
              customers={customers.filter((customer) => customer.active !== false)}
              discountRules={discountRules}
              inventory={inventory}
              onInvoice={setSelectedInvoice}
              onSaved={loadDashboardData}
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
            <ReportsModule data={reportsData} onReload={loadReports} />
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
      {selectedInvoice && <InvoiceModal invoice={selectedInvoice} onClose={() => setSelectedInvoice(null)} />}
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
    </main>
  );
}

function ReportToolbar({ onPrint, title }) {
  return (
    <div className="report-toolbar no-print">
      <strong>{title}</strong>
      <div className="button-row">
        <button className="secondary-button" onClick={onPrint}><Icon name="print" /> Print</button>
        <button className="secondary-button" onClick={onPrint}>PDF Export</button>
      </div>
    </div>
  );
}

function PrintableReport({ children, title }) {
  const printReport = () => window.print();
  return (
    <section className="print-section">
      <ReportToolbar onPrint={printReport} title={title} />
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

function ReportsModule({ data, onReload }) {
  const [range, setRange] = useState("today");
  const [customRange, setCustomRange] = useState({
    date_from: toDateKey(new Date()),
    date_to: toDateKey(new Date()),
  });
  const refreshReports = async () => {
    const params = range === "custom" ? customRange : { range };
    await onReload(params);
  };
  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Reports" title="Business Reports" subtitle="Operational summaries generated from live sales, purchases, suppliers, customers and discounts.">
        <div className="ledger-toolbar">
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
          <button className="secondary-button" onClick={refreshReports}>Refresh Reports</button>
        </div>
      </ModuleCard>
      <ModuleCard eyebrow="Sales Report" title="Sales by Date" subtitle="Completed invoices only; cancelled bills are excluded.">
        <PrintableReport title="Sales Report">
          <DataTable headers={["Date", "Transactions", "Sales", "Cost", "Profit"]}>
            {(data.salesReport || []).map((row) => <tr key={row.sale_date}><td>{row.sale_date}</td><td>{row.transaction_count}</td><td>{currency.format(Number(row.total_sales || 0))}</td><td>{currency.format(Number(row.total_cost || 0))}</td><td className="profit-cell">{currency.format(Number(row.total_profit || 0))}</td></tr>)}
          </DataTable>
        </PrintableReport>
      </ModuleCard>
      <ModuleCard eyebrow="Purchase Report" title="Purchases by Date" subtitle="Gross purchase, rebates, net purchase cost and balance.">
        <PrintableReport title="Purchase Report">
          <DataTable headers={["Date", "Bills", "Gross", "Rebate", "Net", "Paid", "Balance"]}>
            {(data.purchaseReport || []).map((row) => <tr key={row.purchase_date}><td>{row.purchase_date}</td><td>{row.purchase_count}</td><td>{currency.format(Number(row.gross_purchase || 0))}</td><td>{currency.format(Number(row.rebate_received || 0))}</td><td>{currency.format(Number(row.net_purchase || 0))}</td><td>{currency.format(Number(row.paid_amount || 0))}</td><td className="balance-cell">{currency.format(Number(row.balance_amount || 0))}</td></tr>)}
          </DataTable>
        </PrintableReport>
      </ModuleCard>
      <ModuleCard eyebrow="Expense Report" title="Expenses by Date" subtitle="Daily operating costs by category and payment mode.">
        <PrintableReport title="Expense Report">
          <DataTable headers={["Date", "Category", "Payment", "Entries", "Amount"]}>
            {(data.expenseReport || []).map((row) => <tr key={`${row.expense_date}-${row.category}-${row.payment_mode}`}><td>{row.expense_date}</td><td>{row.category}</td><td><span className="tag">{row.payment_mode}</span></td><td>{row.expense_count}</td><td>{currency.format(Number(row.total_expense || 0))}</td></tr>)}
          </DataTable>
        </PrintableReport>
      </ModuleCard>
      <ModuleCard eyebrow="Payment Report" title="Payments and Receipts" subtitle="Supplier payments, supplier rebates and customer receipts.">
        <PrintableReport title="Payment Report">
          <DataTable headers={["Date", "Type", "Party", "Payment", "Rebate", "Mode", "Status", "Reference"]}>
            {(data.paymentReport || []).map((row, index) => <tr key={`${row.payment_date}-${row.party_name}-${index}`}><td>{row.payment_date}</td><td><span className="tag">{row.payment_type}</span></td><td className="primary-cell">{row.party_name}</td><td>{currency.format(Number(row.payment_amount || 0))}</td><td>{currency.format(Number(row.rebate_amount || 0))}</td><td>{row.payment_mode}</td><td><span className={row.cancelled ? "stock-low" : "stock-ok"}>{row.cancelled ? "Cancelled" : "Active"}</span></td><td>{row.reference_number || "-"}</td></tr>)}
          </DataTable>
        </PrintableReport>
      </ModuleCard>
      <ModuleCard eyebrow="Supplier Outstanding" title="Supplier Outstanding Report" subtitle="Supplier payable balances after payments and rebates.">
        <PrintableReport title="Supplier Outstanding Report">
          <DataTable headers={["Supplier", "Purchases", "Paid", "Rebate", "Outstanding"]}>
            {(data.supplierOutstandingReport || []).map((row) => <tr key={row.id}><td className="primary-cell">{row.supplier_name}</td><td>{currency.format(Number(row.total_purchases || 0))}</td><td>{currency.format(Number(row.total_paid || 0))}</td><td>{currency.format(Number(row.total_rebate_received || 0))}</td><td className="balance-cell">{currency.format(Number(row.outstanding_balance || 0))}</td></tr>)}
          </DataTable>
        </PrintableReport>
      </ModuleCard>
      <ModuleCard eyebrow="Customer Outstanding" title="Customer Outstanding Report" subtitle="Customer receivable balances after receipts.">
        <PrintableReport title="Customer Outstanding Report">
          <DataTable headers={["Customer", "Type", "Sales", "Paid", "Outstanding"]}>
            {(data.customerOutstandingReport || []).map((row) => <tr key={row.id}><td className="primary-cell">{row.customer_name}</td><td><span className="tag">{row.customer_type}</span></td><td>{currency.format(Number(row.total_sales || 0))}</td><td>{currency.format(Number(row.total_paid || 0))}</td><td className="balance-cell">{currency.format(Number(row.outstanding_balance || 0))}</td></tr>)}
          </DataTable>
        </PrintableReport>
      </ModuleCard>
      <ModuleCard eyebrow="Discount Report" title="Discounts Given" subtitle="Bill and item discounts grouped by date and payment mode.">
        <PrintableReport title="Discount Report">
          <DataTable headers={["Date", "Payment", "Invoices", "Item Discount", "Bill Discount", "Total Discount"]}>
            {(data.discountReport || []).map((row) => <tr key={`${row.sale_date}-${row.payment_mode}`}><td>{row.sale_date}</td><td><span className="tag">{row.payment_mode}</span></td><td>{row.invoice_count}</td><td>{currency.format(Number(row.item_discount || 0))}</td><td>{currency.format(Number(row.bill_discount || 0))}</td><td className="profit-cell">{currency.format(Number(row.total_discount || 0))}</td></tr>)}
          </DataTable>
        </PrintableReport>
      </ModuleCard>
      <ModuleCard eyebrow="Balance Sheet" title="Basic Balance Sheet" subtitle="Assets, liabilities and net position prepared from live ERP balances.">
        <PrintableReport title="Balance Sheet">
          <div className="purchase-summary-grid supplier-payment-preview">
            <SummaryMetric label="Cash" value={currency.format(Number(data.balanceSheet?.cash || 0))} />
            <SummaryMetric label="Bank" value={currency.format(Number(data.balanceSheet?.bank || 0))} />
            <SummaryMetric label="Inventory" value={currency.format(Number(data.balanceSheet?.inventory || 0))} />
            <SummaryMetric label="Customer Receivable" value={currency.format(Number(data.balanceSheet?.customerReceivable || 0))} />
            <SummaryMetric label="Supplier Payable" value={currency.format(Number(data.balanceSheet?.supplierPayable || 0))} />
            <SummaryMetric label="Net Position" value={currency.format(Number(data.balanceSheet?.netPosition || 0))} featured />
          </div>
        </PrintableReport>
      </ModuleCard>
      <ModuleCard eyebrow="Profit & Loss" title="P&L Report" subtitle="Sales less FIFO purchase cost and expenses, plus supplier rebate received.">
        <PrintableReport title="Profit and Loss Report">
          <div className="purchase-summary-grid supplier-payment-preview">
            <SummaryMetric label="Sales Revenue" value={currency.format(Number(data.profitLoss?.salesRevenue || 0))} />
            <SummaryMetric label="Purchase Cost" value={currency.format(Number(data.profitLoss?.purchaseCost || 0))} />
            <SummaryMetric label="Expenses" value={currency.format(Number(data.profitLoss?.expenses || 0))} />
            <SummaryMetric label="Supplier Rebate Received" value={currency.format(Number(data.profitLoss?.supplierRebateReceived || 0))} positive />
            <SummaryMetric label="Gross Profit" value={currency.format(Number(data.profitLoss?.grossProfit || 0))} />
            <SummaryMetric label="Net Profit" value={currency.format(Number(data.profitLoss?.netProfit || 0))} featured />
          </div>
        </PrintableReport>
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

function AccountsModule({ accounts, accountLedger, accountOutstanding, accountPayments, onLedgerLoad, onPaymentsLoad, onReload, user }) {
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
  const [tab, setTab] = useState("master");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(emptyAccount);
  const [editingKey, setEditingKey] = useState("");
  const [ledgerMode, setLedgerMode] = useState("ANY");
  const [ledgerAccountKey, setLedgerAccountKey] = useState("");
  const [ledgerDateRange, setLedgerDateRange] = useState({ date_from: "", date_to: "" });
  const [payment, setPayment] = useState({
    payment_action: "RECEIVE_CUSTOMER",
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
        {[
          ["master", "Account Master"],
          ["ledger", "Ledger"],
          ["payments", "Payments"],
          ["outstanding", "Outstanding"],
        ].map(([value, label]) => (
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
                {accountPaymentActions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
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
      <MandiTaxSettings canManage={canManage} onReload={onReload} rules={rules.mandiTaxRules} user={user} />
      <RebateSettings canManage={canManage} onReload={onReload} rules={rules.rebateRules} user={user} />
      <SaleRateSettingsSection canManage={canManage} key={settingsData.saleRateSettings?.updated_at || "sale-rate-settings"} onReload={onReload} saleRateSettings={settingsData.saleRateSettings} user={user} />
      <DiscountSettings canManage={canManage} discountRules={settingsData.discountRules} onReload={onReload} user={user} />
      <PermissionSettings roles={settingsData.roles} />
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
        <Field label="Address"><textarea disabled={!canManage} value={draft.address || ""} onChange={(event) => updateDraft("address", event.target.value)} /></Field>
        <Field label="Invoice Footer Text"><textarea disabled={!canManage} value={draft.invoice_footer_text || ""} onChange={(event) => updateDraft("invoice_footer_text", event.target.value)} /></Field>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={save}>Save Business Settings</button>
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

function PermissionSettings({ roles }) {
  return (
    <ModuleCard eyebrow="User & Permission Settings" title="Role Control Matrix" subtitle="Sensitive settings are restricted to Owner/Admin users.">
      <div className="permission-grid">
        {(roles.length ? roles : [
          { role: "Owner", permissions: ["Full access"] },
          { role: "Admin", permissions: ["Settings management"] },
          { role: "Cashier", permissions: ["POS only"] },
          { role: "Purchase Manager", permissions: ["Purchase and suppliers"] },
          { role: "Inventory Manager", permissions: ["Inventory control"] },
        ]).map((role) => (
          <article className="permission-card" key={role.role}>
            <strong>{role.role}</strong>
            <span>{role.permissions.join(", ")}</span>
          </article>
        ))}
      </div>
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
  const categories = [...new Set(rates.map((rate) => rate.category).filter(Boolean))];
  const filteredRates = rates.filter((rate) =>
    rate.product_name.toLowerCase().includes(search.toLowerCase()) &&
    (!origin || rate.origin_type === origin) &&
    (!category || rate.category === category)
  );

  const saveRates = async () => {
    const updates = Object.entries(draftRates)
      .filter(([, value]) => Number(value) > 0)
      .map(([productId, value]) => ({ product_id: Number(productId), new_selling_rate: Number(value) }));
    try {
      await axios.post(`${API_URL}/sale-rates/bulk`, { updates, changed_by: user.id });
      setDraftRates({});
      await onReload();
      alert("Selling rates updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update selling rates"));
    }
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
          <button className="primary-button" onClick={saveRates}>Bulk Save Rates</button>
        </div>
        <DataTable headers={["Product", "Origin", "Current Rate", "Suggested Rate", "New Rate", "Latest Landed Cost", "Stock", "Margin", "Updated", "Updated By"]}>
          {filteredRates.map((rate) => {
            const sellingRate = Number(draftRates[rate.id] || rate.selling_rate);
            const cost = Number(rate.latest_effective_cost || 0);
            const margin = sellingRate > 0 ? ((sellingRate - cost) / sellingRate) * 100 : 0;
            return (
              <tr key={rate.id}>
                <td className="primary-cell">{rate.product_name}<small className="cell-note">{rate.category}</small></td>
                <td><span className="tag">{rate.origin_type}</span></td>
                <td>{currency.format(Number(rate.selling_rate))}</td>
                <td className="profit-cell">{currency.format(Number(rate.suggested_selling_rate))}</td>
                <td><input className="table-input" min="0" step="0.01" type="number" value={draftRates[rate.id] || ""} onChange={(event) => setDraftRates({ ...draftRates, [rate.id]: event.target.value })} /></td>
                <td>{currency.format(cost)}</td>
                <td>{rate.current_stock}</td>
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

function PosBilling({ customers = [], discountRules = [], inventory, onInvoice, onSaved, products, user }) {
  const [search, setSearch] = useState("");
  const [barcode, setBarcode] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [cart, setCart] = useState([]);
  const [paymentMode, setPaymentMode] = useState("CASH");
  const [mixedPayments, setMixedPayments] = useState({ CASH: "", UPI: "", CARD: "" });
  const [customer, setCustomer] = useState({ name: "", mobile: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const searchRef = useRef(null);
  const barcodeRef = useRef(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

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
    searchRef.current?.focus();
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

  const removeCartItem = (productId) => {
    setCart((items) => items.filter((item) => item.product_id !== productId));
  };

  const scanBarcode = () => {
    const code = barcode.trim();
    if (!code) return;
    const product = products.find((item) => item.barcode === code);
    if (!product) {
      alert(`No product is assigned to barcode ${code}`);
    } else {
      addProduct(product);
    }
    setBarcode("");
    barcodeRef.current?.focus();
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

  const checkout = async () => {
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
      onInvoice(response.data.sale);
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
      checkout();
    }
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
                      <td><input className="table-input" min="0.001" step="0.001" type="number" value={item.quantity} onChange={(event) => updateCartItem(item.product_id, "quantity", event.target.value)} /></td>
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
        <button className="primary-button checkout-button" disabled={saving} onClick={checkout}>
          <Icon name="receipt" /> {saving ? "Saving Invoice..." : "Complete Checkout"}
        </button>
      </aside>
    </section>
  );
}

function TotalLine({ label, muted, total, value }) {
  return <div className={`${total ? "total-line total-line-main" : "total-line"} ${muted ? "total-line-muted" : ""}`}><span>{label}</span><strong>{currency.format(value)}</strong></div>;
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
            <button className="secondary-button" onClick={() => window.print()}><Icon name="print" /> Print / PDF</button>
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

function InvoiceModal({ invoice, onClose }) {
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
            <button className="secondary-button" onClick={() => window.print()}><Icon name="print" /> Print / Save PDF</button>
            <button className="whatsapp-button" onClick={sendWhatsApp}><Icon name="message" /> Send on WhatsApp</button>
            <button aria-label="Close invoice" className="remove-button" onClick={onClose}><Icon name="close" /></button>
          </div>
        </div>
        <article className="invoice-paper">
          <header className="invoice-header">
            <BrandLogo invoice />
            <div className="invoice-meta">
              <strong>Tax Invoice</strong>
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
                  <td>{currency.format(Number(item.selling_rate))}</td>
                  <td>{currency.format(Number(item.discount_amount || 0))}</td>
                  <td>{currency.format(Number(item.net_amount))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <section className="invoice-total-box">
            <TotalLine label="Subtotal" value={Number(invoice.gross_amount)} />
            <TotalLine label="Discount" value={-(Number(invoice.item_discount_amount) + Number(invoice.invoice_discount_amount))} />
            <TotalLine label="Tax" value={Number(invoice.tax_amount || 0)} />
            <TotalLine label="Grand Total" total value={Number(invoice.total_amount)} />
          </section>
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
        <thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export default App;
