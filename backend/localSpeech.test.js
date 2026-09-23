"use strict";

/**
 * FROST live voice: on-device speech-to-text in the desktop gateway.
 *
 * What these tests hold in place, in the order a regression would hurt:
 *
 *   1. LOCAL_ONLY. Installing is the only external connection voice adds. In LOCAL_ONLY it is
 *      refused before any request (zero calls to the fetcher), audited as blocked, and a switch to
 *      LOCAL_ONLY during a download stops it.
 *   2. Integrity. Nothing is used that has not matched its pinned hash; a mismatch deletes the file
 *      and ends in "failed", never "ready". The zip reader takes only the five named entries and
 *      refuses an archive carrying a traversal name.
 *   3. The audio. The WAV reaches the engine byte-for-byte, is validated first, is written to a temp
 *      file that is always deleted, and the engine is killed when it overruns.
 *   4. The gateway. Speech routes are served locally and never proxied, refuse a website's origin,
 *      and cap the body before buffering it.
 *
 * Nothing here contacts the network: downloads go through an injected fetcher, and the gateway's
 * cloud target is a stand-in on 127.0.0.1 that must receive nothing.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { Readable } = require("node:stream");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const speechModule = require("./localSpeech");
const {
  ENGINE_ASSET,
  MODEL_ASSETS,
  buildEngineArgs,
  cleanTranscript,
  crc32,
  createLocalSpeech,
  describeEngineExit,
  engineFileNames,
  extractZipEntries,
  resolveSpeechDir,
  validateWav,
} = speechModule;

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const createdDirs = [];
const tempDir = (label) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `froozerp-speech-${label}-`));
  createdDirs.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of createdDirs) fs.rmSync(dir, { recursive: true, force: true });
});
const sha = (algorithm, data) => crypto.createHash(algorithm).update(data).digest("hex");
// Independent of the module's own CRC so a broken implementation cannot agree with itself.
const referenceCrc32 = (data) => zlib.crc32(data) >>> 0;

/** Build a zip in memory. Each entry: { name, data, method = 8, crc, localName }. */
const buildZip = (entries) => {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const data = Buffer.from(entry.data);
    const method = entry.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = entry.crc ?? referenceCrc32(data);
    const name = Buffer.from(entry.name, "utf8");
    const localName = Buffer.from(entry.localName ?? entry.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    parts.push(local, localName, body);
    central.push(record, name);
    offset += local.length + localName.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
};

/** Distinct, compressible-and-not content per engine file. */
const engineEntries = () => ENGINE_ASSET.entries.map((name, index) => ({
  name,
  data: Buffer.concat([Buffer.from(`${name}\n`.repeat(200)), crypto.randomBytes(512 + index)]),
  method: index % 2 === 0 ? 8 : 0,
}));

const makeWav = ({ sampleRate = 16000, channels = 1, bits = 16, format = 1, seconds = 1, riff = "RIFF", fill = null } = {}) => {
  const dataSize = Math.round(sampleRate * seconds) * channels * (bits / 8);
  const header = Buffer.alloc(44);
  header.write(riff, 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(format, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * (bits / 8), 28);
  header.writeUInt16LE(channels * (bits / 8), 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  const data = fill ? Buffer.alloc(dataSize, fill) : crypto.randomBytes(dataSize);
  return Buffer.concat([header, data]);
};

/**
 * An injected fetcher. `routes` maps a URL to a response spec, or to a function returning one:
 * { status, headers, body (Buffer), chunks ([Buffer]), stream (Readable) }.
 */
const fakeFetcher = (routes) => {
  const calls = [];
  const request = async (url) => {
    calls.push(url);
    let spec = routes[url];
    if (typeof spec === "function") spec = spec(url);
    if (!spec) return { statusCode: 404, headers: {}, body: Readable.from([]) };
    const body = spec.stream || Readable.from(spec.chunks || (spec.body ? [spec.body] : []));
    return { statusCode: spec.status || 200, headers: spec.headers || {}, body };
  };
  return { request, calls };
};

const testAssets = ({ zip, modelBytes = crypto.randomBytes(4096) } = {}) => {
  const engineAsset = {
    ...ENGINE_ASSET,
    url: "https://github.test/whisper-bin-x64.zip",
    hash: sha("sha256", zip),
    size: zip.length,
  };
  const modelAssets = {
    small: { ...MODEL_ASSETS.small, url: "https://hf.test/ggml-small.bin", hash: sha("sha1", modelBytes) },
    base: { ...MODEL_ASSETS.base, url: "https://hf.test/ggml-base.bin", hash: sha("sha1", Buffer.from("base-model")) },
  };
  return { engineAsset, modelAssets, modelBytes };
};

const auditLog = () => {
  const entries = [];
  return { entries, audit: (entry) => entries.push(entry) };
};

const leftovers = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.includes(".part-")) : []);

// ---------------------------------------------------------------------------------------------
// Pinned values and paths
// ---------------------------------------------------------------------------------------------

test("the pinned engine and models are the ones in the contract", () => {
  assert.equal(ENGINE_ASSET.url, "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.7/whisper-bin-x64.zip");
  assert.equal(ENGINE_ASSET.algorithm, "sha256");
  assert.equal(ENGINE_ASSET.hash, "d9627486e1c34a03745880485593473e047294260ce9a3cb0aa8deaf15b99af6");
  assert.equal(ENGINE_ASSET.size, 4386743);
  assert.deepEqual([...ENGINE_ASSET.entries], [
    "Release/whisper-cli.exe",
    "Release/whisper.dll",
    "Release/ggml.dll",
    "Release/ggml-base.dll",
    "Release/ggml-cpu.dll",
  ]);
  assert.deepEqual(Object.keys(MODEL_ASSETS).sort(), ["base", "small"]);
  assert.equal(MODEL_ASSETS.small.url, "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin");
  assert.equal(MODEL_ASSETS.small.hash, "55356645c2b361a969dfd0ef2c5a50d530afd8d5");
  assert.equal(MODEL_ASSETS.base.url, "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin");
  assert.equal(MODEL_ASSETS.base.hash, "465707469ff3a37a2b9b8d8f89f2f99de7299dac");
  for (const model of Object.values(MODEL_ASSETS)) assert.equal(model.algorithm, "sha1");
});

test("the speech directory is shared across profiles, with an explicit override", () => {
  assert.equal(resolveSpeechDir({ env: { FROOZERP_SPEECH_DIR: "/x/speech" }, platform: "win32", homedir: "/h" }), path.resolve("/x/speech"));
  assert.equal(
    resolveSpeechDir({ env: { LOCALAPPDATA: "C:\\Users\\o\\AppData\\Local" }, platform: "win32", homedir: "/h" }),
    path.join("C:\\Users\\o\\AppData\\Local", "FroozERP", "speech"),
  );
  assert.equal(resolveSpeechDir({ env: {}, platform: "linux", homedir: "/home/o" }), path.join("/home/o", ".local", "share", "froozerp", "speech"));
  // Not derived from the profile / app-data directory: a disposable rehearsal must not re-download.
  assert.equal(
    resolveSpeechDir({ env: { FROOZERP_APP_DATA_DIR: "/isolated", LOCALAPPDATA: "/lad" }, platform: "win32", homedir: "/h" }),
    path.join("/lad", "FroozERP", "speech"),
  );
  assert.deepEqual(engineFileNames("win32"), ["whisper-cli.exe", "whisper.dll", "ggml.dll", "ggml-base.dll", "ggml-cpu.dll"]);
  assert.deepEqual(engineFileNames("linux"), ["whisper-cli"]);
});

test("localSpeech.js requires node built-ins only, because it ships without node_modules", () => {
  const source = fs.readFileSync(path.join(__dirname, "localSpeech.js"), "utf8");
  const required = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
  const builtins = new Set(require("node:module").builtinModules);
  assert.ok(required.length > 0);
  for (const name of required) assert.ok(builtins.has(name.replace(/^node:/, "")), `${name} is not a node built-in`);
});

test("every file the gateway requires is bundled with the installer", () => {
  const conf = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src-tauri", "tauri.conf.json"), "utf8"));
  const resources = conf.bundle.resources;
  const gateway = fs.readFileSync(path.join(__dirname, "desktopGateway.js"), "utf8");
  const relative = [...gateway.matchAll(/require\(\s*["'](\.\/[^"']+)["']\s*\)/g)].map((match) => match[1]);
  assert.ok(relative.includes("./localSpeech"), "the gateway serves speech through localSpeech.js");
  for (const name of relative) {
    const file = name.endsWith(".js") ? name.slice(2) : `${name.slice(2)}.js`;
    assert.ok(resources.includes(`../backend/${file}`), `${file} is required by the gateway but missing from bundle.resources`);
  }
});

// ---------------------------------------------------------------------------------------------
// The zip reader
// ---------------------------------------------------------------------------------------------

test("the zip reader takes exactly the named entries, stored and deflated, byte for byte", () => {
  const entries = engineEntries();
  const zip = buildZip([
    { name: "Release/SDL2.dll", data: Buffer.from("not wanted") },
    ...entries,
    { name: "Release/whisper-server.exe", data: Buffer.from("not wanted either") },
  ]);
  const extracted = extractZipEntries(zip, ENGINE_ASSET.entries);
  assert.deepEqual([...extracted.keys()].sort(), [...ENGINE_ASSET.entries].sort());
  for (const entry of entries) assert.ok(extracted.get(entry.name).equals(entry.data), entry.name);
  const sample = crypto.randomBytes(1000);
  assert.equal(crc32(sample), referenceCrc32(sample));
});

test("an archive carrying a traversal or absolute entry name is refused whole", () => {
  for (const evil of ["../whisper-cli.exe", "Release/../../evil.dll", "/etc/evil", "C:/Windows/evil.dll", "Release\\..\\evil.dll", ".."]) {
    const zip = buildZip([...engineEntries(), { name: evil, data: Buffer.from("payload") }]);
    assert.throws(() => extractZipEntries(zip, ENGINE_ASSET.entries), /unsafe entry name/, evil);
  }
  // A wanted name reached through a traversal is not the wanted name.
  const sneaky = engineEntries().map((entry) => (entry.name === "Release/whisper.dll" ? { ...entry, name: "Release/x/../whisper.dll" } : entry));
  assert.throws(() => extractZipEntries(buildZip(sneaky), ENGINE_ASSET.entries), /unsafe entry name/);
});

test("a damaged archive is refused rather than partly extracted", () => {
  const entries = engineEntries();
  assert.throws(() => extractZipEntries(buildZip(entries.slice(1)), ENGINE_ASSET.entries), /missing Release\/whisper-cli\.exe/);
  assert.throws(() => extractZipEntries(buildZip([...entries, entries[0]]), ENGINE_ASSET.entries), /duplicate entry/);
  const badCrc = entries.map((entry, index) => (index === 2 ? { ...entry, crc: (referenceCrc32(entry.data) ^ 1) >>> 0 } : entry));
  assert.throws(() => extractZipEntries(buildZip(badCrc), ENGINE_ASSET.entries), /CRC/);
  const renamed = entries.map((entry, index) => (index === 1 ? { ...entry, localName: "Release/whisper.dlX" } : entry));
  assert.throws(() => extractZipEntries(buildZip(renamed), ENGINE_ASSET.entries), /local header name disagrees/);
  assert.throws(() => extractZipEntries(Buffer.from("PK not really a zip file at all........"), ENGINE_ASSET.entries), /refused/);
});

// ---------------------------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------------------------

test("install downloads, verifies, extracts only the five files and reports ready", async () => {
  const speechDir = tempDir("install");
  const entries = engineEntries();
  const zip = buildZip([...entries, { name: "Release/stream.exe", data: Buffer.from("ignored") }]);
  const { engineAsset, modelAssets, modelBytes } = testAssets({ zip });
  const fetcher = fakeFetcher({
    [engineAsset.url]: { chunks: [zip.subarray(0, 1000), zip.subarray(1000)], headers: { "content-length": String(zip.length) } },
    [modelAssets.small.url]: { body: modelBytes, headers: { "content-length": String(modelBytes.length) } },
  });
  const { entries: audits, audit } = auditLog();
  const speech = createLocalSpeech({ speechDir, platform: "win32", readPolicy: () => ({ allowInternetAccess: true }), audit, request: fetcher.request, engineAsset, modelAssets });

  assert.equal(speech.status().state, "not_installed");
  const started = speech.install({});
  assert.equal(started.status, 202);
  assert.equal(started.body.state, "installing");
  assert.equal(started.body.model, "small");
  await speech.whenInstalled();

  const status = speech.status();
  assert.equal(status.state, "ready", status.error);
  assert.equal(status.model, "small");
  assert.equal(status.error, null);
  assert.deepEqual(status.progress, { phase: null, received_bytes: 0, total_bytes: 0 });
  assert.deepEqual(fetcher.calls, [engineAsset.url, modelAssets.small.url]);
  const onDisk = fs.readdirSync(speechDir).sort();
  assert.deepEqual(onDisk, ["ggml-base.dll", "ggml-cpu.dll", "ggml-small.bin", "ggml.dll", "speech-install.json", "whisper-cli.exe", "whisper.dll"]);
  for (const entry of entries) assert.ok(fs.readFileSync(path.join(speechDir, entry.name.split("/").pop())).equals(entry.data));
  assert.ok(fs.readFileSync(path.join(speechDir, "ggml-small.bin")).equals(modelBytes));
  // Every outbound request is on the record as an external connection, none as the cloud.
  assert.equal(audits.length, 2);
  assert.ok(audits.every((entry) => entry.source === "speech-install" && entry.externalConnection === true && entry.reachedCloud === false && entry.blocked === false));

  // A second install finds verified files present and downloads nothing again.
  assert.equal(speech.install({ model: "small" }).status, 202);
  await speech.whenInstalled();
  assert.equal(speech.status().state, "ready");
  assert.equal(fetcher.calls.length, 2, "a verified file already present is not downloaded again");
});

test("a hash mismatch ends in failed, with the file deleted and nothing renamed into place", async () => {
  const speechDir = tempDir("mismatch");
  const zip = buildZip(engineEntries());
  const { engineAsset, modelAssets } = testAssets({ zip });
  const tampered = Buffer.from(zip);
  tampered[10] ^= 0xff;
  const fetcher = fakeFetcher({ [engineAsset.url]: { body: tampered } });
  const speech = createLocalSpeech({ speechDir, platform: "win32", readPolicy: () => ({ allowInternetAccess: true }), request: fetcher.request, engineAsset, modelAssets });
  assert.equal(speech.install({ model: "small" }).status, 202);
  await speech.whenInstalled();
  const status = speech.status();
  assert.equal(status.state, "failed");
  assert.match(status.error, /failed verification/);
  assert.deepEqual(fs.readdirSync(speechDir), [], "neither the bad zip nor a temp file may remain");

  // Same for the model, after a good engine.
  const dir2 = tempDir("mismatch-model");
  const fetcher2 = fakeFetcher({ [engineAsset.url]: { body: zip }, [modelAssets.small.url]: { body: Buffer.from("not the model") } });
  const speech2 = createLocalSpeech({ speechDir: dir2, platform: "win32", readPolicy: () => ({ allowInternetAccess: true }), request: fetcher2.request, engineAsset, modelAssets });
  speech2.install({});
  await speech2.whenInstalled();
  assert.equal(speech2.status().state, "failed");
  assert.equal(fs.existsSync(path.join(dir2, "ggml-small.bin")), false);
  assert.deepEqual(leftovers(dir2), []);

  // A model file already present that does not verify is replaced, not trusted.
  const dir3 = tempDir("mismatch-present");
  const assets3 = testAssets({ zip });
  const { modelBytes } = assets3;
  fs.writeFileSync(path.join(dir3, "ggml-small.bin"), "corrupt");
  const fetcher3 = fakeFetcher({ [engineAsset.url]: { body: zip }, [assets3.modelAssets.small.url]: { body: modelBytes } });
  const speech3 = createLocalSpeech({ speechDir: dir3, platform: "win32", readPolicy: () => ({ allowInternetAccess: true }), request: fetcher3.request, engineAsset: assets3.engineAsset, modelAssets: assets3.modelAssets });
  speech3.install({});
  await speech3.whenInstalled();
  assert.equal(speech3.status().state, "ready", speech3.status().error);
  assert.ok(fs.readFileSync(path.join(dir3, "ggml-small.bin")).equals(modelBytes));
});

test("redirects are followed (relative too), at most five, https only", async () => {
  const zip = buildZip(engineEntries());
  const { engineAsset, modelAssets, modelBytes } = testAssets({ zip });
  const redirect = (location, status = 302) => ({ status, headers: { location } });
  const fetcher = fakeFetcher({
    [engineAsset.url]: redirect("https://objects.github.test/release?sig=abc"),
    "https://objects.github.test/release?sig=abc": { body: zip },
    [modelAssets.small.url]: redirect("/cdn/ggml-small.bin", 307),
    "https://hf.test/cdn/ggml-small.bin": redirect("https://cdn-lfs.hf.test/blob?x=1", 301),
    "https://cdn-lfs.hf.test/blob?x=1": { body: modelBytes },
  });
  const { entries: audits, audit } = auditLog();
  const speechDir = tempDir("redirect");
  const speech = createLocalSpeech({ speechDir, platform: "win32", readPolicy: () => ({ allowInternetAccess: true }), audit, request: fetcher.request, engineAsset, modelAssets });
  speech.install({});
  await speech.whenInstalled();
  assert.equal(speech.status().state, "ready", speech.status().error);
  assert.equal(fetcher.calls.length, 5);
  assert.equal(audits.some((entry) => /sig=|x=1/.test(entry.route)), false, "signed query strings are not written to the audit log");

  // Five redirects is the limit; the sixth fails.
  const chain = (count) => {
    const routes = {};
    for (let i = 0; i < count; i += 1) routes[i === 0 ? engineAsset.url : `https://hop.test/${i}`] = redirect(`https://hop.test/${i + 1}`);
    routes[`https://hop.test/${count}`] = { body: zip };
    return routes;
  };
  const five = fakeFetcher({ ...chain(5), [modelAssets.small.url]: { body: modelBytes } });
  const okSpeech = createLocalSpeech({ speechDir: tempDir("five"), platform: "win32", readPolicy: () => ({ allowInternetAccess: true }), request: five.request, engineAsset, modelAssets });
  okSpeech.install({});
  await okSpeech.whenInstalled();
  assert.equal(okSpeech.status().state, "ready", okSpeech.status().error);

  const six = fakeFetcher({ ...chain(6), [modelAssets.small.url]: { body: modelBytes } });
  const tooMany = createLocalSpeech({ speechDir: tempDir("six"), platform: "win32", readPolicy: () => ({ allowInternetAccess: true }), request: six.request, engineAsset, modelAssets });
  tooMany.install({});
  await tooMany.whenInstalled();
  assert.equal(tooMany.status().state, "failed");
  assert.match(tooMany.status().error, /Too many redirects/);
  assert.equal(six.calls.length, 6);

  const downgrade = fakeFetcher({ [engineAsset.url]: redirect("http://plain.test/zip"), "http://plain.test/zip": { body: zip } });
  const insecure = createLocalSpeech({ speechDir: tempDir("http"), platform: "win32", readPolicy: () => ({ allowInternetAccess: true }), request: downgrade.request, engineAsset, modelAssets });
  insecure.install({});
  await insecure.whenInstalled();
  assert.equal(insecure.status().state, "failed");
  assert.match(insecure.status().error, /non-https/);
  assert.deepEqual(downgrade.calls, [engineAsset.url], "the plain-http address is never requested");
});

test("LOCAL_ONLY refuses install with zero requests, and audits the refusal", async () => {
  const speechDir = path.join(tempDir("local-only"), "speech");
  const fetcher = fakeFetcher({});
  const { entries: audits, audit } = auditLog();
  const speech = createLocalSpeech({ speechDir, readPolicy: () => ({ allowInternetAccess: false }), audit, request: fetcher.request });
  const result = speech.install({ model: "small" });
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "SPEECH_INSTALL_BLOCKED_LOCAL_ONLY");
  await speech.whenInstalled();
  assert.equal(fetcher.calls.length, 0, "LOCAL_ONLY must make no request at all");
  assert.equal(fs.existsSync(speechDir), false, "nothing is created on disk either");
  assert.deepEqual(audits, [{ method: "POST", route: "/api/local/speech/install", blocked: true, reachedCloud: false, reason: "APP_LOCAL_ONLY", source: "speech-install" }]);
  const status = speech.status();
  assert.equal(status.state, "not_installed");
  assert.equal(status.internet_allowed, false);

  // An unreadable policy is treated the same as LOCAL_ONLY.
  const throwing = createLocalSpeech({ speechDir, readPolicy: () => { throw new Error("unreadable"); }, request: fetcher.request });
  assert.equal(throwing.install({}).status, 403);
  assert.equal(fetcher.calls.length, 0);
});

