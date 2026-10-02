# Moving The Cloud: Railway → Render + Neon

**Written 2026-10-01.** This is the runbook for moving the shop's cloud backend from Railway to
Render (web service, free plan, Singapore), and its database from Railway Postgres to Neon (AWS
ap-southeast-1). Every platform step in it is done by the owner, in the platform's own dashboard
or from the owner's laptop. Nothing here is run by an agent, and nothing here publishes a release.

Items marked **(verify)** depend on Render or Neon behaviour that cannot be checked from the
repository. Check them on the platform before relying on them.

---

## The shape of the move

There are two phases, and the order matters.

**Phase 1: host-agnostic code. Merges any time. Changes nothing on Railway.** Merging to `main`
auto-deploys the live Railway service, so every Phase 1 change has to be a no-op there. The
production URL constants still name the Railway `27bb` address. Phase 1 adds:

| What | Where | Effect on Railway as it runs today |
|---|---|---|
| Fail-closed hosted guard | `backend/hostedDeploymentGuard.js` | None, if Railway's variables are as described in "Before merging Phase 1" below |
| Exact CORS origins, no platform wildcard | `backend/cloudCorsPolicy.js` | The Railway origin, the Tauri shells, same-origin pages and LAN hosts all still work. Only *another* `*.up.railway.app` site calling this API from a browser is refused |
| Freeze switch `FROOZERP_CLOUD_FROZEN` | `backend/cloudFreeze.js` | None until the variable is set |
| `trust proxy` hop count `FROOZERP_TRUST_PROXY_HOPS` | `resolveTrustProxy` | None; the default is still 1 |
| `RENDER_EXTERNAL_URL` as a fallback public URL | `server.js` `publicCloudApiUrl` | None; Railway does not set it |
| Deployment id names the platform it sees | `defaultCloudDeploymentId` | None: `railway-production` on Railway, and the value only feeds a yes/no readiness check |
| In-process backups off where they cannot survive | `server.js`, `backupLocation.durable` | **Visible if Railway has no `BACKUP_DIR`**; see below |
| Pool: `PG_POOL_MAX`, 15 s connect timeout, keep-alive, idle-error handler | `backend/storageAdapters.js` | The pool size stays 10 unless `PG_POOL_MAX` is set. A database that stops answering now fails a request after 15 s instead of hanging it |
| Host-neutral SMTP hint | `backend/emailDelivery.js` | Wording only |
| `render.yaml` | repo root | None. Render reads it only when someone applies it |

**Phase 2: the cut-over release.** The new URL goes into every layer, the old `27bb` URL goes into
every legacy list (so saved configurations are rewritten), and a desktop build carrying that is
published *after* the Neon database holds the restored data. See "Phase 2 code" at the end.

---

## What the guard refuses, and why

The server decides it is "hosted" from FroozERP's own variables, never from the platform's. There
are two ways to get those wrong, and both used to start up, answer `/api/health` with 200, and go
live:

- **`HOSTED_APP_MODE_MISSING`**: the runtime is `cloud-server` (from `FROOZERP_RUNTIME_MODE`, or from
  `FROOZERP_DEPLOYMENT_TYPE=cloud` + `APP_MODE=CLOUD_PRODUCTION`), but `APP_MODE` is not
  `CLOUD_PRODUCTION`. Without the refusal, the startup schema bootstrap runs against the live
  database at every boot. That bootstrap archives "duplicate" products, back-fills ids and rewrites
  role permissions. The one allowed exception is an isolated test: `NODE_ENV=test` with a loopback
  database or none (the rehearsal stand-in cloud, the in-process test harness).
- **`HOSTED_RUNTIME_MISSING`**: the runtime is *not* `cloud-server`, but either a hosting platform's
  own variables are present (`RENDER`, `RENDER_SERVICE_ID`, `RENDER_EXTERNAL_URL`,
  `RENDER_EXTERNAL_HOSTNAME`, `RAILWAY_ENVIRONMENT`, `RAILWAY_ENVIRONMENT_NAME`,
  `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID`), or `DATABASE_URL` is set
  while no runtime was chosen. Without the refusal, the process falls back to `desktop-local`. It
  ignores `DATABASE_URL`, serves an empty SQLite file from an ephemeral disk, and forwards business
  requests to whatever cloud URL it can find, all while reporting healthy.

