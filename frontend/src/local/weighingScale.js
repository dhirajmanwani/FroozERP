/**
 * The counter's weighing scale (23 Oct 2026): what the desktop app's scale reader heard, read as a
 * weight the POS can bill.
 *
 * The shop's scale is an iScale Smart Bluetooth scale. Its manual: Bluetooth SPP (a COM port on
 * Windows), 9600 bps 8N1, and once connected it sends its live weight over and over as plain
 * ASCII, "+001.250 kg". `src-tauri/src/weighing_scale.rs` only moves bytes and keeps the newest
 * characters; everything about what they mean is here, where it is testable.
 *
 * Rules the POS relies on:
 *   - Only a whole reading counts. The kept text ends wherever the last read stopped, so its last
 *     piece is usually half a reading and is ignored.
 *   - A weight is used only once it is steady: the same reading for `SCALE_STEADY_MS`. A fruit
 *     still swinging on the pan is never billed.
 *   - A scale that is off, unpaired, silent, sending rubbish or below zero is a state with words,
 *     never a weight of 0.
 *   - Adding an item takes a steady weight once. The same weight is not taken again for the next
 *     item until the scale shows a new steady weight (`SCALE_STEADY` reading ids); F6 reads the
 *     current steady weight whenever asked.
 *   - Weight is for items sold by the kg only. A piece, box or dozen item is never given a weight.
 *
 * Local only: a COM port is not the network, so none of this touches LOCAL_ONLY.
 */

export const SCALE_PORT_STORAGE_KEY = "froozerp.weighingScale.port";
/** The same reading for this long is a steady weight. */
export const SCALE_STEADY_MS = 700;
/** No byte for this long while connected: the scale has stopped sending. */
export const SCALE_SILENT_MS = 3000;
/** Two readings within this many kg are the same reading (the scale's own last digit). */
export const SCALE_SAME_KG = 0.002;
/** How long "Find scale" listens on one port before trying the next. */
export const SCALE_SEARCH_LISTEN_MS = 5000;

export const SCALE_STATES = Object.freeze({
  UNAVAILABLE: "unavailable",
  OFF: "off",
  CONNECTING: "connecting",
  WAITING: "waiting",
  SILENT: "silent",
  FAILED: "failed",
  UNREADABLE: "unreadable",
  NEGATIVE: "negative",
  LIVE: "live",
});

const READING_WITH_UNIT = /([+-])?\s*(\d{1,5}(?:\.\d{1,4})?)\s*(kg|g|lb)\b/i;
const BARE_READING = /^([+-])?\s*(\d{1,5}(?:\.\d{1,4})?)$/;
const UNIT_TO_KG = { kg: 1, g: 0.001, lb: 0.45359237 };

const roundKg = (value) => Math.round(value * 1000) / 1000;

/** The readings in the kept text that are whole, oldest first. */
const wholeReadings = (text) => {
  const lines = text.split(/[\r\n]+/);
  // With line ends, the piece after the last one is still arriving (or is "" when the text ended
  // on a line end).
  if (lines.length > 1) return lines.slice(0, -1);
  // A scale that sends no line ends: each reading starts with its sign. The last piece is whole
  // only if it already has its unit.
  const pieces = text.split(/(?=[+-]\s*\d)/);
  const last = pieces.at(-1) || "";
  return /(kg|g|lb)\s*$/i.test(last) ? pieces : pieces.slice(0, -1);
};

/**
 * The newest whole reading in the text the scale sent:
 *   { status: "weight", kg, raw }      kg to 3 decimals, negative when the scale shows below zero
 *   { status: "unreadable", raw }       the newest whole piece is not a weight
 *   { status: "none" }                  nothing whole yet
 */
export const parseScaleText = (text) => {
  const value = typeof text === "string" ? text : "";
  const readings = wholeReadings(value);
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    const raw = readings[index].trim();
    if (!raw) continue;
    const withUnit = READING_WITH_UNIT.exec(raw);
    const bare = withUnit ? null : BARE_READING.exec(raw);
    const match = withUnit || bare;
    if (!match) return { status: "unreadable", raw: raw.slice(0, 40) };
    const unit = String(withUnit?.[3] || "kg").toLowerCase();
    const amount = Number(match[2]) * (UNIT_TO_KG[unit] ?? 1);
    if (!Number.isFinite(amount)) return { status: "unreadable", raw: raw.slice(0, 40) };
    const kg = roundKg(match[1] === "-" ? -amount : amount);
    return { status: "weight", kg: Object.is(kg, -0) ? 0 : kg, raw };
  }
  return { status: "none" };
};

