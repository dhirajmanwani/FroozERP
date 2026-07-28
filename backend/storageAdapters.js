const fs = require("fs");
const os = require("os");
const path = require("path");

const RUNTIME_MODES = Object.freeze({
  DESKTOP_LOCAL: "desktop-local",
  CLOUD_SERVER: "cloud-server",
  MOBILE_LOCAL: "mobile-local",
  WEB_LOCAL: "web-local",
});

const normalizeRuntimeMode = (value) => String(value || "").trim().toLowerCase();

const resolveDesktopSqlitePath = (env = process.env) => {
  const configured = String(env.FROOZERP_SQLITE_PATH || "").trim();
  if (configured) return path.resolve(configured);
  const home = os.homedir();
  const appDataRoot = process.platform === "win32"
    ? String(env.APPDATA || path.join(home, "AppData", "Roaming"))
    : process.platform === "darwin"
      ? path.join(home, "Library", "Application Support")
      : String(env.XDG_DATA_HOME || path.join(home, ".local", "share"));
  return path.join(appDataRoot, "com.srtcompany.froozerp", "froozerp-local.sqlite3");
};

const resolveRuntimeMode = (env = process.env) => {
  const explicit = normalizeRuntimeMode(env.FROOZERP_RUNTIME_MODE);
  if (Object.values(RUNTIME_MODES).includes(explicit)) return explicit;
  if (String(env.FROOZERP_DESKTOP_SERVICE || "").trim() === "1") {
    return RUNTIME_MODES.DESKTOP_LOCAL;
  }
  const deploymentType = String(env.FROOZERP_DEPLOYMENT_TYPE || "").trim().toLowerCase();
  const appMode = String(env.APP_MODE || "").trim().toUpperCase();
  if (deploymentType === "cloud" && appMode === "CLOUD_PRODUCTION") {
    return RUNTIME_MODES.CLOUD_SERVER;
  }
  return RUNTIME_MODES.DESKTOP_LOCAL;
};

class StorageAdapter {
  constructor({ kind, databaseType, clientPlatform, localFirst }) {
    this.kind = kind;
    this.databaseType = databaseType;
    this.clientPlatform = clientPlatform;
    this.localFirst = localFirst;
  }

  async initialize() {
    throw new Error("Storage adapter initialization is not implemented.");
  }

  async health() {
    throw new Error("Storage adapter health check is not implemented.");
  }

  async close() {}
}

class DesktopSQLiteAdapter extends StorageAdapter {
  constructor({ databasePath }) {
    super({ kind: "desktop-sqlite", databaseType: "sqlite", clientPlatform: "desktop", localFirst: true });
    const configuredPath = String(databasePath || "").trim();
    this.databasePath = configuredPath ? path.resolve(configuredPath) : "";
  }

  async initialize() {
    await fs.promises.mkdir(path.dirname(this.databasePath), { recursive: true });
    if (!fs.existsSync(this.databasePath)) {
      const { DatabaseSync } = require("node:sqlite");
      const database = new DatabaseSync(this.databasePath);
      database.exec("PRAGMA user_version = 1;");
      database.close();
    }
    const handle = await fs.promises.open(this.databasePath, "r+");
    try {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (bytesRead !== 16 || header.toString("utf8") !== "SQLite format 3\u0000") {
        throw new Error("The desktop local database is not a valid SQLite database.");
      }
    } finally {
      await handle.close();
    }
    return this.health();
  }

  async health() {
    const stat = await fs.promises.stat(this.databasePath);
    await fs.promises.access(this.databasePath, fs.constants.R_OK | fs.constants.W_OK);
    return {
      reachable: stat.isFile(),
      databaseType: this.databaseType,
      databasePath: this.databasePath,
      localFirst: true,
    };
  }

  async query() {
    const error = new Error("Desktop clients cannot execute PostgreSQL queries. Use SQLite locally or the authenticated cloud API.");
    error.code = "CLIENT_DIRECT_DATABASE_ACCESS_BLOCKED";
    throw error;
  }

