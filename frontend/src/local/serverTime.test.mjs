import test from "node:test";
import assert from "node:assert/strict";

const storage = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  },
};

const {
  canonicalUtcIso,
  formatKolkataDateTime,
  formatKolkataHeaderClock,
  getTimeDiagnostics,
  markServerTimeOffline,
  observeServerTime,
} = await import("./serverTime.js");

test("server midpoint produces a synced clock offset", () => {
  observeServerTime({
    serverTime: "2026-07-15T00:00:01.100Z",
    requestStartedAt: Date.parse("2026-07-15T00:00:01.000Z"),
    responseReceivedAt: Date.parse("2026-07-15T00:00:01.200Z"),
  });
  const diagnostics = getTimeDiagnostics();
  assert.equal(diagnostics.clockOffsetSeconds, 0);
  assert.equal(diagnostics.timeStatus, "Synced");
  assert.match(diagnostics.railwayServerUtcTime, /\.100Z$/);
});

test("clock drift above sixty seconds is detected", () => {
  observeServerTime({
    serverTime: "2026-07-15T00:02:00.000Z",
    requestStartedAt: Date.parse("2026-07-15T00:00:00.000Z"),
    responseReceivedAt: Date.parse("2026-07-15T00:00:00.200Z"),
  });
  assert.equal(getTimeDiagnostics().timeStatus, "Drift detected");
  assert.equal(markServerTimeOffline().timeStatus, "Offline");
});

test("timestamps serialize as UTC and display in Asia Kolkata", () => {
  assert.equal(canonicalUtcIso("2026-07-15T00:00:00+05:30"), "2026-07-14T18:30:00.000Z");
  assert.match(formatKolkataDateTime("2026-07-14T18:30:00.000Z"), /^15\/07\/2026 12:00:00 am$/i);
  assert.equal(formatKolkataHeaderClock("2026-07-21T10:15:20.000Z"), "21 Jul 2026 \u00b7 03:45:20 PM \u00b7 IST");
});