test("the policy is re-read before every redirect hop", async () => {
  const zip = buildZip(engineEntries());
  const { engineAsset, modelAssets } = testAssets({ zip });
  let allowed = true;
  const fetcher = fakeFetcher({
    [engineAsset.url]: () => {
      allowed = false; // LOCAL_ONLY switched on while the first hop was in flight
      return { status: 302, headers: { location: "https://cdn.test/zip" } };
    },
    "https://cdn.test/zip": { body: zip },
  });
  const { entries: audits, audit } = auditLog();
  const speechDir = tempDir("hop-policy");
  const speech = createLocalSpeech({ speechDir, platform: "win32", readPolicy: () => ({ allowInternetAccess: allowed }), audit, request: fetcher.request, engineAsset, modelAssets });
  assert.equal(speech.install({}).status, 202);
  await speech.whenInstalled();
  assert.deepEqual(fetcher.calls, [engineAsset.url], "the redirect target must not be requested once LOCAL_ONLY is on");
  assert.equal(speech.status().state, "failed");
  assert.match(speech.status().error, /Local Only/);
  assert.deepEqual(audits.map((entry) => entry.blocked), [false, true]);
  assert.equal(audits[1].route, "https://cdn.test/zip");
  assert.deepEqual(fs.readdirSync(speechDir), []);
});

