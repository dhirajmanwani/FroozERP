"use strict";

/**
 * On-device speech-to-text for FROST live voice (whisper.cpp's `whisper-cli`), run by the desktop
 * gateway on 127.0.0.1. The microphone never leaves the laptop: audio arrives from the app as a WAV,
 * is written to a temp file, transcribed by a local process that makes no network connection, and
 * deleted.
 *
 * ## Dependencies: node built-ins only
 *
 * This file ships inside the installer next to desktopGateway.js as an individual bundle resource
 * (src-tauri/tauri.conf.json). The packaged gateway has no node_modules, so a require of anything
 * that is not a node built-in would kill the gateway in the packaged app only -- which is why the
 * small zip reader below exists instead of a dependency.
 *
 * ## The one external connection
 *
 * `install()` downloads the engine (the pinned whisper.cpp release zip) and a model. It is the only
 * external connection FROST voice adds, it happens only on an explicit request, and only when the
 * device's internet-access policy allows it. In LOCAL_ONLY it is refused before any request is made,
 * and the refusal is written to the gateway's cloud-request audit log. The policy is re-read before
 * every request (every redirect hop) and while bytes are flowing, so switching to LOCAL_ONLY in the
 * middle of a download stops it. Every file is verified against a pinned hash before it is renamed
 * into place; a file that fails the check is deleted, never used.
 */

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { spawn } = require("child_process");

// ---------------------------------------------------------------------------------------------
// Pinned assets (taken from upstream on 2026-09-23; see the live-voice contract)
// ---------------------------------------------------------------------------------------------

const ENGINE_ASSET = Object.freeze({
  url: "https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.7/whisper-bin-x64.zip",
  algorithm: "sha256",
  hash: "d9627486e1c34a03745880485593473e047294260ce9a3cb0aa8deaf15b99af6",
  size: 4386743,
  fileName: "whisper-bin-x64.zip",
  // The only entries ever taken out of the archive. Everything else in it is ignored.
  entries: Object.freeze([
    "Release/whisper-cli.exe",
    "Release/whisper.dll",
    "Release/ggml.dll",
    "Release/ggml-base.dll",
    "Release/ggml-cpu.dll",
  ]),
});

const MODEL_ASSETS = Object.freeze({
  small: Object.freeze({
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    algorithm: "sha1",
    hash: "55356645c2b361a969dfd0ef2c5a50d530afd8d5",
    fileName: "ggml-small.bin",
  }),
  base: Object.freeze({
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    algorithm: "sha1",
    hash: "465707469ff3a37a2b9b8d8f89f2f99de7299dac",
    fileName: "ggml-base.bin",
  }),
});

const DEFAULT_MODEL = "small";
const MODEL_PREFERENCE = Object.freeze(["small", "base"]);
const INSTALL_RECORD = "speech-install.json";

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DOWNLOAD_IDLE_TIMEOUT_MS = 60000;

const WAV_MAX_BYTES = 1000000;
const WAV_MAX_SECONDS = 30;
const WAV_SAMPLE_RATE = 16000;
const TRANSCRIBE_TIMEOUT_MS = 30000;
const MAX_ENGINE_STDOUT = 256 * 1024;

const SPEECH_CODES = Object.freeze({
  NOT_INSTALLED: "SPEECH_NOT_INSTALLED",
  AUDIO_INVALID: "SPEECH_AUDIO_INVALID",
  TRANSCRIBE_FAILED: "SPEECH_TRANSCRIBE_FAILED",
  BUSY: "SPEECH_BUSY",
  INSTALL_BLOCKED_LOCAL_ONLY: "SPEECH_INSTALL_BLOCKED_LOCAL_ONLY",
  INSTALL_IN_PROGRESS: "SPEECH_INSTALL_IN_PROGRESS",
  MODEL_UNKNOWN: "SPEECH_MODEL_UNKNOWN",
});

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/**
 * Where the engine and model live. Not business data and not per-profile: a disposable rehearsal
 * profile shares it with the real app on purpose, so it does not re-download 466 MB.
 */
