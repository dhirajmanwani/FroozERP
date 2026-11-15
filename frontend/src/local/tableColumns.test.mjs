import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isNumericHeading, markNumericColumns } from "./tableColumns.js";

const appSource = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../App.css", import.meta.url), "utf8");

test("money and quantity headings become numeric columns; words stay words", () => {
  assert.deepEqual(markNumericColumns(["Date", "Party", "Amount", "Status", "Balance"]), [
    "Date", "Party", { label: "Amount", numeric: true }, "Status", { label: "Balance", numeric: true },
  ]);
  assert.equal(isNumericHeading("Payment"), false, "a mode in one report, an amount in another");
  assert.equal(isNumericHeading("Value"), false, "System Info's Field / Value is text");
  assert.equal(isNumericHeading(" stock value "), true, "case and spaces do not matter");
});

test("a table can add or keep out a heading of its own", () => {
  assert.deepEqual(markNumericColumns(["Party", "Payment"], { also: ["Payment"] })[1], { label: "Payment", numeric: true });
  assert.equal(markNumericColumns(["Returned"], { except: ["Returned"] })[0], "Returned");
  const node = { $$typeof: Symbol.for("react.element") };
  assert.equal(markNumericColumns([node])[0], node, "a node heading passes through");
  assert.deepEqual(markNumericColumns(undefined), []);
});

test("DataTable right-aligns a declared numeric column, heading and cells", () => {
  assert.match(appSource, /const isColumnSpec = \(header\) =>/);
  assert.match(appSource, /`num-col-\$\{column\}`/);
  for (let column = 1; column <= 16; column += 1) {
    assert.match(cssSource, new RegExp(`table\\.num-col-${column} :is\\(th, td\\):nth-child\\(${column}\\)`));
  }
  // The money tables staff read most declare their figures.
  assert.match(appSource, /<DataTable headers=\{markNumericColumns\(currentReport\.headers, \{ also: \["Value"\] \}\)\}>/);
  assert.match(appSource, /<DataTable headers=\{markNumericColumns\(\["Shop", "Cash", "Bank", "Stock Value", "Customers Owe", "We Owe", "Net Profit"\]\)\}>/);
  assert.match(appSource, /<DataTable headers=\{markNumericColumns\(\["Account", "Type", "Mobile", "Opening", "Receivable", "Payable", "Status", "Actions"\]\)\}>/);
});