test("switching to LOCAL_ONLY during a download stops it and deletes the partial file", async () => {
  const speechDir = tempDir("flip");
  const zip = buildZip(engineEntries());
  const { engineAsset, modelAssets } = testAssets({ zip });
  let allowed = true;
  const stream = new Readable({ read() {} });
  const fetcher = fakeFetcher({ [engineAsset.url]: { stream } });
  const { entries: audits, audit } = auditLog();
  const speech = createLocalSpeech({ speechDir, platform: "win32", readPolicy: () => ({ allowInternetAccess: allowed }), audit, request: fetcher.request, engineAsset, modelAssets, policyCheckIntervalMs: 10 });
  speech.install({});
  stream.push(zip.subarray(0, 100));
  for (let i = 0; i < 500 && speech.status().progress.received_bytes === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(speech.status().progress.phase, "engine");
  assert.equal(speech.status().progress.received_bytes, 100);
  assert.equal(speech.status().progress.total_bytes, zip.length);
  allowed = false;
  await speech.whenInstalled();
  const status = speech.status();
  assert.equal(status.state, "failed");
  assert.match(status.error, /Local Only/);
  assert.deepEqual(fs.readdirSync(speechDir), []);
  assert.ok(audits.some((entry) => entry.blocked === true && entry.reason === "APP_LOCAL_ONLY" && entry.source === "speech-install"));
});

test("install refuses an unknown model and a second concurrent install", async () => {
  const speech = createLocalSpeech({ speechDir: tempDir("refuse"), readPolicy: () => ({ allowInternetAccess: true }), request: fakeFetcher({}).request });
  for (const model of ["large", "tiny", 3, "__proto__", "constructor"]) {
    assert.equal(speech.install({ model }).body.code, "SPEECH_MODEL_UNKNOWN", String(model));
  }
  const stream = new Readable({ read() {} });
  const zip = buildZip(engineEntries());
  const { engineAsset, modelAssets } = testAssets({ zip });
  const busy = createLocalSpeech({ speechDir: tempDir("busy-install"), platform: "win32", readPolicy: () => ({ allowInternetAccess: true }), request: fakeFetcher({ [engineAsset.url]: { stream } }).request, engineAsset, modelAssets });
  assert.equal(busy.install({ model: "base" }).status, 202);
  const second = busy.install({ model: "small" });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "SPEECH_INSTALL_IN_PROGRESS");
  assert.equal(busy.status().model, "base");
  stream.destroy(new Error("test over"));
  await busy.whenInstalled();
  assert.equal(busy.status().state, "failed");
});