So a hosted service needs **exactly these three, and the first two are required**:

```
APP_MODE=CLOUD_PRODUCTION
FROOZERP_DEPLOYMENT_TYPE=cloud
FROOZERP_RUNTIME_MODE=cloud-server     # recommended; the first two alone also resolve to cloud-server
```

A refused start logs `[hosted-guard] <CODE>: …` and exits 1. The platform's health check fails,
and the deployment that is already serving stays where it is. The guard never prints a variable's
value, only its name.

The guard leaves these alone, and tests pin each one (`backend/hostedDeploymentGuard.test.js`):
Railway as it runs; Render as `render.yaml` configures it; `scripts/run-rehearsal.mjs`, including
from a shell carrying `RAILWAY_*` variables; the `scripts/multibranch/isolated-*` rigs; the
in-process test harness; a bare `node backend/server.js`; and an explicit desktop-local run. The
desktop app and `npm run app:disposable` never load `server.js`; Tauri runs `desktopGateway.js`.

---

## Before merging Phase 1 (owner, on Railway, read-only)

Do these before Phase 1 reaches `main`. Each one says what to look at and why.

1. **Open `https://froozerp-production-27bb.up.railway.app/api/health`** and confirm
   `deployment_type: "cloud"` and `app_mode: "CLOUD_PRODUCTION"`. If either one differs, **do not
   merge**: the guard would refuse to start the new deploy. Railway would keep the old one running,
   but the variables need fixing first anyway.
2. **Railway → service → Variables. Check the names and values below**:
   - `APP_MODE` is exactly `CLOUD_PRODUCTION`.
   - `FROOZERP_DEPLOYMENT_TYPE` is `cloud`.
   - `FROOZERP_RUNTIME_MODE` is `cloud-server` or unset. If it is unset, the two above still resolve
     to cloud-server.
   - `NODE_ENV` is `production`, not `test`.
   - `FROOZERP_CLOUD_FROZEN` and `FROOZERP_TRUST_PROXY_HOPS` are **not** set.
3. **`BACKUP_DIR`.** If Railway has `BACKUP_DIR` set (the old template suggested `/app/backups`),
   nothing changes. If it is **unset**, the server now skips its scheduled and shutdown backups. It
   also answers *Settings → Backup now* and *Safe shutdown* with **409
   `BACKUP_LOCATION_NOT_DURABLE`**, naming `scripts/cloud/backup-cloud.mjs`. Those files were
   written inside the container and deleted at every deploy, so no real backup is lost; but the
   button's answer does change. The real backup is `backup-cloud.mjs` (`CLOUD_BACKUP.md`).
4. **`CLOUD_API_URL`.** If it is set, it now also becomes an exact allowed CORS origin, and it
   replaces the hard-coded Railway URL in `/login`'s `canonical_cloud_api_url`. No client reads that
   field today. It should be the `27bb` URL or unset; anything else, find out why first.
5. **Browser origins.** Does anything *other than* the backend's own page call this API from a
   browser? For example, a second Railway site, or a dashboard on another `*.up.railway.app`
   domain. If so, add its exact origin to `ALLOWED_ORIGINS` before merging, because the wildcard is
   gone. The desktop and phone apps are not affected: they send `tauri://localhost` or
   `http(s)://tauri.localhost`, which are allowed by name.
6. **Re-run every gate on the integrated tree** (CLAUDE.md "Commands").

After the merge deploys, open `/api/health` again and confirm `status: "ok"`. In the deploy log,
look for `CORS allowed origins: …` listing the `27bb` and the old `froozerp-production` origins.

---

## Environment on Render (names only)

`render.yaml` declares these. Plain values live in the file; the rest are `sync: false`, and Render
asks for them when the Blueprint is applied. **No value is ever committed.**

