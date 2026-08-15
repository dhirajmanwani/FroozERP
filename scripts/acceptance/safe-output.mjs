import { randomUUID } from "node:crypto";
import { constants as fsConstants, existsSync, realpathSync, statSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export function isPathInside(root, candidate, { allowRoot = false } = {}) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === "") return allowRoot;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function resolveAcceptanceReportPath({ report, fixtureRoot, evidenceRoot, repoRoot }) {
  const resolvedReport = path.resolve(report);
  const resolvedFixtureRoot = path.resolve(fixtureRoot);
  const resolvedRepoRoot = path.resolve(repoRoot);
  const allowedRoots = [resolvedFixtureRoot];

  if (evidenceRoot) {
    const resolvedEvidenceRoot = path.resolve(evidenceRoot);
    const excludedEvidenceRoot = path.join(resolvedRepoRoot, ".cache");
    if (!isPathInside(excludedEvidenceRoot, resolvedEvidenceRoot, { allowRoot: true })) {
      throw new Error("--evidence-root must be the repository's excluded .cache directory or one of its descendants.");
    }
    allowedRoots.push(resolvedEvidenceRoot);
  }

  const selectedRoot = allowedRoots.find((root) => isPathInside(root, resolvedReport));
  if (!selectedRoot) {
    throw new Error("Acceptance report must be inside the disposable fixture root or the explicitly supplied excluded evidence root.");
  }
  if (!existsSync(selectedRoot) || !statSync(selectedRoot).isDirectory()) {
    throw new Error(`Acceptance output root must already exist as a directory: ${selectedRoot}`);
  }
  let existingParent = path.dirname(resolvedReport);
  while (!existsSync(existingParent)) {
    const next = path.dirname(existingParent);
    if (next === existingParent) throw new Error("Could not resolve an existing acceptance output parent.");
    existingParent = next;
  }
  const realRoot = realpathSync(selectedRoot);
  const realParent = realpathSync(existingParent);
  if (!isPathInside(realRoot, realParent, { allowRoot: true })) {
    throw new Error("Acceptance report parent resolves outside the allowed output root.");
  }
  return resolvedReport;
}

export async function writeNewJsonAtomically(filePath, value) {
  const parent = path.dirname(filePath);
  await fsp.mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fsp.copyFile(temporary, filePath, fsConstants.COPYFILE_EXCL);
  } finally {
    await fsp.rm(temporary, { force: true });
  }
}
