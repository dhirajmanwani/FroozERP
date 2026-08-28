/**
 * The Ctrl+K palette: find any screen in the app by typing a few letters.
 *
 * The app has fifteen modules, a Settings screen holding twenty sections and a Report Center with
 * roughly thirty reports behind eight categories. That is well past the point where a person can
 * hold the map in their head, and the failure mode is not "I cannot find it" — it is "I did not
 * know the app could do that". A search box over the navigation tree is what turns a drill-down
 * from a place things get buried into a place things get found.
 *
 * ## This module takes the registry as an argument
 *
 * `appNavigation.js` owns the registry — the list of modules and their sections. This module does
 * not import it. It is handed one:
 *
 *     const index = buildCommandIndex(NAVIGATION_REGISTRY);
 *     const found = searchCommands(index, query);
 *
 * That keeps the ranking pure and testable against fixtures, and means a change to the registry
 * cannot break the search except through the one documented shape below.
 *
 * A registry entry is:
 *
 *     { id, label, icon, shortcut, keywords: [], sections: [{ id, label, eyebrow, keywords: [] }] }
 *
 * `id` is the string the app's `activeView` is set to; a section `id` is whatever the module needs
 * to scroll to. Both are **opaque strings** — this module compares and copies them, and never
 * coerces them with `Number()` (`CLAUDE.md`: `"004"` and `4` are different entities).
 *
 * ## Ranking, and why it is scored rather than filtered
 *
 * A palette that returns the right answer third feels broken in a way that a palette returning
 * nothing does not, because the person has to read to find out they were right. So results are
 * scored, not merely matched, and the scale is built so that the tiers cannot interleave:
 *
 *     100  the label is exactly the query
 *      80  the query starts the label            (+6 if it also ends on a word boundary)
 *      60  the query starts a word inside label  (+6 if it also ends on a word boundary)
 *      45  the query sits mid-word in the label
 *      40  a keyword is exactly the query
 *      34  the query starts a keyword            (+6)
 *      28  the query sits inside a keyword       (+6)
 *      20  every word of a multi-word query is found somewhere
 *      15  the query is a subsequence of the label   ("bid" -> "Business Identity")
 *       8  the query is a subsequence of a keyword
 *
 * Three properties are load-bearing and each has a test:
 *
 *   - **Every label tier outranks every keyword tier** (45 > 40), so a real hit on the thing's own
 *     name always beats an alias. Typing `sal` puts POS Billing's neighbours below Sales.
 *   - **Every substring tier outranks subsequence** (28 > 15). Subsequence is what makes a palette
 *     feel fast, and also what makes a bad one throw noise at you; it must never displace an
 *     obvious answer.
 *   - **A module outranks a section of equal match quality** by a bonus of `+2`, which is smaller
 *     than the smallest gap between two tiers (5). It therefore breaks ties and only ties: it can
 *     never lift a weaker match over a stronger one. Modules win ties because they are the broader
 *     destination — from the module you can still reach the section.
 *
 * Remaining ties break on match compactness, then shorter label, then **registry order**. Never on
 * object key order, which is not a guarantee any of this can rest on.
 *
 * ## Errors are never an empty list
 *
 * `CLAUDE.md`: errors must never render as zero. "Nothing matched your search" and "the navigation
 * registry is broken" are completely different answers to the person typing, and an empty
 * `results` array says the first while meaning the second. So every failure has a name:
 * {@link COMMAND_INDEX_STATUS} for a registry that could not be read, {@link COMMAND_SEARCH_STATUS}
 * for a query that could not be run, and a `problems` array of coded, located diagnostics for the
 * entries that were dropped. A search over a partly-broken registry still works, and still says so.
 */

/** Outcome of reading a registry. */
export const COMMAND_INDEX_STATUS = Object.freeze({
  /** Every entry was usable. */
  READY: "ready",
  /** Some entries were dropped; the rest are searchable. `problems` says which and why. */
  DEGRADED: "degraded",
  /** Nothing usable was produced. The palette has no destinations and must say so. */
  INVALID: "invalid",
});

/** Outcome of running a query. */
export const COMMAND_SEARCH_STATUS = Object.freeze({
  /** A real query with at least one result. */
  READY: "ready",
  /** A real query that matched nothing. Distinct from every failure below. */
  NO_MATCHES: "no-matches",
  /** The query was blank, so `results` are the default destinations, not matches. */
  DEFAULTS: "defaults",
  /** The query was not a string. A caller bug, never "nothing matched". */
  INVALID_QUERY: "invalid-query",
  /** The index was missing, malformed, or built from an unusable registry. */
  INVALID_INDEX: "invalid-index",
});

