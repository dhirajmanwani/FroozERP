"use strict";

/**
 * Delivery settings, per branch (Delivery module, 22 Nov 2026).
 *
 * ## What it is
 *
 * Each shop has its own pickup address and pin, its own areas with a usual delivery charge, its own
 * WhatsApp message templates and its own defaults (who usually pays, which provider, when a
 * delivery counts as overdue). The Owner or an Admin saves them once; every device of the branch
 * keeps a copy in `local_delivery_settings`, so the screens work offline.
 *
 * One row per (company, branch) in `delivery_settings`, the whole settings object as JSONB:
 *
 *     { pickup_address, pickup_pin, default_paid_by, default_provider, overdue_minutes,
 *       areas: [ { id, name, usual_paise } ],
 *       templates: { booked, picked_up, delivered } }
 *
 * ## The routes (mounted in server.js)
 *
 * - `GET  /api/v3/delivery-settings` -> `{ branch_id, settings, updated_at, source }`
 *     - `branch`: this branch's own row.
 *     - `copied`: no row yet; another branch of the same company has one, and its templates and
 *       defaults are offered as a starting point with the pickup address, pin and areas blank,
 *       because those are the one part that is never the same at two shops. Nothing is written:
 *       the copy becomes this branch's only when somebody saves it. `updated_at` is null.
 *     - `none`: no branch of the company has saved any; `settings` is null.
 *   Any session may read: the counter needs the templates to message a customer.
 * - `PUT /api/v3/delivery-settings` body `{ settings }` -> the GET shape (`source: "branch"`).
 *   Owner or Admin only, re-read from the database (`requireRateManager`), 403 otherwise.
 *
 * Company and branch are always `req.auth.companyId` / `req.auth.branchId`, the actor always
 * `req.auth.userId`. Nothing here reads an identity or a scope from the body.
 *
 * ## Validation
 *
 * `sanitizeDeliverySettings` refuses rather than truncates: this is an interactive save, and an
 * Owner told "Area 3 needs a name" can fix it, whereas a silently shortened template is a message
 * sent to customers that nobody wrote. Missing keys take the defaults below; unknown keys are not
 * stored.
 *
 * The database work takes a `db` (anything with `query`), so every path runs against PGlite in
 * deliverySettings.test.js.
 */

const { randomUUID } = require("node:crypto");

const PAID_BY = Object.freeze(["shop", "customer"]);
const PROVIDERS = Object.freeze(["rapido", "uber", "own_staff", "other"]);
const TEMPLATE_KEYS = Object.freeze(["booked", "picked_up", "delivered"]);

const LIMITS = Object.freeze({
  pickup_address: 500,
  pickup_pin: 500,
  area_id: 80,
  area_name: 80,
  areas: 200,
  template: 1000,
  overdue_min: 5,
  overdue_max: 600,
  paise_max: 1e11,
});

const DEFAULTS = Object.freeze({
  default_paid_by: "shop",
  default_provider: "rapido",
  overdue_minutes: 45,
});

const SOURCES = Object.freeze({ BRANCH: "branch", COPIED: "copied", NONE: "none" });

const CODES = Object.freeze({
  PERMISSION_REQUIRED: "DELIVERY_SETTINGS_PERMISSION_REQUIRED",
  SCOPE_REQUIRED: "DELIVERY_SETTINGS_SCOPE_REQUIRED",
  INVALID: "DELIVERY_SETTINGS_INVALID",
  STORAGE_MISSING: "DELIVERY_SETTINGS_STORAGE_MISSING",
  LOAD_FAILED: "DELIVERY_SETTINGS_LOAD_FAILED",
  SAVE_FAILED: "DELIVERY_SETTINGS_SAVE_FAILED",
});

