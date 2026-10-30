#!/usr/bin/env node
// Moves the app's stylesheets onto the brand palette, in two recorded passes:
//
//   1. slate -> Frooz: off the borrowed slate-navy palette onto the Frooz logo's
//      greens and gold.
//   2. Frooz -> PEP: the rebrand to "THE PEP - Pulp Eat Up". Every Frooz value is
//      moved onto the PEP logo's hue and chroma with its WCAG luminance held.
//
// The passes run in order, so a stylesheet still carrying slate values lands on the
// PEP palette in one run, and a stylesheet already on PEP is left alone (no PEP value
// is a key of either pass; the script refuses to run if that ever stops being true).
//
// Pass 1 is a family swap, not a redesign. Every slate value is replaced by a green
// of the same lightness, and every generic amber by the brand gold, so nothing
// about contrast, hierarchy or layout changes - only the hue. Semantic colours
// (error red, success green, the assistant's severity ramp) are deliberately left
// alone; an error rendered in the brand's own colour is an error nobody sees.
//
// Kept in the repo rather than run and deleted, so the mapping is auditable and a
// future stylesheet can be brought onto the palette the same way.
//
// Run: node tools/apply-brand-palette.mjs [--check] [file ...]
//   With file arguments, only those files are rewritten (paths from the repo root).

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TARGETS = [
  "frontend/src/theme.css",
  "frontend/src/App.css",
  "frontend/src/index.css",
  "frontend/index.html",
];

// --- Pass 1: slate -> Frooz ------------------------------------------------------
// old value -> new value. Comment says the role, because the hex says nothing.
const SLATE_TO_FROOZ_HEX = {
  // Ground: slate-navy ramp -> forest-green ramp, lightness for lightness.
  "#020617": "#03110b", // deepest scrim
  "#0b1220": "#03110b", // disabled control ground
  "#0f172a": "#082116", // page canvas
  "#111827": "#092318", // deep panel
  "#172033": "#0c2b1d", // inset well, scrollbar trough
  "#182237": "#0d2e1f", // raised surface
  "#1b263a": "#0f3222", // raised on raised
  "#1e293b": "#123623", // card - lands on the logo's own mid green
  "#334155": "#1e4a34", // divider
  "#374151": "#1e4a34", // divider
  "#475569": "#2c5d43", // divider carrying weight
  "#052e16": "#082116", // dark ink on the bright WhatsApp green

  // Text: cool greys -> warm greens, brightest becomes the logo's cream.
  "#64748b": "#4a7a61",
  "#9ca3af": "#97ada1",
  "#94a3b8": "#8fab9c",
  "#cbd5e1": "#c8d8ce",
  "#cbd5f5": "#c8d8ce",
  "#d1d5db": "#cedbd3",
  "#e2e8f0": "#dfe9e2",
  "#e5e7eb": "#e2eae5",
  "#f3f4f6": "#eef2ef",
  "#f9fafb": "#f7f9f7",
  "#f8fafc": "#f6f3ea", // cream

  // Accent: generic amber -> brand gold.
  "#451a03": "#2b1f06",
  "#b45309": "#8a6520",
  "#d39a29": "#c29030", // was already all but the brand value
  "#f59e0b": "#d9ac52",
  "#fbbf24": "#e6c274",
  "#fcd34d": "#eed08d",
  "#fde68a": "#f2dfae",
  "#fef3c7": "#f6ecd3",
  "#fff7ed": "#faf6ea",

  // Teal "selected" state -> gold, so on/off still reads on a green ground.
  "#0f766e": "#8a6520",
  "#134e4a": "#4a3a14",

  // A stray blue wash, folded into the one info wash the palette keeps.
  "#dbeafe": "#e0f2fe",

  // A decorative cyan in one conic gradient; the sweep reads better gold->green.
  "#06b6d4": "#2c5d43",
};

