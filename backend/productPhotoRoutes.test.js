"use strict";

/**
 * The three product-photo routes: who may reach them, whose photos they touch, and where the bytes
 * are allowed to go.
 *
 *   GET    /api/v3/product-photos      every photo in the caller's company
 *   PUT    /api/v3/products/:id/photo  set or replace one product's photo
 *   DELETE /api/v3/products/:id/photo  remove it (idempotent; `removed` tells the truth)
 *
 * Driven through `routeAuthCoverage.loadServerApp()` like the other route suites: the real Express
 * app, a stubbed database, no network, no `app.listen`. That proves what the handlers *said* to the
 * database and what they answered -- not what a real PostgreSQL would have returned, which needs a
 * live database this environment does not have.
 *
 * ## The rule the last block exists for
 *
 * A photo is deliberately not a column on `products`, because that row is copied into
 * `sync_change_log` and `product_audit_trail` on every edit and sent to every device in the
 * reference bootstrap. So the check is not only "the upsert happened" but "the bytes went into
 * `product_photos` and nowhere else" -- measured over every statement the route issued.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  AUTH_DENIAL_CODES,
  collectRouteAuthCoverage,
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
  setConnectionResponder,
  clearConnectionResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

const app = loadServerApp();
const SOURCE = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

const SESSION_COMPANY_ID = 3;
const OTHER_COMPANY_ID = 8;
const PRODUCT_ID = 41;

const PHOTO_BYTES = (() => {
  const bytes = Buffer.alloc(300, 0x5a);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  return bytes;
})();
const PHOTO_BASE64 = PHOTO_BYTES.toString("base64");
const PHOTO = `data:image/png;base64,${PHOTO_BASE64}`;

const PHOTO_ROUTE_KEYS = [
  "GET /api/v3/product-photos",
  "PUT /api/v3/products/:id/photo",
  "DELETE /api/v3/products/:id/photo",
];

const tokenFor = ({ userId = 7, role = "Owner", companyId = SESSION_COMPANY_ID, viewOnly = false } = {}) =>
  issueDeviceSession({
    userId,
    deviceId: "FZDEV-PRODUCT-PHOTOS",
    companyId,
    branchId: 1,
    role,
    viewOnly,
    secret: TEST_SIGNING_KEY,
  });

const PERMISSION_SQL = /role_permission_settings/i;

const permissionRow = (roleName, permissions = {}) => ({
  id: 7,
  full_name: `${roleName} User`,
  username: roleName.toLowerCase().replace(/\s+/g, "."),
  branch_id: 1,
  role_name: roleName,
  permissions,
});

const normalise = (sql) => String(sql).replace(/\s+/g, " ").trim();

/**
 * Drive one request with a scripted database, and report every statement it issued, on the pool and
 * on the transaction client alike.
 *
 * `answer(sql, values)` returns a result, or undefined for the empty-rows default.
 */
const call = async (method, url, {
  token = tokenFor(),
  body = undefined,
  role = permissionRow("Owner"),
  answer = () => undefined,
} = {}) => {
  const statements = [];
  let released = 0;
  const respond = (sql, values) => {
    statements.push({ sql: normalise(sql), values: values || [] });
    if (PERMISSION_SQL.test(sql)) return { rows: role ? [role] : [], rowCount: role ? 1 : 0 };
    const scripted = answer(normalise(sql), values || []);
    return scripted === undefined ? { rows: [], rowCount: 0 } : scripted;
  };
  setQueryResponder(respond);
  setConnectionResponder(() => ({
    query: async (sql, values) => respond(typeof sql === "object" && sql ? sql.text : sql, values),
    release: () => { released += 1; },
  }));
  try {
    const headers = token ? { authorization: `Bearer ${token}` } : {};
    const response = await probe(app, method, url, headers, body);
    return { response, statements, released };
  } finally {
    clearQueryResponder();
    clearConnectionResponder();
  }
};

