# A-4 Route Audit — line-numbered change plan for default-deny

**Read-only audit. No file in the repository was modified and no `git` command was run.**

## Provenance of every number below

| Item | Value | How measured |
| --- | --- | --- |
| `backend/server.js` snapshot | **19,705 lines**, md5 `80c41b90f9e7a215dabc6eda5e16c2e3` | `md5sum`, `wc -l`, 2026-08-20 06:05 UTC |
| Registrations in `server.js` | **219** (`213` routes + `6` `app.use`) | `grep -cE '^\s*app\.(get\|post\|put\|patch\|delete\|use)\('` |
| Registrations in `backend/aiBusinessAssistantService.js` | **42** | `grep -c '^\s*app\.\(get\|post\|put\|patch\|delete\)('` |
| Registrations in `backend/operationalV3.js` | **20** | `grep -c '^\s*use("'` |
| **Total route handlers reachable on the Express app** | **275** | 213 + 42 + 20 |
| Routes that verify a signed session **unconditionally** | **46** | 26 v3-adapter routes in `server.js` + 20 in `operationalV3.js` |
| Routes that verify a session **only when `FROOZERP_OPERATIONAL_SCOPE_MODE=enforce`** | **3** | `/api/sync/push`, `/api/sync/pull`, `/api/sync/status` |
| Routes that verify **nothing** | **226** | 275 − 46 − 3 |
| Routes with **no identity or permission check of any kind** | **98** | `grep '\| NONE$'` on the generated table, `app.use` rows excluded |
| Sites reading `x-user-id` in `server.js` | **10 inbound + 1 outbound** | `grep -n 'x-user-id' server.js` |
| `axios` calls in `frontend/src/App.jsx` | **157** | `grep -c` |
| …of which carry a session token | **28** | context scan for `createOperationalWrite` / `createOperationalReadConfig` / `sessionAuthHeaders` |
| …of which carry **nothing** | **129** | 157 − 28 |

> ### Concurrency warning — read this before using any line number
>
> `backend/server.js` **changed on disk during this audit**: it was 19,692 lines at 05:58 UTC and
> 19,705 lines at 06:04 UTC, and `backend/sessionSecret.test.js` (new) appeared at 06:04. Another
> agent is working on the session-signing-secret hardening (the `DEVICE_SESSION_SECRET` fallback
> noted in the A-3 record). **All line numbers in this report are against md5
> `80c41b90f9e7a215dabc6eda5e16c2e3`.** Re-verify with `grep -n` before editing; every claim here
> is anchored to a searchable string as well as a line number so it survives a shift.

---

# Part 1 — Complete route inventory

## 1.1 How to read the columns

- **verifies a session?** — does the handler reach `verifyDeviceSession`?
  - `YES (v3)` = via `resolveV3OperationalContext` (`server.js:9198`), reached through
    `v3WriteAdapter` (`server.js:9336`), `v3ReadAdapter` (`server.js:9373`), or the `guard()`
    wrapper in `operationalV3.js:510`.
  - `CONDITIONAL (sync)` = via `resolveSyncRequestContext` (`server.js:9129`), which
    **only calls `verifyDeviceSession` when `operationalScopeMode === SCOPE_MODES.ENFORCE`**
    (`server.js:9138`). `normalizeScopeMode` defaults to `OFF` (`operationalScope.js:16`), and
    `FROOZERP_OPERATIONAL_SCOPE_MODE` is read at `server.js:94`. **With the variable unset — the
    default — the sync routes verify no session at all** and fall through to
    `requireSyncContext({userId: submitted.user_id, …})` at `server.js:9131`, i.e. client-asserted
    identity.
  - `no` = never reaches `verifyDeviceSession`.
- **reads `x-user-id`?** — `identity` means the value selects *who the caller is*; `scoping` means
  it selects *which rows*. Every single `x-user-id` read in `server.js` is **identity**. There are
  no scoping reads of that header anywhere in the backend. See Part 4.
- **identity source** — where the handler actually gets the user it authorises against. This column
  is the one that matters for A-4: mounting `requireAuth` does **not** change any of these, because
  `rejectDeviceSessionSubstitution` only compares `user_id`, `device_id`, `company_id`, `branch_id`
  (`deviceSession.js:80-85`) and **never `updated_by` / `created_by` / `changed_by` / `edited_by`**.

## 1.2 Middleware registrations, in mount order

Order is the whole game for default-deny. These four run before every route.

| line | kind | what it does | note for A-4 |
| --- | --- | --- | --- |
| `server.js:59` | `app.use(express.json({limit:"25mb"}))` | body parsing | `requireAuth` reads `req.body.user_id` in `submittedIdentityFrom` (`authMiddleware.js:121`), so it **must mount after this line** or the substitution check silently sees `undefined` |
| `server.js:497` | `app.use(cors(...))` | dynamic CORS | must stay before `requireAuth`, otherwise a 401 is returned without CORS headers and the browser reports a network error instead of an auth error |
| `server.js:522` | `app.use(...)` protocol-upgrade gate | returns 426 for legacy operational paths when scope mode is `enforce` (`requiresOperationalProtocolUpgrade`, `operationalScope.js:55`) | ordering vs `requireAuth` is a **policy choice**: 426-before-401 tells an old client to upgrade; 401-before-426 hides the upgrade hint from unauthenticated callers. Recommend leaving 426 first — it is a client-compatibility signal, not data |
| `server.js:594` | `app.use(...)` desktop-local cloud forwarder | when `desktopLocalRuntime`, forwards everything not in `desktopLocalRoutes` (`server.js:539-549`) to the cloud via `forwardDesktopRequestToCloud` (`server.js:551`) | **`requireAuth` must mount AFTER this line.** Before it, a desktop-local `server.js` would 401 requests it is only *relaying*, and the cloud — the thing that actually holds the data and the users table — would never see them |
| `server.js:19639` | `app.use(express.static(frontendDistPath))` | serves the built SPA | registered late, inside `if (frontendDistAvailable())`. Under an app-wide `requireAuth` mounted early, **the login page itself would 401** |
| `server.js:19648` | `app.use((error, req, res, next) => …)` | error handler | 4-arity, must remain last |

Two further non-`app.use` registrations that behave like middleware:

| line | kind | note |
| --- | --- | --- |
| `server.js:5197` | `registerAiBusinessAssistantRoutes({app, …})` | registers **42** `/api/ai/*` routes. `requireAuth` must mount **before line 5197** to cover them |
| `server.js:9456` | `registerOperationalV3Routes({app, …})` | registers **20** `/api/v3/*` routes, all already session-verified |
| `server.js:7975` | `rateLimitSyncRequest` | per-IP+device-id limiter, 120/min. Keyed off `req.body?.device_id \|\| req.query?.device_id` (`server.js:7976`) — **client-controlled**, so the limit is trivially evaded by varying `device_id`. Not an auth control; do not treat it as one |


## 1.3 `backend/server.js` — 213 routes, source order

Caveats on the generated columns, stated so no row is over-trusted:

- The **identity source** column is derived by slicing each registration to the next one and
  following named handlers to their definitions (`createSaleHandler` at `server.js:17869`,
  `updatePurchaseHandler` at `17256`, etc.). Where a route is registered immediately before a
  helper definition, the slice can bleed — e.g. row `11105 GET /products` shows
  `requireRateManager<-created_by`, which is actually `createProductHandler`'s check bleeding in;
  `GET /products` itself has **no** check. Rows I verified by hand are called out in Parts 2–4.
- `NONE` means: no `requireRateManager`, no `getPermissionUser`, no `requireSelfOrRateManager`,
  no `requireSyncContext`, no `verifyDeviceSession` anywhere in the handler. **98 routes are in
  that state.**
- Row `9121 POST /api/device/register` shows a v3/sync marker: that is slice bleed from the
  `resolveSyncRequestContext` / `resolveV3OperationalContext` definitions which begin at
  `server.js:9129`. The handler is `registerSyncDeviceHandler` (`server.js:9080-9119`) and it has
  **no identity check at all**. Corrected in Part 2.

