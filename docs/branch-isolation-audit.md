# Branch / company isolation audit — `docs/auth-hardening-plan.md` §5

**Date:** 2026-08-21 · **Method:** static reading only. `server.js` was never loaded as a module.
**Answer to the question asked:** **Yes.** A signed-in user of Branch A can read essentially all of
Branch B's business data through the legacy REST surface, and can write into Branch B on a smaller
but non-empty set of routes. Nothing about A-3/A-4/A-4b/A-4c changed this — those stages fixed *who
you are*, not *what you may see*.

---

## 0. Provenance of every number, and the concurrency caveat

All `server.js` line numbers below are against a snapshot taken at **2026-08-21 01:07:31 UTC**,
`md5 905122f912044b6eab5cfa81970ffc79`, **20 123 lines**, kept at
`scratchpad/server.snapshot.js`.

**Another agent is editing `backend/server.js` concurrently.** At 01:19:26 UTC the working file was
**20 236 lines**, `md5 3bea1611bcb7ca8eebc0fdf8165eee5c` — the A-4d master-data work (a
`customer_accounts` permission key and guards on `/accounts`, `/suppliers`, `/customers`). Measured
insert points: +1 line after 943, +26 after 2999, and further blocks at ~6241, ~13035, ~13141,
~13788, ~13853, ~13919, ~13972, ~14018, ~16830. **Net drift is +113 lines by end of file: an anchor
below 943 is exact, and above it the real file's line number is up to 113 *higher* than the one
quoted here.** Re-find by the quoted text, not by the number.

Other files (`authMiddleware.js`, `operationalScope.js`, `operationalV3.js`, `scopeManagement.js`,
`aiBusinessAssistantService.js`, `deviceSession.js`, `migrations/cloud/*.sql`) were read live and
were not being edited.

Counts, all measured:

| Fact | Measured |
| --- | --- |
| Route registrations, `server.js` | **214** (216 counting the two array-path registrations) |
| Route registrations, `aiBusinessAssistantService.js` | **42** |
| Route registrations, `operationalV3.js` + `scopeManagement.js` | **20 + 7 = 27** |
| Total | **285** — matches the A-4 record |
| `req.auth.userId` read sites in `server.js` | **124** |
| **`req.auth.companyId` read sites, whole backend** | **0** |
| **`req.auth.branchId` read sites, whole backend** | **0** |
| Row-level-security policies in the schema | **0** — `grep -ril "CREATE POLICY\|ROW LEVEL SECURITY"` over `backend/` and `src-tauri/migrations/` returns nothing |

The zero in the middle of that table is the whole finding in one line. The token has carried a
verified `company_id` and `branch_id` since A-3 (`authMiddleware.js:94-104`). **Nothing reads them.**

---

## Part 1 — How scoping is *supposed* to work

There are two tenancy models in this codebase, and only one of them is enforced.

### 1.1 The tenancy columns actually exist

Measured from the `CREATE TABLE IF NOT EXISTS` bootstrap in `server.js` plus
`backend/migrations/cloud/*.sql`:

| Group | Tables | Tenancy columns |
| --- | --- | --- |
| Transactional | `sales`, `sale_payments`, `sale_returns`, `purchases`, `inventory_batches`, `stock_transactions`, `stock_adjustments`, `waste_entries`, `customer_ledger`, `customer_payments`, `supplier_payments`, `expenses`, `contra_entries`, `sync_change_log`, `operational_location_products` | `company_id`, `branch_id`, `operational_location_id` |
| Master data | `products`, `product_categories`, `customers`, `suppliers` | `company_id` only (`migrations/cloud/009_operational_location_foundation.sql:29-32`) — **branch-shared by design** |
| Child rows | `sale_items`, `purchase_items`, `sale_return_items`, `sale_batch_allocations` | none — inherit from parent |
| Genuinely untenanted | `accounts`, `lot_discounts`, `sale_rate_history`, `sale_rate_settings` | **none at all** |

So "is this row Branch B's?" is an answerable question for every transaction table. The schema is
not the problem.

### 1.2 Where `branch_id` comes from on a request, today

Four different sources, in decreasing order of trustworthiness:

**(a) The verified session claim — exists, unused for scoping.**
`authMiddleware.js:94-104` builds `req.auth` from verified claims including
`companyId: Number(claims.company_id)` and `branchId: Number(claims.branch_id)`. The claim is minted
at `/login`:

```js
// server.js:10839-10843
const canonicalBranchId = operationalAssignment?.branch_id
  || device.assigned_branch_id
  || user.branch_id
  || 1;
```

and signed into the token at `server.js:10881-10891`. **Read sites for `req.auth.branchId`: zero.**

**(b) The canonical operational context — the real, enforced model.**
`operationalScope.js:66-153`, `createOperationalScopeService(pool).resolve()`. It ignores everything
the caller said and derives scope from a five-way join —
`authorized_devices → device_assignments → operational_locations → branches → staff_location_assignments`
(`operationalScope.js:93-116`) — returning `{company_id, branch_id, operational_location_id, …}`
only if the *user and the device* share an active approved assignment. It then re-checks anything the
caller did supply, via `validateSubmittedScope` (`operationalScope.js:21-30`), which rejects a
mismatch on `company_id`, `branch_id` or `operational_location_id` with
`403 SCOPE_SUBSTITUTION_REJECTED`, and refuses writes under `scope=ALL_LOCATIONS`
(`operationalScope.js:149-151`).

`resolveV3OperationalContext` (`server.js:9464-9528`) wraps that: verify token → substitution check →
`operationalScopeService.resolve` → then cross-check that the *token's* `company_id`/`branch_id` and
`session_revocation_version` still equal the database's, else `401 DEVICE_SESSION_SCOPE_STALE`
(`server.js:9503-9517`).

Two adapters consume it. `v3WriteAdapter` (`server.js:9608-9642`) does the important thing — it
**overwrites the request body** with server-derived values:

```js
req.body = { ...(req.body || {}),
  company_id: resolved.context.company_id,
  branch_id: resolved.context.branch_id,
  operational_location_id: resolved.context.operational_location_id,
  user_id: …, created_by: …, updated_by: …, device_id: …, };
```

`v3ReadAdapter` (`server.js:9645-9657`) sets `req.v3OperationalContext` and nothing else.
`operationalV3.js:523-524`'s `use()` applies the same `resolveContext` to all 20 v3 routes, and
`scopeManagement.js` inherits it for its 7. **This design is correct.** Every query in
`operationalV3.js` and `scopeManagement.js` binds `context.company_id` / `context.branch_id` /
`context.operational_location_id`, never a request field. Cross-branch admin actions deliberately use
a *different* field name — `target_branch_id` (`scopeManagement.js:177, 201, 228, 260`) — and validate
it against `context.company_id` before use (`scopeManagement.js:182-183`, `validateLocation`).

**(c) A request field, pinned by the substitution check.**
`submittedIdentityFrom` (`authMiddleware.js:115-132`) collects, per field, *every* place it could
arrive:

```js
user_id:    [headers["x-user-id"], body.user_id, query.user_id],
device_id:  [headers["x-device-id"], body.device_id, query.device_id],
company_id: [body.company_id, query.company_id],
branch_id:  [body.branch_id, query.branch_id],
```

`rejectDeviceSessionSubstitution` (`deviceSession.js:89-110`) then rejects any supplied value that
differs from the claim. **Two properties matter enormously and are easy to miss:**