const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

export const formatKg = (kg) => `${Number(kg).toLocaleString("en-IN", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} kg`;

/**
 * What the scale is doing, from the reader's status (`scale_status`), as words and at most one
 * weight. `steady` is the reducer state from `nextSteadiness`. Never a weight on any failure.
 */
export const describeScale = (status, steady = null) => {
  if (!status || typeof status !== "object") {
    return { state: SCALE_STATES.UNAVAILABLE, kg: null, steady: false, readingId: null, message: "The weighing scale works in the desktop app only." };
  }
  const port = typeof status.port_name === "string" && status.port_name ? status.port_name : "the scale's port";
  const nowMs = finite(status.now_ms) ?? Date.now();
  switch (status.status) {
    case "idle":
      return { state: SCALE_STATES.OFF, kg: null, steady: false, readingId: null, message: "Scale not connected. Connect it in Settings > Weighing Scale." };
    case "connecting":
      return { state: SCALE_STATES.CONNECTING, kg: null, steady: false, readingId: null, message: `Connecting to the scale on ${port}…` };
    case "failed":
      return {
        state: SCALE_STATES.FAILED,
        kg: null,
        steady: false,
        readingId: null,
        message: `Scale not working: ${status.error || `${port} stopped`}. Check the scale is ON and paired, then connect again.`,
      };
    case "reading":
      break;
    default:
      return { state: SCALE_STATES.FAILED, kg: null, steady: false, readingId: null, message: `The scale reader said something unexpected ("${String(status.status)}").` };
  }
  const lastData = finite(status.last_data_at_ms);
  if (lastData === null) {
    return { state: SCALE_STATES.WAITING, kg: null, steady: false, readingId: null, message: `Connected to ${port}. Waiting for the scale to send a weight: check it is ON.` };
  }
  if (nowMs - lastData > SCALE_SILENT_MS) {
    return { state: SCALE_STATES.SILENT, kg: null, steady: false, readingId: null, message: "The scale stopped sending. Check it is ON and in range of this computer." };
  }
  const reading = parseScaleText(status.text);
  if (reading.status === "none") {
    return { state: SCALE_STATES.WAITING, kg: null, steady: false, readingId: null, message: `Connected to ${port}. Waiting for a whole reading…` };
  }
  if (reading.status === "unreadable") {
    return { state: SCALE_STATES.UNREADABLE, kg: null, steady: false, readingId: null, message: `The scale sent something that is not a weight ("${reading.raw}"). Is this the right port?` };
  }
  if (reading.kg < 0) {
    return { state: SCALE_STATES.NEGATIVE, kg: null, steady: false, readingId: null, message: `The scale shows below zero (${formatKg(reading.kg)}). Empty the pan and press its zero/tare key.` };
  }
  const isSteady = Boolean(steady && steady.steady && Math.abs(steady.kg - reading.kg) <= SCALE_SAME_KG);
  return {
    state: SCALE_STATES.LIVE,
    kg: reading.kg,
    steady: isSteady,
    readingId: isSteady ? steady.readingId : null,
    message: isSteady ? `Scale: ${formatKg(reading.kg)}` : `Scale: ${formatKg(reading.kg)} (settling…)`,
  };
};

export const createSteadiness = () => ({ kg: null, since: null, steady: false, readingId: 0 });

/**
 * One poll of the scale folded into the steadiness state. A reading that holds within
 * `SCALE_SAME_KG` for `SCALE_STEADY_MS` becomes steady, and each new steady weight gets a new
 * `readingId` (so a weight taken for one item is not taken again for the next).
 */
