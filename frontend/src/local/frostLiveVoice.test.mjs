import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DETECTOR_DEFAULTS,
  LIVE_VOICE_ALWAYS_ON_STORAGE_KEY,
  LIVE_VOICE_INSTALL_PATH,
  LIVE_VOICE_NO_SOUND_MESSAGE,
  LIVE_VOICE_PAUSED_MESSAGE,
  LIVE_VOICE_PHASE_LABELS,
  LIVE_VOICE_ENGINE_STARTING_MESSAGE,
  LIVE_VOICE_READY_HINT,
  LIVE_VOICE_TRANSCRIBE_SLOW_MESSAGE,
  LIVE_VOICE_RESUMING_MESSAGE,
  LIVE_VOICE_SPEAK_FAILED_MESSAGE,
  LIVE_VOICE_STATUS_PATH,
  LIVE_VOICE_STILL_NO_SOUND_MESSAGE,
  LIVE_VOICE_STOP_MESSAGES,
  LIVE_VOICE_TOO_LOUD_MESSAGE,
  LIVE_VOICE_TRANSCRIBE_PATH,
  SPEECH_SETUP_PROMPT,
  WAKE_WORD_VARIANTS,
  createLiveVoiceController,
  createUtteranceDetector,
  createVoiceLevelChannel,
  describeTranscribeFailure,
  downsampleTo16k,
  encodeWav16kMono,
  frameRms,
  heardLineFor,
  levelFromRms,
  liveVoiceIdle,
  liveVoiceIndicatorView,
  microphoneFailureMessage,
  questionFromTranscript,
  readAlwaysOnPreference,
  readMicrophonePreference,
  speechEngineNotice,
  speechSetupView,
  spokenAnswerFor,
  writeAlwaysOnPreference,
  writeMicrophonePreference,
  LIVE_VOICE_MICROPHONE_STORAGE_KEY,
  LIVE_VOICE_SILENT_MS,
  listMicrophones,
  microphoneOptions,
  silentMicrophoneMessage,
  rawRetryMessage,
  microphoneConstraints,
} from "./frostLiveVoice.js";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, "..");
const appSource = readFileSync(join(srcRoot, "App.jsx"), "utf8");
const moduleSource = readFileSync(join(here, "frostLiveVoice.js"), "utf8");
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------------------------------------------------------------------------------------
// Synthetic audio. 16 kHz and 100 ms frames keep the arithmetic readable: 1600 samples a frame.
// ---------------------------------------------------------------------------------------------
const RATE = 16000;
const FRAME = 1600;
const tone = (amplitude = 0.2, length = FRAME) => {
  const frame = new Float32Array(length);
  for (let index = 0; index < length; index += 1) frame[index] = amplitude * Math.sin((2 * Math.PI * 220 * index) / RATE);
  return frame;
};
const silence = (length = FRAME) => new Float32Array(length);
const feed = (detector, frames) => frames.flatMap((frame) => detector.push(frame));
const repeat = (count, make) => Array.from({ length: count }, () => make());
const fixed = { sampleRate: RATE, adaptive: false };

test("frame energy is RMS and ignores non-finite samples", () => {
  assert.equal(frameRms(silence()), 0);
  assert.ok(Math.abs(frameRms(tone(0.2)) - 0.2 / Math.SQRT2) < 0.001);
  assert.equal(frameRms(Float32Array.from([NaN, 0, 0, 0])), 0);
  assert.equal(frameRms(null), 0);
});

test("silence alone never produces an utterance", () => {
  const detector = createUtteranceDetector(fixed);
  assert.deepEqual(feed(detector, repeat(100, silence)), []);
  assert.equal(detector.state, "idle");
  assert.equal(detector.hearing, false);
});

test("speech followed by 800 ms of silence is one utterance, emitted on the 8th quiet frame and not before", () => {
  const detector = createUtteranceDetector(fixed);
  assert.deepEqual(feed(detector, repeat(5, silence)), []);
  assert.deepEqual(feed(detector, repeat(10, () => tone())), []);
  assert.equal(detector.hearing, true);
  assert.deepEqual(feed(detector, repeat(7, silence)), [], "700 ms of silence is still inside the utterance");
  const events = feed(detector, [silence()]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "utterance");
  assert.equal(events[0].durationMs, 1000);
  // 300 ms of pre-roll (three whole frames covering the 250 ms asked for) + 1 s of speech + 250 ms tail.
  assert.equal(events[0].samples.length, 3 * FRAME + 10 * FRAME + 4000);
  assert.equal(detector.state, "idle");
});

test("an utterance keeps the audio from just before the threshold, so the first sound is not clipped", () => {
  const detector = createUtteranceDetector(fixed);
  const quietStart = tone(0.005);
  feed(detector, [silence(), silence(), quietStart]);
  const [event] = feed(detector, [...repeat(6, () => tone()), ...repeat(8, silence)]);
  assert.equal(event.type, "utterance");
  const offset = 2 * FRAME;
  assert.ok(Math.abs(event.samples[offset + 10] - quietStart[10]) < 1e-7, "the quiet frame before speech is in the utterance");
});

test("too short: a click or a cough is discarded, not sent", () => {
  const detector = createUtteranceDetector(fixed);
  const events = feed(detector, [...repeat(3, () => tone()), ...repeat(8, silence)]);
  assert.deepEqual(events.map((event) => [event.type, event.reason]), [["discarded", "too_short"]]);
  assert.equal(events[0].samples, undefined);
});

test("the minimum is inclusive: exactly 400 ms is an utterance", () => {
  const detector = createUtteranceDetector(fixed);
  const events = feed(detector, [...repeat(4, () => tone()), ...repeat(8, silence)]);
  assert.equal(events[0].type, "utterance");
});

test("too long: past 20 s it is dropped, the tail is not sent as a new question, and detection recovers", () => {
  const detector = createUtteranceDetector(fixed);
  const events = feed(detector, repeat(201, () => tone()));
  assert.deepEqual(events.map((event) => event.reason), ["too_long"]);
  assert.equal(detector.state, "overflow");
  // More talking, then a pause: nothing, because this is the end of the speech that was too long.
  assert.deepEqual(feed(detector, [...repeat(20, () => tone()), ...repeat(8, silence)]), []);
  assert.equal(detector.state, "idle");
  const next = feed(detector, [...repeat(10, () => tone()), ...repeat(8, silence)]);
  assert.deepEqual(next.map((event) => event.type), ["utterance"]);
});

test("exactly 20 s of speech is still an utterance", () => {
  const detector = createUtteranceDetector(fixed);
  const events = feed(detector, [...repeat(200, () => tone()), ...repeat(8, silence)]);
  assert.deepEqual(events.map((event) => event.type), ["utterance"]);
  assert.equal(events[0].durationMs, 20000);
});

test("hangover: a pause shorter than 800 ms inside a sentence does not split it", () => {
  const detector = createUtteranceDetector(fixed);
  const events = feed(detector, [
    ...repeat(5, () => tone()),
    ...repeat(5, silence),
    ...repeat(5, () => tone()),
    ...repeat(8, silence),
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "utterance");
  assert.equal(events[0].durationMs, 1500);
});

test("hysteresis: a trailing word between the two thresholds keeps the utterance open", () => {
  const detector = createUtteranceDetector(fixed);
  // RMS of a 0.0085 sine is about 0.006: under the start threshold (0.008), over the stop one (0.004).
  const soft = () => tone(0.0085);
  assert.deepEqual(feed(detector, repeat(10, soft)), [], "too soft to start an utterance");
  assert.equal(detector.state, "idle");
  const events = feed(detector, [...repeat(3, () => tone()), ...repeat(7, soft), ...repeat(8, silence)]);
  assert.equal(events.length, 1);
  assert.equal(events[0].durationMs, 1000, "the soft frames count as speech once it has started");
});

test("frames are copied, so a reused capture buffer cannot rewrite an utterance", () => {
  const detector = createUtteranceDetector(fixed);
  const buffer = new Float32Array(FRAME);
  const events = [];
  for (let index = 0; index < 18; index += 1) {
    buffer.set(index < 10 ? tone(0.3) : silence());
    events.push(...detector.push(buffer));
  }
  assert.equal(events.length, 1);
  assert.ok(frameRms(events[0].samples.subarray(0, 10 * FRAME)) > 0.1, "the speech survived the buffer being zeroed");
});

test("adaptive: a loud steady background is learned, and stops reading as speech", () => {
  const detector = createUtteranceDetector({ sampleRate: RATE });
  const hum = () => tone(0.028); // RMS ~0.0198, well over the fixed start threshold (0.008)
  const events = feed(detector, repeat(300, hum));
  assert.deepEqual(events.map((event) => event.reason), ["too_long"], "the first 20 s are one overflow, not a stream of questions");
  assert.equal(detector.state, "idle", "after learning the hum it is quiet again");
  assert.deepEqual(feed(detector, repeat(100, hum)), []);
  assert.ok(detector.thresholds.start > 0.0198);
  assert.ok(detector.thresholds.start <= 0.06, "the adaptive start never climbs over its cap");
  // Somebody speaking over the hum is still heard.
  const speech = feed(detector, [...repeat(10, () => tone(0.4)), ...repeat(10, hum)]);
  assert.deepEqual(speech.map((event) => event.type), ["utterance"]);
});

test("adaptive: a background too loud for the capped threshold is reported once as too_loud, not left on Listening", () => {
  const detector = createUtteranceDetector({ sampleRate: RATE });
  const roar = () => tone(0.05); // RMS ~0.035: over the cap's stop threshold (0.06 * 0.5 = 0.03)
  const first = feed(detector, repeat(201, roar));
  assert.deepEqual(first.map((event) => event.reason), ["too_long"]);
  assert.equal(detector.state, "overflow");
  const next = feed(detector, repeat(200, roar));
  assert.deepEqual(next.map((event) => event.reason), ["too_loud"], "another whole 20 s without a pause is said");
  assert.deepEqual(feed(detector, repeat(400, roar)), [], "said once, not every frame");
  // Quiet again: it recovers.
  feed(detector, repeat(8, silence));
  assert.equal(detector.state, "idle");
});

test("round 2 thresholds: quiet laptop speech (RMS ~0.012) is heard now, and round 1's thresholds missed it", () => {
  assert.equal(DETECTOR_DEFAULTS.startThreshold, 0.008);
  assert.equal(DETECTOR_DEFAULTS.stopThreshold, 0.004);
  assert.equal(DETECTOR_DEFAULTS.noiseMultiplier, 2.5);
  assert.equal(DETECTOR_DEFAULTS.maxStartThreshold, 0.06);
  const quiet = () => tone(0.017); // RMS 0.0120
  assert.ok(Math.abs(frameRms(quiet()) - 0.012) < 0.0005);
  const room = () => tone(0.0028); // RMS ~0.002: a quiet room with noise suppression on
  const speech = [...repeat(20, room), ...repeat(10, quiet), ...repeat(8, room)];
  const now = createUtteranceDetector({ sampleRate: RATE });
  assert.deepEqual(feed(now, speech).map((event) => event.type), ["utterance"]);
  const round1 = createUtteranceDetector({ sampleRate: RATE, startThreshold: 0.02, stopThreshold: 0.01, noiseMultiplier: 3, maxStartThreshold: 0.15 });
  assert.deepEqual(feed(round1, speech), [], "the old start threshold never saw it begin");
});

test("the detector refuses a configuration it cannot honour", () => {
  assert.throws(() => createUtteranceDetector({}), RangeError);
  assert.throws(() => createUtteranceDetector({ sampleRate: RATE, startThreshold: 0.01, stopThreshold: 0.02 }), RangeError);
});

// ---------------------------------------------------------------------------------------------
// Resampling and WAV.
// ---------------------------------------------------------------------------------------------
test("48 kHz to 16 kHz averages each group of three", () => {
  const out = downsampleTo16k(Float32Array.from([1, 2, 3, 4, 5, 6, 7]), 48000);
  assert.deepEqual([...out], [2, 5]);
});

test("44.1 kHz to 16 kHz has the right length and preserves a steady level", () => {
  const input = new Float32Array(44100).fill(0.5);
  const out = downsampleTo16k(input, 44100);
  assert.equal(out.length, 16000);
  assert.ok(out.every((value) => Math.abs(value - 0.5) < 1e-6));
});

test("44.1 kHz averaging weights the fractional edges", () => {
  // ratio 2.75625: output 0 covers input [0, 2.75625) -> 1, 1, and 0.75625 of a 1 => 1.
  // output 1 covers [2.75625, 5.5125): 0.24375 of index 2 (1) + indices 3,4 (0) + 0.5125 of index 5 (0).
  const input = Float32Array.from([1, 1, 1, 0, 0, 0, 0, 0]);
  const out = downsampleTo16k(input, 44100);
  assert.ok(Math.abs(out[0] - 1) < 1e-6);
  assert.ok(Math.abs(out[1] - 0.24375 / 2.75625) < 1e-5);
});

test("16 kHz passes through as a copy, and upsampling is refused", () => {
  const input = Float32Array.from([0.1, 0.2]);
  const out = downsampleTo16k(input, 16000);
  assert.deepEqual([...out], [...input]);
  assert.notEqual(out, input);
  assert.throws(() => downsampleTo16k(input, 8000), RangeError);
  assert.throws(() => downsampleTo16k(input, NaN), RangeError);
});

test("WAV: a RIFF/WAVE PCM16 mono 16 kHz header, little-endian, with clamped samples", () => {
  const bytes = encodeWav16kMono(Float32Array.from([0, 1, -1, 2, -2, NaN, 0.5]));
  assert.ok(bytes instanceof Uint8Array);
  assert.equal(bytes.length, 44 + 7 * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  assert.equal(ascii(0, 4), "RIFF");
  assert.equal(view.getUint32(4, true), 36 + 14);
  assert.equal(ascii(8, 4), "WAVE");
  assert.equal(ascii(12, 4), "fmt ");
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1, "PCM");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000, "byte rate");
  assert.equal(view.getUint16(32, true), 2, "block align");
  assert.equal(view.getUint16(34, true), 16, "bits per sample");
  assert.equal(ascii(36, 4), "data");
  assert.equal(view.getUint32(40, true), 14);
  const samples = Array.from({ length: 7 }, (_, index) => view.getInt16(44 + index * 2, true));
  assert.deepEqual(samples, [0, 32767, -32768, 32767, -32768, 0, 16384]);
});

