/**
 * FROST live voice: talk to FROST and hear it answer, with the microphone never leaving the laptop.
 *
 * ## What this replaced, and why
 *
 * There used to be an OpenAI Realtime path in App.jsx. It opened a WebRTC session straight from
 * the counter to a third party, streamed the shop's microphone there outside LOCAL_ONLY's reach,
 * and answered with a model that was sent no tools, so it could not read the books and would speak
 * a number nobody could check. It is gone. What replaces it is three local pieces put in a row:
 *
 *   1. this module decides when somebody has finished saying something (energy-based voice
 *      activity detection, no network), and packs it as 16 kHz mono WAV;
 *   2. the desktop gateway's `POST /api/local/speech/transcribe` turns it into text with
 *      whisper.cpp on this machine (127.0.0.1 only);
 *   3. the text goes through `askAiAssistant` -- the exact function the typed box uses -- so the
 *      answer is FROST's grounded answer, and `frostSpeech.js` reads that answer aloud with the
 *      device's own synthesiser.
 *
 * Nothing here composes a figure and nothing here opens a connection. The controller is handed its
 * transport (`transcribe`) and its question path (`ask`) by the caller, and the only audio it ever
 * hands anyone is the WAV it passes to `transcribe`. The App wires `transcribe` to the local
 * gateway and nowhere else; `frostLiveVoice.test.mjs` holds App.jsx to that.
 *
 * ## Which utterances are questions
 *
 * A counter is loud and most of what the microphone hears is not addressed to FROST. An utterance
 * is a question only when it starts with the wake word ("Frost", "Hey Frost", "OK Frost" -- and the
 * ways Whisper writes an Indian-English "Frost": "Forest", "Frosty", "Prost"... see
 * `WAKE_WORD_VARIANTS`), or when it comes within ten seconds of FROST finishing an answer (a
 * follow-up). Everything else is transcribed on the laptop and never sent to the question route.
 * It IS shown, on this screen only, for about six seconds ("Heard: "..." -- say Frost first"):
 * round 1 hid it, and a FROST that silently ignored a mis-heard "Frost" looked exactly like a FROST
 * that heard nothing at all.
 *
 * ## Round 2: why "Listening" could sit there doing nothing, and what now says so
 *
 * The first build was tested on the owner's laptop and "just says listening but doesnt do anything".
 * Every link in the chain now either works or puts words on the screen:
 *   - the AudioContext is created inside the click (`prime()`), before the permission wait, because
 *     WebView2 leaves a context made after an await "suspended" and a suspended context never
 *     delivers a frame. A context that is suspended anyway says "Click anywhere to start listening"
 *     and the App resumes it on the next pointerdown or keydown;
 *   - a frame watchdog: no microphone frames for 2.5 s says "No sound is reaching FROST from the
 *     microphone. Click here to start it.";
 *   - a live level meter (`onLevel`), so "the microphone hears me" is visible without FROST;
 *   - detector thresholds low enough for a laptop microphone behind noise suppression;
 *   - what was heard is shown every time, wake word or not.
 *
 * ## Always listening
 *
 * The same controller serves the in-drawer "Live voice" switch and the app-wide "Listen for Frost
 * everywhere" switch; there is only ever one microphone. `start({ idleLimitMs: null })` turns off
 * the three-minute idle switch-off, `setIdleLimit()` changes it on a running session, and `onWake`
 * lets the App pop the FROST drawer open on the conversation before the question is asked. The
 * App draws `liveVoiceIndicatorView(...)` next to the bell whenever the microphone is on, in either
 * mode, so it is never on invisibly.
 *
 * ## Why the pieces are separate functions
 *
 * CLAUDE.md: only `frontend/src/local/` is practically testable, so every decision lives here and
 * App.jsx only supplies the browser objects. The detector is fed synthetic frames in tests; the
 * controller is driven with a fake microphone, a fake AudioContext and a fake synthesiser.
 */

import { buildFrostConversation, latestSpokenTurn } from "./frostConversation.js";
import { resolveSpeechPlan, speechSupported, speechWithNotice } from "./frostSpeech.js";

/** The one route audio is ever sent to. Relative: the caller prefixes the local gateway's base. */
export const LIVE_VOICE_TRANSCRIBE_PATH = "/api/local/speech/transcribe";
export const LIVE_VOICE_STATUS_PATH = "/api/local/speech/status";
export const LIVE_VOICE_INSTALL_PATH = "/api/local/speech/install";

export const LIVE_VOICE_TARGET_RATE = 16000;
export const LIVE_VOICE_FOLLOW_UP_MS = 10000;
export const LIVE_VOICE_IDLE_LIMIT_MS = 180000;
/** No microphone frame for this long while live voice is on is said out loud, not waited out. */
export const LIVE_VOICE_NO_FRAMES_MS = 2500;
/** How long "Heard: ..." stays on the screen. */
export const LIVE_VOICE_HEARD_MS = 6000;
/** Per device, not per profile or per user: it is about this laptop's microphone. */
export const LIVE_VOICE_ALWAYS_ON_STORAGE_KEY = "froozerp_frost_voice_always_on";

export const DETECTOR_DEFAULTS = Object.freeze({
  // RMS of a float frame in [-1, 1]. Round 1 started at 0.02, measured against a desk microphone.
  // A laptop's own microphone behind WebView2's noise suppression puts quiet, ordinary speech a
  // couple of feet away at about 0.01 -- under 0.02, so round 1 never heard it start. A quiet room
  // with suppression on sits near 0.001 to 0.003.
  startThreshold: 0.008,
  // Lower than the start threshold on purpose: the gap is the hysteresis that stops the tail of a
  // word, which is quieter than its start, from being counted as silence.
  stopThreshold: 0.004,
  silenceMs: 800,
  minMs: 400,
  maxMs: 20000,
  // Kept from before the start threshold was crossed, so the first consonant of "Frost" is not
  // clipped off -- whisper hears "rost" otherwise.
  preRollMs: 250,
  // Kept after the last loud frame, so the end of the last word is not clipped either.
  tailMs: 250,
  // A shop is not a quiet room. When the background is loud the thresholds follow it up, to a
  // ceiling, so a fan or a road does not read as one endless utterance. Round 1's x3 up to 0.15
  // could climb above normal speech on a laptop microphone; x2.5 capped at 0.06 cannot. The cost:
  // a background steadily louder than about 0.03 keeps the detector from ever hearing a pause, and
  // that is reported ("too_loud") rather than sitting quietly on "Listening".
  adaptive: true,
  noiseMultiplier: 2.5,
  maxStartThreshold: 0.06,
});

/** Root-mean-square energy of one frame. Non-finite samples count as silence. */
export const frameRms = (frame) => {
  const length = frame?.length || 0;
  if (!length) return 0;
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    const value = frame[index];
    if (Number.isFinite(value)) sum += value * value;
  }
  return Math.sqrt(sum / length);
};

/**
 * A microphone level for the meter, 0 to 1, from one frame's RMS.
 *
 * Logarithmic, because that is how loudness is heard: 60 dB of range, so RMS 0.001 (a silent room)
 * is 0, the detector's start threshold (0.008) is about 0.3, ordinary speech (0.03 to 0.1) is 0.5
 * to 0.67, and full scale is 1. Rounded to two places so a steady room does not redraw the meter
 * for every frame.
 */
