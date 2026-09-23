import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  LIVE_VOICE_INSTALL_PATH,
  LIVE_VOICE_STATUS_PATH,
  LIVE_VOICE_STOP_MESSAGES,
  LIVE_VOICE_TRANSCRIBE_PATH,
  SPEECH_SETUP_PROMPT,
  createLiveVoiceController,
  createUtteranceDetector,
  describeTranscribeFailure,
  downsampleTo16k,
  encodeWav16kMono,
  frameRms,
  liveVoiceIdle,
  microphoneFailureMessage,
  questionFromTranscript,
  speechSetupView,
  spokenAnswerFor,
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
  // RMS of a 0.021 sine is about 0.015: under the start threshold (0.02), over the stop one (0.01).
  const soft = () => tone(0.021);
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
  const hum = () => tone(0.045); // RMS ~0.032, over the fixed start threshold
  const events = feed(detector, repeat(300, hum));
  assert.deepEqual(events.map((event) => event.reason), ["too_long"], "the first 20 s are one overflow, not a stream of questions");
  assert.equal(detector.state, "idle", "after learning the hum it is quiet again");
  assert.deepEqual(feed(detector, repeat(100, hum)), []);
  assert.ok(detector.thresholds.start > 0.032);
  // Somebody speaking over the hum is still heard.
  const speech = feed(detector, [...repeat(10, () => tone(0.4)), ...repeat(10, hum)]);
  assert.deepEqual(speech.map((event) => event.type), ["utterance"]);
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

