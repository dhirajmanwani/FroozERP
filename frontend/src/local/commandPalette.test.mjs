import test from "node:test";
import assert from "node:assert/strict";

import {
  COMMAND_INDEX_STATUS,
  COMMAND_MATCH_KIND,
  COMMAND_PROBLEM,
  COMMAND_RESULT_KIND,
  COMMAND_SEARCH_STATUS,
  buildCommandIndex,
  highlightSegments,
  searchCommands,
} from "./commandPalette.js";

/**
 * A registry shaped like the real one: modules in the order the navigation shows them, Settings and
 * the Report Center carrying the sections that are otherwise unfindable. Built fresh per call so no
 * test can hand a mutated fixture to the next one.
 */
const registry = () => [
  { id: "dashboard", label: "Dashboard", icon: "home", shortcut: "1", keywords: ["home", "overview", "today"], sections: [] },
  { id: "sales", label: "POS Billing", icon: "cart", shortcut: "2", keywords: ["sales", "counter", "checkout", "bill"], sections: [] },
  { id: "purchase", label: "Purchases", icon: "truck", shortcut: "3", keywords: ["mandi", "supplier", "buying"], sections: [] },
  { id: "products", label: "Products", icon: "box", shortcut: "4", keywords: ["catalogue", "items", "fruit"], sections: [] },
  { id: "sale-rates", label: "Sale Rates", icon: "tag", shortcut: "5", keywords: ["pricing", "rate list", "selling price"], sections: [] },
  { id: "waste", label: "Waste Management", icon: "trash", shortcut: null, keywords: ["spoilage", "damage", "disposal"], sections: [] },
  {
    id: "reports",
    label: "Report Center",
    icon: "chart",
    shortcut: "8",
    keywords: ["analytics", "statements"],
    sections: [
      { id: "reports/sales-summary", label: "Sales Summary", eyebrow: "Sales Reports", keywords: ["daily sales", "takings"] },
      { id: "reports/stock-ageing", label: "Stock Ageing", eyebrow: "Inventory Reports", keywords: ["old stock", "ageing"] },
    ],
  },
  {
    id: "settings",
    label: "Settings",
    icon: "settings",
    shortcut: "9",
    keywords: ["configuration", "setup"],
    sections: [
      { id: "settings/business-identity", label: "Business Identity", eyebrow: "Business Settings", keywords: ["shop name", "logo", "gst number"] },
      { id: "settings/tax-gst", label: "Tax & GST", eyebrow: "Business Settings", keywords: ["gst", "hsn", "tax rate"] },
      { id: "settings/users", label: "Users & Roles", eyebrow: "Access", keywords: ["staff", "permissions", "login"] },
      { id: "settings/printing", label: "Printing & Reports", eyebrow: "Printing", keywords: ["printer", "invoice layout"] },
      { id: "settings/backup", label: "Backup & Restore", eyebrow: "Data", keywords: ["export", "restore", "snapshot"] },
    ],
  },
];

const find = (registryValue = registry()) => buildCommandIndex(registryValue);
const ids = (found) => found.results.map((result) => result.id);
const search = (query, options) => searchCommands(find(), query, options);

test("the fixture registry is one this module considers healthy", () => {
  // Every ranking test below reads a status of `ready`. If the fixture itself were degraded the
  // suite would still pass while silently searching a subset of it.
  const index = find();
  assert.equal(index.status, COMMAND_INDEX_STATUS.READY);
  assert.deepEqual(index.problems, []);
  assert.equal(index.entries.length, 15);
});

test("a match at the start of a label beats one in the middle of a label", () => {
  // "Report Center" is what a person typing `report` means. "Printing & Reports" is a Settings
  // section that happens to contain the word, and a palette that offers it first is one people stop
  // trusting after two tries.
  const found = search("report");
  assert.equal(found.status, COMMAND_SEARCH_STATUS.READY);
  assert.equal(found.results[0].id, "reports");
  assert.equal(found.results[0].matchKind, COMMAND_MATCH_KIND.LABEL_PREFIX);
  const printing = found.results.find((result) => result.id === "settings/printing");
  assert.equal(printing.matchKind, COMMAND_MATCH_KIND.LABEL_WORD);
  assert.ok(found.results[0].score > printing.score);
});

