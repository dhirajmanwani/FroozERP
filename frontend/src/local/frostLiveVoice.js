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
 * is a question only when it starts with the wake word ("Frost", "Hey Frost", "OK Frost"), or when it
 * comes within ten seconds of FROST finishing an answer (a follow-up). Everything else is
 * transcribed on the laptop and dropped: it is never sent to the question route and never shown.
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

export const DETECTOR_DEFAULTS = Object.freeze({
  // RMS of a float frame in [-1, 1]. With noise suppression on, a quiet room sits well under 0.005
  // and ordinary speech a foot or two from a laptop microphone is 0.02 to 0.2.
  startThreshold: 0.02,
  // Lower than the start threshold on purpose: the gap is the hysteresis that stops the tail of a
  // word, which is quieter than its start, from being counted as silence.
  stopThreshold: 0.01,
  silenceMs: 800,
  minMs: 400,
  maxMs: 20000,
  // Kept from before the start threshold was crossed, so the first consonant of "Frost" is not
  // clipped off -- whisper hears "rost" otherwise.
  preRollMs: 250,
  // Kept after the last loud frame, so the end of the last word is not clipped either.
  tailMs: 250,
  // A shop is not a quiet room. When the background is loud the thresholds follow it up, to a
  // ceiling, so a fan or a road does not read as one endless utterance.
  adaptive: true,
  noiseMultiplier: 3,
  maxStartThreshold: 0.15,
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
 *   `{ type: "discarded", reason: "too_short" | "too_long", durationMs }`.
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
    if (silenceRun >= silenceSamples) {
      clearUtterance();
      state = "idle";
    }
    return events;
  };

  const reset = () => {
    clearUtterance();
    preRoll = [];
    preRollTotal = 0;
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
// "Frost" as the first word, optionally after hey/hi/ok/okay. "Frosty" and "frosted" are not the
// wake word: \b after "frost" requires the word to end there.
// "Frost's" is a possessive in a sentence about something else, not somebody addressing FROST.
const WAKE = /^[\s"'“‘«(-]*(?:(?:hey|hi|ok|okay)\b[\s,.!-]*)?frost\b(?!['’]s\b)[\s,.:;!?-]*/i;

/**
 * Whether a transcript is a question for FROST, and the question it is.
 *
 * @returns {{ask: boolean, question: string, reason: "empty"|"wake_only"|"wake_word"|"follow_up"|"no_wake_word"}}
 *   `wake_only` means "Frost." on its own: nothing to ask yet, and the caller opens the follow-up
 *   window so the next utterance is taken as the question.
 */
export const questionFromTranscript = (text, { lastSpokeEndedAtMs = null, nowMs = null, followUpMs = LIVE_VOICE_FOLLOW_UP_MS } = {}) => {
  const cleaned = String(text ?? "").replace(MARKERS, " ").replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return { ask: false, question: "", reason: "empty" };
  const wake = WAKE.exec(cleaned);
  if (wake) {
    const question = cleaned.slice(wake[0].length).replace(/^[\s,.:;!?-]+/, "").trim();
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

export const LIVE_VOICE_PHASE_LABELS = Object.freeze({
  off: "Off",
  starting: "Opening the microphone",
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
 *   mediaDevices     navigator.mediaDevices
 *   AudioContextImpl window.AudioContext
 *   synthesis        window.speechSynthesis
 *   Utterance        window.SpeechSynthesisUtterance
 *   transcribe(wav)  resolves to the gateway's JSON `{ text }`; rejects axios-shaped
 *   ask(question)    resolves to the history entry the typed path stored (or null)
 *   isBusy()         true while a typed question is in flight
 *   now()            milliseconds
 *   onChange(view)   `{ on, phase, message, tone }`
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
  now = () => Date.now(),
  timers = globalThis,
  onChange = () => {},
  detectorOptions = {},
  idleLimitMs = LIVE_VOICE_IDLE_LIMIT_MS,
  followUpMs = LIVE_VOICE_FOLLOW_UP_MS,
  bufferSize = 4096,
  postSpeechGuardMs = 300,
  resumeTimeoutMs = 3000,
} = {}) => {
  let view = { on: false, phase: "off", message: "", tone: "info" };
  let session = null;

  const emit = (patch) => {
    const next = { ...view, ...patch };
    if (next.on === view.on && next.phase === view.phase && next.message === view.message && next.tone === view.tone) return;
    view = next;
    onChange(view);
  };

  const release = (current) => {
    if (!current) return;
    current.active = false;
    if (current.idleTimer) timers.clearInterval(current.idleTimer);
    current.idleTimer = null;
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
    if (current.context && current.context.state !== "closed") {
      try { Promise.resolve(current.context.close()).catch(() => null); } catch { /* already closing */ }
    }
    if (current.speaking && synthesis) {
      try { synthesis.cancel(); } catch { /* nothing queued */ }
    }
    current.queue = [];
  };

  const stop = (reason = "switched_off", message = null) => {
    const current = session;
    if (!current && !view.on) return false;
    session = null;
    release(current);
    const text = message || LIVE_VOICE_STOP_MESSAGES[reason] || LIVE_VOICE_STOP_MESSAGES.switched_off;
    const tone = reason === "switched_off" || reason === "idle" || reason === "drawer_closed"
      || reason === "signed_out" || reason === "unmounted" ? "info" : "error";
    emit({ on: false, phase: "off", message: text, tone });
    return true;
  };

  const speak = (current, text) => new Promise((resolve) => {
    if (!text || !current.active) { resolve(); return; }
    let settled = false;
    let guard = null;
    const done = () => {
      if (settled) return;
      settled = true;
      if (guard) timers.clearTimeout(guard);
      resolve();
    };
    try {
      synthesis.cancel();
      const utterance = new Utterance(text);
      utterance.onend = done;
      utterance.onerror = done;
      // Chromium does not always fire `end` for a long utterance. Without this the loop would wait
      // for ever with every frame ignored -- a microphone that is on and hears nothing.
      guard = timers.setTimeout(done, Math.max(8000, text.length * 150));
      synthesis.speak(utterance);
    } catch {
      done();
    }
  });

  const phaseFor = (current) => {
    if (current.speaking) return "speaking";
    if (current.working) return current.working;
    return current.detector.hearing ? "hearing" : "listening";
  };

  const refresh = (current, patch = {}) => {
    if (!current.active) return;
    emit({ on: true, phase: phaseFor(current), ...patch });
  };

  const handleOne = async (current, item) => {
    current.working = "transcribing";
    refresh(current);
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
    } catch (error) {
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
    if (!decision.ask) {
      current.working = null;
      if (decision.reason === "wake_only") {
        current.wakeHeardAtMs = item.endedAtMs;
        refresh(current, { message: "Go ahead, FROST is listening.", tone: "info" });
      } else if (decision.reason === "no_wake_word") {
        // Not shown word for word: what the counter says to customers is not FROST's business.
        refresh(current, { message: "Heard speech without \"Frost\" first, so it was ignored.", tone: "info" });
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
      await speak(current, spoken);
      current.speaking = false;
      current.detector.reset();
      if (!current.active) return;
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
      }
    }
    refresh(current);
  };

  const start = async () => {
    if (session) return view;
    if (typeof mediaDevices?.getUserMedia !== "function" || typeof AudioContextImpl !== "function") {
      emit({ on: false, phase: "off", message: LIVE_VOICE_STOP_MESSAGES.unsupported, tone: "error" });
      return view;
    }
    if (!speechSupported(synthesis, Utterance)) {
      emit({ on: false, phase: "off", message: LIVE_VOICE_STOP_MESSAGES.speech_unsupported, tone: "error" });
      return view;
    }
    const current = {
      active: true,
      stream: null,
      context: null,
      source: null,
      processor: null,
      sink: null,
      detector: null,
      sampleRate: 0,
      queue: [],
      draining: false,
      working: null,
      speaking: false,
      idleTimer: null,
      lastQuestionAtMs: now(),
      lastSpokeEndedAtMs: null,
      wakeHeardAtMs: null,
    };
    session = current;
    emit({ on: true, phase: "starting", message: "", tone: "info" });
    try {
      current.stream = await mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch (error) {
      if (session === current) stop("microphone_failed", microphoneFailureMessage(error));
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
      const context = new AudioContextImpl();
      current.context = context;
      if (context.state === "suspended" && typeof context.resume === "function") {
        // resume() can wait indefinitely for a user gesture the page never gets. Bounded, and a
        // context still paused afterwards is an error, not a switch that says Listening and hears nothing.
        let timer = null;
        await Promise.race([
          Promise.resolve(context.resume()).catch(() => null),
          new Promise((resolve) => { timer = timers.setTimeout(resolve, resumeTimeoutMs); }),
        ]);
        if (timer !== null) timers.clearTimeout(timer);
        if (context.state !== "running") throw new Error("audio stayed paused");
      }
      if (!current.active) { release(current); return view; }
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
    } catch (error) {
      const detail = String(error?.message || error?.name || "").trim();
      if (session === current) stop("audio_failed", `Audio processing could not start${detail ? ` (${detail})` : ""}, so live voice is off.`);
      else release(current);
      return view;
    }
    current.idleTimer = timers.setInterval(() => {
      if (!current.active) return;
      if (liveVoiceIdle({ lastQuestionAtMs: current.lastQuestionAtMs, nowMs: now(), limitMs: idleLimitMs })) {
        stop("idle");
      }
    }, 5000);
    refresh(current, { message: "Say \"Frost\" and then your question.", tone: "info" });
    return view;
  };

  return {
    start,
    stop,
    get view() { return view; },
    get active() { return Boolean(session?.active); },
  };
};