| line | method | path | handler | verifies a session? | reads `x-user-id`? | identity source today | proposed class |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5205 | GET | `/api/auth/me` | (inline) | no | **YES — identity** | NONE | AUTH |
| 5225 | GET | `/api/cloud/internet-access` | (inline) | no | no | NONE | AUTH |
| 5237 | PUT | `/api/cloud/internet-access` | (inline) | no | **YES — identity** | NONE | ROLE:OWNER,ADMIN |
| 5264 | GET | `/api/cloud/health` | (inline) | no | **YES — identity** | NONE | AUTH |
| 5278 | POST | `/api/cloud/device/register` | (inline) | no | no | NONE | AUTH |
| 5323 | GET | `/api/cloud/device/status` | (inline) | no | **YES — identity** | NONE | AUTH |
| 5351 | POST | `/api/cloud/device/approve` | (inline) | no | **YES — identity** | NONE | ROLE:OWNER,ADMIN |
| 5397 | GET | `/api/integrations/email/status` | (inline) | no | **YES — identity** | getPermissionUser<-req.query.user_id | ROLE:OWNER,ADMIN |
| 5415 | POST | `/api/integrations/email/test` | (inline) | no | **YES — identity** | getPermissionUser<-req.body.user_id | ROLE:OWNER,ADMIN |
| 5450 | GET | `/api/integrations/sms/status` | (inline) | no | **YES — identity** | getPermissionUser<-req.query.user_id | ROLE:OWNER,ADMIN |
| 5469 | POST | `/api/integrations/sms/test` | (inline) | no | **YES — identity** | getPermissionUser<-req.body.user_id | ROLE:OWNER,ADMIN |
| 5502 | GET | `/purchase-rules` | (inline) | no | no | NONE | AUTH |
| 5515 | GET | `/settings/purchase-rules` | (inline) | no | no | NONE | AUTH |
| 5528 | GET | `/settings` | (inline) | no | no | NONE | **AUTH — but see Part 3, called pre-login** |
| 5537 | GET | `/settings/role-permissions` | (inline) | no | no | NONE | AUTH |
| 5547 | PUT | `/settings/role-permissions/:roleName` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 5580 | PUT | `/settings/device-control` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 5632 | POST | `/settings/device-control/verify-exit-code` | (inline) | no | no | NONE | ROLE:OWNER,ADMIN |
| 5658 | GET | `/settings/update-center` | (inline) | no | no | NONE | AUTH |
| 5671 | GET | `/api/update/manifest` | (inline) | no | no | NONE | AUTH |
| 5723 | PUT | `/settings/update-center` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 5748 | GET | `/settings/sync-status` | (inline) | no | no | NONE | AUTH |
| 5766 | PUT | `/settings/sync-status` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 5786 | PUT | `/settings/pos` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 5822 | PUT | `/settings/payment` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 5880 | PUT | `/settings/whatsapp` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 5924 | POST | `/settings/whatsapp/test` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 5970 | POST | `/api/whatsapp/send-document` | (inline) | no | no | NONE | ROLE:OWNER,ADMIN |
| 6136 | PUT | `/settings/business` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 6198 | PUT | `/settings/sale-rate` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 6287 | GET | `/users` | (inline) | no | no | requireRateManager<-req.query.updated_by | ROLE:OWNER,ADMIN |
| 6316 | POST | `/users` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 6354 | PUT | `/users/:id` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 6391 | PUT | `/users/:id/password` | (inline) | no | no | requireRateManager<-actorId | ROLE:OWNER,ADMIN |
| 6430 | POST | `/users/:id/deactivate` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 6444 | POST | `/users/:id/reactivate` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 6457 | DELETE | `/users/:id` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 6476 | GET | `/auth/recovery/config` | (inline) | no | no | NONE | **PUBLIC** |
| 6490 | GET | `/auth/recovery/profile` | (inline) | no | no | requireSelfOrRateManager | AUTH |
| 6519 | POST | `/auth/recovery/contact/request` | (inline) | no | no | requireSelfOrRateManager | AUTH |
| 6611 | POST | `/auth/recovery/contact/verify` | (inline) | no | no | requireSelfOrRateManager | AUTH |
| 6694 | POST | `/api/auth/email/send-verification` | (inline) | no | no | requireSelfOrRateManager | AUTH |
| 6746 | POST | `/api/auth/email/verify` | (inline) | no | no | requireSelfOrRateManager | AUTH |
| 6791 | POST | `/api/auth/phone/send-otp` | (inline) | no | no | requireSelfOrRateManager | AUTH |
| 6843 | POST | `/api/auth/phone/verify-otp` | (inline) | no | no | requireSelfOrRateManager | AUTH |
| 6888 | GET | `/auth/recovery/readiness-report` | (inline) | no | no | requireRateManager<-req.query.user_id | ROLE:OWNER,ADMIN |
| 6917 | POST | `/auth/recovery/options` | (inline) | no | no | NONE | **PUBLIC** |
| 6947 | POST | `/auth/recovery/send-otp` | (inline) | no | no | NONE | **PUBLIC** |
| 7074 | POST | `/auth/recovery/verify-otp` | (inline) | no | no | NONE | **PUBLIC** |
| 7171 | POST | `/auth/recovery/reset-password` | (inline) | no | no | NONE | **PUBLIC** |
| 7263 | POST | `/users/:id/recovery-action` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 7349 | GET | `/settings/discount-rules` | (inline) | no | no | NONE | AUTH |
| 7367 | POST | `/settings/discount-rules` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 7404 | PUT | `/settings/discount-rules/:id` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 7450 | DELETE | `/settings/discount-rules/:id` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 7464 | GET | `/lot-discounts` | (inline) | no | no | NONE | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 7506 | POST | `/lot-discounts` | (inline) | no | no | requireRateManager<-req.body.created_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 7580 | PUT | `/lot-discounts/:id` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 7632 | POST | `/lot-discounts/:id/deactivate` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 7675 | POST | `/settings/mandi-tax-rules` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 7698 | PUT | `/settings/mandi-tax-rules/:id` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 7722 | DELETE | `/settings/mandi-tax-rules/:id` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 7736 | POST | `/settings/rebate-rules` | (inline) | no | no | requireRateManager<-updated_by | ROLE:OWNER,ADMIN |
| 7761 | PUT | `/settings/rebate-rules/:id` | (inline) | no | no | requireRateManager<-updated_by | ROLE:OWNER,ADMIN |
| 7788 | DELETE | `/settings/rebate-rules/:id` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 7802 | GET | `/` | (inline) | no | no | NONE | **PUBLIC** |
| 8979 | GET | `/api/health` | healthHandler | no | no | NONE | **PUBLIC** |
| 8980 | GET | `/health` | healthHandler | no | no | NONE | **PUBLIC** |
| 8982 | GET | `/api/time` | (inline) | no | no | NONE | **PUBLIC** |
| 8987 | GET | `/api/version` | (inline) | no | no | NONE | **PUBLIC** |
| 9009 | GET | `/api/system/compatibility` | (inline) | no | no | NONE | **PUBLIC** |
| 9044 | GET | `/api/cloud/readiness` | (inline) | no | no | NONE | AUTH |
| 9120 | POST | `/api/sync/register-device` | registerSyncDeviceHandler | no | no | NONE | **PUBLIC** |
| 9121 | POST | `/api/device/register` | registerSyncDeviceHandler | **CONDITIONAL** — `resolveSyncRequestContext`, only if scope mode = enforce | **YES — identity** |  | **PUBLIC** |
| 9388 | GET | `/api/v3/operational-context` | (inline) | YES — `resolveV3OperationalContext` | no |  | AUTH |
| 9405 | GET | `/api/v3/operational-locations` | (inline) | YES — `resolveV3OperationalContext` | no |  | AUTH |
| 9426 | GET | `/api/v3/inventory` | (inline) | YES — `resolveV3OperationalContext` | no |  | AUTH |
| 9478 | GET | `/api/device/identity` | (inline) | no | no | requireSyncContext<-query | AUTH |
| 9524 | GET | `/api/branch/status` | (inline) | no | no | requireSyncContext<-query | AUTH |
| 9579 | POST | `/api/sync/push` | (inline) | **CONDITIONAL** — `resolveSyncRequestContext`, only if scope mode = enforce | no |  | AUTH |
| 9644 | GET | `/api/sync/pull` | (inline) | **CONDITIONAL** — `resolveSyncRequestContext`, only if scope mode = enforce | no |  | AUTH |
| 9739 | GET | `/api/sync/status` | (inline) | **CONDITIONAL** — `resolveSyncRequestContext`, only if scope mode = enforce | no |  | AUTH |
| 9779 | GET | `/api/owner/dashboard-foundation` | (inline) | no | no | NONE | AUTH |
| 9896 | POST | `/devices/activate` | (inline) | no | no | NONE | **PUBLIC** |
| 9950 | POST | `/bootstrap/first-owner-device` | (inline) | no | no | NONE | **PUBLIC** |
| 10004 | PUT | `/settings/devices/:deviceId` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 10061 | POST | `/settings/activation-codes` | (inline) | no | no | requireRateManager<-req.body.created_by | ROLE:OWNER,ADMIN |
| 10091 | PUT | `/settings/activation-codes/:id/revoke` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 10104 | POST | `/settings/branches` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 10123 | POST | `/settings/counters` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 10142 | PUT | `/settings/backup` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN |
| 10175 | POST | `/settings/backup-now` | (inline) | no | no | requireRateManager<-req.body.created_by | ROLE:OWNER,ADMIN |
| 10187 | POST | `/settings/safe-shutdown` | (inline) | no | no | requireRateManager<-req.body.created_by | ROLE:OWNER,ADMIN |
| 10202 | GET | `/settings/system-info` | (inline) | no | no | NONE | ROLE:OWNER,ADMIN |
| 10211 | POST | `/api/auth/device-bootstrap-status` | (inline) | no | no | NONE | **PUBLIC** |
| 10253 | POST | `/login` | (inline) | no | no | NONE | **PUBLIC** |
| 10687 | GET | `/product-categories` | listProductCategoriesHandler | no | no | NONE | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 10688 | GET | `/api/v3/product-categories` | v3ReadAdapter(listProductCategoriesHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-req.body.created_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 10764 | POST | `/product-categories` | createProductCategoryHandler | no | no | requireRateManager<-req.body.created_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 10765 | POST | `/api/v3/product-categories` | v3WriteAdapter(createProductCategoryHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-req.body.updated_by/req.body.created_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 10851 | PUT | `/product-categories/:id` | updateProductCategoryHandler | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 10852 | PUT | `/api/v3/product-categories/:id` | v3WriteAdapter(updateProductCategoryHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-req.body?.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 10951 | DELETE | `/product-categories/:id` | deactivateProductCategoryHandler | no | no | requireRateManager<-req.body?.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 10952 | DELETE | `/api/v3/product-categories/:id` | v3WriteAdapter(deactivateProductCategoryHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-req.body?.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 10954 | GET | `/product-duplicate-archive-log` | (inline) | no | no | NONE | AUTH |
| 11105 | GET | `/products` | (inline) | no | no | requireRateManager<-created_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11278 | POST | `/products` | createProductHandler | no | no | requireRateManager<-created_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11279 | POST | `/api/v3/products` | v3WriteAdapter(createProductHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-updated_by/created_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11405 | PUT | `/products/:id` | updateProductHandler | no | no | requireRateManager<-updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11406 | PUT | `/api/v3/products/:id` | v3WriteAdapter(updateProductHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-req.body.created_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11468 | POST | `/products/:id/opening-stock` | addOpeningStockLotsForProduct | no | no | requireRateManager<-req.body.created_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11470 | POST | `/products/:productId/opening-stock-lots` | addOpeningStockLotsForProduct | no | no | requireRateManager<-req.body.created_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11471 | POST | `/api/v3/products/:id/opening-stock` | (inline) | YES — `resolveV3OperationalContext` | no |  | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11474 | POST | `/api/v3/products/:productId/opening-stock-lots` | (inline) | YES — `resolveV3OperationalContext` | no |  | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11555 | GET | `/products/:id/lots` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11725 | PUT | `["/inventory-lots/:lotId", "/lots/:lotId"]` | updateInventoryLotHandler | no | no | requireRateManager<-req.body.updated_by | AUTH |
| 11726 | PUT | `/api/v3/inventory-lots/:lotId` | v3WriteAdapter(updateInventoryLotHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11797 | POST | `/inventory-lots/:lotId/add-quantity` | addInventoryLotQuantityHandler | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11798 | POST | `/api/v3/inventory-lots/:lotId/add-quantity` | v3WriteAdapter(addInventoryLotQuantityHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11915 | POST | `["/inventory-lots/:lotId/adjust", "/lots/:lotId/adjust-stock"]` | adjustInventoryLotHandler | no | no | requireRateManager<-req.body.updated_by | AUTH |
| 11916 | POST | `/api/v3/inventory-lots/:lotId/adjust` | v3WriteAdapter(adjustInventoryLotHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11993 | POST | `/inventory-lots/:lotId/deactivate` | deactivateInventoryLotHandler | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 11994 | POST | `/api/v3/inventory-lots/:lotId/deactivate` | v3WriteAdapter(deactivateInventoryLotHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 12071 | POST | `/inventory-lots/:lotId/reactivate` | reactivateInventoryLotHandler | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 12072 | POST | `/api/v3/inventory-lots/:lotId/reactivate` | v3WriteAdapter(reactivateInventoryLotHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 12074 | POST | `/lots/transfer-stock` | (inline) | no | no | requireRateManager<-req.body.updated_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 12171 | GET | `/stock-inventory/audit` | (inline) | no | no | NONE | AUTH |
| 12212 | GET | `/stock-adjustments` | (inline) | no | no | NONE | AUTH |
| 12239 | GET | `/lots/:lotId/audit-trail` | (inline) | no | no | requireRateManager<-userId | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 12335 | POST | `/products/:id/cancel` | cancelProductHandler | no | no | requireRateManager<-userId | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 12336 | POST | `/api/v3/products/:id/deactivate` | v3WriteAdapter(cancelProductHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-userId | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 12338 | GET | `/inventory` | (inline) | no | no | NONE | AUTH |
| 12354 | GET | `/stock` | (inline) | no | no | NONE | AUTH |
| 12379 | GET | `/sale-rates` | (inline) | no | no | requireRateManager<-req.query.user_id | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 12451 | POST | `/sale-rates/bulk` | (inline) | no | no | requireRateManager<-req.body.changed_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 12528 | GET | `/sale-rate-history` | (inline) | no | no | requireRateManager<-req.query.user_id | AUTH |
| 12701 | GET | `/accounts` | (inline) | no | no | NONE | AUTH |
| 12716 | POST | `/accounts` | (inline) | no | no | NONE | AUTH |
| 12807 | PUT | `/accounts/:accountKey` | (inline) | no | no | NONE | AUTH |
| 12911 | GET | `/accounts/outstanding` | (inline) | no | no | NONE | AUTH |
| 12928 | GET | `/accounts/ledger` | (inline) | no | no | NONE | AUTH |
| 13082 | GET | `/accounts/payments` | (inline) | no | no | NONE | AUTH |
| 13091 | POST | `/accounts/payments` | (inline) | no | no | NONE | AUTH |
| 13156 | PUT | `/accounts/payments/:paymentKey` | (inline) | no | no | NONE | AUTH |
| 13263 | POST | `/accounts/payments/:paymentKey/cancel` | (inline) | no | no | NONE | AUTH |
| 13343 | GET | `/accounts/payments/:paymentKey/audit` | (inline) | no | no | NONE | AUTH |
| 13381 | GET | `/suppliers` | (inline) | no | no | NONE | AUTH |
| 13395 | POST | `/suppliers` | (inline) | no | no | NONE | AUTH |
| 13438 | GET | `/suppliers/:id` | (inline) | no | no | NONE | AUTH |
| 13450 | PUT | `/suppliers/:id` | (inline) | no | no | NONE | AUTH |
| 13512 | DELETE | `/suppliers/:id` | (inline) | no | no | NONE | AUTH |
| 13529 | GET | `/supplier-summary` | (inline) | no | no | NONE | AUTH |
| 13541 | GET | `/customers` | (inline) | no | no | NONE | AUTH |
| 13552 | POST | `/customers` | (inline) | no | no | NONE | AUTH |
| 13588 | PUT | `/customers/:id` | (inline) | no | no | NONE | AUTH |
| 13631 | GET | `/customer-summary` | (inline) | no | no | NONE | AUTH |
| 13643 | POST | `/customer-payments` | (inline) | no | no | NONE | AUTH |
| 13675 | GET | `/stock-inventory` | (inline) | no | no | NONE | AUTH |
| 13703 | GET | `/pending-bills/customer` | (inline) | no | no | NONE | AUTH |
| 13816 | GET | `/customer-ledger` | (inline) | no | no | NONE | AUTH |
| 13943 | GET | `/dashboard-metrics` | (inline) | no | no | getPermissionUser<-req.query.user_id | AUTH |
| 13955 | GET | `/dashboard-analytics` | (inline) | no | no | getPermissionUser<-req.query.user_id | AUTH |
| 13967 | GET | `/dashboard-sales-trend` | (inline) | no | no | getPermissionUser<-req.query.user_id | AUTH |
| 13980 | GET | `/dashboard-profit-trend` | (inline) | no | no | getPermissionUser<-req.query.user_id | AUTH |
| 13993 | GET | `/dashboard-expense-trend` | (inline) | no | no | getPermissionUser<-req.query.user_id | AUTH |
| 14006 | GET | `/reports/balance-sheet` | (inline) | no | no | NONE | AUTH |
| 14033 | GET | `/reports/cash-book` | (inline) | no | no | NONE | AUTH |
| 14054 | GET | `/contra-entries` | (inline) | no | no | NONE | AUTH |
| 14071 | POST | `/contra-entries` | (inline) | no | no | NONE | AUTH |
| 14110 | GET | `/reports/balance-sheet/details/:lineKey` | (inline) | no | no | NONE | AUTH |
| 14361 | GET | `/reports/day-book` | (inline) | no | no | NONE | AUTH |
| 14560 | GET | `/reports/summary` | (inline) | no | no | NONE | AUTH |
| 15661 | GET | `/expenses` | (inline) | no | no | NONE | AUTH |
| 15715 | POST | `/expenses` | (inline) | no | no | NONE | AUTH |
| 15747 | PUT | `/expenses/:id` | (inline) | no | no | NONE | AUTH |
| 15807 | POST | `/expenses/:id/cancel` | (inline) | no | no | NONE | AUTH |
| 15854 | GET | `/supplier-payments` | (inline) | no | no | NONE | AUTH |
| 15876 | POST | `/supplier-payments` | (inline) | no | no | NONE | AUTH |
| 15922 | PUT | `/supplier-payments/:id` | (inline) | no | no | NONE | AUTH |
| 15985 | POST | `/supplier-payments/:id/cancel` | (inline) | no | no | NONE | AUTH |
| 16030 | GET | `/supplier-ledger` | (inline) | no | no | NONE | AUTH |
| 16548 | GET | `/purchases` | (inline) | no | no | NONE | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 16586 | POST | `/purchase` | (inline) | no | no | requireRateManager<-entry.actorId/baseEntry.actorId | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 17253 | POST | `/purchase-bill` | createPurchaseBillHandler | no | no | requireRateManager<-baseEntry.actorId | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 17254 | POST | `/api/v3/purchase-bills` | v3WriteAdapter(createPurchaseBillHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-req.body.edited_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 17560 | PUT | `/purchase/:id` | updatePurchaseHandler | no | no | requireRateManager<-req.body.edited_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 17561 | PUT | `/api/v3/purchases/:id` | v3WriteAdapter(updatePurchaseHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-req.body.edited_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 17748 | POST | `/purchase/:id/complete-bill` | completePurchaseBillHandler | no | no | requireRateManager<-req.body.edited_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 17749 | POST | `/api/v3/purchases/:id/complete-bill` | v3WriteAdapter(completePurchaseBillHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-cancelledBy/req.body.edited_by | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 17866 | POST | `/purchase/:id/cancel` | cancelPurchaseHandler | no | no | requireRateManager<-cancelledBy | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 17867 | POST | `/api/v3/purchases/:id/cancel` | v3WriteAdapter(cancelPurchaseHandler) | YES — `resolveV3OperationalContext` | no | requireRateManager<-cancelledBy ; getPermissionUser<-parsedCreatedBy | ROLE:OWNER,ADMIN,PURCHASE MANAGER,INVENTORY MANAGER |
| 18426 | POST | `/sales` | createSaleHandler | no | no | getPermissionUser<-parsedCreatedBy | AUTH |
| 18427 | POST | `/api/v3/sales` | v3WriteAdapter(createSaleHandler) | YES — `resolveV3OperationalContext` | no | getPermissionUser<-parsedCreatedBy | AUTH |
| 18429 | GET | `/sales` | (inline) | no | no | NONE | AUTH |
| 18594 | GET | `/sales-history` | (inline) | no | no | NONE | AUTH |
| 18604 | GET | `/sales-history/items` | (inline) | no | no | NONE | AUTH |
| 18614 | GET | `/sales-history/lots` | (inline) | no | no | NONE | AUTH |
| 18624 | GET | `/sales-history/:id` | (inline) | no | no | NONE | AUTH |
| 18637 | GET | `/sales-report/changes` | (inline) | no | no | NONE | AUTH |
| 18675 | GET | `/sale-returns` | (inline) | no | no | NONE | AUTH |
| 18714 | GET | `/sale-returns/options/:saleId` | (inline) | no | no | NONE | AUTH |
| 18944 | POST | `/sale-returns` | createSaleReturnHandler | no | no | NONE | AUTH |
| 18945 | POST | `/api/v3/sale-returns` | v3WriteAdapter(createSaleReturnHandler) | YES — `resolveV3OperationalContext` | no |  | AUTH |
| 18947 | GET | `/waste-entries` | (inline) | no | no | NONE | AUTH |
| 19082 | POST | `/waste-entries` | createWasteEntryHandler | no | no | NONE | AUTH |
| 19083 | POST | `/api/v3/waste-entries` | v3WriteAdapter(createWasteEntryHandler) | YES — `resolveV3OperationalContext` | no |  | AUTH |
| 19085 | GET | `/sales/:id/audit` | (inline) | no | no | getPermissionUser<-editor.id | AUTH |
| 19375 | PUT | `/sales/:id` | updateSaleHandler | no | no | getPermissionUser<-editor.id | AUTH |
| 19376 | PUT | `/api/v3/sales/:id` | v3WriteAdapter(updateSaleHandler) | YES — `resolveV3OperationalContext` | no | getPermissionUser<-editor.id | AUTH |
| 19471 | POST | `/sales/:id/cancel` | cancelSaleHandler | no | no | NONE | AUTH |
| 19472 | POST | `/api/v3/sales/:id/cancel` | v3WriteAdapter(cancelSaleHandler) | YES — `resolveV3OperationalContext` | no |  | AUTH |
| 19474 | GET | `/sales/:id` | (inline) | no | no | NONE | AUTH |
| 19640 | GET | `/^\/(?!api\/).*/` | (inline) | no | no | NONE | **PUBLIC** (SPA fallback) |

## 1.4 `backend/aiBusinessAssistantService.js` — 42 routes

Registered from `server.js:5197` (`registerAiBusinessAssistantRoutes`), i.e. **before** every
route in §1.3. **None verifies a session.** Every one authorises through `requireAiPermission`
(`aiBusinessAssistantService.js:146`), whose identity line is:

```
aiBusinessAssistantService.js:147:  const userId = req.query.user_id || req.body?.user_id || req.headers["x-user-id"];
```

That is the same client-asserted identity as the rest of the backend, wearing a permission check.
The four routes whose bodies show no direct call go through `requireOwnerIntelligence`
(`aiBusinessAssistantService.js:1832`), which is a `requireAiPermission` wrapper — verified by
reading it, not assumed.

| line | method | path | verifies a session? | reads `x-user-id`? | identity source today | proposed class |
| --- | --- | --- | --- | --- | --- | --- |
| 1565 | GET | `/api/ai/frost/status` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1580 | GET | `/api/ai/providers` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1586 | GET | `/api/ai/suggested-questions` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1592 | GET | `/api/ai/settings` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | ROLE:OWNER,ADMIN |
| 1609 | PUT | `/api/ai/settings` | no | **YES — identity** (via svc:147) | `requireRateManager(req.body.user_id)` — client-asserted | ROLE:OWNER,ADMIN |
| 1628 | GET | `/api/ai/briefing` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1637 | GET | `/api/ai/alerts` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1643 | PATCH | `/api/ai/alerts/:id` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1658 | GET | `/api/ai/reminders` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1664 | GET | `/api/ai/memory` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1671 | POST | `/api/ai/memory/propose` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | ROLE:OWNER,ADMIN |
| 1701 | POST | `/api/ai/memory/:id/approve` | no | **YES — identity** (via svc:147) | `requireRateManager(req.body.user_id)` — client-asserted | ROLE:OWNER,ADMIN |
| 1715 | PATCH | `/api/ai/memory/:id` | no | **YES — identity** (via svc:147) | `requireRateManager(req.body.user_id)` — client-asserted | ROLE:OWNER,ADMIN |
| 1748 | DELETE | `/api/ai/memory/:id` | no | **YES — identity** (via svc:147) | `requireRateManager(req.body.user_id)` — client-asserted | ROLE:OWNER,ADMIN |
| 1757 | GET | `/api/ai/predictions/inventory` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1763 | GET | `/api/ai/predictions/sales` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1769 | GET | `/api/ai/predictions/cashflow` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1776 | GET | `/api/ai/predictions/waste` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1782 | GET | `/api/ai/predictions` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1795 | GET | `/api/ai/profit-advisor` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1801 | GET | `/api/ai/profit-advisor/products/:id` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1809 | GET | `/api/ai/daily-plan` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1841 | GET | `/api/ai/intelligence/pricing` | no | **YES — identity** (via svc:147) | `requireOwnerIntelligence` → `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1847 | GET | `/api/ai/intelligence/purchase-planner` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1853 | GET | `/api/ai/intelligence/waste-prevention` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1859 | GET | `/api/ai/intelligence/customers` | no | **YES — identity** (via svc:147) | `requireOwnerIntelligence` → `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1865 | GET | `/api/ai/intelligence/suppliers` | no | **YES — identity** (via svc:147) | `requireOwnerIntelligence` → `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1871 | GET | `/api/ai/intelligence/profit-optimizer` | no | **YES — identity** (via svc:147) | `requireOwnerIntelligence` → `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1877 | GET | `/api/ai/intelligence/cashflow` | no | **YES — identity** (via svc:147) | `requireOwnerIntelligence` → `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1884 | GET | `/api/ai/intelligence/demand` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1890 | GET | `/api/ai/intelligence/health` | no | **YES — identity** (via svc:147) | `requireOwnerIntelligence` → `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1897 | GET | `/api/ai/intelligence/decision-center` | no | **YES — identity** (via svc:147) | `requireOwnerIntelligence` → `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1904 | GET | `/api/ai/autonomous` | no | **YES — identity** (via svc:147) | `requireOwnerIntelligence` → `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1935 | POST | `/api/ai/reminders` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1966 | PATCH | `/api/ai/reminders/:id` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 1981 | POST | `/api/ai/query` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 2048 | POST | `/api/ai/query/stream` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 2087 | POST | `/api/ai/actions/propose` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 2107 | POST | `/api/ai/voice/session` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 2123 | GET | `/api/ai/voice/status` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 2142 | POST | `/api/ai/voice/transcribe` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |
| 2163 | POST | `/api/ai/voice/speak` | no | **YES — identity** (via svc:147) | `requireAiPermission` → `x-user-id`/`user_id` (svc:147) | AUTH (+ existing FROST permission, re-based on `req.auth.userId`) |

## 1.5 `backend/operationalV3.js` — 20 routes

Registered from `server.js:9456`. Every one goes through `guard()`
(`operationalV3.js:510`) → `resolveContext` = `resolveV3OperationalContext`
(`server.js:9198`) → `verifyDeviceSession`. **These 20 are already authenticated today.**
Mounting `requireAuth` in front of them is belt-and-braces, not a behaviour change — with one
caveat noted in Part 3 (the token is verified twice, and the substitution check runs twice with
different field sets).

| line | method | path | verifies a session? | reads `x-user-id`? | proposed class |
| --- | --- | --- | --- | --- | --- |
| 526 | GET | `/api/v3/location-products` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 546 | GET | `/api/v3/suppliers` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 713 | POST | `/api/v3/suppliers` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 718 | PUT | `/api/v3/suppliers/:supplierId` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 725 | DELETE | `/api/v3/suppliers/:supplierId` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 732 | PUT | `/api/v3/location-products/:productId` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 806 | GET | `/api/v3/purchase-orders` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 818 | POST | `/api/v3/purchase-orders` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 864 | GET | `/api/v3/goods-receipts` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 876 | POST | `/api/v3/goods-receipts` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 950 | GET | `/api/v3/supplier-bills` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 960 | POST | `/api/v3/supplier-bills` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 990 | GET | `/api/v3/payment-allocations` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 1001 | POST | `/api/v3/payment-allocations` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 1043 | POST | `/api/v3/transfers` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 1102 | POST | `/api/v3/transfers/:transferId/actions/:action` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 1163 | GET | `/api/v3/transfers` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 1185 | GET | `/api/v3/reports/consolidated` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | AUTH |
| 1253 | POST | `/api/v3/admin/staff-assignments/preview` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | ROLE:OWNER,ADMIN |
| 1258 | POST | `/api/v3/admin/device-assignments/preview` | YES — `resolveV3OperationalContext` | no (indirect: `server.js:9206` compares it) | ROLE:OWNER,ADMIN |

---

# Part 2 — The allow-list

Every entry states what an unauthenticated attacker gets. **A route on this list is a permanent
bypass**, so each is justified by a caller that provably cannot hold a token yet.

## 2.1 Unconditionally public — 8 paths, 9 registrations

| line | method | path | why it cannot require a session | what an unauthenticated attacker can do with it |
| --- | --- | --- | --- | --- |
| `server.js:8979` | GET | `/api/health` | Called before login by `App.jsx:1615`, `App.jsx:4500`, `App.jsx:4614`, `syncService.js:116`, and **by the Tauri shell itself** at `src-tauri/src/lib.rs:442` (raw TCP `GET /api/health`). Login refuses to proceed until this returns online (`App.jsx:4514` `if (!backendOnline)`) | Learn `version`, `deployment_type`, `app_mode`, `cloud_ready`, and **`company_id` / `company_name` / `branch_id`** (`server.js:8969-8971`). Tenant-name disclosure. Recommend trimming the identity fields from the unauthenticated response before exposure — that is an A-6 item, not a blocker |
| `server.js:8980` | GET | `/health` | Same handler (`healthHandler`, `server.js:8946`); this is the path a load balancer or Railway probe uses | Same as above |
| `server.js:8982` | GET | `/api/time` | `frontend/src/local/serverTime.js:101` calls it to establish authoritative time. Time is needed **before** a token can be trusted (token expiry is compared against a clock) | Nothing but the server clock |
| `server.js:8987` | GET | `/api/version` | Named in the A-4 plan. No in-repo caller found besides the desktop gateway's own local implementation (`desktopGateway.js:213`) — grep for `/api/version` across `frontend/src` and `src-tauri/src` returns no hits | Same identity leak as `/api/health` (`server.js:9002-9004`) |
| `server.js:9009` | GET | `/api/system/compatibility` | `App.jsx:3953` marks it `{ required: true }` in the startup preflight, run before a session exists | Learns backend/frontend version skew and DB reachability |
| `server.js:10253` | POST | `/login` | It is what mints the token (`issueDeviceSession`, `server.js:10598`) | Password guessing. **`locked_until` exists as a column but is not enforced at `/login`** — that is A-5, and it is the reason this route needs edge rate-limiting before exposure |
| `server.js:10211` | POST | `/api/auth/device-bootstrap-status` | `App.jsx:4532` calls it **immediately before** `/login` (`App.jsx:4547`) and again in `retryOnline` at `App.jsx:4626`. There is no token at either point | Device-ID enumeration: confirm whether a given `device_id` is registered and whether it is APPROVED (`server.js:10224-10237`). Low value, but it is an oracle. Rate-limit it |
| `server.js:9896` | POST | `/devices/activate` | Pre-login device enrolment by activation code. Called from `App.jsx:4658` on the login screen while `deviceGate` is set | Brute-force of the activation code. Codes are `FTF-xxxxxx-xxxxxx` (`server.js:625`, 6 hex bytes = 48 bits) and hashed (`hashActivationCode`, `server.js:621`). Acceptable, but it wants a lockout |
| `server.js:9950` | POST | `/bootstrap/first-owner-device` | **Self-authenticating**: it takes `username` + `password` and runs them through `checkPassword` (`server.js:9968`), then refuses if an approved owner device already exists (`server.js:9972`). No in-repo frontend caller — grep for `first-owner-device` across `frontend/src` and `src-tauri/src` returns nothing | Same as `/login` — password guessing against the owner account, plus it auto-approves the attacker's device on success. **This one is the sharpest edge on the list.** Consider making it a documented CLI/ops action rather than a public HTTP route |

## 2.2 Public because the browser needs them before it can log in

| line | method | path | why | attacker gets |
| --- | --- | --- | --- | --- |
| `server.js:19639` | `app.use` | `express.static(frontendDistPath)` | Serves the built SPA bundle. If this 401s, **there is no login page to log in from** | The public JS bundle. Already public by definition |
| `server.js:19640` | GET | `/^\/(?!api\/).*/` | SPA history fallback → `res.sendFile(frontendIndexPath)` | `index.html` |
| `server.js:7802` | GET | `/` | API root banner | Nothing sensitive; verify by reading the handler before shipping |

## 2.3 The password-recovery flow — public, and it must be exactly these four

| line | method | path | why | attacker gets |
| --- | --- | --- | --- | --- |
| `server.js:6476` | GET | `/auth/recovery/config` | Tells the login screen whether recovery is switched on at all | Feature-flag disclosure |
| `server.js:6917` | POST | `/auth/recovery/options` | `App.jsx:8453`, on the "forgot password" screen. By definition nobody is signed in | Account existence — mitigated by `recoveryGenericMessage` (`server.js:664`) |
| `server.js:6947` | POST | `/auth/recovery/send-otp` | `App.jsx:8490` | Can cause OTPs to be mailed/SMSed to *the account's own registered address* — a nuisance and a cost, not a takeover. **Needs a rate limit** |
| `server.js:7074` | POST | `/auth/recovery/verify-otp` | `App.jsx:8517` | OTP guessing (6 digits). **Needs an attempt cap** — verify one exists before exposure; not determined in this audit |
| `server.js:7171` | POST | `/auth/recovery/reset-password` | `App.jsx:8547` | Requires the token minted by verify-otp (`hashRecoveryToken`, `server.js:670`) |

## 2.4 Routes that look like they belong on the allow-list and MUST NOT go on it

This is the half of the allow-list that saves you.

| line | method | path | why it looks public | why it is not |
| --- | --- | --- | --- | --- |
| `server.js:6490` | GET | `/auth/recovery/profile` | It is under `/auth/recovery/` | **It is called only from an authenticated settings screen** (`App.jsx:9044`, inside the signed-in UI, passing `user.id`). Putting it on the list hands out every user's recovery email and mobile. See Part 4, VULN-1 |
| `server.js:6519` | POST | `/auth/recovery/contact/request` | Under `/auth/recovery/` | Authenticated caller at `App.jsx:9077`. Public, this is **account takeover**. See Part 4, VULN-1 |
| `server.js:6611` | POST | `/auth/recovery/contact/verify` | Under `/auth/recovery/` | Authenticated caller at `App.jsx:9106`. Second half of the takeover chain |
| `server.js:6694`, `6746`, `6791`, `6843` | POST | `/api/auth/email/*`, `/api/auth/phone/*` | Under `/api/auth/` alongside `/api/auth/device-bootstrap-status` | All four are in-app contact-verification, all guarded only by `requireSelfOrRateManager` with a client-supplied actor. Same takeover shape |
| `server.js:9120`, `9121` | POST | `/api/sync/register-device`, `/api/device/register` | Device registration — sounds like bootstrap | **Called only after login**, from `syncService.js:202`, inside `runSyncCycle`, using `context.userId` from the signed-in user. `registerSyncDeviceHandler` (`server.js:9080`) has **no identity check whatsoever** and does an `UPDATE authorized_devices` (`server.js:9095`). Public, this lets anyone rewrite any device's `platform`, `app_version` and `company_id`, and enrol unlimited pending devices. **Classify `AUTH`.** See Part 3 for the sequencing problem this creates |
| `server.js:5528` | GET | `/settings` | It is read by the login screen (`App.jsx:2005`) | It also returns **the entire users table, device table, activation codes, backup logs, WhatsApp and payment settings** when a `user_id` is supplied (`getSettingsBundle`, `server.js:4413-4428`). See Part 3 for the split that fixes this without breaking the login screen |
| `server.js:5671` | GET | `/api/update/manifest` | Update check, sounds pre-login | It is called from the in-app update panel (`App.jsx:14449`), after login, and it is a **server-side fetcher** — `AUTH` keeps it from being used as a request-forwarding primitive. The URL is allow-listed to `github.com/dhirajmanwani/FroozERP/releases/` (`server.js:5673`), which is the right guard, but there is no reason to leave it open |


---

# Part 3 — Routes that will BREAK when default-deny lands

**Headline: 129 of the 157 `axios` calls in `frontend/src/App.jsx` send no session token.**
Measured by scanning each `axios.(get|post|put|patch|delete)(` call and the six lines after it for
`createOperationalWrite` / `createOperationalReadConfig` / `sessionAuthHeaders`. 28 carry a token;
129 do not. The full list of the 129 is in `noauth-calls.txt` beside this report.

The reason is structural, and it is worth stating plainly: A-3 introduced
`frontend/src/local/authHeaders.js` and wired it into exactly **two** places in `App.jsx` —
`createOperationalWrite` (`App.jsx:383`) and `createOperationalReadConfig` (`App.jsx:391`) — which
between them cover the protocol-v3 write path and four reads. **Every other request in the app
is built inline with no auth config at all.** Default-deny turns all of them into 401s
simultaneously.

## 3.1 Called before login completes — these break the ability to sign in

| # | caller | file:line | route | what happens | fix |
| --- | --- | --- | --- | --- | --- |
| 1 | Tauri shell readiness probe (raw TCP, not axios) | `src-tauri/src/lib.rs:442` | `GET /api/health` | **The desktop app never reports the backend ready.** This is Rust, so it cannot be given a token — there is none yet | Allow-list `/api/health` (already in Part 2.1). No code change |
| 2 | `checkBackendHealth` | `frontend/src/local/connectivityService.js:157` | `GET /api/health` | Startup connectivity check fails → `App.jsx:4514` sets offline mode and login never runs | Allow-list |
| 3 | login precondition | `App.jsx:4500`, `App.jsx:4514` | `GET /api/health` | Same | Allow-list |
| 4 | `loadLoginDeviceControl` | `App.jsx:2005` | `GET /settings?device_id=…` | **The login screen loses its kiosk/fullscreen-lock config.** Note it passes only `device_id`, no `user_id` — it needs the `deviceControlSettings` slice and nothing else | **Split the route.** Add a public `GET /settings/device-control` returning only `device_control_settings` (the table is read at `server.js:4427`), point `App.jsx:2005` at it, and classify `GET /settings` as `AUTH`. Do **not** allow-list `GET /settings` — `getSettingsBundle` (`server.js:4413`) returns the users table, devices, activation codes and backup logs when a `user_id` is present |
| 5 | `login()` bootstrap gate | `App.jsx:4532` | `POST /api/auth/device-bootstrap-status` | Login aborts before reaching `/login` | Allow-list |
| 6 | `retryOnline()` | `App.jsx:4626` | `POST /api/auth/device-bootstrap-status` | "Retry online" button dead | Allow-list |
| 7 | `login()` | `App.jsx:4547` | `POST /login` | Nobody can sign in | Allow-list |
| 8 | `activateDevice()` | `App.jsx:4658` | `POST /devices/activate` | A pending device can never be activated | Allow-list |
| 9 | `checkRailwayServerTime` | `frontend/src/local/serverTime.js:101` | `GET /api/time` | Authoritative time unavailable → time diagnostics degrade | Allow-list |
| 10 | startup preflight, `{ required: true }` | `App.jsx:3953` | `GET /api/system/compatibility` | A required preflight fails → startup error | Allow-list |
| 11 | forgot-password screen | `App.jsx:8453`, `8490`, `8517`, `8547` | `/auth/recovery/options`, `/send-otp`, `/verify-otp`, `/reset-password` | Password recovery impossible for a locked-out user — the exact population that cannot present a token | Allow-list (Part 2.3) |

## 3.2 Called by the sync layer, post-login, with no token attached

These are the ones that will look like "sync mysteriously stopped" rather than "I can't log in".

| # | caller | file:line | route | why it breaks | fix |
| --- | --- | --- | --- | --- | --- |
| 12 | `initialiseSync` | `frontend/src/local/syncService.js:202` | `POST /api/sync/register-device` | Sends body only, `withTimeout()` with no headers. `context.deviceSessionToken` **is already in scope** (`syncContext`) and is used 40 lines later | Add `headers: optionalSessionAuthHeaders(context.deviceSessionToken)` to the `withTimeout()` config. One-line fix in the local layer — the right place per `CLAUDE.md` |
| 13 | `initialiseSync` | `frontend/src/local/syncService.js:217` | `GET /api/device/identity` | Same — params only, no headers | Same one-line fix |
| 14 | `/api/branch/status` | no in-repo caller found | `GET /api/branch/status` (`server.js:9524`) | Identity from `req.query.user_id` via `requireSyncContext`; breaks for any external caller | Classify `AUTH`; **not determined** whether anything outside this repo calls it. Would need the maintainer to confirm |

## 3.3 Called by the Node sidecar / desktop gateway

| # | caller | file:line | route | why it breaks | fix |
| --- | --- | --- | --- | --- | --- |
| 15 | `getCanonicalIdentity` in desktop-local runtime | `server.js:1283-1292` | `GET /api/auth/me` on the **cloud** backend | It forwards `x-user-id` and `x-session-id` **and no session token** (`server.js:1288`). Once `/api/auth/me` requires auth, this returns 401, the `catch` at `server.js:1295` swallows it, and `buildCanonicalIdentity(null)` is returned — so **FROST/AI authorisation silently degrades to "not authenticated" instead of erroring**. That is exactly the `CLAUDE.md` "errors must never render as zero" failure mode, in the auth layer | Thread the caller's session token through `getCanonicalIdentity` and send it as `Authorization: Bearer`. Until then this call is a hard dependency on `/api/auth/me` being public, which it must not be |
| 16 | `desktopGateway.js` proxy | `backend/desktopGateway.js:150-189` | everything not in `localRoute` | **No breakage** — the strip list at `desktopGateway.js:163-176` does **not** strip `authorization` or `x-froozerp-device-session`, so both survive the hop. Verified by reading the list | None |
| 17 | `forwardDesktopRequestToCloud` in `server.js` | `server.js:551-580` | everything not in `desktopLocalRoutes` | Same — the strip list at `server.js:565` is `host`, `content-length`, `connection`, `accept-encoding` only | None, **provided `requireAuth` mounts after `server.js:594`**. If it mounts before, a desktop-local `server.js` 401s every request it is merely relaying |

## 3.4 The 129 App.jsx calls, grouped by what the user loses

Not one of these sends a token today. Each group is a whole screen going blank.

| screen / feature | representative call sites (`App.jsx`) | routes |
| --- | --- | --- |
| Products & inventory | 3824, 3825, 4436 | `/products`, `/product-duplicate-archive-log`, `/inventory` |
| Purchases | 3874 | `/purchases` |
| Settings & device control | 3045, 3072, 3879 | `/settings`, `/settings/device-control/verify-exit-code` |
| Discounts / lot discounts | 3913, 3918 | `/settings/discount-rules`, `/lot-discounts` |
| Customers & suppliers | 4243, 4249, 3923 | `/customers`, `/suppliers`, `/pending-bills/customer` |
| Accounts & ledgers | 4254, 4259, 4266, 4271 | `/accounts`, `/accounts/ledger`, `/accounts/outstanding`, `/accounts/payments` |
| Reports | 3488, 4330, 4331, 4334 | `/reports/summary`, `/reports/cash-book`, `/inventory` |
| Sales, returns, waste | 4380, 4385, 4390 | `/sales`, `/sale-returns`, `/waste-entries` |
| Dashboard | 4424, 4438, 4439 | `/dashboard-metrics`, `/dashboard-analytics` |
| Expenses | 4370 | `/expenses` |
| Sale rates | 4218, 4219 | `/sale-rates`, `/sale-rate-history` |
| FROST / AI | 2375, 4035, 4066, 4071, 4076, 4101, 4175, 4188, 4204, 4206, 4208 | `/api/ai/*` (42 routes) |
| Cloud & device admin | 2189, 2255, 2283, 2351, 2355, 2565, 2823, 14978, 15045 | `/api/cloud/*` |
| Update centre | 14449 | `/api/update/manifest` |
| Recovery settings | 9044, 9077, 9106 | `/auth/recovery/profile`, `/auth/recovery/contact/*` |

**The fix is one edit, not 129.** `App.jsx` already imports `sessionAuthHeaders`
(`App.jsx:41`). The cheapest correct change is a module-scope axios interceptor in
`frontend/src/local/` — e.g. `authHeaders.js` gains an `installSessionInterceptor(getToken)` that
attaches the headers to every outgoing request, installed once from `App.jsx` where the user state
lives. That keeps the change in the testable local layer per `CLAUDE.md`, and
`authHeaders.test.mjs` can assert every request carries the header rather than asserting the
absence of inline copies.

## 3.5 LOCAL_ONLY and offline operation

**Measured conclusion: A-4 cannot weaken LOCAL_ONLY, and A-4 does not break offline operation.**

- Under LOCAL_ONLY the desktop never reaches `server.js` at all. `cloudRequest`
  (`desktopGateway.js:150`) refuses at line 151 (`!readPolicy().allowInternetAccess`) and records
  `blocked: true, reachedCloud: false` at line 152, before any socket is opened. A 401 from
  `server.js` is therefore unreachable in that mode. The invariant (`blocked=true`,
  `reachedCloud=false`, cloud-router invocations 0, external connections 0) is untouched by
  anything A-4 does inside `server.js`.
- `server.js`'s own LOCAL_ONLY equivalent is the `appInternetAllowed` check at `server.js:553`
  inside `forwardDesktopRequestToCloud`. If `requireAuth` mounted **before** `server.js:594` it
  would 401 ahead of that check — which is *stricter*, not weaker, so still no breach — but it
  would break the desktop app entirely. Mount after 594.
- Offline sessions (`frontend/src/local/offlineSession.js`) do not call the backend, so they are
  unaffected.
- **One thing to watch loudly:** `backend/storageAdapters.test.js:258/326/376/406` — the
  disposable-matrix LOCAL_ONLY test — drives `PUT /api/cloud/internet-access` on the **gateway**
  with `x-user-id: 1, x-user-role: OWNER` and no token. The gateway's Owner gate is
  `desktopGateway.js:224-229`, which trusts those headers outright. A-4 does not touch the gateway,
  so the test keeps passing — but **the LOCAL_ONLY kill switch itself is protected by a header
  anyone can set.** That is a separate hole from A-4's and it should be recorded, because
  "who may turn cloud access back on" is exactly the control the invariant depends on.

## 3.6 Two tests that will break on the wrong kind of A-4 diff

| test | assertion | what breaks it |
| --- | --- | --- |
| `backend/operationalWriteRoutes.test.js:114-119` | `assert.match(backendSource, /app\.post\("\/sales", createSaleHandler\)/)` and the same for `/sale-returns`, `/waste-entries`, `/lots/transfer-stock` | **Any per-route middleware insertion.** Rewriting to `app.post("/sales", requireAuth, createSaleHandler)` fails this test. This is a strong argument for the app-wide `app.use(requireAuth)` the plan already specifies, and against a 213-line find-and-replace |
| `backend/operationalWriteRoutes.test.js:79-89` | the raw session header is read only inside `authMiddleware`, and `verifyDeviceSession(req.headers[…])` never appears | Any A-4 shortcut that reads the header directly instead of going through `extractSessionToken` |


---

# Part 4 — The `x-user-id` removal map

## 4.1 Every site that reads the header

`grep -n 'x-user-id'` across `backend/` (excluding `node_modules` and tests) returns **13**
non-comment hits. All 13 are listed. **Not one of them is scoping — every single one is identity.**

### Identity — must be replaced by `req.auth.userId` (11 sites)

| # | file:line | code | what it selects | after A-4 |
| --- | --- | --- | --- | --- |
| I-1 | `server.js:5208` | `userId: req.query.user_id \|\| req.headers["x-user-id"]` | who `/api/auth/me` reports as | `req.auth.userId` |
| I-2 | `server.js:5240` | `userId: req.body.user_id \|\| req.headers["x-user-id"]` | who is allowed to flip cloud internet access | `req.auth.userId` + `requireRole("OWNER")` |
| I-3 | `server.js:5267` | `userId: req.query.user_id \|\| req.headers["x-user-id"]` | identity attached to `/api/cloud/health` | `req.auth.userId` |
| I-4 | `server.js:5325` | `const userId = req.query.user_id \|\| req.headers["x-user-id"]` | who may read device status | `req.auth.userId` |
| I-5 | `server.js:5354` | `userId: req.body.user_id \|\| req.headers["x-user-id"]` | **who approves a device** | `req.auth.userId` + `requireRole("OWNER")` |
| I-6 | `server.js:5399` | `getPermissionUser(req.query.user_id \|\| req.headers["x-user-id"], "settings", ["Owner","Admin"])` | email-integration status | `req.auth.userId` |
| I-7 | `server.js:5417` | same shape, `req.body.user_id` | sends a test email | `req.auth.userId` |
| I-8 | `server.js:5452` | same shape, `req.query.user_id` | SMS status | `req.auth.userId` |
| I-9 | `server.js:5471` | same shape, `req.body.user_id` | sends a test SMS | `req.auth.userId` |
| I-10 | `server.js:9206` | `user_id: req.body?.user_id \|\| req.query?.user_id \|\| req.headers["x-user-id"]` | the *submitted* identity fed to `rejectDeviceSessionSubstitution` inside `resolveV3OperationalContext` | **This one is already correct** — it is a value to be *checked against* the token, exactly as `authMiddleware.js:120` does. It may stay, but it becomes redundant once `requireAuth` runs the same check first |
| I-11 | `aiBusinessAssistantService.js:147` | `req.query.user_id \|\| req.body?.user_id \|\| req.headers["x-user-id"]` | **the identity for all 42 FROST routes** | `req.auth.userId`. Single highest-leverage line in this table |

### Outbound — a header this server *sends* (1 site)

| # | file:line | code | issue |
| --- | --- | --- | --- |
| O-1 | `server.js:1288` | `"x-user-id": String(parsedUserId)` inside `getCanonicalIdentity`'s desktop-local branch | The local backend asserts a user id to the **cloud** backend with no token. Once the cloud enforces auth this call fails, and its `catch` (`server.js:1295`) turns the failure into an unauthenticated identity rather than an error. Must carry the caller's session token instead |

### Gateway — outside `server.js`, unaffected by A-4 (1 site)

| # | file:line | code | issue |
| --- | --- | --- | --- |
| G-1 | `desktopGateway.js:224-227` | `const userId = String(input.user_id \|\| req.headers["x-user-id"] \|\| "").trim(); … if (!userId \|\| !deviceId \|\| role !== "OWNER") return 403` | **The LOCAL_ONLY kill switch is gated on two headers the caller chooses.** `x-user-role: OWNER` is sufficient. The gateway is a separate process with no user table and no signing key, so this is not fixable by mounting `requireAuth` — it needs its own design decision. Recorded here because it is the control protecting the `CLAUDE.md` connectivity invariant. Also note `desktopGateway.js:278` advertises `x-user-id` and `x-user-role` in `access-control-allow-headers` |

## 4.2 The much larger identity surface: `updated_by` / `created_by` and friends

**This is the finding that decides whether A-4 actually closes the hole.**

`x-user-id` is 11 sites. The *dominant* identity mechanism in `server.js` is a client-supplied
integer in the request body or query, passed straight into `requireRateManager`
(`server.js:853`) or `getPermissionUser` (`server.js:1225`). `grep -n 'requireRateManager('`
returns **63 call sites** (`grep -c 'requireRateManager('`, definition excluded because it has no immediate paren), and `getPermissionUser(` returns **12**; the arguments are `req.body.updated_by`, `req.body.created_by`,
`req.body.changed_by`, `req.body.edited_by`, `req.query.user_id`, `req.query.updated_by`, and
locals derived from them (`entry.actorId`, `cancelledBy`, `editor.id`, `parsedCreatedBy`).

`rejectDeviceSessionSubstitution` compares **only** `user_id`, `device_id`, `company_id`,
`branch_id` (`deviceSession.js:80-85`), and `submittedIdentityFrom` gathers only those four
(`authMiddleware.js:117-124`).

> ### 🔴 LOUD: mounting `requireAuth` does not stop privilege escalation between authenticated users.
>
> After A-4, a signed-in Cashier holding a perfectly valid token can call
> `PUT /settings/business` (`server.js:6136`) with `{"updated_by": <owner's id>}` and
> `requireRateManager` (`server.js:6138`) will approve it. The token proves the Cashier is the
> Cashier; nothing compares that to `updated_by`. The same applies to all 63 sites, including
> `POST /users` (`server.js:6316`), `DELETE /users/:id` (`server.js:6457`),
> `PUT /users/:id/password` (`server.js:6391`), `POST /settings/activation-codes`
> (`server.js:10061`) and `PUT /settings/role-permissions/:roleName` (`server.js:5547`).
>
> **A-4 is not complete until every `requireRateManager(req.body.updated_by)` becomes
> `requireRateManager(req.auth.userId)`.** Doing the middleware without this work converts a
> *"anyone on the network is Owner"* bug into a *"any employee is Owner"* bug. That is an
> improvement, but it must not be reported as closed.
>
> An interim mitigation that is one line and mechanical: extend `submittedIdentityFrom`
> (`authMiddleware.js:117`) to also fold `updated_by`, `created_by`, `changed_by`, `edited_by`,
> `deactivated_by`, `reactivated_by`, `cancelled_by` and `approved_by` into the `user_id`
> comparison, so a mismatch is rejected as substitution. It is blunt — it forbids a legitimate
> "Owner edits on behalf of" pattern that does not currently exist — but it closes all 63 sites at
> once and fails loudly rather than silently.

## 4.3 Individually called-out vulnerabilities

### 🔴 VULN-1 — Unauthenticated account takeover via the recovery-contact routes

`requireSelfOrRateManager` (`server.js:1132`):

```js
const requireSelfOrRateManager = async (targetUserId, actorUserId, client = pool) => {
  const parsedTarget = parsePositiveInteger(targetUserId);
  const parsedActor = parsePositiveInteger(actorUserId);
  if (!parsedTarget || !parsedActor) return null;
  if (parsedTarget === parsedActor) { /* returns the user row */ }
  return requireRateManager(parsedActor, client);
};
```

Every caller passes the actor as `updated_by || user_id`:

- `server.js:6493` — `requireSelfOrRateManager(userId, req.query.updated_by || req.query.user_id)`
- `server.js:6523`, `6615`, `6698`, `6750`, `6795`, `6847` — same, from `req.body`

**Omit `updated_by` and the actor is defaulted to the target, so `parsedTarget === parsedActor`
is always true and the check always passes.** No credentials at any point. The chain:

1. `GET /auth/recovery/profile?user_id=1` (`server.js:6490`) returns the Owner's
   **`recovery_email` and `recovery_mobile` in the clear** (`server.js:6496-6499`), not only the masked
   forms — plus `username`, `full_name`, and verification state. Iterating `user_id` enumerates
   the whole staff directory with contact details.
2. `POST /auth/recovery/contact/request {"user_id":1,"contact_type":"email","contact_value":"attacker@…"}`
   (`server.js:6519`) writes
   `UPDATE users SET pending_recovery_email = $1, recovery_email_verified = FALSE` (`server.js:6579`)
   and mails the OTP **to the attacker's address**.
3. `POST /auth/recovery/contact/verify` (`server.js:6611`) promotes it:
   `SET recovery_email = pending_recovery_email, verified_email = pending_recovery_email,
   recovery_email_verified = TRUE` (`server.js:6648-6652`).
4. `POST /auth/recovery/send-otp` → `/verify-otp` → `/reset-password`
   (`server.js:6947`, `7074`, `7171`) now delivers the reset to the attacker.

**Owner account takeover from an unauthenticated HTTP client, in four requests.** A-4 fixes it
incidentally — `rejectDeviceSessionSubstitution` pins `body.user_id` to the token — but the
defaulting logic at `server.js:6493` and the six sibling lines should be fixed on its own merits,
because it is wrong independently of who is authenticated. **Do not put any of these seven routes
on the allow-list.**

### 🔴 VULN-2 — Unauthenticated full staff/device/activation dump via `GET /settings`

`server.js:5528` → `getSettingsBundle(req.query.user_id, req.query.device_id)`
(`server.js:4413`). At `server.js:4428` the bundle calls `requireRateManager(userId)`; when that
returns a manager, `server.js:4430-4460` add the **entire users table** (`id, full_name, username,
mobile_number, email, active, last_login_at, role, branch`), every row of `authorized_devices`,
every activation code with its label and status, branches, counters, backup settings, backup logs,
system info and device-exit logs. `requireRateManager`'s only input is `req.query.user_id`.

`GET /settings?user_id=1` — no credentials — returns all of it. Owner ids in a single-owner shop
are small integers.

### 🔴 VULN-3 — Unauthenticated device-record tampering

`registerSyncDeviceHandler` (`server.js:9080-9119`), mounted at `server.js:9120` and `9121`, has
**no identity check of any kind**. It calls `upsertDeviceRequest` (`server.js:9087`) and then
`UPDATE authorized_devices SET platform = $2, app_version = $3, company_id = COALESCE($4, company_id)
WHERE device_id = $1` (`server.js:9095-9101`) for **any `device_id` the caller names**, including
one already approved. It also creates unlimited pending device rows. Classify `AUTH`.

### 🟠 VULN-4 — 98 routes with no check at all

The 98 `NONE` rows in Part 1.3. The ones that read or write money and are reachable by anyone who
can reach the port: `/accounts` (`12701`), `/accounts/ledger` (`12928`), `/accounts/outstanding`
(`12911`), `POST /accounts/payments` (`13091`), `POST /customer-payments` (`13643`),
`/supplier-payments` (`15854`, `15876`, `15922`, `15985`), `/expenses` (`15661`, `15715`, `15747`,
`15807`), `/contra-entries` (`14054`, `14071`), `/reports/balance-sheet` (`14006`),
`/reports/cash-book` (`14033`), `/reports/day-book` (`14361`), `/reports/summary` (`14560`),
`/customer-ledger` (`13816`), `/supplier-ledger` (`16030`), `/sales` and `/sales-history`
(`18429`, `18594`, `18604`, `18614`, `18624`), `/purchases` (`16548`),
`POST /suppliers` / `PUT` / `DELETE` (`13395`, `13450`, `13512`),
`POST /customers` / `PUT` (`13552`, `13588`), `/stock-inventory` (`13675`), `/inventory` (`12338`),
`/stock` (`12354`). Default-deny is exactly the right instrument for these — there is nothing to
migrate, they simply start requiring a session.

### 🟠 VULN-5 — Sync routes verify nothing in the default configuration

`resolveSyncRequestContext` (`server.js:9129`) short-circuits at `server.js:9138`:

```js
if (operationalScopeMode !== SCOPE_MODES.ENFORCE) {
  return requireSyncContext({ userId: submitted.user_id, deviceId: submitted.device_id, … }, client);
}
```

`operationalScopeMode` comes from `FROOZERP_OPERATIONAL_SCOPE_MODE` (`server.js:94`) and
`normalizeScopeMode` returns `OFF` for anything unrecognised, **including unset**
(`operationalScope.js:16`). So on a default deployment `POST /api/sync/push` (`server.js:9579`),
`GET /api/sync/pull` (`9644`) and `GET /api/sync/status` (`9739`) take identity from the request
body/query and never call `verifyDeviceSession`. The A-3 record describes "the sync path" as
session-verified; **that is true only with the env var set to `enforce`.** Mounting `requireAuth`
in front of them fixes this, which is a genuine and underappreciated win of A-4.

### 🟠 VULN-6 — `rateLimitSyncRequest` is not a control

`server.js:7976` keys the limiter on `${req.ip}:${req.body?.device_id || req.query?.device_id}`.
The caller picks `device_id`, so the 120/min cap is bypassed by incrementing it. Do not count it
as protection for `/login`-adjacent or OTP routes.


---

# Part 5 — Recommended execution order

The ordering constraint is: **the tree must never be in a state where the app cannot start or log
in.** That rules out "mount the middleware, then fix the callers" — between those two commits the
desktop app is bricked. Every step below is independently shippable and leaves a working app.

### Step 0 — Coordinate with the concurrent `server.js` editor

`backend/server.js` changed mid-audit and `backend/sessionSecret.test.js` appeared (Part 0). A-4
touches the same file. Land or park that work first; two agents in a 19.7k-line file is how a
merge silently drops a route registration, and in this file a dropped registration is a bypass.

### Step 1 — Callers first, middleware last (frontend + sidecar, no behaviour change)

Nothing here changes what the server accepts, so it cannot break anything, and it can ship on its
own.

1a. **`frontend/src/local/authHeaders.js`** — add `installSessionInterceptor(getToken)` and its
tests. New logic in the local layer, per `CLAUDE.md`.

1b. **`frontend/src/App.jsx`** — install the interceptor once, next to where the user state lives.
This covers the 129 unauthenticated calls in §3.4 with one edit rather than 129. Keep
`createOperationalWrite` / `createOperationalReadConfig` as they are; a duplicate header is
harmless.

1c. **`frontend/src/local/syncService.js:202` and `:217`** — attach
`optionalSessionAuthHeaders(context.deviceSessionToken)`. Two lines. Fixes §3.2.

1d. **`server.js:1283-1292`** — thread the session token into `getCanonicalIdentity`'s cloud call
and stop relying on `x-user-id` alone. Fixes §3.3 #15 and removes the outbound `x-user-id` (O-1).

Gates after step 1: `npm --prefix frontend run lint`, `npm run build`,
`TZ=Asia/Kolkata node --test frontend/src/local/*.test.mjs`, `npm run backend:check`.

### Step 2 — Split `GET /settings` so the login screen stops needing the full bundle

Add a narrow public route returning only `device_control_settings`, repoint `App.jsx:2005`, and
leave `GET /settings` classified `AUTH`. This is the one route where the allow-list decision is a
*design* decision rather than a lookup, and doing it before the middleware means the allow-list
never has to contain `/settings`. Fixes VULN-2's exposure route.

Ship steps 1 and 2 together or separately; either way the app still works, still logs in, and the
server still accepts everything it accepted before.

### Step 3 — Mount `requireAuth` app-wide, default-deny

One insertion point: **immediately after `server.js:594`** (the desktop-local forwarder) and
**before `server.js:5197`** (`registerAiBusinessAssistantRoutes`). That position satisfies every
ordering constraint in §1.2 simultaneously:

- after `express.json` (59) so `submittedIdentityFrom` sees the body,
- after `cors` (497) so 401s carry CORS headers,
- after the 426 protocol gate (522) so old clients still get the upgrade hint,
- after the desktop-local forwarder (594) so a desktop `server.js` relays rather than refuses,
- before the AI routes (5197) and everything else.

Shape — allow-list by exact path, not prefix, so `/api/health/../admin` cannot be smuggled in:

```
app.use((req, res, next) => {
  if (isPublicRoute(req.method, req.path)) return next();
  return requireAuth(req, res, next);
});
```

`isPublicRoute` belongs in a **new small module** (`backend/publicRoutes.js`) rather than inline in
`server.js`, so the completeness test can import the same list the server uses. A test asserting
against a copy of the list proves nothing.

The static-file problem: `app.use(express.static(...))` is registered at `server.js:19639`,
*after* this middleware, so under default-deny the SPA bundle 401s. Two options — either move the
static block above the `requireAuth` mount, or add a rule to `isPublicRoute` for `GET` requests
whose path does not start with `/api/` (matching the existing SPA-fallback predicate at
`server.js:19640-19642`). **Moving the static block is cleaner and easier to reason about**;
whichever is chosen, `npm run verify:production` exercises the static path and must be re-run.

**Do not** insert middleware per route. `backend/operationalWriteRoutes.test.js:114-119` pins four
registrations by exact source text (§3.6), and a 213-site edit in this file is where a route gets
missed.

### Step 4 — The completeness test, written before the allow-list is finalised

Per the plan, this is what proves A-4, not the diff. It must enumerate **all 275 handlers**, not
the 213 in `server.js` — the 42 FROST routes and the 20 protocol-v3 routes are registered from
other modules and a naive `grep` of `server.js` misses every one of them. Enumerate by walking
`app.router.stack` after requiring the app, or by scanning all three files. Assert each route is
either on the imported allow-list or reachable only behind `requireAuth`.

### Step 5 — `requireRole` on the Owner/Admin surface

Only after step 3 is green. `requireRole("OWNER")` on `PUT /api/cloud/internet-access` (5237),
`POST /api/cloud/device/approve` (5351), the `/users` family (6316, 6354, 6391, 6430, 6444, 6457),
`PUT /settings/role-permissions/:roleName` (5547), `POST /settings/activation-codes` (10061) and
`/api/v3/admin/*` (`operationalV3.js:1253`, `1258`).

Remember the A-3 design note: a token minted before A-3 carries no `role` claim and
`requireRole` denies it (`authMiddleware.js:173`). Everyone signed in across the deploy boundary
gets 403 on role-gated routes until they sign in again. That is correct behaviour, but it is a
user-visible event and should be expected rather than debugged.

### Step 6 — Replace the client-asserted actor (the real close of the hole)

Convert the 63 `requireRateManager(req.body.updated_by)` / `getPermissionUser(req.query.user_id)`
sites to `req.auth.userId`, and the 11 `x-user-id` identity reads (I-1…I-9, I-11) with them.
Mechanical, high-volume, and best done as its own commit so the diff is reviewable. §4.2 explains
why skipping this leaves a live escalation path; the interim `submittedIdentityFrom` widening in
§4.2 is a reasonable stopgap if step 6 cannot land in the same release.

### Step 7 — Fix `requireSelfOrRateManager`'s actor defaulting

`server.js:6493`, `6523`, `6615`, `6698`, `6750`, `6795`, `6847`. Pass `req.auth.userId` as the
actor and stop defaulting it to the target. Independently correct, and it removes VULN-1 rather
than merely making it require a login.

### Step 8 — Record what A-4 did **not** fix

For the A-4 record in `docs/auth-hardening-plan.md`, in the same spirit as the A-1/A-2/A-3
records:

- `desktopGateway.js:224-229` — the LOCAL_ONLY kill switch is still gated on `x-user-id` and
  `x-user-role`. Not reachable by `requireAuth`; needs its own decision (§4.1 G-1).
- `rateLimitSyncRequest` is keyed on a client-chosen `device_id` and is not a control (VULN-6).
- Multi-tenant isolation remains unaudited (plan §5) — with auth fixed, the next question is
  whether an authenticated user of branch A can read branch B.
- `/api/health` and `/api/version` disclose `company_id`, `company_name` and `branch_id` to
  unauthenticated callers (`server.js:8969-8971`, `9002-9004`).

### Gates the lead must re-run on the integrated tree

`npm --prefix frontend run lint`, `npm run build`, `npm run backend:check`,
`npm --prefix backend test`, `TZ=Asia/Kolkata node --test frontend/src/local/*.test.mjs`,
`cargo check --manifest-path src-tauri/Cargo.toml`, plus
`npm run verify:disposable-matrix` (LOCAL_ONLY invariant) and `npm run verify:production`
(static-asset serving, which step 3 touches).

---

## Things this audit could not determine

- Whether `GET /api/branch/status` (`server.js:9524`) has any caller outside this repository.
  No in-repo caller was found. Would need the maintainer to confirm before classifying it `AUTH`.
- Whether `POST /auth/recovery/verify-otp` (`server.js:7074`) enforces an attempt cap. Not read in
  full; it matters because that route is on the allow-list.
- Whether `GET /` (`server.js:7802`) returns anything sensitive. The handler was not read line by
  line; it is proposed `PUBLIC` on the assumption it is an API banner and that should be checked.
- Whether any production deployment sets `FROOZERP_OPERATIONAL_SCOPE_MODE=enforce`. VULN-5's
  severity depends entirely on that, and no deployment configuration was inspected (and none would
  be — no production contact).
