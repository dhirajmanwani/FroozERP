/**
 * A-6 Gate 3.3 — the first-owner bootstrap must not be reachable from the internet.
 *
 * The route authenticates itself, because on a fresh database nobody can sign in. That makes it a
 * password-guessing oracle against the Owner account, and a correct guess ends with the guesser's
 * device approved. A-5 slowed guessing with a lockout; slow is not closed.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  HTTP_BOOTSTRAP_ENV,
  HTTP_BOOTSTRAP_OPT_IN,
  REFUSAL_CODES,
  resolveOwnerBootstrapTransport,
} = require("./ownerBootstrapPolicy");

const backendCode = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");

test("a hosted deployment never serves this over HTTP, whatever the environment says", () => {
  // Structural rather than configurable, on purpose. This codebase already states the principle for
  // the other direction - a hole that closes only when a variable happens to be set is not closed -
  // and it applies just as well to one that opens that way.
  for (const env of [
    {},
    { [HTTP_BOOTSTRAP_ENV]: HTTP_BOOTSTRAP_OPT_IN },
    { [HTTP_BOOTSTRAP_ENV]: "true" },
    { [HTTP_BOOTSTRAP_ENV]: "1" },
  ]) {
    const decision = resolveOwnerBootstrapTransport({ env, deploymentType: "cloud" });
    assert.equal(decision.allowed, false, `hosted must refuse with env ${JSON.stringify(env)}`);
    assert.equal(decision.code, REFUSAL_CODES.HOSTED);
  }
});

test("everywhere else it is closed until somebody opens it deliberately", () => {
  for (const env of [{}, { [HTTP_BOOTSTRAP_ENV]: "" }, { [HTTP_BOOTSTRAP_ENV]: "true" },
                     { [HTTP_BOOTSTRAP_ENV]: "1" }, { [HTTP_BOOTSTRAP_ENV]: "yes" }]) {
    const decision = resolveOwnerBootstrapTransport({ env, deploymentType: "local" });
    assert.equal(decision.allowed, false, `local must default closed with env ${JSON.stringify(env)}`);
    assert.equal(decision.code, REFUSAL_CODES.NOT_ENABLED);
  }
});

test("the opt-in is a sentence, not a toggle, so it cannot be set by reflex", () => {
  const decision = resolveOwnerBootstrapTransport({
    env: { [HTTP_BOOTSTRAP_ENV]: HTTP_BOOTSTRAP_OPT_IN },
    deploymentType: "local",
  });
  assert.equal(decision.allowed, true);
  // Anyone setting this has read what it does.
  assert.match(HTTP_BOOTSTRAP_OPT_IN, /password-guessing/);
});

test("a refusal always says what to do instead", () => {
  for (const deploymentType of ["cloud", "local"]) {
    const decision = resolveOwnerBootstrapTransport({ env: {}, deploymentType });
    assert.match(decision.message, /bootstrap-first-owner\.mjs/,
      "a refusal that names no alternative just strands the operator");
  }
});

test("the route refuses before it reads the body, and long before it checks a password", () => {
  // This ordering is the whole control. A refusal that arrives after the password comparison still
  // answers the attacker's question, through the failed-attempt counter and the lock it trips.
  const handler = backendCode.slice(
    backendCode.indexOf('app.post("/bootstrap/first-owner-device"'),
    backendCode.indexOf('app.post("/bootstrap/first-owner-device"') + 6000,
  );
  const refusalIndex = handler.indexOf("resolveOwnerBootstrapTransport({");
  const bodyIndex = handler.indexOf("req.body.username");
  const passwordIndex = handler.indexOf("checkPassword(password, user.password_hash)");

  assert.ok(refusalIndex > 0, "the handler must consult the transport policy");
  assert.ok(bodyIndex > 0 && passwordIndex > 0, "the handler must still read a body and a password");
  assert.ok(refusalIndex < bodyIndex, "the refusal must come before the body is read");
  assert.ok(refusalIndex < passwordIndex, "the refusal must come before any password comparison");
});

test("the route stays on the public allow-list, closed rather than deleted", () => {
  // Removing the registration would make the allow-list read as though the surface were gone while
  // a handler still sat behind it. The honest shape is to keep it listed and closed inside.
  assert.match(backendCode, /"POST \/bootstrap\/first-owner-device",/);
  assert.match(backendCode, /A-6 Gate 3\.3/);
});

test("the ops command that replaces it exists and does not take the password as an argument", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "..", "scripts", "bootstrap-first-owner.mjs"), "utf8",
  );
  assert.match(script, /askHidden/, "the password must be prompted for, not passed in");
  assert.doesNotMatch(script, /readFlag\("password"\)/,
    "a password in an argument sits in shell history and the process list");
  assert.match(script, /An approved owner device already exists/,
    "the command must keep the route's refusal, or it becomes a way to add devices later");
});