| Name | In `render.yaml` | Notes |
|---|---|---|
| `NODE_VERSION` | `22` | engines `>=22` |
| `NODE_ENV` | `production` | |
| `APP_MODE` | `CLOUD_PRODUCTION` | required by the guard |
| `FROOZERP_DEPLOYMENT_TYPE` | `cloud` | |
| `FROOZERP_RUNTIME_MODE` | `cloud-server` | |
| `RUN_STARTUP_SCHEMA_BOOTSTRAP` | `false` | ignored when hosted; belt and braces |
| `FROOZERP_CLOUD_DEPLOYMENT_ID` | `render-production` | |
| `PG_POOL_MAX` | `5` | Neon free; the code default is 10 |
| `CLOUD_API_URL` | secret prompt | `https://<service>.onrender.com`. If it is left empty, Render's own `RENDER_EXTERNAL_URL` is used **(verify that Render sets it)** |
| `DATABASE_URL` | secret prompt | Neon **direct** (non-pooler) endpoint, `?sslmode=verify-full` |
| `DEVICE_SESSION_SECRET` | secret prompt | **identical to Railway**, or every counter's session stops verifying |
| `RECOVERY_OTP_HASH_SECRET` | secret prompt | set explicitly; never fall back to the built-in default |
| `FROOZERP_ACTIVATION_SIGNING_KEY` | secret prompt | only to *issue* licences |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` | secret prompt | HTTPS email; Render free reportedly blocks SMTP **(verify)** |
| `FROOZERP_OPERATIONAL_SCOPE_MODE` | secret prompt | copy Railway's value exactly |
| `COMPANY_ID`, `BRANCH_ID`, `FROOZERP_COMPANY_NAME`, `SMS_*`, `FROOZERP_ACTIVATION_KEY_ID`, `ALLOWED_ORIGINS` | add by hand | only if Railway has them. Never set `OPENAI_API_KEY`: it must stay unset (it would stream the counter microphone to a path FroozERP does not own). |

**Never set on Render:** `PORT` (Render sets it), `BACKUP_DIR` (there is no persistent disk on the
free plan), `FROOZERP_DESKTOP_SERVICE`, `FROOZERP_SQLITE_PATH`, `NODE_ENV=test`,
`FROOZERP_ALLOW_LOOPBACK_*`, `FROOZERP_ALLOW_SCHEMA_DRIFT`, `RECOVERY_DEV_OTP_ENABLED`, and
`FROOZERP_CLOUD_FROZEN` (outside a cut-over).

`DB_HOST`, `DB_NAME`, `DB_USER` and `CLOUD_DATABASE_URL` are **not** used to connect. The server
connects with `DATABASE_URL` only.

If the first Render build runs out of memory on the Vite build, add `NODE_OPTIONS` with
`--max-old-space-size=…` **(verify)**.

---

## Day −N: preparation (nothing live changes)

1. **Owner, on Railway, read-only:**
   - Run `SHOW server_version;` and
     `SELECT pg_size_pretty(pg_database_size(current_database()));`.
   - Write down every service variable *name*, using the table above as a checklist.
   - Do the checks in "Before merging Phase 1".
2. **Neon.** Create the project in **AWS ap-southeast-1 (Singapore)**, on **the same Postgres major
   as Railway or newer**.
   - Use client tools (`pg_dump`, `pg_restore`, `psql`) of the Neon major. `pg_dump` must be at
     least the source server's version, and `pg_restore` at least the `pg_dump` that wrote the
     archive. Never restore a newer-major dump into an older server: a PG17 `pg_dump` emits
     `SET transaction_timeout`, which PG16 rejects.
   - Check the free-plan limits against the size from step 1 **(verify on Neon's pricing page)**.
     Roughly: 0.5 GB of storage, a monthly compute allowance at 0.25 CU, and about 5 GB/month of
     egress. While any counter is open, health checks (every 30 s) and sync (every 60 s) keep the
     compute awake, so a 12–14 hour shop day can use most of the compute allowance.
3. **Merge Phase 1 to `main`.** It auto-deploys to Railway as a no-op (see above). Re-run every
   gate first.
4. **Create the Render service from `render.yaml`**, with `DATABASE_URL` pointing at a **Neon branch
   `rehearsal`** that holds a restored copy of a fresh Railway dump (made as in steps 8–9 below).
   **Never point it at an empty database.** On first boot the server bootstraps an empty hosted
   database, and a later `pg_restore` into it half-fails on the existing tables.
   - Rehearse with `npm run app:disposable`, on a disposable profile, with
     `FROOZERP_CLOUD_API_URL=https://<service>.onrender.com`. Do not seed from live while it points
     at any cloud.
   - Run `CLOUD_API_URL=https://<service>.onrender.com npm run cloud:verify`.
   - Time a sign-in on the free instance's 0.1 CPU **(verify)**. scrypt costs about 350 ms on a full
     core, so several counters signing in together after a cold start may exceed the app's 8 s
     login timeout and land in offline sessions. If they do, consider a paid instance.
   - Check `req.ip` behind Render's edge. Sign in, make a deliberate wrong-password attempt from the
     shop, and confirm that the lockout and the audit row record the **shop's public IP**, not a
     Render address. If they record Render's address, set `FROOZERP_TRUST_PROXY_HOPS` to the number
     of proxies in front of the app **(verify)**, redeploy, and check again. Never trust the whole
     chain.
