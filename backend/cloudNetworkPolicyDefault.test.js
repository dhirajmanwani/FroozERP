"use strict";

/**
 * "Nobody ever decided" and "somebody decided and we cannot read it" are not the same answer.
 *
 * ## What went wrong
 *
 * `readPolicy` answered both with a denial. That is right for one of them and wrong for the other,
 * and the wrong one cost the maintainer an afternoon on 2026-09-02.
 *
 * A rehearsal profile is a fresh app-data directory, so `cloud-network-policy.json` did not exist.
 * The gateway therefore refused every cloud request, the app displayed "LOCAL ONLY" as though that
 * had been chosen, and nothing anywhere said the reason was a missing file. Three wrong diagnoses
 * followed -- the internet being off, then a mode setting, then a blank URL -- because each layer
 * hid the next.
 *
 * ## The two directions, and why only one of them changed
 *
 * **Unreadable still denies, and must.** A corrupt file may have said "lock this device down".
 * Opening the internet because that instruction cannot be read would undo somebody's deliberate
 * decision, and a deliberate lockdown is exactly the thing this switch exists to honour.
 *
 * **Absent now allows.** This is a deliberate weakening of a fail-closed default, recorded here and
 * in `docs/connection-simplification-decision.md` because `CLAUDE.md` requires anything that could
 * weaken the LOCAL_ONLY guarantee to be called out loudly.
 *
 * The product is local-first *with* cloud sync. A device that has never been told anything is one
 * somebody just installed, and the behaviour it should have is the ordinary one. A device that
 * cannot reach its cloud is not safer than one that can — it is broken, and it is broken silently.
 * The kill switch stays a deliberate act rather than an accident of a missing file.
 *
 * Nothing about the switch when it is genuinely ON is changed, and the suite that proves those
 * guarantees (`desktopGatewayOwnerControl.test.js`) is untouched.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const { POLICY_SOURCES, resolvePolicyFromRead } = require("./desktopGateway");

test("no policy file at all means this device may use the internet", () => {
  // The case that cost the afternoon. A fresh profile has no file, and had no way to say so.
  const policy = resolvePolicyFromRead({ errorCode: "ENOENT" });
  assert.equal(policy.allowInternetAccess, true);
  assert.equal(policy.source, POLICY_SOURCES.NEVER_SET);
});

test("a file that cannot be read keeps the device locked down", () => {
  // It may have said "lock this down". Guessing otherwise would undo a real decision.
  for (const unreadable of [
    { errorCode: "EACCES" },
    { errorCode: "EIO" },
    { contents: "{ not json" },
    { contents: "" },
    { contents: "null" },
  ]) {
    const policy = resolvePolicyFromRead(unreadable);
    assert.equal(policy.allowInternetAccess, false, JSON.stringify(unreadable));
    assert.equal(policy.source, POLICY_SOURCES.UNREADABLE);
  }
});

test("a file that exists but does not answer the question counts as damaged, not missing", () => {
  // The dangerous near-miss: `{}` is readable JSON and says nothing. Treating it as "never set"
  // would turn one corrupted byte into an unlock.
  for (const contents of ['{}', '{"allowInternetAccess":"yes"}', '{"allowInternetAccess":null}', '{"other":true}']) {
    const policy = resolvePolicyFromRead({ contents });
    assert.equal(policy.allowInternetAccess, false, contents);
    assert.equal(policy.source, POLICY_SOURCES.UNREADABLE);
  }
});

test("a stored decision is obeyed in both directions", () => {
  const off = resolvePolicyFromRead({ contents: JSON.stringify({ allowInternetAccess: false }) });
  assert.equal(off.allowInternetAccess, false);
  assert.equal(off.source, POLICY_SOURCES.STORED);

  const on = resolvePolicyFromRead({ contents: JSON.stringify({ allowInternetAccess: true }) });
  assert.equal(on.allowInternetAccess, true);
  assert.equal(on.source, POLICY_SOURCES.STORED);
});

test("a stored lockdown is never overridden by anything else in the file", () => {
  // The guarantee that matters most: somebody switched this device off the internet on purpose,
  // and no amount of surrounding metadata changes that.
  const policy = resolvePolicyFromRead({
    contents: JSON.stringify({
      allowInternetAccess: false,
      updatedAt: "2026-09-01T00:00:00.000Z",
      changedBy: 1,
      deviceId: "FZDEV-X",
      timeSource: "server",
    }),
  });
  assert.equal(policy.allowInternetAccess, false);
  assert.equal(policy.changedBy, 1);
  assert.equal(policy.deviceId, "FZDEV-X");
});

test("the three cases are told apart, so a caller can explain itself", () => {
  // Without the source, a screen can only say "cloud sync paused" — which reads as a choice
  // somebody made, and sends them hunting through settings for a switch nobody ever set.
  const sources = [
    resolvePolicyFromRead({ errorCode: "ENOENT" }).source,
    resolvePolicyFromRead({ contents: "{ broken" }).source,
    resolvePolicyFromRead({ contents: JSON.stringify({ allowInternetAccess: true }) }).source,
  ];
  assert.deepEqual(sources, [POLICY_SOURCES.NEVER_SET, POLICY_SOURCES.UNREADABLE, POLICY_SOURCES.STORED]);
});

test("nothing here can be reached without a real read result", () => {
  // Called with nothing at all — the shape a future refactor might pass by accident. It must not
  // fall through to "allowed".
  assert.equal(resolvePolicyFromRead().allowInternetAccess, false);
  assert.equal(resolvePolicyFromRead({}).allowInternetAccess, false);
});