export const nextSteadiness = (previous, status) => {
  const state = previous || createSteadiness();
  const nowMs = finite(status?.now_ms) ?? Date.now();
  const lastData = finite(status?.last_data_at_ms);
  const reading = status?.status === "reading" && lastData !== null && nowMs - lastData <= SCALE_SILENT_MS
    ? parseScaleText(status.text)
    : { status: "none" };
  if (reading.status !== "weight") return { ...state, kg: null, since: null, steady: false };
  if (state.kg === null || Math.abs(reading.kg - state.kg) > SCALE_SAME_KG) {
    return { ...state, kg: reading.kg, since: nowMs, steady: false };
  }
  if (state.steady) return state;
  if (nowMs - state.since >= SCALE_STEADY_MS) return { ...state, steady: true, readingId: state.readingId + 1 };
  return state;
};

/** Sold by the kg: the only unit a scale weight is ever put on. */
export const isWeighedUnit = (unit) => String(unit || "").trim().toUpperCase() === "KG";

/**
 * The quantity a weight gives an item of `unit`, or null. `takenReadingId` is the steady weight
 * already used (pass null to read the current one regardless, as F6 does). Zero is no weight.
 */
export const scaleQuantityFor = (unit, view, takenReadingId = null) => {
  if (!isWeighedUnit(unit)) return null;
  if (!view || view.state !== SCALE_STATES.LIVE || !view.steady) return null;
  if (!(typeof view.kg === "number" && view.kg > 0)) return null;
  if (takenReadingId !== null && view.readingId === takenReadingId) return null;
  return roundKg(view.kg);
};

const PORT_KIND_ORDER = { bluetooth: 0, unknown: 1, usb: 2, pci: 3 };

/** Ports in the order "Find scale" tries them: Bluetooth first, then the ones Windows cannot name. */
export const orderPortsForSearch = (ports) => (Array.isArray(ports) ? ports : [])
  .filter((port) => port && typeof port.port_name === "string" && port.port_name.trim())
  .slice()
  .sort((left, right) => (
    ((PORT_KIND_ORDER[left.kind] ?? 4) - (PORT_KIND_ORDER[right.kind] ?? 4))
    || left.port_name.localeCompare(right.port_name, "en", { numeric: true })
  ));

/**
 * Try each port until one sends a weight. Windows makes two COM ports for one Bluetooth device
 * and only one of them talks, so the owner should not have to guess. Every dependency is passed
 * in: `connect(port)`, `readStatus()`, `disconnect()` (the Tauri commands) and `wait(ms)`.
 * Answers { port, view } for the port that answered, or { port: null, tried, message }.
 */
export const findScalePort = async ({ ports, connect, readStatus, disconnect, wait, listenMs = SCALE_SEARCH_LISTEN_MS, stepMs = 250, onTry = null }) => {
  const ordered = orderPortsForSearch(ports);
  const tried = [];
  for (const port of ordered) {
    tried.push(port.port_name);
    onTry?.(port.port_name);
    try {
      await connect(port.port_name);
    } catch {
      continue;
    }
    for (let waited = 0; waited < listenMs; waited += stepMs) {
      await wait(stepMs);
      let status;
      try {
        status = await readStatus();
      } catch {
        break;
      }
      if (status?.status === "failed") break;
      const reading = status?.status === "reading" ? parseScaleText(status.text) : { status: "none" };
      if (reading.status === "weight") return { port: port.port_name, tried };
    }
  }
  try {
    await disconnect();
  } catch {
    // Nothing was found either way; the message below says so.
  }
  return {
    port: null,
    tried,
    message: tried.length === 0
      ? "This computer has no serial ports. Pair the scale in Windows Bluetooth settings (PIN 0111), then try again."
      : `No scale answered on ${tried.join(", ")}. Check the scale is ON and paired in Windows Bluetooth settings (PIN 0111), then try again.`,
  };
};

export const readSavedScalePort = (storage) => {
  try {
    const value = storage?.getItem(SCALE_PORT_STORAGE_KEY);
    return typeof value === "string" && value.trim() ? value.trim() : "";
  } catch {
    return "";
  }
};

export const saveScalePort = (storage, port) => {
  try {
    if (port) storage?.setItem(SCALE_PORT_STORAGE_KEY, port);
    else storage?.removeItem(SCALE_PORT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
};