test("a 20 s utterance at 48 kHz fits the gateway's 1,000,000-byte limit", () => {
  const detectorMax = (20000 + 300 + 250) / 1000;
  const bytes = encodeWav16kMono(downsampleTo16k(new Float32Array(Math.ceil(detectorMax * 48000)), 48000));
  assert.ok(bytes.length <= 1000000, `${bytes.length} bytes`);
});

// ---------------------------------------------------------------------------------------------
// Which utterances are questions.
// ---------------------------------------------------------------------------------------------
test("the wake word opens a question and is stripped from it", () => {
  for (const [heard, question] of [
    ["Frost, what are today's sales?", "what are today's sales?"],
    ["frost. How much stock of apples is left?", "How much stock of apples is left?"],
    ["Hey Frost, who owes me money?", "who owes me money?"],
    ["Hey, Frost. Profit this month?", "Profit this month?"],
    ["OK Frost what did I sell yesterday", "what did I sell yesterday"],
    ["Okay, frost: pending bills", "pending bills"],
    ["  Frost - sales today", "sales today"],
    ["[BLANK_AUDIO] Frost, low stock?", "low stock?"],
  ]) {
    const decision = questionFromTranscript(heard);
    assert.equal(decision.ask, true, heard);
    assert.equal(decision.reason, "wake_word", heard);
    assert.equal(decision.question, question, heard);
  }
});

test("tolerant: every way Whisper writes an Indian-English 'Frost' is the wake word, with or without a greeting", () => {
  // The addendum's list, plus two of our own (forrest, frosts). Pinned so a variant cannot be
  // dropped, or a new one slipped in, without this test changing.
  assert.deepEqual([...WAKE_WORD_VARIANTS].sort(), [
    "forest", "forrest", "fraust", "frast", "fross", "frost", "frost's", "frosted", "frosts", "frosty", "froast", "frust", "prost",
  ].sort());
  for (const variant of [...WAKE_WORD_VARIANTS, "Frost’s", "FOREST", "Prost"]) {
    for (const lead of ["", "Hey ", "Hey, ", "hi ", "OK ", "Okay, ", "\"", "[BLANK_AUDIO] "]) {
      const heard = `${lead}${variant}, what are today's sales?`;
      const decision = questionFromTranscript(heard);
      assert.equal(decision.ask, true, heard);
      assert.equal(decision.reason, "wake_word", heard);
      assert.equal(decision.question, "what are today's sales?", heard);
    }
    assert.equal(questionFromTranscript(`${variant}.`).reason, "wake_only", variant);
  }
});

test("tolerant, not loose: ordinary words that start like Frost are not the wake word", () => {
  for (const heard of [
    "First give me the bill",
    "For how much?",
    "From tomorrow the rate changes",
    "Frozen peas are finished",
    "Fresh apples came today",
    "Fruit is on the second shelf",
    "Frost-free fridge is on sale",
    "Frostbite is not a fruit",
    "Forests are green",
    "Front counter please",
    "Froth on the milk",
    "Hey, first one please",
    "OK for now",
    "I told the frost guy to come tomorrow",
    "Give me two kilos of apples",
  ]) {
    const decision = questionFromTranscript(heard);
    assert.equal(decision.ask, false, heard);
    assert.equal(decision.reason, "no_wake_word", heard);
    assert.equal(decision.question, "");
  }
});

test("decided trade-off: a sentence that merely starts with a variant is taken as a question", () => {
  // Documented beside WAKE_WORD_VARIANTS. Kept visible here so the choice is not reversed by accident.
  assert.deepEqual(questionFromTranscript("Frosty the snowman"), { ask: true, question: "the snowman", reason: "wake_word" });
  assert.equal(questionFromTranscript("Frost's delivery is late").question, "delivery is late");
});

