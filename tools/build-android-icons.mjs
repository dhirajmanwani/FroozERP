#!/usr/bin/env node
// Renders the Android launcher icon from the same vector mark the desktop icon uses
// (4 Oct 2026).
//
// `tauri android init` writes Tauri's own placeholder icon into the generated project, and that
// project is regenerated on every CI run, so the phone showed a different icon from every other
// FroozERP surface. The resources rendered here are committed under src-tauri/icons/android/ and
// copied over the placeholders by scripts/android/patch-android-project.mjs.
//
// What Android needs:
//   - ic_launcher.png         the legacy square icon (Android 7 and older launchers): the desktop
//                             tile, mark on a deep-green rounded square.
//   - ic_launcher_round.png   the legacy round icon: the same, on a circle.
//   - ic_launcher_foreground  the adaptive icon's top layer (Android 8+): the mark alone on a
//                             transparent 108dp canvas, kept inside the 66dp safe zone so no
//                             launcher mask (circle, squircle, teardrop) can cut it.
//   - ic_launcher_background  the adaptive icon's bottom layer: the brand deep green.
//
// Drawing happens on a canvas inside headless Chromium, as tools/build-brand-rasters.mjs does.
// Needs a Chromium binary: set CHROME_PATH, or let it find the usual names.
// Run: node tools/build-android-icons.mjs

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BRAND } from "../frontend/src/local/brandPalette.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const brandingDir = join(repoRoot, "frontend", "public", "branding");
const outDir = join(repoRoot, "src-tauri", "icons", "android");

// Launcher icon is 48dp; the adaptive layers are 108dp. Pixels per density bucket.
const DENSITIES = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
];

const jobs = [];
for (const [density, factor] of DENSITIES) {
  jobs.push({ file: `mipmap-${density}/ic_launcher.png`, size: Math.round(48 * factor), shape: "tile" });
  jobs.push({ file: `mipmap-${density}/ic_launcher_round.png`, size: Math.round(48 * factor), shape: "round" });
  jobs.push({ file: `mipmap-${density}/ic_launcher_foreground.png`, size: Math.round(108 * factor), shape: "foreground" });
}

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
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("no Chromium found. Set CHROME_PATH to a Chrome, Chromium or Edge binary and re-run.");
  return found;
}

const markSvg = readFileSync(join(brandingDir, "frooz-mark-reversed.svg"), "utf8");
const markDataUri = `data:image/svg+xml;base64,${Buffer.from(markSvg).toString("base64")}`;

const drawPage = `<!doctype html><html><body><pre id="out"></pre><script>
const JOBS = ${JSON.stringify(jobs)};
const mark = new Image();
mark.onload = () => {
  const results = [];
  for (const job of JOBS) {
    const size = job.size;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    let markBox;
    if (job.shape === "foreground") {
      // The 66dp safe zone is a circle of diameter 66/108 of the canvas. A square that fits in
      // it is 66/108/sqrt(2) = 43% of the canvas; the mark is a little taller than wide, so
      // 46% of the canvas still keeps every corner inside.
      markBox = size * 0.46;
    } else {
      const fill = ctx.createLinearGradient(0, 0, size, size);
      fill.addColorStop(0, ${JSON.stringify(BRAND.greenMid)});
      fill.addColorStop(1, ${JSON.stringify(BRAND.greenDeep)});
      ctx.beginPath();
      if (job.shape === "round") ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
      else ctx.roundRect(0, 0, size, size, size * 0.22);
      ctx.fillStyle = fill;
      ctx.fill();
      const hairline = Math.max(1, size / 64);
      ctx.beginPath();
      if (job.shape === "round") ctx.arc(size / 2, size / 2, size / 2 - hairline / 2, 0, Math.PI * 2);
      else ctx.roundRect(hairline / 2, hairline / 2, size - hairline, size - hairline, size * 0.22 - hairline / 2);
      ctx.strokeStyle = ${JSON.stringify(BRAND.gold)};
      ctx.globalAlpha = 0.38;
      ctx.lineWidth = hairline;
      ctx.stroke();
      ctx.globalAlpha = 1;
      markBox = size * (job.shape === "round" ? 0.56 : 0.62);
    }
    const scale = Math.min(markBox / mark.naturalWidth, markBox / mark.naturalHeight);
    const width = mark.naturalWidth * scale;
    const height = mark.naturalHeight * scale;
    ctx.drawImage(mark, (size - width) / 2, (size - height) / 2, width, height);
    results.push(job.file + " " + canvas.toDataURL("image/png"));
  }
  document.getElementById("out").textContent = results.join("\\n");
};
mark.src = ${JSON.stringify(markDataUri)};
</script></body></html>`;

const work = join(tmpdir(), `frooz-android-icons-${process.pid}`);
mkdirSync(work, { recursive: true });
const page = join(work, "draw.html");
writeFileSync(page, drawPage);
const dom = execFileSync(
  findChrome(),
  ["--headless", "--disable-gpu", "--no-sandbox", "--virtual-time-budget=8000", "--dump-dom", page],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
);
rmSync(work, { recursive: true, force: true });

const block = dom.match(/<pre id="out">([\s\S]*?)<\/pre>/);
if (!block) throw new Error("the render page produced no output - is the Chromium binary usable?");
const rendered = new Map();
for (const line of block[1].trim().split("\n")) {
  const [file, uri] = line.trim().split(" ");
  rendered.set(file, Buffer.from((uri || "").replace("data:image/png;base64,", ""), "base64"));
}

rmSync(outDir, { recursive: true, force: true });
for (const job of jobs) {
  const png = rendered.get(job.file);
  if (!png || png.length < 24) throw new Error(`${job.file} did not render`);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== job.size || height !== job.size) throw new Error(`${job.file} came back as ${width}x${height}`);
  mkdirSync(dirname(join(outDir, job.file)), { recursive: true });
  writeFileSync(join(outDir, job.file), png);
  console.log(`src-tauri/icons/android/${job.file}  ${job.size}x${job.size}`);
}

const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/ic_launcher_background"/>
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
mkdirSync(join(outDir, "mipmap-anydpi-v26"), { recursive: true });
writeFileSync(join(outDir, "mipmap-anydpi-v26", "ic_launcher.xml"), adaptive);
writeFileSync(join(outDir, "mipmap-anydpi-v26", "ic_launcher_round.xml"), adaptive);
mkdirSync(join(outDir, "values"), { recursive: true });
writeFileSync(join(outDir, "values", "ic_launcher_background.xml"), `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <color name="ic_launcher_background">${BRAND.greenDeep}</color>
</resources>
`);
console.log("src-tauri/icons/android/mipmap-anydpi-v26/ic_launcher{,_round}.xml, values/ic_launcher_background.xml");