export const levelFromRms = (rms) => {
  const value = Number(rms);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const level = (20 * Math.log10(value) + 60) / 60;
  return Math.round(Math.max(0, Math.min(1, level)) * 100) / 100;
};

/**
 * Where the level goes. A tiny store with `get`/`subscribe`, so only the meter re-renders on every
 * frame -- routing ~12 updates a second through App's state would redraw all of App.jsx each time.
 */
export const createVoiceLevelChannel = () => {
  let level = 0;
  const listeners = new Set();
  return {
    get: () => level,
    set(next) {
      const value = Number.isFinite(next) ? Math.max(0, Math.min(1, next)) : 0;
      if (value === level) return;
      level = value;
      for (const listener of listeners) {
        try { listener(); } catch { /* a broken meter must not break the microphone loop */ }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};

const finiteOr = (value, fallback) => (Number.isFinite(value) ? value : fallback);

const concatFrames = (chunks, length) => {
  const out = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= length) break;
    const take = Math.min(chunk.length, length - offset);
    out.set(take === chunk.length ? chunk : chunk.subarray(0, take), offset);
    offset += take;
  }
  return out;
};

/**
 * Decide where utterances start and end in a stream of microphone frames.
 *
 * A state machine with three states:
 *   - `idle`: waiting. The last `preRollMs` of audio is remembered.
 *   - `speech`: a frame crossed the start threshold. Every frame is kept. Frames under the stop
 *     threshold add to a silence run; anything louder resets it (the hangover). When the silence run
 *     reaches `silenceMs` the utterance ends.
 *   - `overflow`: somebody (or something) kept going past `maxMs`. The audio is dropped and nothing is
 *     emitted until `silenceMs` of quiet, so the tail of a long speech is not sent as a new question.
 *
 * `push(frame)` returns the events that frame completed:
 *   `{ type: "utterance", samples: Float32Array, durationMs }` or
 *   `{ type: "discarded", reason: "too_short" | "too_long" | "too_loud", durationMs }`.
 * `too_loud` is emitted once when `overflow` lasts another whole `maxMs` without a pause.
 *
 * Frames are copied; the caller may reuse its buffer (a ScriptProcessorNode does).
 */
export const createUtteranceDetector = (options = {}) => {
  const sampleRate = Number(options.sampleRate);
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError("createUtteranceDetector needs a positive sampleRate.");
  }
  const cfg = {
    startThreshold: finiteOr(options.startThreshold, DETECTOR_DEFAULTS.startThreshold),
    stopThreshold: finiteOr(options.stopThreshold, DETECTOR_DEFAULTS.stopThreshold),
    silenceMs: finiteOr(options.silenceMs, DETECTOR_DEFAULTS.silenceMs),
    minMs: finiteOr(options.minMs, DETECTOR_DEFAULTS.minMs),
    maxMs: finiteOr(options.maxMs, DETECTOR_DEFAULTS.maxMs),
    preRollMs: finiteOr(options.preRollMs, DETECTOR_DEFAULTS.preRollMs),
    tailMs: finiteOr(options.tailMs, DETECTOR_DEFAULTS.tailMs),
    adaptive: options.adaptive === undefined ? DETECTOR_DEFAULTS.adaptive : options.adaptive === true,
    noiseMultiplier: finiteOr(options.noiseMultiplier, DETECTOR_DEFAULTS.noiseMultiplier),
    maxStartThreshold: finiteOr(options.maxStartThreshold, DETECTOR_DEFAULTS.maxStartThreshold),
  };
  if (cfg.stopThreshold > cfg.startThreshold) {
    throw new RangeError("stopThreshold must not be above startThreshold.");
  }
  const samplesFor = (ms) => Math.max(0, Math.round((ms * sampleRate) / 1000));
  const msFor = (samples) => (samples * 1000) / sampleRate;
  const silenceSamples = samplesFor(cfg.silenceMs);
  const minSamples = samplesFor(cfg.minMs);
  const maxSamples = samplesFor(cfg.maxMs);
  const preRollSamples = samplesFor(cfg.preRollMs);
  const tailSamples = samplesFor(cfg.tailMs);
  const stopRatio = cfg.startThreshold > 0 ? cfg.stopThreshold / cfg.startThreshold : 0.5;

  let state = "idle";
  let chunks = [];
  let total = 0;
  let speechStart = 0;
  let voicedEnd = 0;
  let silenceRun = 0;
  let preRoll = [];
  let preRollTotal = 0;
  let noiseFloor = 0;
  let noiseSeen = false;
  let overflowRun = 0;
  let tooLoudReported = false;

  const thresholds = () => {
    if (!cfg.adaptive || !noiseSeen) return { start: cfg.startThreshold, stop: cfg.stopThreshold };
    const start = Math.min(cfg.maxStartThreshold, Math.max(cfg.startThreshold, noiseFloor * cfg.noiseMultiplier));
    return { start, stop: Math.max(cfg.stopThreshold, start * stopRatio) };
  };
  const learn = (rms) => {
    noiseFloor = noiseSeen ? noiseFloor * 0.95 + rms * 0.05 : rms;
    noiseSeen = true;
  };
  const clearUtterance = () => {
    chunks = [];
    total = 0;
    speechStart = 0;
    voicedEnd = 0;
    silenceRun = 0;
  };
  const append = (frame) => {
    chunks.push(frame);
    total += frame.length;
  };

  const push = (input) => {
    const length = input?.length || 0;
    if (!length) return [];
    const frame = Float32Array.from(input);
    const rms = frameRms(frame);
    const { start, stop } = thresholds();
    const events = [];

    if (state === "idle") {
      if (rms >= start) {
        state = "speech";
        chunks = preRoll;
        total = preRollTotal;
        preRoll = [];
        preRollTotal = 0;
        speechStart = total;
        append(frame);
        voicedEnd = total;
        silenceRun = 0;
      } else {
        learn(rms);
        preRoll.push(frame);
        preRollTotal += frame.length;
        while (preRoll.length > 1 && preRollTotal - preRoll[0].length >= preRollSamples) {
          preRollTotal -= preRoll.shift().length;
        }
      }
      return events;
    }

    if (state === "speech") {
      append(frame);
      if (rms < stop) {
        silenceRun += frame.length;
      } else {
        silenceRun = 0;
        voicedEnd = total;
      }
      const voiced = voicedEnd - speechStart;
      if (voiced > maxSamples) {
        events.push({ type: "discarded", reason: "too_long", durationMs: msFor(voiced) });
        clearUtterance();
        overflowRun = 0;
        tooLoudReported = false;
        state = "overflow";
        return events;
      }
      if (silenceRun >= silenceSamples) {
        if (voiced < minSamples) {
          events.push({ type: "discarded", reason: "too_short", durationMs: msFor(voiced) });
        } else {
          const keep = Math.min(total, voicedEnd + tailSamples);
          events.push({ type: "utterance", samples: concatFrames(chunks, keep), durationMs: msFor(voiced) });
        }
        clearUtterance();
        state = "idle";
      }
      return events;
    }

    // overflow
    learn(rms);
    if (rms < stop) silenceRun += frame.length;
    else silenceRun = 0;
    overflowRun += frame.length;
    if (silenceRun >= silenceSamples) {
      clearUtterance();
      overflowRun = 0;
      tooLoudReported = false;
      state = "idle";
    } else if (!tooLoudReported && overflowRun >= maxSamples) {
      // Another whole maximum without one pause: not somebody talking, a background the adaptive
      // ceiling cannot climb over. Said once, so the screen explains why nothing is being sent.
      tooLoudReported = true;
      events.push({ type: "discarded", reason: "too_loud", durationMs: msFor(overflowRun) });
    }
    return events;
  };

  const reset = () => {
    clearUtterance();
    preRoll = [];
    preRollTotal = 0;
    overflowRun = 0;
    tooLoudReported = false;
    state = "idle";
  };

  return {
    push,
    reset,
    get state() { return state; },
    get hearing() { return state === "speech"; },
    get thresholds() { return thresholds(); },
  };
};