- Line 99: `if (value == null || String(value).trim() === "") continue;` — **an omitted field is
  always allowed.** The check constrains *disagreement*, never *absence*.
- The covered names are exactly `user_id`, `device_id`, `company_id`, `branch_id`. **A branch named
  under any other key is unchecked** — `assigned_branch_id`, `target_branch_id`, `req.params.branchId`,
  `to_branch_id`, `account_key`, `supplier_id`, a bare row `id`.

**(d) Nothing at all.** The majority case — see Part 2.

### 1.3 `FROOZERP_OPERATIONAL_SCOPE_MODE`

Read once at `server.js:95`:

```js
const operationalScopeMode = normalizeScopeMode(process.env.FROOZERP_OPERATIONAL_SCOPE_MODE);
```

`normalizeScopeMode` (`operationalScope.js:14-17`) accepts `off` / `shadow` / `enforce` and
**defaults to `off` for any unset or unrecognised value**. Nothing in the repository sets it —
`backend/railway.json` and `backend/Dockerfile` do not; the only assignments are three isolated test
harnesses (`scripts/multibranch/isolated-*.js`) and `routeAuthCoverage.js:152` which pins `off`
deliberately. **What the live Railway service has in its environment is not determined and must not
be determined from here.**

`shadow` is accepted by the normaliser and **is never branched on** — every one of the six consumers
(`server.js:524, 8220, 9293, 9404, 9862, 9922, 9970, 10015`) tests `=== ENFORCE` or `!== ENFORCE`.
`shadow` therefore behaves exactly as `off`. That is worth knowing before anyone sets it expecting a
dry run.

What `enforce` turns on:
1. A **426 protocol-upgrade gate** (`server.js:522-534`) for paths matching
   `requiresOperationalProtocolUpgrade` (`operationalScope.js:53-59`).
2. Signature verification on `/api/sync/*` (`server.js:9404`, `resolveSyncRequestContext`).
3. Per-operation batch scope validation on sync push (`server.js:9862-9873`).
4. The canonical `operationalScopeService` inside `requireSyncContext` (`server.js:8220-8240`).
5. Reference bootstrap on `/api/sync/pull` (`server.js:9922`).

**The 426 gate is a token-boundary regex and leaks badly.** `LEGACY_OPERATIONAL_ROUTE` requires a `/`
or end-of-string after each alternative, so every hyphenated sibling escapes it. Measured over the
216 `server.js` path registrations: **64 blocked, 152 still reachable in `enforce`.** Business-data
routes that survive `enforce` include:

`/stock`, `/stock-inventory`, `/stock-inventory/audit`, `/stock-adjustments`, `/sale-rates`,
`/sale-rates/bulk`, `/sale-rate-history`, `/lot-discounts`, `/customer-ledger`, `/supplier-ledger`,
`/customer-summary`, `/supplier-summary`, `/customer-payments`, `/supplier-payments`,
`/pending-bills/customer`, `/contra-entries`, `/waste-entries`, `/sales-history`,
`/sales-history/items`, `/sales-history/lots`, `/sales-history/:id`, `/sales-report/changes`,
`/dashboard-metrics`, `/dashboard-analytics`, `/dashboard-sales-trend`, `/dashboard-profit-trend`,
`/dashboard-expense-trend`, `/product-duplicate-archive-log`, and all **42 `/api/ai/*` routes**.

So `enforce` is not a fix for isolation. It is a fix for *some* of it.

---

## Part 2 — Read paths

### 2.1 Classification key

- **SCOPED** — the filter value is derived server-side from the verified session or from the
  canonical device/staff assignment. The caller cannot influence it.
- **SCOPED_BY_REQUEST** — the filter exists but its value comes from the request. After A-4 this is
  *pinned* when the field is literally named `branch_id`/`company_id` in body or query, and
  *unpinned* under any other name. **In every case, omitting the field is permitted** — see 1.2(c).
- **UNSCOPED** — the query returns rows from every branch and every company.

### 2.2 Headline counts (`server.js`, 214 registrations)

| Class | Count |
| --- | --- |
| SCOPED (`/api/v3/*` and the v3 context resolvers) | 26 |
| SCOPED, conditional on `enforce` (`/api/sync/push`, `/pull`, `/status`) | 3 |
| SCOPED_BY_REQUEST | 8 |
| **UNSCOPED — touches a branch-carrying table with no branch filter** | **69** (42 reads + 27 writes) |
| UNSCOPED at company level, or against a table with no tenancy column at all | 8 (listed in 2.4) |
| Remainder | 100 |

The 100 is not all clean. It contains **~17 master-data CRUD registrations** (`/products`,
`/product-categories`, `/suppliers`, `/customers` and their v3 twins) whose only tenancy predicate is
the company-only fail-open form `($n::INTEGER IS NULL OR company_id = $n)` — see 3.1's second bullet.
Those are correctly branch-shared, so they are not branch-isolation defects, but they are
**company**-isolation defects on the legacy path. The rest is genuinely non-business: health,
version, time, settings, integrations, backup, device control, the SPA fallback, and the
auth/recovery flows that operate on the caller's own row.

Plus, outside `server.js`: **42 UNSCOPED** (`/api/ai/*`) and **27 SCOPED** (`operationalV3.js` +
`scopeManagement.js`, of which 2 queries inside one route leak — see F-6).

**Total UNSCOPED business-data registrations: 69 + 8 + 42 = 119 of 285.**

Derivation of the 69, so it can be re-checked: 37 routes whose own body contains a business `SELECT`
with no `branch_id` predicate; **+10** legacy twins whose predicate is present but disabled (3.1);
**+22** routes that delegate to a helper (`getDashboardSummary`, `loadUnifiedAccounts`,
`getSupplierSummaryRows`, `getCustomerSummaryRows`, `loadSalesHistoryStructured`,
`getBalanceSheetSnapshot`, `getCashBookReport`, `stockInventorySelectSql`,
`addOpeningStockLotsForProduct`), each of which was opened and confirmed to contain **zero**
`branch_id`/`company_id` references.

### 2.3 UNSCOPED — the exhaustive list

Grouped by module. Line numbers are the route registration in the snapshot.

**Sales & POS reads (9)**

| Line | Route | Why |
| --- | --- | --- |
| 18822 | `GET /sales` | `FROM sales s LEFT JOIN … GROUP BY s.id` — no `WHERE` at all (18864-18873) |
| 19886 | `GET /sales/:id` | keyed on `id` only |
| 19030 | `GET /sales-report/changes` | `FROM sales`, date range only |
| 18987 | `GET /sales-history` | → `loadSalesHistoryStructured` @18888, 0 branch/company refs |
| 18997 | `GET /sales-history/items` | same helper |
| 19007 | `GET /sales-history/lots` | same helper |
| 19017 | `GET /sales-history/:id` | same helper, date range `1900-01-01 → 2999-12-31` |
| 19068 | `GET /sale-returns` | `sale_returns JOIN sales`, no branch |
| 19107 | `GET /sale-returns/options/:saleId` | keyed on `saleId` |

**Inventory & stock reads (5)**