test("heard line: shown for every transcription, with the nudge when Frost was not said first", () => {
  assert.equal(heardLineFor("Frost, sales today?", "wake_word"), 'Heard: "Frost, sales today?"');
  assert.equal(heardLineFor("Give me two kilos of apples.", "no_wake_word"), 'Heard: "Give me two kilos of apples." — say Frost first');
  assert.equal(heardLineFor("  [BLANK_AUDIO]  ", "empty"), "Heard nothing clear. Say it again, a little closer to the microphone.");
  assert.equal(heardLineFor("", "no_wake_word"), "Heard nothing clear. Say it again, a little closer to the microphone.");
  assert.equal(heardLineFor("And (music) yesterday?", "follow_up"), 'Heard: "And yesterday?"');
  const long = heardLineFor("word ".repeat(100), "no_wake_word");
  assert.ok(long.length < 200, "a long transcript is shortened on screen");
  assert.match(long, /…" — say Frost first$/);
});

test("the wake word on its own is not a question, but says so", () => {
  for (const heard of ["Frost.", "Hey Frost?", "frost", "OK Frost..."]) {
    assert.deepEqual(questionFromTranscript(heard), { ask: false, question: "", reason: "wake_only" }, heard);
  }
});

test("empty and marker-only transcripts ask nothing", () => {
  for (const heard of ["", "   ", "[BLANK_AUDIO]", "(music)", "[Music] (applause)", "*coughs*", "...", null, undefined]) {
    assert.deepEqual(questionFromTranscript(heard), { ask: false, question: "", reason: "empty" }, String(heard));
  }
  // Even inside the follow-up window.
  assert.equal(questionFromTranscript("[BLANK_AUDIO]", { lastSpokeEndedAtMs: 1000, nowMs: 2000 }).ask, false);
});

test("within 10 s of FROST finishing, anything said is a follow-up; after, it is not", () => {
  const spoke = 50_000;
  const inside = questionFromTranscript("And yesterday?", { lastSpokeEndedAtMs: spoke, nowMs: spoke + 4000 });
  assert.deepEqual(inside, { ask: true, question: "And yesterday?", reason: "follow_up" });
  assert.equal(questionFromTranscript("And yesterday?", { lastSpokeEndedAtMs: spoke, nowMs: spoke + 10000 }).ask, true, "10 s is inside");
  assert.equal(questionFromTranscript("And yesterday?", { lastSpokeEndedAtMs: spoke, nowMs: spoke + 10001 }).ask, false);
  assert.equal(questionFromTranscript("And yesterday?", { lastSpokeEndedAtMs: spoke, nowMs: spoke - 1 }).ask, false, "said before FROST finished");
  assert.equal(questionFromTranscript("And yesterday?", { lastSpokeEndedAtMs: null, nowMs: spoke }).ask, false, "FROST has not spoken");
  assert.equal(questionFromTranscript("And yesterday?", { lastSpokeEndedAtMs: spoke, nowMs: NaN }).ask, false);
  assert.equal(questionFromTranscript("And yesterday?", { lastSpokeEndedAtMs: spoke, nowMs: spoke + 20000, followUpMs: 30000 }).ask, true);
  // A wake word inside the window still has the wake word stripped.
  assert.equal(questionFromTranscript("Frost, and last week?", { lastSpokeEndedAtMs: spoke, nowMs: spoke + 1000 }).question, "and last week?");
});

test("idle: live voice turns off at 3 minutes without a question, and on an unreadable clock", () => {
  assert.equal(liveVoiceIdle({ lastQuestionAtMs: 0, nowMs: 179999 }), false);
  assert.equal(liveVoiceIdle({ lastQuestionAtMs: 0, nowMs: 180000 }), true);
  assert.equal(liveVoiceIdle({ lastQuestionAtMs: 1000, nowMs: 5000, limitMs: 3000 }), true);
  assert.equal(liveVoiceIdle({ lastQuestionAtMs: null, nowMs: 1 }), true);
  assert.equal(liveVoiceIdle({ lastQuestionAtMs: 0, nowMs: NaN }), true);
  assert.equal(liveVoiceIdle(), true);
});

// ---------------------------------------------------------------------------------------------
// Setup card.
// ---------------------------------------------------------------------------------------------
const status = (state, extra = {}) => ({
  state,
  model: state === "ready" ? "small" : null,
  progress: { phase: null, received_bytes: 0, total_bytes: 0 },
  error: null,
  internet_allowed: true,
  ...extra,
});

test("setup: not installed offers the one-time download with the promised wording", () => {
  const view = speechSetupView(status("not_installed"));
  assert.equal(view.kind, "not_installed");
  assert.equal(view.ready, false);
  assert.equal(view.action, "download");
  assert.equal(view.text, SPEECH_SETUP_PROMPT);
  assert.match(view.text, /470 MB/);
  assert.match(view.text, /stays on this laptop/);
});

test("setup: in LOCAL_ONLY the download is refused in words and not offered", () => {
  const notAllowed = speechSetupView(status("not_installed", { internet_allowed: false }));
  assert.equal(notAllowed.kind, "blocked");
  assert.equal(notAllowed.action, null);
  assert.equal(notAllowed.ready, false);
  assert.match(notAllowed.detail, /Local Only/);
  const refused = speechSetupView(status("not_installed"), { stage: "install", status: 403, code: "SPEECH_INSTALL_BLOCKED_LOCAL_ONLY" });
  assert.equal(refused.kind, "blocked");
  assert.equal(refused.action, null);
  assert.match(refused.text, /Local Only.*Nothing was downloaded/);
});

test("setup: installing shows the phase and a percentage, or bytes when the size is unknown", () => {
  const model = speechSetupView(status("installing", { progress: { phase: "model", received_bytes: 42, total_bytes: 100 } }));
  assert.equal(model.kind, "installing");
  assert.equal(model.percent, 42);
  assert.match(model.text, /speech model: 42%/);
  assert.equal(model.ready, false);
  const engine = speechSetupView(status("installing", { progress: { phase: "engine", received_bytes: 5 * 1024 * 1024, total_bytes: 0 } }));
  assert.equal(engine.percent, null);
  assert.match(engine.text, /speech engine/);
  assert.match(engine.detail, /5 MB so far/);
  const verifying = speechSetupView(status("installing", { progress: { phase: "verifying", received_bytes: 10, total_bytes: 10 } }));
  assert.match(verifying.text, /Checking the download: 100%/);
  const overshoot = speechSetupView(status("installing", { progress: { phase: "model", received_bytes: 150, total_bytes: 100 } }));
  assert.equal(overshoot.percent, 100);
});

test("setup: ready is the only state that says ready", () => {
  const view = speechSetupView(status("ready"));
  assert.equal(view.kind, "ready");
  assert.equal(view.ready, true);
  assert.equal(view.action, null);
});

test("setup: a failed install is a failure with its reason, and can be retried when allowed", () => {
  const failed = speechSetupView(status("failed", { error: "Model hash did not match." }));
  assert.equal(failed.kind, "failed");
  assert.equal(failed.ready, false);
  assert.equal(failed.tone, "error");
  assert.equal(failed.action, "retry");
  assert.match(failed.text, /Voice setup failed: Model hash did not match\./);
  const failedLocalOnly = speechSetupView(status("failed", { error: "x", internet_allowed: false }));
  assert.equal(failedLocalOnly.action, null);
  assert.match(failedLocalOnly.detail, /Local Only/);
  const noReason = speechSetupView(status("failed"));
  assert.match(noReason.text, /no reason was given/);
});

test("setup: an unreadable status is an error, never 'not installed' and never 'ready'", () => {
  for (const body of [{}, { state: "READY" }, { state: "weird" }, "ok", 42, []]) {
    const view = speechSetupView(body);
    assert.equal(view.kind, "unreadable", JSON.stringify(body));
    assert.equal(view.ready, false);
    assert.equal(view.action, "retry");
    assert.equal(view.tone, "error");
  }
  const unreachable = speechSetupView(null, { stage: "status", status: null, message: "the voice service on this laptop did not answer" });
  assert.equal(unreachable.kind, "unreadable");
  assert.match(unreachable.text, /could not be checked: the voice service on this laptop did not answer/);
  // A stale "ready" underneath a failed read is still a failed read.
  assert.equal(speechSetupView(status("ready"), { stage: "status", message: "timeout" }).ready, false);
});

test("setup: install refusals each read differently", () => {
  const busy = speechSetupView(status("not_installed"), { stage: "install", status: 409, code: "SPEECH_INSTALL_IN_PROGRESS" });
  assert.equal(busy.kind, "installing");
  const unknown = speechSetupView(status("not_installed"), { stage: "install", status: 400, code: "SPEECH_MODEL_UNKNOWN" });
  assert.equal(unknown.kind, "failed");
  assert.match(unknown.text, /speech model/);
  const network = speechSetupView(status("not_installed"), { stage: "install", message: "the voice service on this laptop did not answer" });
  assert.equal(network.kind, "failed");
  assert.match(network.text, /could not start: the voice service/);
  // Once the gateway reports the download running, its progress wins over the stale refusal.
  const running = speechSetupView(status("installing", { progress: { phase: "model", received_bytes: 1, total_bytes: 4 } }), { stage: "install", code: "SPEECH_INSTALL_IN_PROGRESS" });
  assert.equal(running.percent, 25);
});

test("setup: before the first read it says it is checking, not ready and not missing", () => {
  const view = speechSetupView(null, null);
  assert.equal(view.kind, "checking");
  assert.equal(view.ready, false);
  assert.equal(view.action, null);
});

test("setup: every non-ready view has text and is not ready", () => {
  const views = [
    speechSetupView(null),
    speechSetupView(status("not_installed")),
    speechSetupView(status("not_installed", { internet_allowed: false })),
    speechSetupView(status("installing")),
    speechSetupView(status("failed")),
    speechSetupView({ state: "?" }),
    speechSetupView(null, { stage: "status" }),
    speechSetupView(null, { stage: "install", code: "SPEECH_INSTALL_BLOCKED_LOCAL_ONLY" }),
  ];
  for (const view of views) {
    assert.equal(view.ready, false, view.kind);
    assert.ok(view.text.length > 10, view.kind);
  }
});

// ---------------------------------------------------------------------------------------------
// Failure wording.
// ---------------------------------------------------------------------------------------------
test("microphone failures each say what happened", () => {
  const refused = microphoneFailureMessage({ name: "NotAllowedError" });
  const missing = microphoneFailureMessage({ name: "NotFoundError" });
  const busy = microphoneFailureMessage({ name: "NotReadableError" });
  const other = microphoneFailureMessage({ name: "TypeError", message: "boom" });
  assert.match(refused, /permission was refused/);
  assert.match(missing, /No microphone/);
  assert.match(busy, /busy/);
  assert.match(other, /boom/);
  assert.equal(new Set([refused, missing, busy, other]).size, 4);
});

test("transcription failures are distinct, and only 'busy' and a slow answer keep the microphone open", () => {
  const cases = [
    [{ response: { status: 409, data: { code: "SPEECH_NOT_INSTALLED" } } }, true],
    [{ response: { status: 400, data: { code: "SPEECH_AUDIO_INVALID" } } }, true],
    [{ response: { status: 503, data: { code: "SPEECH_TRANSCRIBE_FAILED" } } }, true],
    [{ response: { status: 429, data: { code: "SPEECH_BUSY" } } }, false],
    [{ message: "Network Error" }, true],
    [{ response: { status: 500, data: {} } }, true],
    [{ code: "ECONNABORTED", message: "timeout of 120000ms exceeded" }, false],
  ];
  const messages = cases.map(([error, stops]) => {
    const failure = describeTranscribeFailure(error);
    assert.equal(failure.stop, stops, JSON.stringify(error));
    assert.ok(failure.message.length > 20);
    return failure.message;
  });
  assert.equal(new Set(messages).size, messages.length, "no two failures read the same");
  assert.match(messages[5], /HTTP 500/);
  assert.match(messages[4], /did not answer \(Network Error\)/, "what the browser said is on the screen");
  assert.match(messages[6], /took too long/);
});

test("the app waits longer for a transcription than the gateway can possibly take", () => {
  // 24 Sep 2026: the app gave up at 70 s while the gateway's worst case (server start, request,
  // whisper-cli fallback) was 90 s, and the owner saw "did not answer" on the first question.
  const require = createRequire(import.meta.url);
  const speech = require("../../../backend/localSpeech.js");
  const gatewayWorstMs = speech.SERVER_START_TIMEOUT_MS + 2 * speech.TRANSCRIBE_TIMEOUT_MS;
  const match = appSource.match(/\/api\/local\/speech\/transcribe`, wavBytes, \{[\s\S]*?timeout: (\d+),/);
  assert.ok(match, "the transcribe call sets its own timeout");
  assert.ok(Number(match[1]) >= gatewayWorstMs + 15000, `${match[1]} ms must clear the gateway's ${gatewayWorstMs} ms with room to spare`);
});

test("the spoken answer goes through the same speech plan as the Speak button", () => {
  const synthesis = { speak() {}, cancel() {} };
  function utterance() {}
  const spoken = spokenAnswerFor({ question: "sales?", answer: "Sales today are Rs 42,300.00.", notice: "Worded by FROST.", facts: [] }, { synthesis, utterance });
  assert.equal(spoken, "Sales today are Rs 42,300.00. Worded by FROST.");
  assert.equal(spokenAnswerFor({ question: "sales?", failureMessage: "offline" }, { synthesis, utterance }), "I could not answer that. The reason is on the screen.");
  assert.equal(spokenAnswerFor(null, { synthesis, utterance }), "");
  assert.equal(spokenAnswerFor({ answer: "x" }, { synthesis: null, utterance: null }), "", "no synthesiser, nothing spoken");
});

// ---------------------------------------------------------------------------------------------
// The controller, with a fake microphone, AudioContext and synthesiser.
// ---------------------------------------------------------------------------------------------
const settle = async (rounds = 6) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

const makeRig = ({
  transcribeResult = () => ({ text: "Frost, what are today's sales?" }),
  askResult = (question) => ({ question, answer: "Sales today are Rs 42,300.00.", facts: [] }),
  micError = null,
  holdMic = false,
  holdSpeech = false,
  speechSupportedHere = true,
  suspended = false,
  resumes = true,
  sampleRate = RATE,
  speakThrows = false,
  speechError = null,
  allowed = () => true,
  onWake = null,
  micLabel = "Headset (Boat Rockerz 255)",
  micDeviceId = "mic-headset",
  micMuted = false,
} = {}) => {
  const rig = {
    log: [],
    levels: [],
    timeouts: [],
    wakes: [],
    clock: 1_000_000,
    tracks: [],
    contexts: [],
    constraints: null,
    transcribed: [],
    asked: [],
    spoken: [],
    views: [],
    intervals: [],
    busy: false,
    releaseMic: null,
    finishSpeech: null,
  };
  const track = () => {
    const item = {
      stopped: false,
      label: micLabel,
      muted: micMuted,
      stop() { item.stopped = true; },
      getSettings: () => ({ deviceId: micDeviceId }),
    };
    rig.tracks.push(item);
    return item;
  };
  const stream = () => {
    const tracks = [track()];
    return { getTracks: () => tracks };
  };
  rig.mediaDevices = {
    getUserMedia(constraints) {
      rig.constraints = constraints;
      rig.log.push("getUserMedia");
      if (micError) return Promise.reject(micError);
      if (holdMic) return new Promise((resolve) => { rig.releaseMic = () => resolve(stream()); });
      return Promise.resolve(stream());
    },
  };
  class FakeAudioContext {
    constructor() {
      this.sampleRate = sampleRate;
      this.state = suspended ? "suspended" : "running";
      this.destination = { kind: "destination" };
      this.processor = null;
      this.onstatechange = null;
      this.resumeCalls = 0;
      rig.contexts.push(this);
      rig.log.push("new AudioContext");
    }
    createMediaStreamSource(input) { return { input, connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      const node = { onaudioprocess: null, connected: false, connect() { node.connected = true; }, disconnect() { node.connected = false; } };
      this.processor = node;
      return node;
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    resume() {
      this.resumeCalls += 1;
      rig.log.push("resume");
      if (resumes || rig.resumesNow) { this.state = "running"; this.onstatechange?.(); return Promise.resolve(); }
      return new Promise(() => {});
    }
    close() { this.state = "closed"; this.onstatechange?.(); return Promise.resolve(); }
  }
  rig.synthesis = {
    speaking: false,
    cancelled: 0,
    cancel() { rig.synthesis.cancelled += 1; rig.synthesis.speaking = false; },
    speak(utterance) {
      if (speakThrows) throw new Error("no voices");
      rig.spoken.push(utterance.text);
      rig.synthesis.speaking = true;
      const end = () => {
        rig.synthesis.speaking = false;
        if (speechError) utterance.onerror?.({ error: speechError });
        else utterance.onend?.();
      };
      if (holdSpeech) rig.finishSpeech = end;
      else setImmediate(end);
    },
  };
  function Utterance(text) { this.text = text; }
  rig.timers = {
    setInterval(fn) { rig.intervals.push(fn); return rig.intervals.length; },
    clearInterval() {},
    // Held, not run: the only timeout left is the speech guard, and a real one firing under a
    // loaded test run would end "speaking" before the test looked at it.
    setTimeout(fn, ms) { rig.timeouts.push({ fn, ms }); return rig.timeouts.length; },
    clearTimeout() {},
  };
  rig.controller = createLiveVoiceController({
    mediaDevices: rig.mediaDevices,
    AudioContextImpl: FakeAudioContext,
    synthesis: speechSupportedHere ? rig.synthesis : null,
    Utterance: speechSupportedHere ? Utterance : null,
    transcribe: async (wav) => {
      rig.transcribed.push(wav);
      return transcribeResult(wav);
    },
    ask: async (question) => {
      rig.asked.push(question);
      rig.log.push(`ask:${question}`);
      return askResult(question);
    },
    isBusy: () => rig.busy,
    isAllowed: () => allowed(),
    onWake: async (wake) => {
      rig.wakes.push(wake.reason);
      rig.log.push(`wake:${wake.reason}`);
      if (onWake) await onWake(wake);
    },
    onLevel: (level) => rig.levels.push(level),
    now: () => rig.clock,
    timers: rig.timers,
    onChange: (view) => rig.views.push(view),
    detectorOptions: { adaptive: false },
  });
  rig.frame = (frame) => {
    const context = rig.contexts.at(-1);
    context.processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame } });
    rig.clock += 100;
  };
  rig.say = () => {
    for (let index = 0; index < 10; index += 1) rig.frame(tone());
    for (let index = 0; index < 8; index += 1) rig.frame(silence());
  };
  rig.tick = () => rig.intervals.at(-1)();
  return rig;
};

test("controller: turning on opens the microphone with echo cancellation and noise suppression", async () => {
  const rig = makeRig();
  await rig.controller.start();
  assert.deepEqual(rig.constraints, { audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
  assert.equal(rig.controller.view.on, true);
  assert.equal(rig.controller.view.phase, "listening");
  assert.equal(rig.contexts[0].processor.connected, true);
});

test("controller: switching off stops every track, detaches the processor and closes the AudioContext", async () => {
  const rig = makeRig();
  await rig.controller.start();
  const processor = rig.contexts[0].processor;
  assert.equal(rig.controller.stop("switched_off"), true);
  assert.ok(rig.tracks.length > 0);
  assert.ok(rig.tracks.every((item) => item.stopped), "the microphone is released");
  assert.equal(rig.contexts[0].state, "closed");
  assert.equal(processor.onaudioprocess, null);
  assert.equal(rig.controller.view.on, false);
  assert.equal(rig.controller.view.message, LIVE_VOICE_STOP_MESSAGES.switched_off);
  assert.equal(rig.controller.stop("switched_off"), false, "a second stop is a no-op");
});

test("controller: a question with the wake word is transcribed locally, asked, and the answer spoken", async () => {
  const rig = makeRig();
  await rig.controller.start();
  rig.say();
  await settle();
  assert.equal(rig.transcribed.length, 1);
  const wav = rig.transcribed[0];
  assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
  assert.deepEqual(rig.asked, ["what are today's sales?"]);
  assert.deepEqual(rig.spoken, ["Sales today are Rs 42,300.00."]);
  assert.ok(rig.views.some((view) => view.phase === "hearing"));
  assert.ok(rig.views.some((view) => view.phase === "transcribing"));
  assert.ok(rig.views.some((view) => view.phase === "thinking"));
  assert.ok(rig.views.some((view) => view.phase === "speaking"));
  assert.equal(rig.controller.view.phase, "listening");
});

test("controller: speech without the wake word is never asked, but what was heard is shown for ~6 s", async () => {
  const rig = makeRig({ transcribeResult: () => ({ text: "Give me two kilos of apples." }) });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.equal(rig.transcribed.length, 1);
  assert.deepEqual(rig.asked, [], "nothing is sent to the question route");
  assert.deepEqual(rig.wakes, [], "and the drawer is not popped");
  // Round 1 hid this line; round 2 shows it, on this screen only, so a mis-heard "Frost" is visible.
  assert.equal(rig.controller.view.heard, 'Heard: "Give me two kilos of apples." — say Frost first');
  rig.clock += 5_000;
  rig.tick();
  assert.notEqual(rig.controller.view.heard, "", "still shown at 5 s");
  rig.clock += 1_000;
  rig.tick();
  assert.equal(rig.controller.view.heard, "", "gone after ~6 s");
});

test("controller: a question's heard text is shown too, and an empty transcript says it heard nothing clear", async () => {
  const replies = ["Frost, what are today's sales?", "[BLANK_AUDIO]"];
  const rig = makeRig({ transcribeResult: () => ({ text: replies.shift() }) });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.ok(rig.views.some((view) => view.heard === 'Heard: "Frost, what are today\'s sales?"'));
  rig.clock += 20_000;
  rig.say();
  await settle();
  assert.match(rig.controller.view.heard, /Heard nothing clear/);
  assert.deepEqual(rig.asked, ["what are today's sales?"]);
});

test("controller: after FROST speaks, a follow-up needs no wake word", async () => {
  let reply = "Frost, what are today's sales?";
  const rig = makeRig({ transcribeResult: () => ({ text: reply }) });
  await rig.controller.start();
  rig.say();
  await settle();
  reply = "And yesterday?";
  rig.clock += 2000;
  rig.say();
  await settle();
  assert.deepEqual(rig.asked, ["what are today's sales?", "And yesterday?"]);
});

test("controller: 'Frost.' on its own opens the window for the next thing said", async () => {
  const replies = ["Frost.", "How much did I sell today?"];
  const rig = makeRig({ transcribeResult: () => ({ text: replies.shift() }) });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.deepEqual(rig.asked, []);
  assert.match(rig.controller.view.message, /Go ahead/);
  rig.say();
  await settle();
  assert.deepEqual(rig.asked, ["How much did I sell today?"]);
});

test("controller: while FROST is speaking the microphone is ignored", async () => {
  const rig = makeRig({ holdSpeech: true });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.equal(rig.controller.view.phase, "speaking");
  rig.say();
  rig.say();
  await settle();
  assert.equal(rig.transcribed.length, 1, "FROST's own voice was not transcribed");
  rig.finishSpeech();
  await settle();
  assert.equal(rig.controller.view.phase, "listening");
});

test("controller: a question while a typed one is in flight is not sent", async () => {
  const rig = makeRig();
  rig.busy = true;
  await rig.controller.start();
  rig.say();
  await settle();
  assert.deepEqual(rig.asked, []);
  assert.match(rig.controller.view.message, /still answering/);
});

test("controller: a refused microphone is an error in words, and nothing else starts", async () => {
  const rig = makeRig({ micError: Object.assign(new Error("denied"), { name: "NotAllowedError" }) });
  await rig.controller.start();
  assert.equal(rig.controller.view.on, false);
  assert.equal(rig.controller.view.tone, "error");
  assert.match(rig.controller.view.message, /permission was refused/);
  // Round 2 makes the AudioContext before the permission wait (it has to be inside the click), so
  // one exists -- and it is closed again, with nothing wired to it.
  assert.equal(rig.contexts.length, 1);
  assert.equal(rig.contexts[0].state, "closed");
  assert.equal(rig.contexts[0].processor, null);
});

test("controller: switched off while Windows was still asking for the microphone, the late stream is released", async () => {
  const rig = makeRig({ holdMic: true });
  const starting = rig.controller.start();
  await settle();
  rig.controller.stop("drawer_closed");
  rig.releaseMic();
  await starting;
  assert.ok(rig.tracks.length === 1 && rig.tracks[0].stopped);
  assert.equal(rig.contexts.length, 1);
  assert.equal(rig.contexts[0].state, "closed");
  assert.equal(rig.contexts[0].processor, null, "nothing was wired to the late stream");
  assert.equal(rig.controller.view.on, false);
  assert.equal(rig.controller.view.message, LIVE_VOICE_STOP_MESSAGES.drawer_closed);
});

test("controller: 3 minutes without a question turns it off and releases the microphone", async () => {
  const rig = makeRig();
  await rig.controller.start();
  rig.clock += 179_000;
  rig.intervals[0]();
  assert.equal(rig.controller.view.on, true);
  rig.clock += 1_000;
  rig.intervals[0]();
  assert.equal(rig.controller.view.on, false);
  assert.equal(rig.controller.view.message, LIVE_VOICE_STOP_MESSAGES.idle);
  assert.ok(rig.tracks.every((item) => item.stopped));
});

test("controller: a transcription failure stops live voice with its own message", async () => {
  const rig = makeRig({ transcribeResult: () => { throw { response: { status: 503, data: { code: "SPEECH_TRANSCRIBE_FAILED" } } }; } });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.equal(rig.controller.view.on, false);
  assert.equal(rig.controller.view.tone, "error");
  assert.match(rig.controller.view.message, /failed to turn that into text/);
  assert.ok(rig.tracks.every((item) => item.stopped));
});

test("controller: an unreadable transcription is a failure, not an empty question", async () => {
  const rig = makeRig({ transcribeResult: () => ({ words: "Frost, sales" }) });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.equal(rig.controller.view.on, false);
  assert.match(rig.controller.view.message, /unreadable/);
});

test("controller: 'busy' keeps listening", async () => {
  const rig = makeRig({ transcribeResult: () => { throw { response: { status: 429, data: { code: "SPEECH_BUSY" } } }; } });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.equal(rig.controller.view.on, true);
  assert.match(rig.controller.view.message, /Still working/);
});

test("controller: a failed answer is shown and a short line is spoken, never a figure", async () => {
  const rig = makeRig({ askResult: (question) => ({ question, failureMessage: "The local service did not answer." }) });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.deepEqual(rig.spoken, ["I could not answer that. The reason is on the screen."]);
  assert.equal(rig.controller.view.message, "The local service did not answer.");
  assert.equal(rig.controller.view.tone, "error");
});

test("controller: a microphone that dies mid-session turns live voice off and says so", async () => {
  const rig = makeRig();
  await rig.controller.start();
  rig.tracks[0].onended();
  assert.equal(rig.controller.view.on, false);
  assert.equal(rig.controller.view.tone, "error");
  assert.match(rig.controller.view.message, /microphone stopped working/);
  assert.equal(rig.contexts[0].state, "closed");
});

test("controller: audio that stays paused never says Listening; it says to click, and a click resumes it", async () => {
  // Always-on after sign-in: no click, so WebView2 keeps the context suspended.
  const rig = makeRig({ suspended: true, resumes: false });
  await rig.controller.start({ idleLimitMs: null });
  assert.equal(rig.controller.view.on, true, "the microphone is open, and the indicator says so");
  assert.equal(rig.controller.view.phase, "paused");
  assert.notEqual(rig.controller.view.phase, "listening");
  assert.equal(rig.controller.view.message, LIVE_VOICE_PAUSED_MESSAGE);
  assert.equal(LIVE_VOICE_PHASE_LABELS.paused, "Click anywhere to start listening");
  // Waiting for the click is already said; the watchdog does not replace it.
  rig.clock += 10_000;
  rig.tick();
  assert.equal(rig.controller.view.phase, "paused");
  // The click.
  rig.resumesNow = true;
  assert.equal(rig.controller.resume(), true);
  assert.equal(rig.contexts[0].state, "running");
  assert.equal(rig.controller.view.message, LIVE_VOICE_RESUMING_MESSAGE);
  rig.frame(silence());
  assert.equal(rig.controller.view.phase, "listening");
  assert.equal(rig.controller.view.message, LIVE_VOICE_READY_HINT);
  const resumed = makeRig({ suspended: true, resumes: true });
  await resumed.controller.start();
  assert.equal(resumed.controller.view.phase, "listening");
});

test("controller: resume() does nothing while frames are arriving and the context runs", async () => {
  const rig = makeRig();
  await rig.controller.start();
  rig.frame(silence());
  assert.equal(rig.controller.resume(), false);
  assert.equal(rig.controller.view.message, LIVE_VOICE_READY_HINT);
});

test("controller: a microphone rate the engine cannot take is said as that, not as a gateway fault", async () => {
  const rig = makeRig({ sampleRate: 8000 });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.equal(rig.transcribed.length, 0, "nothing was sent");
  assert.equal(rig.controller.view.on, false);
  assert.match(rig.controller.view.message, /could not be prepared for the speech engine/);
});

test("controller: without a synthesiser it refuses before opening the microphone", async () => {
  const rig = makeRig({ speechSupportedHere: false });
  await rig.controller.start();
  assert.equal(rig.constraints, null);
  assert.equal(rig.controller.view.message, LIVE_VOICE_STOP_MESSAGES.speech_unsupported);
});

test("controller: a synthesiser that never says it finished does not hold the microphone deaf for ever", async () => {
  const rig = makeRig({ holdSpeech: true });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.equal(rig.controller.view.phase, "speaking");
  const guard = rig.timeouts.at(-1);
  assert.ok(guard.ms >= 8000);
  guard.fn();
  await settle();
  assert.equal(rig.controller.view.phase, "listening");
  assert.notEqual(rig.controller.view.message, LIVE_VOICE_SPEAK_FAILED_MESSAGE, "a missing end event is not a failure");
});

test("controller: switching off while FROST is speaking cancels the speech too", async () => {
  const rig = makeRig({ holdSpeech: true });
  await rig.controller.start();
  rig.say();
  await settle();
  const before = rig.synthesis.cancelled;
  rig.controller.stop("switched_off");
  assert.ok(rig.synthesis.cancelled > before);
});

// ---------------------------------------------------------------------------------------------
// Round 2: the gesture, the frame watchdog, the level meter.
// ---------------------------------------------------------------------------------------------
test("controller: prime() makes and resumes the AudioContext synchronously, before the microphone is asked for", async () => {
  const rig = makeRig({ suspended: true, resumes: true });
  // Inside the click: no await between the click and these two lines.
  assert.equal(rig.controller.prime(), true);
  assert.deepEqual(rig.log, ["new AudioContext", "resume"], "created and resumed synchronously inside the gesture");
  assert.equal(rig.contexts[0].state, "running");
  assert.equal(rig.controller.prime(), true, "a second prime reuses the first");
  assert.equal(rig.contexts.length, 1);
  await rig.controller.start();
  assert.equal(rig.contexts.length, 1, "start() used the primed context rather than making one after the await");
  assert.ok(rig.log.indexOf("new AudioContext") < rig.log.indexOf("getUserMedia"));
  assert.equal(rig.controller.view.phase, "listening");
});

test("controller: start() without prime() still creates the context before the permission wait", async () => {
  const rig = makeRig();
  const starting = rig.controller.start();
  assert.deepEqual(rig.log.slice(0, 2), ["new AudioContext", "getUserMedia"]);
  await starting;
});

test("controller: a primed context that start() will not use is closed, and so is one left when voice stops", () => {
  const rig = makeRig();
  rig.controller.prime();
  rig.controller.discardPrimed();
  assert.equal(rig.contexts[0].state, "closed");
  rig.controller.prime();
  rig.controller.stop("drawer_closed");
  assert.equal(rig.contexts[1].state, "closed");
});

test("watchdog: no frames for 2.5 s says so in words, keeps the microphone on, and frames arriving clear it", async () => {
  const rig = makeRig();
  await rig.controller.start();
  rig.clock += 2_400;
  rig.tick();
  assert.equal(rig.controller.view.phase, "listening", "not before 2.5 s");
  rig.clock += 100;
  rig.tick();
  assert.equal(rig.controller.view.on, true);
  assert.equal(rig.controller.view.phase, "no_sound");
  assert.equal(rig.controller.view.message, LIVE_VOICE_NO_SOUND_MESSAGE);
  assert.equal(LIVE_VOICE_NO_SOUND_MESSAGE, "No sound is reaching FROST from the microphone. Click here to start it.");
  assert.equal(rig.controller.view.tone, "error");
  assert.ok(rig.tracks.every((item) => !item.stopped), "the watchdog reports; it does not close the microphone");
  rig.frame(silence());
  assert.equal(rig.controller.view.phase, "listening");
  assert.equal(rig.controller.view.message, LIVE_VOICE_READY_HINT);
  // Frames stopping later in the session are caught too.
  rig.clock += 3_000;
  rig.tick();
  assert.equal(rig.controller.view.phase, "no_sound");
});

test("watchdog: a click that does not bring frames back says so differently", async () => {
  const rig = makeRig();
  await rig.controller.start();
  rig.clock += 2_500;
  rig.tick();
  assert.equal(rig.controller.resume(), true, "the click on the message");
  assert.equal(rig.controller.view.message, LIVE_VOICE_RESUMING_MESSAGE);
  assert.equal(rig.controller.view.phase, "listening");
  rig.clock += 2_500;
  rig.tick();
  assert.equal(rig.controller.view.phase, "no_sound");
  assert.equal(rig.controller.view.message, LIVE_VOICE_STILL_NO_SOUND_MESSAGE);
});

test("watchdog: a context primed in the click that still will not run is reported after 2.5 s", async () => {
  const rig = makeRig({ suspended: true, resumes: false });
  rig.controller.prime();
  await rig.controller.start();
  assert.equal(rig.controller.view.phase, "paused");
  rig.clock += 2_500;
  rig.tick();
  assert.equal(rig.controller.view.phase, "no_sound");
  assert.equal(rig.controller.view.message, LIVE_VOICE_NO_SOUND_MESSAGE);
  assert.equal(rig.controller.resume(), true);
  assert.ok(rig.contexts[0].resumeCalls >= 2, "the click resumes the context again");
});

test("controller: an AudioContext suspended mid-session says to click, and a context closed from outside ends voice in words", async () => {
  const rig = makeRig();
  await rig.controller.start();
  rig.contexts[0].state = "suspended";
  rig.contexts[0].onstatechange();
  assert.equal(rig.controller.view.phase, "paused");
  assert.equal(rig.controller.view.message, LIVE_VOICE_PAUSED_MESSAGE);
  rig.contexts[0].state = "closed";
  rig.contexts[0].onstatechange();
  assert.equal(rig.controller.view.on, false);
  assert.match(rig.controller.view.message, /stopped on its own/);
  assert.ok(rig.tracks.every((item) => item.stopped));
});

test("level: RMS becomes a 0..1 meter value on a 60 dB scale", () => {
  assert.equal(levelFromRms(0), 0);
  assert.equal(levelFromRms(NaN), 0);
  assert.equal(levelFromRms(-1), 0);
  assert.equal(levelFromRms(0.001), 0);
  assert.equal(levelFromRms(1), 1);
  assert.equal(levelFromRms(4), 1);
  assert.equal(levelFromRms(0.01), 0.33);
  assert.equal(levelFromRms(0.1), 0.67);
  assert.ok(levelFromRms(0.008) > 0.25 && levelFromRms(0.008) < 0.35, "the start threshold shows as a visible bar");
});

test("level: every microphone frame publishes its level, even while FROST speaks, and closing publishes 0", async () => {
  const rig = makeRig({ holdSpeech: true });
  await rig.controller.start();
  rig.frame(silence());
  rig.frame(tone(0.2));
  assert.deepEqual(rig.levels, [0, levelFromRms(0.2 / Math.SQRT2)]);
  assert.ok(rig.levels[1] > 0.6);
  rig.say();
  await settle();
  assert.equal(rig.controller.view.phase, "speaking");
  const before = rig.levels.length;
  rig.frame(tone(0.2));
  assert.equal(rig.levels.length, before + 1, "the meter still moves while capture is ignored");
  rig.controller.stop("switched_off");
  assert.equal(rig.levels.at(-1), 0);
});

test("level channel: subscribers hear changes only, and a throwing subscriber does not break it", () => {
  const channel = createVoiceLevelChannel();
  let calls = 0;
  channel.subscribe(() => { throw new Error("broken meter"); });
  const off = channel.subscribe(() => { calls += 1; });
  assert.equal(channel.get(), 0);
  channel.set(0.5);
  channel.set(0.5);
  assert.equal(calls, 1);
  channel.set(2);
  assert.equal(channel.get(), 1);
  channel.set(NaN);
  assert.equal(channel.get(), 0);
  off();
  channel.set(0.3);
  assert.equal(calls, 3);
});

test("controller: a background too loud to find a pause in is said, not sat on", async () => {
  const rig = makeRig();
  await rig.controller.start();
  for (let index = 0; index < 401; index += 1) rig.frame(tone(0.4));
  assert.ok(rig.views.some((view) => /longer than 20 seconds/.test(view.message)));
  assert.equal(rig.controller.view.message, LIVE_VOICE_TOO_LOUD_MESSAGE);
  assert.equal(rig.controller.view.tone, "error");
  assert.equal(rig.transcribed.length, 0);
});

test("controller: a synthesiser error is said on screen, but our own cancel is not an error", async () => {
  const failed = makeRig({ speechError: "synthesis-failed" });
  await failed.controller.start();
  failed.say();
  await settle();
  assert.equal(failed.controller.view.message, LIVE_VOICE_SPEAK_FAILED_MESSAGE);
  const cancelled = makeRig({ speechError: "interrupted" });
  await cancelled.controller.start();
  cancelled.say();
  await settle();
  assert.notEqual(cancelled.controller.view.message, LIVE_VOICE_SPEAK_FAILED_MESSAGE);
  assert.equal(cancelled.controller.view.tone, "info");
});

test("controller: a synthesiser that fails to speak is said on screen", async () => {
  const rig = makeRig({ speakThrows: true });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.deepEqual(rig.asked, ["what are today's sales?"]);
  assert.equal(rig.controller.view.message, LIVE_VOICE_SPEAK_FAILED_MESSAGE);
  assert.equal(rig.controller.view.tone, "error");
  assert.equal(rig.controller.view.on, true, "the question was answered on screen; listening carries on");
});

// ---------------------------------------------------------------------------------------------
// Round 2: always listening.
// ---------------------------------------------------------------------------------------------
test("always-on: no idle switch-off, however long nobody asks anything", async () => {
  const rig = makeRig();
  await rig.controller.start({ idleLimitMs: null });
  rig.frame(silence());
  rig.clock += 60 * 60 * 1000;
  rig.frame(silence());
  rig.tick();
  assert.equal(rig.controller.view.on, true);
  assert.ok(rig.tracks.every((item) => !item.stopped));
});

test("always-on: switched on under a running drawer session, the same microphone carries on without the idle limit", async () => {
  const rig = makeRig();
  await rig.controller.start();
  rig.controller.setIdleLimit(null);
  rig.clock += 10 * 60 * 1000;
  rig.frame(silence());
  rig.tick();
  await settle();
  assert.equal(rig.controller.view.on, true);
  // Ten silent minutes also reopen the microphone once without voice processing; the old stream is
  // closed first, so there is still only ever one microphone open.
  assert.equal(rig.tracks.filter((item) => !item.stopped).length, 1, "one microphone");
  assert.equal(rig.contexts.length, 1);
  // And back: the three minutes start from now, not from the last question.
  rig.controller.setIdleLimit(180_000);
  rig.tick();
  assert.equal(rig.controller.view.on, true);
  rig.clock += 180_000;
  rig.frame(silence());
  rig.tick();
  assert.equal(rig.controller.view.on, false);
  assert.equal(rig.controller.view.message, LIVE_VOICE_STOP_MESSAGES.idle);
});

test("always-on: hearing Frost pops FROST open before the question is asked", async () => {
  const rig = makeRig();
  await rig.controller.start({ idleLimitMs: null });
  rig.say();
  await settle();
  assert.deepEqual(rig.wakes, ["wake_word"]);
  assert.ok(rig.log.indexOf("wake:wake_word") < rig.log.indexOf("ask:what are today's sales?"), "drawer first, then the question");
  assert.deepEqual(rig.spoken, ["Sales today are Rs 42,300.00."]);
});

test("always-on: 'Frost' alone pops FROST open and waits 10 s for the question", async () => {
  const replies = ["Frost.", "How much did I sell today?"];
  const rig = makeRig({ transcribeResult: () => ({ text: replies.shift() }) });
  await rig.controller.start({ idleLimitMs: null });
  rig.say();
  await settle();
  assert.deepEqual(rig.wakes, ["wake_only"]);
  assert.deepEqual(rig.asked, []);
  assert.match(rig.controller.view.message, /Go ahead/);
  rig.say();
  await settle();
  assert.deepEqual(rig.asked, ["How much did I sell today?"]);
  assert.deepEqual(rig.wakes, ["wake_only", "follow_up"]);
});

test("always-on: a drawer that fails to open does not lose the question", async () => {
  const rig = makeRig({ onWake: () => { throw new Error("render failed"); } });
  await rig.controller.start({ idleLimitMs: null });
  rig.say();
  await settle();
  assert.deepEqual(rig.asked, ["what are today's sales?"]);
});

test("permission: a Cashier gets no microphone, and a role lost mid-session closes it", async () => {
  const cashier = makeRig({ allowed: () => false });
  assert.equal(cashier.controller.prime(), false);
  await cashier.controller.start({ idleLimitMs: null });
  assert.equal(cashier.constraints, null, "getUserMedia was never called");
  assert.equal(cashier.contexts.length, 0);
  assert.equal(cashier.controller.view.on, false);
  assert.equal(cashier.controller.view.message, LIVE_VOICE_STOP_MESSAGES.not_permitted);
  const throwing = makeRig({ allowed: () => { throw new Error("no user"); } });
  await throwing.controller.start();
  assert.equal(throwing.constraints, null, "a check that throws is a refusal");
  let owner = true;
  const rig = makeRig({ allowed: () => owner });
  await rig.controller.start({ idleLimitMs: null });
  owner = false;
  rig.tick();
  assert.equal(rig.controller.view.on, false);
  assert.ok(rig.tracks.every((item) => item.stopped));
});

test("preference: read and write tolerate a storage that throws, is missing, or holds garbage", () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  assert.equal(readAlwaysOnPreference(storage), false);
  assert.equal(writeAlwaysOnPreference(storage, true), true);
  assert.equal(store.get(LIVE_VOICE_ALWAYS_ON_STORAGE_KEY), "1");
  assert.equal(readAlwaysOnPreference(() => storage), true, "a getter works as well as the storage");
  assert.equal(writeAlwaysOnPreference(storage, false), true);
  assert.equal(readAlwaysOnPreference(storage), false);
  store.set(LIVE_VOICE_ALWAYS_ON_STORAGE_KEY, "yes");
  assert.equal(readAlwaysOnPreference(storage), false, "only the value we write means on");
  const broken = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); }, removeItem() { throw new Error("x"); } };
  assert.equal(readAlwaysOnPreference(broken), false);
  assert.equal(writeAlwaysOnPreference(broken, true), false);
  assert.equal(writeAlwaysOnPreference(broken, false), false);
  const denied = () => { throw new Error("localStorage is not available"); };
  assert.equal(readAlwaysOnPreference(denied), false);
  assert.equal(writeAlwaysOnPreference(denied, true), false);
  assert.equal(readAlwaysOnPreference(null), false);
  assert.equal(writeAlwaysOnPreference(null, true), false);
});

