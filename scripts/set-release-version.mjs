import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const nextVersion = process.argv[2];

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(nextVersion || "")) {
  console.error("Usage: npm run release:set-version -- 1.0.31");
  process.exit(1);
}

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));
const writeJson = (filePath, data) => {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
};

const rootPackagePath = path.join(root, "package.json");
const frontendPackagePath = path.join(root, "frontend", "package.json");
const tauriConfigPath = path.join(root, "src-tauri", "tauri.conf.json");
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const appPath = path.join(root, "frontend", "src", "App.jsx");

for (const filePath of [rootPackagePath, frontendPackagePath, tauriConfigPath, cargoPath, appPath]) {
  if (!fs.existsSync(filePath)) {
    console.error(`Missing expected version file: ${filePath}`);
    process.exit(1);
  }
}

const rootPackage = readJson(rootPackagePath);
rootPackage.version = nextVersion;
writeJson(rootPackagePath, rootPackage);

const frontendPackage = readJson(frontendPackagePath);
frontendPackage.version = nextVersion;
writeJson(frontendPackagePath, frontendPackage);

const tauriConfig = readJson(tauriConfigPath);
tauriConfig.version = nextVersion;
writeJson(tauriConfigPath, tauriConfig);

let cargoToml = fs.readFileSync(cargoPath, "utf8");
cargoToml = cargoToml.replace(/^version = ".*"$/m, `version = "${nextVersion}"`);
fs.writeFileSync(cargoPath, cargoToml);

let appSource = fs.readFileSync(appPath, "utf8");
appSource = appSource.replace(/const APP_VERSION = ".*?";/, `const APP_VERSION = "${nextVersion}";`);
fs.writeFileSync(appPath, appSource);

console.log(`FroozERP release version set to ${nextVersion}`);