// rgb triples inside rgba(), same mapping applied to translucent layers.
const SLATE_TO_FROOZ_RGB = {
  "2,6,23": "3,17,11",
  "9,12,20": "3,17,11",
  "15,23,42": "8,33,22",
  "17,24,39": "9,35,24",
  "23,32,51": "12,43,29",
  "30,41,59": "18,54,35",
  "51,65,85": "30,74,52",
  "100,116,139": "74,122,97",
  "148,163,184": "143,171,156",
  "245,158,11": "217,172,82",
  "251,191,36": "230,194,116",
};

// --- Pass 2: Frooz -> PEP --------------------------------------------------------
// The PEP logo measures ground #102f20, mustard #eab43f, cream #f6f4e5. The three
// logo roles take those values outright; every other step keeps its old WCAG
// luminance and moves onto the logo's hue (OKLCH), so documented contrasts hold.
// Values that did not move (#cedbd3, #dfe9e2, #eef2ef, #f7f9f7) are not listed.
const FROOZ_TO_PEP_HEX = {
  "#0a2d1c": "#102f20", // BRAND.greenDeep - the logo's ground
  "#123623": "#153525", // BRAND.greenMid / GROUND.card
  "#c29030": "#eab43f", // BRAND.gold / ACCENT.brandGold - the logo's mustard
  "#03110b": "#04100b", // GROUND.abyss
  "#082116": "#0a2017", // GROUND.canvas
  "#092318": "#0b2219", // GROUND.panel
  "#0c2b1d": "#0f2b1e", // GROUND.track
  "#0d2e1f": "#102e20", // GROUND.raised
  "#0f3222": "#123124", // GROUND.raisedHigh
  "#1e4a34": "#224a36", // GROUND.border
  "#2c5d43": "#305c46", // GROUND.borderStrong
  "#4a7a61": "#4e7964", // INK.faint
  "#7aa48f": "#7da391", // INK.placeholder
  "#8fab9c": "#91ab9d", // INK.muted
  "#97ada1": "#98aca2", // INK.mutedWarm
  "#c8d8ce": "#c9d7cf", // INK.body
  "#e2eae5": "#e2e9e5", // INK.brightWarm
  "#f6f3ea": "#f6f4e5", // CREAM / INK.brightest - the logo's cream
  "#e8e3d3": "#e7e4ce", // CREAM_DIM
  "#2b1f06": "#2c1e02", // ACCENT.deepShadow
  "#8a6520": "#896613", // ACCENT.deep
  "#6b4d18": "#6a4e0c", // ACCENT.deepStrong - light theme's working accent
  "#573c11": "#553d07", // ACCENT.deepHover
  "#d9ac52": "#eab43f", // ACCENT.accent - dark theme's working accent is now the mustard itself
  "#4a3a14": "#4e3806", // ACCENT.deepMuted
  "#e6c274": "#facb6c", // ACCENT.bright - lifted, keeps its 1.25:1 step above the brighter accent
  "#eed08d": "#f7cd7e", // ACCENT.soft
  "#f2dfae": "#fbdda4", // ACCENT.softer
  "#efd47f": "#fdcf75", // ACCENT.glow
  "#f6ecd3": "#fbebce", // ACCENT.wash
  "#faf6ea": "#fdf6e8", // ACCENT.washWarm
};