// ---------------------------------------------------------------------------------------------
// WAV validation and transcript cleaning
// ---------------------------------------------------------------------------------------------

test("only 16 kHz mono PCM16 WAV up to 30 s and 1,000,000 bytes is accepted", () => {
  assert.equal(validateWav(makeWav({ seconds: 1 })).ok, true);
  assert.equal(validateWav(makeWav({ seconds: 30 })).ok, true);
  const cases = {
    "wrong rate": makeWav({ sampleRate: 44100 }),
    "8 kHz": makeWav({ sampleRate: 8000 }),
    stereo: makeWav({ channels: 2 }),
    "8-bit": makeWav({ bits: 8 }),
    "float": makeWav({ format: 3 }),
    "too long": makeWav({ seconds: 30.5 }),
    "not RIFF": makeWav({ riff: "RIFX" }),
    "too big": Buffer.concat([makeWav({ seconds: 1 }), Buffer.alloc(1000000)]),
    empty: Buffer.alloc(0),
    "not a buffer": "RIFF....WAVE",
    "truncated data": makeWav({ seconds: 1 }).subarray(0, 1000),
    "no samples": makeWav({ seconds: 0 }),
  };
  for (const [label, input] of Object.entries(cases)) assert.equal(validateWav(input).ok, false, label);
});

