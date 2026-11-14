// The name and logo at the top of every screen, on the sign-in page and on bills.
//
// They come from Settings > Business Identity, so the owner can change them without a new build:
// - the logo is the picture chosen there ("Choose logo"); with none chosen, the PEP mark that
//   ships with the app (the "pép" letters) is shown;
// - the big line is the Business Name, the same name a bill prints as the shop's name;
// - the small line under it is the Brand Name and the Company Name ("<brand> - by <company>").
//
// Only a picture stored in the settings themselves is ever drawn. A web address is never drawn,
// because every counter would then fetch it from the internet, which LOCAL_ONLY forbids; the
// server refuses to store one in the first place (backend/businessLogo.js).
//
// The sign-in page and the start-up screen are drawn before any settings have loaded, so the last
// identity seen is remembered on this computer and shown there. Losing that copy (cleared storage, a
// private window) only means those screens show the PEP mark until the next sign-in.

import { PRODUCT_PHOTO_MAX_BYTES, fitWithin, photoDataUrlBytes } from "./productPhotos.js";

export const DEFAULT_BRAND_TITLE = "THE PEP";
export const DEFAULT_BRAND_TAGLINE = "Pulp Eat Up. - by SRT Company";
export const DEFAULT_BRAND_IDENTITY = Object.freeze({
  title: DEFAULT_BRAND_TITLE,
  tagline: DEFAULT_BRAND_TAGLINE,
  logo: null,
});

export const DEFAULT_BRAND_NAME = "Pulp Eat Up.";
export const DEFAULT_INVOICE_FOOTER = "Thank you for shopping with THE PEP.";
export const DEFAULT_COMPACT_LOGO_TEXT = "PEP";

// What the server seeds into a business-settings row nobody has edited yet (backend/server.js,
// the business_settings defaults). Those words belong to an earlier name of the shop, so a row
// that still holds them is treated as "not set" when it is shown: the screen, the bill and the
// price list fall back to THE PEP. The stored row is never rewritten; the owner's own words,
// whatever they are, are always shown as typed.
export const LEGACY_DEFAULT_BUSINESS_NAME = "FroozERP Retail";
export const LEGACY_DEFAULT_BRAND_NAME = "FEEL THE FREAKIN' FROOZ";
export const LEGACY_DEFAULT_INVOICE_FOOTER = "Thank you for shopping with FEEL THE FREAKIN' FROOZ.";
export const LEGACY_DEFAULT_COMPACT_LOGO_TEXT = "FTF";

const sameWords = (a, b) => a.toLowerCase() === b.toLowerCase();

/** True when the setting still holds the old seeded default, word for word (case aside). */
export function isLegacyDefault(value, legacyDefault) {
  const typed = typeof value === "string" ? value.trim() : "";
  return Boolean(typed && legacyDefault) && sameWords(typed, legacyDefault);
}

/** The setting as typed, or "" when it is blank or still the old seeded default. */
export function displaySetting(value, legacyDefault) {
  const typed = typeof value === "string" ? value.trim() : "";
  return isLegacyDefault(typed, legacyDefault) ? "" : typed;
}

/** The shop's name for display: what the owner typed, else THE PEP. */
export function displayBusinessName(settings) {
  return displaySetting(settings?.business_name, LEGACY_DEFAULT_BUSINESS_NAME) || DEFAULT_BRAND_TITLE;
}

/** The bill's thank-you line for display: what the owner typed, else THE PEP's line. */
export function displayInvoiceFooter(settings) {
  return displaySetting(settings?.invoice_footer_text, LEGACY_DEFAULT_INVOICE_FOOTER) || DEFAULT_INVOICE_FOOTER;
}

/** The longest side a stored logo keeps. The top bar shows it at ~42px, a bill at ~64px. */
export const BRAND_LOGO_EDGE = 256;
/** What the app aims for, well under the server's 200 KB, since the logo rides in every settings load. */
export const BRAND_LOGO_TARGET_BYTES = 60 * 1024;

export const BRAND_IDENTITY_STORAGE_KEY = "froozerp.brandIdentity.v1";

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** The stored logo when it is a picture this app may draw, otherwise null. */
export function uploadedLogo(value) {
  const bytes = photoDataUrlBytes(value);
  if (bytes === null || bytes <= 0 || bytes > PRODUCT_PHOTO_MAX_BYTES) return null;
  return value;
}

/** True when the settings hold something in the logo field that is not a drawable picture. */
export function hasUnusableLogo(settings) {
  const value = text(settings?.logo_url);
  return value !== "" && uploadedLogo(value) === null;
}

