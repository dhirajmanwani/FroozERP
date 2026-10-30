// The PEP palette ("THE PEP - Pulp Eat Up"), read out of the official logo artwork
// rather than invented.
//
// The PEP logo carries exactly three colours: a forest-green ground (#102f20), a
// mustard for the letters (#eab43f) and a cream for the leaf, the letter counters,
// "THE" and the tagline (#f6f4e5). Everything below is those three, one mid green
// stepped up from the ground for cards, and the ramps needed to build a usable
// interface out of them, and nothing else.
//
// The ramps were retuned from the earlier Frooz palette rather than redrawn: each
// step was moved onto the PEP logo's hue and chroma in OKLCH and then re-solved so
// its WCAG luminance is unchanged. That is why every contrast number documented here
// and in theme.css held through the rebrand - the hue moved, the lightness did not.
// The mapping old -> new is kept in tools/apply-brand-palette.mjs.
//
// Why this file exists: App.css is 6,300 lines with ~700 hardcoded colour values.
// Without a written-down palette the next edit picks whatever hex looks close, and
// six months later the app is off-brand in forty places nobody can find.
// brandPalette.test.mjs reads the stylesheets and fails if a colour appears in them
// that is not listed here, so drift stops being possible rather than being noticed.

// --- The colours that are actually in the logo --------------------------------

export const BRAND = Object.freeze({
  greenDeep: "#102f20", // the logo's ground, measured off the artwork
  greenMid: "#153525", // one step up from the ground at the same hue - the card surface
  gold: "#eab43f", // the logo's mustard (the letters)
});

// The logo inks its leaf, counters, "THE" and tagline in warm cream, not white. Cream
// is the app's brightest text for the same reason: white on deep green is a harsh
// pairing and staff look at this screen for a full shift.
export const CREAM = "#f6f4e5";

// A second, dimmer cream at the logo cream's hue: the light theme's page ground, and
// the second ink tools/build-brand-assets.mjs uses where artwork has to keep its
// internal contrast when it is flipped.
export const CREAM_DIM = "#e7e4ce";

// --- Ground ramp -------------------------------------------------------------
// Darkest to lightest. Named by the job each step does, not by a number, so a
// later change to the ramp does not require renaming every use site.

export const GROUND = Object.freeze({
  abyss: "#04100b", // scrim behind modals, deepest shadow
  canvas: "#0a2017", // the page itself
  panel: "#0b2219", // deep panels sitting on the canvas
  track: "#0f2b1e", // scrollbar troughs, inset wells
  raised: "#102e20", // a surface lifted off the canvas
  raisedHigh: "#123124", // a surface lifted off a raised surface
  card: "#153525", // cards - lands exactly on BRAND.greenMid
  border: "#224a36", // a visible divider
  borderStrong: "#305c46", // a divider that has to carry weight
});

// --- Text ramp ---------------------------------------------------------------

export const INK = Object.freeze({
  faint: "#4e7964", // a divider that has to carry weight on the dark ground
  placeholder: "#7da391", // disabled and placeholder text. `faint` was 2.69:1 on a card - below the
  // 4.5:1 a person needs to read it at all - so placeholders were decorative rather than legible.
  // This clears 4.5:1 on every dark surface while staying dimmer than `muted`, which is the whole
  // point of the step: quieter than a label, still readable.
  muted: "#91ab9d", // labels, secondary detail
  mutedWarm: "#98aca2", // the same weight where the surroundings are warmer
  body: "#c9d7cf", // ordinary reading text
  bodyWarm: "#cedbd3",
  bright: "#dfe9e2", // emphasised text
  brightWarm: "#e2e9e5",
  paper: "#eef2ef", // near-white surfaces, printed output
  paperWarm: "#f7f9f7",
  brightest: CREAM, // headings, primary values, the logo's own ink
});

// --- Mustard ramp ------------------------------------------------------------
// The accent, every step on the logo mustard's hue. `accent` is the working accent
// on a dark ground, and with the PEP logo that is the artwork's own mustard: it is
// bright enough to read on every dark surface (7.1:1 at worst, on a card) where the old Frooz
// gold was too muddy to. The flip side is that the mustard is far too light for
// paper (1.9:1 on white), so on a light surface the `deep*` steps do the work.

