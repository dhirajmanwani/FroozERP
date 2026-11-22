/**
 * The words and links a delivery hands to other apps: the block pasted into Rapido or Uber, the
 * WhatsApp message to the customer, the map link and the `tel:` link behind the rider's QR code.
 *
 * Nothing here sends anything. A `wa.me` link opens WhatsApp with the text typed in and a person
 * presses Send; a `tel:` link is dialled by a person's phone. That is the same safety argument as
 * `frostDuesOutreach.js`, whose number normaliser and `wa.me` builder this module reuses rather than
 * keeping a second idea of what a valid number is.
 *
 * ## Numbers
 *
 * Riders and customers here are Indian mobiles, so {@link normalizeIndianMobile} is stricter than the
 * general WhatsApp normaliser: it answers `91` + ten digits starting 6–9, or `""`. A number that does
 * not fit gets no link at all rather than a link that rings a stranger — a QR code on the board that
 * dials the wrong person is worse than one that is missing.
 *
 * ## Templates
 *
 * Customer messages are templates with `{placeholder}`s, edited per branch in Settings → Delivery. A
 * line whose placeholders all came out empty is dropped (no "Track here: " with nothing after it), and
 * an unknown placeholder is left exactly as typed, so a typo is visible in the preview instead of
 * vanishing from the message.
 */

import { normalizeWhatsappNumber, whatsappDraftLink } from "./frostDuesOutreach.js";
import { PAID_BY, deliveryChargePaise } from "./deliveryLifecycle.js";

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/* ----------------------------------------------------------------------------- numbers ------- */

/**
 * An Indian mobile number as `91XXXXXXXXXX`, or `""`.
 *
 * Accepts the ways people actually write them: `98765 43210`, `+91-98765-43210`, `09876543210`,
 * `0091 98765 43210`.
 */
export const normalizeIndianMobile = (phone) => {
  let digits = text(phone).replace(/[^\d+]/g, "");
  // A trunk-prefixed 0 (`09876543210`) is the local habit; the general normaliser would keep the 0.
  if (/^0\d{10}$/.test(digits)) digits = digits.slice(1);
  const normalized = normalizeWhatsappNumber(digits, "91");
  return /^91[6-9]\d{9}$/.test(normalized) ? normalized : "";
};

/** `+91 98765 43210`, for reading aloud and printing, or the input as typed when it is not a mobile. */
export const formatIndianMobile = (phone) => {
  const normalized = normalizeIndianMobile(phone);
  if (!normalized) return text(phone);
  return `+91 ${normalized.slice(2, 7)} ${normalized.slice(7)}`;
};

/** `tel:+91XXXXXXXXXX` (the text behind the rider's QR code), or `""`. */
export const telLink = (phone) => {
  const normalized = normalizeIndianMobile(phone);
  return normalized ? `tel:+${normalized}` : "";
};

/**
 * `https://wa.me/91XXXXXXXXXX?text=...`, or `""` when the number is not a mobile.
 *
 * With no text it still opens the chat (`https://wa.me/91XXXXXXXXXX`): "WhatsApp the customer" is
 * useful without a prepared message. It never opens `wa.me` without a number — that is a contact
 * picker, and a picker is how a message reaches the wrong customer.
 */
export const whatsappLink = (phone, message) => {
  const normalized = normalizeIndianMobile(phone);
  if (!normalized) return "";
  return whatsappDraftLink(normalized, text(message)) || `https://wa.me/${normalized}`;
};

/* -------------------------------------------------------------------------------- maps ------- */

const isWebLink = (value) => /^https?:\/\/\S+$/i.test(text(value));

const GOOGLE_MAPS_SEARCH = "https://www.google.com/maps/search/?api=1&query=";

/** `"lat,lng"` (with optional spaces) as a valid coordinate pair, or `null`. */
const coordinatesOf = (value) => {
  const match = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text(value));
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return `${match[1]},${match[2]}`;
};

/**
 * A link a rider can open: the stored link if it is http(s), a pin if it is `lat,lng`, else a Google
 * Maps search for the address text, else `""`.
 *
 * Only http(s) is passed through. A stored `javascript:` or `file:` value is not a map and is never
 * handed to the browser.
 */