  async connect() {
    return this.query();
  }
}

class MobileSQLiteAdapter extends StorageAdapter {
  constructor() {
    super({ kind: "mobile-sqlite", databaseType: "sqlite", clientPlatform: "mobile", localFirst: true });
  }
}

class WebIndexedDBAdapter extends StorageAdapter {
  constructor() {
    super({ kind: "web-indexeddb", databaseType: "indexeddb", clientPlatform: "web", localFirst: true });
  }
}

class CloudPostgresAdapter extends StorageAdapter {
  constructor({ connectionString, sslEnabled, rejectUnauthorized, allowIsolatedLoopback = false }) {
    super({ kind: "cloud-postgres", databaseType: "postgresql", clientPlatform: "cloud", localFirst: false });
    if (!connectionString) {
      throw new Error("Cloud-server runtime requires DATABASE_URL.");
    }
    const parsed = new URL(connectionString);
    if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
      throw new Error("Cloud-server DATABASE_URL must use PostgreSQL.");
    }
    const host = String(parsed.hostname || "").toLowerCase();
    const isolatedStaging =
      allowIsolatedLoopback &&
      ["localhost", "127.0.0.1", "::1"].includes(host) &&
      parsed.pathname.endsWith("_staging");
    if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host) && !isolatedStaging) {
      throw new Error("Cloud-server PostgreSQL cannot use a loopback host.");
    }
    // PostgreSQL is loaded only for the explicit cloud-server runtime.
    const { Pool, types } = require("pg");
    types.setTypeParser(1082, (value) => value);
    this.connectionString = connectionString;
    this.host = host;
    this.pool = new Pool({
      connectionString,
      ssl: sslEnabled ? { rejectUnauthorized } : undefined,
    });
    this.pool.on("connect", (client) => {
      client.query("SET TIME ZONE 'UTC'").catch((error) => {
        console.error("Unable to enforce PostgreSQL UTC session timezone", error.message);
      });
    });
  }

  query(...args) {
    return this.pool.query(...args);
  }

  connect(...args) {
    return this.pool.connect(...args);
  }

  async initialize() {
    await this.pool.query("SELECT 1");
    return this.health();
  }

  async health() {
    await this.pool.query("SELECT 1");
    return { reachable: true, databaseType: this.databaseType, databasePath: "", localFirst: false };
  }

  async close() {
    await this.pool.end();
  }
}

const createStorageAdapter = (env = process.env) => {
  const runtimeMode = resolveRuntimeMode(env);
  if (runtimeMode === RUNTIME_MODES.CLOUD_SERVER) {
    return {
      runtimeMode,
      adapter: new CloudPostgresAdapter({
        connectionString: String(env.DATABASE_URL || "").trim(),
        sslEnabled: /^true$/i.test(env.DB_SSL || ""),
        rejectUnauthorized: !/^false$/i.test(env.DB_SSL_REJECT_UNAUTHORIZED || ""),
        allowIsolatedLoopback:
          String(env.NODE_ENV || "").trim().toLowerCase() === "test" &&
          /^true$/i.test(env.FROOZERP_ALLOW_LOOPBACK_POSTGRES_FOR_ISOLATED_TESTS || ""),
      }),
    };
  }
  if (runtimeMode === RUNTIME_MODES.DESKTOP_LOCAL) {
    return {
      runtimeMode,
      adapter: new DesktopSQLiteAdapter({ databasePath: resolveDesktopSqlitePath(env) }),
    };
  }
  if (runtimeMode === RUNTIME_MODES.MOBILE_LOCAL) {
    return { runtimeMode, adapter: new MobileSQLiteAdapter() };
  }
  return { runtimeMode, adapter: new WebIndexedDBAdapter() };
};

module.exports = {
  RUNTIME_MODES,
  StorageAdapter,
  DesktopSQLiteAdapter,
  MobileSQLiteAdapter,
  WebIndexedDBAdapter,
  CloudPostgresAdapter,
  resolveRuntimeMode,
  resolveDesktopSqlitePath,
  createStorageAdapter,
};