export const ACCENT = Object.freeze({
  deepShadow: "#2c1e02", // gold text's shadow well
  deep: "#896613", // gold on a light surface, e.g. an invoice
  // Hover/focus for `deep`. On a dark ground the accent brightens on hover; on a
  // light one it has to darken instead, because brightening a gold that is already
  // sitting on white is how you end up with an unreadable hover state. 7.8:1 on white.
  deepStrong: "#6a4e0c", // the light theme's working accent. `deep` clears 4.5:1 on a white card (5.3:1) but
  // only 3.5:1 on the tinted sidebar, and gold labels sit there - so the working value has to be the
  // one that survives every light surface, not just the lightest. 7.8:1 on white, 5.2:1 on the sidebar.
  // A dark mustard, not a brighter one: moving it toward the logo's hue was free, moving it toward
  // the logo's lightness would have failed the sidebar.
  deepHover: "#553d07", // hover/focus for `deepStrong`. On light, hover goes darker: brightening a
  // gold that is already on a pale ground removes the only contrast it had. 10.2:1 on white.
  brandGold: BRAND.gold, // the logo's value - print, the price-list picture, artwork
  accent: BRAND.gold, // the working accent on dark ground - the logo mustard itself
  deepMuted: "#4e3806", // an accent surface that is switched on but unavailable
  bright: "#facb6c", // hover, focus - 1.25:1 above `accent`, the same step the Frooz ramp had
  soft: "#f7cd7e",
  softer: "#fbdda4",
  glow: "#fdcf75",
  wash: "#fbebce", // a gold-tinted light surface
  washWarm: "#fdf6e8",
});

// --- Semantic signals --------------------------------------------------------
// Deliberately NOT rebranded. An error that is brand-coloured is an error nobody
// notices. Success green is kept bright and saturated so it separates from the
// forest-green ground rather than blending into it.

export const SIGNAL = Object.freeze({
  danger: "#ef4444",
  dangerBright: "#f87171",
  dangerSoft: "#fca5a5",
  dangerWash: "#fecaca",
  dangerRose: "#fb7185",
  dangerRoseSoft: "#fecdd3",
  dangerDeep: "#7f1d1d",
  success: "#22c55e",
  // The four `*Ink`/`*Deep` entries below exist only because of the light theme. The
  // bright signal colours above are tuned for a dark ground and every one of them
  // fails as text on paper - #22c55e measures 2.28:1 on white, #38bdf8 2.14:1,
  // #fb923c 2.26:1. These are the same signals darkened until they clear 4.5:1 there,
  // so a warning stays readable in both themes. They are still not brand-coloured.
  successDeep: "#166534", // success text on a light surface - 7.1:1 on white
  successBright: "#4ade80",
  successSoft: "#86efac",
  successWash: "#bbf7d0",
  info: "#38bdf8",
  infoBright: "#7dd3fc",
  infoSoft: "#bae6fd",
  infoWash: "#e0f2fe",
  infoDeep: "#0ea5e9",
  infoCyan: "#22d3ee",
  infoNavy: "#082f49",
  infoInk: "#075985", // info as text on a light surface. Was #0369a1, which cleared 4.5:1 on a white
  // card but only 4.0:1 once the light theme's sidebar was deepened to give the page some structure
  // -- and info labels sit there. Deepened with it. 5.1:1 at worst across every light surface. // info text on a light surface - 5.9:1 on white
  // The severity ramp on the assistant panel runs info -> attention -> high ->
  // critical. It stays blue/yellow/orange/red on purpose: recoloured into the
  // brand's own gold, "attention" and "high" would read as decoration.
  attention: "#fde047",
  attentionDeep: "#facc15",
  warning: "#fdba74",
  warningDeep: "#fb923c",
  warningInk: "#9a3412", // warning text on a light surface - 7.3:1 on white
  attentionInk: "#854d0e", // attention text on a light surface - 6.9:1 on white
});

// --- Absolutes ---------------------------------------------------------------
// Paper and ink for printed output, where the screen palette does not apply.

export const ABSOLUTE = Object.freeze({
  white: "#ffffff",
  whiteShort: "#fff",
  black: "#000000",
  nearBlack: "#111111",
});

const ALL = Object.freeze([
  ...Object.values(BRAND),
  CREAM,
  CREAM_DIM,
  ...Object.values(GROUND),
  ...Object.values(INK),
  ...Object.values(ACCENT),
  ...Object.values(SIGNAL),
  ...Object.values(ABSOLUTE),
]);

const APPROVED = new Set(ALL.map((value) => value.toLowerCase()));

/** True when `value` is a colour this brand is allowed to use. */
export function isBrandColour(value) {
  if (typeof value !== "string") return false;
  return APPROVED.has(value.trim().toLowerCase());
}

/** Every approved colour, lowercased, deduplicated. */
export function approvedColours() {
  return [...APPROVED].sort();
}

/**
 * The `r, g, b` triple for a colour, for building `rgba(...)` values.
 * Returns null for anything not in the palette, so an off-brand tint cannot be
 * smuggled in through a translucent layer.
 */
export function brandRgb(value) {
  if (!isBrandColour(value)) return null;
  let hex = value.trim().toLowerCase().slice(1);
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
  if (hex.length !== 6) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}
