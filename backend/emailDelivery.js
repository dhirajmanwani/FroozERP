// Every email FroozERP sends (recovery codes, contact verification, the provider test) goes
// through here, so there is one answer to "is email set up" and one way a failure is worded.
//
// Two ways to send:
// - An HTTPS email service (`EMAIL_PROVIDER` = brevo or resend, with `EMAIL_API_KEY`). This is
//   the one that works on Railway's Hobby plan, which blocks outbound SMTP (ports 25, 465 and
//   587): an SMTP connection there never opens, so every code "failed to send" after a long wait.
// - Plain SMTP (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`), for hosts that allow it.
// When both are set the HTTPS service wins, because it is the one that was set up on purpose
// for a host where SMTP does not get out.
//
// `sendEmail` never throws. A delivery that failed comes back as `delivered: false` with a
// `reason` a shop owner can act on, because "Unable to send recovery code" told nobody whether
// the password, the host or the plan was wrong.

const clean = (value) => String(value ?? "").trim();

const splitSender = (value) => {
  const text = clean(value);
  const match = text.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return match ? { name: clean(match[1]), email: clean(match[2]) } : { name: "", email: text };
};

const API_PROVIDERS = {
  brevo: {
    label: "Brevo",
    endpoint: "https://api.brevo.com/v3/smtp/email",
    headers: (key) => ({ "api-key": key, accept: "application/json" }),
    body: ({ from, fromName, to, subject, text, html }) => ({
      sender: { name: fromName, email: from },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html || undefined,
    }),
    messageId: (payload) => payload?.messageId || "",
  },
  resend: {
    label: "Resend",
    endpoint: "https://api.resend.com/emails",
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    body: ({ from, fromName, to, subject, text, html }) => ({
      from: fromName ? `${fromName} <${from}>` : from,
      to: [to],
      subject,
      text,
      html: html || undefined,
    }),
    messageId: (payload) => payload?.id || "",
  },
};

// The longest one send may take, whichever way it goes. The desktop gateway gives up on a cloud
// request after 15 seconds and reports the cloud as unreachable, so a send that outlasts that is
// reported as the wrong fault. nodemailer's own defaults are two minutes to connect and ten on a
// silent socket, which on a host that blocks SMTP meant a spinner and then a misleading error.
const EMAIL_SEND_DEADLINE_MS = 12000;
const SMTP_TIMEOUTS = { connectionTimeout: 10000, greetingTimeout: 8000, socketTimeout: 10000 };
const API_TIMEOUT_MS = EMAIL_SEND_DEADLINE_MS;

const SMTP_BLOCKED_HINT = "Railway's Hobby plan blocks email over SMTP; set EMAIL_PROVIDER=brevo and EMAIL_API_KEY instead";

const emailSettings = (env = process.env) => {
  const apiProvider = clean(env.EMAIL_PROVIDER).toLowerCase();
  const apiKey = clean(env.EMAIL_API_KEY);
  const smtpPassword = clean(env.SMTP_PASS || env.SMTP_PASSWORD);
  // A sender may be written bare (shop@gmail.com) or with its name (FroozERP <shop@gmail.com>).
  const sender = splitSender(env.EMAIL_FROM || env.SMTP_FROM || env.SMTP_USER);
  const from = sender.email;
  const fromName = clean(env.EMAIL_SENDER_NAME || env.SMTP_SENDER_NAME || sender.name || "FroozERP");

  if (apiProvider || apiKey) {
    const known = Boolean(API_PROVIDERS[apiProvider]);
    const required = { provider: known, api_key: Boolean(apiKey), sender: Boolean(from) };
    const missing = [];
    if (!known) missing.push(apiProvider ? `EMAIL_PROVIDER (brevo or resend, not "${apiProvider}")` : "EMAIL_PROVIDER (brevo or resend)");
    if (!apiKey) missing.push("EMAIL_API_KEY");
    if (!from) missing.push("EMAIL_FROM");
    return {
      provider: known ? apiProvider : "api",
      transport: "https",
      configured: missing.length === 0,
      required,
      missing,
      from,
      fromName,
      apiKey,
    };
  }

  const required = {
    smtp_host: Boolean(clean(env.SMTP_HOST)),
    smtp_user: Boolean(clean(env.SMTP_USER)),
    smtp_password: Boolean(smtpPassword),
    sender: Boolean(from),
  };
  const missing = [
    !required.smtp_host && "SMTP_HOST",
    !required.smtp_user && "SMTP_USER",
    !required.smtp_password && "SMTP_PASS",
  ].filter(Boolean);
  return {
    provider: "smtp",
    transport: "smtp",
    configured: missing.length === 0,
    required,
    missing,
    from,
    fromName,
    host: clean(env.SMTP_HOST),
    port: Number(env.SMTP_PORT || 587),
    secure: /^true$/i.test(clean(env.SMTP_SECURE)),
    user: clean(env.SMTP_USER),
    password: smtpPassword,
  };
};

