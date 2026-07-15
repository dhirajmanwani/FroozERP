import assert from "node:assert/strict";
import test from "node:test";
import { describeUpdateAvailability, normalizeUpdateMetadata } from "./updateMetadata.js";

test("null update metadata is a valid unpublished state", () => {
  assert.deepEqual(normalizeUpdateMetadata(null), {
    version: "",
    publishedAt: "",
    releaseNotes: "",
    hasPublishedRelease: false,
  });
  assert.deepEqual(describeUpdateAvailability({ metadata: null }), {
    phase: "no_published_update",
    label: "No published update available",
  });
});

test("missing pub_date does not hide a published version", () => {
  const metadata = normalizeUpdateMetadata({ version: "1.0.53", notes: "Candidate" });
  assert.equal(metadata.version, "1.0.53");
  assert.equal(metadata.publishedAt, "");
  assert.equal(metadata.hasPublishedRelease, true);
});

test("offline update checks remain a non-crashing Settings state", () => {
  assert.deepEqual(describeUpdateAvailability({ metadata: null, online: false }), {
    phase: "offline",
    label: "Offline - update status unavailable",
  });
});

test("an unpublished RC is not reported as a published update", () => {
  const state = describeUpdateAvailability({ metadata: {}, online: true, update: null });
  assert.equal(state.phase, "no_published_update");
  assert.equal(state.label, "No published update available");
});
