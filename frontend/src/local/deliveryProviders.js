/**
 * Who carries the parcel.
 *
 * The original spec asked for a Rust `DeliveryProvider` trait with booking calls. Rapido and Uber
 * both keep their partner APIs behind onboarding, approval and volume minimums, so v1 books every
 * rider by hand in the provider's own app and records what was pasted back. That makes the "provider"
 * here a label plus a hint about how to book, with `supportsApi: false` on every one of them — the
 * same decision migration 020 took for the order's free-text carrier, for the same reasons.
 *
 * The shape is kept anyway (one {@link MANUAL_PROVIDER} booking mode, `supportsApi` on each entry) so
 * that if an API ever is wired in, the screens already branch on a flag instead of on a name.
 *
 * The ids are stored: they are in the SQLite CHECK, the Rust constants and the cloud sanitiser, so
 * they must never be renamed here alone.
 */

export const PROVIDER = Object.freeze({
  RAPIDO: "rapido",
  UBER: "uber",
  OWN_STAFF: "own_staff",
  OTHER: "other",
});

export const PROVIDER_LABEL = Object.freeze({
  rapido: "Rapido",
  uber: "Uber",
  own_staff: "Own staff",
  other: "Other",
});

export const PROVIDER_IDS = Object.freeze(Object.values(PROVIDER));

/** The only booking mode in v1: a person books in the provider's app and types the result here. */
export const MANUAL_PROVIDER = Object.freeze({
  id: "manual",
  label: "Manual booking",
  supportsApi: false,
  canQuote: false,
  canTrack: false,
  description: "Book the rider in the provider's own app, then record the rider, phone, tracking link and charge here.",
});

const BOOKING_HINT = Object.freeze({
  rapido: "Open Rapido (Parcel), paste the pickup and drop from \"Copy for rider\", book, then enter the rider's name, phone and tracking link here.",
  uber: "Open Uber (Connect / Courier), paste the pickup and drop from \"Copy for rider\", book, then enter the rider's name, phone and tracking link here.",
  own_staff: "Hand the parcel to a staff member and enter their name and phone as the rider. No booking is needed.",
  other: "Book with any service, then enter the rider's name, phone and any tracking link here.",
});

const normalizeId = (id) => String(id ?? "").trim().toLowerCase();

/** Whether an id is one this app (and the database) accepts. */
export const isKnownProvider = (id) => PROVIDER_IDS.includes(normalizeId(id));

/**
 * The provider entry for an id. An unknown or blank id reads as {@link PROVIDER.OTHER} with
 * `known: false`, so a screen can still draw the card and say the value is unrecognised, rather than
 * throwing or inventing a label.
 *
 * @returns {{id: string, label: string, supportsApi: false, bookingMode: string, bookingHint: string, known: boolean}}
 */
export const providerFor = (id) => {
  const key = normalizeId(id);
  const known = PROVIDER_IDS.includes(key);
  const resolved = known ? key : PROVIDER.OTHER;
  return Object.freeze({
    id: resolved,
    label: PROVIDER_LABEL[resolved],
    supportsApi: false,
    bookingMode: MANUAL_PROVIDER.id,
    bookingHint: BOOKING_HINT[resolved],
    known,
  });
};

/** Every provider, in the order the picker shows them. */
export const listProviders = () => PROVIDER_IDS.map((id) => providerFor(id));