test("a hit on the thing's own name beats a hit on one of its aliases", () => {
  // `sal` is the canonical example: "Sale Rates" is named that, "POS Billing" merely answers to
  // "sales", and "Waste Management" only contains the letters inside the word "disposal". Keyword
  // tiers are scored strictly below every label tier so an alias can never outrank a name.
  const found = search("sal");
  assert.equal(found.results[0].id, "sale-rates");
  const posIndex = found.results.findIndex((result) => result.id === "sales");
  const wasteIndex = found.results.findIndex((result) => result.id === "waste");
  assert.ok(posIndex !== -1 && wasteIndex !== -1, "both weaker matches are still offered");
  assert.ok(posIndex < wasteIndex, "an alias that starts with the query beats one that buries it mid-word");
  assert.equal(found.results[posIndex].matchKind, COMMAND_MATCH_KIND.KEYWORD_PREFIX);
  assert.equal(found.results[wasteIndex].matchKind, COMMAND_MATCH_KIND.KEYWORD_MID);
});

test("a whole-word match beats a partial one", () => {
  // Both labels start with the query, so the only difference is that one query covers a whole word
  // and the other stops halfway through one. This is the rule that keeps "Tax & GST" above
  // "Taxable Value" when someone types `tax`.
  const found = searchCommands(buildCommandIndex([
    { id: "purchase", label: "Purchases", icon: "truck", shortcut: "3", keywords: [], sections: [] },
    { id: "purchase-entry", label: "Purchase Entry", icon: "truck", shortcut: null, keywords: [], sections: [] },
  ]), "purchase");
  assert.deepEqual(found.results.map((result) => result.id), ["purchase-entry", "purchase"]);
});

test("a module beats a section of equal match quality", () => {
  // Both are whole-word label prefixes, and the section's label is the shorter of the two — so the
  // length tie-break would put the section first. The module wins purely because it is the broader
  // destination: from the module the section is still one scroll away, but not the other way round.
  const found = searchCommands(buildCommandIndex([
    {
      id: "reports",
      label: "Report Center",
      icon: "chart",
      shortcut: "8",
      keywords: [],
      sections: [{ id: "reports/log", label: "Report Log", eyebrow: "Audit", keywords: [] }],
    },
  ]), "report");
  assert.deepEqual(found.results.map((result) => result.id), ["reports", "reports/log"]);
  assert.equal(found.results[0].score - found.results[1].score, 2);
});

test("the module bonus can only break a tie, never overturn a better match", () => {
  // The bonus is smaller than the gap between any two scoring tiers. If it ever grew past that, a
  // module's keyword would start outranking a section's name and no test above would notice.
  const found = search("summary");
  assert.equal(found.results[0].id, "reports/sales-summary");
  assert.equal(found.results[0].kind, COMMAND_RESULT_KIND.SECTION);
});

test("a section result names the module it lives in", () => {
  // "Business Identity" on its own is a phrase with no address. The person needs to be told it is
  // in Settings, both to trust the result and to find it again by hand next time.
  const found = search("business identity");
  const result = found.results[0];
  assert.equal(result.id, "settings/business-identity");
  assert.equal(result.kind, COMMAND_RESULT_KIND.SECTION);
  assert.equal(result.parentLabel, "Settings");
  assert.equal(result.moduleLabel, "Settings");
  assert.equal(result.eyebrow, "Business Settings");
});

test("a module result has no parent to name", () => {
  const result = search("dashboard").results[0];
  assert.equal(result.kind, COMMAND_RESULT_KIND.MODULE);
  assert.equal(result.parentLabel, null);
  assert.equal(result.moduleLabel, "Dashboard");
});