/** `{ title, tagline, logo }` for business settings as the server returns them. */
export function resolveBrandIdentity(settings) {
  const safe = settings && typeof settings === "object" ? settings : {};
  const title = displayBusinessName(safe);
  // An untouched seeded row (the old default name still in place) is shown as THE PEP, and its
  // old default brand line becomes THE PEP's own. Once the owner has typed a name of their own,
  // every field is shown exactly as typed.
  const seededRow = isLegacyDefault(safe.business_name, LEGACY_DEFAULT_BUSINESS_NAME);
  const brand = seededRow && isLegacyDefault(safe.brand_name, LEGACY_DEFAULT_BRAND_NAME)
    ? DEFAULT_BRAND_NAME
    : text(safe.brand_name);
  const company = text(safe.company_name);
  // A brand name that only repeats the big line would print the same words twice.
  const brandLine = brand && brand.toLowerCase() !== title.toLowerCase() ? brand : "";
  const tagline = brandLine && company ? `${brandLine} - by ${company}` : brandLine || company;
  return { title, tagline, logo: uploadedLogo(text(safe.logo_url)) };
}

const sameIdentity = (a, b) => a.title === b.title && a.tagline === b.tagline && a.logo === b.logo;

const normaliseIdentity = (value) => {
  if (!value || typeof value !== "object") return null;
  const title = text(value.title);
  if (!title) return null;
  return { title, tagline: text(value.tagline), logo: uploadedLogo(text(value.logo)) };
};

/** The identity remembered on this computer, or the shipped default. Never throws. */
export function readCachedBrandIdentity(storage) {
  try {
    const raw = storage?.getItem?.(BRAND_IDENTITY_STORAGE_KEY);
    if (!raw) return DEFAULT_BRAND_IDENTITY;
    return normaliseIdentity(JSON.parse(raw)) || DEFAULT_BRAND_IDENTITY;
  } catch {
    return DEFAULT_BRAND_IDENTITY;
  }
}

/** Remembers the identity for the sign-in page. A storage failure is ignored: it is a convenience. */
export function writeCachedBrandIdentity(storage, identity) {
  try {
    storage?.setItem?.(BRAND_IDENTITY_STORAGE_KEY, JSON.stringify(identity));
    return true;
  } catch {
    return false;
  }
}

/**
 * The one current identity every logo on screen reads (React's `useSyncExternalStore`). A store
 * rather than props because the logo is drawn in a dozen places, several of them (the start-up
 * screen, the sign-in page, printed bills) outside the part of the app that holds the settings.
 */
export function createBrandIdentityStore(storage) {
  let current = readCachedBrandIdentity(storage);
  const listeners = new Set();
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Called when business settings have actually loaded; the defaults never reach here. */
    set: (identity) => {
      const next = normaliseIdentity(identity);
      if (!next || sameIdentity(next, current)) return current;
      current = next;
      writeCachedBrandIdentity(storage, next);
      listeners.forEach((listener) => listener());
      return current;
    },
  };
}

/**
 * Shrink a picked image to a stored logo: at most BRAND_LOGO_EDGE on its longest side. PNG first,
 * because a logo is usually a cut-out and PNG keeps the transparent ground; WebP (which also keeps
 * it) at falling quality when the PNG is too heavy. `tools` is the browser (createImageBitmap and a
 * canvas); tests pass fakes. Throws with a plain sentence when the image cannot be read.
 */
export async function shrinkBrandLogo(blob, tools) {
  const { createImageBitmap, createCanvas } = tools;
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error("That file could not be opened as a picture.");
  }
  const size = fitWithin(bitmap.width, bitmap.height, BRAND_LOGO_EDGE);
  if (!size) throw new Error("That picture has no size.");
  const canvas = createCanvas(size.width, size.height);
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, size.width, size.height);
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close?.();
  const fits = (dataUrl) => (photoDataUrlBytes(dataUrl) ?? Infinity) <= BRAND_LOGO_TARGET_BYTES;
  let dataUrl = canvas.toDataURL("image/png");
  if (fits(dataUrl)) return dataUrl;
  for (const quality of [0.9, 0.8, 0.7, 0.6]) {
    const webp = canvas.toDataURL("image/webp", quality);
    // A webview without a WebP encoder hands back PNG whatever is asked; keep the smaller one.
    if (!webp.startsWith("data:image/webp")) break;
    dataUrl = webp;
    if (fits(dataUrl)) break;
  }
  return dataUrl;
}

/** Whether a shrunk logo may be sent, and if not, a sentence the owner can act on. */
export function checkBrandLogo(dataUrl) {
  if (!dataUrl) return { ok: false, message: "No picture chosen." };
  const bytes = photoDataUrlBytes(dataUrl);
  if (bytes === null) return { ok: false, message: "That is not a JPEG, PNG or WebP picture." };
  if (bytes > PRODUCT_PHOTO_MAX_BYTES) {
    return { ok: false, message: `The logo is ${Math.ceil(bytes / 1024)} KB after shrinking, over the 200 KB limit. Choose a simpler picture.` };
  }
  return { ok: true, bytes };
}