const MESSAGES = Object.freeze({
  PERMISSION_REQUIRED: "Only the Owner or an Admin can change delivery settings.",
  SCOPE_REQUIRED: "This session has no shop and branch to keep delivery settings for. Sign in at a counter of the shop.",
  INVALID: "Delivery settings were not saved. Check the highlighted fields.",
  STORAGE_MISSING: "Delivery settings are not set up on this server yet. Ask the administrator to update the database.",
  LOAD_FAILED: "Delivery settings could not be loaded.",
  SAVE_FAILED: "Delivery settings could not be saved.",
});

const isBlank = (value) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Text up to `limit` characters after trimming; "" when absent; an error when not text or too long. */
const textField = (value, limit, label, errors) => {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    errors.push(`${label} must be text`);
    return "";
  }
  const text = value.trim();
  if (text.length > limit) {
    errors.push(`${label} is longer than ${limit} characters`);
    return "";
  }
  return text;
};

/** One of `allowed` (lower-cased), the default when blank, an error otherwise. */
const choiceField = (value, allowed, fallback, label, errors) => {
  if (isBlank(value)) return fallback;
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!allowed.includes(text)) {
    errors.push(`${label} must be one of ${allowed.join(", ")}`);
    return fallback;
  }
  return text;
};

/** Whole paise >= 0, or null when blank. Explicit checks, never `??`: 0 is a real usual charge. */
const paiseField = (value, label, errors) => {
  if (isBlank(value)) return null;
  const number = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < 0 || number > LIMITS.paise_max) {
    errors.push(`${label} must be whole paise of 0 or more`);
    return null;
  }
  return number;
};

/**
 * Validate and normalise a settings object.
 *
 * @returns {{ ok: true, value: object, errors: [] } | { ok: false, value: null, errors: string[] }}
 */
const sanitizeDeliverySettings = (raw, { newId = randomUUID } = {}) => {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, value: null, errors: ["settings must be an object"] };

  const value = {
    pickup_address: textField(raw.pickup_address, LIMITS.pickup_address, "Pickup address", errors),
    pickup_pin: textField(raw.pickup_pin, LIMITS.pickup_pin, "Pickup pin", errors),
    default_paid_by: choiceField(raw.default_paid_by, PAID_BY, DEFAULTS.default_paid_by, "Default paid by", errors),
    default_provider: choiceField(raw.default_provider, PROVIDERS, DEFAULTS.default_provider, "Default provider", errors),
    overdue_minutes: DEFAULTS.overdue_minutes,
    areas: [],
    templates: {},
  };

  if (!isBlank(raw.overdue_minutes)) {
    const minutes = typeof raw.overdue_minutes === "number" || typeof raw.overdue_minutes === "string"
      ? Number(raw.overdue_minutes)
      : NaN;
    if (!Number.isInteger(minutes) || minutes < LIMITS.overdue_min || minutes > LIMITS.overdue_max) {
      errors.push(`Overdue minutes must be a whole number from ${LIMITS.overdue_min} to ${LIMITS.overdue_max}`);
    } else {
      value.overdue_minutes = minutes;
    }
  }

  if (raw.areas !== null && raw.areas !== undefined) {
    if (!Array.isArray(raw.areas)) {
      errors.push("Areas must be a list");
    } else if (raw.areas.length > LIMITS.areas) {
      errors.push(`No more than ${LIMITS.areas} areas can be saved`);
    } else {
      const ids = new Set();
      raw.areas.forEach((area, index) => {
        const label = `Area ${index + 1}`;
        if (!isPlainObject(area)) {
          errors.push(`${label} is not an area`);
          return;
        }
        const before = errors.length;
        const name = textField(area.name, LIMITS.area_name, `${label} name`, errors);
        if (!name && errors.length === before) errors.push(`${label} needs a name`);
        // Area ids are opaque strings. A number is kept as its text, never the other way round.
        let id = typeof area.id === "number" && Number.isFinite(area.id) ? String(area.id) : textField(area.id, LIMITS.area_id, `${label} id`, errors);
        if (!id) id = String(newId());
        if (ids.has(id)) errors.push(`${label} repeats id ${id}`);
        ids.add(id);
        value.areas.push({ id, name, usual_paise: paiseField(area.usual_paise, `${label} usual charge`, errors) });
      });
    }
  }

  if (raw.templates !== null && raw.templates !== undefined && !isPlainObject(raw.templates)) {
    errors.push("Templates must be an object");
  }
  const templates = isPlainObject(raw.templates) ? raw.templates : {};
  for (const key of TEMPLATE_KEYS) {
    value.templates[key] = textField(templates[key], LIMITS.template, `The ${key.replace("_", " ")} template`, errors);
  }

  return errors.length ? { ok: false, value: null, errors } : { ok: true, value, errors: [] };
};