test("a result carries both halves of the jump: which screen, and where on it", () => {
  // The caller sets `activeView` to `viewId` and scrolls to `sectionId`. A result that only carried
  // its own id would leave the caller taking the id apart, which bakes the id format into the UI.
  const section = search("stock ageing").results[0];
  assert.equal(section.viewId, "reports");
  assert.equal(section.sectionId, "reports/stock-ageing");
  assert.equal(section.icon, "chart");

  const module = search("products").results[0];
  assert.equal(module.viewId, "products");
  assert.equal(module.sectionId, null, "a module has no section to scroll to");
});

test("a section shows no shortcut chip of its own but still knows the module's", () => {
  // Alt+9 opens Settings, not Business Identity. Printing the parent's chip on the section row
  // would promise a keystroke that lands somewhere else.
  const section = search("business identity").results[0];
  assert.equal(section.shortcut, null);
  assert.equal(section.moduleShortcut, "9");

  const module = search("settings").results[0];
  assert.equal(module.shortcut, "9");
});

test("a module with no shortcut says so rather than inventing one", () => {
  assert.equal(search("waste").results[0].shortcut, null);
});

test("typing the initials of a phrase finds it", () => {
  // Subsequence matching is what makes a palette feel fast: `bid` is three keystrokes for a
  // two-word section name nobody wants to type out.
  const found = search("bid");
  assert.equal(found.status, COMMAND_SEARCH_STATUS.READY);
  assert.equal(found.results[0].id, "settings/business-identity");
  assert.equal(found.results[0].matchKind, COMMAND_MATCH_KIND.LABEL_SUBSEQUENCE);
});

test("a subsequence match never displaces a real substring match", () => {
  // "Backup & Restore" contains b, u and s in that order, so it is a legitimate subsequence hit for
  // `bus` — and it is not what anybody typing `bus` wants. Subsequence is scored far below every
  // substring tier precisely so it can add results without reordering the obvious ones: here it
  // lands below the section named "Business Identity" and below the one merely filed under
  // "Business Settings", both of which contain the letters as typed.
  const found = search("bus");
  assert.deepEqual(ids(found), ["settings/business-identity", "settings/tax-gst", "settings/backup"]);
  assert.equal(found.results[0].matchKind, COMMAND_MATCH_KIND.LABEL_PREFIX);
  assert.equal(found.results[1].matchKind, COMMAND_MATCH_KIND.KEYWORD_PREFIX);
  assert.equal(found.results[2].matchKind, COMMAND_MATCH_KIND.LABEL_SUBSEQUENCE);
  assert.ok(found.results[1].score > found.results[2].score);
});

test("every word of a multi-word query is enough, in any order", () => {
  // People type what they remember, not what the screen is called. "rate sale" is the same request
  // as "sale rates" and must not come back empty.
  const found = search("rate sale");
  assert.equal(found.status, COMMAND_SEARCH_STATUS.READY);
  assert.equal(found.results[0].id, "sale-rates");
  assert.equal(found.results[0].matchKind, COMMAND_MATCH_KIND.ALL_WORDS);
});

test("case and surrounding whitespace are ignored", () => {
  // A trailing space arrives free with a paste and with several Android keyboards, and shift-typing
  // is normal for the first letter. Neither may change the answer.
  const plain = search("sale rates");
  const shouted = search("   SALE RATES  ");
  assert.deepEqual(ids(shouted), ids(plain));
  assert.equal(shouted.query, "sale rates", "the normalized query is reported back for display");
});

test("an empty query offers the modules rather than nothing", () => {
  // This is the first thing a person sees on pressing Ctrl+K. An empty list there reads as a broken
  // feature, and the module list is the honest default: the whole map at one level of zoom.
  const found = search("");
  assert.equal(found.status, COMMAND_SEARCH_STATUS.DEFAULTS);
  assert.deepEqual(ids(found), [
    "dashboard", "sales", "purchase", "products", "sale-rates", "waste", "reports", "settings",
  ]);
  assert.ok(found.results.every((result) => result.kind === COMMAND_RESULT_KIND.MODULE));
  assert.equal(found.results[0].matchKind, COMMAND_MATCH_KIND.DEFAULT);
});