const resolveSpeechDir = ({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) => {
  const override = String(env.FROOZERP_SPEECH_DIR || "").trim();
  if (override) return path.resolve(override);
  if (platform === "win32") {
    const localAppData = String(env.LOCALAPPDATA || "").trim() || path.join(homedir, "AppData", "Local");
    return path.join(localAppData, "FroozERP", "speech");
  }
  return path.join(homedir, ".local", "share", "froozerp", "speech");
};

const engineBinaryName = (platform = process.platform) => (platform === "win32" ? "whisper-cli.exe" : "whisper-cli");

/** Files that must all be present for the engine to count as installed. */
const engineFileNames = (platform = process.platform) => (platform === "win32"
  ? ENGINE_ASSET.entries.map((entry) => entry.split("/").pop())
  : [engineBinaryName(platform)]);

// ---------------------------------------------------------------------------------------------
// Zip reading (central directory + local headers; stored and deflate only)
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const archiveError = (message) => {
  const error = new Error(`Speech engine archive refused: ${message}`);
  error.code = "SPEECH_ARCHIVE_INVALID";
  return error;
};

/** An entry name that could escape the extraction directory, or that no sane archive carries. */
const isUnsafeEntryName = (name) => {
  if (!name || name.includes("\0") || name.includes("\\")) return true;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return true;
  return name.split("/").some((segment) => segment === "..");
};

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

/**
 * Read exactly the `wanted` entries out of a zip held in memory.
 *
 * The whole archive is refused -- nothing is returned, so nothing is written -- when any entry name
 * is unsafe (traversal, absolute, drive letter, backslash), when a wanted entry is missing,
 * duplicated, encrypted, uses a method other than stored/deflate, disagrees with its local header,
 * or fails its size or CRC check. Only entries whose names match `wanted` exactly are ever inflated.
 */
const extractZipEntries = (zip, wanted) => {
  if (!Buffer.isBuffer(zip) || zip.length < 22) throw archiveError("not a zip file");
  const wantedSet = new Set(wanted);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw archiveError("end of central directory not found");
  const entryCount = zip.readUInt16LE(eocd + 10);
  const cdSize = zip.readUInt32LE(eocd + 12);
  const cdOffset = zip.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw archiveError("zip64 is not supported");
  if (cdOffset + cdSize > eocd) throw archiveError("central directory out of bounds");

  const found = new Map();
  let offset = cdOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocd || zip.readUInt32LE(offset) !== 0x02014b50) throw archiveError("corrupt central directory");
    const flags = zip.readUInt16LE(offset + 8);
    const method = zip.readUInt16LE(offset + 10);
    const crc = zip.readUInt32LE(offset + 16);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const size = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > eocd) throw archiveError("corrupt central directory");
    const name = zip.toString(flags & 0x800 ? "utf8" : "latin1", offset + 46, nameEnd);
    offset = nameEnd + extraLength + commentLength;

    if (isUnsafeEntryName(name)) throw archiveError(`unsafe entry name ${JSON.stringify(name)}`);
    if (!wantedSet.has(name)) continue;
    if (found.has(name)) throw archiveError(`duplicate entry ${name}`);
    if (flags & 0x1) throw archiveError(`encrypted entry ${name}`);
    if (method !== 0 && method !== 8) throw archiveError(`unsupported compression method ${method} for ${name}`);
    if (size > MAX_ENTRY_BYTES || compressedSize > MAX_ENTRY_BYTES) throw archiveError(`entry ${name} is too large`);

    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) throw archiveError(`bad local header for ${name}`);
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const localName = zip.toString(flags & 0x800 ? "utf8" : "latin1", localOffset + 30, localOffset + 30 + localNameLength);
    if (localName !== name) throw archiveError(`local header name disagrees for ${name}`);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zip.length) throw archiveError(`entry ${name} runs past the end of the archive`);
    const compressed = zip.subarray(dataStart, dataEnd);
    let data;
    try {
      data = method === 0 ? Buffer.from(compressed) : zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) });
    } catch {
      throw archiveError(`entry ${name} could not be inflated`);
    }
    if (data.length !== size) throw archiveError(`entry ${name} has the wrong size`);
    if (crc32(data) !== crc) throw archiveError(`entry ${name} failed its CRC check`);
    found.set(name, data);
  }
  const missing = wanted.filter((name) => !found.has(name));
  if (missing.length) throw archiveError(`missing ${missing.join(", ")}`);
  return found;
};

// ---------------------------------------------------------------------------------------------
// WAV validation
// ---------------------------------------------------------------------------------------------

