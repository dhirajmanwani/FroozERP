# UI Polish Backlog

Visual and copy issues observed by the maintainer while walking through the running app.

**Nothing here is implemented.** This file is an intake log, not a work plan.

## How this file is kept

- Items are recorded **only** as reported by the maintainer during a walkthrough. This file is
  not populated by reading source, and issues are not inferred, extrapolated, or added
  speculatively.
- Each item is filed under the screen it was seen on. Screen sections are created as they come
  up, in the order first reported.
- Reports are recorded as observations, in the maintainer's own terms. If a cause is not
  stated, none is guessed at — an item may simply describe what looks wrong.
- Anything ambiguous is left flagged as open rather than resolved by assumption.

## Entry format

```
### <Screen name>

- **<short description>** — what was observed. Reported <date>.
  Detail: exact wording, location on screen, or conditions, where given.
  Status: open
```

## Session log

| Date | Build / context |
| --- | --- |
| 2026-08-15 | Dev mode (`npm run app`) from source at `F:\FroozERP`, LOCAL_ONLY, disposable test profile |

---

## Items

### Stock Inventory (Reports → Inventory → Current Stock)

- **Filter clutter and layout** — the filter block shows everything at once, with no grouping,
  progressive disclosure, or collapse. Reported 2026-08-15.

  Controls reported visible simultaneously:

  | | |
  | --- | --- |
  | Product Search / Selector | Lot Filter |
  | View Mode | Category |
  | Supplier | Origin |
  | Date Type | Date From |
  | Date To | Status |
  | Sort By | Rows |

  Plus eight quick chips: Today's Arrivals, Last 7 Days, Last 30 Days, Low Stock,
  Out of Stock, Imported, Local, Recently Updated.

  Plus three toggles / actions: Show Empty Lots, Show Inactive / Cancelled Lots,
  View Audit Trail, Clear All Filters.

  **Full set: 12 controls + 8 quick chips + 3 toggles/actions**, all visible at once.

  Status: open (complete as reported 2026-08-15)

---

### Reports → Profit & Loss (and every report offering export)