test("a query of nothing but spaces is the same as an empty one", () => {
  assert.equal(search("   ").status, COMMAND_SEARCH_STATUS.DEFAULTS);
});

test("a default result scores zero and is still a result", () => {
  // Zero is a real score here, not a missing one. `CLAUDE.md` records that `??` does not fall
  // through on 0; neither does anything in this module treat a 0 score as "no match".
  const found = search("");
  assert.equal(found.results[0].score, 0);
  assert.equal(found.totalMatches, 8);
});

test("where you went last is offered first when nothing is typed", () => {
  const found = search("", { recentIds: ["settings/tax-gst", "purchase"] });
  assert.deepEqual(ids(found).slice(0, 2), ["settings/tax-gst", "purchase"]);
  assert.equal(found.results[0].kind, COMMAND_RESULT_KIND.SECTION, "a recent section is worth offering even though sections are not default destinations");
  assert.equal(ids(found).filter((id) => id === "purchase").length, 1, "a promoted module is not also listed again below");
});

test("a recent destination that no longer exists is simply not offered", () => {
  // Normal after an upgrade removes a screen. It is not a fault and must not blank the palette.
  const found = search("", { recentIds: ["settings/removed-in-v2", 4, null] });
  assert.equal(found.status, COMMAND_SEARCH_STATUS.DEFAULTS);
  assert.equal(ids(found)[0], "dashboard");
});

test("a query that matches nothing says so, and is not an error", () => {
  // The one case where an empty list is the truthful answer. It has its own status so the UI can
  // say "nothing matches" instead of the sentence it shows when the registry is broken.
  const found = search("zzzz");
  assert.equal(found.status, COMMAND_SEARCH_STATUS.NO_MATCHES);
  assert.deepEqual(found.results, []);
  assert.match(found.message, /Nothing in the app matches "zzzz"/);
});

test("a registry that is not a list is a named failure, not an empty result", () => {
  // The two look identical to a person staring at the palette, and they are opposite answers: one
  // means "we have nothing like that", the other means "the app cannot read its own menu".
  for (const broken of [null, undefined, "settings", 42, { modules: [] }]) {
    const index = buildCommandIndex(broken);
    assert.equal(index.status, COMMAND_INDEX_STATUS.INVALID);
    assert.equal(index.problems[0].code, COMMAND_PROBLEM.REGISTRY_NOT_ARRAY);
    assert.ok(index.message.length > 0);

    const found = searchCommands(index, "sales");
    assert.equal(found.status, COMMAND_SEARCH_STATUS.INVALID_INDEX);
    assert.deepEqual(found.results, []);
    assert.ok(found.message.length > 0);
  }
});

test("an empty registry is a broken app, not an empty search", () => {
  const index = buildCommandIndex([]);
  assert.equal(index.status, COMMAND_INDEX_STATUS.INVALID);
  assert.equal(index.problems[0].code, COMMAND_PROBLEM.REGISTRY_EMPTY);
});

test("a registry whose every entry is unusable is invalid, and says which entries and why", () => {
  const index = buildCommandIndex([{ label: "No id" }, "not an entry", null]);
  assert.equal(index.status, COMMAND_INDEX_STATUS.INVALID);
  assert.deepEqual(index.problems.map((problem) => problem.code), [
    COMMAND_PROBLEM.MODULE_ID_INVALID,
    COMMAND_PROBLEM.MODULE_NOT_OBJECT,
    COMMAND_PROBLEM.MODULE_NOT_OBJECT,
    COMMAND_PROBLEM.REGISTRY_NO_USABLE_MODULES,
  ]);
  assert.match(index.problems[0].at, /registry\[0\]/);
});

