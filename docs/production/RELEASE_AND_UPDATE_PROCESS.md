# Release And Update Process

## Version

Initial Windows production version:

```text
1.0.0
```

Bundle identifier:

```text
com.srtcompany.froozerp
```

Do not change the bundle identifier after release without a migration plan for local data and updater identity.

## Build Commands

There are two, and picking the wrong one is how a day gets lost.

**Putting a build on a machine — the everyday one:**

```powershell
npm.cmd run build:windows:local
```

An NSIS installer and nothing else. It needs no signing key, because it does not produce anything
for the update feed. The installer, and the app inside it, are the same build the release command
produces; only the `.zip` and `.sig` that a published update would need are absent. That is why the
maintainer can install a fix on the shop's own laptop without ever touching the release key, which
`CLAUDE.md` forbids using for exactly this.

**Publishing a release to the update feed:**

```powershell
npm.cmd run verify:windows
npm.cmd run build:windows
npm.cmd run release:windows
```

This one *does* require `TAURI_SIGNING_PRIVATE_KEY`, deliberately — an update with no signature is
an update nobody can install. It is what `.github/workflows/windows-updater-release.yml` runs.

`verify:update-safety` keeps the two apart: it fails if the release workflow or the release script
ever picks up the local flavour, and if the local overlay ever changes anything but that one flag.
Without those checks the failure would be silent — the main config would still say updater artifacts
are on, and every published release would carry no update.

Output:

```text
release/windows/FroozERP-Setup-1.0.0.exe
```

## Update Foundation

The application includes an owner/admin Software Updates panel in Settings. It shows:

- current version
- latest known version
- update status
- release title
- release notes
- published date
- last checked time
- download/install state
- update errors

The update feed is intentionally configurable:

```text
VITE_UPDATE_FEED_URL
window.__FROOZERP_UPDATE_FEED_URL__
```

No fake public update URL is hardcoded.

## Update Feed Contract

The local update foundation expects a hosted JSON feed with fields such as:

```json
{
  "version": "1.0.1",
  "title": "FroozERP 1.0.1",
  "notes": "Release notes",
  "published_at": "2026-06-16T00:00:00Z",
  "mandatory": false
}
```

Real end-to-end updates require hosted signed release artifacts and metadata. Until that release infrastructure exists, the app can check configured metadata but cannot safely install a production update.

## Pre-Update Safety Rules

Before installing updates:

- check local database health
- preserve the SQLite database
- preserve pending outbox operations
- preserve device identity and activation
- avoid updates while a transaction is being committed
- run local migrations transactionally after update
- record migration success/failure

## Milestone Rehearsal — run before every publish

**Ruled by the maintainer, 2026-08-27:** before any significant publish, the build is run once on a
disposable copy. Not ceremony. The updater installs in `quiet` mode against the `latest` release, so
a publish reaches every counter silently, with nobody clicking anything and no easy undo — the first
person to exercise a new release must not be a cashier mid-sale.

Automated gates prove the pieces. They run headless on Linux and never open a window, so the things
they can least vouch for are exactly the things a release changes most often: a schema migration
against a real database, sync between two machines, and whether a screen actually renders.

### Run it

```powershell
# Close the real app first. Copying a live SQLite file mid-write can capture a torn state.
$env:FROOZERP_DISPOSABLE_PROFILE = "rehearsal"
$env:FROOZERP_DISPOSABLE_SEED = "live"
npm run app:disposable
```

**Never `npm run app` for this.** That opens the real profile: `resolve_app_data_dir` redirects the
database only when `NODE_ENV=test` *and* an absolute `FROOZERP_ISOLATED_SQLITE_DIR` are both set,
and a plain dev run sets neither. On 2026-08-18 exactly that happened — the variables were set in
one terminal window and the run came from another — and migrations plus a grandfather entitlement
were written into live data. `app:disposable` sets them itself and refuses to start if the path
resolves anywhere near the real app-data directory. That is why it exists.

`FROOZERP_DISPOSABLE_SEED = "live"` copies the real database so the rehearsal meets real data, real
volume and real migration state — a fresh empty profile proves the app starts, not that the upgrade
survives what is actually on the machine.

Afterwards, clear the variables or close the window. They live as long as the terminal does, which
is the same per-window statefulness behind the 2026-08-18 incident:

```powershell
Remove-Item Env:FROOZERP_DISPOSABLE_PROFILE, Env:FROOZERP_DISPOSABLE_SEED
```

### What to check, every time

- The app opens, and opens **into the seeded data** — the shop's real products and customers, not an
  empty profile. If it looks empty, the seed did not take and the rehearsal is proving nothing.
- Sign in works.
- Billing: one sale, start to finish. This is the till; nothing ships if this is uncertain.
- Every screen the release touched, opened at least once.
- The terminal, read to the end for a migration failure or a panic. A migration that failed and was
  swallowed looks identical to one that worked, from the UI.

### What to check for *this* release specifically

Each release adds its own rows here, because the generic list above cannot know what changed.

**Orders across devices + orders in Report Center (2026-08-27):**

- Migration `022_customer_order_sync` applies to a **seeded** profile without error. It is
  forward-only and additive, but it has never met a real database.
- Orders written before this release are marked `blocked` with a readable reason, not left claiming
  to be queued. Making a status change on one should queue it and clear the block.
- A new order queues exactly one outbox row.
- Report Center → **Order Reports**: all four open. Reached without visiting the Orders screen
  first, they must show real figures — not zeros, and not a permanent "Reading this device's
  orders…".
- With no internet, the order reports still answer. They read local SQLite by design; if they go
  blank offline, that design has been broken.
- Two devices, if two are available: an order taken on one appears on the other after a sync. This
  is the release's whole point and the part with no automated coverage at all.

**Counters, stock scoping, distribution, order routing and other charges (1.0.71, 2026-09-02):**

This is a 92-commit release. The generic list above is not enough on its own, and the two things it
can least vouch for — a migration meeting a real database, and whether a screen renders — are most
of what changed.

*Before anything else*

- **Turn the laptop's internet off for the billing checks.** A disposable profile seeded from live
  carries the real device identity, so a test bill raised with the internet on syncs to the real
  cloud and lands in the shop's real books. Nothing in the app stops that, and a fabricated sale in
  the accounts is not undone by deleting a row. Sync is rehearsed separately, on a second machine.
- The installed shop app should still open **while the rehearsal is running**. Since 1.0.71 a debug
  build listens on 5051 and the installed app on 5000, so the two cannot fight. If the installed app
  refuses to start with a port or version message, that separation did not work and nothing else
  here matters.

*Migrations against a seeded profile*

- SQLite `023_customer_order_transfer` and `024_other_charges` apply without error. Both are
  forward-only and additive, and neither has met a real database.
- The terminal, read to the end. A migration that failed and was swallowed looks identical from the
  UI to one that worked.

*Counters and stock scoping — the core of the release*

- The topbar names the counter this machine is standing at.
- **Branches & Counters** opens as its own module and lists the counter created on 2026-09-02.
- The till shows **only its own shelf**. With stock at more than one place, a cashier must not be
  able to select a lot belonging to another branch. This is the release's whole point.
- Summary tiles and the table below them agree. A non-zero stock value beside `Products: 0` is a
  bug, not an empty result.

*Distribution*

- **Stock Distribution** opens. Send stock from one place to another: the sender's count goes down,
  the receiver's goes up, and the receiving lot carries the sender's cost.
- Receiving asks for quantities. "Receive in full" alone used to be refused by the server.
- One branch requests stock from another by product and quantity; the holding branch chooses which
  crates to send when it approves.

*Purchases and orders*

- Purchase Entry asks **where the goods were received** and honours the answer.
- An order with nobody handling it appears in the unassigned queue, and assigning it moves it.

*Other charges — new, and money*

- Settings → **Other Charges**: create a charge, name its unit, add slabs.
- POS: 12 km on a 10/15 km delivery charges the **15 km** rate. Four 10 kg crates is four times the
  10 kg rate, not one 4 kg crate.
- A measurement past the last slab shows a refusal naming both numbers — never a price, never zero.
- Taxable Amount and Mandi Tax are **unchanged** by any charge; only Net Payable moves.
- A bill carrying a charge can be edited, and the charge survives the edit.

*Appearance*

- Light, Dark and System all render. No unreadable text on either ground.
- The logo is not clipped and does not double.
- Keyboard shortcuts and the command palette open and navigate.

*And one thing to look for that has nothing to do with a feature*

