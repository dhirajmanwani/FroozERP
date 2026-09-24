const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  EMAIL_SEND_DEADLINE_MS,
  emailSettings,
  publicEmailSettings,
  sendEmail,
  splitSender,
} = require("./emailDelivery");

const MESSAGE = { to: "owner@example.test", subject: "Your FroozERP verification code", text: "Code 123456", html: "<p>123456</p>" };

const smtpEnv = { SMTP_HOST: "smtp.gmail.com", SMTP_USER: "shop@gmail.com", SMTP_PASS: "app-password" };
const brevoEnv = { EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "xkeysib-test", EMAIL_FROM: "shop@gmail.com" };

const fakeFetch = (status, payload, calls = []) => async (url, options) => {
  calls.push({ url, options, body: JSON.parse(options.body) });
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
};

const fakeTransport = (behaviour, calls = []) => (options) => ({
  sendMail: async (mail) => {
    calls.push({ options, mail });
    return behaviour(mail);
  },
  close: () => calls.push({ closed: true }),
});

test("nothing set means not configured, and the reason names what is missing", async () => {
  const settings = emailSettings({});
  assert.equal(settings.configured, false);
  assert.deepEqual(settings.missing, ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]);
  const result = await sendEmail(MESSAGE, { env: {} });
  assert.equal(result.delivered, false);
  assert.equal(result.status, "not_configured");
  assert.match(result.reason, /SMTP_HOST/);
});

test("an HTTPS email service wins over SMTP when both are set", () => {
  const settings = emailSettings({ ...smtpEnv, ...brevoEnv });
  assert.equal(settings.provider, "brevo");
  assert.equal(settings.transport, "https");
  assert.equal(settings.configured, true);
});

test("a half-set HTTPS service is reported as such instead of falling back to SMTP silently", () => {
  const unknown = emailSettings({ ...smtpEnv, EMAIL_PROVIDER: "sendgridd", EMAIL_API_KEY: "k", EMAIL_FROM: "a@b.test" });
  assert.equal(unknown.configured, false);
  assert.match(unknown.missing.join(" "), /brevo or resend, not "sendgridd"/);
  const noKey = emailSettings({ EMAIL_PROVIDER: "resend", EMAIL_FROM: "a@b.test" });
  assert.deepEqual(noKey.missing, ["EMAIL_API_KEY"]);
});

test("the settings screen never receives the key or the password", () => {
  const shown = publicEmailSettings(emailSettings({ ...brevoEnv }));
  const text = JSON.stringify(shown);
  assert.doesNotMatch(text, /xkeysib-test/);
  assert.equal(shown.api_key_configured, true);
  const smtpShown = JSON.stringify(publicEmailSettings(emailSettings(smtpEnv)));
  assert.doesNotMatch(smtpShown, /app-password/);
});

test("a sender can be written bare or with its name", () => {
  assert.deepEqual(splitSender("shop@gmail.com"), { name: "", email: "shop@gmail.com" });
  assert.deepEqual(splitSender("Frooz Fruits <shop@gmail.com>"), { name: "Frooz Fruits", email: "shop@gmail.com" });
  assert.deepEqual(splitSender("\"Frooz\" <shop@gmail.com>"), { name: "Frooz", email: "shop@gmail.com" });
  const settings = emailSettings({ ...brevoEnv, EMAIL_FROM: "Frooz Fruits <shop@gmail.com>" });
  assert.equal(settings.from, "shop@gmail.com");
  assert.equal(settings.fromName, "Frooz Fruits");
});

test("Brevo is called with its own request shape and the key in its own header", async () => {
  const calls = [];
  const result = await sendEmail(MESSAGE, { env: brevoEnv, fetchImpl: fakeFetch(201, { messageId: "<m1@brevo>" }, calls) });
  assert.equal(result.delivered, true);
  assert.equal(result.message_id, "<m1@brevo>");
  assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
  assert.equal(calls[0].options.headers["api-key"], "xkeysib-test");
  assert.deepEqual(calls[0].body.to, [{ email: "owner@example.test" }]);
  assert.equal(calls[0].body.sender.email, "shop@gmail.com");
  assert.equal(calls[0].body.textContent, "Code 123456");
});

test("Resend is called with a bearer key", async () => {
  const calls = [];
  const env = { EMAIL_PROVIDER: "resend", EMAIL_API_KEY: "re_test", EMAIL_FROM: "codes@frooz.test" };
  const result = await sendEmail(MESSAGE, { env, fetchImpl: fakeFetch(200, { id: "abc" }, calls) });
  assert.equal(result.delivered, true);
  assert.equal(calls[0].url, "https://api.resend.com/emails");
  assert.equal(calls[0].options.headers.Authorization, "Bearer re_test");
  assert.equal(calls[0].body.from, "FroozERP <codes@frooz.test>");
});

