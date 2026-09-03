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

```powershell
npm.cmd run verify:windows
npm.cmd run build:windows
npm.cmd run release:windows
```

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
