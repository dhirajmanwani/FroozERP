/**
 * Where a person can go in this app, and the keys that take them there.
 *
 * The sidebar, the command palette and the back/forward buttons all need the same three facts:
 * what the destinations are, what each one is called, and which keystroke reaches it. Held in
 * three places those facts drift, and drift here is invisible — a shortcut chip that promises a
 * key nothing listens for, or a palette entry that navigates to an id no view renders. So the
 * facts live here once, and `appNavigation.test.mjs` reads `App.jsx` as text to prove this file
 * still describes the app that actually ships.
 *
 * Two rules shaped everything below.
 *
 * 1. **A shortcut must never fire while somebody is typing.** The person at the counter spends
 *    the whole day in a product search box with a customer waiting. A key that jumped screens
 *    mid-sale would abandon a half-built bill. Hence Alt+digit rather than bare letters, and
 *    hence `isTypingContext` — suppression is the default and firing is the exception.
 * 2. **An unknown id is named, not guessed.** `resolveNavigationTarget` reports UNKNOWN rather
 *    than falling back to the dashboard, because a confident default sends somebody to a screen
 *    they did not ask for and looks like the app working.
 */

/** The one modifier. Alt+digit avoids both the browser's Alt+letter access keys and, being a
 *  modified chord, avoids every bare-letter collision with a form field. */
export const SHORTCUT_MODIFIER = "Alt";

export const NAVIGATION_KIND = Object.freeze({
  MODULE: "module",
  SECTION: "section",
});

export const NAVIGATION_LOOKUP = Object.freeze({
  FOUND: "found",
  UNKNOWN: "unknown",
});

/**
 * Shortcut assignment, in the order a shop actually works rather than alphabetically or in
 * sidebar order. The reasoning for the first few, because it is the part that will be argued with:
 *
 *   Alt+1  POS Billing      the till. It is where the day is spent, so it gets the key a hand
 *                           finds without looking.
 *   Alt+2  Products         opened *during* a sale to check a rate or what is left, so it sits
 *                           next to the till rather than off in a catalogue section.
 *   Alt+3  Purchase Entry   the first job of the morning, after the mandi run.
 *   Alt+4  Sale Rate Update done immediately after purchase and before the shutters go up —
 *                           one morning task with Purchase Entry, so one adjacent pair of keys.
 *   Alt+5  Orders           phone and WhatsApp orders, worked between walk-ins all day.
 *
 * 6-9 then descend by how often the screen is opened: ledgers, the credit chase, returns, and
 * the end-of-day reports.
 *
 * Alt+0 is Dashboard. 0 sits at the far end of the number row, which makes it both the "back to
 * the start" key and the one most likely to be hit by accident — so it lands on a read-only
 * overview, where a mis-hit costs nothing. That is also why Settings, which is where the damage
 * lives, carries no shortcut at all: it is reachable from the sidebar and the palette, which are
 * both deliberate acts. Waste, Discounts, Expenses and All Shops are unassigned for the plainer
 * reason that there are ten digits and fifteen modules, and these are the five least-opened.
 */