| Line | Route | Why |
| --- | --- | --- |
| 12610 | `GET /inventory` | `stockInventorySelectSql` @11752, 0 branch/company refs |
| 12626 | `GET /stock` | `products JOIN inventory_batches`, no branch |
| 14000 | `GET /stock-inventory` | same select fragment |
| 12484 | `GET /stock-adjustments` | `stock_adjustments JOIN inventory_batches` |
| 11377 | `GET /products` | product list carries per-lot stock from `inventory_batches`, unfiltered |

**Rates & discounts (2)** — 7730 `GET /lot-discounts` and 12651 `GET /sale-rates`, both of which
read `inventory_batches`. `lot_discounts`, `sale_rate_history` and `sale_rate_settings` themselves
carry **no tenancy column**, so those tables cannot be scoped without a schema change (F-7).

**Money, ledgers & accounts (10)**

| Line | Route | Why |
| --- | --- | --- |
| 12973 | `GET /accounts` | `loadUnifiedAccounts` @12822 → `accounts`, `customer_payments`, `supplier_payments`, 0 branch refs |
| 13183 | `GET /accounts/outstanding` | same helper |
| 13354 | `GET /accounts/payments` | `getUnifiedPaymentRows` @12865, 0 branch refs |
| 13200 | `GET /accounts/ledger` | `sales`+`sale_payments`+`customer_payments`+`purchases`+`supplier_payments`, no branch |
| 14141 | `GET /customer-ledger` | no branch |
| 16417 | `GET /supplier-ledger` | no branch |
| 14028 | `GET /pending-bills/customer` | no branch |
| 16219 | `GET /supplier-payments` | no branch |
| 14379 | `GET /contra-entries` | no branch |
| 15997 | `GET /expenses` | no branch |

**Parties (4)** — 13699 `GET /suppliers` and 13847 `GET /supplier-summary` route through
`getSupplierSummaryRows` @3372 (`purchases`, `supplier_payments`, `suppliers` — 0 branch refs);
13859 `GET /customers` and 13949 `GET /customer-summary` through `getCustomerSummaryRows` @3554
(`sales`, `sale_payments`, `customer_payments`, `expenses`, `purchases`, `supplier_payments` —
0 branch refs). These aggregate *transactional* balances onto company-level master rows, so a
Branch A user sees each party's company-wide receivable/payable.

**Dashboards & reports (10)**

| Line | Route | Helper |
| --- | --- | --- |
| 14268 | `GET /dashboard-metrics` | `getDashboardSummary` @4243 — `sales`, `purchases`, `expenses`, `inventory_batches`, `waste_entries`, `sale_returns`, `supplier_payments`. 0 branch refs |
| 14280 | `GET /dashboard-analytics` | `getDashboardAnalyticsPayload` |
| 14292 | `GET /dashboard-sales-trend` | `getDashboardSalesTrend` |
| 14305 | `GET /dashboard-profit-trend` | `getDashboardProfitTrend` |
| 14318 | `GET /dashboard-expense-trend` | `getDashboardExpenseTrend` |
| 14331 | `GET /reports/balance-sheet` | `getBalanceSheetSnapshot` @3661, 0 branch/company refs in 200 lines |
| 14358 | `GET /reports/cash-book` | `getCashBookReport` @3826, 0 refs |
| 14446 | `GET /reports/balance-sheet/details/:lineKey` | 0 refs |
| 14697 | `GET /reports/day-book` | 9 business tables, 0 refs |
| 14896 | `GET /reports/summary` | 1 099 lines, 10 business tables, **0 occurrences of `branch_id` or `company_id`** |

**Purchases & waste (2)**

| Line | Route | Why |
| --- | --- | --- |
| 16943 | `GET /purchases` | `purchases JOIN purchase_items JOIN products LEFT JOIN inventory_batches`, no branch |
| 19352 | `GET /waste-entries` | `waste_entries JOIN products`, no branch |

9 + 5 + 2 + 10 + 4 + 10 + 2 = **42**, which is the read half of the 69.

**FROST / AI (42, in `aiBusinessAssistantService.js`, counted separately from the 69)** — every route in `aiBusinessAssistantService.js:1583-2181`. The whole file
contains 11 mentions of `branch_id`/`company_id`, and they are all *writes* of literal `1`:
`const filters = ["company_id = 1"]` (line 572), `VALUES (1, 1, $1, …)` into `ai_alerts` (1295-1297),
`VALUES (1, $1, …)` into `ai_conversations` (1560-1563) and `ai_audit_log` (1574-1576). The fact
queries that produce the answers — `FROM sales` @239/398/675/1259, `FROM purchases` @308/328,
`FROM expenses` @415/522, `FROM inventory_batches` @476/809/963/1059 — carry **no tenancy predicate
whatsoever**. FROST will happily narrate Branch B's margins to a Branch A cashier who has
`ai_assistant_view` (`aiBusinessAssistantService.js:1584`, fallback roles include `Cashier`).

**Also unscoped, cross-company, in the otherwise-clean v3 admin surface:**
`GET /api/v3/admin/scope-management` (`scopeManagement.js:96`) branch/location/assignment queries all
bind `context.company_id` correctly, **but two do not**:
`SELECT u.id, u.full_name, u.username, u.active, u.role_id … FROM users u … WHERE u.active = TRUE`
(line 110-111) and `FROM authorized_devices WHERE status = 'PENDING'` (line 113-115). Company-wide
Owner route leaking the other company's user list and pending devices.

The **27 UNSCOPED writes** are enumerated in Part 3.3, because what matters about them is not what
they return but where they land.

### 2.4 UNSCOPED against tables that have no tenancy column, or at company level (8)

These leak across branches too, but no middleware can fix them because the row carries no branch:

| Line | Route | Table |
| --- | --- | --- |
| 6549 | `GET /users` | `users` — every user row in the database, all companies, including `locked_until`, `recovery_email`, `recovery_mobile`, verification flags, `session_revocation_version`. Gate is `requireRateManager` only (`server.js:6551`) |
| 11226 | `GET /product-duplicate-archive-log` | `product_duplicate_archive_log` |
| 11827 | `GET /products/:id/lots` | `product_audit_trail` |
| 12443 | `GET /stock-inventory/audit` | `product_audit_trail` |
| 12511 | `GET /lots/:lotId/audit-trail` | `product_audit_trail` |
| 12800 | `GET /sale-rate-history` | `sale_rate_history` |
| 13661 | `GET /accounts/payments/:paymentKey/audit` | `customer_payment_audit`, `supplier_payment_audit` |
| 19497 | `GET /sales/:id/audit` | `sale_audit_trail` |

Every audit-trail table in the schema lacks `branch_id`. So even after the main fix, one branch's
operator can read the full edit history of another branch's lots, sales and payments — including the
names of the other branch's staff, via `LEFT JOIN users u ON u.id = pat.edited_by`
(`server.js:11808`, `11844`, `12461`, `12525`, `14014`).

### 2.5 SCOPED_BY_REQUEST reads

| Line | Route | Value source | Pinned by A-4? |
| --- | --- | --- | --- |
| 10051 | `GET /api/owner/dashboard-foundation` | `parsePositiveInteger(req.query.branch_id) \|\| 1` (10053) | Yes for a *supplied* value; **no** for an omitted one — see Finding 3 |
| 5547 | `GET /api/cloud/device/status` | `req.query.branch_id \|\| configuredBranchId` (5550) | Yes |
| 5488 | `GET /api/cloud/health` | `req.query.branch_id \|\| configuredBranchId \|\| 1` (5493) | Yes |
| 9750 | `GET /api/device/identity` | `req.query.branch_id` (9755) → `requireSyncContext` | Yes |
| 9796 | `GET /api/branch/status` | `req.query.branch_id` (9801) → `requireSyncContext` | Yes |
| 9916 | `GET /api/sync/pull` | `resolveSyncRequestContext` — request body in `off`, claims in `enforce` | Yes |
| 10011 | `GET /api/sync/status` | same | Yes |

