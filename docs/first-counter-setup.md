# The first counter

**Written 2026-09-02.** One command, run once, on the machine that runs the backend. After it,
everything else happens inside the app.

---

## What a counter is

A counter is a place that holds stock and can sell it: a shop floor, a warehouse, a mandi counter.
It is what the app means by "where you are working". Your branch is the shop; the counter is the
till inside it. Main Branch and its warehouse can be the same building and still be two counters,
because the fruit in the warehouse has not been put on the shelf yet.

Every machine stands at exactly one counter. That is what stops a person at Ratanada selling fruit
that is sitting in Main Branch.

---

## Why this needs a command at all

The app can create counters — **Branches & Counters** in the module list does it, and records who
did it and when. What it cannot do is create the *first* one.

Permission to manage counters is read from the counter your machine is standing at. With no counter,
your machine is standing nowhere, so the app has no permission to check, so it refuses. Nothing is
broken; it is a chicken-and-egg. The first Owner account has exactly the same problem and is solved
the same way: from the server's own command line, where there is nothing for a stranger to reach
because nothing is listening.

---

## Before you run it

Two things must already be true.

**1. Your Owner account exists.** If it does not, `scripts/bootstrap-first-owner.mjs` makes it.

**2. The machine has opened the app once and been approved.** Open FroozERP on it and sign in. That
registers the machine. Approve it, then come back here.

You need that machine's **device id**. It is on the login screen, under *Show technical details*.

---

## The command

On the machine running the backend, with the same database settings it uses:

```
node scripts/bootstrap-first-counter.mjs \
  --branch 1 \
  --name "Main Branch Counter" \
  --code MB-COUNTER \
  --device-id <the device id from the login screen> \
  --username owner
```

Add `--dry-run` first if you want to see what it would do without it doing anything. It prints the
branch, the counter, the machine and the account, and writes nothing.

Add `--type WAREHOUSE` if this first place is a warehouse rather than a shop floor. A warehouse is
just a counter that receives and sends rather than sells.

Then **sign out and back in** on that machine. Your session is still carrying the old, empty scope
until you do.

---

## After that, use the app

Branches & Counters creates every counter after the first — Ratanada's till, the warehouse, a second
till at Main Branch — and posts machines and staff to them, with a record of who changed what.

The command will refuse to run a second time, and says so plainly. That is deliberate: two ways to
create counters means one of them has no audit trail.

---

## What it refuses, and what to do

| It says | What it means |
| --- | --- |
| *This company already has a counter* | The chicken-and-egg is over. Use Branches & Counters in the app. |
| *This database has no device "…"* | That machine has never opened the app. Open it, sign in, approve it, come back. |
| *Device … is PENDING, not APPROVED* | Approve the machine first. |
| *"…" is a Cashier, not the Owner* | Only the Owner can hold the first counter. |
| *Machine … is already posted to a counter* | A machine stands at one counter. Move it from the app, which records the move. |
| *Branch … has no company* | Fix the branch first — a counter under it could never sync. |
| *Nothing was written. …* | The database refused something. Nothing partial was left behind; the whole thing rolled back. |

That last one matters more than it looks. A counter written without its permissions would look set
up and behave as though it were not, which is worse than the plain refusal you started with. So it
is all or nothing.

---

## Seeing where you stand

At any point, this prints the whole picture — branches, counters, which machine is posted where,
who is posted where, and what the next step is:

```
node scripts/show-setup.mjs
```

It only reads. It is safe to point at the live shop database, and safe to run as often as you like.

Its `last seen` column is also the easiest way to spot machines that were approved once and have not
been used since. Any approved machine can still pull your data, so that list is worth going through
once the counters are in place.