test("indicator: drawn whenever the microphone is on, in every phase, whoever is signed in", () => {
  for (const phase of Object.keys(LIVE_VOICE_PHASE_LABELS).filter((name) => name !== "off")) {
    for (const alwaysOn of [true, false]) {
      for (const allowed of [true, false]) {
        const indicator = liveVoiceIndicatorView({ view: { on: true, phase, message: "", tone: "info" }, alwaysOn, allowed });
        assert.ok(indicator, `${phase} ${alwaysOn} ${allowed}`);
        assert.equal(indicator.kind, "on");
        assert.equal(indicator.label, LIVE_VOICE_PHASE_LABELS[phase]);
      }
    }
  }
  const stalled = liveVoiceIndicatorView({ view: { on: true, phase: "no_sound", message: LIVE_VOICE_NO_SOUND_MESSAGE, tone: "error" } });
  assert.equal(stalled.tone, "error");
  assert.equal(stalled.detail, LIVE_VOICE_NO_SOUND_MESSAGE, "with the drawer closed the reason is carried in words");
  assert.equal(liveVoiceIndicatorView({ view: { on: true, phase: "paused", message: LIVE_VOICE_PAUSED_MESSAGE, tone: "attention" } }).tone, "attention");
});

test("indicator: always-on that stopped on a failure says so next to the bell; otherwise off draws nothing", () => {
  const failed = { on: false, phase: "off", message: "No microphone was found, so live voice is off.", tone: "error" };
  const stopped = liveVoiceIndicatorView({ view: failed, alwaysOn: true, allowed: true });
  assert.equal(stopped.kind, "stopped");
  assert.equal(stopped.detail, failed.message);
  assert.equal(liveVoiceIndicatorView({ view: failed, alwaysOn: false, allowed: true }), null);
  assert.equal(liveVoiceIndicatorView({ view: failed, alwaysOn: true, allowed: false }), null, "not for a Cashier, who has no voice");
  assert.equal(liveVoiceIndicatorView({ view: { on: false, phase: "off", message: LIVE_VOICE_STOP_MESSAGES.switched_off, tone: "info" }, alwaysOn: true, allowed: true }), null);
  assert.equal(liveVoiceIndicatorView(), null);
});

