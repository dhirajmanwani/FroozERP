import { useState } from "react";
import axios from "axios";

function App() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState(null);
  const [products, setProducts] = useState([]);
const [showProducts, setShowProducts] = useState(false);
const [productName, setProductName] = useState("");
const [sellingRate, setSellingRate] = useState("");
const [purchaseRate, setPurchaseRate] = useState("");
const [unit, setUnit] = useState("");

  const login = async () => {
    try {
      const response = await axios.post(
        "http://localhost:5000/login",
        {
          username,
          password,
        }
      );

      setUser(response.data);
    } catch (error) {
      alert("Login Failed");
    }
  };

 const loadProducts = async () => {
  const response = await axios.get(
    "http://localhost:5000/products"
  );

  setProducts(response.data);
  setShowProducts(true);
};

const addProduct = async () => {
  try {
    await axios.post(
      "http://localhost:5000/products",
      {
        product_name: productName,
        selling_rate: sellingRate,
        purchase_rate: purchaseRate,
        unit: unit,
      }
    );

    alert("Product Added");

    loadProducts();
  } catch (error) {
    alert("Error Adding Product");
  }
};

  if (user) {
  return (
    <div style={{ padding: "20px" }}>
      <h1>FroozERP Dashboard</h1>

      <h3>Welcome {user.full_name}</h3>
      <p>Role: {user.role}</p>
      <p>Branch: {user.branch}</p>
      <h3>Add Product</h3>

<input
  placeholder="Product Name"
  value={productName}
  onChange={(e) => setProductName(e.target.value)}
/>

<br /><br />

<input
  placeholder="Selling Rate"
  value={sellingRate}
  onChange={(e) => setSellingRate(e.target.value)}
/>

<br /><br />

<input
  placeholder="Purchase Rate"
  value={purchaseRate}
  onChange={(e) => setPurchaseRate(e.target.value)}
/>

<br /><br />

<input
  placeholder="Unit"
  value={unit}
  onChange={(e) => setUnit(e.target.value)}
/>

<br /><br />

<button onClick={addProduct}>
  Add Product
</button>

<hr />
      <button onClick={loadProducts}>
  Products
</button>

<br /><br />
{showProducts && (
  <div>
    <h3>Products</h3>

    {products.map((product) => (
      <div key={product.id}>
        <strong>{product.product_name}</strong>
        {" - ₹"}
        {product.selling_rate}
        {" per "}
        {product.unit}
      </div>
    ))}
  </div>
)}

      <hr />

      <div>
        <button>Products</button>
        <button>Inventory</button>
        <button>Sales</button>
        <button>Purchases</button>
        <button>Users</button>
      </div>

      <br />

      <div>
        <h3>Quick Stats</h3>
        <p>Products: 0</p>
        <p>Stock Value: ₹0</p>
        <p>Today's Sales: ₹0</p>
      </div>
    </div>
  );
}

  return (
    <div style={{ padding: "20px" }}>
      <h1>FroozERP Login</h1>

      <input
        placeholder="Username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />

      <br /><br />

      <input
        type="password"
        placeholder="Password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />

      <br /><br />

      <button onClick={login}>
        Login
      </button>
    </div>
  );
}

export default App;