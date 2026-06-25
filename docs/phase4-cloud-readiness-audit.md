# FroozERP Phase 4 Cloud Readiness Audit

Date: 2026-06-25

## Current Stable Baseline

- Installed Windows app version: 1.0.25
- Current backend API base in installed app: `http://127.0.0.1:5000`
- Local SQLite file: `C:\Users\DellPc\AppData\Roaming\com.srtcompany.froozerp\froozerp-local.sqlite3`
- Local SQLite file size before Phase 4 changes: 364544 bytes
- Installed app login smoke test: passed
- POS Billing smoke test: passed
- PDF preview/save/system viewer fix: previously verified and checkpointed
- Pre-Phase 4 checkpoint commit: `95b7f01`

## APIs Already Cloud-Ready or Partially Ready

- `POST /login`
- `GET /api/health`
- `POST /api/sync/register-device`
- `POST /api/sync/push`
- `GET /api/sync/pull`
- `GET /api/sync/status`
- `GET /settings/system-info`
- `GET /settings/sync-status`
- `PUT /settings/sync-status`
- `GET /dashboard-metrics`
- `GET /reports/summary`
- Product, lot, sales, purchase, payment and report APIs use PostgreSQL through the shared pool.

## Gaps Found

- Root `/health` returned 404 before Phase 4; production load balancers commonly expect it.
- `/api/version` was missing.
- Frontend used a single `VITE_API_URL`/fallback API base instead of explicit local/cloud/custom modes.
- Cloud PostgreSQL migration was not documented as a repeatable checklist.
- Owner remote tracking did not have a dedicated cloud freshness endpoint.
- Sync is foundation-grade, not full business-complete sync:
  - Idempotency table exists.
  - Local outbox exists.
  - Push/pull endpoints exist.
  - Business conflict handling remains limited and must be expanded before Android/mobile production.

## APIs Requiring Production Hardening

- `POST /login`: needs HTTPS-only deployment, stronger token/session strategy, rate limits and audit review.
- `/settings/*`: must enforce Owner/Admin permissions consistently in cloud mode.
- `/api/sync/*`: must enforce authenticated user session plus approved device identity.
- `/sales`, `/purchases`, `/products`, `/reports/*`: require branch/device enforcement before multi-branch cloud use.
- `/api/owner/dashboard-foundation`: foundation endpoint only; should later be protected by Owner role middleware.

## Production Environment Needs

- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT=5000` or cloud platform assigned port
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`
- `CORS_ORIGINS` containing the production app/web origins
- HTTPS termination at load balancer/reverse proxy
- Secret storage outside repository

## Current Phase 4 Scope Boundary

This phase starts cloud foundation only. Android/iOS packaging, mobile UI and native mobile sync must wait until the Windows cloud foundation passes installed-app online/offline and sync tests.
