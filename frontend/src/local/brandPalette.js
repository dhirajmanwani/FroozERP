// The Frooz palette, read out of the official logo artwork rather than invented.
//
// frontend/public/branding/frooz-logo.svg carries exactly three colours: a deep
// green, a mid green and a gold. Everything below is those three plus the ramp
// needed to build a usable interface out of them, and nothing else.
//
// Why this file exists: App.css is 6,300 lines with ~700 hardcoded colour values.
// Without a written-down palette the next edit picks whatever hex looks close, and
// six months later the app is off-brand in forty places nobody can find.
// brandPalette.test.mjs reads the stylesheets and fails if a colour appears in them
// that is not listed here, so drift stops being possible rather than being noticed.

// --- The three colours that are actually in the logo -------------------------

export const BRAND = Object.freeze({
  greenDeep: "#0a2d1c",
  greenMid: "#123623",
  gold: "#c29030",
});

// The reversed logo variants ink in warm cream, not white. Cream is the app's
// brightest text for the same reason: white on deep green is a harsh pairing and
// staff look at this screen for a full shift.
export const CREAM = "#f6f3ea";

// The reversed logo files ink in two creams, not one: the brighter for the deep
// green's role and this dimmer one for the mid green's, so the artwork keeps its
// internal contrast when it is flipped. tools/build-brand-assets.mjs uses both.
export const CREAM_DIM = "#e8e3d3";

// --- Ground ramp -------------------------------------------------------------
// Darkest to lightest. Named by the job each step does, not by a number, so a
// later change to the ramp does not require renaming every use site.

export const GROUND = Object.freeze({
  abyss: "#03110b", // scrim behind modals, deepest shadow
  canvas: "#082116", // the page itself
  panel: "#092318", // deep panels sitting on the canvas
  track: "#0c2b1d", // scrollbar troughs, inset wells
  raised: "#0d2e1f", // a surface lifted off the canvas
  raisedHigh: "#0f3222", // a surface lifted off a raised surface
  card: "#123623", // cards - lands exactly on the logo's mid green
  border: "#1e4a34", // a visible divider
  borderStrong: "#2c5d43", // a divider that has to carry weight
});

// --- Text ramp ---------------------------------------------------------------

export const INK = Object.freeze({
  faint: "#4a7a61", // a divider that has to carry weight on the dark ground
  placeholder: "#7aa48f", // disabled and placeholder text. `faint` was 2.69:1 on a card - below the
  // 4.5:1 a person needs to read it at all - so placeholders were decorative rather than legible.
  // This clears 4.5:1 on every dark surface while staying dimmer than `muted`, which is the whole
  // point of the step: quieter than a label, still readable.
  muted: "#8fab9c", // labels, secondary detail
  mutedWarm: "#97ada1", // the same weight where the surroundings are warmer
  body: "#c8d8ce", // ordinary reading text
  bodyWarm: "#cedbd3",
  bright: "#dfe9e2", // emphasised text
  brightWarm: "#e2eae5",
  paper: "#eef2ef", // near-white surfaces, printed output
  paperWarm: "#f7f9f7",
  brightest: CREAM, // headings, primary values, the logo's own ink
});

// --- Gold ramp ---------------------------------------------------------------
// The accent. `accent` is the gold that reads on a dark ground; `brandGold` is the
// artwork's own value, which is correct on paper and too dark on screen.

export const ACCENT = Object.freeze({
  deepShadow: "#2b1f06", // gold text's shadow well
  deep: "#8a6520", // gold on a light surface, e.g. an invoice
  // Hover/focus for `deep`. On a dark ground the accent brightens on hover; on a
  // light one it has to darken instead, because brightening a gold that is already
  // sitting on white is how you end up with an unreadable hover state. 7.8:1 on white.
  deepStrong: "#6b4d18", // the light theme's working accent. `deep` clears 4.5:1 on a white card but
  // only 3.6:1 on the tinted sidebar, and gold labels sit there - so the working value has to be the
  // one that survives every light surface, not just the lightest. 7.8:1 on white, 5.3:1 on the sidebar.
  deepHover: "#573c11", // hover/focus for `deepStrong`. On light, hover goes darker: brightening a
  // gold that is already on a pale ground removes the only contrast it had. 10.2:1 on white.
  brandGold: BRAND.gold, // the logo's value - print, light surfaces
  accent: "#d9ac52", // the working accent on dark ground
  deepMuted: "#4a3a14", // an accent surface that is switched on but unavailable
  bright: "#e6c274", // hover, focus
  soft: "#eed08d",
  softer: "#f2dfae",
  glow: "#efd47f",
  wash: "#f6ecd3", // a gold-tinted light surface
  washWarm: "#faf6ea",
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
