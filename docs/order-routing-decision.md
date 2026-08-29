# How an order finds its branch

**Decided:** 2026-08-27, by the maintainer, in response to the question *"if every order goes to
all the devices, won't it create confusion?"*

**Status:** ruled. The transport it depends on is being built now; the routing described here is the
layer above it and is **not yet implemented**. This file is the record of what was decided and why,
so the next stage does not re-litigate it.

---

## The question

Orders are being put on the same sync road that POS sales already travel. The maintainer asked
whether every device would then see every order, and proposed that orders should arrive at the main
branch and be transferable from there to whichever branch is nearer the customer.

## The part of the worry that was already handled

Orders would not have gone to every device. The pull visibility predicate
(`backend/syncReferenceBootstrap.js:7-15`) admits a non-reference entity type only when **both**
`branch_id` and `operational_location_id` match the pulling device:

```sql
company_id = $1
AND ( entity_type = ANY($4::TEXT[])          -- reference data: categories, products, rates, suppliers
      OR (branch_id = $2 AND operational_location_id = $3) )
```

So an order taken at one branch reaches that branch's counters and no others. That is the existing
behaviour, not something added for this.

## The part of the worry that was real

Nothing decided *which* branch an order belongs to. An order inherited the branch of the device that
typed it in, and there was no way to change it. Two situations therefore had no answer at all:

- an order arriving centrally — a website order, or a WhatsApp to the company number — with no
  branch attached;
- a customer who calls the main number but lives beside a different branch.

## What was decided

### 1. One field was doing two jobs

An order has two distinct branches, and conflating them is why it could not be moved:

- **where it was taken** — the branch that answered the phone. Provenance; never changes.
- **which branch is fulfilling it** — who packs it, whose stock is reserved, whose counters see it.

The **fulfilment branch** is authoritative for visibility and for stock reservation. Splitting the
two makes a transfer an ordinary field change that travels on the sync road already being built,
rather than a separate transfer mechanism with its own failure modes.

### 2. Only the fulfilling branch sees the order

Chosen over making every order visible company-wide. Two reasons: it matches the branch isolation
already built (A-7, `docs/branch-isolation-audit.md`), and an order carries a customer's name,
mobile number and delivery address — which has no business sitting on a device at a branch that is
not handling it. The Owner still sees across branches through the all-shops view, which is a
role-gated read rather than a copy on every device.

### 3. An unassigned order waits, and never lands on a counter

An order with no fulfilment branch is *unassigned*. It reserves nothing and no counter is
accountable for it until a person has decided who is handling it.

**This cannot be delivered through the sync pull road, and that is the important consequence.** The
pull predicate scopes by branch and location; it has no notion of role. A company-wide unassigned
order would therefore land on every device including cashier counters — the opposite of both
decisions above. So:

> **Unassigned orders live in the cloud only, read by an Owner/manager screen over the authenticated
> API. They enter the sync road at the moment they are assigned to a branch, and only then do they
> reach that branch's devices.**

No unassigned order is ever copied to a counter device.

## The trap this creates, which must be handled when it is built

When an order moves from branch A to branch B, A's devices have **already pulled it**. The
change-log row announcing the move is written scoped to B (`logSyncChange`, `server.js:8718-8760`,
scoped by the branch on the change). A's devices only pull rows matching A, so **they would never be
told it left** — and the order would sit on A's board as open work forever.

Two branches would then both believe they owe the same customer a delivery, which is precisely the
confusion the maintainer asked about. A transfer must therefore write **two** change-log rows: a
removal scoped to the old branch and an upsert scoped to the new one. A single row is a bug.

Stock reservation moves with it: A must release, B must reserve. That interacts with the open
question of whether a pulled order reserves stock on the receiving device at all — see the Rust
sync work.

## Not decided here

- The customer-facing consequence of a transfer (does the customer get told, and by whom).
- Whether an order may be split across branches. Assumed not; one order, one fulfilling branch.
- How "nearest branch" is determined. Assumed a human chooses, not a distance calculation.

---

# The build contract