test("conservative: Frost has to be the first word, and not Frosty or Frost's", () => {
  for (const heard of [
    "Frosty the snowman",
    "Frosted flakes are on the second shelf",
    "I told the frost guy to come tomorrow",
    "Frost's delivery is late",
    "Give me two kilos of apples",
  ]) {
    const decision = questionFromTranscript(heard);
    assert.equal(decision.ask, false, heard);
    assert.equal(decision.reason, "no_wake_word", heard);
    assert.equal(decision.question, "");
  }
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

test("transcription failures are distinct, and only 'busy' keeps the microphone open", () => {
  const cases = [
    [{ response: { status: 409, data: { code: "SPEECH_NOT_INSTALLED" } } }, true],
    [{ response: { status: 400, data: { code: "SPEECH_AUDIO_INVALID" } } }, true],
    [{ response: { status: 503, data: { code: "SPEECH_TRANSCRIBE_FAILED" } } }, true],
    [{ response: { status: 429, data: { code: "SPEECH_BUSY" } } }, false],
    [{ message: "Network Error" }, true],
    [{ response: { status: 500, data: {} } }, true],
  ];
  const messages = cases.map(([error, stops]) => {
    const failure = describeTranscribeFailure(error);
    assert.equal(failure.stop, stops, JSON.stringify(error));
    assert.ok(failure.message.length > 20);
    return failure.message;
  });
  assert.equal(new Set(messages).size, messages.length, "no two failures read the same");
  assert.match(messages[5], /HTTP 500/);
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
} = {}) => {
  const rig = {
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
    const item = { stopped: false, stop() { item.stopped = true; } };
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
      rig.contexts.push(this);
    }
    createMediaStreamSource(input) { return { input, connect() {}, disconnect() {} }; }
    createScriptProcessor() {
      const node = { onaudioprocess: null, connected: false, connect() { node.connected = true; }, disconnect() { node.connected = false; } };
      this.processor = node;
      return node;
    }
    createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
    resume() {
      if (resumes) { this.state = "running"; return Promise.resolve(); }
      return new Promise(() => {});
    }
    close() { this.state = "closed"; return Promise.resolve(); }
  }
  rig.synthesis = {
    speaking: false,
    cancelled: 0,
    cancel() { rig.synthesis.cancelled += 1; rig.synthesis.speaking = false; },
    speak(utterance) {
      rig.spoken.push(utterance.text);
      rig.synthesis.speaking = true;
      const end = () => { rig.synthesis.speaking = false; utterance.onend?.(); };
      if (holdSpeech) rig.finishSpeech = end;
      else setImmediate(end);
    },
  };
  function Utterance(text) { this.text = text; }
  rig.timers = {
    setInterval(fn) { rig.intervals.push(fn); return rig.intervals.length; },
    clearInterval() {},
    setTimeout(fn, ms) { return setTimeout(fn, Math.min(ms, 5)); },
    clearTimeout(id) { clearTimeout(id); },
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
      return askResult(question);
    },
    isBusy: () => rig.busy,
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

test("controller: speech without the wake word is dropped, never asked", async () => {
  const rig = makeRig({ transcribeResult: () => ({ text: "Give me two kilos of apples." }) });
  await rig.controller.start();
  rig.say();
  await settle();
  assert.equal(rig.transcribed.length, 1);
  assert.deepEqual(rig.asked, []);
  assert.doesNotMatch(rig.controller.view.message, /apples/, "what the counter says is not repeated on screen");
  assert.match(rig.controller.view.message, /without "Frost"/);
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
  assert.equal(rig.contexts.length, 0);
});

test("controller: switched off while Windows was still asking for the microphone, the late stream is released", async () => {
  const rig = makeRig({ holdMic: true });
  const starting = rig.controller.start();
  await settle();
  rig.controller.stop("drawer_closed");
  rig.releaseMic();
  await starting;
  assert.ok(rig.tracks.length === 1 && rig.tracks[0].stopped);
  assert.equal(rig.contexts.length, 0);
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

test("controller: audio that stays paused is an error, not a switch that says Listening", async () => {
  const rig = makeRig({ suspended: true, resumes: false });
  await rig.controller.start();
  assert.equal(rig.controller.view.on, false);
  assert.match(rig.controller.view.message, /Audio processing could not start \(audio stayed paused\)/);
  assert.ok(rig.tracks.every((item) => item.stopped));
  const resumed = makeRig({ suspended: true, resumes: true });
  await resumed.controller.start();
  assert.equal(resumed.controller.view.phase, "listening");
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

test("the microphone is released on switch-off, drawer close, sign-out and unmount", () => {
  assert.match(appSource, /frostLiveVoiceRef\.current\?\.active\) \{\s*stopFrostLiveVoice\("switched_off"\)/);
  assert.match(appSource, /if \(!frostDrawerOpen\) frostLiveVoiceRef\.current\?\.stop\("drawer_closed"\);/);
  assert.match(appSource, /if \(!user\) frostLiveVoiceRef\.current\?\.stop\("signed_out"\);/);
  assert.match(appSource, /useEffect\(\(\) => \(\) => frostLiveVoiceRef\.current\?\.stop\("unmounted"\), \[\]\);/);
  // And release() itself stops the tracks and closes the context -- the controller tests above
  // check it behaviourally; this pins the lines so a refactor cannot drop one silently.
  const release = stripComments(moduleSource).match(/const release = \(current\) => \{[\s\S]*?\n {2}\};/);
  assert.ok(release);
  assert.match(release[0], /track\.stop\(\)/);
  assert.match(release[0], /context\.close\(\)/);
});

test("the Live voice switch is only drawn for Owner or Admin, and asked through the typed path", () => {
  assert.match(appSource, /\{canManageFrost && liveVoiceBar\}/);
  assert.match(appSource, /\{canManageFrost && !surface\.onConversation && liveVoice\?\.on && liveVoiceBar\}/);
  assert.match(appSource, /const canManageFrost = user\?\.role === "Owner" \|\| user\?\.role === "Admin";/);
  assert.match(appSource, /if \(!frostBellAllowed\) \{\s*setFrostLiveVoice\(/);
  assert.match(appSource, /ask: \(question\) => askAiAssistantRef\.current\(question, \{ fromVoice: true \}\)/);
  assert.match(appSource, /askAiAssistantRef\.current = askAiAssistant;/);
});

test("this module has no transport of its own", () => {
  const code = stripComments(moduleSource);
  for (const forbidden of ["fetch(", "axios", "XMLHttpRequest", "http://", "https://", "WebSocket", "RTCPeerConnection", "sendBeacon", "import("]) {
    assert.equal(code.includes(forbidden), false, `frostLiveVoice.js must not reference ${forbidden}`);
  }
});
