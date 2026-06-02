import { useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import "./App.css";

const API_URL = "http://localhost:5000";
const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
});

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
};

const navigationItems = [
  ["dashboard", "Dashboard"],
  ["products", "Products"],
  ["purchase", "Purchase Entry"],
  ["inventory", "Inventory"],
  ["sales", "POS Billing"],
  ["sales-history", "Sales History"],
  ["expenses", "Expenses"],
  ["customers", "Customers"],
  ["reports", "Reports"],
  ["settings", "Settings"],
];

const futureModules = {
  expenses: ["Expenses", "Track and categorize operating costs across your business."],
  customers: ["Customers", "Manage customer profiles, activity, and account balances."],
  reports: ["Reports", "Review business performance and operational insights."],
  settings: ["Settings", "Configure your organization, branches, and preferences."],
};

const getErrorMessage = (error, fallback) =>
  error.response?.data?.message || fallback;

const toDateKey = (date) =>
  typeof date === "string" ? date.slice(0, 10) : date.toLocaleDateString("en-CA");

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

  const [productName, setProductName] = useState("");
  const [sellingRate, setSellingRate] = useState("");
  const [purchaseRate, setPurchaseRate] = useState("");
  const [productBarcode, setProductBarcode] = useState("");
  const [unit, setUnit] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [purchaseProductId, setPurchaseProductId] = useState("");
  const [purchaseQuantity, setPurchaseQuantity] = useState("");
  const [purchaseRateInput, setPurchaseRateInput] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState(null);

  const kpis = useMemo(() => {
    const today = toDateKey(new Date());
    const todaysSales = salesHistory.filter((sale) => toDateKey(sale.sale_date) === today);
    const total = (items, key) =>
      items.reduce((sum, item) => sum + Number(item[key] || 0), 0);
    const stockValue = inventory.reduce(
      (sum, item) => sum + Number(item.remaining_qty || 0) * Number(item.purchase_rate || 0),
      0
    );
    const stockByProduct = inventory.reduce((stock, item) => {
      stock.set(item.product_name, (stock.get(item.product_name) || 0) + Number(item.remaining_qty || 0));
      return stock;
    }, new Map());
    const lowStockItems = [...stockByProduct.values()].filter((quantity) => quantity <= 5).length;

    return [
      ["Today's Sales", currency.format(total(todaysSales, "amount")), "rupee"],
      ["Today's Profit", currency.format(total(todaysSales, "profit")), "trend"],
      ["Stock Value", currency.format(stockValue), "layers"],
      ["Low Stock Items", lowStockItems, "alert"],
      ["Transactions", todaysSales.length, "receipt"],
    ];
  }, [inventory, salesHistory]);

  const loadProducts = async () => {
    const response = await axios.get(`${API_URL}/products`);
    setProducts(response.data);
  };

  const loadDashboardData = async () => {
    const [inventoryResponse, salesResponse] = await Promise.all([
      axios.get(`${API_URL}/inventory`),
      axios.get(`${API_URL}/sales`),
    ]);
    setInventory(inventoryResponse.data);
    setSalesHistory(salesResponse.data);
  };

  const login = async () => {
    try {
      const response = await axios.post(`${API_URL}/login`, { username, password });
      setUser(response.data);
      await Promise.all([loadProducts(), loadDashboardData()]);
    } catch (error) {
      alert(getErrorMessage(error, "Login Failed"));
    }
  };

  const addProduct = async () => {
    try {
      await axios.post(`${API_URL}/products`, {
        product_name: productName,
        selling_rate: sellingRate,
        purchase_rate: purchaseRate,
        unit,
        barcode: productBarcode,
      });
      setProductName("");
      setSellingRate("");
      setPurchaseRate("");
      setUnit("");
      setProductBarcode("");
      await loadProducts();
      alert("Product Added");
    } catch (error) {
      alert(getErrorMessage(error, "Error Adding Product"));
    }
  };

  const savePurchase = async () => {
    try {
      await axios.post(`${API_URL}/purchase`, {
        supplier_name: supplierName,
        product_id: purchaseProductId,
        quantity: purchaseQuantity,
        purchase_rate: purchaseRateInput,
        branch_id: user.branch_id,
        created_by: user.id,
      });
      setSupplierName("");
      setPurchaseProductId("");
      setPurchaseQuantity("");
      setPurchaseRateInput("");
      await loadDashboardData();
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

  const selectPurchaseProduct = (event) => {
    const productId = event.target.value;
    const product = products.find((item) => String(item.id) === productId);
    setPurchaseProductId(productId);
    setPurchaseRateInput(product?.purchase_rate || "");
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
        const response = await axios.get(`${API_URL}/sales`);
        setSalesHistory(response.data);
      }
      if (view === "dashboard") await loadDashboardData();
    } catch (error) {
      alert(getErrorMessage(error, "Error Loading Data"));
    }
  };

  if (!user) {
    return (
      <main className="login-page">
        <section className="login-panel">
          <div className="login-brand">
            <span className="brand-mark">F</span>
            <div>
              <strong>FROOZERP</strong>
              <small>Fruit Retail Intelligence</small>
            </div>
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

  return (
    <main className="erp-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <span className="brand-mark">F</span>
          <div>
            <strong>FROOZERP</strong>
            <small>Fruit Retail Intelligence</small>
          </div>
        </div>
        <span className="sidebar-section">Main Menu</span>
        <nav className="sidebar-nav">
          {navigationItems.map(([view, label]) => (
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
            <div>
              <span className="eyebrow">FroozERP Workspace</span>
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
                  {[["sales", "POS Billing"], ["purchase", "New Purchase"], ["inventory", "View Inventory"], ["products", "Manage Products"]].map(([view, label]) => (
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
                <Field label="Purchase Rate"><input type="number" min="0" step="0.01" value={purchaseRate} onChange={(event) => setPurchaseRate(event.target.value)} /></Field>
                <Field label="Unit"><input value={unit} onChange={(event) => setUnit(event.target.value)} /></Field>
                <Field label="Barcode (Optional)"><input value={productBarcode} onChange={(event) => setProductBarcode(event.target.value)} /></Field>
              </div>
              <button className="primary-button" onClick={addProduct}>Add Product</button>
              <DataTable headers={["Product", "Barcode", "Selling Rate", "Purchase Rate", "Unit"]}>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td className="primary-cell">{product.product_name}</td>
                    <td>{product.barcode || "-"}</td>
                    <td>{currency.format(Number(product.selling_rate))}</td>
                    <td>{currency.format(Number(product.purchase_rate))}</td>
                    <td><span className="tag">{product.unit}</span></td>
                  </tr>
                ))}
              </DataTable>
            </ModuleCard>
          )}

          {activeView === "purchase" && (
            <ModuleCard eyebrow="Procurement" title="Purchase Entry" subtitle="Record incoming stock and supplier purchase details.">
              <div className="form-grid">
                <Field label="Supplier Name"><input value={supplierName} onChange={(event) => setSupplierName(event.target.value)} /></Field>
                <Field label="Product">
                  <select value={purchaseProductId} onChange={selectPurchaseProduct}>
                    <option value="">Select product</option>
                    {products.map((product) => <option key={product.id} value={product.id}>{product.product_name}</option>)}
                  </select>
                </Field>
                <Field label="Quantity"><input type="number" min="0" step="0.001" value={purchaseQuantity} onChange={(event) => setPurchaseQuantity(event.target.value)} /></Field>
                <Field label="Purchase Rate"><input type="number" min="0" step="0.01" value={purchaseRateInput} onChange={(event) => setPurchaseRateInput(event.target.value)} /></Field>
              </div>
              <button className="primary-button" onClick={savePurchase}>Save Purchase</button>
            </ModuleCard>
          )}

          {activeView === "inventory" && (
            <ModuleCard eyebrow="Stock Control" title="Inventory Batches" subtitle="Review current quantities and batch-level purchase details.">
              <DataTable headers={["Batch", "Product", "Purchased", "Remaining", "Purchase Rate", "Supplier", "Date"]}>
                {inventory.map((item) => (
                  <tr key={item.id}>
                    <td><span className="batch-id">{item.batch_no}</span></td>
                    <td className="primary-cell">{item.product_name}</td>
                    <td>{item.purchase_qty}</td>
                    <td><span className={Number(item.remaining_qty) <= 5 ? "stock-low" : "stock-ok"}>{item.remaining_qty}</span></td>
                    <td>{currency.format(Number(item.purchase_rate))}</td>
                    <td>{item.supplier_name}</td>
                    <td>{item.purchase_date}</td>
                  </tr>
                ))}
              </DataTable>
            </ModuleCard>
          )}

          {activeView === "sales" && (
            <PosBilling
              inventory={inventory}
              onInvoice={setSelectedInvoice}
              onSaved={loadDashboardData}
              products={products}
              user={user}
            />
          )}

          {activeView === "sales-history" && (
            <ModuleCard eyebrow="Revenue" title="Sales History" subtitle="Review completed sales, costs, and realized profit.">
              <DataTable headers={["Invoice", "Date", "Customer", "Items", "Payment", "Amount", "Cost", "Profit", ""]}>
                {salesHistory.map((sale) => (
                  <tr key={sale.id}>
                    <td><span className="batch-id">{sale.invoice_no || `#${sale.id}`}</span></td>
                    <td>{sale.sale_date}</td>
                    <td>{sale.customer_name || "Walk-in Customer"}</td>
                    <td className="primary-cell">{sale.item_summary}</td>
                    <td><span className="tag">{sale.payment_mode}</span></td>
                    <td>{currency.format(Number(sale.amount))}</td>
                    <td>{currency.format(Number(sale.cost_amount))}</td>
                    <td className="profit-cell">{currency.format(Number(sale.profit))}</td>
                    <td><button className="table-action" onClick={() => loadInvoice(sale.id)}>View</button></td>
                  </tr>
                ))}
              </DataTable>
            </ModuleCard>
          )}

          {futureModules[activeView] && (
            <section className="content-card empty-state">
              <div className="empty-icon"><Icon name={icons[activeView]} size={25} /></div>
              <span className="eyebrow">FroozERP Module</span>
              <h2>{futureModules[activeView][0]}</h2>
              <p>{futureModules[activeView][1]}</p>
              <span className="coming-soon">Coming Soon</span>
            </section>
          )}
        </div>
      </section>
      {selectedInvoice && <InvoiceModal invoice={selectedInvoice} onClose={() => setSelectedInvoice(null)} />}
    </main>
  );
}

function PosBilling({ inventory, onInvoice, onSaved, products, user }) {
  const [search, setSearch] = useState("");
  const [barcode, setBarcode] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [cart, setCart] = useState([]);
  const [invoiceDiscount, setInvoiceDiscount] = useState("");
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
    const invoiceDiscountAmount = Number(invoiceDiscount || 0);
    return {
      gross,
      itemDiscount,
      invoiceDiscount: invoiceDiscountAmount,
      discount: itemDiscount + invoiceDiscountAmount,
      total: Math.max(gross - itemDiscount - invoiceDiscountAmount, 0),
      itemCount: cart.reduce((sum, item) => sum + Number(item.quantity), 0),
    };
  }, [cart, invoiceDiscount]);

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
        invoice_discount: Number(invoiceDiscount || 0),
        payments,
        branch_id: user.branch_id,
        created_by: user.id,
      });
      setCart([]);
      setInvoiceDiscount("");
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
            <span className="shortcut-hint">F2 Search · F3 Barcode · F4 Checkout</span>
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
                    <small>{product.barcode || "No barcode"} · {currency.format(Number(product.selling_rate))}/{product.unit}</small>
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
          <Field label="Invoice Discount"><input min="0" step="0.01" type="number" value={invoiceDiscount} onChange={(event) => setInvoiceDiscount(event.target.value)} /></Field>
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
          <TotalLine label="Subtotal" value={totals.gross} />
          <TotalLine label="Discount" value={-totals.discount} />
          <TotalLine label="Tax" value={0} muted />
          <TotalLine label="Payable" value={totals.total} total />
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

function InvoiceModal({ invoice, onClose }) {
  const sendWhatsApp = () => {
    if (!invoice.customer_mobile) {
      alert("Add a customer mobile number to send this invoice on WhatsApp.");
      return;
    }
    const message = [
      "Thank you for shopping with FroozERP. Your invoice is ready.",
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
            <div>
              <strong className="invoice-logo">FROOZERP</strong>
              <span>Fruit Retail Intelligence</span>
            </div>
            <div className="invoice-meta">
              <strong>Tax Invoice</strong>
              <span>{invoice.invoice_no}</span>
              <span>{new Date(invoice.created_at).toLocaleString("en-IN")}</span>
            </div>
          </header>
          <section className="invoice-customer">
            <div><small>Billed To</small><strong>{invoice.customer_name || "Walk-in Customer"}</strong><span>{invoice.customer_mobile || "No mobile number"}</span></div>
            <div><small>Payment</small><strong>{invoice.payment_mode}</strong><span>{invoice.branch_name || "FroozERP Store"}</span></div>
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
            <strong>Thank you for shopping with FroozERP.</strong>
            <span>We appreciate your business.</span>
            <small>GST-ready invoice · Generated by FroozERP</small>
          </footer>
        </article>
      </section>
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