- Technical details shows **no "⚠ Running from source" row** once the app has been installed to a
  folder of its own. On the maintainer's laptop today it will show one, because `F:\FroozERP` is
  both the install and the checkout. That warning disappearing is how the relocation is confirmed.

**Connection simplification and the cloud address (1.0.72, 2026-09-03):**

*What changed about the rehearsal itself — read this first*

A rehearsal runs `tauri dev`, which is a **debug** build, and a debug build now has **no cloud
address at all**. Three separate places make that true: `cloud_api_url()` in `src-tauri/src/lib.rs`
returns an empty string under `cfg!(debug_assertions)`; `BUILT_IN_DESKTOP_CLOUD_API_URL` in
`App.jsx` is empty unless `import.meta.env.DEV` is false; and a disposable profile's saved settings
start empty, so nothing supplies one from `localStorage` either.

Two consequences, and they pull in opposite directions:

- **The rehearsal is much safer than it was.** Previously the only thing standing between a test
  bill on a live-seeded profile and the shop's real books was remembering to switch the laptop's
  internet off. Now the build cannot reach a cloud even if somebody forgets. Switch it off anyway —
  it costs nothing and the belt is worth having alongside the braces.
- **The rehearsal can no longer prove cloud sync.** It never proved it well, but now it cannot prove
  it at all: the connection line will read "Working offline" throughout, correctly. Whether bills
  actually reach the cloud has to be established on a real installed build, which means it is not a
  precondition this rehearsal can satisfy. Say so plainly rather than letting a green rehearsal
  imply it.

  To rehearse against a cloud deliberately, set `FROOZERP_CLOUD_API_URL` — and then do **not** seed
  from live, because a seeded profile carries the shop's real device identity and would write
  real-looking rows into whatever it is pointed at.

*What to check*

- The connection banner reads **"Working offline — Billing works normally…"**, not "Local Only mode
  selected". Nothing anywhere offers a mode to pick.
- Settings → Sync & Connection → **Advanced Diagnostics**: no App Mode dropdown, no AUTO / LOCAL
  ONLY pair, no editable Cloud API URL, Branch Server or Custom API box, no "Save Mode" button.
- The addresses are still **shown** as disabled rows further down. Removing the questions was the
  point; losing the answers would replace one silent failure with another.
- With everything healthy and nothing queued, the banner shows **nothing at all**. That is
  deliberate — a permanent green tick is ignored within a week.
- Billing, start to finish, with the internet off. The whole claim is that this works unchanged.

*A note about `git pull` on the maintainer's laptop*

`F:\FroozERP` is both the checkout and the installed app, so a pull changes the shop's software —
but only partly. It replaces `backend/*.js`, which the installed app runs directly, so the gateway
changes on its next restart. It does **not** change the installed UI (`frontend/dist` is not
committed) or the Rust binary (not rebuilt). After a pull the real app therefore runs the new
gateway behind the old screens, which is harmless here but is worth knowing before reading anything
into what the installed app shows. Task #76 — moving the app out of the checkout — is what ends
this class of confusion.

**In-app device activation, and the first published release since July (1.0.73, 2026-09-15):**

*Read this first: this is not a one-feature release*

The in-app updater points at `releases/latest`, and the newest **published** GitHub release is
**v1.0.51, 14 July 2026**. Everything since — through 1.0.72 — reached the shop only because the
maintainer installed builds by hand. So whatever this release contains, what the updater will
actually deliver is "every change since the version each machine happens to be on", silently, in
`quiet` mode.

Before rehearsing, write down what each machine reports in Settings → Software Updates. If a
counter is on 1.0.72 this is a one-step update and the list below is the whole risk. If a counter
is still near 1.0.51 it is a two-month jump and the rehearsal must be seeded from **that** machine's
database, not from the newest one — an upgrade is only proven against the state it will actually
meet.

*What to check*

- Settings → Counter & Display → **Device Activation Licences** appears for the Owner, and does
  **not** appear for any other role. Check with a Cashier account, not by reasoning about it.
- The device list is the shop's real devices, by name. Nobody should have to type or read out an
  `FZDEV-...` id anywhere in this flow.
- Issue one licence for **30 days** against a device, and do **not** import the file anywhere.
  Issuing alone changes nothing on any machine — a licence is superseded only when the new file is
  imported on the device itself — so this is safe on a live shop. Check: the file saves, the
  history row appears with the right dates, and "Get File Again" returns the same file rather than
  issuing a second one.