test("a refused API key says so, with the service's own words", async () => {
  const result = await sendEmail(MESSAGE, { env: brevoEnv, fetchImpl: fakeFetch(401, { code: "unauthorized", message: "Key not found" }) });
  assert.equal(result.delivered, false);
  assert.equal(result.status, "provider_rejected");
  assert.match(result.reason, /Brevo refused the EMAIL_API_KEY \(Key not found\)/);
});

test("an unreachable email service is a failure with a reason, never a throw", async () => {
  const fetchImpl = async () => { throw new TypeError("fetch failed"); };
  const result = await sendEmail(MESSAGE, { env: brevoEnv, fetchImpl });
  assert.equal(result.delivered, false);
  assert.equal(result.status, "unreachable");
  assert.match(result.reason, /Brevo could not be reached/);
});

test("SMTP sends with short timeouts, the sender's name, and closes the connection", async () => {
  const calls = [];
  const result = await sendEmail(MESSAGE, { env: smtpEnv, createTransport: fakeTransport(() => ({ messageId: "<s1>" }), calls) });
  assert.equal(result.delivered, true);
  const opened = calls[0].options;
  assert.equal(opened.host, "smtp.gmail.com");
  assert.equal(opened.port, 587);
  assert.ok(opened.connectionTimeout <= EMAIL_SEND_DEADLINE_MS);
  assert.equal(calls[0].mail.from, "\"FroozERP\" <shop@gmail.com>");
  assert.ok(calls.some((entry) => entry.closed));
});

test("a refused Gmail password points at the App Password", async () => {
  const refuse = () => { throw Object.assign(new Error("Invalid login: 535-5.7.8 Username and Password not accepted"), { code: "EAUTH", responseCode: 535 }); };
  const result = await sendEmail(MESSAGE, { env: smtpEnv, createTransport: fakeTransport(refuse) });
  assert.equal(result.delivered, false);
  assert.equal(result.status, "provider_rejected");
  assert.match(result.reason, /App Password/);
});

test("a blocked SMTP port names the Railway plan and the way around it", async () => {
  const block = () => { throw Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT" }); };
  const result = await sendEmail(MESSAGE, { env: smtpEnv, createTransport: fakeTransport(block) });
  assert.equal(result.status, "unreachable");
  assert.match(result.reason, /smtp\.gmail\.com:587 could not be reached/);
  assert.match(result.reason, /EMAIL_PROVIDER=brevo/);
});

test("an SMTP server that never answers is cut off at the deadline, not left hanging", async () => {
  const hang = () => new Promise(() => {});
  const started = Date.now();
  const result = await sendEmail(MESSAGE, { env: smtpEnv, createTransport: fakeTransport(hang), deadlineMs: 50 });
  assert.ok(Date.now() - started < 2000);
  assert.equal(result.delivered, false);
  assert.equal(result.status, "unreachable");
});

test("the deadline leaves room inside the desktop gateway's cloud timeout", () => {
  // The gateway aborts a forwarded request after this many ms and calls the cloud unreachable.
  const gateway = fs.readFileSync(path.join(__dirname, "desktopGateway.js"), "utf8");
  const match = gateway.match(/return fetch\(`\$\{CLOUD_API_URL\}\$\{route\}`[\s\S]*?AbortSignal\.timeout\((\d+)\)/);
  assert.ok(match, "the gateway's forwarding timeout must still be readable");
  assert.ok(EMAIL_SEND_DEADLINE_MS + 2000 <= Number(match[1]), `${EMAIL_SEND_DEADLINE_MS} ms leaves no room inside ${match[1]} ms`);
});

test("server email failures use a status the gateway passes through, with the reason in the message", () => {
  const server = fs.readFileSync(path.join(__dirname, "server.js"), "utf8");
  assert.match(server, /const PROVIDER_FAILURE_STATUS = 424;/);
  for (const code of ["EMAIL_PROVIDER_NOT_CONFIGURED", "EMAIL_DELIVERY_FAILED", "PROVIDER_DELIVERY_FAILED"]) {
    const at = server.indexOf(`"${code}"`);
    assert.ok(at > 0, `${code} must still exist`);
  }
  assert.doesNotMatch(server, /res\.status\(503\)\.json\(\{\s*(?:\.\.\.status,\s*)?code: "EMAIL_/);
  assert.doesNotMatch(server, /require\("nodemailer"\)/, "email goes through emailDelivery.js only");
  assert.match(server, /emailDeliveryFailureMessage\(delivery\)/);
});
