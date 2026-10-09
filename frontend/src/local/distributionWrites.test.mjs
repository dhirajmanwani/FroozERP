import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  crateAllocationsForApproval,
  drawableTransferActions,
  transferActionId,
  transferItemsForRequest,
  transferItemsForSend,
} from "./distributionWrites.js";

test("snapshot ids are sent as opaque strings, never Number()", () => {
  assert.deepEqual(transferItemsForSend([{ product_id: "product-12", source_lot_id: " lot-uuid-1 ", requested_quantity: "2.5" }]), [
    { product_id: "product-12", source_lot_id: "lot-uuid-1", requested_quantity: "2.5" },
  ]);
  assert.deepEqual(transferItemsForRequest([{ product_id: "product-12", source_lot_id: "x", requested_quantity: 3 }]), [
    { product_id: "product-12", requested_quantity: 3 },
  ], "a request carries no lot");
  assert.deepEqual(crateAllocationsForApproval([{ source_lot_id: "inventory-lot-4", quantity: "1.25" }]), [
    { source_lot_id: "inventory-lot-4", quantity: 1.25 },
  ]);
});

test("actions go to the server's row id, falling back to the described id", () => {
  assert.equal(transferActionId({ id: "uuid-1", serverId: "17" }), "17");
  assert.equal(transferActionId({ id: "uuid-1", serverId: "" }), "uuid-1");
  assert.equal(transferActionId({ id: "uuid-1" }), "uuid-1");
});

test("part-receipt and take-back buttons are held back, and that is reported", () => {
  const { drawn, heldBack } = drawableTransferActions([
    { action: "receive" }, { action: "partial_receive" }, { action: "discrepancy" },
  ]);
  assert.deepEqual(drawn.map((option) => option.action), ["receive", "discrepancy"]);
  assert.equal(heldBack, true);
  assert.equal(drawableTransferActions([{ action: "dispatch" }]).heldBack, false);
  assert.equal(drawableTransferActions([{ action: "source_receive" }]).drawn.length, 0);
});

test("App posts actions with transferActionId and draws only drawable actions", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("function DistributionModule(");
  const body = app.slice(start, app.indexOf("\nfunction ", start + 1));
  assert.doesNotMatch(body, /onAction\?\.\(entry\.id/);
  assert.match(body, /onAction\?\.\(transferActionId\(entry\), "approve"/);
  assert.match(body, /drawnActions\.map\(\(option\)/);
  assert.match(app, /items: transferItemsForSend\(draft\.lines\)/);
});