`requireSyncContext` (`server.js:8164-8240`) deserves credit: even in `off` mode it independently
verifies `device.assigned_branch_id === branch_id` (8200-8202) and that user, branch and device agree
on company (8204-8208). It is the single best-defended scoping path in the legacy code.

---

## Part 3 — Write paths

### 3.1 The structural defect: 22 legacy twins of scoped v3 handlers

Twenty-two handler functions are registered **twice** — once under `/api/v3/…` behind
`v3WriteAdapter`/`v3ReadAdapter`, and once under a legacy path with **no adapter**. Measured by
resolving each registration's handler identifier to its top-level definition (21 found
automatically; `addOpeningStockLotsForProduct` is the 22nd — its v3 registration wraps the call in
an inline arrow, so an identifier match misses it, which is itself a warning about how this class of
duplicate hides):

| Handler | Legacy registration | v3 registration |
| --- | --- | --- |
| `listProductCategoriesHandler` | `GET /product-categories` @10959 | @10960 |
| `createProductCategoryHandler` | `POST /product-categories` @11036 | @11037 |
| `updateProductCategoryHandler` | `PUT /product-categories/:id` @11123 | @11124 |
| `deactivateProductCategoryHandler` | `DELETE /product-categories/:id` @11223 | @11224 |
| `createProductHandler` | `POST /products` @11550 | @11551 |
| `updateProductHandler` | `PUT /products/:id` @11677 | @11678 |
| `addOpeningStockLotsForProduct` | `POST /products/:id/opening-stock` @11740, `…/opening-stock-lots` @11742 | @11743, @11746 |
| `updateInventoryLotHandler` | `PUT /inventory-lots/:lotId` \| `/lots/:lotId` @11997 | @11998 |
| `addInventoryLotQuantityHandler` | `POST /inventory-lots/:lotId/add-quantity` @12069 | @12070 |
| `adjustInventoryLotHandler` | `POST /inventory-lots/:lotId/adjust` \| `/lots/:lotId/adjust-stock` @12187 | @12188 |
| `deactivateInventoryLotHandler` | `POST /inventory-lots/:lotId/deactivate` @12265 | @12266 |
| `reactivateInventoryLotHandler` | `POST /inventory-lots/:lotId/reactivate` @12343 | @12344 |
| `cancelProductHandler` | `POST /products/:id/cancel` @12607 | @12608 |
| `createPurchaseBillHandler` | `POST /purchase-bill` @17648 | @17649 |
| `updatePurchaseHandler` | `PUT /purchase/:id` @17955 | @17956 |
| `completePurchaseBillHandler` | `POST /purchase/:id/complete-bill` @18143 | @18144 |
| `cancelPurchaseHandler` | `POST /purchase/:id/cancel` @18260 | @18261 |
| `createSaleHandler` | `POST /sales` @18819 | @18820 |
| `createSaleReturnHandler` | `POST /sale-returns` @19349 | @19350 |
| `createWasteEntryHandler` | `POST /waste-entries` @19494 | @19495 |
| `updateSaleHandler` | `PUT /sales/:id` @19787 | @19788 |
| `cancelSaleHandler` | `POST /sales/:id/cancel` @19883 | @19884 |

Inside the shared handler the scope filter is written as an **opt-in predicate that switches itself
off when the parameter is null**. The full `company_id AND branch_id AND operational_location_id`
form appears **13 times** — at `server.js` lines **11877, 12016, 12091, 12205, 12283, 17449, 17675,
17979, 18165, 19179, 19398, 19535, 19807**:

```js
const context = req.v3OperationalContext;          // undefined on the legacy registration
const lotResult = await client.query(
  `SELECT * FROM inventory_batches
   WHERE id = $1
     AND ($2::INTEGER IS NULL OR (
       company_id = $2 AND branch_id = $3 AND operational_location_id = $4
     ))
   FOR UPDATE`,
  [lotId, context?.company_id || null, context?.branch_id || null,
   context?.operational_location_id || null]
);
```

`?.` plus `|| null` means the legacy call binds `$2 = NULL`, and `NULL::INTEGER IS NULL` is `TRUE`,
so **the entire tenancy conjunct evaluates true and the row is selected by primary key alone**. There
are **45** occurrences of `$n::INTEGER IS NULL OR` in the file, out of 58 `IS NULL OR` overall (the
other 13 are ordinary nullable-column logic such as `sla.effective_from IS NULL OR …`). They split
three ways, and the distinction matters:

- **13 full-triple, reached with NULL on a legacy path** — the list above. **Fail-open in practice.**
- **17 company-only, same polarity, same cause** — `($n::INTEGER IS NULL OR company_id = $n)` at
  10946, 10947, 10976, 11054, 11067, 11087, 11140, 11151, 11456, 11573, 11604, 11696, 12552, 16726,
  16738, 17449, 19398, each bound from `req.v3OperationalContext?.company_id || null`. **Fail-open
  in practice**, at company granularity.
- **15 in the sync/context paths** (8490-8492, 8522-8524, 8552-8554, 8626-8627, 10019-10023) where
  `company_id` and `branch_id` come from a resolved context and are never null; only the
  `operational_location_id` leg is deliberately optional under `off`. **Not fail-open** — but it does
  mean sub-branch isolation is unenforced by default.

So 30 of the 45 are load-bearing defects, not 45. That distinction is worth keeping: a fix that
rewrites all 45 identically will break the sync paths.

**A default that disables a security filter is the inverse of the rule `CLAUDE.md` already states
about errors: "Errors must never render as zero." Here, an absent scope renders as "all scopes".**

### 3.2 Can a user of Branch A write a row that lands in Branch B?

**By naming another branch under the checked name — no.** `body.branch_id` and `query.branch_id` are
covered by `submittedIdentityFrom` and rejected on mismatch. This is the one place A-4 accidentally
delivered isolation.

**By naming another branch under an unchecked name — yes.** Measured, the unchecked branch-selector
fields are:

| Field | Site | Guarded? |
| --- | --- | --- |
| `assigned_branch_id` | `readDevicePayload` `server.js:8081`; `PUT /settings/devices/:deviceId` `server.js:10305` | **No** — not in `submittedIdentityFrom`, no company/branch check on the target device |
| `target_branch_id` | `scopeManagement.js:177, 201, 228, 260`; `operationalV3.js:1010` | Yes — validated against `context.company_id` before use |
| `req.params.branchId` | `scopeManagement.js:149` | Yes — `WHERE id = $1 AND company_id = $2` |

**By omitting the field and hitting a default — yes, in several places.** Every `|| 1` and
`COALESCE(…, 1)` on a branch, measured (32 sites total; the ones that determine where a row lands):