/** What kind of destination a result is. */
export const COMMAND_RESULT_KIND = Object.freeze({
  MODULE: "module",
  SECTION: "section",
});

/** Why a result is in the list. Exported so the UI can explain a surprising hit. */
export const COMMAND_MATCH_KIND = Object.freeze({
  EXACT_LABEL: "exact-label",
  LABEL_PREFIX: "label-prefix",
  LABEL_WORD: "label-word",
  LABEL_MID_WORD: "label-mid-word",
  EXACT_KEYWORD: "exact-keyword",
  KEYWORD_PREFIX: "keyword-prefix",
  KEYWORD_MID: "keyword-mid",
  ALL_WORDS: "all-words",
  LABEL_SUBSEQUENCE: "label-subsequence",
  KEYWORD_SUBSEQUENCE: "keyword-subsequence",
  /** No query was typed; the result is a default destination, not a match. */
  DEFAULT: "default",
});

/** Coded reasons a registry entry was dropped. Stable strings — the UI may key off them. */
export const COMMAND_PROBLEM = Object.freeze({
  REGISTRY_NOT_ARRAY: "registry-not-array",
  REGISTRY_EMPTY: "registry-empty",
  REGISTRY_NO_USABLE_MODULES: "registry-no-usable-modules",
  MODULE_NOT_OBJECT: "module-not-object",
  MODULE_ID_INVALID: "module-id-invalid",
  MODULE_LABEL_INVALID: "module-label-invalid",
  MODULE_ID_DUPLICATE: "module-id-duplicate",
  MODULE_SECTIONS_INVALID: "module-sections-invalid",
  KEYWORDS_INVALID: "keywords-invalid",
  SECTION_NOT_OBJECT: "section-not-object",
  SECTION_ID_INVALID: "section-id-invalid",
  SECTION_LABEL_INVALID: "section-label-invalid",
  SECTION_ID_DUPLICATE: "section-id-duplicate",
});

/** How many results a palette shows before it has to say "and more". */
export const DEFAULT_RESULT_LIMIT = 12;

const SCORE = Object.freeze({
  EXACT_LABEL: 100,
  LABEL_PREFIX: 80,
  LABEL_WORD: 60,
  LABEL_MID_WORD: 45,
  EXACT_KEYWORD: 40,
  KEYWORD_PREFIX: 34,
  KEYWORD_MID: 28,
  ALL_WORDS: 20,
  LABEL_SUBSEQUENCE: 15,
  KEYWORD_SUBSEQUENCE: 8,
});

/**
 * Awarded when a contiguous match both starts and ends on a word boundary, i.e. it covers whole
 * words. Six is large enough to separate a whole-word hit from a partial one within a tier and
 * small enough never to reach the tier above.
 */
const WHOLE_WORD_BONUS = 6;

/**
 * A module beats a section of equal match quality. Two, because the smallest gap between two
 * scoring tiers is five — so this can only ever break a tie, never overturn a better match.
 */
const MODULE_BONUS = 2;

const WORD_CHAR = /[\p{L}\p{N}]/u;

const isNonEmptyString = (value) => typeof value === "string" && value.trim() !== "";

/**
 * A searchable piece of text, carried with its lowercase form.
 *
 * `alignable` is false in the rare case where lowercasing changes the string's length (a handful of
 * Unicode letters do). Highlight ranges are indices into the original text, so when the two forms
 * cannot be lined up character for character the match still counts and the highlight is simply
 * dropped — a wrong highlight points at the wrong letters, which is worse than none.
 */
const searchField = (value) => {
  const text = typeof value === "string" ? value : "";
  const lowered = text.toLowerCase();
  return { text, lowered, alignable: lowered.length === text.length };
};

const startsWord = (lowered, index) => index === 0 || !WORD_CHAR.test(lowered[index - 1]);
const endsWord = (lowered, end) => end >= lowered.length || !WORD_CHAR.test(lowered[end]);

const rangesFor = (field, start, length) =>
  field.alignable ? [{ start, end: start + length }] : [];

/** Merge a sorted list of matched character indices into contiguous ranges. */
const mergeIndices = (indices) => {
  const ranges = [];
  for (const index of indices) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === index) last.end = index + 1;
    else ranges.push({ start: index, end: index + 1 });
  }
  return ranges;
};