test("one broken entry drops that entry and says so, rather than failing the whole palette", () => {
  // A palette that goes dark because one section lost its id is worse than one that is missing that
  // section and admits it. `degraded` is how the UI can show the admission.
  const broken = registry();
  broken[7].sections[1] = { label: "Tax & GST", eyebrow: "Business Settings" };
  const index = buildCommandIndex(broken);
  assert.equal(index.status, COMMAND_INDEX_STATUS.DEGRADED);
  assert.equal(index.problems.length, 1);
  assert.equal(index.problems[0].code, COMMAND_PROBLEM.SECTION_ID_INVALID);
  assert.match(index.problems[0].at, /sections\[1\]/);

  const found = searchCommands(index, "settings");
  assert.equal(found.status, COMMAND_SEARCH_STATUS.READY);
  assert.equal(found.degraded, true, "a search over an incomplete map must be able to say it is incomplete");
  assert.equal(found.problems.length, 1);
  assert.ok(found.message.length > 0);
  assert.ok(!ids(found).includes("settings/tax-gst"));
});

test("a section with no label is dropped rather than drawn as a blank row", () => {
  const broken = registry();
  broken[7].sections[0] = { id: "settings/business-identity", eyebrow: "Business Settings" };
  const index = buildCommandIndex(broken);
  assert.equal(index.problems[0].code, COMMAND_PROBLEM.SECTION_LABEL_INVALID);
});

test("a repeated id is dropped, because navigating to it would be a coin toss", () => {
  const broken = registry();
  broken[7].sections.push({ id: "settings/backup", label: "Backup (old)", eyebrow: "Data", keywords: [] });
  const index = buildCommandIndex(broken);
  assert.equal(index.status, COMMAND_INDEX_STATUS.DEGRADED);
  assert.equal(index.problems[0].code, COMMAND_PROBLEM.SECTION_ID_DUPLICATE);
  assert.equal(index.entries.filter((entry) => entry.id === "settings/backup").length, 1);
});

test("ids are opaque strings and are never coerced to numbers", () => {
  // `CLAUDE.md`: "004" and 4 are different entities, and a mismatch here once emptied the Inventory
  // table while every summary tile stayed correct. A numeric id is refused rather than stringified,
  // because guessing would send the person to a screen that is not the one they picked.
  const index = buildCommandIndex([
    { id: "004", label: "Legacy Screen", icon: null, shortcut: null, keywords: [], sections: [] },
    { id: 4, label: "Numeric Screen", icon: null, shortcut: null, keywords: [], sections: [] },
  ]);
  assert.equal(index.status, COMMAND_INDEX_STATUS.DEGRADED);
  assert.equal(index.problems[0].code, COMMAND_PROBLEM.MODULE_ID_INVALID);

  const found = searchCommands(index, "legacy");
  assert.equal(found.results.length, 1);
  assert.strictEqual(found.results[0].id, "004");
  assert.strictEqual(found.results[0].viewId, "004");
});

test("a query that is not text is a named caller error, not a miss", () => {
  const index = find();
  for (const broken of [null, undefined, 5, ["sales"], {}]) {
    const found = searchCommands(index, broken);
    assert.equal(found.status, COMMAND_SEARCH_STATUS.INVALID_QUERY);
    assert.deepEqual(found.results, []);
    assert.match(found.message, /Search needs text/);
  }
});

test("an index that was never built is refused rather than treated as empty", () => {
  for (const broken of [null, undefined, registry(), { status: "ready" }]) {
    const found = searchCommands(broken, "sales");
    assert.equal(found.status, COMMAND_SEARCH_STATUS.INVALID_INDEX);
  }
});

test("results that do not fit are counted, not silently dropped", () => {
  // A palette showing eight of forty matches without saying so teaches people the app cannot find
  // things it can find.
  const found = search("s", { limit: 3 });
  assert.equal(found.results.length, 3);
  assert.ok(found.totalMatches > 3);
  assert.equal(found.truncated, true);
  const untruncated = search("s");
  assert.equal(untruncated.truncated, untruncated.totalMatches > untruncated.results.length);
  assert.equal(search("dashboard").truncated, false, "a query with one answer is never reported as truncated");
});

