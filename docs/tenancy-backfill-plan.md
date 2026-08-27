# Tenancy backfill — the precondition for branch isolation

**Status:** written 2026-08-21. **Not executed. Requires the maintainer's explicit approval,** for
the reason the schema itself gives.

**Related:** `docs/branch-isolation-audit.md` (the failure this unblocks),
`docs/auth-hardening-plan.md` (A-7), `docs/backlog-1.0.72.md`.

---

## Why this document exists

A-7's remaining work is adding `company_id` / `branch_id` predicates to 37 read routes. I was about
to start. Then I read the migration that added those columns:

> `-- Add nullable shadow scope to current operational tables. Enforcement is enabled`
> `-- only after an owner-approved backfill and client rollout.`
> — `backend/migrations/cloud/009_operational_location_foundation.sql:321`

and, at the top of the same file:

> `-- This file creates no branch/location rows and performs no ownership backfill.`

**The columns are empty.** Adding `WHERE company_id = $1` to a route today makes it return nothing —
not an error, an empty screen, on every module at once. That is precisely the failure `CLAUDE.md`
names: *"Errors must never render as zero."*

Whoever wrote that migration knew, and left the warning. It is worth more than the code it sits in.

---

## What is actually empty, and what is not

This is the finding that changes the size of the job. **`branch_id` is not a shadow column on the
core business tables** — it is part of their original schema and has been written on every insert
since. Only `company_id` and `operational_location_id` arrived later and were never filled.

| Column | State | Consequence |
| --- | --- | --- |
| `branch_id` | **Populated** on `sales`, `purchases`, `inventory_batches`, `expenses`, `customer_payments`, `supplier_payments`, `waste_entries`, `sale_returns` — verified in the schema bootstrap | Branch-level scoping needs **no backfill** |
| `company_id` | **NULL everywhere.** Added by cloud migrations 005 and 009 as a nullable shadow column | Company-level scoping needs a backfill |
| `operational_location_id` | **NULL everywhere**, and depends on rows in `operational_locations` that this migration also did not create | Needs a location to exist *before* it can be filled |

### Why that matters

**Most of A-7's read scoping can proceed without any backfill at all.** A single-company business
does not need `company_id` to tell Jodhpur from Jaipur — `branch_id` already does, and it is
already there.

The backfill is required for company-level isolation, which matters when there is a second
*company*, not a second *branch*. That is a later problem than the one being solved.

**This roughly halves the risk of A-7 and removes the blocking dependency I thought existed.**

---

## The three phases, smallest first

### Phase 1 — scope by `branch_id` only (no backfill, no approval needed)

Add `branch_id = <session branch>` to the 37 routes, using the column that is already populated.
Verified route by route against `tenancyCoverage.test.js`, which counts what is left.

- **Risk: low.** The data is present, so no screen goes blank.
- **Blocked on: nothing.**
- **Delivers: branch isolation** — the thing multibranch actually needs.

**One caveat that must be checked per route, not assumed:** a row whose `branch_id` is NULL becomes
invisible the moment a predicate is added. `branch_id = $1` does not match NULL. Before each batch,
count the NULLs in that table (query below). Where any exist, either fix them first or write
`(branch_id = $1 OR branch_id IS NULL)` **temporarily**, with the exception recorded — a permanent
NULL-tolerant predicate is a permanent hole.

### Phase 2 — the `company_id` backfill (needs approval)

> **RULED 2026-08-22 by the maintainer: not needed, and therefore not scheduled.**
>
> The installation is one company - Frooz - with multiple branches, each holding multiple
> devices. Phase 2 exists to keep one company's data away from another's. With one company
> there is no second party to isolate from, so the backfill would be schema churn with a real
> risk (it has no natural undo) and no beneficiary.
>
> **What this does *not* excuse.** Multiple branches are real, so *branch* isolation is real,
> and that is Phase 1 - already done. Nothing below reduces that obligation.
>
> **The trigger to reopen this:** a second company, or any requirement to show one branch's
> staff a company-level figure that must exclude another company. Until one of those is true,
> this section is a plan, not a task.

Only once a second company is real, or company-level isolation is otherwise wanted.

On a single-company installation this is mechanical:

```sql
-- Establish there is exactly one company before assuming it.
SELECT id, company_name FROM companies;

-- Then, per table, and only where it is currently unset:
UPDATE sales SET company_id = :company WHERE company_id IS NULL;
```

**Why it still needs approval despite being mechanical:** it writes to every row of every business
table. If the premise ("there is one company, and everything belongs to it") is wrong, it is wrong
everywhere at once, and `company_id` was NULL so there is no prior value to restore. The
verification below exists to test the premise *before* relying on it.

### Phase 3 — `operational_location_id`

Last, and separate. It cannot be filled until `operational_locations` rows exist — the migration
created none, and the only writer is `scopeManagement.js:186`. Filling it means first deciding what
the operational locations *are*, which is a business question about how the shop is organised, not a
data question.

**Do not start this to "complete the set".** Nothing in A-7 needs it.

---

## Verification, before and after

Run before touching anything. These are reads; they change nothing.

```sql
-- 1. Is the single-company premise true?
SELECT COUNT(*) AS companies FROM companies;

-- 2. How many rows would a branch predicate hide? Any non-zero needs a decision, not a default.
SELECT 'sales' AS table_name, COUNT(*) AS null_branch FROM sales WHERE branch_id IS NULL
UNION ALL SELECT 'purchases', COUNT(*) FROM purchases WHERE branch_id IS NULL
UNION ALL SELECT 'inventory_batches', COUNT(*) FROM inventory_batches WHERE branch_id IS NULL
UNION ALL SELECT 'expenses', COUNT(*) FROM expenses WHERE branch_id IS NULL
UNION ALL SELECT 'customer_payments', COUNT(*) FROM customer_payments WHERE branch_id IS NULL
UNION ALL SELECT 'supplier_payments', COUNT(*) FROM supplier_payments WHERE branch_id IS NULL
UNION ALL SELECT 'waste_entries', COUNT(*) FROM waste_entries WHERE branch_id IS NULL
UNION ALL SELECT 'sale_returns', COUNT(*) FROM sale_returns WHERE branch_id IS NULL;

-- 3. Which branches actually appear in the data? More than one on a "single-branch"
--    business means an assumption somewhere is already wrong.
SELECT branch_id, COUNT(*) FROM sales GROUP BY branch_id ORDER BY branch_id;
```

**Row counts before and after each phase must match.** A backfill that changes how many rows exist
is not a backfill.

---

## Rollback

- **Phase 1** is code only. Revert the commit.
- **Phase 2** has no natural undo: `company_id` was NULL, so "restoring" means setting it back to
  NULL, which is only correct if the whole backfill was wrong. **Take a database backup
  immediately before, and restore a copy of it once to prove the backup works** — an untested
  backup is not a rollback plan. That test is already an open item in the A-6 checklist (5.2).
- **Phase 3** should not be attempted without a written decision about what the locations are.

---

## What I will not do without being told

- Run any `UPDATE` against business data.
- Assume a single company or a single branch because it looks that way from here. I cannot see the
  database; the queries above exist so the answer comes from it and not from me.
- Fill `operational_location_id` with an invented location.

---

## Recommendation

**Do Phase 1 and stop.** It needs no approval, no backfill and no downtime, it uses a column that
has always been populated, and it delivers the isolation multibranch actually requires.

Phases 2 and 3 are for a second *company* and a decision about *locations* — neither of which is
in front of the business today, and both of which get easier once Phase 1 has proved the pattern on
37 real routes.

The 3–4 week estimate in the audit assumed all three phases and a blocking backfill. **Phase 1
alone is materially smaller**, and it is the part that matters.

---

## Phase 1: done (2026-08-21)

Closed in five batches on branch `claude/offline-entitlement-migration-0nc0wl`. The number the
harness reports for unscoped GET routes went **37 → 26 → 16 → 3 → 2**.

| Batch | Area |
|---|---|
| 1 | transaction lists: `/sales`, `/purchases`, `/expenses`, `/waste-entries`, `/sale-returns`, `/contra-entries` |
| 2 | inventory and payments: `/inventory`, `/stock`, `/stock-inventory`, `/supplier-payments`, `/accounts/payments` |
| 3 | account balances, the balance sheet, the dashboards |
| 4 | products and lots, sales history, cash book, day book |
| 5 | the Report Center (`/reports/summary`, 27 queries) |