| Line | Expression | Effect |
| --- | --- | --- |
| **8258** | `const logSyncChange = async (client, { branchId = 1, … })` | **Default parameter.** Any caller that omits `branchId` publishes the change into Branch 1's sync log — which is what other devices replicate. |
| **11440** | `branchId: 1,` inside `createProductHandler` | Hard-coded. Auto-created product categories always publish to Branch 1. |
| 11492 | `branchId: parsePositiveInteger(branch_id) \|\| 1` (`createProductHandler`) | Omitted → Branch 1 |
| 11656 | `branchId: req.v3OperationalContext?.branch_id \|\| 1` (`updateProductHandler`) | Legacy path → Branch 1 |
| 11711 | `branchId: parsePositiveInteger(req.body.branch_id) \|\| 1` (opening-stock lots) | Omitted → **opening stock lot created in Branch 1** |
| 11967 | `branchId: context?.branch_id \|\| lot.branch_id \|\| 1` | Legacy path → the lot's own branch, else 1 |
| 12584 | `branchId: req.v3OperationalContext?.branch_id \|\| 1` (`cancelProductHandler`) | Legacy path → Branch 1 |
| **6603** | `parsePositiveInteger(req.body.branch_id) \|\| manager.branch_id \|\| 1` (`POST /users`) | **`manager` comes from `requireRateManager` (`server.js:1011-1025`), whose `SELECT` returns only `u.id, u.full_name, r.role_name` — `manager.branch_id` is *always* `undefined`.** The middle term is dead; the effective expression is `req.body.branch_id || 1`. A Branch-2 admin who omits `branch_id` creates the user in Branch 1. |
| **10405** | `POST /settings/counters` → `parsePositiveInteger(req.body.branch_id) \|\| 1` | Omitted → counter created in Branch 1 |
| 10350 | `POST /settings/activation-codes` → `… \|\| 1` | Omitted → activation code minted for Branch 1 |
| **8081** | `assigned_branch_id: parsePositiveInteger(body.assigned_branch_id \|\| body.branch_id) \|\| 1` | New device registers into Branch 1 by default, or into any named branch |
| 8123 | `assigned_branch_id = COALESCE($3, assigned_branch_id, 1)` (`approveDevice`) | Approval with no branch → Branch 1 |
| 10053 | `GET /api/owner/dashboard-foundation` → `req.query.branch_id \|\| 1` | Read, see **F-3** |

**By omitting the field and hitting `NULL` — yes, and this is subtler.** These money routes write
`parsePositiveInteger(req.body.branch_id)`, which returns **`null`** when the field is absent:
`server.js:13409`, `13434` (`POST /accounts/payments`), `13502`, `13541`
(`PUT /accounts/payments/:paymentKey`), `13990` (`POST /customer-payments`), `14435`
(`POST /contra-entries`), `16084` (`POST /expenses`), `16140` (`PUT /expenses/:id`), `16247`
(`POST /supplier-payments`), `16343` (`PUT /supplier-payments/:id`), `19575` (`PUT /sales/:id`).

A `NULL` `branch_id` is *invisible* to `WHERE branch_id = $n` and *counted as Branch 1* by
`WHERE COALESCE(branch_id, 1) = $2` — which is exactly what `/api/owner/dashboard-foundation` uses
(`server.js:10072, 10082, 10094, 10124`) and `10560` (`LEFT JOIN branches b ON b.id = COALESCE(u.branch_id, 1)`).
So an expense saved without a branch simultaneously belongs to nobody and to Branch 1.

### 3.3 Writes that can hit another branch's *existing* rows

Three distinct failure modes, kept apart because they need different fixes. Together these are the
27 UNSCOPED writes counted in 2.2.

**Group A — the predicate exists but is disabled on the legacy path (3.1).** The row is selected by
primary key alone, so any branch's and any company's row is reachable.

| Legacy route | Registration | Disabled predicate |
| --- | --- | --- |
| `PUT /inventory-lots/:lotId` \| `/lots/:lotId` | 11997 | 11877 |
| `POST /inventory-lots/:lotId/add-quantity` | 12069 | 12016 |
| `POST /inventory-lots/:lotId/adjust` \| `/lots/:lotId/adjust-stock` | 12187 | 12091 |
| `POST /inventory-lots/:lotId/deactivate` | 12265 | 12205 |
| `POST /inventory-lots/:lotId/reactivate` | 12343 | 12283 |
| `POST /purchase-bill` | 17648 | 17449 |
| `PUT /purchase/:id` | 17955 | 17675 |
| `POST /purchase/:id/complete-bill` | 18143 | 17979 |
| `POST /purchase/:id/cancel` | 18260 | 18165 |
| `POST /sale-returns` | 19349 | 19179 |
| `POST /waste-entries` | 19494 | 19398 |
| `PUT /sales/:id` | 19787 | 19535 |
| `POST /sales/:id/cancel` | 19883 | 19807 |
| `PUT /products/:id`, `POST /products/:id/cancel` | 11677, 12607 | 11696, 12552 (company only) |

**Group B — no scope predicate has ever existed.** These select and mutate by id or by an
account/party key, with nothing tenancy-related in the `WHERE` at all.

`POST /lot-discounts` (7772) · `PUT /lot-discounts/:id` (7846) ·
`POST /lot-discounts/:id/deactivate` (7898) · `POST /settings/counters` (10395) ·
`POST /products/:id/opening-stock` (11740) · `POST /products/:productId/opening-stock-lots` (11742) ·
`POST /lots/transfer-stock` (12346) · `POST /sale-rates/bulk` (12723) ·
`POST /accounts/payments` (13363) · `PUT /accounts/payments/:paymentKey` (13446) ·
`POST /accounts/payments/:paymentKey/cancel` (13565) · `POST /customer-payments` (13961) ·
`POST /contra-entries` (14396) · `POST /expenses` (16051) · `PUT /expenses/:id` (16095) ·
`POST /expenses/:id/cancel` (16162) · `POST /supplier-payments` (16241) ·
`PUT /supplier-payments/:id` (16294) · `POST /supplier-payments/:id/cancel` (16364) ·
`POST /purchase` (16981) · `PUT /settings/devices/:deviceId` (10276)

**Group C — the *value written* is pinned, but the *row targeted* is not.** These read
`req.body.branch_id` for the new row's branch, which A-4's substitution check pins to the token — so
a Branch A user cannot stamp a row "Branch B". But for the `PUT` and `cancel` members, the row being
modified is still located by id with no branch filter, so they belong to Group A or B for targeting
purposes. `POST /sales` (18819) is the cleanest member: `parsedBranchId` is **required** (rejected at
18338 if absent) and pinned, so a sale cannot be created in another branch — though its inventory-lot
selection at 18401-18420 disables the company/location half of the filter on the legacy path, so it
can consume another *company's* lots that happen to share the branch id.

Related integrity gaps found while measuring:

- `POST /settings/branches` (`server.js:10376-10393`) inserts a branch with **no `company_id`**
  (`INSERT INTO branches (branch_name, address, phone_number, gst_number, active)`). A NULL-company
  branch then fails `requireSyncContext`'s company agreement test (`server.js:8204-8208`) — the new
  branch cannot sync. The v3 twin `POST /api/v3/admin/branches` (`scopeManagement.js:130`) does it
  correctly with `context.company_id`.
- `POST /users` (`server.js:6578`) inserts no `company_id` either, though the column exists
  (`migrations/cloud/005_multibranch_identity_foundation.sql:8`).
