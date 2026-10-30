# Branding Assets

**Rewritten 2026-10-30** for the new name and logo: **THE PEP - Pulp Eat Up.** (the logo writes
it "THE pép" with "PULP EAT UP." under it). Everything the app and the website show is derived
from one vector file by script, so the assets cannot drift apart from each other or from the brand.

## The source

```text
branding/source/pep-logo-source.svg     the vector source
branding/source/pep-logo-original.jpeg  the logo as supplied (1206x636), kept for reference
```

The source was traced once from the supplied JPEG, colour by colour (potrace, at 4x the JPEG's
scale; the two counters are true circles fitted to the traced dots). It carries two colour classes
and five named parts and nothing else, which is what makes everything below a selection, a crop and
a recolour rather than a redraw:

| Class / part | What it is | Supplied colour |
| --- | --- | --- |
| `pep-ink` / `pep-letters` | the "pép" letters, bite mark included | mustard `#eab43f` |
| `pep-cream` / `pep-counters`, `pep-leaf`, `pep-the`, `pep-tagline` | the dots in the p's, the leaf, the vertical THE, the tagline | cream `#f6f4e5` |

The green ground (`#102f20`) is not in the artwork; the one variant that needs it adds it. Colour
values in every output come from `frontend/src/local/brandPalette.js`, never retyped. Do not
hand-edit the source or anything the generators write.

## Generated: vector variants

`node tools/build-brand-assets.mjs`

| File (in `frontend/public/branding/`) | Parts | Use it for |
| --- | --- | --- |
| `pep-logo.svg` / `pep-logo-reversed.svg` | full lockup | wide strips: splash, invoice header, site |
| `pep-mark.svg` / `pep-mark-reversed.svg` | "pép" and leaf, about 2:1 | favicon, app icon, sidebar badge, anything small |
| `pep-wordmark.svg` / `pep-wordmark-reversed.svg` | THE and "pép", no tagline | strips too small for the tagline to be read |
| `pep-logo-on-green.svg` | full lockup on its own green ground | where the ground cannot be supplied |

Also `frontend/public/favicon.svg` (the reversed mark on a deep-green tile), and the reversed cuts
plus favicon copied to `website/public/branding/`.

- **Reversed** (dark surfaces): letters `BRAND.gold`, cream parts `CREAM` - the logo's own colours.
- **Light** (white or cream surfaces, the invoice): letters take the brightest of `ACCENT.deep`,
  `deepStrong`, `deepHover` that clears 3:1 on white and on cream (the script fails if none does),
  and the cream parts become `BRAND.greenDeep`. The supplied mustard is about 1.9:1 on white.

**The `-reversed` twin is not optional on a dark surface**, and the light cut is not optional on
paper: each disappears or goes muddy on the other's ground.

Legacy names: `frooz-logo.svg`, `frooz-logo-reversed.svg`, `frooz-mark.svg`,
`frooz-mark-reversed.svg` and `frooz-wordmark-reversed.svg` are byte copies of the matching
`pep-*` files, kept only while `App.jsx`, `index.html` and `tools/build-brand-tokens.mjs` still
load those names. Remove them from `LEGACY_COPIES` once nothing does.

## Generated: rasters

`node tools/build-brand-rasters.mjs` (after the vector step), then `node tools/build-android-icons.mjs`

```text
frontend/public/branding/pep-icon-{64,192,512}.png    web / PWA icons (+ frooz-icon-{64,192}.png copies for index.html)
frontend/public/branding/pep-logo-full-{512,1024}.png lockup on its green ground
frontend/public/branding/pep-logo-invoice-320.png     light lockup on transparency, for white paper
branding/generated/pep-icon-1024.png, pep-logo-{full,light,reversed}-2048.png
src-tauri/icons/32x32.png, 128x128.png, 128x128@2x.png, icon.png, icon.ico (16-256)
src-tauri/icons/android/**                            launcher icons, adaptive layers, background colour
```

The icons are the mark across a deep-green rounded tile with a gold hairline, not the bare mark: a
desktop icon has to hold its own against whatever wallpaper is behind it.

