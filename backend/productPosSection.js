"use strict";

/**
 * The owner's choice of POS shelf for a product: the one decision about what `pos_section` may hold.
 *
 * Pure on purpose, like `productPhoto.js`: the product create and edit routes in `server.js` call
 * this and nothing else, so the rule is testable without a database.
 *
 * ## The values
 *
 * `'retail' | 'bar' | 'moments'`, stored lower-case. NULL means automatic: the POS derives the
 * shelf from the product's category and name exactly as it always has. An absent value, `null` and
 * an empty string all mean automatic. Anything else is refused, never stored and never silently
 * turned into automatic -- a typo must not quietly move a product to another shelf.
 *
 * ## What a refusal looks like
 *
 * `{ ok: false, code: "POS_SECTION_INVALID", message }`, the message written for the shop owner.
 */

const POS_SECTIONS = Object.freeze(["retail", "bar", "moments"]);

const POS_SECTION_INVALID = "POS_SECTION_INVALID";

const INVALID = Object.freeze({
  ok: false,
  code: POS_SECTION_INVALID,
  message: "Choose a POS section: Retail, Bar, Moments, or Automatic.",
});

/** `{ ok: true, value: 'retail' | 'bar' | 'moments' | null }` or `{ ok: false, code, message }`. */
const parsePosSection = (value) => {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return INVALID;
  const key = value.trim().toLowerCase();
  if (key === "") return { ok: true, value: null };
  if (POS_SECTIONS.includes(key)) return { ok: true, value: key };
  return INVALID;
};

module.exports = {
  POS_SECTIONS,
  POS_SECTION_INVALID,
  parsePosSection,
};