const productIn = (companyId) => (sql, values) => {
  if (/^SELECT id FROM products WHERE id = \$1 AND company_id = \$2$/.test(sql)) {
    const matches = Number(values[0]) === PRODUCT_ID && Number(values[1]) === companyId;
    return { rows: matches ? [{ id: PRODUCT_ID }] : [], rowCount: matches ? 1 : 0 };
  }
  return undefined;
};

const UPDATED_AT = "2026-09-24T10:00:00.000Z";

const savingPhoto = ({ previous = null } = {}) => {
  const product = productIn(SESSION_COMPANY_ID);
  return (sql, values) => {
    const scripted = product(sql, values);
    if (scripted) return scripted;
    if (/^SELECT content_type, byte_size FROM product_photos/.test(sql)) {
      return { rows: previous ? [previous] : [], rowCount: previous ? 1 : 0 };
    }
    if (/^INSERT INTO product_photos/.test(sql)) {
      return { rows: [{ product_id: values[0], updated_at: UPDATED_AT }], rowCount: 1 };
    }
    return undefined;
  };
};

const find = (statements, pattern) => statements.filter(({ sql }) => pattern.test(sql));
const wrote = (statements) => statements.filter(({ sql }) => /^(INSERT|UPDATE|DELETE)\b/i.test(sql));

// -------------------------------------------------------------------------------------------
// Authentication: behind the default-deny gate, never on the public allow-list
// -------------------------------------------------------------------------------------------

test("all three photo routes are registered and refuse a caller with no verified session", async () => {
  const coverage = await collectRouteAuthCoverage();
  const byKey = new Map(coverage.map((route) => [route.key, route]));
  for (const key of PHOTO_ROUTE_KEYS) {
    assert.ok(byKey.has(key), `${key} is not registered`);
    assert.equal(byKey.get(key).authenticated, true, `${key} is reachable without a session: ${byKey.get(key).evidence}`);
  }
});

test("the photo routes are not on the public allow-list", () => {
  // The list lives in two places: the server's own set, and the policy in routeAuthCoverage.test.js.
  // Neither may name a photo route -- a POS without a session has no business reading a catalogue.
  const policy = fs.readFileSync(path.join(__dirname, "routeAuthCoverage.test.js"), "utf8");
  for (const key of PHOTO_ROUTE_KEYS) {
    assert.ok(!policy.includes(`"${key}"`), `${key} must not be allow-listed`);
  }
  assert.doesNotMatch(SOURCE, /PUBLIC_ROUTES[^;]*product-photos/s);
  assert.doesNotMatch(SOURCE, /PUBLIC_ROUTES[^;]*\/photo"/s);
});

for (const [method, url] of [
  ["GET", "/api/v3/product-photos"],
  ["PUT", `/api/v3/products/${PRODUCT_ID}/photo`],
  ["DELETE", `/api/v3/products/${PRODUCT_ID}/photo`],
]) {
  test(`${method} ${url} with a forged x-user-id and no token is refused before any business query`, async () => {
    const { response, statements } = await call(method, url, {
      token: null,
      body: method === "PUT" ? { photo: PHOTO } : undefined,
    });
    assert.equal(response.status, 401);
    assert.ok(AUTH_DENIAL_CODES.includes(response.body?.code), `unexpected refusal ${response.body?.code}`);
    assert.deepEqual(statements, [], "nothing may reach the database without a session");
  });
}

test("a view-only session cannot change a photo", async () => {
  // The Owner looking at another shop holds a token scoped to that shop. Writes are refused
  // app-wide for such a token; this pins that the photo routes did not step around it.
  const { response, statements } = await call("PUT", `/api/v3/products/${PRODUCT_ID}/photo`, {
    token: tokenFor({ viewOnly: true }),
    body: { photo: PHOTO },
    answer: savingPhoto(),
  });
  assert.ok(response.status === 401 || response.status === 403, `expected a refusal, got ${response.status}`);
  assert.deepEqual(wrote(statements), []);
});

// -------------------------------------------------------------------------------------------
// GET: company-scoped, from the verified session only
// -------------------------------------------------------------------------------------------

test("GET lists only the caller's company, bound from the session", async () => {
  const { response, statements } = await call("GET", "/api/v3/product-photos", {
    answer: (sql) => (/FROM product_photos pp/.test(sql)
      ? { rows: [{ product_id: PRODUCT_ID, photo_data: PHOTO, updated_at: UPDATED_AT }], rowCount: 1 }
      : undefined),
  });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body, {
    photos: [{ product_id: PRODUCT_ID, photo: PHOTO, updated_at: UPDATED_AT }],
    count: 1,
  });

  const [list] = find(statements, /FROM product_photos pp/);
  assert.ok(list, "the list query never ran");
  assert.match(list.sql, /pp\.company_id = \$1/, "the photo's own company must be filtered");
  assert.match(list.sql, /JOIN products p ON p\.id = pp\.product_id/);
  assert.match(list.sql, /p\.company_id = \$1/, "and the product's, which is the authority");
  assert.doesNotMatch(list.sql, /IS NULL OR/i, "a missing company must not widen the read to every company");
  assert.deepEqual(list.values, [SESSION_COMPANY_ID]);
});

