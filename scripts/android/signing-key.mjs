#!/usr/bin/env node
// ---------------------------------------------------------------------------------------------
// FroozERP's own Android signing key (3 Oct 2026)
//
// Why it exists: the phone APK used to be signed with each GitHub runner's throwaway debug key, so
// every new build was "a different app" to Android. A new build would not install over the old one,
// so the phone had to uninstall first, losing its local data and its device id, and it came back
// as one more box in Branches & Counters -> Computers & phones. ANDROID_ID, which the app now uses
// to give a reinstalled phone its old device id back, is also per signing key. One fixed key fixes
// both: an update installs over the top, and a reinstall keeps the same device id.
//
//   node scripts/android/signing-key.mjs create
//       Makes a new key once, on the Owner's computer. Writes it to
//       %USERPROFILE%\FroozERP-android-signing-key.txt (never inside the repository; refuses to
//       overwrite an existing one) and copies it to the clipboard on Windows. It goes into GitHub as
//       the repository secret ANDROID_SIGNING_BUNDLE. Keep the file safe: losing it means the next
//       build is a different app again.
//
//   node scripts/android/signing-key.mjs create --out <file>
//       Same, to a chosen file, without the clipboard. CI uses this for a throwaway key when the
//       secret is not set.
//
//   node scripts/android/signing-key.mjs unpack <bundle-file> <dir>
//       CI only: writes <dir>/key.pk8 and <dir>/cert.der for `apksigner sign --key --cert`.
//
// The bundle is one line of base64 JSON: { version: 1, key_pk8, cert_der } (each base64). The key
// is an RSA-2048 private key; the certificate is self-signed, CN=FroozERP, valid until 2075.
// Nothing here talks to the network.
// ---------------------------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_VERSION = 1;

// --- minimal DER ----------------------------------------------------------------------------

const derLength = (length) => {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  for (let rest = length; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const sequence = (...parts) => der(0x30, ...parts);
const set = (...parts) => der(0x31, ...parts);
const integer = (bytes) => {
  let body = Buffer.from(bytes);
  while (body.length > 1 && body[0] === 0 && (body[1] & 0x80) === 0) body = body.subarray(1);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return der(0x02, body);
};
const oid = (dotted) => {
  const [first, second, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
};
const nullValue = () => Buffer.from([0x05, 0x00]);
const utf8 = (text) => der(0x0c, Buffer.from(text, "utf8"));
const two = (value) => String(value).padStart(2, "0");
const utcTime = (date) => der(0x17, Buffer.from(
  `${two(date.getUTCFullYear() % 100)}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`,
));
const generalizedTime = (date) => der(0x18, Buffer.from(
  `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}Z`,
));
// RFC 5280: UTCTime through 2049, GeneralizedTime from 2050.
const certTime = (date) => (date.getUTCFullYear() < 2050 ? utcTime(date) : generalizedTime(date));

const SHA256_WITH_RSA = "1.2.840.113549.1.1.11";
const COMMON_NAME = "2.5.4.3";
const ORGANIZATION = "2.5.4.10";

const distinguishedName = () => sequence(
  set(sequence(oid(COMMON_NAME), utf8("FroozERP"))),
  set(sequence(oid(ORGANIZATION), utf8("FroozERP"))),
);

/** A self-signed X.509 v3 certificate with no extensions, which is all apksigner needs. */
export const selfSignedCertificate = ({ privateKey, publicKey, notBefore = new Date(), notAfter = new Date(Date.UTC(2075, 0, 1)) }) => {
  const algorithm = sequence(oid(SHA256_WITH_RSA), nullValue());
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const tbs = sequence(
    der(0xa0, integer([2])),
    integer(serial),
    algorithm,
    distinguishedName(),
    sequence(certTime(notBefore), certTime(notAfter)),
    distinguishedName(),
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = crypto.sign("sha256", tbs, privateKey);
  return sequence(tbs, algorithm, der(0x03, Buffer.from([0]), signature));
};

/** A new key and its certificate, as the one-line bundle that goes into the GitHub secret. */
export const createSigningBundle = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const cert = selfSignedCertificate({ privateKey, publicKey });
  const json = JSON.stringify({
    version: BUNDLE_VERSION,
    key_pk8: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    cert_der: cert.toString("base64"),
  });
  return Buffer.from(json, "utf8").toString("base64");
};

/** The key and certificate inside a bundle, checked to belong together. Throws a plain message. */
export const readSigningBundle = (bundleText) => {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(String(bundleText || "").trim(), "base64").toString("utf8"));
  } catch {
    throw new Error("The signing bundle is not readable. Copy the whole line from the key file again.");
  }
  if (parsed?.version !== BUNDLE_VERSION || !parsed.key_pk8 || !parsed.cert_der) {
    throw new Error("The signing bundle is not a FroozERP Android signing key.");
  }
  const keyDer = Buffer.from(parsed.key_pk8, "base64");
  const certDer = Buffer.from(parsed.cert_der, "base64");
  const privateKey = crypto.createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" });
  const certificate = new crypto.X509Certificate(certDer);
  if (!certificate.checkPrivateKey(privateKey)) {
    throw new Error("The signing bundle's key and certificate do not belong together.");
  }
  return { keyDer, certDer, certificate };
};

const defaultKeyFile = () => path.join(os.homedir(), "FroozERP-android-signing-key.txt");

const insideRepository = (file) => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const relative = path.relative(repo, path.resolve(file));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const main = (argv) => {
  const [command, ...rest] = argv;
  if (command === "create") {
    const outIndex = rest.indexOf("--out");
    const chosen = outIndex >= 0 ? rest[outIndex + 1] : "";
    const file = chosen || defaultKeyFile();
    if (!chosen && insideRepository(file)) throw new Error("Refusing to write the signing key inside the repository.");
    if (fs.existsSync(file)) {
      throw new Error(`${file} already exists. That is your key: use it, do not make a new one.`);
    }
    const bundle = createSigningBundle();
    fs.writeFileSync(file, `${bundle}\n`, { mode: 0o600, flag: "wx" });
    if (chosen) {
      console.log(`Signing key written to ${file}`);
      return;
    }
    let copied = false;
    if (process.platform === "win32") {
      try {
        execFileSync("clip", { input: bundle });
        copied = true;
      } catch {
        copied = false;
      }
    }
    console.log(`Signing key saved: ${file}`);
    console.log(copied
      ? "It is also on the clipboard. Paste it into GitHub as the secret ANDROID_SIGNING_BUNDLE."
      : "Open that file, copy the whole line, and paste it into GitHub as the secret ANDROID_SIGNING_BUNDLE.");
    console.log("Keep this file safe. Without it, the next phone build is a different app again.");
    return;
  }
  if (command === "unpack") {
    const [bundleFile, outDir] = rest;
    if (!bundleFile || !outDir) throw new Error("Usage: signing-key.mjs unpack <bundle-file> <dir>");
    const { keyDer, certDer, certificate } = readSigningBundle(fs.readFileSync(bundleFile, "utf8"));
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(outDir, "key.pk8"), keyDer, { mode: 0o600 });
    fs.writeFileSync(path.join(outDir, "cert.der"), certDer, { mode: 0o644 });
    console.log(`Signing certificate SHA-256: ${certificate.fingerprint256}`);
    return;
  }
  throw new Error("Usage: signing-key.mjs create [--out <file>] | unpack <bundle-file> <dir>");
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
