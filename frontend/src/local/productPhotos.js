// Product photos: the picture the owner picks for each product in Product Master, shown on the
// POS tiles of every counter.
//
// Where a photo comes from: the owner copies an image in a browser (Google Images, Pinterest:
// right-click, "Copy image") and pastes it into Product Master, or saves it and chooses the file.
// The app never fetches a picture from the internet itself (LOCAL_ONLY and the CSP both forbid
// that), and nothing is generated.
//
// Where it lives: in the cloud's `product_photos` table, one row per product, deliberately not on
// the product row. The whole product row is copied into the sync log and audit trail on every
// edit and sent to every device in the reference bootstrap; a photo there would ride along each
// time. Each device keeps its own copy of the photo list (IndexedDB), so a counter that is offline
// still shows yesterday's pictures.
//
// Photos are presentation only. A missing or failed photo never blocks a sale: the tile falls back
// to the product's colour and first letter.

import { canonicalInventoryId } from "./stockInventory.js";

/** Mirrors PRODUCT_PHOTO_MAX_BYTES in backend/productPhoto.js; the server refuses anything larger. */
export const PRODUCT_PHOTO_MAX_BYTES = 200 * 1024;
/** The longest side a stored photo keeps. A POS tile shows ~52px; Product Master previews ~120px. */
export const PRODUCT_PHOTO_EDGE = 320;
/** What the app aims for, well under the server limit, so a whole shop's photos stay a light download. */
export const PRODUCT_PHOTO_TARGET_BYTES = 40 * 1024;
export const PRODUCT_PHOTO_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp"]);

const DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

/** The largest size with the same shape that fits inside `edge` on its longest side. */
export function fitWithin(width, height, edge = PRODUCT_PHOTO_EDGE) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const scale = Math.min(1, edge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** How many bytes a base64 data URL decodes to, or null when it is not one. */
export function photoDataUrlBytes(dataUrl) {
  const match = String(dataUrl ?? "").match(DATA_URL);
  if (!match) return null;
  const body = match[2];
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return (body.length / 4) * 3 - padding;
}

/**
 * Whether a photo may be sent, and if not, a sentence the owner can act on. The server checks the
 * same things; checking here first means the owner hears it before waiting on the network.
 */
export function checkProductPhoto(dataUrl) {
  if (!dataUrl) return { ok: false, message: "No photo chosen." };
  const bytes = photoDataUrlBytes(dataUrl);
  if (bytes === null) return { ok: false, message: "That is not a JPEG, PNG or WebP photo." };
  if (bytes > PRODUCT_PHOTO_MAX_BYTES) {
    return { ok: false, message: `The photo is ${Math.ceil(bytes / 1024)} KB after shrinking, over the 200 KB limit. Choose a simpler photo.` };
  }
  return { ok: true, bytes };
}

/**
 * The image file in a paste or a drop, or null. Google Images and Pinterest put the picture itself
 * on the clipboard with "Copy image"; a dragged browser image often carries only its address,
 * which is not a picture the app may fetch, so that case says so instead of silently doing nothing.
 */
export function imageFromTransfer(transfer) {
  const items = Array.from(transfer?.items || []);
  for (const item of items) {
    if (item?.kind === "file" && String(item.type || "").startsWith("image/")) {
      const file = item.getAsFile?.();
      if (file) return { file };
    }
  }
  const files = Array.from(transfer?.files || []);
  const file = files.find((entry) => String(entry?.type || "").startsWith("image/"));
  if (file) return { file };
  const hasLink = items.some((item) => item?.kind === "string" && /uri-list|html|plain/.test(String(item.type || "")));
  return {
    file: null,
    message: hasLink
      ? "That pasted the photo's web address, not the photo. In the browser, right-click the photo and choose \"Copy image\", then paste here."
      : "No photo found. Right-click a photo in the browser, choose \"Copy image\", then paste here.",
  };
}

/**
 * Shrink a picked image to a stored photo: at most PRODUCT_PHOTO_EDGE on its longest side, JPEG,
 * stepping the quality down until it is under the target. `tools` is the browser (createImageBitmap
 * and a canvas); tests pass fakes. Throws with a plain sentence when the image cannot be read.
 */
export async function shrinkProductPhoto(blob, tools) {
  const { createImageBitmap, createCanvas } = tools;
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error("That file could not be opened as a photo.");
  }
  const size = fitWithin(bitmap.width, bitmap.height);
  if (!size) throw new Error("That photo has no size.");
  const canvas = createCanvas(size.width, size.height);
  const context = canvas.getContext("2d");
  // JPEG has no transparency: a PNG cut-out on transparent ground would otherwise turn black.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close?.();
  let dataUrl = "";
  for (const quality of [0.86, 0.78, 0.7, 0.6, 0.5]) {
    dataUrl = canvas.toDataURL("image/jpeg", quality);
    if ((photoDataUrlBytes(dataUrl) ?? Infinity) <= PRODUCT_PHOTO_TARGET_BYTES) break;
  }
  return dataUrl;
}

