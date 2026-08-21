import test from "node:test";
import assert from "node:assert/strict";

import { SHOP_VIEW_STATUS, resolveShopViewPresentation, shopPickerVisible } from "./shopView.js";

const owner = (overrides = {}) => ({
  loadState: "loaded",
  isOwner: true,
  branches: [{ id: 1, branch_name: "Jodhpur Warehouse" }, { id: 2, branch_name: "Sardarpura" }],
  ownBranchId: 1,
  viewingBranchId: 1,
  viewOnly: false,
  ...overrides,
});

test("an Owner with several shops gets a picker and no banner on their own shop", () => {
  const view = resolveShopViewPresentation(owner());
  assert.equal(view.status, SHOP_VIEW_STATUS.READY);
  assert.equal(shopPickerVisible(view), true);
  assert.equal(view.banner, null);
  assert.equal(view.isViewingOther, false);
  assert.equal(view.shops.length, 2);
});

test("viewing another shop always produces a banner naming it", () => {
  // The rule this module exists for. Every screen keeps its title and quietly starts showing
  // another branch's numbers; the banner is the only thing that says so.
  const view = resolveShopViewPresentation(owner({ viewingBranchId: 2, viewOnly: true }));
  assert.equal(view.isViewingOther, true);
  assert.match(view.banner.text, /Sardarpura/);
  assert.match(view.banner.text, /Nothing can be saved/);
  assert.equal(view.banner.returnBranchId, 1);
});

test("the banner survives the shop list failing to load", () => {
  // Whatever else broke, being pointed at another shop is the thing that must still be said. A
  // failed list is a missing dropdown; a missing banner is reading somebody else's takings as
  // your own.
  const view = resolveShopViewPresentation(owner({
    loadState: "error",
    loadError: "Network down",
    branches: [],
    viewingBranchId: 2,
    viewOnly: true,
  }));
  assert.equal(view.status, SHOP_VIEW_STATUS.UNAVAILABLE);
  assert.equal(view.isViewingOther, true);
  assert.ok(view.banner, "a failed list must not silence the banner");
});

test("the banner survives going offline", () => {
  const view = resolveShopViewPresentation(owner({ offline: true, viewingBranchId: 2, viewOnly: true }));
  assert.ok(view.banner);
  assert.equal(shopPickerVisible(view), false);
  assert.match(view.message, /connection/i);
});

test("a shop with no name still names something in the banner", () => {
  // `Shop 2` is not informative, but it is not nothing, and nothing is what a template hole
  // renders as. An unnamed shop must not produce "You are viewing ."
  const view = resolveShopViewPresentation(owner({
    branches: [{ id: 1, branch_name: "Head Office" }, { id: 2, branch_name: "" }],
    viewingBranchId: 2,
    viewOnly: true,
  }));
  assert.match(view.banner.text, /Shop 2/);
});

test("a shop missing from the list entirely still names something", () => {
  const view = resolveShopViewPresentation(owner({ branches: [], viewingBranchId: 7, viewOnly: true }));
  assert.match(view.banner.text, /Shop 7/);
});

test("view_only alone is enough to raise the banner", () => {
  // Belt and braces against the two signals disagreeing: if the server says this session cannot
  // write, that is reason enough to say so, even when the branch ids happen to match.
  const view = resolveShopViewPresentation(owner({ viewingBranchId: 1, viewOnly: true }));
  assert.equal(view.isViewingOther, true);
  assert.ok(view.banner);
});

test("a mismatch between own and viewed shop raises it too, without view_only", () => {
  const view = resolveShopViewPresentation(owner({ viewingBranchId: 2, viewOnly: false }));
  assert.equal(view.isViewingOther, true);
});

test("a single-shop business sees no picker at all", () => {
  // The normal case today. A dropdown with one entry is clutter that also reads as broken.
  const view = resolveShopViewPresentation(owner({
    branches: [{ id: 1, branch_name: "Jodhpur" }],
  }));
  assert.equal(view.status, SHOP_VIEW_STATUS.HIDDEN);
  assert.equal(shopPickerVisible(view), false);
});

test("a non-Owner sees nothing and is told nothing", () => {
  // Not a permission message: staff have one shop, so there is nothing to offer and an
  // explanation would only advertise a door they cannot open.
  const view = resolveShopViewPresentation(owner({ isOwner: false }));
  assert.equal(view.status, SHOP_VIEW_STATUS.HIDDEN);
  assert.equal(view.banner, null);
  assert.equal(view.message, "");
});

test("loading is not an empty shop list", () => {
  const view = resolveShopViewPresentation(owner({ loadState: "loading", branches: [] }));
  assert.equal(view.status, SHOP_VIEW_STATUS.LOADING);
  assert.equal(shopPickerVisible(view), false);
});

test("malformed shop entries are dropped rather than rendered as blanks", () => {
  const view = resolveShopViewPresentation(owner({
    branches: [{ id: 1, branch_name: "Real" }, null, { id: "abc" }, { id: 3, branch_name: "Also Real" }],
  }));
  assert.deepEqual(view.shops.map((shop) => shop.id), [1, 3]);
});