/**
 * Leftmost-greedy subsequence match: every character of `query`, in order, somewhere in `lowered`.
 * Returns the matched indices, or null. Greedy-leftmost is what a person expects — typing `bid`
 * should highlight the B of Business and the Id of Identity, not letters from the end.
 */
const subsequenceIndices = (lowered, query) => {
  const indices = [];
  let cursor = 0;
  for (const char of query) {
    const found = lowered.indexOf(char, cursor);
    if (found === -1) return null;
    indices.push(found);
    cursor = found + 1;
  }
  return indices;
};

/** How spread out a match is: 0 when contiguous. Used only to break score ties. */
const spreadOf = (indices) =>
  indices.length === 0 ? 0 : indices[indices.length - 1] - indices[0] - (indices.length - 1);

const normalizeQuery = (query) => query.trim().replace(/\s+/gu, " ").toLowerCase();

const problem = (code, message, at) => ({ code, message, at });

const normalizeKeywords = (value, at, problems) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(problem(COMMAND_PROBLEM.KEYWORDS_INVALID, `${at} has keywords that are not a list; they were ignored.`, at));
    return [];
  }
  const usable = value.filter(isNonEmptyString).map((keyword) => keyword.trim());
  if (usable.length !== value.length) {
    problems.push(problem(COMMAND_PROBLEM.KEYWORDS_INVALID, `${at} has keywords that are not text; they were ignored.`, at));
  }
  return usable;
};

/**
 * Read a navigation registry into a searchable index.
 *
 * One entry per module and one per section, because both are destinations a person types towards —
 * "Business Identity" is a thing you go to, not a thing you find by first knowing it lives in
 * Settings. A section entry carries `viewId` (the module to open) and `sectionId` (what to scroll
 * to) separately, so the caller does not have to take the id apart.
 *
 * A single broken entry does not fail the whole palette: it is dropped, recorded in `problems`, and
 * the status becomes `degraded` so the UI can say that the map is incomplete. A registry that
 * produced nothing usable — including an empty one — is `invalid`, because a palette with no
 * destinations is a broken app rather than an empty search.
 *
 * @param {Array} registry modules in the order the navigation shows them
 * @returns {{status: string, entries: Array, problems: Array, message: string}}
 */