const modules = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: "grid",
    shortcut: "0",
    keywords: ["home", "overview", "today", "summary", "start"],
    sections: [],
  },
  {
    id: "products",
    label: "Products",
    icon: "box",
    shortcut: "2",
    keywords: ["items", "fruit", "catalogue", "price list", "rate", "stock"],
    sections: [],
  },
  {
    id: "purchase",
    label: "Purchase Entry",
    icon: "cart",
    shortcut: "3",
    keywords: ["mandi", "supplier", "buy", "inward", "lot", "arrival"],
    sections: [],
  },
  {
    id: "pending-bills",
    label: "Pending Bills",
    icon: "alert",
    shortcut: "7",
    keywords: ["unpaid", "outstanding", "due", "credit", "supplier payment"],
    sections: [],
  },
  {
    id: "accounts",
    label: "Accounts",
    icon: "users",
    shortcut: "6",
    keywords: ["ledger", "customer", "supplier", "party", "balance", "statement"],
    sections: [],
  },
  {
    id: "returns",
    label: "Sale Returns",
    icon: "history",
    shortcut: "8",
    keywords: ["refund", "customer return", "credit note", "take back"],
    sections: [],
  },
  {
    id: "waste",
    label: "Waste Management",
    icon: "alert",
    shortcut: null,
    keywords: ["spoilage", "damage", "rotten", "wastage", "throw"],
    sections: [],
  },
  {
    id: "sales",
    label: "POS Billing",
    icon: "receipt",
    shortcut: "1",
    keywords: ["pos", "counter", "till", "invoice", "bill", "sell", "cart"],
    sections: [],
  },
  {
    id: "discounts",
    label: "Discounts",
    icon: "wallet",
    shortcut: null,
    keywords: ["offer", "slab", "concession", "bill discount"],
    sections: [],
  },
  {
    id: "sale-rates",
    label: "Sale Rate Update",
    icon: "trend",
    shortcut: "4",
    keywords: ["selling price", "daily rate", "margin", "approve rate"],
    sections: [],
  },
  {
    id: "expenses",
    label: "Expenses",
    icon: "wallet",
    shortcut: null,
    keywords: ["spending", "petty cash", "overheads", "paid out"],
    sections: [],
  },
  {
    id: "orders",
    label: "Orders",
    icon: "parcel",
    shortcut: "5",
    keywords: ["advance order", "phone order", "whatsapp", "booking", "reserved"],
    sections: [],
  },
  {
    id: "reports",
    label: "Reports",
    icon: "chart",
    shortcut: "9",
    keywords: ["report center", "analysis", "export", "print", "history"],
    // Report Center already drills down by category. These ids are the category ids it selects
    // with, so a palette entry can open a category directly instead of landing on the index.
    sections: [
      { id: "reports/orders", label: "Order Reports", eyebrow: "Report Center", keywords: ["fulfilment", "by customer", "open orders"] },
      { id: "reports/sales", label: "Sales Reports", eyebrow: "Report Center", keywords: ["sales history", "discount report", "bills"] },
      { id: "reports/purchase", label: "Purchase Reports", eyebrow: "Report Center", keywords: ["purchase history", "supplier bills", "mandi"] },
      { id: "reports/accounts", label: "Accounts & Ledger", eyebrow: "Report Center", keywords: ["customer ledger", "supplier ledger", "receivable", "payable", "statement"] },
      { id: "reports/returns", label: "Sale Returns", eyebrow: "Report Center", keywords: ["return history", "return value", "reason"] },
      { id: "reports/waste", label: "Waste Management", eyebrow: "Report Center", keywords: ["daily waste", "waste cost", "spoilage"] },
      { id: "reports/inventory", label: "Inventory Reports", eyebrow: "Report Center", keywords: ["stock", "lots", "valuation", "adjustment", "audit"] },
      { id: "reports/financial", label: "Financial Reports", eyebrow: "Report Center", keywords: ["profit and loss", "balance sheet", "cash book", "expense report"] },
    ],
  },
  {
    id: "all-shops",
    label: "All Shops",
    icon: "layers",
    shortcut: null,
    keywords: ["branches", "consolidated", "group", "other shop", "owner"],
    sections: [],
  },
  {
    id: "settings",
    label: "Settings",
    icon: "settings",
    shortcut: null,
    keywords: ["configuration", "setup", "preferences", "admin", "master"],
    // Seventeen cards stacked on one page. The `eyebrow` is kept exactly as `SettingsModule`
    // renders it — it is the grouping the maintainer already wrote, and repeating it here means
    // the drill-down and the page agree about what a group is called.
    sections: [
      { id: "settings/display-typography", label: "Display Typography", eyebrow: "Appearance / Accessibility", keywords: ["font size", "text size", "readability", "zoom"] },
      { id: "settings/business-identity", label: "Business Identity", eyebrow: "Business Settings", keywords: ["shop name", "address", "gst", "invoice header", "logo"] },
      { id: "settings/weighing-scale", label: "Weighing Scale Integration", eyebrow: "POS Settings", keywords: ["scale", "usb", "serial", "bluetooth", "weight"] },
      { id: "settings/payment-tax", label: "UPI, Payment QR and Sales Mandi Tax", eyebrow: "Payment & Tax Settings", keywords: ["upi", "qr code", "payment", "sales tax", "gst", "tax", "mandi tax"] },
      { id: "settings/whatsapp", label: "WhatsApp Business Cloud API", eyebrow: "WhatsApp Settings", keywords: ["whatsapp", "send bill", "cloud api", "token"] },
      { id: "settings/mandi-tax", label: "Origin-Based Mandi Tax", eyebrow: "Mandi Tax Settings", keywords: ["local", "imported", "purchase tax", "percentage", "gst", "tax", "mandi tax"] },
      { id: "settings/supplier-rebate", label: "Payment-Speed Rebate Slabs", eyebrow: "Supplier Rebate Settings", keywords: ["rebate", "early payment", "discount days", "slab"] },
      { id: "settings/sale-rate-suggestions", label: "Sale Rate Suggestions", eyebrow: "Sale Rate Settings", keywords: ["margin", "rounding", "suggested rate"] },
      { id: "settings/bill-discount-slabs", label: "Bill-Level Discount Slabs", eyebrow: "Overall Sale Discount Settings", keywords: ["automatic discount", "bill total", "payment mode"] },
      { id: "settings/permission-matrix", label: "Permission Matrix", eyebrow: "Role Management", keywords: ["roles", "access", "permissions", "cashier", "admin"] },
      { id: "settings/users", label: "Owner User Administration", eyebrow: "User Management", keywords: ["staff", "add user", "reset password", "deactivate"] },
      { id: "settings/device-control", label: "Fullscreen Lock & Owner Exit Code", eyebrow: "Security / Device Control", keywords: ["kiosk", "fullscreen", "exit code", "lock"] },
      { id: "settings/operational-scope", label: "Branch, Location, Staff and Device Control", eyebrow: "Operational Scope", keywords: ["branch", "location", "counter", "assignment"] },
      { id: "settings/updates", label: "FroozERP Windows Updates", eyebrow: "Software Updates", keywords: ["update", "version", "installer", "upgrade"] },
      { id: "settings/sync", label: "Connection Status", eyebrow: "Sync & Connection", keywords: ["sync", "internet", "cloud", "offline", "local only", "server"] },
      { id: "settings/backup", label: "Auto Backup and Safe Shutdown", eyebrow: "Backup & Restore", keywords: ["backup", "restore", "shutdown", "safety"] },
      { id: "settings/system-info", label: "Server, Network and Device Status", eyebrow: "System Info", keywords: ["lan url", "ip address", "diagnostics", "device"] },
    ],
  },
];

