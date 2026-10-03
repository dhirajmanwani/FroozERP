import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createSigningBundle, readSigningBundle } from "./signing-key.mjs";

const SCRIPT = fileURLToPath(new URL("./signing-key.mjs", import.meta.url));

test("a new bundle holds a self-signed RSA key and certificate that belong together", () => {
  const { keyDer, certificate } = readSigningBundle(createSigningBundle());
  assert.ok(certificate.verify(certificate.publicKey), "self-signed");
  assert.match(certificate.subject, /CN=FroozERP/);
  assert.equal(certificate.issuer, certificate.subject);
  assert.equal(certificate.publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.ok(new Date(certificate.validTo).getUTCFullYear() >= 2074, "valid for decades");
  assert.ok(new Date(certificate.validFrom).getTime() <= Date.now() + 1000);
  const key = crypto.createPrivateKey({ key: keyDer, format: "der", type: "pkcs8" });
  assert.equal(key.asymmetricKeyType, "rsa");
});

test("two bundles are two different keys", () => {
  const a = readSigningBundle(createSigningBundle()).certificate.fingerprint256;
  const b = readSigningBundle(createSigningBundle()).certificate.fingerprint256;
  assert.notEqual(a, b);
});

test("a damaged or foreign bundle is refused with a plain message, never used", () => {
  assert.throws(() => readSigningBundle(""), /not readable|not a FroozERP/);
  assert.throws(() => readSigningBundle("not base64 json"), /not readable/);
  assert.throws(() => readSigningBundle(Buffer.from('{"version":2}').toString("base64")), /not a FroozERP Android signing key/);
  const one = JSON.parse(Buffer.from(createSigningBundle(), "base64").toString());
  const two = JSON.parse(Buffer.from(createSigningBundle(), "base64").toString());
  const mixed = Buffer.from(JSON.stringify({ ...one, cert_der: two.cert_der })).toString("base64");
  assert.throws(() => readSigningBundle(mixed), /do not belong together/);
});

test("create never overwrites a key, and unpack writes what apksigner takes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-signing-"));
  const bundle = path.join(dir, "bundle.txt");
  execFileSync(process.execPath, [SCRIPT, "create", "--out", bundle]);
  const first = fs.readFileSync(bundle, "utf8");
  assert.throws(() => execFileSync(process.execPath, [SCRIPT, "create", "--out", bundle], { stdio: "pipe" }));
  assert.equal(fs.readFileSync(bundle, "utf8"), first, "the existing key is untouched");
  const out = path.join(dir, "unpacked");
  const printed = execFileSync(process.execPath, [SCRIPT, "unpack", bundle, out], { encoding: "utf8" });
  assert.match(printed, /Signing certificate SHA-256: [0-9A-F:]+/);
  const cert = new crypto.X509Certificate(fs.readFileSync(path.join(out, "cert.der")));
  assert.ok(cert.checkPrivateKey(crypto.createPrivateKey({ key: fs.readFileSync(path.join(out, "key.pk8")), format: "der", type: "pkcs8" })));
  fs.rmSync(dir, { recursive: true, force: true });
});
