import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import "./App.css";

const API_URL = "http://localhost:5000";
const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
});
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
  customers: "users",
  reports: "chart",
  settings: "settings",
  "sale-rates": "trend",
  "account-manager": "users",
  "supplier-payments": "wallet",
  "supplier-ledger": "history",
};

const navigationItems = [
  ["dashboard", "Dashboard"],
  ["products", "Products"],
  ["purchase", "Purchase Entry"],
  ["account-manager", "Account Manager"],
  ["inventory", "Inventory"],
  ["sales", "POS Billing"],
  ["sales-history", "Sales History"],
  ["supplier-payments", "Supplier Payments"],
  ["supplier-ledger", "Supplier Ledger"],
  ["sale-rates", "Sale Rate Update"],
  ["expenses", "Expenses"],
  ["customers", "Customers"],
  ["reports", "Reports"],
  ["settings", "Settings"],
];

const getErrorMessage = (error, fallback) =>
  error.response?.data?.message || fallback;

const toDateKey = (date) =>
  typeof date === "string" ? date.slice(0, 10) : date.toLocaleDateString("en-CA");

const supplierTypes = [
  ["LOCAL_SUPPLIER", "Local Supplier"],
  ["IMPORTED_SUPPLIER", "Imported Supplier"],
  ["COMMISSION_AGENT", "Commission Agent"],
  ["TRANSPORT_VENDOR", "Transport Vendor"],
];

const supplierPaymentModes = [
  ["CASH", "Cash"],
  ["UPI", "UPI"],
  ["BANK_TRANSFER", "Bank Transfer"],
  ["CHEQUE", "Cheque"],
];

const customerTypes = [
  ["RETAIL", "Retail"],
  ["WHOLESALE", "Wholesale"],
];

const customerPaymentModes = [
  ["CASH", "Cash"],
  ["UPI", "UPI"],
  ["CARD", "Card"],
  ["BANK_TRANSFER", "Bank Transfer"],
];

const discountTypes = [
  ["FLAT_AMOUNT", "Flat Amount"],
  ["PERCENTAGE", "Percentage"],
];

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

const emptySupplierForm = {
  supplier_name: "",
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
  notes: "",
  opening_balance: "",
  supplier_type: "LOCAL_SUPPLIER",
  active: true,
};