export const mapLink = ({ map_link, address, landmark, area_name } = {}) => {
  if (isWebLink(map_link)) return text(map_link);
  const pin = coordinatesOf(map_link);
  if (pin) return `${GOOGLE_MAPS_SEARCH}${encodeURIComponent(pin)}`;
  const parts = [address, landmark, area_name].map(text).filter(Boolean);
  if (parts.length === 0) return "";
  return `${GOOGLE_MAPS_SEARCH}${encodeURIComponent(parts.join(", "))}`;
};

/** The shop's pickup pin as a link: `settings.pickup_pin` when it is a URL or `lat,lng`, else `""`. */
export const pickupMapLink = (settings) => {
  const pin = settings?.pickup_pin;
  if (isWebLink(pin)) return text(pin);
  const coordinates = coordinatesOf(pin);
  return coordinates ? `${GOOGLE_MAPS_SEARCH}${encodeURIComponent(coordinates)}` : "";
};

/* ------------------------------------------------------------------------------- money ------- */

const rupeeFormatter = (fractionDigits) => new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: fractionDigits,
  maximumFractionDigits: fractionDigits,
});

/** `₹1,250` or `₹45.50`, from integer paise; `""` when there is no amount. */
export const formatPaise = (paise) => {
  if (!Number.isFinite(paise)) return "";
  const rounded = Math.round(paise);
  return `₹${rupeeFormatter(rounded % 100 === 0 ? 0 : 2).format(rounded / 100)}`;
};

/* ----------------------------------------------------------------------- rider copy text ------ */

const firstText = (...values) => {
  for (const value of values) {
    const candidate = text(value);
    if (candidate) return candidate;
  }
  return "";
};

/** Who and where the parcel goes, from the delivery first and then from its order. */
const dropOf = (delivery, order) => ({
  name: firstText(delivery?.customer_name, order?.customer_name),
  phone: firstText(delivery?.customer_phone, order?.customer_mobile),
  address: firstText(delivery?.address, order?.delivery_address),
  landmark: text(delivery?.landmark),
  area: text(delivery?.area_name),
  map_link: text(delivery?.map_link),
});

/**
 * The block pasted into Rapido or Uber when booking: pickup, drop, order number, and — when the
 * customer pays for the delivery — what the rider is to collect.
 *
 * Blank facts are left out rather than printed as "Landmark: ", so the rider never wonders whether a
 * field was forgotten. The amount line appears only when the charge is known; a customer-paid
 * delivery with no charge yet says so instead of printing ₹0.
 */
