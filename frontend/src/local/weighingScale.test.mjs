import assert from "node:assert/strict";
import test from "node:test";
import {
  SCALE_SILENT_MS,
  SCALE_STATES,
  SCALE_STEADY_MS,
  createSteadiness,
  describeScale,
  findScalePort,
  isWeighedUnit,
  nextSteadiness,
  orderPortsForSearch,
  parseScaleText,
  plainScaleError,
  readSavedScalePort,
  saveScalePort,
  scaleQuantityFor,
} from "./weighingScale.js";

const reading = (text, { now = 10_000, lastData = now - 100, port = "COM5" } = {}) => ({
  status: "reading", port_name: port, text, bytes_read: text.length, last_data_at_ms: lastData, now_ms: now, error: null,
});

test("parse: the newest whole reading, as the iScale manual prints it", () => {
  assert.deepEqual(parseScaleText("+001.250 kg\r\n"), { status: "weight", kg: 1.25, raw: "+001.250 kg" });
  // The kept text usually ends mid-reading: that half is ignored, the one before it counts.
  assert.equal(parseScaleText("+001.250 kg\r\n+001.3").kg, 1.25);
  assert.equal(parseScaleText("+000.980 kg\r\n+001.250 kg\r\n").kg, 1.25, "newest first");
  assert.deepEqual(parseScaleText("+001.2"), { status: "none" }, "half a reading is no reading");
  assert.deepEqual(parseScaleText(""), { status: "none" });
  assert.deepEqual(parseScaleText(null), { status: "none" });
});

test("parse: no line ends, grams, a bare number, below zero, and rubbish", () => {
  assert.equal(parseScaleText("+001.250 kg+001.260 kg+001.2").kg, 1.26, "split on the sign when there are no line ends");
  assert.equal(parseScaleText("+001.250 kg+001.260 kg").kg, 1.26, "a last piece with its unit is whole");
  assert.equal(parseScaleText("+1250 g\r\n").kg, 1.25);
  assert.equal(parseScaleText("ST,GS,+001.500kg\r\n").kg, 1.5, "status letters around the reading are fine");
  assert.equal(parseScaleText("002.000\r\n").kg, 2, "a bare number is kg");
  assert.equal(parseScaleText("-000.120 kg\r\n").kg, -0.12);
  assert.equal(parseScaleText("+000.000 kg\r\n").kg, 0);
  assert.equal(Object.is(parseScaleText("-000.000 kg\r\n").kg, -0), false, "minus zero is zero");
  assert.deepEqual(parseScaleText("hello there\r\n"), { status: "unreadable", raw: "hello there" });
});

test("describe: every way the scale can fail is words, never a weight of zero", () => {
  const cases = [
    [null, SCALE_STATES.UNAVAILABLE],
    [{ status: "idle" }, SCALE_STATES.OFF],
    [{ status: "connecting", port_name: "COM5" }, SCALE_STATES.CONNECTING],
    [{ status: "failed", port_name: "COM5", error: "COM5 could not be opened: Access is denied." }, SCALE_STATES.FAILED],
    [{ status: "reading", port_name: "COM5", text: "", last_data_at_ms: null, now_ms: 1 }, SCALE_STATES.WAITING],
    [reading("+001.250 kg\r\n", { now: 10_000, lastData: 10_000 - SCALE_SILENT_MS - 1 }), SCALE_STATES.SILENT],
    [reading("+001.2"), SCALE_STATES.WAITING],
    [reading("garbage\r\n"), SCALE_STATES.UNREADABLE],
    [reading("-000.120 kg\r\n"), SCALE_STATES.NEGATIVE],
    [{ status: "weird" }, SCALE_STATES.FAILED],
  ];
  for (const [status, state] of cases) {
    const view = describeScale(status);
    assert.equal(view.state, state, JSON.stringify(status));
    assert.equal(view.kg, null, `${state} carries no weight`);
    assert.ok(view.message.length > 10, `${state} says why`);
  }
  assert.match(describeScale({ status: "failed", port_name: "COM5", error: "COM5 could not be opened: Access is denied." }).message, /COM5 is being used by another program/);
});

test("steadiness: the same reading for long enough is steady, a swinging one never is", () => {
  let steady = createSteadiness();
  steady = nextSteadiness(steady, reading("+001.250 kg\r\n", { now: 1000 }));
  assert.equal(describeScale(reading("+001.250 kg\r\n", { now: 1000 }), steady).steady, false, "first sight is not steady");
  steady = nextSteadiness(steady, reading("+001.251 kg\r\n", { now: 1000 + SCALE_STEADY_MS - 1 }));
  assert.equal(steady.steady, false);
  steady = nextSteadiness(steady, reading("+001.250 kg\r\n", { now: 1000 + SCALE_STEADY_MS }));
  assert.equal(steady.steady, true, "within the last digit, held long enough");
  assert.equal(steady.readingId, 1);
  const view = describeScale(reading("+001.250 kg\r\n", { now: 1000 + SCALE_STEADY_MS }), steady);
  assert.deepEqual([view.state, view.kg, view.steady, view.readingId], [SCALE_STATES.LIVE, 1.25, true, 1]);
  assert.equal(view.message, "Scale: 1.250 kg");

  // Taken off and a new fruit put on: a new steady weight gets a new id.
  steady = nextSteadiness(steady, reading("+000.000 kg\r\n", { now: 3000 }));
  assert.equal(steady.steady, false);
  steady = nextSteadiness(steady, reading("+000.000 kg\r\n", { now: 3000 + SCALE_STEADY_MS }));
  steady = nextSteadiness(steady, reading("+000.640 kg\r\n", { now: 5000 }));
  steady = nextSteadiness(steady, reading("+000.640 kg\r\n", { now: 5000 + SCALE_STEADY_MS }));
  assert.deepEqual([steady.kg, steady.steady, steady.readingId], [0.64, true, 3]);

  // A silent scale clears it.
  const silent = nextSteadiness(steady, reading("+000.640 kg\r\n", { now: 20_000, lastData: 20_000 - SCALE_SILENT_MS - 1 }));
  assert.deepEqual([silent.kg, silent.steady], [null, false]);
});

