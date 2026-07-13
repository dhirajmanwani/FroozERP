import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const channel = (process.env.FROOZERP_UPDATE_CHANNEL || process.argv[2] || "stable").toLowerCase();
const allowedChannels = new Set(["stable", "beta"]);

if (!allowedChannels.has(channel)) {
  console.error("FROOZERP_UPDATE_CHANNEL must be stable or beta.");
  process.exit(1);
}

const tauriConfig = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = tauriConfig.version;
const releaseDir = path.join(root, "release", "windows");
const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle");
const repo = process.env.GITHUB_REPOSITORY || "dhirajmanwani/FroozERP";
const githubRefType = String(process.env.GITHUB_REF_TYPE || "").toLowerCase();
const githubRefName = String(process.env.GITHUB_REF_NAME || "").trim();
const tag = githubRefType === "tag" && githubRefName ? githubRefName : `v${version}`;

const walk = (dir) => {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
};

const files = [...walk(releaseDir), ...walk(bundleDir)];
const installer = files
  .filter((filePath) => {
    const name = path.basename(filePath);
    return /\.exe$/i.test(filePath) && /FroozERP|froozerp|setup/i.test(name) && name.includes(version);
  })
  .sort((left, right) => {
    return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs;
  })[0];

if (!installer) {
  console.error(`No Windows installer artifact for version ${version} was found. Run npm run build:windows and npm run release:windows first.`);
  process.exit(1);
}

const signaturePath = `${installer}.sig`;
if (!fs.existsSync(signaturePath)) {
  console.error(`Missing updater signature file: ${signaturePath}`);
  console.error("Build with TAURI_SIGNING_PRIVATE_KEY configured. Do not commit the private key.");
  process.exit(1);
}

fs.mkdirSync(releaseDir, { recursive: true });

const installerName = path.basename(installer);
const signature = fs.readFileSync(signaturePath, "utf8").trim();
const notesPath = path.join(root, "release-notes.md");
const notes = fs.existsSync(notesPath)
  ? fs.readFileSync(notesPath, "utf8").trim()
  : `FroozERP ${version} Windows desktop update.`;
const manifestName = channel === "beta" ? "latest-beta.json" : "latest.json";
const manifestPath = path.join(releaseDir, manifestName);
const artifactUrl = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(installerName)}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: artifactUrl,
    },
  },
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(JSON.stringify({
  channel,
  version,
  installer,
  signaturePath,
  manifestPath,
  artifactUrl,
}, null, 2));