export const buildCommandIndex = (registry) => {
  const problems = [];
  if (!Array.isArray(registry)) {
    return {
      status: COMMAND_INDEX_STATUS.INVALID,
      entries: [],
      problems: [problem(
        COMMAND_PROBLEM.REGISTRY_NOT_ARRAY,
        `The navigation registry is not a list (received ${registry === null ? "null" : typeof registry}), so no destinations could be read.`,
        "registry",
      )],
      message: "The navigation registry could not be read, so search is unavailable.",
    };
  }
  if (registry.length === 0) {
    return {
      status: COMMAND_INDEX_STATUS.INVALID,
      entries: [],
      problems: [problem(COMMAND_PROBLEM.REGISTRY_EMPTY, "The navigation registry is empty, so there is nothing to search.", "registry")],
      message: "The navigation registry is empty, so search is unavailable.",
    };
  }

  const entries = [];
  const seenIds = new Set();
  let order = 0;

  registry.forEach((module, moduleIndex) => {
    const at = `registry[${moduleIndex}]`;
    if (!module || typeof module !== "object" || Array.isArray(module)) {
      problems.push(problem(COMMAND_PROBLEM.MODULE_NOT_OBJECT, `${at} is not a navigation entry and was dropped.`, at));
      return;
    }
    // Ids are opaque strings. A non-string id is refused rather than coerced: navigating to
    // String(4) when the view is "004" opens the wrong screen, silently.
    if (!isNonEmptyString(module.id)) {
      problems.push(problem(COMMAND_PROBLEM.MODULE_ID_INVALID, `${at} has no usable id and was dropped; it cannot be navigated to.`, at));
      return;
    }
    const moduleId = module.id;
    if (!isNonEmptyString(module.label)) {
      problems.push(problem(COMMAND_PROBLEM.MODULE_LABEL_INVALID, `${at} ("${moduleId}") has no label and was dropped; it would appear as a blank row.`, at));
      return;
    }
    if (seenIds.has(moduleId)) {
      problems.push(problem(COMMAND_PROBLEM.MODULE_ID_DUPLICATE, `${at} repeats the id "${moduleId}"; the later entry was dropped.`, at));
      return;
    }
    seenIds.add(moduleId);

    const moduleLabel = module.label.trim();
    const moduleShortcut = isNonEmptyString(module.shortcut) ? module.shortcut.trim() : null;
    const icon = isNonEmptyString(module.icon) ? module.icon.trim() : null;
    const moduleKeywords = normalizeKeywords(module.keywords, `${at} ("${moduleId}")`, problems);

    entries.push({
      id: moduleId,
      kind: COMMAND_RESULT_KIND.MODULE,
      viewId: moduleId,
      sectionId: null,
      label: moduleLabel,
      moduleId,
      moduleLabel,
      parentLabel: null,
      eyebrow: "",
      icon,
      shortcut: moduleShortcut,
      moduleShortcut,
      keywords: moduleKeywords,
      order: order++,
      haystack: {
        label: searchField(moduleLabel),
        keywords: moduleKeywords.map((keyword) => ({ field: "keyword", ...searchField(keyword) })),
      },
    });

    const rawSections = module.sections;
    if (rawSections !== undefined && rawSections !== null && !Array.isArray(rawSections)) {
      problems.push(problem(COMMAND_PROBLEM.MODULE_SECTIONS_INVALID, `${at} ("${moduleId}") has sections that are not a list; they were ignored.`, at));
      return;
    }
    const sections = Array.isArray(rawSections) ? rawSections : [];

    sections.forEach((section, sectionIndex) => {
      const sectionAt = `${at}.sections[${sectionIndex}]`;
      if (!section || typeof section !== "object" || Array.isArray(section)) {
        problems.push(problem(COMMAND_PROBLEM.SECTION_NOT_OBJECT, `${sectionAt} is not a navigation entry and was dropped.`, sectionAt));
        return;
      }
      if (!isNonEmptyString(section.id)) {
        problems.push(problem(COMMAND_PROBLEM.SECTION_ID_INVALID, `${sectionAt} has no usable id and was dropped; it cannot be scrolled to.`, sectionAt));
        return;
      }
      const sectionId = section.id;
      if (!isNonEmptyString(section.label)) {
        problems.push(problem(COMMAND_PROBLEM.SECTION_LABEL_INVALID, `${sectionAt} ("${sectionId}") has no label and was dropped; it would appear as a blank row.`, sectionAt));
        return;
      }
      if (seenIds.has(sectionId)) {
        problems.push(problem(COMMAND_PROBLEM.SECTION_ID_DUPLICATE, `${sectionAt} repeats the id "${sectionId}"; the later entry was dropped.`, sectionAt));
        return;
      }
      seenIds.add(sectionId);

      const sectionLabel = section.label.trim();
      const eyebrow = isNonEmptyString(section.eyebrow) ? section.eyebrow.trim() : "";
      const sectionKeywords = normalizeKeywords(section.keywords, `${sectionAt} ("${sectionId}")`, problems);

      entries.push({
        id: sectionId,
        kind: COMMAND_RESULT_KIND.SECTION,
        viewId: moduleId,
        sectionId,
        label: sectionLabel,
        moduleId,
        moduleLabel,
        // A person searching for "Business Identity" needs to be told it lives in Settings, or the
        // result is a word with no address.
        parentLabel: moduleLabel,
        eyebrow,
        icon,
        // The section itself has no Alt+key chip. Showing the module's chip here would promise that
        // Alt+9 lands on this section, which it does not; `moduleShortcut` carries it for a caller
        // that wants to show it as the parent's.
        shortcut: null,
        moduleShortcut,
        keywords: sectionKeywords,
        order: order++,
        haystack: {
          label: searchField(sectionLabel),
          keywords: [
            ...sectionKeywords.map((keyword) => ({ field: "keyword", ...searchField(keyword) })),
            ...(eyebrow ? [{ field: "eyebrow", ...searchField(eyebrow) }] : []),
          ],
        },
      });
    });
  });

  if (entries.length === 0) {
    return {
      status: COMMAND_INDEX_STATUS.INVALID,
      entries: [],
      problems: [
        ...problems,
        problem(COMMAND_PROBLEM.REGISTRY_NO_USABLE_MODULES, "No navigation entry in the registry could be read, so there is nothing to search.", "registry"),
      ],
      message: "The navigation registry could not be read, so search is unavailable.",
    };
  }
  return {
    status: problems.length > 0 ? COMMAND_INDEX_STATUS.DEGRADED : COMMAND_INDEX_STATUS.READY,
    entries,
    problems,
    message: problems.length > 0
      ? `${problems.length} navigation entr${problems.length === 1 ? "y" : "ies"} could not be read and will not appear in search.`
      : "",
  };
};