test("blank-audio and non-speech markers are stripped from the transcript", () => {
  assert.equal(cleanTranscript(" [BLANK_AUDIO]\n"), "");
  assert.equal(cleanTranscript(" [Music]\n (music)\n"), "");
  assert.equal(cleanTranscript(" Frost, what were\n sales today? [BLANK_AUDIO]\r\n"), "Frost, what were sales today?");
  assert.equal(cleanTranscript(""), "");
});

test("the engine is run with the flags whisper-cli v1.8.7 accepts", () => {
  assert.deepEqual(buildEngineArgs({ modelPath: "M", wavPath: "W", threads: 4 }), ["-m", "M", "-f", "W", "-l", "auto", "--translate", "-nt", "-np", "-t", "4"]);
  assert.match(describeEngineExit(3221225781, null), /Visual C\+\+/);
  assert.match(describeEngineExit(2, null), /exited with 2/);
});

// ---------------------------------------------------------------------------------------------
// Transcribe, against a fake engine (a node script, so it runs on Windows too)
// ---------------------------------------------------------------------------------------------

const FAKE_ENGINE = `
const fs = require("fs");
const crypto = require("crypto");
const [mode, ...args] = process.argv.slice(2);
const wav = args[args.indexOf("-f") + 1];
const bytes = fs.readFileSync(wav);
const report = process.env.FAKE_REPORT_DIR;
if (mode === "echo") {
  fs.writeFileSync(require("path").join(report, "seen.json"), JSON.stringify({ args, sha: crypto.createHash("sha256").update(bytes).digest("hex") }));
  process.stdout.write(" [BLANK_AUDIO]\\n Frost, what were sales today? (music)\\n");
} else if (mode === "blank") {
  process.stdout.write(" [BLANK_AUDIO]\\n");
} else if (mode === "hang") {
  fs.writeFileSync(require("path").join(report, "pid"), String(process.pid));
  setTimeout(() => process.stdout.write("too late"), 60000);
} else if (mode === "slow") {
  setTimeout(() => process.stdout.write(" slow answer\\n"), 400);
} else if (mode === "fail") {
  process.stderr.write("boom");
  process.exit(3);
}
`;