/** 16 kHz mono PCM16 RIFF/WAVE, at most 30 s and 1,000,000 bytes. */
const validateWav = (buffer) => {
  const invalid = (reason) => ({ ok: false, reason });
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return invalid("The audio is empty or too short to be a WAV file.");
  if (buffer.length > WAV_MAX_BYTES) return invalid("The audio is larger than 1,000,000 bytes.");
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return invalid("The audio is not a RIFF/WAVE file.");
  let format = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    if (id === "fmt ") {
      if (size < 16 || bodyStart + 16 > buffer.length) return invalid("The WAV format chunk is truncated.");
      format = {
        audioFormat: buffer.readUInt16LE(bodyStart),
        channels: buffer.readUInt16LE(bodyStart + 2),
        sampleRate: buffer.readUInt32LE(bodyStart + 4),
        bitsPerSample: buffer.readUInt16LE(bodyStart + 14),
      };
    } else if (id === "data") {
      if (bodyStart + size > buffer.length) return invalid("The WAV data chunk is truncated.");
      data = { start: bodyStart, size };
      break;
    }
    offset = bodyStart + size + (size % 2);
  }
  if (!format) return invalid("The WAV file has no format chunk.");
  if (!data) return invalid("The WAV file has no data chunk.");
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) return invalid("The audio must be 16-bit PCM.");
  if (format.channels !== 1) return invalid("The audio must be mono.");
  if (format.sampleRate !== WAV_SAMPLE_RATE) return invalid("The audio must be sampled at 16000 Hz.");
  if (data.size === 0 || data.size % 2 !== 0) return invalid("The WAV data chunk is empty or not whole samples.");
  const seconds = data.size / (WAV_SAMPLE_RATE * 2);
  if (seconds > WAV_MAX_SECONDS) return invalid("The audio is longer than 30 seconds.");
  return { ok: true, seconds };
};

// ---------------------------------------------------------------------------------------------
// Transcript cleaning
// ---------------------------------------------------------------------------------------------

/**
 * whisper-cli with `-nt -np` prints one line per segment and nothing else. Non-speech markers such
 * as "[BLANK_AUDIO]", "[Music]" or "(music)" are removed, so silence comes back as "".
 */
const cleanTranscript = (stdout) => String(stdout || "")
  .replace(/\[[^\]]*\]/g, " ")
  .replace(/\([^)]*\)/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const buildEngineArgs = ({ modelPath, wavPath, threads }) => [
  "-m", modelPath,
  "-f", wavPath,
  "-l", "auto",
  "--translate",
  "-nt",
  "-np",
  "-t", String(threads),
];

// STATUS_DLL_NOT_FOUND. The pinned Windows build links the Microsoft Visual C++ 2015-2022 runtime
// (MSVCP140, VCRUNTIME140, VCRUNTIME140_1, VCOMP140), which the release zip does not carry; on a
// laptop without that redistributable the engine cannot start, and saying so beats an exit number.
const WINDOWS_DLL_NOT_FOUND = new Set([0xc0000135, -1073741515]);

const describeEngineExit = (code, signal) => {
  if (WINDOWS_DLL_NOT_FOUND.has(code)) {
    return "the speech engine could not start because a Windows runtime library is missing (Microsoft Visual C++ 2015-2022 Redistributable, x64)";
  }
  return `the engine exited with ${code ?? signal}`;
};

const defaultThreads = () => {
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, Number(cpus) || 1));
};

// ---------------------------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------------------------

/** One GET, no redirect handling. Resolves with { statusCode, headers, body: Readable }. */
const httpsRequest = (url) => new Promise((resolve, reject) => {
  const request = https.get(url, { headers: { "user-agent": "FroozERP-speech-installer" }, timeout: DOWNLOAD_IDLE_TIMEOUT_MS }, (response) => {
    resolve({ statusCode: response.statusCode, headers: response.headers, body: response });
  });
  request.on("timeout", () => request.destroy(new Error("The download stalled and was stopped.")));
  request.on("error", reject);
});

const withCode = (message, code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

/** The URL without its query string: CDN redirects carry signed parameters not worth logging. */
const auditableUrl = (value) => {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(unparseable url)";
  }
};

const discard = (body) => {
  try {
    if (body && typeof body.resume === "function") body.resume();
    if (body && typeof body.destroy === "function") body.destroy();
  } catch {}
};