/**
 * Stored JSON, read back. A stored row was sanitised on the way in, but the column is JSONB and the
 * row may be older than a rule; anything the sanitiser would refuse now is still shown rather than
 * hidden, with only the shape guaranteed (objects and lists where the frontend expects them).
 */
const shapeStoredSettings = (stored) => {
  const raw = isPlainObject(stored) ? stored : {};
  return {
    pickup_address: typeof raw.pickup_address === "string" ? raw.pickup_address : "",
    pickup_pin: typeof raw.pickup_pin === "string" ? raw.pickup_pin : "",
    default_paid_by: PAID_BY.includes(raw.default_paid_by) ? raw.default_paid_by : DEFAULTS.default_paid_by,
    default_provider: PROVIDERS.includes(raw.default_provider) ? raw.default_provider : DEFAULTS.default_provider,
    overdue_minutes: Number.isInteger(raw.overdue_minutes) ? raw.overdue_minutes : DEFAULTS.overdue_minutes,
    areas: Array.isArray(raw.areas) ? raw.areas.filter(isPlainObject) : [],
    templates: Object.fromEntries(TEMPLATE_KEYS.map((key) => [
      key,
      isPlainObject(raw.templates) && typeof raw.templates[key] === "string" ? raw.templates[key] : "",
    ])),
  };
};

/** Another branch's settings as a starting point: its templates and defaults, nothing of its place. */
const copyForNewBranch = (stored) => ({
  ...shapeStoredSettings(stored),
  pickup_address: "",
  pickup_pin: "",
  areas: [],
});

const isoOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/**
 * This branch's settings, or a copy of another branch's, or none.
 *
 * @param {{ query: Function }} db
 * @param {{ companyId: number, branchId: number }} scope the session's
 */
const readDeliverySettings = async (db, { companyId, branchId }) => {
  const own = await db.query(
    `SELECT branch_id, settings, updated_at
       FROM delivery_settings
      WHERE company_id = $1 AND branch_id = $2
      LIMIT 1`,
    [companyId, branchId]
  );
  if (own.rows[0]) {
    return {
      branch_id: branchId,
      settings: shapeStoredSettings(own.rows[0].settings),
      updated_at: isoOrNull(own.rows[0].updated_at),
      source: SOURCES.BRANCH,
    };
  }
  // The company's first branch that has saved any -- an open shop before a closed one, then the
  // oldest branch, which is the main shop in every company set up so far. Same company only, by
  // both the row's company and the branch's.
  const other = await db.query(
    `SELECT ds.branch_id, ds.settings
       FROM delivery_settings ds
       JOIN branches b ON b.id = ds.branch_id
      WHERE ds.company_id = $1
        AND b.company_id = $1
        AND ds.branch_id <> $2
      ORDER BY (b.active IS DISTINCT FROM FALSE) DESC, ds.branch_id
      LIMIT 1`,
    [companyId, branchId]
  );
  if (other.rows[0]) {
    return {
      branch_id: branchId,
      settings: copyForNewBranch(other.rows[0].settings),
      updated_at: null,
      source: SOURCES.COPIED,
    };
  }
  return { branch_id: branchId, settings: null, updated_at: null, source: SOURCES.NONE };
};

