#!/usr/bin/env node
// One-shot: moves the app's stylesheets off the borrowed slate-navy palette and
// onto the brand's own greens and gold.
//
// This is a family swap, not a redesign. Every slate value is replaced by a green
// of the same lightness, and every generic amber by the brand gold, so nothing
// about contrast, hierarchy or layout changes - only the hue. Semantic colours
// (error red, success green, the assistant's severity ramp) are deliberately left
// alone; an error rendered in the brand's own colour is an error nobody sees.
//
// Kept in the repo rather than run and deleted, so the mapping is auditable and a
// future stylesheet can be brought onto the palette the same way.
//
// Run: node tools/apply-brand-palette.mjs [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = ["frontend/src/App.css", "frontend/src/index.css", "frontend/index.html"];

// old value -> new value. Comment says the role, because the hex says nothing.
const HEX = {
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
const RGB = {
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

const check = process.argv.includes("--check");
const hexPattern = new RegExp(`(${Object.keys(HEX).join("|")})\\b`, "gi");
const rgbPattern = /(rgba?\(\s*)(\d+)(\s*,\s*)(\d+)(\s*,\s*)(\d+)/g;

let totalHex = 0;
let totalRgb = 0;
let changedFiles = 0;

for (const relative of TARGETS) {
  const path = join(repoRoot, relative);
  const before = readFileSync(path, "utf8");

  let hexHits = 0;
  let after = before.replace(hexPattern, (match) => {
    hexHits += 1;
    return HEX[match.toLowerCase()];
  });

  let rgbHits = 0;
  after = after.replace(rgbPattern, (match, open, r, s1, g, s2, b) => {
    const mapped = RGB[`${r},${g},${b}`];
    if (!mapped) return match;
    rgbHits += 1;
    const [nr, ng, nb] = mapped.split(",");
    return `${open}${nr}${s1}${ng}${s2}${nb}`;
  });

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
