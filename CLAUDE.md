# FroozERP

Local-first fruit/produce retail ERP. React + Vite frontend in a Tauri 2 desktop shell,
Node/Express backend, PostgreSQL server-side, SQLite locally on each device.
Windows is the only shipped target. Single maintainer.

## Commands

Run from the repo root unless noted.

```powershell
npm --prefix frontend run dev          # frontend dev server (5173)
npm run app                            # Tauri desktop app in dev mode
node backend/server.js                 # backend on 5000

npm --prefix frontend run lint         # eslint (add --no-cache if it misbehaves)
npm run build                          # production frontend build
npm run backend:check                  # node --check backend/server.js
npm --prefix backend test              # backend node:test suites
node --test frontend/src/local/*.test.mjs   # frontend local-module suites
cargo check --manifest-path src-tauri/Cargo.toml

npm run verify:disposable-matrix       # acceptance matrix
npm run verify:update-safety           # updater safety
npm run verify:production              # production static regressions
npm run build:windows                  # NSIS bundle (unsigned unless keys are set)
```

Always run lint, build, `backend:check`, both test suites and `cargo check` before
proposing a release commit.

## Hard boundaries

These are release-safety rules, not preferences. Do not cross them without being asked
explicitly, in the current conversation, by the maintainer:

- **Never contact production or Railway.** No pushes, deploys, or publishes.
- **Never request or use the signing password.** RCs are built unsigned.
- **Never modify updater metadata** or anything under `release/`.
- **Never touch `F:\FroozERP_recovery_backups\`.** It is preserved failure evidence.
- **Never install or launch the packaged app on the real laptop** during source work.
  Use disposable copies of databases, profiles and app state.
- **Never fabricate, delete or reassign business data to make a test pass.**
- LOCAL_ONLY mode must keep `blocked=true`, `reachedCloud=false`, cloud-router
  invocations at 0, and external connections at 0. Any change that could weaken this
  needs to be called out loudly.

## Architecture

- `backend/server.js` — ~19.7k lines, single file. Routes, schema bootstrap, migrations,
  business math and reporting queries all interleaved. Splitting it is planned, not done.
- `frontend/src/App.jsx` — ~17.7k lines, single file, every module view.
- `frontend/src/local/*.js` — the local-first layer (sync, snapshots, offline session,
  stock inventory, connectivity policy). Each has a matching `*.test.mjs` run by
  `node --test`. **New logic belongs here, not in App.jsx**, because only this layer is
  practically testable.
- `src-tauri/src/local_db.rs` — ~265k, owns the SQLite schema and builds the reference
  snapshot the frontend reads. If a field looks wrong in the UI, check the snapshot
  query here before suspecting the frontend.
- `src-tauri/migrations/sqlite/NNN_*.sql` — forward-only, applied once, must be
  idempotent across restarts.
- Postgres schema is still bootstrapped at backend startup via
  `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, not a
  versioned migration system. Adding a column means editing that startup path.

## Pitfalls that have already bitten

- **Canonical IDs.** Entity IDs are opaque strings. Always compare and group with
  `canonicalInventoryId` / `inventoryIdsEqual` from `local/stockInventory.js`. Never
  `String(id)` on one side of a join and `canonicalInventoryId(id)` on the other, and
  never coerce IDs with `Number()` — `"004"` and `4` are different entities. A mismatch
  here silently emptied the Inventory table while every summary tile stayed correct.
- **Summary vs detail must share filter semantics.** If a panel's totals come from one
  collection and its table from another, they will eventually disagree and the disagreement
  will look like data loss. Derive both from the same filtered source.
- **Errors must never render as zero.** A failed load, a contract violation or an internal
  inconsistency has to produce a distinct error state. `Products: 0` next to a non-zero
  stock value is a bug, not an empty result. See `resolveInventoryPresentation`.
- **`??` does not fall through on `0`.** Several lot fields are legitimately zero. Use
  explicit `Number.isFinite` checks when picking between two numeric fields.
- **The Rust snapshot emits aliases.** `remaining_qty` and `balance_qty`, and
  `purchase_rate` and `effective_cost_per_unit`, are each emitted from a single column.
  Don't assume they can diverge, and don't "fix" one without checking `local_db.rs`.
- **Report Center defaults to a `today` range.** `resolveReportDateRange` returns
  today→today when no range is set, and the custom date inputs only bind when
  `range === "custom"`, so an effective filter can be active while the inputs look empty.
  Any effective filter must be visible to the user.

## Known security debt

Authorization currently trusts a client-supplied identity: `/login` issues no session
token, and the frontend sends `x-user-id` on subsequent requests which the backend accepts
at face value. Most routes have no auth middleware. Anyone who can reach the API can assert
any user ID, including Owner. Passwords are unsalted SHA-256 with a plaintext-equality
fallback in `passwordMatches`, and `/login` has no failed-attempt lockout despite a
`locked_until` column existing.

Do not treat this as fixed. If you touch auth, the direction is: real signed sessions
verified by middleware on every route, bcrypt/argon2id hashing, and removal of the
plaintext fallback. Flag it rather than working around it.

## Conventions

- Test new local-layer logic with `node:test` in `frontend/src/local/*.test.mjs`.
  Several suites assert against `App.jsx` source text — if you change App.jsx structure,
  run the whole local suite, not just the file you think you touched.
- Keep migrations idempotent and forward-only. Never edit an applied migration.
- Prefer editing `frontend/src/local/` over growing `App.jsx` or `server.js`.
- Currency is INR; quantities carry 3 decimals; money rounds to 2.

## Delegation (standing instruction)

Multi-part work is delegated to subagents by default rather than done serially in one
thread. This applies to all future jobs in this repo unless the maintainer says otherwise.

How to split:

- **Parallelise by disjoint file area**, never by "half a feature". A Rust/`src-tauri`
  task and a `frontend/src/local` task can run at once; two agents editing `App.jsx`
  cannot.
- **Agents must not run `git` commands.** Concurrent agents race on `.git/index.lock`.
  The lead reviews every diff and makes all commits.
- **Read-only audit agents are cheap and worth it** — use one to produce a line-numbered
  change plan before an agent edits a 17k-line file.
- **The lead re-runs every gate after integration.** An agent reporting "tests pass" is
  evidence, not proof; the gates are only green when the lead has seen them green on the
  integrated tree.
- Trivial single-file edits stay in the lead thread. Delegation is for breadth, not for
  avoiding work.

Every agent brief must carry the hard boundaries above verbatim — a cold agent does not
know them, and the boundaries are release-safety rules, not preferences.
