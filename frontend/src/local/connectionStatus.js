/**
 * What the app is doing about the internet, in words a shopkeeper reads once and never thinks about.
 *
 * ## What this replaces
 *
 * Four settings decided one behaviour: **App Mode** (Local Single Device / Branch LAN Server /
 * Branch LAN Client / Cloud Production), **Connectivity Mode** (Auto / Local Only), a **Cloud API
 * URL** field, and a policy file on disk that failed closed when absent. Getting the shop's actual
 * behaviour required all four to agree, and nothing on screen said which one was in charge.
 *
 * The maintainer, who owns the shop this runs in, put it plainly: *"mujhe khud switch krne ki
 * zarurat hi nhi padni chahiye"* -- he should never have to switch anything. Net nahi hai to local
 * chale, net aa jaye to apne aap sync ho jaye. As simple as that.
 *
 * He is right, and the old design was not a feature. It was four ways to misconfigure one shop. On
 * 2026-09-02 it cost an afternoon: a rehearsal profile came up unable to sync, and the reason was
 * spread across a mode nobody had set, a URL nobody had filled and a file that did not exist.
 *
 * ## The rule now
 *
 * There is one behaviour and no choice: **use the cloud when it answers, use this computer when it
 * does not, and catch up by itself.** Nothing to pick, nothing to switch.
 *
 * The only job left for a screen is to *say what is happening*, and to say it in terms of the
 * shop's own stakes -- whether today's bills are safe -- rather than in terms of the software's
 * internal state. "Cloud Production, Connectivity Auto, policy allowInternetAccess=true" describes
 * the machine. "Working offline — 3 bills saved here, they will send when the internet is back"
 * describes the shop.
 *
 * ## What survives, and why
 *
 * The LOCAL_ONLY kill switch stays in the engine. `CLAUDE.md` requires that when it is on, nothing
 * reaches the cloud at all -- blocked, no cloud-router calls, no external connections -- and those
 * guarantees are unchanged and still tested. What changes is that it is **no longer a setting a
 * shopkeeper can reach or has to understand.** He confirmed no machine of his needs to be kept off
 * the cloud on purpose.
 *
 * Pure and free of React, so the decision can be tested without a screen.
 */

/** What the app is actually doing right now. Not a setting -- an observation. */
export const CONNECTION_STATE = Object.freeze({
  /** Talking to the cloud, and up to date. */
  SYNCED: "SYNCED",
  /** Talking to the cloud, with work still to send. */
  CATCHING_UP: "CATCHING_UP",
  /** No cloud right now. Everything is being kept on this computer. */
  OFFLINE: "OFFLINE",
  /** Somebody deliberately cut this machine off. Not reachable from ordinary settings. */
  HELD_OFFLINE: "HELD_OFFLINE",
  /** Too early to say. Shown as nothing rather than as a guess. */
  STARTING: "STARTING",
});

/** How loudly the shop should be told. */
export const CONNECTION_TONE = Object.freeze({
  /** Everything is fine. Say little or nothing. */
  CALM: "CALM",
  /** Working, but the shop should know. */
  NOTICE: "NOTICE",
  /** Something needs a person. */
  ATTENTION: "ATTENTION",
});

const counted = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

/** "3 bills" / "1 bill" -- the shop counts in bills, not in rows or operations. */
const bills = (count) => `${count} ${count === 1 ? "bill" : "bills"}`;

/**
 * Roughly how long ago, for somebody who wants reassurance rather than a timestamp.
 *
 * Deliberately coarse. "2 hours ago" is what a person needs to decide whether to worry; a precise
 * clock time invites them to do arithmetic in their head at a counter with a queue.
 */
export const describeAge = (isoTime, now = new Date()) => {
  const then = isoTime ? new Date(isoTime) : null;
  if (!then || Number.isNaN(then.getTime())) return "";
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (minutes < 0) return "";
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
};

/**
 * What to show, from what is true.
 *
 * @param {object} facts
 * @param {boolean|null} facts.cloudReachable  null while nobody has checked yet
 * @param {number}       facts.pendingCount    work waiting to be sent
 * @param {string}       facts.lastSyncAt      ISO time of the last successful sync
 * @param {boolean}      facts.heldOffline     the kill switch, which no ordinary screen sets
 * @param {boolean}      facts.localServiceReady
 * @returns {{state: string, tone: string, headline: string, detail: string, showsInTopBar: boolean}}
 */
export const resolveConnectionStatus = ({
  cloudReachable = null,
  pendingCount = 0,
  lastSyncAt = "",
  heldOffline = false,
  localServiceReady = true,
  now = new Date(),
} = {}) => {
  const pending = counted(pendingCount);
  const since = describeAge(lastSyncAt, now);

  // Deliberately first. A machine somebody cut off is not "offline" -- offline is weather, this is
  // a decision, and telling somebody to check their internet would send them chasing a fault that
  // does not exist.
  if (heldOffline) {
    return {
      state: CONNECTION_STATE.HELD_OFFLINE,
      tone: CONNECTION_TONE.ATTENTION,
      headline: "This computer is being kept off the internet on purpose",
      detail: pending
        ? `Everything is saved here. ${bills(pending)} will send when it is reconnected.`
        : "Everything is saved here. Nothing is being sent to the cloud.",
      showsInTopBar: true,
    };
  }

  // "Not checked yet" is not "offline". Announcing offline during startup would make every launch
  // begin with a warning that is usually wrong a second later.
  if (!localServiceReady || cloudReachable === null) {
    return {
      state: CONNECTION_STATE.STARTING,
      tone: CONNECTION_TONE.CALM,
      headline: "Starting up",
      detail: "",
      showsInTopBar: false,
    };
  }

  if (!cloudReachable) {
    return {
      state: CONNECTION_STATE.OFFLINE,
      tone: CONNECTION_TONE.NOTICE,
      headline: "Working offline",
      // Says the shop is safe before it says anything is wrong. A cashier reading this mid-sale
      // needs to know whether to keep going, and the answer is yes.
      detail: pending
        ? `Billing works normally. ${bills(pending)} saved on this computer, and they will send by themselves when the internet is back.`
        : "Billing works normally. Everything is saved on this computer and will send by itself when the internet is back.",
      showsInTopBar: true,
    };
  }

  if (pending) {
    return {
      state: CONNECTION_STATE.CATCHING_UP,
      tone: CONNECTION_TONE.CALM,
      headline: "Catching up",
      detail: `${bills(pending)} still to send. Nothing to do — it is sending them now.`,
      showsInTopBar: true,
    };
  }

  return {
    state: CONNECTION_STATE.SYNCED,
    tone: CONNECTION_TONE.CALM,
    headline: "Saved to the cloud",
    detail: since ? `Last checked ${since}.` : "",
    // Nothing is wrong and nothing is waiting, so the top bar says nothing. A permanent green tick
    // is read for a week and ignored forever after -- and then it is worthless on the day it turns
    // red.
    showsInTopBar: false,
  };
};

/**
 * Whether anything about the connection should interrupt somebody.
 *
 * Only a deliberate hold does. Being offline is ordinary in a shop with patchy internet, and this
 * app is built for it; making it an alert would train everyone to dismiss alerts.
 */
export const connectionNeedsAttention = (status) =>
  status?.tone === CONNECTION_TONE.ATTENTION;
