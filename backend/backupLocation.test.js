"use strict";

/**
 * The backup directory, and the claim that goes with it.
 *
 * Both halves of the 2026-09-17 finding are pinned here: the path that only resolves wrongly in
 * the container, and the fact that a container-local backup is not a backup at all.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { resolveBackupLocation } = require("./backupLocation");

test("the container layout never resolves above the application", () => {
  // The actual failure: `/app` + ".." + "backups" = "/backups", which the node user cannot create,
  // so every scheduled backup on the hosted deployment died with EACCES.
  const resolved = resolveBackupLocation({ dirname: "/app", hostedCloudDeployment: true });
  assert.equal(resolved.directory, path.resolve("/app/backups"));
  assert.notEqual(resolved.directory, path.resolve("/backups"));
});

test("the desktop layout is unchanged, because the shop's backups already live there", () => {
  // <app>/backend/server.js keeps writing to <app>/backups. Moving it would orphan every backup
  // the shop already has and contradict the seeded backup_settings.backup_location.
  const resolved = resolveBackupLocation({ dirname: path.join("/opt", "FroozERP-App", "backend") });
  assert.equal(resolved.directory, path.join(path.resolve("/opt/FroozERP-App"), "backups"));
  assert.equal(resolved.durable, true);
  assert.equal(resolved.warning, "");
});

test("BACKUP_DIR wins, and is treated as a decision somebody made", () => {
  const resolved = resolveBackupLocation({
    dirname: "/app",
    env: { BACKUP_DIR: "/mnt/froozerp-backups" },
    hostedCloudDeployment: true,
  });
  assert.equal(resolved.directory, path.resolve("/mnt/froozerp-backups"));
  assert.equal(resolved.source, "BACKUP_DIR");
  assert.equal(resolved.durable, true);
});

test("a hosted deployment with no configured location is told the files are not a backup", () => {
  // The half that matters more than the path. A backup inside an ephemeral container that nobody
  // can download is not safer than no backup — it only looks safer.
  const resolved = resolveBackupLocation({ dirname: "/app", hostedCloudDeployment: true });
  assert.equal(resolved.durable, false);
  assert.match(resolved.warning, /replaced on every deploy/);
  assert.match(resolved.warning, /cannot be downloaded/);
  assert.match(resolved.warning, /BACKUP_DIR/, "the warning must name the way out");
});

test("durability is never silently assumed", () => {
  for (const options of [
    { dirname: "/app", hostedCloudDeployment: true },
    { dirname: "/app", env: { BACKUP_DIR: "   " }, hostedCloudDeployment: true },
  ]) {
    assert.equal(resolveBackupLocation(options).durable, false);
  }
  // Whitespace is not a configuration.
  assert.equal(resolveBackupLocation({ dirname: "/app", env: { BACKUP_DIR: "   " } }).source, "app-directory");
});

test("it refuses to guess when it is not told where the app is", () => {
  for (const dirname of [undefined, "", "   ", null, 42]) {
    assert.throws(() => resolveBackupLocation({ dirname }), /dirname/);
  }
});