- `POST /supplier-payments` validates the supplier with
  `SELECT id FROM suppliers WHERE id = $1 AND active = TRUE` (`server.js:16268`) — no company check.
  A payment can be recorded against another company's supplier.
- `PUT /api/v3/admin/staff-assignments/:userId` (`scopeManagement.js:225`) looks up the target with
  `SELECT id, active FROM users WHERE id = $1` (line 231) — no company filter — so another company's
  user can be assigned into your operational location. Same at
  `POST /api/v3/admin/devices/:deviceId/approve` (`scopeManagement.js:279`) and its device lookup
  `SELECT * FROM authorized_devices WHERE device_id = $1 FOR UPDATE` (line 275).

### 3.4 What the database does enforce

`migrations/cloud/011_inventory_incremental_publication.sql` installs
`froozerp_publish_inventory_lot_sync()`, which validates the triple:

```sql
-- 011:48-61
IF lot.company_id IS NULL OR lot.branch_id IS NULL
   OR lot.operational_location_id IS NULL OR NULLIF(lot.global_id,'') IS NULL THEN
  RETURN NULL;                       -- silently skip
END IF;
PERFORM 1 FROM operational_locations ol
 WHERE ol.id = lot.operational_location_id
   AND ol.company_id = lot.company_id AND ol.branch_id = lot.branch_id;
IF NOT FOUND THEN
  RAISE EXCEPTION 'Inventory lot % has an invalid company/branch/location relationship', …;
END IF;
```

This is the right shape and the right layer — but note the polarity again: an **inconsistent** triple
raises; an **absent** one returns NULL and the write proceeds unpublished. Legacy writes therefore
succeed and simply never replicate. There is **no `CREATE POLICY` / row-level security anywhere** in
the schema.

---

## Part 4 — Ranked findings

Severity is judged for a **reachable** API, since that is the decision this audit gates.

---

### F-1 — Every report, ledger, dashboard and history endpoint returns the whole company's data to any authenticated user of any branch — **READ, critical**

**What a real user could do.** Sign in as a Branch B cashier on a Branch B device. Open Report Center,
the dashboard, sales history, customer/supplier ledgers, or ask FROST a question. Every number
returned is the **sum across all branches and all companies in the database**.

**Concrete steps.** No crafted request needed — the frontend does it. `GET /reports/summary`,
`GET /reports/day-book`, `GET /reports/balance-sheet`, `GET /reports/cash-book`,
`GET /dashboard-metrics`, `GET /sales`, `GET /sales-history`, `GET /customer-ledger`,
`GET /supplier-ledger`, `GET /accounts/ledger`, `GET /stock-inventory`, `GET /inventory`,
`GET /users`, and all 42 `/api/ai/*`. Measured: `/reports/summary` spans lines 14896-15995 —
**1 099 lines, zero occurrences of `branch_id` or `company_id`.**

**What it looks like afterwards.** Nothing. There is no artefact — no audit row, no anomaly. Every
branch's operator has been reading the whole business all along and it looks exactly like their own
numbers being larger than they expected. **This is the finding most likely to be already happening in
production today**, and unlike a write bug it leaves no evidence to check against.

**Second-order:** the maintainer's stated goal is multi-branch operation. Under F-1, adding Branch 2
does not partition the reports — it silently doubles every branch's apparent turnover. That will read
as an accounting error long before it reads as a security bug.

---

### F-2 — Every legacy twin of a v3 write route mutates any row by primary key, in any branch, in any company — **WRITE, critical**

**What a real user could do.** A Branch A user with the relevant role edits, re-costs, adjusts,
deactivates or cancels **any** inventory lot, sale, purchase or product in the database, by id.

**Concrete steps.**
1. Sign in normally as a Branch A Owner/Admin. Get a valid token for Branch A.
2. `PUT /lots/9931` with a body containing `{"purchase_rate": 5, "reason": "…"}` and **no
   `branch_id`, `company_id` or `operational_location_id` fields**.
3. `requireAuth` passes — nothing in the body contradicts the token.
4. `updateInventoryLotHandler` runs with `req.v3OperationalContext === undefined`, so
   `server.js:11877` binds `$2 = NULL`, the conjunct short-circuits true, and lot 9931 — Branch B's —
   is selected `FOR UPDATE` and rewritten.

Same shape for `POST /sales/:id/cancel` (19807), `PUT /sales/:id` (19535), `PUT /purchase/:id`
(17675), `POST /purchase/:id/cancel` (18165), `POST /sale-returns` (19179), `POST /waste-entries`
(19398), and the five lot mutators (11877, 12016, 12091, 12205, 12283).

**What it looks like afterwards.** Branch B's lot has a changed cost and a `product_audit_trail` row
naming a Branch A user. `logSyncChange` at 11967 records `context?.branch_id || lot.branch_id || 1`,
so the change *is* published — under the **lot's** branch, i.e. Branch B — attributed to a Branch A
actor. Branch B's devices then pull a mutation of their own stock made by someone who was never in
their branch. Downstream: Branch B's stock valuation, COGS and profit all move.

**Precondition, and it is only a partial one.** In `enforce` the 426 gate does cover `/lots/…`,
`/inventory-lots/…`, `/sales/…`, `/sale-returns`, `/purchase/…`, `/purchase-bill` and `/products/…`
— so most of F-2 is blocked. **But `POST /waste-entries` (19494) and the `/lot-discounts` mutators
(7772, 7846, 7898) are *not*** — `waste` and `lot` are followed by a hyphen, and
`LEGACY_OPERATIONAL_ROUTE` requires `/` or end-of-string. Both write `inventory_batches`. So
`enforce` narrows F-2 rather than closing it, and does nothing at all for F-1, F-3, F-4 or F-5.

---

### F-3 — Omitting `branch_id` is always allowed, so defaults decide where reads and writes land — **BOTH, high**

The substitution check constrains disagreement, never absence (`deviceSession.js:99`).

**Read case.** `GET /api/owner/dashboard-foundation` with no `branch_id` →
`parsePositiveInteger(req.query.branch_id) || 1` (`server.js:10053`) → the Branch B Owner is shown
**Branch 1's** invoice count, sales, cash/bank/UPI split, credit sales, expenses and stock value —
mixed, in the same response, with `balances` from `getDashboardSummary()` which is company-wide
(F-1). Half the tile row is one branch, the other half is all of them, and the JSON says
`"branch_id": 1` so it looks deliberate.

**Write case.** `POST /settings/counters` with no `branch_id` → the counter is created in Branch 1
(`server.js:10405`). `POST /users` with no `branch_id` → **always** Branch 1, because
`manager.branch_id` is `undefined` (`requireRateManager` at `server.js:1011-1025` does not select it)
so the `|| manager.branch_id ||` term at 6603 is dead code. `POST /products/:id/opening-stock` with no
`branch_id` → the opening lot is created in Branch 1 (`server.js:11711`), and `logSyncChange` then
publishes it to Branch 1's devices (`server.js:8258` default `branchId = 1`, and the hard-coded
`branchId: 1` at 11440).

**What it looks like afterwards.** Rows that belong to Branch B sitting in Branch 1 with a Branch B
actor in `created_by`. Or, on the money routes (3.2), rows with `branch_id IS NULL` that are invisible
to `branch_id = $n` and counted as Branch 1 by `COALESCE(branch_id, 1) = $2`. Reconciling those after
the fact requires inferring the branch from the actor, which is guesswork.

---