export const buildRiderCopyText = ({ delivery, order, settings, shopName } = {}) => {
  const drop = dropOf(delivery, order);
  const lines = [];
  const pickupLink = pickupMapLink(settings);
  const pickupName = text(shopName);
  const pickupAddress = text(settings?.pickup_address);
  if (pickupName || pickupAddress || pickupLink) {
    lines.push("PICKUP");
    if (pickupName) lines.push(pickupName);
    if (pickupAddress) lines.push(pickupAddress);
    if (pickupLink) lines.push(`Pin: ${pickupLink}`);
    lines.push("");
  }
  lines.push("DROP");
  if (drop.name) lines.push(drop.name);
  if (drop.phone) lines.push(`Phone: ${formatIndianMobile(drop.phone)}`);
  if (drop.address) lines.push(drop.address);
  if (drop.landmark) lines.push(`Landmark: ${drop.landmark}`);
  if (drop.area) lines.push(`Area: ${drop.area}`);
  const dropLink = mapLink({ map_link: drop.map_link, address: drop.address, landmark: drop.landmark, area_name: drop.area });
  if (dropLink) lines.push(`Map: ${dropLink}`);
  const orderNo = firstText(order?.order_no, delivery?.order_no);
  if (orderNo) {
    lines.push("");
    lines.push(`Order: ${orderNo}`);
  }
  if (text(delivery?.paid_by).toLowerCase() === PAID_BY.CUSTOMER) {
    const charge = deliveryChargePaise(delivery);
    lines.push(charge === null
      ? "Delivery charge: paid by the customer"
      : `Collect delivery charge from customer: ${formatPaise(charge)}`);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

/* ---------------------------------------------------------------------------- templates ------ */

export const DELIVERY_PLACEHOLDERS = Object.freeze([
  "{name}",
  "{order_no}",
  "{tracking_link}",
  "{rider_name}",
  "{rider_phone}",
  "{amount}",
  "{shop}",
]);

export const DELIVERY_MESSAGE_KIND = Object.freeze({
  BOOKED: "booked",
  PICKED_UP: "picked_up",
  DELIVERED: "delivered",
});

/**
 * The texts a branch starts with. Short and friendly, one fact per line so that a fact nobody filled
 * in (no tracking link for own staff) drops out cleanly.
 */
export const DEFAULT_DELIVERY_TEMPLATES = Object.freeze({
  booked: [
    "Hi {name}, aapka order {order_no} delivery ke liye book ho gaya hai.",
    "Rider: {rider_name} {rider_phone}",
    "Track: {tracking_link}",
    "Delivery charge: {amount}",
    "- {shop}",
  ].join("\n"),
  picked_up: [
    "Hi {name}, aapka order {order_no} nikal gaya hai, rider raste mein hai.",
    "Rider: {rider_name} {rider_phone}",
    "Track: {tracking_link}",
    "- {shop}",
  ].join("\n"),
  delivered: [
    "Hi {name}, aapka order {order_no} deliver ho gaya. Thank you!",
    "- {shop}",
  ].join("\n"),
});

const PLACEHOLDER_PATTERN = /\{([a-z_]+)\}/g;
const PLACEHOLDER_KEYS = DELIVERY_PLACEHOLDERS.map((entry) => entry.slice(1, -1));

/** Placeholders a template uses that this app does not fill, e.g. `["{nmae}"]`. */
export const unknownPlaceholders = (template) => {
  const found = new Set();
  for (const match of String(template ?? "").matchAll(/\{([^{}\s]*)\}/g)) {
    if (!PLACEHOLDER_KEYS.includes(match[1])) found.add(match[0]);
  }
  return [...found];
};

/**
 * Fill a template's placeholders from `values` (keys with or without braces).
 *
 * A line whose known placeholders all came out empty is dropped; a line with at least one filled, or
 * with none at all, is kept. Unknown placeholders are left exactly as typed. Spaces left before
 * punctuation by an empty value ("Hi , ...") are tidied.
 */
export const fillDeliveryTemplate = (template, values = {}) => {
  const lookup = {};
  for (const [key, value] of Object.entries(values || {})) {
    lookup[String(key).replace(/^\{|\}$/g, "")] = text(value);
  }
  const lines = String(template ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  for (const line of lines) {
    let used = 0;
    let filled = 0;
    const replaced = line.replace(PLACEHOLDER_PATTERN, (whole, key) => {
      if (!PLACEHOLDER_KEYS.includes(key)) return whole;
      used += 1;
      const value = lookup[key] || "";
      if (value) filled += 1;
      return value;
    });
    if (used > 0 && filled === 0) continue;
    out.push(replaced.replace(/[ \t]+([,.!?])/g, "$1").replace(/[ \t]{2,}/g, " ").trim());
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

/**
 * The WhatsApp message for one moment of a delivery (`booked`, `picked_up`, `delivered`).
 *
 * The branch's template when it has one, else the default (the cloud stores `""` to mean "use the
 * default"). `{amount}` is the delivery charge and is filled only when the customer is paying it — a
 * shop-paid delivery's cost is the shop's business, not the customer's. Returns `""` for an unknown
 * kind rather than guessing a message.
 */
export const buildCustomerMessage = ({ kind, delivery, order, settings, shopName } = {}) => {
  const key = text(kind).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_DELIVERY_TEMPLATES, key)) return "";
  const custom = settings?.templates?.[key];
  const template = text(custom) ? String(custom) : DEFAULT_DELIVERY_TEMPLATES[key];
  const drop = dropOf(delivery, order);
  const customerPays = text(delivery?.paid_by).toLowerCase() === PAID_BY.CUSTOMER;
  const charge = customerPays ? deliveryChargePaise(delivery) : null;
  const riderPhone = text(delivery?.rider_phone);
  return fillDeliveryTemplate(template, {
    name: drop.name,
    order_no: firstText(order?.order_no, delivery?.order_no),
    tracking_link: isWebLink(delivery?.tracking_link) ? text(delivery.tracking_link) : "",
    rider_name: text(delivery?.rider_name),
    rider_phone: riderPhone ? formatIndianMobile(riderPhone) : "",
    amount: charge === null ? "" : formatPaise(charge),
    shop: text(shopName),
  });
};