/**
 * Downsample to 16 kHz by averaging each output sample's span of input (a box low-pass, then
 * decimation). Exact for 48000 (3:1) and handles 44100 (2.75625:1) with fractional span edges.
 *
 * Upsampling is refused rather than faked: a microphone at under 16 kHz would give whisper audio it
 * was not trained on, and saying so is better than a transcription that silently degrades.
 */
export const downsampleTo16k = (input, fromRate) => {
  const rate = Number(fromRate);
  if (!Number.isFinite(rate) || rate < LIVE_VOICE_TARGET_RATE) {
    throw new RangeError(`Cannot downsample from ${fromRate} Hz to ${LIVE_VOICE_TARGET_RATE} Hz.`);
  }
  const source = input || new Float32Array(0);
  if (rate === LIVE_VOICE_TARGET_RATE) return Float32Array.from(source);
  const ratio = rate / LIVE_VOICE_TARGET_RATE;
  const outLength = Math.floor(source.length / ratio);
  const out = new Float32Array(outLength);
  for (let index = 0; index < outLength; index += 1) {
    const from = index * ratio;
    const to = Math.min(source.length, (index + 1) * ratio);
    // Weighted by how much of each input sample falls in [from, to), so a 44.1 kHz stream is not
    // biased towards whichever neighbour happens to round in.
    let sum = 0;
    let weight = 0;
    for (let position = Math.floor(from); position < to; position += 1) {
      const covered = Math.min(position + 1, to) - Math.max(position, from);
      if (covered <= 0) continue;
      const value = Number.isFinite(source[position]) ? source[position] : 0;
      sum += value * covered;
      weight += covered;
    }
    out[index] = weight > 0 ? sum / weight : 0;
  }
  return out;
};

const writeAscii = (view, offset, text) => {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
};

/** RIFF/WAVE, PCM16, mono, 16 kHz. Samples outside [-1, 1] are clamped; non-finite ones are 0. */
export const encodeWav16kMono = (samples) => {
  const source = samples || new Float32Array(0);
  const dataBytes = source.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, LIVE_VOICE_TARGET_RATE, true);
  view.setUint32(28, LIVE_VOICE_TARGET_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let index = 0; index < source.length; index += 1) {
    const raw = Number.isFinite(source[index]) ? source[index] : 0;
    const clamped = Math.max(-1, Math.min(1, raw));
    const value = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    view.setInt16(44 + index * 2, Math.max(-32768, Math.min(32767, value)), true);
  }
  return new Uint8Array(buffer);
};

// Bracketed or parenthesised markers whisper writes for non-speech: [BLANK_AUDIO], (music),
// [Music], *coughs*. The gateway strips [BLANK_AUDIO]; the rest are stripped here too.
const MARKERS = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g;

/**
 * What Whisper writes when somebody says "Frost" in Indian English, as the first word.
 *
 * Decided (round 2, from the owner's own test): an explicit list, not an edit distance. Edit
 * distance 1 or 2 from "frost" takes in "first", "front", "froth" and "frosh", and a counter says
 * "first" all day ("first give me the bill"). The list is every spelling seen or reasonably
 * expected for this one word, plus two of our own: "forrest" (Whisper's spelling of the name, which
 * "Frost" said with a vowel between f and r lands on) and "frosts". Ordinary words that merely
 * start like it -- first, for, from, frozen, fresh, fruit, frost-free, frostbite, forests -- are
 * NOT wake words; the tests hold both lists.
 *
 * The price, accepted knowingly: "Frosty the snowman" and "Frosted flakes..." as the first words of
 * a sentence now go to FROST as a question. At a fruit counter that is rare, and FROST answering a
 * stray sentence is visible and harmless; FROST ignoring its own name is the bug being fixed.
 */