- **White screen instead of a loading state** — clicking **Print**, **View PDF**, **Save PDF**
  or **Export** shows a blank white screen for several seconds before the preview renders.
  Reported 2026-08-15. Applies to every report that offers export, not only Profit & Loss.

  Questions asked by the maintainer, recorded verbatim:

  1. Why a white screen appears instead of a loading state.
  2. Whether the render can happen off-screen so the user never sees blank.
  3. Whether a proper progress indicator is enough, or the export approach itself needs
     replacing for the report sizes we generate.

  Explicit instruction: **measure before proposing — numbers, not guesses.**

  Status: open — measured 2026-08-15, no code changed

  **Measurements**

  *1. Why the screen is white.* Not a missing loading state — the app whitens itself on
  purpose. `App.jsx:1034` adds `pdf-export-active` to `document.body`; `App.css:1529` sets
  `background: #ffffff !important`, and `.pdf-export-mode *` forces white background and black
  text on the report element. **No overlay or spinner is rendered over it**, so the user sees
  the whitened live UI for the whole capture. `App.jsx:1036` also waits two animation frames
  before starting, guaranteeing at least one painted white frame before any work begins.

  *2. It is not module-loading delay.* `html2canvas`, `jsPDF` and `pdfjs-dist` are **static
  top-level imports** (`App.jsx:3-6`), so they are already in the main bundle and loaded at
  startup. Built chunks: `App` 1691.5 KB, `index.es` (jsPDF) 147.9 KB, `purify.es` 24.4 KB,
  `pdf.worker` 2136.3 KB. Lazy-loading them would improve startup but would not shorten the
  blank period.

  *3. Cost model — measured, jsPDF only.* Capture scale is
  `Math.max(2, Math.min(3, devicePixelRatio))` (`App.jsx:1039`), so **2 on ordinary displays**,
  3 on 300% scaling. jsPDF stores the PNG essentially uncompressed, so output size tracks
  `width x height x 3 bytes`:

  | Report | Canvas | Canvas RGBA in memory | **PDF size** | jsPDF build |
  | --- | --- | --- | --- | --- |
  | short @scale2 | 2400x4000 | 36.6 MB | **27.5 MB** | 1166 ms |
  | short @scale3 | 3600x6000 | 82.4 MB | **61.8 MB** | 2259 ms |
  | medium @scale2 | 2400x10000 | 91.6 MB | **68.7 MB** | 2425 ms |

  A long report at scale 3 (3600x36000) would need **494 MB** of canvas memory alone.

  **These timings are a lower bound.** They measure jsPDF only, in Node. The real blank period
  is this *plus* `html2canvas` DOM rasterisation and `canvas.toDataURL("image/png")`, both of
  which run on the main thread in the browser and are typically the larger share.

  *4. Hypothesis tested and rejected.* The per-page loop (`App.jsx:1057-1063`) re-adds the same
  full image for every page, which looked like it would multiply file size. It does not —
  jsPDF deduplicates identical image data. Measured output was constant at 5.50 MB across 1, 2,
  5 and 10 pages. Page count is not a factor.

  **Answers to the three questions**

  1. *Why white instead of loading:* deliberate whitening for capture, with nothing drawn over
     it. A loading state was never added to this path.
  2. *Can the render happen off-screen:* yes. `html2canvas` clones the document to render, and
     exposes an `onclone` hook. The print classes are currently applied to the **live** DOM,
     which is what the user sees. Applying them to the clone instead would leave the visible UI
     untouched for the whole operation. This is the smallest change with the largest perceived
     effect.
  3. *Progress indicator, or replace the approach:* a progress indicator is **not sufficient**.
     The output is a photograph of the screen, not a document: 27-69 MB for ordinary reports,
     no selectable or searchable text, resolution fixed at capture time, and print quality
     bounded by screen rendering. A spinner would make the wait legible while leaving a
     27 MB image-PDF as the deliverable. For report exports the approach should be replaced
     with text-based PDF generation (real text, vector rules, page breaks between rows).
     Raster capture remains reasonable for thermal receipts, which are small and layout-exact.

  **Not measured:** actual `html2canvas` + `toDataURL` wall time in the running WebView, and
  real report dimensions for Profit & Loss on this data set. Both need instrumentation or a
  driven UI session, which was out of scope tonight (no UI code changes).

---

### Whole app — theme, logo, visual design

- **Cleaner, more premium look across the app** — covering theme, colours, typography, and a
  new logo. Reported 2026-08-15.

  Explicit instruction: this needs direction from the maintainer before anything is touched.
  No redesign is to be proposed until the following are answered — who the user is, the
  intended feeling, light or dark, reference software whose look is liked, and whether the
  FROOZ brand colours are fixed or open to change.

  Status: open, direction partially gathered 2026-08-15

  **Direction given by the maintainer (2026-08-15):**

  | Question | Answer |
  | --- | --- |
  | Primary user | **Both equally** — POS and back office each treated on their own terms |
  | Feeling | **Calm and precise** — quiet, restrained, data-first; colour used sparingly and only to mean something |
  | Light or dark | **Both, user-selectable** |
  | FROOZ brand colours | **Open — free to change**, including as part of the new logo |

  **Still outstanding:** reference software whose look the maintainer likes, and what
  specifically appeals about each (density, calm, colour, typography, table handling).

  No redesign has been proposed. Per explicit instruction, none will be until direction is
  complete.

  **Implications to hold on to when the proposal is written:**

  - "Both equally" plus "calm and precise" means one type scale and one spacing system across
    POS and back office, with density varying by context rather than two unrelated looks.
  - "Both, user-selectable" means colour must be defined as semantic tokens from the start, not
    picked per screen — every colour needs a light and a dark value with contrast checked in
    both. Retrofitting this later is the expensive path.
  - "Colour used sparingly and only to mean something" conflicts with the current habit of
    status colouring across dense tables. Which states genuinely need colour, and which can be
    carried by type weight or position, is a decision to take deliberately.
  - "Open — free to change" removes the usual constraint, so the palette should be derived from
    legibility requirements first (long tables, INR figures, 3-decimal quantities, thermal
    print) and brand expression second.