/** Best contiguous match of `query` against one field, or null. */
const scoreContiguous = (field, query, tiers) => {
  if (field.lowered === query) {
    return {
      score: tiers.exact,
      matchKind: tiers.exactKind,
      ranges: rangesFor(field, 0, query.length),
      spread: 0,
    };
  }
  const index = field.lowered.indexOf(query);
  if (index === -1) return null;
  const end = index + query.length;
  const whole = startsWord(field.lowered, index) && endsWord(field.lowered, end);
  if (index === 0) {
    return {
      score: tiers.prefix + (whole ? WHOLE_WORD_BONUS : 0),
      matchKind: tiers.prefixKind,
      ranges: rangesFor(field, index, query.length),
      spread: 0,
    };
  }
  if (startsWord(field.lowered, index)) {
    return {
      score: tiers.word + (endsWord(field.lowered, end) ? WHOLE_WORD_BONUS : 0),
      matchKind: tiers.wordKind,
      ranges: rangesFor(field, index, query.length),
      spread: 0,
    };
  }
  // Mid-word. It cannot be a whole-word match by definition, so it never earns the bonus and can
  // never climb into the tier above it.
  return {
    score: tiers.mid,
    matchKind: tiers.midKind,
    ranges: rangesFor(field, index, query.length),
    spread: 0,
  };
};

const LABEL_TIERS = {
  exact: SCORE.EXACT_LABEL,
  exactKind: COMMAND_MATCH_KIND.EXACT_LABEL,
  prefix: SCORE.LABEL_PREFIX,
  prefixKind: COMMAND_MATCH_KIND.LABEL_PREFIX,
  word: SCORE.LABEL_WORD,
  wordKind: COMMAND_MATCH_KIND.LABEL_WORD,
  mid: SCORE.LABEL_MID_WORD,
  midKind: COMMAND_MATCH_KIND.LABEL_MID_WORD,
};

const KEYWORD_TIERS = {
  exact: SCORE.EXACT_KEYWORD,
  exactKind: COMMAND_MATCH_KIND.EXACT_KEYWORD,
  prefix: SCORE.KEYWORD_PREFIX,
  prefixKind: COMMAND_MATCH_KIND.KEYWORD_PREFIX,
  word: SCORE.KEYWORD_PREFIX,
  wordKind: COMMAND_MATCH_KIND.KEYWORD_PREFIX,
  mid: SCORE.KEYWORD_MID,
  midKind: COMMAND_MATCH_KIND.KEYWORD_MID,
};

/** Every word of a multi-word query found somewhere, so "rate sale" still finds "Sale Rates". */
const scoreAllWords = (entry, query) => {
  const words = query.split(" ").filter(Boolean);
  if (words.length < 2) return null;
  const label = entry.haystack.label;
  const found = [];
  for (const word of words) {
    const inLabel = label.lowered.indexOf(word);
    if (inLabel !== -1) {
      found.push({ start: inLabel, length: word.length });
      continue;
    }
    const inKeyword = entry.haystack.keywords.some((keyword) => keyword.lowered.includes(word));
    if (!inKeyword) return null;
  }
  const ranges = label.alignable
    ? mergeIndices(
      [...new Set(found.flatMap(({ start, length }) => Array.from({ length }, (_, offset) => start + offset)))]
        .sort((a, b) => a - b),
    )
    : [];
  return {
    score: SCORE.ALL_WORDS,
    matchKind: COMMAND_MATCH_KIND.ALL_WORDS,
    field: "label",
    text: label.text,
    ranges,
    spread: 0,
  };
};