export const WAKE_WORD_VARIANTS = Object.freeze([
  "frost", "frosty", "frost's", "frosts", "frosted",
  "forest", "forrest", "frust", "frast", "prost", "froast", "fraust", "fross",
]);
const WAKE_SET = new Set(WAKE_WORD_VARIANTS);
const LEADING = /^[\s"'“‘«(-]+/u;
const GREETING = /^(?:hey|hi|ok|okay)(?![\p{L}'’])[\s,.!-]*/iu;
// A word, with at most one apostrophe inside it ("frost's", "frost’s").
const FIRST_WORD = /^\p{L}+(?:['’]\p{L}+)?/u;

/** The transcript with non-speech markers removed and whitespace collapsed. */
export const cleanTranscript = (text) => String(text ?? "").replace(MARKERS, " ").replace(/\s+/g, " ").trim();

/**
 * The text after the wake word, or null when the transcript does not start with one.
 * "Frost", "Hey Frost", "OK, Forest" -- the wake word is the first word, or the second after a
 * greeting. A hyphen straight after it ("Frost-free fridge") means it was part of another word.
 */
export const textAfterWakeWord = (cleaned) => {
  const tryAt = (text) => {
    const match = FIRST_WORD.exec(text);
    if (!match) return null;
    if (!WAKE_SET.has(match[0].toLowerCase().replace(/’/g, "'"))) return null;
    const rest = text.slice(match[0].length);
    if (/^-\p{L}/u.test(rest)) return null;
    return rest;
  };
  const text = String(cleaned ?? "").replace(LEADING, "");
  const direct = tryAt(text);
  if (direct !== null) return direct;
  const greeting = GREETING.exec(text);
  return greeting ? tryAt(text.slice(greeting[0].length)) : null;
};

/**
 * Whether a transcript is a question for FROST, and the question it is.
 *
 * @returns {{ask: boolean, question: string, reason: "empty"|"wake_only"|"wake_word"|"follow_up"|"no_wake_word"}}
 *   `wake_only` means "Frost." on its own: nothing to ask yet, and the caller opens the follow-up
 *   window so the next utterance is taken as the question.
 */
export const questionFromTranscript = (text, { lastSpokeEndedAtMs = null, nowMs = null, followUpMs = LIVE_VOICE_FOLLOW_UP_MS } = {}) => {
  const cleaned = cleanTranscript(text);
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return { ask: false, question: "", reason: "empty" };
  const afterWake = textAfterWakeWord(cleaned);
  if (afterWake !== null) {
    const question = afterWake.replace(/^[\s,.:;!?-]+/, "").trim();
    if (!/[\p{L}\p{N}]/u.test(question)) return { ask: false, question: "", reason: "wake_only" };
    return { ask: true, question, reason: "wake_word" };
  }
  const since = Number(nowMs) - Number(lastSpokeEndedAtMs);
  if (
    lastSpokeEndedAtMs !== null && nowMs !== null
    && Number.isFinite(since) && since >= 0 && since <= followUpMs
  ) {
    return { ask: true, question: cleaned, reason: "follow_up" };
  }
  return { ask: false, question: "", reason: "no_wake_word" };
};

const HEARD_MAX_CHARS = 140;

/**
 * The line shown for ~6 s after every transcription, so a mishearing -- or a "Frost" Whisper wrote
 * as something else -- is visible. Shown on this screen only; nothing here is sent anywhere.
 */
export const heardLineFor = (text, reason) => {
  const cleaned = cleanTranscript(text);
  if (reason === "empty" || !/[\p{L}\p{N}]/u.test(cleaned)) {
    return "Heard nothing clear. Say it again, a little closer to the microphone.";
  }
  const shown = cleaned.length > HEARD_MAX_CHARS ? `${cleaned.slice(0, HEARD_MAX_CHARS - 1).trimEnd()}…` : cleaned;
  if (reason === "no_wake_word") return `Heard: "${shown}" — say Frost first`;
  return `Heard: "${shown}"`;
};

/** True when live voice should turn itself off. An unreadable clock turns it off too. */
export const liveVoiceIdle = ({ lastQuestionAtMs, nowMs, limitMs = LIVE_VOICE_IDLE_LIMIT_MS } = {}) => {
  const last = Number(lastQuestionAtMs);
  const now = Number(nowMs);
  if (lastQuestionAtMs === null || lastQuestionAtMs === undefined || !Number.isFinite(last) || !Number.isFinite(now)) return true;
  return now - last >= limitMs;
};

export const SPEECH_SETUP_PROMPT = "Voice needs a one-time download (about 470 MB) on this laptop. Your voice stays on this laptop.";

const SPEECH_STATES = new Set(["not_installed", "installing", "ready", "failed"]);
const PHASE_WORDS = Object.freeze({
  engine: "Downloading the speech engine",
  model: "Downloading the speech model",
  verifying: "Checking the download",
});
const megabytes = (bytes) => `${Math.round(Number(bytes) / (1024 * 1024))} MB`;
const LOCAL_ONLY_DOWNLOAD = "This laptop is in Local Only mode, so the voice download is not allowed. Nothing was downloaded. Switch Connectivity to Auto to download it.";

/**
 * What the one-line setup card says, for every state the gateway can be in and every way reading
 * it can fail.
 *
 * @param {object|null} status  the body of GET /api/local/speech/status, or null before it is read
 * @param {object|null} failure `{ stage: "status"|"install", status?, code?, message? }`
 * @returns {{kind: string, ready: boolean, text: string, detail: string, percent: number|null,
 *            action: "download"|"retry"|null, tone: "neutral"|"progress"|"positive"|"error"}}
 *
 * Only `kind: "ready"` has `ready: true`. A failure is never drawn as ready, and an unreadable
 * status is never drawn as "not installed" either -- that would offer a 470 MB download to fix a
 * gateway that simply did not answer.
 */
export const speechSetupView = (status, failure = null) => {
  const view = (kind, text, extra = {}) => ({
    kind,
    ready: kind === "ready",
    text,
    detail: "",
    percent: null,
    action: null,
    tone: "neutral",
    ...extra,
  });
  if (failure?.code === "SPEECH_INSTALL_BLOCKED_LOCAL_ONLY") {
    return view("blocked", LOCAL_ONLY_DOWNLOAD, { tone: "error" });
  }
  if (failure && failure.stage !== "install") {
    const reason = String(failure.message || "").trim();
    return view("unreadable", `Voice setup could not be checked${reason ? `: ${reason}` : "."}`, { action: "retry", tone: "error" });
  }
  const readable = status && typeof status === "object" && SPEECH_STATES.has(status.state);
  if (failure && failure.stage === "install" && !(readable && status.state === "installing")) {
    if (failure.code === "SPEECH_INSTALL_IN_PROGRESS") {
      return view("installing", "A voice download is already running.", { tone: "progress" });
    }
    if (failure.code === "SPEECH_MODEL_UNKNOWN") {
      return view("failed", "The voice download could not start: this app asked for a speech model the laptop does not know.", { action: "retry", tone: "error" });
    }
    const reason = String(failure.message || "").trim();
    return view("failed", `The voice download could not start${reason ? `: ${reason}` : "."}`, { action: "retry", tone: "error" });
  }
  if (status === null || status === undefined) {
    return view("checking", "Checking whether voice is set up on this laptop...");
  }
  if (!readable) {
    return view("unreadable", "The voice setup status could not be read, so voice stays off.", { action: "retry", tone: "error" });
  }
  const internetAllowed = status.internet_allowed === true;
  if (status.state === "ready") {
    return view("ready", "Voice is ready on this laptop. Turn on Live voice to talk to FROST.", { tone: "positive" });
  }
  if (status.state === "installing") {
    const progress = status.progress || {};
    const received = Number(progress.received_bytes);
    const total = Number(progress.total_bytes);
    const words = PHASE_WORDS[progress.phase] || "Downloading voice";
    if (Number.isFinite(received) && Number.isFinite(total) && total > 0) {
      const percent = Math.max(0, Math.min(100, Math.floor((received / total) * 100)));
      return view("installing", `${words}: ${percent}%`, { percent, tone: "progress", detail: `${megabytes(received)} of ${megabytes(total)}` });
    }
    return view("installing", `${words}...`, {
      tone: "progress",
      detail: Number.isFinite(received) && received > 0 ? `${megabytes(received)} so far` : "",
    });
  }
  if (status.state === "failed") {
    const reason = String(status.error || "").trim() || "no reason was given";
    return view("failed", `Voice setup failed: ${reason}`, internetAllowed
      ? { action: "retry", tone: "error" }
      : { tone: "error", detail: LOCAL_ONLY_DOWNLOAD });
  }
  // not_installed
  if (!internetAllowed) {
    return view("blocked", SPEECH_SETUP_PROMPT, { tone: "error", detail: LOCAL_ONLY_DOWNLOAD });
  }
  return view("not_installed", SPEECH_SETUP_PROMPT, { action: "download" });
};

/**
 * A line about the speech engine itself, for a status that is otherwise ready. Tolerates a gateway
 * from before round 2, which sends neither `engine` nor `engine_update_available`: then it is null.
 *
 * @param {object|null} status  GET /api/local/speech/status
 * @param {{engine?: string|null}} [latest]  the `engine` the last transcription reported, if any
 * @returns {null | {kind: "update"|"slow", text: string, detail: string, action: "install"|null}}
 */
export const speechEngineNotice = (status, { engine = null } = {}) => {
  if (!status || typeof status !== "object" || status.state !== "ready") return null;
  if (status.engine_update_available === true) {
    const allowed = status.internet_allowed === true;
    return {
      kind: "update",
      text: "Voice engine update available. It makes answers come back faster; it is a 4 MB download and the speech model is kept.",
      detail: allowed ? "" : "This laptop is in Local Only mode, so the update cannot be downloaded. Switch Connectivity to Auto to install it.",
      action: allowed ? "install" : null,
    };
  }
  const running = typeof engine === "string" && engine ? engine : status.engine;
  if (running === "cli") {
    return {
      kind: "slow",
      text: "Voice is using its slower engine on this laptop, so each answer takes a few seconds longer.",
      detail: "",
      action: null,
    };
  }
  return null;
};

export const LIVE_VOICE_PHASE_LABELS = Object.freeze({
  off: "Off",
  starting: "Opening the microphone",
  paused: "Click anywhere to start listening",
  no_sound: "No sound from the microphone",
  listening: "Listening",
  hearing: "Hearing you",
  transcribing: "Working out what you said",
  thinking: "FROST is thinking",
  speaking: "FROST is speaking",
});

export const LIVE_VOICE_STOP_MESSAGES = Object.freeze({
  switched_off: "Live voice is off. The microphone is closed.",
  idle: "Live voice turned off after 3 minutes without a question.",
  drawer_closed: "Live voice turned off because FROST was closed.",
  signed_out: "Live voice turned off because you signed out.",
  unmounted: "Live voice turned off.",
  not_permitted: "Live voice is only for the Owner or an Admin.",
  unsupported: "This device cannot use the microphone here, so live voice is off.",
  speech_unsupported: "This device cannot read answers aloud, so live voice is off.",
});

/** Shown while the AudioContext is suspended and waiting for a click or a key. */
export const LIVE_VOICE_PAUSED_MESSAGE = "Click anywhere to start listening.";
/** Shown when no microphone frame has arrived for LIVE_VOICE_NO_FRAMES_MS. */
export const LIVE_VOICE_NO_SOUND_MESSAGE = "No sound is reaching FROST from the microphone. Click here to start it.";
/** Shown when a click to resume did not bring frames back either. */
export const LIVE_VOICE_STILL_NO_SOUND_MESSAGE = "Still no sound from the microphone after starting it. Check the microphone in Windows Sound settings, or turn voice off and on again.";
export const LIVE_VOICE_RESUMING_MESSAGE = "Starting the microphone...";
export const LIVE_VOICE_READY_HINT = "Say \"Frost\" and then your question.";
export const LIVE_VOICE_TOO_LOUD_MESSAGE = "It is too loud here for FROST to hear where you stop talking, so nothing is being sent. Move somewhere quieter or closer to the microphone.";
// The gateway loads the speech model into its server on the first transcription after it starts
// (up to ~30 s, then the request itself), so the first one can take up to a minute. Said, so the
// bar does not look stuck on "Working out what you said".
export const LIVE_VOICE_ENGINE_STARTING_MESSAGE = "Starting the speech engine (the first time can take up to a minute)...";
export const LIVE_VOICE_TRANSCRIBE_SLOW_MESSAGE = "Still working out what you said. The speech engine is taking longer than usual.";
/** A transcription still running after this long says so, whether or not it is the first. */
export const LIVE_VOICE_TRANSCRIBE_SLOW_MS = 6000;
const WORKING_MESSAGES = new Set([LIVE_VOICE_ENGINE_STARTING_MESSAGE, LIVE_VOICE_TRANSCRIBE_SLOW_MESSAGE]);
export const LIVE_VOICE_SPEAK_FAILED_MESSAGE = "FROST could not read the answer aloud on this device. The answer is on the screen.";
const STALL_MESSAGES = new Set([
  LIVE_VOICE_PAUSED_MESSAGE,
  LIVE_VOICE_NO_SOUND_MESSAGE,
  LIVE_VOICE_STILL_NO_SOUND_MESSAGE,
  LIVE_VOICE_RESUMING_MESSAGE,
]);

/**
 * The small always-visible indicator next to the bell.
 *
 * Drawn whenever the microphone is on -- in either mode, for anybody, whatever `allowed` and
 * `alwaysOn` say -- because a microphone must never be on without something on screen saying so.
 * When "listen everywhere" is chosen but FROST is not listening because something failed, it is
 * drawn too, with the reason, since the drawer that would otherwise say so may be closed.
 *
 * @returns {null | {kind: "on"|"stopped", phase: string, label: string, tone: "active"|"attention"|"error", detail: string}}
 */
export const liveVoiceIndicatorView = ({ view = null, alwaysOn = false, allowed = false } = {}) => {
  const message = String(view?.message || "");
  if (view?.on === true) {
    const phase = String(view.phase || "listening");
    const stalled = phase === "paused" || phase === "no_sound";
    return {
      kind: "on",
      phase,
      label: LIVE_VOICE_PHASE_LABELS[phase] || LIVE_VOICE_PHASE_LABELS.listening,
      tone: phase === "no_sound" || view.tone === "error" ? "error" : stalled ? "attention" : "active",
      // A slow first transcription is said next to the bell too, or a closed drawer looks stuck.
      detail: stalled || view.tone === "error" || WORKING_MESSAGES.has(message) ? message : "",
    };
  }
  if (alwaysOn && allowed && view?.tone === "error" && message) {
    return { kind: "stopped", phase: "off", label: "FROST is not listening", tone: "error", detail: message };
  }
  return null;
};

const storageFrom = (source) => (typeof source === "function" ? source() : source);

/** The "listen everywhere" choice on this device. Anything unreadable is "off". */
export const readAlwaysOnPreference = (source) => {
  try {
    return storageFrom(source)?.getItem(LIVE_VOICE_ALWAYS_ON_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

/** Remember the choice. False when it could not be stored; the choice still holds this session. */
export const writeAlwaysOnPreference = (source, on) => {
  try {
    const storage = storageFrom(source);
    if (!storage) return false;
    if (on) storage.setItem(LIVE_VOICE_ALWAYS_ON_STORAGE_KEY, "1");
    else storage.removeItem(LIVE_VOICE_ALWAYS_ON_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
};

export const LIVE_VOICE_PREFERENCE_NOT_SAVED = "This choice could not be saved on this laptop, so it lasts only until FroozERP closes.";

/** One short line for why the microphone could not open. */
export const microphoneFailureMessage = (error) => {
  const name = String(error?.name || "");
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") {
    return "Microphone permission was refused, so live voice is off. Allow the microphone for FroozERP and try again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") {
    return "No microphone was found, so live voice is off.";
  }
  if (name === "NotReadableError" || name === "AbortError" || name === "TrackStartError") {
    return "The microphone is busy in another program or could not start, so live voice is off.";
  }
  const detail = String(error?.message || name || "").trim();
  return `The microphone could not start${detail ? ` (${detail})` : ""}, so live voice is off.`;
};

/**
 * What a failed transcription means, and whether live voice keeps going.
 *
 * Takes an axios-shaped error (`error.response.status`, `error.response.data.code`). Only "busy" is
 * worth carrying on through: the engine is already working on the previous thing said. Everything
 * else is a fault the owner has to know about, and a microphone left open on top of a fault is a
 * microphone listening to nothing useful.
 */
export const describeTranscribeFailure = (error) => {
  const status = Number(error?.response?.status);
  const code = String(error?.response?.data?.code || "");
  if (code === "SPEECH_BUSY" || status === 429) {
    return { stop: false, message: "Still working on the last thing you said. Say it again in a moment." };
  }
  if (code === "SPEECH_NOT_INSTALLED" || status === 409) {
    return { stop: true, message: "The voice download is missing on this laptop, so live voice is off. Set it up again with the Live voice switch." };
  }
  if (code === "SPEECH_AUDIO_INVALID" || status === 400) {
    return { stop: true, message: "The speech engine could not read the recording, so live voice is off." };
  }
  if (code === "SPEECH_TRANSCRIBE_FAILED" || status === 503) {
    return { stop: true, message: "The speech engine failed to turn that into text, so live voice is off." };
  }
  if (code === "SPEECH_RESPONSE_UNREADABLE") {
    return { stop: true, message: "The speech engine answered with something unreadable, so live voice is off." };
  }
  if (!error?.response) {
    return { stop: true, message: "The voice service on this laptop did not answer, so live voice is off." };
  }
  return { stop: true, message: `Speech to text failed${Number.isFinite(status) ? ` (HTTP ${status})` : ""}, so live voice is off.` };
};

const ANSWER_FAILED_SPOKEN = "I could not answer that. The reason is on the screen.";

/**
 * What to say aloud for one answered question, from the entry `askAiAssistant` stored.
 *
 * Built through the same `buildFrostConversation` → `latestSpokenTurn` → `resolveSpeechPlan` chain
 * as the Speak button, so the live path cannot speak anything the button would refuse to.
 */
export const spokenAnswerFor = (entry, { synthesis = null, utterance = null } = {}) => {
  if (!entry) return "";
  if (entry.failureMessage) return ANSWER_FAILED_SPOKEN;
  const turn = latestSpokenTurn(buildFrostConversation({ history: [entry] }));
  const plan = resolveSpeechPlan({ turn, synthesis, utterance, loading: false });
  return speechWithNotice(plan, turn);
};


/**
 * The microphone, the detector, transcription, the question and the spoken answer, in one loop.
 *
 * Everything with a side effect is passed in:
 *   mediaDevices      navigator.mediaDevices
 *   AudioContextImpl  window.AudioContext
 *   synthesis         window.speechSynthesis
 *   Utterance         window.SpeechSynthesisUtterance
 *   transcribe(wav)   resolves to the gateway's JSON `{ text, engine? }`; rejects axios-shaped
 *   ask(question)     resolves to the history entry the typed path stored (or null)
 *   isBusy()          true while a typed question is in flight
 *   isAllowed()       false for anybody but the Owner or an Admin: start() and prime() refuse, and a
 *                     running session stops on its next tick
 *   onWake({reason})  awaited before a question is asked, and after "Frost" alone, so the App can
 *                     pop the FROST drawer open on the conversation first
 *   onLevel(level)    0..1 for every microphone frame, and 0 when the microphone closes
 *   now()             milliseconds
 *   onChange(view)    `{ on, phase, message, tone, heard, engine }`
 *
 * And the controller's own methods:
 *   prime()           call synchronously inside the click that turns voice on, before any await:
 *                     creates and resumes the AudioContext while the gesture still counts
 *   discardPrimed()   closes a primed context start() will not use (voice not set up, etc.)
 *   start({ idleLimitMs })  `idleLimitMs: null` means no idle switch-off (always listening)
 *   setIdleLimit(ms)  the same, on a running session
 *   resume()          call from a gesture: resumes a suspended context and re-arms the watchdog
 *   note(message, tone)  a line while off, e.g. why it did not start
 *   stop(reason, message)
 *
 * `stop(reason)` is idempotent and always releases the microphone: tracks stopped, processor
 * detached, AudioContext closed. It is safe to call while `start()` is still awaiting permission --
 * the stream that arrives afterwards is stopped immediately.
 */
export const createLiveVoiceController = ({
  mediaDevices = null,
  AudioContextImpl = null,
  synthesis = null,
  Utterance = null,
  transcribe,
  ask,
  isBusy = () => false,
  isAllowed = () => true,
  onWake = null,
  onLevel = null,
  now = () => Date.now(),
  timers = globalThis,
  onChange = () => {},
  detectorOptions = {},
  idleLimitMs = LIVE_VOICE_IDLE_LIMIT_MS,
  followUpMs = LIVE_VOICE_FOLLOW_UP_MS,
  bufferSize = 4096,
  postSpeechGuardMs = 300,
  noFramesMs = LIVE_VOICE_NO_FRAMES_MS,
  heardMs = LIVE_VOICE_HEARD_MS,
  slowTranscribeMs = LIVE_VOICE_TRANSCRIBE_SLOW_MS,
  tickMs = 500,
} = {}) => {
  let view = { on: false, phase: "off", message: "", tone: "info", heard: "", engine: null };
  let session = null;
  let primed = null;
  let idleLimit = idleLimitMs;
  // Whether the speech engine has answered once in this app's life. Until it has, the first
  // transcription is expected to be slow (the gateway is loading the model) and says so.
  let engineWarm = false;

  const emit = (patch) => {
    const next = { ...view, ...patch };
    if (Object.keys(next).every((key) => next[key] === view[key])) return;
    view = next;
    onChange(view);
  };

  // A permission check that throws is a refusal, not a crash with the microphone open.
  const allowed = () => {
    try { return isAllowed() === true; } catch { return false; }
  };

  const publishLevel = (level) => {
    if (typeof onLevel !== "function") return;
    try { onLevel(level); } catch { /* a broken meter must not stop the microphone loop */ }
  };

  const closeContext = (context) => {
    if (!context) return;
    try { context.onstatechange = null; } catch { /* read-only in some fakes */ }
    if (context.state === "closed") return;
    try { Promise.resolve(context.close()).catch(() => null); } catch { /* already closing */ }
  };

  // Not awaited. Called inside a gesture it takes effect; called outside one it may wait for ever,
  // and nothing here waits with it -- the phase says "paused" and the App resumes on the next click.
  const resumeContext = (context) => {
    if (!context || context.state !== "suspended" || typeof context.resume !== "function") return;
    try { Promise.resolve(context.resume()).catch(() => null); } catch { /* the phase says paused */ }
  };

  const discardPrimed = () => {
    const context = primed;
    primed = null;
    closeContext(context);
  };

  const prime = () => {
    if (session) return true;
    if (primed) {
      resumeContext(primed);
      return true;
    }
    if (!allowed() || typeof AudioContextImpl !== "function") return false;
    try {
      primed = new AudioContextImpl();
    } catch {
      primed = null;
      return false;
    }
    resumeContext(primed);
    return true;
  };

  const release = (current) => {
    if (!current) return;
    current.active = false;
    if (current.ticker) timers.clearInterval(current.ticker);
    current.ticker = null;
    if (current.processor) {
      current.processor.onaudioprocess = null;
      try { current.processor.disconnect(); } catch { /* already detached */ }
    }
    try { current.source?.disconnect(); } catch { /* already detached */ }
    try { current.sink?.disconnect(); } catch { /* already detached */ }
    if (current.stream) {
      for (const track of current.stream.getTracks?.() || []) {
        try { track.stop(); } catch { /* a track that cannot stop is already stopped */ }
      }
    }
    closeContext(current.context);
    if (current.speaking && synthesis) {
      try { synthesis.cancel(); } catch { /* nothing queued */ }
    }
    current.queue = [];
  };

  const stop = (reason = "switched_off", message = null) => {
    discardPrimed();
    const current = session;
    if (!current && !view.on) return false;
    session = null;
    release(current);
    publishLevel(0);
    const text = message || LIVE_VOICE_STOP_MESSAGES[reason] || LIVE_VOICE_STOP_MESSAGES.switched_off;
    const tone = reason === "switched_off" || reason === "idle" || reason === "drawer_closed"
      || reason === "signed_out" || reason === "unmounted" ? "info" : "error";
    emit({ on: false, phase: "off", message: text, tone, heard: "" });
    return true;
  };

  const note = (message, tone = "info") => {
    if (session) return false;
    emit({ on: false, phase: "off", message: String(message || ""), tone, heard: "" });
    return true;
  };

  const setIdleLimit = (ms) => {
    const wasOff = !Number.isFinite(idleLimit);
    idleLimit = ms;
    // Turning the idle limit back on starts its three minutes now, not from the last question.
    if (wasOff && Number.isFinite(ms) && session) session.lastQuestionAtMs = now();
  };

  /** Resolves true when the synthesiser read it (or was cut off by us), false when it failed. */
  const speak = (current, text) => new Promise((resolve) => {
    if (!text || !current.active) { resolve(true); return; }
    let settled = false;
    let guard = null;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      if (guard) timers.clearTimeout(guard);
      resolve(ok);
    };
    try {
      synthesis.cancel();
      const utterance = new Utterance(text);
      utterance.onend = () => done(true);
      // "interrupted" and "canceled" are this module or the Speak button cancelling, not a fault.
      utterance.onerror = (event) => done(event?.error === "interrupted" || event?.error === "canceled");
      // Chromium does not always fire `end` for a long utterance. Without this the loop would wait
      // for ever with every frame ignored -- a microphone that is on and hears nothing.
      guard = timers.setTimeout(() => done(true), Math.max(8000, text.length * 150));
      synthesis.speak(utterance);
    } catch {
      done(false);
    }
  });

  const phaseFor = (current) => {
    if (current.speaking) return "speaking";
    if (current.working) return current.working;
    if (current.stalled) return "no_sound";
    if (current.context?.state === "suspended") return "paused";
    return current.detector?.hearing ? "hearing" : "listening";
  };

  const refresh = (current, patch = {}) => {
    if (!current.active) return;
    emit({ on: true, phase: phaseFor(current), ...patch });
  };

  const showHeard = (current, line) => {
    if (!current.active) return;
    current.heardUntilMs = now() + heardMs;
    emit({ heard: line });
  };

  const reveal = async (reason) => {
    if (typeof onWake !== "function") return;
    try {
      await onWake({ reason });
    } catch {
      // The drawer failing to open must not lose the question: it is still asked and answered
      // aloud, and it is in the conversation the next time FROST is opened.
    }
  };

  const handleOne = async (current, item) => {
    current.working = "transcribing";
    current.transcribeStartedAtMs = now();
    current.slowNoted = false;
    refresh(current, engineWarm ? {} : { message: LIVE_VOICE_ENGINE_STARTING_MESSAGE, tone: "info" });
    let wav;
    try {
      wav = encodeWav16kMono(downsampleTo16k(item.samples, current.sampleRate));
    } catch (error) {
      // Not a transcription failure and not the gateway's fault: this microphone runs at a rate
      // the speech engine cannot be given. Said as that, not as "the voice service did not answer".
      const detail = String(error?.message || "").trim();
      stop("audio_failed", `The recording could not be prepared for the speech engine${detail ? ` (${detail})` : ""}, so live voice is off.`);
      return;
    }
    let text;
    try {
      const data = await transcribe(wav);
      if (!current.active) return;
      if (!data || typeof data.text !== "string") {
        const unreadable = { response: { status: 200, data: { code: "SPEECH_RESPONSE_UNREADABLE" } } };
        throw unreadable;
      }
      text = data.text;
      engineWarm = true;
      current.transcribeStartedAtMs = null;
      if (WORKING_MESSAGES.has(view.message)) emit({ message: "", tone: "info" });
      // Round 2's gateway says which engine did the work. "cli" is the slow fallback and the App
      // says so; a gateway from before round 2 sends nothing and nothing is said.
      if (typeof data.engine === "string" && data.engine) emit({ engine: data.engine });
    } catch (error) {
      current.transcribeStartedAtMs = null;
      if (!current.active) return;
      const failure = describeTranscribeFailure(error);
      if (failure.stop) {
        stop("transcribe_failed", failure.message);
        return;
      }
      current.working = null;
      refresh(current, { message: failure.message, tone: "error" });
      return;
    }
    const armedAt = Math.max(
      Number.isFinite(current.lastSpokeEndedAtMs) ? current.lastSpokeEndedAtMs : -Infinity,
      Number.isFinite(current.wakeHeardAtMs) ? current.wakeHeardAtMs : -Infinity,
    );
    const decision = questionFromTranscript(text, {
      lastSpokeEndedAtMs: Number.isFinite(armedAt) ? armedAt : null,
      nowMs: item.endedAtMs,
      followUpMs,
    });
    // Every time, question or not: what Whisper made of it is the only way to see a mishearing.
    showHeard(current, heardLineFor(text, decision.reason));
    if (!decision.ask) {
      current.working = null;
      if (decision.reason === "wake_only") {
        current.wakeHeardAtMs = item.endedAtMs;
        current.lastQuestionAtMs = now();
        await reveal("wake_only");
        if (!current.active) return;
        refresh(current, { message: "Go ahead, FROST is listening.", tone: "info" });
      } else {
        refresh(current);
      }
      return;
    }
    if (isBusy()) {
      current.working = null;
      refresh(current, { message: "FROST is still answering. Ask again in a moment.", tone: "info" });
      return;
    }
    current.wakeHeardAtMs = null;
    current.lastQuestionAtMs = now();
    await reveal(decision.reason);
    if (!current.active) return;
    current.working = "thinking";
    refresh(current, { message: "", tone: "info" });
    let entry;
    try {
      entry = await ask(decision.question);
    } catch {
      entry = { failureMessage: "FROST could not answer that." };
    }
    if (!current.active) return;
    current.working = null;
    const spoken = spokenAnswerFor(entry, { synthesis, utterance: Utterance });
    if (entry?.failureMessage) refresh(current, { message: entry.failureMessage, tone: "error" });
    if (spoken) {
      current.speaking = true;
      current.detector.reset();
      refresh(current);
      const spokenOk = await speak(current, spoken);
      current.speaking = false;
      current.detector.reset();
      if (!current.active) return;
      if (!spokenOk) refresh(current, { message: LIVE_VOICE_SPEAK_FAILED_MESSAGE, tone: "error" });
    }
    current.lastSpokeEndedAtMs = now();
    refresh(current);
  };

  const drain = async (current) => {
    if (current.draining) return;
    current.draining = true;
    try {
      while (current.active && current.queue.length) {
        const item = current.queue.shift();
        await handleOne(current, item);
      }
    } finally {
      current.draining = false;
    }
  };

  const onFrame = (current, frame) => {
    if (!current.active) return;
    // Before anything can return early: a frame arriving is what the watchdog and the meter watch,
    // whether or not FROST is speaking over it.
    current.lastFrameAtMs = now();
    publishLevel(levelFromRms(frameRms(frame)));
    if (current.stalled || STALL_MESSAGES.has(view.message)) {
      current.stalled = false;
      refresh(current, STALL_MESSAGES.has(view.message) ? { message: LIVE_VOICE_READY_HINT, tone: "info" } : {});
    }
    const externallySpeaking = Boolean(synthesis?.speaking) && !current.speaking;
    const guarded = Number.isFinite(current.lastSpokeEndedAtMs) && now() - current.lastSpokeEndedAtMs < postSpeechGuardMs;
    // FROST speaking into its own microphone would transcribe its own answer as the next question.
    if (current.speaking || externallySpeaking || guarded) {
      if (current.detector.state !== "idle") current.detector.reset();
      return;
    }
    const events = current.detector.push(frame);
    for (const event of events) {
      if (event.type === "utterance") {
        // One waiting at most, and the newest wins: a backlog would answer things said a minute ago.
        current.queue = [{ samples: event.samples, endedAtMs: now() }];
        drain(current);
      } else if (event.reason === "too_long") {
        refresh(current, { message: "That was longer than 20 seconds, so it was not sent. Ask a shorter question.", tone: "info" });
      } else if (event.reason === "too_loud") {
        refresh(current, { message: LIVE_VOICE_TOO_LOUD_MESSAGE, tone: "error" });
      }
    }
    refresh(current);
  };

  const onContextState = (current) => {
    if (!current.active || session !== current) return;
    const state = current.context?.state;
    if (state === "suspended") {
      refresh(current, { message: LIVE_VOICE_PAUSED_MESSAGE, tone: "attention" });
    } else if (state === "closed") {
      // Not by us: release() detaches this handler before it closes the context.
      stop("audio_failed", "Audio processing stopped on its own, so live voice is off.");
    } else {
      refresh(current);
    }
  };

  const tick = (current) => {
    if (!current.active || session !== current) return;
    if (!allowed()) {
      stop("not_permitted");
      return;
    }
    const at = now();
    if (Number.isFinite(idleLimit) && idleLimit > 0
      && liveVoiceIdle({ lastQuestionAtMs: current.lastQuestionAtMs, nowMs: at, limitMs: idleLimit })) {
      stop("idle");
      return;
    }
    if (view.heard && Number.isFinite(current.heardUntilMs) && at >= current.heardUntilMs) {
      current.heardUntilMs = null;
      emit({ heard: "" });
    }
    if (current.working === "transcribing" && !current.slowNoted && Number.isFinite(current.transcribeStartedAtMs)
      && at - current.transcribeStartedAtMs >= slowTranscribeMs && view.message !== LIVE_VOICE_ENGINE_STARTING_MESSAGE) {
      current.slowNoted = true;
      refresh(current, { message: LIVE_VOICE_TRANSCRIBE_SLOW_MESSAGE, tone: "info" });
    }
    // A context that was never given a gesture is waiting for one, and already says "Click
    // anywhere to start listening"; the watchdog would only repeat it in other words.
    const waitingForClick = current.context?.state === "suspended" && !current.primedByGesture && !current.resumeTried;
    const since = Number.isFinite(current.lastFrameAtMs) ? current.lastFrameAtMs : current.watchFromMs;
    if (!current.stalled && !waitingForClick && Number.isFinite(since) && at - since >= noFramesMs) {
      current.stalled = true;
      refresh(current, {
        message: current.resumeTried ? LIVE_VOICE_STILL_NO_SOUND_MESSAGE : LIVE_VOICE_NO_SOUND_MESSAGE,
        tone: "error",
      });
    }
  };

  const resume = () => {
    const current = session;
    if (!current?.active || !current.context) return false;
    const suspended = current.context.state === "suspended";
    if (!suspended && !current.stalled) return false;
    current.resumeTried = true;
    resumeContext(current.context);
    current.stalled = false;
    current.watchFromMs = now();
    current.lastFrameAtMs = null;
    refresh(current, { message: LIVE_VOICE_RESUMING_MESSAGE, tone: "info" });
    return true;
  };

  const start = async (options = {}) => {
    if (session) return view;
    if (options && Object.prototype.hasOwnProperty.call(options, "idleLimitMs")) idleLimit = options.idleLimitMs;
    if (!allowed()) {
      discardPrimed();
      emit({ on: false, phase: "off", message: LIVE_VOICE_STOP_MESSAGES.not_permitted, tone: "error", heard: "" });
      return view;
    }
    if (typeof mediaDevices?.getUserMedia !== "function" || typeof AudioContextImpl !== "function") {
      discardPrimed();
      emit({ on: false, phase: "off", message: LIVE_VOICE_STOP_MESSAGES.unsupported, tone: "error", heard: "" });
      return view;
    }
    if (!speechSupported(synthesis, Utterance)) {
      discardPrimed();
      emit({ on: false, phase: "off", message: LIVE_VOICE_STOP_MESSAGES.speech_unsupported, tone: "error", heard: "" });
      return view;
    }
    // Before the first await. WebView2 lets an AudioContext run only if it was created (or resumed)
    // inside a user gesture, and the permission wait below ends the gesture. Round 1 created it
    // after that wait: the context stayed suspended, no frame ever arrived, and the bar said
    // "Listening" to nothing.
    const primedByGesture = Boolean(primed);
    let context = primed;
    primed = null;
    if (!context) {
      try {
        context = new AudioContextImpl();
      } catch (error) {
        const detail = String(error?.message || error?.name || "").trim();
        emit({ on: false, phase: "off", message: `Audio processing could not start${detail ? ` (${detail})` : ""}, so live voice is off.`, tone: "error", heard: "" });
        return view;
      }
    }
    resumeContext(context);
    const current = {
      active: true,
      stream: null,
      context,
      primedByGesture,
      source: null,
      processor: null,
      sink: null,
      detector: null,
      sampleRate: 0,
      queue: [],
      draining: false,
      working: null,
      speaking: false,
      ticker: null,
      lastQuestionAtMs: now(),
      lastSpokeEndedAtMs: null,
      wakeHeardAtMs: null,
      lastFrameAtMs: null,
      watchFromMs: null,
      stalled: false,
      resumeTried: false,
      heardUntilMs: null,
      transcribeStartedAtMs: null,
      slowNoted: false,
    };
    session = current;
    emit({ on: true, phase: "starting", message: "", tone: "info", heard: "", engine: null });
    try {
      current.stream = await mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (error) {
      if (session === current) stop("microphone_failed", microphoneFailureMessage(error));
      else release(current);
      return view;
    }
    if (!current.active) {
      // Switched off (or the drawer closed) while Windows was asking for permission.
      release(current);
      return view;
    }
    // A microphone unplugged or taken by another program mid-session ends its track. Without this
    // the switch would stay on, listening to nothing. (A track we stop ourselves does not fire it.)
    for (const track of current.stream.getTracks?.() || []) {
      track.onended = () => {
        if (session === current) stop("microphone_lost", "The microphone stopped working, so live voice is off.");
      };
    }
    try {
      current.sampleRate = Number(context.sampleRate);
      current.detector = createUtteranceDetector({ ...detectorOptions, sampleRate: current.sampleRate });
      current.source = context.createMediaStreamSource(current.stream);
      current.processor = context.createScriptProcessor(bufferSize, 1, 1);
      // A ScriptProcessorNode only runs while connected to the destination. The zero gain keeps
      // the microphone out of the speakers.
      current.sink = context.createGain();
      current.sink.gain.value = 0;
      current.processor.onaudioprocess = (event) => onFrame(current, event.inputBuffer.getChannelData(0));
      current.source.connect(current.processor);
      current.processor.connect(current.sink);
      current.sink.connect(context.destination);
      context.onstatechange = () => onContextState(current);
    } catch (error) {
      const detail = String(error?.message || error?.name || "").trim();
      if (session === current) stop("audio_failed", `Audio processing could not start${detail ? ` (${detail})` : ""}, so live voice is off.`);
      else release(current);
      return view;
    }
    resumeContext(context);
    current.watchFromMs = now();
    current.ticker = timers.setInterval(() => tick(current), tickMs);
    if (context.state === "suspended") refresh(current, { message: LIVE_VOICE_PAUSED_MESSAGE, tone: "attention" });
    else refresh(current, { message: LIVE_VOICE_READY_HINT, tone: "info" });
    return view;
  };

  return {
    prime,
    discardPrimed,
    start,
    stop,
    resume,
    note,
    setIdleLimit,
    get view() { return view; },
    get active() { return Boolean(session?.active); },
  };
};