**Added:** 2026-08-29. The ruling above is the *what*; this is the *how*, written before any code so
that the Postgres half, the SQLite half and the screen are built against one shape rather than three
guesses. Anything here that turns out wrong gets corrected **here first**, then in the code.

## The two branch fields

`customer_orders.branch_id` **keeps its name and becomes the fulfilment branch.** That choice is not
cosmetic: `logSyncChange` scopes every change row by `branchId`, and the pull predicate filters on
`branch_id`, so if fulfilment lives in that column then a transfer is an ordinary field change and
the transport needs no modification at all. Naming the new column `fulfilment_branch_id` instead
would mean teaching the whole sync road to scope by a different column — much more code, and every
line of it a chance to leak an order to a branch that should not see it.

Provenance moves to the new column:

| database | column | meaning |
| --- | --- | --- |
| Postgres `customer_orders` | `branch_id` (**becomes nullable**) | who is fulfilling it. `NULL` = unassigned. Authoritative for sync scoping and stock reservation. |
| Postgres `customer_orders` | `taken_at_branch_id` (new) | who answered the phone. Set once at creation, never changed by a transfer. |
| SQLite `local_customer_orders` | `branch_id` | same meaning as above (still INTEGER — see migration 022 on why it is not being rebuilt) |
| SQLite `local_customer_orders` | `taken_at_branch_id` (new, TEXT) | same meaning as above |

**Backfill:** `taken_at_branch_id := branch_id` on every existing row, both databases. Every order
in the tree today was typed in on a device at the branch that is handling it, so that is not a guess
— it is the true value.

**`branch_id` must lose `NOT NULL DEFAULT 1` in Postgres.** As it stands an unassigned order would
silently become branch 1's problem, which is the confusion this whole document exists to prevent. A
default that invents an answer is worse than a null that admits there isn't one.

## A transfer writes two change-log rows

The trap named above, as a rule the code must satisfy:

```
transfer(order, from: A, to: B):
  bump entity_version once  -> V
  logSyncChange(branchId: A, entity_version: V, operation_type: "TRANSFER_OUT")
  logSyncChange(branchId: B, entity_version: V, operation_type: "UPSERT")
```

Both rows carry **the same** `entity_version`. They must be written in the same Postgres transaction
as the `UPDATE`, so there is no window in which one exists without the other.

`TRANSFER_OUT` is a new operation type and it is **not** `DELETE`. The difference matters to a person
at branch A: "this order was cancelled" and "this order is now Ratanada's" are different facts, and a
counter that is told the wrong one will ring the wrong customer. It matters to the code too —
`apply_pulled_customer_order_with_tx` treats anything that is not `DELETE` as an upsert, so a
`TRANSFER_OUT` row that is not handled explicitly would **re-insert the order onto the very device it
is supposed to be leaving.** That is the single most likely way to build this wrong.

## What the losing device does with `TRANSFER_OUT`

Sets `deleted_at`, and also records **why**:

- `transferred_to_branch_id` — where it went
- `transferred_away_at` — when

`deleted_at` is what releases the stock: reservations are summed by `reservedQuantityByProduct` over
the orders the board loads, and the board loads `deleted_at IS NULL`. So the release is a consequence
of the existing rule rather than a second mechanism that could disagree with it. The two new columns
are what stop the order from appearing to have simply vanished.

## Unassigned orders

`branch_id IS NULL`. No `logSyncChange` call is made for them at all — which is not a special case
that has to be remembered, because `logSyncChange` already throws without a branch id. The existing
guard enforces the ruling for free.

They are read over the authenticated API by an Owner/manager screen, and they reach a device only at
the moment somebody assigns them. Assignment is a transfer whose "from" is nobody, so it writes
**one** row, not two: there is no old branch to tell.

## Order of work

1. **Both schemas and the transfer function**, with the two-row rule tested. Nothing else works until
   the field split exists.
2. The unassigned queue: API read + the Owner screen.
3. The Transfer control on the Orders board.

Stages 2 and 3 are screens over stage 1. Stage 1 is the one that is expensive to change later,
because it is the one written into two databases.