test("engine notice: tolerates a gateway without the round-2 fields, offers the update, and says when it is slow", () => {
  const ready = { state: "ready", model: "small", internet_allowed: true };
  assert.equal(speechEngineNotice(ready), null, "no engine fields: nothing said");
  assert.equal(speechEngineNotice({ ...ready, engine: "server" }), null);
  assert.equal(speechEngineNotice({ ...ready, engine: null, engine_update_available: null }), null, "null is tolerated like absent");
  assert.equal(speechEngineNotice({ state: "not_installed", engine: null, internet_allowed: true }), null);
  assert.equal(speechEngineNotice(null), null);
  assert.equal(speechEngineNotice({ state: "installing", engine_update_available: true }), null);
  const update = speechEngineNotice({ ...ready, engine: "cli", engine_update_available: true });
  assert.equal(update.kind, "update");
  assert.match(update.text, /^Voice engine update available/);
  assert.equal(update.action, "install");
  const blocked = speechEngineNotice({ ...ready, internet_allowed: false, engine_update_available: true });
  assert.equal(blocked.action, null);
  assert.match(blocked.detail, /Local Only/);
  const slow = speechEngineNotice({ ...ready, engine: "cli" });
  assert.equal(slow.kind, "slow");
  assert.match(slow.text, /slower engine/);
  assert.equal(speechEngineNotice(ready, { engine: "cli" }).kind, "slow", "the transcribe response's engine counts too");
  assert.equal(speechEngineNotice({ ...ready, engine: "cli" }, { engine: "server" }), null, "the latest transcription wins");
});

