/**
 * A branch's delivery settings: the pickup address and pin, the areas with their usual charge, the
 * WhatsApp templates, and the defaults a new delivery starts with.
 *
 * ## Where they live, and who wins
 *
 * One row per branch in the cloud (`delivery_settings`), saved by the Owner or an Admin, and a copy
 * on every device (`local_delivery_settings`) so the delivery screens work with no internet. The
 * plan put them in their own local table on purpose: the general settings table is wiped and refilled
 * from the cloud on every refresh, and settings kept there would be lost exactly when they mattered.
 *
 * The local copy carries a `dirty` flag. An edit is written locally, dirty, *first*, and only then
 * pushed; a dirty copy is the newest thing anybody has typed and wins over the cloud until it has been
 * pushed and marked clean. That ordering is what makes "saved" true even when the push fails: the
 * edit is on this computer and will go up on the next sync.
 *
 * ## Failures are reported, never turned into empty settings
 *
 * {@link syncDeliverySettings} and {@link saveDeliverySettingsFlow} take their I/O as injected
 * functions and never throw. A failed fetch or push comes back in `error`, alongside the best
 * settings still known (the local copy, else the defaults with `source: "default"`). Replacing a
 * branch's settings with blanks because the internet dropped would wipe its pickup address off every
 * rider message — so that never happens here.
 *
 * In LOCAL_ONLY mode the caller passes no `fetchCloud` / `pushCloud`; this module then makes no cloud
 * call at all and works from the local copy.
 *
 * ## Validation mirrors the cloud's
 *
 * `PUT /api/v3/delivery-settings` refuses (400 `DELIVERY_SETTINGS_INVALID`) rather than truncates.
 * {@link validateDeliverySettings} checks the same limits so the person sees the problem at the
 * keyboard, and {@link normalizeDeliverySettings} always produces something the server will accept.
 */

import { DEFAULT_OVERDUE_MINUTES, MAX_DELIVERY_PAISE, PAID_BY, storedPaise } from "./deliveryLifecycle.js";
import { PROVIDER, PROVIDER_IDS } from "./deliveryProviders.js";
import { DEFAULT_DELIVERY_TEMPLATES, unknownPlaceholders } from "./deliveryText.js";
import { canonicalInventoryId } from "./stockInventory.js";

/** Limits shared with the cloud sanitiser (backend `PUT /api/v3/delivery-settings`). */
export const DELIVERY_SETTINGS_LIMITS = Object.freeze({
  PICKUP_TEXT: 500,
  OVERDUE_MIN: 5,
  OVERDUE_MAX: 600,
  AREAS: 200,
  AREA_NAME: 80,
  AREA_ID: 80,
  TEMPLATE: 1000,
});

const TEMPLATE_KINDS = Object.freeze(["booked", "picked_up", "delivered"]);
const PAID_BY_VALUES = Object.freeze(Object.values(PAID_BY));

export const DEFAULT_DELIVERY_SETTINGS = Object.freeze({
  pickup_address: "",
  pickup_pin: "",
  default_paid_by: PAID_BY.SHOP,
  default_provider: PROVIDER.RAPIDO,
  overdue_minutes: DEFAULT_OVERDUE_MINUTES,
  areas: Object.freeze([]),
  templates: Object.freeze({ ...DEFAULT_DELIVERY_TEMPLATES }),
});

