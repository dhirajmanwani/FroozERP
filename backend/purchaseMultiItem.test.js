// A purchase from the cart holds one item and one lot per fruit (4 Oct 2026). These pin the three
// places that used to treat a purchase as one item: the list, edit/complete, and cancel.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
const between = (start, end) => {
  const from = source.indexOf(start);
  assert.ok(from >= 0, `missing ${start}`);
  const to = source.indexOf(end, from + start.length);
  assert.ok(to > from, `missing ${end} after ${start}`);
  return source.slice(from, to);
};

test("GET /purchases pairs each item with its own lot instead of crossing every item with every lot", () => {
  const route = between('app.get("/purchases"', "return res.json(result.rows);");
  assert.doesNotMatch(route, /LEFT JOIN inventory_batches ib ON ib\.purchase_id = p\.id\s/);
  assert.match(route, /PARTITION BY item\.product_id ORDER BY item\.id/);
  assert.match(route, /PARTITION BY batch\.product_id ORDER BY batch\.id/);
  assert.match(route, /lot\.product_id = pi\.product_id AND lot\.product_line = pi\.product_line/);
  assert.match(route, /pi\.net_payable AS item_net_payable/);
});

test("edit and complete-bill refuse a bill with several items before touching it", () => {
  const helper = between("const refuseMultiItemPurchaseChange = async", "\n};\n");
  assert.match(helper, /COUNT\(\*\)::INTEGER AS items FROM purchase_items WHERE purchase_id = \$1/);
  assert.match(helper, /PURCHASE_MULTI_ITEM_CHANGE_UNSUPPORTED/);
  assert.match(helper, /status: 409/);
  for (const [handler, action] of [["const updatePurchaseHandler", "edit"], ["const completePurchaseBillHandler", "complete"]]) {
    const body = between(handler, "\n};\n");
    const guard = body.indexOf(`refuseMultiItemPurchaseChange(client, purchaseId, "${action}")`);
    const firstItemRead = body.indexOf("SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY id LIMIT 1");
    assert.ok(guard > 0, `${handler} has the guard`);
    assert.ok(firstItemRead > guard, `${handler} refuses before it reads the first item`);
  }
});

test("cancel covers every item and every lot of the bill", () => {
  const body = between("const cancelPurchaseHandler", "\n};\n");
  assert.doesNotMatch(body, /LIMIT 1/);
  assert.match(body, /for \(const lot of batches\)/);
  assert.match(body, /const soldLot = batches\.find/);
});

test("editing or completing a purchase keeps each lot's branch", () => {
  const edit = between("const updatePurchaseHandler", "\n};\n");
  const complete = between("const completePurchaseBillHandler", "\n};\n");
  assert.equal((edit.match(/branch_id = COALESCE\(branch_id, \$\d+\)/g) || []).length, 2);
  assert.equal((complete.match(/branch_id = COALESCE\(branch_id, \$\d+\)/g) || []).length, 1);
});
