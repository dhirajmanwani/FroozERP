import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const reportPath = path.join(root, ".cache", "production-verification-report.json");
const commands = [
  ["Backend syntax", "node --check backend/server.js && node --check backend/desktopGateway.js && node --check backend/localSettingsStore.js && node --check backend/storageAdapters.js"],
  ["Backend tests", "npm --prefix backend test"],
  ["Frontend local runtime tests", "npm --prefix frontend run test:local-runtime"],
  ["Frontend lint", "npm --prefix frontend run lint"],
  ["Frontend production build", "npm --prefix frontend run build"],
  ["Update Center static tests", "node scripts/update-center-static-tests.mjs"],
  ["Production regression static tests", "node scripts/production-regression-static-tests.mjs"],
  ["Updater safety", "npm run verify:update-safety"],
  ["Rust tests", "cargo test --manifest-path src-tauri/Cargo.toml --lib -- --test-threads=1"],
  ["Rust check", "cargo check --manifest-path src-tauri/Cargo.toml"],
  ["Whitespace check", "git diff --check"],
];

const startedAt = new Date().toISOString();
const results = [];
for (const [name, command] of commands) {
  const started = Date.now();
  process.stdout.write(`\n[verify:production] ${name}\n`);
  const result = spawnSync(command, {
    cwd: root,
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10 * 60 * 1000,
  });
  const entry = {
    name,
    command,
    passed: result.status === 0 && !result.error,
    exitCode: result.status,
    durationMs: Date.now() - started,
    stdout: String(result.stdout || "").trim().slice(-12000),
    stderr: String(result.stderr || "").trim().slice(-12000),
    error: result.error?.message || "",
  };
  results.push(entry);
  process.stdout.write(`${entry.passed ? "PASS" : "FAIL"} (${entry.durationMs} ms)\n`);
  if (!entry.passed) {
    if (entry.stdout) process.stdout.write(`${entry.stdout}\n`);
    if (entry.stderr) process.stderr.write(`${entry.stderr}\n`);
    break;
  }
}

const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  passed: results.length === commands.length && results.every((entry) => entry.passed),
  results,
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\nProduction verification: ${report.passed ? "PASS" : "FAIL"}`);
console.log(`Machine-readable report: ${reportPath}`);
if (!report.passed) process.exit(1);