test("controller: the first transcription says the speech engine is starting; later ones do not", async () => {
  let release = null;
  const rig = makeRig({ transcribeResult: () => new Promise((resolve) => { release = () => resolve({ text: "Give me apples." }); }) });
  await rig.controller.start({ idleLimitMs: null });
  rig.say();
  await settle();
  assert.equal(rig.controller.view.phase, "transcribing");
  assert.equal(rig.controller.view.message, LIVE_VOICE_ENGINE_STARTING_MESSAGE);
  assert.equal(liveVoiceIndicatorView({ view: rig.controller.view }).detail, LIVE_VOICE_ENGINE_STARTING_MESSAGE, "next to the bell too");
  rig.clock += 30_000;
  rig.frame(silence()); // the microphone keeps delivering frames meanwhile
  rig.tick();
  assert.equal(rig.controller.view.message, LIVE_VOICE_ENGINE_STARTING_MESSAGE, "not replaced by the slow line while the engine starts");
  release();
  await settle();
  assert.equal(rig.controller.view.message, "", "cleared once the engine has answered");
  rig.say();
  await settle();
  assert.equal(rig.controller.view.phase, "transcribing");
  assert.notEqual(rig.controller.view.message, LIVE_VOICE_ENGINE_STARTING_MESSAGE, "the engine is warm now");
  // A later one that runs long says so.
  rig.clock += 6_000;
  rig.frame(silence());
  rig.tick();
  assert.equal(rig.controller.view.message, LIVE_VOICE_TRANSCRIBE_SLOW_MESSAGE);
  release();
  await settle();
  assert.equal(rig.controller.view.message, "");
});

test("the transcribe request waits long enough for the first, model-loading transcription (>= 65 s)", () => {
  const transcribe = appSource.match(/transcribe: async \(wavBytes\) => \{[\s\S]*?\n {6}\},/);
  assert.ok(transcribe);
  const timeout = Number((transcribe[0].match(/timeout: (\d+)/) || [])[1]);
  assert.ok(timeout >= 65000, `timeout ${timeout}`);
});

test("controller: the engine a transcription reports is kept in the view; none reported is null", async () => {
  const rig = makeRig({ transcribeResult: () => ({ text: "Frost, sales?", elapsed_ms: 900, engine: "cli" }) });
  await rig.controller.start();
  assert.equal(rig.controller.view.engine, null);
  rig.say();
  await settle();
  assert.equal(rig.controller.view.engine, "cli");
});

// ---------------------------------------------------------------------------------------------
// Source wiring: where audio may go, and what is gone.
// ---------------------------------------------------------------------------------------------
const walk = (directory) => readdirSync(directory).flatMap((name) => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? walk(path) : [path];
});
const shippedSources = walk(srcRoot).filter((path) => /\.(jsx?|css|html)$/.test(path) && !/\.test\.m?js$/.test(path));

test("the OpenAI Realtime voice path is gone from frontend/src", () => {
  assert.ok(shippedSources.length > 20, "the walk found the sources");
  for (const path of shippedSources) {
    const source = readFileSync(path, "utf8");
    for (const forbidden of [
      "api.openai.com",
      "/v1/realtime",
      "api/ai/voice/session",
      "realtimeUrl",
      "RTCPeerConnection",
      "oai-events",
      "clientSecret",
      "frost-realtime-voice",
      "startFrostVoice",
    ]) {
      assert.equal(source.includes(forbidden), false, `${relative(srcRoot, path)} still contains ${forbidden}`);
    }
  }
});