### F-4 — `PUT /settings/devices/:deviceId` re-points any device at any branch, unscoped and unchecked — **WRITE, high; potentially a privilege escalation**

**What a real user could do.** Any Owner or Admin — of any branch, of any company — can move any
device in the database into any branch.

**Concrete steps.** `PUT /settings/devices/FZDEV-BRANCH-B-POS-01` with
`{"action":"RENAME","assigned_branch_id":1}`.
- The gate is `requireRateManager(req.auth.userId)` (`server.js:10279`) — role only, no branch, no
  company (`server.js:1011-1025`).
- `SELECT * FROM authorized_devices WHERE device_id = $1` (10291) — unscoped.
- `UPDATE … SET assigned_branch_id = COALESCE($3, assigned_branch_id, …)` with
  `parsePositiveInteger(req.body.assigned_branch_id)` (10298-10306).
- `assigned_branch_id` is **not** one of the four names `submittedIdentityFrom` covers, so the
  substitution check never looks at it.

**Why it may escalate.** `/login` mints the branch claim as
`operationalAssignment?.branch_id || device.assigned_branch_id || user.branch_id || 1`
(`server.js:10839-10843`). **If no `device_assignments` row exists for the device**,
`operationalAssignment` is null and the claim comes from `device.assigned_branch_id` — the field just
overwritten. The attacker's *next login* then yields a token whose verified `branch_id` claim is the
other branch, which converts every SCOPED_BY_REQUEST path (sync push/pull, `POST /sales`,
`/api/owner/dashboard-foundation`) into legitimate access to that branch.

**Not determined:** whether `device_assignments` is populated in the live database. If it is, the
first term wins and the escalation half of F-4 does not fire — the unscoped device rewrite still
does, and it still breaks the other branch's sync (`requireSyncContext` at `server.js:8200-8202`
refuses when `device.assigned_branch_id !== branch_id`, so re-pointing a rival branch's terminal is a
one-request denial of service on their POS). Determining this needs a read of `device_assignments`
against a **disposable copy** of the database, which was out of scope here.

---

### F-5 — FROST answers business questions from the whole database, for a Cashier — **READ, high**

Separated from F-1 because the exposure shape is different: it is conversational, it is 42 routes
that no `enforce` mode touches, and its permission floor is the lowest in the app.
`requireAiPermission` for `GET /api/ai/frost/status` accepts fallback roles
`["Owner","Admin","Cashier","Purchase Manager","Inventory Manager"]`
(`aiBusinessAssistantService.js:1584`). The fact-gathering queries have no tenancy predicate at all,
and the module *writes* `company_id = 1` as a literal in four places (572, 1297, 1561, 1575), so its
own audit trail attributes every cross-tenant answer to Company 1.

---

### F-6 — Company-level leaks in otherwise-clean surfaces — **READ, medium**

`GET /api/v3/admin/scope-management` binds `context.company_id` on five of seven queries and not on
the other two (`scopeManagement.js:110-115`): the full active user list and the pending-device list,
both cross-company. `GET /users` (`server.js:6549`) is worse — every user row in the database with
recovery contacts and lock state. `POST /settings/branches` and `POST /users` create rows with a NULL
`company_id`, which makes the tenancy column untrustworthy going forward.

---

### F-7 — `accounts`, `lot_discounts`, `sale_rate_history`, `sale_rate_settings` have no tenancy column — **structural, medium**

Neither can `product_audit_trail`, `sale_audit_trail`, `purchase_audit_trail`,
`expense_audit_trail`, `customer_payment_audit`, `supplier_payment_audit`, `lot_discount_audit` or
`product_duplicate_archive_log` (2.4). None of these can be scoped without a schema change, so
`GET /accounts`, `GET /accounts/outstanding`, `GET /sale-rate-history`, `GET /sales/:id/audit`,
`GET /lots/:lotId/audit-trail`, `GET /stock-inventory/audit` and their writers are unfixable by
middleware alone — twelve tables in total. Any plan that says "add a scoping helper" has to say what
happens to them. The cheapest answer is probably `company_id`/`branch_id` columns backfilled from the
parent row, added as forward-only migrations.

---

### Not determined

1. **Whether the live deployment sets `FROOZERP_OPERATIONAL_SCOPE_MODE=enforce`.** Nothing in the
   repo sets it (`railway.json`, `Dockerfile` checked). Determining it means reading the Railway
   environment — forbidden. `docs/a4-route-audit.md:897` flagged the same gap and it is still open.
   Most of F-2 hinges on it; F-1, F-3, F-4, F-5 and the `/waste-entries` + `/lot-discounts` part of
   F-2 do not.
2. **Whether `device_assignments` / `staff_location_assignments` / `operational_locations` are
   populated in the live database.** This decides whether the v3 path is even reachable, whether
   `/login` derives branch canonically, and whether the F-4 escalation fires. Needs a disposable copy
   of the database, not the real one.
3. **How many rows already carry `branch_id IS NULL`.** The read-only query to answer it (run against
   a disposable copy) is `SELECT 'expenses', COUNT(*) FROM expenses WHERE branch_id IS NULL UNION ALL …`
   over the eleven tables listed in 3.2. Until that is known, the size of the historical
   mis-attribution under F-3 is unknown.
4. **Whether `shadow` mode was ever intended to do something.** It normalises successfully and is
   never branched on. Either it is dead or a feature was lost.

---

## Part 5 — Recommended direction

### 5.1 The fix is not one mechanism, it is three, in this order

**(a) Delete the fail-open default — the single highest-value change.**

The 13 full-triple `($n::INTEGER IS NULL OR (company_id = $n AND branch_id = $n+1 …))` predicates and
their 17 company-only siblings (3.1) exist so that one handler can serve both a scoped and an
unscoped registration.
That requirement should end: the scope should be **required**, and a handler reached without one
should refuse, not widen. Concretely, `req.v3OperationalContext` becomes mandatory for every handler
that has one today, sourced from `req.auth` when the canonical assignment is absent, and the SQL loses
the `IS NULL OR` wrapper.

Same for the defaults: `logSyncChange`'s `branchId = 1` (`server.js:8258`), the hard-coded
`branchId: 1` (11440), and every `|| 1` in the table in 3.2 should become "throw if absent". The
project already has the right instinct written down —
*"Errors must never render as zero"* — and this is the same rule applied to scope.

**Breaks:** any caller that legitimately omits scope. Measured: the frontend sends
`branch_id: user.branch_id` on ~20 call sites (`App.jsx:2309, 2350, 3601, 3614, 4806, 5029, 5123,
5450, 9602, 12566, 12677, 12776, 13126, …`), so most flows already comply — but `POST /users`,
`POST /settings/counters`, `POST /settings/activation-codes` and the opening-stock routes need
checking one by one. This is the risky part and it is why it must land before, not after, the
middleware.

**(b) A scope resolver at the top of every business handler, not a query helper.**

A query helper ("`scopedQuery(sql, params, scope)`") is the wrong shape here: `server.js` builds SQL
by template interpolation in dozens of places, several with dynamic `$n` arithmetic
(`server.js:5253`, `18401-18420`), and a helper that has to parse or append to those strings will be
wrong somewhere and silently. What generalises instead is **one function that produces the scope**,
plus the discipline that no handler binds a branch from `req`:

