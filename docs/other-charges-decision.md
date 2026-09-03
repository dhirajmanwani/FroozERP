# Other charges on a bill

**Settled 2026-09-02, in conversation with the maintainer.** Crate charge, labour charge, delivery
charge — and whatever the shop invents next.

---

## The shape

Nothing in the code knows what a crate or a kilometre is. The maintainer creates a charge, names it,
names its unit, and gives it either one flat rate or a list of slabs. "Crate", "labour" and
"delivery" are his examples, not categories in the software.

| Crate charge (kg) | | Delivery charge (km) | |
| --- | --- | --- | --- |
| up to 10 | ₹40 | up to 10 | ₹100 |
| up to 20 | ₹50 | up to 15 | ₹150 |

**Quantity and measurement are different numbers.** Four 10 kg crates is 4 × ₹40, not one 4 kg
crate. Conflating them under-charges by exactly the amount that matters.

---

## His three rulings

**1. A charge is kept, not owed back.** Money taken for a crate is the shop's. Nothing is returned
when the crate comes back.

He was offered the alternative — a deposit, tracked per customer until the crate returns — and chose
against it. If that ever changes it is a liability ledger, which is a different feature rather than
a bigger version of this one.

**2. Mandi Tax does not apply to charges.** Tax is on fruit. Charges land after tax and never enter
`taxable_amount`. Routing them through it would raise the shop's tax on money it never collected tax
on, on every bill carrying a delivery.

**3. A slab rounds up.** 12 km costs ₹150, because 12 km is past what ₹100 was meant to cover.

---

## Charges are revenue, not profit

**Settled the same day.** A ₹500 bill with a ₹150 delivery is a ₹650 bill in the sales figures, and
its profit is what it would have been without the delivery.

The reasoning is his: a delivery has its own cost — fuel, a person, time — that the software does
not know. Counting the whole ₹150 as profit would make every delivered bill look better than it was,
silently and flatteringly, and the error would compound across a month of reports.

`profit = netBeforeCharges − totalCost`. Revenue reads `total_amount` and so does include charges.
The asymmetry is deliberate. **Do not "fix" it without asking him.**

---

## The rule that is not his, and why

**A measurement past the last slab has no price, and says so.**

With rates written up to 15 km, a 40 km delivery is refused by name: *"Delivery charge has rates up
to 15 km, and this is 40. Add a slab, or enter the amount by hand."* It is never priced at the top
slab, and never at zero.

Charging ₹150 for 40 km loses money on precisely the trips that cost most, silently, on every bill,
until somebody happens to notice. `Products: 0` beside a non-zero stock value is a bug rather than
an empty result, and `Delivery: ₹150` for a distance nobody priced is the same failure with the
decimal point moved.

A hand-typed amount is allowed, is stamped `manual`, and requires the same permission as typing a
sale rate the price list did not produce.

---

## What it refuses, and where

| Where | What is refused | Why |
| --- | --- | --- |
| Pricing | A measurement past the last slab | Nobody wrote that price |
| Pricing | A rate that was never set | `NULL` is "unpriced", not "free" — a rate of **0** is a real rate |
| Server | A bill with one unpriceable line — the whole bill | The cashier has a screen to read refusals on; the server does not, and half-pricing writes a bill quietly short |
| Server | A client-supplied rate or amount | A client-supplied price is a client-supplied discount; every line is re-priced from the stored slabs |
| Device | A sale whose charge lines and stated total disagree | Reconciling would pick a winner nobody chose |
| Device | An edit that says nothing about charges, on a bill that has them | Silence is not "there are none" — treating it as such deletes collected money |

---

## Known limitations, recorded rather than hidden

- ~~A bill carrying charges cannot be edited.~~ **Fixed 2026-09-02.** Both edit paths now hand the
  charges to `buildSalePayload`, which re-prices them from the stored slabs, and both write the
  result back. An edit shows what the shop would charge *today*, so if a rate has moved since the
  bill was raised, the difference is visible on screen before it is saved rather than discovered on
  the reprint. A hand-typed amount is carried through as typed — it was typed because no rate
  covered it, and re-deriving it would only refuse again.

  One refusal remains, deliberately: an edit that says **nothing at all** about charges, on a bill
  that has them, is refused (`SALE_CHARGES_NOT_SUPPLIED` online, a CONFLICT on the sync path).
  Silence is not "there are none" — it means the app sending it predates the feature, and reading
  it as an empty list would delete collected money on every edit that device ever pushes. An
  up-to-date app always sends the key, empty list included; sending `[]` is how a cashier removes
  the last charge.
- **The flat sales-history export does not carry `other_charges_amount`.** Any report summing those
  rows is short by charges. Already true of `tax_amount`, so consistent, but wrong in the same way.
- **Charge types cannot be created offline.** They arrive from the cloud. Editing a price list is an
  Owner action at a desk, not a counter action, so this has not been treated as urgent.
