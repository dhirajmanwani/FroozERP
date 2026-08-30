# How stock reaches a shop

**Decided:** 2026-08-30, by the maintainer, describing how the business actually runs.

**Status:** ruled, not yet built. This file records the model and the reasoning so the build does not
re-argue it.

---

## The model, in the maintainer's own terms

> every shop / branch / sub branch will have different stock, and that abc staff cannot and must not
> pick from the other branch. now the process happens that a purchase manager purchases fruits. it
> gets to the warehouse, than warehouse manager transfers and distributes the fruits to the sub
> branches. and thn the sub branch which is for example ratanada has the stock 15, while the main
> branch has the stock 20, and abc is working in ratanada. he can only bill the stock and view the
> stock available in ratanada.

Four stages, and each one is a place where stock physically sits:

1. **Purchase.** A purchase manager buys in bulk from a supplier.
2. **Warehouse.** The goods arrive at one place, not at the shops.
3. **Distribution.** A warehouse manager sends quantities out — 15 kg of apples to Ratanada, 20 kg
   to Main Branch. This is a deliberate act by a person, not an automatic split.
4. **Sale.** A cashier at Ratanada bills against Ratanada's 15, and can see only Ratanada's 15.

## The rule that everything else serves

**A counter may sell only what is physically on its own shelf.**

This is not a software preference. The fruit is in one building. If a cashier at Ratanada can bill
against Main Branch's crate, then:

- Main Branch's shelf has less than its screen says, and nobody knows why;
- Ratanada's screen has less than its shelf, and nobody knows why;
- the printed bill carries the wrong shop's name and GST number.

The error is silent at the moment it happens and only surfaces days later as an unexplained
shortage. That is the same failure shape as the customer-order routing problem
(`docs/order-routing-decision.md`) and it is the reason both decisions exist.

## What follows from it

### Stock is scoped to where it sits, not to who is looking

Every quantity belongs to one place. The warehouse is a place. Each shop is a place. Moving stock
between them is an event that must be recorded, not a filter that can be switched off.

### Selling binds to the machine, viewing binds to the person

Settled in conversation on the same day, and it is the resolution of an apparent conflict.

The maintainer asked whether a staff member's shop should follow them to whatever laptop they use,
and whether a manager over several shops should see all of them. The answer is that these are two
different questions:

- **Selling, billing, and stock movement** bind to **the shop the machine is in.** The customer and
  the fruit are standing there; no login can change that.
- **Looking — reports, dashboards, order boards** binds to **the person's own shops.** A manager
  assigned to Ratanada and Main Branch may look at both.

This is already how the Owner works (`/api/owner/view-branch`, view-only, 30-minute session, with a
permanent banner naming the shop). Extending it to a multi-shop manager is a widening of an existing
mechanism rather than a new one.

`staff_location_assignments` already permits several rows per user — `UNIQUE (user_id,
operational_location_id)` — so the data model already allows a manager to hold several shops. What
does not exist is the app ever using more than one of them.

### A distribution is a transfer between two places, and both must be told

The same trap as customer-order transfer, for the same reason. `sync_change_log` rows are pulled only
when **both** `branch_id` and `operational_location_id` match the pulling device
(`backend/syncReferenceBootstrap.js`). So sending stock from the warehouse to Ratanada must announce
itself **twice**: once scoped to the warehouse, whose count went down, and once scoped to Ratanada,
whose count went up. A single row leaves one of the two places believing it still holds fruit it has
given away.

## Open questions, to be answered by the audit rather than assumed

- Whether stock is currently scoped by branch alone or by branch **and** operational location.
- Whether the existing `/lots/transfer-stock` route reaches devices at all.
- Whether a cashier's available-stock figure is already filtered to their own shop, or only appears
  to be because there is one shop today.

## Not decided here

- Whether a shop may return stock to the warehouse, and who may authorise it.
- Whether a distribution can be made in advance and accepted on arrival, or takes effect at once.
- What happens to a distribution sent to a shop that is offline at the time.