const setUpFakeEngine = (mode, options = {}) => {
  const root = tempDir(`engine-${mode}`);
  const speechDir = path.join(root, "speech");
  const tmp = path.join(root, "tmp");
  const reportDir = path.join(root, "report");
  for (const dir of [speechDir, tmp, reportDir]) fs.mkdirSync(dir, { recursive: true });
  const script = path.join(root, "fake-engine.js");
  fs.writeFileSync(script, FAKE_ENGINE);
  fs.writeFileSync(path.join(speechDir, "whisper-cli"), "placeholder");
  fs.writeFileSync(path.join(speechDir, "ggml-small.bin"), "model");
  const spawns = [];
  const spawnProcess = (command, args, spawnOptions) => {
    spawns.push({ command, args, options: spawnOptions });
    return spawn(process.execPath, [script, mode, ...args], { ...spawnOptions, env: { ...process.env, FAKE_REPORT_DIR: reportDir } });
  };
  const speech = createLocalSpeech({ speechDir, platform: "linux", tmpDir: tmp, readPolicy: () => ({ allowInternetAccess: false }), spawnProcess, threads: 3, ...options });
  return { speech, speechDir, tmp, reportDir, spawns };
};

test("transcribe hands the engine the exact audio, strips markers and always deletes the temp file", async () => {
  const { speech, speechDir, tmp, reportDir, spawns } = setUpFakeEngine("echo");
  const wav = makeWav({ seconds: 2 });
  const result = await speech.transcribe(wav);
  assert.equal(result.status, 200);
  assert.equal(result.body.text, "Frost, what were sales today?");
  assert.equal(typeof result.body.elapsed_ms, "number");
  const seen = JSON.parse(fs.readFileSync(path.join(reportDir, "seen.json"), "utf8"));
  assert.equal(seen.sha, sha("sha256", wav), "the engine must read exactly the bytes that were posted");
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].command, path.join(speechDir, "whisper-cli"));
  assert.equal(spawns[0].options.shell, false);
  assert.equal(spawns[0].options.windowsHide, true);
  const wavPath = spawns[0].args[3];
  assert.equal(path.dirname(wavPath), tmp);
  assert.deepEqual(spawns[0].args, ["-m", path.join(speechDir, "ggml-small.bin"), "-f", wavPath, "-l", "auto", "--translate", "-nt", "-np", "-t", "3"]);
  assert.deepEqual(fs.readdirSync(tmp), [], "the temp WAV must be deleted");

  const blank = setUpFakeEngine("blank");
  const silent = await blank.speech.transcribe(makeWav({ seconds: 1, fill: 0 }));
  assert.deepEqual([silent.status, silent.body.text], [200, ""]);
});

