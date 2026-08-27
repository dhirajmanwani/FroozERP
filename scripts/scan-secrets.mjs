#!/usr/bin/env node
/**
 * A-6 Gate 2.2 — prove no credential is committed.
 *
 * The gate said "believed met, unverified", and belief is not a control. This is the thing that
 * verifies it, kept in the repo so it can be re-run before every deploy rather than being a scan
 * somebody did once and remembered.
 *
 *   node scripts/scan-secrets.mjs            # what is committed right now
 *   node scripts/scan-secrets.mjs --history  # every blob that has ever existed
 *
 * The history pass matters more than it sounds. A credential committed and deleted the next day is
 * still in the history and still leaked - deleting a file does not unpublish what was pushed.
 *
 * Exits non-zero on a finding, so it can gate a release.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { argv, exit } from "node:process";

/** Shaped for what this project actually holds, not for a generic checklist. */
const PATTERNS = [
  ["Database URL with a password", /\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:@'"]+:[^\s@'"]{3,}@/gi],
  ["AWS access key id", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_\-]{35}\b/g],
  ["Slack token", /\bxox[abprs]-[0-9A-Za-z-]{10,}/g],
  ["Stripe secret key", /\bsk_(live|test)_[0-9A-Za-z]{16,}/g],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9_\-]{32,}/g],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_\-]{20,}/g],
  ["Meta long-lived access token", /\bEAA[A-Za-z0-9]{40,}/g],
  ["Twilio account sid", /\bAC[0-9a-fA-F]{32}\b/g],
  ["Private key block", /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g],
  ["JSON Web Token", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./g],
  ["Hardcoded password", /\b(password|passwd|pwd)\s*[:=]\s*["'][^"'\s]{8,}["']/gi],
  ["Hardcoded secret or token", /\b(secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[:=]\s*["'][^"'\s]{16,}["']/gi],
];

/**
 * Lines that match a pattern above and are not credentials. Every entry carries its reason,
 * because an unexplained exclusion is how a real finding gets waved through next time.
 */
const NOT_A_SECRET = [
  [/example|placeholder|dummy|sample|your[_-]?(key|token|secret)|xxx+|<[^>]+>/i, "an obvious placeholder"],
  [/process\.env|import\.meta\.env|env\[|getenv|readFileSync/i, "read at runtime, not a literal"],
  [/\.test\.(js|mjs|ts)$|__tests__|routeAuthCoverage|scan-secrets/i, "a test fixture or this scanner"],
  [/user:password@|u:\$\{|someuser:somepassword|DBuser:secret|user:pass@/i, "a documentation example"],
  [/i-accept-owner-password-guessing/, "the Gate 3.3 opt-in phrase, not a credential"],
  // Matched on the exact literal rather than on the word "poison", so a real credential that
  // happens to contain it is still caught.
  [/postgresql:\/\/poison:poison@127\.0\.0\.1:5432\/poison/,
   "the deliberately unusable URL a Rust lifecycle test pins so the spawned backend cannot reach a real database"],
];

const BINARY = /\.(png|jpe?g|gif|svg|woff2?|ico|pdf|zip|exe|dll|ttf|otf|icns|lic)$/i;
const VENDORED = /(^|\/)node_modules\//;

const sh = (command, maxBuffer = 256e6) => execSync(command, { encoding: "utf8", maxBuffer });

const findingsIn = (path, text) => {
  const lines = text.split("\n");
  const found = [];
  for (const [name, pattern] of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const lineNumber = text.slice(0, match.index).split("\n").length;
      const line = lines[lineNumber - 1] || "";
      // The path is tested too: a fixture is a fixture wherever the match lands in it.
      if (NOT_A_SECRET.some(([re]) => re.test(line) || re.test(path))) continue;
      found.push({ path, line: lineNumber, name, sample: match[0].slice(0, 30) });
    }
  }
  return found;
};

/**
 * Scans the files as they are on disk, not as they were committed.
 *
 * The first version of this read `git show HEAD:<file>`, which answers "is a credential already
 * committed" and nothing else - so it could not see one sitting in the working tree about to be
 * committed, which is the only moment anybody can still do something about it. It reported a clean
 * tree with a live database password and a Meta token planted in it. Reading disk covers both:
 * committed content is on disk too, and `--history` covers anything since deleted.
 */
const scanWorkingTree = () => {
  const files = sh("git ls-files").trim().split("\n").filter((f) => f && !BINARY.test(f) && !VENDORED.test(f));
  let findings = [];
  let scanned = 0;
  for (const file of files) {
    let text = "";
    try { text = readFileSync(file, "utf8"); } catch { continue; } // deleted on disk; --history has it
    scanned += 1;
    findings = findings.concat(findingsIn(file, text));
  }
  return { scanned, unit: "files in the working tree", findings };
};

const scanHistory = () => {
  const seen = new Set();
  let findings = [];
  let scanned = 0;
  for (const entry of sh("git rev-list --objects --all", 512e6).trim().split("\n")) {
    const space = entry.indexOf(" ");
    if (space < 0) continue;
    const sha = entry.slice(0, space);
    const path = entry.slice(space + 1);
    if (BINARY.test(path) || VENDORED.test(path) || seen.has(sha)) continue;
    seen.add(sha);
    let text = "";
    try {
      if (Number(sh(`git cat-file -s ${sha}`).trim()) > 2_000_000) continue;
      text = sh(`git cat-file -p ${sha}`);
    } catch { continue; }
    scanned += 1;
    findings = findings.concat(findingsIn(`${path}@${sha.slice(0, 8)}`, text));
  }
  return { scanned, unit: "historical blobs", findings };
};

const history = argv.includes("--history");
const { scanned, unit, findings } = history ? scanHistory() : scanWorkingTree();

console.log(`scanned ${scanned} ${unit}`);
if (findings.length === 0) {
  console.log("No credentials found.");
  exit(0);
}
console.log(`\n${findings.length} finding(s):`);
for (const f of findings) console.log(`  ${f.path}:${f.line}  ${f.name}  ${f.sample}`);
console.log("\nIf one of these is genuinely not a credential, add it to NOT_A_SECRET with its reason.");
exit(1);
