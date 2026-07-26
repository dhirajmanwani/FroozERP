import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  getUserDisplayName,
  getUserInitial,
  getUserRoleLabel,
} from "./userPresentation.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");

test("canonical owner uses the authenticated alias when full name duplicates the role", () => {
  const user = {
    id: 1,
    full_name: "Owner",
    username: "dhirajmanwani",
    canonical_username: "owner",
    login_alias: "dhirajmanwani",
    role: "Owner",
  };
  assert.equal(getUserDisplayName(user), "dhirajmanwani");
  assert.equal(getUserRoleLabel(user), "Owner");
  assert.equal(getUserInitial(user), "D");
});

test("an explicit display name remains the primary label", () => {
  const user = {
    display_name: "Dhiraj Manwani",
    full_name: "Owner",
    login_alias: "dhirajmanwani",
    role_name: "Owner",
  };
  assert.equal(getUserDisplayName(user), "Dhiraj Manwani");
  assert.equal(getUserRoleLabel(user), "Owner");
});

test("canonical identity is only a presentation fallback", () => {
  const user = { canonical_username: "owner", normalized_role: "OWNER" };
  assert.equal(getUserDisplayName(user), "owner");
  assert.equal(getUserRoleLabel(user), "OWNER");
});

test("sidebar, welcome banner and profile use the same presentation resolver", () => {
  assert.match(appSource, /const userDisplayName = getUserDisplayName\(user\)/);
  assert.match(appSource, /<strong>\{userDisplayName\}<\/strong>/);
  assert.match(appSource, /<small>\{userRoleLabel\}<\/small>/);
  assert.match(appSource, /Good to see you, \{userDisplayName\.split/);
  assert.match(appSource, /<SummaryMetric label="Role" value=\{userRoleLabel\}/);
});
