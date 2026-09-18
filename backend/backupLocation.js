"use strict";

/**
 * Where a backup is written, and whether writing it there means anything.
 *
 * ## What went wrong
 *
 * The hosted backend had been failing its scheduled backup every single night:
 *
 *     Scheduled backup failed Error: EACCES: permission denied, mkdir '/backups'
 *       at async ensureDirectory (/app/server.js:988:3)
 *       at async createDatabaseBackup (/app/server.js:5406:3)
 *
 * The directory came from `path.join(__dirname, "..", "backups")`. That is correct on a desktop
 * install, where `server.js` sits in `<app>/backend` and the sibling `backups` folder is one level
 * up. In the container the application *is* the working directory: `__dirname` is `/app`, so `..`
 * is the filesystem root, and `/backups` is a directory no non-root user may create.
 *
 * One expression, two layouts, and the wrong answer only in the one nobody looks at.
 *
 * ## The second half, which is worse
 *
 * Even written to a directory it can create, a backup inside the container is not a backup. The
 * filesystem is ephemeral: the next deploy replaces it, and there is no way for anybody to fetch
 * the file in the meantime. So a hosted deployment that "succeeds" at this is not safer than one
 * that fails — it only looks safer, and looking safer is the more expensive of the two.
 *
 * That is why this module answers two questions rather than one. `directory` is where to write;
 * `durable` is whether anybody should believe in it. A caller that ignores `durable` is claiming a
 * safety it does not have.
 */

const path = require("path");

/**
 * @param {object} options
 * @param {string} options.dirname   `__dirname` of the module that owns backups (server.js).
 * @param {object} [options.env]     Environment to read `BACKUP_DIR` from.
 * @param {boolean} [options.hostedCloudDeployment] True on Railway and anything like it.
 * @returns {{directory: string, source: string, durable: boolean, warning: string}}
 */
const resolveBackupLocation = ({ dirname, env = {}, hostedCloudDeployment = false } = {}) => {
  if (typeof dirname !== "string" || dirname.trim() === "") {
    throw new Error("resolveBackupLocation needs the dirname of the module that owns backups.");
  }

  const configured = typeof env.BACKUP_DIR === "string" ? env.BACKUP_DIR.trim() : "";
  if (configured) {
    return {
      directory: path.resolve(configured),
      source: "BACKUP_DIR",
      // Somebody chose this path on purpose. If it is a mounted volume it is durable, and if it is
      // not, that is a decision that was made rather than one that happened.
      durable: true,
      warning: "",
    };
  }

  // The desktop layout, and the only one where `..` is right: server.js lives in <app>/backend.
  const looksLikeBackendSubdirectory = path.basename(dirname) === "backend";
  const directory = looksLikeBackendSubdirectory
    ? path.join(path.resolve(dirname, ".."), "backups")
    : path.join(path.resolve(dirname), "backups");

  if (!hostedCloudDeployment) {
    return { directory, source: "app-directory", durable: true, warning: "" };
  }

  return {
    directory,
    source: "app-directory",
    durable: false,
    warning:
      `Scheduled backups write to ${directory}, inside the container. That filesystem is replaced on `
      + "every deploy and cannot be downloaded, so these files are not a backup of this shop's data. "
      + "Set BACKUP_DIR to a mounted volume, or rely on the database provider's own backups and turn "
      + "auto_backup_enabled off so nothing claims a safety it does not have.",
  };
};

module.exports = { resolveBackupLocation };