const idKey = (value) => {
  const key = canonicalInventoryId(value);
  return key === null || key === undefined || key === "" ? null : String(key);
};

/** product id → photo data URL, with ids compared the canonical way ("004" is not 4). */
export function indexProductPhotos(photos) {
  const index = new Map();
  for (const row of Array.isArray(photos) ? photos : []) {
    const key = idKey(row?.product_id);
    if (key && typeof row?.photo === "string" && photoDataUrlBytes(row.photo) !== null) index.set(key, row.photo);
  }
  return index;
}

/** The photo for a product, looked up by its id and then by its cloud id; null when it has none. */
export function photoForProduct(index, product) {
  if (!index?.size || !product) return null;
  for (const candidate of [product.id, product.cloud_id, product.product_id]) {
    const key = idKey(candidate);
    if (key && index.has(key)) return index.get(key);
  }
  return null;
}

// ---- The device's own copy -------------------------------------------------------------------

const CACHE_DB = "froozerp-product-photos";
const CACHE_STORE = "photos";
const CACHE_KEY = "all";

const request = (operation) => new Promise((resolve, reject) => {
  operation.onsuccess = () => resolve(operation.result);
  operation.onerror = () => reject(operation.error);
});

const openCache = async (indexedDB) => {
  const opening = indexedDB.open(CACHE_DB, 1);
  opening.onupgradeneeded = () => opening.result.createObjectStore(CACHE_STORE);
  return request(opening);
};

/** The photo list this device saw last, or null (none yet, storage blocked, or unreadable). */
export async function readCachedProductPhotos(indexedDB) {
  try {
    if (!indexedDB) return null;
    const db = await openCache(indexedDB);
    try {
      const value = await request(db.transaction(CACHE_STORE, "readonly").objectStore(CACHE_STORE).get(CACHE_KEY));
      return Array.isArray(value?.photos) ? value : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Keep the list for offline use. Returns false when the device would not store it. */
export async function writeCachedProductPhotos(indexedDB, photos, savedAt = new Date().toISOString()) {
  try {
    if (!indexedDB) return false;
    const db = await openCache(indexedDB);
    try {
      await request(db.transaction(CACHE_STORE, "readwrite").objectStore(CACHE_STORE).put({ photos, savedAt }, CACHE_KEY));
      return true;
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/**
 * Merge one saved or removed photo into a list, so the screen updates at once without waiting
 * for the next full download.
 */
export function withProductPhoto(photos, productId, photo, updatedAt = new Date().toISOString()) {
  const key = idKey(productId);
  const rest = (Array.isArray(photos) ? photos : []).filter((row) => idKey(row?.product_id) !== key);
  return photo ? [...rest, { product_id: productId, photo, updated_at: updatedAt }] : rest;
}