// What the settings screen may show. Never the key or the password, only whether they are set.
const publicEmailSettings = (settings) => {
  const { apiKey, password, ...rest } = settings;
  return {
    ...rest,
    api_key_configured: Boolean(apiKey),
    password_configured: Boolean(password),
    sender_email: settings.from,
    sender_name: settings.fromName,
  };
};

const SMTP_UNREACHABLE_CODES = new Set(["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN"]);

const describeSmtpFailure = (error, settings) => {
  const code = clean(error?.code);
  const responseCode = Number(error?.responseCode);
  if (code === "EAUTH" || responseCode === 535 || responseCode === 534) {
    return {
      status: "provider_rejected",
      reason: /gmail/i.test(settings.host)
        ? "Gmail refused the email password. Gmail needs a 16-letter App Password here, not the normal password"
        : "the email server refused the SMTP username or password",
    };
  }
  if (SMTP_UNREACHABLE_CODES.has(code) || /timeout|timed out/i.test(clean(error?.message))) {
    return {
      status: "unreachable",
      reason: `the email server ${settings.host}:${settings.port} could not be reached (${SMTP_BLOCKED_HINT})`,
    };
  }
  if (responseCode >= 500 && /sender|from|relay/i.test(clean(error?.response))) {
    return { status: "provider_rejected", reason: `the email server refused the sender ${settings.from}` };
  }
  return {
    status: "provider_rejected",
    reason: `the email server answered: ${clean(error?.response || error?.message || "unknown error").slice(0, 160)}`,
  };
};

const describeApiFailure = (label, httpStatus, payload) => {
  const detail = clean(payload?.message || payload?.error?.message || payload?.name || "").slice(0, 160);
  if (httpStatus === 401 || httpStatus === 403) {
    return { status: "provider_rejected", reason: `${label} refused the EMAIL_API_KEY${detail ? ` (${detail})` : ""}` };
  }
  return {
    status: "provider_rejected",
    reason: `${label} answered HTTP ${httpStatus}${detail ? `: ${detail}` : ""}`,
  };
};

const sendViaApi = async (settings, message, { fetchImpl = globalThis.fetch } = {}) => {
  const api = API_PROVIDERS[settings.provider];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetchImpl(api.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...api.headers(settings.apiKey) },
      body: JSON.stringify(api.body({ ...message, from: settings.from, fromName: settings.fromName })),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return { delivered: false, provider: settings.provider, http_status: response.status, ...describeApiFailure(api.label, response.status, payload) };
    }
    return { delivered: true, provider: settings.provider, status: "accepted", message_id: api.messageId(payload) };
  } catch (error) {
    return {
      delivered: false,
      provider: settings.provider,
      status: "unreachable",
      reason: `${api.label} could not be reached (${clean(error?.name === "AbortError" ? `no answer in ${API_TIMEOUT_MS / 1000} seconds` : error?.message) || "network error"})`,
    };
  } finally {
    clearTimeout(timer);
  }
};

const sendViaSmtp = async (settings, message, { createTransport, deadlineMs = EMAIL_SEND_DEADLINE_MS }) => {
  let transporter = null;
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`no answer in ${deadlineMs / 1000} seconds`), { code: "ETIMEDOUT" })), deadlineMs);
  });
  try {
    transporter = createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: { user: settings.user, pass: settings.password },
      ...SMTP_TIMEOUTS,
    });
    const info = await Promise.race([deadline, transporter.sendMail({
      from: settings.fromName ? `"${settings.fromName.replace(/"/g, "")}" <${settings.from}>` : settings.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html || undefined,
    })]);
    return { delivered: true, provider: "smtp", status: "accepted", message_id: info?.messageId || "" };
  } catch (error) {
    return { delivered: false, provider: "smtp", ...describeSmtpFailure(error, settings) };
  } finally {
    clearTimeout(timer);
    try { transporter?.close?.(); } catch { /* already closed */ }
  }
};

const sendEmail = async (message, { env = process.env, fetchImpl, createTransport, deadlineMs } = {}) => {
  const settings = emailSettings(env);
  if (!settings.configured) {
    return {
      delivered: false,
      provider: settings.provider,
      status: "not_configured",
      reason: `missing ${settings.missing.join(", ")}`,
    };
  }
  if (settings.transport === "https") return sendViaApi(settings, message, { fetchImpl });
  return sendViaSmtp(settings, message, { createTransport: createTransport || require("nodemailer").createTransport, deadlineMs });
};

module.exports = {
  API_PROVIDERS,
  EMAIL_SEND_DEADLINE_MS,
  SMTP_TIMEOUTS,
  describeSmtpFailure,
  emailSettings,
  publicEmailSettings,
  sendEmail,
  splitSender,
};