test("GET refuses a company named in the query string rather than reading it", async () => {
  // The session is the only identity. A caller naming another company is refused by the app-wide
  // substitution check before the handler runs, so nothing is read at all.
  const { response, statements } = await call("GET", `/api/v3/product-photos?company_id=${OTHER_COMPANY_ID}`);
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "DEVICE_SESSION_SUBSTITUTION_REJECTED");
  assert.equal(find(statements, /product_photos/).length, 0, "a refused request must not have read anything");
});

test("GET needs no permission beyond a session, because the POS draws these", async () => {
  const { response, statements } = await call("GET", "/api/v3/product-photos", {
    token: tokenFor({ role: "Cashier" }),
    role: permissionRow("Cashier", {}),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { photos: [], count: 0 });
  assert.equal(find(statements, PERMISSION_SQL).length, 0);
});

test("GET reports a missing table as its own error, never as an empty list", async () => {
  const { response } = await call("GET", "/api/v3/product-photos", {
    answer: (sql) => {
      if (/FROM product_photos pp/.test(sql)) {
        const error = new Error('relation "product_photos" does not exist');
        error.code = "42P01";
        throw error;
      }
      return undefined;
    },
  });
  assert.equal(response.status, 500);
  assert.equal(response.body.code, "PRODUCT_PHOTO_STORAGE_MISSING");
  assert.equal(response.body.photos, undefined, "an error must not look like zero photos");
});

test("GET reports any other database failure with a distinct code", async () => {
  const { response } = await call("GET", "/api/v3/product-photos", {
    answer: (sql) => {
      if (/FROM product_photos pp/.test(sql)) throw new Error("connection reset");
      return undefined;
    },
  });
  assert.equal(response.status, 500);
  assert.equal(response.body.code, "PRODUCT_PHOTOS_LOAD_FAILED");
  assert.ok(response.body.message);
});

// -------------------------------------------------------------------------------------------
// PUT: permission, validation, company scope, and where the bytes go
// -------------------------------------------------------------------------------------------

const putPhoto = (options = {}) => call("PUT", `/api/v3/products/${PRODUCT_ID}/photo`, {
  body: { photo: PHOTO },
  answer: savingPhoto(),
  ...options,
});

test("PUT without the inventory permission is refused before anything is read or written", async () => {
  const { response, statements } = await putPhoto({
    token: tokenFor({ role: "Cashier" }),
    role: permissionRow("Cashier", { inventory: false }),
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "PRODUCT_PHOTO_PERMISSION_REQUIRED");
  assert.deepEqual(wrote(statements), []);
  assert.equal(find(statements, /FROM products/).length, 0, "a denied caller must not learn whether the product exists");
});

test("PUT asks for the inventory key, for the verified session user", async () => {
  const { statements } = await putPhoto({ token: tokenFor({ userId: 12, role: "Cashier" }), role: null });
  const [lookup] = find(statements, PERMISSION_SQL);
  assert.ok(lookup, "no permission lookup ran");
  assert.deepEqual(lookup.values, [12], "the actor is the token's user, not a request field");
  // And the key, read from the handler, since the lookup SQL does not carry it.
  const handler = SOURCE.slice(SOURCE.indexOf("const saveProductPhotoHandler = async"));
  assert.match(handler.slice(0, 800), /getPermissionUser\(req\.auth\.userId, PRODUCT_PHOTO_PERMISSION_KEY, \["Owner", "Admin"\]\)/);
  assert.match(SOURCE, /const PRODUCT_PHOTO_PERMISSION_KEY = "inventory";/);
});

test("PUT by a role granted inventory is allowed", async () => {
  const { response } = await putPhoto({
    token: tokenFor({ role: "Inventory Manager" }),
    role: permissionRow("Inventory Manager", { inventory: true }),
  });
  assert.equal(response.status, 200, response.text);
});

for (const [label, photo, code] of [
  ["no photo", undefined, "PHOTO_REQUIRED"],
  ["a GIF", `data:image/gif;base64,${Buffer.from("GIF89a....").toString("base64")}`, "PHOTO_FORMAT_UNSUPPORTED"],
  ["broken base64", "data:image/png;base64,@@@@", "PHOTO_NOT_BASE64"],
  ["a JPEG named as PNG", `data:image/png;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64")}`, "PHOTO_CONTENT_MISMATCH"],
  ["an oversized photo", `data:image/png;base64,${Buffer.concat([PHOTO_BYTES, Buffer.alloc(200 * 1024)]).toString("base64")}`, "PHOTO_TOO_LARGE"],
]) {
  test(`PUT with ${label} answers 400 ${code} and writes nothing`, async () => {
    const { response, statements } = await putPhoto({ body: photo === undefined ? {} : { photo } });
    assert.equal(response.status, 400);
    assert.equal(response.body.code, code);
    assert.ok(response.body.message.length > 10);
    assert.deepEqual(wrote(statements), []);
  });
}

test("PUT on another company's product answers exactly as a missing product does", async () => {
  const { response, statements, released } = await putPhoto({ answer: productIn(OTHER_COMPANY_ID) });
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { code: "PRODUCT_NOT_FOUND", message: "This product was not found." });
  const [lookup] = find(statements, /^SELECT id FROM products/);
  assert.deepEqual(lookup.values, [PRODUCT_ID, SESSION_COMPANY_ID], "the product is looked up inside the session's company");
  assert.deepEqual(wrote(statements), []);
  assert.equal(find(statements, /^ROLLBACK$/).length, 1);
  assert.equal(released, 1, "the connection must go back to the pool");
});

test("PUT on a non-numeric id is a 404, not a 500", async () => {
  const { response, statements } = await call("PUT", "/api/v3/products/abc/photo", { body: { photo: PHOTO } });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "PRODUCT_NOT_FOUND");
  assert.deepEqual(wrote(statements), []);
});

