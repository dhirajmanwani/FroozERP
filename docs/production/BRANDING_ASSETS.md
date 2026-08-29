# Branding Assets

**Rewritten 2026-08-22.** The maintainer supplied the logo as vector art. Everything the app and the
website show is now derived from that one file by a script, so the assets cannot drift apart from
each other or from the brand.

## The source

```text
frontend/public/branding/frooz-logo.svg
```

This is the official lockup, exported from Illustrator. It carries exactly three colours and nothing
else — a deep green, a mid green and a gold — which is what makes everything below a recolour rather
than a redraw.

| Role | Value |
| --- | --- |
| Deep green | `#0a2d1c` |
| Mid green | `#123623` |
| Gold | `#c29030` |

The reversed variants ink in a warm cream, `#f6f3ea`.

If a fresh export ever arrives, replace this file and re-run both generators. Do not hand-edit it,
and do not hand-edit anything either generator produces.

## Generated: vector variants

`node tools/build-brand-assets.mjs`

```text
frontend/public/branding/frooz-logo-reversed.svg
frontend/public/branding/frooz-mark.svg
frontend/public/branding/frooz-mark-reversed.svg
frontend/public/branding/frooz-wordmark.svg
frontend/public/branding/frooz-wordmark-reversed.svg
```

Each is a viewBox crop of the source plus a colour swap. Three shapes, two palettes.

| Variant | What it is | Use it for |
| --- | --- | --- |
| `frooz-logo` | The full lockup, about 3:1 | Wide strips: site header, invoice header, splash |
| `frooz-mark` | The monogram and its leaf, square | Favicon, app icon, avatar, the sidebar badge, anything small |
| `frooz-wordmark` | Tagline and `FROOZ`, no monogram | When the mark is already on screen nearby |

**The `-reversed` twin is not optional on a dark surface.** The normal cut is deep green; on the app's
deep-green ground it disappears completely. The app's screen chrome uses reversed everywhere; the
invoice uses the normal cut, because it prints on white paper.

## Generated: raster icons

`node tools/build-brand-rasters.mjs`

```text
frontend/public/branding/frooz-icon-64.png
frontend/public/branding/frooz-icon-192.png
frontend/public/branding/frooz-icon-512.png
src-tauri/icons/32x32.png
src-tauri/icons/128x128.png
src-tauri/icons/128x128@2x.png
src-tauri/icons/icon.png
src-tauri/icons/icon.ico
```

These are the mark drawn on a deep-green rounded tile with a gold hairline, not the bare mark. A
desktop icon has to hold its own against whatever wallpaper is behind it, and a single-colour cream
shape on transparency does not.

The generator needs a Chromium, Chrome or Edge binary. It finds the usual paths; set `CHROME_PATH`
if it cannot. It draws on a canvas and reads the pixels back rather than taking screenshots, because
headless Chromium's `--window-size` sets the window rather than the viewport and clamps width to
500px, which silently crops small tiles.

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

```text
frontend/public/branding/frooz-official-logo.png
frontend/public/branding/frooz-logo-full-1024.png
frontend/public/branding/frooz-logo-full-512.png
frontend/public/branding/frooz-logo-invoice-320.png
frontend/public/branding/frooz-symbol-512.png
frontend/public/branding/frooz-symbol-192.png
frontend/public/branding/frooz-symbol-64.png
branding/source/**
branding/generated/**
```

All of these show an earlier mark — a multicoloured fruit circle with a white `F` in it — that the
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