### The two routes still on the list, and why they cannot come off yet

`GET /accounts` and `GET /accounts/outstanding` scope both of their money halves already. What
keeps them on the baseline is one statement — `SELECT * FROM accounts` — and `accounts` has no
`branch_id`. It is company-wide master data, like `customers` and `suppliers`. **These two come off
the list in Phase 2, not before.** They were deliberately not fixed by removing `accounts` from
`TENANT_TABLES` in the harness: that would make the number fall without changing anything real.

> **Reassessed 2026-08-22, after the ruling above.** With exactly one company, an unscoped read of
> `accounts` returns that company's own accounts and nothing else. There is no second company's
> data in the table for it to leak, so these two are **correct as they stand**, not merely
> tolerated.
>
> They stay on the baseline anyway, and deliberately. The number is not a score to drive to zero;
> it is a list of places whose correctness depends on an assumption. The assumption here is "there
> is one company", and the day that stops being true these two must be the first things looked at.
> Removing them from the list would delete exactly the reminder that makes that possible.

### Business decisions, as confirmed by the maintainer on 2026-08-21

Phase 1 could not be finished without answering two questions. I answered both the
isolation-correct way and asked. **The first answer was wrong and has been reversed.**

1. ~~A supplier's or customer's outstanding balance is per branch.~~ **Corrected: these are
   *company* figures.** Stock is purchased from a supplier once, in bulk, into a warehouse branch,
   and is then transferred out to the shops beneath it. A per-shop supplier balance therefore parks
   the whole debt on the warehouse and reports zero at every shop that sells the goods. Customer
   balances follow the same rule, because a customer may settle at any counter.

   Implemented by `resolveMoneyScope` in `backend/server.js`, which makes every caller state which
   question it is asking. Company scope is expressed as
   `branch_id IN (SELECT id FROM branches WHERE company_id = $1)` — **not** as a `company_id`
   column on the money tables, because those are the empty shadow columns Phase 2 exists to fill.
   Going through `branches` needs no backfill at all.

   One guard matters here: `branches.company_id` is nullable and was never backfilled, and a NULL
   makes that subquery match nothing, turning every balance into a silent zero.
   `assertCompanyBranchLink` refuses the question loudly instead. **If Phase 2 ever runs, it must
   not break this link.**

   Summary and detail were moved together — `/supplier-ledger`, `/customer-ledger`,
   `/accounts/ledger`, `/accounts/payments`, `/supplier-payments` and `/pending-bills/customer` are
   all company-scoped. A balance whose backing list is filtered differently never reconciles.

   **The balance sheet and dashboard stay per shop**, by explicit decision: a shop's payables must
   sit against that shop's own cash or the sheet will not balance. The Supplier screen and the
   balance sheet will therefore disagree about "we owe suppliers". That is intended.
   `backend/moneyScope.test.js` pins the split.

2. **`/api/owner/dashboard-foundation` no longer accepts a branch from the caller.** It read
   `req.query.branch_id || 1`, so any authenticated user could name any branch — and an omitted
   parameter silently reported branch 1's takings. It now uses the session's branch and requires the
   `dashboard` permission. **If a genuine all-branches view is wanted, it needs its own route with
   an Owner check**, not a query parameter.

### What Phase 1 still does not prove

The harness records the SQL a route runs; there is no database here. It proves a query *mentions*
the branch. It does not prove the rows come back scoped, and it cannot distinguish scoping by the
session from scoping by a value the caller supplied. **That verification needs a live two-branch
database and is still open.** A second guard was added in `backend/queryArity.test.js` after batch 5
added a `$3` predicate to a query with no parameter array — a runtime failure that every existing
gate passed.

---

## Open, agreed with the maintainer on 2026-08-21

**An owner-only all-shops view.** Per-shop figures are the day-to-day view, so a whole-company
summary needs its own screen rather than a switch on the existing one. Not built yet. When it is,
it needs its own Owner check — not a branch parameter on an existing route, which is exactly the
hole that `/api/owner/dashboard-foundation` had.
