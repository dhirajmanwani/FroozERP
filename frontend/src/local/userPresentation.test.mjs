import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  getUserDisplayName,
  getUserGreetingName,
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
  // The greeting resolves through the same module, but not through the same function: a title
  // is not a first name, so it takes `getUserGreetingName` rather than the display label.
  assert.match(appSource, /Good to see you, \{getUserGreetingName\(user\)\}/);
  assert.match(appSource, /<SummaryMetric label="Role" value=\{userRoleLabel\}/);
});

/**
 * A title is not a first name.
 *
 * The Owner's `full_name` is "Mr. Dhiraj Manwani". The dashboard greeted people with
 * `userDisplayName.split(" ")[0]`, which makes that "Good to see you, Mr." and puts M on the
 * avatar -- a screen that looks broken rather than formal, produced by nothing worse than typing a
 * name the ordinary way.
 */

test("a title in front of the name is not greeted as the name", () => {
  assert.equal(getUserGreetingName({ full_name: "Mr. Dhiraj Manwani", role_name: "Owner" }), "Dhiraj");
  assert.equal(getUserInitial({ full_name: "Mr. Dhiraj Manwani", role_name: "Owner" }), "D");
});

test("the Indian and English forms are both recognised, with or without the stop", () => {
  const forms = ["Mr.", "Mr", "Shri", "Shri.", "Smt", "Dr.", "Prof", "CA", "Adv.", "Kum."];
  for (const title of forms) {
    assert.equal(
      getUserGreetingName({ full_name: `${title} Dhiraj Manwani`, role_name: "Owner" }),
      "Dhiraj",
      `${title} should not be greeted as a name`,
    );
  }
});

test("a name with no title is untouched", () => {
  // The change must be invisible to everybody who does not type a title.
  assert.equal(getUserGreetingName({ full_name: "Dhiraj Manwani", role_name: "Owner" }), "Dhiraj");
  assert.equal(getUserGreetingName({ full_name: "Ramesh", role_name: "Cashier" }), "Ramesh");
  assert.equal(getUserInitial({ full_name: "Ramesh", role_name: "Cashier" }), "R");
});

test("a name that is only a title still greets somebody", () => {
  // Falling through to "" would render "Good to see you, ." -- an empty greeting is worse than an
  // odd one, and this is the shape of every strip-the-prefix helper that was never given a floor.
  assert.equal(getUserGreetingName({ full_name: "Mr.", role_name: "Owner" }), "Mr.");
  assert.notEqual(getUserInitial({ full_name: "Mr.", role_name: "Owner" }), "");
});

test("a name that merely starts with those letters is not stripped", () => {
  // "Mrinal" begins with "Mr" and is a name; matching a prefix rather than a whole word would eat it.
  assert.equal(getUserGreetingName({ full_name: "Mrinal Sen", role_name: "Owner" }), "Mrinal");
  assert.equal(getUserGreetingName({ full_name: "Drishti Rao", role_name: "Owner" }), "Drishti");
});

test("the dashboard greeting uses the helper, not the first word of the display name", () => {
  // The bug lived in App.jsx, not here, so the module being right is not enough.
  assert.ok(
    !appSource.includes('userDisplayName.split(" ")[0]'),
    "the greeting must not take the first word of the display name",
  );
});