const hashFile = (filePath, algorithm) => new Promise((resolve, reject) => {
  const hash = crypto.createHash(algorithm);
  const stream = fs.createReadStream(filePath);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("error", reject);
  stream.on("end", () => resolve(hash.digest("hex")));
});

const removeQuietly = (filePath) => {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
};

// ---------------------------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------------------------

const createLocalSpeech = ({
  speechDir = resolveSpeechDir(),
  platform = process.platform,
  readPolicy,
  audit = () => {},
  request = httpsRequest,
  spawnProcess = spawn,
  enginePath = null,
  threads = defaultThreads(),
  transcribeTimeoutMs = TRANSCRIBE_TIMEOUT_MS,
  tmpDir = os.tmpdir(),
  policyCheckIntervalMs = 1000,
  engineAsset = ENGINE_ASSET,
  modelAssets = MODEL_ASSETS,
} = {}) => {
  if (typeof readPolicy !== "function") throw new Error("createLocalSpeech needs readPolicy: installing must consult the internet-access policy.");

  const enginePathResolved = enginePath || path.join(speechDir, engineBinaryName(platform));
  const state = {
    installing: false,
    installingModel: null,
    progress: { phase: null, received_bytes: 0, total_bytes: 0 },
    error: null,
    installPromise: null,
    busy: false,
  };

  const internetAllowed = () => {
    try {
      return readPolicy()?.allowInternetAccess === true;
    } catch {
      return false;
    }
  };

  const modelPathFor = (model) => path.join(speechDir, modelAssets[model].fileName);
  const engineInstalled = () => engineFileNames(platform).every((name) => fs.existsSync(path.join(speechDir, name)));

  /** The model that transcription would use, or null when the engine or every model is missing. */
  const installedModel = () => {
    if (!enginePath && !engineInstalled()) return null;
    if (enginePath && !fs.existsSync(enginePath)) return null;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(speechDir, INSTALL_RECORD), "utf8"));
      if (modelAssets[record?.model] && fs.existsSync(modelPathFor(record.model))) return record.model;
    } catch {}
    return MODEL_PREFERENCE.find((model) => modelAssets[model] && fs.existsSync(modelPathFor(model))) || null;
  };

  const status = () => {
    const model = installedModel();
    let current;
    if (state.installing) current = "installing";
    else if (model) current = "ready";
    else if (state.error) current = "failed";
    else current = "not_installed";
    return {
      state: current,
      model: state.installing ? state.installingModel : model,
      progress: state.installing ? { ...state.progress } : { phase: null, received_bytes: 0, total_bytes: 0 },
      error: state.error,
      internet_allowed: internetAllowed(),
    };
  };

  const auditDownload = (url, extra = {}) => audit({
    method: "GET",
    route: auditableUrl(url),
    blocked: false,
    reachedCloud: false,
    externalConnection: true,
    source: "speech-install",
    ...extra,
  });

  const auditBlocked = (route, method = "GET") => audit({
    method,
    route,
    blocked: true,
    reachedCloud: false,
    reason: "APP_LOCAL_ONLY",
    source: "speech-install",
  });

  /** GET with redirects followed (at most five), https only, policy re-read before every hop. */
  const openFollowingRedirects = async (startUrl) => {
    let url = startUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!/^https:\/\//i.test(url)) throw withCode(`Refused a non-https download address: ${auditableUrl(url)}`, "SPEECH_DOWNLOAD_INSECURE");
      if (!internetAllowed()) {
        auditBlocked(auditableUrl(url));
        throw withCode("Local Only mode is on; the download was stopped.", "APP_LOCAL_ONLY");
      }
      auditDownload(url);
      const response = await request(url);
      if (REDIRECT_STATUSES.has(response.statusCode)) {
        const location = response.headers?.location;
        discard(response.body);
        if (!location) throw withCode(`Redirect without a location from ${auditableUrl(url)}`, "SPEECH_DOWNLOAD_FAILED");
        url = new URL(Array.isArray(location) ? location[0] : location, url).href;
        continue;
      }
      return response;
    }
    throw withCode(`Too many redirects (more than ${MAX_REDIRECTS}).`, "SPEECH_DOWNLOAD_FAILED");
  };

  /** Stream to a temp name while hashing; rename into place only if the hash (and size) match. */
  const download = async (asset, finalPath, phase) => {
    const tempPath = `${finalPath}.part-${process.pid}-${Date.now()}`;
    let policyTimer = null;
    try {
      const response = await openFollowingRedirects(asset.url);
      if (response.statusCode !== 200) {
        discard(response.body);
        throw withCode(`Download failed with HTTP ${response.statusCode}.`, "SPEECH_DOWNLOAD_FAILED");
      }
      const declared = Number(response.headers?.["content-length"]);
      state.progress = {
        phase,
        received_bytes: 0,
        total_bytes: Number.isFinite(declared) && declared > 0 ? declared : Number(asset.size) || 0,
      };
      const hash = crypto.createHash(asset.algorithm);
      const out = fs.createWriteStream(tempPath, { flags: "wx" });
      const outClosed = new Promise((resolve, reject) => {
        out.on("close", resolve);
        out.on("error", reject);
      });
      let stoppedForPolicy = false;
      policyTimer = setInterval(() => {
        if (!internetAllowed()) {
          stoppedForPolicy = true;
          discard(response.body);
        }
      }, policyCheckIntervalMs);
      try {
        for await (const chunk of response.body) {
          if (stoppedForPolicy) break;
          hash.update(chunk);
          state.progress.received_bytes += chunk.length;
          if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
        }
      } catch (error) {
        if (!stoppedForPolicy) throw withCode(`Download interrupted: ${error.message}`, "SPEECH_DOWNLOAD_FAILED");
      } finally {
        out.end();
        await outClosed;
      }
      if (stoppedForPolicy) {
        auditBlocked(auditableUrl(asset.url));
        throw withCode("Local Only mode was switched on during the download; it was stopped and the partial file deleted.", "APP_LOCAL_ONLY");
      }
      state.progress = { ...state.progress, phase: "verifying" };
      const digest = hash.digest("hex");
      const received = state.progress.received_bytes;
      if (digest !== asset.hash || (asset.size && received !== asset.size)) {
        throw withCode(`${path.basename(finalPath)} failed verification (expected ${asset.algorithm} ${asset.hash}, got ${digest}); the file was deleted.`, "SPEECH_HASH_MISMATCH");
      }
      fs.renameSync(tempPath, finalPath);
    } finally {
      if (policyTimer) clearInterval(policyTimer);
      removeQuietly(tempPath);
    }
  };

  const installEngine = async () => {
    if (engineInstalled()) return;
    const zipPath = path.join(speechDir, engineAsset.fileName);
    let verifiedZip = false;
    if (fs.existsSync(zipPath)) {
      state.progress = { phase: "verifying", received_bytes: 0, total_bytes: 0 };
      verifiedZip = (await hashFile(zipPath, engineAsset.algorithm)) === engineAsset.hash;
      if (!verifiedZip) removeQuietly(zipPath);
    }
    if (!verifiedZip) await download(engineAsset, zipPath, "engine");
    state.progress = { phase: "verifying", received_bytes: 0, total_bytes: 0 };
    const entries = extractZipEntries(fs.readFileSync(zipPath), engineAsset.entries);
    for (const [name, data] of entries) {
      const target = path.join(speechDir, name.split("/").pop());
      const temp = `${target}.part-${process.pid}-${Date.now()}`;
      try {
        fs.writeFileSync(temp, data, { flag: "wx", mode: 0o755 });
        fs.renameSync(temp, target);
      } finally {
        removeQuietly(temp);
      }
    }
    removeQuietly(zipPath);
  };

  const installModel = async (model) => {
    const asset = modelAssets[model];
    const modelPath = modelPathFor(model);
    if (fs.existsSync(modelPath)) {
      state.progress = { phase: "verifying", received_bytes: 0, total_bytes: 0 };
      if ((await hashFile(modelPath, asset.algorithm)) === asset.hash) return;
      removeQuietly(modelPath);
    }
    await download(asset, modelPath, "model");
  };

  const runInstall = async (model) => {
    try {
      fs.mkdirSync(speechDir, { recursive: true });
      await installEngine();
      await installModel(model);
      fs.writeFileSync(path.join(speechDir, INSTALL_RECORD), JSON.stringify({ model, installed_at: new Date().toISOString() }, null, 2));
      state.error = null;
    } catch (error) {
      state.error = String(error?.message || error || "Speech install failed.");
    } finally {
      state.installing = false;
      state.installingModel = null;
      state.progress = { phase: null, received_bytes: 0, total_bytes: 0 };
    }
  };

  /**
   * Start an install in the background. Returns { status, body } for the gateway to send.
   * Refusals are decided before anything touches the network or the disk.
   */
  const install = ({ model } = {}) => {
    const chosen = model === undefined || model === null || model === "" ? DEFAULT_MODEL : model;
    if (typeof chosen !== "string" || !Object.prototype.hasOwnProperty.call(modelAssets, chosen)) {
      return { status: 400, body: { code: SPEECH_CODES.MODEL_UNKNOWN, message: "Choose the small or base speech model." } };
    }
    if (state.installing) {
      return { status: 409, body: { code: SPEECH_CODES.INSTALL_IN_PROGRESS, message: "The voice download is already running." } };
    }
    if (!internetAllowed()) {
      auditBlocked("/api/local/speech/install", "POST");
      return {
        status: 403,
        body: {
          code: SPEECH_CODES.INSTALL_BLOCKED_LOCAL_ONLY,
          message: "This laptop is in Local Only mode, so the voice download was not started. Nothing was fetched.",
        },
      };
    }
    state.installing = true;
    state.installingModel = chosen;
    state.error = null;
    state.progress = { phase: "engine", received_bytes: 0, total_bytes: 0 };
    state.installPromise = runInstall(chosen);
    return { status: 202, body: status() };
  };

  const runEngine = (args) => new Promise((resolve) => {
    let child;
    try {
      child = spawnProcess(enginePathResolved, args, { cwd: speechDir, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, reason: `could not start the engine: ${error.message}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, transcribeTimeoutMs);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_ENGINE_STDOUT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.on("error", (error) => finish({ ok: false, reason: `engine error: ${error.message}` }));
    child.on("close", (code, signal) => {
      if (timedOut) return finish({ ok: false, reason: `the engine took longer than ${transcribeTimeoutMs} ms and was stopped`, timedOut: true });
      if (code !== 0) return finish({ ok: false, reason: describeEngineExit(code, signal), stderr });
      return finish({ ok: true, stdout });
    });
  });

  /** Transcribe one WAV. Returns { status, body } for the gateway to send. */
  const transcribe = async (wavBuffer) => {
    const model = installedModel();
    if (!model) return { status: 409, body: { code: SPEECH_CODES.NOT_INSTALLED, message: "Voice is not set up on this laptop yet." } };
    const check = validateWav(wavBuffer);
    if (!check.ok) return { status: 400, body: { code: SPEECH_CODES.AUDIO_INVALID, message: check.reason } };
    if (state.busy) return { status: 429, body: { code: SPEECH_CODES.BUSY, message: "Still transcribing the previous utterance." } };
    state.busy = true;
    const wavPath = path.join(tmpDir, `froozerp-speech-${process.pid}-${crypto.randomBytes(8).toString("hex")}.wav`);
    const started = Date.now();
    try {
      fs.writeFileSync(wavPath, wavBuffer, { flag: "wx", mode: 0o600 });
      const result = await runEngine(buildEngineArgs({ modelPath: modelPathFor(model), wavPath, threads }));
      if (!result.ok) {
        return { status: 503, body: { code: SPEECH_CODES.TRANSCRIBE_FAILED, message: `Speech could not be transcribed: ${result.reason}.` } };
      }
      return { status: 200, body: { text: cleanTranscript(result.stdout), elapsed_ms: Date.now() - started } };
    } catch (error) {
      return { status: 503, body: { code: SPEECH_CODES.TRANSCRIBE_FAILED, message: `Speech could not be transcribed: ${error.message}.` } };
    } finally {
      removeQuietly(wavPath);
      state.busy = false;
    }
  };

  return {
    speechDir,
    enginePath: enginePathResolved,
    status,
    install,
    transcribe,
    /** For tests: resolves when the background install started by install() has finished. */
    whenInstalled: () => state.installPromise || Promise.resolve(),
  };
};

module.exports = {
  DEFAULT_MODEL,
  ENGINE_ASSET,
  MAX_REDIRECTS,
  MODEL_ASSETS,
  SPEECH_CODES,
  TRANSCRIBE_TIMEOUT_MS,
  WAV_MAX_BYTES,
  buildEngineArgs,
  cleanTranscript,
  crc32,
  createLocalSpeech,
  describeEngineExit,
  engineBinaryName,
  engineFileNames,
  extractZipEntries,
  isUnsafeEntryName,
  resolveSpeechDir,
  validateWav,
};