test("audio is posted only to the local gateway's transcribe route, as raw WAV", () => {
  assert.equal(LIVE_VOICE_TRANSCRIBE_PATH, "/api/local/speech/transcribe");
  // Exactly one audio upload in App.jsx, and it is to LOCAL_API_URL + the transcribe path.
  const wavPosts = appSource.match(/"Content-Type": "audio\/wav"/g) || [];
  assert.equal(wavPosts.length, 1);
  const transcribe = appSource.match(/transcribe: async \(wavBytes\) => \{[\s\S]*?\n {6}\},/);
  assert.ok(transcribe, "the transcribe wiring is where it was");
  assert.match(transcribe[0], /axios\.post\(`\$\{LOCAL_API_URL\}\/api\/local\/speech\/transcribe`, wavBytes, \{/);
  assert.match(transcribe[0], /"Content-Type": "audio\/wav"/);
  assert.doesNotMatch(transcribe[0], /\bAPI_URL\}|CLOUD_|SYNC_API_URL|AUTH_API_URL/);
  // No other way out for audio: the page itself never touches the microphone or a peer connection.
  assert.doesNotMatch(appSource, /getUserMedia\(/, "App.jsx hands navigator.mediaDevices to the controller; it never opens the microphone itself");
  assert.doesNotMatch(appSource, /new (?:WebSocket|RTCPeerConnection|MediaRecorder)\(/);
});

test("every speech route is called on LOCAL_API_URL and none goes through the cloud guard", () => {
  const uses = [...stripComments(appSource).matchAll(/(.{0,40})\/api\/local\/speech\/(status|install|transcribe)/g)];
  assert.deepEqual([...new Set(uses.map((match) => match[2]))].sort(), ["install", "status", "transcribe"]);
  for (const match of uses) {
    assert.match(match[1], /\$\{LOCAL_API_URL\}$/, `speech route called on another base: ${match[0]}`);
  }
  assert.equal(`${LIVE_VOICE_STATUS_PATH}|${LIVE_VOICE_INSTALL_PATH}`, "/api/local/speech/status|/api/local/speech/install");
  assert.doesNotMatch(appSource, /guardCloudCall\("[^"]*(?:speech|voice)/i);
  const block = stripComments(appSource.slice(appSource.indexOf("// ---- FROST live voice"), appSource.indexOf("const proposeFrostAction = async")));
  assert.ok(block.length > 500, "the live voice block is where it was");
  assert.doesNotMatch(block, /guardCloudCall|CLOUD_OPERATIONAL_API_URL|SYNC_API_URL|fetch\(/);
});

test("the microphone is released on switch-off, drawer close (unless always-on), sign-out and unmount", () => {
  assert.match(appSource, /if \(controller\.active\) \{\s*frostVoiceOffCountRef\.current \+= 1;\s*controller\.stop\("switched_off"\);/);
  assert.match(appSource, /if \(!next\) \{\s*frostVoiceOffCountRef\.current \+= 1;\s*controller\.stop\("switched_off"\);/, "turning always-on off closes the microphone");
  assert.match(appSource, /if \(frostDrawerOpen \|\| frostVoiceAlwaysOnRef\.current\) return;\s*frostVoiceOffCountRef\.current \+= 1;\s*frostLiveVoiceRef\.current\?\.stop\("drawer_closed"\);/);
  // A start still waiting on the status check when any of those happened does not open the microphone.
  assert.match(appSource, /const offCount = frostVoiceOffCountRef\.current;\s*const status = await readFrostSpeechStatus\(\);[\s\S]{0,120}if \(offCount !== frostVoiceOffCountRef\.current \|\|/);
  assert.equal((appSource.match(/frostVoiceOffCountRef\.current \+= 1;/g) || []).length, 5, "switch off, always-on off, drawer close, sign-out, microphone change");
  assert.match(appSource, /if \(!user\) \{\s*frostVoiceOffCountRef\.current \+= 1;\s*frostLiveVoiceRef\.current\?\.stop\("signed_out"\);/);
  assert.match(appSource, /useEffect\(\(\) => \(\) => frostLiveVoiceRef\.current\?\.stop\("unmounted"\), \[\]\);/);
  // And release() itself stops the tracks and closes the context -- the controller tests above
  // check it behaviourally; this pins the lines so a refactor cannot drop one silently.
  const code = stripComments(moduleSource);
  const release = code.match(/const release = \(current\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(release);
  assert.match(release[0], /track\.stop\(\)/);
  assert.match(release[0], /closeContext\(current\.context\)/);
  const close = code.match(/const closeContext = \(context\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(close);
  assert.match(close[0], /context\.close\(\)/);
});

test("the Live voice switch is only drawn for Owner or Admin, and asked through the typed path", () => {
  assert.match(appSource, /\{canManageFrost && liveVoiceBar\}/);
  assert.match(appSource, /\{canManageFrost && !surface\.onConversation && liveVoice\?\.on && liveVoiceBar\}/);
  assert.match(appSource, /const canManageFrost = user\?\.role === "Owner" \|\| user\?\.role === "Admin";/);
  assert.match(appSource, /if \(!frostBellAllowed\) \{\s*await controller\.start\(\);\s*return;/, "a Cashier's start goes to the controller, which refuses it in words");
  assert.match(appSource, /frostVoiceAllowedRef\.current = frostBellAllowed;/);
  assert.match(appSource, /isAllowed: \(\) => frostVoiceAllowedRef\.current === true && Boolean\(userRef\.current\)/);
  assert.match(appSource, /ask: \(question\) => askAiAssistantRef\.current\(question, \{ fromVoice: true \}\)/);
  assert.match(appSource, /askAiAssistantRef\.current = askAiAssistant;/);
});

test("this module has no transport of its own", () => {
  const code = stripComments(moduleSource);
  for (const forbidden of ["fetch(", "axios", "XMLHttpRequest", "http://", "https://", "WebSocket", "RTCPeerConnection", "sendBeacon", "import("]) {
    assert.equal(code.includes(forbidden), false, `frostLiveVoice.js must not reference ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Round 2 wiring in App.jsx.
// ---------------------------------------------------------------------------------------------
const liveBlock = () => stripComments(appSource.slice(appSource.indexOf("// ---- FROST live voice"), appSource.indexOf("const proposeFrostAction = async")));

test("one controller for both switches: built once, and never a second microphone", () => {
  const block = liveBlock();
  assert.equal((appSource.match(/createLiveVoiceController\(/g) || []).length, 1, "exactly one place builds a controller");
  assert.match(block, /const ensureFrostLiveVoiceController = \(\) => \{\s*if \(frostLiveVoiceRef\.current\) return frostLiveVoiceRef\.current;/);
  assert.doesNotMatch(block, /frostLiveVoiceRef\.current = null/, "the controller is never thrown away and rebuilt");
});

test("gesture: both switches prime the AudioContext inside the click, before the status check's await", () => {
  const block = liveBlock();
  for (const name of ["toggleFrostLiveVoice", "toggleFrostVoiceAlwaysOn", "relaunchFrostListening"]) {
    const body = block.match(new RegExp(`const ${name} = \\(\\) => \\{[\\s\\S]*?\\n {2}\\};`));
    assert.ok(body, name);
    assert.doesNotMatch(body[0], /\bawait\b|async/, `${name} must stay synchronous so the gesture still counts`);
    const primeAt = body[0].indexOf("controller.prime();");
    const beginAt = body[0].indexOf("beginFrostLiveVoice(");
    assert.ok(primeAt > -1 && beginAt > primeAt, `${name} primes before it starts`);
  }
  // The status check is where the await is.
  assert.match(block, /const startFrostLiveVoice = async[\s\S]*?const status = await readFrostSpeechStatus\(\);/);
});

test("gesture: while paused or without sound, the next pointerdown or key anywhere resumes the microphone", () => {
  const block = liveBlock();
  assert.match(block, /const frostVoiceNeedsGesture = frostLiveVoice\.on === true && \(frostLiveVoice\.phase === "paused" \|\| frostLiveVoice\.phase === "no_sound"\);/);
  assert.match(block, /const resume = \(\) => \{ frostLiveVoiceRef\.current\?\.resume\(\); \};\s*window\.addEventListener\("pointerdown", resume, true\);\s*window\.addEventListener\("keydown", resume, true\);/);
  assert.match(block, /window\.removeEventListener\("pointerdown", resume, true\);/);
  // And the words themselves are a button in the voice bar.
  assert.match(appSource, /<button className=\{`\$\{messageClass\} frost-live-message-action`\} onClick=\{voice\?\.onResume\}/);
});

test("always-on: remembered per device, started once after sign-in, and not stopped by closing the drawer", () => {
  const block = liveBlock();
  assert.match(appSource, /useState\(\(\) => readAlwaysOnPreference\(\(\) => window\.localStorage\)\)/);
  assert.match(block, /const saved = writeAlwaysOnPreference\(\(\) => window\.localStorage, next\);\s*setFrostVoicePreferenceNote\(saved \? "" : LIVE_VOICE_PREFERENCE_NOT_SAVED\);/);
  assert.match(block, /if \(!user \|\| !frostBellAllowed \|\| !frostVoiceAlwaysOn\) return;[\s\S]*?if \(frostVoiceAutoStartedRef\.current === key\) return;[\s\S]*?beginFrostLiveVoice\(\{ auto: true \}\);/);
  assert.match(block, /controller\.start\(\{ idleLimitMs: alwaysOn \? null : LIVE_VOICE_IDLE_LIMIT_MS, deviceId: frostMicrophoneIdRef\.current \}\)/, "no idle switch-off when always-on");
  assert.match(block, /if \(controller\.active\) \{\s*controller\.setIdleLimit\(null\);\s*return;/);
  // The drawer check that refuses to open a microphone into a closed drawer is skipped for always-on.
  assert.match(block, /\|\| !userRef\.current \|\| \(!alwaysOn && !frostDrawerOpenRef\.current\)\)/);
  assert.match(block, /frostVoiceAutoStartedRef\.current = "";/, "signing out lets the next sign-in start it again");
});

test("always-on: 'Frost' pops the drawer through the launcher's own opener, on the conversation, before asking", () => {
  const reveal = stripComments(appSource).match(/frostVoiceRevealRef\.current = \(\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(reveal);
  assert.match(reveal[0], /if \(!frostDrawerOpenRef\.current\) \{\s*flushSync\(\(\) => openFrostDrawer\(FROST_PRIMARY_SECTION\)\);/);
  assert.match(reveal[0], /setFrostActiveTab\(FROST_PRIMARY_SECTION\);/);
  assert.match(liveBlock(), /onWake: \(\) => frostVoiceRevealRef\.current\?\.\(\),/);
  assert.match(appSource, /import \{ flushSync \} from "react-dom";/);
});

test("indicator: rendered next to the bell whenever the controller says the microphone is on, drawer open or not", () => {
  assert.match(liveBlock(), /const frostVoiceIndicator = liveVoiceIndicatorView\(\{ view: frostLiveVoice, alwaysOn: frostVoiceAlwaysOn, allowed: frostBellAllowed \}\);/);
  const topbar = appSource.slice(appSource.indexOf('<div className="topbar-status-row">'), appSource.indexOf('<div className="notification-bell-wrap">'));
  assert.match(topbar, /\{frostVoiceIndicator && \(\s*<FrostVoiceIndicator/, "the indicator sits in the topbar, just before the bell");
  assert.doesNotMatch(topbar.slice(0, topbar.indexOf("{frostVoiceIndicator &&")), /frostDrawerOpen &&/, "not gated on the drawer");
  assert.match(appSource, /<FrostVoiceLevel channel=\{level\} \/>/, "with the level");
  // The launcher is fixed on screen; the topbar scrolls away. It carries the microphone too.
  assert.match(appSource, /micOn=\{frostLiveVoice\.on === true\}/);
  assert.match(appSource, /\{micOn && <i aria-hidden="true" className="frost-launcher-mic">/);
});

test("the voice bar: always-on switch for Owner/Admin, drawer switch only when always-on is off, heard line drawn", () => {
  assert.match(appSource, /\{!alwaysOn && \(\s*<button\s+aria-checked=\{on\}/);
  assert.match(appSource, /onClick=\{voice\.onToggleAlwaysOn\}/);
  assert.match(appSource, /Listen for &quot;Frost&quot; everywhere/);
  assert.match(appSource, /\{heard && <p aria-live="polite" className="frost-live-heard">\{heard\}<\/p>\}/);
  assert.match(appSource, /heard=\{frostDrawerOpen \? "" : frostLiveVoice\.heard\}/, "and next to the bell when the drawer is closed");
  assert.match(appSource, /\{engineNotice\.action === "install" && \(/);
  // Every piece of the bar is still behind canManageFrost.
  assert.match(appSource, /\{canManageFrost && liveVoiceBar\}/);
});

// ---------------------------------------------------------------------------------------------
// A microphone that is on and silent, and choosing another one (23 Sep 2026: Bluetooth earphones).
// ---------------------------------------------------------------------------------------------
test("controller: 5 s of silence reopens the microphone without voice processing, then says why if still silent", async () => {
  const label = "Headset (Boat Rockerz 255)";
  const rig = makeRig();
  await rig.controller.start();
  assert.equal(rig.controller.view.microphone, label, "the screen can say which microphone is open");
  assert.equal(rig.controller.view.microphoneId, "mic-headset");
  assert.equal(rig.controller.view.microphoneRaw, false);
  assert.equal(rig.constraints.audio.echoCancellation, true, "processed first");
  for (let index = 0; index < 45; index += 1) rig.frame(silence());
  rig.tick();
  assert.equal(rig.tracks.length, 1, "4.5 s is not yet silence");
  for (let index = 0; index < 10; index += 1) rig.frame(silence());
  rig.tick();
  assert.equal(rig.controller.view.message, rawRetryMessage(label));
  assert.equal(rig.controller.view.tone, "attention");
  await settle();
  assert.deepEqual(rig.constraints, microphoneConstraints({ deviceId: "mic-headset", raw: true }));
  assert.deepEqual(rig.constraints.audio, {
    echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, deviceId: { ideal: "mic-headset" },
  });
  assert.equal(rig.tracks.length, 2);
  assert.equal(rig.tracks[0].stopped, true, "the processed stream is closed");
  assert.equal(rig.tracks[1].stopped, false);
  assert.equal(rig.contexts.length, 1, "same AudioContext, only the source changes");
  assert.equal(rig.controller.view.microphoneRaw, true);
  // Silent on the plain stream too: now it says so, with what it measured.
  for (let index = 0; index < 55; index += 1) rig.frame(silence());
  rig.tick();
  await settle();
  assert.equal(rig.tracks.length, 2, "reopened once, not in a loop");
  assert.equal(rig.controller.view.message, silentMicrophoneMessage(label, { peak: 0, muted: false, triedRaw: true }));
  assert.match(rig.controller.view.message, /complete silence/);
  assert.match(rig.controller.view.message, /tried with and without Windows voice processing; loudest sample 0\.00000/);
  assert.equal(rig.controller.view.tone, "error");
  assert.equal(rig.controller.view.on, true, "still listening: the owner may simply be quiet");
  rig.frame(tone(0.01));
  assert.equal(rig.controller.view.message, LIVE_VOICE_READY_HINT);
  assert.equal(rig.controller.view.tone, "info");
});

test("controller: sound on the plain stream clears the retry, and later starts open it that way at once", async () => {
  const rig = makeRig();
  await rig.controller.start();
  for (let index = 0; index < 55; index += 1) rig.frame(silence());
  rig.tick();
  await settle();
  rig.frame(tone(0.01));
  assert.equal(rig.controller.view.message, LIVE_VOICE_READY_HINT);
  rig.controller.stop("switched_off");
  await rig.controller.start();
  assert.equal(rig.constraints.audio.echoCancellation, false);
  assert.equal(rig.controller.view.microphoneRaw, true);
});

test("controller: a faint microphone is told apart from one sending nothing, and a muted one says so", async () => {
  const faint = makeRig();
  await faint.controller.start();
  for (let round = 0; round < 2; round += 1) {
    for (let index = 0; index < 55; index += 1) faint.frame(tone(0.0003));
    faint.tick();
    await settle();
  }
  assert.match(faint.controller.view.message, /sends sound, but far too quietly/);
  assert.match(faint.controller.view.message, /loudest sample 0\.000[23]/);
  const muted = makeRig({ micMuted: true });
  await muted.controller.start();
  for (let round = 0; round < 2; round += 1) {
    for (let index = 0; index < 55; index += 1) muted.frame(silence());
    muted.tick();
    await settle();
  }
  assert.match(muted.controller.view.message, /Windows reports the microphone muted/);
  assert.match(muted.controller.view.message, /mute key/);
});

test("controller: a plain-stream reopen that fails says what it measured instead of going quiet", async () => {
  const rig = makeRig();
  await rig.controller.start();
  rig.mediaDevices.getUserMedia = () => Promise.reject(Object.assign(new Error("busy"), { name: "NotReadableError" }));
  for (let index = 0; index < 55; index += 1) rig.frame(silence());
  rig.tick();
  await settle();
  assert.match(rig.controller.view.message, /complete silence/);
  assert.equal(rig.controller.view.on, true, "the processed stream is still open and listening");
  assert.equal(rig.tracks[0].stopped, false);
});

test("controller: a quiet but live microphone (room noise) is not called silent", async () => {
  const rig = makeRig();
  await rig.controller.start();
  for (let index = 0; index < 80; index += 1) rig.frame(tone(0.002));
  rig.tick();
  assert.ok(!String(rig.controller.view.message).startsWith("FROST hears nothing"));
  assert.ok(LIVE_VOICE_SILENT_MS <= 8000);
});

test("controller: time spent answering is not counted as silence", async () => {
  const rig = makeRig({ holdSpeech: true });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.equal(rig.controller.view.phase, "speaking");
  for (let index = 0; index < 80; index += 1) rig.frame(silence());
  rig.tick();
  assert.ok(!String(rig.controller.view.message).startsWith("FROST hears nothing"));
});

test("controller: no frames at all is the no-sound watchdog, not the silent-microphone message", async () => {
  const rig = makeRig();
  await rig.controller.start();
  rig.clock += 8000;
  rig.tick();
  assert.ok(!String(rig.controller.view.message).startsWith("FROST hears nothing"));
});

test("controller: a chosen microphone is asked for as `ideal`, so an unplugged one falls back to the default", async () => {
  const rig = makeRig();
  await rig.controller.start({ deviceId: "mic-laptop" });
  assert.deepEqual(rig.constraints.audio.deviceId, { ideal: "mic-laptop" });
  const plain = makeRig();
  await plain.controller.start({ deviceId: "  " });
  assert.equal("deviceId" in plain.constraints.audio, false, "no choice, Windows' default");
});

test("silentMicrophoneMessage: names the microphone, and tells zeros, faint and unknown apart", () => {
  assert.match(silentMicrophoneMessage("Mic Array"), /^FROST hears nothing from "Mic Array"\./);
  assert.match(silentMicrophoneMessage(""), /^FROST hears nothing from this microphone\./);
  assert.match(silentMicrophoneMessage("x"), /Let desktop apps access your microphone/);
  assert.match(silentMicrophoneMessage("x"), /choose another microphone below/);
  const zeros = silentMicrophoneMessage("Mic Array", { peak: 0 });
  assert.match(zeros, /complete silence, not even room noise/);
  assert.match(zeros, /mute key/);
  assert.match(zeros, /loudest sample 0\.00000\)$/);
  const faint = silentMicrophoneMessage("Mic Array", { peak: 0.0002, triedRaw: true });
  assert.match(faint, /^"Mic Array" sends sound, but far too quietly/);
  assert.match(faint, /\(tried with and without Windows voice processing; loudest sample 0\.00020\)$/);
  assert.match(silentMicrophoneMessage("", { peak: 0.0002 }), /^This microphone sends sound/);
  // Printed as 0.00000 on the owner's laptop, and not exactly zero: still nothing, not "faint".
  assert.match(silentMicrophoneMessage("Mic Array", { peak: 0.000003, triedRaw: true }), /complete silence[\s\S]*loudest sample 0\.00000\)$/);
  assert.match(silentMicrophoneMessage("Mic Array", { peak: 0.0001 }), /far too quietly/);
  assert.match(silentMicrophoneMessage("x", { peak: 0.2, muted: true }), /complete silence[\s\S]*Windows reports the microphone muted/);
});

test("listMicrophones: real devices only, the default stand-in names the current default, failures are empty", async () => {
  const list = await listMicrophones({
    enumerateDevices: async () => [
      { kind: "audioinput", deviceId: "default", label: "Default - Headset (Boat)" },
      { kind: "audioinput", deviceId: "communications", label: "Communications - Headset (Boat)" },
      { kind: "audioinput", deviceId: "mic-laptop", label: "Microphone Array (Realtek)" },
      { kind: "audioinput", deviceId: "mic-headset", label: "" },
      { kind: "audiooutput", deviceId: "spk", label: "Speakers" },
      { kind: "audioinput", deviceId: "", label: "" },
    ],
  });
  assert.deepEqual(list, {
    devices: [
      { deviceId: "mic-laptop", label: "Microphone Array (Realtek)" },
      { deviceId: "mic-headset", label: "Microphone 2" },
    ],
    defaultLabel: "Headset (Boat)",
  });
  assert.deepEqual(await listMicrophones(null), { devices: [], defaultLabel: "" });
  assert.deepEqual(await listMicrophones({ enumerateDevices: async () => { throw new Error("no"); } }), { devices: [], defaultLabel: "" });
});

test("microphoneOptions: default first, and a remembered but unplugged microphone stays visible", () => {
  const list = { devices: [{ deviceId: "a", label: "A" }], defaultLabel: "A" };
  assert.deepEqual(microphoneOptions(list, ""), [{ value: "", label: "Windows default (A)" }, { value: "a", label: "A" }]);
  assert.deepEqual(microphoneOptions(list, "gone").at(-1), { value: "gone", label: "Chosen microphone (not connected now)" });
  assert.equal(microphoneOptions({ devices: [] }, "")[0].label, "Windows default");
});

test("microphone preference: per device, unreadable is the default, a refused write says so", () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };
  assert.equal(readMicrophonePreference(storage), "");
  assert.equal(writeMicrophonePreference(storage, "mic-laptop"), true);
  assert.equal(store.get(LIVE_VOICE_MICROPHONE_STORAGE_KEY), "mic-laptop");
  assert.equal(readMicrophonePreference(() => storage), "mic-laptop");
  assert.equal(writeMicrophonePreference(storage, ""), true);
  assert.equal(store.has(LIVE_VOICE_MICROPHONE_STORAGE_KEY), false);
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  assert.equal(readMicrophonePreference(broken), "");
  assert.equal(writeMicrophonePreference(broken, "x"), false);
  assert.equal(writeMicrophonePreference(() => { throw new Error("no storage"); }, "x"), false);
});

test("App: the voice bar shows which microphone FROST hears and lets the owner choose another", () => {
  const code = stripComments(appSource);
  assert.match(code, /useState\(\(\) => readMicrophonePreference\(\(\) => window\.localStorage\)\)/);
  const choose = code.match(/const chooseFrostMicrophone = \(deviceId\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(choose);
  assert.match(choose[0], /const saved = writeMicrophonePreference\(\(\) => window\.localStorage, id\);\s*setFrostVoicePreferenceNote\(saved \? "" : LIVE_VOICE_PREFERENCE_NOT_SAVED\);/);
  // Switching while listening closes the old microphone and opens the new one in the same click.
  assert.match(choose[0], /frostVoiceOffCountRef\.current \+= 1;\s*controller\.stop\("switched_off", "Switching microphone\.\.\."\);\s*controller\.prime\(\);\s*beginFrostLiveVoice\(\);/);
  assert.match(code, /devices\.addEventListener\("devicechange", onChange\);\s*return \(\) => devices\.removeEventListener\("devicechange", onChange\);/);
  assert.match(code, /Hearing: &quot;\{liveVoice\.microphone\}&quot;/);
  assert.match(code, /\{liveVoice\?\.microphoneRaw && " \(without Windows voice processing\)"\}/);
  assert.match(code, /onChange=\{\(event\) => voice\.onChooseMicrophone\(event\.target\.value\)\} value=\{voice\.microphoneId \|\| ""\}/);
});