const freezeSection = (section) => Object.freeze({ ...section, keywords: Object.freeze([...section.keywords]) });

const freezeModule = (item) =>
  Object.freeze({
    ...item,
    keywords: Object.freeze([...item.keywords]),
    sections: Object.freeze(item.sections.map(freezeSection)),
  });

/** The registry. Frozen because two consumers read it and neither may edit it for the other. */
export const navigationRegistry = Object.freeze(modules.map(freezeModule));

/**
 * Every destination as one flat list — modules first, then each module's sections — which is the
 * shape a command palette wants to filter. `kind` distinguishes them; `moduleId` on a section is
 * the view the caller must switch to before scrolling to `id`.
 */
export const navigationTargets = Object.freeze(
  navigationRegistry.flatMap((item) => [
    Object.freeze({
      kind: NAVIGATION_KIND.MODULE,
      id: item.id,
      moduleId: item.id,
      label: item.label,
      icon: item.icon,
      shortcut: item.shortcut,
      eyebrow: "",
      keywords: item.keywords,
    }),
    ...item.sections.map((section) =>
      Object.freeze({
        kind: NAVIGATION_KIND.SECTION,
        id: section.id,
        moduleId: item.id,
        label: section.label,
        icon: item.icon,
        shortcut: null,
        eyebrow: section.eyebrow,
        keywords: section.keywords,
      }),
    ),
  ]),
);

/**
 * Ids are opaque strings, always. `"004"` and `4` are different entities in this codebase and a
 * `Number()` anywhere near an id has already cost a day; this is the only normalisation allowed.
 */
const asId = (value) => (typeof value === "string" ? value.trim() : "");