const emptyCustomerForm = {
  customer_name: "",
  customer_type: "RETAIL",
  mobile_number: "",
  address: "",
  gst_number: "",
  notes: "",
  opening_balance: "",
  active: true,
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
  const [supplierSummary, setSupplierSummary] = useState([]);
  const [supplierPayments, setSupplierPayments] = useState([]);
  const [supplierLedger, setSupplierLedger] = useState({ suppliers: [], ledger: [] });
  const [ledgerSupplierId, setLedgerSupplierId] = useState("");
  const [customers, setCustomers] = useState([]);
  const [customerSummary, setCustomerSummary] = useState([]);
  const [customerLedger, setCustomerLedger] = useState({ customers: [], ledger: [] });
  const [ledgerCustomerId, setLedgerCustomerId] = useState("");
  const [reportsData, setReportsData] = useState({
    salesReport: [],
    purchaseReport: [],
    supplierOutstandingReport: [],
    customerOutstandingReport: [],
    discountReport: [],
  });
  const [expenses, setExpenses] = useState([]);
  const [supplierDashboard, setSupplierDashboard] = useState({
    todaySales: 0,
    todayProfit: 0,
    stockValue: 0,
    lowStockItems: 0,
    transactions: 0,
    supplierOutstanding: 0,
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
    const metrics = {
      todaySales: supplierDashboard.todaySales ?? total(todaysSales, "amount"),
      todayProfit: supplierDashboard.todayProfit ?? total(todaysSales, "profit"),
      stockValue: supplierDashboard.stockValue ?? stockValue,
      lowStockItems: supplierDashboard.lowStockItems ?? lowStockItems,
      transactions: supplierDashboard.transactions ?? todaysSales.length,
      supplierOutstanding: supplierDashboard.supplierOutstanding ?? supplierDashboard.total_supplier_outstanding ?? 0,
      totalRebateReceived: supplierDashboard.totalRebateReceived ?? supplierDashboard.total_rebate_received ?? 0,
      todaySupplierPayments: supplierDashboard.todaySupplierPayments ?? supplierDashboard.todays_supplier_payments ?? 0,
    };

    return [
      ["Today's Sales", currency.format(Number(metrics.todaySales || 0)), "rupee"],
      ["Today's Profit", currency.format(Number(metrics.todayProfit || 0)), "trend"],
      ["Stock Value", currency.format(Number(metrics.stockValue || 0)), "layers"],
      ["Low Stock Items", Number(metrics.lowStockItems || 0), "alert"],
      ["Transactions", Number(metrics.transactions || 0), "receipt"],
      ["Supplier Outstanding", currency.format(Number(metrics.supplierOutstanding || 0)), "wallet"],
      ["Total Rebate Received", currency.format(Number(metrics.totalRebateReceived || 0)), "trend"],
      ["Today's Supplier Payments", currency.format(Number(metrics.todaySupplierPayments || 0)), "rupee"],
    ];
  }, [inventory, salesHistory, supplierDashboard]);

  const activeSuppliers = useMemo(
    () => suppliers.filter((supplier) => supplier.active !== false),
    [suppliers]
  );

  const supplierSummaryById = useMemo(
    () => new Map(supplierSummary.map((supplier) => [String(supplier.id), supplier])),
    [supplierSummary]
  );

  const customerSummaryById = useMemo(
    () => new Map(customerSummary.map((customer) => [String(customer.id), customer])),
    [customerSummary]
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
    const [suppliersResponse, summaryResponse] = await Promise.all([
      axios.get(`${API_URL}/suppliers`, { params }),
      axios.get(`${API_URL}/supplier-summary`),
    ]);
    const supplierSummaryPayload = summaryResponse.data;
    setSuppliers(suppliersResponse.data);
    setSupplierSummary(Array.isArray(supplierSummaryPayload) ? supplierSummaryPayload : supplierSummaryPayload.suppliers || []);
  };

  const loadSupplierPayments = async (supplierId = "") => {
    const response = await axios.get(`${API_URL}/supplier-payments`, {
      params: supplierId ? { supplier_id: supplierId } : {},
    });
    setSupplierPayments(response.data);
  };

  const loadSupplierLedger = async (supplierId = ledgerSupplierId) => {
    const response = await axios.get(`${API_URL}/supplier-ledger`, {
      params: supplierId ? { supplier_id: supplierId } : {},
    });
    setSupplierLedger(response.data);
  };

  const loadCustomerData = async (search = "") => {
    const params = search ? { search } : {};
    const [customersResponse, summaryResponse] = await Promise.all([
      axios.get(`${API_URL}/customers`, { params }),
      axios.get(`${API_URL}/customer-summary`),
    ]);
    const summaryPayload = summaryResponse.data;
    setCustomers(customersResponse.data);
    setCustomerSummary(Array.isArray(summaryPayload) ? summaryPayload : summaryPayload.customers || []);
  };

  const loadCustomerLedger = async (customerId = ledgerCustomerId) => {
    const response = await axios.get(`${API_URL}/customer-ledger`, {
      params: customerId ? { customer_id: customerId } : {},
    });
    setCustomerLedger(response.data);
  };

  const loadReports = async () => {
    const response = await axios.get(`${API_URL}/reports/summary`);
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

  const loadDashboardData = async () => {
    const [inventoryResponse, salesResponse, supplierMetricsResponse] = await Promise.all([
      axios.get(`${API_URL}/inventory`),
      axios.get(`${API_URL}/sales`),
      axios.get(`${API_URL}/dashboard-metrics`),
    ]);
    setInventory(inventoryResponse.data);
    setSalesHistory(salesResponse.data);
    setSupplierDashboard(supplierMetricsResponse.data);
  };

  const login = async () => {
    try {
      const response = await axios.post(`${API_URL}/login`, { username, password });
      setUser(response.data);
      await Promise.all([loadProducts(), loadDashboardData(), loadPurchaseRules(), loadSupplierData(), loadCustomerData(), loadSettingsData(response.data)]);
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
      await Promise.all([loadDashboardData(), loadSupplierData(), loadSupplierLedger(ledgerSupplierId)]);
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
      if (["purchase", "account-manager", "supplier-payments", "supplier-ledger"].includes(view)) {
        await loadSupplierData();
      }
      if (view === "supplier-payments") await loadSupplierPayments();
      if (view === "supplier-ledger") await loadSupplierLedger(ledgerSupplierId);
      if (view === "customers") {
        await Promise.all([loadCustomerData(), loadCustomerLedger(ledgerCustomerId)]);
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
              <section className="content-card">
                <div className="card-heading">
                  <div>
                    <span className="eyebrow">Quick Access</span>
                    <h2>Daily Operations</h2>
                  </div>
                </div>
                <div className="quick-grid">
                  {[["sales", "POS Billing"], ["purchase", "New Purchase"], ["account-manager", "Suppliers"], ["supplier-payments", "Supplier Payment"], ["supplier-ledger", "Supplier Ledger"], ["inventory", "View Inventory"]].map(([view, label]) => (
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
                <button className="secondary-button" onClick={() => navigate("account-manager")}>Add New Supplier</button>
              </div>
            </ModuleCard>
          )}

          {activeView === "account-manager" && (
            <AccountManager
              onNavigate={navigate}
              onReload={loadSupplierData}
              suppliers={suppliers}
              summaryBySupplier={supplierSummaryById}
            />
          )}

          {activeView === "supplier-payments" && (
            <SupplierPayments
              onReload={async () => {
                await Promise.all([loadSupplierData(), loadSupplierPayments(), loadSupplierLedger(ledgerSupplierId), loadDashboardData()]);
              }}
              payments={supplierPayments}
              suppliers={activeSuppliers}
              summaryBySupplier={supplierSummaryById}
              user={user}
            />
          )}

          {activeView === "supplier-ledger" && (
            <SupplierLedger
              ledgerData={supplierLedger}
              onLoad={loadSupplierLedger}
              selectedSupplierId={ledgerSupplierId}
              setSelectedSupplierId={setLedgerSupplierId}
              suppliers={suppliers}
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

          {activeView === "customers" && (
            <CustomerModule
              customers={customers}
              ledgerData={customerLedger}
              onLedgerLoad={loadCustomerLedger}
              onReload={async () => { await Promise.all([loadCustomerData(), loadCustomerLedger(ledgerCustomerId)]); }}
              selectedCustomerId={ledgerCustomerId}
              setSelectedCustomerId={setLedgerCustomerId}
              summaryByCustomer={customerSummaryById}
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

const supplierTypeLabel = (value) =>
  supplierTypes.find(([type]) => type === value)?.[1] || value || "-";

function AccountManager({ onNavigate, onReload, suppliers, summaryBySupplier }) {
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(emptySupplierForm);
  const [editingId, setEditingId] = useState(null);
  const [selectedSupplierId, setSelectedSupplierId] = useState("");
  const selectedSupplier = suppliers.find((supplier) => String(supplier.id) === selectedSupplierId);
  const selectedSummary = summaryBySupplier.get(selectedSupplierId);

  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));

  const resetForm = () => {
    setDraft(emptySupplierForm);
    setEditingId(null);
  };

  const saveSupplier = async () => {
    try {
      const payload = { ...draft, opening_balance: Number(draft.opening_balance || 0) };
      if (editingId) {
        await axios.put(`${API_URL}/suppliers/${editingId}`, payload);
      } else {
        await axios.post(`${API_URL}/suppliers`, payload);
      }
      resetForm();
      await onReload(search);
      alert(editingId ? "Supplier Updated" : "Supplier Added");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save supplier"));
    }
  };

  const editSupplier = (supplier) => {
    setDraft({
      ...emptySupplierForm,
      ...supplier,
      opening_balance: supplier.opening_balance || "",
      active: supplier.active !== false,
    });
    setEditingId(supplier.id);
    setSelectedSupplierId(String(supplier.id));
  };

  const toggleSupplierStatus = async (supplier) => {
    try {
      await axios.put(`${API_URL}/suppliers/${supplier.id}`, {
        ...supplier,
        active: supplier.active === false,
      });
      await onReload(search);
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update supplier status"));
    }
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Supplier Account" title={editingId ? "Edit Supplier Account" : "Add Supplier Account"} subtitle="Create supplier accounts before purchases are recorded. Inactive suppliers remain preserved for transaction history.">
        <div className="form-grid supplier-form-grid">
          <Field label="Supplier Name"><input value={draft.supplier_name} onChange={(event) => updateDraft("supplier_name", event.target.value)} /></Field>
          <Field label="Firm Name"><input value={draft.firm_name || ""} onChange={(event) => updateDraft("firm_name", event.target.value)} /></Field>
          <Field label="Supplier Type">
            <select value={draft.supplier_type} onChange={(event) => updateDraft("supplier_type", event.target.value)}>
              {supplierTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Mobile Number"><input value={draft.mobile_number || ""} onChange={(event) => updateDraft("mobile_number", event.target.value)} /></Field>
          <Field label="Alternate Number"><input value={draft.alternate_number || ""} onChange={(event) => updateDraft("alternate_number", event.target.value)} /></Field>
          <Field label="City"><input value={draft.city || ""} onChange={(event) => updateDraft("city", event.target.value)} /></Field>
          <Field label="GST Number"><input value={draft.gst_number || ""} onChange={(event) => updateDraft("gst_number", event.target.value)} /></Field>
          <Field label="Bank Name"><input value={draft.bank_name || ""} onChange={(event) => updateDraft("bank_name", event.target.value)} /></Field>
          <Field label="Account Number"><input value={draft.account_number || ""} onChange={(event) => updateDraft("account_number", event.target.value)} /></Field>
          <Field label="IFSC Code"><input value={draft.ifsc_code || ""} onChange={(event) => updateDraft("ifsc_code", event.target.value.toUpperCase())} /></Field>
          <Field label="UPI ID"><input value={draft.upi_id || ""} onChange={(event) => updateDraft("upi_id", event.target.value)} /></Field>
          <Field label="Opening Balance"><input min="0" step="0.01" type="number" value={draft.opening_balance || ""} onChange={(event) => updateDraft("opening_balance", event.target.value)} /></Field>
          <Field label="Address"><textarea value={draft.address || ""} onChange={(event) => updateDraft("address", event.target.value)} /></Field>
          <Field label="Notes"><textarea value={draft.notes || ""} onChange={(event) => updateDraft("notes", event.target.value)} /></Field>
          <label className="check-field"><input type="checkbox" checked={draft.active !== false} onChange={(event) => updateDraft("active", event.target.checked)} /><span>Active Supplier</span></label>
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={saveSupplier}>{editingId ? "Update Supplier" : "Add Supplier"}</button>
          {editingId && <button className="secondary-button" onClick={resetForm}>Cancel Edit</button>}
        </div>
      </ModuleCard>

      <ModuleCard eyebrow="Supplier List" title="Account Manager" subtitle="Search, review and maintain supplier account status.">
        <div className="ledger-toolbar">
          <label className="icon-input">
            <Icon name="search" />
            <input placeholder="Search supplier, firm, mobile, city or GST" value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => event.key === "Enter" && onReload(search)} />
          </label>
          <button className="secondary-button" onClick={() => onReload(search)}>Search</button>
          <button className="secondary-button" onClick={() => { setSearch(""); onReload(""); }}>Clear</button>
        </div>
        <DataTable headers={["Supplier", "Firm", "Type", "Mobile", "City", "Outstanding", "Status", ""]}>
          {suppliers.map((supplier) => {
            const summary = summaryBySupplier.get(String(supplier.id)) || supplier;
            return (
              <tr key={supplier.id}>
                <td className="primary-cell">{supplier.supplier_name}</td>
                <td>{supplier.firm_name || "-"}</td>
                <td><span className="tag">{supplierTypeLabel(supplier.supplier_type)}</span></td>
                <td>{supplier.mobile_number || "-"}</td>
                <td>{supplier.city || "-"}</td>
                <td className="balance-cell">{currency.format(Number(summary.outstanding_balance || 0))}</td>
                <td><span className={supplier.active !== false ? "stock-ok" : "stock-low"}>{supplier.active !== false ? "Active" : "Inactive"}</span></td>
                <td>
                  <div className="button-row">
                    <button className="table-action" onClick={() => setSelectedSupplierId(String(supplier.id))}>View</button>
                    <button className="table-action" onClick={() => editSupplier(supplier)}>Edit</button>
                    <button className="secondary-button" onClick={() => toggleSupplierStatus(supplier)}>{supplier.active !== false ? "Inactive" : "Active"}</button>
                  </div>
                </td>
              </tr>
            );
          })}
        </DataTable>
      </ModuleCard>

      <ModuleCard eyebrow="Supplier Detail" title={selectedSupplier ? selectedSupplier.supplier_name : "Select Supplier"} subtitle="Supplier financial summary and account details.">
        {selectedSupplier ? (
          <section className="supplier-detail">
            <div className="purchase-summary-grid">
              <SummaryMetric label="Total Purchases" value={currency.format(Number(selectedSummary?.total_purchases || 0))} />
              <SummaryMetric label="Total Paid" value={currency.format(Number(selectedSummary?.total_paid || 0))} />
              <SummaryMetric label="Total Rebate" value={currency.format(Number(selectedSummary?.total_rebate_received || 0))} positive />
              <SummaryMetric label="Outstanding Balance" value={currency.format(Number(selectedSummary?.outstanding_balance || 0))} featured />
            </div>
            <div className="detail-grid">
              <DetailItem label="Firm" value={selectedSupplier.firm_name} />
              <DetailItem label="Type" value={supplierTypeLabel(selectedSupplier.supplier_type)} />
              <DetailItem label="Mobile" value={selectedSupplier.mobile_number} />
              <DetailItem label="Alternate" value={selectedSupplier.alternate_number} />
              <DetailItem label="City" value={selectedSupplier.city} />
              <DetailItem label="GST" value={selectedSupplier.gst_number} />
              <DetailItem label="Bank" value={selectedSupplier.bank_name} />
              <DetailItem label="Account" value={selectedSupplier.account_number} />
              <DetailItem label="IFSC" value={selectedSupplier.ifsc_code} />
              <DetailItem label="UPI" value={selectedSupplier.upi_id} />
              <DetailItem label="Address" value={selectedSupplier.address} />
              <DetailItem label="Notes" value={selectedSupplier.notes} />
            </div>
            <div className="button-row">
              <button className="primary-button" onClick={() => onNavigate("supplier-payments")}>Record Payment</button>
              <button className="secondary-button" onClick={() => onNavigate("supplier-ledger")}>View Ledger</button>
            </div>
          </section>
        ) : (
          <p className="form-note">Select a supplier from the Account Manager table to view details.</p>
        )}
      </ModuleCard>
    </section>
  );
}

function SupplierPayments({ onReload, payments, suppliers, summaryBySupplier, user }) {
  const [form, setForm] = useState({
    supplier_id: "",
    payment_date: toDateKey(new Date()),
    payment_amount: "",
    rebate_received: "",
    payment_mode: "CASH",
    reference_number: "",
    remarks: "",
  });
  const [editingPaymentId, setEditingPaymentId] = useState(null);
  const selectedSummary = summaryBySupplier.get(String(form.supplier_id));

  const updateForm = (field, value) => setForm((current) => ({ ...current, [field]: value }));

  const savePayment = async () => {
    try {
      const payload = {
        ...form,
        payment_amount: Number(form.payment_amount || 0),
        rebate_received: Number(form.rebate_received || 0),
        branch_id: user.branch_id,
        created_by: user.id,
      };
      if (editingPaymentId) {
        const reason = window.prompt("Enter reason for editing supplier payment");
        if (!reason?.trim()) return;
        await axios.put(`${API_URL}/supplier-payments/${editingPaymentId}`, { ...payload, edited_by: user.id, reason });
      } else {
        await axios.post(`${API_URL}/supplier-payments`, payload);
      }
      setForm((current) => ({
        ...current,
        supplier_id: "",
        payment_amount: "",
        rebate_received: "",
        reference_number: "",
        remarks: "",
      }));
      setEditingPaymentId(null);
      await onReload();
      alert(editingPaymentId ? "Supplier payment updated" : "Supplier Payment Saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save supplier payment"));
    }
  };
  const editPayment = (payment) => {
    setEditingPaymentId(payment.id);
    setForm({
      supplier_id: String(payment.supplier_id),
      payment_date: toDateKey(payment.payment_date),
      payment_amount: payment.payment_amount || "",
      rebate_received: payment.rebate_amount || "",
      payment_mode: payment.payment_mode || "CASH",
      reference_number: payment.reference_number || "",
      remarks: payment.remarks || "",
    });
  };
  const cancelPayment = async (payment) => {
    const reason = window.prompt("Enter reason for cancelling supplier payment");
    if (!reason?.trim()) return;
    try {
      await axios.post(`${API_URL}/supplier-payments/${payment.id}/cancel`, { cancelled_by: user.id, reason });
      await onReload();
      alert("Supplier payment cancelled");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to cancel supplier payment"));
    }
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Supplier Payment" title="Payment Entry" subtitle="Record payments and payment-time rebates. Rebates reduce supplier payable balance immediately.">
        <div className="form-grid">
          <Field label="Supplier">
            <select value={form.supplier_id} onChange={(event) => updateForm("supplier_id", event.target.value)}>
              <option value="">Select supplier</option>
              {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.supplier_name}{supplier.firm_name ? ` - ${supplier.firm_name}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Payment Date"><input type="date" value={form.payment_date} onChange={(event) => updateForm("payment_date", event.target.value)} /></Field>
          <Field label="Payment Amount"><input min="0" step="0.01" type="number" value={form.payment_amount} onChange={(event) => updateForm("payment_amount", event.target.value)} /></Field>
          <Field label="Rebate Received"><input min="0" step="0.01" type="number" value={form.rebate_received} onChange={(event) => updateForm("rebate_received", event.target.value)} /></Field>
          <Field label="Payment Mode">
            <select value={form.payment_mode} onChange={(event) => updateForm("payment_mode", event.target.value)}>
              {supplierPaymentModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Reference Number"><input value={form.reference_number} onChange={(event) => updateForm("reference_number", event.target.value)} /></Field>
          <Field label="Remarks"><textarea value={form.remarks} onChange={(event) => updateForm("remarks", event.target.value)} /></Field>
        </div>
        {selectedSummary && (
          <div className="purchase-summary-grid supplier-payment-preview">
            <SummaryMetric label="Total Purchases" value={currency.format(Number(selectedSummary.total_purchases || 0))} />
            <SummaryMetric label="Total Paid" value={currency.format(Number(selectedSummary.total_paid || 0))} />
            <SummaryMetric label="Total Rebate" value={currency.format(Number(selectedSummary.total_rebate_received || 0))} positive />
            <SummaryMetric label="Outstanding" value={currency.format(Number(selectedSummary.outstanding_balance || 0))} featured />
          </div>
        )}
        <div className="button-row">
          <button className="primary-button" onClick={savePayment}>{editingPaymentId ? "Update Payment" : "Save Payment"}</button>
          {editingPaymentId && <button className="secondary-button" onClick={() => { setEditingPaymentId(null); setForm({ supplier_id: "", payment_date: toDateKey(new Date()), payment_amount: "", rebate_received: "", payment_mode: "CASH", reference_number: "", remarks: "" }); }}>Cancel Edit</button>}
        </div>
      </ModuleCard>

      <ModuleCard eyebrow="Payment History" title="Recent Supplier Payments" subtitle="Payments and rebates posted through Supplier Payments.">
        <DataTable headers={["Date", "Supplier", "Mode", "Payment", "Rebate", "Status", "Reference", "Remarks", ""]}>
          {payments.map((payment) => (
            <tr key={payment.id}>
              <td>{payment.payment_date}</td>
              <td className="primary-cell">{payment.supplier_name}</td>
              <td><span className="tag">{payment.payment_mode}</span></td>
              <td>{currency.format(Number(payment.payment_amount || 0))}</td>
              <td className="profit-cell">{currency.format(Number(payment.rebate_amount || 0))}</td>
              <td><span className={payment.cancelled ? "stock-low" : "stock-ok"}>{payment.cancelled ? "Cancelled" : "Active"}</span></td>
              <td>{payment.reference_number || "-"}</td>
              <td>{payment.remarks || "-"}</td>
              <td><div className="button-row"><button className="table-action" disabled={payment.cancelled} onClick={() => editPayment(payment)}>Edit</button><button className="remove-button" disabled={payment.cancelled} onClick={() => cancelPayment(payment)}>Cancel</button></div></td>
            </tr>
          ))}
        </DataTable>
      </ModuleCard>
    </section>
  );
}

function SupplierLedger({ ledgerData, onLoad, selectedSupplierId, setSelectedSupplierId, suppliers }) {
  const summaries = ledgerData.suppliers || [];
  const rows = ledgerData.ledger || [];
  const totals = summaries.reduce((summary, supplier) => ({
    purchases: summary.purchases + Number(supplier.total_purchases || 0),
    paid: summary.paid + Number(supplier.total_paid || 0),
    rebate: summary.rebate + Number(supplier.total_rebate_received || 0),
    outstanding: summary.outstanding + Number(supplier.outstanding_balance || 0),
  }), { purchases: 0, paid: 0, rebate: 0, outstanding: 0 });

  const changeSupplier = async (supplierId) => {
    setSelectedSupplierId(supplierId);
    await onLoad(supplierId);
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Supplier Ledger" title="Outstanding Balance" subtitle="Purchase, payment and rebate entries are combined into a running supplier balance.">
        <div className="ledger-toolbar">
          <Field label="Supplier">
            <select value={selectedSupplierId} onChange={(event) => changeSupplier(event.target.value)}>
              <option value="">All suppliers</option>
              {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.supplier_name}</option>)}
            </select>
          </Field>
          <button className="secondary-button" onClick={() => onLoad(selectedSupplierId)}>Refresh Ledger</button>
        </div>
        <div className="purchase-summary-grid">
          <SummaryMetric label="Total Purchases" value={currency.format(totals.purchases)} />
          <SummaryMetric label="Total Paid" value={currency.format(totals.paid)} />
          <SummaryMetric label="Total Rebate Received" value={currency.format(totals.rebate)} positive />
          <SummaryMetric label="Outstanding Balance" value={currency.format(totals.outstanding)} featured />
        </div>
        <DataTable headers={["Date", "Supplier", "Transaction", "Purchase", "Payment", "Rebate", "Running Balance", "Remarks"]}>
          {rows.map((row, index) => (
            <tr key={`${row.supplier_id}-${row.transaction_type}-${row.purchase_id || row.supplier_payment_id || index}-${index}`}>
              <td>{row.transaction_date}</td>
              <td className="primary-cell">{row.supplier_name}</td>
              <td><span className="tag">{row.transaction_type}</span></td>
              <td>{currency.format(Number(row.purchase_amount || 0))}</td>
              <td>{currency.format(Number(row.payment_amount || 0))}</td>
              <td className="profit-cell">{currency.format(Number(row.rebate_amount || 0))}</td>
              <td className="balance-cell">{currency.format(Number(row.running_balance || 0))}</td>
              <td>{row.remarks || "-"}</td>
            </tr>
          ))}
        </DataTable>
      </ModuleCard>
    </section>
  );
}

function CustomerModule({ customers, ledgerData, onLedgerLoad, onReload, selectedCustomerId, setSelectedCustomerId, summaryByCustomer, user }) {
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(emptyCustomerForm);
  const [editingId, setEditingId] = useState(null);
  const [payment, setPayment] = useState({
    customer_id: "",
    payment_date: toDateKey(new Date()),
    payment_amount: "",
    payment_mode: "CASH",
    reference_number: "",
    remarks: "",
  });
  const filteredCustomers = customers.filter((customer) =>
    customer.customer_name.toLowerCase().includes(search.toLowerCase()) ||
    (customer.mobile_number || "").includes(search)
  );
  const ledgerRows = ledgerData.ledger || [];
  const ledgerTotals = (ledgerData.customers || []).reduce((summary, customer) => ({
    sales: summary.sales + Number(customer.total_sales || 0),
    paid: summary.paid + Number(customer.total_paid || 0),
    outstanding: summary.outstanding + Number(customer.outstanding_balance || 0),
  }), { sales: 0, paid: 0, outstanding: 0 });

  const saveCustomer = async () => {
    try {
      const payload = { ...draft, opening_balance: Number(draft.opening_balance || 0) };
      if (editingId) await axios.put(`${API_URL}/customers/${editingId}`, payload);
      else await axios.post(`${API_URL}/customers`, payload);
      setDraft(emptyCustomerForm);
      setEditingId(null);
      await onReload();
      alert(editingId ? "Customer updated" : "Customer saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save customer"));
    }
  };
  const editCustomer = (customer) => {
    setEditingId(customer.id);
    setDraft({
      customer_name: customer.customer_name || "",
      customer_type: customer.customer_type || "RETAIL",
      mobile_number: customer.mobile_number || "",
      address: customer.address || "",
      gst_number: customer.gst_number || "",
      notes: customer.notes || "",
      opening_balance: customer.opening_balance || "",
      active: customer.active !== false,
    });
  };
  const savePayment = async () => {
    try {
      await axios.post(`${API_URL}/customer-payments`, {
        ...payment,
        payment_amount: Number(payment.payment_amount || 0),
        branch_id: user.branch_id,
        created_by: user.id,
      });
      setPayment((current) => ({ ...current, payment_amount: "", reference_number: "", remarks: "" }));
      await onReload();
      alert("Customer payment saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save customer payment"));
    }
  };
  const changeLedgerCustomer = async (customerId) => {
    setSelectedCustomerId(customerId);
    await onLedgerLoad(customerId);
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Customer Accounts" title="Customers" subtitle="Manage retail and wholesale customer accounts, payments and outstanding balances.">
        <div className="form-grid supplier-form-grid">
          <Field label="Customer Name"><input value={draft.customer_name} onChange={(event) => setDraft({ ...draft, customer_name: event.target.value })} /></Field>
          <Field label="Customer Type">
            <select value={draft.customer_type} onChange={(event) => setDraft({ ...draft, customer_type: event.target.value })}>
              {customerTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Mobile Number"><input value={draft.mobile_number} onChange={(event) => setDraft({ ...draft, mobile_number: event.target.value.replace(/\D/g, "") })} /></Field>
          <Field label="GST Number"><input value={draft.gst_number} onChange={(event) => setDraft({ ...draft, gst_number: event.target.value })} /></Field>
          <Field label="Opening Balance"><input min="0" step="0.01" type="number" value={draft.opening_balance} onChange={(event) => setDraft({ ...draft, opening_balance: event.target.value })} /></Field>
          <label className="check-field"><input checked={draft.active} type="checkbox" onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>Active</span></label>
          <Field label="Address"><textarea value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} /></Field>
          <Field label="Notes"><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></Field>
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={saveCustomer}>{editingId ? "Update Customer" : "Add Customer"}</button>
          {editingId && <button className="secondary-button" onClick={() => { setDraft(emptyCustomerForm); setEditingId(null); }}>Cancel Edit</button>}
        </div>
      </ModuleCard>

      <ModuleCard eyebrow="Customer List" title="Search Customers" subtitle="Walk-in customers are supported in POS without creating an account; saved customers appear here.">
        <div className="ledger-toolbar">
          <Field label="Search"><input placeholder="Search name or mobile" value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
          <button className="secondary-button" onClick={onReload}>Refresh</button>
        </div>
        <DataTable headers={["Name", "Type", "Mobile", "GST", "Outstanding", "Status", ""]}>
          {filteredCustomers.map((customer) => {
            const summary = summaryByCustomer.get(String(customer.id)) || customer;
            return (
              <tr key={customer.id}>
                <td className="primary-cell">{customer.customer_name}<small className="cell-note">{customer.address || "No address"}</small></td>
                <td><span className="tag">{customer.customer_type}</span></td>
                <td>{customer.mobile_number || "-"}</td>
                <td>{customer.gst_number || "-"}</td>
                <td className="balance-cell">{currency.format(Number(summary.outstanding_balance || 0))}</td>
                <td><span className={customer.active !== false ? "stock-ok" : "stock-low"}>{customer.active !== false ? "Active" : "Inactive"}</span></td>
                <td><button className="table-action" onClick={() => editCustomer(customer)}>Edit</button></td>
              </tr>
            );
          })}
        </DataTable>
      </ModuleCard>

      <ModuleCard eyebrow="Customer Payments" title="Payment Entry" subtitle="Record customer receipts against outstanding balances.">
        <div className="form-grid">
          <Field label="Customer">
            <select value={payment.customer_id} onChange={(event) => setPayment({ ...payment, customer_id: event.target.value })}>
              <option value="">Select customer</option>
              {customers.filter((customer) => customer.active !== false).map((customer) => <option key={customer.id} value={customer.id}>{customer.customer_name}</option>)}
            </select>
          </Field>
          <Field label="Payment Date"><input type="date" value={payment.payment_date} onChange={(event) => setPayment({ ...payment, payment_date: event.target.value })} /></Field>
          <Field label="Amount"><input min="0" step="0.01" type="number" value={payment.payment_amount} onChange={(event) => setPayment({ ...payment, payment_amount: event.target.value })} /></Field>
          <Field label="Mode">
            <select value={payment.payment_mode} onChange={(event) => setPayment({ ...payment, payment_mode: event.target.value })}>
              {customerPaymentModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Reference"><input value={payment.reference_number} onChange={(event) => setPayment({ ...payment, reference_number: event.target.value })} /></Field>
          <Field label="Remarks"><textarea value={payment.remarks} onChange={(event) => setPayment({ ...payment, remarks: event.target.value })} /></Field>
        </div>
        <button className="primary-button" onClick={savePayment}>Save Customer Payment</button>
      </ModuleCard>

      <ModuleCard eyebrow="Customer Ledger" title="Outstanding Balance" subtitle="Sales and payments are combined into a running customer balance.">
        <div className="ledger-toolbar">
          <Field label="Customer">
            <select value={selectedCustomerId} onChange={(event) => changeLedgerCustomer(event.target.value)}>
              <option value="">All customers</option>
              {customers.map((customer) => <option key={customer.id} value={customer.id}>{customer.customer_name}</option>)}
            </select>
          </Field>
          <button className="secondary-button" onClick={() => onLedgerLoad(selectedCustomerId)}>Refresh Ledger</button>
        </div>
        <div className="purchase-summary-grid">
          <SummaryMetric label="Total Sales" value={currency.format(ledgerTotals.sales)} />
          <SummaryMetric label="Total Paid" value={currency.format(ledgerTotals.paid)} />
          <SummaryMetric label="Outstanding" value={currency.format(ledgerTotals.outstanding)} featured />
        </div>
        <DataTable headers={["Date", "Customer", "Transaction", "Debit", "Credit", "Running Balance", "Remarks"]}>
          {ledgerRows.map((row, index) => (
            <tr key={`${row.customer_id}-${row.transaction_type}-${index}`}>
              <td>{row.transaction_date}</td>
              <td className="primary-cell">{row.customer_name}</td>
              <td><span className="tag">{row.transaction_type}</span></td>
              <td>{currency.format(Number(row.debit_amount || 0))}</td>
              <td>{currency.format(Number(row.credit_amount || 0))}</td>
              <td className="balance-cell">{currency.format(Number(row.running_balance || 0))}</td>
              <td>{row.remarks || "-"}</td>
            </tr>
          ))}
        </DataTable>
      </ModuleCard>
    </section>
  );
}

function ReportsModule({ data, onReload }) {
  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Reports" title="Business Reports" subtitle="Operational summaries generated from live sales, purchases, suppliers, customers and discounts.">
        <button className="secondary-button" onClick={onReload}>Refresh Reports</button>
      </ModuleCard>
      <ModuleCard eyebrow="Sales Report" title="Sales by Date" subtitle="Completed invoices only; cancelled bills are excluded.">
        <DataTable headers={["Date", "Transactions", "Sales", "Cost", "Profit"]}>
          {(data.salesReport || []).map((row) => <tr key={row.sale_date}><td>{row.sale_date}</td><td>{row.transaction_count}</td><td>{currency.format(Number(row.total_sales || 0))}</td><td>{currency.format(Number(row.total_cost || 0))}</td><td className="profit-cell">{currency.format(Number(row.total_profit || 0))}</td></tr>)}
        </DataTable>
      </ModuleCard>
      <ModuleCard eyebrow="Purchase Report" title="Purchases by Date" subtitle="Gross purchase, rebates, net purchase cost and balance.">
        <DataTable headers={["Date", "Bills", "Gross", "Rebate", "Net", "Paid", "Balance"]}>
          {(data.purchaseReport || []).map((row) => <tr key={row.purchase_date}><td>{row.purchase_date}</td><td>{row.purchase_count}</td><td>{currency.format(Number(row.gross_purchase || 0))}</td><td>{currency.format(Number(row.rebate_received || 0))}</td><td>{currency.format(Number(row.net_purchase || 0))}</td><td>{currency.format(Number(row.paid_amount || 0))}</td><td className="balance-cell">{currency.format(Number(row.balance_amount || 0))}</td></tr>)}
        </DataTable>
      </ModuleCard>
      <ModuleCard eyebrow="Supplier Outstanding" title="Supplier Outstanding Report" subtitle="Supplier payable balances after payments and rebates.">
        <DataTable headers={["Supplier", "Purchases", "Paid", "Rebate", "Outstanding"]}>
          {(data.supplierOutstandingReport || []).map((row) => <tr key={row.id}><td className="primary-cell">{row.supplier_name}</td><td>{currency.format(Number(row.total_purchases || 0))}</td><td>{currency.format(Number(row.total_paid || 0))}</td><td>{currency.format(Number(row.total_rebate_received || 0))}</td><td className="balance-cell">{currency.format(Number(row.outstanding_balance || 0))}</td></tr>)}
        </DataTable>
      </ModuleCard>
      <ModuleCard eyebrow="Customer Outstanding" title="Customer Outstanding Report" subtitle="Customer receivable balances after receipts.">
        <DataTable headers={["Customer", "Type", "Sales", "Paid", "Outstanding"]}>
          {(data.customerOutstandingReport || []).map((row) => <tr key={row.id}><td className="primary-cell">{row.customer_name}</td><td><span className="tag">{row.customer_type}</span></td><td>{currency.format(Number(row.total_sales || 0))}</td><td>{currency.format(Number(row.total_paid || 0))}</td><td className="balance-cell">{currency.format(Number(row.outstanding_balance || 0))}</td></tr>)}
        </DataTable>
      </ModuleCard>
      <ModuleCard eyebrow="Discount Report" title="Discounts Given" subtitle="Bill and item discounts grouped by date and payment mode.">
        <DataTable headers={["Date", "Payment", "Invoices", "Item Discount", "Bill Discount", "Total Discount"]}>
          {(data.discountReport || []).map((row) => <tr key={`${row.sale_date}-${row.payment_mode}`}><td>{row.sale_date}</td><td><span className="tag">{row.payment_mode}</span></td><td>{row.invoice_count}</td><td>{currency.format(Number(row.item_discount || 0))}</td><td>{currency.format(Number(row.bill_discount || 0))}</td><td className="profit-cell">{currency.format(Number(row.total_discount || 0))}</td></tr>)}
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

function DetailItem({ label, value }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value || "-"}</strong>
    </div>
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

function PosBilling({ discountRules = [], inventory, onInvoice, onSaved, products, user }) {
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
          <DataTable headers={["Action", "Edited At", "Edited By", "Reason", "Old Value", "New Value"]}>
            {history.rows.map((row) => (
              <tr key={row.id}>
                <td><span className="tag">{row.action}</span></td>
                <td>{new Date(row.edited_at).toLocaleString("en-IN")}</td>
                <td>{row.edited_by_name || "-"}</td>
                <td>{row.reason}</td>
                <td><pre className="audit-json">{JSON.stringify(row.old_value, null, 2)}</pre></td>
                <td><pre className="audit-json">{JSON.stringify(row.new_value, null, 2)}</pre></td>
              </tr>
            ))}
          </DataTable>
          {history.rows.length === 0 && <div className="cart-empty">No changes recorded for this invoice.</div>}
        </div>
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
