"use strict";

/**
 * Every module the server needs must actually reach the container.
 *
 * ## What happened
 *
 * `backend/Dockerfile` copied eight files by name. Every backend module written after that line was
 * added — eleven of them by 2026-09-05, including `passwordHash.js` and `sessionSecret.js` — was
 * absent from the image. The container died on its first `require` with
 * `Cannot find module './passwordHash'`, never opened a port, failed Railway's health check, and
 * Railway kept the previous image.
 *
 * The shop's cloud therefore ran code from **2026-07-12 until 2026-09-05**. Every release in
 * between looked deployed and none of it ever ran. Railway reported "Deployment successful",
 * because the *build* had genuinely succeeded; only the health check knew, and it only said
 * "service unavailable".
 *
 * ## Why it stayed hidden for two months
 *
 * Nothing in the ordinary workflow touches a Dockerfile. Splitting a module out of a 19k-line
 * `server.js` is exactly the change this repository encourages, every gate passes on it, and the
 * failure appears somewhere else entirely — as a feature that "should work" not working, weeks
 * later, in an app nobody suspects is talking to two-month-old code. Most of 2026-09-05 went into
 * looking for the reason in the app, the connection settings, and the network, in that order.
 *
 * ## What is pinned here
 *
 * The invariant is not "the list is up to date" — a list that must be maintained by hand will go
 * stale again, and the next person will not know to check it either. The invariant is that **there
 * is no list**: the image takes the directory, and `.dockerignore` decides what stays out. Adding a
 * module is not a deployment decision and must never silently become one.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BACKEND = __dirname;
const DOCKERFILE = fs.readFileSync(path.join(BACKEND, "Dockerfile"), "utf8");

/** Every local module `server.js` pulls in, transitively. */
const requiredModules = () => {
  const seen = new Set();
  const queue = ["server"];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const file = path.join(BACKEND, `${name}.js`);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(/require\("\.\/([a-zA-Z0-9_-]+)"\)/g)) {
      queue.push(match[1]);
    }
  }
  seen.delete("server");
  return [...seen].sort();
};

test("the image is built from the directory, not from a hand-written list of files", () => {
  // The whole failure in one assertion. A selective COPY is not a smaller version of this — it is a
  // different thing, one that goes wrong quietly every time the backend gains a file.
  assert.match(
    DOCKERFILE,
    /^COPY --chown=node:node \. \.\/$/m,
    "the Dockerfile must copy the backend directory wholesale",
  );

  const copyLines = DOCKERFILE.split("\n").filter((line) => line.trimStart().startsWith("COPY"));
  const selective = copyLines.filter((line) => /\b[a-zA-Z0-9_-]+\.js\b/.test(line));
  assert.deepEqual(
    selective,
    [],
    `no COPY may name a .js file — that is the list that went stale:\n${selective.join("\n")}`,
  );
});

test("every module the server requires exists and would be copied", () => {
  // Belt and braces, and cheap. If the COPY rule above is ever loosened, this still catches the
  // specific shape of the outage: a module that server.js needs and the image does not have.
  const modules = requiredModules();
  assert.ok(modules.length > 5, "sanity: the requires could not be parsed at all");

  const ignored = fs.readFileSync(path.join(BACKEND, ".dockerignore"), "utf8")
    .split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));

  for (const name of modules) {
    const file = `${name}.js`;
    assert.ok(fs.existsSync(path.join(BACKEND, file)), `${file} is required but does not exist`);
    // A runtime module must never match an ignore rule. `*.test.js` is in there deliberately, so a
    // module named like a test would be excluded from the image and nothing would say so.
    assert.equal(
      ignored.some((rule) => rule === file || (rule.startsWith("*") && file.endsWith(rule.slice(1)))),
      false,
      `${file} is required at runtime but .dockerignore would keep it out of the image`,
    );
  }
});

test("the modules that were missing are specifically covered", () => {
  // Named rather than left to the general rule, because these eleven are the evidence: each was
  // required by a server that could not start, on a cloud that reported itself healthy.
  const modules = new Set(requiredModules());
  for (const name of [
    "passwordHash",
    "sessionSecret",
    "authMiddleware",
    "deviceSession",
    "loginLockout",
    "ownerBootstrapPolicy",
    "publicRouteThrottle",
    "operationalScope",
    "operationalV3",
    "allBranchesSummary",
    "syncReferenceBootstrap",
  ]) {
    assert.ok(modules.has(name), `${name} is no longer required — remove it from this list on purpose`);
    assert.ok(fs.existsSync(path.join(BACKEND, `${name}.js`)), `${name}.js must exist`);
  }
});

test("the start command runs the file the image actually contains", () => {
  // `railway.json` names `node server.js` and the Dockerfile's WORKDIR is /app, which is where the
  // MODULE_NOT_FOUND stack said server.js was. Those two must keep agreeing: a start command
  // pointing at a path the image does not have fails in the same silent way.
  assert.match(DOCKERFILE, /^WORKDIR \/app$/m);
  const railway = JSON.parse(fs.readFileSync(path.join(BACKEND, "railway.json"), "utf8"));
  assert.match(railway.deploy.startCommand, /server\.js$/);
  assert.equal(railway.deploy.healthcheckPath, "/api/health", "the health check is the only thing that noticed");
});
