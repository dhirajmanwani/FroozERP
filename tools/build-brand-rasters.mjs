#!/usr/bin/env node
// Renders the app icon at every size Windows and the web manifest ask for, from
// the same vector mark the app itself uses.
//
// The icon is the mark on a deep-green tile rather than the mark alone: a desktop
// icon has to hold its own against whatever wallpaper is behind it, and the mark
// is a single-colour cream shape with nothing to sit on.
//
// Drawing happens on a canvas inside the browser and comes back out as data URIs,
// rather than through --screenshot. Headless Chromium's --window-size sets the
// window, not the viewport, and it clamps width to 500px, so screenshots of small
// tiles come back cropped. A canvas is exactly the size it is told to be.
//
// Needs a Chromium binary. Set CHROME_PATH, or let it find the usual names.
// Run: node tools/build-brand-rasters.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { BRAND } from "../frontend/src/local/brandPalette.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const brandingDir = join(repoRoot, "frontend", "public", "branding");
const iconsDir = join(repoRoot, "src-tauri", "icons");

// Values come from the palette module rather than being retyped here.
const GREEN_DEEP = BRAND.greenDeep;
const GREEN_MID = BRAND.greenMid;
const GOLD = BRAND.gold;

const SIZES = [16, 32, 48, 64, 128, 192, 256, 512];

const OUTPUTS = [
  ["frontend/public/branding/frooz-icon-64.png", 64],
  ["frontend/public/branding/frooz-icon-192.png", 192],
  ["frontend/public/branding/frooz-icon-512.png", 512],
  ["src-tauri/icons/32x32.png", 32],
  ["src-tauri/icons/128x128.png", 128],
  ["src-tauri/icons/128x128@2x.png", 256],
  ["src-tauri/icons/icon.png", 512],
];

const ICO_SIZES = [16, 32, 48, 64, 128, 256];

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      "no Chromium found. Set CHROME_PATH to a Chrome, Chromium or Edge binary and re-run.",
    );
  }
  return found;
}

const markSvg = readFileSync(join(brandingDir, "frooz-mark-reversed.svg"), "utf8");
const markDataUri = `data:image/svg+xml;base64,${Buffer.from(markSvg).toString("base64")}`;

// Proportions are fractions of the tile, so every size is the same design rather
// than one design scaled badly.
const drawPage = `<!doctype html><html><body><pre id="out"></pre><script>
const SIZES = ${JSON.stringify(SIZES)};
const mark = new Image();
mark.onload = () => {
  const results = [];
  for (const size of SIZES) {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    const radius = size * 0.22;

    const fill = ctx.createLinearGradient(0, 0, size, size);
    fill.addColorStop(0, ${JSON.stringify(GREEN_MID)});
    fill.addColorStop(1, ${JSON.stringify(GREEN_DEEP)});
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, radius);
    ctx.fillStyle = fill;
    ctx.fill();

    // A gold hairline just inside the edge, so the tile has an edge on a dark
    // wallpaper as well as a light one.
    const hairline = Math.max(1, size / 64);
    ctx.beginPath();
    ctx.roundRect(hairline / 2, hairline / 2, size - hairline, size - hairline, radius - hairline / 2);
    ctx.strokeStyle = ${JSON.stringify(GOLD)};
    ctx.globalAlpha = 0.38;
    ctx.lineWidth = hairline;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // The mark, centred, inside a margin that keeps it clear of the rounded corners.
    // Small tiles get a tighter margin: at 32px a generous one leaves the glyph
    // too small to recognise on a taskbar.
    const inset = Math.round(size * (size <= 48 ? 0.11 : 0.19));
    const box = size - inset * 2;
    const scale = Math.min(box / mark.naturalWidth, box / mark.naturalHeight);
    const width = mark.naturalWidth * scale;
    const height = mark.naturalHeight * scale;
    ctx.drawImage(mark, (size - width) / 2, (size - height) / 2, width, height);

    results.push(size + " " + canvas.toDataURL("image/png"));
  }
  document.getElementById("out").textContent = results.join("\\n");
};
mark.src = ${JSON.stringify(markDataUri)};
</script></body></html>`;

const work = join(tmpdir(), `frooz-rasters-${process.pid}`);
mkdirSync(work, { recursive: true });
const page = join(work, "draw.html");
writeFileSync(page, drawPage);

const dom = execFileSync(
  findChrome(),
  [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--virtual-time-budget=8000",
    "--dump-dom",
    page,
  ],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
);

const block = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!block) throw new Error("the render page produced no output - is the Chromium binary usable?");

const rendered = new Map();
for (const line of block[1].trim().split("\n")) {
  const [size, uri] = line.trim().split(" ");
  const base64 = (uri || "").replace("data:image/png;base64,", "");
  if (!base64) throw new Error(`no image came back for size ${size}`);
  rendered.set(Number(size), Buffer.from(base64, "base64"));
}
for (const size of SIZES) {
  const png = rendered.get(size);
  if (!png) throw new Error(`size ${size} missing from the render`);
  // Read the PNG's own IHDR rather than trusting the label on it.
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== size || height !== size) {
    throw new Error(`size ${size} came back as ${width}x${height}`);
  }
}

/**
 * Packs PNGs into a Windows .ico. The format is a small directory followed by the
 * image payloads; Windows has accepted PNG payloads since Vista, and Windows is
 * the only target this app ships to.
 */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach(({ size, png }, index) => {
    const at = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, at + 0); // 0 means 256
    directory.writeUInt8(size >= 256 ? 0 : size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size, 0 for truecolour
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)]);
}

for (const [relative, size] of OUTPUTS) {
  writeFileSync(join(repoRoot, relative), rendered.get(size));
  console.log(`${relative}  ${size}x${size}`);
}

writeFileSync(
  join(iconsDir, "icon.ico"),
  buildIco(ICO_SIZES.map((size) => ({ size, png: rendered.get(size) }))),
);
console.log(`src-tauri/icons/icon.ico  ${ICO_SIZES.join(", ")}`);

rmSync(work, { recursive: true, force: true });
