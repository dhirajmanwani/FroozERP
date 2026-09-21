/**
 * What the FROST panel puts in front of the owner, and what it keeps one tap away.
 *
 * ## The complaint this answers
 *
 * The panel opened onto eleven tabs in a row — Briefing, Ask FROST, Voice, Alerts, Decision Center,
 * Predictions, Profit Advisor, Memory, Reminders, History, Settings — above a period dropdown, a
 * Refresh button and a second heading that said "FROST" under a drawer heading that already said
 * "FROST". The maintainer's words: "there are a lot of options on the title bar, make it
 * sophisticated, simple for me, like a true ai model".
 *
 * Eleven equal tabs is a filing cabinet, not an assistant. An assistant has one surface — the
 * conversation — and everything else is somewhere you go when you want it.
 *
 * ## The shape
 *
 * One primary surface, always the conversation. Everything else becomes a menu entry with a label
 * and a plain-language line saying what is in there, ordered by how often an owner running a fruit
 * shop would actually open it. Talking becomes a control on the composer, in the same way typing
 * is, so the everyday way to hear FROST is not a place you navigate to.
 *
 * The old Voice tab is not deleted, and not promoted either. It opens a live microphone session
 * with a third-party provider that is sent no tools, so it cannot read the books and would speak a
 * number nobody can check. It fails closed today because no key is configured. Removing it would
 * hide a thing that still exists in the code; leaving it in the row would offer it as an equal to
 * the parts that work. So it sits in the footer with a label that says what is true about it.
 *
 * The old Briefing tab splits in two rather than disappearing, because it was two things wearing
 * one name. Its recommendations are what FROST would say if asked how today looks, so they open the
 * conversation. Its six metric tiles and insight cards are something to look at rather than
 * something said, so they stay a place, under the name an owner would use for them.
 *
 * ## Access is not decided here
 *
 * The caller passes `canManageFrost` and `canManageReminders` already computed, with exactly the
 * expressions the panel used before. This module narrows what is *shown*; it must never be the
 * thing that decides who may do what, and a UI that hides a section is not a permission anyway —
 * the server's own checks are. Keeping the booleans as inputs means a future change to who may
 * manage FROST happens in one place and this file is not it.
 */

/**
 * Every section the panel can show, in menu order.
 *
 * `daily` marks the ones worth surfacing as a shortcut beside the composer; the rest are reached
 * through the menu. The order is deliberate and is the answer to "make it simple": what an owner
 * opens most sits nearest.
 */
const SECTIONS = Object.freeze([
  { key: "today", label: "Today's numbers", blurb: "Sales, profit, dues and low stock at a glance", daily: true },
  { key: "alerts", label: "Alerts", blurb: "What needs attention today", daily: true },
  { key: "reminders", label: "Reminders", blurb: "What you asked FROST to remember", daily: true, requires: "reminders" },
  { key: "decision", label: "Decision Center", blurb: "Actions waiting for your approval" },
  { key: "predictions", label: "Predictions", blurb: "Where stock, sales and cash are heading" },
  { key: "profit", label: "Profit Advisor", blurb: "Where the margin is going" },
  { key: "memory", label: "Memory", blurb: "What FROST knows about your shop", requires: "frost" },
  { key: "voice", label: "Live voice", blurb: "Not connected to your books yet", requires: "frost", footer: true },
  { key: "settings", label: "FROST Settings", blurb: "Provider, model and limits", requires: "frost", footer: true },
]);

/** The one surface the panel opens onto. It is not a menu entry and cannot be hidden. */
export const FROST_PRIMARY_SECTION = "conversation";

const allowed = (section, { canManageFrost, canManageReminders }) => {
  if (section.requires === "frost") return canManageFrost === true;
  if (section.requires === "reminders") return canManageReminders === true;
  return true;
};

/**
 * The panel's chrome for this user and this moment.
 *
 * @param {object} input
 * @param {string} input.activeSection      the section currently open, or the conversation
 * @param {boolean} input.canManageFrost    same expression the panel used before
 * @param {boolean} input.canManageReminders same expression the panel used before
 * @param {number} input.alertCount         unresolved alerts, for the badge
 * @returns {{primary: string, activeSection: string, onConversation: boolean,
 *            shortcuts: Array<object>, menu: Array<object>, footer: Array<object>}}
 */
export const resolveFrostSurface = ({
  activeSection = FROST_PRIMARY_SECTION,
  canManageFrost = false,
  canManageReminders = false,
  alertCount = 0,
} = {}) => {
  const permitted = SECTIONS.filter((section) => allowed(section, { canManageFrost, canManageReminders }));
  const badge = (key) => {
    const count = Number(alertCount);
    return key === "alerts" && Number.isFinite(count) && count > 0 ? count : 0;
  };
  const decorate = (section) => ({
    key: section.key,
    label: section.label,
    blurb: section.blurb,
    badge: badge(section.key),
    active: section.key === activeSection,
  });
  // A section the user may not reach must not leave the panel stuck on it. This is the same class
  // as an error rendering as zero: a blank body where a section used to be reads as lost data.
  const reachable = permitted.some((section) => section.key === activeSection);
  const section = reachable ? activeSection : FROST_PRIMARY_SECTION;
  return {
    primary: FROST_PRIMARY_SECTION,
    activeSection: section,
    onConversation: section === FROST_PRIMARY_SECTION,
    shortcuts: permitted.filter((entry) => entry.daily === true).map(decorate),
    menu: permitted.filter((entry) => entry.footer !== true).map(decorate),
    footer: permitted.filter((entry) => entry.footer === true).map(decorate),
  };
};

/**
 * The period filter, said in words rather than left as a dropdown value.
 *
 * CLAUDE.md: an effective filter must be visible to the user. Report Center learned this the hard
 * way — a `today` range applied while the date inputs looked empty. The conversation hides the
 * select behind a menu, so the label has to appear in the thread instead, and an unrecognised value
 * is named rather than silently drawn as "Today".
 */
export const FROST_RANGE_LABELS = Object.freeze({
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  this_month: "This month",
});

export const describeFrostRange = (range) => {
  const key = String(range || "").trim();
  if (!key) return "No period selected";
  return FROST_RANGE_LABELS[key] || `Period: ${key}`;
};
