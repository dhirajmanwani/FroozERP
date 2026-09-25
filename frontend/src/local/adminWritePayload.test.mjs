import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { SESSION_IDENTITY_FIELDS, adminWritePayload } from "./adminWritePayload.js";

test("a staff assignment for somebody else no longer names them in the body", () => {
  const draft = { user_id: "7", branch_id: "1", operational_location_id: "2", role_id: "3", is_default: true };
  const body = adminWritePayload({
    ...draft,
    target_branch_id: draft.branch_id,
    target_operational_location_id: draft.operational_location_id,
  });
  assert.equal("user_id" in body, false);
  assert.equal("branch_id" in body, false);
  assert.equal(body.target_branch_id, "1");
  assert.equal(body.target_operational_location_id, "2");
  assert.equal(body.role_id, "3");
  assert.deepEqual(draft.user_id, "7", "the draft itself is left alone");
});

test("the stripped fields are exactly the ones the server compares against the session", () => {
  const source = fs.readFileSync(new URL("../../../backend/deviceSession.js", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("const rejectDeviceSessionSubstitution"));
  const compared = [...block.slice(0, block.indexOf("];")).matchAll(/\["(\w+)",/g)].map((match) => match[1]);
  assert.deepEqual([...compared].sort(), [...SESSION_IDENTITY_FIELDS].sort());
});

test("Branches & Counters sends every write through it", () => {
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /const write = createOperationalWrite\(user, adminWritePayload\(payload\)\);/);
});
