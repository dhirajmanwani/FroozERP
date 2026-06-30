# Phase 4E Production Cloud Deployment Checklist

## Release gate

Phase 4E is a deployment pack, not a cloud deployment. Do not change the installed app to `CLOUD_PRODUCTION` and do not show `Cloud Connected` until every hosted check below passes against a real public HTTPS API and hosted PostgreSQL.

## Owner inputs required

- Hosting provider/project and region
- Public API domain and TLS certificate
- Managed PostgreSQL `DATABASE_URL`
- Company ID and company name
- Initial/default branch ID
- Cloud deployment ID
- Exact allowed dashboard/browser origins
- Provider backup, retention, and point-in-time recovery policy
- Approved device ID, branch assignment, and verification user ID for each rollout device

Store all real credentials in the hosting provider secret manager. Never place them in Git, screenshots, diagnostics, chat logs, or installer files.

## Deployment files

- `backend/Dockerfile`
- `backend/.dockerignore`
- `backend/.env.production.example`
- `scripts/cloud/verify-hosted-cloud.mjs`
- `docs/phase4e-database-migration-runbook.md`

## Pre-deployment checklist

- [ ] Current branch is clean and pushed.
- [ ] Windows app version and backend `APP_VERSION` match.
- [ ] Local PostgreSQL and each device SQLite file have verified backups.
- [ ] Backup restore has been tested away from production.
- [ ] Pending, failed, and conflict sync queues are recorded.
- [ ] Hosted database is provisioned with encryption, backups, and restricted network access.
- [ ] Public API hostname resolves and HTTPS is valid.
- [ ] Public URL does not use localhost, loopback, LAN/private IP, `.local`, or port 5000.
- [ ] CORS origins are exact and do not use `*`.
- [ ] Startup schema bootstrap and reference seeding are disabled.
- [ ] Schema/data is restored or migrated explicitly before application startup.

## Build and start

Docker:

```powershell
docker build -f backend/Dockerfile -t froozerp-backend:1.0.30 backend
docker run --env-file backend/.env.production -p 8080:8080 froozerp-backend:1.0.30
```

Managed Node host:

```text
Root directory: backend
Install command: npm ci --omit=dev
Start command: npm start
Health path: /api/health
```

The host may inject `PORT`; `backend/server.js` binds to it. Local shop mode retains the existing local PostgreSQL fallback when `DATABASE_URL` is absent.

## Read-only verification

Full verification:

```powershell
$env:CLOUD_API_URL = "https://api.example.com"
$env:EXPECTED_APP_VERSION = "1.0.30"
$env:VERIFY_USER_ID = "approved-user-id"
$env:DEVICE_ID = "approved-device-id"
$env:BRANCH_ID = "assigned-branch-id"
npm.cmd run cloud:verify
```

Public deployment checks only:

```powershell
$env:CLOUD_API_URL = "https://api.example.com"
$env:VERIFY_PUBLIC_ONLY = "true"
npm.cmd run cloud:verify
```

The command performs GET requests only. It validates `/api/health`, `/api/version`, `/api/cloud/readiness`, `/api/device/identity`, and `/api/branch/status`. It never creates, updates, deletes, resets, or migrates data.

## Go-live gate

- [ ] `/api/health` reports FroozERP, matching version, reachable database, and cloud identity.
- [ ] `/api/version` matches the installed Windows app.
- [ ] `/api/cloud/readiness` reports `deployment_ready`, `cloud_ready=true`, and no blockers.
- [ ] `/api/device/identity` reports the approved device and correct branch.
- [ ] `/api/branch/status` reports the active branch and approved devices.
- [ ] Installed Windows app still shows local/LAN mode before cutover.
- [ ] One controlled device is configured for the hosted API.
- [ ] Wi-Fi/mobile internet switching and offline queue recovery are tested.
- [ ] Duplicate operations are rejected or acknowledged idempotently.
- [ ] Row counts and financial totals reconcile.

Deployment readiness does not enable full purchases, field purchases, payments, ledgers, expenses, waste, returns, settings, permissions, or bidirectional lot sync. Those modules remain blocked from production cloud rollout.
