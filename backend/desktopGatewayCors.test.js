const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { CORS_ALLOWED_REQUEST_HEADERS } = require("./desktopGateway");

const FRONTEND_SRC = path.join(__dirname, "..", "frontend", "src");

const sourceFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const full = path.join(dir, entry.name);
  if (entry.isDirectory()) return sourceFiles(full);
  if (!/\.(jsx?|mjs)$/.test(entry.name) || /\.test\.mjs$/.test(entry.name)) return [];
  return [full];
});

// Every `x-...` header name the screen's code writes as a string. A header the screen sends and
// the gateway's preflight does not allow is refused by the browser before it leaves: the screen
// sees "Network Error" and no log anywhere records a request. That is how every product add and
// edit in the desktop app failed while every server-side test passed.
const headersTheScreenSends = () => {
  const found = new Map();
  for (const file of sourceFiles(FRONTEND_SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/["'`](x-[a-z0-9-]+)["'`]/gi)) {
      const name = match[1].toLowerCase();
      if (!found.has(name)) found.set(name, path.relative(FRONTEND_SRC, file));
    }
  }
  return found;
};

test("the gateway's preflight allows every custom header the screen sends", () => {
  const allowed = new Set(CORS_ALLOWED_REQUEST_HEADERS);
  const sent = headersTheScreenSends();
  assert.ok(sent.has("x-idempotency-key"), "the scan must see the header every operational write carries");
  const missing = [...sent].filter(([name]) => !allowed.has(name)).map(([name, file]) => `${name} (${file})`);
  assert.deepEqual(missing, [], `add these to CORS_ALLOWED_REQUEST_HEADERS in desktopGateway.js: ${missing.join(", ")}`);
});

test("the preflight answer is built from that list, not a second copy of it", () => {
  const source = fs.readFileSync(path.join(__dirname, "desktopGateway.js"), "utf8");
  assert.match(source, /"access-control-allow-headers": CORS_ALLOWED_REQUEST_HEADERS\.join\(","\)/);
  assert.equal(source.match(/access-control-allow-headers/g).length, 1);
});
