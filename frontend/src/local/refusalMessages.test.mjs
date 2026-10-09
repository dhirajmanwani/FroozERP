import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { REFUSAL_MESSAGES, plainRefusalMessage } from "./refusalMessages.js";

const refusal = (status, code, message) => ({ response: { status, data: { code, ...(message === undefined ? {} : { message }) } } });

test("every new auth refusal has plain words, and the server's own wording wins", () => {
  for (const code of [
    "CURRENT_PASSWORD_REQUIRED", "CURRENT_PASSWORD_INVALID", "USER_LOCKED",
    "OWNER_REQUIRED_FOR_PRIVILEGED_ACCOUNT", "USER_NOT_IN_YOUR_BRANCH", "OWNER_REQUIRED_FOR_PRIVILEGED_ROLE",
    "BILLING_PERMISSION_REQUIRED", "PURCHASE_PERMISSION_REQUIRED", "REPORTS_PERMISSION_REQUIRED",
    "EXIT_CODE_ATTEMPTS_LOCKED",
  ]) {
    assert.equal(plainRefusalMessage(refusal(403, code)), REFUSAL_MESSAGES[code], code);
  }
  assert.equal(plainRefusalMessage(refusal(423, "USER_LOCKED", "Locked for 9 more minutes.")), "Locked for 9 more minutes.");
});

test("anything else is left to the caller", () => {
  assert.equal(plainRefusalMessage(refusal(409, "SOMETHING_ELSE", "x")), "");
  assert.equal(plainRefusalMessage(new Error("Network Error")), "");
  assert.equal(plainRefusalMessage(null), "");
});

test("App routes the refusals through it, and sends current_password on its own row", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const auth = app.slice(app.indexOf("const getAuthErrorMessage = "), app.indexOf("const hasObjectContent"));
  assert.match(auth, /const refusal = plainRefusalMessage\(error\);\s*\n\s*if \(refusal\) return refusal;/);
  assert.match(app, /\} else if \(plainRefusalMessage\(error\)\) \{\s*\n\s*\/\/ EXIT_CODE_ATTEMPTS_LOCKED/);
  assert.match(app, /const ownRow = inventoryIdsEqual\(passwordTarget\.id, user\.id\);/);
  assert.match(app, /\.\.\.\(ownRow \? \{ current_password: passwordTarget\.current_password \|\| "" \} : \{\}\),/);
  assert.match(app, /alert\(plainRefusalMessage\(error\) \|\| getErrorMessage\(error, "Unable to complete checkout"\)\);/);
  assert.match(app, /alert\(plainRefusalMessage\(error\) \|\| getErrorMessage\(error, "Purchase Error"\)\);/);
});
