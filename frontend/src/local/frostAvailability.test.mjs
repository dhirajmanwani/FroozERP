import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  DETERMINISTIC_PROVIDER_OPTION,
  FROST_PROVIDER_LIST_UNAVAILABLE_MESSAGE,
  describeFrostTransportFailure,
  resolveFrostDataSource,
  resolveFrostLoadDecision,
  resolveFrostProviderOptions,
} from "./frostAvailability.js";

const appSource = await readFile(new URL("../App.jsx", import.meta.url), "utf8");

test("a desktop shell reads FROST from the cloud however local its API URL looks", () => {
  // The desktop's API URL is the local gateway, and the gateway forwards every /api/ai/ route
  // onward. Judging the source by the address said "local" for 127.0.0.1 and was wrong.
  for (const apiUrl of ["http://localhost:5051", "http://127.0.0.1:5051", "http://[::1]:5051/"]) {
    assert.equal(resolveFrostDataSource({ apiUrl, cloudApiMode: false, desktopShell: true }), "cloud");
  }
  assert.equal(resolveFrostDataSource({ apiUrl: "https://froozerp.example.com", cloudApiMode: true }), "cloud");
});

test("a browser against a FROST-serving backend is still local", () => {
  for (const apiUrl of ["http://localhost:5000", "http://127.0.0.1:5000", "http://[::1]:5000/"]) {
    assert.equal(resolveFrostDataSource({ apiUrl, cloudApiMode: false, desktopShell: false }), "local");
  }
});

test("a desktop FROST refuses with the cloud down, because that is where its data is", () => {
  const decision = resolveFrostLoadDecision({
    apiUrl: "http://127.0.0.1:5051",
    cloudApiMode: false,
    desktopShell: true,
    internetAvailable: false,
    cloudOnline: false,
  });
  assert.equal(decision.shouldLoad, false);
  assert.match(decision.reason, /requires cloud access/);

  // ...and loads when the cloud is there, rather than refusing on the address alone.
  assert.equal(resolveFrostLoadDecision({
    apiUrl: "http://127.0.0.1:5051",
    cloudApiMode: false,
    desktopShell: true,
    internetAvailable: true,
    cloudOnline: true,
  }).shouldLoad, true);
});

test("a cloud-hosted FROST still refuses when there is no cloud to read", () => {
  const offline = resolveFrostLoadDecision({
    apiUrl: "https://froozerp.example.com",
    cloudApiMode: true,
    internetAvailable: false,
    cloudOnline: null,
  });
  assert.equal(offline.shouldLoad, false);
  assert.match(offline.reason, /requires cloud access/);

  const cloudDown = resolveFrostLoadDecision({
    apiUrl: "https://froozerp.example.com",
    cloudApiMode: true,
    internetAvailable: true,
    cloudOnline: false,
  });
  assert.equal(cloudDown.shouldLoad, false);

  const healthy = resolveFrostLoadDecision({
    apiUrl: "https://froozerp.example.com",
    cloudApiMode: true,
    internetAvailable: true,
    cloudOnline: true,
  });
  assert.equal(healthy.shouldLoad, true);
});

test("a provider list that did not arrive is reported, not drawn as a one-option choice", () => {
  for (const value of [[], null, undefined, "not a list", [{}, { key: "" }, { label: "No key" }]]) {
    const resolved = resolveFrostProviderOptions(value);
    assert.equal(resolved.usable, false);
    assert.equal(resolved.message, FROST_PROVIDER_LIST_UNAVAILABLE_MESSAGE);
    assert.deepEqual(resolved.options, [DETERMINISTIC_PROVIDER_OPTION]);
  }
});

test("a provider list that arrived keeps the built-in option first and says nothing is wrong", () => {
  const resolved = resolveFrostProviderOptions([
    { key: "openai", label: "OpenAI" },
    { key: "ollama", label: "Local Ollama" },
  ]);
  assert.equal(resolved.usable, true);
  assert.equal(resolved.message, "");
  assert.deepEqual(resolved.options.map((option) => option.key), ["deterministic", "openai", "ollama"]);
});

test("a provider already saved stays visible when the list could not be read", () => {
  const resolved = resolveFrostProviderOptions([], "ollama");
  assert.equal(resolved.usable, false);
  assert.deepEqual(resolved.options.map((option) => option.key), ["deterministic", "ollama"]);
  assert.match(resolved.options[1].label, /list unavailable/);
  // Otherwise the select's value matches no option, the browser draws the first one, and a FROST
  // configured for a local model reads as "Deterministic only" on screen.
  assert.deepEqual(resolveFrostProviderOptions([], "deterministic").options, [DETERMINISTIC_PROVIDER_OPTION]);
  assert.deepEqual(resolveFrostProviderOptions([], "").options, [DETERMINISTIC_PROVIDER_OPTION]);
});

test("a backend that names deterministic itself does not produce two of it", () => {
  const resolved = resolveFrostProviderOptions([
    { key: "deterministic", label: "Deterministic only" },
    { key: "ollama", label: "Local Ollama" },
  ]);
  assert.deepEqual(resolved.options.map((option) => option.key), ["deterministic", "ollama"]);
});

test("a refused connection to this machine names this machine, not the cloud", () => {
  assert.match(
    describeFrostTransportFailure({ apiUrl: "http://127.0.0.1:5051", cloudApiMode: false, status: null }),
    /server on this machine/,
  );
  assert.match(
    describeFrostTransportFailure({ apiUrl: "https://froozerp.example.com", cloudApiMode: true, status: null }),
    /requires cloud access/,
  );
});

test("a failure that carries a status is left to the caller's own ladder", () => {
  assert.equal(describeFrostTransportFailure({ apiUrl: "http://127.0.0.1:5051", status: 403 }), "");
  assert.equal(describeFrostTransportFailure({ apiUrl: "http://127.0.0.1:5051", status: 503 }), "");
});

test("App.jsx resolves FROST availability through this module, desktop shell included", () => {
  assert.match(appSource, /resolveFrostLoadDecision\(/);
  assert.match(appSource, /resolveFrostProviderOptions\(/);
  // Both decision call sites must say whether this is the desktop shell. Without it the resolver
  // reads 127.0.0.1 as "FROST is served here", which is the mistake this module was corrected for.
  assert.equal((appSource.match(/desktopShell: isDesktopShell\(\)/g) || []).length, 2);
});