5. **Build the Phase 2 RC (unsigned)** and rehearse it against the Render rehearsal branch, following
   *Milestone Rehearsal* in `RELEASE_AND_UPDATE_PROCESS.md`. **Do not publish it yet.** A counter on
   the new build would write to Neon while the others still write to Railway, which splits the
   books.

---

## Cut-over evening (after the shop closes; the owner performs every platform step)

6. **Freeze Railway.** Set `FROOZERP_CLOUD_FROZEN=true` on the Railway backend; it redeploys.
   - Check that `/api/health` answers **200** with `"status": "frozen"`, and that
     `POST /api/sync/push` answers **503** `CLOUD_UNAVAILABLE`.
   - Any value other than `true` does **not** freeze. The log says so, and `/api/health` keeps
     saying `"ok"`. Read the health answer; do not assume the freeze took.
   - Counters on the old build now treat the cloud as offline and queue locally. Their outbox
     entries are released, not rejected.
   - **Do not** delete the Railway domain or the service. That produces 404s, and a 404 on the
     offline-purchase replay marks queued GRNs `failed`, outside the automatic queue. A 503 retries.
7. **Wait about 2 minutes** for in-flight requests to finish. Then confirm nothing is still writing:
   run `SELECT max(id) FROM sync_change_log;` twice, a minute apart, and check the answers match.
8. **Dump Railway** from its `DATABASE_PUBLIC_URL`:
   - Run `scripts/cloud/backup-postgres.ps1` (`pg_dump --format=custom --no-owner --no-acl`, then
     `pg_restore --list` as a check), with `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_NAME` and
     `PGPASSWORD` taken from that URL.
   - Also take a `node scripts/cloud/backup-cloud.mjs` JSONL copy as an independent second backup.
9. **Restore** into the **empty production database on Neon's direct endpoint**:
   - Run `scripts/cloud/restore-postgres.ps1` with `PGSSLMODE=require`. It refuses a non-empty
     target, and restores with `--single-transaction --exit-on-error --no-owner --no-acl`, as the
     Neon owner role. That role must own the tables, because the server runs a small DDL step at
     every boot.
   - Render must **not** be pointed at this database yet.
10. **Verify** the restored database:
    - Run `backup-cloud.mjs` against Neon and compare its per-table summary with the Railway JSONL
      summary. `verify-row-counts.ps1 -CompareDatabase` cannot span two hosts, so run it once per
      host and diff the two.
    - Run `node scripts/cloud/check-schema-drift.mjs` and expect no drift.
    - Run `node scripts/run-cloud-migrations.js`; the dry run rolls back cleanly.
    - Run `node scripts/show-setup.mjs`: the owner is OK, and passwords are scrypt.
    - For the key sequences, `SELECT last_value` must be at least `max(id)`. Device pull cursors
      depend on `sync_change_log` ids carrying over.
11. **Point Render's `DATABASE_URL`** at the Neon production database (direct endpoint,
    `sslmode=verify-full`) and deploy.
    - In the log, expect `schema contract verified`,
      `[auth] Every active user's password is stored as scrypt`, and
      `business counts after bootstrap` matching Railway.
    - In the log, also expect **no** `[hosted-guard]` line, and
      `[backup] Scheduled and shutdown backups are OFF` (correct: there is no disk).
    - Run `CLOUD_API_URL=https://<service>.onrender.com EXPECTED_APP_VERSION=<version> npm run cloud:verify`.
12. **Publish the Phase 2 desktop build**, following the release process. The maintainer publishes;
    the signing key stays with them.
    - Counters take it in their auto-update window (by default 22:00–06:00 every day). The update
      comes from GitHub, independent of the cloud.
    - LOCAL_ONLY devices do not download; update them by hand.

## After the update: how queued bills reach Neon

