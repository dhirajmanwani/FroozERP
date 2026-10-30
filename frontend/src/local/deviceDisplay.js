// How a computer or phone is named on screen: what kind of machine it is, and a short form of its
// device id. Used by every device table in Branches & Counters (Step 4 and Step 5).
//
// A device id is one long unbroken word (FZDEV-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX, or
// FZDEV-ANDROID-<32 hex>). Printed in full under a machine's name it either ran out of its cell
// into the next one or, wrapped, took four lines (30 Oct 2026). The short form keeps the start and
// the end, which is what a person compares; the full id stays on the element's tooltip.

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

export const DEVICE_ID_SHORT_MAX = 20;

/**
 * "FZDEV-D2328EAF-7C41-4B9E-A0D3-5F18C2E94B71" -> "FZDEV-D2328EAF…4B71".
 * Ids that already fit are returned unchanged, so a short id is never given an ellipsis.
 */
export const shortDeviceId = (deviceId) => {
  const id = text(deviceId);
  if (id.length <= DEVICE_ID_SHORT_MAX) return id;
  const parts = id.split("-");
  // The prefix plus the first block that is not a word ("FZDEV-ANDROID-9a3f7c21" keeps ANDROID).
  let head = "";
  for (const part of parts) {
    head = head ? `${head}-${part}` : part;
    if (/\d/.test(part) || head.length >= 14) break;
  }
  if (head.length > 18) head = head.slice(0, 18);
  const tail = id.slice(-4);
  if (head.length + 1 + tail.length >= id.length) return id;
  return `${head}…${tail}`;
};

const KINDS = Object.freeze({
  laptop: { icon: "laptop", label: "Laptop" },
  desktop: { icon: "monitor", label: "Desktop" },
  windows: { icon: "monitor", label: "Windows computer" },
  tablet: { icon: "tablet", label: "Tablet" },
  android: { icon: "phone", label: "Android phone" },
  iphone: { icon: "phone", label: "iPhone" },
  browser: { icon: "monitor", label: "Browser" },
  other: { icon: "monitor", label: "Computer" },
});

/**
 * What kind of machine a device row is. The kind the Owner chose when approving it (Step 4,
 * `device_type` on the assignment: LAPTOP, DESKTOP, TABLET, ANDROID_PHONE, IPHONE, OTHER) wins over
 * what the app reported about itself (`platform`/`device_type` on the registration: tauri-windows,
 * android, Browser).
 */
export const deviceKind = ({ assignedType, platform, reportedType } = {}) => {
  const chosen = text(assignedType).toUpperCase();
  if (chosen === "LAPTOP") return KINDS.laptop;
  if (chosen === "DESKTOP") return KINDS.desktop;
  if (chosen === "TABLET") return KINDS.tablet;
  if (chosen === "ANDROID_PHONE") return KINDS.android;
  if (chosen === "IPHONE") return KINDS.iphone;
  const reported = `${text(platform)} ${text(reportedType)}`.toLowerCase();
  if (reported.includes("android")) return KINDS.android;
  if (reported.includes("ios") || reported.includes("iphone")) return KINDS.iphone;
  if (reported.includes("windows")) return KINDS.windows;
  if (reported.includes("browser") || reported.includes("web")) return KINDS.browser;
  return KINDS.other;
};

const pad = (value) => String(value).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2027-10-30" -> "30 Oct 2027". Anything that is not a calendar date comes back as it was. */
export const formatDeviceDate = (value) => {
  const raw = text(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!match) return raw;
  const month = MONTHS[Number(match[2]) - 1];
  return month ? `${Number(match[3])} ${month} ${match[1]}` : raw;
};

/**
 * A timestamp as two short lines, { date: "31 Oct 2026", time: "12:15 am" }, in the computer's own
 * time; null when there is nothing readable to show.
 */
export const deviceSeenParts = (value) => {
  const raw = text(value);
  if (!raw) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  const hours = at.getHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return {
    date: `${at.getDate()} ${MONTHS[at.getMonth()]} ${at.getFullYear()}`,
    time: `${hour12}:${pad(at.getMinutes())} ${hours < 12 ? "am" : "pm"}`,
  };
};
