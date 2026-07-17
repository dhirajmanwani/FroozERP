import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const tauriConfigPath = path.join(root, "src-tauri", "tauri.conf.json");
const rootPackagePath = path.join(root, "package.json");
const backendPackagePath = path.join(root, "backend", "package.json");
const frontendPackagePath = path.join(root, "frontend", "package.json");
const hookPath = path.join(root, "src-tauri", "installer", "froozerp-cleanup-hooks.nsh");
const appDataDir = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"), "com.srtcompany.froozerp");
const installDir = path.join(process.env.ProgramFiles || "C:\\Program Files", "FroozERP");

const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, "utf8"));
const releaseVersions = {
  workspace: JSON.parse(fs.readFileSync(rootPackagePath, "utf8")).version,
  backend: JSON.parse(fs.readFileSync(backendPackagePath, "utf8")).version,
  frontend: JSON.parse(fs.readFileSync(frontendPackagePath, "utf8")).version,
  tauri: tauriConfig.version,
};
const hook = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : "";
const forbiddenPatterns = [
  /froozerp-local\.sqlite3/i,
  /Remove-Item/i,
  /RMDir\s+["']?\$APPDATA/i,
  /Delete\s+["']?\$APPDATA/i,
  /com\.srtcompany\.froozerp.*RMDir/i,
  /com\.srtcompany\.froozerp.*Delete/i,
];

const failures = [];
const warnings = [];
if (tauriConfig.identifier !== "com.srtcompany.froozerp") {
  failures.push(`Unexpected app identifier: ${tauriConfig.identifier}`);
}
if (!tauriConfig.bundle?.createUpdaterArtifacts) {
  failures.push("Tauri updater artifacts are not enabled.");
}
if (new Set(Object.values(releaseVersions)).size !== 1) {
  failures.push(`Release versions are inconsistent: ${JSON.stringify(releaseVersions)}`);
}
if (tauriConfig.plugins?.updater?.windows?.installMode !== "quiet") {
  failures.push("Windows in-app updater installMode must be quiet so no external installer window is left open.");
}
if (!tauriConfig.plugins?.updater?.pubkey || /REPLACE_WITH/i.test(tauriConfig.plugins.updater.pubkey)) {
  const message = "Tauri updater public key is not configured.";
  if (process.env.CI === "true" || process.env.FROOZERP_REQUIRE_UPDATER_KEY === "1") {
    failures.push(message);
  } else {
    warnings.push(message);
  }
}
for (const pattern of forbiddenPatterns) {
  if (pattern.test(hook)) {
    failures.push(`Installer hook contains unsafe app-data deletion pattern: ${pattern}`);
  }
}
if (path.resolve(appDataDir).toLowerCase().startsWith(path.resolve(installDir).toLowerCase())) {
  failures.push(`App data directory is inside install directory: ${appDataDir}`);
}

if (failures.length) {
  console.error("Update safety verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  identifier: tauriConfig.identifier,
  version: tauriConfig.version,
  releaseVersions,
  installDir,
  appDataDir,
  preservedData: [
    "SQLite database",
    "device identity",
    "offline sync queue",
    "user settings",
    "printer settings",
    "weighing-scale settings",
    "branch configuration",
    "backup configuration",
  ],
  warnings,
}, null, 2));
