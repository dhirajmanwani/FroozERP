# The Frooz website — design direction

**Written 2026-08-21, at the maintainer's request, before any of it is built.** The site itself is
gated: a public site taking real orders means the backend is reachable from the internet, and
`docs/auth-hardening-plan.md` §A-6 still says **DO NOT EXPOSE**. This exists so the design is a
decision taken in advance rather than whatever gets typed on the day the gate opens.

---

## 1. The theme is already decided, and it is better than the obvious one

Read out of `frontend/src/App.css` and `index.css` rather than invented:

| Role | Value | Where it earns its place |
| --- | --- | --- |
| Ground | `#0f172a` → `#111827` → `#1e293b` | The app's three-step dark slate |
| Accent | `#f59e0b`, lifted to `#fbbf24` | 44 uses across the app. This is the brand |
| Text | `#f8fafc` / `#cbd5e1` / `#94a3b8` | Three weights, not five |
| Type | Inter | Already loaded, already the app's voice |

**Amber on dark slate is the whole idea, and it should not be softened for the web.**

Every fruit and vegetable site in India reaches for the same three things: leaf green, a lot of
white, and a photograph of produce in a wicker basket under studio light. It reads as clean, and it
reads as everyone else. A customer cannot tell two of those sites apart, which means the design is
doing no work.

Amber on near-black is what a market stall actually looks like after dark — sodium light on fruit.
It is warm rather than clinical, it makes produce photography glow instead of fighting it, and
nobody else in this category is doing it. Inheriting it also means the website and the app are
visibly the same company, which matters when the same person sees an invoice, a WhatsApp message and
a web page in one day.

**Do not:** add green as a second accent, lighten the ground "so it feels fresher", or introduce a
second typeface for headings. Each of those individually converts this into the site it was supposed
not to be.

---

## 2. What the site is for, in order

1. **Order the same fruit again.** Retail produce is repeat business on a short cycle. The single
   most valuable screen is not the catalogue — it is *last order, reorder*.
2. **Know where the parcel is.** The customer's only question after ordering.
3. **Find out what is good today.** Produce is seasonal and the stock changes daily. This is the one
   thing a static shop front cannot do and a live one can.

Everything else — About, our story, why we care about farmers — is a page nobody reads that costs a
week. Ship none of it.

---

## 3. Design rules specific to this business

**Stock is the honest part.** The app already refuses to render a failed load as ₹0. The site
inherits that rule: never show an item as available when it is not, and never show "0" where the
truth is "we could not check". Selling online what is not in the shop is the one failure that costs
a customer permanently, and G7's analysis names it as the reason stock accuracy stops being a
reporting concern.

**Price by weight, visibly.** Produce is sold by the kilo at a rate that moves daily. A price with
no unit beside it is the single commonest confusion in this category. Show `₹80 / kg`, always, and
show the date the rate applies to.

**The photograph is the product.** In a category where every competitor uses the same stock library,
real photographs of the actual crates, taken on a phone in the actual shop, will outperform anything
bought. Amber-on-dark makes them look better than white-on-white does.

**Design for one thumb on a mid-range Android on mobile data.** Not a desktop grid that reflows.
Order in three taps. No carousel, no hero video, no font that needs downloading before text appears.

**WhatsApp is the channel, not email.** Order confirmation, "your parcel is on the way", the
tracking link — all of it goes where the customer already is. The site's job is to hand off to it,
not to compete with it. G2 already builds that surface.

---

## 4. The screen that has to be right

Order tracking, because it is the one the customer opens more than once and the one that decides
whether they order again.

It shows: what they ordered, what it cost, which stage it is at, who is carrying it, and the
carrier's own tracking link. The stages are the same four the app uses — received, packed, sent,
delivered — because a customer and a shop describing the same parcel differently is how a support
conversation starts.

The delivery reference is pasted from Rapido or Porter rather than fetched from an API. That is
deliberate and is documented in G7: it works with every provider at once, needs no partner
onboarding, and answers the only question being asked. When volume makes copying a link the
bottleneck, integration earns its place — not before.

---

## 5. What "world class" means here

Not more design. Less, held to properly:

- **One accent colour, used for one thing.** Amber means "this is the action". The moment it also
  means "this is a heading" and "this is a badge", it stops meaning anything.
- **Three type sizes on a page, not seven.** The app already has a scale (`--font-size-*`); reuse it
  rather than inventing web values.
- **No state without a cause.** Every spinner says what it is waiting for, every empty screen says
  why it is empty, every error says what to do next. This is the same rule as CLAUDE.md's
  "errors must never render as zero", and it is where most sites are actually poor.
- **Fast on the worst connection you expect, not the best.** Under 100KB of blocking assets. Text
  before images.

---

## 6. Related and not yet decided

**G6 — Brand theming** overlaps this directly. If theming becomes configurable, these tokens are the
default theme rather than hard-coded values, and the website should read them from the same source
the app does rather than keeping its own copy that drifts.

Open: whether the site is served by the existing backend (`backend/public`, as the Railway build
already does for the app bundle) or deployed separately. Serving it from the same origin avoids a
second deployment and a CORS surface; a separate deployment keeps a public front end away from the
ERP entirely. **That is a security decision as much as an architectural one, and it should be taken
with the A-6 checklist open.**
