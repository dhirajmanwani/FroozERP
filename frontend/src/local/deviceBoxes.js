// ---------------------------------------------------------------------------------------------
// One computer, one box (3 Oct 2026)
//
// The owner's rule: a computer or phone has one device id and one name, and shows as one box in
// Branches & Counters -> Computers & phones, even after an update. The Windows app now sends a
// fingerprint of the machine (`machine_fp`: a SHA-256 of its Windows machine id, never the id
// itself), and the cloud folds every device id sharing it into one box. Ids left behind by an
// install from before this rule carry no fingerprint, so the Owner can retire them by hand; a
// retired id is kept (old bills name it), it just stops being a box.
// ---------------------------------------------------------------------------------------------

import { canonicalInventoryId } from "./stockInventory.js";

const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

/** A machine fingerprint as the cloud accepts it, or "" for anything else. */
export const normalizeMachineFingerprint = (value) => {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return FINGERPRINT_PATTERN.test(text) ? text : "";
};

/** The other ids one machine has used, without the box's own id, each once, in the order given. */
export const previousDeviceIds = (device) => {
  const own = canonicalInventoryId(device?.device_id);
  // An id still asking to join is named by `waitingIdsNote` instead, not twice.
  const seen = new Set((Array.isArray(device?.waiting_device_ids) ? device.waiting_device_ids : []).map(canonicalInventoryId));
  return (Array.isArray(device?.previous_device_ids) ? device.previous_device_ids : [])
    .map(canonicalInventoryId)
    .filter((id) => id !== "" && id !== own && !seen.has(id) && seen.add(id));
};

/** "Also used: A, B" for a box that folds older ids, or "". */
export const previousIdsNote = (device) => {
  const ids = previousDeviceIds(device);
  if (ids.length === 0) return "";
  return `${ids.length === 1 ? "Older id on this machine" : `${ids.length} older ids on this machine`}: ${ids.join(", ")}`;
};

/**
 * "This machine is also asking to join as X" for an approved box whose machine has a waiting
 * request under another id, or "". The cloud keeps that request off the waiting list (the machine
 * is already approved), so it is named here: if the machine really is signing in as X now, it is
 * locked out until this old box is retired, which puts X back on the waiting list.
 */
export const waitingIdsNote = (device) => {
  const own = canonicalInventoryId(device?.device_id);
  const ids = (Array.isArray(device?.waiting_device_ids) ? device.waiting_device_ids : [])
    .map(canonicalInventoryId)
    .filter((id) => id !== "" && id !== own);
  if (ids.length === 0) return "";
  return `This machine is also asking to join as ${ids.join(", ")}. If it cannot sign in, retire this old id and approve the new one.`;
};

/**
 * Whether the Owner may retire this id from this screen. Never the computer being used to do it:
 * that would sign this very machine out of the shop.
 */
export const canRetireDeviceId = ({ deviceId, currentDeviceId, isOwner }) => {
  const id = canonicalInventoryId(deviceId);
  if (!isOwner || id === "") return false;
  return id !== canonicalInventoryId(currentDeviceId);
};

export const retireDeviceConfirmText = (device) => {
  const name = String(device?.device_name || "").trim() || "this machine";
  return `Remove the old id ${canonicalInventoryId(device?.device_id)} (${name})?\n\nDo this only for an id the machine no longer uses (an old install). Its bills stay in the books. If a machine still uses this id, it will have to ask to join again.`;
};