/** Where the settings on screen came from. */
export const DELIVERY_SETTINGS_SOURCE = Object.freeze({
  /** This device's copy: either a dirty edit not yet pushed, or the last copy pulled. */
  LOCAL: "local",
  /** This branch's cloud row. */
  CLOUD: "cloud",
  /** No row for this branch yet: another branch's templates, pickup and areas blank. */
  COPIED: "copied",
  /** Nothing saved anywhere. */
  DEFAULT: "default",
});

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Settings may arrive as the stored JSON text rather than an object. */
const asObject = (raw) => {
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return isPlainObject(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isPlainObject(raw) ? raw : null;
};

const freshDefaults = () => ({
  ...DEFAULT_DELIVERY_SETTINGS,
  areas: [],
  templates: { ...DEFAULT_DELIVERY_TEMPLATES },
});

const slug = (value) => text(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "area";

const areaKey = (name) => text(name).toLowerCase().replace(/\s+/g, " ");

/**
 * A settings object this app and the cloud both accept, from whatever was stored or typed.
 *
 * Unknown keys are dropped; bad values fall back to the defaults; text is trimmed and capped; areas
 * without a name are dropped and areas repeating a name (ignoring case) keep the first. An area with
 * no id, or a repeated one, is given a stable id derived from its name, because the cloud refuses
 * duplicate ids. A blank template means "use the default" (that is what the cloud stores) and is
 * filled with the default text so the settings screen shows what will actually be sent.
 */
export const normalizeDeliverySettings = (raw) => {
  const source = asObject(raw);
  const settings = freshDefaults();
  if (!source) return settings;

  settings.pickup_address = text(source.pickup_address).slice(0, DELIVERY_SETTINGS_LIMITS.PICKUP_TEXT);
  settings.pickup_pin = text(source.pickup_pin).slice(0, DELIVERY_SETTINGS_LIMITS.PICKUP_TEXT);

  const paidBy = text(source.default_paid_by).toLowerCase();
  settings.default_paid_by = PAID_BY_VALUES.includes(paidBy) ? paidBy : PAID_BY.SHOP;
  const provider = text(source.default_provider).toLowerCase();
  settings.default_provider = PROVIDER_IDS.includes(provider) ? provider : PROVIDER.RAPIDO;

  const overdue = Number(source.overdue_minutes);
  settings.overdue_minutes = source.overdue_minutes !== null && source.overdue_minutes !== "" && Number.isFinite(overdue)
    ? Math.min(DELIVERY_SETTINGS_LIMITS.OVERDUE_MAX, Math.max(DELIVERY_SETTINGS_LIMITS.OVERDUE_MIN, Math.round(overdue)))
    : DEFAULT_OVERDUE_MINUTES;

  const seenNames = new Set();
  const seenIds = new Set();
  for (const entry of Array.isArray(source.areas) ? source.areas : []) {
    if (settings.areas.length >= DELIVERY_SETTINGS_LIMITS.AREAS) break;
    if (!isPlainObject(entry)) continue;
    const name = text(entry.name).replace(/\s+/g, " ").slice(0, DELIVERY_SETTINGS_LIMITS.AREA_NAME);
    const key = areaKey(name);
    if (!key || seenNames.has(key)) continue;
    seenNames.add(key);
    let id = canonicalInventoryId(entry.id).slice(0, DELIVERY_SETTINGS_LIMITS.AREA_ID);
    if (!id || seenIds.has(id)) {
      const base = `area-${slug(name)}`;
      id = base;
      for (let n = 2; seenIds.has(id); n += 1) id = `${base}-${n}`;
    }
    seenIds.add(id);
    const paise = storedPaise(entry.usual_paise);
    settings.areas.push({
      id,
      name,
      usual_paise: paise !== null && paise >= 0 && paise <= MAX_DELIVERY_PAISE ? paise : null,
    });
  }

  const templates = isPlainObject(source.templates) ? source.templates : {};
  for (const kind of TEMPLATE_KINDS) {
    const value = typeof templates[kind] === "string" ? templates[kind].replace(/\r\n?/g, "\n").trim() : "";
    settings.templates[kind] = value ? value.slice(0, DELIVERY_SETTINGS_LIMITS.TEMPLATE) : DEFAULT_DELIVERY_TEMPLATES[kind];
  }
  return settings;
};

const isPinText = (value) => /^https?:\/\/\S+$/i.test(value)
  || /^\s*-?\d{1,2}(?:\.\d+)?\s*,\s*-?\d{1,3}(?:\.\d+)?\s*$/.test(value);

/**
 * Problems with settings as typed, in plain English. Checks the raw form (before normalising), so a
 * value normalising would quietly replace — a junk charge, a repeated area — is caught and named.
 *
 * @returns {{ok: boolean, errors: string[]}}
 */
export const validateDeliverySettings = (settings) => {
  const errors = [];
  const source = asObject(settings);
  if (!source) return { ok: false, errors: ["The delivery settings could not be read."] };
  const limits = DELIVERY_SETTINGS_LIMITS;

  if (text(source.pickup_address).length > limits.PICKUP_TEXT) errors.push(`The pickup address is longer than ${limits.PICKUP_TEXT} characters.`);
  const pin = text(source.pickup_pin);
  if (pin.length > limits.PICKUP_TEXT) errors.push(`The pickup pin is longer than ${limits.PICKUP_TEXT} characters.`);
  else if (pin && !isPinText(pin)) errors.push("The pickup pin must be a map link (starting with https://) or a location like 12.9716,77.5946.");

  const paidBy = text(source.default_paid_by).toLowerCase();
  if (paidBy && !PAID_BY_VALUES.includes(paidBy)) errors.push("Default \"Paid by\" must be Shop or Customer.");
  const provider = text(source.default_provider).toLowerCase();
  if (provider && !PROVIDER_IDS.includes(provider)) errors.push("The default provider is not one this app knows.");

  const overdueRaw = source.overdue_minutes;
  if (overdueRaw !== undefined && overdueRaw !== null && text(overdueRaw) !== "") {
    const overdue = Number(overdueRaw);
    if (!Number.isInteger(overdue) || overdue < limits.OVERDUE_MIN || overdue > limits.OVERDUE_MAX) {
      errors.push(`"Late after" must be a whole number of minutes from ${limits.OVERDUE_MIN} to ${limits.OVERDUE_MAX}.`);
    }
  }

  if (source.areas !== undefined && source.areas !== null && !Array.isArray(source.areas)) {
    errors.push("The areas list could not be read.");
  }
  const areas = Array.isArray(source.areas) ? source.areas : [];
  if (areas.length > limits.AREAS) errors.push(`At most ${limits.AREAS} areas can be saved.`);
  const names = new Map();
  areas.forEach((area, index) => {
    const label = text(area?.name) || `Area ${index + 1}`;
    if (!isPlainObject(area)) {
      errors.push(`Area ${index + 1} could not be read.`);
      return;
    }
    const name = text(area.name);
    if (!name) errors.push(`Area ${index + 1} has no name.`);
    else if (name.length > limits.AREA_NAME) errors.push(`The area name "${name.slice(0, 20)}…" is longer than ${limits.AREA_NAME} characters.`);
    const key = areaKey(name);
    if (key) {
      if (names.has(key)) errors.push(`"${name}" is listed twice. Keep one.`);
      names.set(key, true);
    }
    const charge = area.usual_paise;
    if (charge !== null && charge !== undefined && charge !== "") {
      const paise = Number(charge);
      if (typeof charge === "boolean" || !Number.isInteger(paise) || paise < 0 || paise > MAX_DELIVERY_PAISE) {
        errors.push(`The usual charge for ${label} is not an amount in rupees.`);
      }
    }
  });

  const templates = source.templates;
  if (templates !== undefined && templates !== null && !isPlainObject(templates)) errors.push("The message templates could not be read.");
  for (const kind of TEMPLATE_KINDS) {
    const value = isPlainObject(templates) ? templates[kind] : undefined;
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      errors.push(`The ${kind.replace("_", " ")} message could not be read.`);
      continue;
    }
    if (value.trim().length > limits.TEMPLATE) errors.push(`The ${kind.replace("_", " ")} message is longer than ${limits.TEMPLATE} characters.`);
    const unknown = unknownPlaceholders(value);
    if (unknown.length > 0) {
      errors.push(`The ${kind.replace("_", " ")} message uses ${unknown.join(", ")}, which this app does not fill in. Check the spelling.`);
    }
  }
  return { ok: errors.length === 0, errors };
};

/** The usual charge for an area, in paise, or `null` (no such area, or no usual charge set). */
export const usualChargeForArea = (settings, areaName) => {
  const key = areaKey(areaName);
  if (!key) return null;
  const areas = Array.isArray(settings?.areas) ? settings.areas : [];
  const area = areas.find((entry) => areaKey(entry?.name) === key);
  if (!area) return null;
  const paise = storedPaise(area.usual_paise);
  return paise !== null && paise >= 0 ? paise : null;
};

/* ------------------------------------------------------------------------------ resolve ------ */

/** `{ settings, ... }` from either `getLocalDeliverySettings` or the GET route, or null. */
const unwrap = (value) => {
  if (!isPlainObject(value)) return null;
  // An axios-style `{ data: { settings } }` is accepted, so a caller cannot get "no settings" from
  // forgetting to unwrap a response.
  if (!("settings" in value) && isPlainObject(value.data) && "settings" in value.data) return value.data;
  return value;
};

const hasSettings = (row) => Boolean(row) && asObject(row.settings) !== null;

/**
 * Which settings to use, from the local row and the cloud answer (either may be null).
 *
 * A dirty local copy wins — it is an edit nobody has pushed yet. Otherwise the cloud row (or the
 * copied templates of a branch with no row yet), then any local copy, then the defaults.
 *
 * @returns {{settings: object, source: string, dirty: boolean}}
 */
export const resolveDeliverySettings = ({ local = null, cloud = null } = {}) => {
  const localRow = unwrap(local);
  const cloudRow = unwrap(cloud);
  if (hasSettings(localRow) && localRow.dirty) {
    return { settings: normalizeDeliverySettings(localRow.settings), source: DELIVERY_SETTINGS_SOURCE.LOCAL, dirty: true };
  }
  if (hasSettings(cloudRow)) {
    return {
      settings: normalizeDeliverySettings(cloudRow.settings),
      source: cloudRow.source === "copied" ? DELIVERY_SETTINGS_SOURCE.COPIED : DELIVERY_SETTINGS_SOURCE.CLOUD,
      dirty: false,
    };
  }
  if (hasSettings(localRow)) {
    return { settings: normalizeDeliverySettings(localRow.settings), source: DELIVERY_SETTINGS_SOURCE.LOCAL, dirty: Boolean(localRow.dirty) };
  }
  return { settings: normalizeDeliverySettings(null), source: DELIVERY_SETTINGS_SOURCE.DEFAULT, dirty: false };
};

const messageOf = (error) => text(error?.response?.data?.message || error?.message || error) || "unknown error";

/**
 * Bring this device's copy and the cloud's into line, and say which settings to use.
 *
 * Injected I/O, called as:
 *   - `readLocal(branchId)`                       -> `{ settings, dirty, ... }` or null (getLocalDeliverySettings)
 *   - `writeLocal({ branchId, settings, dirty })`                                  (saveLocalDeliverySettings)
 *   - `fetchCloud(branchId)`                      -> `{ settings, source, updated_at }` (GET route)
 *   - `pushCloud(settings, branchId)`             -> the same shape                  (PUT route)
 * `fetchCloud` / `pushCloud` may be omitted (LOCAL_ONLY): no cloud call is made.
 *
 * - A dirty local copy is pushed; on success it is re-written clean with what the cloud kept.
 * - Otherwise the cloud row is fetched and kept locally (clean) for offline use.
 * - If the local copy could not even be read, nothing is written locally: an unreadable row might be
 *   an unpushed edit, and overwriting it with the cloud's older copy would lose it.
 *
 * Never throws. Returns `{ settings, source, dirty, error }`, `error` a sentence or null.
 */
export const syncDeliverySettings = async ({ branchId, readLocal, writeLocal, fetchCloud, pushCloud } = {}) => {
  const errors = [];
  let local = null;
  let localReadable = true;
  if (typeof readLocal === "function") {
    try {
      local = unwrap(await readLocal(branchId));
    } catch (error) {
      localReadable = false;
      errors.push(`The delivery settings saved on this computer could not be read (${messageOf(error)}).`);
    }
  }

  const writeClean = async (settings) => {
    if (!localReadable || typeof writeLocal !== "function") return;
    try {
      await writeLocal({ branchId, settings, dirty: false });
    } catch (error) {
      errors.push(`The delivery settings could not be saved on this computer for offline use (${messageOf(error)}).`);
    }
  };
  const finish = (resolved) => ({ ...resolved, error: errors.length > 0 ? errors.join(" ") : null });

  if (hasSettings(local) && local.dirty) {
    const pending = normalizeDeliverySettings(local.settings);
    if (typeof pushCloud !== "function") return finish(resolveDeliverySettings({ local }));
    try {
      const pushed = unwrap(await pushCloud(pending, branchId));
      const kept = hasSettings(pushed) ? normalizeDeliverySettings(pushed.settings) : pending;
      await writeClean(kept);
      return finish({ settings: kept, source: DELIVERY_SETTINGS_SOURCE.CLOUD, dirty: false });
    } catch (error) {
      errors.push(`Delivery settings changed on this computer have not reached the cloud yet (${messageOf(error)}). They are kept here and will be sent on the next sync.`);
      return finish({ settings: pending, source: DELIVERY_SETTINGS_SOURCE.LOCAL, dirty: true });
    }
  }

  if (typeof fetchCloud !== "function") return finish(resolveDeliverySettings({ local }));
  let cloud;
  try {
    cloud = unwrap(await fetchCloud(branchId));
  } catch (error) {
    errors.push(`Delivery settings could not be fetched from the cloud (${messageOf(error)}). ${hasSettings(local) ? "Showing the copy saved on this computer." : "Showing the default settings."}`);
    return finish(resolveDeliverySettings({ local }));
  }
  const resolved = resolveDeliverySettings({ local, cloud });
  if (hasSettings(cloud)) await writeClean(resolved.settings);
  return finish(resolved);
};

/**
 * Save an edit: validate, write locally as dirty, then try the push.
 *
 * Saved locally first so the edit survives a dropped connection; a failed push leaves it dirty for
 * the next {@link syncDeliverySettings}. A successful push re-writes the local copy clean.
 *
 * `writeLocal({ branchId, settings, dirty })`, `pushCloud(settings, branchId)` as in
 * {@link syncDeliverySettings}; `pushCloud` may be omitted (LOCAL_ONLY).
 *
 * @returns {Promise<{saved: boolean, pushed: boolean, error: string|null, errors: string[], settings: object|null}>}
 */
export const saveDeliverySettingsFlow = async ({ branchId, settings, writeLocal, pushCloud } = {}) => {
  const check = validateDeliverySettings(settings);
  if (!check.ok) {
    return { saved: false, pushed: false, error: check.errors[0], errors: check.errors, settings: null };
  }
  const normalized = normalizeDeliverySettings(settings);
  if (typeof writeLocal !== "function") {
    return { saved: false, pushed: false, error: "Delivery settings can only be saved in the desktop app.", errors: [], settings: null };
  }
  try {
    await writeLocal({ branchId, settings: normalized, dirty: true });
  } catch (error) {
    return { saved: false, pushed: false, error: `The delivery settings could not be saved on this computer (${messageOf(error)}).`, errors: [], settings: null };
  }
  if (typeof pushCloud !== "function") return { saved: true, pushed: false, error: null, errors: [], settings: normalized };
  let kept = normalized;
  try {
    const pushed = unwrap(await pushCloud(normalized, branchId));
    if (hasSettings(pushed)) kept = normalizeDeliverySettings(pushed.settings);
  } catch (error) {
    return {
      saved: true,
      pushed: false,
      error: `Saved on this computer, but not yet in the cloud (${messageOf(error)}). It will be sent on the next sync.`,
      errors: [],
      settings: normalized,
    };
  }
  try {
    await writeLocal({ branchId, settings: kept, dirty: false });
  } catch (error) {
    return { saved: true, pushed: true, error: `Saved to the cloud, but this computer's copy could not be updated (${messageOf(error)}).`, errors: [], settings: kept };
  }
  return { saved: true, pushed: true, error: null, errors: [], settings: kept };
};
