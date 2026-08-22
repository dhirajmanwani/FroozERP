# The Frooz website — design direction

**Written 2026-08-21, at the maintainer's request, before any of it is built. Section 1 rewritten
2026-08-22, when the official logo arrived and the palette in the first version turned out to be the
app's colours rather than the brand's.** The site itself is gated: a public site taking real orders
means the backend is reachable from the internet, and `docs/auth-hardening-plan.md` §A-6 still says
**DO NOT EXPOSE**. This exists so the design is a decision taken in advance rather than whatever gets
typed on the day the gate opens.

---

## 1. The theme is decided, and it is the brand's own colours

The first version of this section was written before anyone had seen the logo. It read a palette out
of `App.css` and called it the brand, and it told designers not to add green. Now that the artwork
exists that instruction is backwards, because green is the brand. The reasoning underneath it still
holds and is kept below; only the colours change.

These values are taken from the vector artwork itself, `frontend/public/branding/frooz-logo.svg`:

| Role | Value | Where it comes from |
| --- | --- | --- |
| Ground | `#0a2d1c` → `#123623` | The two greens in the logo: deep green, then a slightly lighter mid green for panels and cards |
| Accent | `#c29030`, lifted to `#d9ac52` when it sits on the dark ground | The gold of the leaf, the vertical rule and the tagline |
| Text | `#f6f3ea` / `#c8d8ce` / `#8fab9c` | Brightest is the cream used as ink in the reversed logo files; the two quieter weights are greens of the same lightness as the app's old greys, so nothing loses contrast. All three are in `frontend/src/local/brandPalette.js` |
| Type | The `FROOZ` lettering from the logo for the one big display line; Inter for everything else | The wordmark is already drawn; Inter is already loaded and is the app's voice |

**Deep green and gold is the whole idea, and it should not be softened for the web.**

Every fruit and vegetable site in India reaches for the same three things: leaf green, a lot of
white, and a photograph of produce in a wicker basket under studio light. It reads as clean, and it
reads as everyone else. A customer cannot tell two of those sites apart, which means the design is
doing no work.

A dark ground is what breaks that tie. It is what a market stall actually looks like after dark —
sodium light on fruit. It is warm rather than clinical, and it makes produce photography glow instead
of fighting it. That argument has not changed. What has changed is *which* dark. It used to be a
borrowed slate navy with a generic amber on top; it is now the brand's own deep forest green with the
brand's own gold on top. The site gets the difference from the category **and** is on-brand, instead
of trading one for the other.

Deep green on deep green is still nothing like the category norm. The cliché is *light* green on
white. Nobody is running a near-black green page with gold on it.

**Do not:**

- Bring back `frooz-official-logo.png`. That file is the old multicoloured fruit-circle mark and it
  is superseded. The SVGs below are the logo now.
- Lighten the ground to a white page "so it feels fresher". That is the site this one is supposed
  not to be.
- Add a heading typeface beyond the lettering the wordmark already gives you.
- Recolour the logo. There are exactly two palettes, the normal one and the reversed one, and both
  are generated. Nothing else is allowed.

**The app is being rethemed onto these same values at the same time.** Same greens, same gold, same
cream. So a customer who sees an invoice, a WhatsApp message and the web page in one day sees one
company, not three.

### The logo is wide, and that has layout consequences

The lockup is about three times wider than it is tall (2172 × 724). It will not fit a square slot, so
do not try — squeezing it or padding it into a square is how it ends up unreadable at small sizes.
Use the right variant instead:

| Variant | Use it for |
| --- | --- |
| `frooz-logo.svg` | The full lockup: site header, invoice header, anywhere with room for a wide strip |
| `frooz-mark.svg` | The monogram alone: favicon, app icon, avatar, any small or square chrome |
| `frooz-wordmark.svg` | Tagline plus `FROOZ`, no monogram: when the mark is already on screen nearby |

Every one of those has a `-reversed` twin. **On any dark surface — which on this site is nearly all of
them — use the reversed file.** The normal one is deep green, and deep green on a deep green ground
disappears.

All six files are generated from the one source SVG by `node tools/build-brand-assets.mjs`. They are
crops and colour swaps of the same paths, so a fresh export from Illustrator can be dropped in and
regenerated. Do not hand-edit the generated files.

The app icon is a separate job, because a desktop icon needs a background to sit on and the mark is
a single-colour shape with nothing behind it. `node tools/build-brand-rasters.mjs` draws the mark on
a deep-green tile at every size Windows and the web manifest ask for, including the `.ico`.

The full colour list lives in `frontend/src/local/brandPalette.js`, and `brandPalette.test.mjs` reads
the app's stylesheets and fails if a colour appears in them that is not on that list. If the website
ends up in this repo, point the same guard at its stylesheet.

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
bought. A dark green ground makes them look better than white-on-white does.

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

- **One accent colour, used for one thing.** Gold means "this is the action". The moment it also
  means "this is a heading" and "this is a badge", it stops meaning anything. The greens carry
  everything else: ground, panels, borders.
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
the app does rather than keeping its own copy that drifts. The source of truth for the colours is the
logo SVG and `tools/build-brand-assets.mjs`, so whatever holds the tokens should match those values
rather than being typed in again by hand.

Open: whether the site is served by the existing backend (`backend/public`, as the Railway build
already does for the app bundle) or deployed separately. Serving it from the same origin avoids a
second deployment and a CORS surface; a separate deployment keeps a public front end away from the
ERP entirely. **That is a security decision as much as an architectural one, and it should be taken
with the A-6 checklist open.**
