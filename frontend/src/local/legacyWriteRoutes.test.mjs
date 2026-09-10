import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The app must not call a legacy write route, because turning scope enforcement on refuses them.
 *
 * ## The decision this unblocks
 *
 * `GET /api/sync/pull` refuses the reference bootstrap unless
 * `FROOZERP_OPERATIONAL_SCOPE_MODE=enforce` (server.js ~12280):
 *
 *     Conflict - Reference bootstrap requires enforced operational-location scope
 *
 * The reference bootstrap is the only way a device with an empty local database is filled from the
 * cloud, so with the mode at its default of `off` a new counter — or a rebuilt machine — can never
 * receive the shop's data at all. That is what the DELL hit on 2026-09-09, and
 * `docs/auth-hardening-plan.md` records both that the default is `off` and that the live value was
 * never checked.
 *
 * Turning it on has a second effect: `operationalScope.js` starts refusing the 25 legacy write
 * routes with 426 CLIENT_UPGRADE_REQUIRED. The audit asserts that "the app makes no legacy write
 * calls, so refusing these costs nothing today". That sentence is the whole safety of the change,
 * and it was an assertion in a document rather than a checked fact.
 *
 * This checks it, and keeps checking it. The failure it prevents is specific and nasty: somebody
 * adds one write to a legacy path, every gate stays green because nothing here knows about scope
 * mode, and a counter starts getting 426 on a real action months later.
 *
 * ## How it matches
 *
 * A legacy path is the bare route (`POST /products`). The v3 replacement is the same word behind a
 * prefix (`POST /api/v3/products`), so a substring search reports every v3 call as a legacy one — a
 * first pass did exactly that and produced ten false hits. The route must therefore sit immediately
 * after the base-url expression: `` `${API_URL}/products` `` and never `` `${API_URL}/api/v3/products` ``.
 * The trailing guard stops `/products` matching `/products-summary`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => fs.readFileSync(path.join(here, relative), "utf8");

/** The routes `operationalScope.js` refuses under `enforce`, read from the module itself. */
const legacyWriteRoutes = () => {
  const source = read("../../../backend/operationalScope.js");
  const start = source.indexOf("const LEGACY_WRITE_ROUTES");
  assert.notEqual(start, -1, "the legacy write route list must still exist");
  const block = source.slice(start, source.indexOf("];", start));
  return [...block.matchAll(/\["(GET|POST|PUT|DELETE|PATCH)",\s*"([^"]+)"/g)]
    .map(([, method, route]) => [method, route]);
};

/** Every frontend file that can make a request. */
const frontendSources = () => {
  const localDir = path.join(here);
  const files = ["../App.jsx", ...fs.readdirSync(localDir).filter((name) => name.endsWith(".js")).map((name) => `./${name}`)];
  return files.map((file) => ({ file, source: read(file) }));
};

test("the legacy route list is read, not remembered", () => {
  // A hardcoded copy here would drift from the list the server actually refuses, and the drift
  // would show up as a working screen that stops working on a deployment somewhere else.
  const routes = legacyWriteRoutes();
  assert.ok(routes.length >= 20, `expected the full legacy write list, got ${routes.length}`);
  assert.ok(routes.some(([method, route]) => method === "POST" && route === "/products"));
});

test("the app writes only through /api/v3, so scope enforcement refuses nothing it does", () => {
  const routes = legacyWriteRoutes();
  const offenders = [];

  for (const { file, source } of frontendSources()) {
    const lines = source.split("\n");
    for (const [method, route] of routes) {
      const head = route.split("/:")[0];
      const verb = method.toLowerCase();
      const call = new RegExp(`axios\\.${verb}\\b`);
      // Immediately after the base-url expression, and not the head of a longer sibling.
      const bare = new RegExp(`\\}${head.replace(/\//g, "\\/")}(?![A-Za-z0-9-])`);
      lines.forEach((line, index) => {
        if (call.test(line) && bare.test(line)) {
          offenders.push(`${file}:${index + 1}  ${method} ${route}  ${line.trim().slice(0, 100)}`);
        }
      });
    }
  }

  assert.deepEqual(
    offenders,
    [],
    "these calls would be refused with 426 once FROOZERP_OPERATIONAL_SCOPE_MODE=enforce:\n" + offenders.join("\n"),
  );
});

test("the matcher can actually see a legacy call", () => {
  // Without this the test above passes on a broken regex, which is the failure mode of every
  // "nothing matched" assertion. A v3 call must not count; the bare one must.
  const head = "/products";
  const call = /axios\.post\b/;
  const bare = new RegExp(`\\}${head.replace(/\//g, "\\/")}(?![A-Za-z0-9-])`);
  const legacy = "await axios.post(`${API_URL}/products`, body, config);";
  const v3 = "await axios.post(`${API_URL}/api/v3/products`, body, config);";
  const sibling = "await axios.post(`${API_URL}/products-summary`, body, config);";

  assert.ok(call.test(legacy) && bare.test(legacy), "a bare legacy call must be caught");
  assert.ok(!bare.test(v3), "a v3 call must not be reported as legacy");
  assert.ok(!bare.test(sibling), "a longer sibling route must not be reported as legacy");
});