test("the same query returns the same order every time", () => {
  // Two sections share a label and every other ranking input, so the comparator falls all the way
  // through to registry order. Without that last tie-break the order would be whatever the sort
  // implementation happened to do, which is not a guarantee and would flicker as the list re-renders.
  const tied = buildCommandIndex([
    { id: "purchase", label: "Purchases", icon: "truck", shortcut: "3", keywords: [], sections: [{ id: "purchase/notes", label: "Notes", eyebrow: "Purchases", keywords: [] }] },
    { id: "sales", label: "POS Billing", icon: "cart", shortcut: "2", keywords: [], sections: [{ id: "sales/notes", label: "Notes", eyebrow: "Billing", keywords: [] }] },
  ]);
  const first = searchCommands(tied, "notes");
  assert.deepEqual(first.results.map((result) => result.id), ["purchase/notes", "sales/notes"]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.deepEqual(searchCommands(tied, "notes").results.map((result) => result.id), first.results.map((result) => result.id));
  }
  assert.deepEqual(ids(search("re")), ids(search("re")));
});

test("a result says which characters matched, against the text it matched in", () => {
  const found = search("bid");
  const { highlight } = found.results[0];
  assert.equal(highlight.field, "label");
  assert.equal(highlight.text, "Business Identity");
  assert.deepEqual(highlight.ranges, [
    { start: 0, end: 1 },
    { start: 3, end: 4 },
    { start: 10, end: 11 },
  ]);
});

test("a keyword-only hit highlights the keyword, not the label", () => {
  // Otherwise "POS Billing" appears for `sal` with nothing on the row explaining why, which reads
  // as a random result.
  const found = search("sal");
  const pos = found.results.find((result) => result.id === "sales");
  assert.equal(pos.highlight.field, "keyword");
  assert.equal(pos.highlight.text, "sales");
  assert.deepEqual(pos.highlight.ranges, [{ start: 0, end: 3 }]);
});

test("highlight segments rebuild the original text exactly", () => {
  // A highlight may change what is emphasised and never what the label says.
  const { highlight } = search("bid").results[0];
  const segments = highlightSegments(highlight.text, highlight.ranges);
  assert.equal(segments.map((segment) => segment.text).join(""), "Business Identity");
  assert.deepEqual(segments.filter((segment) => segment.matched).map((segment) => segment.text), ["B", "i", "d"]);
});

test("nonsense highlight ranges are ignored rather than allowed to garble the label", () => {
  const overlapping = highlightSegments("Sale Rates", [{ start: 5, end: 20 }, { start: 0, end: 4 }, { start: 2, end: 3 }]);
  assert.equal(overlapping.map((segment) => segment.text).join(""), "Sale Rates");
  assert.deepEqual(highlightSegments("Sale Rates", null).map((segment) => segment.text).join(""), "Sale Rates");
  assert.deepEqual(highlightSegments("", [{ start: 0, end: 1 }]), []);
});

test("an eyebrow is searchable, so a category name finds what is under it", () => {
  // Settings groups its twenty sections under headings, and the heading is often the only part a
  // person remembers.
  const found = search("business settings");
  assert.ok(ids(found).includes("settings/business-identity"));
  assert.equal(found.results[0].highlight.field, "eyebrow");
});

test("keywords that are not text are ignored and reported, not searched", () => {
  const index = buildCommandIndex([
    { id: "waste", label: "Waste Management", icon: "trash", shortcut: null, keywords: ["spoilage", 7, null], sections: [] },
  ]);
  assert.equal(index.status, COMMAND_INDEX_STATUS.DEGRADED);
  assert.equal(index.problems[0].code, COMMAND_PROBLEM.KEYWORDS_INVALID);
  assert.deepEqual(index.entries[0].keywords, ["spoilage"]);
});

test("a module with no sections is indexed as itself and nothing else", () => {
  const index = buildCommandIndex([
    { id: "dashboard", label: "Dashboard", icon: "home", shortcut: "1", keywords: [], sections: [] },
    { id: "waste", label: "Waste Management", icon: "trash", shortcut: null, keywords: [] },
  ]);
  assert.equal(index.status, COMMAND_INDEX_STATUS.READY, "an absent sections list is an absence, not a fault");
  assert.equal(index.entries.length, 2);
});
