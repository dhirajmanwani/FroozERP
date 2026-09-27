/**
 * A server message, with anything only the maintainer can act on turned into words a shopkeeper can.
 *
 * Some refusals from `backend/operationalScope.js` name the repository script that fixes them
 * ("…created once with scripts/bootstrap-first-counter.mjs (docs/first-counter-setup.md)…"). That
 * is exactly right in a log and exactly wrong on a counter screen: the person reading it cannot run
 * a script, and a file path reads like the app has broken. The server's wording is kept for the
 * logs; on screen the sentence that names a script becomes "ask the maintainer".
 *
 * Only sentences that mention a repository path are touched. Every other message passes through
 * unchanged, character for character, so no error is ever softened into something else.
 */

const SCRIPT_PATH = /\b(?:scripts|docs)\/[\w./-]+\.(?:mjs|js|md)\b/;

/** Sentences, keeping their end punctuation. A dot only ends one when a space or the end follows, so "x.mjs" stays whole. */
const sentences = (text) => text.split(/(?<=[.!?])\s+/);

const replacementFor = (sentence) => {
  if (/bootstrap-first-counter/.test(sentence)) return "Ask the maintainer to set up the first counter.";
  if (/approve-device/.test(sentence)) return "Ask the Owner to post this computer to a counter in Branches & Counters.";
  return "Ask the maintainer for help with this.";
};

export const plainServerMessage = (message) => {
  if (typeof message !== "string" || !SCRIPT_PATH.test(message)) return message;
  const out = [];
  for (const raw of sentences(message)) {
    const sentence = raw.trim();
    if (!sentence) continue;
    if (!SCRIPT_PATH.test(sentence)) {
      out.push(sentence);
      continue;
    }
    // "Post it … in Branches & Counters from a computer that is, or with scripts/approve-device.mjs --counter."
    // keeps its first half, which a person can act on, and drops only the script.
    const beforeScript = sentence.split(/,?\s+or with\s+/)[0];
    if (beforeScript !== sentence && !SCRIPT_PATH.test(beforeScript)) {
      out.push(`${beforeScript.replace(/[.!?]*$/, "")}.`);
      continue;
    }
    const replacement = replacementFor(sentence);
    if (!out.includes(replacement)) out.push(replacement);
  }
  return out.join(" ");
};