- If the server has no signing key, the screen must say so in words and issue nothing. A screen
  that fails silently here would look identical to one that worked.
- Cloud side, before the rehearsal is even worth running: migration 017 applied, and
  `FROOZERP_ACTIVATION_SIGNING_KEY` set to **key id 2's** seed. Key id 1 never goes on a server.
- The window opens maximized with nothing cut off at the left, at 1366x768 and above.
- The greeting reads "Good to see you, Dhiraj", not "Good to see you, Mr.".

*Giving the rehearsal a cloud*

A debug build has no cloud address **unless it is given one** (see the 1.0.72 note above), so by
default the activation screen correctly reports that it cannot list devices, with "No cloud backend
is configured for this installation. Local modules remain available." That is not a limit of the
rehearsal, it is an unset variable.

The screen calls the *local* backend, and the desktop gateway proxies the call onward. The address
the gateway proxies to comes from `FROOZERP_CLOUD_API_URL` (or `CLOUD_API_URL`) read at runtime by
`cloud_api_url()` in `src-tauri/src/lib.rs`, so no rebuild is needed - it only has to be set in the
same terminal window that launches the app.

First make the copy the stand-in cloud will use. Pointing it at the live database would let a
disposable run - which is itself seeded from a copy of live - sync back into the real shop, which is
the one outcome a rehearsal must not produce. The repo's own scripts do this, and the order matters:
`restore-postgres.ps1` refuses a non-empty target, and `server.js` fills a database with empty tables
the moment it starts against it, so restore *before* starting anything.

The target database **must be named with a `_staging` suffix**. `CloudPostgresAdapter` refuses a
loopback PostgreSQL host outright, and the single exception it makes is a database whose name ends
in `_staging` while the isolated-tests flag is set. Any other name dies at startup with
"Cloud-server PostgreSQL cannot use a loopback host."

```powershell
powershell -File scripts\cloud\backup-postgres.ps1        # prints the .dump path it wrote
createdb -U postgres froozerp_staging
powershell -File scripts\cloud\restore-postgres.ps1 -DumpFile <that path> -Database froozerp_staging
```

Cloud migration 017 does not have to be applied by hand: `activation_licences` is declared in
`server.js`'s own startup bootstrap for exactly the local and self-hosted case, and
`verifyDeclaredSchema` refuses to start if the two ever drift.

**Since 2026-09-23 there is one command for both windows**, once the `_staging` copy exists:

```powershell
$env:PGPASSWORD = '<the postgres password, single quotes>'
npm run app:rehearsal
```

`scripts/run-rehearsal.mjs` sets every variable below itself, overriding anything already in the
shell (a `DATABASE_URL` left over from applying cloud migrations included), stops this checkout's
own leftover `server.js` on 5090 and Vite on 5173, **refuses to start if either port is still held**
-- a second `server.js` dies on EADDRINUSE and the old one keeps answering with old code -- prints
the commit it is running, removes `FROOZERP_DISPOSABLE_SEED`, and stops the stand-in cloud when the
app closes. Profile defaults to `rehearsal2` (`FROOZERP_REHEARSAL_PROFILE` to change it; the name,
never the `profile-` folder name). The session secret is generated once and kept in the disposable
root. The two windows below are what it does, kept for when something needs doing by hand.

```powershell
# window 1 - the stand-in cloud, pointed at the COPY, never live
$env:NODE_ENV = "test"
$env:FROOZERP_RUNTIME_MODE = "cloud-server"
$env:FROOZERP_ALLOW_LOOPBACK_POSTGRES_FOR_ISOLATED_TESTS = "true"
$env:FROOZERP_ALLOW_LOOPBACK_CLOUD_FOR_ISOLATED_TESTS = "true"
$env:DEVICE_SESSION_SECRET = "<32+ random characters, this rehearsal only>"
$env:PGPASSWORD = '<the postgres password, single quotes>'
$env:DATABASE_URL = "postgresql://postgres@127.0.0.1:5432/froozerp_staging"
$env:PORT = "5090"
$env:FROOZERP_ACTIVATION_SIGNING_KEY = "<key id 2 seed>"
node backend/server.js

# window 2 - the disposable app, told where its cloud is
$env:FROOZERP_CLOUD_API_URL = "http://127.0.0.1:5090"
$env:VITE_CLOUD_API_URL = "http://127.0.0.1:5090"
$env:VITE_ALLOW_LOOPBACK_CLOUD_FOR_ISOLATED_TESTS = "true"
npm run app:disposable
```