test("PUT stores the photo under the session's company and answers the contract shape", async () => {
  const { response, statements, released } = await putPhoto();
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body, { product_id: PRODUCT_ID, photo: PHOTO, updated_at: UPDATED_AT });

  const [upsert] = find(statements, /^INSERT INTO product_photos/);
  assert.ok(upsert, "the photo was never written");
  assert.match(upsert.sql, /ON CONFLICT \(product_id\) DO UPDATE/, "a second upload replaces the first");
  assert.deepEqual(upsert.values, [PRODUCT_ID, SESSION_COMPANY_ID, PHOTO, "image/png", PHOTO_BYTES.length, 7]);
  assert.equal(find(statements, /^COMMIT$/).length, 1);
  assert.equal(released, 1);
});

test("PUT refuses a body naming another company, and writes nothing", async () => {
  const { response, statements } = await putPhoto({ body: { photo: PHOTO, company_id: OTHER_COMPANY_ID } });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "DEVICE_SESSION_SUBSTITUTION_REJECTED");
  assert.deepEqual(wrote(statements), []);
});

test("PUT attributes the change to the session user, whatever actor the body names", async () => {
  // `updated_by` is not an identity claim, so the middleware lets it through; only the handler's
  // choice of actor decides whose name goes on the row. It must be the verified one.
  const { response, statements } = await putPhoto({ body: { photo: PHOTO, updated_by: 1, edited_by: 1 } });
  assert.equal(response.status, 200, response.text);
  const [upsert] = find(statements, /^INSERT INTO product_photos/);
  assert.equal(upsert.values[1], SESSION_COMPANY_ID);
  assert.equal(upsert.values[5], 7);
  const [audit] = find(statements, /^INSERT INTO product_audit_trail/);
  assert.equal(audit.values[4], 7);
});