export const findNavigationModule = (id) => navigationRegistry.find((item) => item.id === asId(id)) || null;

export const findNavigationSection = (id) => {
  const wanted = asId(id);
  for (const item of navigationRegistry) {
    const section = item.sections.find((entry) => entry.id === wanted);
    if (section) return Object.freeze({ ...section, moduleId: item.id });
  }
  return null;
};

/**
 * The only lookup callers should navigate from. An id that matches nothing comes back as UNKNOWN
 * with the id it was asked about, so the caller can show a named failure. It must never resolve
 * to a plausible-looking default: silently landing on the Dashboard because a palette entry went
 * stale reads as the app working, and nobody reports it.
 */
export const resolveNavigationTarget = (id) => {
  const wanted = asId(id);
  const item = findNavigationModule(wanted);
  if (item) {
    return Object.freeze({
      status: NAVIGATION_LOOKUP.FOUND,
      kind: NAVIGATION_KIND.MODULE,
      id: item.id,
      moduleId: item.id,
      label: item.label,
      section: null,
      module: item,
    });
  }
  const section = findNavigationSection(wanted);
  if (section) {
    return Object.freeze({
      status: NAVIGATION_LOOKUP.FOUND,
      kind: NAVIGATION_KIND.SECTION,
      id: section.id,
      moduleId: section.moduleId,
      label: section.label,
      section,
      module: findNavigationModule(section.moduleId),
    });
  }
  return Object.freeze({
    status: NAVIGATION_LOOKUP.UNKNOWN,
    kind: null,
    id: wanted,
    moduleId: null,
    label: "",
    section: null,
    module: null,
    reason: wanted
      ? `No navigation target is registered for "${wanted}".`
      : "No navigation target was named.",
  });
};

/**
 * The chip text, e.g. "Alt 1". Exported so the sidebar and the palette cannot print different
 * things for the same key.
 *
 * The emptiness test is explicit rather than `shortcut ? ... : ...`, because `0` is a real
 * shortcut here and every falsy shortcut of a check would swallow it. Same reason `??` is not
 * used to pick a default: it falls through on `null`, but a plain `||` would not fall through
 * on `0` in the way a reader expects.
 */
export const formatShortcut = (shortcut) => {
  if (shortcut === null || shortcut === undefined) return "";
  const key = typeof shortcut === "number" ? String(shortcut) : String(shortcut).trim();
  if (key === "") return "";
  return `${SHORTCUT_MODIFIER} ${key}`;
};

const TYPING_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

const closestMatch = (node, selector) => {
  if (!node || typeof node.closest !== "function") return false;
  try {
    return Boolean(node.closest(selector));
  } catch {
    // A detached or non-element target. Refusing the shortcut is the safe direction: the worst
    // case is a key that does nothing, against a key that fires inside a form field.
    return true;
  }
};

/**
 * True when the keystroke belongs to whatever the person is doing, not to the app.
 *
 * Deliberately broad. Every `input` is covered rather than only the text-shaped ones, because a
 * field's `type` can change at runtime and a shortcut that fires inside a form is a defect while
 * a shortcut that fails to fire inside one is a shrug. Open modals count too — a dialog is a
 * question the person has been asked, and navigating out from under it strands the answer.
 */