test("an engine that overruns is killed and reported as a failure", async () => {
  // Long enough for a stand-in node process to start and record its pid on a loaded machine.
  const { speech, tmp, reportDir } = setUpFakeEngine("hang", { transcribeTimeoutMs: 3000 });
  const started = Date.now();
  const result = await speech.transcribe(makeWav({ seconds: 1 }));
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "SPEECH_TRANSCRIBE_FAILED");
  assert.ok(Date.now() - started < 10000, "the timeout must not wait for the engine");
  const pid = Number(fs.readFileSync(path.join(reportDir, "pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH", "the engine process must be gone");
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test("an engine that fails is a failure, never an empty answer", async () => {
  const { speech, tmp } = setUpFakeEngine("fail");
  const result = await speech.transcribe(makeWav({ seconds: 1 }));
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "SPEECH_TRANSCRIBE_FAILED");
  assert.equal("text" in result.body, false);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test("one transcription at a time: a second is refused as busy", async () => {
  const { speech, spawns } = setUpFakeEngine("slow");
  const first = speech.transcribe(makeWav({ seconds: 1 }));
  const second = await speech.transcribe(makeWav({ seconds: 1 }));
  assert.equal(second.status, 429);
  assert.equal(second.body.code, "SPEECH_BUSY");
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(done.body.text, "slow answer");
  assert.equal(spawns.length, 1);
  assert.equal((await speech.transcribe(makeWav({ seconds: 1 }))).status, 200, "busy clears once the first finishes");
});

test("transcribe refuses invalid audio and a missing install without running anything", async () => {
  const { speech, speechDir, spawns, tmp } = setUpFakeEngine("echo");
  const invalid = await speech.transcribe(makeWav({ channels: 2 }));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.code, "SPEECH_AUDIO_INVALID");
  fs.rmSync(path.join(speechDir, "ggml-small.bin"));
  const missing = await speech.transcribe(makeWav({ seconds: 1 }));
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, "SPEECH_NOT_INSTALLED");
  assert.equal(speech.status().state, "not_installed");
  assert.equal(spawns.length, 0);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

// ---------------------------------------------------------------------------------------------
// Gateway routes, in-process (cross-platform)
// ---------------------------------------------------------------------------------------------

const { createSpeechRequestHandler } = require("./desktopGateway");

const stubSpeech = () => {
  const calls = { status: 0, install: [], transcribe: [] };
  return {
    calls,
    status: () => { calls.status += 1; return { state: "ready", model: "small", progress: { phase: null, received_bytes: 0, total_bytes: 0 }, error: null, internet_allowed: false }; },
    install: (input) => { calls.install.push(input); return { status: 202, body: { state: "installing" } }; },
    transcribe: async (buffer) => { calls.transcribe.push(buffer); return { status: 200, body: { text: "ok", elapsed_ms: 1 } }; },
  };
};

const withHandlerServer = async (speech, run) => {
  const handler = createSpeechRequestHandler({ speech });
  const server = http.createServer((req, res) => handler(req, res, new URL(req.url, "http://127.0.0.1")));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
};

test("gateway: a website's origin is refused on every speech route", async () => {
  const speech = stubSpeech();
  await withHandlerServer(speech, async (base) => {
    for (const origin of ["https://attacker.example", "null", "http://192.168.1.20:5173"]) {
      for (const [route, method, body] of [["status", "GET"], ["install", "POST", "{}"], ["transcribe", "POST", makeWav()]]) {
        const response = await fetch(`${base}/api/local/speech/${route}`, { method, headers: { origin }, body });
        assert.equal(response.status, 403, `${origin} ${route}`);
        assert.equal((await response.json()).code, "SPEECH_ORIGIN_REFUSED");
      }
    }
    assert.deepEqual(speech.calls, { status: 0, install: [], transcribe: [] });
    for (const origin of ["http://tauri.localhost", "tauri://localhost", "http://localhost:5173"]) {
      const response = await fetch(`${base}/api/local/speech/status`, { headers: { origin } });
      assert.equal(response.status, 200, origin);
      assert.equal((await response.json()).state, "ready");
    }
  });
});

test("gateway: the transcribe body reaches the service as the exact bytes, capped at 1,000,000", async () => {
  const speech = stubSpeech();
  await withHandlerServer(speech, async (base) => {
    // Not valid UTF-8 and not JSON: any decoding on the way would change it.
    const bytes = Buffer.concat([makeWav({ seconds: 1 }), Buffer.from([0xff, 0xfe, 0x00, 0xc3, 0x28, 0x80])]);
    const response = await fetch(`${base}/api/local/speech/transcribe`, { method: "POST", headers: { origin: "http://tauri.localhost", "content-type": "audio/wav" }, body: bytes });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: "ok", elapsed_ms: 1 });
    assert.equal(speech.calls.transcribe.length, 1);
    assert.ok(Buffer.isBuffer(speech.calls.transcribe[0]));
    assert.ok(speech.calls.transcribe[0].equals(bytes));

    const tooBig = await fetch(`${base}/api/local/speech/transcribe`, { method: "POST", headers: { origin: "http://tauri.localhost" }, body: Buffer.alloc(1000001) });
    assert.equal(tooBig.status, 400);
    assert.equal((await tooBig.json()).code, "SPEECH_AUDIO_INVALID");
    assert.equal(speech.calls.transcribe.length, 1, "an oversized body never reaches the service");

    // Chunked, with no content-length to refuse up front: the cap has to hold while reading, and
    // the app still gets the code rather than a dropped connection.
    const chunk = new Uint8Array(64 * 1024);
    let sent = 0;
    const chunked = await fetch(`${base}/api/local/speech/transcribe`, {
      method: "POST",
      headers: { origin: "http://tauri.localhost" },
      duplex: "half",
      body: new ReadableStream({
        pull(controller) {
          if (sent > 1100000) return controller.close();
          sent += chunk.length;
          controller.enqueue(chunk);
        },
      }),
    });
    assert.equal(chunked.status, 400);
    assert.equal((await chunked.json()).code, "SPEECH_AUDIO_INVALID");
    assert.equal(speech.calls.transcribe.length, 1);
  });
});

test("gateway: install passes the model through; wrong methods and unknown paths are answered locally", async () => {
  const speech = stubSpeech();
  await withHandlerServer(speech, async (base) => {
    const install = await fetch(`${base}/api/local/speech/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "base" }) });
    assert.equal(install.status, 202);
    assert.deepEqual(speech.calls.install, [{ model: "base" }]);
    const unreadable = await fetch(`${base}/api/local/speech/install`, { method: "POST", body: "{not json" });
    assert.equal(unreadable.status, 400);
    assert.equal((await unreadable.json()).code, "SPEECH_MODEL_UNKNOWN");
    assert.equal((await fetch(`${base}/api/local/speech/install`)).status, 405);
    assert.equal((await fetch(`${base}/api/local/speech/status`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/api/local/speech/elsewhere`)).status, 404);
  });
});

// ---------------------------------------------------------------------------------------------
// Gateway routes, against a real gateway process
// ---------------------------------------------------------------------------------------------

const reservePort = async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const startGateway = async ({ root, speechDir, policy, cloudApiUrl, extraEnv = {} }) => {
  const appData = path.join(root, "appdata");
  fs.mkdirSync(appData, { recursive: true });
  const databasePath = path.join(root, "froozerp-local.sqlite3");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE local_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  database.close();
  if (policy !== undefined) fs.writeFileSync(path.join(appData, "cloud-network-policy.json"), JSON.stringify({ allowInternetAccess: policy }));
  const port = await reservePort();
  const child = spawn(process.execPath, ["desktopGateway.js"], {
    cwd: __dirname,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      APP_VERSION: "speech-test",
      FROOZERP_APP_DATA_DIR: appData,
      FROOZERP_SQLITE_PATH: databasePath,
      FROOZERP_SPEECH_DIR: speechDir,
      CLOUD_API_URL: cloudApiUrl,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(750) })).ok) {
        return { child, base: `http://127.0.0.1:${port}`, auditPath: path.join(appData, "logs", "cloud-request-audit.jsonl") };
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill();
  throw new Error(`Gateway did not become healthy. exit=${child.exitCode} stderr=${stderr}`);
};