test("PUT records one audit row with the type and size, never the bytes", async () => {
  const { statements } = await putPhoto({ answer: savingPhoto({ previous: { content_type: "image/jpeg", byte_size: 999 } }) });
  const audits = find(statements, /^INSERT INTO product_audit_trail/);
  assert.equal(audits.length, 1);
  const [audit] = audits;
  assert.match(audit.sql, /'PRODUCT_PHOTO_SET'/);
  assert.equal(audit.values[0], PRODUCT_ID);
  assert.deepEqual(JSON.parse(audit.values[1]), { content_type: "image/jpeg", byte_size: 999 });
  assert.deepEqual(JSON.parse(audit.values[2]), { content_type: "image/png", byte_size: PHOTO_BYTES.length });
  assert.equal(audit.values[3], "Product photo replaced");
  assert.equal(audit.values[4], 7);
});

test("PUT sends the photo bytes into product_photos and nowhere else", async () => {
  const { statements } = await putPhoto();
  const carriers = statements.filter(({ sql, values }) =>
    sql.includes(PHOTO_BASE64) || values.some((value) => String(value ?? "").includes(PHOTO_BASE64)));
  assert.equal(carriers.length, 1, "the bytes may appear in exactly one statement: the product_photos upsert");
  assert.match(carriers[0].sql, /^INSERT INTO product_photos\b/);
  assert.equal(find(statements, /sync_change_log/i).length, 0, "a photo change is not a sync change");
  assert.equal(find(statements, /UPDATE products\b/i).length, 0, "the products row must not change, or it is re-sent to every device");
});

test("PUT reports a failed write with a distinct code and rolls back", async () => {
  const saving = savingPhoto();
  const { response, statements } = await putPhoto({
    answer: (sql, values) => {
      if (/^INSERT INTO product_audit_trail/.test(sql)) throw new Error("disk full");
      return saving(sql, values);
    },
  });
  assert.equal(response.status, 500);
  assert.equal(response.body.code, "PRODUCT_PHOTO_SAVE_FAILED");
  assert.equal(find(statements, /^ROLLBACK$/).length, 1);
  assert.equal(find(statements, /^COMMIT$/).length, 0);
});

// -------------------------------------------------------------------------------------------
// DELETE: same scope and permission; idempotent, with `removed` telling the truth
// -------------------------------------------------------------------------------------------

const deletePhoto = (options = {}) => call("DELETE", `/api/v3/products/${PRODUCT_ID}/photo`, options);

const removingPhoto = (existing) => {
  const product = productIn(SESSION_COMPANY_ID);
  return (sql, values) => {
    const scripted = product(sql, values);
    if (scripted) return scripted;
    if (/^DELETE FROM product_photos/.test(sql)) {
      return { rows: existing ? [existing] : [], rowCount: existing ? 1 : 0 };
    }
    return undefined;
  };
};