const FROOZ_TO_PEP_RGB = {
  "10,45,28": "16,47,32", // BRAND.greenDeep
  "18,54,35": "21,53,37", // BRAND.greenMid / GROUND.card
  "194,144,48": "234,180,63", // BRAND.gold
  "3,17,11": "4,16,11", // GROUND.abyss
  "8,33,22": "10,32,23", // GROUND.canvas
  "9,35,24": "11,34,25", // GROUND.panel
  "12,43,29": "15,43,30", // GROUND.track
  "13,46,31": "16,46,32", // GROUND.raised
  "15,50,34": "18,49,36", // GROUND.raisedHigh
  "30,74,52": "34,74,54", // GROUND.border
  "44,93,67": "48,92,70", // GROUND.borderStrong
  "74,122,97": "78,121,100", // INK.faint
  "122,164,143": "125,163,145", // INK.placeholder
  "143,171,156": "145,171,157", // INK.muted
  "151,173,161": "152,172,162", // INK.mutedWarm
  "200,216,206": "201,215,207", // INK.body
  "226,234,229": "226,233,229", // INK.brightWarm
  "246,243,234": "246,244,229", // CREAM
  "232,227,211": "231,228,206", // CREAM_DIM
  "43,31,6": "44,30,2", // ACCENT.deepShadow
  "138,101,32": "137,102,19", // ACCENT.deep
  "107,77,24": "106,78,12", // ACCENT.deepStrong
  "87,60,17": "85,61,7", // ACCENT.deepHover
  "217,172,82": "234,180,63", // ACCENT.accent
  "74,58,20": "78,56,6", // ACCENT.deepMuted
  "230,194,116": "250,203,108", // ACCENT.bright
  "238,208,141": "247,205,126", // ACCENT.soft
  "242,223,174": "251,221,164", // ACCENT.softer
  "239,212,127": "253,207,117", // ACCENT.glow
  "246,236,211": "251,235,206", // ACCENT.wash
  "250,246,234": "253,246,232", // ACCENT.washWarm
};

const PASSES = [
  { name: "slate -> Frooz", hex: SLATE_TO_FROOZ_HEX, rgb: SLATE_TO_FROOZ_RGB },
  { name: "Frooz -> PEP", hex: FROOZ_TO_PEP_HEX, rgb: FROOZ_TO_PEP_RGB },
];

// Idempotency: a final value must never be a key of any pass, or a second run would
// move it again. The final values are the last pass's outputs.
const last = PASSES[PASSES.length - 1];
for (const pass of PASSES) {
  for (const value of Object.values(last.hex)) {
    if (value in pass.hex) throw new Error(`${value} is a final colour and a key of ${pass.name}`);
  }
  for (const value of Object.values(last.rgb)) {
    if (value in pass.rgb) throw new Error(`rgb(${value}) is a final colour and a key of ${pass.name}`);
  }
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const files = args.filter((arg) => !arg.startsWith("--"));
const TARGETS = files.length ? files : DEFAULT_TARGETS;
const rgbPattern = /(rgba?\(\s*)(\d+)(\s*,\s*)(\d+)(\s*,\s*)(\d+)/g;

let totalHex = 0;
let totalRgb = 0;
let changedFiles = 0;

for (const relative of TARGETS) {
  const path = join(repoRoot, relative);
  const before = readFileSync(path, "utf8");
  let after = before;
  let hexHits = 0;
  let rgbHits = 0;

  for (const pass of PASSES) {
    const hexPattern = new RegExp(`(${Object.keys(pass.hex).join("|")})\\b`, "gi");
    after = after.replace(hexPattern, (match) => {
      hexHits += 1;
      return pass.hex[match.toLowerCase()];
    });
    after = after.replace(rgbPattern, (match, open, r, s1, g, s2, b) => {
      const mapped = pass.rgb[`${r},${g},${b}`];
      if (!mapped) return match;
      rgbHits += 1;
      const [nr, ng, nb] = mapped.split(",");
      return `${open}${nr}${s1}${ng}${s2}${nb}`;
    });
  }

  totalHex += hexHits;
  totalRgb += rgbHits;
  if (after !== before) {
    changedFiles += 1;
    if (!check) writeFileSync(path, after);
  }
  console.log(`${relative}: ${hexHits} colour values, ${rgbHits} translucent layers`);
}

console.log(
  `${check ? "would rewrite" : "rewrote"} ${changedFiles} file(s): ` +
    `${totalHex} colour values, ${totalRgb} translucent layers`,
);
