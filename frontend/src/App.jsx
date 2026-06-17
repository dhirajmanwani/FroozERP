import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import QRCode from "qrcode";
import "./App.css";
import {
  cacheLocalReferenceSnapshot,
  cancelLocalPosSale,
  completeLocalPosSale,
  editLocalPosSale,
  getOrCreateLocalDeviceIdentity,
  initializeLocalDatabase,
  isTauriRuntime,
  listLocalPosSales,
  loadLocalReferenceSnapshot,
  loadLocalPosSale,
} from "./local/localDatabase";
import {
  authenticateOfflineSession,
  cacheOfflineSession,
  readOfflineSession,
  verifyOfflineSessionRecord,
} from "./local/offlineSession";
import {
  connectivityEventNames,
  subscribeConnectivity,
} from "./local/connectivityService";
import {
  checkBackendHealth,
  getSyncStatus,
  queueSafeSyncTest,
  retryFailedOperations,
  syncNow,
} from "./local/syncService";

const isDesktopShell = () => Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);

const API_URL = (
  import.meta.env.VITE_API_URL ||
  window.__FROOZERP_API_URL__ ||
  (isDesktopShell() ? "http://127.0.0.1:5000" : `${window.location.protocol}//${window.location.hostname}:5000`)
).replace(/\/$/, "");
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
const APP_VERSION = "1.0.0";
const APP_DISPLAY_NAME = "FroozERP - Feel the Freakin' Frooz";
const APP_COMPANY = "SRT Company";
const UPDATE_FEED_URL = (
  import.meta.env.VITE_UPDATE_FEED_URL ||
  window.__FROOZERP_UPDATE_FEED_URL__ ||
  ""
).trim();
const roundUi = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const defaultPurchaseRules = {
  mandiTaxRules: [],
  rebateRules: [],
};

const icons = {
  dashboard: "grid",
  products: "box",
  purchase: "cart",
  "pending-bills": "alert",
  inventory: "layers",
  returns: "history",
  waste: "alert",
  sales: "receipt",
  discounts: "wallet",
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
  ["pending-bills", "Pending Bills"],
  ["accounts", "Accounts"],
  ["returns", "Sale Returns"],
  ["waste", "Waste Management"],
  ["sales", "POS Billing"],
  ["discounts", "Discounts"],
  ["sale-rates", "Sale Rate Update"],
  ["expenses", "Expenses"],
  ["reports", "Reports"],
  ["settings", "Settings"],
];

const offlineLocalDataViews = new Set(["dashboard", "products", "sales", "reports", "settings"]);
const offlineBackendRequiredViews = new Set(["purchase", "pending-bills", "accounts", "returns", "waste", "discounts", "sale-rates", "expenses"]);

const getErrorMessage = (error, fallback) =>
  error.response?.data?.message || fallback;

const getAuthErrorMessage = (error, fallback) => {
  const code = error.response?.data?.code;
  const message = error.response?.data?.message;
  if (code === "INVALID_CREDENTIALS") return "Invalid username or password.";
  if (code === "USER_DISABLED") return message || "This user account is disabled. Contact your Owner or Administrator.";
  if (code === "DEVICE_PENDING_APPROVAL") return message || "This device is pending owner approval.";
  if (["DEVICE_DISABLED", "DEVICE_REVOKED"].includes(code)) return message || "This device is disabled for FroozERP access.";
  if (code === "BRANCH_ACCESS_DENIED") return message || "This branch is not authorised for login.";
  if (code === "SERVER_UNAVAILABLE") return message || "FroozERP backend is unavailable.";
  return message || fallback;
};

const hasObjectContent = (value) =>
  Boolean(value) && typeof value === "object" && Object.keys(value).length > 0;

const localSnapshotToInvoice = (snapshot) => {
  const invoice = snapshot?.invoice || snapshot || {};
  const items = snapshot?.items || invoice.items || [];
  const payments = snapshot?.payments || invoice.payments || [];
  return {
    ...invoice,
    id: invoice.id || invoice.invoice_global_id,
    sale_id: invoice.id || invoice.invoice_global_id,
    invoice_no: invoice.server_invoice_no || invoice.offline_invoice_ref || invoice.invoice_no,
    sale_status: invoice.status || invoice.sale_status || "COMPLETED",
    sale_date: invoice.bill_date || invoice.sale_date,
    transaction_date: invoice.bill_date || invoice.transaction_date,
    customer_name: invoice.customer_name,
    customer_mobile: invoice.customer_mobile,
    customer_id: invoice.customer_id,
    gross_amount: Number(invoice.gross_total ?? invoice.gross_amount ?? 0),
    item_discount_amount: Number(invoice.item_discount_total ?? invoice.item_discount_amount ?? 0),
    invoice_discount_amount: Number(invoice.bill_discount_total ?? invoice.invoice_discount_amount ?? 0),
    tax_amount: Number(invoice.tax_total ?? invoice.tax_amount ?? 0),
    total_amount: Number(invoice.net_total ?? invoice.total_amount ?? 0),
    payment_mode: invoice.payment_mode || "CASH",
    edit_reason: invoice.edit_reason,
    cancellation_reason: invoice.cancellation_reason,
    items: items.map((item) => ({
      ...item,
      id: item.id || item.item_global_id,
      product_id: item.product_id,
      product_name: item.product_name,
      inventory_batch_id: item.inventory_batch_id || item.lot_id,
      lot_id: item.lot_id || item.inventory_batch_id,
      lot_name: item.lot_name,
      lot_size: item.lot_size,
      quantity: Number(item.quantity || 0),
      selling_rate: Number(item.selling_rate ?? item.rate ?? 0),
      rate: Number(item.rate ?? item.selling_rate ?? 0),
      discount_amount: Number(item.discount_amount ?? item.discount ?? 0),
      discount: Number(item.discount ?? item.discount_amount ?? 0),
      amount: Number(item.amount ?? item.net_amount ?? 0),
      net_amount: Number(item.net_amount ?? item.amount ?? 0),
      unit: item.unit,
      stock_movement_id: item.stock_movement_id,
    })),
    payments,
    sync_status: invoice.sync_status,
    entity_version: invoice.entity_version,
  };
};

const getClientDeviceInfo = () => {
  const storageKey = "froozerp_device_id";
  let deviceId = localStorage.getItem(storageKey);
  if (!deviceId) {
    deviceId = `FZDEV-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    localStorage.setItem(storageKey, deviceId);
  }
  const userAgent = navigator.userAgent || "Browser";
  const isAndroid = /android/i.test(userAgent);
  const isTablet = /ipad|tablet/i.test(userAgent) || (isAndroid && !/mobile/i.test(userAgent));
  const isPhone = /mobile|iphone/i.test(userAgent) && !isTablet;
  const browser = /chrome|crios/i.test(userAgent) ? "Chrome" : /firefox|fxios/i.test(userAgent) ? "Firefox" : /safari/i.test(userAgent) ? "Safari" : "Browser";
  const deviceType = isAndroid
    ? isTablet ? `Android Tablet - ${browser}` : `Android Phone - ${browser}`
    : isTablet ? `Tablet Browser - ${browser}` : isPhone ? `Mobile Browser - ${browser}` : `Desktop Browser - ${browser}`;
  return {
    device_id: deviceId,
    device_name: localStorage.getItem("froozerp_device_name") || `${deviceType} - ${window.location.hostname}`,
    device_type: deviceType,
    user_agent: userAgent,
  };
};

const resolveLocalDeviceInfo = async (fallback = getClientDeviceInfo()) => {
  if (!isTauriRuntime()) return fallback;
  const identity = await getOrCreateLocalDeviceIdentity().catch(() => null);
  if (!identity?.device_id) return fallback;
  localStorage.setItem("froozerp_device_id", identity.device_id);
  if (identity.device_name) localStorage.setItem("froozerp_device_name", identity.device_name);
  return {
    ...fallback,
    device_id: identity.device_id,
    device_name: identity.device_name || fallback.device_name,
    device_type: identity.platform || fallback.device_type,
    branch_id: identity.branch_id || fallback.branch_id,
  };
};

const toDateKey = (date) =>
  typeof date === "string" ? date.slice(0, 10) : date.toLocaleDateString("en-CA");
const formatDisplayDate = (dateValue) => {
  const key = toDateKey(dateValue || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key || "-";
  const [year, month, day] = key.split("-");
  return `${day}/${month}/${year}`;
};
const formatFileDate = (dateValue) => formatDisplayDate(dateValue).replaceAll("/", "-");
const safeFileName = (value) =>
  String(value || "FroozERP_Document")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 140);
const withDocumentTitle = (fileName, action) => {
  const previousTitle = document.title;
  document.title = safeFileName(fileName).replace(/\.pdf$/i, "");
  action();
  setTimeout(() => {
    document.title = previousTitle;
  }, 1000);
};
const exportElementToPdf = async ({ element, fileName, mode = "A4", receiptWidth = "80MM", save = true }) => {
  if (!element) throw new Error("Nothing to export");
  const isThermal = mode === "THERMAL";
  element.classList.add("pdf-export-mode", isThermal ? "pdf-export-thermal" : "pdf-export-a4");
  document.body.classList.add("pdf-export-active");
  try {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = await html2canvas(element, {
      backgroundColor: "#ffffff",
      scale: 2,
      useCORS: true,
      scrollX: 0,
      scrollY: 0,
      windowWidth: Math.max(document.documentElement.clientWidth, element.scrollWidth),
      windowHeight: Math.max(document.documentElement.clientHeight, element.scrollHeight),
    });
    const imgData = canvas.toDataURL("image/png");
    const isLandscapeReport = !isThermal && Boolean(element.closest?.(".cash-book-print-report"));
    const pageWidth = isThermal ? (receiptWidth === "58MM" ? 58 : 80) : isLandscapeReport ? 297 : 210;
    const imgHeight = (canvas.height * pageWidth) / canvas.width;
    const pageHeight = isThermal ? Math.max(120, imgHeight) : isLandscapeReport ? 210 : 297;
    const pdf = new jsPDF(isLandscapeReport ? "l" : "p", "mm", isThermal ? [pageWidth, pageHeight] : "a4");
    if (isThermal) {
      pdf.addImage(imgData, "PNG", 0, 0, pageWidth, imgHeight);
    } else {
      let yOffset = 0;
      let remainingHeight = imgHeight;
      pdf.addImage(imgData, "PNG", 0, yOffset, pageWidth, imgHeight);
      remainingHeight -= pageHeight;
      while (remainingHeight > 0) {
        yOffset -= pageHeight;
        pdf.addPage();
        pdf.addImage(imgData, "PNG", 0, yOffset, pageWidth, imgHeight);
        remainingHeight -= pageHeight;
      }
    }
    const finalFileName = safeFileName(fileName).replace(/\.pdf$/i, "") + ".pdf";
    if (save) pdf.save(finalFileName);
    return { blob: pdf.output("blob"), fileName: finalFileName, pdf };
  } finally {
    element.classList.remove("pdf-export-mode", "pdf-export-thermal", "pdf-export-a4");
    document.body.classList.remove("pdf-export-active");
  }
};

const supplierPaymentModes = [
  ["CASH", "Cash"],
  ["UPI", "UPI"],
  ["BANK_TRANSFER", "Bank Transfer"],
  ["CHEQUE", "Cheque"],
];
const bankPaymentModes = new Set(["UPI", "CARD", "BANK_TRANSFER", "BANK", "CHEQUE"]);

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
  Cashier: { dashboard: true, sales: true, accounts: true, "pending-bills": true },
  "Purchase Manager": { dashboard: true, purchase: true, "pending-bills": true, accounts: true, reports: true },
  "Inventory Manager": { dashboard: true, products: true, waste: true, reports: true },
};

const modulePermissionMap = {
  dashboard: "dashboard",
  products: "inventory",
  purchase: "purchases",
  "pending-bills": "billing",
  accounts: "supplier_accounts",
  returns: "billing",
  waste: "waste_management",
  sales: "billing",
  discounts: "discounts",
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
  default_invoice_print: "THERMAL_RECEIPT",
  default_report_print: "A4_REPORT",
  show_print_preview_before_print: true,
  show_item_discount_column_pos: true,
  show_item_discount_column_receipt: true,
  show_bill_discount_row_receipt: true,
  hide_zero_discount_rows: true,
};

const defaultSaleRateSettings = {
  desired_margin_percent: 25,
  rounding_rule: "NEAREST_RUPEE",
  suggestion_enabled: true,
  bill_level_slab_discount_enabled: true,
  pos_lot_selection_mode: "ASK_MULTIPLE",
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
  qr_display_size: "MEDIUM",
};

function BrandLogo({ compact = false, invoice = false, splash = false }) {
  const assetBase = import.meta.env.BASE_URL || "/";
  const assetPath = (path) => `${assetBase}${path}`.replace(/([^:]\/)\/+/g, "$1");
  const imageSrc = compact ? assetPath("branding/frooz-symbol-192.png") : invoice ? assetPath("branding/frooz-logo-invoice-320.png") : assetPath("branding/frooz-logo-full-512.png");
  const alt = compact ? "FroozERP" : "Feel the Freakin' Frooz official logo";
  return (
    <div className={`${invoice ? "brand-lockup brand-lockup-invoice" : "brand-lockup"} ${compact ? "brand-lockup-compact" : ""} ${splash ? "brand-lockup-splash" : ""}`}>
      <span className="brand-monogram">
        <img alt={alt} src={imageSrc} />
      </span>
      {!compact && (
        <span className="brand-copy">
          <strong>FroozERP</strong>
          <small>Feel the Freakin&apos; Frooz - by SRT Company</small>
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

class ModuleErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    console.error("FroozERP module error", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Module Error</span>
                <strong>Unable to open this screen</strong>
              </div>
              <button className="remove-button" onClick={this.props.onClose}><Icon name="close" /></button>
            </div>
            <div className="cart-empty">
              {this.state.error?.message || "Unexpected error while rendering this module."}
            </div>
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const initialView = (() => {
    const requestedView = new URLSearchParams(window.location.search).get("view");
    return navigationItems.some(([view]) => view === requestedView) ? requestedView : "dashboard";
  })();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState(null);
  const [deviceInfo, setDeviceInfo] = useState(() => getClientDeviceInfo());
  const [localDbStatus, setLocalDbStatus] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncMessage, setSyncMessage] = useState("");
  const [startupError, setStartupError] = useState("");
  const [startupNotice, setStartupNotice] = useState("");
  const [backendHealth, setBackendHealth] = useState({
    apiUrl: API_URL,
    url: `${API_URL}/api/health`,
    online: null,
    message: "Backend reachability has not been checked yet.",
  });
  const [loginBusy, setLoginBusy] = useState(false);
  const [offlineMode, setOfflineMode] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [lastReferenceSyncAt, setLastReferenceSyncAt] = useState("");
  const [deviceGate, setDeviceGate] = useState(null);
  const [activationCode, setActivationCode] = useState("");
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [activeView, setActiveView] = useState(initialView);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [products, setProducts] = useState([]);
  const [productCategories, setProductCategories] = useState([]);
  const [productDuplicateWarning, setProductDuplicateWarning] = useState("");
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
    backupLogs: [],
    authorizedDevices: [],
    activationCodes: [],
    branches: [],
    counters: [],
    systemInfo: {},
    canManageSettings: false,
  });
  const [discountRules, setDiscountRules] = useState([]);
  const [lotDiscounts, setLotDiscounts] = useState([]);
  const [customerPendingBills, setCustomerPendingBills] = useState({ summary: [], invoices: [] });
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
    stockLotReport: [],
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
  const [productCategoryId, setProductCategoryId] = useState("");
  const [newProductCategoryName, setNewProductCategoryName] = useState("");
  const [productMinimumStock, setProductMinimumStock] = useState("");
  const [productActive, setProductActive] = useState(true);
  const [productRemarks, setProductRemarks] = useState("");
  const [addOpeningStock, setAddOpeningStock] = useState(false);
  const [openingStockLots, setOpeningStockLots] = useState([]);
  const [openingStockDraft, setOpeningStockDraft] = useState({
    lot_name: "",
    lot_size: "",
    quantity: "",
    purchase_rate: "",
    sale_rate: "",
    opening_stock_date: toDateKey(new Date()),
    supplier_id: "",
    remarks: "",
  });
  const [lotPanelProduct, setLotPanelProduct] = useState(null);
  const [productLots, setProductLots] = useState([]);
  const [productLotAudit, setProductLotAudit] = useState([]);
  const [productListSearch, setProductListSearch] = useState("");
  const [lotListSearch, setLotListSearch] = useState("");
  const [showEmptyLots, setShowEmptyLots] = useState(false);
  const [showInventoryEmptyLots, setShowInventoryEmptyLots] = useState(false);
  const [showOpeningLotForm, setShowOpeningLotForm] = useState(false);
  const [lotAction, setLotAction] = useState(null);
  const [lotDraft, setLotDraft] = useState({
    lot_name: "",
    lot_size: "",
    supplier_id: "",
    purchase_qty: "",
    purchase_rate: "",
    sale_rate: "",
    opening_stock_date: "",
    remarks: "",
    quantity: "",
    new_quantity: "",
    adjustment_date: toDateKey(new Date()),
    reason: "",
  });
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
  const [purchaseLotName, setPurchaseLotName] = useState("");
  const [purchaseLotSize, setPurchaseLotSize] = useState("");
  const [purchaseCart, setPurchaseCart] = useState([]);
  const [editingPurchaseItemIndex, setEditingPurchaseItemIndex] = useState(null);
  const [editingPurchaseId, setEditingPurchaseId] = useState(null);
  const [purchaseAmendmentMode, setPurchaseAmendmentMode] = useState(false);
  const [amendmentDate, setAmendmentDate] = useState("");
  const [amendmentSupplierId, setAmendmentSupplierId] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [selectedInvoicePrintMode, setSelectedInvoicePrintMode] = useState(null);
  const [editingSale, setEditingSale] = useState(null);
  const [saleEditLoading, setSaleEditLoading] = useState(false);
  const [saleEditError, setSaleEditError] = useState("");
  const [changeHistory, setChangeHistory] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [accountLedgerFocusKey, setAccountLedgerFocusKey] = useState("");

  useEffect(() => {
    const onPopState = () => {
      const requestedView = new URLSearchParams(window.location.search).get("view");
      if (requestedView && navigationItems.some(([view]) => view === requestedView)) {
        setActiveView(requestedView);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    initializeLocalDatabase().then(async (status) => {
      if (cancelled) return;
      setLocalDbStatus(status);
      if (!isTauriRuntime()) return;
      const identity = await getOrCreateLocalDeviceIdentity().catch(() => null);
      if (!identity?.device_id || cancelled) return;
      localStorage.setItem("froozerp_device_id", identity.device_id);
      if (identity.device_name) localStorage.setItem("froozerp_device_name", identity.device_name);
      setDeviceInfo((current) => ({
        ...current,
        device_id: identity.device_id,
        device_name: identity.device_name || current.device_name,
        device_type: identity.platform || current.device_type,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshSyncStatus = async () => {
    const status = await getSyncStatus();
    setSyncStatus(status);
    return status;
  };

  const userRef = useRef(user);
  const deviceInfoRef = useRef(deviceInfo);
  const reconnectSyncRef = useRef(false);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    deviceInfoRef.current = deviceInfo;
  }, [deviceInfo]);

  const runSyncNow = async () => {
    if (!user) return null;
    setSyncMessage("Syncing...");
    const status = await syncNow({
      apiUrl: API_URL,
      user,
      deviceInfo,
      branchId: user.branch_id || 1,
    });
    setSyncStatus(status);
    setSyncMessage(status.lastError ? `Sync failed: ${status.lastError}` : "Sync complete");
    return status;
  };

  const applyConnectivityState = useCallback((health) => {
    setBackendHealth(health);
    if (health.online === null || health.checking) return;
    setOfflineMode(!health.online);
    if (health.online) {
      setStartupError((current) => {
        if (!current) return "";
        const recoverable = /backend|network|internet|offline|connect/i.test(current);
        return recoverable ? "" : current;
      });
      setStartupNotice((current) => current || "Online - FroozERP backend is reachable.");
    }
  }, []);

  const performConnectivityCheck = useCallback(async (reason = "manual", options = {}) => {
    const health = await checkBackendHealth(API_URL, {
      details: true,
      timeoutMs: options.timeoutMs || 3500,
      force: Boolean(options.force),
      reason,
    });
    applyConnectivityState(health);
    if (health.online && userRef.current && !reconnectSyncRef.current) {
      reconnectSyncRef.current = true;
      syncNow({
        apiUrl: API_URL,
        user: userRef.current,
        deviceInfo: deviceInfoRef.current,
        branchId: userRef.current.branch_id || 1,
      })
        .then((status) => {
          setSyncStatus(status);
          setSyncMessage(status.lastError ? `Sync failed: ${status.lastError}` : "Online - pending changes checked for sync");
        })
        .finally(() => {
          reconnectSyncRef.current = false;
        });
    }
    return health;
  }, [applyConnectivityState]);

  useEffect(() => subscribeConnectivity(applyConnectivityState), [applyConnectivityState]);

  useEffect(() => {
    performConnectivityCheck("startup", { force: true });
    const handleConnectivityEvent = (event) => {
      if (event.type === "visibilitychange" && document.hidden) return;
      performConnectivityCheck(event.type, { force: true });
    };
    for (const eventName of connectivityEventNames) {
      const target = eventName === "visibilitychange" ? document : window;
      target.addEventListener(eventName, handleConnectivityEvent);
    }
    const timer = window.setInterval(() => {
      performConnectivityCheck(backendHealth.online ? "periodic-online" : "periodic-offline");
    }, backendHealth.online ? 60_000 : 10_000);
    return () => {
      window.clearInterval(timer);
      for (const eventName of connectivityEventNames) {
        const target = eventName === "visibilitychange" ? document : window;
        target.removeEventListener(eventName, handleConnectivityEvent);
      }
    };
  }, [backendHealth.online, performConnectivityCheck]);

  const queuePhase2SyncTest = async () => {
    if (!user) return;
    try {
      const entityId = await queueSafeSyncTest({
        value: `Phase 2 sync test ${new Date().toISOString()}`,
        user,
        deviceInfo,
        branchId: user.branch_id || 1,
      });
      setSyncMessage(`Queued safe sync test ${entityId}`);
      await refreshSyncStatus();
    } catch (error) {
      setSyncMessage(getErrorMessage(error, "Unable to queue safe sync test"));
    }
  };

  const retrySyncFailures = async () => {
    const status = await retryFailedOperations();
    setSyncStatus(status);
    setSyncMessage("Failed sync operations moved back to pending");
  };

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    refreshSyncStatus().then((status) => {
      if (!cancelled) setSyncStatus(status);
    });
    const timer = window.setInterval(() => {
      if (backendHealth.online) runSyncNow();
    }, 60_000);
    const onlineHandler = () => performConnectivityCheck("sync-online-event", { force: true });
    window.addEventListener("online", onlineHandler);
    if (backendHealth.online) runSyncNow();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("online", onlineHandler);
    };
  }, [user, deviceInfo.device_id, backendHealth.online, performConnectivityCheck]);

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

  const hasRolePermission = (permissionKey) => {
    if (!user) return false;
    if (user.role === "Owner") return true;
    const permissions = rolePermissionMap.get(user.role);
    if (permissions && Object.prototype.hasOwnProperty.call(permissions, permissionKey)) {
      return Boolean(permissions[permissionKey]);
    }
    return ["Admin"].includes(user.role) && ["manual_pos_rate_override", "pos_date_override"].includes(permissionKey);
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

  const amendmentSuppliers = useMemo(() => {
    const rows = purchases.filter((purchase) => !amendmentDate || toDateKey(purchase.purchase_date) === amendmentDate);
    return [...new Map(rows.map((purchase) => [String(purchase.supplier_id || purchase.supplier_name), purchase])).values()];
  }, [amendmentDate, purchases]);

  const amendmentPurchases = useMemo(() => purchases.filter((purchase) =>
    (!amendmentDate || toDateKey(purchase.purchase_date) === amendmentDate) &&
    (!amendmentSupplierId || String(purchase.supplier_id || "") === amendmentSupplierId)
  ), [amendmentDate, amendmentSupplierId, purchases]);

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

  const applySettingsBundle = (bundle = {}) => {
    const nextSaleRateSettings = { ...defaultSaleRateSettings, ...(bundle.saleRateSettings || {}) };
    setSettingsData({
      businessSettings: { ...defaultBusinessSettings, ...(bundle.businessSettings || {}) },
      saleRateSettings: nextSaleRateSettings,
      posSettings: { ...defaultPosSettings, ...(bundle.posSettings || {}) },
      paymentSettings: { ...defaultPaymentSettings, ...(bundle.paymentSettings || {}) },
      discountRules: bundle.discountRules || [],
      roles: bundle.roles || [],
      users: bundle.users || [],
      updateCenter: bundle.updateCenter || {},
      syncSettings: bundle.syncSettings || {},
      backupSettings: bundle.backupSettings || {},
      backupLogs: bundle.backupLogs || [],
      authorizedDevices: bundle.authorizedDevices || [],
      activationCodes: bundle.activationCodes || [],
      branches: bundle.branches || [],
      counters: bundle.counters || [],
      systemInfo: bundle.systemInfo || {},
      canManageSettings: Boolean(bundle.canManageSettings),
    });
    setSettingsRules({
      mandiTaxRules: bundle.mandiTaxRules || [],
      rebateRules: bundle.rebateRules || [],
    });
    setDiscountRules((bundle.discountRules || []).filter((rule) => rule.active !== false));
    setLotDiscounts(bundle.lotDiscounts || []);
    setProductDuplicateWarning(bundle.productDuplicateWarning || "");
    setSaleRates(bundle.saleRates || []);
    setSaleRateHistory(bundle.saleRateHistory || []);
    setSaleDesiredMargin(String(nextSaleRateSettings.desired_margin_percent || 25));
  };

  const applyReferenceSnapshot = async (snapshot, { offline = false, nextView = null } = {}) => {
    const bundle = snapshot?.settings_bundle || {};
    setProducts(snapshot?.products || []);
    setProductCategories(snapshot?.categories || []);
    setInventory(snapshot?.inventory_lots || []);
    setCustomers(snapshot?.customers || []);
    setSalesHistory(snapshot?.sales_history || []);
    applySettingsBundle(bundle);
    setOfflineMode(offline);
    setOfflineReady(Boolean(snapshot?.reference_ready));
    setLastReferenceSyncAt(snapshot?.last_successful_sync_at || "");
    setSyncStatus((current) => ({
      ...(current || {}),
      online: !offline,
      syncing: false,
      pendingOperations: Number(snapshot?.pending_operations ?? current?.pendingOperations ?? 0),
      failedOperations: Number(snapshot?.failed_operations ?? current?.failedOperations ?? 0),
      conflictOperations: Number(snapshot?.conflict_operations ?? current?.conflictOperations ?? 0),
      lastSuccessfulSyncAt: snapshot?.last_successful_sync_at || current?.lastSuccessfulSyncAt || "",
      lastPushAt: current?.lastPushAt || "",
      lastPullAt: current?.lastPullAt || "",
      currentCursor: current?.currentCursor || "0",
      lastError: "",
      syncing: false,
    }));
    if (nextView) setActiveView(nextView);
    if (offline) {
      setSyncMessage("Offline - changes will sync later");
      setStartupNotice("Offline mode is active. FroozERP loaded your local SQLite data and will sync changes later.");
    } else {
      setSyncMessage("");
    }
  };

  const fetchOnlineReferenceSnapshot = async (currentUser, latestDevice) => {
    const [
      productsResponse,
      categoriesResponse,
      settingsResponse,
      inventoryResponse,
      customersResponse,
      salesResponse,
      duplicateLogResponse,
      lotDiscountsResponse,
    ] = await Promise.all([
      axios.get(`${API_URL}/products`),
      axios.get(`${API_URL}/product-categories`),
      axios.get(`${API_URL}/settings`, { params: { user_id: currentUser?.id, device_id: latestDevice.device_id } }),
      axios.get(`${API_URL}/inventory`, { params: { include_cancelled: true } }),
      axios.get(`${API_URL}/customers`),
      axios.get(`${API_URL}/sales`),
      axios.get(`${API_URL}/product-duplicate-archive-log`).catch(() => ({ data: { message: "" } })),
      axios.get(`${API_URL}/lot-discounts`).catch(() => ({ data: [] })),
    ]);

    const settingsPayload = settingsResponse.data || {};
    const branchId = String(currentUser?.branch_id || 1);
    const branchRecord = (settingsPayload.branches || []).find((row) => String(row.id) === branchId);

    return {
      cached_at: new Date().toISOString(),
      last_successful_sync_at: new Date().toISOString(),
      branch_context: {
        branch_id: branchId,
        branch_name: branchRecord?.branch_name || currentUser?.branch || "Main Branch",
      },
      user_profile: currentUser,
      device_identity: {
        ...latestDevice,
        platform: "tauri-windows",
        app_version: APP_VERSION,
        branch_id: branchId,
        registration_status: "approved",
      },
      products: productsResponse.data || [],
      categories: categoriesResponse.data || [],
      inventory_lots: inventoryResponse.data || [],
      customers: customersResponse.data || [],
      sales_history: salesResponse.data || [],
      settings_bundle: {
        businessSettings: settingsPayload.businessSettings || {},
        saleRateSettings: settingsPayload.saleRateSettings || {},
        posSettings: settingsPayload.posSettings || {},
        paymentSettings: settingsPayload.paymentSettings || {},
        discountRules: settingsPayload.discountRules || [],
        roles: settingsPayload.roles || [],
        users: settingsPayload.users || [],
        updateCenter: settingsPayload.updateCenter || {},
        syncSettings: settingsPayload.syncSettings || {},
        backupSettings: settingsPayload.backupSettings || {},
        backupLogs: settingsPayload.backupLogs || [],
        authorizedDevices: settingsPayload.authorizedDevices || [],
        activationCodes: settingsPayload.activationCodes || [],
        branches: settingsPayload.branches || [],
        counters: settingsPayload.counters || [],
        systemInfo: settingsPayload.systemInfo || {},
        canManageSettings: Boolean(settingsPayload.canManageSettings),
        mandiTaxRules: settingsPayload.mandiTaxRules || [],
        rebateRules: settingsPayload.rebateRules || [],
        lotDiscounts: lotDiscountsResponse.data || [],
        productDuplicateWarning: duplicateLogResponse.data?.message || "",
      },
    };
  };

  const hydrateOnlineSession = async (currentUser, latestDevice) => {
    const snapshot = await fetchOnlineReferenceSnapshot(currentUser, latestDevice);
    const offlineSession = await cacheOfflineSession({
      username,
      password,
      user: currentUser,
      deviceId: latestDevice.device_id,
      branchId: currentUser?.branch_id || 1,
      lastSuccessfulSyncAt: snapshot.last_successful_sync_at,
    });
    await applyReferenceSnapshot(snapshot, { offline: false, nextView: initialView });
    if (isTauriRuntime()) {
      const status = await cacheLocalReferenceSnapshot({
        ...snapshot,
        offline_auth: offlineSession,
      });
      setLocalDbStatus(status);
    }
    setStartupNotice("Online login succeeded and local reference data has been refreshed for offline use.");
    return snapshot;
  };

  const continueOffline = async (latestDevice = deviceInfo) => {
    latestDevice = await resolveLocalDeviceInfo(latestDevice || getClientDeviceInfo());
    const snapshot = await loadLocalReferenceSnapshot({
      username,
      deviceId: latestDevice.device_id,
    }).catch(() => null);
    const cachedOfflineRecord = hasObjectContent(snapshot?.offline_auth)
      ? snapshot.offline_auth
      : readOfflineSession();
    const offlineAuth = cachedOfflineRecord
      ? await verifyOfflineSessionRecord(cachedOfflineRecord, {
        username,
        password,
        deviceId: latestDevice.device_id,
      })
      : await authenticateOfflineSession({
        username,
        password,
        deviceId: latestDevice.device_id,
      });
    if (!offlineAuth.ok) {
      setStartupError(offlineAuth.message);
      return false;
    }
    if (!snapshot?.reference_ready) {
      setOfflineReady(false);
      setLastReferenceSyncAt(snapshot?.last_successful_sync_at || offlineAuth.session?.lastSuccessfulSyncAt || "");
      setStartupError("This device must connect to the internet once before offline use.");
      return false;
    }
    const offlineUser = hasObjectContent(snapshot?.user_profile)
      ? snapshot.user_profile
      : offlineAuth.session?.user;
    setUser({ ...offlineUser, offline_session: true });
    await applyReferenceSnapshot(snapshot, { offline: true, nextView: "sales" });
    return true;
  };

  const loadProducts = async () => {
    const [response, duplicateLogResponse] = await Promise.all([
      axios.get(`${API_URL}/products`),
      axios.get(`${API_URL}/product-duplicate-archive-log`).catch(() => ({ data: { message: "" } })),
    ]);
    setProducts(response.data);
    setProductDuplicateWarning(duplicateLogResponse.data?.message || "");
  };
  const loadProductCategories = async () => {
    const response = await axios.get(`${API_URL}/product-categories`);
    setProductCategories(response.data);
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
    const response = await axios.get(`${API_URL}/settings`, { params: { user_id: currentUser?.id, device_id: deviceInfo.device_id } });
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
      backupLogs: data.backupLogs || [],
      authorizedDevices: data.authorizedDevices || [],
      activationCodes: data.activationCodes || [],
      branches: data.branches || [],
      counters: data.counters || [],
      systemInfo: data.systemInfo || {},
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

  const loadLotDiscounts = async () => {
    const response = await axios.get(`${API_URL}/lot-discounts`);
    setLotDiscounts(response.data);
  };

  const loadCustomerPendingBills = async () => {
    const response = await axios.get(`${API_URL}/pending-bills/customer`);
    setCustomerPendingBills(response.data || { summary: [], invoices: [] });
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
    if (isTauriRuntime() && offlineMode) {
      const snapshot = await loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id }).catch(() => null);
      const localRows = await listLocalPosSales().catch(() => []);
      const salesRows = localRows.map(localSnapshotToInvoice);
      setReportsData((current) => ({
        ...current,
        salesHistoryReport: salesRows,
        stockLotReport: snapshot?.inventory_lots || inventory,
        cashBookReport: salesRows.flatMap((sale) => (sale.payments || []).map((payment) => ({
          transaction_date: sale.sale_date,
          source: "LOCAL_POS",
          party_name: sale.customer_name || "Walk-in Customer",
          payment_mode: payment.mode || payment.payment_mode || sale.payment_mode,
          total_amount: Number(payment.amount || sale.total_amount || 0),
          transaction_count: 1,
        }))),
      }));
      return;
    }
    const [response, inventoryResponse, cashBookResponse] = await Promise.all([
      axios.get(`${API_URL}/reports/summary`, { params }),
      axios.get(`${API_URL}/inventory`, { params: { include_cancelled: true } }),
      axios.get(`${API_URL}/reports/cash-book`, { params }),
    ]);
    setReportsData({ ...response.data, stockLotReport: inventoryResponse.data, cashBookReport: cashBookResponse.data });
  };

  const loadExpenses = async () => {
    const response = await axios.get(`${API_URL}/expenses`);
    setExpenses(response.data);
  };

  const loadSalesHistory = async () => {
    if (isTauriRuntime() && offlineMode) {
      const localRows = await listLocalPosSales();
      setSalesHistory(localRows.map(localSnapshotToInvoice));
      return;
    }
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
    if (isTauriRuntime() && offlineMode) {
      const snapshot = await loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id }).catch(() => null);
      const localRows = await listLocalPosSales().catch(() => []);
      setInventory(snapshot?.inventory_lots || inventory);
      setSalesHistory(localRows.map(localSnapshotToInvoice));
      setSupplierDashboard((current) => current || {});
      setDashboardAnalytics((current) => current || {});
      return;
    }
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
    setLoginBusy(true);
    setStartupError("");
    setStartupNotice("");
    try {
      const latestDevice = await resolveLocalDeviceInfo(getClientDeviceInfo());
      setDeviceInfo(latestDevice);
      const health = await performConnectivityCheck("login", { force: true, timeoutMs: 4000 });
      const backendOnline = health.online;

      if (!backendOnline) {
        setOfflineMode(true);
        const opened = await continueOffline(latestDevice);
        if (!opened) {
          setStartupError((current) => current || `Backend health check failed at ${health.url}: ${health.message}.`);
        }
        return;
      }

      const response = await axios.post(`${API_URL}/login`, { username: username.trim(), password, ...latestDevice }, { timeout: 8000 });
      setDeviceGate(null);
      setUser(response.data);
      if (response.data?.force_password_change) {
        setStartupNotice("Sign in succeeded. This account must change its temporary password from User Management before regular use.");
      }

      try {
        await hydrateOnlineSession(response.data, latestDevice);
      } catch (hydrateError) {
        console.error("Online hydration failed", hydrateError);
        const snapshot = await loadLocalReferenceSnapshot({ username, deviceId: latestDevice.device_id }).catch(() => null);
        if (snapshot?.reference_ready) {
          setUser({ ...response.data, offline_session: true });
          await applyReferenceSnapshot(snapshot, { offline: true, nextView: "sales" });
          setStartupNotice("Backend login succeeded. FroozERP continued in offline mode because reference-data refresh failed.");
          return;
        }
        setUser(null);
        setStartupError(getErrorMessage(hydrateError, "Login succeeded, but no usable local reference data was available."));
      }
    } catch (error) {
      if (["DEVICE_NOT_APPROVED", "DEVICE_PENDING_APPROVAL", "DEVICE_DISABLED", "DEVICE_REVOKED", "DEVICE_ID_REQUIRED"].includes(error.response?.data?.code)) {
        setDeviceGate(error.response.data);
        setStartupError(error.response.data.message || "This device is not approved.");
        return;
      }
      if (isTauriRuntime()) {
        const latestDevice = await resolveLocalDeviceInfo(getClientDeviceInfo());
        const opened = await continueOffline(latestDevice);
        if (opened) return;
      }
      setStartupError(getAuthErrorMessage(error, `Unable to sign in through ${API_URL}. Connect once to the FroozERP backend to authorise this device.`));
    } finally {
      setLoginBusy(false);
    }
  };

  const retryOnline = async () => {
    setLoginBusy(true);
    setStartupError("");
    setStartupNotice(`Checking backend at ${API_URL}/api/health...`);
    try {
      const latestDevice = await resolveLocalDeviceInfo(getClientDeviceInfo());
      setDeviceInfo(latestDevice);
      const health = await performConnectivityCheck("retry-online", { force: true, timeoutMs: 4000 });
      if (health.online) {
        setStartupNotice(`Backend online at ${health.url}. Enter credentials and click Sign In to complete first online login.`);
      } else {
        setStartupError(`Backend health check failed at ${health.url}: ${health.message}`);
      }
      return health;
    } finally {
      setLoginBusy(false);
    }
  };

  const activateDevice = async () => {
    if (!activationCode.trim()) {
      alert("Enter activation code.");
      return;
    }
    try {
      const latestDevice = getClientDeviceInfo();
      const response = await axios.post(`${API_URL}/devices/activate`, {
        ...latestDevice,
        activation_code: activationCode,
      });
      setDeviceInfo(response.data.device || latestDevice);
      setDeviceGate(null);
      setActivationCode("");
      alert("Device activated. Please login again.");
    } catch (error) {
      alert(getErrorMessage(error, "Device activation failed"));
    }
  };

  const addProduct = async () => {
    try {
      const wasEditing = Boolean(editingProductId);
      const selectedCategory = productCategories.find((category) => String(category.id) === String(productCategoryId));
      const finalCategoryName = selectedCategory?.category_name || newProductCategoryName.trim() || productCategory.trim();
      const normalizedName = productName.trim().toLowerCase();
      const duplicateProduct = products.find((product) =>
        product.product_name?.trim().toLowerCase() === normalizedName &&
        Number(product.id) !== Number(editingProductId || 0)
      );
      if (duplicateProduct) {
        alert("This product already exists.");
        return;
      }
      if (!finalCategoryName) {
        alert("Please select or add product category.");
        return;
      }
      if (addOpeningStock && !editingProductId && openingStockLots.length === 0) {
        alert("Please add at least one opening stock lot.");
        return;
      }
      const payload = {
        product_name: productName,
        selling_rate: sellingRate,
        unit,
        barcode: productBarcode,
        origin_type: productOriginType,
        category: finalCategoryName,
        category_id: productCategoryId || null,
        minimum_stock: productMinimumStock,
        active: productActive,
        remarks: productRemarks,
        branch_id: user.branch_id,
        created_by: user.id,
        updated_by: user.id,
        opening_stock_lots: addOpeningStock && !editingProductId ? openingStockLots : [],
      };
      if (editingProductId) {
        await axios.put(`${API_URL}/products/${editingProductId}`, payload);
        if (addOpeningStock && openingStockLots.length > 0) {
          await axios.post(`${API_URL}/products/${editingProductId}/opening-stock`, {
            opening_stock_lots: openingStockLots,
            branch_id: user.branch_id,
            created_by: user.id,
          });
        }
      } else {
        await axios.post(`${API_URL}/products`, payload);
      }
      resetProductForm();
      await Promise.all([loadProducts(), loadProductCategories(), loadDashboardData()]);
      alert(wasEditing ? "Product Updated" : "Product Added");
    } catch (error) {
      alert(getErrorMessage(error, "Error Adding Product"));
    }
  };

  const resetProductForm = () => {
    setProductName("");
    setSellingRate("");
    setUnit("");
    setProductBarcode("");
    setProductOriginType("LOCAL");
    setProductCategory("Fruit");
    setProductCategoryId("");
    setNewProductCategoryName("");
    setProductMinimumStock("");
    setProductActive(true);
    setProductRemarks("");
    setAddOpeningStock(false);
    setOpeningStockLots([]);
    setOpeningStockDraft({
      lot_name: "",
      lot_size: "",
      quantity: "",
      purchase_rate: "",
      sale_rate: "",
      opening_stock_date: toDateKey(new Date()),
      supplier_id: "",
      remarks: "",
    });
    setLotPanelProduct(null);
    setProductLots([]);
    setProductLotAudit([]);
    setShowOpeningLotForm(false);
    setLotAction(null);
    setEditingProductId(null);
  };

  const saveProductCategory = async () => {
    try {
      const categoryName = newProductCategoryName.trim();
      if (!categoryName) {
        alert("Please enter category name.");
        return;
      }
      const duplicate = productCategories.find((category) => category.category_name?.trim().toLowerCase() === categoryName.toLowerCase());
      if (duplicate) {
        alert("Category already exists.");
        setProductCategoryId(String(duplicate.id));
        setProductCategory(duplicate.category_name);
        return;
      }
      const response = await axios.post(`${API_URL}/product-categories`, {
        category_name: categoryName,
        created_by: user.id,
      });
      await loadProductCategories();
      setProductCategoryId(String(response.data.id));
      setProductCategory(response.data.category_name);
      setNewProductCategoryName("");
      alert("Category saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save category"));
    }
  };

  const editProductCategory = async (category) => {
    const nextName = window.prompt("Edit category name", category.category_name);
    if (!nextName?.trim()) return;
    try {
      await axios.put(`${API_URL}/product-categories/${category.id}`, {
        category_name: nextName,
        active: category.active !== false,
        remarks: category.remarks || "",
        updated_by: user.id,
        reason: "Category renamed from Product Master",
      });
      await Promise.all([loadProductCategories(), loadProducts()]);
      alert("Category updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update category"));
    }
  };

  const deactivateProductCategory = async (category) => {
    const reason = window.prompt(`Enter reason to remove/deactivate ${category.category_name}`);
    if (!reason?.trim()) return;
    try {
      await axios.delete(`${API_URL}/product-categories/${category.id}`, {
        data: { updated_by: user.id, reason },
      });
      await loadProductCategories();
      alert("Category removed");
    } catch (error) {
      await loadProductCategories();
      alert(getErrorMessage(error, "This category has items or transactions. It can only be deactivated."));
    }
  };

  const getSupplierLabel = (supplierId) => {
    const supplier = activeSuppliers.find((item) => String(item.id) === String(supplierId));
    return supplier?.supplier_name || "";
  };

  const getOpeningLotName = (draft, nextIndex) => draft.lot_name.trim() || `Opening Lot ${nextIndex}`;

  const isSameOpeningLot = (left, right) =>
    String(left.product_id || editingProductId || "").toLowerCase() === String(right.product_id || editingProductId || "").toLowerCase() &&
    String(left.lot_name || "").trim().toLowerCase() === String(right.lot_name || "").trim().toLowerCase() &&
    String(left.supplier_id || "").trim() === String(right.supplier_id || "").trim() &&
    String(left.opening_stock_date || left.purchase_date || "").slice(0, 10) === String(right.opening_stock_date || right.purchase_date || "").slice(0, 10) &&
    String(left.lot_size || "").trim().toLowerCase() === String(right.lot_size || "").trim().toLowerCase();

  const resetOpeningStockDraft = () => {
    setOpeningStockDraft({
      lot_name: "",
      lot_size: "",
      quantity: "",
      purchase_rate: "",
      sale_rate: sellingRate,
      opening_stock_date: toDateKey(new Date()),
      supplier_id: "",
      remarks: "",
    });
  };

  const buildOpeningStockLotFromDraft = () => {
    const quantity = Number(openingStockDraft.quantity || 0);
    const purchaseRate = Number(openingStockDraft.purchase_rate || 0);
    const saleRate = Number(openingStockDraft.sale_rate || sellingRate || 0);
    if (quantity <= 0) {
      alert("Please enter lot quantity.");
      return null;
    }
    if (purchaseRate <= 0) {
      alert("Please enter opening stock rate.");
      return null;
    }
    if (saleRate <= 0) {
      alert("Please enter sale rate.");
      return null;
    }
    const nextLotName = getOpeningLotName(openingStockDraft, productLots.length + openingStockLots.length + 1);
    const nextLot = {
      ...openingStockDraft,
      lot_name: nextLotName,
      supplier_name: getSupplierLabel(openingStockDraft.supplier_id),
      sale_rate: saleRate,
    };
    const duplicateLot = [...productLots, ...openingStockLots].find((lot) => isSameOpeningLot(lot, nextLot));
    if (duplicateLot) {
      const confirmed = window.confirm("This lot already exists. Add as separate lot anyway?");
      if (!confirmed) return null;
      nextLot.allow_duplicate_lot = true;
    }
    return nextLot;
  };

  const addOpeningStockLot = () => {
    const nextLot = buildOpeningStockLotFromDraft();
    if (!nextLot) return;
    setOpeningStockLots((current) => [...current, nextLot]);
    resetOpeningStockDraft();
  };

  const saveNewOpeningStockLot = async () => {

  const activeproductId = editingProductId || lotPanelProduct?.id;

  if (!activeproductId) {
    alert("No product id found");
    return;
  }

  const nextLot = buildOpeningStockLotFromDraft();
  alert(JSON.stringify(nextLot, null, 2));

  if (!nextLot) {
    alert("Lot data invalid. Check lot name, quantity, purchase rate, sale rate/date.");
    return;
  }

  try {
      const payload = {
        ...nextLot,
        opening_cost: nextLot.purchase_rate,
        size_grade: nextLot.lot_size,
        created_by: user.id,
        branch_id: user.branch_id,
      };
      try {
        await axios.post(`${API_URL}/products/${activeproductId}/opening-stock-lots`, payload);
      } catch (error) {
        const message = getErrorMessage(error, "Unable to add opening stock lot");
        if (message.includes("Add as separate lot anyway?") && window.confirm("This lot already exists. Add as separate lot anyway?")) {
          await axios.post(`${API_URL}/products/${activeproductId}/opening-stock-lots`, { ...payload, allow_duplicate_lot: true });
        } else {
          throw error;
        }
      }
      resetOpeningStockDraft();
      setShowOpeningLotForm(false);
      setAddOpeningStock(false);
      await refreshLotContext(lotPanelProduct || { id: activeproductId, product_name: productName });
      alert("Opening stock lot added");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to add opening stock lot"));
    }
  };

  const loadProductLots = async (product, showPanel = true) => {
    try {
      const response = await axios.get(`${API_URL}/products/${product.id}/lots`);
      setProductLots(response.data.lots || []);
      setProductLotAudit(response.data.audit || []);
      if (showPanel) setLotPanelProduct(product);
    } catch (error) {
      alert(getErrorMessage(error, "Unable to load product lots"));
    }
  };

  const openLotAction = (type, lot) => {
    setLotAction({ type, lot });
    setLotDraft({
      lot_name: lot.lot_name || lot.batch_no || "",
      lot_size: lot.lot_size || "",
      supplier_id: lot.supplier_id ? String(lot.supplier_id) : "",
      purchase_qty: String(lot.purchase_qty || ""),
      purchase_rate: String(lot.purchase_rate || lot.effective_cost_per_unit || ""),
      sale_rate: String(lot.temporary_sale_rate || lot.selling_rate || ""),
      opening_stock_date: toDateKey(lot.purchase_date || new Date()),
      remarks: lot.remarks || "",
      quantity: "",
      new_quantity: String(lot.balance_qty ?? lot.remaining_qty ?? 0),
      adjustment_type: "Physical Count Correction",
      transfer_to_lot_id: "",
      transfer_quantity: "",
      adjustment_date: toDateKey(new Date()),
      reason: "",
    });
  };

  const closeLotAction = () => {
    setLotAction(null);
    setLotDraft({
      lot_name: "",
      lot_size: "",
      supplier_id: "",
      purchase_qty: "",
      purchase_rate: "",
      sale_rate: "",
      opening_stock_date: "",
      remarks: "",
      quantity: "",
      new_quantity: "",
      adjustment_type: "Physical Count Correction",
      transfer_to_lot_id: "",
      transfer_quantity: "",
      adjustment_date: toDateKey(new Date()),
      reason: "",
    });
  };

  const refreshLotContext = async (product = lotPanelProduct) => {
    const inventoryResponse = await axios.get(`${API_URL}/inventory`, { params: { include_cancelled: true } });
    setInventory(inventoryResponse.data);
    await Promise.all([loadProducts(), loadDashboardData(), loadReports()]);
    if (product?.id) await loadProductLots(product, true);
  };

  const saveLotAction = async () => {
    if (!lotAction?.lot?.id) return;
    try {
      const selectedSupplier = activeSuppliers.find((supplier) => String(supplier.id) === String(lotDraft.supplier_id));
      const basePayload = {
        updated_by: user.id,
        branch_id: user.branch_id,
        reason: lotDraft.reason,
      };
      if (lotAction.type === "edit") {
        const nextQty = Number(lotDraft.purchase_qty || 0);
        const nextCost = Number(lotDraft.purchase_rate || 0);
        if (!lotDraft.lot_name.trim()) {
          alert("Please enter lot name / number.");
          return;
        }
        if (!Number.isFinite(nextQty) || nextQty < 0) {
          alert("Please enter a valid opening quantity.");
          return;
        }
        if (!Number.isFinite(nextCost) || nextCost <= 0) {
          alert("Please enter a valid opening cost / purchase rate.");
          return;
        }
        await axios.put(`${API_URL}/inventory-lots/${lotAction.lot.id}`, {
          ...basePayload,
          lot_name: lotDraft.lot_name,
          lot_size: lotDraft.lot_size,
          supplier_id: lotDraft.supplier_id || null,
          supplier_name: selectedSupplier?.supplier_name || null,
          purchase_qty: lotDraft.purchase_qty,
          purchase_rate: lotDraft.purchase_rate,
          sale_rate: lotDraft.sale_rate,
          opening_stock_date: lotDraft.opening_stock_date,
          remarks: lotDraft.remarks,
          reason: lotDraft.reason || "Opening stock lot edited",
        });
        alert("Lot updated");
      }
      if (lotAction.type === "add") {
        if (Number(lotDraft.quantity || 0) <= 0) {
          alert("Enter quantity to add.");
          return;
        }
        await axios.post(`${API_URL}/inventory-lots/${lotAction.lot.id}/add-quantity`, {
          ...basePayload,
          quantity: lotDraft.quantity,
          reason: lotDraft.reason || "Quantity added to opening stock lot",
        });
        alert("Quantity added");
      }
      if (lotAction.type === "adjust") {
        const nextQty = Number(lotDraft.new_quantity || 0);
        if (!lotDraft.reason.trim()) {
          alert("Adjustment reason is required.");
          return;
        }
        if (!Number.isFinite(nextQty) || nextQty < 0) {
          alert("Please enter a valid physical quantity.");
          return;
        }
        await axios.post(`${API_URL}/inventory-lots/${lotAction.lot.id}/adjust`, {
          ...basePayload,
          physical_quantity: lotDraft.new_quantity,
          adjustment_type: lotDraft.adjustment_type,
          adjustment_date: lotDraft.adjustment_date,
          remarks: lotDraft.remarks,
          reason: lotDraft.reason,
        });
        alert("Lot adjusted");
      }
      if (lotAction.type === "transfer") {
        if (!lotDraft.reason.trim()) {
          alert("Transfer reason is required.");
          return;
        }
        if (!lotDraft.transfer_to_lot_id) {
          alert("Select destination lot.");
          return;
        }
        if (Number(lotDraft.transfer_quantity || 0) <= 0) {
          alert("Enter quantity to move.");
          return;
        }
        await axios.post(`${API_URL}/lots/transfer-stock`, {
          from_lot_id: lotAction.lot.id,
          to_lot_id: lotDraft.transfer_to_lot_id,
          quantity: lotDraft.transfer_quantity,
          reason: lotDraft.reason,
          remarks: lotDraft.remarks,
          updated_by: user.id,
        });
        alert("Stock transferred");
      }
      if (lotAction.type === "deactivate") {
        if (!lotDraft.reason.trim()) {
          alert("Reason is required to deactivate a lot.");
          return;
        }
        await axios.post(`${API_URL}/inventory-lots/${lotAction.lot.id}/deactivate`, {
          ...basePayload,
          reason: lotDraft.reason,
          deactivated_by: user.id,
        });
        alert("Lot deactivated");
      }
      if (lotAction.type === "reactivate") {
        if (!lotDraft.reason.trim()) {
          alert("Reason is required to reactivate a lot.");
          return;
        }
        await axios.post(`${API_URL}/inventory-lots/${lotAction.lot.id}/reactivate`, {
          ...basePayload,
          reason: lotDraft.reason,
          reactivated_by: user.id,
        });
        alert("Lot reactivated");
      }
      closeLotAction();
      await refreshLotContext();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update lot"));
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
    setPurchaseLotName("");
    setPurchaseLotSize("");
    setPurchaseCart([]);
    setEditingPurchaseItemIndex(null);
    setEditingPurchaseId(null);
    setPurchaseAmendmentMode(false);
    setAmendmentDate("");
    setAmendmentSupplierId("");
  };

  const resetPurchaseItemFields = () => {
    setPurchaseProductId("");
    setPurchaseQuantity("");
    setPurchaseRateInput("");
    setTemporarySaleRate("");
    setExpectedPurchaseRate("");
    setPurchaseItemRemarks("");
    setPurchaseLotName("");
    setPurchaseLotSize("");
    setEditingPurchaseItemIndex(null);
  };

  const addPurchaseCartItem = () => {
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
    if (!purchaseLotName.trim()) {
      alert("Please enter lot name / size.");
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
      lot_name: purchaseLotName,
      lot_size: purchaseLotSize,
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
    setPurchaseLotName(item.lot_name || "");
    setPurchaseLotSize(item.lot_size || "");
    setPurchaseItemRemarks(item.remarks || "");
  };

  const removePurchaseCartItem = (index) => {
    setPurchaseCart((currentCart) => currentCart.filter((_, itemIndex) => itemIndex !== index));
    if (editingPurchaseItemIndex === index) resetPurchaseItemFields();
  };

  const validatePurchaseBeforeSave = () => {
    if (!purchaseSupplierId) return "Please select supplier";
    if (editingPurchaseId) {
      const productName = selectedPurchaseProduct?.product_name || "selected item";
      if (!purchaseProductId) return "Please select product";
      if (Number(purchaseQuantity || 0) <= 0) return `Please enter quantity for ${productName}`;
      if (purchaseBillStatus === "BILL_COMPLETED") {
        if (Number(purchaseRateInput || 0) <= 0) return `Please enter purchase rate for ${productName}`;
        if (!purchaseRebateRuleId) return "Please select rebate rule";
        if (purchaseType === "CASH" && Number(purchasePaidAmount || 0) <= 0) return "Please enter paid amount";
      }
      if (purchaseBillStatus === "BILL_PENDING" && Number(temporarySaleRate || 0) <= 0) return `Please enter temporary sale rate for ${productName}`;
      return "";
    }
    if (purchaseCart.length === 0) return "Please add at least one item";
    if (purchaseBillStatus === "BILL_COMPLETED") {
      const missingRate = purchaseCart.find((item) => Number(item.purchase_rate || 0) <= 0);
      if (missingRate) return `Please enter purchase rate for ${missingRate.product_name}`;
      if (!purchaseRebateRuleId) return "Please select rebate rule";
      if (purchaseType === "CASH" && Number(purchasePaidAmount || 0) <= 0) return "Please enter paid amount";
    }
    if (purchaseBillStatus === "BILL_PENDING") {
      const missingTempRate = purchaseCart.find((item) => Number(item.temporary_sale_rate || 0) <= 0);
      if (missingTempRate) return `Please enter temporary sale rate for ${missingTempRate.product_name}`;
    }
    return "";
  };

  const savePurchase = async () => {
    try {
      const wasEditing = Boolean(editingPurchaseId);
      const validationMessage = validatePurchaseBeforeSave();
      if (validationMessage) {
        alert(validationMessage);
        return;
      }
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
        lot_name: purchaseLotName,
        lot_size: purchaseLotSize,
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
      if (purchaseAmendmentMode) {
        setPurchaseCart([]);
        resetPurchaseItemFields();
      } else {
        resetPurchaseForm();
      }
      await Promise.all([loadDashboardData(), loadPurchases(), loadSupplierData(), loadAccounts(), loadAccountOutstanding()]);
      alert(purchaseBillStatus === "BILL_PENDING" ? "Stock Arrival Saved - Bill Pending" : wasEditing ? "Purchase Updated" : "Purchase Saved");
    } catch (error) {
      alert(getErrorMessage(error, "Purchase Error"));
    }
  };

  const loadInvoice = async (saleId, options = {}) => {
    try {
      if (isTauriRuntime() && (offlineMode || String(saleId || "").startsWith("invoice-") || String(saleId || "").startsWith("pos-invoice-"))) {
        const snapshot = await loadLocalPosSale(saleId);
        setSelectedInvoice(localSnapshotToInvoice(snapshot));
        setSelectedInvoicePrintMode(options.print ? (options.printMode || "THERMAL") : null);
        return;
      }
      const response = await axios.get(`${API_URL}/sales/${saleId}`);
      setSelectedInvoice(response.data);
      setSelectedInvoicePrintMode(options.print ? (options.printMode || "THERMAL") : null);
    } catch (error) {
      alert(getErrorMessage(error, "Error Loading Invoice"));
    }
  };

  const printSaleInvoice = async (saleId, printMode = "THERMAL") => {
    const invoiceId = saleId || "";
    if (!invoiceId) {
      alert("Unable to print invoice. Invoice ID is missing.");
      return;
    }
    await loadInvoice(invoiceId, { print: true, printMode });
  };

  const loadSaleForEdit = async (saleId) => {
    setSaleEditLoading(true);
    setSaleEditError("");
    try {
      if (isTauriRuntime() && (offlineMode || String(saleId || "").startsWith("invoice-") || String(saleId || "").startsWith("pos-invoice-"))) {
        const snapshot = await loadLocalPosSale(saleId);
        setEditingSale(localSnapshotToInvoice(snapshot));
        return;
      }
      const response = await axios.get(`${API_URL}/sales/${saleId}`);
      setEditingSale(response.data);
    } catch (error) {
      const message = getErrorMessage(error, "Error Loading Invoice");
      setSaleEditError(message);
      alert(message);
    } finally {
      setSaleEditLoading(false);
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
    const saleId = sale.sale_id || sale.id || "";
    if (!saleId) {
      alert("Unable to cancel invoice. Invoice ID is missing.");
      return false;
    }
    const reason = window.prompt(`Enter cancellation reason for ${sale.invoice_no || `#${sale.id}`}`);
    if (!reason?.trim()) return false;
    try {
      if (isTauriRuntime() && (offlineMode || sale.sync_status || String(saleId).startsWith("invoice-") || String(saleId).startsWith("pos-invoice-"))) {
        const result = await cancelLocalPosSale({
          invoice_global_id: String(saleId),
          reason,
          user_id: String(user.id || ""),
          device_id: deviceInfo.device_id,
        });
        const localInvoice = localSnapshotToInvoice(result.invoice);
        setSalesHistory((rows) => rows.map((row) => String(row.id) === String(saleId) ? { ...row, ...localInvoice } : row));
        const snapshot = await loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id }).catch(() => null);
        if (snapshot) {
          setInventory(snapshot.inventory_lots || []);
        }
        await refreshSyncStatus();
        return true;
      }
      await axios.post(`${API_URL}/sales/${saleId}/cancel`, { reason, cancelled_by: user.id });
      await Promise.all([loadSalesHistory(), loadDashboardData(), loadReports()]);
      alert("Invoice cancelled");
      return true;
    } catch (error) {
      alert(getErrorMessage(error, "Unable to cancel invoice"));
      return false;
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
    setProductCategoryId(product.category_id ? String(product.category_id) : "");
    setProductMinimumStock(product.minimum_stock || "");
    setProductActive(product.active !== false);
    setProductRemarks(product.remarks || "");
    setAddOpeningStock(false);
    setOpeningStockLots([]);
    setShowOpeningLotForm(false);
    setEditingProductId(product.id);
    loadProductLots(product, true);
  };

  const cancelProductEdit = () => {
    resetProductForm();
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
    setPurchaseAmendmentMode(true);
    setAmendmentDate(toDateKey(purchase.purchase_date || new Date()));
    setAmendmentSupplierId(String(purchase.supplier_id || ""));
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
    setPurchaseLotName(purchase.lot_name || purchase.item_lot_name || "");
    setPurchaseLotSize(purchase.lot_size || purchase.item_lot_size || "");
    setPurchaseCart([]);
    setEditingPurchaseItemIndex(null);
    setActiveView("purchase");
  };

  const openPurchaseAmendment = (purchase) => {
    setPurchaseAmendmentMode(true);
    setEditingPurchaseId(null);
    setAmendmentDate(toDateKey(purchase.purchase_date || new Date()));
    setAmendmentSupplierId(String(purchase.supplier_id || ""));
    setPurchaseDate(toDateKey(purchase.purchase_date || new Date()));
    setPurchaseSupplierId(String(purchase.supplier_id || ""));
    setPurchaseBillStatus(purchase.purchase_bill_status || "BILL_COMPLETED");
    setPurchaseType(purchase.purchase_type === "PENDING_BILL" ? "CREDIT" : purchase.purchase_type || "CREDIT");
    setPurchasePaymentMode(purchase.payment_mode || "CASH");
    setPurchasePaymentReference(purchase.payment_reference_number || "");
    setPurchaseBillNumber(purchase.bill_number || "");
    setPurchaseBillDate(purchase.bill_date ? toDateKey(purchase.bill_date) : "");
    setPurchaseFreightCharges("");
    setPurchaseLabourCharges("");
    setPurchaseOtherCharges("");
    setPurchasePaidAmount("");
    setPurchaseRebateRuleId(String(purchase.rebate_rule_id || ""));
    setPurchaseRemarks(purchase.remarks || "");
    setPurchaseCart([]);
    resetPurchaseItemFields();
    setActiveView("purchase");
  };

  const openBlankPurchaseAmendment = () => {
    setPurchaseAmendmentMode(true);
    setEditingPurchaseId(null);
    setAmendmentDate("");
    setAmendmentSupplierId("");
    setPurchaseDate(toDateKey(new Date()));
    setPurchaseSupplierId("");
    setPurchaseBillStatus("BILL_COMPLETED");
    setPurchaseType("CREDIT");
    setPurchasePaymentMode("CASH");
    setPurchasePaymentReference("");
    setPurchaseBillNumber("");
    setPurchaseBillDate("");
    setPurchaseFreightCharges("");
    setPurchaseLabourCharges("");
    setPurchaseOtherCharges("");
    setPurchasePaidAmount("");
    setPurchaseRebateRuleId("");
    setPurchaseRemarks("");
    setPurchaseCart([]);
    resetPurchaseItemFields();
    setActiveView("purchase");
  };

  const startForgottenPurchaseItem = () => {
    if (!amendmentDate || !amendmentSupplierId) {
      alert("Select purchase date and supplier first.");
      return;
    }
    setEditingPurchaseId(null);
    setPurchaseDate(amendmentDate);
    setPurchaseSupplierId(amendmentSupplierId);
    if (purchaseBillStatus === "BILL_PENDING") setPurchaseType("CREDIT");
    resetPurchaseItemFields();
  };

  const cancelPurchaseAmendment = () => {
    setEditingPurchaseId(null);
    resetPurchaseItemFields();
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

  const openCustomerLedgerFromReport = async (sale) => {
    let customerRows = customers;
    if (!customerRows.length) {
      const response = await axios.get(`${API_URL}/customers`);
      customerRows = response.data;
      setCustomers(response.data);
    }
    const saleCustomerId = Number(sale.customer_id || 0);
    const saleMobile = String(sale.customer_mobile || "").trim();
    const saleName = String(sale.customer_name || "").trim().toLowerCase();
    const customer = customerRows.find((item) => {
      if (saleCustomerId && Number(item.id) === saleCustomerId) return true;
      const mobileMatches = saleMobile && String(item.mobile_number || "").trim() === saleMobile;
      const nameMatches = saleName && String(item.customer_name || "").trim().toLowerCase() === saleName;
      const walkInMatches = saleName.includes("walk-in") && item.system_account === true;
      return mobileMatches || nameMatches || walkInMatches;
    });
    if (!customer?.id) {
      alert("Customer account is not linked to this sale.");
      return;
    }
    const accountKey = `CUSTOMER-${customer.id}`;
    setAccountLedgerFocusKey(accountKey);
    setActiveView("accounts");
    await loadAccountLedger(accountKey);
  };

  const openSaleForEditFromReport = async (sale) => {
    if (!canEditSales) {
      alert("Your role cannot edit completed sales.");
      return;
    }
    const saleId = String(sale.sale_id || sale.id || "");
    if (!saleId) {
      alert("Sale invoice not found.");
      return;
    }
    const localEligible = isTauriRuntime() && (
      offlineMode ||
      sale.sync_status ||
      sale.offline_invoice_ref ||
      sale.localSale ||
      saleId.startsWith("invoice-") ||
      saleId.startsWith("pos-invoice-")
    );
    const preloadTasks = [];
    if (!products.length) preloadTasks.push(loadProducts());
    if (!inventory.length && !localEligible) {
      preloadTasks.push(
        axios.get(`${API_URL}/inventory`, { params: { include_cancelled: true } })
          .then((response) => setInventory(response.data))
      );
    }
    if (!inventory.length && localEligible) {
      preloadTasks.push(
        loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id })
          .then((snapshot) => {
            if (snapshot) setInventory(snapshot.inventory_lots || []);
          })
      );
    }
    if (!customers.length) preloadTasks.push(loadCustomerData());
    if (preloadTasks.length) await Promise.all(preloadTasks);
    await loadSaleForEdit(saleId);
  };

  const navigate = async (view) => {
    if (!hasModuleAccess(view)) {
      alert("Your role does not have access to this module.");
      return;
    }
    const currentUrlView = new URLSearchParams(window.location.search).get("view");
    if (currentUrlView !== view) {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("view", view);
      window.history.pushState({ view }, "", nextUrl);
    }
    if (offlineMode) {
      const snapshot = await loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id });
      if (!snapshot?.reference_ready) {
        setStartupError("This device must connect to the internet once before offline use.");
        return;
      }
      setSidebarOpen(false);
      await applyReferenceSnapshot(snapshot, { offline: true, nextView: view });
      if (offlineBackendRequiredViews.has(view)) {
        setSyncMessage("Offline - this module opens with local cached data where available. Some actions require the FroozERP backend.");
      } else if (offlineLocalDataViews.has(view)) {
        setSyncMessage("Offline - loaded local SQLite data for this module.");
      }
      if (view === "reports") await loadReports().catch(() => null);
      if (view === "dashboard") await loadDashboardData().catch(() => null);
      if (view === "sales") await Promise.all([loadSalesHistory(), loadReports()]).catch(() => null);
      return;
    }
    setSidebarOpen(false);
    setActiveView(view);
    try {
      if (view === "products") {
        await Promise.all([loadProducts(), loadProductCategories(), loadSupplierData(), loadDashboardData()]);
      }
      if (view === "sales") await Promise.all([loadDiscountRules(), loadLotDiscounts(), loadCustomerData()]);
      if (view === "discounts") {
        const inventoryResponse = await axios.get(`${API_URL}/inventory`);
        setInventory(inventoryResponse.data);
        await Promise.all([loadLotDiscounts(), loadProducts(), loadSupplierData()]);
      }
      if (["purchase", "pending-bills", "accounts"].includes(view)) {
        await loadSupplierData();
      }
      if (["purchase", "pending-bills"].includes(view)) await loadPurchases();
      if (view === "pending-bills") await Promise.all([loadCustomerPendingBills(), loadCustomerData()]);
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
            <h1>{APP_DISPLAY_NAME}</h1>
            <p>Preparing FroozERP, checking the local database, device authorisation and sync readiness.</p>
          </div>
          <div className="first-launch-steps">
            <span>Checking local database</span>
            <span>Checking device authorisation</span>
            <span>Preparing authorised reference data</span>
            <span>Ready for online or local-first POS</span>
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
          {(startupNotice || startupError || lastReferenceSyncAt) && (
            <div className={`startup-status-panel ${startupError ? "startup-status-error" : ""}`}>
              {startupNotice && <p>{startupNotice}</p>}
              {startupError && <p>{startupError}</p>}
              {lastReferenceSyncAt && <small>Last successful local data sync: {new Date(lastReferenceSyncAt).toLocaleString("en-IN")}</small>}
            </div>
          )}
          <div className="startup-api-panel">
            <span>API base</span>
            <code>{backendHealth.apiUrl}</code>
            <small>
              {backendHealth.online === true ? "Online" : backendHealth.online === false ? "Offline" : "Not checked"} - {backendHealth.message}
            </small>
          </div>
          <div className="startup-actions">
            <button className="primary-button login-button" disabled={loginBusy} onClick={login}>
              {loginBusy ? "Signing In..." : "Sign In"}
            </button>
            <button className="recovery-link-button" disabled={loginBusy} onClick={() => setRecoveryOpen(true)}>
              Forgot Username or Password?
            </button>
            {isTauriRuntime() && (
              <>
                <button className="secondary-button" disabled={loginBusy} onClick={retryOnline}>
                  Retry Online
                </button>
                <button className="secondary-button" disabled={loginBusy} onClick={() => continueOffline()}>
                  Continue Offline
                </button>
              </>
            )}
          </div>
          {deviceGate && (
            <div className="device-activation-panel">
              <span className="eyebrow">Device Activation Required</span>
              <strong>This device is not approved.</strong>
              <small>Device ID: {deviceGate.device_id || deviceInfo.device_id}</small>
              <p>Ask the owner to approve this device from Settings, or enter a one-time activation code.</p>
              <input
                placeholder="Activation code"
                value={activationCode}
                onChange={(event) => setActivationCode(event.target.value.toUpperCase())}
              />
              <button className="secondary-button" onClick={activateDevice}>Activate Device</button>
            </div>
          )}
          {recoveryOpen && (
            <AccountRecoveryModal
              apiUrl={API_URL}
              backendHealth={backendHealth}
              deviceInfo={deviceInfo}
              onClose={() => setRecoveryOpen(false)}
              onCheckOnline={performConnectivityCheck}
              onRetryOnline={retryOnline}
            />
          )}
        </section>
      </main>
    );
  }

  const activeLabel = navigationItems.find(([view]) => view === activeView)?.[1];
  const canManageRates = ["Owner", "Admin"].includes(user.role);
  const canEditSales = ["Owner", "Admin"].includes(user.role) || hasRolePermission("sale_edit");
  const canCancelSales = ["Owner", "Admin"].includes(user.role) || hasRolePermission("invoice_cancellation");
  const canManageStock = ["Owner", "Admin", "Inventory Manager"].includes(user.role);
  const lotBalanceQuantity = (lot) => Number(lot.balance_qty ?? lot.remaining_qty ?? 0);
  const lotUsedQuantity = (lot) => Number(lot.sold_qty ?? Math.max(Number(lot.purchase_qty || 0) - Number(lot.remaining_qty || 0), 0));
  const lotStatusLabel = (lot) => {
    const status = String(lot.batch_status || "ACTIVE").toUpperCase();
    if (status === "CANCELLED") return "Cancelled";
    if (status === "INACTIVE") return "Inactive";
    if (lotBalanceQuantity(lot) <= 0 && lotUsedQuantity(lot) > 0) return "Sold Out";
    return "Active";
  };
  const lotStatusClass = (lot) => {
    const label = lotStatusLabel(lot);
    if (label === "Active") return "stock-ok";
    if (label === "Sold Out") return "origin-rate";
    return "stock-low";
  };
  const visibleInventory = inventory.filter((batch) => showInventoryEmptyLots || lotBalanceQuantity(batch) > 0);
  const inventoryGroups = [...visibleInventory.reduce((groups, batch) => {
    const key = String(batch.product_id);
    const current = groups.get(key) || {
      product_id: batch.product_id,
      category: batch.category || "Fruit",
      product_name: batch.product_name,
      unit: batch.unit || "",
      total_stock: 0,
      stock_value: 0,
      lots: [],
    };
    const remaining = Number(batch.remaining_qty || 0);
    const cost = Number(batch.effective_cost_per_unit || batch.purchase_rate || 0);
    current.total_stock += remaining;
    current.stock_value += remaining * cost;
    current.lots.push(batch);
    groups.set(key, current);
    return groups;
  }, new Map()).values()].sort((left, right) => `${left.category}-${left.product_name}`.localeCompare(`${right.category}-${right.product_name}`));
  const productSearchText = productListSearch.trim().toLowerCase();
  const filteredProducts = products.filter((product) => {
    if (!productSearchText) return true;
    return [
      product.product_name,
      product.category_name,
      product.category,
      product.barcode,
      product.origin_type,
      product.selling_rate,
      product.active !== false ? "active" : "inactive",
      product.unit,
    ].some((value) => String(value ?? "").toLowerCase().includes(productSearchText));
  });
  const lotSearchText = lotListSearch.trim().toLowerCase();
  const filteredProductLots = productLots.filter((lot) => {
    if (!showEmptyLots && lotBalanceQuantity(lot) <= 0) return false;
    if (!lotSearchText) return true;
    return [
      lot.lot_name,
      lot.batch_no,
      lot.supplier_name,
      lot.lot_size,
      lot.purchase_date,
      lot.purchase_rate,
      lot.effective_cost_per_unit,
      lot.temporary_sale_rate,
      lot.selling_rate,
      lot.batch_status || "ACTIVE",
      lot.remarks,
      lotStatusLabel(lot),
    ].some((value) => String(value ?? "").toLowerCase().includes(lotSearchText));
  });

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
          <button aria-label="Log out" className="logout-button" onClick={(event) => { event.stopPropagation(); setUser(null); setOfflineMode(false); setStartupError(""); setStartupNotice(""); }}>
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
          {offlineMode && <div className="offline-pill">Offline - changes will sync later</div>}
        </header>

        <div className="content-area">
          {(startupNotice || startupError || syncMessage) && (
            <div className={`startup-status-panel ${startupError ? "startup-status-error" : ""}`}>
              {startupError && <p>{startupError}</p>}
              {!startupError && startupNotice && <p>{startupNotice}</p>}
              {!startupError && syncMessage && <small>{syncMessage}</small>}
            </div>
          )}
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
                  {[["sales", "POS Billing"], ["purchase", "New Purchase"], ["accounts", "Accounts"], ["reports", "Stock Inventory"]].map(([view, label]) => (
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
            <section className="settings-layout">
              <ModuleCard eyebrow="Product Master" title="Category, Item, Lot & Opening Stock" subtitle="Manage fruit categories, item masters and opening stock lots without disturbing FIFO inventory.">
                {productDuplicateWarning && <div className="cart-empty">{productDuplicateWarning}</div>}
                <div className="purchase-summary-grid supplier-payment-preview">
                  <SummaryMetric featured label="Categories" value={productCategories.length} />
                  <SummaryMetric label="Items" value={products.length} />
                  <SummaryMetric label="Active Items" value={products.filter((product) => product.active !== false).length} />
                  <SummaryMetric label="Inventory Lots" value={inventory.length} />
                </div>
              </ModuleCard>

              <ModuleCard eyebrow="Category Management" title="Fruit Categories" subtitle="Add, edit or deactivate categories. Categories with items are protected from hard deletion.">
                <div className="form-grid supplier-form-grid">
                  <Field label="Add New Category"><input value={newProductCategoryName} onChange={(event) => setNewProductCategoryName(event.target.value)} placeholder="Example: Mango" /></Field>
                  <Field label="Select Existing Category">
                    <select value={productCategoryId} onChange={(event) => {
                      const selected = productCategories.find((category) => String(category.id) === event.target.value);
                      setProductCategoryId(event.target.value);
                      setProductCategory(selected?.category_name || "");
                    }}>
                      <option value="">Select category</option>
                      {productCategories.filter((category) => category.active !== false).map((category) => <option key={category.id} value={category.id}>{category.category_name}</option>)}
                    </select>
                  </Field>
                  <button className="primary-button" onClick={saveProductCategory}>Save Category</button>
                </div>
                <DataTable headers={["Category", "Items", "Status", "Actions"]}>
                  {productCategories.map((category) => (
                    <tr key={category.id}>
                      <td className="primary-cell">{category.category_name}</td>
                      <td>{category.item_count || 0}</td>
                      <td><span className={category.active !== false ? "stock-ok" : "stock-low"}>{category.active !== false ? "Active" : "Inactive"}</span></td>
                      <td>
                        <div className="button-row table-actions-row">
                          <button className="table-action" onClick={() => editProductCategory(category)}>Edit</button>
                          <button className="remove-button" disabled={category.active === false} onClick={() => deactivateProductCategory(category)}>Remove / Deactivate</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              </ModuleCard>

              <ModuleCard eyebrow="Item Management" title={editingProductId ? "Edit Item" : "Add Item Inside Category"} subtitle="Items are products used by POS, purchase, inventory, reports and FIFO costing.">
                <div className="form-grid supplier-form-grid">
                  <Field label="Category">
                    <select value={productCategoryId} onChange={(event) => {
                      const selected = productCategories.find((category) => String(category.id) === event.target.value);
                      setProductCategoryId(event.target.value);
                      setProductCategory(selected?.category_name || "");
                    }}>
                      <option value="">Select existing category</option>
                      {productCategories.filter((category) => category.active !== false).map((category) => <option key={category.id} value={category.id}>{category.category_name}</option>)}
                    </select>
                  </Field>
                  <Field label="Item Name"><input value={productName} onChange={(event) => setProductName(event.target.value)} placeholder="Example: Kesar" /></Field>
                  <Field label="Unit">
                    <select value={unit} onChange={(event) => setUnit(event.target.value)}>
                      <option value="">Select unit</option>
                      <option value="KG">KG</option>
                      <option value="BOX">Box</option>
                      <option value="PIECE">Piece</option>
                      <option value="DOZEN">Dozen</option>
                    </select>
                  </Field>
                  <Field label="Default Sale Rate"><input type="number" min="0" step="0.01" value={sellingRate} onChange={(event) => setSellingRate(event.target.value)} /></Field>
                  <Field label="Barcode (Optional)"><input value={productBarcode} onChange={(event) => setProductBarcode(event.target.value)} /></Field>
                  <Field label="Minimum Stock"><input type="number" min="0" step="0.001" value={productMinimumStock} onChange={(event) => setProductMinimumStock(event.target.value)} /></Field>
                  <Field label="Origin Type">
                    <select value={productOriginType} onChange={(event) => setProductOriginType(event.target.value)}>
                      <option value="LOCAL">Local</option>
                      <option value="IMPORTED">Imported</option>
                    </select>
                  </Field>
                  <label className="check-field"><input type="checkbox" checked={productActive} onChange={(event) => setProductActive(event.target.checked)} /><span>Active Item</span></label>
                </div>
                <Field label="Remarks"><textarea value={productRemarks} onChange={(event) => setProductRemarks(event.target.value)} /></Field>
                {!editingProductId && <label className="check-field"><input type="checkbox" checked={addOpeningStock} onChange={(event) => setAddOpeningStock(event.target.checked)} /><span>Add Opening Stock</span></label>}
                {addOpeningStock && !editingProductId && (
                  <div className="lot-entry-panel">
                    <div className="form-grid supplier-form-grid">
                      <Field label="Supplier (Optional)">
                        <select value={openingStockDraft.supplier_id} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, supplier_id: event.target.value })}>
                          <option value="">No supplier payable</option>
                          {activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.supplier_name}</option>)}
                        </select>
                      </Field>
                      <Field label="Lot Name / Number"><input value={openingStockDraft.lot_name} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, lot_name: event.target.value })} placeholder="Lot A" /></Field>
                      <Field label="Size / Grade"><input value={openingStockDraft.lot_size} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, lot_size: event.target.value })} placeholder="Small / Premium" /></Field>
                      <Field label="Quantity"><input type="number" min="0" step="0.001" value={openingStockDraft.quantity} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, quantity: event.target.value })} /></Field>
                      <Field label="Purchase Rate / Opening Cost"><input type="number" min="0" step="0.01" value={openingStockDraft.purchase_rate} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, purchase_rate: event.target.value })} /></Field>
                      <Field label="Sale Rate"><input type="number" min="0" step="0.01" value={openingStockDraft.sale_rate || sellingRate} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, sale_rate: event.target.value })} /></Field>
                      <Field label="Opening Stock Date"><input type="date" value={openingStockDraft.opening_stock_date} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, opening_stock_date: event.target.value })} /></Field>
                      <Field label="Lot Remarks"><input value={openingStockDraft.remarks} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, remarks: event.target.value })} /></Field>
                    </div>
                    <button className="secondary-button" onClick={addOpeningStockLot}>Add Opening Stock Lot</button>
                    <DataTable headers={["Supplier", "Lot", "Size", "Qty", "Cost", "Sale Rate", "Date", "Remarks", "Actions"]}>
                      {openingStockLots.map((lot, index) => (
                        <tr key={`${lot.lot_name}-${lot.opening_stock_date}-${index}`}>
                          <td>{lot.supplier_name || "-"}</td>
                          <td className="primary-cell">{lot.lot_name}</td>
                          <td>{lot.lot_size || "-"}</td>
                          <td>{lot.quantity}</td>
                          <td>{currency.format(Number(lot.purchase_rate || 0))}</td>
                          <td>{currency.format(Number(lot.sale_rate || sellingRate || 0))}</td>
                          <td>{lot.opening_stock_date}</td>
                          <td>{lot.remarks || "-"}</td>
                          <td><button className="remove-button" onClick={() => setOpeningStockLots((current) => current.filter((_, lotIndex) => lotIndex !== index))}>Remove</button></td>
                        </tr>
                      ))}
                      {openingStockLots.length === 0 && <tr><td colSpan="9" className="empty-cell">Add one or more opening stock lots before saving.</td></tr>}
                    </DataTable>
                  </div>
                )}
                {lotPanelProduct && (
                  <div className="lot-entry-panel">
                    <div className="report-toolbar">
                      <div>
                        <span className="eyebrow">Opening Stock / Lots</span>
                        <h3>{lotPanelProduct.product_name}</h3>
                        <p className="form-note">Existing inventory lots are editable here. Quantity cannot be reduced below stock already sold, wasted or otherwise used.</p>
                      </div>
                      <button className="secondary-button" onClick={() => loadProductLots(lotPanelProduct, true)}>Refresh Lots</button>
                    </div>
                    <label className="icon-input table-search-input">
                      <Icon name="search" />
                      <input
                        placeholder="Search lot, supplier, size..."
                        value={lotListSearch}
                        onChange={(event) => setLotListSearch(event.target.value)}
                      />
                    </label>
                    <label className="check-field report-check-field">
                      <input checked={showEmptyLots} type="checkbox" onChange={(event) => setShowEmptyLots(event.target.checked)} />
                      <span>Show Empty Lots</span>
                    </label>
                    <DataTable headers={["Supplier", "Lot", "Size/Grade", "Opening Date", "Opening Qty", "Sold Qty", "Balance Qty", "Cost", "Sale Rate", "Remarks", "Actions"]}>
                      {filteredProductLots.length ? filteredProductLots.map((lot) => (
                        <tr key={lot.id}>
                          <td>{lot.supplier_name || "No supplier payable"}</td>
                          <td className="primary-cell">{lot.lot_name || lot.batch_no || `Lot #${lot.id}`}<small className={`cell-note ${lotStatusClass(lot)}`}>{lotStatusLabel(lot)}</small></td>
                          <td>{lot.lot_size || "-"}</td>
                          <td>{formatDisplayDate(lot.purchase_date)}</td>
                          <td>{Number(lot.purchase_qty || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</td>
                          <td>{Number(lot.sold_qty || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</td>
                          <td>{Number(lot.balance_qty ?? lot.remaining_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</td>
                          <td>{currency.format(Number(lot.purchase_rate || lot.effective_cost_per_unit || 0))}</td>
                          <td>{currency.format(Number(lot.temporary_sale_rate || lot.selling_rate || 0))}</td>
                          <td>{lot.remarks || "-"}</td>
                          <td>
                            <div className="button-row table-actions-row">
                              <button className="table-action" onClick={() => openLotAction("edit", lot)}>Edit</button>
                              <button className="table-action" disabled={lot.batch_status === "CANCELLED"} onClick={() => openLotAction("add", lot)}>Add Quantity</button>
                              <button className="table-action" disabled={lot.batch_status === "CANCELLED"} onClick={() => openLotAction("adjust", lot)}>Adjust</button>
                              <button className="table-action" disabled={lot.batch_status === "CANCELLED" || lotBalanceQuantity(lot) <= 0} onClick={() => openLotAction("transfer", lot)}>Transfer</button>
                              <button className="remove-button" disabled={lot.batch_status === "CANCELLED"} onClick={() => openLotAction("deactivate", lot)}>Deactivate</button>
                            </div>
                          </td>
                        </tr>
                      )) : (
                        <tr><td colSpan="11" className="empty-cell">{productLots.length ? (showEmptyLots ? "No matching lots found." : "No active lots found. Enable Show Empty Lots to view sold-out lots.") : "No lots found for this product."}</td></tr>
                      )}
                    </DataTable>
                    <div className="button-row">
                      <button className="secondary-button" onClick={() => {
                        resetOpeningStockDraft();
                        setAddOpeningStock(true);
                        setShowOpeningLotForm(true);
                      }}>Add New Opening Stock Lot</button>
                    </div>
                    {showOpeningLotForm && (
                      <div className="lot-entry-panel">
                        <div className="report-toolbar">
                          <div>
                            <span className="eyebrow">New Opening Lot</span>
                            <h3>Add lot for {lotPanelProduct.product_name}</h3>
                            <p className="form-note">This creates a separate opening stock batch for the same item. Existing lots are not overwritten or merged.</p>
                          </div>
                        </div>
                        <div className="form-grid supplier-form-grid">
                          <Field label="Supplier / Supplier Payable">
                            <select value={openingStockDraft.supplier_id} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, supplier_id: event.target.value })}>
                              <option value="">No supplier payable</option>
                              {activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.supplier_name}</option>)}
                            </select>
                          </Field>
                          <Field label="Lot Name / Number"><input value={openingStockDraft.lot_name} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, lot_name: event.target.value })} placeholder="Opening Lot 1" /></Field>
                          <Field label="Size / Grade"><input value={openingStockDraft.lot_size} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, lot_size: event.target.value })} placeholder="Small / Medium / Premium" /></Field>
                          <Field label="Quantity"><input type="number" min="0" step="0.001" value={openingStockDraft.quantity} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, quantity: event.target.value })} /></Field>
                          <Field label="Purchase Rate / Opening Cost"><input type="number" min="0" step="0.01" value={openingStockDraft.purchase_rate} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, purchase_rate: event.target.value })} /></Field>
                          <Field label="Sale Rate"><input type="number" min="0" step="0.01" value={openingStockDraft.sale_rate || sellingRate} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, sale_rate: event.target.value })} /></Field>
                          <Field label="Opening Stock Date"><input type="date" value={openingStockDraft.opening_stock_date} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, opening_stock_date: event.target.value })} /></Field>
                          <Field label="Lot Remarks"><input value={openingStockDraft.remarks} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, remarks: event.target.value })} /></Field>
                        </div>
                        <div className="button-row">
                          <button
  type="button"
  className="primary-button"
  onClick={saveNewOpeningStockLot}
>
  Save Lot
</button>
                          <button className="secondary-button" onClick={() => {
                            resetOpeningStockDraft();
                            setShowOpeningLotForm(false);
                            setAddOpeningStock(false);
                          }}>Cancel</button>
                        </div>
                      </div>
                    )}
                    {productLotAudit.length > 0 && (
                      <div className="lot-audit-panel">
                        <h3>Lot Audit Trail</h3>
                        <DataTable headers={["Action", "Edited At", "Edited By", "Reason"]}>
                          {productLotAudit.map((entry) => (
                            <tr key={entry.id}>
                              <td className="primary-cell">{entry.action}</td>
                              <td>{formatDisplayDate(entry.edited_at)}</td>
                              <td>{entry.edited_by_name || entry.edited_by || "-"}</td>
                              <td>{entry.reason || "-"}</td>
                            </tr>
                          ))}
                        </DataTable>
                      </div>
                    )}
                  </div>
                )}
                <div className="button-row">
                  <button className="primary-button" onClick={addProduct}>{editingProductId ? "Update Item" : "Add Item"}</button>
                  {editingProductId && <button className="secondary-button" onClick={cancelProductEdit}>Cancel Edit</button>}
                </div>
              </ModuleCard>

              <ModuleCard eyebrow="Item List" title="Category-Wise Items" subtitle="Inactive items stay in history but are hidden from POS by default.">
                <label className="icon-input table-search-input">
                  <Icon name="search" />
                  <input
                    placeholder="Search item, category, barcode..."
                    value={productListSearch}
                    onChange={(event) => setProductListSearch(event.target.value)}
                  />
                </label>
                <DataTable headers={["Category", "Item", "Barcode", "Origin", "Sale Rate", "Min Stock", "Stock", "Lots", "Unit", "Status", "Actions"]}>
                  {filteredProducts.map((product) => (
                    <tr key={product.id}>
                      <td>{product.category_name || product.category || "Fruit"}</td>
                      <td className="primary-cell">{product.product_name}<small className="cell-note">{product.remarks || ""}</small></td>
                      <td>{product.barcode || "-"}</td>
                      <td><span className="tag">{product.origin_type || "LOCAL"}</span></td>
                      <td>{currency.format(Number(product.selling_rate))}</td>
                      <td>{product.minimum_stock || 0}</td>
                      <td>{Number(product.current_stock || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</td>
                      <td>{product.lot_count || 0}</td>
                      <td><span className="tag">{product.unit}</span></td>
                      <td><span className={product.active !== false ? "stock-ok" : "stock-low"}>{product.active !== false ? "Active" : "Inactive"}</span></td>
                      <td>
                        <div className="button-row table-actions-row">
                          <button className="table-action" onClick={() => editProduct(product)}>Edit</button>
                          <button className="table-action" onClick={() => loadProductLots(product, true)}>View Lots / Edit Lots</button>
                          <button className="remove-button" disabled={product.active === false} onClick={() => deactivateProduct(product)}>Deactivate</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredProducts.length === 0 && <tr><td colSpan="11" className="empty-cell">No matching items found.</td></tr>}
                </DataTable>
              </ModuleCard>
            </section>
          )}

          {activeView === "purchase" && (
            <section className="settings-layout">
              {purchaseAmendmentMode && (
                <ModuleCard eyebrow="Purchase Amendment" title="Add / Edit Purchase" subtitle="Select date and supplier to amend old purchase entries without deleting history.">
                  <div className="form-grid supplier-form-grid">
                    <Field label="Purchase Date">
                      <input type="date" value={amendmentDate} onChange={(event) => {
                        setAmendmentDate(event.target.value);
                        setPurchaseDate(event.target.value);
                        setAmendmentSupplierId("");
                        setPurchaseSupplierId("");
                        setEditingPurchaseId(null);
                      }} />
                    </Field>
                    <Field label="Supplier On Date">
                      <select value={amendmentSupplierId} onChange={(event) => {
                        setAmendmentSupplierId(event.target.value);
                        setPurchaseSupplierId(event.target.value);
                        setEditingPurchaseId(null);
                      }}>
                        <option value="">Select supplier for this date</option>
                        {amendmentSuppliers.map((purchase) => (
                          <option key={purchase.supplier_id || purchase.supplier_name} value={purchase.supplier_id || ""}>{purchase.supplier_name}</option>
                        ))}
                      </select>
                    </Field>
                    <button className="secondary-button" onClick={startForgottenPurchaseItem}>Add Forgotten Item</button>
                    <button className="secondary-button" onClick={resetPurchaseForm}>Exit Amendment</button>
                  </div>
                  <DataTable headers={["Purchase", "Item", "Qty", "Rate", "Status", "Net", "Actions"]}>
                    {amendmentPurchases.map((purchase) => (
                      <tr key={purchase.id}>
                        <td><span className="batch-id">#{purchase.id}</span></td>
                        <td className="primary-cell">{purchase.product_name}<small className="cell-note">{purchase.batch_no || "-"}</small></td>
                        <td>{Number(purchase.quantity || 0).toLocaleString("en-IN")} {purchase.unit || ""}</td>
                        <td>{currency.format(Number(purchase.purchase_rate || purchase.expected_purchase_rate || 0))}</td>
                        <td><span className={purchase.purchase_status === "CANCELLED" ? "stock-low" : purchase.purchase_bill_status === "BILL_PENDING" ? "origin-rate" : "stock-ok"}>{purchase.purchase_status === "CANCELLED" ? "Cancelled" : purchase.purchase_bill_status === "BILL_PENDING" ? "Pending Bill" : "Completed Bill"}</span></td>
                        <td>{currency.format(Number(purchase.net_payable || purchase.total_amount || 0))}</td>
                        <td>
                          <div className="button-row table-actions-row">
                            <button className="table-action" disabled={purchase.purchase_status === "CANCELLED"} onClick={() => editPurchase(purchase)}>Edit</button>
                            {purchase.purchase_bill_status === "BILL_PENDING" && <button className="primary-button" disabled={purchase.purchase_status === "CANCELLED"} onClick={() => completePendingPurchase(purchase)}>Complete Bill</button>}
                            <button className="remove-button" disabled={purchase.purchase_status === "CANCELLED"} onClick={() => cancelPurchase(purchase)}>Cancel</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                  {amendmentDate && amendmentSupplierId && amendmentPurchases.length === 0 && <div className="cart-empty">No purchases found for selected date and supplier.</div>}
                </ModuleCard>
              )}
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
                      {products.filter((product) => product.active !== false).map((product) => <option key={product.id} value={product.id}>{product.category || "Fruit"} - {product.product_name} ({product.unit})</option>)}
                    </select>
                  </Field>
                  <Field label="Lot Name / Number"><input value={purchaseLotName} onChange={(event) => setPurchaseLotName(event.target.value)} placeholder="Lot A / Supplier Bill Lot" /></Field>
                  <Field label="Size / Grade"><input value={purchaseLotSize} onChange={(event) => setPurchaseLotSize(event.target.value)} placeholder="Small / Premium" /></Field>
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
                    <button className="secondary-button" onClick={addPurchaseCartItem}>{editingPurchaseItemIndex !== null ? "Update Item" : purchaseAmendmentMode ? "Add Forgotten Item" : "Add Item"}</button>
                    {editingPurchaseItemIndex !== null && <button className="secondary-button" onClick={resetPurchaseItemFields}>Cancel Item Edit</button>}
                  </div>
                )}
                {!editingPurchaseId && (
                  <DataTable headers={["Product", "Lot / Size", "Qty", "Unit", "Origin", "Purchase / Expected Rate", "Temp Sale Rate", "Remarks", "Actions"]}>
                    {purchaseCart.map((item, index) => (
                      <tr key={`${item.product_id}-${index}`}>
                        <td className="primary-cell">{item.product_name}</td>
                        <td>{item.lot_name || "-"}{item.lot_size ? ` / ${item.lot_size}` : ""}</td>
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
                  {editingPurchaseId && <button className="secondary-button" onClick={purchaseAmendmentMode ? cancelPurchaseAmendment : resetPurchaseForm}>Cancel Amendment</button>}
                  <button className="secondary-button" onClick={() => navigate("accounts")}>Add New Supplier</button>
                </div>
              </ModuleCard>
            </section>
          )}

          {activeView === "pending-bills" && (
            <PendingBillsModule
              customerPendingBills={customerPendingBills}
              customers={customers}
              onCancelPurchase={cancelPurchase}
              onCompletePurchase={completePendingPurchase}
              onEditPurchase={editPurchase}
              onReload={async () => {
                await Promise.all([loadPurchases(), loadCustomerPendingBills(), loadDashboardData(), loadReports()]);
              }}
              onOpenPurchaseAmendment={openPurchaseAmendment}
              onViewInvoice={loadInvoice}
              purchases={purchases}
              user={user}
            />
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
              deviceInfo={deviceInfo}
              discountRules={discountRules}
              lotDiscounts={lotDiscounts}
              inventory={inventory}
              onInvoice={setSelectedInvoice}
              onSaved={async (result) => {
                if (result?.localSale) {
                  setSalesHistory((rows) => [result.localSale, ...rows]);
                  setInventory((rows) => rows.map((lot) => {
                    const movement = result.localSale.items.find((item) => String(item.inventory_batch_id) === String(lot.id));
                    return movement
                      ? { ...lot, remaining_qty: Math.max(Number(lot.remaining_qty || 0) - Number(movement.quantity || 0), 0) }
                      : lot;
                  }));
                  await refreshSyncStatus();
                  return;
                }
                await Promise.all([loadDashboardData(), loadLotDiscounts(), loadCustomerPendingBills()]);
              }}
              paymentSettings={settingsData.paymentSettings}
              posSettings={settingsData.posSettings}
              printSettings={settingsData.businessSettings}
              products={products.filter((product) => product.active !== false)}
              saleRateSettings={settingsData.saleRateSettings}
              syncInBackground={runSyncNow}
              canManualRateOverride={hasRolePermission("manual_pos_rate_override")}
              canPosDateOverride={hasRolePermission("pos_date_override")}
              user={user}
            />
          )}

          {activeView === "discounts" && (
            <DiscountManagementModule
              discounts={lotDiscounts}
              inventory={inventory}
              onReload={async () => {
                await Promise.all([loadLotDiscounts(), loadDashboardData()]);
              }}
              products={products.filter((product) => product.active !== false)}
              user={user}
            />
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
              localDbStatus={localDbStatus}
              onReload={async () => { await Promise.all([loadSettingsData(), loadPurchaseRules(), loadDiscountRules()]); }}
              onRetrySync={retrySyncFailures}
              onRunSync={runSyncNow}
              onQueueSyncTest={queuePhase2SyncTest}
              settingsData={settingsData}
              syncMessage={syncMessage}
              syncStatus={syncStatus}
              rules={settingsRules}
              user={user}
            />
          )}

          {activeView === "reports" && (
            <ReportsModule
              canCancelSales={canCancelSales}
              canEditSales={canEditSales}
              canManageStock={canManageStock}
              data={reportsData}
              onCancelPurchase={cancelPurchase}
              onCompletePurchase={completePendingPurchase}
              onEditPurchase={editPurchase}
              onOpenCustomerLedger={openCustomerLedgerFromReport}
              onOpenBlankPurchaseAmendment={openBlankPurchaseAmendment}
              onOpenPurchaseAmendment={openPurchaseAmendment}
              onOpenSaleForEdit={openSaleForEditFromReport}
              onOpenSaleView={loadInvoice}
              onPrintSale={printSaleInvoice}
              onCancelSale={cancelSale}
              onOpenLotAction={openLotAction}
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
      {selectedInvoice && (
        <InvoiceModal
          autoPrintMode={selectedInvoicePrintMode}
          canCancel={canCancelSales && selectedInvoice.sale_status !== "CANCELLED"}
          canEdit={canEditSales && selectedInvoice.sale_status !== "CANCELLED"}
          invoice={selectedInvoice}
          onCancel={async () => {
            const invoice = selectedInvoice;
            const cancelled = await cancelSale(invoice);
            if (cancelled) {
              setSelectedInvoice(null);
              setSelectedInvoicePrintMode(null);
            }
          }}
          onClose={() => {
            setSelectedInvoice(null);
            setSelectedInvoicePrintMode(null);
          }}
          onEdit={() => {
            const invoice = selectedInvoice;
            setSelectedInvoice(null);
            setSelectedInvoicePrintMode(null);
            openSaleForEditFromReport(invoice);
          }}
          paymentSettings={settingsData.paymentSettings}
          printSettings={settingsData.businessSettings}
        />
      )}
      {saleEditLoading && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="cart-empty">Loading invoice editor...</div>
          </section>
        </div>
      )}
      {saleEditError && !saleEditLoading && !editingSale && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Edit Bill</span>
                <strong>Unable to load invoice</strong>
              </div>
              <button className="remove-button" onClick={() => setSaleEditError("")}><Icon name="close" /></button>
            </div>
            <div className="cart-empty">{saleEditError}</div>
          </section>
        </div>
      )}
      {editingSale && (
        <ModuleErrorBoundary onClose={() => setEditingSale(null)}>
          <SaleEditModal
            deviceInfo={deviceInfo}
            invoice={editingSale}
            offlineMode={offlineMode}
            onClose={() => setEditingSale(null)}
            onSaved={async (result) => {
              setEditingSale(null);
              if (result?.localSale) {
                setSalesHistory((rows) => {
                  const exists = rows.some((row) => String(row.id || row.sale_id) === String(result.localSale.id || result.localSale.sale_id));
                  return exists
                    ? rows.map((row) => String(row.id || row.sale_id) === String(result.localSale.id || result.localSale.sale_id) ? { ...row, ...result.localSale } : row)
                    : [result.localSale, ...rows];
                });
                const snapshot = await loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id }).catch(() => null);
                if (snapshot) {
                  setInventory(snapshot.inventory_lots || []);
                }
                await refreshSyncStatus();
                return;
              }
              await Promise.all([loadSalesHistory(), loadDashboardData(), loadReports()]);
            }}
            products={products.filter((product) => product.active !== false)}
            inventory={inventory}
            canSaleDateEdit={hasRolePermission("sale_date_edit")}
            user={user}
          />
        </ModuleErrorBoundary>
      )}
      {changeHistory && <ChangeHistoryModal history={changeHistory} onClose={() => setChangeHistory(null)} />}
      {lotAction && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Opening Stock Lot</span>
                <strong>
                  {lotAction.type === "edit" && "Edit Lot"}
                  {lotAction.type === "add" && "Add Quantity"}
                  {lotAction.type === "adjust" && "Adjust Quantity"}
                  {lotAction.type === "transfer" && "Transfer Stock"}
                  {lotAction.type === "deactivate" && "Deactivate Lot"}
                  {lotAction.type === "reactivate" && "Reactivate Lot"}
                </strong>
              </div>
              <button aria-label="Close lot editor" className="remove-button" onClick={closeLotAction}><Icon name="close" /></button>
            </div>
            <div className="sale-edit-body">
              <div className="purchase-summary-grid supplier-payment-preview">
                <SummaryMetric label="Product" value={lotAction.lot.product_name || lotPanelProduct?.product_name || "-"} />
                <SummaryMetric label="Lot" value={lotAction.lot.lot_name || lotAction.lot.batch_no || `#${lotAction.lot.id}`} />
                <SummaryMetric label="Opening Qty" value={Number(lotAction.lot.purchase_qty || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} />
                <SummaryMetric label="Used Qty" value={Number(lotAction.lot.sold_qty ?? (Number(lotAction.lot.purchase_qty || 0) - Number(lotAction.lot.remaining_qty || 0))).toLocaleString("en-IN", { maximumFractionDigits: 3 })} />
                <SummaryMetric label="Balance Qty" value={Number(lotAction.lot.balance_qty ?? lotAction.lot.remaining_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} featured />
              </div>

              {lotAction.type === "edit" && (
                <div className="form-grid supplier-form-grid">
                  <Field label="Lot Name / Number"><input value={lotDraft.lot_name} onChange={(event) => setLotDraft({ ...lotDraft, lot_name: event.target.value })} /></Field>
                  <Field label="Size / Grade"><input value={lotDraft.lot_size} onChange={(event) => setLotDraft({ ...lotDraft, lot_size: event.target.value })} /></Field>
                  <Field label="Supplier (Optional)">
                    <select value={lotDraft.supplier_id} onChange={(event) => setLotDraft({ ...lotDraft, supplier_id: event.target.value })}>
                      <option value="">No supplier</option>
                      {activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.supplier_name}</option>)}
                    </select>
                  </Field>
                  <Field label="Opening Quantity"><input min="0" step="0.001" type="number" value={lotDraft.purchase_qty} onChange={(event) => setLotDraft({ ...lotDraft, purchase_qty: event.target.value })} /></Field>
                  <Field label="Current Balance Qty"><input readOnly value={Number(lotAction.lot.balance_qty ?? lotAction.lot.remaining_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} /></Field>
                  <Field label="Opening Cost / Purchase Rate"><input min="0" step="0.01" type="number" value={lotDraft.purchase_rate} onChange={(event) => setLotDraft({ ...lotDraft, purchase_rate: event.target.value })} /></Field>
                  <Field label="Sale Rate"><input min="0" step="0.01" type="number" value={lotDraft.sale_rate} onChange={(event) => setLotDraft({ ...lotDraft, sale_rate: event.target.value })} /></Field>
                  <Field label="Opening Stock Date"><input type="date" value={lotDraft.opening_stock_date} onChange={(event) => setLotDraft({ ...lotDraft, opening_stock_date: event.target.value })} /></Field>
                  <Field label="Remarks"><input value={lotDraft.remarks} onChange={(event) => setLotDraft({ ...lotDraft, remarks: event.target.value })} /></Field>
                  <Field label="Reason"><input value={lotDraft.reason} onChange={(event) => setLotDraft({ ...lotDraft, reason: event.target.value })} placeholder="Reason for audit trail" /></Field>
                </div>
              )}

              {lotAction.type === "add" && (
                <div className="form-grid supplier-form-grid">
                  <Field label="Quantity To Add"><input min="0" step="0.001" type="number" value={lotDraft.quantity} onChange={(event) => setLotDraft({ ...lotDraft, quantity: event.target.value })} /></Field>
                  <Field label="Reason"><input value={lotDraft.reason} onChange={(event) => setLotDraft({ ...lotDraft, reason: event.target.value })} placeholder="Example: missed opening stock count" /></Field>
                </div>
              )}

              {lotAction.type === "adjust" && (
                <div className="form-grid supplier-form-grid">
                  <Field label="Current Software Qty"><input readOnly value={Number(lotAction.lot.balance_qty ?? lotAction.lot.remaining_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} /></Field>
                  <Field label="Physical / Corrected Quantity"><input min="0" step="0.001" type="number" value={lotDraft.new_quantity} onChange={(event) => setLotDraft({ ...lotDraft, new_quantity: event.target.value })} /></Field>
                  <Field label="Difference / Adjustment Qty"><input readOnly value={(Number(lotDraft.new_quantity || 0) - Number(lotAction.lot.balance_qty ?? lotAction.lot.remaining_qty ?? 0)).toLocaleString("en-IN", { maximumFractionDigits: 3 })} /></Field>
                  <Field label="Adjustment Type">
                    <select value={lotDraft.adjustment_type} onChange={(event) => setLotDraft({ ...lotDraft, adjustment_type: event.target.value })}>
                      <option>Increase Stock</option>
                      <option>Decrease Stock</option>
                      <option>Physical Count Correction</option>
                      <option>Damage</option>
                      <option>Missing</option>
                      <option>Found</option>
                      <option>Owner Adjustment</option>
                    </select>
                  </Field>
                  <Field label="Adjustment Date"><input type="date" value={lotDraft.adjustment_date} onChange={(event) => setLotDraft({ ...lotDraft, adjustment_date: event.target.value })} /></Field>
                  <Field label="Reason"><input value={lotDraft.reason} onChange={(event) => setLotDraft({ ...lotDraft, reason: event.target.value })} placeholder="Reason is mandatory" /></Field>
                  <Field label="Remarks"><input value={lotDraft.remarks} onChange={(event) => setLotDraft({ ...lotDraft, remarks: event.target.value })} /></Field>
                </div>
              )}

              {lotAction.type === "transfer" && (
                <div className="form-grid supplier-form-grid">
                  <Field label="From Lot"><input readOnly value={`${lotAction.lot.product_name || ""} - ${lotAction.lot.lot_name || lotAction.lot.batch_no || `Lot #${lotAction.lot.id}`}`} /></Field>
                  <Field label="Available Qty"><input readOnly value={Number(lotAction.lot.balance_qty ?? lotAction.lot.remaining_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} /></Field>
                  <Field label="To Lot">
                    <select value={lotDraft.transfer_to_lot_id} onChange={(event) => setLotDraft({ ...lotDraft, transfer_to_lot_id: event.target.value })}>
                      <option value="">Select destination lot</option>
                      {inventory
                        .filter((lot) => Number(lot.id) !== Number(lotAction.lot.id) && String(lot.batch_status || "ACTIVE").toUpperCase() !== "CANCELLED")
                        .map((lot) => (
                          <option key={lot.id} value={lot.id}>
                            {lot.product_name} - {lot.lot_name || lot.batch_no || `Lot #${lot.id}`}{lot.lot_size ? ` / ${lot.lot_size}` : ""} - Bal {Number(lot.balance_qty ?? lot.remaining_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Quantity To Move"><input min="0" step="0.001" type="number" value={lotDraft.transfer_quantity} onChange={(event) => setLotDraft({ ...lotDraft, transfer_quantity: event.target.value })} /></Field>
                  <Field label="Reason"><input value={lotDraft.reason} onChange={(event) => setLotDraft({ ...lotDraft, reason: event.target.value })} placeholder="Reason is mandatory" /></Field>
                  <Field label="Remarks"><input value={lotDraft.remarks} onChange={(event) => setLotDraft({ ...lotDraft, remarks: event.target.value })} /></Field>
                </div>
              )}

              {lotAction.type === "deactivate" && (
                <Field label="Reason"><textarea value={lotDraft.reason} onChange={(event) => setLotDraft({ ...lotDraft, reason: event.target.value })} placeholder="Reason is mandatory. Lots with used stock cannot be deactivated." /></Field>
              )}

              {lotAction.type === "reactivate" && (
                <Field label="Reason"><textarea value={lotDraft.reason} onChange={(event) => setLotDraft({ ...lotDraft, reason: event.target.value })} placeholder="Reason is mandatory. Reactivated lots return available unsold quantity to active stock." /></Field>
              )}

              <div className="button-row">
                <button className="primary-button" onClick={saveLotAction}>Save Lot Changes</button>
                <button className="secondary-button" onClick={closeLotAction}>Cancel</button>
              </div>
            </div>
          </section>
        </div>
      )}
      {profileOpen && <UserProfilePanel onClose={() => setProfileOpen(false)} onLogout={() => setUser(null)} user={user} />}
    </main>
  );
}

function AccountRecoveryModal({ apiUrl, backendHealth, deviceInfo, onCheckOnline, onClose, onRetryOnline }) {
  const [mode, setMode] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [methods, setMethods] = useState([]);
  const [method, setMethod] = useState("");
  const [requestId, setRequestId] = useState("");
  const [otp, setOtp] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [recoveredUsername, setRecoveredUsername] = useState("");
  const [passwordDraft, setPasswordDraft] = useState({ new_password: "", confirm_password: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [step, setStep] = useState("choose");
  const [providerStatus, setProviderStatus] = useState(null);
  const [supportContacts, setSupportContacts] = useState([]);
  const [developmentOtp, setDevelopmentOtp] = useState("");

  const onlineRequired = backendHealth?.online === false;
  useEffect(() => {
    let cancelled = false;
    setStatus("Checking FroozERP service...");
    onCheckOnline?.("recovery-open", { force: true, timeoutMs: 3500 }).then((health) => {
      if (cancelled) return;
      if (health?.online) {
        setStatus("FroozERP service is online. Choose a recovery option.");
        if (step === "offline") setStep(mode ? "identify" : "choose");
      } else {
        setError(`Account recovery requires internet access. ${health?.message || "Backend is unavailable."}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (backendHealth?.checking) {
      setStatus("Checking FroozERP service...");
      return;
    }
    if (backendHealth?.online) {
      setError("");
      setStatus("FroozERP service is online. Continue account recovery.");
      if (step === "offline") setStep(mode ? "identify" : "choose");
    }
  }, [backendHealth?.checking, backendHealth?.online, mode, step]);
  const resetMessages = () => {
    setStatus("");
    setError("");
    setDevelopmentOtp("");
  };
  const recoveryPayload = () => ({
    identifier,
    purpose: mode,
    method,
    device_id: deviceInfo?.device_id,
  });
  const chooseMode = (nextMode) => {
    resetMessages();
    setMode(nextMode);
    setStep(onlineRequired ? "offline" : "identify");
  };
  const loadOptions = async () => {
    resetMessages();
    if (!identifier.trim()) {
      setError("Enter your registered username, email or mobile number.");
      return;
    }
    setBusy(true);
    try {
      const health = await (onCheckOnline?.("recovery-options", { force: true, timeoutMs: 4000 }) || checkBackendHealth(apiUrl, { details: true, timeoutMs: 4000 }));
      if (!health.online) {
        setStep("offline");
        setError(`Account recovery requires internet access. ${health.message}`);
        return;
      }
      const response = await axios.post(`${apiUrl}/auth/recovery/options`, recoveryPayload(), { timeout: 8000 });
      setProviderStatus(response.data.provider_status || null);
      setSupportContacts(response.data.support_contacts || []);
      if (response.data.code === "STAFF_OWNER_ASSISTANCE_REQUIRED") {
        setStep("staff");
        setStatus(response.data.message);
        return;
      }
      if (!response.data.methods?.length) {
        setError(response.data.message || "No verified recovery method is available for this account.");
        return;
      }
      setMethods(response.data.methods);
      setMethod(response.data.methods[0]?.method || "");
      setStep("method");
      setStatus("Select where FroozERP should send the verification code.");
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, "Unable to load recovery options."));
    } finally {
      setBusy(false);
    }
  };
  const sendOtp = async () => {
    resetMessages();
    if (!method) {
      setError("Select a recovery method.");
      return;
    }
    setBusy(true);
    try {
      const response = await axios.post(`${apiUrl}/auth/recovery/send-otp`, recoveryPayload(), { timeout: 8000 });
      setProviderStatus(response.data.provider_status || null);
      if (response.data.code === "PROVIDER_NOT_CONFIGURED" && !response.data.development_otp) {
        setError(response.data.message || "Recovery delivery provider is not configured.");
        return;
      }
      setRequestId(response.data.request_id || "");
      setDevelopmentOtp(response.data.development_otp || "");
      setStep("otp");
      setStatus(response.data.development_otp ? "Development recovery code generated for internal testing." : "Verification code sent.");
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, "Unable to send recovery code."));
    } finally {
      setBusy(false);
    }
  };
  const verifyOtp = async () => {
    resetMessages();
    setBusy(true);
    try {
      const response = await axios.post(`${apiUrl}/auth/recovery/verify-otp`, {
        request_id: requestId,
        otp,
        device_id: deviceInfo?.device_id,
      }, { timeout: 8000 });
      setVerificationToken(response.data.verification_token || "");
      if (mode === "username") {
        setRecoveredUsername(response.data.username || "");
        setStep("username-result");
        setStatus("Username recovered successfully.");
      } else {
        setStep("reset");
        setStatus("Verification complete. Set a new password.");
      }
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, "Unable to verify recovery code."));
    } finally {
      setBusy(false);
    }
  };
  const resetPassword = async () => {
    resetMessages();
    setBusy(true);
    try {
      const response = await axios.post(`${apiUrl}/auth/recovery/reset-password`, {
        request_id: requestId,
        verification_token: verificationToken,
        ...passwordDraft,
        device_id: deviceInfo?.device_id,
      }, { timeout: 8000 });
      setStep("done");
      setStatus(response.data.message || "Password changed. Sign in again with the new password.");
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, "Unable to reset password."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section className="invoice-modal recovery-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">FroozERP Account Recovery</span>
            <strong>Forgot Username or Password?</strong>
          </div>
          <button aria-label="Close recovery" className="remove-button" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="sale-edit-body recovery-body">
          <BrandLogo compact />
          {step === "choose" && (
            <div className="recovery-option-grid">
              <button className="secondary-button" onClick={() => chooseMode("username")}>Forgot Username</button>
              <button className="secondary-button" onClick={() => chooseMode("password")}>Forgot Password</button>
              <button className="secondary-button" onClick={() => setStep("staff")}>Contact Owner / Administrator</button>
            </div>
          )}
          {step === "offline" && (
            <div className="startup-status-panel startup-status-error">
              <p><strong>Internet connection required</strong></p>
              <p>Account recovery securely verifies your registered email or mobile number and therefore requires an online connection.</p>
              <div className="button-row">
                <button className="secondary-button" disabled={busy} onClick={onRetryOnline}>Retry Online</button>
                <button className="secondary-button" onClick={() => setStep("staff")}>Contact Owner / Administrator</button>
                <button className="secondary-button" onClick={onClose}>Back to Sign In</button>
              </div>
            </div>
          )}
          {step === "identify" && (
            <>
              <Field label="Registered username, email or mobile"><input value={identifier} onChange={(event) => setIdentifier(event.target.value)} /></Field>
              <button className="primary-button" disabled={busy} onClick={loadOptions}>{busy ? "Checking..." : "Continue"}</button>
            </>
          )}
          {step === "method" && (
            <>
              <Field label="Recovery Method">
                <select value={method} onChange={(event) => setMethod(event.target.value)}>
                  {methods.map((entry) => <option key={entry.method} value={entry.method}>{entry.label}</option>)}
                </select>
              </Field>
              <button className="primary-button" disabled={busy} onClick={sendOtp}>{busy ? "Sending..." : "Send Verification Code"}</button>
            </>
          )}
          {step === "otp" && (
            <>
              {developmentOtp && <div className="startup-status-panel"><p>Development test OTP: <strong>{developmentOtp}</strong></p></div>}
              <Field label="Verification Code"><input inputMode="numeric" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 8))} /></Field>
              <button className="primary-button" disabled={busy} onClick={verifyOtp}>{busy ? "Verifying..." : "Verify Code"}</button>
            </>
          )}
          {step === "username-result" && (
            <div className="startup-status-panel">
              <p>Recovered username</p>
              <strong>{recoveredUsername}</strong>
              <button className="primary-button" onClick={onClose}>Back to Sign In</button>
            </div>
          )}
          {step === "reset" && (
            <>
              <Field label="New Password">
                <input type={showPassword ? "text" : "password"} value={passwordDraft.new_password} onChange={(event) => setPasswordDraft({ ...passwordDraft, new_password: event.target.value })} />
              </Field>
              <Field label="Confirm New Password">
                <input type={showPassword ? "text" : "password"} value={passwordDraft.confirm_password} onChange={(event) => setPasswordDraft({ ...passwordDraft, confirm_password: event.target.value })} />
              </Field>
              <label className="check-field"><input checked={showPassword} type="checkbox" onChange={(event) => setShowPassword(event.target.checked)} /><span>Show password</span></label>
              <p className="form-note">Use a password the staff member cannot guess. FroozERP stores only a secure password hash.</p>
              <button className="primary-button" disabled={busy} onClick={resetPassword}>{busy ? "Saving..." : "Reset Password"}</button>
            </>
          )}
          {step === "staff" && (
            <div className="startup-status-panel">
              <p><strong>Account assistance required</strong></p>
              <p>For the security of your business, staff login recovery is managed by your authorised Owner or Administrator.</p>
              {supportContacts.length > 0 && supportContacts.map((contact) => (
                <small key={`${contact.contact_type}-${contact.contact_value}`}>{contact.label}: {contact.contact_value}</small>
              ))}
              <div className="button-row">
                <button className="secondary-button" onClick={() => setStep("choose")}>Back</button>
                <button className="primary-button" onClick={onClose}>Back to Sign In</button>
              </div>
            </div>
          )}
          {step === "done" && (
            <div className="startup-status-panel">
              <p>{status}</p>
              <button className="primary-button" onClick={onClose}>Back to Sign In</button>
            </div>
          )}
          {(status || error || providerStatus) && step !== "done" && (
            <div className={`startup-status-panel ${error ? "startup-status-error" : ""}`}>
              {status && <p>{status}</p>}
              {error && <p>{error}</p>}
              {providerStatus && (
                <small>Email: {providerStatus.email}; SMS: {providerStatus.sms}; Development: {providerStatus.development}</small>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ReportToolbar({ exporting = false, onPdfExport, onPrint, title }) {
  return (
    <div className="report-toolbar no-print">
      <strong>{title}</strong>
      <div className="button-row">
        <button className="secondary-button" onClick={onPrint}><Icon name="print" /> Print</button>
        <button className="secondary-button" disabled={exporting} onClick={onPdfExport || onPrint}>{exporting ? "Exporting..." : "PDF Export"}</button>
      </div>
    </div>
  );
}

function UserProfilePanel({ onClose, onLogout, user }) {
  const [passwordDraft, setPasswordDraft] = useState({ password: "", confirm_password: "" });
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [profile, setProfile] = useState(null);
  const [recoveryDraft, setRecoveryDraft] = useState({ email: "", mobile: "" });
  const [verification, setVerification] = useState({ type: "", requestId: "", otp: "", maskedContact: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const loadRecoveryProfile = async () => {
    try {
      const response = await axios.get(`${API_URL}/auth/recovery/profile`, {
        params: { user_id: user.id, updated_by: user.id },
      });
      setProfile(response.data);
      setRecoveryDraft({
        email: response.data.pending_recovery_email || response.data.recovery_email || "",
        mobile: response.data.pending_recovery_mobile || response.data.recovery_mobile || "",
      });
    } catch (loadError) {
      setError(getAuthErrorMessage(loadError, "Unable to load recovery profile"));
    }
  };
  useEffect(() => {
    loadRecoveryProfile();
  }, [user.id]);
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
  const requestContactOtp = async (type) => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await axios.post(`${API_URL}/auth/recovery/contact/request`, {
        user_id: user.id,
        updated_by: user.id,
        contact_type: type,
        contact_value: type === "email" ? recoveryDraft.email : recoveryDraft.mobile,
      });
      setVerification({
        type,
        requestId: response.data.request_id,
        otp: response.data.development_otp || "",
        maskedContact: response.data.masked_contact || "",
      });
      setMessage(`Verification code sent to ${response.data.masked_contact}.`);
      await loadRecoveryProfile();
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, "Unable to send recovery contact OTP"));
    } finally {
      setBusy(false);
    }
  };
  const verifyContactOtp = async () => {
    if (!verification.type || !verification.requestId || !verification.otp.trim()) {
      setError("Enter the verification code.");
      return;
    }
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await axios.post(`${API_URL}/auth/recovery/contact/verify`, {
        user_id: user.id,
        updated_by: user.id,
        contact_type: verification.type,
        request_id: verification.requestId,
        otp: verification.otp,
      });
      setMessage(response.data.message || "Recovery contact verified.");
      setVerification({ type: "", requestId: "", otp: "", maskedContact: "" });
      await loadRecoveryProfile();
    } catch (verifyError) {
      setError(getAuthErrorMessage(verifyError, "Unable to verify recovery contact"));
    } finally {
      setBusy(false);
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
          <ModuleCard eyebrow="Recovery Security" title="Owner Recovery Contacts" subtitle="Recovery contacts are usable only after OTP verification. Password recovery requires backend connectivity.">
            <div className="purchase-summary-grid supplier-payment-preview">
              <SummaryMetric label="Email Status" value={profile?.recovery_email_verified ? "Verified" : profile?.pending_recovery_email ? "Pending" : "Not Verified"} featured={profile?.recovery_email_verified} />
              <SummaryMetric label="Mobile Status" value={profile?.recovery_mobile_verified ? "Verified" : profile?.pending_recovery_mobile ? "Pending" : "Not Verified"} featured={profile?.recovery_mobile_verified} />
              <SummaryMetric label="Email Provider" value={profile?.provider_status?.email || "Checking"} />
              <SummaryMetric label="SMS Provider" value={profile?.provider_status?.sms || "Checking"} />
            </div>
            <div className="form-grid supplier-form-grid">
              <Field label="Recovery Email">
                <input type="email" value={recoveryDraft.email} onChange={(event) => setRecoveryDraft({ ...recoveryDraft, email: event.target.value })} />
              </Field>
              <Field label="Recovery Mobile">
                <input value={recoveryDraft.mobile} onChange={(event) => setRecoveryDraft({ ...recoveryDraft, mobile: event.target.value })} placeholder="10 digits or +91XXXXXXXXXX" />
              </Field>
            </div>
            <div className="button-row">
              <button className="secondary-button" disabled={busy} onClick={() => requestContactOtp("email")}>Verify Email</button>
              <button className="secondary-button" disabled={busy} onClick={() => requestContactOtp("mobile")}>Verify Mobile</button>
              <button className="secondary-button" disabled={busy} onClick={loadRecoveryProfile}>Refresh Status</button>
            </div>
            {verification.requestId && (
              <div className="form-grid settings-add-grid">
                <Field label={`OTP for ${verification.maskedContact || verification.type}`}>
                  <input inputMode="numeric" value={verification.otp} onChange={(event) => setVerification({ ...verification, otp: event.target.value.replace(/\D/g, "").slice(0, 8) })} />
                </Field>
                <button className="primary-button" disabled={busy} onClick={verifyContactOtp}>{busy ? "Verifying..." : "Confirm Verification"}</button>
              </div>
            )}
            {(message || error) && (
              <div className={`startup-status-panel ${error ? "startup-status-error" : ""}`}>
                {message && <p>{message}</p>}
                {error && <p>{error}</p>}
              </div>
            )}
          </ModuleCard>
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

function PrintableReport({ beforePdfExport, beforePrint, children, fileName, reportClassName = "", title }) {
  const [printTarget, setPrintTarget] = useState(false);
  const [exporting, setExporting] = useState(false);
  const reportRef = useRef(null);
  const printReport = () => {
    if (beforePrint && beforePrint() === false) return;
    setTimeout(() => {
      setPrintTarget(true);
      setTimeout(() => {
        withDocumentTitle(fileName || title, () => window.print());
        setTimeout(() => setPrintTarget(false), 250);
      }, 50);
    }, 0);
  };
  const exportReport = async () => {
    if (beforePdfExport && beforePdfExport() === false) return;
    setPrintTarget(true);
    setExporting(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await exportElementToPdf({
        element: reportRef.current,
        fileName: fileName || `${title}.pdf`,
        mode: "A4",
      });
    } catch (error) {
      alert(`Unable to export PDF: ${error.message}`);
    } finally {
      setExporting(false);
      setPrintTarget(false);
    }
  };
  return (
    <section className={`print-section ${reportClassName} ${printTarget ? "print-target" : ""}`}>
      <ReportToolbar exporting={exporting} onPdfExport={exportReport} onPrint={printReport} title={title} />
      <div ref={reportRef} className="print-area report-paper">
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

const matchesPendingBillSearch = (values, search) => {
  const text = String(search || "").trim().toLowerCase();
  if (!text) return true;
  return values.some((value) => String(value ?? "").toLowerCase().includes(text));
};

function PendingPurchaseBillsModule({ onCancelPurchase, onCompletePurchase, onEditPurchase, onOpenPurchaseAmendment, purchases, search = "" }) {
  const [selectedSupplierKey, setSelectedSupplierKey] = useState("");
  const basePendingRows = purchases.filter((purchase) =>
    purchase.purchase_status !== "CANCELLED" &&
    purchase.purchase_bill_status === "BILL_PENDING"
  );
  const narration = (purchase) => {
    const product = purchase.product_name || "Item";
    const qty = Number(purchase.quantity || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
    const unit = String(purchase.unit || "").toLowerCase();
    const rate = Number(purchase.expected_purchase_rate || purchase.purchase_rate || 0);
    return `${product} ${qty}${unit} @ ${receiptCurrency.format(rate)} = ${receiptCurrency.format(Number(purchase.quantity || 0) * rate)}`;
  };
  const estimatedValue = (purchase) => Number(purchase.quantity || 0) * Number(purchase.expected_purchase_rate || purchase.purchase_rate || 0);
  const pendingRows = basePendingRows.filter((purchase) => matchesPendingBillSearch([
    purchase.supplier_name,
    purchase.firm_name,
    purchase.purchase_date,
    purchase.bill_number,
    purchase.payment_mode,
    purchase.purchase_type,
    purchase.remarks,
    purchase.product_name,
    purchase.quantity,
    purchase.expected_purchase_rate,
    purchase.purchase_rate,
    estimatedValue(purchase),
    narration(purchase),
    "Pending Bill",
  ], search));
  const supplierSummaries = [...pendingRows.reduce((map, purchase) => {
    const key = String(purchase.supplier_id || purchase.supplier_name || "UNKNOWN");
    const summary = map.get(key) || {
      key,
      supplier_id: purchase.supplier_id,
      supplier_name: purchase.supplier_name || "Unknown Supplier",
      from: toDateKey(purchase.purchase_date),
      to: toDateKey(purchase.purchase_date),
      billCount: 0,
      itemCount: 0,
      estimatedValue: 0,
      rows: [],
    };
    const date = toDateKey(purchase.purchase_date);
    summary.from = date < summary.from ? date : summary.from;
    summary.to = date > summary.to ? date : summary.to;
    summary.billCount += 1;
    summary.itemCount += 1;
    summary.estimatedValue += estimatedValue(purchase);
    summary.rows.push(purchase);
    map.set(key, summary);
    return map;
  }, new Map()).values()].sort((left, right) => left.supplier_name.localeCompare(right.supplier_name));
  const selectedSupplier = supplierSummaries.find((summary) => summary.key === selectedSupplierKey);
  const selectedRows = selectedSupplier?.rows || [];

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Pending Purchase Bills" title="Supplier-Wise Pending Bills" subtitle="Operational queue for stock received before supplier bill completion.">
        <div className="purchase-summary-grid supplier-payment-preview">
          <SummaryMetric label="Pending Suppliers" value={supplierSummaries.length} featured />
          <SummaryMetric label="Pending Bills" value={pendingRows.length} />
          <SummaryMetric label="Estimated Value" value={currency.format(pendingRows.reduce((sum, row) => sum + estimatedValue(row), 0))} />
        </div>
        <DataTable headers={["Supplier Name", "Pending From Date", "Pending To Date", "Pending Bill Count", "Total Pending Items", "Estimated Value", "Action"]}>
          {supplierSummaries.map((summary) => (
            <tr key={summary.key}>
              <td className="primary-cell">{summary.supplier_name}</td>
              <td>{formatDisplayDate(summary.from)}</td>
              <td>{formatDisplayDate(summary.to)}</td>
              <td>{summary.billCount} bills</td>
              <td>{summary.itemCount} items</td>
              <td>{currency.format(summary.estimatedValue)}</td>
              <td><button className="table-action" onClick={() => setSelectedSupplierKey(summary.key)}>View</button></td>
            </tr>
          ))}
        </DataTable>
        {supplierSummaries.length === 0 && <div className="cart-empty">{basePendingRows.length ? "No matching pending bills found." : "No pending purchase bills."}</div>}
      </ModuleCard>

      {selectedSupplier && (
        <ModuleCard eyebrow="Supplier Drill-Down" title={selectedSupplier.supplier_name} subtitle="Complete, edit or safely cancel pending bill entries for this supplier.">
          <DataTable headers={["Date", "Items Narration", "Estimated Total", "Status", "Action"]}>
            {selectedRows.map((purchase) => (
              <tr className="report-row-clickable" key={purchase.id} onClick={() => onOpenPurchaseAmendment(purchase)}>
                <td>{formatDisplayDate(purchase.purchase_date)}</td>
                <td className="primary-cell purchase-items-cell">
                  <span title={narration(purchase)}>{narration(purchase)}</span>
                </td>
                <td>{currency.format(estimatedValue(purchase))}</td>
                <td><span className="origin-rate">Pending Bill</span></td>
                <td>
                  <div className="button-row table-actions-row">
                    <button className="primary-button" onClick={(event) => { event.stopPropagation(); onCompletePurchase(purchase); }}>Complete Bill</button>
                    <button className="table-action" onClick={(event) => { event.stopPropagation(); onEditPurchase(purchase); }}>Edit Pending Entry</button>
                    <button className="remove-button" onClick={(event) => { event.stopPropagation(); onCancelPurchase(purchase); }}>Cancel Pending Entry</button>
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
          <div className="button-row">
            <button className="secondary-button" onClick={() => onOpenPurchaseAmendment(selectedRows[0])}>Add Forgotten Item</button>
            <button className="secondary-button" onClick={() => setSelectedSupplierKey("")}>Back to Supplier Summary</button>
          </div>
        </ModuleCard>
      )}
    </section>
  );
}

function PendingBillsModule({ customerPendingBills = { summary: [], invoices: [] }, customers = [], onCancelPurchase, onCompletePurchase, onEditPurchase, onOpenPurchaseAmendment, onReload, onViewInvoice, purchases, user }) {
  const [activeTab, setActiveTab] = useState("purchase");
  const [selectedCustomerKey, setSelectedCustomerKey] = useState("");
  const [pendingSearch, setPendingSearch] = useState("");
  const [paymentDraft, setPaymentDraft] = useState({
    customer_id: "",
    payment_date: toDateKey(new Date()),
    payment_amount: "",
    payment_mode: "CASH",
    reference_number: "",
    remarks: "",
  });
  const rawSummaries = Array.isArray(customerPendingBills.summary) ? customerPendingBills.summary : [];
  const summaries = rawSummaries
    .map((summary) => {
      const rows = Array.isArray(summary.rows) ? summary.rows : [];
      const summaryMatches = matchesPendingBillSearch([
        summary.customer_name,
        summary.from,
        summary.to,
        summary.pending_bill_count,
        summary.total_credit_amount,
        summary.amount_received,
        summary.balance,
        "Customer Pending Bills",
      ], pendingSearch);
      const filteredRows = rows.filter((invoice) => matchesPendingBillSearch([
        summary.customer_name,
        invoice.customer_name,
        invoice.invoice_no,
        invoice.sale_date,
        invoice.bill_date,
        invoice.item_narration,
        invoice.gross_amount,
        invoice.item_discount_amount,
        invoice.invoice_discount_amount,
        invoice.total_amount,
        invoice.received_amount,
        invoice.balance_amount,
        invoice.due_date,
        invoice.credit_status,
        invoice.payment_mode,
        invoice.remarks,
      ], pendingSearch));
      return { ...summary, rows: summaryMatches ? rows : filteredRows };
    })
    .filter((summary) => matchesPendingBillSearch([
      summary.customer_name,
      summary.from,
      summary.to,
      summary.pending_bill_count,
      summary.total_credit_amount,
      summary.amount_received,
      summary.balance,
    ], pendingSearch) || summary.rows.length > 0);
  const selectedCustomer = summaries.find((summary) => summary.key === selectedCustomerKey);
  const canReceivePayment = ["Owner", "Admin", "Cashier"].includes(user.role);

  const openReceivePayment = (summary, invoice = null) => {
    if (!summary?.customer_id) {
      alert("Customer account is required before receiving payment.");
      return;
    }
    setSelectedCustomerKey(summary.key);
    setPaymentDraft({
      customer_id: summary.customer_id,
      payment_date: toDateKey(new Date()),
      payment_amount: invoice ? Number(invoice.balance_amount || 0).toFixed(2) : "",
      payment_mode: "CASH",
      reference_number: "",
      remarks: invoice?.invoice_no ? `Against credit invoice ${invoice.invoice_no}` : "Against customer pending bills",
    });
  };

  const saveCustomerPayment = async () => {
    if (!canReceivePayment) {
      alert("Your role cannot receive customer payments.");
      return;
    }
    if (!paymentDraft.customer_id || Number(paymentDraft.payment_amount || 0) <= 0) {
      alert("Enter valid customer payment details.");
      return;
    }
    try {
      await axios.post(`${API_URL}/customer-payments`, {
        ...paymentDraft,
        branch_id: user.branch_id,
        created_by: user.id,
      });
      setPaymentDraft({ customer_id: "", payment_date: toDateKey(new Date()), payment_amount: "", payment_mode: "CASH", reference_number: "", remarks: "" });
      await onReload();
      alert("Customer payment saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save customer payment"));
    }
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Operations" title="Pending Bills" subtitle="Complete supplier pending bills and settle customer credit invoices.">
        <label className="icon-input table-search-input">
          <Icon name="search" />
          <input
            placeholder="Search pending bill, customer, supplier, invoice..."
            value={pendingSearch}
            onChange={(event) => setPendingSearch(event.target.value)}
          />
        </label>
        <div className="settings-tabs">
          <button className={activeTab === "purchase" ? "tab-active" : ""} onClick={() => setActiveTab("purchase")}>Pending Purchase Bills</button>
          <button className={activeTab === "customer" ? "tab-active" : ""} onClick={() => setActiveTab("customer")}>Customer Pending Bills</button>
        </div>
      </ModuleCard>

      {activeTab === "purchase" && (
        <PendingPurchaseBillsModule
          onCancelPurchase={onCancelPurchase}
          onCompletePurchase={onCompletePurchase}
          onEditPurchase={onEditPurchase}
          onOpenPurchaseAmendment={onOpenPurchaseAmendment}
          purchases={purchases}
          search={pendingSearch}
        />
      )}

      {activeTab === "customer" && (
        <>
          <ModuleCard eyebrow="Customer Credit" title="Customer-Wise Pending Bills" subtitle="Credit POS bills stay here until customer receipts are entered.">
            <div className="purchase-summary-grid supplier-payment-preview">
              <SummaryMetric label="Customers Pending" value={summaries.length} featured />
              <SummaryMetric label="Credit Amount" value={currency.format(summaries.reduce((sum, row) => sum + Number(row.total_credit_amount || 0), 0))} />
              <SummaryMetric label="Balance" value={currency.format(summaries.reduce((sum, row) => sum + Number(row.balance || 0), 0))} />
            </div>
            <DataTable headers={["Customer Name", "Pending From Date", "Pending To Date", "Pending Bill Count", "Total Credit Amount", "Amount Received", "Balance", "Action"]}>
              {summaries.map((summary) => (
                <tr key={summary.key}>
                  <td className="primary-cell">{summary.customer_name}</td>
                  <td>{formatDisplayDate(summary.from)}</td>
                  <td>{formatDisplayDate(summary.to)}</td>
                  <td>{summary.pending_bill_count} bills</td>
                  <td>{currency.format(Number(summary.total_credit_amount || 0))}</td>
                  <td>{currency.format(Number(summary.amount_received || 0))}</td>
                  <td className="balance-cell">{currency.format(Number(summary.balance || 0))}</td>
                  <td><button className="table-action" onClick={() => setSelectedCustomerKey(summary.key)}>View</button></td>
                </tr>
              ))}
            </DataTable>
            {summaries.length === 0 && <div className="cart-empty">{rawSummaries.length ? "No matching pending bills found." : "No customer pending bills."}</div>}
          </ModuleCard>

          {selectedCustomer && (
            <ModuleCard eyebrow="Customer Drill-Down" title={selectedCustomer.customer_name} subtitle="Receive payment, view invoices and print customer credit statement.">
              <DataTable headers={["Bill Date", "Invoice Number", "Items / Narration", "Gross Amount", "Discount", "Net Amount", "Received", "Balance", "Due Date", "Status", "Action"]}>
                {selectedCustomer.rows.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>{formatDisplayDate(invoice.sale_date)}</td>
                    <td><span className="batch-id">{invoice.invoice_no || `#${invoice.id}`}</span></td>
                    <td className="primary-cell purchase-items-cell"><span title={invoice.item_narration}>{String(invoice.item_narration || "").split("\n").slice(0, 2).join(", ")}</span></td>
                    <td>{currency.format(Number(invoice.gross_amount || 0))}</td>
                    <td>{currency.format(Number(invoice.item_discount_amount || 0) + Number(invoice.invoice_discount_amount || 0))}</td>
                    <td>{currency.format(Number(invoice.total_amount || 0))}</td>
                    <td>{currency.format(Number(invoice.received_amount || 0))}</td>
                    <td className="balance-cell">{currency.format(Number(invoice.balance_amount || 0))}</td>
                    <td>{invoice.due_date ? formatDisplayDate(invoice.due_date) : "-"}</td>
                    <td><span className={invoice.credit_status === "Paid" ? "stock-ok" : invoice.credit_status === "Partially Paid" ? "origin-rate" : "stock-low"}>{invoice.credit_status}</span></td>
                    <td>
                      <div className="button-row table-actions-row">
                        <button className="primary-button" disabled={Number(invoice.balance_amount || 0) <= 0} onClick={() => openReceivePayment(selectedCustomer, invoice)}>Receive Payment</button>
                        <button className="table-action" onClick={() => onViewInvoice(invoice.id)}>View Invoice</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </DataTable>
              <div className="button-row">
                <button className="secondary-button" onClick={() => openReceivePayment(selectedCustomer)}>Receive General Payment</button>
                <button className="secondary-button" onClick={() => window.print()}>Print Statement</button>
                <button className="secondary-button" onClick={() => setSelectedCustomerKey("")}>Back to Customer Summary</button>
              </div>
            </ModuleCard>
          )}

          {paymentDraft.customer_id && (
            <ModuleCard eyebrow="Customer Receipt" title="Receive Payment Against Credit" subtitle="Payment will reduce customer receivable and update Cash Book based on payment mode.">
              <div className="form-grid supplier-form-grid">
                <Field label="Customer">
                  <select value={paymentDraft.customer_id} onChange={(event) => setPaymentDraft({ ...paymentDraft, customer_id: event.target.value })}>
                    <option value="">Select customer</option>
                    {customers.filter((customer) => customer.active !== false).map((customer) => <option key={customer.id} value={customer.id}>{customer.customer_name}</option>)}
                  </select>
                </Field>
                <Field label="Payment Date"><input type="date" value={paymentDraft.payment_date} onChange={(event) => setPaymentDraft({ ...paymentDraft, payment_date: event.target.value })} /></Field>
                <Field label="Payment Amount"><input min="0" step="0.01" type="number" value={paymentDraft.payment_amount} onChange={(event) => setPaymentDraft({ ...paymentDraft, payment_amount: event.target.value })} /></Field>
                <Field label="Payment Mode">
                  <select value={paymentDraft.payment_mode} onChange={(event) => setPaymentDraft({ ...paymentDraft, payment_mode: event.target.value })}>
                    <option value="CASH">Cash</option>
                    <option value="UPI">UPI</option>
                    <option value="CARD">Card</option>
                    <option value="BANK_TRANSFER">Bank</option>
                  </select>
                </Field>
                <Field label="Reference Number"><input value={paymentDraft.reference_number} onChange={(event) => setPaymentDraft({ ...paymentDraft, reference_number: event.target.value })} /></Field>
                <Field label="Remarks"><input value={paymentDraft.remarks} onChange={(event) => setPaymentDraft({ ...paymentDraft, remarks: event.target.value })} /></Field>
              </div>
              <div className="button-row">
                <button className="primary-button" onClick={saveCustomerPayment}>Save Payment</button>
                <button className="secondary-button" onClick={() => setPaymentDraft({ customer_id: "", payment_date: toDateKey(new Date()), payment_amount: "", payment_mode: "CASH", reference_number: "", remarks: "" })}>Cancel</button>
              </div>
            </ModuleCard>
          )}
        </>
      )}
    </section>
  );
}

function DiscountManagementModule({ discounts = [], inventory = [], onReload, products = [], user }) {
  const [productId, setProductId] = useState("");
  const [selectedLotIds, setSelectedLotIds] = useState([]);
  const [form, setForm] = useState({
    discount_type: "FIXED_AMOUNT",
    discount_value: "",
    start_date: toDateKey(new Date()),
    end_date: "",
    active: true,
    remarks: "",
  });
  const canManage = ["Owner", "Admin"].includes(user.role);
  const productLots = inventory.filter((lot) =>
    String(lot.product_id) === String(productId) &&
    Number(lot.remaining_qty || 0) > 0 &&
    lot.batch_status !== "CANCELLED"
  );
  const activeDiscountForLot = (lotId) => discounts.find((discount) =>
    Number(discount.inventory_batch_id) === Number(lotId) &&
    discount.active !== false &&
    (!discount.end_date || toDateKey(discount.end_date) >= toDateKey(new Date()))
  );

  const toggleLot = (lotId) => {
    setSelectedLotIds((ids) => ids.includes(lotId) ? ids.filter((id) => id !== lotId) : [...ids, lotId]);
  };

  const saveDiscount = async () => {
    if (!canManage) {
      alert("Only Owner/Admin can create discounts.");
      return;
    }
    if (!productId || selectedLotIds.length === 0 || Number(form.discount_value || 0) < 0) {
      alert("Select product, lot and valid discount value.");
      return;
    }
    try {
      await axios.post(`${API_URL}/lot-discounts`, {
        product_id: productId,
        inventory_batch_ids: selectedLotIds,
        ...form,
        created_by: user.id,
      });
      setSelectedLotIds([]);
      setForm({ discount_type: "FIXED_AMOUNT", discount_value: "", start_date: toDateKey(new Date()), end_date: "", active: true, remarks: "" });
      await onReload();
      alert("Discount saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save discount"));
    }
  };

  const deactivateDiscount = async (discount) => {
    if (!canManage) {
      alert("Only Owner/Admin can deactivate discounts.");
      return;
    }
    const remarks = window.prompt("Reason / remarks for deactivation", "Discount deactivated") || "Discount deactivated";
    try {
      await axios.post(`${API_URL}/lot-discounts/${discount.id}/deactivate`, { updated_by: user.id, remarks });
      await onReload();
      alert("Discount deactivated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to deactivate discount"));
    }
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Retail Pricing" title="Discount Management" subtitle="Create item-wise and lot-wise retail POS discounts without changing permanent sale rates.">
        <div className="form-grid supplier-form-grid">
          <Field label="Product / Item">
            <select value={productId} onChange={(event) => { setProductId(event.target.value); setSelectedLotIds([]); }}>
              <option value="">Select product</option>
              {products.map((product) => <option key={product.id} value={product.id}>{product.category || "Fruit"} - {product.product_name}</option>)}
            </select>
          </Field>
          <Field label="Discount Type">
            <select value={form.discount_type} onChange={(event) => setForm({ ...form, discount_type: event.target.value })}>
              <option value="FIXED_AMOUNT">Fixed Amount Discount</option>
              <option value="PERCENTAGE">Percentage Discount</option>
              <option value="SPECIAL_RATE">Special Sale Rate</option>
            </select>
          </Field>
          <Field label="Discount Value"><input min="0" step="0.01" type="number" value={form.discount_value} onChange={(event) => setForm({ ...form, discount_value: event.target.value })} /></Field>
          <Field label="Start Date"><input type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} /></Field>
          <Field label="End Date"><input type="date" value={form.end_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} /></Field>
          <Field label="Status">
            <select value={form.active ? "ACTIVE" : "INACTIVE"} onChange={(event) => setForm({ ...form, active: event.target.value === "ACTIVE" })}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </Field>
          <Field label="Remarks"><input value={form.remarks} onChange={(event) => setForm({ ...form, remarks: event.target.value })} /></Field>
        </div>
        <div className="button-row">
          <button className="secondary-button" disabled={productLots.length === 0} onClick={() => setSelectedLotIds(productLots.map((lot) => lot.id))}>Select All Active Lots</button>
          <button className="primary-button" disabled={!canManage} onClick={saveDiscount}>Save Discount</button>
        </div>
      </ModuleCard>

      <ModuleCard eyebrow="Lot Selection" title="Available Lots / Batches" subtitle="Discounts apply only to the selected stock lots.">
        <DataTable headers={["Select", "Lot Name / Number", "Size / Grade", "Supplier", "Available Qty", "Current Sale Rate", "Cost Rate", "Existing Discount", "Status"]}>
          {productLots.map((lot) => {
            const existing = activeDiscountForLot(lot.id);
            return (
              <tr key={lot.id}>
                <td><input checked={selectedLotIds.includes(lot.id)} type="checkbox" onChange={() => toggleLot(lot.id)} /></td>
                <td className="primary-cell">{lot.lot_name || lot.batch_no || `Lot #${lot.id}`}</td>
                <td>{lot.lot_size || "-"}</td>
                <td>{lot.supplier_name || "-"}</td>
                <td>{Number(lot.remaining_qty || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</td>
                <td>{currency.format(Number(lot.temporary_sale_rate || 0) > 0 ? Number(lot.temporary_sale_rate) : Number(lot.selling_rate || 0))}</td>
                <td>{currency.format(Number(lot.effective_cost_per_unit || lot.purchase_rate || 0))}</td>
                <td>{existing ? `${existing.discount_type} ${currency.format(Number(existing.discount_value || 0))}` : "-"}</td>
                <td><span className={lot.batch_status === "ACTIVE" || !lot.batch_status ? "stock-ok" : "stock-low"}>{lot.batch_status || "ACTIVE"}</span></td>
              </tr>
            );
          })}
        </DataTable>
        {productId && productLots.length === 0 && <div className="cart-empty">No active lots with stock for this product.</div>}
        {!productId && <div className="cart-empty">Select a product to view lots.</div>}
      </ModuleCard>

      <ModuleCard eyebrow="Active Discounts" title="Current Lot-Wise Discounts" subtitle="Reports and Sales History always keep discount accounting, even if receipt display hides it.">
        <DataTable headers={["Product", "Lot / Size", "Discount Type", "Value", "Start", "End", "Status", "Remarks", "Actions"]}>
          {discounts.map((discount) => (
            <tr key={discount.id}>
              <td className="primary-cell">{discount.product_name}</td>
              <td>{discount.lot_name || discount.batch_no || "-"}{discount.lot_size ? ` / ${discount.lot_size}` : ""}</td>
              <td>{discount.discount_type}</td>
              <td>{discount.discount_type === "PERCENTAGE" ? `${Number(discount.discount_value || 0)}%` : currency.format(Number(discount.discount_value || 0))}</td>
              <td>{formatDisplayDate(discount.start_date)}</td>
              <td>{discount.end_date ? formatDisplayDate(discount.end_date) : "Open"}</td>
              <td><span className={discount.active ? "stock-ok" : "stock-low"}>{discount.active ? "Active" : "Inactive"}</span></td>
              <td>{discount.remarks || "-"}</td>
              <td><button className="remove-button" disabled={!discount.active || !canManage} onClick={() => deactivateDiscount(discount)}>Deactivate</button></td>
            </tr>
          ))}
        </DataTable>
      </ModuleCard>
    </section>
  );
}

function ReportsModule({ canCancelSales, canEditSales, canManageStock, data = {}, onCancelPurchase, onCompletePurchase, onEditPurchase, onOpenBlankPurchaseAmendment, onOpenCustomerLedger, onOpenLotAction, onOpenPurchaseAmendment, onOpenSaleForEdit, onOpenSaleView, onPrintSale, onCancelSale, onOpenSupplierLedger, onReload }) {
  const [range, setRange] = useState("today");
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [selectedReport, setSelectedReport] = useState("");
  const [clubSalesItems, setClubSalesItems] = useState(false);
  const [salesPrintNarration, setSalesPrintNarration] = useState(false);
  const salesPrintNarrationRef = useRef(false);
  const [clubPurchaseItems, setClubPurchaseItems] = useState(false);
  const [purchasePrintNarration, setPurchasePrintNarration] = useState(false);
  const purchasePrintNarrationRef = useRef(false);
  const [salesFilters, setSalesFilters] = useState({
    date: "",
    status: "ACTIVE",
    viewMode: "INVOICE",
    customer: "",
    product: "",
    lot: "",
    paymentMode: "",
    user: "",
  });
  const [expandedSalesRows, setExpandedSalesRows] = useState({});
  const [accountReportFilters, setAccountReportFilters] = useState({
    accountType: "",
    accountName: "",
    voucherType: "",
    paymentMode: "",
  });
  const [clubLedgerEntries, setClubLedgerEntries] = useState(false);
  const [ledgerPrintNarration, setLedgerPrintNarration] = useState(false);
  const ledgerPrintNarrationRef = useRef(false);
  const [balanceSheetDetail, setBalanceSheetDetail] = useState(null);
  const [balanceSheetDetailLoading, setBalanceSheetDetailLoading] = useState(false);
  const [balanceSheetDetailError, setBalanceSheetDetailError] = useState("");
  const [cashBookDetail, setCashBookDetail] = useState(null);
  const [cashBookFilters, setCashBookFilters] = useState({ paymentMode: "", accountFilter: "", bookAccount: "ALL" });
  const [cashBookViewMode, setCashBookViewMode] = useState("SUMMARY");
  const [cashBookGroupBy, setCashBookGroupBy] = useState("PERIOD");
  const [showCashBookRemarks, setShowCashBookRemarks] = useState(true);
  const [inventoryLotReportFilter, setInventoryLotReportFilter] = useState("ACTIVE");
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
  const currentReportParams = () => range === "custom" ? customRange : { range };
  const currentCashBookParams = (overrides = {}) => {
    const nextFilters = { ...cashBookFilters, ...(overrides.filters || {}) };
    const bookAccount = nextFilters.bookAccount || "ALL";
    const accountFilter = bookAccount === "CASH" ? "CASH" : ["BANK", "UPI", "CARD", "BANK_TRANSFER"].includes(bookAccount) ? "BANK" : "";
    const paymentMode = ["UPI", "CARD", "BANK_TRANSFER"].includes(bookAccount)
      ? bookAccount
      : nextFilters.paymentMode;
    return {
      ...currentReportParams(),
      payment_mode: paymentMode,
      account_filter: accountFilter,
      party_filter: nextFilters.accountFilter,
      search,
    };
  };
  const refreshReports = async () => {
    await onReload(selectedReport === "cashBook" ? currentCashBookParams() : currentReportParams());
  };
  const reloadCashBook = async (filters = cashBookFilters) => {
    await onReload(currentCashBookParams({ filters }));
  };
  const clearLedgerFilters = async () => {
    setAccountReportFilters({ accountType: "", accountName: "", voucherType: "", paymentMode: "" });
    await onReload(currentReportParams());
  };
  const openBalanceSheetDetail = async (lineKey) => {
    if (!lineKey) return;
    setBalanceSheetDetailLoading(true);
    setBalanceSheetDetailError("");
    setBalanceSheetDetail(null);
    try {
      const response = await axios.get(`${API_URL}/reports/balance-sheet/details/${lineKey}`, { params: currentReportParams() });
      setBalanceSheetDetail(response.data);
    } catch (error) {
      setBalanceSheetDetailError(getErrorMessage(error, "Unable to load Balance Sheet detail"));
    } finally {
      setBalanceSheetDetailLoading(false);
    }
  };
  const matchesSearch = (row) => !search.trim() || Object.values(row || {}).some((value) => {
    const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
    return text.toLowerCase().includes(search.trim().toLowerCase());
  });
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
  const dayBookVoucherType = (row) => {
    const raw = String(row.transaction_type || row.voucher_type || "").toLowerCase();
    if (raw.includes("sale return")) return "Sale Return";
    if (raw.includes("customer sale") || raw === "sale" || raw.includes("pos sale")) return "POS Sale";
    if (raw.includes("supplier purchase") || raw === "purchase") return "Purchase";
    if (raw.includes("supplier payment")) return "Supplier Payment";
    if (raw.includes("customer payment") || raw.includes("customer receipt") || raw === "receipt") return "Customer Receipt";
    if (raw.includes("expense")) return "Expense";
    if (raw.includes("waste")) return "Waste";
    if (raw.includes("opening")) return "Opening Stock";
    if (raw.includes("adjust")) return "Stock Adjustment";
    if (raw.includes("capital")) return "Owner Capital";
    if (raw.includes("drawing")) return "Drawings";
    return row.transaction_type || row.voucher_type || "-";
  };
  const accountNames = [...new Set(ledgerRows.map((row) => row.party_name).filter(Boolean))].sort();
  const voucherTypes = [
    "POS Sale",
    "Purchase",
    "Supplier Payment",
    "Customer Receipt",
    "Expense",
    "Sale Return",
    "Waste",
    "Stock Adjustment",
    "Opening Stock",
    "Owner Capital",
    "Drawings",
    ...new Set(ledgerRows.map(dayBookVoucherType).filter(Boolean)),
  ].filter((type, index, list) => list.indexOf(type) === index).sort();
  const filteredLedgerRows = ledgerRows.filter((row) => {
    if (accountReportFilters.accountType === "CASH" && row.payment_mode !== "CASH") return false;
    if (accountReportFilters.accountType === "BANK" && !bankPaymentModes.has(row.payment_mode)) return false;
    if (accountReportFilters.accountType === "EXPENSE" && !["EXPENSE", "EXPENSE_VENDOR"].includes(row.account_type)) return false;
    if (accountReportFilters.accountType && !["CASH", "BANK", "EXPENSE"].includes(accountReportFilters.accountType) && row.account_type !== accountReportFilters.accountType) return false;
    if (accountReportFilters.accountName && row.party_name !== accountReportFilters.accountName) return false;
    if (accountReportFilters.voucherType && dayBookVoucherType(row) !== accountReportFilters.voucherType) return false;
    if (accountReportFilters.paymentMode === "OTHER" && ["CASH", "UPI", "CARD", "BANK_TRANSFER", "CREDIT", "CHEQUE"].includes(row.payment_mode)) return false;
    if (accountReportFilters.paymentMode && accountReportFilters.paymentMode !== "OTHER" && row.payment_mode !== accountReportFilters.paymentMode) return false;
    return true;
  });
  const clubRowsByDateAccount = (rows) => {
    if (!clubLedgerEntries) return rows;
    const groups = new Map();
    for (const row of rows) {
      const voucherType = dayBookVoucherType(row);
      const key = `${toDateKey(row.date)}-${voucherType}-${row.party_name}-${row.payment_mode || "NONE"}`;
      const current = groups.get(key) || {
        ...row,
        display_voucher_type: voucherType,
        voucher_no: "Multiple",
        debit: 0,
        credit: 0,
        narration: "",
        remarks: "",
        transaction_count: 0,
      };
      current.debit += Number(row.debit || 0);
      current.credit += Number(row.credit || 0);
      current.transaction_count += 1;
      current.narration = [current.narration, row.narration || row.remarks].filter(Boolean).join("\n");
      current.remarks = [current.remarks, row.remarks].filter(Boolean).join("; ");
      current.narration_summary = `${voucherType} - ${current.transaction_count} ${current.transaction_count === 1 ? "entry" : "entries"}${row.payment_mode ? ` - ${row.payment_mode}` : ""}`;
      groups.set(key, current);
    }
    return [...groups.values()];
  };
  const withRunningBalance = (rows, mode = "RECEIVABLE") => {
    let balance = 0;
    return [...rows]
      .sort((left, right) => toDateKey(left.date).localeCompare(toDateKey(right.date)) || String(left.voucher_no || "").localeCompare(String(right.voucher_no || "")))
      .map((row) => {
        balance = roundUi(balance + (mode === "PAYABLE" ? Number(row.credit || 0) - Number(row.debit || 0) : Number(row.debit || 0) - Number(row.credit || 0)));
        return { ...row, running_balance: balance };
      })
      .sort((left, right) => toDateKey(right.date).localeCompare(toDateKey(left.date)) || String(right.voucher_no || "").localeCompare(String(left.voucher_no || "")));
  };
  const ledgerNarration = (row) => ledgerPrintNarration || ledgerPrintNarrationRef.current ? row.narration || row.remarks || "-" : row.remarks || row.narration || "-";
  const customerLedgerRows = withRunningBalance(clubRowsByDateAccount(filteredLedgerRows.filter((row) => row.account_type === "CUSTOMER")));
  const supplierLedgerRows = withRunningBalance(clubRowsByDateAccount(filteredLedgerRows.filter((row) => row.account_type === "SUPPLIER")), "PAYABLE");
  const accountStatementRows = withRunningBalance(clubRowsByDateAccount(filteredLedgerRows));
  const dayBookRows = clubRowsByDateAccount(filteredLedgerRows);
  const cashBookData = data.cashBookReport || {};
  const cashBookRows = filterRows(cashBookData.rows);
  const stockLotRows = filterRows(data.stockLotReport).filter((row) => {
    const status = String(row.batch_status || "ACTIVE").toUpperCase();
    const balance = Number(row.remaining_qty ?? row.balance_qty ?? 0);
    if (inventoryLotReportFilter === "ACTIVE") return balance > 0 && !["CANCELLED", "INACTIVE"].includes(status);
    if (inventoryLotReportFilter === "SOLD_OUT") return !["CANCELLED", "INACTIVE"].includes(status);
    return true;
  });
  const cashBookAccountMode = cashBookFilters.bookAccount || "ALL";
  const cashBookAccountLabel = cashBookAccountMode === "ALL"
    ? "Cash + Bank"
    : cashBookAccountMode === "CASH"
      ? "Cash"
      : cashBookAccountMode === "UPI"
      ? "UPI"
      : cashBookAccountMode === "CARD"
        ? "Card"
        : cashBookAccountMode === "BANK_TRANSFER"
          ? "Bank Transfer"
          : "Bank / UPI / Card";
  const cashBookOpeningCash = Number(cashBookData.opening_cash || 0);
  const cashBookOpeningBank = Number(cashBookData.opening_bank || 0);
  const cashBookReceiptsCash = Number(cashBookData.cash_receipts || 0);
  const cashBookReceiptsBank = Number(cashBookData.bank_receipts || 0);
  const cashBookPaymentsCash = Number(cashBookData.cash_payments || 0);
  const cashBookPaymentsBank = Number(cashBookData.bank_payments || 0);
  const cashBookClosingCash = Number(cashBookData.closing_cash || 0);
  const cashBookClosingBank = Number(cashBookData.closing_bank || 0);
  const salesChanges = filterRows(data.salesChangeReport);
  const editedBills = salesChanges.filter((row) => row.sale_status === "EDITED" || row.edited_at);
  const cancelledBills = salesChanges.filter((row) => row.sale_status === "CANCELLED" || row.cancelled_at);
  const purchaseChanges = filterRows(data.purchaseChangeReport);
  const wasteProductRows = filterRows(data.wasteProductReport);
  const purchaseHistoryRawRows = filterRows(data.purchaseHistoryReport).filter((row) =>
    row.purchase_status === "CANCELLED" || row.purchase_bill_status === "BILL_COMPLETED"
  );
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
    const lotText = row.lot_name ? ` (${row.lot_name}${row.lot_size ? ` / ${row.lot_size}` : ""})` : "";
    const qty = Number(row.quantity || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
    const unit = String(row.unit || "").toLowerCase();
    const rate = Number(row.purchase_rate || row.expected_purchase_rate || 0);
    return `${product}${lotText} ${qty}${unit} @ ${money(rate)} = ${money(purchaseItemBasic(row))}`;
  };
  const filteredPurchaseHistoryRows = purchaseHistoryRawRows.filter((row) => {
    if (purchaseFilters.supplier && String(row.supplier_id || "") !== purchaseFilters.supplier) return false;
    if (purchaseFilters.product && String(row.product_id || "") !== purchaseFilters.product) return false;
    if (purchaseFilters.paymentType && row.purchase_type !== purchaseFilters.paymentType) return false;
    if (purchaseFilters.date && toDateKey(row.purchase_date) !== purchaseFilters.date) return false;
    if (purchaseFilters.status === "CANCELLED") return row.purchase_status === "CANCELLED";
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
        .map((row) => `${row.product_name}${row.lot_name ? ` ${row.lot_name}` : ""} ${Number(row.quantity || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}${String(row.unit || "").toLowerCase()}`)
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
  const purchaseNarrationDisplay = (row) => (
    purchasePrintNarration || purchasePrintNarrationRef.current ? row.item_narration : row.item_summary
  );
  const salesHistoryRawRows = Array.isArray(data.salesHistoryReport)
    ? data.salesHistoryReport
    : Array.isArray(data.salesHistoryReport?.rows)
      ? data.salesHistoryReport.rows
      : [];
  const saleItems = (row) => {
    if (Array.isArray(row.items)) return row.items;
    if (typeof row.items === "string") {
      try {
        const parsed = JSON.parse(row.items);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  };
  const saleStatusLabel = (row) => row.sale_status === "CANCELLED" ? "Cancelled" : row.sale_status === "EDITED" ? "Edited" : "Completed";
  const saleItemGross = (item) => Number(item.gross_amount ?? item.amount ?? 0) || Number(item.quantity || 0) * Number(item.selling_rate || 0);
  const saleItemDiscount = (item) => Number(item.discount_amount || 0);
  const saleItemNetBeforeInvoiceDiscount = (item) => Number(item.net_amount ?? (saleItemGross(item) - saleItemDiscount(item)));
  const saleLotLabel = (item) => [item.lot_name, item.lot_size].filter(Boolean).join(" / ") || "-";
  const saleItemNarration = (item) => {
    const lot = [item.lot_name, item.lot_size].filter(Boolean).join(" / ") || "-";
    const qty = Number(item.quantity || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
    const unit = String(item.unit || "");
    const rate = Number(item.selling_rate || 0);
    return [
      `Item: ${item.product_name || "Item"}`,
      `Lot No: ${lot}`,
      `Qty: ${qty} ${unit}`.trim(),
      `Rate: ${money(rate)}`,
      `Amount: ${money(saleItemGross(item))}`,
    ].join("\n");
  };
  const saleItemSearchText = (row, item) => [
    row.invoice_no,
    row.customer_name,
    row.customer_mobile,
    row.payment_mode,
    row.sale_status,
    toDateKey(row.sale_date),
    item.product_name,
    item.category,
    item.lot_name,
    item.lot_size,
    item.unit,
    item.quantity,
    item.selling_rate,
    saleItemGross(item),
    saleItemNetBeforeInvoiceDiscount(item),
  ].filter((value) => value !== undefined && value !== null).join(" ").toLowerCase();
  const saleHeaderSearchText = (row) => [
    row.invoice_no,
    row.customer_name,
    row.customer_mobile,
    row.payment_mode,
    row.sale_status,
    saleStatusLabel(row),
    toDateKey(row.sale_date),
    formatDisplayDate(row.sale_date),
    row.gross_amount,
    row.total_amount,
  ].filter((value) => value !== undefined && value !== null).join(" ").toLowerCase();
  const saleNarrationPreview = (items) => {
    const summary = items
      .slice(0, 2)
      .map((item) => `${item.product_name || "Item"}${item.lot_name ? ` ${item.lot_name}` : ""} ${Number(item.quantity || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}${String(item.unit || "").toLowerCase()}`)
      .join(", ");
    const extraCount = Math.max(items.length - 2, 0);
    return `${summary || "No item detail"}${extraCount ? ` +${extraCount} more` : ""}`;
  };
  const salesFilterOptions = salesHistoryRawRows.reduce((options, row) => {
    if (row.customer_name) options.customers.set(String(row.customer_id || row.customer_name), row.customer_name || "Walk-in Customer");
    if (row.payment_mode) options.paymentModes.add(row.payment_mode);
    if (row.created_by_name) options.users.add(row.created_by_name);
    for (const item of saleItems(row)) {
      if (item.product_id || item.product_name) options.products.set(String(item.product_id || item.product_name), item.product_name || "Item");
      const lotKey = String(item.inventory_batch_id || item.lot_name || "");
      if (lotKey) options.lots.set(lotKey, saleLotLabel(item));
    }
    return options;
  }, { customers: new Map(), products: new Map(), lots: new Map(), paymentModes: new Set(), users: new Set() });
  const filteredSalesHistoryRows = salesHistoryRawRows.filter((row) => {
    if (salesFilters.date && toDateKey(row.sale_date) !== salesFilters.date) return false;
    if (salesFilters.status === "CANCELLED") return row.sale_status === "CANCELLED";
    if (salesFilters.status === "EDITED") return row.sale_status === "EDITED";
    if (salesFilters.status === "ACTIVE") return row.sale_status !== "CANCELLED";
    return true;
  }).map((row) => {
    const allItems = saleItems(row);
    const selectorItems = allItems.filter((item) => {
      if (salesFilters.customer && String(row.customer_id || row.customer_name || "") !== salesFilters.customer) return false;
      if (salesFilters.product && String(item.product_id || item.product_name || "") !== salesFilters.product) return false;
      if (salesFilters.lot && String(item.inventory_batch_id || item.lot_name || "") !== salesFilters.lot) return false;
      if (salesFilters.paymentMode && row.payment_mode !== salesFilters.paymentMode) return false;
      if (salesFilters.user && row.created_by_name !== salesFilters.user) return false;
      return true;
    });
    const hasSelectorFilter = Boolean(salesFilters.customer || salesFilters.product || salesFilters.lot || salesFilters.paymentMode || salesFilters.user);
    if (hasSelectorFilter && selectorItems.length === 0) return null;
    const searchText = search.trim().toLowerCase();
    if (!searchText) return { ...row, visible_items: selectorItems, all_items: allItems, showing_matched_only: false };
    const matchedItems = selectorItems.filter((item) => saleItemSearchText(row, item).includes(searchText));
    const headerMatches = saleHeaderSearchText(row).includes(searchText);
    if (matchedItems.length > 0) {
      return {
        ...row,
        visible_items: matchedItems,
        all_items: allItems,
        showing_matched_only: matchedItems.length < allItems.length || !headerMatches,
      };
    }
    if (headerMatches && selectorItems.length > 0) {
      return { ...row, visible_items: selectorItems, all_items: allItems, showing_matched_only: false };
    }
    return null;
  }).filter(Boolean);
  const salesHistoryRows = (() => {
    const buildItemRows = (row) => {
      const visibleItems = row.visible_items?.length ? row.visible_items : saleItems(row);
      const allItems = row.all_items?.length ? row.all_items : visibleItems;
      const invoiceDiscount = Number(row.invoice_discount_amount || 0);
      const allNetBeforeInvoiceDiscount = allItems.reduce((sum, item) => sum + saleItemNetBeforeInvoiceDiscount(item), 0);
      return visibleItems.map((item, index) => {
        const netBeforeInvoiceDiscount = saleItemNetBeforeInvoiceDiscount(item);
        const invoiceDiscountShare = allNetBeforeInvoiceDiscount ? invoiceDiscount * (netBeforeInvoiceDiscount / allNetBeforeInvoiceDiscount) : 0;
        return {
          ...row,
          sale_id: row.id,
          item_id: item.id,
          sale_item_id: item.sale_item_id || item.id,
          inventory_batch_id: item.inventory_batch_id,
          display_key: `sale-${row.id}-item-${item.id || index}-lot-${item.inventory_batch_id || "fifo"}-${index}`,
          item_name: item.product_name || "Item",
          lot_name: item.lot_name || "",
          lot_size: item.lot_size || "",
          category: item.category || "",
          quantity: Number(item.quantity || 0),
          unit: item.unit || "",
          rate: Number(item.selling_rate || 0),
          item_summary: saleItemNarration(item),
          item_narration: saleItemNarration(item),
          gross_total: saleItemGross(item),
          item_discount_total: saleItemDiscount(item),
          bill_discount_total: invoiceDiscountShare,
          discount_total: saleItemDiscount(item) + invoiceDiscountShare,
          net_total: netBeforeInvoiceDiscount - invoiceDiscountShare,
          cost_rate: Number(item.quantity || 0) ? Number(item.cost_amount || 0) / Number(item.quantity || 1) : 0,
          cost_amount: Number(item.cost_amount || 0),
          profit: Number(item.profit || 0),
          cost_status: item.cost_status,
          status_label: saleStatusLabel(row),
          manual_rate_override: Boolean(item.manual_rate_override),
          showing_matched_only: row.showing_matched_only,
          full_items: allItems,
        };
      });
    };
    if (salesFilters.viewMode === "INVOICE" || clubSalesItems) {
      return filteredSalesHistoryRows.map((row) => {
        const items = row.visible_items?.length ? row.visible_items : saleItems(row);
        const itemRows = buildItemRows(row);
        return {
          ...row,
          sale_id: row.id,
          display_key: `sale-${row.id}`,
          item_summary: saleNarrationPreview(items),
          item_narration: items.map(saleItemNarration).join("\n") || "No item detail available",
          gross_total: itemRows.reduce((sum, item) => sum + Number(item.gross_total || 0), 0),
          item_discount_total: itemRows.reduce((sum, item) => sum + Number(item.item_discount_total || 0), 0),
          bill_discount_total: itemRows.reduce((sum, item) => sum + Number(item.bill_discount_total || 0), 0),
          discount_total: itemRows.reduce((sum, item) => sum + Number(item.discount_total || 0), 0),
          net_total: itemRows.reduce((sum, item) => sum + Number(item.net_total || 0), 0),
          status_label: saleStatusLabel(row),
          manual_rate_override: items.some((item) => item.manual_rate_override),
          item_rows: itemRows,
          showing_matched_only: row.showing_matched_only,
        };
      });
    }
    return filteredSalesHistoryRows.flatMap(buildItemRows);
  })();
  const salesNarrationDisplay = (row) => (
    salesPrintNarration || salesPrintNarrationRef.current ? row.item_narration : row.item_summary
  );
  const reports = {
    salesByDate: {
      title: "Sales by Date",
      rows: filterRows(data.salesReport),
      summary: (rows) => [["Sales", money(totalOf(rows, "total_sales")), true], ["Cash", money(totalOf(rows, "cash_sales"))], ["UPI", money(totalOf(rows, "upi_sales"))], ["Profit", money(totalOf(rows, "total_profit"))]],
      headers: ["Date", "Transactions", "Sales", "Cash", "UPI", "Bank/Card", "Cost", "Profit"],
      render: (row) => <tr key={row.sale_date}><td>{formatDisplayDate(row.sale_date)}</td><td>{row.transaction_count}</td><td>{money(row.total_sales)}</td><td>{money(row.cash_sales)}</td><td>{money(row.upi_sales)}</td><td>{money(row.bank_card_sales)}</td><td>{money(row.total_cost)}</td><td className="profit-cell">{money(row.total_profit)}</td></tr>,
    },
    salesByProduct: {
      title: "Sales by Product",
      rows: filterRows(data.salesProductReport),
      summary: (rows) => [["Revenue", money(totalOf(rows, "revenue")), true], ["Quantity Sold", number(totalOf(rows, "quantity_sold"))], ["Profit", money(totalOf(rows, "profit"))]],
      headers: ["Product", "Lot", "Quantity", "Rate", "Revenue", "Cost", "Profit"],
      render: (row) => <tr key={`${row.product_name}-${row.lot_name || "default"}-${row.lot_size || ""}`}><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{[row.lot_name, row.lot_size].filter(Boolean).join(" / ") || "-"}</td><td>{number(row.quantity_sold)}</td><td>{money(Number(row.quantity_sold || 0) ? Number(row.revenue || 0) / Number(row.quantity_sold || 1) : 0)}</td><td>{money(row.revenue)}</td><td>{money(row.cost)}</td><td className="profit-cell">{money(row.profit)}</td></tr>,
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
      rows: salesHistoryRows,
      summary: (rows) => {
        const activeRows = rows.filter((row) => row.status_label !== "Cancelled");
        const invoiceCount = new Set(activeRows.map((row) => row.sale_id)).size;
        return [["Net Sales", money(totalOf(activeRows, "net_total")), true], ["Invoices", invoiceCount], ["Item Lines", number(activeRows.reduce((sum, row) => sum + (row.item_rows?.length || 1), 0))], ["Gross Total", money(totalOf(activeRows, "gross_total"))], ["Item Discount", money(totalOf(activeRows, "item_discount_total"))], ["Bill Discount", money(totalOf(activeRows, "bill_discount_total"))]];
      },
      headers: salesFilters.viewMode === "INVOICE"
        ? ["Date", "Invoice", "Customer", "Item Summary", "Gross Total", "Item Discount", "Bill Discount", "Net Total", "Payment Mode", "Status"]
        : ["Date", "Invoice", "Customer", "Item Name", "Lot No.", "Size / Grade", "Quantity", "Unit", "Rate", "Gross Amount", "Item Discount", "Bill Discount", "Net Amount", "Payment Mode", "User"],
      render: (row) => {
        const saleId = row.sale_id || row.id;
        const openInvoice = () => onOpenSaleView?.(saleId);
        if (salesFilters.viewMode === "INVOICE") {
          const expanded = Boolean(expandedSalesRows[row.display_key]);
          return (
            <React.Fragment key={row.display_key}>
              <tr className={`report-row-clickable ${row.status_label === "Cancelled" ? "muted-row" : ""}`} onClick={openInvoice}>
                <td className="primary-cell date-cell">
                  {formatDisplayDate(row.sale_date)}
                </td>
                <td className="primary-cell">
                  {row.invoice_no || `#${row.sale_id}`}
                  {row.showing_matched_only && <small className="cell-note warning-note">Showing matched items only</small>}
                </td>
                <td className="primary-cell">
                  {row.customer_name || "Walk-in Customer"}
                  {row.customer_mobile && <small className="cell-note">{row.customer_mobile}</small>}
                </td>
                <td className="primary-cell purchase-items-cell sales-items-cell">
                  <span>{salesNarrationDisplay(row)}</span>
                  <small className="cell-note">{row.item_rows?.length || 0} item line{(row.item_rows?.length || 0) === 1 ? "" : "s"}</small>
                </td>
                <td className="amount-cell">{money(row.gross_total)}</td>
                <td className="amount-cell">{money(row.item_discount_total)}</td>
                <td className="amount-cell">{money(row.bill_discount_total)}</td>
                <td className="amount-cell">{money(row.net_total)}</td>
                <td className="status-cell">{row.payment_mode || "-"}</td>
                <td className="status-cell">{row.status_label}</td>
              </tr>
              {expanded && (
                <tr className="sales-history-drilldown-row">
                  <td colSpan="10">
                    <DataTable headers={["Item", "Lot", "Size", "Qty", "Unit", "Rate", "Gross", "Item Disc.", "Bill Disc.", "Net", "Cost Rate", "Profit"]}>
                      {(row.item_rows || []).map((item) => (
                        <tr className="report-row-clickable" key={item.display_key} onClick={openInvoice}>
                          <td className="primary-cell">{item.item_name}</td>
                          <td>{item.lot_name || "-"}</td>
                          <td>{item.lot_size || "-"}</td>
                          <td>{number(item.quantity)}</td>
                          <td>{item.unit || "-"}</td>
                          <td>{money(item.rate)}</td>
                          <td>{money(item.gross_total)}</td>
                          <td>{money(item.item_discount_total)}</td>
                          <td>{money(item.bill_discount_total)}</td>
                          <td>{money(item.net_total)}</td>
                          <td>{money(item.cost_rate)}</td>
                          <td className="profit-cell">{money(item.profit)}</td>
                        </tr>
                      ))}
                    </DataTable>
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        }
        return (
          <tr className={`report-row-clickable ${row.status_label === "Cancelled" ? "muted-row" : ""}`} key={row.display_key} onClick={openInvoice}>
            <td className="date-cell">{formatDisplayDate(row.sale_date)}</td>
            <td className="primary-cell">{row.invoice_no || `#${row.sale_id}`}{row.showing_matched_only && <small className="cell-note warning-note">Matched item</small>}</td>
            <td className="primary-cell">{row.customer_name || "Walk-in Customer"}</td>
            <td className="primary-cell">{row.item_name}</td>
            <td>{row.lot_name || "-"}</td>
            <td>{row.lot_size || "-"}</td>
            <td>{number(row.quantity)}</td>
            <td>{row.unit || "-"}</td>
            <td>{money(row.rate)}</td>
            <td className="amount-cell">{money(row.gross_total)}</td>
            <td className="amount-cell">{money(row.item_discount_total)}</td>
            <td className="amount-cell">{money(row.bill_discount_total)}</td>
            <td className="amount-cell">{money(row.net_total)}</td>
            <td className="status-cell">{row.payment_mode || "-"}</td>
            <td>{row.created_by_name || row.sold_by || "-"}</td>
          </tr>
        );
      },
    },
    editedBills: {
      title: "Edited Bills",
      rows: editedBills,
      summary: (rows) => [["Edited Bills", rows.length, true], ["Total Amount", money(totalOf(rows, "total_amount"))]],
      headers: ["Invoice", "Date", "Amount", "Edited By", "Edited At", "Reason"],
      render: (row) => <tr key={row.id}><td>{row.invoice_no || `#${row.id}`}</td><td>{formatDisplayDate(row.sale_date)}</td><td>{money(row.total_amount)}</td><td>{row.changed_by_name || "-"}</td><td>{row.edited_at ? new Date(row.edited_at).toLocaleString("en-IN") : "-"}</td><td>{row.edit_reason || "-"}</td></tr>,
    },
    cancelledBills: {
      title: "Cancelled Bills",
      rows: cancelledBills,
      summary: (rows) => [["Cancelled Bills", rows.length, true], ["Cancelled Amount", money(totalOf(rows, "total_amount"))]],
      headers: ["Invoice", "Date", "Amount", "Cancelled By", "Cancelled At", "Reason"],
      render: (row) => <tr key={row.id}><td>{row.invoice_no || `#${row.id}`}</td><td>{formatDisplayDate(row.sale_date)}</td><td>{money(row.total_amount)}</td><td>{row.changed_by_name || "-"}</td><td>{row.cancelled_at ? new Date(row.cancelled_at).toLocaleString("en-IN") : "-"}</td><td>{row.cancellation_reason || "-"}</td></tr>,
    },
    provisionalProfitSales: {
      title: "Provisional Profit Sales",
      rows: filterRows(data.provisionalProfitSalesReport),
      summary: (rows) => [["Sales", money(totalOf(rows, "total_amount")), true], ["Provisional Profit", money(totalOf(rows, "profit"))], ["Invoices", rows.length]],
      headers: ["Invoice", "Date", "Customer", "Payment", "Products", "Amount", "Cost", "Provisional Profit"],
      render: (row) => <tr key={row.id}><td>{row.invoice_no}</td><td>{formatDisplayDate(row.sale_date)}</td><td>{row.customer_name}</td><td>{row.payment_mode}</td><td>{row.products || "-"}</td><td>{money(row.total_amount)}</td><td>{money(row.total_cost)}</td><td className="profit-cell">{money(row.profit)}</td></tr>,
    },
    discountReport: {
      title: "Discount Report",
      rows: filterRows(data.discountReport),
      summary: (rows) => [["Discount Amount", money(totalOf(rows, "discount_amount")), true], ["Gross Amount", money(totalOf(rows, "gross_amount"))], ["Net Amount", money(totalOf(rows, "net_amount"))], ["Profit Impact", money(totalOf(rows, "profit_impact"))]],
      headers: ["Date", "Product", "Lot", "Discount Type", "Discount Value", "Qty Sold", "Gross Amount", "Discount Amount", "Net Amount", "Profit Impact"],
      render: (row, index) => <tr key={`${row.sale_date}-${row.invoice_no}-${row.product_name}-${row.lot_name}-${index}`}><td>{formatDisplayDate(row.sale_date)}</td><td className="primary-cell">{row.product_name}<small className="cell-note">{row.invoice_no || row.payment_mode}</small></td><td>{row.lot_name || "-"}{row.lot_size ? ` / ${row.lot_size}` : ""}</td><td>{row.discount_type || "Bill / Manual"}</td><td>{row.discount_type === "PERCENTAGE" ? `${Number(row.discount_value || 0)}%` : money(row.discount_value)}</td><td>{number(row.quantity_sold)}</td><td>{money(row.gross_amount)}</td><td>{money(row.discount_amount)}</td><td>{money(row.net_amount)}</td><td>{money(row.profit_impact)}</td></tr>,
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
      headers: ["Date", "Supplier", "Narration", "Gross Total", "Net Total", "Status"],
      render: (row) => (
        <tr className="report-row-clickable" key={row.display_key} onClick={() => onOpenPurchaseAmendment?.(row.source_rows?.[0] || row)}>
          <td className="primary-cell date-cell">{formatDisplayDate(row.purchase_date)}</td>
          <td className="primary-cell">{row.supplier_name}{row.firm_name && <small className="cell-note">{row.firm_name}</small>}</td>
          <td className="primary-cell purchase-items-cell">
            <span title={row.item_narration}>{purchaseNarrationDisplay(row)}</span>
            <small className="cell-note">{clubPurchaseItems ? `${row.source_rows.length} item${row.source_rows.length === 1 ? "" : "s"}` : `${number(row.quantity)} ${row.unit || ""}`}</small>
          </td>
          <td className="amount-cell">{money(row.gross_total)}</td>
          <td className="amount-cell">{money(row.net_total)}</td>
          <td className="status-cell"><span className={row.status_label === "Cancelled" ? "stock-low" : row.status_label === "Pending Bill" ? "origin-rate" : "stock-ok"}>{row.status_label}</span></td>
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
      headers: ["Date", "Particulars / Narration", "Voucher Type", "Voucher No.", "Debit", "Credit", "Balance"],
      render: (row, index) => <tr key={`${row.date}-${index}`}><td>{formatDisplayDate(row.date)}</td><td className="primary-cell purchase-items-cell"><span title={row.narration || row.remarks}>{ledgerNarration(row)}</span><small className="cell-note">{row.party_name}</small></td><td>{row.voucher_type || row.transaction_type}</td><td>{row.voucher_no || "-"}</td><td>{money(row.debit)}</td><td>{money(row.credit)}</td><td className="balance-cell">{money(Math.abs(Number(row.running_balance || 0)))} {Number(row.running_balance || 0) >= 0 ? "Dr" : "Cr"}</td></tr>,
    },
    supplierLedger: {
      title: "Supplier Ledger",
      rows: supplierLedgerRows,
      summary: (rows) => [["Debits", money(totalOf(rows, "debit")), true], ["Credits", money(totalOf(rows, "credit"))], ["Rows", rows.length]],
      headers: ["Date", "Particulars / Narration", "Voucher Type", "Voucher No.", "Debit", "Credit", "Balance"],
      render: (row, index) => <tr key={`${row.date}-${index}`}><td>{formatDisplayDate(row.date)}</td><td className="primary-cell purchase-items-cell"><span title={row.narration || row.remarks}>{ledgerNarration(row)}</span><small className="cell-note">{row.party_name}</small></td><td>{row.voucher_type || row.transaction_type}</td><td>{row.voucher_no || "-"}</td><td>{money(row.debit)}</td><td>{money(row.credit)}</td><td className="balance-cell">{money(Math.abs(Number(row.running_balance || 0)))} {Number(row.running_balance || 0) >= 0 ? "Cr" : "Dr"}</td></tr>,
    },
    accountStatement: {
      title: "Account Statement",
      rows: accountStatementRows,
      summary: (rows) => [["Debits", money(totalOf(rows, "debit")), true], ["Credits", money(totalOf(rows, "credit"))], ["Rows", rows.length]],
      headers: ["Date", "Particulars / Narration", "Voucher Type", "Voucher No.", "Debit", "Credit", "Balance"],
      render: (row, index) => <tr key={`${row.date}-${index}`}><td>{formatDisplayDate(row.date)}</td><td className="primary-cell purchase-items-cell"><span title={row.narration || row.remarks}>{ledgerNarration(row)}</span><small className="cell-note">{row.party_name} - {row.account_type}</small></td><td>{row.voucher_type || row.transaction_type}</td><td>{row.voucher_no || "-"}</td><td>{money(row.debit)}</td><td>{money(row.credit)}</td><td className="balance-cell">{money(Math.abs(Number(row.running_balance || 0)))} {Number(row.running_balance || 0) >= 0 ? "Dr" : "Cr"}</td></tr>,
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
      render: (row, index) => <tr key={`${row.transaction_date}-${row.source}-${row.payment_mode}-${index}`}><td>{formatDisplayDate(row.transaction_date)}</td><td>{row.source}</td><td><span className="tag">{row.payment_mode}</span></td><td>{row.transaction_count}</td><td className="primary-cell">{money(row.total_amount)}</td></tr>,
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
    stockInventory: {
      title: "Stock Inventory",
      rows: stockLotRows,
      summary: () => [],
      headers: [],
      render: () => null,
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
    lotWiseStock: {
      title: "Lot Wise Stock",
      rows: stockLotRows,
      summary: (rows) => [["Lot Stock Value", money(rows.reduce((sum, row) => sum + Number(row.remaining_qty || 0) * Number(row.effective_cost_per_unit || row.purchase_rate || 0), 0)), true], ["Lots", rows.length], ["Categories", new Set(rows.map((row) => row.category || "Fruit")).size]],
      headers: ["Category", "Item", "Lot / Size", "Source", "Supplier", "Received", "Balance", "Cost", "Value", "Status"],
      render: (row) => {
        const status = String(row.batch_status || "ACTIVE").toUpperCase();
        const balance = Number(row.remaining_qty ?? row.balance_qty ?? 0);
        const statusLabel = status === "CANCELLED" ? "Cancelled" : status === "INACTIVE" ? "Inactive" : balance <= 0 ? "Sold Out" : "Active";
        return <tr key={row.id}><td>{row.category || "Fruit"}</td><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{row.lot_name || row.batch_no}{row.lot_size ? ` / ${row.lot_size}` : ""}</td><td><span className="tag">{row.stock_source || "PURCHASE"}</span></td><td>{row.supplier_name || "-"}</td><td>{number(row.purchase_qty)}</td><td>{number(row.remaining_qty)}</td><td>{money(row.effective_cost_per_unit || row.purchase_rate)}</td><td>{money(Number(row.remaining_qty || 0) * Number(row.effective_cost_per_unit || row.purchase_rate || 0))}</td><td><span className={statusLabel === "Active" ? "stock-ok" : statusLabel === "Sold Out" ? "origin-rate" : "stock-low"}>{statusLabel}</span></td></tr>;
      },
    },
    profitLoss: {
      title: "Profit & Loss",
      rows: [
        { section: "Income", particular: "Sales Revenue", amount: Number(data.profitLoss?.salesRevenue || 0), emphasis: true },
        { section: "Income", particular: "Other Income", amount: 0 },
        { section: "Cost of Goods Sold", particular: "Purchase Cost", amount: -Number(data.profitLoss?.purchaseCost || 0) },
        { section: "Cost of Goods Sold", particular: "Mandi Tax", amount: -Number(data.profitLoss?.mandiTax || 0) },
        { section: "Cost of Goods Sold", particular: "Freight", amount: -Number(data.profitLoss?.freightCharges || 0) },
        { section: "Cost of Goods Sold", particular: "Labour", amount: -Number(data.profitLoss?.labourCharges || 0) },
        { section: "Cost of Goods Sold", particular: "Other Purchase Charges", amount: -Number(data.profitLoss?.otherPurchaseCharges || 0) },
        { section: "Cost of Goods Sold", particular: "Less Supplier Rebate Received", amount: Number(data.profitLoss?.supplierRebateReceived || 0) },
        { section: "Result", particular: "Gross Profit", amount: Number(data.profitLoss?.grossProfit || 0), emphasis: true },
        ...(Array.isArray(data.profitLoss?.expenseCategories) ? data.profitLoss.expenseCategories : []).map((row) => ({ section: "Expenses", particular: row.category, amount: -Number(row.amount || 0) })),
        { section: "Result", particular: Number(data.profitLoss?.netProfit || 0) < 0 ? "Net Loss" : "Net Profit", amount: Number(data.profitLoss?.netProfit || 0), emphasis: true },
      ].filter(matchesSearch),
      summary: () => [
        ["Sales Revenue", money(data.profitLoss?.salesRevenue), true],
        ["Gross Profit", money(data.profitLoss?.grossProfit)],
        ["Total Expenses", money(data.profitLoss?.expenses)],
        [Number(data.profitLoss?.netProfit || 0) < 0 ? "Net Loss" : "Net Profit", money(Math.abs(Number(data.profitLoss?.netProfit || 0)))],
      ],
      headers: ["Section", "Particulars", "Amount"],
      render: (row, index) => <tr className={row.emphasis ? "date-total-row" : ""} key={`${row.section}-${row.particular}-${index}`}><td>{row.section}</td><td className="primary-cell">{row.particular}</td><td className={row.amount < 0 ? "stock-low" : "profit-cell"}>{money(Math.abs(row.amount))}{row.amount < 0 ? " Dr" : ""}</td></tr>,
    },
    balanceSheet: {
      title: "Balance Sheet",
      rows: [
        { liability: "Capital / Owner Equity", liabilityKey: "owner_equity", liabilityAmount: Number(data.balanceSheet?.ownerCapital || 0), asset: "Cash in Hand", assetKey: "cash_in_hand", assetAmount: Number(data.balanceSheet?.cash || 0) },
        { liability: Number(data.balanceSheet?.netProfit || 0) < 0 ? "Net Loss" : "Net Profit", liabilityKey: "net_profit", liabilityAmount: Number(data.balanceSheet?.netProfit || 0), asset: "Cash at Bank / Bank Balance", assetKey: "cash_at_bank", assetAmount: Number(data.balanceSheet?.bank || 0) },
        { liability: "Supplier Payables / Trade Creditors", liabilityKey: "supplier_payables", liabilityAmount: Number(data.balanceSheet?.supplierPayable || 0), asset: "Inventory / Closing Stock", assetKey: "inventory", assetAmount: Number(data.balanceSheet?.inventory || 0) },
        { liability: "Loans / Credit Balances", liabilityKey: "loans", liabilityAmount: 0, asset: "Customer Receivables / Sundry Debtors", assetKey: "customer_receivables", assetAmount: Number(data.balanceSheet?.customerReceivable || 0) },
        { liability: "Other Liabilities", liabilityKey: "other_liabilities", liabilityAmount: 0, asset: "Other Assets", assetKey: "other_assets", assetAmount: 0 },
        { liability: "Total Liabilities", liabilityAmount: Number(data.balanceSheet?.totalLiabilities || 0), asset: "Total Assets", assetAmount: Number(data.balanceSheet?.totalAssets || 0), total: true },
      ].filter(matchesSearch),
      summary: () => [["Total Assets", money(data.balanceSheet?.totalAssets), true], ["Total Liabilities", money(data.balanceSheet?.totalLiabilities)], ["Inventory", money(data.balanceSheet?.inventory)]],
      headers: ["Liabilities", "Amount", "Assets", "Amount"],
      render: (row, index) => <tr className={row.total ? "date-total-row" : ""} key={`${row.liability}-${index}`}>
        <td className="primary-cell">{row.total ? row.liability : <button className="table-link-button" onClick={() => openBalanceSheetDetail(row.liabilityKey)}>{row.liability}</button>}</td>
        <td>{money(row.liabilityAmount)}</td>
        <td className="primary-cell">{row.total ? row.asset : <button className="table-link-button" onClick={() => openBalanceSheetDetail(row.assetKey)}>{row.asset}</button>}</td>
        <td>{money(row.assetAmount)}</td>
      </tr>,
    },
    cashBook: {
      title: "Cash Book",
      rows: cashBookRows,
      summary: () => [
        ["Opening Cash", money(cashBookOpeningCash), true],
        ["Opening Bank", money(cashBookOpeningBank), true],
        ["Cash Receipts", money(cashBookReceiptsCash)],
        ["Bank Receipts", money(cashBookReceiptsBank)],
        ["Cash Payments", money(cashBookPaymentsCash)],
        ["Bank Payments", money(cashBookPaymentsBank)],
        ["Closing Cash", money(cashBookClosingCash), true],
        ["Closing Bank", money(cashBookClosingBank), true],
        ["Total Closing", money(cashBookData.total_closing), true],
      ],
      headers: ["Date", "Particulars / Account", "Narration", "Receipt Cash", "Receipt Bank/UPI/Card", "Payment Cash", "Payment Bank/UPI/Card", "Cash Balance", "Bank Balance", "Total Balance", "Reference / Bill No"],
      render: (row, index) => <tr className="report-row-clickable" onClick={() => setCashBookDetail(row)} key={`${row.date}-${row.reference_no}-${index}`}><td className="date-cell">{formatDisplayDate(row.date)}</td><td className="primary-cell">{row.account_name || row.party_name}</td><td className="purchase-items-cell"><span title={row.narration}>{row.narration || "-"}</span></td><td className="amount-cell">{money(row.receipt_cash)}</td><td className="amount-cell">{money(row.receipt_bank)}</td><td className="amount-cell">{money(row.payment_cash)}</td><td className="amount-cell">{money(row.payment_bank)}</td><td className="amount-cell">{money(row.cash_balance)}</td><td className="amount-cell">{money(row.bank_balance)}</td><td className="profit-cell amount-cell">{money(row.total_balance)}</td><td>{row.reference_no || "-"}</td></tr>,
    },
    expenseReport: {
      title: "Expense Report",
      rows: filterRows(data.expenseReport),
      summary: (rows) => [["Total Expenses", money(totalOf(rows.filter((row) => row.status !== "CANCELLED"), "amount")), true], ["Cash", money(totalOf(rows.filter((row) => row.payment_mode === "CASH" && row.status !== "CANCELLED"), "amount"))], ["UPI", money(totalOf(rows.filter((row) => row.payment_mode === "UPI" && row.status !== "CANCELLED"), "amount"))], ["Cancelled", money(totalOf(rows.filter((row) => row.status === "CANCELLED"), "amount"))]],
      headers: ["Date", "Category", "Paid To", "Payment Mode", "Amount", "Reference", "Remarks", "Status"],
      render: (row) => <tr className={row.status === "CANCELLED" ? "muted-row" : ""} key={row.id}><td>{formatDisplayDate(row.expense_date)}</td><td className="primary-cell">{row.category}</td><td>{row.paid_to || row.vendor_name || "-"}</td><td>{row.payment_mode}</td><td>{money(row.amount)}</td><td>{row.reference_number || "-"}</td><td>{row.remarks || row.cancellation_reason || "-"}</td><td><span className={row.status === "CANCELLED" ? "stock-low" : "stock-ok"}>{row.status || "ACTIVE"}</span></td></tr>,
    },
  };
  const categories = [
    { id: "sales", title: "Sales Reports", icon: "receipt", description: "Unified sales history with item narration, discounts, payments and bill status.", reports: ["salesHistory", "discountReport"] },
    { id: "purchase", title: "Purchase Reports", icon: "cart", description: "Unified purchase history with item narration, bill status, payments and amendment actions.", reports: ["purchaseHistory"] },
    { id: "accounts", title: "Accounts & Ledger", icon: "users", description: "Customer ledger, supplier ledger, statements, payments and balances.", reports: ["customerLedger", "supplierLedger", "accountStatement", "paymentReport", "paymentModeSummary", "receivableReport", "payableReport"] },
    { id: "returns", title: "Sale Returns", icon: "history", description: "Return history, value and reason analysis.", reports: ["returnHistory", "returnValue", "returnReason"] },
    { id: "waste", title: "Waste Management", icon: "alert", description: "Daily, monthly, product-wise and cost-focused waste analysis.", reports: ["dailyWaste", "monthlyWaste", "productWiseWaste", "mostWastedProducts", "wasteCost"] },
    { id: "inventory", title: "Inventory Reports", icon: "layers", description: "Single stock inventory workspace for stock, lots, valuation, adjustments and audit.", reports: ["stockInventory"] },
    { id: "financial", title: "Financial Reports", icon: "wallet", description: "Profit and loss, balance sheet, cash book and expense reports.", reports: ["profitLoss", "balanceSheet", "cashBook", "expenseReport"] },
  ];
  const currentCategory = categories.find((category) => category.id === selectedCategory);
  const currentReport = reports[selectedReport];
  const profitLossLine = (label, value, options = {}) => {
    const numericValue = Number(value || 0);
    const amountClass = numericValue < 0 ? "pl-negative" : options.positive ? "pl-positive" : "";
    const formattedAmount = numericValue < 0 ? `(${money(Math.abs(numericValue))})` : money(numericValue);
    return (
      <div className={`pl-line ${options.indent ? "pl-line-indent" : ""} ${options.total ? "pl-line-total" : ""} ${options.highlight ? "pl-line-highlight" : ""}`} key={label}>
        <span>{label}</span>
        <strong className={amountClass}>{formattedAmount}</strong>
      </div>
    );
  };
  const renderProfitLossStatement = () => {
    const pl = data.profitLoss || {};
    const amount = (field) => Number(pl[field] || 0);
    const salesRevenue = amount("salesRevenue");
    const otherIncome = amount("otherIncome");
    const totalIncome = salesRevenue + otherIncome;
    const purchaseCost = amount("purchaseCost");
    const mandiTax = amount("mandiTax");
    const freightCharges = amount("freightCharges");
    const labourCharges = amount("labourCharges");
    const otherPurchaseCharges = amount("otherPurchaseCharges");
    const supplierRebateReceived = amount("supplierRebateReceived");
    const cogs = Number(pl.costOfGoodsSold ?? (purchaseCost + mandiTax + freightCharges + labourCharges + otherPurchaseCharges - supplierRebateReceived));
    const grossProfit = Number(pl.grossProfit ?? (totalIncome - cogs));
    const totalExpenses = amount("expenses");
    const netProfit = Number(pl.netProfit ?? (grossProfit - totalExpenses));
    const expenseCategories = Array.isArray(pl.expenseCategories) ? pl.expenseCategories : [];
    const knownExpenseLabels = [
      ["Rent", ["rent"]],
      ["Staff Salary", ["staff salary", "salary", "wages"]],
      ["Electricity", ["electricity", "power"]],
      ["Transport", ["transport", "transportation"]],
      ["Loading / Hamali", ["loading", "hamali", "labour"]],
      ["Packing", ["packing", "packaging"]],
      ["Repair", ["repair", "maintenance"]],
      ["Food / Tea / Misc", ["food", "tea", "misc"]],
    ];
    const matchedExpenseIndexes = new Set();
    const expenseRows = knownExpenseLabels.map(([label, needles]) => {
      const total = expenseCategories.reduce((sum, row, index) => {
        const category = String(row.category || "").toLowerCase();
        if (needles.some((needle) => category.includes(needle))) {
          matchedExpenseIndexes.add(index);
          return sum + Number(row.amount || 0);
        }
        return sum;
      }, 0);
      return { category: label, amount: total };
    }).filter((row) => row.amount > 0);
    const otherExpenses = expenseCategories.reduce((sum, row, index) => matchedExpenseIndexes.has(index) ? sum : sum + Number(row.amount || 0), 0);
    if (otherExpenses > 0) {
      expenseRows.push({ category: "Other Expenses", amount: otherExpenses });
    }
    const hasTransactions = [salesRevenue, otherIncome, purchaseCost, mandiTax, freightCharges, labourCharges, otherPurchaseCharges, supplierRebateReceived, totalExpenses].some((value) => Math.abs(Number(value || 0)) > 0);
    const periodFrom = data.dateFrom || customRange.date_from || "-";
    const periodTo = data.dateTo || customRange.date_to || "-";
    return (
      <div className="profit-loss-statement">
        <div className="pl-title-block">
          <span>Financial Report</span>
          <h2>PROFIT &amp; LOSS STATEMENT</h2>
          <p>For Period: {periodFrom} to {periodTo}</p>
        </div>
        {!hasTransactions && <div className="pl-empty-note">No transactions found for selected period.</div>}
        <section className="pl-section">
          <h3>INCOME</h3>
          {profitLossLine("Sales Revenue", salesRevenue, { indent: true })}
          {profitLossLine("Other Income", otherIncome, { indent: true })}
          {profitLossLine("TOTAL INCOME", totalIncome, { total: true })}
        </section>
        <section className="pl-section">
          <h3>LESS: COST OF GOODS SOLD</h3>
          {profitLossLine("Purchase Cost", purchaseCost, { indent: true })}
          {profitLossLine("Mandi Tax", mandiTax, { indent: true })}
          {profitLossLine("Freight", freightCharges, { indent: true })}
          {profitLossLine("Labour", labourCharges, { indent: true })}
          {profitLossLine("Other Purchase Charges", otherPurchaseCharges, { indent: true })}
          {profitLossLine("Less Supplier Rebate Received", -supplierRebateReceived, { indent: true })}
          {profitLossLine("TOTAL COGS", cogs, { total: true })}
        </section>
        <section className="pl-section pl-result-section">
          {profitLossLine("GROSS PROFIT", grossProfit, { highlight: true, positive: grossProfit >= 0 })}
        </section>
        <section className="pl-section">
          <h3>LESS: EXPENSES</h3>
          {expenseRows.length > 0 ? expenseRows.map((row) => profitLossLine(row.category, row.amount, { indent: true })) : <div className="pl-empty-note">No expenses recorded for this period.</div>}
          {profitLossLine("TOTAL EXPENSES", totalExpenses, { total: true })}
        </section>
        <section className={`pl-section pl-net-section ${netProfit >= 0 ? "pl-net-profit" : "pl-net-loss"}`}>
          {profitLossLine(netProfit >= 0 ? "NET PROFIT" : "NET LOSS", netProfit, { highlight: true, positive: netProfit >= 0 })}
        </section>
      </div>
    );
  };
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
      {["customerLedger", "supplierLedger", "accountStatement"].includes(selectedReport) && (
        <>
          <Field label="Account Type">
            <select value={accountReportFilters.accountType} onChange={(event) => setAccountReportFilters({ ...accountReportFilters, accountType: event.target.value })}>
              <option value="">All account types</option>
              <option value="CUSTOMER">Customer</option>
              <option value="SUPPLIER">Supplier</option>
              <option value="CASH">Cash</option>
              <option value="BANK">Bank</option>
              <option value="EXPENSE">Expense</option>
              <option value="INCOME">Income</option>
              <option value="INVENTORY">Inventory</option>
              <option value="CAPITAL">Capital</option>
              <option value="LIABILITY">Liability</option>
              <option value="ASSET">Asset</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
          <Field label="Account">
            <select value={accountReportFilters.accountName} onChange={(event) => setAccountReportFilters({ ...accountReportFilters, accountName: event.target.value })}>
              <option value="">All accounts</option>
              {accountNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Field>
          <Field label="Voucher Type">
            <select value={accountReportFilters.voucherType} onChange={(event) => setAccountReportFilters({ ...accountReportFilters, voucherType: event.target.value })}>
              <option value="">All vouchers</option>
              {voucherTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </Field>
          <Field label="Payment Mode">
            <select value={accountReportFilters.paymentMode} onChange={(event) => setAccountReportFilters({ ...accountReportFilters, paymentMode: event.target.value })}>
              <option value="">All modes</option>
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="CARD">Card</option>
              <option value="BANK_TRANSFER">Bank Transfer</option>
              <option value="CREDIT">Credit</option>
              <option value="OTHER">Other</option>
              <option value="CHEQUE">Cheque</option>
            </select>
          </Field>
          <label className="check-field report-check-field">
            <input checked={clubLedgerEntries} type="checkbox" onChange={(event) => setClubLedgerEntries(event.target.checked)} />
            <span>Club Entries</span>
          </label>
          <button className="secondary-button" onClick={clearLedgerFilters}>Clear Ledger Filters</button>
        </>
      )}
      {selectedReport === "cashBook" && (
        <>
          <Field label="Book Account">
            <select value={cashBookFilters.bookAccount} onChange={(event) => {
              const next = { ...cashBookFilters, bookAccount: event.target.value, paymentMode: "" };
              setCashBookFilters(next);
              reloadCashBook(next);
            }}>
              <option value="ALL">All Cash + Bank</option>
              <option value="CASH">Cash</option>
              <option value="BANK">All Bank / UPI / Card</option>
              <option value="UPI">UPI</option>
              <option value="CARD">Card</option>
              <option value="BANK_TRANSFER">Bank Transfer</option>
            </select>
          </Field>
          <Field label="Payment Mode">
            <select value={cashBookFilters.paymentMode} onChange={(event) => {
              const next = { ...cashBookFilters, paymentMode: event.target.value };
              setCashBookFilters(next);
              reloadCashBook(next);
            }} disabled={["UPI", "CARD", "BANK_TRANSFER"].includes(cashBookFilters.bookAccount)}>
              <option value="">All modes</option>
              {cashBookFilters.bookAccount === "CASH" ? <option value="CASH">Cash</option> : cashBookFilters.bookAccount === "ALL" ? (
                <>
                  <option value="CASH">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="CARD">Card</option>
                  <option value="BANK_TRANSFER">Bank Transfer</option>
                </>
              ) : (
                <>
                  <option value="UPI">UPI</option>
                  <option value="CARD">Card</option>
                  <option value="BANK_TRANSFER">Bank Transfer</option>
                </>
              )}
            </select>
          </Field>
          <Field label="Account / Party">
            <select value={cashBookFilters.accountFilter} onChange={(event) => {
              const next = { ...cashBookFilters, accountFilter: event.target.value };
              setCashBookFilters(next);
              reloadCashBook(next);
            }}>
              <option value="">All accounts</option>
              <option value="CUSTOMER">Customer</option>
              <option value="SUPPLIER">Supplier</option>
              <option value="EXPENSE">Expense</option>
              <option value="EMPLOYEE">Employee</option>
              <option value="OWNER">Owner</option>
            </select>
          </Field>
          <Field label="View Mode">
            <select value={cashBookViewMode} onChange={(event) => setCashBookViewMode(event.target.value)}>
              <option value="SUMMARY">Account Summary</option>
              <option value="ENTRY">Entry-wise</option>
            </select>
          </Field>
          <Field label="Group By">
            <select value={cashBookGroupBy} onChange={(event) => setCashBookGroupBy(event.target.value)}>
              <option value="PERIOD">Entire Selected Period</option>
              <option value="DATE">Date-wise</option>
              <option value="MONTH">Month-wise</option>
            </select>
          </Field>
          <label className="check-field report-check-field">
            <input checked={showCashBookRemarks} type="checkbox" onChange={(event) => setShowCashBookRemarks(event.target.checked)} />
            <span>Show Entry Wise Remarks</span>
          </label>
          <button className="secondary-button" onClick={() => {
            const next = { paymentMode: "", accountFilter: "", bookAccount: "ALL" };
            setCashBookFilters(next);
            setCashBookViewMode("SUMMARY");
            setCashBookGroupBy("PERIOD");
            reloadCashBook(next);
          }}>Clear Cash Book Filters</button>
        </>
      )}
      {selectedReport === "lotWiseStock" && (
        <Field label="Lot Visibility">
          <select value={inventoryLotReportFilter} onChange={(event) => setInventoryLotReportFilter(event.target.value)}>
            <option value="ACTIVE">Active Stock Only</option>
            <option value="SOLD_OUT">Include Sold Out Lots</option>
            <option value="ALL">Include Cancelled/Inactive Lots</option>
          </select>
        </Field>
      )}
      {selectedReport === "salesHistory" && (
        <>
          <Field label="View Mode">
            <select value={salesFilters.viewMode} onChange={(event) => setSalesFilters({ ...salesFilters, viewMode: event.target.value })}>
              <option value="INVOICE">Invoice-wise</option>
              <option value="ITEM">Item-wise</option>
              <option value="LOT">Lot-wise</option>
            </select>
          </Field>
          <Field label="Exact Date">
            <input type="date" value={salesFilters.date} onChange={(event) => setSalesFilters({ ...salesFilters, date: event.target.value })} />
          </Field>
          <Field label="Customer">
            <select value={salesFilters.customer} onChange={(event) => setSalesFilters({ ...salesFilters, customer: event.target.value })}>
              <option value="">All customers</option>
              {[...salesFilterOptions.customers.entries()].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </Field>
          <Field label="Product">
            <select value={salesFilters.product} onChange={(event) => setSalesFilters({ ...salesFilters, product: event.target.value })}>
              <option value="">All products</option>
              {[...salesFilterOptions.products.entries()].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </Field>
          <Field label="Lot">
            <select value={salesFilters.lot} onChange={(event) => setSalesFilters({ ...salesFilters, lot: event.target.value })}>
              <option value="">All lots</option>
              {[...salesFilterOptions.lots.entries()].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </Field>
          <Field label="Payment Mode">
            <select value={salesFilters.paymentMode} onChange={(event) => setSalesFilters({ ...salesFilters, paymentMode: event.target.value })}>
              <option value="">All modes</option>
              {[...salesFilterOptions.paymentModes].sort().map((mode) => <option key={mode} value={mode}>{mode}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={salesFilters.status} onChange={(event) => setSalesFilters({ ...salesFilters, status: event.target.value })}>
              <option value="ACTIVE">Active Bills</option>
              <option value="ALL">All Bills</option>
              <option value="EDITED">Edited</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </Field>
          <label className="check-field report-check-field">
            <input checked={search.trim().length > 0} readOnly type="checkbox" />
            <span>{search.trim() ? "Showing matched items only where applicable" : "Item-level search ready"}</span>
          </label>
          <button className="secondary-button" onClick={() => setSalesFilters({ date: "", status: "ACTIVE", viewMode: "INVOICE", customer: "", product: "", lot: "", paymentMode: "", user: "" })}>Clear Sales Filters</button>
        </>
      )}
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
  const balanceDetailColumnValue = (row, column) => {
    const keyMap = {
      Date: "transaction_date",
      "Voucher Type": "voucher_type",
      "Voucher No": "voucher_no",
      Party: "party_name",
      "Payment Mode": "payment_mode",
      Debit: "debit",
      Credit: "credit",
      Balance: "balance",
      Narration: "narration",
      Product: "product_name",
      Lot: "lot",
      Size: "lot_size",
      Qty: "quantity",
      Cost: "cost_rate",
      Value: "value",
      Supplier: "supplier_name",
      Opening: "opening_balance",
      Purchases: "purchases",
      Payments: "payments",
      Rebates: "rebates",
      Customer: "customer_name",
      "Credit Sales": "credit_sales",
      Receipts: "receipts",
      Returns: "returns",
      Particular: "particular",
      Amount: "amount",
    };
    const key = keyMap[column] || column.toLowerCase().replace(/\s+/g, "_");
    const value = row?.[key];
    if (["Debit", "Credit", "Balance", "Cost", "Value", "Opening", "Purchases", "Payments", "Rebates", "Credit Sales", "Receipts", "Returns", "Amount"].includes(column)) {
      return money(value);
    }
    if (column === "Date") return formatDisplayDate(value);
    if (column === "Qty") return number(value);
    return value || "-";
  };
  const renderBalanceSheetDetailModal = () => {
    if (!balanceSheetDetail && !balanceSheetDetailLoading && !balanceSheetDetailError) return null;
    const columns = Array.isArray(balanceSheetDetail?.columns) ? balanceSheetDetail.columns : ["Particular", "Amount"];
    const rows = Array.isArray(balanceSheetDetail?.rows) ? balanceSheetDetail.rows : [];
    return (
      <div className="modal-backdrop">
        <section className="invoice-modal change-history-modal balance-detail-modal">
          <div className="invoice-modal-header">
            <div>
              <span className="eyebrow">Balance Sheet Drilldown</span>
              <h2>{balanceSheetDetail?.title || "Loading Detail"}</h2>
              <p>{balanceSheetDetail ? `${formatDisplayDate(balanceSheetDetail.dateFrom)} to ${formatDisplayDate(balanceSheetDetail.dateTo)} | Closing as at ${formatDisplayDate(balanceSheetDetail.asAtDate || balanceSheetDetail.dateTo)}` : "Fetching source transactions..."}</p>
            </div>
            <button className="secondary-button" onClick={() => { setBalanceSheetDetail(null); setBalanceSheetDetailError(""); }}>Close</button>
          </div>
          {balanceSheetDetailLoading && <div className="cart-empty">Loading balance sheet detail...</div>}
          {balanceSheetDetailError && <div className="error-banner">{balanceSheetDetailError}</div>}
          {balanceSheetDetail && (
            <>
              <div className="purchase-summary-grid supplier-payment-preview">
                {[
                  ["Opening Balance", balanceSheetDetail.openingBalance],
                  ["Debit During Range", balanceSheetDetail.debitDuringRange],
                  ["Credit During Range", balanceSheetDetail.creditDuringRange],
                  ["Closing Balance", balanceSheetDetail.closingBalance ?? balanceSheetDetail.amount],
                ].map(([label, value], index) => <SummaryMetric featured={index === 3} key={label} label={label} value={money(value)} />)}
              </div>
              {Array.isArray(balanceSheetDetail.breakdown) && balanceSheetDetail.breakdown.length > 0 && (
                <div className="balance-detail-breakdown">
                  {balanceSheetDetail.breakdown.map((item) => <span key={item.label}>{item.label}: <strong>{money(item.value)}</strong></span>)}
                </div>
              )}
              <DataTable headers={columns}>
                {rows.map((row, index) => (
                  <tr key={`${balanceSheetDetail.lineKey}-${index}`}>
                    {columns.map((column) => <td key={column}>{balanceDetailColumnValue(row, column)}</td>)}
                  </tr>
                ))}
              </DataTable>
              {rows.length === 0 && <div className="cart-empty">No source transactions found for this line.</div>}
            </>
          )}
        </section>
      </div>
    );
  };
  const renderCashBookDetailModal = () => {
    if (!cashBookDetail) return null;
    const sourceRows = cashBookDetail.source_rows || [cashBookDetail];
    const totalReceiptCash = sourceRows.reduce((sum, row) => sum + Number(row.receipt_cash || 0), 0);
    const totalReceiptBank = sourceRows.reduce((sum, row) => sum + Number(row.receipt_bank || 0), 0);
    const totalPaymentCash = sourceRows.reduce((sum, row) => sum + Number(row.payment_cash || 0), 0);
    const totalPaymentBank = sourceRows.reduce((sum, row) => sum + Number(row.payment_bank || 0), 0);
    return (
      <div className="modal-backdrop">
        <section className="invoice-modal change-history-modal">
          <div className="invoice-modal-header">
            <div>
              <span className="eyebrow">Cash Book Detail</span>
              <h2>{cashBookDetail.account_name || cashBookDetail.source_type || "Cash / Bank Movement"}</h2>
              <p>{cashBookDetail.group_label || formatDisplayDate(cashBookDetail.date)} | {sourceRows.length} entr{sourceRows.length === 1 ? "y" : "ies"}</p>
            </div>
            <button className="secondary-button" onClick={() => setCashBookDetail(null)}>Close</button>
          </div>
          <div className="purchase-summary-grid supplier-payment-preview">
            <SummaryMetric label="Receipt Cash" value={money(totalReceiptCash)} />
            <SummaryMetric label="Receipt Bank" value={money(totalReceiptBank)} />
            <SummaryMetric label="Payment Cash" value={money(totalPaymentCash)} />
            <SummaryMetric featured label="Payment Bank" value={money(totalPaymentBank)} />
          </div>
          <DataTable headers={["Date & Time", "Voucher / Invoice", "Type", "Party", "Mode", "Cash", "Bank", "Remarks", "Created By", "Source"]}>
            {sourceRows.map((row, index) => (
              <tr key={`${row.source_type}-${row.source_id}-${index}`}>
                <td>{formatDisplayDate(row.date)}<small className="cell-note">{row.entry_time ? new Date(row.entry_time).toLocaleTimeString("en-IN") : ""}</small></td>
                <td className="primary-cell">{row.reference_no || "-"}</td>
                <td>{row.source_type || "-"}</td>
                <td>{row.party_name || row.account_name || "-"}</td>
                <td>{row.payment_mode || "-"}</td>
                <td className="amount-cell">{money(Number(row.receipt_cash || 0) || Number(row.payment_cash || 0))}</td>
                <td className="amount-cell">{money(Number(row.receipt_bank || 0) || Number(row.payment_bank || 0))}</td>
                <td className="purchase-items-cell">{row.narration || "-"}</td>
                <td>{row.created_by_name || "-"}</td>
                <td>{row.source_type || "-"}</td>
              </tr>
            ))}
          </DataTable>
        </section>
      </div>
    );
  };
  const renderCashBookStatement = () => {
    const cashBookPeriodLabel = (row) => {
      const key = toDateKey(row.date);
      if (cashBookGroupBy === "DATE") return key;
      if (cashBookGroupBy === "MONTH") return key.slice(0, 7);
      return "Selected Period";
    };
    const cashBookGroupLabel = (row) => {
      const key = cashBookPeriodLabel(row);
      if (cashBookGroupBy === "DATE") return formatDisplayDate(key);
      if (cashBookGroupBy === "MONTH") {
        const [year, month] = key.split("-");
        return `${month}/${year}`;
      }
      return `${formatDisplayDate(cashBookData.dateFrom || data.dateFrom)} to ${formatDisplayDate(cashBookData.dateTo || data.dateTo)}`;
    };
    const groupCashBookRows = (rows) => {
      if (cashBookViewMode === "ENTRY") {
        return rows.map((row) => ({ ...row, source_rows: [row], group_label: cashBookGroupLabel(row), ledger_folio: row.reference_no || "-" }));
      }
      return [...rows.reduce((groups, row) => {
        const side = Number(row.receipt_cash || 0) || Number(row.receipt_bank || 0) ? "RECEIPT" : "PAYMENT";
        const periodKey = cashBookPeriodLabel(row);
        const key = [periodKey, side, row.account_type || "", row.account_name || row.party_name || "", row.mode_group || ""].join("|");
        const current = groups.get(key) || {
          date: cashBookGroupBy === "PERIOD" ? (cashBookData.dateFrom || data.dateFrom) : periodKey,
          account_name: row.account_name || row.party_name || "-",
          account_type: row.account_type,
          party_name: row.party_name,
          mode_group: row.mode_group,
          group_label: cashBookGroupLabel(row),
          payment_mode: "Multiple",
          reference_no: "—",
          ledger_folio: "—",
          source_type: side === "RECEIPT" ? "Account Summary Receipt" : "Account Summary Payment",
          receipt_cash: 0,
          receipt_bank: 0,
          payment_cash: 0,
          payment_bank: 0,
          source_rows: [],
        };
        current.receipt_cash += Number(row.receipt_cash || 0);
        current.receipt_bank += Number(row.receipt_bank || 0);
        current.payment_cash += Number(row.payment_cash || 0);
        current.payment_bank += Number(row.payment_bank || 0);
        current.source_rows.push(row);
        groups.set(key, current);
        return groups;
      }, new Map()).values()];
    };
    const displayRows = groupCashBookRows(cashBookRows);
    const receiptRows = displayRows.filter((row) => Number(row.receipt_cash || 0) + Number(row.receipt_bank || 0) > 0);
    const paymentRows = displayRows.filter((row) => Number(row.payment_cash || 0) + Number(row.payment_bank || 0) > 0);
    const receiptSideCashTotal = cashBookOpeningCash + cashBookReceiptsCash;
    const receiptSideBankTotal = cashBookOpeningBank + cashBookReceiptsBank;
    const paymentSideCashTotal = cashBookPaymentsCash + cashBookClosingCash;
    const paymentSideBankTotal = cashBookPaymentsBank + cashBookClosingBank;
    const renderBookRow = (row, side) => (
      <tr className="report-row-clickable" key={`${side}-${row.group_label}-${row.account_name}-${row.mode_group || ""}-${row.source_id || row.reference_no}`} onClick={() => setCashBookDetail(row)}>
        <td className="date-cell">{cashBookViewMode === "ENTRY" ? formatDisplayDate(row.date) : row.group_label}</td>
        <td className="primary-cell">
          {side === "RECEIPT" ? "To " : "By "}{row.account_name || row.party_name || "-"} A/c
          {cashBookViewMode === "ENTRY" && showCashBookRemarks && <small className="cell-note">{row.narration || "-"}</small>}
          {cashBookViewMode === "SUMMARY" && <small className="cell-note">{row.source_rows.length} entr{row.source_rows.length === 1 ? "y" : "ies"}</small>}
        </td>
        <td className="status-cell">{row.ledger_folio || "—"}</td>
        <td className="balance-cell amount-cell">{money(side === "RECEIPT" ? row.receipt_cash : row.payment_cash)}</td>
        <td className="balance-cell amount-cell">{money(side === "RECEIPT" ? row.receipt_bank : row.payment_bank)}</td>
      </tr>
    );
    return (
      <section className="cash-book-statement">
        <div className="pl-title-block cash-book-title">
          <span>Traditional Double-Sided Format</span>
          <h2>CASH BOOK</h2>
          <p>{cashBookAccountLabel} | {cashBookViewMode === "SUMMARY" ? "Account Summary" : "Entry-wise"} | {cashBookGroupBy === "PERIOD" ? "Entire Selected Period" : cashBookGroupBy === "DATE" ? "Date-wise" : "Month-wise"} | {formatDisplayDate(cashBookData.dateFrom || data.dateFrom)} to {formatDisplayDate(cashBookData.dateTo || data.dateTo)}</p>
        </div>
        {(cashBookClosingCash < 0 || cashBookClosingBank < 0) && (
          <div className="cash-book-warning">
            Cash or bank balance is negative. Please verify opening balance and entries.
          </div>
        )}
        <div className="cash-book-sides">
          <section className="cash-book-panel">
            <h3><span>Dr.</span> Receipts / Money Coming In</h3>
            <DataTable headers={["Date", "Particulars", "L.F.", "Cash (₹)", "Bank (₹)"]}>
              <tr className="date-total-row">
                <td>{formatDisplayDate(cashBookData.dateFrom || data.dateFrom)}</td>
                <td className="primary-cell">To Balance b/d</td>
                <td className="status-cell">—</td>
                <td className="balance-cell amount-cell">{money(cashBookOpeningCash)}</td>
                <td className="balance-cell amount-cell">{money(cashBookOpeningBank)}</td>
              </tr>
              {receiptRows.map((row) => renderBookRow(row, "RECEIPT"))}
              {receiptRows.length === 0 && <tr><td colSpan="5" className="empty-cell">No receipts found for this range.</td></tr>}
              <tr className="date-total-row">
                <td colSpan="3">Total Dr. Side</td>
                <td className="balance-cell amount-cell">{money(receiptSideCashTotal)}</td>
                <td className="balance-cell amount-cell">{money(receiptSideBankTotal)}</td>
              </tr>
            </DataTable>
          </section>
          <section className="cash-book-panel">
            <h3><span>Cr.</span> Payments / Money Going Out</h3>
            <DataTable headers={["Date", "Particulars", "L.F.", "Cash (₹)", "Bank (₹)"]}>
              {paymentRows.map((row) => renderBookRow(row, "PAYMENT"))}
              {paymentRows.length === 0 && <tr><td colSpan="5" className="empty-cell">No payments found for this range.</td></tr>}
              <tr className="date-total-row">
                <td>{formatDisplayDate(cashBookData.dateTo || data.dateTo)}</td>
                <td className="primary-cell">By Balance c/d</td>
                <td className="status-cell">—</td>
                <td className="balance-cell amount-cell">{money(cashBookClosingCash)}</td>
                <td className="balance-cell amount-cell">{money(cashBookClosingBank)}</td>
              </tr>
              <tr className="date-total-row">
                <td colSpan="3">Total Cr. Side</td>
                <td className="balance-cell amount-cell">{money(paymentSideCashTotal)}</td>
                <td className="balance-cell amount-cell">{money(paymentSideBankTotal)}</td>
              </tr>
            </DataTable>
          </section>
        </div>
        <div className="cash-book-closing">
          <span>Total Cash Receipts: <strong>{money(cashBookReceiptsCash)}</strong></span>
          <span>Total Bank Receipts: <strong>{money(cashBookReceiptsBank)}</strong></span>
          <span>Total Cash Payments: <strong>{money(cashBookPaymentsCash)}</strong></span>
          <span>Total Bank Payments: <strong>{money(cashBookPaymentsBank)}</strong></span>
          <span>Closing Cash: <strong>{money(cashBookClosingCash)}</strong></span>
          <span>Closing Bank: <strong>{money(cashBookClosingBank)}</strong></span>
          <span>Total Cash + Bank: <strong>{money(cashBookData.total_closing)}</strong></span>
        </div>
      </section>
    );
  };
  if (currentReport) {
    const rows = currentReport.rows || [];
    const handleReportPrintOption = () => {
      if (selectedReport === "purchaseHistory") {
        const includeNarration = window.confirm("Print narration/details?");
        purchasePrintNarrationRef.current = includeNarration;
        setPurchasePrintNarration(includeNarration);
      }
      if (selectedReport === "salesHistory") {
        const includeNarration = window.confirm("Print narration/details?");
        salesPrintNarrationRef.current = includeNarration;
        setSalesPrintNarration(includeNarration);
      }
      if (["customerLedger", "supplierLedger", "accountStatement"].includes(selectedReport)) {
        const includeNarration = window.confirm("Print narration/details also?");
        ledgerPrintNarrationRef.current = includeNarration;
        setLedgerPrintNarration(includeNarration);
      }
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
              <td colSpan="3">Net Purchase Total for {formatDisplayDate(date)}</td>
              <td>{money(total.gross)}</td>
              <td className="balance-cell">{money(total.net)}</td>
              <td>Cancelled excluded</td>
            </tr>
          );
        }
      });
      return renderedRows;
    };
    const reportFileName = (() => {
      const from = formatFileDate(data.dateFrom || customRange.date_from);
      const to = formatFileDate(data.dateTo || customRange.date_to);
      const title = safeFileName(currentReport.title);
      if (selectedReport === "balanceSheet") return `Balance_Sheet_As_At_${to}.pdf`;
      if (selectedReport === "cashBook") {
        const mode = cashBookFilters.bookAccount || cashBookFilters.paymentMode || "All";
        return `${mode === "BANK" ? "Bank_Book" : "Cash_Book"}_${cashBookFilters.paymentMode || mode}_${from}_to_${to}.pdf`;
      }
      return `${title}_${from}_to_${to}.pdf`;
    })();
    return (
      <>
        <section className="settings-layout">
          <ModuleCard eyebrow="Report View" title={currentReport.title} subtitle="Single report workspace with filters, summary, print and export controls.">
            <div className="button-row">
              <button className="secondary-button" onClick={() => setSelectedReport("")}>Back to {currentCategory?.title || "Report List"}</button>
              <button className="secondary-button" onClick={() => { setSelectedReport(""); setSelectedCategory(""); }}>Back to Report Center</button>
              {selectedReport === "purchaseHistory" && <button className="primary-button" onClick={onOpenBlankPurchaseAmendment}>Add/Edit Purchase</button>}
            </div>
            {renderFilters()}
          </ModuleCard>
          <ModuleCard eyebrow={currentCategory?.title || "Reports"} title={currentReport.title} subtitle={`${rows.length} row${rows.length === 1 ? "" : "s"} found.`}>
            <PrintableReport
              beforePdfExport={handleReportPrintOption}
              beforePrint={handleReportPrintOption}
              fileName={reportFileName}
              reportClassName={selectedReport === "salesHistory" ? "sales-history-print-report" : selectedReport === "purchaseHistory" ? "purchase-history-print-report" : selectedReport === "profitLoss" ? "profit-loss-print-report" : selectedReport === "cashBook" ? "cash-book-print-report" : ""}
              title={currentReport.title}
            >
              <div className="purchase-summary-grid supplier-payment-preview">
                {(currentReport.summary?.(rows) || []).map(([label, value, featured]) => <SummaryMetric featured={featured} key={label} label={label} value={value} />)}
              </div>
              {selectedReport === "stockInventory" ? (
                <StockInventoryReport
                  auditEndpoint={`${API_URL}/stock-inventory/audit`}
                  canManageStock={canManageStock}
                  lots={Array.isArray(data.stockLotReport) ? data.stockLotReport : []}
                  onLotAction={onOpenLotAction}
                  products={Array.isArray(data.stockReport) ? data.stockReport : []}
                />
              ) : selectedReport === "profitLoss" ? renderProfitLossStatement() : selectedReport === "cashBook" ? renderCashBookStatement() : (
                <>
                  <DataTable headers={currentReport.headers}>
                    {selectedReport === "purchaseHistory" ? renderPurchaseHistoryRows() : rows.map((row, index) => currentReport.render(row, index))}
                  </DataTable>
                  {rows.length === 0 && <div className="cart-empty">No records found for the selected filters.</div>}
                </>
              )}
            </PrintableReport>
          </ModuleCard>
        </section>
        {renderBalanceSheetDetailModal()}
        {renderCashBookDetailModal()}
      </>
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

function StockInventoryReport({ auditEndpoint, canManageStock, lots = [], onLotAction, products = [] }) {
  const [viewMode, setViewMode] = useState("PRODUCT");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState({
    category: "",
    product: "",
    lot: "",
    supplier: "",
    status: "ACTIVE",
    date_from: "",
    date_to: "",
    showEmpty: false,
    showInactive: false,
  });
  const [expandedProductId, setExpandedProductId] = useState("");
  const [auditRows, setAuditRows] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState("");
  const [auditFocus, setAuditFocus] = useState(null);
  const [selectedLotDetail, setSelectedLotDetail] = useState(null);
  const money = (value) => currency.format(Number(value || 0));
  const qty = (value) => Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
  const lotBalance = (lot) => Number(lot.balance_qty ?? lot.remaining_qty ?? 0);
  const lotOpening = (lot) => Number(lot.purchase_qty || 0);
  const lotUsed = (lot) => Number(lot.sold_qty ?? Math.max(lotOpening(lot) - Number(lot.remaining_qty || 0), 0));
  const lotCost = (lot) => Number(lot.effective_cost_per_unit || lot.purchase_rate || 0);
  const lotSaleRate = (lot) => Number(lot.temporary_sale_rate || lot.sale_rate || lot.selling_rate || 0);
  const lotStatus = (lot) => {
    const status = String(lot.batch_status || "ACTIVE").toUpperCase();
    if (status === "CANCELLED") return "Cancelled";
    if (status === "INACTIVE") return "Inactive";
    if (lotBalance(lot) <= 0 && lotUsed(lot) > 0) return "Sold Out";
    return "Active";
  };
  const statusClass = (status) => status === "Active" ? "stock-ok" : status === "Sold Out" ? "origin-rate" : "stock-low";
  const activeLots = lots.filter((lot) => lotStatus(lot) === "Active");
  const productGroups = [...lots.reduce((groups, lot) => {
    const key = String(lot.product_id);
    const current = groups.get(key) || {
      product_id: lot.product_id,
      product_name: lot.product_name,
      category: lot.category || "Fruit",
      unit: lot.unit || "",
      minimum_stock: products.find((product) => Number(product.product_id) === Number(lot.product_id))?.minimum_stock || 0,
      sale_rate: lot.selling_rate || 0,
      total_stock: 0,
      stock_value: 0,
      active_lots: 0,
      sold_out_lots: 0,
      lots: [],
    };
    const balance = lotBalance(lot);
    const status = lotStatus(lot);
    current.total_stock += status === "Cancelled" || status === "Inactive" ? 0 : balance;
    current.stock_value += status === "Cancelled" || status === "Inactive" ? 0 : balance * lotCost(lot);
    current.active_lots += status === "Active" ? 1 : 0;
    current.sold_out_lots += status === "Sold Out" ? 1 : 0;
    current.lots.push(lot);
    groups.set(key, current);
    return groups;
  }, new Map()).values()].sort((left, right) => `${left.category}-${left.product_name}`.localeCompare(`${right.category}-${right.product_name}`));
  const categoryRows = [...productGroups.reduce((groups, product) => {
    const key = product.category || "Fruit";
    const current = groups.get(key) || { category: key, products: 0, total_quantity: 0, stock_value: 0, low_stock_count: 0, product_rows: [] };
    current.products += 1;
    current.total_quantity += product.total_stock;
    current.stock_value += product.stock_value;
    if (Number(product.total_stock || 0) <= Number(product.minimum_stock || 0)) current.low_stock_count += 1;
    current.product_rows.push(product);
    groups.set(key, current);
    return groups;
  }, new Map()).values()].sort((left, right) => left.category.localeCompare(right.category));
  const categories = [...new Set(lots.map((lot) => lot.category || "Fruit"))].sort();
  const suppliers = [...new Set(lots.map((lot) => lot.supplier_name).filter(Boolean))].sort();
  const productOptions = productGroups.map((product) => [String(product.product_id), product.product_name]);
  const lotOptions = lots.map((lot) => [String(lot.id), [lot.lot_name || lot.batch_no || `Lot #${lot.id}`, lot.lot_size].filter(Boolean).join(" / ")]);
  const matchesText = (values) => {
    const needle = search.trim().toLowerCase();
    if (!needle) return true;
    return values.some((value) => String(value ?? "").toLowerCase().includes(needle));
  };
  const filteredLots = lots.filter((lot) => {
    const status = lotStatus(lot);
    if (!filters.showEmpty && status === "Sold Out") return false;
    if (!filters.showInactive && ["Inactive", "Cancelled"].includes(status)) return false;
    if (filters.status && filters.status !== "ALL" && status !== filters.status) return false;
    if (filters.category && (lot.category || "Fruit") !== filters.category) return false;
    if (filters.product && String(lot.product_id) !== filters.product) return false;
    if (filters.lot && String(lot.id) !== filters.lot) return false;
    if (filters.supplier && lot.supplier_name !== filters.supplier) return false;
    if (filters.date_from && toDateKey(lot.purchase_date || lot.created_at || "") < filters.date_from) return false;
    if (filters.date_to && toDateKey(lot.purchase_date || lot.created_at || "") > filters.date_to) return false;
    return matchesText([
      lot.product_name,
      lot.category,
      lot.lot_name,
      lot.batch_no,
      lot.lot_size,
      lot.supplier_name,
      lot.purchase_qty,
      lot.remaining_qty,
      lot.purchase_rate,
      lot.effective_cost_per_unit,
      lot.temporary_sale_rate,
      lot.selling_rate,
      status,
      lot.remarks,
    ]);
  });
  const filteredProductRows = productGroups
    .map((product) => ({ ...product, visible_lots: filteredLots.filter((lot) => Number(lot.product_id) === Number(product.product_id)) }))
    .filter((product) => product.visible_lots.length > 0 && matchesText([product.product_name, product.category, product.total_stock, product.stock_value]));
  const filteredCategoryRows = categoryRows
    .map((category) => ({ ...category, product_rows: filteredProductRows.filter((product) => product.category === category.category) }))
    .filter((category) => category.product_rows.length > 0 && matchesText([category.category, category.products, category.total_quantity, category.stock_value]));
  const totalStockValue = activeLots.reduce((sum, lot) => sum + lotBalance(lot) * lotCost(lot), 0);
  const lowStockItems = productGroups.filter((product) => Number(product.total_stock || 0) <= Number(product.minimum_stock || 0)).length;
  const adjustmentCount = auditRows.filter((row) => row.action === "INVENTORY_LOT_ADJUST").length;

  useEffect(() => {
    let mounted = true;
    const loadAudit = async () => {
      if (!auditEndpoint) return;
      setAuditLoading(true);
      setAuditError("");
      try {
        const response = await axios.get(auditEndpoint);
        if (mounted) setAuditRows(response.data || []);
      } catch (error) {
        if (mounted) setAuditError(getErrorMessage(error, "Unable to load stock audit trail"));
      } finally {
        if (mounted) setAuditLoading(false);
      }
    };
    loadAudit();
    return () => {
      mounted = false;
    };
  }, [auditEndpoint]);

  const openAudit = (lot = null) => {
    setAuditFocus(lot || { all: true });
  };
  const focusedAuditRows = auditFocus?.all ? auditRows : auditRows.filter((row) => String(row.lot_id || "") === String(auditFocus?.id || ""));
  const auditChangeSummary = (row) => {
    const oldValue = row.old_value || {};
    const newValue = row.new_value || {};
    const beforeQty = oldValue.remaining_qty ?? oldValue.purchase_qty ?? "-";
    const afterQty = newValue.remaining_qty ?? newValue.purchase_qty ?? "-";
    const beforeRate = oldValue.purchase_rate ?? oldValue.effective_cost_per_unit ?? "-";
    const afterRate = newValue.purchase_rate ?? newValue.effective_cost_per_unit ?? "-";
    return `Qty ${beforeQty} -> ${afterQty} | Cost ${beforeRate} -> ${afterRate}`;
  };
  const clearFilters = () => setFilters({ category: "", product: "", lot: "", supplier: "", status: "ACTIVE", date_from: "", date_to: "", showEmpty: false, showInactive: false });
  const renderLotActions = (lot) => {
    const status = lotStatus(lot);
    return (
      <div className="table-actions">
        <button className="table-action" disabled={!canManageStock} onClick={() => onLotAction?.("edit", lot)}>Edit Lot</button>
        <button className="table-action" disabled={!canManageStock || status === "Cancelled"} onClick={() => onLotAction?.("adjust", lot)}>Adjust Stock</button>
        <button className="table-action" disabled={!canManageStock || status === "Cancelled" || lotBalance(lot) <= 0} onClick={() => onLotAction?.("transfer", lot)}>Transfer</button>
        <button className="table-action" disabled={!canManageStock || status === "Cancelled"} onClick={() => onLotAction?.("add", lot)}>Add Qty</button>
        {status === "Cancelled" || status === "Inactive" ? (
          <button className="table-action" disabled={!canManageStock} onClick={() => onLotAction?.("reactivate", lot)}>Reactivate</button>
        ) : (
          <button className="remove-button compact-button" disabled={!canManageStock} onClick={() => onLotAction?.("deactivate", lot)}>Deactivate</button>
        )}
        <button className="secondary-button compact-button" onClick={() => openAudit(lot)}>Audit</button>
      </div>
    );
  };
  const openLotDetail = (lot) => setSelectedLotDetail(lot);
  const renderLotRows = (rows) => rows.map((lot) => {
    const status = lotStatus(lot);
    return (
      <tr className="report-row-clickable" key={lot.id} onClick={() => openLotDetail(lot)}>
        <td className="primary-cell">{lot.product_name}<small className="cell-note">{lot.unit}</small></td>
        <td>{lot.category || "Fruit"}</td>
        <td>{lot.supplier_name || "-"}</td>
        <td className="primary-cell">{lot.lot_name || lot.batch_no || `Lot #${lot.id}`}</td>
        <td>{lot.lot_size || "-"}</td>
        <td>{formatDisplayDate(lot.purchase_date || lot.created_at)}</td>
        <td>{qty(lotOpening(lot))}</td>
        <td>{qty(lotUsed(lot))}</td>
        <td>{qty(lot.adjusted_qty)}</td>
        <td><span className={lotBalance(lot) <= 0 ? "origin-rate" : "stock-ok"}>{qty(lotBalance(lot))}</span></td>
        <td>{money(lotCost(lot))}</td>
        <td>{money(lotSaleRate(lot))}</td>
        <td>{money(lotBalance(lot) * lotCost(lot))}</td>
        <td><span className={statusClass(status)}>{status}</span></td>
        <td className="purchase-items-cell"><span title={lot.remarks || "-"}>{lot.remarks || "-"}</span></td>
        <td>{lot.created_at ? new Date(lot.created_at).toLocaleString("en-IN") : "-"}</td>
        <td>{lot.last_edited_at ? new Date(lot.last_edited_at).toLocaleString("en-IN") : "-"}</td>
      </tr>
    );
  });

  return (
    <section className="stock-inventory-report">
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric featured label="Total Stock Value" value={money(totalStockValue)} />
        <SummaryMetric label="Total Products" value={productGroups.length} />
        <SummaryMetric label="Active Lots" value={activeLots.length} />
        <SummaryMetric label="Sold Out Lots" value={lots.filter((lot) => lotStatus(lot) === "Sold Out").length} />
        <SummaryMetric label="Low Stock Items" value={lowStockItems} />
        <SummaryMetric label="Inventory Adjustments" value={auditLoading ? "Loading" : adjustmentCount} />
      </div>
      {auditError && <div className="error-banner">{auditError}</div>}
      <div className="ledger-toolbar stock-inventory-toolbar no-print">
        <Field label="View Mode">
          <select value={viewMode} onChange={(event) => setViewMode(event.target.value)}>
            <option value="PRODUCT">Product-wise</option>
            <option value="LOT">Lot-wise</option>
            <option value="CATEGORY">Category-wise</option>
          </select>
        </Field>
        <Field label="Search"><input placeholder="Search product, lot, supplier, remarks..." value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
        <Field label="Category">
          <select value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
            <option value="">All categories</option>
            {categories.map((category) => <option key={category} value={category}>{category}</option>)}
          </select>
        </Field>
        <Field label="Product">
          <select value={filters.product} onChange={(event) => setFilters({ ...filters, product: event.target.value })}>
            <option value="">All products</option>
            {productOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </Field>
        <Field label="Lot Number">
          <select value={filters.lot} onChange={(event) => setFilters({ ...filters, lot: event.target.value })}>
            <option value="">All lots</option>
            {lotOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </Field>
        <Field label="Supplier">
          <select value={filters.supplier} onChange={(event) => setFilters({ ...filters, supplier: event.target.value })}>
            <option value="">All suppliers</option>
            {suppliers.map((supplier) => <option key={supplier} value={supplier}>{supplier}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
            <option value="ACTIVE">Active</option>
            <option value="Sold Out">Sold Out</option>
            <option value="Inactive">Inactive</option>
            <option value="Cancelled">Cancelled</option>
            <option value="ALL">All statuses</option>
          </select>
        </Field>
        <Field label="Date From"><input type="date" value={filters.date_from} onChange={(event) => setFilters({ ...filters, date_from: event.target.value })} /></Field>
        <Field label="Date To"><input type="date" value={filters.date_to} onChange={(event) => setFilters({ ...filters, date_to: event.target.value })} /></Field>
        <label className="check-field report-check-field"><input checked={filters.showEmpty} type="checkbox" onChange={(event) => setFilters({ ...filters, showEmpty: event.target.checked })} /><span>Show Empty Lots</span></label>
        <label className="check-field report-check-field"><input checked={filters.showInactive} type="checkbox" onChange={(event) => setFilters({ ...filters, showInactive: event.target.checked })} /><span>Show Inactive / Cancelled Lots</span></label>
        <button className="secondary-button" onClick={clearFilters}>Clear Stock Filters</button>
        <button className="secondary-button" onClick={() => openAudit()}>View Audit Trail</button>
      </div>
      {viewMode === "PRODUCT" && (
        <DataTable headers={["Product", "Category", "Total Stock", "Available Lots", "Average Cost", "Sale Rate", "Stock Value", "Minimum Stock", "Status"]}>
          {filteredProductRows.map((product) => {
            const averageCost = product.total_stock > 0 ? product.stock_value / product.total_stock : 0;
            const low = Number(product.total_stock || 0) <= Number(product.minimum_stock || 0);
            const toggleProduct = () => setExpandedProductId(expandedProductId === String(product.product_id) ? "" : String(product.product_id));
            return (
              <React.Fragment key={product.product_id}>
                <tr className="report-row-clickable" onClick={toggleProduct}>
                  <td className="primary-cell">{product.product_name}<small className="cell-note">{product.unit}</small></td>
                  <td>{product.category}</td>
                  <td>{qty(product.total_stock)}</td>
                  <td>{product.active_lots}</td>
                  <td>{money(averageCost)}</td>
                  <td>{money(product.sale_rate)}</td>
                  <td>{money(product.stock_value)}</td>
                  <td>{qty(product.minimum_stock)}</td>
                  <td><span className={low ? "stock-low" : "stock-ok"}>{low ? "Low Stock" : "OK"}</span></td>
                </tr>
                {expandedProductId === String(product.product_id) && (
                  <tr className="sales-history-drilldown-row">
                    <td colSpan="9">
                      <DataTable headers={["Product", "Category", "Supplier", "Lot No.", "Size", "Opening Date", "Opening Qty", "Sold Qty", "Adjusted Qty", "Balance Qty", "Cost", "Sale Rate", "Stock Value", "Status", "Remarks", "Created At", "Last Edited"]}>
                        {renderLotRows(product.visible_lots)}
                      </DataTable>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
          {filteredProductRows.length === 0 && <tr><td colSpan="9" className="empty-cell">No matching stock products found.</td></tr>}
        </DataTable>
      )}
      {viewMode === "LOT" && (
        <DataTable headers={["Product", "Category", "Supplier", "Lot No.", "Size", "Opening Date", "Opening Qty", "Sold Qty", "Adjusted Qty", "Balance Qty", "Cost", "Sale Rate", "Stock Value", "Status", "Remarks", "Created At", "Last Edited"]}>
          {renderLotRows(filteredLots)}
          {filteredLots.length === 0 && <tr><td colSpan="17" className="empty-cell">No matching stock lots found.</td></tr>}
        </DataTable>
      )}
      {viewMode === "CATEGORY" && (
        <DataTable headers={["Category", "Products", "Total Quantity", "Stock Value", "Low Stock Count"]}>
          {filteredCategoryRows.map((category) => (
            <tr className="report-row-clickable" key={category.category} onClick={() => { setViewMode("PRODUCT"); setFilters({ ...filters, category: category.category }); }}>
              <td className="primary-cell">{category.category}</td>
              <td>{category.product_rows.length}</td>
              <td>{qty(category.product_rows.reduce((sum, product) => sum + product.total_stock, 0))}</td>
              <td>{money(category.product_rows.reduce((sum, product) => sum + product.stock_value, 0))}</td>
              <td>{category.product_rows.filter((product) => Number(product.total_stock || 0) <= Number(product.minimum_stock || 0)).length}</td>
            </tr>
          ))}
          {filteredCategoryRows.length === 0 && <tr><td colSpan="5" className="empty-cell">No matching stock categories found.</td></tr>}
        </DataTable>
      )}
      {selectedLotDetail && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Stock Lot Detail</span>
                <strong>{selectedLotDetail.product_name} - {selectedLotDetail.lot_name || selectedLotDetail.batch_no || `Lot #${selectedLotDetail.id}`}</strong>
              </div>
              <button aria-label="Close lot detail" className="remove-button" onClick={() => setSelectedLotDetail(null)}><Icon name="close" /></button>
            </div>
            <div className="sale-edit-body">
              <div className="purchase-summary-grid supplier-payment-preview">
                <SummaryMetric label="Balance Qty" value={qty(lotBalance(selectedLotDetail))} featured />
                <SummaryMetric label="Stock Value" value={money(lotBalance(selectedLotDetail) * lotCost(selectedLotDetail))} />
                <SummaryMetric label="Status" value={lotStatus(selectedLotDetail)} />
              </div>
              <DataTable headers={["Field", "Value"]}>
                <tr><td>Product</td><td className="primary-cell">{selectedLotDetail.product_name}</td></tr>
                <tr><td>Category</td><td>{selectedLotDetail.category || "Fruit"}</td></tr>
                <tr><td>Supplier</td><td>{selectedLotDetail.supplier_name || "-"}</td></tr>
                <tr><td>Lot / Size</td><td>{[selectedLotDetail.lot_name || selectedLotDetail.batch_no || `Lot #${selectedLotDetail.id}`, selectedLotDetail.lot_size].filter(Boolean).join(" / ")}</td></tr>
                <tr><td>Opening / Sold / Adjusted</td><td>{qty(lotOpening(selectedLotDetail))} / {qty(lotUsed(selectedLotDetail))} / {qty(selectedLotDetail.adjusted_qty)}</td></tr>
                <tr><td>Cost / Sale Rate</td><td>{money(lotCost(selectedLotDetail))} / {money(lotSaleRate(selectedLotDetail))}</td></tr>
                <tr><td>Opening Date</td><td>{formatDisplayDate(selectedLotDetail.purchase_date || selectedLotDetail.created_at)}</td></tr>
                <tr><td>Remarks</td><td>{selectedLotDetail.remarks || "-"}</td></tr>
              </DataTable>
              <div className="detail-action-bar no-print">
                {renderLotActions(selectedLotDetail)}
              </div>
            </div>
          </section>
        </div>
      )}
      {auditFocus && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Stock Audit Trail</span>
                <strong>{auditFocus.all ? "All Inventory Changes" : `${auditFocus.product_name} - ${auditFocus.lot_name || auditFocus.batch_no || `Lot #${auditFocus.id}`}`}</strong>
              </div>
              <button className="remove-button" onClick={() => setAuditFocus(null)}><Icon name="close" /></button>
            </div>
            <div className="sale-edit-body">
              <DataTable headers={["Date", "Product", "Lot", "Action", "Qty / Rate Change", "Reason", "Edited By"]}>
                {focusedAuditRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.edited_at ? new Date(row.edited_at).toLocaleString("en-IN") : "-"}</td>
                    <td className="primary-cell">{row.product_name}</td>
                    <td>{row.lot_name || row.lot_id || "-"}</td>
                    <td><span className="tag">{row.action}</span></td>
                    <td>{auditChangeSummary(row)}</td>
                    <td>{row.reason || "-"}</td>
                    <td>{row.edited_by_name || "-"}</td>
                  </tr>
                ))}
                {focusedAuditRows.length === 0 && <tr><td colSpan="7" className="empty-cell">No audit entries found.</td></tr>}
              </DataTable>
            </div>
          </section>
        </div>
      )}
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
  const expenseCategories = ["Rent", "Staff Salary", "Electricity", "Transport", "Loading / Hamali", "Packing Material", "Repair & Maintenance", "Food / Tea / Misc", "Other"];
  const emptyExpense = {
    expense_date: toDateKey(new Date()),
    category: "Other",
    amount: "",
    payment_mode: "CASH",
    reference_number: "",
    vendor_name: "",
    remarks: "",
    active: true,
  };
  const [draft, setDraft] = useState(emptyExpense);
  const [editingId, setEditingId] = useState(null);
  const [filters, setFilters] = useState({ search: "", category: "", payment_mode: "", status: "", date_from: "", date_to: "" });
  const filteredExpenses = expenses.filter((expense) => {
    const status = expense.status || (expense.active !== false ? "ACTIVE" : "CANCELLED");
    const searchText = `${expense.category || ""} ${expense.vendor_name || ""} ${expense.paid_to || ""} ${expense.reference_number || ""} ${expense.remarks || ""}`.toLowerCase();
    if (filters.search && !searchText.includes(filters.search.toLowerCase())) return false;
    if (filters.category && expense.category !== filters.category) return false;
    if (filters.payment_mode && expense.payment_mode !== filters.payment_mode) return false;
    if (filters.status && status !== filters.status) return false;
    if (filters.date_from && toDateKey(expense.expense_date) < filters.date_from) return false;
    if (filters.date_to && toDateKey(expense.expense_date) > filters.date_to) return false;
    return true;
  });
  const totalActiveExpenses = filteredExpenses
    .filter((expense) => expense.active !== false && expense.status !== "CANCELLED")
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);

  const saveExpense = async () => {
    try {
      const payload = {
        ...draft,
        amount: Number(draft.amount || 0),
        paid_to: draft.paid_to || draft.vendor_name,
        branch_id: user.branch_id,
        created_by: user.id,
        edited_by: user.id,
      };
      if (editingId) {
        const reason = window.prompt("Enter reason for editing this expense", "Expense updated");
        if (!reason) return;
        await axios.put(`${API_URL}/expenses/${editingId}`, { ...payload, reason });
      }
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
      vendor_name: expense.vendor_name || expense.paid_to || "",
      remarks: expense.remarks || "",
      active: expense.active !== false,
    });
  };
  const cancelExpense = async (expense) => {
    const reason = window.prompt(`Enter cancellation reason for ${expense.category}`);
    if (!reason) return;
    try {
      await axios.post(`${API_URL}/expenses/${expense.id}/cancel`, { reason, cancelled_by: user.id });
      await onReload();
      alert("Expense cancelled");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to cancel expense"));
    }
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
          <Field label="Category">
            <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
              {expenseCategories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </Field>
          <Field label="Amount"><input min="0" step="0.01" type="number" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} /></Field>
          <Field label="Payment Mode">
            <select value={draft.payment_mode} onChange={(event) => setDraft({ ...draft, payment_mode: event.target.value })}>
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="BANK_TRANSFER">Bank</option>
            </select>
          </Field>
          <Field label="Reference Number"><input value={draft.reference_number} onChange={(event) => setDraft({ ...draft, reference_number: event.target.value })} /></Field>
          <Field label="Paid To / Vendor Name"><input value={draft.vendor_name} onChange={(event) => setDraft({ ...draft, vendor_name: event.target.value })} /></Field>
          <label className="check-field"><input checked={draft.active} type="checkbox" onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>Active</span></label>
          <Field label="Remarks"><textarea value={draft.remarks} onChange={(event) => setDraft({ ...draft, remarks: event.target.value })} /></Field>
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={saveExpense}>{editingId ? "Update Expense" : "Save Expense"}</button>
          {editingId && <button className="secondary-button" onClick={() => { setEditingId(null); setDraft(emptyExpense); }}>Cancel Edit</button>}
        </div>
      </ModuleCard>
      <ModuleCard eyebrow="Expense Register" title="Recent Expenses" subtitle="Expense rows remain available for reporting and review.">
        <div className="ledger-toolbar">
          <Field label="Search"><input placeholder="Search category, paid to, reference" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} /></Field>
          <Field label="Category">
            <select value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
              <option value="">All categories</option>
              {expenseCategories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </Field>
          <Field label="Payment Mode">
            <select value={filters.payment_mode} onChange={(event) => setFilters({ ...filters, payment_mode: event.target.value })}>
              <option value="">All modes</option>
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="BANK_TRANSFER">Bank</option>
            </select>
          </Field>
          <Field label="Status">
            <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </Field>
          <Field label="From"><input type="date" value={filters.date_from} onChange={(event) => setFilters({ ...filters, date_from: event.target.value })} /></Field>
          <Field label="To"><input type="date" value={filters.date_to} onChange={(event) => setFilters({ ...filters, date_to: event.target.value })} /></Field>
          <button className="secondary-button" onClick={onReload}>Refresh</button>
        </div>
        <DataTable headers={["Date", "Category", "Vendor", "Mode", "Amount", "Status", "Reference", "Remarks", ""]}>
          {filteredExpenses.map((expense) => {
            const status = expense.status || (expense.active !== false ? "ACTIVE" : "CANCELLED");
            return (
            <tr className={status === "CANCELLED" ? "muted-row" : ""} key={expense.id}>
              <td>{expense.expense_date}</td>
              <td className="primary-cell">{expense.category}</td>
              <td>{expense.paid_to || expense.vendor_name || "-"}</td>
              <td><span className="tag">{expense.payment_mode}</span></td>
              <td>{currency.format(Number(expense.amount || 0))}</td>
              <td><span className={status === "ACTIVE" ? "stock-ok" : "stock-low"}>{status}</span></td>
              <td>{expense.reference_number || "-"}</td>
              <td>{expense.remarks || expense.cancellation_reason || "-"}</td>
              <td>
                <div className="button-row table-actions-row">
                  <button className="table-action" disabled={status === "CANCELLED"} onClick={() => editExpense(expense)}>Edit</button>
                  <button className="remove-button" disabled={status === "CANCELLED"} onClick={() => cancelExpense(expense)}>Cancel</button>
                </div>
              </td>
            </tr>
          );})}
        </DataTable>
        {filteredExpenses.length === 0 && <div className="cart-empty">No records found for selected filters.</div>}
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
  const [ledgerExporting, setLedgerExporting] = useState(false);
  const ledgerPrintRef = useRef(null);
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
  const exportLedgerPdf = async () => {
    if (!ledgerPrintRef.current) return;
    setLedgerExporting(true);
    try {
      await exportElementToPdf({
        element: ledgerPrintRef.current,
        fileName: `${accountLedger.account?.account_name || "Account_Ledger"}_${formatFileDate(ledgerDateRange.date_from || "all")}_to_${formatFileDate(ledgerDateRange.date_to || toDateKey(new Date()))}.pdf`,
        mode: "A4",
      });
    } catch (error) {
      alert(`Unable to export ledger PDF: ${error.message}`);
    } finally {
      setLedgerExporting(false);
    }
  };

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
                  <td className="primary-cell">
                    {account.account_name}
                    <small className="cell-note">{account.system_account ? "System Account" : account.firm_name || account.city || account.address || "-"}</small>
                  </td>
                  <td><span className="tag">{account.account_type}</span></td>
                  <td>{account.mobile_number || "-"}</td>
                  <td>{currency.format(Number(account.opening_balance || 0))}</td>
                  <td>{currency.format(Number(account.receivable_balance || 0))}</td>
                  <td>{currency.format(Number(account.payable_balance || 0))}</td>
                  <td><span className={account.active !== false ? "stock-ok" : "stock-low"}>{account.active !== false ? "Active" : "Inactive"}</span></td>
                  <td><button className="table-action" disabled={account.system_account === true} onClick={() => editAccount(account)}>{account.system_account ? "Protected" : "Edit"}</button></td>
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
            <button className="secondary-button" disabled={ledgerExporting} onClick={exportLedgerPdf}>{ledgerExporting ? "Exporting..." : "PDF Export"}</button>
          </div>
          <div ref={ledgerPrintRef} className="print-area report-paper">
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
            <DataTable headers={["Date", "Invoice Number", "Transaction Type", "Sale Amount", "Payment Mode", "Debit", "Credit", "Balance", "Narration"]}>
              {printableLedgerRows.map((row, index) => (
                <tr key={`${row.date}-${row.transaction_type}-${index}`}>
                  <td>{row.date}</td>
                  <td>{row.invoice_no || "-"}</td>
                  <td><span className="tag">{row.transaction_type}</span></td>
                  <td>{row.sale_amount ? currency.format(Number(row.sale_amount || 0)) : "-"}</td>
                  <td>{row.payment_mode || "-"}</td>
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

function SettingsModule({
  canManage,
  localDbStatus,
  onQueueSyncTest,
  onReload,
  onRetrySync,
  onRunSync,
  rules,
  settingsData,
  syncMessage,
  syncStatus,
  user,
}) {
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
      <DiscountSettings canManage={canManage} discountRules={settingsData.discountRules} onReload={onReload} saleRateSettings={settingsData.saleRateSettings} user={user} />
      <PermissionSettings canManage={canManage} key={JSON.stringify(settingsData.roles || [])} onReload={onReload} roles={settingsData.roles} user={user} />
      <UserManagementSection canManage={canManage} key={JSON.stringify(settingsData.users || [])} onReload={onReload} roles={settingsData.roles} user={user} users={settingsData.users || []} />
      <SecurityDevicesSection activationCodes={settingsData.activationCodes || []} branches={settingsData.branches || []} canManage={canManage} counters={settingsData.counters || []} devices={settingsData.authorizedDevices || []} onReload={onReload} user={user} />
      <BranchCounterSettings branches={settingsData.branches || []} canManage={canManage} counters={settingsData.counters || []} onReload={onReload} user={user} />
      <UpdateCenterSection canManage={canManage} key={settingsData.updateCenter?.updated_at || "update-center"} onReload={onReload} updateCenter={settingsData.updateCenter} user={user} />
      <SyncSettingsSection
        backendHealth={backendHealth}
        canManage={canManage}
        key={settingsData.syncSettings?.updated_at || "sync-settings"}
        localDbStatus={localDbStatus}
        onQueueSyncTest={onQueueSyncTest}
        onReload={onReload}
        onRetrySync={onRetrySync}
        onRunSync={onRunSync}
        syncMessage={syncMessage}
        syncSettings={settingsData.syncSettings}
        syncStatus={syncStatus}
        user={user}
      />
      <BackupSettings backupLogs={settingsData.backupLogs || []} backupSettings={settingsData.backupSettings} canManage={canManage} onReload={onReload} user={user} />
      <SystemInfoSection systemInfo={settingsData.systemInfo || {}} />
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
            <option value="THERMAL">Thermal 80mm / 58mm</option>
            <option value="A4">A4</option>
          </select>
        </Field>
        <Field label="Default Invoice Print">
          <select disabled={!canManage} value={draft.default_invoice_print || "THERMAL_RECEIPT"} onChange={(event) => updateDraft("default_invoice_print", event.target.value)}>
            <option value="A4_INVOICE">A4 Invoice</option>
            <option value="THERMAL_RECEIPT">Thermal Receipt</option>
          </select>
        </Field>
        <Field label="Default Report Print">
          <select disabled={!canManage} value={draft.default_report_print || "A4_REPORT"} onChange={(event) => updateDraft("default_report_print", event.target.value)}>
            <option value="A4_REPORT">A4 Report</option>
          </select>
        </Field>
        <Field label="Receipt Width">
          <select disabled={!canManage} value={draft.receipt_width || "80MM"} onChange={(event) => updateDraft("receipt_width", event.target.value)}>
            <option value="58MM">58mm</option>
            <option value="80MM">80mm</option>
          </select>
        </Field>
        <label className="check-field"><input checked={draft.auto_print_after_billing === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("auto_print_after_billing", event.target.checked)} /><span>Auto print after billing</span></label>
        <label className="check-field"><input checked={draft.show_print_preview_before_print !== false} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("show_print_preview_before_print", event.target.checked)} /><span>Show print preview before print</span></label>
        <label className="check-field"><input checked={draft.show_item_discount_column_pos !== false} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("show_item_discount_column_pos", event.target.checked)} /><span>Show Item Discount Column on POS</span></label>
        <label className="check-field"><input checked={draft.show_item_discount_column_receipt !== false} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("show_item_discount_column_receipt", event.target.checked)} /><span>Show Item Discount Column on Receipt</span></label>
        <label className="check-field"><input checked={draft.show_bill_discount_row_receipt !== false} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("show_bill_discount_row_receipt", event.target.checked)} /><span>Show Bill Discount Row on Receipt</span></label>
        <label className="check-field"><input checked={draft.hide_zero_discount_rows !== false} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("hide_zero_discount_rows", event.target.checked)} /><span>Hide Zero Discount Rows</span></label>
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
        <Field label="QR Display Size">
          <select disabled={!canManage} value={draft.qr_display_size || "MEDIUM"} onChange={(event) => updateDraft("qr_display_size", event.target.value)}>
            <option value="SMALL">Small</option>
            <option value="MEDIUM">Medium</option>
            <option value="LARGE">Large</option>
          </select>
        </Field>
        <label className="check-field"><input checked={draft.enable_upi_qr_on_invoice === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("enable_upi_qr_on_invoice", event.target.checked)} /><span>Enable UPI QR on Invoice</span></label>
        <label className="check-field"><input checked={draft.show_upi_qr_on_all_bills === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("show_upi_qr_on_all_bills", event.target.checked)} /><span>Show UPI QR on all bills</span></label>
        {draft.enable_upi_qr_on_invoice === true && !draft.business_upi_id && <p className="form-note stock-low">Please add UPI ID in Settings to show QR code.</p>}
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
        <Field label="POS Lot Selection Mode">
          <select disabled={!canManage} value={draft.pos_lot_selection_mode || "ASK_MULTIPLE"} onChange={(event) => setDraft({ ...draft, pos_lot_selection_mode: event.target.value })}>
            <option value="ASK_MULTIPLE">Ask When Multiple Lots Exist</option>
            <option value="AUTO_FIFO">Auto FIFO</option>
            <option value="MANUAL">Manual Lot Selection</option>
          </select>
        </Field>
        <label className="check-field"><input disabled={!canManage} checked={draft.suggestion_enabled !== false} type="checkbox" onChange={(event) => setDraft({ ...draft, suggestion_enabled: event.target.checked })} /><span>Suggestions Active</span></label>
        <Field label="Notes"><textarea disabled={!canManage} value={draft.notes || ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></Field>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={save}>Save Sale Rate Settings</button>
    </ModuleCard>
  );
}

function DiscountSettings({ canManage, discountRules, onReload, saleRateSettings = {}, user }) {
  const [calculationEnabled, setCalculationEnabled] = useState(saleRateSettings.bill_level_slab_discount_enabled !== false);
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
  const saveCalculationToggle = async () => {
    try {
      await axios.put(`${API_URL}/settings/sale-rate`, {
        ...defaultSaleRateSettings,
        ...saleRateSettings,
        bill_level_slab_discount_enabled: calculationEnabled,
        updated_by: user.id,
      });
      await onReload();
      alert("Discount calculation setting updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update discount calculation setting"));
    }
  };
  return (
    <ModuleCard eyebrow="Overall Sale Discount Settings" title="Bill-Level Discount Slabs" subtitle="Automatic POS invoice discounts based on total bill amount and optional payment mode.">
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric featured label="Discount Calculation" value={calculationEnabled ? "Enabled" : "Disabled"} />
        <SummaryMetric label="Active Slabs" value={discountRules.filter((rule) => rule.active !== false).length} />
      </div>
      <div className="button-row">
        <label className="check-field"><input checked={calculationEnabled} disabled={!canManage} type="checkbox" onChange={(event) => setCalculationEnabled(event.target.checked)} /><span>Enable Bill-Level Slab Discount</span></label>
        <button className="secondary-button" disabled={!canManage} onClick={saveCalculationToggle}>Save Calculation Setting</button>
      </div>
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
  ["manual_pos_rate_override", "Manual POS Rate Override"],
  ["pos_date_override", "POS Bill Date Override"],
  ["sale_date_edit", "Sale Bill Date Edit"],
  ["device_management", "Authorized Devices"],
  ["activation_codes", "Activation Codes"],
  ["backup_restore", "Backup / Restore"],
  ["branch_settings", "Branch Settings"],
  ["system_info", "System Info"],
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
    recovery_enabled: true,
    staff_self_recovery_enabled: false,
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
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const roleNames = (roles || []).map((role) => role.role_name).filter(Boolean);
  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const startEdit = (item) => {
    setEditingId(item.id);
    setDraft({
      full_name: item.full_name || "",
      username: item.username || "",
      mobile_number: item.mobile_number || "",
      email: item.email || "",
      recovery_enabled: item.recovery_enabled !== false,
      staff_self_recovery_enabled: item.staff_self_recovery_enabled === true,
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
      if (passwordTarget.recoveryAction) {
        const supplied = passwordTarget.password || "";
        if (supplied && supplied !== passwordTarget.confirm_password) {
          setRecoveryMessage("Temporary password and confirmation do not match.");
          return;
        }
        const response = await axios.post(`${API_URL}/users/${passwordTarget.id}/recovery-action`, {
          action: "RESET_PASSWORD",
          temporary_password: supplied,
          updated_by: user.id,
        });
        setRecoveryMessage(response.data.temporary_password
          ? `Temporary password generated. Share it securely once: ${response.data.temporary_password}`
          : "Temporary password set. The user must change it at next login.");
      } else {
        await axios.put(`${API_URL}/users/${passwordTarget.id}/password`, {
          password: passwordTarget.password,
          confirm_password: passwordTarget.confirm_password,
          updated_by: user.id,
        });
        setRecoveryMessage("Password updated and active sessions revoked.");
      }
      setPasswordTarget(null);
      await onReload();
    } catch (error) {
      setRecoveryMessage(getAuthErrorMessage(error, "Unable to update password"));
    }
  };
  const recoveryAction = async (item, action) => {
    try {
      const response = await axios.post(`${API_URL}/users/${item.id}/recovery-action`, {
        action,
        updated_by: user.id,
      });
      setRecoveryMessage(response.data.message || "Recovery action completed.");
      await onReload();
    } catch (error) {
      setRecoveryMessage(getAuthErrorMessage(error, "Unable to complete recovery action"));
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
        <label className="check-field"><input checked={draft.recovery_enabled} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("recovery_enabled", event.target.checked)} /><span>Recovery enabled</span></label>
        <label className="check-field"><input checked={draft.staff_self_recovery_enabled} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("staff_self_recovery_enabled", event.target.checked)} /><span>Allow staff self-recovery</span></label>
        <Field label="Notes"><textarea disabled={!canManage} value={draft.notes} onChange={(event) => updateDraft("notes", event.target.value)} /></Field>
      </div>
      {recoveryMessage && <div className="startup-status-panel"><p>{recoveryMessage}</p></div>}
      <div className="button-row">
        <button className="primary-button" disabled={!canManage} onClick={saveUser}>{editingId ? "Update User" : "Add User"}</button>
        {editingId && <button className="secondary-button" onClick={resetForm}>Cancel Edit</button>}
      </div>
      <DataTable headers={["Name", "Username", "Role", "Mobile", "Last Login", "Status", "Actions"]}>
        {users.map((item) => (
          <tr key={item.id}>
            <td className="primary-cell">
              {item.full_name}
              <small className="cell-note">{item.email || "No email"}</small>
              <small className="cell-note">
                Recovery {item.recovery_enabled === false ? "disabled" : item.recovery_email_verified || item.recovery_mobile_verified || item.verified_email || item.verified_mobile ? "ready" : "needs verified contact"}
              </small>
            </td>
            <td>{item.username}</td>
            <td><span className="tag">{item.role}</span></td>
            <td>{item.mobile_number || "-"}</td>
            <td>{item.last_login_at ? new Date(item.last_login_at).toLocaleString("en-IN") : "Not recorded"}</td>
            <td><span className={item.active ? "stock-ok" : "stock-low"}>{item.active ? "Active" : "Inactive"}</span></td>
            <td>
              <div className="button-row table-actions-row">
                <button className="table-action" disabled={!canManage} onClick={() => startEdit(item)}>Edit</button>
                <button className="table-action" disabled={!canManage} onClick={() => setPasswordTarget({ id: item.id, name: item.full_name, password: "", confirm_password: "" })}>Password</button>
                <button className="table-action" disabled={!canManage || item.id === user.id} onClick={() => setPasswordTarget({ id: item.id, name: item.full_name, password: "", confirm_password: "", recoveryAction: true })}>Reset Staff Password</button>
                <button className="secondary-button" disabled={!canManage || item.id === user.id} onClick={() => recoveryAction(item, "UNLOCK_ACCOUNT")}>Unlock</button>
                <button className="secondary-button" disabled={!canManage || item.id === user.id} onClick={() => recoveryAction(item, "RESEND_USERNAME")}>Resend Username</button>
                <button className="secondary-button" disabled={!canManage || item.id === user.id} onClick={() => recoveryAction(item, "REVOKE_SESSIONS")}>Revoke Sessions</button>
                <button className="secondary-button" disabled={!canManage || item.id === user.id} onClick={() => recoveryAction(item, "REQUIRE_PASSWORD_CHANGE")}>Require Change</button>
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
                <span className="eyebrow">{passwordTarget.recoveryAction ? "Staff Account Recovery" : "Reset Password"}</span>
                <strong>{passwordTarget.name}</strong>
              </div>
              <button aria-label="Close password reset" className="remove-button" onClick={() => setPasswordTarget(null)}><Icon name="close" /></button>
            </div>
            <div className="sale-edit-body">
              {passwordTarget.recoveryAction && <p className="form-note">Leave the fields blank to generate a one-time temporary password. The user will be required to change it at next login.</p>}
              <div className="form-grid settings-add-grid">
                <Field label={passwordTarget.recoveryAction ? "Temporary Password" : "New Password"}><input type="password" value={passwordTarget.password} onChange={(event) => setPasswordTarget({ ...passwordTarget, password: event.target.value })} /></Field>
                <Field label="Confirm Password"><input type="password" value={passwordTarget.confirm_password} onChange={(event) => setPasswordTarget({ ...passwordTarget, confirm_password: event.target.value })} /></Field>
              </div>
              <button className="primary-button" onClick={changePassword}>{passwordTarget.recoveryAction ? "Reset Staff Access" : "Save Password"}</button>
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
  const [lastChecked, setLastChecked] = useState("");
  const status = draft.update_status || "READY_FOR_FUTURE_UPDATES";
  const updateAvailable = ["UPDATE_AVAILABLE", "DOWNLOAD_READY_FUTURE", "DOWNLOADED"].includes(status);
  const updateDownloaded = ["DOWNLOADED", "INSTALL_READY_FUTURE"].includes(status);
  const latestVersion = draft.latest_version || draft.current_version || APP_VERSION;
  const releaseTitle = draft.release_title || "FroozERP Windows release";
  const releaseNotes = draft.release_notes || draft.changelog || "No hosted update feed is configured yet.";
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
  const checkForUpdates = async () => {
    const checkedAt = new Date().toISOString();
    setLastChecked(checkedAt);
    if (!UPDATE_FEED_URL) {
      setMessage("Update feed is not configured. Hosted signed release metadata is required for real update checks.");
      return;
    }
    try {
      const response = await axios.get(UPDATE_FEED_URL, { timeout: 8000 });
      const data = response.data || {};
      setDraft((current) => ({
        ...current,
        latest_version: data.version || data.latest_version || latestVersion,
        release_title: data.title || data.release_title || releaseTitle,
        release_notes: data.notes || data.release_notes || releaseNotes,
        published_at: data.pub_date || data.published_at || checkedAt,
        update_status: data.version && data.version !== APP_VERSION ? "UPDATE_AVAILABLE" : "NO_UPDATE_AVAILABLE",
      }));
      setMessage(data.version && data.version !== APP_VERSION ? `FroozERP update available - version ${data.version}` : "No update available");
    } catch (error) {
      setMessage(getErrorMessage(error, "Unable to check update feed"));
    }
  };
  return (
    <ModuleCard eyebrow="Software Updates" title="FroozERP Windows Updates" subtitle="Updater-ready foundation with local data preservation checks before installing signed releases.">
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric label="Current Version" value={draft.current_version || APP_VERSION} featured />
        <SummaryMetric label="Latest Version" value={latestVersion} />
        <SummaryMetric label="Status" value={status} />
        <SummaryMetric label="Last Checked" value={lastChecked ? new Date(lastChecked).toLocaleString("en-IN") : "Not checked"} />
      </div>
      <div className={updateAvailable ? "update-available-panel" : "update-foundation-panel"}>
        <strong>{updateAvailable ? `FroozERP update available - version ${latestVersion}` : releaseTitle}</strong>
        <span>{releaseNotes}</span>
        <small>Feed: {UPDATE_FEED_URL || "Not configured"}</small>
        <small>Published: {draft.published_at ? new Date(draft.published_at).toLocaleString("en-IN") : "Pending hosted release metadata"}</small>
      </div>
      <p className="form-note">{message || "Before installing an update, FroozERP checks local database health, preserves SQLite data, pending outbox operations, device identity and settings."}</p>
      <div className="form-grid supplier-form-grid">
        <Field label="Current Version"><input disabled={!canManage} value={draft.current_version || ""} onChange={(event) => setDraft({ ...draft, current_version: event.target.value })} /></Field>
        <Field label="Latest Version"><input disabled={!canManage} value={draft.latest_version || ""} onChange={(event) => setDraft({ ...draft, latest_version: event.target.value })} /></Field>
        <Field label="Production Update Feed"><input disabled value={UPDATE_FEED_URL || "Configure VITE_UPDATE_FEED_URL or window.__FROOZERP_UPDATE_FEED_URL__"} /></Field>
        <Field label="Release Date"><input disabled={!canManage} type="date" value={toDateKey(draft.release_date || new Date())} onChange={(event) => setDraft({ ...draft, release_date: event.target.value })} /></Field>
        <Field label="Release Notes"><textarea disabled={!canManage} value={draft.release_notes || draft.changelog || ""} onChange={(event) => setDraft({ ...draft, release_notes: event.target.value })} /></Field>
      </div>
      <div className="button-row">
        <button className="secondary-button" disabled={!canManage} onClick={checkForUpdates}>Check for Updates</button>
        <button className="secondary-button" disabled={!canManage} onClick={() => save("NO_UPDATE_AVAILABLE")}>Save Update Metadata</button>
        <button className="secondary-button" disabled={!canManage || !updateAvailable || updateDownloaded} onClick={() => save("DOWNLOADED")}>Download Update</button>
        {updateDownloaded && <button className="primary-button" disabled={!canManage} onClick={() => save("INSTALL_READY_FUTURE")}>Install Update</button>}
        {updateAvailable && <button className="secondary-button" disabled={!canManage} onClick={() => setMessage("Reminder saved for this session.")}>Remind Me Later</button>}
      </div>
    </ModuleCard>
  );
}

function SyncSettingsSection({
  backendHealth,
  canManage,
  localDbStatus,
  onQueueSyncTest,
  onReload,
  onRetrySync,
  onRunSync,
  syncMessage,
  syncSettings,
  syncStatus,
  user,
}) {
  const [draft, setDraft] = useState(syncSettings || {});
  const [statusMessage, setStatusMessage] = useState("");
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
  const pending = Number(syncStatus?.pendingOperations ?? draft.pending_count ?? 0);
  const failed = Number(syncStatus?.failedOperations || 0);
  const conflicts = Number(syncStatus?.conflictOperations || 0);
  const backendOnline = backendHealth?.online === true || syncStatus?.online === true;
  const syncTotal = Number(syncStatus?.syncProgressTotal || pending || 0);
  const syncDone = Number(syncStatus?.syncProgressDone || 0);
  const autoStatus = backendHealth?.online === false
    ? "Offline - backend unreachable"
    : ["AUTHORIZATION", "DEVICE_AUTHORIZATION"].includes(syncStatus?.lastFailureKind)
      ? "Authorisation required"
      : conflicts > 0
        ? "Conflict"
        : syncStatus?.syncing
          ? `Online - syncing ${syncDone} of ${syncTotal}`
          : backendOnline && pending > 0
            ? `Online - ${pending} changes pending`
            : backendOnline
              ? "Online - all changes synced"
              : "Backend status not checked";
  const nativeDbLabel = localDbStatus?.available
    ? localDbStatus.initialized ? "Local SQLite Ready" : "Local SQLite Error"
    : "Browser Mode";
  const lastSync = syncStatus?.lastSuccessfulSyncAt || draft.last_sync_at;
  const lastPush = syncStatus?.lastPushAt;
  const lastPull = syncStatus?.lastPullAt;
  return (
    <ModuleCard eyebrow="Sync Settings" title="Offline Sync Engine" subtitle="Local outbox, idempotent cloud push, cursor pull and conflict status are active for Phase 2 foundation entities.">
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric label="Auto Sync Status" value={autoStatus} featured />
        <SummaryMetric label="Pending Queue" value={pending} />
        <SummaryMetric label="Failed" value={failed} />
        <SummaryMetric label="Conflicts" value={conflicts} />
        <SummaryMetric label="Last Sync Time" value={lastSync ? new Date(lastSync).toLocaleString("en-IN") : "Not synced"} />
        <SummaryMetric label="Local Database" value={nativeDbLabel} />
      </div>
      {(statusMessage || syncMessage || syncStatus?.lastError) && <p className="form-note">{syncMessage || statusMessage || syncStatus?.lastError}</p>}
      <div className="form-grid supplier-form-grid">
        <Field label="Device ID"><input disabled value={draft.device_id || "LOCAL-STORE"} /></Field>
        <Field label="Device Display Name"><input disabled={!canManage} value={draft.device_display_name || ""} onChange={(event) => setDraft({ ...draft, device_display_name: event.target.value })} /></Field>
        <Field label="Local SQLite Path"><input disabled value={localDbStatus?.databasePath || "Available in FroozERP desktop app"} /></Field>
        <Field label="Local Schema Version"><input disabled value={localDbStatus?.schemaVersion || "Not initialized"} /></Field>
        <Field label="Last Push"><input disabled value={lastPush ? new Date(lastPush).toLocaleString("en-IN") : "Not pushed"} /></Field>
        <Field label="Last Pull"><input disabled value={lastPull ? new Date(lastPull).toLocaleString("en-IN") : "Not pulled"} /></Field>
        <Field label="Settings API Base"><input disabled value={backendHealth?.apiUrl || API_URL} /></Field>
        <Field label="Sync Worker API Base"><input disabled value={syncStatus?.apiUrl || API_URL} /></Field>
        <Field label="Backend Health URL"><input disabled value={backendHealth?.url || `${API_URL}/api/health`} /></Field>
        <Field label="Last Sync Failure"><input disabled value={syncStatus?.lastError || backendHealth?.message || "None"} /></Field>
        <Field label="Current Cursor"><input disabled value={syncStatus?.currentCursor || "0"} /></Field>
        <label className="check-field"><input checked={draft.sync_enabled === true} disabled type="checkbox" /><span>Phase 2 sync foundation enabled for approved native devices</span></label>
        <Field label="Notes"><textarea disabled value={draft.notes || "Cloud sync foundation is active for reference data and safe test entities."} /></Field>
      </div>
      {localDbStatus?.error && <p className="form-note stock-low">{localDbStatus.error}</p>}
      <p className="form-note">Native FroozERP uses local-first POS for selected-lot sales, queues sync operations locally and pushes them when the backend is reachable. Browser mode remains online-first.</p>
      <div className="toolbar-actions">
        <button className="primary-button" disabled={!canManage} onClick={save}>Save Device Name</button>
        <button className="secondary-button" disabled={!canManage || !onRunSync} onClick={onRunSync}>Sync Now</button>
        <button className="secondary-button" disabled={!canManage || !onRetrySync} onClick={onRetrySync}>Retry Failed</button>
        <button className="secondary-button" disabled={!canManage || !onQueueSyncTest} onClick={onQueueSyncTest}>Queue Safe Test</button>
      </div>
    </ModuleCard>
  );
}

function SecurityDevicesSection({ activationCodes, branches, canManage, counters, devices, onReload, user }) {
  const [generatedCode, setGeneratedCode] = useState("");
  const [codeDraft, setCodeDraft] = useState({ code_label: "Counter device activation", expires_in_hours: 24, branch_id: "1", counter_id: "" });
  const deviceAction = async (device, action) => {
    try {
      await axios.put(`${API_URL}/settings/devices/${encodeURIComponent(device.device_id)}`, {
        action,
        updated_by: user.id,
        device_name: device.device_name,
        assigned_branch_id: device.assigned_branch_id || 1,
        assigned_counter_id: device.assigned_counter_id || null,
      });
      await onReload();
      alert(`Device ${action.toLowerCase()} saved`);
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update device"));
    }
  };
  const generateCode = async () => {
    try {
      const response = await axios.post(`${API_URL}/settings/activation-codes`, {
        ...codeDraft,
        created_by: user.id,
      });
      setGeneratedCode(response.data.code);
      await onReload();
      alert("Activation code generated. Share it only with the device being approved.");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to generate activation code"));
    }
  };
  const revokeCode = async (code) => {
    try {
      await axios.put(`${API_URL}/settings/activation-codes/${code.id}/revoke`, { updated_by: user.id });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to revoke activation code"));
    }
  };
  return (
    <ModuleCard eyebrow="Security" title="Authorized Devices" subtitle="Only approved browsers can use FroozERP after login. New devices stay pending until approved or activated by one-time code.">
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric featured label="Approved Devices" value={devices.filter((device) => device.status === "APPROVED").length} />
        <SummaryMetric label="Pending Requests" value={devices.filter((device) => device.status === "PENDING").length} />
        <SummaryMetric label="Activation Codes" value={activationCodes.filter((code) => code.status === "ACTIVE").length} />
      </div>
      <DataTable headers={["Device", "Type", "Branch / Counter", "Status", "Last Active", "Actions"]}>
        {devices.map((device) => (
          <tr key={device.device_id}>
            <td className="primary-cell">{device.device_name}<small className="cell-note">{device.device_id}</small></td>
            <td>{device.device_type || "Browser"}</td>
            <td>{device.branch_name || "Main Branch"}<small className="cell-note">{device.counter_name || "No counter assigned"}</small></td>
            <td><span className={device.status === "APPROVED" ? "stock-ok" : device.status === "PENDING" ? "origin-rate" : "stock-low"}>{device.status}</span></td>
            <td>{device.last_active_at ? new Date(device.last_active_at).toLocaleString("en-IN") : "Not active yet"}</td>
            <td>
              <div className="button-row table-actions-row">
                <button className="table-action" disabled={!canManage || device.status === "APPROVED"} onClick={() => deviceAction(device, "APPROVE")}>Approve</button>
                <button className="secondary-button" disabled={!canManage} onClick={() => deviceAction(device, "RENAME")}>Save</button>
                <button className="remove-button" disabled={!canManage} onClick={() => deviceAction(device, device.status === "PENDING" ? "REJECT" : "DISABLE")}>{device.status === "PENDING" ? "Reject" : "Disable"}</button>
              </div>
            </td>
          </tr>
        ))}
        {devices.length === 0 && <tr><td colSpan="6" className="empty-cell">No device requests yet.</td></tr>}
      </DataTable>
      <div className="form-grid supplier-form-grid">
        <Field label="Activation Label"><input disabled={!canManage} value={codeDraft.code_label} onChange={(event) => setCodeDraft({ ...codeDraft, code_label: event.target.value })} /></Field>
        <Field label="Expires In Hours"><input disabled={!canManage} min="1" type="number" value={codeDraft.expires_in_hours} onChange={(event) => setCodeDraft({ ...codeDraft, expires_in_hours: event.target.value })} /></Field>
        <Field label="Branch">
          <select disabled={!canManage} value={codeDraft.branch_id} onChange={(event) => setCodeDraft({ ...codeDraft, branch_id: event.target.value })}>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_name}</option>)}
          </select>
        </Field>
        <Field label="Counter Optional">
          <select disabled={!canManage} value={codeDraft.counter_id} onChange={(event) => setCodeDraft({ ...codeDraft, counter_id: event.target.value })}>
            <option value="">No counter limit</option>
            {counters.map((counter) => <option key={counter.id} value={counter.id}>{counter.counter_name}</option>)}
          </select>
        </Field>
      </div>
      <div className="button-row">
        <button className="primary-button" disabled={!canManage} onClick={generateCode}>Generate Activation Code</button>
        {generatedCode && <span className="batch-id">New Code: {generatedCode}</span>}
      </div>
      <DataTable headers={["Label", "Branch", "Counter", "Expires", "Status", "Used By", "Actions"]}>
        {activationCodes.map((code) => (
          <tr key={code.id}>
            <td className="primary-cell">{code.code_label || "Activation Code"}</td>
            <td>{code.branch_name || "Any"}</td>
            <td>{code.counter_name || "Any"}</td>
            <td>{code.expires_at ? new Date(code.expires_at).toLocaleString("en-IN") : "-"}</td>
            <td><span className={code.status === "ACTIVE" ? "stock-ok" : "stock-low"}>{code.status}</span></td>
            <td>{code.used_by_device_id || "-"}</td>
            <td><button className="remove-button" disabled={!canManage || code.status !== "ACTIVE"} onClick={() => revokeCode(code)}>Revoke</button></td>
          </tr>
        ))}
      </DataTable>
    </ModuleCard>
  );
}

function BranchCounterSettings({ branches, canManage, counters, onReload, user }) {
  const [branchDraft, setBranchDraft] = useState({ branch_name: "", address: "", phone_number: "", gst_number: "", active: true });
  const [counterDraft, setCounterDraft] = useState({ branch_id: "1", counter_name: "", counter_type: "RETAIL_COUNTER", active: true });
  const addBranch = async () => {
    try {
      await axios.post(`${API_URL}/settings/branches`, { ...branchDraft, updated_by: user.id });
      setBranchDraft({ branch_name: "", address: "", phone_number: "", gst_number: "", active: true });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save branch"));
    }
  };
  const addCounter = async () => {
    try {
      await axios.post(`${API_URL}/settings/counters`, { ...counterDraft, updated_by: user.id });
      setCounterDraft({ branch_id: "1", counter_name: "", counter_type: "RETAIL_COUNTER", active: true });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save counter"));
    }
  };
  return (
    <ModuleCard eyebrow="Multi-Branch Foundation" title="Branch & Counter Master" subtitle="Future-ready branch/counter structure. Current store remains Main Branch unless more branches are added.">
      <div className="form-grid supplier-form-grid">
        <Field label="Branch Name"><input disabled={!canManage} value={branchDraft.branch_name} onChange={(event) => setBranchDraft({ ...branchDraft, branch_name: event.target.value })} /></Field>
        <Field label="Phone"><input disabled={!canManage} value={branchDraft.phone_number} onChange={(event) => setBranchDraft({ ...branchDraft, phone_number: event.target.value })} /></Field>
        <Field label="GST Number"><input disabled={!canManage} value={branchDraft.gst_number} onChange={(event) => setBranchDraft({ ...branchDraft, gst_number: event.target.value })} /></Field>
        <Field label="Address"><input disabled={!canManage} value={branchDraft.address} onChange={(event) => setBranchDraft({ ...branchDraft, address: event.target.value })} /></Field>
        <button className="primary-button" disabled={!canManage || !branchDraft.branch_name.trim()} onClick={addBranch}>Add Branch</button>
      </div>
      <DataTable headers={["Branch", "Address", "Phone", "GST", "Status"]}>
        {branches.map((branch) => <tr key={branch.id}><td className="primary-cell">{branch.branch_name}</td><td>{branch.address || branch.location || "-"}</td><td>{branch.phone_number || "-"}</td><td>{branch.gst_number || "-"}</td><td><span className={branch.active !== false ? "stock-ok" : "stock-low"}>{branch.active !== false ? "Active" : "Inactive"}</span></td></tr>)}
      </DataTable>
      <div className="form-grid supplier-form-grid">
        <Field label="Branch">
          <select disabled={!canManage} value={counterDraft.branch_id} onChange={(event) => setCounterDraft({ ...counterDraft, branch_id: event.target.value })}>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_name}</option>)}
          </select>
        </Field>
        <Field label="Counter Name"><input disabled={!canManage} value={counterDraft.counter_name} onChange={(event) => setCounterDraft({ ...counterDraft, counter_name: event.target.value })} /></Field>
        <Field label="Counter Type">
          <select disabled={!canManage} value={counterDraft.counter_type} onChange={(event) => setCounterDraft({ ...counterDraft, counter_type: event.target.value })}>
            <option value="RETAIL_COUNTER">Retail Counter</option>
            <option value="OWNER_DASHBOARD">Owner Dashboard</option>
            <option value="BACK_OFFICE">Back Office</option>
          </select>
        </Field>
        <button className="primary-button" disabled={!canManage || !counterDraft.counter_name.trim()} onClick={addCounter}>Add Counter</button>
      </div>
      <DataTable headers={["Counter", "Branch", "Type", "Status"]}>
        {counters.map((counter) => <tr key={counter.id}><td className="primary-cell">{counter.counter_name}</td><td>{counter.branch_name || "-"}</td><td>{counter.counter_type}</td><td><span className={counter.active !== false ? "stock-ok" : "stock-low"}>{counter.active !== false ? "Active" : "Inactive"}</span></td></tr>)}
      </DataTable>
    </ModuleCard>
  );
}

function BackupSettings({ backupLogs = [], backupSettings, canManage, onReload, user }) {
  const [draft, setDraft] = useState({
    auto_backup_enabled: backupSettings?.auto_backup_enabled !== false,
    backup_on_shutdown: backupSettings?.backup_on_shutdown !== false,
    daily_backup_time: backupSettings?.daily_backup_time || "23:59",
    keep_last_backups: backupSettings?.keep_last_backups || 30,
    backup_location: backupSettings?.backup_location || "",
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/backup`, { ...draft, updated_by: user.id });
      await onReload();
      alert("Backup settings saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save backup settings"));
    }
  };
  const backupNow = async (backupType = "Manual") => {
    setBusy(true);
    try {
      const response = await axios.post(`${API_URL}/settings/backup-now`, { created_by: user.id, backup_type: backupType });
      await onReload();
      alert(`Backup created: ${response.data.backup_file_name}`);
    } catch (error) {
      alert(getErrorMessage(error, "Backup failed"));
    } finally {
      setBusy(false);
    }
  };
  const safeShutdown = async () => {
    if (!window.confirm("Run shutdown backup now? After success, close the server window manually.")) return;
    setBusy(true);
    try {
      const response = await axios.post(`${API_URL}/settings/safe-shutdown`, { created_by: user.id });
      await onReload();
      alert(response.data.message || "Backup completed. You may now close the server window.");
    } catch (error) {
      alert(getErrorMessage(error, "Safe shutdown backup failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModuleCard eyebrow="Backup & Restore" title="Auto Backup and Safe Shutdown" subtitle="Manual, scheduled and shutdown backup workflow. Restore is prepared but kept disabled until verified.">
      <div className="purchase-summary-grid">
        <SummaryMetric label="Auto Backup" value={draft.auto_backup_enabled ? "ON" : "OFF"} featured />
        <SummaryMetric label="Backup on Shutdown" value={draft.backup_on_shutdown ? "ON" : "OFF"} />
        <SummaryMetric label="Daily Backup Time" value={draft.daily_backup_time} />
        <SummaryMetric label="Keep Backups" value={draft.keep_last_backups} />
      </div>
      <div className="form-grid supplier-form-grid">
        <label className="check-field"><input checked={draft.auto_backup_enabled} disabled={!canManage} type="checkbox" onChange={(event) => setDraft({ ...draft, auto_backup_enabled: event.target.checked })} /><span>Auto Backup ON/OFF</span></label>
        <label className="check-field"><input checked={draft.backup_on_shutdown} disabled={!canManage} type="checkbox" onChange={(event) => setDraft({ ...draft, backup_on_shutdown: event.target.checked })} /><span>Backup on Shutdown</span></label>
        <Field label="Daily Backup Time"><input disabled={!canManage} type="time" value={draft.daily_backup_time} onChange={(event) => setDraft({ ...draft, daily_backup_time: event.target.value })} /></Field>
        <Field label="Keep Last X Backups"><input disabled={!canManage} min="1" type="number" value={draft.keep_last_backups} onChange={(event) => setDraft({ ...draft, keep_last_backups: event.target.value })} /></Field>
        <Field label="Backup Location"><input disabled={!canManage} value={draft.backup_location} onChange={(event) => setDraft({ ...draft, backup_location: event.target.value })} /></Field>
      </div>
      <div className="button-row">
        <button className="primary-button" disabled={!canManage || busy} onClick={() => backupNow("Manual")}>Backup Now</button>
        <button className="secondary-button" disabled={!canManage || busy} onClick={save}>Save Backup Settings</button>
        <button className="secondary-button" disabled={!canManage || busy} onClick={safeShutdown}>Close Software Safely</button>
        <button className="remove-button" disabled>Restore Prepared - Disabled</button>
      </div>
      <p className="form-note">Restore requires Owner permission and remains disabled until backup verification testing is completed.</p>
      <DataTable headers={["File", "Type", "Size", "Started", "Completed", "Status", "Error"]}>
        {backupLogs.map((log) => (
          <tr key={log.id}>
            <td className="primary-cell">{log.backup_file_name || "-"}<small className="cell-note">{log.backup_path || "-"}</small></td>
            <td>{log.backup_type}</td>
            <td>{Number(log.backup_size || 0).toLocaleString("en-IN")} bytes</td>
            <td>{log.started_at ? new Date(log.started_at).toLocaleString("en-IN") : "-"}</td>
            <td>{log.completed_at ? new Date(log.completed_at).toLocaleString("en-IN") : "-"}</td>
            <td><span className={log.status === "SUCCESS" ? "stock-ok" : log.status === "FAILED" ? "stock-low" : "origin-rate"}>{log.status}</span></td>
            <td>{log.error_message || "-"}</td>
          </tr>
        ))}
      </DataTable>
    </ModuleCard>
  );
}

function SystemInfoSection({ systemInfo }) {
  const device = systemInfo.currentDevice || {};
  const branch = systemInfo.currentBranch || {};
  const backup = systemInfo.lastBackup || {};
  const androidUrl = systemInfo.lanFrontendUrl || (systemInfo.serverIp ? `http://${systemInfo.serverIp}:5173` : "-");
  return (
    <ModuleCard eyebrow="System Info" title="Server, Network and Device Status" subtitle="Use the LAN URL from another device on the same shop network.">
      <section className="about-frooz-panel">
        <BrandLogo />
        <div>
          <span className="eyebrow">About FroozERP</span>
          <h3>{APP_DISPLAY_NAME}</h3>
          <p>By {APP_COMPANY}</p>
          <small>Version {APP_VERSION} - Device {device.device_id || "Not registered"} - Platform {device.device_type || "Windows/Desktop or Browser"}</small>
        </div>
      </section>
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric featured label="Backend" value={systemInfo.backendStatus || "Unknown"} />
        <SummaryMetric label="Database" value={systemInfo.databaseStatus || "Unknown"} />
        <SummaryMetric label="Server IP" value={systemInfo.serverIp || "-"} />
        <SummaryMetric label="Device Status" value={device.status || "Not registered"} />
      </div>
      <DataTable headers={["Item", "Value"]}>
        <tr><td>Software Version</td><td>{systemInfo.softwareVersion || APP_VERSION}</td></tr>
        <tr><td>Display Branding</td><td>{APP_DISPLAY_NAME}</td></tr>
        <tr><td>Company</td><td>{APP_COMPANY}</td></tr>
        <tr><td>LAN API URL</td><td>{systemInfo.lanApiUrl || "-"}</td></tr>
        <tr><td>LAN Frontend URL</td><td>{systemInfo.lanFrontendUrl || "-"}</td></tr>
        <tr><td>Android Chrome URL</td><td>{androidUrl}</td></tr>
        <tr><td>Current Device</td><td>{device.device_name || "-"} ({device.device_id || "-"})</td></tr>
        <tr><td>Current Device Type</td><td>{device.device_type || "Browser"}</td></tr>
        <tr><td>Current Branch</td><td>{branch.branch_name || "Main Branch"}</td></tr>
        <tr><td>Current Counter</td><td>{device.counter_name || device.assigned_counter_id || "Not assigned"}</td></tr>
        <tr><td>Last Backup</td><td>{backup.completed_at ? new Date(backup.completed_at).toLocaleString("en-IN") : "Not recorded"}</td></tr>
        <tr><td>Backup Location</td><td>{systemInfo.backupLocation || "-"}</td></tr>
      </DataTable>
      <section className="android-help-card">
        <span className="eyebrow">Android Connection Guide</span>
        <ol>
          <li>Connect the Android phone or tablet to the same Wi-Fi as the FroozERP server computer.</li>
          <li>Open Chrome and enter <strong>{androidUrl}</strong>.</li>
          <li>Login with your FroozERP user. If device approval appears, approve it from an already approved Owner device.</li>
          <li>For counter tablets, assign the device as Retail Counter Tablet from Authorized Devices.</li>
          <li>Use Chrome menu → Add to Home screen to install the FroozERP shortcut.</li>
        </ol>
        <p>Android devices use the same backend and database. No separate phone/tablet database is created.</p>
      </section>
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
    .map(([rowId, value]) => {
      const rate = rates.find((item) => String(item.id) === String(rowId));
      return rate ? {
        product_id: Number(rate.product_id || rate.id),
        inventory_batch_id: rate.inventory_batch_id || null,
        product_name: rate.product_name,
        lot_name: rate.lot_name,
        lot_size: rate.lot_size,
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
      inventory_batch_id: update.inventory_batch_id || null,
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
          "Product", "Lot", "Size", "Origin", "Current Lot Sale Rate", "Suggested Rate", "New Rate", "Latest Purchase Cost", "Stock", "Pending Bill Stock", "Margin %", "Updated", "Updated By",
        ]}>
          {filteredRates.map((rate) => {
            const sellingRate = Number(draftRates[rate.id] || rate.selling_rate);
            const cost = Number(rate.latest_effective_cost || 0);
            const margin = sellingRate > 0 ? ((sellingRate - cost) / sellingRate) * 100 : 0;
            return (
              <tr key={rate.id}>
                <td><input checked={Boolean(selectedSuggested[rate.id])} type="checkbox" onChange={(event) => toggleSuggestedRate(rate, event.target.checked)} /></td>
                <td className="primary-cell">{rate.product_name}<small className="cell-note">{rate.category}</small></td>
                <td>{rate.lot_name || (rate.inventory_batch_id ? `Lot #${rate.inventory_batch_id}` : "Product default")}</td>
                <td>{rate.lot_size || "-"}</td>
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
                    <td className="primary-cell">{update.product_name}<small className="cell-note">{[update.lot_name, update.lot_size].filter(Boolean).join(" / ") || "Product default"}</small></td>
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

const currentDateTimeLocal = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

function PosBilling({ canManualRateOverride = false, canPosDateOverride = false, customers = [], deviceInfo = {}, discountRules = [], lotDiscounts = [], inventory, onInvoice, onSaved, paymentSettings = {}, posSettings = {}, printSettings = {}, products, saleRateSettings = {}, syncInBackground, user }) {
  const [search, setSearch] = useState("");
  const [barcode, setBarcode] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [cart, setCart] = useState([]);
  const [paymentMode, setPaymentMode] = useState("CASH");
  const [quantityMode, setQuantityMode] = useState(posSettings.enable_weighing_scale ? "SCALE" : "MANUAL");
  const [scaleMessage, setScaleMessage] = useState("");
  const [mixedPayments, setMixedPayments] = useState({ CASH: "", UPI: "", CARD: "", BANK_TRANSFER: "" });
  const [customer, setCustomer] = useState({ account_id: "", name: "", mobile: "", notes: "" });
  const [creditInfo, setCreditInfo] = useState({ due_date: "", remarks: "" });
  const [billDateTime, setBillDateTime] = useState(currentDateTimeLocal);
  const [saving, setSaving] = useState(false);
  const [lastInvoice, setLastInvoice] = useState(null);
  const searchRef = useRef(null);
  const barcodeRef = useRef(null);
  const quantityRefs = useRef({});

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const effectiveQuantityMode = posSettings.enable_weighing_scale ? quantityMode : "MANUAL";
  const lotSelectionMode = String(saleRateSettings.pos_lot_selection_mode || "ASK_MULTIPLE").toUpperCase();

  const stockByProduct = useMemo(
    () => inventory.reduce((stock, batch) => {
      stock.set(batch.product_id, (stock.get(batch.product_id) || 0) + Number(batch.remaining_qty || 0));
      return stock;
    }, new Map()),
    [inventory]
  );

  const lotsByProduct = useMemo(
    () => inventory.reduce((lots, batch) => {
      if (Number(batch.remaining_qty || 0) <= 0) return lots;
      const rows = lots.get(batch.product_id) || [];
      rows.push(batch);
      lots.set(batch.product_id, rows);
      return lots;
    }, new Map()),
    [inventory]
  );

  const costByProduct = useMemo(
    () => inventory.reduce((costs, batch) => {
      const current = costs.get(batch.product_id);
      const cost = Number(batch.effective_cost_per_unit || batch.purchase_rate || 0);
      return costs.set(batch.product_id, current === undefined ? cost : Math.max(current, cost));
    }, new Map()),
    [inventory]
  );

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matchedProducts = (query
      ? products.filter((product) => product.product_name.toLowerCase().includes(query))
      : products
    ).slice(0, 8);
    return matchedProducts.flatMap((product) => {
      const lots = lotsByProduct.get(product.id) || [];
      if (lotSelectionMode === "AUTO_FIFO") return [{ key: `product-${product.id}`, product, lot: null }];
      if (lots.length <= 1 && lotSelectionMode !== "MANUAL") return [{ key: `product-${product.id}`, product, lot: lots[0] || null }];
      return lots.map((lot) => ({ key: `lot-${lot.id}`, product, lot }));
    }).slice(0, 12);
  }, [lotSelectionMode, lotsByProduct, products, search]);

  const totals = useMemo(() => {
    const gross = cart.reduce((sum, item) => sum + item.quantity * Number(item.selling_rate), 0);
    const itemDiscount = cart.reduce((sum, item) => sum + Number(item.discount_amount || 0), 0);
    const subtotalAfterItemDiscounts = Math.max(gross - itemDiscount, 0);
    const discountRule = saleRateSettings.bill_level_slab_discount_enabled === false ? null : getMatchingDiscountRule(discountRules, gross, paymentMode);
    const invoiceDiscountAmount = Math.min(calculateDiscountFromRule(discountRule, gross), subtotalAfterItemDiscounts);
    return {
      gross,
      itemDiscount,
      invoiceDiscount: invoiceDiscountAmount,
      discount: itemDiscount + invoiceDiscountAmount,
      total: Math.max(gross - itemDiscount - invoiceDiscountAmount, 0),
      itemCount: cart.reduce((sum, item) => sum + Number(item.quantity), 0),
      discountRule,
    };
  }, [cart, discountRules, paymentMode, saleRateSettings.bill_level_slab_discount_enabled]);

  const getLotLabel = (lot) => lot ? [lot.lot_name || lot.batch_no, lot.lot_size].filter(Boolean).join(" / ") : "Auto FIFO";
  const getCompactLotName = (lot) => {
    const raw = String(lot?.lot_name || lot?.batch_no || "").trim();
    if (!raw) return "Auto FIFO";
    const parts = raw.split("-");
    if (parts.length >= 3 && /^\d{8,}$/.test(parts[1])) {
      return `${parts[0]}-${parts[parts.length - 1]}`;
    }
    return raw.length > 22 ? `${raw.slice(0, 18)}...` : raw;
  };

  const getActiveLotDiscount = (lotId) => {
    if (!lotId) return null;
    const today = toDateKey(new Date());
    return [...lotDiscounts]
      .filter((discount) =>
        Number(discount.inventory_batch_id) === Number(lotId) &&
        discount.active !== false &&
        (!discount.start_date || toDateKey(discount.start_date) <= today) &&
        (!discount.end_date || toDateKey(discount.end_date) >= today)
      )
      .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0] || null;
  };

  const applyLotDiscount = (baseRate, quantity, discount) => {
    const rate = Number(baseRate || 0);
    const qty = Number(quantity || 0);
    if (!discount) return { sellingRate: rate, discountAmount: 0, discountPerUnit: 0 };
    const value = Number(discount.discount_value || 0);
    if (discount.discount_type === "SPECIAL_RATE") {
      return {
        sellingRate: value,
        discountAmount: 0,
        discountPerUnit: 0,
      };
    }
    const discountPerUnit = discount.discount_type === "PERCENTAGE"
      ? roundUi(rate * value / 100)
      : Math.min(value, rate);
    return {
      sellingRate: rate,
      discountAmount: roundUi(discountPerUnit * qty),
      discountPerUnit,
    };
  };

  const addProduct = (product, selectedLot = null) => {
    const productLots = lotsByProduct.get(product.id) || [];
    if (!selectedLot && productLots.length > 1 && lotSelectionMode !== "AUTO_FIFO") {
      alert("Please select lot for this item.");
      return;
    }
    const lot = selectedLot || (lotSelectionMode === "AUTO_FIFO" ? null : productLots[0]) || null;
    const cartKey = `${product.id}-${lot?.id || "FIFO"}`;
    const availableStock = lot ? Number(lot.remaining_qty || 0) : (stockByProduct.get(product.id) || 0);
    const currentItem = cart.find((item) => item.cart_key === cartKey);
    const nextQuantity = Number(currentItem?.quantity || 0) + 1;
    if (availableStock < nextQuantity) {
      alert(lot ? "Selected lot does not have enough stock." : `Insufficient stock for ${product.product_name}. Available quantity: ${availableStock}`);
      return;
    }
    const lotSaleRate = Number(lot?.temporary_sale_rate || 0);
    const defaultRate = lotSaleRate > 0 ? lotSaleRate : Number(product.selling_rate);
    const lotDiscount = getActiveLotDiscount(lot?.id);
    const discounted = applyLotDiscount(defaultRate, nextQuantity, lotDiscount);

    setCart((items) => currentItem
      ? items.map((item) => item.cart_key === cartKey ? { ...item, quantity: nextQuantity, discount_amount: roundUi(Number(item.lot_discount_per_unit || 0) * nextQuantity) } : item)
      : [...items, {
        cart_key: cartKey,
        product_id: product.id,
        inventory_batch_id: lot?.id || null,
        product_name: product.product_name,
        lot_name: lot?.lot_name || lot?.batch_no || "",
        lot_size: lot?.lot_size || "",
        unit: product.unit,
        available_qty: availableStock,
        default_selling_rate: defaultRate,
        selling_rate: discounted.sellingRate,
        quantity: 1,
        discount_amount: discounted.discountAmount,
        lot_discount_id: lotDiscount?.id || null,
        lot_discount_type: lotDiscount?.discount_type || null,
        lot_discount_value: lotDiscount ? Number(lotDiscount.discount_value || 0) : 0,
        lot_discount_per_unit: discounted.discountPerUnit,
      }]
    );
    setSearch("");
    setHighlightedIndex(0);
    setTimeout(() => {
      const input = quantityRefs.current[cartKey];
      input?.focus();
      input?.select();
    }, 0);
  };

  const updateCartItem = (cartKey, field, value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return;
    if (field === "selling_rate" && !canManualRateOverride) {
      alert("You do not have permission to change sale rate.");
      return;
    }
    const currentItem = cart.find((item) => item.cart_key === cartKey);
    if (field === "quantity" && currentItem && number > Number(currentItem.available_qty || 0)) {
      alert(currentItem.inventory_batch_id ? "Selected lot does not have enough stock." : `Only ${currentItem.available_qty || 0} units are available.`);
      return;
    }
    setCart((items) => items.map((item) => {
      if (item.cart_key !== cartKey) return item;
      if (field === "quantity" && item.lot_discount_id) {
        return { ...item, quantity: value, discount_amount: roundUi(Number(item.lot_discount_per_unit || 0) * number) };
      }
      return { ...item, [field]: value };
    }));
  };

  const completeQuantityEntry = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    setSearch("");
    setHighlightedIndex(0);
    searchRef.current?.focus();
  };

  const removeCartItem = (productId) => {
    setCart((items) => items.filter((item) => item.cart_key !== productId));
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
      setCustomer({ account_id: "", name: "", mobile: "", notes: "" });
      return;
    }
    setCustomer({
      account_id: selected.id,
      name: selected.customer_name || "",
      mobile: selected.mobile_number || "",
      notes: selected.notes || "",
    });
  };

  const newSyncId = (prefix) => {
    const id = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${id}`;
  };

  const buildLocalSalePayload = ({ payments, selectedBillDate, dateOverrideReason }) => {
    const invoiceGlobalId = newSyncId("invoice");
    const offlineInvoiceRef = `OFF-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
    return {
      operation_id: newSyncId("op"),
      invoice_global_id: invoiceGlobalId,
      offline_invoice_ref: offlineInvoiceRef,
      branch_id: String(user.branch_id || 1),
      device_id: deviceInfo.device_id || newSyncId("device"),
      user_id: String(user.id || ""),
      customer,
      bill_date: selectedBillDate,
      bill_datetime: billDateTime,
      payment_mode: paymentMode,
      gross_total: Number(totals.gross || 0),
      item_discount_total: Number(totals.itemDiscount || 0),
      bill_discount_total: Number(totals.invoiceDiscount || 0),
      tax_total: 0,
      net_total: Number(totals.total || 0),
      status: "COMPLETED",
      sync_status: "pending",
      entity_version: 1,
      date_override_reason: dateOverrideReason,
      items: cart.map((item) => {
        const itemGlobalId = newSyncId("line");
        const stockMovementId = newSyncId("stock");
        return {
          item_global_id: itemGlobalId,
          invoice_global_id: invoiceGlobalId,
          product_id: String(item.product_id),
          product_name: item.product_name,
          lot_id: item.inventory_batch_id ? String(item.inventory_batch_id) : "",
          lot_name: item.lot_name || "",
          lot_size: item.lot_size || "",
          quantity: Number(item.quantity),
          unit: item.unit || "",
          rate: Number(item.selling_rate),
          discount: Number(item.discount_amount || 0),
          amount: roundUi(Number(item.quantity) * Number(item.selling_rate) - Number(item.discount_amount || 0)),
          stock_movement_id: stockMovementId,
          available_qty: Number(item.available_qty || 0),
          selling_rate: Number(item.selling_rate),
          discount_amount: Number(item.discount_amount || 0),
          inventory_batch_id: item.inventory_batch_id ? Number(item.inventory_batch_id) : null,
          lot_discount_id: item.lot_discount_id || null,
          lot_discount_type: item.lot_discount_type || null,
          lot_discount_value: Number(item.lot_discount_value || 0),
        };
      }),
      payments: payments.map((payment) => ({
        posting_id: newSyncId("posting"),
        mode: payment.mode,
        amount: Number(payment.amount),
      })),
    };
  };

  const checkout = async (printAfterSave = false, confirmations = {}) => {
    if (saving && !confirmations.retry) return;
    if (cart.length === 0) {
      alert("Add at least one product before checkout.");
      return;
    }
    const today = toDateKey(new Date());
    const selectedBillDate = billDateTime ? billDateTime.slice(0, 10) : today;
    if (!canPosDateOverride && selectedBillDate !== today) {
      alert("You do not have permission to change bill date.");
      return;
    }
    const dateConfirmations = {};
    let dateOverrideReason = confirmations.date_override_reason || "";
    if (selectedBillDate < today && !confirmations.backdate_confirmed) {
      if (!window.confirm(`You are creating a backdated POS bill for ${selectedBillDate}. Continue?`)) return;
      dateOverrideReason = window.prompt("Reason for backdated bill (optional)", "Backdated POS bill created") || "Backdated POS bill created";
      dateConfirmations.backdate_confirmed = true;
    }
    if (selectedBillDate > today && !confirmations.future_date_confirmed) {
      if (!["Owner", "Admin"].includes(user.role)) {
        alert("Only Owner/Admin can confirm a future bill date.");
        return;
      }
      if (!window.confirm(`You are creating a future-dated POS bill for ${selectedBillDate}. Continue?`)) return;
      dateOverrideReason = window.prompt("Reason for future bill date (optional)", "Future-dated POS bill created") || "Future-dated POS bill created";
      dateConfirmations.future_date_confirmed = true;
    }
    if (customer.mobile && !/^\d{10,15}$/.test(customer.mobile)) {
      alert("Enter a valid customer mobile number.");
      return;
    }
    if (paymentMode === "CREDIT" && !customer.account_id) {
      if (!["Owner", "Admin"].includes(user.role)) {
        alert("Select a saved customer account for credit sale.");
        return;
      }
      if (!window.confirm("No saved customer selected. Assign this credit sale to Walk-in Customer Credit?")) return;
    }
    let zeroRateConfirmed = confirmations.zero_rate_confirmed === true;
    let belowCostConfirmed = confirmations.below_cost_confirmed === true;
    for (const item of cart) {
      const rate = Number(item.selling_rate);
      const defaultRate = Number(item.default_selling_rate ?? item.selling_rate);
      const rateChanged = roundUi(rate) !== roundUi(defaultRate);
      const discountControlledRate = item.lot_discount_type === "SPECIAL_RATE";
      if (!Number.isFinite(rate) || rate < 0) {
        alert(`Enter a valid sale rate for ${item.product_name}.`);
        return;
      }
      if (rateChanged && !discountControlledRate && !canManualRateOverride) {
        alert("You do not have permission to change sale rate.");
        return;
      }
      if (rateChanged && !discountControlledRate && rate === 0 && !zeroRateConfirmed) {
        if (!["Owner", "Admin"].includes(user.role) || !window.confirm(`Sale rate for ${item.product_name} is zero. Continue?`)) return;
        zeroRateConfirmed = true;
      }
      const estimatedCost = Number(costByProduct.get(item.product_id) || 0);
      if (rateChanged && !discountControlledRate && estimatedCost > 0 && rate < estimatedCost && !belowCostConfirmed) {
        if (!["Owner", "Admin"].includes(user.role) || !window.confirm(`This rate is below cost for ${item.product_name}. Continue?`)) return;
        belowCostConfirmed = true;
      }
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
      if (isTauriRuntime()) {
        if (cart.some((item) => !item.inventory_batch_id)) {
          alert("Desktop local-first POS requires a selected stock lot for every item.");
          return;
        }
        const localSale = buildLocalSalePayload({ payments, selectedBillDate, dateOverrideReason });
        const result = await completeLocalPosSale(localSale);
        const invoice = {
          id: localSale.invoice_global_id,
          invoice_no: localSale.offline_invoice_ref,
          offline_invoice_ref: localSale.offline_invoice_ref,
          sale_date: selectedBillDate,
          bill_datetime: billDateTime,
          customer_name: customer.name || "Walk-in Customer",
          customer_mobile: customer.mobile || "",
          payment_mode: paymentMode,
          amount: localSale.net_total,
          total_amount: localSale.net_total,
          sync_status: "pending",
          items: localSale.items.map((item) => ({
            product_id: item.product_id,
            product_name: item.product_name,
            unit: item.unit,
            quantity: item.quantity,
            selling_rate: item.rate,
            inventory_batch_id: item.inventory_batch_id,
            lot_name: item.lot_name,
            lot_size: item.lot_size,
            amount: item.amount,
            discount_amount: item.discount,
            net_amount: item.amount,
          })),
          payments: localSale.payments,
        };
        setCart([]);
        setMixedPayments({ CASH: "", UPI: "", CARD: "", BANK_TRANSFER: "" });
        setPaymentMode("CASH");
        setCustomer({ account_id: "", name: "", mobile: "", notes: "" });
        setCreditInfo({ due_date: "", remarks: "" });
        setBillDateTime(currentDateTimeLocal());
        await onSaved?.({ localSale: invoice, pendingOperations: result?.pending_operations });
        setLastInvoice(invoice);
        onInvoice(invoice);
        if (typeof syncInBackground === "function") {
          syncInBackground().catch(() => {});
        }
        if (printAfterSave || printSettings.auto_print_after_billing === true) {
          setTimeout(() => window.print(), 250);
        }
        return;
      }
      const response = await axios.post(`${API_URL}/sales`, {
        items: cart.map((item) => ({
          product_id: item.product_id,
          inventory_batch_id: item.inventory_batch_id,
          quantity: Number(item.quantity),
          selling_rate: Number(item.selling_rate),
          discount_amount: Number(item.discount_amount || 0),
          lot_discount_id: item.lot_discount_id || null,
          lot_discount_type: item.lot_discount_type || null,
          lot_discount_value: Number(item.lot_discount_value || 0),
        })),
        customer,
        invoice_discount: Number(totals.invoiceDiscount || 0),
        discount_rule_id: totals.discountRule?.id || null,
        payments,
        branch_id: user.branch_id,
        created_by: user.id,
        bill_date: selectedBillDate,
        bill_datetime: billDateTime,
        credit_due_date: paymentMode === "CREDIT" ? creditInfo.due_date || null : null,
        credit_remarks: paymentMode === "CREDIT" ? creditInfo.remarks || customer.notes || "" : "",
        date_override_reason: dateOverrideReason,
        backdate_confirmed: confirmations.backdate_confirmed || dateConfirmations.backdate_confirmed || false,
        future_date_confirmed: confirmations.future_date_confirmed || dateConfirmations.future_date_confirmed || false,
        below_cost_confirmed: belowCostConfirmed,
        zero_rate_confirmed: zeroRateConfirmed,
      });
      setCart([]);
      setMixedPayments({ CASH: "", UPI: "", CARD: "", BANK_TRANSFER: "" });
      setPaymentMode("CASH");
      setCustomer({ account_id: "", name: "", mobile: "", notes: "" });
      setCreditInfo({ due_date: "", remarks: "" });
      setBillDateTime(currentDateTimeLocal());
      await onSaved();
      setLastInvoice(response.data.sale);
      onInvoice(response.data.sale);
      if (printAfterSave || printSettings.auto_print_after_billing === true) {
        setTimeout(() => window.print(), 250);
      }
    } catch (error) {
      const responseData = error.response?.data || {};
      if (error.response?.status === 409) {
        if (responseData.requires_below_cost_confirmation && window.confirm(responseData.message || "This rate is below cost. Continue?")) {
          setSaving(false);
          setTimeout(() => checkout(printAfterSave, { ...confirmations, below_cost_confirmed: true, retry: true }), 0);
          return;
        }
        if (responseData.requires_zero_rate_confirmation && window.confirm(responseData.message || "Zero sale rate requires confirmation. Continue?")) {
          setSaving(false);
          setTimeout(() => checkout(printAfterSave, { ...confirmations, zero_rate_confirmed: true, retry: true }), 0);
          return;
        }
        if (responseData.requires_backdate_confirmation && window.confirm(responseData.message || "Backdated bill requires confirmation. Continue?")) {
          const reason = window.prompt("Reason for backdated bill (optional)", "Backdated POS bill created") || "Backdated POS bill created";
          setSaving(false);
          setTimeout(() => checkout(printAfterSave, { ...confirmations, backdate_confirmed: true, date_override_reason: reason, retry: true }), 0);
          return;
        }
        if (responseData.requires_future_date_confirmation && window.confirm(responseData.message || "Future bill date requires confirmation. Continue?")) {
          const reason = window.prompt("Reason for future bill date (optional)", "Future-dated POS bill created") || "Future-dated POS bill created";
          setSaving(false);
          setTimeout(() => checkout(printAfterSave, { ...confirmations, future_date_confirmed: true, date_override_reason: reason, retry: true }), 0);
          return;
        }
      }
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
      const selected = searchResults[highlightedIndex];
      addProduct(selected.product, selected.lot);
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
      <div className="mobile-pos-note">
        POS billing is optimized for tablet and desktop. Phone screens remain supported for quick invoice lookup and emergency billing.
      </div>
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
            {searchResults.map((option, index) => {
              const { product, lot } = option;
              const stock = lot ? Number(lot.remaining_qty || 0) : (stockByProduct.get(product.id) || 0);
              const baseRate = Number(lot?.temporary_sale_rate || product.selling_rate || 0);
              const activeDiscount = getActiveLotDiscount(lot?.id);
              const discounted = applyLotDiscount(baseRate, 1, activeDiscount);
              const rate = discounted.sellingRate;
              return (
                <button
                  className={index === highlightedIndex ? "product-result product-result-active" : "product-result"}
                  key={option.key}
                  onClick={() => addProduct(product, lot)}
                  title={lot ? `Full lot: ${getLotLabel(lot)}` : product.product_name}
                >
                  <span className="product-result-main">
                    <strong>{product.product_name}</strong>
                    <span className="product-result-meta">
                      <span>Lot: {getCompactLotName(lot)}</span>
                      <span>Size: {lot?.lot_size || product.lot_size || "Standard"}</span>
                      <span>Unit: {product.unit || "Unit"}</span>
                    </span>
                    <small>Rate: {currency.format(rate)}/{product.unit || "Unit"}{activeDiscount ? " after lot discount" : ""}</small>
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
                <thead><tr><th>Product</th><th>Lot/Size</th><th>Rate</th><th>Qty</th>{printSettings.show_item_discount_column_pos !== false && <th>Item Discount</th>}<th>Total</th><th /></tr></thead>
                <tbody>
                  {cart.map((item) => (
                    <tr key={item.cart_key}>
                      <td className="primary-cell">
                        {item.product_name}
                        <small className="cell-note">{item.available_qty || stockByProduct.get(item.product_id) || 0} {item.unit} available</small>
                      </td>
                      <td><span className="batch-id">{[item.lot_name, item.lot_size].filter(Boolean).join(" / ") || "Auto FIFO"}</span></td>
                      <td>
                        <input
                          className="table-input"
                          min="0"
                          readOnly={!canManualRateOverride}
                          step="0.01"
                          title={canManualRateOverride ? "Owner/Admin can override POS sale rate" : "You do not have permission to change sale rate"}
                          type="number"
                          value={item.selling_rate}
                          onChange={(event) => updateCartItem(item.cart_key, "selling_rate", event.target.value)}
                        />
                      </td>
                      <td><input className="table-input" min="0.001" ref={(node) => { quantityRefs.current[item.cart_key] = node; }} step="0.001" type="number" value={item.quantity} onChange={(event) => updateCartItem(item.cart_key, "quantity", event.target.value)} onKeyDown={completeQuantityEntry} /></td>
                      {printSettings.show_item_discount_column_pos !== false && <td><input className="table-input" min="0" step="0.01" type="number" value={item.discount_amount} onChange={(event) => updateCartItem(item.cart_key, "discount_amount", event.target.value)} /></td>}
                      <td className="primary-cell">{currency.format(item.quantity * item.selling_rate - Number(item.discount_amount || 0))}</td>
                      <td><button aria-label={`Remove ${item.product_name}`} className="remove-button" onClick={() => removeCartItem(item.cart_key)}><Icon name="trash" size={16} /></button></td>
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
          <Field label="Bill Date">
            <input
              disabled={!canPosDateOverride}
              type="datetime-local"
              value={billDateTime}
              onChange={(event) => setBillDateTime(event.target.value)}
            />
          </Field>
          <p className="form-note">{canPosDateOverride ? "Owner/Admin can select a previous or custom bill date." : "Bill date is locked for your role."}</p>
          <Field label="Saved Customer Account">
            <select value={customer.account_id || ""} onChange={(event) => selectCustomer(event.target.value)}>
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
              <option value="BANK_TRANSFER">Bank</option>
              <option value="CREDIT">Credit</option>
              <option value="MIXED">Mixed Payment</option>
            </select>
          </Field>
          {paymentMode === "CREDIT" && (
            <div className="credit-panel">
              <p className="form-note">Credit sale will reduce inventory now and create customer receivable. Cash Book updates only when payment is received.</p>
              <Field label="Due Date"><input type="date" value={creditInfo.due_date} onChange={(event) => setCreditInfo({ ...creditInfo, due_date: event.target.value })} /></Field>
              <Field label="Credit Remarks"><input value={creditInfo.remarks} onChange={(event) => setCreditInfo({ ...creditInfo, remarks: event.target.value })} placeholder="Optional credit note" /></Field>
            </div>
          )}
          {paymentSettings.enable_upi_qr_on_invoice && paymentSettings.business_upi_id && ["UPI", "MIXED", "BANK_TRANSFER"].includes(paymentMode) && (
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

function SaleEditModal({ canSaleDateEdit = false, deviceInfo, inventory = [], invoice, offlineMode = false, onClose, onSaved, products, user }) {
  const [items, setItems] = useState(() => (invoice.items || []).map((item) => ({
    id: item.id || item.sale_item_id,
    product_id: item.product_id,
    product_name: item.product_name,
    unit: item.unit,
    inventory_batch_id: item.inventory_batch_id || "",
    lot_name: item.lot_name || "",
    lot_size: item.lot_size || "",
    quantity: item.quantity,
    selling_rate: item.selling_rate,
    discount_amount: item.discount_amount || 0,
    lot_discount_id: item.lot_discount_id || null,
    lot_discount_type: item.lot_discount_type || null,
    lot_discount_value: item.lot_discount_value || 0,
  })));
  const [customer, setCustomer] = useState({
    account_id: invoice.customer_id || "",
    name: invoice.customer_name || "",
    mobile: invoice.customer_mobile || "",
    notes: invoice.customer_notes || "",
  });
  const [paymentMode, setPaymentMode] = useState(invoice.payment_mode === "MIXED" ? "CASH" : invoice.payment_mode || "CASH");
  const [billDate, setBillDate] = useState(toDateKey(invoice.sale_date || invoice.transaction_date || new Date()));
  const [invoiceDiscount, setInvoiceDiscount] = useState(invoice.invoice_discount_amount || 0);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const canChangeRate = ["Owner", "Admin"].includes(user.role);
  const activeLotsForProduct = (productId) => inventory.filter((lot) =>
    Number(lot.product_id) === Number(productId) &&
    Number(lot.remaining_qty ?? lot.balance_qty ?? 0) > 0 &&
    !["CANCELLED", "INACTIVE"].includes(String(lot.batch_status || "ACTIVE").toUpperCase())
  );
  const gross = items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.selling_rate || 0), 0);
  const itemDiscount = items.reduce((sum, item) => sum + Number(item.discount_amount || 0), 0);
  const netPayable = Math.max(gross - itemDiscount - Number(invoiceDiscount || 0), 0);
  const availableProducts = products.filter((product) => product.active !== false);

  const updateItem = (index, field, value) => {
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item));
  };
  const addItem = (productId) => {
    const product = products.find((item) => String(item.id) === String(productId));
    if (!product) return;
    const availableLots = activeLotsForProduct(product.id);
    const selectedLot = availableLots[0] || {};
    const lotSaleRate = Number(selectedLot.temporary_sale_rate || selectedLot.sale_rate || 0);
    setItems((current) => [...current, {
      product_id: product.id,
      product_name: product.product_name,
      unit: product.unit,
      inventory_batch_id: selectedLot.id || "",
      lot_name: selectedLot.lot_name || selectedLot.batch_no || "",
      lot_size: selectedLot.lot_size || "",
      quantity: 1,
      selling_rate: lotSaleRate > 0 ? lotSaleRate : product.selling_rate,
      discount_amount: 0,
    }]);
  };
  const changeItemProduct = (index, productId) => {
    const product = products.find((entry) => String(entry.id) === String(productId));
    if (!product) return;
    const availableLots = activeLotsForProduct(product.id);
    const selectedLot = availableLots[0] || {};
    updateItem(index, "product_id", product.id);
    updateItem(index, "product_name", product.product_name);
    updateItem(index, "unit", product.unit);
    updateItem(index, "inventory_batch_id", selectedLot.id || "");
    updateItem(index, "lot_name", selectedLot.lot_name || selectedLot.batch_no || "");
    updateItem(index, "lot_size", selectedLot.lot_size || "");
    updateItem(index, "selling_rate", Number(selectedLot.temporary_sale_rate || selectedLot.sale_rate || 0) > 0 ? Number(selectedLot.temporary_sale_rate || selectedLot.sale_rate || 0) : product.selling_rate);
  };
  const changeItemLot = (index, lotId) => {
    const lot = inventory.find((entry) => String(entry.id) === String(lotId));
    if (!lot) {
      updateItem(index, "inventory_batch_id", "");
      updateItem(index, "lot_name", "");
      updateItem(index, "lot_size", "");
      return;
    }
    updateItem(index, "inventory_batch_id", lot.id);
    updateItem(index, "lot_name", lot.lot_name || lot.batch_no || "");
    updateItem(index, "lot_size", lot.lot_size || "");
    const lotSaleRate = Number(lot.temporary_sale_rate || lot.sale_rate || 0);
    if (lotSaleRate > 0) updateItem(index, "selling_rate", lotSaleRate);
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
      const editItems = items.map((item) => ({
          id: Number(item.id || 0) || undefined,
          item_global_id: String(item.id || `sale-item-${crypto.randomUUID?.() || Date.now()}`),
          product_id: String(item.product_id),
          product_name: item.product_name || products.find((product) => String(product.id) === String(item.product_id))?.product_name || "",
          lot_id: String(item.inventory_batch_id || item.lot_id || ""),
          inventory_batch_id: String(item.inventory_batch_id || item.lot_id || ""),
          lot_name: item.lot_name || "",
          lot_size: item.lot_size || "",
          unit: item.unit || "",
          quantity: Number(item.quantity),
          rate: Number(item.selling_rate),
          selling_rate: Number(item.selling_rate),
          discount: Number(item.discount_amount || 0),
          discount_amount: Number(item.discount_amount || 0),
          amount: Math.max(Number(item.quantity || 0) * Number(item.selling_rate || 0) - Number(item.discount_amount || 0), 0),
          lot_discount_id: item.lot_discount_id || null,
          lot_discount_type: item.lot_discount_type || null,
          lot_discount_value: Number(item.lot_discount_value || 0),
          stock_movement_id: item.stock_movement_id || `stock-edit-${crypto.randomUUID?.() || Date.now()}`,
        }));
      const payload = {
        invoice_global_id: String(invoice.sale_id || invoice.id),
        items: editItems,
        customer,
        invoice_discount: Number(invoiceDiscount || 0),
        bill_discount_total: Number(invoiceDiscount || 0),
        gross_total: gross,
        item_discount_total: itemDiscount,
        tax_total: Number(invoice.tax_amount || invoice.tax_total || 0),
        net_total: netPayable,
        payments: [{ mode: paymentMode, amount: netPayable }],
        branch_id: invoice.branch_id || user.branch_id,
        user_id: String(user.id || ""),
        edited_by: user.id,
        device_id: deviceInfo?.device_id || "",
        bill_date: billDate,
        bill_datetime: `${billDate}T00:00`,
        payment_mode: paymentMode,
        reason,
      };
      const localEligible = isTauriRuntime() && (
        offlineMode ||
        invoice.sync_status ||
        String(invoice.id || invoice.sale_id || "").startsWith("invoice-") ||
        String(invoice.id || invoice.sale_id || "").startsWith("pos-invoice-")
      );
      if (localEligible) {
        const result = await editLocalPosSale(payload);
        await onSaved({ localSale: localSnapshotToInvoice(result.invoice), pendingOperations: result.pending_operations });
        alert("Invoice updated locally. Pending sync.");
      } else {
        await axios.put(`${API_URL}/sales/${invoice.id}`, {
          ...payload,
          items: editItems.map((item) => ({
            id: Number(item.id || 0) || undefined,
            product_id: Number(item.product_id),
            inventory_batch_id: Number(item.inventory_batch_id || 0) || null,
            quantity: Number(item.quantity),
            selling_rate: Number(item.selling_rate),
            discount_amount: Number(item.discount_amount || 0),
            lot_discount_id: item.lot_discount_id || null,
            lot_discount_type: item.lot_discount_type || null,
            lot_discount_value: Number(item.lot_discount_value || 0),
          })),
        });
        await onSaved();
        alert("Invoice updated");
      }
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
            <Field label="Bill Date"><input disabled={!canSaleDateEdit} type="date" value={billDate} onChange={(event) => setBillDate(event.target.value)} /></Field>
            <Field label="Customer Name"><input value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} /></Field>
            <Field label="Mobile Number"><input inputMode="numeric" value={customer.mobile} onChange={(event) => setCustomer({ ...customer, mobile: event.target.value.replace(/\D/g, "") })} /></Field>
            <Field label="Payment Mode">
              <select value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)}>
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="CARD">Card</option>
                <option value="BANK_TRANSFER">Bank Transfer</option>
                <option value="CREDIT">Credit</option>
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
          <DataTable headers={["Product", "Lot / Size", "Qty", "Rate", "Discount", "Net", ""]}>
            {items.map((item, index) => (
              <tr key={`${item.product_id}-${item.inventory_batch_id || "fifo"}-${index}`}>
                <td className="primary-cell">
                  <select className="settings-table-input" value={item.product_id} onChange={(event) => changeItemProduct(index, event.target.value)}>
                    {products.map((product) => <option key={product.id} value={product.id}>{product.product_name}</option>)}
                  </select>
                  <small className="cell-note">{item.unit}</small>
                </td>
                <td>
                  <select className="settings-table-input" value={item.inventory_batch_id || ""} onChange={(event) => changeItemLot(index, event.target.value)}>
                    <option value="">FIFO / Auto</option>
                    {activeLotsForProduct(item.product_id).map((lot) => (
                      <option key={lot.id} value={lot.id}>
                        {(lot.lot_name || lot.batch_no || `Lot #${lot.id}`)}{lot.lot_size ? ` / ${lot.lot_size}` : ""} - Avl {Number(lot.remaining_qty ?? lot.balance_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}
                      </option>
                    ))}
                    {item.inventory_batch_id && !activeLotsForProduct(item.product_id).some((lot) => String(lot.id) === String(item.inventory_batch_id)) && (
                      <option value={item.inventory_batch_id}>{[item.lot_name, item.lot_size].filter(Boolean).join(" / ") || `Lot #${item.inventory_batch_id}`} - original lot</option>
                    )}
                  </select>
                </td>
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
  if (toDateKey(oldSale.sale_date || "") !== toDateKey(newSale.sale_date || "")) lines.push(`Bill Date: ${formatDisplayDate(oldSale.sale_date)} -> ${formatDisplayDate(newSale.sale_date)}`);
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
  const receiptRef = useRef(null);
  const [exporting, setExporting] = useState(false);
  const exportReceiptPdf = async () => {
    if (!receiptRef.current) return;
    setExporting(true);
    try {
      await exportElementToPdf({
        element: receiptRef.current,
        fileName: `FroozERP_Payment_Receipt_${payment.payment_key || payment.id || toDateKey(new Date())}.pdf`,
        mode: "A4",
      });
    } catch (error) {
      alert(`Unable to export receipt PDF: ${error.message}`);
    } finally {
      setExporting(false);
    }
  };
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
            <button className="secondary-button" disabled={exporting} onClick={exportReceiptPdf}>{exporting ? "Exporting..." : "Save PDF"}</button>
            <button aria-label="Close receipt" className="remove-button" onClick={onClose}><Icon name="close" /></button>
          </div>
        </div>
        <article ref={receiptRef} className="invoice-paper print-area">
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

function InvoiceModal({ autoPrintMode = null, canCancel = false, canEdit = false, invoice, onCancel, onClose, onEdit, paymentSettings = {}, printSettings = {} }) {
  const [printMode, setPrintMode] = useState(printSettings.default_invoice_print === "A4_INVOICE" || printSettings.default_printer_type === "A4" ? "A4" : "THERMAL");
  const [upiQrDataUrl, setUpiQrDataUrl] = useState("");
  const [exporting, setExporting] = useState(false);
  const invoiceRef = useRef(null);
  const autoPrintedRef = useRef(false);
  const activePrintMode = printMode === "A4" ? "A4" : "THERMAL";
  const invoicePayments = invoice.payments || [];
  const showItemDiscountOnReceipt = printSettings.show_item_discount_column_receipt !== false;
  const showBillDiscountRow = printSettings.show_bill_discount_row_receipt !== false;
  const hideZeroDiscountRows = printSettings.hide_zero_discount_rows !== false;
  const billDiscountAmount = Number(invoice.invoice_discount_amount || 0);
  const shouldRenderBillDiscountRow = showBillDiscountRow && (billDiscountAmount > 0 || !hideZeroDiscountRows);
  const hasUpiPayment = invoice.payment_mode === "UPI" || invoice.payment_mode === "MIXED" || invoicePayments.some((payment) => (payment.mode || payment.payment_mode) === "UPI");
  const qrSizeMap = { SMALL: 110, MEDIUM: 145, LARGE: 180 };
  const qrDisplaySize = String(paymentSettings.qr_display_size || "MEDIUM").toUpperCase();
  const qrCodeWidth = activePrintMode === "THERMAL"
    ? Math.min(qrSizeMap[qrDisplaySize] || 145, printSettings.receipt_width === "58MM" ? 118 : 145)
    : (qrSizeMap[qrDisplaySize] || 145);
  const isUpiQrEnabled = paymentSettings.enable_upi_qr_on_invoice === true;
  const shouldShowUpiQr = isUpiQrEnabled && Boolean(paymentSettings.business_upi_id) && (hasUpiPayment || paymentSettings.show_upi_qr_on_all_bills === true || isUpiQrEnabled);
  const shouldShowUpiWarning = isUpiQrEnabled && !paymentSettings.business_upi_id;
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
    if (!upiPayload) {
      setUpiQrDataUrl("");
      return undefined;
    }
    QRCode.toDataURL(upiPayload, { errorCorrectionLevel: "M", margin: 1, width: qrCodeWidth })
      .then((url) => active && setUpiQrDataUrl(url))
      .catch(() => active && setUpiQrDataUrl(""));
    return () => {
      active = false;
    };
  }, [qrCodeWidth, upiPayload]);
  const invoiceDateKey = toDateKey(invoice.sale_date || invoice.transaction_date || invoice.created_at);
  const invoiceFileName = () => `FroozERP_POS_Invoice_${invoice.invoice_no || `SALE-${invoice.id}`}_${formatFileDate(invoiceDateKey)}.pdf`;
  const printWithMode = (mode) => {
    setPrintMode(mode);
    withDocumentTitle(invoiceFileName(), () => setTimeout(() => window.print(), 100));
  };
  useEffect(() => {
    if (!autoPrintMode || autoPrintedRef.current) return;
    autoPrintedRef.current = true;
    printWithMode(autoPrintMode === "A4" ? "A4" : "THERMAL");
  }, [autoPrintMode]);
  const exportInvoicePdf = async (mode = activePrintMode, save = true) => {
    setPrintMode(mode);
    setExporting(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, upiPayload && !upiQrDataUrl ? 250 : 80));
      return await exportElementToPdf({
        element: invoiceRef.current,
        fileName: invoiceFileName(),
        mode,
        receiptWidth: printSettings.receipt_width || "80MM",
        save,
      });
    } finally {
      setExporting(false);
    }
  };
  const sendWhatsApp = async () => {
    if (!invoice.customer_mobile) {
      alert("Add a customer mobile number to send this invoice on WhatsApp.");
      return;
    }
    const pdfFile = await exportInvoicePdf(activePrintMode, false);
    const message = [
      "Thank you for shopping with FEEL THE FREAKIN' FROOZ. Your invoice is ready.",
      `Invoice: ${invoice.invoice_no}`,
      `Bill Date: ${formatDisplayDate(invoiceDateKey)}`,
      `Amount: ${currency.format(Number(invoice.total_amount))}`,
      "We appreciate your business.",
    ].join("\n");
    const file = new File([pdfFile.blob], pdfFile.fileName, { type: "application/pdf" });
    if (navigator.canShare?.({ files: [file] }) && navigator.share) {
      try {
        await navigator.share({ files: [file], title: invoice.invoice_no, text: message });
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }
    await exportInvoicePdf(activePrintMode, true);
    alert("PDF has been generated. Attach the downloaded PDF if WhatsApp Web does not allow automatic attachment.");
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
            {canEdit && <button className="primary-button" onClick={onEdit}>Edit Bill</button>}
            <button className="secondary-button" onClick={() => printWithMode("THERMAL")}><Icon name="print" /> POS Thermal Print</button>
            <button className="secondary-button" onClick={() => printWithMode("A4")}><Icon name="print" /> A4 Invoice Print</button>
            <button className="secondary-button" disabled={exporting} onClick={() => exportInvoicePdf(activePrintMode, true)}>{exporting ? "Exporting..." : "PDF Export"}</button>
            <button className="whatsapp-button" disabled={exporting} onClick={sendWhatsApp}><Icon name="message" /> Send on WhatsApp</button>
            {canCancel && <button className="remove-button" onClick={onCancel}>Cancel Bill</button>}
            <button aria-label="Close invoice" className="remove-button" onClick={onClose}><Icon name="close" /></button>
          </div>
        </div>
        <article ref={invoiceRef} className={`invoice-paper ${activePrintMode === "A4" ? "invoice-a4" : "invoice-thermal"} ${printSettings.receipt_width === "58MM" ? "invoice-58mm" : "invoice-80mm"}`}>
          <header className="invoice-header">
            <BrandLogo invoice />
            <div className="invoice-meta">
              <strong>Tax Invoice</strong>
              <span>{printSettings.business_name || "FroozERP Retail"}</span>
              <span>{invoice.invoice_no}</span>
              <span>Bill Date: {formatDisplayDate(invoiceDateKey)}</span>
              <span>Entry Time: {new Date(invoice.created_at).toLocaleString("en-IN")}</span>
            </div>
          </header>
          <section className="invoice-customer">
            <div><small>Billed To</small><strong>{invoice.customer_name || "Walk-in Customer"}</strong><span>{invoice.customer_mobile || "No mobile number"}</span></div>
            <div><small>Payment</small><strong>{invoice.payment_mode}</strong><span>{invoice.branch_name || "SRT Retail Store"}</span></div>
            <div><small>Status</small><strong>{invoice.sale_status || "COMPLETED"}</strong><span>{invoice.cancellation_reason || invoice.edit_reason || "No changes recorded"}</span></div>
          </section>
          {activePrintMode === "THERMAL" ? (
            <section className="thermal-items-list">
              {(invoice.items || []).map((item) => {
                const lotText = [item.lot_name, item.lot_size].filter(Boolean).join(" / ") || "-";
                const discountAmount = Number(item.discount_amount || 0);
                return (
                  <article className="thermal-item-block" key={item.id || `${item.product_id}-${item.inventory_batch_id || "FIFO"}`}>
                    <div className="thermal-item-name">{item.product_name}</div>
                    <div className="thermal-item-detail">
                      <span>Lot: {lotText}</span>
                      <span>Qty: {item.quantity} {item.unit}</span>
                      <span>Rate: {receiptCurrency.format(Number(item.selling_rate))}</span>
                    </div>
                    {showItemDiscountOnReceipt && (discountAmount > 0 || !hideZeroDiscountRows) && (
                      <div className="thermal-item-discount">
                        <span>Discount</span>
                        <strong>{receiptCurrency.format(discountAmount)}</strong>
                      </div>
                    )}
                    <div className="thermal-item-amount">
                      <span>Amount</span>
                      <strong>{receiptCurrency.format(Number(item.net_amount))}</strong>
                    </div>
                  </article>
                );
              })}
            </section>
          ) : (
            <table className="invoice-table">
              <thead><tr><th>Item</th><th>Lot/Size</th><th>Qty</th><th>Rate</th>{showItemDiscountOnReceipt && <th>Item Discount</th>}<th>Amount</th></tr></thead>
              <tbody>
                {invoice.items?.map((item) => (
                  <tr key={item.id || `${item.product_id}-${item.inventory_batch_id || "FIFO"}`}>
                    <td>{item.product_name}</td>
                    <td>{[item.lot_name, item.lot_size].filter(Boolean).join(" / ") || "-"}</td>
                    <td>{item.quantity} {item.unit}</td>
                    <td>{receiptCurrency.format(Number(item.selling_rate))}</td>
                    {showItemDiscountOnReceipt && <td>{receiptCurrency.format(Number(item.discount_amount || 0))}</td>}
                    <td>{receiptCurrency.format(Number(item.net_amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <section className="invoice-total-box">
            <ThermalTotalLine label="Gross Total" value={Number(invoice.gross_amount)} />
            {shouldRenderBillDiscountRow && <ThermalTotalLine label="Bill Discount" value={-billDiscountAmount} />}
            <ThermalTotalLine label="Tax" value={Number(invoice.tax_amount || 0)} />
            <ThermalTotalLine label="Net Payable" total value={Number(invoice.total_amount)} />
          </section>
          {shouldShowUpiWarning && <p className="form-note stock-low">Please add UPI ID in Settings to show QR code.</p>}
          {shouldShowUpiQr && upiQrDataUrl && (
            <section className="upi-qr-box">
              <img alt="UPI payment QR" src={upiQrDataUrl} style={{ width: `${qrCodeWidth}px`, height: `${qrCodeWidth}px` }} />
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
            <button className="secondary-button" onClick={() => onNavigate("reports")} type="button">Open Stock Inventory</button>
          </div>
          <div className="low-stock-list">
            {lowStockItems.length ? lowStockItems.map((item) => (
              <button className="low-stock-row" key={item.product_id} onClick={() => onNavigate("reports")} type="button">
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