test("DELETE without the inventory permission is refused before anything is read or written", async () => {
  const { response, statements } = await deletePhoto({
    token: tokenFor({ role: "Cashier" }),
    role: permissionRow("Cashier", {}),
    answer: removingPhoto({ content_type: "image/png", byte_size: 10 }),
  });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "PRODUCT_PHOTO_PERMISSION_REQUIRED");
  assert.deepEqual(wrote(statements), []);
});

test("DELETE on another company's product is a 404 and removes nothing", async () => {
  const { response, statements } = await deletePhoto({ answer: productIn(OTHER_COMPANY_ID) });
  assert.equal(response.status, 404);
  assert.equal(response.body.code, "PRODUCT_NOT_FOUND");
  const [lookup] = find(statements, /^SELECT id FROM products/);
  assert.deepEqual(lookup.values, [PRODUCT_ID, SESSION_COMPANY_ID]);
  assert.deepEqual(wrote(statements), []);
});

test("DELETE of an existing photo answers removed:true and audits type and size only", async () => {
  const { response, statements } = await deletePhoto({
    answer: removingPhoto({ content_type: "image/webp", byte_size: 4321 }),
  });
  assert.equal(response.status, 200, response.text);
  assert.deepEqual(response.body, { product_id: PRODUCT_ID, removed: true });

  const [removal] = find(statements, /^DELETE FROM product_photos/);
  assert.match(removal.sql, /company_id = \$2/);
  assert.deepEqual(removal.values, [PRODUCT_ID, SESSION_COMPANY_ID]);

  const audits = find(statements, /^INSERT INTO product_audit_trail/);
  assert.equal(audits.length, 1);
  assert.match(audits[0].sql, /'PRODUCT_PHOTO_REMOVED'/);
  assert.deepEqual(JSON.parse(audits[0].values[1]), { content_type: "image/webp", byte_size: 4321 });
  assert.equal(find(statements, /sync_change_log/i).length, 0);
  assert.equal(find(statements, /^COMMIT$/).length, 1);
});

test("DELETE when there is no photo is still a success, and says nothing was removed", async () => {
  const { response, statements } = await deletePhoto({ answer: removingPhoto(null) });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { product_id: PRODUCT_ID, removed: false });
  assert.equal(find(statements, /^INSERT INTO product_audit_trail/).length, 0, "no change, so no audit row");
});

// -------------------------------------------------------------------------------------------
// The photo stays off every road that copies product rows
// -------------------------------------------------------------------------------------------

test("no photo column was added to products, and nothing publishes product_photos to devices", () => {
  assert.doesNotMatch(SOURCE, /ALTER TABLE products ADD COLUMN IF NOT EXISTS (photo|image)/i);
  const bootstrap = fs.readFileSync(path.join(__dirname, "syncReferenceBootstrap.js"), "utf8");
  assert.doesNotMatch(bootstrap, /product_photos|photo_data/, "the reference bootstrap must not carry photo bytes");
  // The only statements in server.js that name photo_data are the table declaration, the upsert and
  // the list read. A fourth -- a copy into a log, a join into a product read -- fails here by name.
  const mentions = [...SOURCE.matchAll(/photo_data/g)].length;
  assert.equal(
    mentions,
    6,
    "photo_data may be named only by the CREATE TABLE, the list SELECT and its mapping, and the upsert "
    + "(its column list and both sides of its ON CONFLICT assignment)",
  );
});

test("none of the three handlers writes to the sync change log", () => {
  for (const name of ["listProductPhotosHandler", "saveProductPhotoHandler", "removeProductPhotoHandler"]) {
    const start = SOURCE.indexOf(`const ${name} = async`);
    assert.ok(start > 0, `${name} is missing`);
    // `\r?\n`: the shipped target is Windows, where the checkout has CRLF endings.
    const closing = /\r?\n\};\r?\n/g;
    closing.lastIndex = start;
    const end = closing.exec(SOURCE);
    assert.ok(end, `the end of ${name} was not found`);
    const body = SOURCE.slice(start, end.index);
    assert.doesNotMatch(body, /logSyncChange|sync_change_log/, `${name} must not publish a sync change`);
  }
});