The generators need a Chromium, Chrome or Edge binary. They find the usual paths; set `CHROME_PATH`
if they cannot. They draw on a canvas and read the pixels back rather than taking screenshots,
because headless Chromium's `--window-size` sets the window rather than the viewport and clamps
width to 500px, which silently crops small tiles.

## Typefaces

```text
frontend/src/assets/fonts/inter-latin.woff2
frontend/src/assets/fonts/inter-latin-ext.woff2
frontend/src/assets/fonts/bodoni-moda-latin.woff2
frontend/src/assets/fonts/bodoni-moda-latin-ext.woff2
```

Declared in `frontend/src/fonts.css`. Both are SIL Open Font License 1.1 and the
licences sit beside the files, which is what redistributing them requires.

**Inter** is the interface face. It had been named in `index.css` from the start with
nothing behind it, so the app was rendering in Segoe UI on any machine without Inter
installed.

**Bodoni Moda** is the display face, chosen because it is the same kind of letter as
the `FROOZ` wordmark. It carries the top two steps of the type scale and the headline
numbers, and nothing else — below about 20px its hairlines break up on the dark green
ground. Every rule that uses it must also set `font-optical-sizing: auto`; pinned to a
display optical size it visibly loses strokes at interface sizes.

It also stops at the edge of an invoice. Printing runs on a plain sans stack because a
58mm thermal receipt drops a serif's hairlines, and the on-screen preview matches, so
what you see is what the printer produces.

`latin-ext` is bundled alongside `latin` for both faces and is **not** optional: the
rupee sign is U+20B9, which sits in the latin-ext range. With latin alone, every price
in the app renders its currency symbol in a different, system typeface.

To update a face, take the matching woff2 out of `@fontsource-variable/inter` or
`@fontsource-variable/bodoni-moda` and replace the file. Leave the `unicode-range`
lines alone — they are what makes the subsetting correct.

## Colour discipline

The full approved colour list is `frontend/src/local/brandPalette.js`, and
`frontend/src/local/brandPalette.test.mjs` reads `App.css`, `index.css` and `index.html` and fails if
a colour appears in them that is not on that list — solid values and the tints inside `rgba()` alike.

Adding a colour is allowed. Adding it *quietly* is not: put it in `brandPalette.js` with a comment
saying what job it does, and the guard will accept it.

Error red, success green and the assistant's severity ramp are deliberately **not** brand-coloured.
An error rendered in the company's own gold is an error nobody notices.

`tools/apply-brand-palette.mjs` holds the map that moved the app off its old slate-navy palette. It
is kept so the mapping is auditable, and so a future stylesheet can be brought onto the brand the
same way.

## Superseded

The Frooz lockup (an Illustrator export, formerly `frontend/public/branding/frooz-logo.svg`, now a
legacy copy of the PEP art) is in git history. Older still:

```text
frontend/public/branding/frooz-official-logo.png
frontend/public/branding/frooz-logo-full-1024.png
frontend/public/branding/frooz-logo-full-512.png
frontend/public/branding/frooz-logo-invoice-320.png
frontend/public/branding/frooz-symbol-512.png
frontend/public/branding/frooz-symbol-192.png
frontend/public/branding/frooz-symbol-64.png
branding/source/frooz-*
branding/generated/frooz-*, future-android/, future-ios/
```

All of these show the oldest mark — a multicoloured fruit circle with a white `F` in it — that the
current logo replaced. Nothing in the app points at them any more. They are left in place rather than
deleted, because the maintainer may still be using them on printed material or elsewhere off this
repo. **Do not reintroduce them into the app or the website.**

The old note about transparent backgrounds no longer applies. The vector source has a transparent
background at every size.

## Rules

- Do not redesign the logo, or alter its wording, colours or proportions.
- Do not hand-edit a generated file. Change the source or the generator and re-run.
- Preserve aspect ratio. The lockup is wide; it does not go in a square slot — the mark does.
- Do not crop the tagline in large placements, and do not put tagline text inside a small icon.
- Keep printed reports on white with solid dark text.
