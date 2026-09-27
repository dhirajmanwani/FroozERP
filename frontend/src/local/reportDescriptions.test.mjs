import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ORDER_REPORT } from "./orderReporting.js";
import { REPORT_DESCRIPTIONS, describeReport } from "./reportDescriptions.js";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

const categoryReportIds = () => {
  const anchor = app.indexOf('{ id: "orders", title: "Order Reports"');
  assert.ok(anchor > 0, "the report categories must still be a literal array");
  const start = app.lastIndexOf("const categories = [", anchor);
  const block = app.slice(start, app.indexOf("\n  ];", start));
  const ids = [];
  for (const [, list] of block.matchAll(/reports: \[([^\]]*)\]/g)) {
    for (const item of list.split(",").map((value) => value.trim()).filter(Boolean)) {
      const orderKey = item.match(/^ORDER_REPORT\.([A-Z_]+)$/);
      ids.push(orderKey ? ORDER_REPORT[orderKey[1]] : item.replace(/^"|"$/g, ""));
    }
  }
  return ids;
};

test("every report listed in a Report Center category has its own line", () => {
  const ids = categoryReportIds();
  assert.ok(ids.length > 20, "guard against a truncated parse");
  for (const id of ids) {
    assert.ok(describeReport(id), `${id} has no description`);
  }
});

test("no two reports share a line, and none uses a word a shopkeeper would not", () => {
  const lines = Object.values(REPORT_DESCRIPTIONS);
  assert.equal(new Set(lines).size, lines.length);
  for (const line of lines) assert.doesNotMatch(line, /FIFO|workspace|SQLite|backend/i);
});

test("unknown ids read as empty, never as a guess", () => {
  assert.equal(describeReport("noSuchReport"), "");
  assert.equal(describeReport(undefined), "");
});

test("App.jsx: the category cards show the description, not a repeated 'Open report workspace'", () => {
  assert.doesNotMatch(app, /Open report workspace/);
  assert.match(app, /<span>\{describeReport\(reportId\)\}<\/span>/);
});