const stopGateway = async (child) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

const startCloudStandIn = async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
};

test("real gateway: in LOCAL_ONLY install is refused, audited, and nothing leaves the machine", async () => {
  const root = tempDir("gateway-local-only");
  const speechDir = path.join(root, "speech");
  const cloud = await startCloudStandIn();
  const { child, base, auditPath } = await startGateway({ root, speechDir, policy: false, cloudApiUrl: cloud.url });
  const app = { origin: "http://tauri.localhost" };
  try {
    const status = await (await fetch(`${base}/api/local/speech/status`, { headers: app })).json();
    assert.deepEqual(status, { state: "not_installed", model: null, progress: { phase: null, received_bytes: 0, total_bytes: 0 }, error: null, internet_allowed: false });

    const install = await fetch(`${base}/api/local/speech/install`, { method: "POST", headers: { ...app, "content-type": "application/json" }, body: "{}" });
    assert.equal(install.status, 403);
    assert.equal((await install.json()).code, "SPEECH_INSTALL_BLOCKED_LOCAL_ONLY");

    const transcribe = await fetch(`${base}/api/local/speech/transcribe`, { method: "POST", headers: { ...app, "content-type": "audio/wav" }, body: makeWav() });
    assert.equal(transcribe.status, 409);
    assert.equal((await transcribe.json()).code, "SPEECH_NOT_INSTALLED");

    // No speech path is ever proxied, known or not.
    assert.equal((await fetch(`${base}/api/local/speech/unknown`, { headers: app })).status, 404);
    assert.equal((await fetch(`${base}/api/local/speech/install`, { method: "PUT", headers: app })).status, 405);

    const foreign = await fetch(`${base}/api/local/speech/install`, { method: "POST", headers: { origin: "https://attacker.example" }, body: "{}" });
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).code, "SPEECH_ORIGIN_REFUSED");

    assert.deepEqual(cloud.requests, [], "no speech request may reach the cloud");
    assert.equal(fs.existsSync(speechDir), false, "a refused install writes nothing");
    const audits = fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const refusal = audits.filter((entry) => entry.source === "speech-install");
    assert.equal(refusal.length, 1);
    assert.equal(refusal[0].blocked, true);
    assert.equal(refusal[0].reachedCloud, false);
    assert.equal(refusal[0].reason, "APP_LOCAL_ONLY");
    assert.equal(refusal[0].route, "/api/local/speech/install");
    assert.equal(audits.some((entry) => entry.reachedCloud === true), false);
  } finally {
    await stopGateway(child);
    await cloud.close();
  }
});

test("real gateway: posted WAV bytes reach the engine unchanged and come back as text", { skip: process.platform === "win32" && "the stand-in engine is a script; Windows would need a real whisper-cli.exe" }, async () => {
  const root = tempDir("gateway-transcribe");
  const speechDir = path.join(root, "speech");
  fs.mkdirSync(speechDir, { recursive: true });
  const reportDir = path.join(root, "report");
  fs.mkdirSync(reportDir);
  const engine = path.join(speechDir, "whisper-cli");
  fs.writeFileSync(engine, `#!${process.execPath}\nprocess.argv.splice(2, 0, "echo");\n${FAKE_ENGINE}`);
  fs.chmodSync(engine, 0o755);
  fs.writeFileSync(path.join(speechDir, "ggml-base.bin"), "model");
  const cloud = await startCloudStandIn();
  const { child, base } = await startGateway({ root, speechDir, policy: true, cloudApiUrl: cloud.url, extraEnv: { FAKE_REPORT_DIR: reportDir } });
  try {
    const status = await (await fetch(`${base}/api/local/speech/status`)).json();
    assert.equal(status.state, "ready");
    assert.equal(status.model, "base");
    assert.equal(status.internet_allowed, true);
    const wav = makeWav({ seconds: 3 });
    const response = await fetch(`${base}/api/local/speech/transcribe`, { method: "POST", headers: { origin: "http://tauri.localhost", "content-type": "audio/wav" }, body: wav });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.text, "Frost, what were sales today?");
    const seen = JSON.parse(fs.readFileSync(path.join(reportDir, "seen.json"), "utf8"));
    assert.equal(seen.sha, sha("sha256", wav));
    assert.deepEqual(seen.args.slice(0, 2), ["-m", path.join(speechDir, "ggml-base.bin")]);
    assert.deepEqual(cloud.requests, []);
  } finally {
    await stopGateway(child);
    await cloud.close();
  }
});

// ---------------------------------------------------------------------------------------------
// The OpenAI Realtime path is gone
// ---------------------------------------------------------------------------------------------

test("the backend no longer mints OpenAI Realtime sessions", () => {
  const core = fs.readFileSync(path.join(__dirname, "frostCore.js"), "utf8");
  const service = fs.readFileSync(path.join(__dirname, "aiBusinessAssistantService.js"), "utf8");
  assert.equal(core.includes("createRealtimeSession"), false);
  assert.equal(/api\.openai\.com\/v1\/realtime/.test(core + service), false);
  assert.equal(service.includes('"/api/ai/voice/session"'), false);
  // The stored settings shape is untouched: no schema change rides along with the removal.
  assert.match(core, /realtimeModel: "gpt-realtime"/);
});
