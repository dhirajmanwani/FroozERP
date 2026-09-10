import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * A dev server running permanently offline must say so.
 *
 * The build refuses `VITE_API_MODE=LOCAL_ONLY`, because that value once shipped to the shop out of
 * a `.env.local` written months earlier and cost two days. The refusal was deliberately limited to
 * `build`, on the reasoning that a dev server is somebody at a keyboard who can change it back in a
 * second.
 *
 * That reasoning had a hole, and the first rehearsal after the guard landed fell straight into it.
 * `npm run app:disposable` is a dev server -- and it is the rehearsal that stands between a change
 * and every counter in the shop. In LOCAL_ONLY the app cannot reach the cloud, so signing in fails
 * with nothing on screen to explain it. The person at the keyboard can indeed change it back in a
 * second, once they know it is set. Nobody did; that is the whole history of this bug.
 *
 * So dev warns rather than refuses -- running deliberately offline is a real thing to want, and
 * refusing would only teach people to set the acknowledgement permanently -- and the warning names
 * the file, because "where did this come from" is the part that costs the days.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(here, "..", "..", "vite.config.js");

const runConfig = async ({ files = {}, shell = {}, command, mode = "development" }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-vite-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);

  const config = (await import(pathToFileURL(CONFIG).href)).default;
  const previousCwd = process.cwd();
  const previousWarn = console.warn;
  const warnings = [];
  const restoreEnv = {};
  for (const [key, value] of Object.entries(shell)) {
    restoreEnv[key] = process.env[key];
    process.env[key] = value;
  }
  console.warn = (...args) => warnings.push(args.join(" "));
  process.chdir(dir);
  try {
    config({ command, mode });
    return { warnings, threw: null };
  } catch (error) {
    return { warnings, threw: error };
  } finally {
    process.chdir(previousCwd);
    console.warn = previousWarn;
    for (const [key, value] of Object.entries(restoreEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test("a dev server in LOCAL_ONLY warns, and does not refuse", async () => {
  const { warnings, threw } = await runConfig({
    files: { ".env.local": "VITE_API_MODE=LOCAL_ONLY\n" },
    command: "serve",
  });
  assert.equal(threw, null, "dev must still start -- running offline on purpose is legitimate");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /LOCAL_ONLY/);
  assert.match(warnings[0], /signing in/i, "it must name the symptom somebody will actually hit");
});

test("the warning says which file set it", async () => {
  // Without this it is a warning that a thing is true, which was never the hard part.
  const { warnings } = await runConfig({
    files: { ".env.local": "VITE_API_MODE=LOCAL_ONLY\n" },
    command: "serve",
  });
  assert.match(warnings[0], /\.env\.local/);
});

test("a value from the shell is named as the shell, not blamed on a file", async () => {
  const { warnings } = await runConfig({
    files: {},
    shell: { VITE_API_MODE: "LOCAL_ONLY" },
    command: "serve",
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /shell/i);
});

test("a healthy dev server says nothing", async () => {
  // The shape of a warning that gets ignored: one that appears on every run.
  for (const files of [{}, { ".env.local": "VITE_LOCAL_API_URL=http://127.0.0.1:5000\n" }]) {
    const { warnings, threw } = await runConfig({ files, command: "serve" });
    assert.equal(threw, null);
    assert.deepEqual(warnings, [], `expected silence for ${JSON.stringify(files)}`);
  }
});

test("the build still refuses, which is the stronger rule", async () => {
  const { threw } = await runConfig({
    files: { ".env.local": "VITE_API_MODE=LOCAL_ONLY\n" },
    command: "build",
    mode: "production",
  });
  assert.notEqual(threw, null, "a build must never bake a permanently offline app");
  assert.match(threw.message, /permanently/);
});

test("a healthy build is not refused", async () => {
  const { threw } = await runConfig({ files: {}, command: "build", mode: "production" });
  assert.equal(threw, null);
});