/** The single best reason this entry matches, or null if it does not. */
const scoreEntry = (entry, query) => {
  const label = entry.haystack.label;
  let best = null;
  const consider = (candidate) => {
    if (!candidate) return;
    if (!best || candidate.score > best.score || (candidate.score === best.score && candidate.spread < best.spread)) {
      best = candidate;
    }
  };

  const labelMatch = scoreContiguous(label, query, LABEL_TIERS);
  if (labelMatch) consider({ ...labelMatch, field: "label", text: label.text });

  for (const keyword of entry.haystack.keywords) {
    const keywordMatch = scoreContiguous(keyword, query, KEYWORD_TIERS);
    if (keywordMatch) consider({ ...keywordMatch, field: keyword.field, text: keyword.text });
  }

  consider(scoreAllWords(entry, query));

  // Subsequence is deliberately last and deliberately cheap. It is what makes typing "bid" find
  // "Business Identity", and it is also what would fill the list with noise if it could outrank a
  // real substring hit.
  const labelIndices = subsequenceIndices(label.lowered, query);
  if (labelIndices) {
    consider({
      score: SCORE.LABEL_SUBSEQUENCE,
      matchKind: COMMAND_MATCH_KIND.LABEL_SUBSEQUENCE,
      field: "label",
      text: label.text,
      ranges: label.alignable ? mergeIndices(labelIndices) : [],
      spread: spreadOf(labelIndices),
    });
  } else {
    for (const keyword of entry.haystack.keywords) {
      const keywordIndices = subsequenceIndices(keyword.lowered, query);
      if (!keywordIndices) continue;
      consider({
        score: SCORE.KEYWORD_SUBSEQUENCE,
        matchKind: COMMAND_MATCH_KIND.KEYWORD_SUBSEQUENCE,
        field: keyword.field,
        text: keyword.text,
        ranges: keyword.alignable ? mergeIndices(keywordIndices) : [],
        spread: spreadOf(keywordIndices),
      });
    }
  }

  return best;
};

const toResult = (entry, match) => ({
  id: entry.id,
  kind: entry.kind,
  viewId: entry.viewId,
  sectionId: entry.sectionId,
  label: entry.label,
  moduleId: entry.moduleId,
  moduleLabel: entry.moduleLabel,
  parentLabel: entry.parentLabel,
  eyebrow: entry.eyebrow,
  icon: entry.icon,
  shortcut: entry.shortcut,
  moduleShortcut: entry.moduleShortcut,
  keywords: entry.keywords,
  score: match.score,
  matchKind: match.matchKind,
  // Which text the ranges index into, so the caller highlights the string it is actually drawing.
  highlight: { field: match.field, text: match.text, ranges: match.ranges },
  order: entry.order,
});

/**
 * Sort order for two scored results.
 *
 * Score, then module before section, then the more compact match, then the shorter label, then
 * registry order. The last one is what makes repeated calls return the same list: registry order is
 * assigned once at build time and is unique per entry, so no comparison ever falls through to the
 * engine's own array order.
 */
const compareResults = (a, b) => {
  if (a.score !== b.score) return b.score - a.score;
  if (a.kind !== b.kind) return a.kind === COMMAND_RESULT_KIND.MODULE ? -1 : 1;
  if (a.spread !== b.spread) return a.spread - b.spread;
  if (a.label.length !== b.label.length) return a.label.length - b.label.length;
  return a.order - b.order;
};

const usableLimit = (limit) =>
  Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_RESULT_LIMIT;

/**
 * The destinations to show before anything is typed.
 *
 * An empty palette is a dead end, and this is the first thing a person sees when they press Ctrl+K.
 * The modules, in the order the navigation shows them, are the honest default: they are the whole
 * map at one level of zoom. `recentIds` — opaque ids the caller remembers from previous jumps — are
 * promoted to the front in the order given, because where you went last is the best available guess
 * at where you are going now. Ids that are no longer in the registry are ignored; that is a normal
 * consequence of an upgrade, not a fault.
 */
const defaultResults = (entries, recentIds) => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const recent = [];
  const taken = new Set();
  for (const id of recentIds) {
    if (typeof id !== "string") continue;
    const entry = byId.get(id);
    if (!entry || taken.has(entry.id)) continue;
    taken.add(entry.id);
    recent.push(entry);
  }
  const modules = entries.filter(
    (entry) => entry.kind === COMMAND_RESULT_KIND.MODULE && !taken.has(entry.id),
  );
  return [...recent, ...modules].map((entry) => toResult(entry, {
    score: 0,
    matchKind: COMMAND_MATCH_KIND.DEFAULT,
    field: "label",
    text: entry.label,
    ranges: [],
  }));
};