**All three of those are needed, and the two `VITE_` ones were missing from this page until
2026-09-21, when their absence cost a rehearsal an evening.** `FROOZERP_CLOUD_API_URL` is read by
the Rust shell and reaches the *gateway* only. The screen resolves its own `CLOUD_API_URL`
separately, in `App.jsx`, and `isRealCloudUrl` there rejects any loopback address outright -- the
guard that stops a shipped build from treating a machine on the LAN as the cloud. The single
exception is `ISOLATED_LOOPBACK_CLOUD_API_URL`, which requires a dev build (`npm run app:disposable`
runs `tauri dev`, so that part is already true) **and** `VITE_ALLOW_LOOPBACK_CLOUD_FOR_ISOLATED_TESTS`
**and** a loopback `VITE_CLOUD_API_URL`.

With only the gateway variable set, `(Invoke-RestMethod http://127.0.0.1:5051/api/health)
.cloud_api_configured` answers `True` and everything still fails, which is what makes this one
expensive to find. The screen's own view is the one that decides, and it is on the page:
**Settings -> Cloud API URL**. "Not configured" there means the two `VITE_` variables did not reach
Vite, whatever the gateway says.

What it costs when they are missing: `guardCloudCall("canonical-cloud-login", ...)` refuses with
`CLOUD_NOT_CONFIGURED` before any request is made, so `login()` never reaches its POST, falls
through to `continueOffline()`, and opens a perfectly working offline session. Nothing says the
cloud was skipped. Then FROST -- which is cloud-served on the desktop -- has no session token to
send and every one of its endpoints answers 401. The console tell is precise: filter it for
`login-` and an offline fall-through shows `login-local-readiness-N` with **no** `login-request`,
`login-success` or `login-failed` line after it.

Every variable in window 1 is load-bearing, and leaving one out fails at startup rather than
quietly:

- `FROOZERP_RUNTIME_MODE=cloud-server` is what makes `server.js` use PostgreSQL at all. Without it
  `resolveRuntimeMode` returns `desktop-local`, `DATABASE_URL` is ignored entirely and the process
  runs on embedded SQLite - which looks like it started fine.
- `FROOZERP_ALLOW_LOOPBACK_POSTGRES_FOR_ISOLATED_TESTS` plus the `_staging` name is the only way a
  loopback database is accepted (`storageAdapters.js`, `CloudPostgresAdapter`).
- `DEVICE_SESSION_SECRET` of at least 32 characters. A cloud-server runtime counts as exposed, so
  `sessionSecret.js` makes a borrowed key fatal rather than a warning, and the process exits.
- `NODE_ENV=test` gates both isolated-test flags.
- `FROOZERP_CLOUD_API_URL` in window 2, or the gateway has no target at all, plus the two `VITE_`
  variables above, or the screen has none. The gateway and the screen are told separately.

Keep the password out of `DATABASE_URL` and pass it as `PGPASSWORD`. node-postgres falls back to
`PGPASSWORD` when the connection string carries no password, and a password containing `@`, `:`,
`/`, `#` or `%` either mis-parses - the driver reports `28P01`, password authentication failed,
which reads like a wrong password rather than a mangled one - or throws `ERR_INVALID_URL` outright.
Both were reproduced on 2026-09-18 with the password `p@ss:w/rd#1`; the same password in
`PGPASSWORD` connects and the server starts.

Verified on 2026-09-18 by booting `server.js` against a local PostgreSQL 16 with exactly this set:
schema bootstrap completes, the server listens, and `GET /api/activation/licences` answers
`AUTH_SESSION_REQUIRED` rather than 404 or 500. Renaming the database to anything without the
`_staging` suffix reproduces the loopback refusal.

If the screen still refuses after this, read the message rather than assuming. "Local Only mode
selected" means the app's own kill switch is on, which is a different fact from having no cloud.
"No cloud backend is configured for this installation" on a run where the gateway reports
`cloud_api_configured: True` means the screen, not the gateway, is the one without a target - the
two `VITE_` variables above.

*What this rehearsal still cannot prove*