```
resolveScope(req) → { companyId, branchId, operationalLocationId }
  ← operational assignment if one exists (already built: operationalScope.js:66)
  ← else req.auth.companyId / req.auth.branchId (already verified: authMiddleware.js:94-104)
  ← else refuse
```

The mechanism already exists and is already tested. What is missing is that 110 handlers call it and
put its output in the `WHERE`.

**Middleware alone cannot do this.** Express middleware can *attach* a scope; it cannot make a
handler's SQL use it. The only way to make that enforceable rather than aspirational is (c).

**(c) Postgres row-level security, as the backstop — worth it, and cheaper than it sounds.**

The plumbing is already in place. `beginV3BusinessOperation` (`server.js:9544-9550`) already runs
`SET_CONFIG('froozerp.device_id' | 'froozerp.user_id' | 'froozerp.operation_id', …, TRUE)` on the
transaction, and migration 011 already demonstrates trigger-level tenancy validation with
`RAISE EXCEPTION` on an inconsistent triple. Extending that to
`SET_CONFIG('froozerp.company_id' / 'froozerp.branch_id')` on **every** connection checkout, plus
`ENABLE ROW LEVEL SECURITY` + a `USING (branch_id = current_setting('froozerp.branch_id')::int)`
policy on the fifteen branch-carrying tables, converts "we scoped 110 handlers" from a claim into an
invariant. A handler that forgets returns zero rows instead of everything — the fail-closed
direction.

**What it would break, honestly:** the backup path (`pg_dump` via `execFile`) and any migration or
maintenance connection needs `BYPASSRLS` or a separate role. Consolidated Owner reporting
(`operationalV3.js:1185`, `canUseConsolidatedReports`) needs an explicit company-scoped policy rather
than a branch-scoped one. And the four untenanted tables from F-7 need columns before they can have
policies. RLS should be the **last** step, after (a) and (b), because turning it on over the current
code would break most of the app at once and the failure mode ("Products: 0") is precisely the one
`CLAUDE.md` warns about.

**Do not** try to solve this by extending `submittedIdentityFrom` to cover more field names. That
treats a whitelist of parameter names as a security boundary, and F-4 is what happens the first time
someone adds a field the list does not know about. The list is a *substitution* check; it was never a
scoping mechanism and should not be promoted into one.

### 5.2 The completeness test

`routeAuthCoverage.test.js` works because it measures **behaviour** — it probes the real app and
asks whether a handler runs. The scoping equivalent has to do the same, and the honest version is
harder than the auth one, because "did this query filter by branch?" is not observable from an HTTP
status.

The shape that would actually prove something:

1. **Seed two branches in a disposable Postgres.** Company 1/Branch 1 and Company 2/Branch 2, each
   with one product, one lot, one sale, one expense, one payment, one user, one device — with
   deliberately non-overlapping ids so a leak is unambiguous. This is the expensive part, and it is
   also the part that makes the test worth anything. **Never against the real database, never against
   Railway.**
2. **Mint a real Branch-1 token** via `issueDeviceSession`, and enumerate routes exactly as
   `routeAuthCoverage.js:263-275` already does.
3. **For every route, three probes:** (i) with the Branch-1 token and no branch field —
   assert no Branch-2 identifier appears anywhere in the response body; (ii) with a Branch-2 id in a
   path parameter — assert 403/404, not 200; (iii) for writes, replay and then assert
   `SELECT COUNT(*) FROM <table> WHERE branch_id = 2 AND created_by = <branch-1 user>` is zero.
4. **Policy lives in the test, mechanism in the module** — same split as A-4. An explicit
   `INTENTIONALLY_UNSCOPED` allow-list holds `/api/health`, `/api/version`, `/login`, the routes
   over the twelve untenanted tables from F-7, and the consolidated-report routes. Every other route must pass or the
   suite fails. **A route added later is unscoped-by-default and fails**, which is the property that
   makes this keep working.
5. **A floor like `MINIMUM_EXPECTED_ROUTES`**, so "the seed failed and nothing was probed" cannot
   read as a pass — the same trap `routeAuthCoverage.js:78-84` already guards against.

Probe (i) — "no Branch-2 identifier in the body" — is the one that catches F-1, and it is also the one
that produces false positives on aggregate responses that legitimately contain no ids. Those need
probe (iii)'s database-level assertion instead: seed Branch 2 with an amount no Branch 1 row can
produce (say ₹777 777.77) and assert it never appears in a Branch-1 total. That is crude and it is
also the only way to test an aggregate.

### 5.3 Honest size estimate

| Piece | Size |
| --- | --- |
| (a) Remove fail-open defaults: 13 full-triple + 17 company-only `IS NULL OR` predicates + 13 `\|\| 1` / default-parameter sites, and fix each caller | **2-3 days.** Mechanical, but every one needs its caller checked, and `POST /users`' dead `manager.branch_id` shows how easy it is to look right and be inert |
| (b) Thread a resolved scope through the 77 unscoped handlers in `server.js` (69 branch-level + 8 company/untenanted) + 42 in `aiBusinessAssistantService.js` = **119** | **1-2 weeks.** The report queries (`/reports/summary` alone is 1 099 lines) dominate; several aggregate across 10 tables and each `FROM` needs its own predicate. This is where a wrong edit produces a *silently smaller* number, which is the hardest kind of regression to notice |
| (c) The two-branch seed + coverage suite | **3-4 days**, most of it the fixture |
| (d) RLS migration + `BYPASSRLS` role + backup path | **2-3 days**, plus a real soak on a disposable copy |
| (e) F-4 specifically (scope the device routes, move `assigned_branch_id` behind the v3 approval flow) | **half a day** — and it is the cheapest large win here |
| **Total** | **3-4 weeks of focused work**, and it should be sequenced (e) → (a) → (c) → (b) → (d), so that the test exists before the 119-handler edit rather than after it |

That is larger than A-4 was, and it should be scoped as its own stage — **A-7**, not a sub-bullet of
A-6. The A-6 exposure checklist line 4.1 ("Every query is scoped by `company_id`/`branch_id` — Never
audited") can now be marked **audited and failing**, with this document as the evidence.

### 5.4 One thing that is already right and should not be disturbed

`operationalV3.js`, `scopeManagement.js` and `operationalScope.js` are a correct multi-tenant design:
scope derived from a canonical join, never from the request; a separate `target_branch_id` name for
deliberate cross-branch admin, validated against the caller's company; consolidated reporting behind
an explicit device+staff permission; and a database trigger that refuses an inconsistent tenancy
triple. **The fix is not to design a scoping model — one exists. The fix is to make the legacy
surface stop bypassing it, and then to delete the legacy surface.** Twenty-two handlers already have
a correct v3 twin (3.1); the shortest path to isolation for those is to delete the legacy
registration, not to scope it. That is a frontend change (`App.jsx` would have to call the `/api/v3/`
paths and supply an idempotency key), which is why it is not free — but it is a smaller and much more
verifiable change than scoping 119 handlers by hand.

### 5.5 LOCAL_ONLY

Unaffected by anything in this report, and nothing here suggests weakening it. Every finding concerns
`server.js` in cloud-server runtime. Under LOCAL_ONLY, `desktopGateway.cloudRequest` refuses before
opening a socket, so `blocked=true`, `reachedCloud=false`, 0 cloud-router invocations and 0 external
connections all continue to hold. This audit made no network requests and loaded no module from
`backend/`.
