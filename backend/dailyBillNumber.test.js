const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { assignBillNo, billDateCode, nextCloudBillNo, readRequestedBillNo } = require("./dailyBillNumber");

// A stand-in for the sales table with its unique invoice_no index, enough for the four statements
// assignBillNo sends. `raceOn` makes the UPDATE for that number fail as if another transaction
// committed it a moment earlier.
const fakeSales = (rows = [], { raceOn = "" } = {}) => {
  const sales = rows.map((row) => ({ ...row }));
  const statements = [];
  return {
    sales,
    statements,
    async query(sql, params = []) {
      statements.push(sql);
      if (sql.startsWith("SELECT invoice_no FROM sales WHERE invoice_no LIKE")) {
        const prefix = params[0].replace(/%$/, "");
        return { rows: sales.filter((row) => String(row.invoice_no || "").startsWith(prefix)) };
      }
      if (sql.startsWith("SELECT 1 FROM sales WHERE invoice_no = $1 AND id <> $2")) {
        return { rows: sales.filter((row) => row.invoice_no === params[0] && row.id !== params[1]) };
      }
      if (sql.startsWith("UPDATE sales SET invoice_no")) {
        if (params[0] === raceOn) {
          const error = new Error("duplicate key value violates unique constraint");
          error.code = "23505";
          throw error;
        }
        const sale = sales.find((row) => row.id === params[1]);
        sale.invoice_no = params[0];
        return { rows: [] };
      }
      if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) bill_no_claim$/.test(sql)) return { rows: [] };
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
};

test("the bill's date reads as DDMMYY", () => {
  assert.equal(billDateCode("2026-10-31"), "311026");
  assert.equal(billDateCode("2026-11-01T00:00:00.000Z"), "011126");
  assert.equal(billDateCode("garbage"), "");
  assert.equal(readRequestedBillNo("311026-001"), "311026-001");
  assert.equal(readRequestedBillNo("311026-001-2"), "", "a suffix is the cloud's to give, not the counter's");
  assert.equal(readRequestedBillNo("FZ-1; DROP TABLE sales"), "");
});

test("the counter's own number is kept as it printed it", async () => {
  const client = fakeSales([{ id: 7, invoice_no: null }]);
  assert.equal(await assignBillNo(client, { saleId: 7, dateKey: "2026-10-31", requested: "311026-004", fallback: "FZ-20261031-000007" }), "311026-004");
  assert.equal(client.sales[0].invoice_no, "311026-004");
});

test("a bill made in the cloud takes the next number of its day, and a new day starts at 001", async () => {
  const client = fakeSales([
    { id: 1, invoice_no: "311026-001" },
    { id: 2, invoice_no: "311026-002-2" },
    { id: 3, invoice_no: "FZ-20261031-000003" },
    { id: 4, invoice_no: "301026-009" },
    { id: 5, invoice_no: null },
    { id: 6, invoice_no: null },
  ]);
  assert.equal(await nextCloudBillNo(client, "2026-10-31"), "311026-003");
  assert.equal(await assignBillNo(client, { saleId: 5, dateKey: "2026-10-31", fallback: "FZ-x" }), "311026-003");
  assert.equal(await assignBillNo(client, { saleId: 6, dateKey: "2026-11-01", fallback: "FZ-y" }), "011126-001");
});

test("two computers with the same number: the second bill is kept as -2, never refused", async () => {
  const client = fakeSales([{ id: 1, invoice_no: "311026-001" }, { id: 2, invoice_no: null }]);
  assert.equal(await assignBillNo(client, { saleId: 2, dateKey: "2026-10-31", requested: "311026-001", fallback: "FZ-z" }), "311026-001-2");
});

test("a number taken by another transaction a moment earlier moves on instead of failing the sale", async () => {
  const client = fakeSales([{ id: 2, invoice_no: null }], { raceOn: "311026-001" });
  assert.equal(await assignBillNo(client, { saleId: 2, dateKey: "2026-10-31", requested: "311026-001", fallback: "FZ-z" }), "311026-001-2");
  assert.ok(client.statements.includes("ROLLBACK TO SAVEPOINT bill_no_claim"));
});

test("re-stamping the same sale keeps its own number (a resend is not a clash with itself)", async () => {
  const client = fakeSales([{ id: 9, invoice_no: "311026-001" }]);
  assert.equal(await assignBillNo(client, { saleId: 9, dateKey: "2026-10-31", requested: "311026-001", fallback: "FZ-q" }), "311026-001");
});

test("an unreadable date keeps the old FZ number rather than inventing a date", async () => {
  const client = fakeSales([{ id: 3, invoice_no: null }]);
  assert.equal(await assignBillNo(client, { saleId: 3, dateKey: "not a date", fallback: "FZ-20261031-000003" }), "FZ-20261031-000003");
});

test("both places that create a sale number it through assignBillNo", () => {
  const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.equal((source.match(/await assignBillNo\(client, \{/g) || []).length, 2);
  assert.match(source, /requested: payload\.bill_no,/, "the synced counter bill keeps the number it printed");
  assert.doesNotMatch(source, /UPDATE sales SET invoice_no = \$1 WHERE id = \$2", \[invoiceNo, sale\.id\]/);
});
