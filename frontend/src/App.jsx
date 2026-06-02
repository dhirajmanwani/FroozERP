import { useMemo, useState } from "react";
import axios from "axios";
import "./App.css";

const API_URL = "http://localhost:5000";
const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
});

const getErrorMessage = (error, fallback) =>
  error.response?.data?.message || fallback;

function App() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState(null);
  const [activeView, setActiveView] = useState("dashboard");
  const [products, setProducts] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [salesHistory, setSalesHistory] = useState([]);

  const [productName, setProductName] = useState("");
  const [sellingRate, setSellingRate] = useState("");
  const [purchaseRate, setPurchaseRate] = useState("");
  const [unit, setUnit] = useState("");

  const [supplierName, setSupplierName] = useState("");
  const [purchaseProductId, setPurchaseProductId] = useState("");
  const [purchaseQuantity, setPurchaseQuantity] = useState("");
  const [purchaseRateInput, setPurchaseRateInput] = useState("");

  const [saleProductId, setSaleProductId] = useState("");
  const [saleQuantity, setSaleQuantity] = useState("");

  const selectedSaleProduct = useMemo(
    () => products.find((product) => String(product.id) === saleProductId),
    [products, saleProductId]
  );

  const loadProducts = async () => {
    try {
      const response = await axios.get(`${API_URL}/products`);
      setProducts(response.data);
    } catch (error) {
      alert(getErrorMessage(error, "Error Loading Products"));
    }
  };

  const login = async () => {
    try {
      const response = await axios.post(`${API_URL}/login`, {
        username,
        password,
      });
      setUser(response.data);
      await loadProducts();
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
      });
      setProductName("");
      setSellingRate("");
      setPurchaseRate("");
      setUnit("");
      await loadProducts();
      alert("Product Added");
    } catch (error) {
      alert(getErrorMessage(error, "Error Adding Product"));
    }
  };

  const loadInventory = async () => {
    try {
      const response = await axios.get(`${API_URL}/inventory`);
      setInventory(response.data);
      setActiveView("inventory");
    } catch (error) {
      alert(getErrorMessage(error, "Error Loading Inventory"));
    }
  };

  const loadSalesHistory = async () => {
    try {
      const response = await axios.get(`${API_URL}/sales`);
      setSalesHistory(response.data);
      setActiveView("sales-history");
    } catch (error) {
      alert(getErrorMessage(error, "Error Loading Sales History"));
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
      alert("Purchase Saved");
    } catch (error) {
      alert(getErrorMessage(error, "Purchase Error"));
    }
  };

  const saveSale = async () => {
    try {
      const response = await axios.post(`${API_URL}/sales`, {
        product_id: saleProductId,
        quantity: saleQuantity,
        branch_id: user.branch_id,
        created_by: user.id,
      });
      setSaleProductId("");
      setSaleQuantity("");
      alert(
        `Sale Saved. Profit: ${currency.format(Number(response.data.sale.profit))}`
      );
    } catch (error) {
      alert(getErrorMessage(error, "Sale Error"));
    }
  };

  const selectPurchaseProduct = (event) => {
    const productId = event.target.value;
    const product = products.find((item) => String(item.id) === productId);
    setPurchaseProductId(productId);
    setPurchaseRateInput(product?.purchase_rate || "");
  };

  if (!user) {
    return (
      <main className="login-page">
        <section className="panel login-panel">
          <h1>FroozERP Login</h1>
          <label>
            Username
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <button onClick={login}>Login</button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <h1>FroozERP Dashboard</h1>
          <p>
            {user.full_name} | {user.role} | {user.branch}
          </p>
        </div>
      </header>

      <nav className="navigation">
        <button onClick={() => setActiveView("dashboard")}>Dashboard</button>
        <button onClick={() => setActiveView("products")}>Products</button>
        <button onClick={() => setActiveView("purchase")}>Purchase Entry</button>
        <button onClick={loadInventory}>Inventory</button>
        <button onClick={() => setActiveView("sales")}>Sales</button>
        <button onClick={loadSalesHistory}>Sales History</button>
      </nav>

      {activeView === "dashboard" && (
        <section className="panel">
          <h2>Welcome</h2>
          <p>Select a module from the navigation bar.</p>
        </section>
      )}

      {activeView === "products" && (
        <section className="panel">
          <h2>Product Management</h2>
          <div className="form-grid">
            <label>
              Product Name
              <input
                value={productName}
                onChange={(event) => setProductName(event.target.value)}
              />
            </label>
            <label>
              Selling Rate
              <input
                type="number"
                min="0"
                step="0.01"
                value={sellingRate}
                onChange={(event) => setSellingRate(event.target.value)}
              />
            </label>
            <label>
              Purchase Rate
              <input
                type="number"
                min="0"
                step="0.01"
                value={purchaseRate}
                onChange={(event) => setPurchaseRate(event.target.value)}
              />
            </label>
            <label>
              Unit
              <input value={unit} onChange={(event) => setUnit(event.target.value)} />
            </label>
          </div>
          <button onClick={addProduct}>Add Product</button>

          <h3>Products</h3>
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th>Selling Rate</th>
                <th>Purchase Rate</th>
                <th>Unit</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td>{product.product_name}</td>
                  <td>{currency.format(Number(product.selling_rate))}</td>
                  <td>{currency.format(Number(product.purchase_rate))}</td>
                  <td>{product.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {activeView === "purchase" && (
        <section className="panel">
          <h2>Purchase Entry</h2>
          <div className="form-grid">
            <label>
              Supplier Name
              <input
                value={supplierName}
                onChange={(event) => setSupplierName(event.target.value)}
              />
            </label>
            <label>
              Product
              <select value={purchaseProductId} onChange={selectPurchaseProduct}>
                <option value="">Select product</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.product_name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Quantity
              <input
                type="number"
                min="0"
                step="0.001"
                value={purchaseQuantity}
                onChange={(event) => setPurchaseQuantity(event.target.value)}
              />
            </label>
            <label>
              Purchase Rate
              <input
                type="number"
                min="0"
                step="0.01"
                value={purchaseRateInput}
                onChange={(event) => setPurchaseRateInput(event.target.value)}
              />
            </label>
          </div>
          <button onClick={savePurchase}>Save Purchase</button>
        </section>
      )}

      {activeView === "inventory" && (
        <section className="panel">
          <h2>Inventory Batches</h2>
          <table>
            <thead>
              <tr>
                <th>Batch</th>
                <th>Product</th>
                <th>Purchased</th>
                <th>Remaining</th>
                <th>Purchase Rate</th>
                <th>Supplier</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {inventory.map((item) => (
                <tr key={item.id}>
                  <td>{item.batch_no}</td>
                  <td>{item.product_name}</td>
                  <td>{item.purchase_qty}</td>
                  <td>{item.remaining_qty}</td>
                  <td>{currency.format(Number(item.purchase_rate))}</td>
                  <td>{item.supplier_name}</td>
                  <td>{item.purchase_date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {activeView === "sales" && (
        <section className="panel">
          <h2>Sales Entry</h2>
          <div className="form-grid">
            <label>
              Product
              <select
                value={saleProductId}
                onChange={(event) => setSaleProductId(event.target.value)}
              >
                <option value="">Select product</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.product_name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Selling Rate
              <input
                readOnly
                value={
                  selectedSaleProduct
                    ? currency.format(Number(selectedSaleProduct.selling_rate))
                    : ""
                }
              />
            </label>
            <label>
              Quantity
              <input
                type="number"
                min="0"
                step="0.001"
                value={saleQuantity}
                onChange={(event) => setSaleQuantity(event.target.value)}
              />
            </label>
          </div>
          <button onClick={saveSale}>Save Sale</button>
        </section>
      )}

      {activeView === "sales-history" && (
        <section className="panel">
          <h2>Sales History</h2>
          <table>
            <thead>
              <tr>
                <th>Sale</th>
                <th>Date</th>
                <th>Product</th>
                <th>Quantity</th>
                <th>Selling Rate</th>
                <th>Amount</th>
                <th>Cost</th>
                <th>Profit</th>
              </tr>
            </thead>
            <tbody>
              {salesHistory.map((sale) => (
                <tr key={sale.id}>
                  <td>#{sale.id}</td>
                  <td>{sale.sale_date}</td>
                  <td>{sale.product_name}</td>
                  <td>
                    {sale.quantity} {sale.unit}
                  </td>
                  <td>{currency.format(Number(sale.selling_rate))}</td>
                  <td>{currency.format(Number(sale.amount))}</td>
                  <td>{currency.format(Number(sale.cost_amount))}</td>
                  <td>{currency.format(Number(sale.profit))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}

export default App;