/**
 * Search an index built by {@link buildCommandIndex}.
 *
 * @param {object} index the value returned by {@link buildCommandIndex}
 * @param {string} query what the person typed; leading and trailing space and case are ignored
 * @param {object} [options]
 * @param {number} [options.limit] how many results to return; the rest are counted, not hidden
 * @param {Array<string>} [options.recentIds] opaque ids to offer first when the query is blank
 * @returns {{status: string, query: string, results: Array, totalMatches: number, truncated: boolean, degraded: boolean, problems: Array, message: string}}
 */
export const searchCommands = (index, query, options = {}) => {
  const limit = usableLimit(options?.limit);
  const recentIds = Array.isArray(options?.recentIds) ? options.recentIds : [];

  const failure = (status, message, problems = []) => ({
    status,
    query: typeof query === "string" ? query : "",
    results: [],
    totalMatches: 0,
    truncated: false,
    degraded: false,
    problems,
    message,
  });

  if (!index || typeof index !== "object" || !Array.isArray(index.entries)) {
    return failure(
      COMMAND_SEARCH_STATUS.INVALID_INDEX,
      "Search was given no usable navigation index, so no destinations could be offered.",
    );
  }
  if (index.status === COMMAND_INDEX_STATUS.INVALID || index.entries.length === 0) {
    return failure(
      COMMAND_SEARCH_STATUS.INVALID_INDEX,
      index.message || "The navigation registry could not be read, so search is unavailable.",
      Array.isArray(index.problems) ? index.problems : [],
    );
  }
  // Not "nothing matched". A non-string query is a caller bug, and the two must never look alike to
  // the person staring at an empty list.
  if (typeof query !== "string") {
    return failure(
      COMMAND_SEARCH_STATUS.INVALID_QUERY,
      `Search needs text to look for (received ${query === null ? "null" : typeof query}).`,
      Array.isArray(index.problems) ? index.problems : [],
    );
  }

  const degraded = index.status === COMMAND_INDEX_STATUS.DEGRADED;
  const problems = Array.isArray(index.problems) ? index.problems : [];
  const normalized = normalizeQuery(query);

  if (normalized === "") {
    const all = defaultResults(index.entries, recentIds);
    return {
      status: COMMAND_SEARCH_STATUS.DEFAULTS,
      query: "",
      results: all.slice(0, limit),
      totalMatches: all.length,
      truncated: all.length > limit,
      degraded,
      problems,
      message: degraded ? index.message : "",
    };
  }

  const scored = [];
  for (const entry of index.entries) {
    const match = scoreEntry(entry, normalized);
    if (!match) continue;
    // A score of 0 is a real score, so this asks whether a match exists rather than whether its
    // score is truthy. (`CLAUDE.md`: `??` does not fall through on `0`, and nor does `||`.)
    const isModule = entry.kind === COMMAND_RESULT_KIND.MODULE;
    scored.push({
      ...toResult(entry, { ...match, score: match.score + (isModule ? MODULE_BONUS : 0) }),
      spread: match.spread,
    });
  }
  scored.sort(compareResults);
  const results = scored.slice(0, limit).map(({ spread: _spread, ...result }) => result);

  return {
    status: scored.length > 0 ? COMMAND_SEARCH_STATUS.READY : COMMAND_SEARCH_STATUS.NO_MATCHES,
    query: normalized,
    results,
    totalMatches: scored.length,
    truncated: scored.length > limit,
    degraded,
    problems,
    message: scored.length === 0
      ? `Nothing in the app matches "${query.trim()}".`
      : (degraded ? index.message : ""),
  };
};

/**
 * Split a string into drawn segments using a result's highlight ranges.
 *
 * Here rather than in the component so that the one place that knows what a range means is the
 * place that produced it. Out-of-order, overlapping or out-of-bounds ranges are ignored rather than
 * allowed to reorder or duplicate the text — a highlight must never change what the label says.
 */
export const highlightSegments = (text, ranges) => {
  const source = typeof text === "string" ? text : "";
  if (source === "") return [];
  const usable = (Array.isArray(ranges) ? ranges : [])
    .filter((range) =>
      range
      && Number.isInteger(range.start)
      && Number.isInteger(range.end)
      && range.start >= 0
      && range.end > range.start
      && range.end <= source.length)
    .sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = 0;
  for (const range of usable) {
    if (range.start < cursor) continue;
    if (range.start > cursor) segments.push({ text: source.slice(cursor, range.start), matched: false });
    segments.push({ text: source.slice(range.start, range.end), matched: true });
    cursor = range.end;
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), matched: false });
  return segments;
};
