# Running the cloud migrations

**Written 2026-09-02.** These are changes to the shape of your live shop database — new columns,
new rules, new triggers. They are forward-only: once applied, they are not undone by running
something else. So the order below is the order.

---

## Before you start

**Do it when the shop is closed.** Some of these take a brief exclusive lock on a table. If a
counter is syncing at that moment, one of the two waits, and if the app is busy enough it can
fail. Nothing is corrupted by that — it rolls back — but you would rather not find out at 11am.

**Take a backup.** On Railway: your Postgres service, then **Backups**, then create one. Wait for
it to finish before going further. Nothing below is expected to need it. That is not the same as
not needing it.

**Have this branch's code on the laptop you are running from:**

```
git pull
npm --prefix backend install
```

The runner borrows the backend's PostgreSQL driver, so the second line matters even though you are
not starting the backend.

---

## Get the connection string

On Railway, open your Postgres service, then **Variables**. You want `DATABASE_PUBLIC_URL` — the
public one, because you are connecting from your laptop, not from inside Railway.

Copy it. Do not paste it into a file, a chat, or a commit. It is the whole database in one line.

---

## Step 1 — the dry run

```powershell
$env:DATABASE_PUBLIC_URL = "<paste it here>"
node scripts/run-cloud-migrations.js
```

This is not a simulation. It opens a transaction, **actually runs every migration against your real
database**, and then rolls the whole thing back. PostgreSQL can undo schema changes inside a
transaction, which is why this is worth doing: if a migration is going to fail on your data, it
fails here, having changed nothing.

You should see one line per migration and then:

```
validated backend/migrations/cloud/005_multibranch_identity_foundation.sql
...
validated backend/migrations/cloud/013_transfer_request_without_lot.sql
cloud migration dry run rolled back
```

**If any line is an error, stop and send it to me.** Nothing has been changed. Do not run step 2.

---

## Step 2 — apply

Same command, one word longer:

```powershell
node scripts/run-cloud-migrations.js --apply
```

Last line should be:

```
cloud migrations committed
```

That is the whole thing. It is all one transaction, so there is no half-applied state to clean up:
either every migration went in, or none did.

---

## Why it re-runs everything, every time

The runner has no memory of what it has already applied. It replays the whole list on every run.

That is deliberate, and it is what makes the dry run meaningful — it can only tell you the truth if
it really executes everything. It works because every migration is written to be safe to apply
twice: `ADD COLUMN IF NOT EXISTS`, `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`, and constraint
additions wrapped in a check for whether the constraint is already there.

`backend/cloudMigrationCoverage.test.js` fails if a new migration is written that would not survive
a second run.

---

## What decides which files run

`scripts/run-cloud-migrations.js` names them one at a time. It does not scan the folder — a folder
scan would apply whatever happened to be sitting there.

The cost of naming them is that a new migration can be written and forgotten. **This has happened.**
011 was committed and left out of the list, and 011 is the only thing that publishes a stock change
to a counter. Nothing errored. Fruit would simply not have arrived.

So there is now a test: every `.sql` file in `backend/migrations/cloud/` must either be in the
runner's list, or in its `deliberatelyNotRun` list with a reason. Four files are excluded on
purpose:

| File | Why it is not run here |
| --- | --- |
| 002, 003, 004 | the backend creates these itself when it starts up |
| 007 | its own header says *"Migration plan only. Do not apply automatically."* |

If someone adds a migration and forgets the list, `npm --prefix backend test` fails and names it.

---

## After the migrations

The counters come next — see `docs/first-counter-setup.md`. Keep the same PowerShell window: every
command in this repo that talks to the cloud reads `DATABASE_PUBLIC_URL` as well as `DATABASE_URL`,
so what you set above carries straight over.
