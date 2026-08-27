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