/**
 * Upsert this branch's settings. The caller has already checked the role and sanitised `settings`.
 */
const saveDeliverySettings = async (db, { companyId, branchId, actorId, settings }) => {
  const result = await db.query(
    `INSERT INTO delivery_settings (company_id, branch_id, settings, updated_by, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (company_id, branch_id) DO UPDATE SET
       settings = EXCLUDED.settings,
       updated_by = EXCLUDED.updated_by,
       updated_at = now()
     RETURNING branch_id, settings, updated_at`,
    [companyId, branchId, JSON.stringify(settings), actorId || null]
  );
  const row = result.rows[0];
  return {
    branch_id: branchId,
    settings: shapeStoredSettings(row?.settings ?? settings),
    updated_at: isoOrNull(row?.updated_at),
    source: SOURCES.BRANCH,
  };
};

const storageMissing = (error) => error?.code === "42P01" || error?.code === "42703";

/**
 * Express handlers, given the server's pool and role check.
 *
 * @param {{ pool: { query: Function }, requireRateManager: (userId, db) => Promise<object|null>,
 *           parsePositiveInteger: (value) => number|null, log?: Function }} deps
 */
const createDeliverySettingsHandlers = ({ pool, requireRateManager, parsePositiveInteger, log = console.error }) => {
  const scopeOf = (req) => ({
    companyId: parsePositiveInteger(req.auth?.companyId),
    branchId: parsePositiveInteger(req.auth?.branchId),
  });

  const getHandler = async (req, res) => {
    const scope = scopeOf(req);
    if (!scope.companyId || !scope.branchId) {
      return res.status(400).json({ code: CODES.SCOPE_REQUIRED, message: MESSAGES.SCOPE_REQUIRED });
    }
    try {
      return res.json(await readDeliverySettings(pool, scope));
    } catch (error) {
      log("Loading delivery settings failed", { code: error?.code, message: error?.message });
      if (storageMissing(error)) return res.status(500).json({ code: CODES.STORAGE_MISSING, message: MESSAGES.STORAGE_MISSING });
      return res.status(500).json({ code: CODES.LOAD_FAILED, message: MESSAGES.LOAD_FAILED });
    }
  };

  const putHandler = async (req, res) => {
    try {
      const manager = await requireRateManager(req.auth?.userId, pool);
      if (!manager) return res.status(403).json({ code: CODES.PERMISSION_REQUIRED, message: MESSAGES.PERMISSION_REQUIRED });
      const scope = scopeOf(req);
      if (!scope.companyId || !scope.branchId) {
        return res.status(400).json({ code: CODES.SCOPE_REQUIRED, message: MESSAGES.SCOPE_REQUIRED });
      }
      const checked = sanitizeDeliverySettings(req.body?.settings);
      if (!checked.ok) {
        return res.status(400).json({ code: CODES.INVALID, message: MESSAGES.INVALID, errors: checked.errors });
      }
      return res.json(await saveDeliverySettings(pool, {
        ...scope,
        actorId: parsePositiveInteger(manager.id),
        settings: checked.value,
      }));
    } catch (error) {
      log("Saving delivery settings failed", { code: error?.code, message: error?.message });
      if (storageMissing(error)) return res.status(500).json({ code: CODES.STORAGE_MISSING, message: MESSAGES.STORAGE_MISSING });
      return res.status(500).json({ code: CODES.SAVE_FAILED, message: MESSAGES.SAVE_FAILED });
    }
  };

  return { getHandler, putHandler };
};

module.exports = {
  PAID_BY,
  PROVIDERS,
  TEMPLATE_KEYS,
  LIMITS,
  DEFAULTS,
  SOURCES,
  CODES,
  MESSAGES,
  sanitizeDeliverySettings,
  shapeStoredSettings,
  copyForNewBranch,
  readDeliverySettings,
  saveDeliverySettings,
  createDeliverySettingsHandlers,
};
