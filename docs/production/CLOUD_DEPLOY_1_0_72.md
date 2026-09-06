# Deploying the cloud from 1.0.64

Written on 2026-09-05, while working out why the shop's app could never reach its cloud. It is
specific to this one deploy, because this one is unusual: `main` is 103 commits behind, the gap
contains the whole auth-hardening track, and Railway deploys `main` automatically the moment it
changes. There is no staging step between the merge and every counter.

Ordinary releases do not need a document. This one does.

---

## What this deploy actually changes

| | Before (1.0.64) | After |
|---|---|---|
| Passwords | old formats still authenticate | **scrypt only** — anything else is refused |
| Requests | most routes unauthenticated | **default-deny**, signed session tokens |
| Old app builds | work | refused with `CLIENT_UPGRADE_REQUIRED` |
| Charge types | route does not exist | works |
| Session signing key | borrowed from a database credential | **must be dedicated, or the server will not start** |

The last row is the one that can take the shop offline, and it is checkable in advance.

---

## Before you merge anything

### 1. The Owner password — done 2026-09-05

`show-setup.mjs` reported `owner … NEEDS RESET`, meaning the only account on the system would have
been unable to sign in the moment this deploy landed. It was reset to scrypt while 1.0.64 was still
live, which is the safe order: the deployed backend accepts both formats, the new one accepts only
scrypt, so resetting first leaves no window where nobody can sign in.

Re-check with `node scripts/show-setup.mjs` if any account is added before the merge.

### 2. `DEVICE_SESSION_SECRET` on Railway — **the thing that failed**

`backend/sessionSecret.js` refuses to start a *cloud* deployment whose signing key is missing, too
short (under 32 characters), or borrowed from a database credential, and `server.js` calls
`process.exit(1)` on that verdict. Refusing to boot is right — a server running with a forgeable
signing key is worse than one that is down, because nobody finds out — but a process that exits at
startup fails Railway's health check, and Railway then keeps the previous deployment. Which is
exactly what happened on 2026-09-05.

**A correction, recorded because the reasoning was wrong and the wrong reasoning was written here
first.** This section previously claimed the variable was already set, on the grounds that the live
service runs the same check and answers `/api/health` at all. That inference does not hold:
`sessionSecret.js` landed on **2026-08-20**, and the live service runs code from **2026-07-12**. The
check it was supposed to be proving did not exist in the code that was answering. A deployed
artifact only demonstrates the behaviour of *the code it is running*, and here that was code a month
older than the rule being tested.

On Railway, open the service that serves the shop's data → **Variables**, and confirm
`DEVICE_SESSION_SECRET` exists and is at least 32 characters. If it does not:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Add it as a variable, then redeploy. Do not paste it into a chat, a file, or a commit; it is worth
as much as the database password, and for a different reason.

Setting or changing it invalidates every session token, so everyone signs in again. That is expected
here — there are no sessions worth keeping across this deploy.

### 2a. There are two services, and only one has the shop's data

`froozerp-production.up.railway.app` and `froozerp-production-27bb.up.railway.app` are different
deployments. The first took the new code happily and reports `tenant_configured: false` — its
database has no company row, so it is not the shop's. The second is the one the app talks to, the one
holding SRT Company, and the one that must actually receive this release.

`App.jsx` maps the first to the second in `LEGACY_CLOUD_API_URLS`, so the naming is already known to
be a trap. Deploying the wrong one succeeds and changes nothing, which is the most expensive kind of
success.

### 3. Your own unpushed work

`git status` reported the branch ahead of `origin` by 12 commits, including the Frooz logo. Push
before merging, or the deploy carries a different tree than the one that was tested:

```powershell
git push
```

---

## The merge

Railway deploys `main` on change, so merging **is** the deploy. Do it when the shop is closed or
quiet, with an hour free and the laptop to hand.

```powershell
git checkout main
git pull
git merge claude/offline-entitlement-migration-0nc0wl
git push
```

Then watch Railway's deploy log for the backend service. What you are looking for:

- **`[auth] SESSION_SECRET_…`** followed by the service restarting over and over — step 2 was
  missed. Add the variable; it will recover on the next deploy.
- **A database error during startup** — the schema bootstrap could not run. Do not retry blindly;
  read the message.
- **Nothing alarming, service healthy** — go to the checks below.

### Rolling back

Railway can redeploy an earlier commit from its deploy history. The schema changes are additive
(`ADD COLUMN IF NOT EXISTS`), so an older backend runs against the newer schema without complaint.
The one thing a rollback does *not* undo is the Owner password reset — which is fine, because
1.0.64 accepts scrypt too. That is the whole reason for doing it first.

---

## After the deploy

```powershell
curl.exe https://froozerp-production-27bb.up.railway.app/api/health
```

`"version"` should no longer read `1.0.64`, and `"database"` should read `reachable`.

```powershell
$env:DATABASE_PUBLIC_URL = "<paste>"
node scripts/show-setup.mjs
Remove-Item Env:DATABASE_PUBLIC_URL
```

The SIGN-IN section should still show `owner … ok`.

**Do not try the app yet.** Until it is rebuilt it is an old client, and the new cloud refuses old
clients by design — `CLIENT_UPGRADE_REQUIRED` is the system working, not a fault.

---

## What happens to the shop in between

Billing does not stop. The app is local-first: sales are written to this computer's SQLite and
queued in `sync_outbox`, and the queue drains once the app can talk to the cloud again. So between
the deploy and the app update, the shop keeps selling and the bills wait. Nothing is lost by the
gap; it just gets longer the longer the gap lasts.

What does *not* work in that window is anything that needs the cloud while it is running: sync,
cloud reports, and adding a charge type.

---

## Then, and only then: the app

The cloud has to be new **before** the app is, or the app reaches a cloud that has never heard of
charge types and the fix looks like it failed.

Build and install the app, and then the charges checks that the rehearsal could not do — a
rehearsal build deliberately has no cloud, so creating a charge type is one of the few things it
cannot prove. See `RELEASE_AND_UPDATE_PROCESS.md`.