The stand-in cloud is not the real one. TLS, the deployed frontend, and anything that depends on the
hosted database's actual contents are still unproven by a rehearsal. Do not let a green rehearsal
imply that issuing works against production.

**FROST becomes the Owner's assistant, and speaks from a local model (1.0.74, 2026-09-21):**

*Read this first: two different machines, two different risks*

The maintainer's own laptop runs 1.0.73, installed by hand on 19 Sep, so for it this is a one-step
update and the list below is the whole risk. The counters are still near **v1.0.51, 14 July** — the
newest published release — so for them it is a two-month jump, and the rows for 1.0.71, 1.0.72 and
1.0.73 above all still apply. Seed the rehearsal from the **oldest** machine's database. This is
also the last release the counters need installed by hand; from 1.0.75 they update themselves.

*What to check*

- FROST opens for the **Owner** and is refused for everyone else. Check with a Cashier account and
  an Admin account, not by reasoning about it — Admin loses FROST in this release, deliberately,
  and it is reversible from the role-permissions screen.
- The greeting matches the clock. Open FROST in the morning and again in the evening, or change the
  machine's time, and the line should change with it.
- The suggested questions are a **dropdown**, not a grid of buttons, and picking one answers that
  question rather than returning a general briefing.
- **Settings → FROST Configuration → Provider lists five options**, not one. One option alone means
  the list did not load from the backend, and the note under the dropdown should say so rather than
  leaving a menu that looks complete. This is what 1.0.74 fixes; if it is still one option, the fix
  did not reach this build.
- **Stop the local server and open FROST.** The message must name *this machine's* server, not the
  cloud. Pointing at the cloud here sends the reader to the wrong machine.
- **Sign in with the cloud unreachable, then open FROST.** The app opens an offline session, which
  carries no cloud token, so FROST cannot work. It must say that it is an offline session and that
  signing in again needs the cloud reachable. It must not say the session expired, and it must not
  fire its eleven requests to find out — that combination, and the advice to sign in again, is what
  it did before 1.0.74 and what sent the 21 Sep rehearsal looking for a fault that was not there.
- Every figure FROST states must be checkable against the same figure in the ordinary reports. This
  is the release's one non-negotiable: the model phrases, the database answers.

*FROST needs the cloud, so most of the rows above cannot be checked without one*

Corrected 21 Sep 2026, after this list was first written. On a desktop install every FROST request
is forwarded to the cloud (`backend/server.js:647`; only the nine routes in `desktopLocalRoutes` are
served on the device), so with the cloud down FROST answers nothing and these rows neither pass nor
fail — they go unanswered. An earlier version of this section claimed the opposite and told the
rehearser that FROST "must work" in Local Only. It does not, and that instruction would have been
read as a release defect.

Either give the rehearsal a stand-in cloud, using the recipe in the 1.0.73 section above, or skip
the FROST rows and say in the rehearsal notes that they were skipped. Skipping them is the honest
outcome; recording them as passed because nothing visibly broke is not.

*With Ollama installed, if it is*

- With Ollama running and `llama3.2:3b` pulled, FROST's answers should read as sentences rather than
  `Period: Today. sales 48250`. The figures must still match the reports.
- **Stop Ollama and ask again.** FROST must still answer, in its plain wording, with a line saying
  the local model is not running. A blank panel or an error here is a bug.
- Type a non-loopback address into **Local Model Address** and save. It must be refused. That field
  is the one place a typo could send the shop's figures to another machine, and LOCAL_ONLY mode
  requires external connections to stay at zero.

*What this rehearsal cannot prove*

Nothing in this repository has ever talked to a real Ollama — the automated tests drive an injected
`fetch`. Whether a real Ollama accepts the request body, and whether a 3B model phrases well enough
to be worth keeping, are open until this rehearsal answers them.

### Only then

A rehearsal that found nothing is the precondition for **Signing And Publishing** below. A rehearsal
that found something is a bug report, and the version does not go out.

## Signing And Publishing

Only an authorised release process should publish FroozERP binaries. Ordinary staff must not upload installers or update artifacts.

Production requirements:

- code-sign the Windows installer
- sign updater artifacts
- publish checksums
- host update metadata on the approved production feed
- document rollback/recovery procedures

## Current Limitation

The Phase 3 installer is an unsigned internal-test installer. Real update installation was not tested because no hosted signed update feed exists yet.