export const isTypingContext = (target) => {
  if (!target) return false;
  const tagName = typeof target.tagName === "string" ? target.tagName.toUpperCase() : "";
  if (TYPING_TAGS.has(tagName)) return true;
  if (target.isContentEditable === true) return true;
  if (typeof target.getAttribute === "function") {
    const attribute = target.getAttribute("contenteditable");
    if (typeof attribute === "string" && attribute.toLowerCase() !== "false") return true;
  }
  if (closestMatch(target, 'input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return true;
  // `.modal-backdrop` is this app's own dialog wrapper; the ARIA selectors catch anything newer.
  if (closestMatch(target, '.modal-backdrop, [role="dialog"], [aria-modal="true"]')) return true;
  return false;
};

const DIGIT_CODE = /^(?:Digit|Numpad)([0-9])$/;

/**
 * The digit a keyboard event names, or `""`.
 *
 * `event.code` is read first and `event.key` only as a fallback: under Alt, `key` is unreliable
 * across layouts — some report a dead key, some a composed character, some the unmodified letter
 * — while `code` describes the physical key and does not move.
 */
export const shortcutKeyFromEvent = (event) => {
  const code = typeof event?.code === "string" ? event.code : "";
  const matched = DIGIT_CODE.exec(code);
  if (matched) return matched[1];
  const key = typeof event?.key === "string" ? event.key : "";
  return /^[0-9]$/.test(key) ? key : "";
};

/**
 * The module a keyboard event asks for, or `null` when it asks for nothing.
 *
 * Every rejection below is a rejection on purpose:
 *   - no `altKey`: a bare digit is typed into a quantity box a hundred times a day;
 *   - `ctrlKey`/`metaKey`: Ctrl+Alt is AltGr on Indian and European layouts, so a person typing
 *     an ordinary character would otherwise be thrown across the app;
 *   - `isComposing` / keyCode 229: an IME is mid-word and the keystroke is not finished;
 *   - `isTypingContext`: the sale in progress wins over the shortcut, always.
 */
export const resolveShortcutTarget = (event) => {
  if (!event) return null;
  if (event.isComposing === true || event.keyCode === 229) return null;
  if (event.altKey !== true) return null;
  if (event.ctrlKey === true || event.metaKey === true) return null;
  if (event.repeat === true) return null;
  if (isTypingContext(event.target)) return null;
  const key = shortcutKeyFromEvent(event);
  if (key === "") return null;
  return navigationRegistry.find((item) => item.shortcut === key) || null;
};

/**
 * Back/forward, as a value.
 *
 * No module-level state: two callers (the app shell and, one day, a test or a second window)
 * must not be able to push each other's history around. Every function here takes a state and
 * returns a new frozen one.
 */
export const createNavigationHistory = (startId = null) => {
  const first = asId(startId);
  return Object.freeze({
    entries: Object.freeze(first === "" ? [] : [first]),
    index: first === "" ? -1 : 0,
  });
};

const normalizeHistory = (state) => {
  const entries = Array.isArray(state?.entries) ? state.entries.filter((entry) => asId(entry) !== "") : [];
  const index = Number.isInteger(state?.index) ? state.index : entries.length - 1;
  const clamped = entries.length === 0 ? -1 : Math.min(Math.max(index, 0), entries.length - 1);
  return { entries, index: clamped };
};

export const currentHistoryEntry = (state) => {
  const { entries, index } = normalizeHistory(state);
  return index < 0 ? null : entries[index];
};

export const canGoBack = (state) => normalizeHistory(state).index > 0;

export const canGoForward = (state) => {
  const { entries, index } = normalizeHistory(state);
  return index >= 0 && index < entries.length - 1;
};

/**
 * Two behaviours that people notice the moment they are missing.
 *
 * Pushing after going back drops the forward entries — the rule every browser follows, and the
 * one that keeps Forward from replaying a branch the person has already left.
 *
 * Pushing the entry you are already on changes nothing. Without that, clicking "Products" twice
 * stacks two identical entries and Back appears to be broken because the first press lands on
 * the screen you were already looking at.
 */
export const pushNavigation = (state, id) => {
  const { entries, index } = normalizeHistory(state);
  const wanted = asId(id);
  if (wanted === "") return Object.freeze({ entries: Object.freeze([...entries]), index });
  if (index >= 0 && entries[index] === wanted) {
    return Object.freeze({ entries: Object.freeze([...entries]), index });
  }
  const kept = entries.slice(0, index + 1);
  kept.push(wanted);
  return Object.freeze({ entries: Object.freeze(kept), index: kept.length - 1 });
};

export const goBack = (state) => {
  const { entries, index } = normalizeHistory(state);
  const frozen = Object.freeze([...entries]);
  if (index <= 0) return Object.freeze({ entries: frozen, index });
  return Object.freeze({ entries: frozen, index: index - 1 });
};

export const goForward = (state) => {
  const { entries, index } = normalizeHistory(state);
  const frozen = Object.freeze([...entries]);
  if (index < 0 || index >= entries.length - 1) return Object.freeze({ entries: frozen, index });
  return Object.freeze({ entries: frozen, index: index + 1 });
};
