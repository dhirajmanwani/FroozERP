# The Frooz storefront

The customer-facing ordering site. Two pages: **Today** (`index.html`) and **Track**
(`track.html`). Design direction and the reasoning behind it are in
`docs/website-design-brief.md`.

## This is not live, and must not be made live yet

**It is not connected to the backend, and connecting it is gated.** A public site
taking real orders means the backend is reachable from the internet, and
`docs/auth-hardening-plan.md` §A-6 still says **DO NOT EXPOSE**. Close those gates
first.

Until then it reads `data/catalogue.json`, which a person exports from the app and
uploads. **That is the intended way to run it right now**, and it is safe precisely
because nothing of the system is reachable: see `docs/putting-the-shop-online.md`.
The file checked in is sample data and says so at the top.

## Running it

There is no build step and no dependency. It is HTML, CSS and ES modules.

```bash
npm --prefix website run serve     # http://127.0.0.1:8901
npm --prefix website test          # the basket and availability suites
```

A plain file:// open will not work — ES modules and `fetch` both need an origin.

## How it is put together

| File | What it is |
| --- | --- |
| `src/site.css` | The whole design system. Colours come from `src/tokens.css`; nothing here invents one |
| `src/tokens.css` | **Generated.** `node tools/build-brand-tokens.mjs` builds it from `frontend/src/local/brandPalette.js` |
| `src/availability.js` | Turns a catalogue row into an honest stock state. Has its own suite |
| `src/basket.js` | Basket maths, kilos and rupees. Has its own suite |
| `src/shop.js` | Wiring for the Today page — fetch, render, listen. No logic worth testing lives here |
| `src/track.js` | Wiring for the Track page |
| `public/` | **Generated.** The logo and font files, refreshed by the same tokens script |
| `data/catalogue.json` | What the shop is selling today. Written by the app's export, uploaded by hand |

The site and the desktop app read their colours from one file, and
`frontend/src/local/brandPalette.test.mjs` fails the build if a colour appears in
either stylesheet that is not in it. A customer who sees the site and an invoice on
the same day should not be able to tell they were built by different hands.

## The rules this site is held to

These come out of the brief and out of CLAUDE.md, and they are why the code looks
the way it does.

**An error never renders as zero.** `availability.js` has a fourth state, `UNKNOWN`,
alongside in-stock, limited and sold-out. It means *we could not read the stock* —
and it never collapses into "sold out", because those are the same number and
completely different things to tell a customer. The page says "Stock not confirmed"
and offers to ask the shop, rather than saying "Unavailable" about fruit that is
probably sitting on the shelf.

**A rate of zero is refused, not printed.** Nobody sells fruit for nothing, so a zero
rate is a rate that failed to load. `addLine` will not accept it.

**Line totals sum to the printed total.** Rounding happens once per line, and the
subtotal is the sum of those rounded lines. A customer adding six lines up on paper
has to get the number we charge.

**Dates and times are the shop's.** Formatted in the viewer's timezone instead, rates
set on the 22nd read as the 21st to anyone west of India, and "yesterday's rates" is
exactly what this is meant to rule out.

**Weight always carries its unit, money always carries its grouping.** `2.500 kg`,
and `₹1,09,340.75` in Indian digit grouping, the same as the app.

## Two things that follow from being static

**Stock goes stale, and the site knows it.** The catalogue carries `generatedAt` and
`stockTrustedForHours`. Past that window every product resolves to `UNKNOWN` and a
notice explains why. Rates keep showing, with their date, because a rate is set once
a day and printed on a board; a quantity is not.

**The last order lives in the customer's browser.** There are no accounts and no
server, so there is nowhere else it could honestly live - and nowhere better: it is
one person's shopping, on one person's phone, and it never leaves it. Every read and
write is wrapped, because a private window or blocked site data must not stop
somebody ordering fruit.

## Not built yet

- Real photographs. The cards hold a photo slot; until there are real phone photos of
  the actual crates, it shows the produce's own colour and its initial. That is a
  designed empty state, not a placeholder, and it is deliberately not a stock photo.
- Anything behind the WhatsApp handoff. The site composes the message; a person
  answers it. That is the intended first version.
- The tracking page. `track.html` is built and correct, but a static site has no
  per-order data, so it is not linked from anywhere yet. Until the backend is
  connected, "where is my parcel" is answered on WhatsApp.
- Live catalogue, real orders, payment. All of it waits on the exposure gate above.