test("quantity: only kg items, only a steady weight above zero, and each weight once on adding", () => {
  const live = { state: SCALE_STATES.LIVE, kg: 1.2504, steady: true, readingId: 4 };
  assert.equal(scaleQuantityFor("KG", live), 1.25);
  assert.equal(scaleQuantityFor("kg", live), 1.25);
  for (const unit of ["PIECE", "BOX", "DOZEN", "", null]) assert.equal(scaleQuantityFor(unit, live), null, `${unit} is never weighed`);
  assert.equal(scaleQuantityFor("KG", { ...live, steady: false }), null, "settling is not a weight");
  assert.equal(scaleQuantityFor("KG", { ...live, kg: 0 }), null, "an empty pan is not a weight");
  assert.equal(scaleQuantityFor("KG", { ...live, state: SCALE_STATES.SILENT }), null);
  assert.equal(scaleQuantityFor("KG", live, 4), null, "the weight already taken for the last item is not taken again");
  assert.equal(scaleQuantityFor("KG", live, 3), 1.25);
  assert.equal(scaleQuantityFor("KG", null), null);
  assert.equal(isWeighedUnit(" kg "), true);
});

test("find scale: Bluetooth ports first, the first one that sends a weight wins, and a miss says what to do", async () => {
  assert.deepEqual(orderPortsForSearch([
    { port_name: "COM10", kind: "usb" }, { port_name: "COM4", kind: "unknown" }, { port_name: "COM3", kind: "bluetooth" }, { port_name: "" }, null,
  ]).map((port) => port.port_name), ["COM3", "COM4", "COM10"]);

  // COM4 opens but stays silent (Windows' incoming port); COM5 talks.
  let current = null;
  const connected = [];
  const deps = {
    connect: async (port) => { current = port; connected.push(port); },
    readStatus: async () => (current === "COM5" ? reading("+000.500 kg\r\n") : { status: "reading", port_name: current, text: "", last_data_at_ms: null, now_ms: 1 }),
    disconnect: async () => { current = null; },
    wait: async () => {},
    listenMs: 1000,
  };
  const found = await findScalePort({ ...deps, ports: [{ port_name: "COM4", kind: "unknown" }, { port_name: "COM5", kind: "unknown" }] });
  assert.deepEqual(found, { port: "COM5", tried: ["COM4", "COM5"] });
  assert.equal(current, "COM5", "left connected to the scale it found");

  const failing = { ...deps, connect: async (port) => { connected.push(port); throw new Error("Access is denied"); } };
  const none = await findScalePort({ ...failing, ports: [{ port_name: "COM7", kind: "pci" }] });
  assert.equal(none.port, null);
  assert.match(none.message, /No scale answered on COM7/);
  assert.match((await findScalePort({ ...deps, ports: [] })).message, /no serial ports/);
});

test("saved port: per computer, and a storage that throws is not a crash", () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: (key) => store.delete(key) };
  assert.equal(readSavedScalePort(storage), "");
  assert.equal(saveScalePort(storage, "COM5"), true);
  assert.equal(readSavedScalePort(storage), "COM5");
  saveScalePort(storage, "");
  assert.equal(readSavedScalePort(storage), "");
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(readSavedScalePort(broken), "");
  assert.equal(saveScalePort(broken, "COM5"), false);
});

test("errors: Windows' words become what to do, and a reader that is retrying says so", () => {
  assert.match(plainScaleError("COM12 could not be opened: The semaphore timeout period has expired.", "COM12"), /did not answer on COM12.*phone's iScale app/);
  assert.match(plainScaleError("COM12 could not be opened: Access is denied.", "COM12"), /being used by another program/);
  assert.match(plainScaleError("COM9 could not be opened: The system cannot find the file specified.", "COM9"), /not on this computer any more.*PIN 0111/);
  assert.match(plainScaleError("The link to the scale on COM12 dropped: broken pipe", "COM12"), /dropped.*ON and in range/);
  assert.equal(plainScaleError("something new", "COM3"), "The scale on COM3 is not working: something new");
  assert.equal(plainScaleError(null, "COM3"), "The scale on COM3 is not working.");

  const retrying = describeScale({ status: "failed", retrying: true, attempts: 4, port_name: "COM12", error: "COM12 could not be opened: The semaphore timeout period has expired." });
  assert.equal(retrying.state, SCALE_STATES.RETRYING);
  assert.equal(retrying.kg, null);
  assert.match(retrying.message, /did not answer on COM12.*Trying again by itself/);
  const again = describeScale({ status: "connecting", attempts: 5, port_name: "COM12", error: "COM12 could not be opened: The semaphore timeout period has expired." });
  assert.equal(again.state, SCALE_STATES.RETRYING, "between tries it still says why");
  assert.equal(describeScale({ status: "connecting", attempts: 1, port_name: "COM12" }).state, SCALE_STATES.CONNECTING);
  const stopped = describeScale({ status: "failed", retrying: false, port_name: "COM12", error: "COM12 could not be opened: Access is denied." });
  assert.equal(stopped.state, SCALE_STATES.FAILED);
  assert.match(stopped.message, /Then press Connect or Find scale/);
});
