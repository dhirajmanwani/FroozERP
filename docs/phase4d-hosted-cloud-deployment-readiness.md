# Phase 4D Hosted Cloud Deployment Readiness

## Outcome

Phase 4D prepares FroozERP to be configured and inspected on a real hosted platform without requiring provider credentials in the repository. It does not deploy infrastructure, apply migrations, enable Android, or enable unfinished business-module sync.

`Cloud Connected` remains prohibited until the installed app reaches a real public HTTPS FroozERP API whose hosted PostgreSQL database and deployment-readiness checks pass.

## Target deployment

1. A managed host runs `backend/server.js` behind a public HTTPS URL.
2. A managed PostgreSQL service stores the authoritative cloud data.
3. Each company has an explicit `COMPANY_ID`.
4. Every device is registered and approved with a stable local `DEVICE_ID`.
5. Every device is assigned to one `BRANCH_ID`; optional sub-branch metadata remains migration-planned.
6. Installed apps use `VITE_CLOUD_API_URL` and `CLOUD_PRODUCTION` only after the hosted service passes readiness.
7. LAN modes continue to use the branch server and are never presented as cloud.

## Production environment

Backend host:

```dotenv
NODE_ENV=production
APP_VERSION=1.0.30
APP_MODE=CLOUD_PRODUCTION
FROOZERP_DEPLOYMENT_TYPE=cloud

CLOUD_API_URL=https://api.example.com
DATABASE_URL=postgresql://managed-provider-value
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true

COMPANY_ID=assigned-company-id
BRANCH_ID=assigned-default-branch-id
DEVICE_ID=
DEVICE_NAME=
FROOZERP_COMPANY_NAME=Company Name
FROOZERP_CLOUD_DEPLOYMENT_ID=provider-deployment-id

ALLOWED_ORIGINS=https://owner.example.com,tauri://localhost
```

`CLOUD_DATABASE_URL` can replace `DATABASE_URL`. Explicit `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` are supported when the provider does not supply a connection URL. Secrets must remain in the provider secret manager.

Installed app build/runtime:

```dotenv
VITE_API_MODE=CLOUD_PRODUCTION
VITE_CLOUD_API_URL=https://api.example.com
VITE_COMPANY_ID=assigned-company-id
VITE_BRANCH_ID=assigned-branch-id
VITE_DEVICE_ID=
VITE_DEVICE_NAME=
```

The local SQLite device identity remains authoritative when `VITE_DEVICE_ID` and `VITE_DEVICE_NAME` are blank.

## Strict cloud classification

A cloud URL must:

- use HTTPS;
- have a public hostname;
- not use localhost, loopback, `.local`, link-local, private IPv4 ranges, or private IPv6 ranges;
- not use port `5000`, which FroozERP reserves for local/LAN deployments.

Blank or invalid URLs remain `Cloud Not Configured`. A reachable LAN branch server remains `Local Branch Server`, not cloud.

## Read-only deployment endpoints

| Endpoint | Purpose | Writes data |
| --- | --- | --- |
| `GET /api/health` | API, version, database reachability, and cloud identity | No |
| `GET /api/version` | API/application version and configured deployment identity | No |
| `GET /api/cloud/readiness` | Public, non-secret deployment prerequisite checks | No |
| `GET /api/device/identity` | Authenticated approved-device identity | No |
| `GET /api/branch/status` | Authenticated branch/device connection summary | No |

`/api/device/identity` and `/api/branch/status` require `user_id`, `device_id`, and `branch_id`. They validate that the user is active and the device is approved for the requested branch.

`/api/cloud/readiness` reports booleans and blocker names only. It never returns database credentials or secret values. Deployment readiness requires:

- `NODE_ENV=production`;
- cloud deployment type;
- `APP_MODE=CLOUD_PRODUCTION`;
- a public HTTPS `CLOUD_API_URL`;
- explicit hosted database configuration and a successful database probe;
- company and branch IDs;
- cloud deployment ID;
- explicit non-wildcard allowed origins.

## Verification sequence

1. Deploy the backend without applying migration plans automatically.
2. Verify `GET /api/version` matches the installed app version.
3. Verify `GET /api/health` returns `database=reachable`, `deployment_type=cloud`, and the expected company identity.
4. Verify `GET /api/cloud/readiness` returns `readiness=deployment_ready`, `cloud_ready=true`, and no blockers.
5. Register and approve a test device through the existing controlled device flow.
6. Verify `/api/device/identity` returns the expected company, branch, user, role, and device.
7. Verify `/api/branch/status` reports the expected active branch and approved device count.
8. Configure one installed Windows app with the hosted URL and confirm Cloud status.
9. Test offline/online recovery and duplicate-operation handling before any production rollout.

## Still not implemented

Deployment readiness is not business-sync readiness. Purchases, field purchase entries, stock arrivals, full lots/stock, independent ledgers, general payments, expenses, waste, returns, settings, and permissions do not yet have complete offline-first bidirectional handlers.

Until those handlers and real multi-device tests pass, field devices and cross-branch business sync remain not production-ready.