13. On first launch, `sanitizeSavedApiConfigForRuntime` rewrites the saved `27bb` URL to the Render
    URL, and the gateway gets the new constant from `lib.rs`.
    - The outbox drains through `/api/sync/push`.
    - Operations Railway applied before the freeze are de-duplicated by `sync_processed_operations`,
      which was restored with the dump.
    - Pull cursors continue, because `pg_dump` preserved the `sync_change_log` ids and sequences.
    - `DEVICE_SESSION_SECRET` is identical, so existing tokens verify.
    - A session opened **offline** (during the freeze, or on a cold start) carries no cloud token.
      Staff must sign out and back in once online before sync resumes. Tell them.
14. **The morning after:** wake Render before opening, or run the `/api/time` pinger below, so the
    first sign-in of the day does not fall into an offline session.

## Rollback window

- **Until any counter has written to Neon:** unset `FROOZERP_CLOUD_FROZEN` on Railway, and do not
  publish the build.
- **After that:** rollback needs a reverse dump. Avoid it.
- Keep Railway **frozen, not deleted**, for about two weeks. Take a final `backup-cloud.mjs` copy,
  then remove the Railway service and its Postgres.
- In a follow-up, retire `railway.json`, `backend/railway.json`, and the Railway entries in
  `backend/deployImageContents.test.js` and `backend/renderBlueprint.test.js`.

---

## Living with the free plan

**Cold start.** Render free sleeps after about 15 minutes idle, and waking takes about 30–60 s
**(verify)**. The first request after a sleep fails soft: the cloud is marked unavailable, bills
queue locally, and nothing is lost. The real cost is at sign-in, where the first counter of the
morning usually gets an offline session with no cloud token.

- **Mitigation:** an external pinger on **`/api/time`** every ~10 minutes during shop hours. It is
  public and does not touch the database, so it keeps Render awake without keeping Neon awake.
  Render free has a monthly instance-hour allowance **(verify)**.
- Or open `https://<service>.onrender.com/api/health` before opening the shop.

**Health check.** `healthCheckPath` is `/api/health`, which runs a database query. If Render probes
it continuously while awake **(verify)**, Neon never scales to zero while Render is up. If Neon
compute hours become the constraint, `/api/time` is also a valid health path: the server only
listens after the database has been verified at startup.

**No disk.** Every deploy and restart starts from a clean filesystem. The server knows this
(`backupLocation.durable` is false) and does not write in-process backups. Back up with
`backup-cloud.mjs` from the shop (`CLOUD_BACKUP.md`) and rely on Neon's own history and branches.

**Logs** are kept for a short time on the free plan **(verify)**. The login incident id is only
findable while they last.

---

## Phase 2 code (the cut-over release)

**Done 2 Oct 2026, release 1.0.76**, after the Render rehearsal passed (a desktop bill synced to
Render + the Neon `rehearsal` branch; it also found and fixed the lot-scope sync bug, PR #29). Merging
it changes only the URL constants the next *build* carries; nothing reaches a counter until 1.0.76 is
published, which happens on cut-over night after step 11.

The code changes for the release itself, made only once Render + Neon is live and verified:

- The new URL goes into `src-tauri/src/lib.rs` `PRODUCTION_CLOUD_API_URL`,
  `frontend/src/local/cloudOrigins.js`, `backend/desktopGateway.js` `DEFAULT_CLOUD_API_URL`, and
  `backend/server.js` `defaultProductionCloudOrigin`.
- `https://froozerp-production-27bb.up.railway.app` is **added** to every legacy list:
  `mobile_gateway.rs` `LEGACY_CLOUD_API_URLS`, `desktopGateway.js` `LEGACY_CLOUD_API_URLS`,
  `cloudOrigins.js`, and `server.js` `legacyProductionCloudOrigins`. Keep
  `froozerp-production.up.railway.app` too.
- Extend the "never name the production host" test regexes to the new host.
- Add a test that a saved `27bb` `cloudApiUrl` is rewritten to the new URL on load.
- **Android:** rebuild the APK. Its cloud URL is fixed at compile time.

## LOCAL_ONLY invariants

None of this weakens them. The guard, the freeze, the CORS policy and the backup gating are all
server-side. The client changes in Phase 2 are URL constants and origin detection only.
`cloudCallGuard`, `guardCloudCall` and the gateway's fail-closed policy are untouched. Re-run the
LOCAL_ONLY audit tests after Phase 2.
