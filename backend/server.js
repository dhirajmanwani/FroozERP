const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { Pool, types } = require("pg");
const nodemailer = require("nodemailer");

types.setTypeParser(1082, (value) => value);

const app = express();
app.use(express.json({ limit: "25mb" }));

const pool = new Pool({
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "froozerp",
  password: process.env.DB_PASSWORD || "8386",
  port: Number(process.env.DB_PORT) || 5432,
});
const port = Number(process.env.PORT) || 5000;
const host = process.env.HOST || "0.0.0.0";
const backupDirectory = process.env.BACKUP_DIR || path.join(__dirname, "..", "backups");
const allowedCorsOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedTauriCorsOrigins = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
]);

const isPrivateNetworkHost = (hostname) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "::1" ||
  /^10\./.test(hostname) ||
  /^192\.168\./.test(hostname) ||
  /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedCorsOrigins.includes("*") || allowedCorsOrigins.includes(origin)) return callback(null, true);
    if (allowedTauriCorsOrigins.has(origin)) return callback(null, true);
    try {
      const parsed = new URL(origin);
      if (isPrivateNetworkHost(parsed.hostname)) return callback(null, true);
    } catch {
      return callback(new Error("Invalid CORS origin"));
    }
    return callback(new Error("Origin not allowed by FroozERP CORS"));
  },
}));

const parsePositiveNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const parsePositiveInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
};

const parseNonNegativeNumber = (value) => {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : null;
};

const roundCurrency = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const roundUnitCost = (value) => Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
const hashPassword = (password) =>
  crypto.createHash("sha256").update(String(password || ""), "utf8").digest("hex");
const hashActivationCode = (code) =>
  crypto.createHash("sha256").update(String(code || "").trim().toUpperCase(), "utf8").digest("hex");
const generateActivationCode = () => `FTF-${crypto.randomBytes(3).toString("hex").toUpperCase()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
const normalizeUsername = (value) => cleanText(value).toLowerCase();
const normalizePhone = (value) => cleanText(value).replace(/[^\d+]/g, "");
const normalizeWhatsappPhone = (value, defaultCountryCode = "91") => {
  let digits = cleanText(value).replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("+")) digits = digits.slice(1);
  digits = digits.replace(/\D/g, "");
  const countryCode = cleanText(defaultCountryCode).replace(/\D/g, "") || "91";
  if (digits.length === 10) digits = `${countryCode}${digits}`;
  if (digits.length < 11 || digits.length > 15) return "";
  return digits;
};
const maskAccessToken = (value) => {
  const token = cleanText(value);
  if (!token) return "";
  return `${token.slice(0, 5)}...${token.slice(-4)}`;
};
const hashSensitiveValue = (value) =>
  crypto.createHash("sha256").update(String(value || "").trim().toLowerCase(), "utf8").digest("hex");
const recoveryOtpSecret = process.env.RECOVERY_OTP_HASH_SECRET || process.env.OTP_HASH_SECRET || process.env.DB_PASSWORD || "froozerp-local-dev-otp-secret";
const recoveryGenericMessage = "If the provided information matches an eligible account, a verification code will be sent.";
const recoveryDevOtpEnabled = /^true$/i.test(process.env.RECOVERY_DEV_OTP_ENABLED || "") && process.env.NODE_ENV !== "production";
const generateOtpCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, "0");
const generateTemporaryPassword = () => `FZ-${crypto.randomBytes(4).toString("hex").toUpperCase()}-${crypto.randomInt(1000, 9999)}`;
const hashOtp = (requestId, otp) =>
  crypto.createHmac("sha256", recoveryOtpSecret).update(`${requestId}:${String(otp || "").trim()}`).digest("hex");
const hashRecoveryToken = (requestId, token) =>
  crypto.createHmac("sha256", recoveryOtpSecret).update(`token:${requestId}:${String(token || "")}`).digest("hex");
const maskEmail = (email) => {
  const value = cleanText(email);
  const [name, domain] = value.split("@");
  if (!name || !domain) return "";
  return `${name.slice(0, 1)}***@${domain}`;
};
const maskMobile = (mobile) => {
  const value = normalizePhone(mobile);
  if (!value) return "";
  return `${"*".repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
};
const normalizeRecoveryEmail = (email) => {
  const value = cleanText(email).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
};
const normalizeRecoveryMobile = (mobile) => {
  const digits = cleanText(mobile).replace(/[^\d]/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return "";
};
const buildOtpEmailHtml = ({ code, purpose }) => `
  <div style="font-family:Arial,sans-serif;background:#0f172a;padding:24px;color:#e2e8f0">
    <div style="max-width:520px;margin:auto;background:#1e293b;border:1px solid #334155;border-radius:12px;padding:24px">
      <h2 style="margin:0 0 8px;color:#f8fafc">FroozERP Verification Code</h2>
      <p style="margin:0 0 18px;color:#cbd5e1">Use this code to ${purpose === "username" ? "recover your username" : purpose === "contact" ? "verify your recovery contact" : "reset your password"}.</p>
      <div style="font-size:32px;letter-spacing:8px;font-weight:800;color:#fbbf24">${code}</div>
      <p style="margin:18px 0 0;color:#94a3b8">This code expires in 10 minutes. If you did not request this, contact your Owner/Admin.</p>
      <p style="margin:14px 0 0;color:#94a3b8">FroozERP - Feel the Freakin' Frooz<br/>SRT Company</p>
    </div>
  </div>
`;
const getLanIpAddresses = () => Object.values(os.networkInterfaces())
  .flat()
  .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
  .map((entry) => entry.address);
const getPrimaryLanIp = () => getLanIpAddresses()[0] || "localhost";
const ensureDirectory = async (directory) => {
  await fs.promises.mkdir(directory, { recursive: true });
  return directory;
};
const formatBackupTimestamp = (date = new Date()) => {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
};
const execFileAsync = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout, stderr) => {
    if (error) {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
      return;
    }
    resolve({ stdout, stderr });
  });
});
const escapePowerShellSingleQuoted = (value) => String(value).replace(/'/g, "''");
const passwordMatches = (password, storedHash) => {
  const stored = cleanText(storedHash);
  if (!stored) return false;
  return stored === hashPassword(password) || stored === String(password || "");
};
const applySaleRateRounding = (value, rule) => {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount)) return 0;
  switch (rule) {
    case "ROUND_UP_5":
      return Math.ceil(amount / 5) * 5;
    case "ROUND_UP_10":
      return Math.ceil(amount / 10) * 10;
    case "NO_ROUND":
      return roundCurrency(amount);
    case "NEAREST_RUPEE":
    default:
      return Math.round(amount);
  }
};
const toDateKey = (value) =>
  value instanceof Date ? value.toLocaleDateString("en-CA") : String(value).slice(0, 10);
const toBusinessDateKey = (value) => {
  const text = cleanText(value);
  if (!text) return toDateKey(new Date());
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return `${match[1]}-${match[2]}-${match[3]}`;
  return toDateKey(new Date(text));
};
const RATE_MANAGER_ROLES = new Set(["Owner", "Admin"]);
const SUPPLIER_TYPES = new Set(["LOCAL_SUPPLIER", "IMPORTED_SUPPLIER", "COMMISSION_AGENT", "TRANSPORT_VENDOR"]);
const SUPPLIER_PAYMENT_MODES = new Set(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE"]);
const BANK_PAYMENT_MODES = ["UPI", "CARD", "BANK_TRANSFER", "BANK", "CHEQUE"];
const CUSTOMER_TYPES = new Set(["RETAIL", "WHOLESALE"]);
const ACCOUNT_TYPES = new Set(["CUSTOMER", "SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT", "STAFF", "OTHER"]);
const DISCOUNT_TYPES = new Set(["FLAT_AMOUNT", "PERCENTAGE"]);
const DISCOUNT_PAYMENT_MODES = new Set(["ALL", "CASH", "UPI", "CARD"]);
const LOT_DISCOUNT_TYPES = new Set(["FIXED_AMOUNT", "PERCENTAGE", "SPECIAL_RATE"]);
const ROUNDING_RULES = new Set(["NEAREST_RUPEE", "ROUND_UP_5", "ROUND_UP_10", "NO_ROUND"]);
const SALE_STATUSES = new Set(["COMPLETED", "EDITED", "CANCELLED"]);
const REFUND_TYPES = new Set(["CASH_REFUND", "UPI_REFUND", "CREDIT_NOTE", "FUTURE_ADJUSTMENT"]);
const WASTE_TYPES = new Set(["DAAGI", "SAMPLING", "PERSONAL_USE", "OTHER"]);
const PURCHASE_BILL_STATUSES = new Set(["BILL_PENDING", "BILL_COMPLETED"]);
const PRODUCT_UNITS = new Set(["KG", "BOX", "PIECE", "DOZEN"]);
const PERMISSION_KEYS = [
  "settings",
  "discounts",
  "mandi_tax",
  "rebate_rules",
  "supplier_payments",
  "customer_payments",
  "sale_edit",
  "invoice_cancellation",
  "reports",
  "purchases",
  "supplier_accounts",
  "inventory",
  "waste_management",
  "billing",
  "manual_pos_rate_override",
  "pos_date_override",
  "sale_date_edit",
  "device_management",
  "activation_codes",
  "backup_restore",
  "branch_settings",
  "system_info",
  "whatsapp_send",
  "whatsapp_settings",
];

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");
const nullableText = (value) => cleanText(value) || null;
const safeDocumentFileName = (value) =>
  (cleanText(value) || "FroozERP_Document.pdf")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 180);
const normalizeSupplierType = (value) => String(value || "LOCAL_SUPPLIER").toUpperCase();
const normalizePaymentMode = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, "_");
const normalizeDiscountType = (value) => String(value || "FLAT_AMOUNT").toUpperCase();
const normalizeDiscountPaymentMode = (value) => String(value || "ALL").trim().toUpperCase();
const normalizeRefundType = (value) => String(value || "CASH_REFUND").trim().toUpperCase();
const normalizeWasteType = (value) => String(value || "DAAGI").trim().toUpperCase();
const normalizeProductUnit = (value) => {
  const unit = String(value || "").trim().toUpperCase();
  return PRODUCT_UNITS.has(unit) ? unit : unit;
};

const requireRateManager = async (userId, client = pool) => {
  const parsedUserId = parsePositiveInteger(userId);
  if (!parsedUserId) return null;
  const result = await client.query(
    `
    SELECT u.id, u.full_name, r.role_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.id = $1 AND u.active = TRUE
    `,
    [parsedUserId]
  );
  const user = result.rows[0];
  return user && RATE_MANAGER_ROLES.has(user.role_name) ? user : null;
};

const writeAuthAudit = async ({ userId = null, actorUserId = null, username = "", action, safeCode = "", deviceId = "", ipAddress = "", details = {} }, client = pool) => {
  try {
    await client.query(
      `
      INSERT INTO auth_audit_log (user_id, actor_user_id, username, action, safe_code, device_id, ip_address, details)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `,
      [
        parsePositiveInteger(userId),
        parsePositiveInteger(actorUserId),
        cleanText(username) || null,
        cleanText(action) || "AUTH_EVENT",
        cleanText(safeCode) || null,
        cleanText(deviceId) || null,
        cleanText(ipAddress) || null,
        JSON.stringify(details || {}),
      ]
    );
  } catch (error) {
    console.error("Auth audit failed", error.message || error);
  }
};

const authFailure = async (res, { status = 401, code = "INVALID_CREDENTIALS", publicMessage = "Invalid username or password.", userId = null, username = "", deviceId = "", ipAddress = "", details = {} }) => {
  await writeAuthAudit({ userId, username, action: "LOGIN_FAILED", safeCode: code, deviceId, ipAddress, details });
  return res.status(status).json({ code, message: publicMessage });
};

const getRecoveryProviderStatus = () => ({
  email: process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS ? "configured" : "not_configured",
  sms: process.env.SMS_PROVIDER_URL && (process.env.SMS_PROVIDER_TOKEN || process.env.SMS_PROVIDER_API_KEY) ? "configured" : "not_configured",
  development: recoveryDevOtpEnabled ? "enabled" : "disabled",
});

const sendEmailOtp = async ({ to, code, purpose }) => {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    return { delivered: false, provider: "EmailOtpProvider", status: "not_configured" };
  }
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: /^true$/i.test(process.env.SMTP_SECURE || ""),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
  const from = process.env.SMTP_FROM || process.env.SMTP_USER;
  const info = await transporter.sendMail({
    from,
    to,
    subject: "Your FroozERP verification code",
    text: `Your FroozERP verification code is ${code}. It expires in 10 minutes.`,
    html: buildOtpEmailHtml({ code, purpose }),
  });
  return { delivered: true, provider: "EmailOtpProvider", status: "accepted", message_id: info.messageId };
};

const sendSmsOtp = async ({ to, code }) => {
  if (!process.env.SMS_PROVIDER_URL || !(process.env.SMS_PROVIDER_TOKEN || process.env.SMS_PROVIDER_API_KEY)) {
    return { delivered: false, provider: "SmsOtpProvider", status: "not_configured" };
  }
  const template = process.env.SMS_PROVIDER_TEMPLATE || "Your FroozERP verification code is {{otp}}. It expires in 10 minutes.";
  const body = {
    to,
    message: template.replace("{{otp}}", code),
    sender: process.env.SMS_SENDER_ID || "FROOZ",
    template_id: process.env.SMS_TEMPLATE_ID || undefined,
  };
  const headers = { "Content-Type": "application/json" };
  if (process.env.SMS_PROVIDER_TOKEN) headers.Authorization = `Bearer ${process.env.SMS_PROVIDER_TOKEN}`;
  if (process.env.SMS_PROVIDER_API_KEY) headers["x-api-key"] = process.env.SMS_PROVIDER_API_KEY;
  const response = await fetch(process.env.SMS_PROVIDER_URL, {
    method: process.env.SMS_PROVIDER_METHOD || "POST",
    headers,
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  if (!response.ok) {
    return { delivered: false, provider: "SmsOtpProvider", status: "provider_rejected", http_status: response.status, response: responseText.slice(0, 180) };
  }
  return { delivered: true, provider: "SmsOtpProvider", status: "accepted", http_status: response.status };
};

const sendRecoveryOtp = async ({ method, contact, code, purpose }) => {
  const providerStatus = getRecoveryProviderStatus();
  if (method === "email" && providerStatus.email === "configured") {
    return sendEmailOtp({ to: contact, code, purpose });
  }
  if (method === "mobile" && providerStatus.sms === "configured") {
    return sendSmsOtp({ to: contact, code, purpose });
  }
  if (recoveryDevOtpEnabled) {
    return { delivered: true, provider: "DevelopmentOtpProvider", status: "development_only", development_code: code, purpose };
  }
  return { delivered: false, provider: method === "email" ? "EmailOtpProvider" : "SmsOtpProvider", status: "not_configured" };
};

const sendRecoveryNotification = async ({ method, contact, subject, message, html }) => {
  const providerStatus = getRecoveryProviderStatus();
  if (method === "email") {
    if (providerStatus.email !== "configured") return { delivered: false, provider: "EmailOtpProvider", status: "not_configured" };
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: /^true$/i.test(process.env.SMTP_SECURE || ""),
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: contact,
      subject,
      text: message,
      html,
    });
    return { delivered: true, provider: "EmailOtpProvider", status: "accepted", message_id: info.messageId };
  }
  if (providerStatus.sms !== "configured") return { delivered: false, provider: "SmsOtpProvider", status: "not_configured" };
  const headers = { "Content-Type": "application/json" };
  if (process.env.SMS_PROVIDER_TOKEN) headers.Authorization = `Bearer ${process.env.SMS_PROVIDER_TOKEN}`;
  if (process.env.SMS_PROVIDER_API_KEY) headers["x-api-key"] = process.env.SMS_PROVIDER_API_KEY;
  const response = await fetch(process.env.SMS_PROVIDER_URL, {
    method: process.env.SMS_PROVIDER_METHOD || "POST",
    headers,
    body: JSON.stringify({
      to: contact,
      message,
      sender: process.env.SMS_SENDER_ID || "FROOZ",
      template_id: process.env.SMS_TEMPLATE_ID || undefined,
    }),
  });
  const responseText = await response.text();
  if (!response.ok) {
    return { delivered: false, provider: "SmsOtpProvider", status: "provider_rejected", http_status: response.status, response: responseText.slice(0, 180) };
  }
  return { delivered: true, provider: "SmsOtpProvider", status: "accepted", http_status: response.status };
};

const findRecoveryUser = async (identifier, client = pool) => {
  const text = cleanText(identifier);
  const phone = normalizePhone(text);
  if (!text) return null;
  const result = await client.query(
    `
    SELECT
      u.id, u.full_name, u.username, u.active, u.mobile_number, u.email,
      u.verified_email, u.verified_mobile, u.recovery_enabled,
      u.recovery_email, u.recovery_email_verified, u.recovery_email_verified_at,
      u.recovery_mobile, u.recovery_mobile_verified, u.recovery_mobile_verified_at,
      u.staff_self_recovery_enabled, u.force_password_change,
      r.role_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE LOWER(u.username) = LOWER($1)
       OR ($2 <> '' AND LOWER(COALESCE(u.recovery_email, u.verified_email, '')) = LOWER($2))
       OR ($3 <> '' AND COALESCE(u.recovery_mobile, u.verified_mobile, '') = $3)
    ORDER BY CASE WHEN LOWER(u.username) = LOWER($1) THEN 0 ELSE 1 END, u.id
    LIMIT 1
    `,
    [text, text, phone]
  );
  return result.rows[0] || null;
};

const getRecoveryMethodsForUser = (user) => {
  if (!user) return [];
  const roleName = String(user.role_name || "");
  const manager = RATE_MANAGER_ROLES.has(roleName);
  if (!manager && user.staff_self_recovery_enabled !== true) return [];
  const methods = [];
  const email = cleanText(user.recovery_email || user.verified_email);
  const mobile = cleanText(user.recovery_mobile || user.verified_mobile);
  const emailVerified = user.recovery_email_verified === true || (!user.recovery_email && Boolean(user.verified_email));
  const mobileVerified = user.recovery_mobile_verified === true || (!user.recovery_mobile && Boolean(user.verified_mobile));
  if (email && emailVerified) methods.push({ method: "email", label: `Email: ${maskEmail(email)}` });
  if (mobile && mobileVerified) methods.push({ method: "mobile", label: `Mobile: ${maskMobile(mobile)}` });
  return methods;
};

const ensureRecoveryEligible = (user) => {
  if (!user) return { ok: false, code: "GENERIC_RESPONSE", message: recoveryGenericMessage };
  if (user.active === false) return { ok: false, code: "USER_DISABLED", message: "This account is disabled. Contact your Owner or Administrator." };
  if (user.recovery_enabled === false) return { ok: false, code: "RECOVERY_NOT_ENABLED", message: "Account recovery is not enabled for this user." };
  const roleName = String(user.role_name || "");
  const manager = RATE_MANAGER_ROLES.has(roleName);
  if (!manager && user.staff_self_recovery_enabled !== true) {
    return {
      ok: false,
      code: "STAFF_OWNER_ASSISTANCE_REQUIRED",
      message: "Account assistance required. For the security of your business, staff login recovery is managed by your authorised Owner or Administrator.",
    };
  }
  const methods = getRecoveryMethodsForUser(user);
  if (!methods.length) {
    return { ok: false, code: "RECOVERY_CONTACT_NOT_CONFIGURED", message: "No verified recovery email or mobile is configured for this account." };
  }
  return { ok: true, methods };
};

const getSupportContacts = async ({ staffOnly = false } = {}) => {
  const result = await pool.query(
    `
    SELECT label, contact_type, contact_value
    FROM owner_admin_support_contacts
    WHERE active = TRUE
      AND ($1::BOOLEAN = FALSE OR visible_to_staff = TRUE)
    ORDER BY id
    `,
    [staffOnly]
  );
  return result.rows;
};

const requireSelfOrRateManager = async (targetUserId, actorUserId, client = pool) => {
  const parsedTarget = parsePositiveInteger(targetUserId);
  const parsedActor = parsePositiveInteger(actorUserId);
  if (!parsedTarget || !parsedActor) return null;
  if (parsedTarget === parsedActor) {
    const result = await client.query(
      `
      SELECT u.id, u.full_name, u.username, r.role_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.active = TRUE
      `,
      [parsedActor]
    );
    return result.rows[0] || null;
  }
  return requireRateManager(parsedActor, client);
};

const createOtpRequest = async ({ client = pool, user, purpose, method, contact, req, deviceId = "" }) => {
  const requestId = `rec_${crypto.randomUUID()}`;
  const otp = generateOtpCode();
  await client.query(
    `
    UPDATE account_recovery_requests
    SET invalidated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = $1 AND purpose = $2 AND method = $3 AND used_at IS NULL AND invalidated_at IS NULL
    `,
    [user.id, purpose, method]
  );
  await client.query(
    `
    INSERT INTO account_recovery_requests (
      request_id, user_id, purpose, method, contact_hash, otp_hash,
      expires_at, resend_available_at, requested_ip, requested_device_id, user_agent
    )
    VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP + INTERVAL '10 minutes',
            CURRENT_TIMESTAMP + INTERVAL '60 seconds', $7, $8, $9)
    `,
    [
      requestId,
      user.id,
      purpose,
      method,
      hashSensitiveValue(contact),
      hashOtp(requestId, otp),
      req.ip,
      deviceId,
      cleanText(req.get("user-agent")),
    ]
  );
  const delivery = await sendRecoveryOtp({ method, contact, code: otp, purpose });
  return { requestId, otp, delivery };
};

const invalidateOtpRequest = async (requestId, client = pool) => {
  if (!requestId) return;
  await client.query(
    "UPDATE account_recovery_requests SET invalidated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE request_id = $1 AND used_at IS NULL",
    [requestId]
  );
};

const verifyOtpRequest = async ({ requestId, otp, purpose, client = pool }) => {
  const result = await client.query(
    `
    SELECT rr.*, u.username, u.active, u.full_name
    FROM account_recovery_requests rr
    JOIN users u ON u.id = rr.user_id
    WHERE rr.request_id = $1
    LIMIT 1
    `,
    [requestId]
  );
  const request = result.rows[0];
  if (!request || request.purpose !== purpose || request.used_at || request.invalidated_at || new Date(request.expires_at).getTime() <= Date.now()) {
    return { ok: false, status: 400, code: "OTP_EXPIRED_OR_INVALID", message: "The verification code is invalid or expired." };
  }
  if (Number(request.attempt_count || 0) >= 5) {
    return { ok: false, status: 429, code: "OTP_ATTEMPTS_EXCEEDED", message: "Too many incorrect verification attempts." };
  }
  const expected = Buffer.from(request.otp_hash, "hex");
  const actual = Buffer.from(hashOtp(requestId, otp), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    await client.query(
      "UPDATE account_recovery_requests SET attempt_count = COALESCE(attempt_count, 0) + 1, updated_at = CURRENT_TIMESTAMP WHERE request_id = $1",
      [requestId]
    );
    return { ok: false, status: 400, code: "OTP_INVALID", message: "The verification code is invalid or expired.", request };
  }
  return { ok: true, request };
};

const getPermissionUser = async (userId, permissionKey, defaultRoles = [], client = pool) => {
  const parsedUserId = parsePositiveInteger(userId);
  if (!parsedUserId || !PERMISSION_KEYS.includes(permissionKey)) return null;
  const result = await client.query(
    `
    SELECT
      u.id,
      u.full_name,
      r.role_name,
      COALESCE(rps.permissions, '{}'::jsonb) AS permissions
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN role_permission_settings rps ON rps.role_name = r.role_name
    WHERE u.id = $1 AND u.active = TRUE
    `,
    [parsedUserId]
  );
  const user = result.rows[0];
  if (!user) return null;
  if (user.role_name === "Owner") return user;
  const storedPermission = user.permissions?.[permissionKey];
  if (storedPermission === true || (storedPermission === undefined && defaultRoles.includes(user.role_name))) {
    return user;
  }
  return null;
};

const initializeDatabase = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS branches (
      id SERIAL PRIMARY KEY,
      branch_name VARCHAR(120) NOT NULL DEFAULT 'Main Branch',
      location VARCHAR(160),
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE branches ADD COLUMN IF NOT EXISTS location VARCHAR(160);
    ALTER TABLE branches ADD COLUMN IF NOT EXISTS address TEXT;
    ALTER TABLE branches ADD COLUMN IF NOT EXISTS phone_number VARCHAR(40);
    ALTER TABLE branches ADD COLUMN IF NOT EXISTS gst_number VARCHAR(80);
    ALTER TABLE branches ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
    ALTER TABLE branches ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE branches ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

    CREATE TABLE IF NOT EXISTS counters (
      id SERIAL PRIMARY KEY,
      branch_id INTEGER REFERENCES branches(id),
      counter_name VARCHAR(120) NOT NULL,
      counter_type VARCHAR(40) NOT NULL DEFAULT 'RETAIL_COUNTER',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS roles (
      id SERIAL PRIMARY KEY,
      role_name VARCHAR(80) UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      full_name VARCHAR(140) NOT NULL,
      username VARCHAR(80) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role_id INTEGER REFERENCES roles(id),
      branch_id INTEGER REFERENCES branches(id),
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile_number VARCHAR(30);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(140);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS joining_date DATE DEFAULT CURRENT_DATE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS counter_id INTEGER REFERENCES counters(id);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_email VARCHAR(180);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_mobile VARCHAR(30);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_email VARCHAR(180);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_email_verified BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_email_verified_at TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_recovery_email VARCHAR(180);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_mobile VARCHAR(30);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_mobile_verified BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_mobile_verified_at TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_recovery_mobile VARCHAR(30);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS recovery_enabled BOOLEAN DEFAULT TRUE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_self_recovery_enabled BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS force_password_change BOOLEAN DEFAULT FALSE;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS session_revocation_version INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP;
    CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique_idx
      ON users (LOWER(username));

    CREATE TABLE IF NOT EXISTS auth_audit_log (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      actor_user_id INTEGER REFERENCES users(id),
      username VARCHAR(120),
      action VARCHAR(80) NOT NULL,
      safe_code VARCHAR(80),
      device_id VARCHAR(160),
      ip_address VARCHAR(80),
      details JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS account_recovery_requests (
      request_id VARCHAR(80) PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      purpose VARCHAR(40) NOT NULL,
      method VARCHAR(20) NOT NULL,
      contact_hash VARCHAR(128) NOT NULL,
      otp_hash VARCHAR(128) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      attempt_count INTEGER DEFAULT 0,
      resend_available_at TIMESTAMP,
      used_at TIMESTAMP,
      invalidated_at TIMESTAMP,
      verified_at TIMESTAMP,
      verification_token_hash VARCHAR(128),
      verification_expires_at TIMESTAMP,
      requested_ip VARCHAR(80),
      requested_device_id VARCHAR(160),
      user_agent TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS account_recovery_user_idx
      ON account_recovery_requests (user_id, purpose, created_at DESC);
    CREATE INDEX IF NOT EXISTS account_recovery_contact_idx
      ON account_recovery_requests (contact_hash, created_at DESC);

    CREATE TABLE IF NOT EXISTS owner_admin_support_contacts (
      id SERIAL PRIMARY KEY,
      label VARCHAR(120) NOT NULL,
      contact_type VARCHAR(30) NOT NULL,
      contact_value VARCHAR(180) NOT NULL,
      visible_to_staff BOOLEAN DEFAULT FALSE,
      active BOOLEAN DEFAULT TRUE,
      updated_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      total_amount NUMERIC(14, 2) NOT NULL,
      total_cost NUMERIC(14, 2) NOT NULL,
      profit NUMERIC(14, 2) NOT NULL,
      branch_id INTEGER REFERENCES branches(id),
      created_by INTEGER REFERENCES users(id),
      sale_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS counter_id INTEGER REFERENCES counters(id);

    CREATE TABLE IF NOT EXISTS suppliers (
      id SERIAL PRIMARY KEY,
      supplier_name VARCHAR(160) NOT NULL,
      firm_name VARCHAR(160),
      mobile_number VARCHAR(30),
      alternate_number VARCHAR(30),
      address TEXT,
      city VARCHAR(100),
      gst_number VARCHAR(60),
      bank_name VARCHAR(120),
      account_number VARCHAR(80),
      ifsc_code VARCHAR(30),
      upi_id VARCHAR(120),
      notes TEXT,
      opening_balance NUMERIC(14, 2) DEFAULT 0 CHECK (opening_balance >= 0),
      supplier_type VARCHAR(40) NOT NULL DEFAULT 'LOCAL_SUPPLIER',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(30);
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN DEFAULT TRUE;

    CREATE TABLE IF NOT EXISTS product_categories (
      id SERIAL PRIMARY KEY,
      category_name VARCHAR(120) NOT NULL,
      active BOOLEAN DEFAULT TRUE,
      remarks TEXT,
      created_by INTEGER REFERENCES users(id),
      updated_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS product_categories_name_lower_unique_idx
      ON product_categories (LOWER(category_name));

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      product_name VARCHAR(160) NOT NULL,
      selling_rate NUMERIC(14, 2) NOT NULL,
      unit VARCHAR(30) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES product_categories(id);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS barcode VARCHAR(100);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS origin_type VARCHAR(20) DEFAULT 'LOCAL';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category VARCHAR(80) DEFAULT 'Fruit';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT TRUE;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS remarks TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_duplicate_of INTEGER;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS archive_reason TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS selling_rate_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS selling_rate_updated_by INTEGER REFERENCES users(id);
    UPDATE products SET origin_type = 'LOCAL' WHERE origin_type IS NULL;
    CREATE INDEX IF NOT EXISTS products_name_search_lower_idx
      ON products (LOWER(product_name));
    CREATE TABLE IF NOT EXISTS product_duplicate_archive_log (
      id SERIAL PRIMARY KEY,
      duplicate_product_id INTEGER NOT NULL REFERENCES products(id),
      kept_product_id INTEGER NOT NULL REFERENCES products(id),
      category_key TEXT NOT NULL,
      product_name_key TEXT NOT NULL,
      archive_reason TEXT NOT NULL,
      archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (duplicate_product_id)
    );
    WITH ranked_products AS (
      SELECT
        id,
        LOWER(COALESCE(NULLIF(TRIM(category), ''), 'Fruit')) AS category_key,
        LOWER(TRIM(product_name)) AS product_name_key,
        FIRST_VALUE(id) OVER (
          PARTITION BY LOWER(COALESCE(NULLIF(TRIM(category), ''), 'Fruit')), LOWER(TRIM(product_name))
          ORDER BY CASE WHEN active IS DISTINCT FROM FALSE THEN 0 ELSE 1 END, COALESCE(created_at, '1970-01-01'::timestamp), id
        ) AS kept_product_id,
        COUNT(*) OVER (
          PARTITION BY LOWER(COALESCE(NULLIF(TRIM(category), ''), 'Fruit')), LOWER(TRIM(product_name))
        ) AS duplicate_count
      FROM products
      WHERE product_name IS NOT NULL AND TRIM(product_name) <> ''
    ),
    archived_products AS (
      UPDATE products p
      SET active = FALSE,
          archived_duplicate_of = ranked_products.kept_product_id,
          archived_at = COALESCE(p.archived_at, CURRENT_TIMESTAMP),
          archive_reason = COALESCE(p.archive_reason, 'Archived duplicate product during startup migration'),
          remarks = CONCAT_WS(E'\n', NULLIF(p.remarks, ''), 'Archived duplicate product. Kept product ID: ' || ranked_products.kept_product_id)
      FROM ranked_products
      WHERE p.id = ranked_products.id
        AND ranked_products.duplicate_count > 1
        AND ranked_products.id <> ranked_products.kept_product_id
      RETURNING
        p.id AS duplicate_product_id,
        ranked_products.kept_product_id,
        ranked_products.category_key,
        ranked_products.product_name_key
    )
    INSERT INTO product_duplicate_archive_log (
      duplicate_product_id, kept_product_id, category_key, product_name_key, archive_reason
    )
    SELECT
      duplicate_product_id,
      kept_product_id,
      category_key,
      product_name_key,
      'Archived duplicate product during startup migration'
    FROM archived_products
    ON CONFLICT (duplicate_product_id) DO NOTHING;
    DROP INDEX IF EXISTS products_category_name_lower_unique_idx;
    CREATE UNIQUE INDEX products_category_name_lower_unique_idx
      ON products (LOWER(COALESCE(category, 'Fruit')), LOWER(product_name))
      WHERE active IS DISTINCT FROM FALSE;
    CREATE UNIQUE INDEX IF NOT EXISTS products_barcode_unique_idx
      ON products (barcode)
      WHERE barcode IS NOT NULL AND barcode <> '';
    INSERT INTO product_categories (category_name, active)
    SELECT DISTINCT COALESCE(NULLIF(TRIM(category), ''), 'Fruit'), TRUE
    FROM products
    ON CONFLICT DO NOTHING;
    UPDATE products p
    SET category_id = pc.id,
        category = pc.category_name
    FROM product_categories pc
    WHERE p.category_id IS NULL
      AND LOWER(pc.category_name) = LOWER(COALESCE(NULLIF(TRIM(p.category), ''), 'Fruit'));

    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS basic_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS supplier_id INTEGER;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS mandi_tax_percent NUMERIC(6, 3) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS mandi_tax_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS other_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS rebate_percent NUMERIC(6, 3) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS rebate_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS net_payable NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS balance_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_timing VARCHAR(30) DEFAULT 'LATER';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS effective_cost_per_unit NUMERIC(14, 4) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS freight_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS labour_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS rebate_rule_id INTEGER;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_due_days INTEGER DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_status VARCHAR(20) DEFAULT 'PENDING';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_date DATE;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS purchase_type VARCHAR(20) DEFAULT 'CREDIT';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(30);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_reference_number VARCHAR(120);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS purchase_status VARCHAR(20) DEFAULT 'ACTIVE';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS remarks TEXT;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS edit_reason TEXT;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS purchase_bill_status VARCHAR(30) DEFAULT 'BILL_COMPLETED';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS temporary_sale_rate NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS expected_purchase_rate NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS bill_number VARCHAR(120);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS bill_date DATE;
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS lot_name VARCHAR(120);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS lot_size VARCHAR(120);
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS stock_source VARCHAR(40) DEFAULT 'PURCHASE';
    ALTER TABLE purchases ADD COLUMN IF NOT EXISTS counter_id INTEGER REFERENCES counters(id);
    UPDATE purchases SET purchase_status = 'ACTIVE' WHERE purchase_status IS NULL;

    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS basic_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS mandi_tax_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS other_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS rebate_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS net_payable NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS effective_cost_per_unit NUMERIC(14, 4) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS freight_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS labour_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS lot_name VARCHAR(120);
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS lot_size VARCHAR(120);
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS unit VARCHAR(30);
    ALTER TABLE purchase_items ADD COLUMN IF NOT EXISTS origin_type VARCHAR(20);

    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS effective_cost_per_unit NUMERIC(14, 4);
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS supplier_id INTEGER;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS mandi_tax_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS freight_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS labour_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS other_charges NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS rebate_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS net_payable NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS payment_timing VARCHAR(120);
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS balance_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS purchase_id INTEGER;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS batch_status VARCHAR(20) DEFAULT 'ACTIVE';
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS purchase_bill_status VARCHAR(30) DEFAULT 'BILL_COMPLETED';
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS temporary_sale_rate NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS lot_name VARCHAR(120);
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS lot_size VARCHAR(120);
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS stock_source VARCHAR(40) DEFAULT 'PURCHASE';
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS remarks TEXT;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS unit VARCHAR(30);
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS origin_type VARCHAR(20);
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS adjusted_qty NUMERIC(14, 3) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS transfer_in_qty NUMERIC(14, 3) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS transfer_out_qty NUMERIC(14, 3) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS returned_qty NUMERIC(14, 3) DEFAULT 0;
    ALTER TABLE inventory_batches ADD COLUMN IF NOT EXISTS waste_qty NUMERIC(14, 3) DEFAULT 0;
    UPDATE inventory_batches SET batch_status = 'ACTIVE' WHERE batch_status IS NULL;
    UPDATE inventory_batches SET effective_cost_per_unit = purchase_rate WHERE effective_cost_per_unit IS NULL;
    UPDATE purchase_items pi
       SET unit = COALESCE(pi.unit, p.unit),
           origin_type = COALESCE(pi.origin_type, p.origin_type)
      FROM products p
     WHERE pi.product_id = p.id
       AND (pi.unit IS NULL OR pi.origin_type IS NULL);
    UPDATE inventory_batches ib
       SET unit = COALESCE(ib.unit, p.unit),
           origin_type = COALESCE(ib.origin_type, p.origin_type)
      FROM products p
     WHERE ib.product_id = p.id
       AND (ib.unit IS NULL OR ib.origin_type IS NULL);

    CREATE TABLE IF NOT EXISTS mandi_tax_rules (
      id SERIAL PRIMARY KEY,
      origin_type VARCHAR(20) NOT NULL UNIQUE,
      tax_percent NUMERIC(6, 3) NOT NULL CHECK (tax_percent >= 0),
      active BOOLEAN DEFAULT TRUE,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS rebate_rules (
      id SERIAL PRIMARY KEY,
      rule_name VARCHAR(120) NOT NULL,
      pay_within_days INTEGER NOT NULL CHECK (pay_within_days >= 0),
      rebate_percent NUMERIC(6, 3) NOT NULL CHECK (rebate_percent >= 0),
      active BOOLEAN DEFAULT TRUE,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_rate_history (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      old_selling_rate NUMERIC(14, 2) NOT NULL,
      new_selling_rate NUMERIC(14, 2) NOT NULL,
      changed_by INTEGER NOT NULL REFERENCES users(id),
      reason TEXT,
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS product_audit_trail (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by)
    SELECT
      log.duplicate_product_id,
      'ARCHIVE_DUPLICATE',
      JSONB_BUILD_OBJECT(
        'duplicate_product_id', log.duplicate_product_id,
        'category_key', log.category_key,
        'product_name_key', log.product_name_key
      ),
      JSONB_BUILD_OBJECT(
        'active', FALSE,
        'archived_duplicate_of', log.kept_product_id,
        'archived_at', log.archived_at
      ),
      log.archive_reason,
      NULL
    FROM product_duplicate_archive_log log
    WHERE NOT EXISTS (
      SELECT 1
      FROM product_audit_trail audit
      WHERE audit.product_id = log.duplicate_product_id
        AND audit.action = 'ARCHIVE_DUPLICATE'
    );

    CREATE TABLE IF NOT EXISTS product_category_audit_trail (
      id SERIAL PRIMARY KEY,
      category_id INTEGER REFERENCES product_categories(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS purchase_audit_trail (
      id SERIAL PRIMARY KEY,
      purchase_id INTEGER NOT NULL REFERENCES purchases(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS business_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      business_name VARCHAR(180) NOT NULL DEFAULT 'FroozERP Retail',
      brand_name VARCHAR(180) NOT NULL DEFAULT 'FEEL THE FREAKIN'' FROOZ',
      company_name VARCHAR(180) NOT NULL DEFAULT 'SRT Company',
      address TEXT,
      phone_number VARCHAR(40),
      gst_number VARCHAR(80),
      logo_url TEXT,
      compact_logo_text VARCHAR(40) DEFAULT 'FTF',
      invoice_footer_text TEXT DEFAULT 'Thank you for shopping with FEEL THE FREAKIN'' FROOZ.',
      default_printer_type VARCHAR(20) DEFAULT 'THERMAL',
      receipt_width VARCHAR(10) DEFAULT '80MM',
      auto_print_after_billing BOOLEAN DEFAULT FALSE,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS default_printer_type VARCHAR(20) DEFAULT 'THERMAL';
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS receipt_width VARCHAR(10) DEFAULT '80MM';
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS auto_print_after_billing BOOLEAN DEFAULT FALSE;
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS default_invoice_print VARCHAR(30) DEFAULT 'THERMAL_RECEIPT';
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS default_report_print VARCHAR(30) DEFAULT 'A4_REPORT';
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS show_print_preview_before_print BOOLEAN DEFAULT TRUE;
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS show_item_discount_column_pos BOOLEAN DEFAULT TRUE;
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS show_item_discount_column_receipt BOOLEAN DEFAULT TRUE;
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS show_bill_discount_row_receipt BOOLEAN DEFAULT TRUE;
    ALTER TABLE business_settings ADD COLUMN IF NOT EXISTS hide_zero_discount_rows BOOLEAN DEFAULT TRUE;

    CREATE TABLE IF NOT EXISTS sale_rate_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      desired_margin_percent NUMERIC(6, 2) NOT NULL DEFAULT 25 CHECK (desired_margin_percent >= 0),
      rounding_rule VARCHAR(30) NOT NULL DEFAULT 'NEAREST_RUPEE',
      suggestion_enabled BOOLEAN DEFAULT TRUE,
      notes TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE sale_rate_settings ADD COLUMN IF NOT EXISTS bill_level_slab_discount_enabled BOOLEAN DEFAULT TRUE;
    ALTER TABLE sale_rate_settings ADD COLUMN IF NOT EXISTS pos_lot_selection_mode VARCHAR(30) DEFAULT 'ASK_MULTIPLE';

    CREATE TABLE IF NOT EXISTS pos_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enable_weighing_scale BOOLEAN DEFAULT FALSE,
      scale_connection_type VARCHAR(30) DEFAULT 'MANUAL_FALLBACK',
      scale_com_port VARCHAR(40),
      scale_baud_rate INTEGER DEFAULT 9600,
      scale_auto_read BOOLEAN DEFAULT FALSE,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS payment_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      business_upi_id VARCHAR(160),
      upi_payee_name VARCHAR(180),
      enable_upi_qr_on_invoice BOOLEAN DEFAULT FALSE,
      show_upi_qr_on_all_bills BOOLEAN DEFAULT FALSE,
      qr_display_size VARCHAR(20) DEFAULT 'MEDIUM',
      enable_sales_mandi_tax BOOLEAN DEFAULT FALSE,
      sales_mandi_tax_percent NUMERIC(6, 3) DEFAULT 0,
      sales_mandi_tax_basis VARCHAR(40) DEFAULT 'NET_AFTER_ALL_DISCOUNTS',
      sales_mandi_tax_effective_date DATE,
      sales_mandi_tax_customer_scope VARCHAR(40) DEFAULT 'REGISTERED_CUSTOMERS',
      sales_mandi_tax_product_scope VARCHAR(40) DEFAULT 'ALL_PRODUCTS',
      sales_mandi_tax_disable_reason TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS show_upi_qr_on_all_bills BOOLEAN DEFAULT FALSE;
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS qr_display_size VARCHAR(20) DEFAULT 'MEDIUM';
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS enable_sales_mandi_tax BOOLEAN DEFAULT FALSE;
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS sales_mandi_tax_percent NUMERIC(6, 3) DEFAULT 0;
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS sales_mandi_tax_basis VARCHAR(40) DEFAULT 'NET_AFTER_ALL_DISCOUNTS';
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS sales_mandi_tax_effective_date DATE;
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS sales_mandi_tax_customer_scope VARCHAR(40) DEFAULT 'REGISTERED_CUSTOMERS';
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS sales_mandi_tax_product_scope VARCHAR(40) DEFAULT 'ALL_PRODUCTS';
    ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS sales_mandi_tax_disable_reason TEXT;

    CREATE TABLE IF NOT EXISTS whatsapp_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      enabled BOOLEAN DEFAULT FALSE,
      phone_number_id VARCHAR(160),
      access_token TEXT,
      default_country_code VARCHAR(8) DEFAULT '91',
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS whatsapp_send_logs (
      id BIGSERIAL PRIMARY KEY,
      source_type VARCHAR(40) NOT NULL,
      source_id VARCHAR(180),
      account_id INTEGER,
      account_type VARCHAR(30),
      phone_number VARCHAR(30) NOT NULL,
      document_name VARCHAR(220) NOT NULL,
      status VARCHAR(40) NOT NULL,
      error_message TEXT,
      sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      sent_by_user_id INTEGER REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS whatsapp_send_logs_source_idx
      ON whatsapp_send_logs (source_type, source_id, sent_at DESC);

    CREATE TABLE IF NOT EXISTS sale_discount_rules (
      id SERIAL PRIMARY KEY,
      rule_name VARCHAR(140) NOT NULL,
      minimum_bill_amount NUMERIC(14, 2) NOT NULL CHECK (minimum_bill_amount >= 0),
      maximum_bill_amount NUMERIC(14, 2) CHECK (maximum_bill_amount IS NULL OR maximum_bill_amount >= 0),
      discount_type VARCHAR(30) NOT NULL,
      discount_value NUMERIC(14, 2) NOT NULL CHECK (discount_value >= 0),
      payment_mode VARCHAR(20) NOT NULL DEFAULT 'ALL',
      active BOOLEAN DEFAULT TRUE,
      updated_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lot_discounts (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      inventory_batch_id INTEGER NOT NULL REFERENCES inventory_batches(id),
      discount_type VARCHAR(30) NOT NULL,
      discount_value NUMERIC(14, 2) NOT NULL CHECK (discount_value >= 0),
      start_date DATE NOT NULL DEFAULT CURRENT_DATE,
      end_date DATE,
      active BOOLEAN DEFAULT TRUE,
      remarks TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP,
      deactivated_by INTEGER REFERENCES users(id),
      deactivated_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS lot_discounts_batch_active_idx
      ON lot_discounts (inventory_batch_id, active, start_date, end_date);

    CREATE TABLE IF NOT EXISTS lot_discount_audit (
      id SERIAL PRIMARY KEY,
      discount_id INTEGER REFERENCES lot_discounts(id) ON DELETE SET NULL,
      product_id INTEGER REFERENCES products(id),
      inventory_batch_id INTEGER REFERENCES inventory_batches(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      remarks TEXT,
      changed_by INTEGER REFERENCES users(id),
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS supplier_payments (
      id SERIAL PRIMARY KEY,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
      payment_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (payment_amount >= 0),
      rebate_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (rebate_amount >= 0),
      payment_mode VARCHAR(30) NOT NULL,
      reference_number VARCHAR(120),
      remarks TEXT,
      branch_id INTEGER REFERENCES branches(id),
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS cancelled BOOLEAN DEFAULT FALSE;
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id);
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id);
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS edit_reason TEXT;
    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS counter_id INTEGER REFERENCES counters(id);

    CREATE TABLE IF NOT EXISTS supplier_payment_audit (
      id SERIAL PRIMARY KEY,
      supplier_payment_id INTEGER NOT NULL REFERENCES supplier_payments(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      customer_name VARCHAR(160) NOT NULL,
      customer_type VARCHAR(20) NOT NULL DEFAULT 'RETAIL',
      mobile_number VARCHAR(20),
      address TEXT,
      gst_number VARCHAR(80),
      notes TEXT,
      opening_balance NUMERIC(14, 2) DEFAULT 0 CHECK (opening_balance >= 0),
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE customers ADD COLUMN IF NOT EXISTS firm_name VARCHAR(160);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS alternate_number VARCHAR(30);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS city VARCHAR(100);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS bank_name VARCHAR(120);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS account_number VARCHAR(80);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS ifsc_code VARCHAR(30);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS upi_id VARCHAR(120);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS system_account BOOLEAN DEFAULT FALSE;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(30);
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN DEFAULT TRUE;
    INSERT INTO customers (
      customer_name, customer_type, mobile_number, notes, opening_balance, active, system_account
    )
    SELECT 'Walk-in Customer', 'RETAIL', NULL, 'System account for POS bills without a saved customer.', 0, TRUE, TRUE
    WHERE NOT EXISTS (
      SELECT 1 FROM customers WHERE system_account = TRUE OR LOWER(customer_name) = LOWER('Walk-in Customer')
    );
    UPDATE customers
    SET customer_name = 'Walk-in Customer',
        customer_type = 'RETAIL',
        active = TRUE,
        system_account = TRUE,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = (
      SELECT id
      FROM customers
      WHERE system_account = TRUE OR LOWER(customer_name) = LOWER('Walk-in Customer')
      ORDER BY system_account DESC, id
      LIMIT 1
    );
    CREATE INDEX IF NOT EXISTS customers_name_mobile_search_lower_idx
      ON customers (LOWER(customer_name), COALESCE(mobile_number, ''));

    CREATE TABLE IF NOT EXISTS accounts (
      id SERIAL PRIMARY KEY,
      account_name VARCHAR(160) NOT NULL,
      account_type VARCHAR(30) NOT NULL,
      firm_name VARCHAR(160),
      mobile_number VARCHAR(30),
      alternate_number VARCHAR(30),
      address TEXT,
      city VARCHAR(100),
      gst_number VARCHAR(80),
      bank_name VARCHAR(120),
      account_number VARCHAR(80),
      ifsc_code VARCHAR(30),
      upi_id VARCHAR(120),
      opening_balance NUMERIC(14, 2) DEFAULT 0 CHECK (opening_balance >= 0),
      active BOOLEAN DEFAULT TRUE,
      notes TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS whatsapp_number VARCHAR(30);
    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS whatsapp_opt_in BOOLEAN DEFAULT TRUE;
    CREATE INDEX IF NOT EXISTS accounts_name_mobile_search_lower_idx
      ON accounts (LOWER(account_name), COALESCE(mobile_number, ''));

    CREATE TABLE IF NOT EXISTS customer_payments (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
      payment_amount NUMERIC(14, 2) NOT NULL CHECK (payment_amount > 0),
      payment_mode VARCHAR(20) NOT NULL,
      reference_number VARCHAR(120),
      remarks TEXT,
      branch_id INTEGER REFERENCES branches(id),
      created_by INTEGER REFERENCES users(id),
      cancelled BOOLEAN DEFAULT FALSE,
      cancelled_by INTEGER REFERENCES users(id),
      cancelled_at TIMESTAMP,
      cancellation_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id);
    ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
    ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS edit_reason TEXT;
    ALTER TABLE customer_payments ADD COLUMN IF NOT EXISTS counter_id INTEGER REFERENCES counters(id);

    CREATE TABLE IF NOT EXISTS customer_payment_audit (
      id SERIAL PRIMARY KEY,
      customer_payment_id INTEGER NOT NULL REFERENCES customer_payments(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_returns (
      id SERIAL PRIMARY KEY,
      return_no VARCHAR(40) UNIQUE,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      customer_name VARCHAR(120),
      customer_mobile VARCHAR(20),
      return_date DATE NOT NULL DEFAULT CURRENT_DATE,
      refund_type VARCHAR(30) NOT NULL,
      return_reason TEXT NOT NULL,
      total_return_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_return_amount >= 0),
      total_cost_amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (total_cost_amount >= 0),
      branch_id INTEGER REFERENCES branches(id),
      counter_id INTEGER REFERENCES counters(id),
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE sale_returns ADD COLUMN IF NOT EXISTS counter_id INTEGER REFERENCES counters(id);

    CREATE TABLE IF NOT EXISTS sale_return_items (
      id SERIAL PRIMARY KEY,
      sale_return_id INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
      sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
      product_id INTEGER NOT NULL REFERENCES products(id),
      return_quantity NUMERIC(14, 3) NOT NULL CHECK (return_quantity > 0),
      selling_rate NUMERIC(14, 2) NOT NULL DEFAULT 0,
      return_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
      cost_amount NUMERIC(14, 2) NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS waste_entries (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      waste_date DATE NOT NULL DEFAULT CURRENT_DATE,
      quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
      waste_type VARCHAR(30) NOT NULL,
      remarks TEXT,
      cost_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
      branch_id INTEGER REFERENCES branches(id),
      counter_id INTEGER REFERENCES counters(id),
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE waste_entries ADD COLUMN IF NOT EXISTS counter_id INTEGER REFERENCES counters(id);

    CREATE TABLE IF NOT EXISTS role_permission_settings (
      role_name VARCHAR(80) PRIMARY KEY,
      permissions JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS update_center (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      current_version VARCHAR(40) NOT NULL DEFAULT '1.0.0',
      release_date DATE NOT NULL DEFAULT CURRENT_DATE,
      changelog TEXT NOT NULL DEFAULT 'Initial local FroozERP release channel prepared.',
      update_status VARCHAR(40) NOT NULL DEFAULT 'READY_FOR_FUTURE_UPDATES',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      sync_enabled BOOLEAN DEFAULT FALSE,
      sync_status VARCHAR(40) NOT NULL DEFAULT 'OFFLINE_READY',
      last_sync_at TIMESTAMP,
      pending_count INTEGER NOT NULL DEFAULT 0 CHECK (pending_count >= 0),
      device_id VARCHAR(120) DEFAULT 'LOCAL-STORE',
      notes TEXT DEFAULT 'Cloud sync architecture prepared. Online sync delivery is not enabled yet.',
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE sync_settings ADD COLUMN IF NOT EXISTS device_display_name VARCHAR(160) DEFAULT 'Main Counter Device';

    CREATE TABLE IF NOT EXISTS sync_queue (
      id SERIAL PRIMARY KEY,
      entity_type VARCHAR(80) NOT NULL,
      entity_id INTEGER,
      operation VARCHAR(30) NOT NULL,
      payload JSONB,
      sync_status VARCHAR(40) NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      synced_at TIMESTAMP,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS authorized_devices (
      id SERIAL PRIMARY KEY,
      device_id VARCHAR(160) UNIQUE NOT NULL,
      device_name VARCHAR(160) NOT NULL,
      device_type VARCHAR(60) DEFAULT 'Browser',
      user_agent TEXT,
      local_ip VARCHAR(80),
      assigned_branch_id INTEGER REFERENCES branches(id) DEFAULT 1,
      assigned_counter_id INTEGER REFERENCES counters(id),
      approved_by INTEGER REFERENCES users(id),
      approved_at TIMESTAMP,
      last_active_at TIMESTAMP,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
      request_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS assigned_branch_id INTEGER REFERENCES branches(id) DEFAULT 1;
    ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS assigned_counter_id INTEGER REFERENCES counters(id);
    ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP;
    ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS local_ip VARCHAR(80);
    ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS platform VARCHAR(80) DEFAULT 'Browser';
    ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS app_version VARCHAR(40) DEFAULT '1.0.0';
    ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMP;
    ALTER TABLE authorized_devices ADD COLUMN IF NOT EXISTS sync_status VARCHAR(40) DEFAULT 'IDLE';

    CREATE TABLE IF NOT EXISTS activation_codes (
      id SERIAL PRIMARY KEY,
      code_hash TEXT UNIQUE NOT NULL,
      code_label VARCHAR(120),
      branch_id INTEGER REFERENCES branches(id),
      counter_id INTEGER REFERENCES counters(id),
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      used_by_device_id VARCHAR(160),
      used_at TIMESTAMP,
      status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
    );

    CREATE TABLE IF NOT EXISTS device_audit_trail (
      id SERIAL PRIMARY KEY,
      device_id VARCHAR(160),
      action VARCHAR(40) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT,
      changed_by INTEGER REFERENCES users(id),
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_processed_operations (
      operation_id VARCHAR(180) PRIMARY KEY,
      device_id VARCHAR(160) NOT NULL,
      entity_type VARCHAR(80) NOT NULL,
      entity_id VARCHAR(180) NOT NULL,
      result_status VARCHAR(40) NOT NULL,
      result_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS sync_processed_device_idx
      ON sync_processed_operations (device_id, processed_at);

    CREATE TABLE IF NOT EXISTS sync_change_log (
      change_id BIGSERIAL PRIMARY KEY,
      branch_id INTEGER NOT NULL DEFAULT 1,
      entity_type VARCHAR(80) NOT NULL,
      entity_id VARCHAR(180) NOT NULL,
      operation_type VARCHAR(30) NOT NULL,
      entity_version INTEGER NOT NULL DEFAULT 1,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS sync_change_log_cursor_idx
      ON sync_change_log (branch_id, change_id);
    CREATE INDEX IF NOT EXISTS sync_change_log_entity_idx
      ON sync_change_log (entity_type, entity_id);

    CREATE TABLE IF NOT EXISTS sync_test_entities (
      id VARCHAR(180) PRIMARY KEY,
      branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id),
      device_id VARCHAR(160),
      value TEXT NOT NULL,
      entity_version INTEGER NOT NULL DEFAULT 1,
      deleted_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_conflict_log (
      id BIGSERIAL PRIMARY KEY,
      operation_id VARCHAR(180),
      device_id VARCHAR(160),
      branch_id INTEGER,
      entity_type VARCHAR(80) NOT NULL,
      entity_id VARCHAR(180) NOT NULL,
      local_version INTEGER,
      server_version INTEGER,
      local_payload JSONB,
      server_payload JSONB,
      reason TEXT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'open',
      detected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sync_pos_sale_staging (
      invoice_global_id VARCHAR(180) PRIMARY KEY,
      offline_invoice_ref VARCHAR(180) UNIQUE NOT NULL,
      branch_id INTEGER NOT NULL DEFAULT 1 REFERENCES branches(id),
      device_id VARCHAR(160) NOT NULL,
      created_by INTEGER REFERENCES users(id),
      payload JSONB NOT NULL,
      result_status VARCHAR(40) NOT NULL DEFAULT 'accepted_for_review',
      entity_version INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE product_categories ADD COLUMN IF NOT EXISTS global_id VARCHAR(180);
    ALTER TABLE product_categories ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE product_categories ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
    UPDATE product_categories SET global_id = 'category-' || id WHERE global_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS product_categories_global_id_unique_idx
      ON product_categories (global_id);

    ALTER TABLE products ADD COLUMN IF NOT EXISTS global_id VARCHAR(180);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP;
    UPDATE products SET global_id = 'product-' || id WHERE global_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS products_global_id_unique_idx
      ON products (global_id);

    ALTER TABLE sales ADD COLUMN IF NOT EXISTS global_id VARCHAR(180);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS offline_invoice_ref VARCHAR(180);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS source_device_id VARCHAR(160);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
    CREATE UNIQUE INDEX IF NOT EXISTS sales_global_id_unique_idx
      ON sales (global_id)
      WHERE global_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS sales_offline_invoice_ref_unique_idx
      ON sales (offline_invoice_ref)
      WHERE offline_invoice_ref IS NOT NULL;

    CREATE TABLE IF NOT EXISTS backup_logs (
      id SERIAL PRIMARY KEY,
      backup_file_name VARCHAR(220),
      backup_path TEXT,
      backup_size BIGINT DEFAULT 0,
      backup_type VARCHAR(30) NOT NULL,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      completed_at TIMESTAMP,
      status VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
      error_message TEXT,
      created_by INTEGER REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS backup_settings (
      id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      auto_backup_enabled BOOLEAN DEFAULT TRUE,
      backup_on_shutdown BOOLEAN DEFAULT TRUE,
      daily_backup_time VARCHAR(5) DEFAULT '23:59',
      keep_last_backups INTEGER DEFAULT 30,
      backup_location TEXT,
      restore_enabled BOOLEAN DEFAULT FALSE,
      updated_by INTEGER REFERENCES users(id),
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS contra_entries (
      id SERIAL PRIMARY KEY,
      contra_date DATE NOT NULL DEFAULT CURRENT_DATE,
      contra_type VARCHAR(30) NOT NULL,
      amount NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
      cash_account VARCHAR(120) DEFAULT 'Cash',
      bank_account VARCHAR(120) DEFAULT 'Bank',
      reference_number VARCHAR(120),
      remarks TEXT,
      branch_id INTEGER REFERENCES branches(id),
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      cancelled BOOLEAN DEFAULT FALSE,
      cancelled_at TIMESTAMP,
      cancelled_by INTEGER REFERENCES users(id)
    );
    ALTER TABLE contra_entries ADD COLUMN IF NOT EXISTS cancelled BOOLEAN DEFAULT FALSE;
    ALTER TABLE contra_entries ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
    ALTER TABLE contra_entries ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id);

    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
      category VARCHAR(120) NOT NULL,
      amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
      payment_mode VARCHAR(30) NOT NULL DEFAULT 'CASH',
      reference_number VARCHAR(120),
      vendor_name VARCHAR(160),
      remarks TEXT,
      branch_id INTEGER REFERENCES branches(id),
      created_by INTEGER REFERENCES users(id),
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'ACTIVE';
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_to VARCHAR(160);
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id);
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS edit_reason TEXT;
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id);
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    ALTER TABLE expenses ADD COLUMN IF NOT EXISTS counter_id INTEGER REFERENCES counters(id);
    UPDATE expenses SET status = CASE WHEN active IS DISTINCT FROM FALSE THEN 'ACTIVE' ELSE 'CANCELLED' END WHERE status IS NULL;
    UPDATE expenses SET paid_to = vendor_name WHERE paid_to IS NULL AND vendor_name IS NOT NULL;

    CREATE TABLE IF NOT EXISTS expense_audit_trail (
      id SERIAL PRIMARY KEY,
      expense_id INTEGER NOT NULL REFERENCES expenses(id),
      action VARCHAR(30) NOT NULL,
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      changed_by INTEGER REFERENCES users(id),
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO business_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO sale_rate_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO pos_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO payment_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO whatsapp_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO update_center (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO sync_settings (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO backup_settings (id, backup_location)
    VALUES (1, '${backupDirectory.replace(/'/g, "''")}')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO role_permission_settings (role_name, permissions)
    VALUES
      ('Owner', '{"settings":true,"discounts":true,"mandi_tax":true,"rebate_rules":true,"supplier_payments":true,"customer_payments":true,"sale_edit":true,"invoice_cancellation":true,"reports":true,"purchases":true,"supplier_accounts":true,"inventory":true,"waste_management":true,"billing":true}'::jsonb),
      ('Admin', '{"settings":true,"discounts":true,"mandi_tax":true,"rebate_rules":true,"supplier_payments":true,"customer_payments":true,"sale_edit":true,"invoice_cancellation":true,"reports":true,"purchases":true,"supplier_accounts":true,"inventory":true,"waste_management":true,"billing":true}'::jsonb),
      ('Cashier', '{"billing":true,"customer_payments":true,"settings":false,"invoice_cancellation":false,"sale_edit":false,"discounts":false,"mandi_tax":false,"rebate_rules":false,"supplier_payments":false,"reports":false,"purchases":false,"supplier_accounts":false,"inventory":false,"waste_management":false}'::jsonb),
      ('Purchase Manager', '{"purchases":true,"supplier_payments":true,"supplier_accounts":true,"reports":true,"settings":false,"discounts":false,"mandi_tax":false,"rebate_rules":false,"customer_payments":false,"sale_edit":false,"invoice_cancellation":false,"inventory":false,"waste_management":false,"billing":false}'::jsonb),
      ('Inventory Manager', '{"inventory":true,"waste_management":true,"reports":true,"settings":false,"discounts":false,"mandi_tax":false,"rebate_rules":false,"supplier_payments":false,"customer_payments":false,"sale_edit":false,"invoice_cancellation":false,"purchases":false,"supplier_accounts":false,"billing":false}'::jsonb)
    ON CONFLICT (role_name) DO NOTHING;

    UPDATE role_permission_settings
    SET permissions = permissions || '{"manual_pos_rate_override":true,"pos_date_override":true}'::jsonb
    WHERE role_name IN ('Owner', 'Admin');

    UPDATE role_permission_settings
    SET permissions = permissions || '{"sale_date_edit":true}'::jsonb
    WHERE role_name IN ('Owner', 'Admin');

    UPDATE role_permission_settings
    SET permissions = permissions || '{"device_management":true,"activation_codes":true,"backup_restore":true,"branch_settings":true,"system_info":true}'::jsonb
    WHERE role_name IN ('Owner', 'Admin');

    UPDATE role_permission_settings
    SET permissions = permissions || '{"whatsapp_send":true,"whatsapp_settings":true}'::jsonb
    WHERE role_name IN ('Owner', 'Admin');

    UPDATE role_permission_settings
    SET permissions = permissions || '{"manual_pos_rate_override":false}'::jsonb
    WHERE role_name IN ('Cashier', 'Purchase Manager', 'Inventory Manager')
      AND NOT (permissions ? 'manual_pos_rate_override');

    UPDATE role_permission_settings
    SET permissions = permissions || '{"pos_date_override":false}'::jsonb
    WHERE role_name IN ('Cashier', 'Purchase Manager', 'Inventory Manager')
      AND NOT (permissions ? 'pos_date_override');

    UPDATE role_permission_settings
    SET permissions = permissions || '{"sale_date_edit":false}'::jsonb
    WHERE role_name IN ('Cashier', 'Purchase Manager', 'Inventory Manager')
      AND NOT (permissions ? 'sale_date_edit');

    UPDATE role_permission_settings
    SET permissions = permissions || '{"device_management":false,"activation_codes":false,"backup_restore":false,"branch_settings":false,"system_info":false}'::jsonb
    WHERE role_name IN ('Cashier', 'Purchase Manager', 'Inventory Manager')
      AND NOT (permissions ? 'device_management');

    UPDATE role_permission_settings
    SET permissions = permissions || '{"whatsapp_send":false,"whatsapp_settings":false}'::jsonb
    WHERE role_name IN ('Cashier', 'Purchase Manager', 'Inventory Manager')
      AND NOT (permissions ? 'whatsapp_send');

    INSERT INTO branches (id, branch_name, location)
    VALUES (1, 'Main Branch', 'Primary Store')
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO counters (id, branch_id, counter_name, counter_type, active)
    VALUES
      (1, 1, 'Main Counter', 'RETAIL_COUNTER', TRUE),
      (2, 1, 'Owner Dashboard', 'OWNER_DASHBOARD', TRUE),
      (3, 1, 'Back Office', 'BACK_OFFICE', TRUE)
    ON CONFLICT (id) DO NOTHING;

    UPDATE branches SET address = COALESCE(address, location) WHERE id = 1;

    INSERT INTO roles (role_name)
    VALUES ('Owner'), ('Admin'), ('Cashier'), ('Purchase Manager'), ('Inventory Manager')
    ON CONFLICT (role_name) DO NOTHING;

    INSERT INTO users (full_name, username, password_hash, role_id, branch_id, active)
    SELECT 'Owner', 'owner', '${hashPassword("owner123")}', r.id, 1, TRUE
    FROM roles r
    WHERE r.role_name = 'Owner'
      AND NOT EXISTS (SELECT 1 FROM users);

    UPDATE users SET branch_id = 1 WHERE branch_id IS NULL;
    UPDATE sales SET branch_id = 1 WHERE branch_id IS NULL;
    UPDATE purchases SET branch_id = 1 WHERE branch_id IS NULL;
    UPDATE supplier_payments SET branch_id = 1 WHERE branch_id IS NULL;
    UPDATE customer_payments SET branch_id = 1 WHERE branch_id IS NULL;
    UPDATE expenses SET branch_id = 1 WHERE branch_id IS NULL;
    UPDATE sale_returns SET branch_id = 1 WHERE branch_id IS NULL;
    UPDATE waste_entries SET branch_id = 1 WHERE branch_id IS NULL;

    INSERT INTO mandi_tax_rules (origin_type, tax_percent)
    VALUES ('LOCAL', 2), ('IMPORTED', 4)
    ON CONFLICT (origin_type) DO NOTHING;

    INSERT INTO rebate_rules (rule_name, pay_within_days, rebate_percent)
    SELECT seed.rule_name, seed.pay_within_days, seed.rebate_percent
    FROM (VALUES
      ('Same Day', 0, 3::NUMERIC),
      ('Within 3 Days', 3, 2::NUMERIC),
      ('Within 7 Days', 7, 1::NUMERIC),
      ('Later', 15, 0::NUMERIC)
    ) AS seed(rule_name, pay_within_days, rebate_percent)
    WHERE NOT EXISTS (SELECT 1 FROM rebate_rules);

    ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_no VARCHAR(40);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_name VARCHAR(120);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_mobile VARCHAR(20);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_notes TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20) DEFAULT 'CASH';
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS gross_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS item_discount_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS invoice_discount_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_rule_id INTEGER;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_rule_name VARCHAR(140);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_rule_type VARCHAR(30);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_rule_value NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount_rule_payment_mode VARCHAR(20);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS taxable_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS mandi_tax_rate NUMERIC(6, 3) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS mandi_tax_basis VARCHAR(40);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS mandi_tax_effective_date DATE;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS tax_config_snapshot JSONB;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS sale_status VARCHAR(20) DEFAULT 'COMPLETED';
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS edited_by INTEGER REFERENCES users(id);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS edited_at TIMESTAMP;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS edit_reason TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id);
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS profit_status VARCHAR(30) DEFAULT 'FINAL';
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS transaction_date DATE;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS bill_datetime TIMESTAMP;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS backdated_bill BOOLEAN DEFAULT FALSE;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS backdate_reason TEXT;
    UPDATE sales SET transaction_date = sale_date WHERE transaction_date IS NULL;
    UPDATE sales SET bill_datetime = COALESCE(sale_date::timestamp, created_at) WHERE bill_datetime IS NULL;
    UPDATE sales
    SET customer_id = (
      SELECT id FROM customers WHERE system_account = TRUE ORDER BY id LIMIT 1
    )
    WHERE customer_id IS NULL
      AND (
        customer_name IS NULL
        OR LOWER(COALESCE(customer_name, '')) LIKE '%walk-in%'
      );
    UPDATE sales SET sale_status = 'COMPLETED' WHERE sale_status IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS sales_invoice_no_unique_idx
      ON sales (invoice_no)
      WHERE invoice_no IS NOT NULL;

    CREATE TABLE IF NOT EXISTS sale_audit_trail (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id),
      action VARCHAR(30) NOT NULL,
      field_name VARCHAR(80),
      old_value JSONB,
      new_value JSONB,
      reason TEXT NOT NULL,
      edited_by INTEGER REFERENCES users(id),
      edited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id),
      quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
      selling_rate NUMERIC(14, 2) NOT NULL CHECK (selling_rate >= 0),
      amount NUMERIC(14, 2) NOT NULL,
      cost_amount NUMERIC(14, 2) NOT NULL,
      profit NUMERIC(14, 2) NOT NULL
    );

    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS net_amount NUMERIC(14, 2);
    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS cost_status VARCHAR(30) DEFAULT 'FINAL';
    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS default_selling_rate NUMERIC(14, 2);
    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS manual_rate_override BOOLEAN DEFAULT FALSE;
    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS lot_discount_id INTEGER REFERENCES lot_discounts(id);
    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS lot_discount_type VARCHAR(30);
    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS lot_discount_value NUMERIC(14, 2) DEFAULT 0;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS due_date DATE;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS credit_remarks TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS credit_status VARCHAR(30) DEFAULT 'PAID';
    UPDATE sale_items SET default_selling_rate = selling_rate WHERE default_selling_rate IS NULL;

    CREATE TABLE IF NOT EXISTS pos_rate_override_audit (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      sale_item_id INTEGER REFERENCES sale_items(id) ON DELETE SET NULL,
      product_id INTEGER NOT NULL REFERENCES products(id),
      product_name VARCHAR(160) NOT NULL,
      default_rate NUMERIC(14, 2) NOT NULL,
      manual_rate NUMERIC(14, 2) NOT NULL,
      changed_by INTEGER REFERENCES users(id),
      changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      invoice_no VARCHAR(40),
      reason TEXT
    );

    CREATE TABLE IF NOT EXISTS sale_payments (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      payment_mode VARCHAR(20) NOT NULL,
      amount NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
      reference_number VARCHAR(120),
      payment_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      user_id INTEGER,
      branch_id INTEGER,
      device_id VARCHAR(120),
      status VARCHAR(20) DEFAULT 'POSTED'
    );
    ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS reference_number VARCHAR(120);
    ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS payment_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS user_id INTEGER;
    ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS branch_id INTEGER;
    ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS device_id VARCHAR(120);
    ALTER TABLE sale_payments ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'POSTED';

    CREATE TABLE IF NOT EXISTS customer_ledger (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER REFERENCES sales(id),
      customer_name VARCHAR(120),
      customer_mobile VARCHAR(20),
      transaction_type VARCHAR(30) NOT NULL,
      debit_amount NUMERIC(14, 2) DEFAULT 0 CHECK (debit_amount >= 0),
      credit_amount NUMERIC(14, 2) DEFAULT 0 CHECK (credit_amount >= 0),
      balance_delta NUMERIC(14, 2) NOT NULL DEFAULT 0,
      remarks TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE customer_ledger ADD COLUMN IF NOT EXISTS transaction_date DATE;
    ALTER TABLE customer_ledger ADD COLUMN IF NOT EXISTS customer_id INTEGER;

    CREATE TABLE IF NOT EXISTS stock_adjustments (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      inventory_batch_id INTEGER NOT NULL REFERENCES inventory_batches(id),
      adjustment_date DATE NOT NULL DEFAULT CURRENT_DATE,
      adjustment_type VARCHAR(80) NOT NULL,
      quantity_before NUMERIC(14, 3) NOT NULL DEFAULT 0,
      physical_quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
      adjustment_quantity NUMERIC(14, 3) NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      remarks TEXT,
      adjusted_by INTEGER REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sale_permission_settings (
      role_name VARCHAR(80) PRIMARY KEY,
      can_edit_sales BOOLEAN DEFAULT FALSE,
      can_cancel_sales BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO sale_permission_settings (role_name, can_edit_sales, can_cancel_sales)
    VALUES
      ('Owner', TRUE, TRUE),
      ('Admin', TRUE, TRUE),
      ('Cashier', FALSE, FALSE),
      ('Purchase Manager', FALSE, FALSE),
      ('Inventory Manager', FALSE, FALSE)
    ON CONFLICT (role_name) DO NOTHING;

    CREATE TABLE IF NOT EXISTS sale_batch_allocations (
      id SERIAL PRIMARY KEY,
      sale_item_id INTEGER NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
      inventory_batch_id INTEGER NOT NULL REFERENCES inventory_batches(id),
      quantity NUMERIC(14, 3) NOT NULL CHECK (quantity > 0),
      purchase_rate NUMERIC(14, 2) NOT NULL,
      cost_amount NUMERIC(14, 2) NOT NULL
    );

    CREATE INDEX IF NOT EXISTS inventory_batches_fifo_idx
      ON inventory_batches (product_id, branch_id, purchase_date, created_at, id)
      WHERE remaining_qty > 0;

    CREATE INDEX IF NOT EXISTS sale_items_sale_id_idx
      ON sale_items (sale_id);

    CREATE INDEX IF NOT EXISTS sale_batch_allocations_sale_item_id_idx
      ON sale_batch_allocations (sale_item_id);

    CREATE INDEX IF NOT EXISTS sale_payments_sale_id_idx
      ON sale_payments (sale_id);

    CREATE INDEX IF NOT EXISTS sale_audit_trail_sale_id_idx
      ON sale_audit_trail (sale_id, edited_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS customer_ledger_mobile_idx
      ON customer_ledger (customer_mobile, created_at, id);
    CREATE INDEX IF NOT EXISTS customer_ledger_customer_id_idx
      ON customer_ledger (customer_id, transaction_date, id);

    CREATE INDEX IF NOT EXISTS suppliers_name_search_idx
      ON suppliers (LOWER(supplier_name), LOWER(COALESCE(firm_name, '')));

    CREATE INDEX IF NOT EXISTS suppliers_name_firm_search_lower_idx
      ON suppliers (LOWER(supplier_name), LOWER(COALESCE(firm_name, '')));

    CREATE INDEX IF NOT EXISTS purchases_supplier_id_idx
      ON purchases (supplier_id);

    CREATE INDEX IF NOT EXISTS purchase_audit_purchase_idx
      ON purchase_audit_trail (purchase_id, edited_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS product_audit_product_idx
      ON product_audit_trail (product_id, edited_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS supplier_payments_supplier_date_idx
      ON supplier_payments (supplier_id, payment_date, id);

    CREATE INDEX IF NOT EXISTS supplier_payment_audit_payment_idx
      ON supplier_payment_audit (supplier_payment_id, edited_at DESC, id DESC);

    CREATE INDEX IF NOT EXISTS customers_search_idx
      ON customers (LOWER(customer_name), LOWER(COALESCE(mobile_number, '')));

    CREATE INDEX IF NOT EXISTS accounts_search_idx
      ON accounts (LOWER(account_name), account_type, active);

    CREATE INDEX IF NOT EXISTS customer_payments_customer_date_idx
      ON customer_payments (customer_id, payment_date, id);

    CREATE INDEX IF NOT EXISTS expenses_date_idx
      ON expenses (expense_date DESC, id DESC);

    CREATE INDEX IF NOT EXISTS sale_returns_sale_date_idx
      ON sale_returns (sale_id, return_date DESC, id DESC);

    CREATE INDEX IF NOT EXISTS sale_return_items_product_idx
      ON sale_return_items (product_id, sale_item_id);

    CREATE INDEX IF NOT EXISTS waste_entries_date_product_idx
      ON waste_entries (waste_date DESC, product_id, id DESC);

    CREATE INDEX IF NOT EXISTS sync_queue_status_idx
      ON sync_queue (sync_status, created_at);

    CREATE INDEX IF NOT EXISTS sale_discount_rules_match_idx
      ON sale_discount_rules (active, payment_mode, minimum_bill_amount, maximum_bill_amount);

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'purchases_supplier_id_fkey') THEN
        ALTER TABLE purchases
          ADD CONSTRAINT purchases_supplier_id_fkey
          FOREIGN KEY (supplier_id) REFERENCES suppliers(id);
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_batches_supplier_id_fkey') THEN
        ALTER TABLE inventory_batches
          ADD CONSTRAINT inventory_batches_supplier_id_fkey
          FOREIGN KEY (supplier_id) REFERENCES suppliers(id);
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inventory_batches_purchase_id_fkey') THEN
        ALTER TABLE inventory_batches
          ADD CONSTRAINT inventory_batches_purchase_id_fkey
          FOREIGN KEY (purchase_id) REFERENCES purchases(id);
      END IF;
    END $$;

    UPDATE sales
    SET gross_amount = total_amount
    WHERE gross_amount = 0
      AND item_discount_amount = 0
      AND invoice_discount_amount = 0;

    UPDATE sale_items
    SET net_amount = amount
    WHERE net_amount IS NULL;

    UPDATE purchases
    SET
      basic_amount = total_amount,
      gross_amount = total_amount,
      net_payable = total_amount,
      balance_amount = total_amount
    WHERE basic_amount = 0
      AND gross_amount = 0
      AND net_payable = 0;

    WITH legacy_suppliers AS (
      SELECT DISTINCT TRIM(supplier_name) AS supplier_name
      FROM purchases
      WHERE supplier_name IS NOT NULL
        AND TRIM(supplier_name) <> ''
    )
    INSERT INTO suppliers (supplier_name, firm_name, supplier_type, notes)
    SELECT
      supplier_name,
      supplier_name,
      'LOCAL_SUPPLIER',
      'Auto-created from legacy purchase records'
    FROM legacy_suppliers legacy
    WHERE NOT EXISTS (
      SELECT 1
      FROM suppliers existing
      WHERE LOWER(existing.supplier_name) = LOWER(legacy.supplier_name)
    );

    UPDATE purchases p
    SET supplier_id = matched.id
    FROM (
      SELECT MIN(id) AS id, LOWER(supplier_name) AS supplier_key
      FROM suppliers
      GROUP BY LOWER(supplier_name)
    ) matched
    WHERE p.supplier_id IS NULL
      AND p.supplier_name IS NOT NULL
      AND LOWER(TRIM(p.supplier_name)) = matched.supplier_key;

    UPDATE inventory_batches ib
    SET supplier_id = matched.id
    FROM (
      SELECT MIN(id) AS id, LOWER(supplier_name) AS supplier_key
      FROM suppliers
      GROUP BY LOWER(supplier_name)
    ) matched
    WHERE ib.supplier_id IS NULL
      AND ib.supplier_name IS NOT NULL
      AND LOWER(TRIM(ib.supplier_name)) = matched.supplier_key;

    UPDATE inventory_batches ib
    SET purchase_id = matched.id
    FROM purchases matched
    WHERE ib.purchase_id IS NULL
      AND ib.batch_no LIKE ('%-' || matched.id::TEXT);
  `);
};

const previousDateKey = (dateValue) => {
  const date = new Date(`${toDateKey(dateValue)}T00:00:00`);
  date.setDate(date.getDate() - 1);
  return toDateKey(date);
};

const getSupplierSummaryRows = async ({ active, search, supplierId, dateTo } = {}) => {
  const filters = [];
  const values = [];
  const purchaseDateFilter = isDateInput(dateTo) ? `AND purchase_date <= $${values.push(dateTo)}` : "";
  const paymentDateFilter = isDateInput(dateTo) ? `AND payment_date <= $${values.length}` : "";
  if (supplierId) {
    values.push(supplierId);
    filters.push(`s.id = $${values.length}`);
  }
  if (typeof active === "boolean") {
    values.push(active);
    filters.push(`s.active = $${values.length}`);
  }
  if (search) {
    values.push(`%${search.toLowerCase()}%`);
    filters.push(`(
      LOWER(s.supplier_name) LIKE $${values.length}
      OR LOWER(COALESCE(s.firm_name, '')) LIKE $${values.length}
      OR LOWER(COALESCE(s.mobile_number, '')) LIKE $${values.length}
      OR LOWER(COALESCE(s.city, '')) LIKE $${values.length}
      OR LOWER(COALESCE(s.gst_number, '')) LIKE $${values.length}
    )`);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await pool.query(
    `
    WITH purchase_summary AS (
      SELECT
        supplier_id,
        SUM(COALESCE(NULLIF(gross_amount, 0), total_amount, 0)) AS total_purchases,
        SUM(COALESCE(NULLIF(net_payable, 0), total_amount, 0)) AS net_purchase_cost,
        SUM(COALESCE(rebate_amount, 0)) AS purchase_rebate,
        SUM(COALESCE(paid_amount, 0)) AS purchase_paid
      FROM purchases
      WHERE supplier_id IS NOT NULL
        AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'
        AND COALESCE(purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
        ${purchaseDateFilter}
      GROUP BY supplier_id
    ),
    payment_summary AS (
      SELECT
        supplier_id,
        SUM(payment_amount) AS total_paid,
        SUM(rebate_amount) AS payment_rebate
      FROM supplier_payments
      WHERE cancelled = FALSE
        ${paymentDateFilter}
      GROUP BY supplier_id
    )
    SELECT
      s.*,
      COALESCE(ps.total_purchases, 0) AS total_purchases,
      COALESCE(ps.net_purchase_cost, 0) AS net_purchase_cost,
      COALESCE(ps.purchase_rebate, 0) AS purchase_rebate_received,
      COALESCE(ps.purchase_paid, 0) + COALESCE(pay.total_paid, 0) AS total_paid,
      COALESCE(pay.payment_rebate, 0) AS payment_rebate_received,
      COALESCE(ps.purchase_rebate, 0) + COALESCE(pay.payment_rebate, 0) AS total_rebate_received,
      ROUND((
        COALESCE(s.opening_balance, 0)
        + COALESCE(ps.total_purchases, 0)
        - COALESCE(ps.purchase_rebate, 0)
        - COALESCE(ps.purchase_paid, 0)
        - COALESCE(pay.total_paid, 0)
        - COALESCE(pay.payment_rebate, 0)
      )::NUMERIC, 2) AS outstanding_balance
    FROM suppliers s
    LEFT JOIN purchase_summary ps ON ps.supplier_id = s.id
    LEFT JOIN payment_summary pay ON pay.supplier_id = s.id
    ${whereClause}
    ORDER BY s.active DESC, s.supplier_name
    `,
    values
  );
  return result.rows;
};

const buildSupplierSummaryPayload = (rows) => {
  const totals = rows.reduce((summary, supplier) => ({
    totalPurchases: summary.totalPurchases + Number(supplier.total_purchases || 0),
    totalPaid: summary.totalPaid + Number(supplier.total_paid || 0),
    totalRebateReceived: summary.totalRebateReceived + Number(supplier.total_rebate_received || 0),
    outstandingBalance: summary.outstandingBalance + Number(supplier.outstanding_balance || 0),
  }), {
    totalPurchases: 0,
    totalPaid: 0,
    totalRebateReceived: 0,
    outstandingBalance: 0,
  });

  return {
    totalPurchases: roundCurrency(totals.totalPurchases),
    totalPaid: roundCurrency(totals.totalPaid),
    totalRebateReceived: roundCurrency(totals.totalRebateReceived),
    outstandingBalance: roundCurrency(totals.outstandingBalance),
    suppliers: rows,
  };
};

const readSupplierPayload = (body) => {
  const supplierType = normalizeSupplierType(body.supplier_type);
  return {
    supplier_name: cleanText(body.supplier_name),
    firm_name: nullableText(body.firm_name),
    mobile_number: nullableText(body.mobile_number),
    alternate_number: nullableText(body.alternate_number),
    address: nullableText(body.address),
    city: nullableText(body.city),
    gst_number: nullableText(body.gst_number),
    bank_name: nullableText(body.bank_name),
    account_number: nullableText(body.account_number),
    ifsc_code: nullableText(body.ifsc_code),
    upi_id: nullableText(body.upi_id),
    whatsapp_number: nullableText(body.whatsapp_number),
    whatsapp_opt_in: body.whatsapp_opt_in === undefined ? true : body.whatsapp_opt_in === true || body.whatsapp_opt_in === "true",
    notes: nullableText(body.notes),
    opening_balance: parseNonNegativeNumber(body.opening_balance),
    supplier_type: supplierType,
    active: body.active === undefined ? true : body.active === true || body.active === "true",
  };
};

const normalizeCustomerType = (value) => String(value || "RETAIL").trim().toUpperCase();
const normalizeAccountType = (value) => String(value || "OTHER").trim().toUpperCase();

const supplierTypeFromAccountType = (accountType) => ({
  SUPPLIER: "LOCAL_SUPPLIER",
  TRANSPORT_VENDOR: "TRANSPORT_VENDOR",
  COMMISSION_AGENT: "COMMISSION_AGENT",
}[accountType] || "LOCAL_SUPPLIER");

const accountTypeFromSupplierType = (supplierType) => ({
  TRANSPORT_VENDOR: "TRANSPORT_VENDOR",
  COMMISSION_AGENT: "COMMISSION_AGENT",
}[supplierType] || "SUPPLIER");

const readCustomerPayload = (body) => {
  const customerType = normalizeCustomerType(body.customer_type);
  return {
    customer_name: cleanText(body.customer_name),
    customer_type: customerType,
    firm_name: nullableText(body.firm_name),
    mobile_number: nullableText(body.mobile_number),
    alternate_number: nullableText(body.alternate_number),
    address: nullableText(body.address),
    city: nullableText(body.city),
    gst_number: nullableText(body.gst_number),
    bank_name: nullableText(body.bank_name),
    account_number: nullableText(body.account_number),
    ifsc_code: nullableText(body.ifsc_code),
    upi_id: nullableText(body.upi_id),
    whatsapp_number: nullableText(body.whatsapp_number),
    whatsapp_opt_in: body.whatsapp_opt_in === undefined ? true : body.whatsapp_opt_in === true || body.whatsapp_opt_in === "true",
    notes: nullableText(body.notes),
    opening_balance: parseNonNegativeNumber(body.opening_balance),
    active: body.active === undefined ? true : body.active === true || body.active === "true",
  };
};

const readAccountPayload = (body) => {
  const accountType = normalizeAccountType(body.account_type);
  return {
    account_name: cleanText(body.account_name),
    account_type: accountType,
    firm_name: nullableText(body.firm_name),
    mobile_number: nullableText(body.mobile_number),
    alternate_number: nullableText(body.alternate_number),
    address: nullableText(body.address),
    city: nullableText(body.city),
    gst_number: nullableText(body.gst_number),
    bank_name: nullableText(body.bank_name),
    account_number: nullableText(body.account_number),
    ifsc_code: nullableText(body.ifsc_code),
    upi_id: nullableText(body.upi_id),
    whatsapp_number: nullableText(body.whatsapp_number),
    whatsapp_opt_in: body.whatsapp_opt_in === undefined ? true : body.whatsapp_opt_in === true || body.whatsapp_opt_in === "true",
    opening_balance: parseNonNegativeNumber(body.opening_balance),
    active: body.active === undefined ? true : body.active === true || body.active === "true",
    notes: nullableText(body.notes),
  };
};

const getCustomerSummaryRows = async ({ active, search, customerId, dateTo } = {}) => {
  const filters = [];
  const values = [];
  const saleDateFilter = isDateInput(dateTo) ? `AND s.sale_date <= $${values.push(dateTo)}` : "";
  const customerPaymentDateFilter = isDateInput(dateTo) ? `AND payment_date <= $${values.length}` : "";
  if (customerId) {
    values.push(customerId);
    filters.push(`c.id = $${values.length}`);
  }
  if (typeof active === "boolean") {
    values.push(active);
    filters.push(`c.active = $${values.length}`);
  }
  if (search) {
    values.push(`%${search.toLowerCase()}%`);
    filters.push(`(
      LOWER(c.customer_name) LIKE $${values.length}
      OR LOWER(COALESCE(c.mobile_number, '')) LIKE $${values.length}
      OR LOWER(COALESCE(c.gst_number, '')) LIKE $${values.length}
    )`);
  }
  const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await pool.query(
    `
    WITH sale_summary AS (
      SELECT
        matched.customer_id,
        SUM(CASE WHEN s.sale_status <> 'CANCELLED' THEN s.total_amount ELSE 0 END) AS total_sales,
        SUM(CASE WHEN s.sale_status <> 'CANCELLED' THEN COALESCE(pay.total_paid, 0) ELSE 0 END) AS sale_paid,
        SUM(CASE WHEN s.sale_status = 'CANCELLED' THEN s.total_amount ELSE 0 END) AS total_cancelled
      FROM sales s
      JOIN LATERAL (
        SELECT c.id AS customer_id
        FROM customers c
        WHERE
          s.customer_id = c.id
          OR (s.customer_id IS NULL AND s.customer_mobile IS NOT NULL AND c.mobile_number = s.customer_mobile)
          OR (
            s.customer_id IS NULL
            AND c.system_account = TRUE
            AND (
              s.customer_name IS NULL
              OR LOWER(COALESCE(s.customer_name, '')) LIKE '%walk-in%'
            )
          )
          OR (
            s.customer_id IS NULL
            AND c.system_account IS DISTINCT FROM TRUE
            AND s.customer_mobile IS NULL
            AND s.customer_name IS NOT NULL
            AND LOWER(c.customer_name) = LOWER(s.customer_name)
          )
        ORDER BY CASE WHEN s.customer_id = c.id THEN 0 WHEN c.mobile_number = s.customer_mobile THEN 1 ELSE 2 END, c.id
        LIMIT 1
      ) matched ON TRUE
      LEFT JOIN (
        SELECT sale_id, SUM(amount) AS total_paid
        FROM sale_payments
        GROUP BY sale_id
      ) pay ON pay.sale_id = s.id
      WHERE 1 = 1
        ${saleDateFilter}
      GROUP BY matched.customer_id
    ),
    customer_payment_summary AS (
      SELECT customer_id, SUM(payment_amount) AS total_customer_paid
      FROM customer_payments
      WHERE cancelled = FALSE
        ${customerPaymentDateFilter}
      GROUP BY customer_id
    )
    SELECT
      c.*,
      COALESCE(ss.total_sales, 0) AS total_sales,
      COALESCE(ss.sale_paid, 0) + COALESCE(cps.total_customer_paid, 0) AS total_paid,
      COALESCE(ss.total_cancelled, 0) AS total_cancelled,
      ROUND((
        COALESCE(c.opening_balance, 0)
        + COALESCE(ss.total_sales, 0)
        - COALESCE(ss.sale_paid, 0)
        - COALESCE(cps.total_customer_paid, 0)
      )::NUMERIC, 2) AS outstanding_balance
    FROM customers c
    LEFT JOIN sale_summary ss ON ss.customer_id = c.id
    LEFT JOIN customer_payment_summary cps ON cps.customer_id = c.id
    ${whereClause}
    ORDER BY c.active DESC, c.customer_name
    `,
    values
  );
  return result.rows;
};

const buildCustomerSummaryPayload = (rows) => {
  const totals = rows.reduce((summary, customer) => ({
    totalSales: summary.totalSales + Number(customer.total_sales || 0),
    totalPaid: summary.totalPaid + Number(customer.total_paid || 0),
    outstandingBalance: summary.outstandingBalance + Number(customer.outstanding_balance || 0),
  }), { totalSales: 0, totalPaid: 0, outstandingBalance: 0 });
  return {
    totalSales: roundCurrency(totals.totalSales),
    totalPaid: roundCurrency(totals.totalPaid),
    outstandingBalance: roundCurrency(totals.outstandingBalance),
    customers: rows,
  };
};

const getBalanceSheetSnapshot = async ({ dateTo = toDateKey(new Date()) } = {}) => {
  const asAtDate = isDateInput(dateTo) ? dateTo : toDateKey(new Date());
  const bankModesSql = BANK_PAYMENT_MODES.map((mode) => `'${mode}'`).join(", ");
  const [cashResult, inventoryResult, profitLossResult, supplierRows, customerRows] = await Promise.all([
    pool.query(
      `
      SELECT
        COALESCE((
          SELECT SUM(sp.amount)
          FROM sale_payments sp
          JOIN sales s ON s.id = sp.sale_id
          WHERE s.sale_status <> 'CANCELLED'
            AND sp.payment_mode = 'CASH'
            AND s.sale_date <= $1
        ), 0)
        + COALESCE((
          SELECT SUM(payment_amount)
          FROM customer_payments
          WHERE cancelled = FALSE
            AND payment_mode = 'CASH'
            AND payment_date <= $1
        ), 0)
        - COALESCE((
          SELECT SUM(payment_amount)
          FROM supplier_payments
          WHERE cancelled = FALSE
            AND payment_mode = 'CASH'
            AND payment_date <= $1
        ), 0)
        - COALESCE((
          SELECT SUM(COALESCE(paid_amount, 0))
          FROM purchases
          WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'
            AND COALESCE(purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
            AND COALESCE(payment_mode, '') = 'CASH'
            AND purchase_date <= $1
        ), 0)
        - COALESCE((
          SELECT SUM(amount)
          FROM expenses
          WHERE active IS DISTINCT FROM FALSE
            AND COALESCE(status, 'ACTIVE') <> 'CANCELLED'
            AND payment_mode = 'CASH'
            AND expense_date <= $1
        ), 0) AS cash_in_hand,
        COALESCE((
          SELECT SUM(sp.amount)
          FROM sale_payments sp
          JOIN sales s ON s.id = sp.sale_id
          WHERE s.sale_status <> 'CANCELLED'
            AND sp.payment_mode IN (${bankModesSql})
            AND s.sale_date <= $1
        ), 0)
        + COALESCE((
          SELECT SUM(payment_amount)
          FROM customer_payments
          WHERE cancelled = FALSE
            AND payment_mode IN (${bankModesSql})
            AND payment_date <= $1
        ), 0)
        - COALESCE((
          SELECT SUM(payment_amount)
          FROM supplier_payments
          WHERE cancelled = FALSE
            AND payment_mode IN (${bankModesSql})
            AND payment_date <= $1
        ), 0)
        - COALESCE((
          SELECT SUM(COALESCE(paid_amount, 0))
          FROM purchases
          WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'
            AND COALESCE(purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
            AND COALESCE(payment_mode, '') IN (${bankModesSql})
            AND purchase_date <= $1
        ), 0)
        - COALESCE((
          SELECT SUM(amount)
          FROM expenses
          WHERE active IS DISTINCT FROM FALSE
            AND COALESCE(status, 'ACTIVE') <> 'CANCELLED'
            AND payment_mode IN (${bankModesSql})
            AND expense_date <= $1
        ), 0) AS cash_at_bank
      `,
      [asAtDate]
    ),
    pool.query(
      `
      SELECT COALESCE(SUM(remaining_qty * COALESCE(effective_cost_per_unit, purchase_rate)), 0) AS inventory_value
      FROM inventory_batches
      WHERE COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED'
        AND created_at::date <= $1
      `,
      [asAtDate]
    ),
    pool.query(
      `
      SELECT
        COALESCE((SELECT SUM(total_amount) FROM sales WHERE sale_status <> 'CANCELLED' AND sale_date <= $1), 0) AS sales_revenue,
        COALESCE((SELECT SUM(total_cost) FROM sales WHERE sale_status <> 'CANCELLED' AND sale_date <= $1), 0) AS purchase_cost,
        COALESCE((SELECT SUM(mandi_tax_amount) FROM purchases WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED' AND purchase_date <= $1), 0) AS mandi_tax,
        COALESCE((SELECT SUM(freight_charges) FROM purchases WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED' AND purchase_date <= $1), 0) AS freight_charges,
        COALESCE((SELECT SUM(labour_charges) FROM purchases WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED' AND purchase_date <= $1), 0) AS labour_charges,
        COALESCE((SELECT SUM(other_charges) FROM purchases WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED' AND purchase_date <= $1), 0) AS other_purchase_charges,
        COALESCE((SELECT SUM(amount) FROM expenses WHERE active IS DISTINCT FROM FALSE AND COALESCE(status, 'ACTIVE') <> 'CANCELLED' AND expense_date <= $1), 0) AS expenses,
        COALESCE((SELECT SUM(rebate_amount) FROM purchases WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED' AND purchase_date <= $1), 0)
          + COALESCE((SELECT SUM(rebate_amount) FROM supplier_payments WHERE cancelled = FALSE AND payment_date <= $1), 0) AS supplier_rebate_received
      `,
      [asAtDate]
    ),
    getSupplierSummaryRows({ dateTo: asAtDate }),
    getCustomerSummaryRows({ dateTo: asAtDate }),
  ]);

  const cash = cashResult.rows[0] || {};
  const profitLoss = profitLossResult.rows[0] || {};
  const inventoryValue = Number(inventoryResult.rows[0]?.inventory_value || 0);
  const customerReceivable = customerRows.reduce((sum, row) => sum + Number(row.outstanding_balance || 0), 0);
  const supplierPayable = supplierRows.reduce((sum, row) => sum + Number(row.outstanding_balance || 0), 0);
  const purchaseCost = Number(profitLoss.purchase_cost || 0);
  const costOfGoodsSold = purchaseCost
    + Number(profitLoss.mandi_tax || 0)
    + Number(profitLoss.freight_charges || 0)
    + Number(profitLoss.labour_charges || 0)
    + Number(profitLoss.other_purchase_charges || 0)
    - Number(profitLoss.supplier_rebate_received || 0);
  const grossProfit = Number(profitLoss.sales_revenue || 0) - costOfGoodsSold;
  const netProfit = grossProfit - Number(profitLoss.expenses || 0);
  const cashInHand = Number(cash.cash_in_hand || 0);
  const cashAtBank = Number(cash.cash_at_bank || 0);
  const totalAssets = cashInHand + cashAtBank + inventoryValue + customerReceivable;
  const ownerCapital = roundCurrency(totalAssets - supplierPayable - netProfit);

  return {
    asAtDate,
    cash: roundCurrency(cashInHand),
    bank: roundCurrency(cashAtBank),
    inventory: roundCurrency(inventoryValue),
    customerReceivable: roundCurrency(customerReceivable),
    supplierPayable: roundCurrency(supplierPayable),
    netProfit: roundCurrency(netProfit),
    ownerCapital,
    netPosition: roundCurrency(totalAssets - supplierPayable),
    totalAssets: roundCurrency(totalAssets),
    totalLiabilities: roundCurrency(supplierPayable + netProfit + ownerCapital),
    profitLoss: {
      salesRevenue: roundCurrency(Number(profitLoss.sales_revenue || 0)),
      purchaseCost: roundCurrency(purchaseCost),
      costOfGoodsSold: roundCurrency(costOfGoodsSold),
      grossProfit: roundCurrency(grossProfit),
      expenses: roundCurrency(Number(profitLoss.expenses || 0)),
      netProfit: roundCurrency(netProfit),
    },
    supplierRows,
    customerRows,
  };
};

const cashBookModeGroup = (paymentMode) => {
  const mode = normalizePaymentMode(paymentMode);
  if (mode === "CASH" || mode === "CASH_REFUND") return "CASH";
  if (BANK_PAYMENT_MODES.includes(mode) || mode === "UPI_REFUND" || mode === "CARD_REFUND" || mode === "BANK_REFUND") return "BANK";
  return "";
};

const getCashBookReport = async ({
  dateFrom = toDateKey(new Date()),
  dateTo = toDateKey(new Date()),
  paymentMode = "",
  accountFilter = "",
  partyFilter = "",
  search = "",
  groupByDate = false,
  lineKey = "",
} = {}) => {
  const from = isDateInput(dateFrom) ? dateFrom : toDateKey(new Date());
  const to = isDateInput(dateTo) ? dateTo : from;
  const normalizedPaymentMode = normalizePaymentMode(paymentMode || "");
  const normalizedAccountFilter = String(accountFilter || "").trim().toUpperCase();
  const normalizedPartyFilter = String(partyFilter || "").trim().toUpperCase();
  const searchText = cleanText(search).toLowerCase();
  const result = await pool.query(
    `
    WITH sale_item_summary AS (
      SELECT
        si.sale_id,
        STRING_AGG(
          DISTINCT p.product_name
            || COALESCE(' ' || NULLIF(ib.lot_name, ''), '')
            || ' ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM si.quantity::TEXT))
            || COALESCE(' ' || p.unit, '')
            || ' @ ' || si.selling_rate,
          ', '
        ) AS item_summary
      FROM sale_items si
      JOIN products p ON p.id = si.product_id
      LEFT JOIN sale_batch_allocations sba ON sba.sale_item_id = si.id
      LEFT JOIN inventory_batches ib ON ib.id = sba.inventory_batch_id
      GROUP BY si.sale_id
    ),
    purchase_item_summary AS (
      SELECT
        pi.purchase_id,
        STRING_AGG(
          DISTINCT pr.product_name
            || COALESCE(' ' || NULLIF(pi.lot_name, ''), '')
            || ' ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM pi.quantity::TEXT))
            || COALESCE(' ' || pr.unit, ''),
          ', '
        ) AS item_summary
      FROM purchase_items pi
      JOIN products pr ON pr.id = pi.product_id
      GROUP BY pi.purchase_id
    )
    SELECT *
    FROM (
      SELECT
        s.sale_date AS date,
        s.created_at AS entry_time,
        'Customer A/c - ' || COALESCE(c.customer_name, s.customer_name, 'Walk-in Customer') AS account_name,
        'CUSTOMER' AS account_type,
        COALESCE(c.customer_name, s.customer_name, 'Walk-in Customer') AS party_name,
        'POS Invoice ' || COALESCE(s.invoice_no, 'SALE-' || s.id) || ' | ' || COALESCE(c.customer_name, s.customer_name, 'Walk-in Customer') || COALESCE(' | Items: ' || sis.item_summary, '') AS narration,
        sp.payment_mode,
        'RECEIPT' AS direction,
        sp.amount,
        COALESCE(s.invoice_no, 'SALE-' || s.id) AS reference_no,
        'POS Sale' AS source_type,
        s.id AS source_id
      FROM sale_payments sp
      JOIN sales s ON s.id = sp.sale_id
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN sale_item_summary sis ON sis.sale_id = s.id
      WHERE s.sale_status <> 'CANCELLED'
        AND s.sale_date <= $1
        AND sp.payment_mode <> 'CREDIT'
      UNION ALL
      SELECT
        cp.payment_date AS date,
        cp.created_at AS entry_time,
        'Customer A/c - ' || c.customer_name AS account_name,
        'CUSTOMER' AS account_type,
        c.customer_name AS party_name,
        'Received from ' || c.customer_name || ' | Against ledger balance | ' || cp.payment_mode || COALESCE(' | ' || cp.remarks, '') AS narration,
        cp.payment_mode,
        'RECEIPT' AS direction,
        cp.payment_amount AS amount,
        COALESCE(cp.reference_number, 'CP-' || cp.id) AS reference_no,
        'Customer Receipt' AS source_type,
        cp.id AS source_id
      FROM customer_payments cp
      JOIN customers c ON c.id = cp.customer_id
      WHERE cp.cancelled = FALSE
        AND cp.payment_date <= $1
      UNION ALL
      SELECT
        p.purchase_date AS date,
        p.created_at AS entry_time,
        'Supplier A/c - ' || COALESCE(s.supplier_name, p.supplier_name, 'Supplier') AS account_name,
        'SUPPLIER' AS account_type,
        COALESCE(s.supplier_name, p.supplier_name, 'Supplier') AS party_name,
        COALESCE(p.payment_mode, 'CASH') || ' Purchase from ' || COALESCE(s.supplier_name, p.supplier_name, 'Supplier') || COALESCE(' | Items: ' || pis.item_summary, '') || COALESCE(' | ' || p.remarks, '') AS narration,
        p.payment_mode,
        'PAYMENT' AS direction,
        COALESCE(p.paid_amount, 0) AS amount,
        COALESCE(p.bill_number, p.payment_reference_number, 'PUR-' || p.id) AS reference_no,
        'Purchase Payment' AS source_type,
        p.id AS source_id
      FROM purchases p
      LEFT JOIN suppliers s ON s.id = p.supplier_id
      LEFT JOIN purchase_item_summary pis ON pis.purchase_id = p.id
      WHERE COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
        AND COALESCE(p.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
        AND COALESCE(p.paid_amount, 0) > 0
        AND p.purchase_date <= $1
        AND COALESCE(p.payment_mode, '') <> ''
      UNION ALL
      SELECT
        sp.payment_date AS date,
        sp.created_at AS entry_time,
        'Supplier A/c - ' || s.supplier_name AS account_name,
        'SUPPLIER' AS account_type,
        s.supplier_name AS party_name,
        'Payment to ' || s.supplier_name || ' | Against pending purchase bills | ' || sp.payment_mode || COALESCE(' | ' || sp.remarks, '') AS narration,
        sp.payment_mode,
        'PAYMENT' AS direction,
        sp.payment_amount AS amount,
        COALESCE(sp.reference_number, 'SP-' || sp.id) AS reference_no,
        'Supplier Payment' AS source_type,
        sp.id AS source_id
      FROM supplier_payments sp
      JOIN suppliers s ON s.id = sp.supplier_id
      WHERE sp.cancelled = FALSE
        AND sp.payment_date <= $1
      UNION ALL
      SELECT
        e.expense_date AS date,
        e.created_at AS entry_time,
        e.category || ' Expense - ' || COALESCE(e.paid_to, e.vendor_name, e.category) AS account_name,
        CASE WHEN LOWER(e.category) LIKE '%salary%' OR LOWER(COALESCE(e.paid_to, e.vendor_name, '')) LIKE '%salary%' THEN 'EMPLOYEE' ELSE 'EXPENSE' END AS account_type,
        COALESCE(e.paid_to, e.vendor_name, e.category) AS party_name,
        e.category || ' paid to ' || COALESCE(e.paid_to, e.vendor_name, e.category) || ' | ' || e.payment_mode || COALESCE(' | ' || e.remarks, '') AS narration,
        e.payment_mode,
        'PAYMENT' AS direction,
        e.amount,
        COALESCE(e.reference_number, 'EXP-' || e.id) AS reference_no,
        'Expense' AS source_type,
        e.id AS source_id
      FROM expenses e
      WHERE e.active IS DISTINCT FROM FALSE
        AND COALESCE(e.status, 'ACTIVE') <> 'CANCELLED'
        AND e.expense_date <= $1
      UNION ALL
      SELECT
        sr.return_date AS date,
        sr.created_at AS entry_time,
        'Customer A/c - ' || COALESCE(sr.customer_name, 'Walk-in Customer') AS account_name,
        'CUSTOMER' AS account_type,
        COALESCE(sr.customer_name, 'Walk-in Customer') AS party_name,
        'Refund to ' || COALESCE(sr.customer_name, 'Walk-in Customer') || ' | Return ' || COALESCE(sr.return_no, 'RET-' || sr.id) || ' | ' || sr.refund_type || COALESCE(' | ' || sr.return_reason, '') AS narration,
        sr.refund_type AS payment_mode,
        'PAYMENT' AS direction,
        sr.total_return_amount AS amount,
        COALESCE(sr.return_no, 'RET-' || sr.id) AS reference_no,
        'Sale Return Refund' AS source_type,
        sr.id AS source_id
      FROM sale_returns sr
      WHERE sr.return_date <= $1
        AND sr.refund_type IN ('CASH_REFUND', 'UPI_REFUND')
      UNION ALL
      SELECT
        ce.contra_date AS date,
        ce.created_at AS entry_time,
        'Contra A/c - ' || COALESCE(ce.bank_account, 'Bank') AS account_name,
        'CONTRA' AS account_type,
        COALESCE(ce.bank_account, 'Bank') AS party_name,
        'Cash deposited into ' || COALESCE(ce.bank_account, 'Bank') || COALESCE(' | ' || ce.remarks, '') AS narration,
        'CASH' AS payment_mode,
        'PAYMENT' AS direction,
        ce.amount,
        COALESCE(ce.reference_number, 'CONTRA-' || ce.id) AS reference_no,
        'Contra Payment' AS source_type,
        ce.id AS source_id
      FROM contra_entries ce
      WHERE ce.cancelled = FALSE
        AND ce.contra_type = 'CASH_TO_BANK'
        AND ce.contra_date <= $1
      UNION ALL
      SELECT
        ce.contra_date AS date,
        ce.created_at AS entry_time,
        'Contra A/c - ' || COALESCE(ce.cash_account, 'Cash') AS account_name,
        'CONTRA' AS account_type,
        COALESCE(ce.cash_account, 'Cash') AS party_name,
        'Cash deposited into ' || COALESCE(ce.bank_account, 'Bank') || COALESCE(' | ' || ce.remarks, '') AS narration,
        'BANK_TRANSFER' AS payment_mode,
        'RECEIPT' AS direction,
        ce.amount,
        COALESCE(ce.reference_number, 'CONTRA-' || ce.id) AS reference_no,
        'Contra Receipt' AS source_type,
        ce.id AS source_id
      FROM contra_entries ce
      WHERE ce.cancelled = FALSE
        AND ce.contra_type = 'CASH_TO_BANK'
        AND ce.contra_date <= $1
      UNION ALL
      SELECT
        ce.contra_date AS date,
        ce.created_at AS entry_time,
        'Contra A/c - ' || COALESCE(ce.bank_account, 'Bank') AS account_name,
        'CONTRA' AS account_type,
        COALESCE(ce.bank_account, 'Bank') AS party_name,
        'Cash withdrawn from ' || COALESCE(ce.bank_account, 'Bank') || COALESCE(' | ' || ce.remarks, '') AS narration,
        'BANK_TRANSFER' AS payment_mode,
        'PAYMENT' AS direction,
        ce.amount,
        COALESCE(ce.reference_number, 'CONTRA-' || ce.id) AS reference_no,
        'Contra Payment' AS source_type,
        ce.id AS source_id
      FROM contra_entries ce
      WHERE ce.cancelled = FALSE
        AND ce.contra_type = 'BANK_TO_CASH'
        AND ce.contra_date <= $1
      UNION ALL
      SELECT
        ce.contra_date AS date,
        ce.created_at AS entry_time,
        'Contra A/c - ' || COALESCE(ce.cash_account, 'Cash') AS account_name,
        'CONTRA' AS account_type,
        COALESCE(ce.cash_account, 'Cash') AS party_name,
        'Cash withdrawn from ' || COALESCE(ce.bank_account, 'Bank') || COALESCE(' | ' || ce.remarks, '') AS narration,
        'CASH' AS payment_mode,
        'RECEIPT' AS direction,
        ce.amount,
        COALESCE(ce.reference_number, 'CONTRA-' || ce.id) AS reference_no,
        'Contra Receipt' AS source_type,
        ce.id AS source_id
      FROM contra_entries ce
      WHERE ce.cancelled = FALSE
        AND ce.contra_type = 'BANK_TO_CASH'
        AND ce.contra_date <= $1
    ) cash_rows
    ORDER BY date, entry_time, reference_no
    `,
    [to]
  );

  const filteredRows = result.rows
    .map((row) => {
      const modeGroup = cashBookModeGroup(row.payment_mode);
      const amount = Number(row.amount || 0);
      return {
        ...row,
        date: toDateKey(row.date),
        date_key: toDateKey(row.date),
        mode_group: modeGroup,
        receipt_cash: row.direction === "RECEIPT" && modeGroup === "CASH" ? amount : 0,
        receipt_bank: row.direction === "RECEIPT" && modeGroup === "BANK" ? amount : 0,
        payment_cash: row.direction === "PAYMENT" && modeGroup === "CASH" ? amount : 0,
        payment_bank: row.direction === "PAYMENT" && modeGroup === "BANK" ? amount : 0,
      };
    })
    .filter((row) => row.mode_group)
    .filter((row) => {
      if (lineKey === "cash_in_hand" && row.mode_group !== "CASH") return false;
      if (lineKey === "cash_at_bank" && row.mode_group !== "BANK") return false;
      if (normalizedPaymentMode && normalizePaymentMode(row.payment_mode) !== normalizedPaymentMode) return false;
      if (normalizedAccountFilter && normalizedAccountFilter !== "ALL" && row.account_type !== normalizedAccountFilter && row.mode_group !== normalizedAccountFilter) return false;
      if (normalizedPartyFilter && normalizedPartyFilter !== "ALL" && row.account_type !== normalizedPartyFilter) return false;
      if (searchText) {
        const haystack = [
          row.account_name, row.party_name, row.narration, row.payment_mode,
          row.reference_no, row.source_type, row.amount,
        ].join(" ").toLowerCase();
        if (!haystack.includes(searchText)) return false;
      }
      return true;
    });

  const openingRows = filteredRows.filter((row) => row.date_key < from);
  const movementRows = filteredRows.filter((row) => row.date_key >= from && row.date_key <= to);
  const openingCash = roundCurrency(openingRows.reduce((sum, row) => sum + row.receipt_cash - row.payment_cash, 0));
  const openingBank = roundCurrency(openingRows.reduce((sum, row) => sum + row.receipt_bank - row.payment_bank, 0));

  const detailRows = groupByDate
    ? [...movementRows.reduce((groups, row) => {
      const current = groups.get(row.date_key) || {
        date: row.date_key,
        entry_time: row.date_key,
        account_name: `Date Summary - ${row.date_key}`,
        account_type: "SUMMARY",
        party_name: "Date Summary",
        narration: "",
        payment_mode: "ALL",
        receipt_cash: 0,
        receipt_bank: 0,
        payment_cash: 0,
        payment_bank: 0,
        reference_no: "Grouped",
        source_type: "Cash Book Date Summary",
        source_id: row.date_key,
        source_rows: [],
      };
      current.receipt_cash += row.receipt_cash;
      current.receipt_bank += row.receipt_bank;
      current.payment_cash += row.payment_cash;
      current.payment_bank += row.payment_bank;
      current.source_rows.push(row);
      current.narration = `${current.source_rows.length} cash/bank transaction${current.source_rows.length === 1 ? "" : "s"} on ${row.date_key}`;
      groups.set(row.date_key, current);
      return groups;
    }, new Map()).values()]
    : movementRows;

  let cashBalance = openingCash;
  let bankBalance = openingBank;
  const rows = detailRows.map((row) => {
    cashBalance = roundCurrency(cashBalance + Number(row.receipt_cash || 0) - Number(row.payment_cash || 0));
    bankBalance = roundCurrency(bankBalance + Number(row.receipt_bank || 0) - Number(row.payment_bank || 0));
    return {
      ...row,
      cash_balance: cashBalance,
      bank_balance: bankBalance,
      total_balance: roundCurrency(cashBalance + bankBalance),
    };
  });

  const cashReceipts = roundCurrency(rows.reduce((sum, row) => sum + Number(row.receipt_cash || 0), 0));
  const bankReceipts = roundCurrency(rows.reduce((sum, row) => sum + Number(row.receipt_bank || 0), 0));
  const cashPayments = roundCurrency(rows.reduce((sum, row) => sum + Number(row.payment_cash || 0), 0));
  const bankPayments = roundCurrency(rows.reduce((sum, row) => sum + Number(row.payment_bank || 0), 0));
  const closingCash = roundCurrency(openingCash + cashReceipts - cashPayments);
  const closingBank = roundCurrency(openingBank + bankReceipts - bankPayments);

  return {
    dateFrom: from,
    dateTo: to,
    opening_cash: openingCash,
    opening_bank: openingBank,
    cash_receipts: cashReceipts,
    bank_receipts: bankReceipts,
    cash_payments: cashPayments,
    bank_payments: bankPayments,
    closing_cash: closingCash,
    closing_bank: closingBank,
    total_closing: roundCurrency(closingCash + closingBank),
    rows,
  };
};

const getWalkInCustomer = async (client = pool) => {
  const result = await client.query(
    `
    SELECT *
    FROM customers
    WHERE system_account = TRUE OR LOWER(customer_name) = LOWER('Walk-in Customer')
    ORDER BY system_account DESC, id
    LIMIT 1
    `
  );
  return result.rows[0] || null;
};

const isDateInput = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));

const parseDashboardRange = (query = {}) => {
  if (isDateInput(query.date_from) && isDateInput(query.date_to) && query.date_from <= query.date_to) {
    return { dateFrom: query.date_from, dateTo: query.date_to, days: null };
  }
  const requestedDays = parsePositiveInteger(query.days);
  const days = [7, 15, 30].includes(requestedDays) ? requestedDays : 7;
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days + 1);
  return {
    dateFrom: toDateKey(startDate),
    dateTo: toDateKey(endDate),
    days,
  };
};

const getDashboardSummary = async () => {
  const [metricsResult, supplierRows, customerRows] = await Promise.all([
    pool.query(
      `
      SELECT
        COALESCE((SELECT SUM(total_amount) FROM sales WHERE sale_date = CURRENT_DATE AND sale_status <> 'CANCELLED'), 0) AS "todaySales",
        COALESCE((SELECT SUM(profit) FROM sales WHERE sale_date = CURRENT_DATE AND sale_status <> 'CANCELLED'), 0) AS "todayProfit",
        COALESCE((
          SELECT SUM(remaining_qty * COALESCE(effective_cost_per_unit, purchase_rate))
          FROM inventory_batches
          WHERE COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED'
        ), 0) AS "stockValue",
        COALESCE((
          SELECT COUNT(*)
          FROM (
            SELECT
              p.id,
              COALESCE(SUM(ib.remaining_qty), 0) AS current_stock,
              COALESCE(p.minimum_stock, 5) AS minimum_stock
            FROM products p
            LEFT JOIN inventory_batches ib ON ib.product_id = p.id
              AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
            WHERE p.active IS DISTINCT FROM FALSE
            GROUP BY p.id, p.minimum_stock
          ) stock
          WHERE stock.current_stock <= stock.minimum_stock
        ), 0) AS "lowStockItems",
        COALESCE((SELECT COUNT(*) FROM sales WHERE sale_date = CURRENT_DATE AND sale_status <> 'CANCELLED'), 0) AS "transactions",
        COALESCE((SELECT SUM(amount) FROM expenses WHERE expense_date = CURRENT_DATE AND active IS DISTINCT FROM FALSE), 0) AS "todayExpenses",
        COALESCE((SELECT SUM(total_return_amount) FROM sale_returns WHERE return_date = CURRENT_DATE), 0) AS "todayReturns",
        COALESCE((SELECT SUM(total_return_amount) FROM sale_returns WHERE return_date >= DATE_TRUNC('month', CURRENT_DATE)::date), 0) AS "monthlyReturns",
        COALESCE((SELECT SUM(cost_amount) FROM waste_entries WHERE waste_date = CURRENT_DATE), 0) AS "todayWaste",
        COALESCE((SELECT SUM(cost_amount) FROM waste_entries WHERE waste_date >= DATE_TRUNC('month', CURRENT_DATE)::date), 0) AS "monthlyWaste",
        COALESCE((SELECT SUM(quantity) FROM waste_entries WHERE waste_date >= DATE_TRUNC('month', CURRENT_DATE)::date), 0) AS "monthlyWasteQuantity",
        COALESCE((SELECT SUM(rebate_amount) FROM purchases WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED' AND COALESCE(purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'), 0)
          + COALESCE((SELECT SUM(rebate_amount) FROM supplier_payments WHERE cancelled = FALSE), 0) AS "totalRebateReceived",
        COALESCE((SELECT SUM(payment_amount) FROM supplier_payments WHERE payment_date = CURRENT_DATE AND cancelled = FALSE), 0)
          + COALESCE((SELECT SUM(paid_amount) FROM purchases WHERE COALESCE(payment_date, purchase_date) = CURRENT_DATE AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED' AND COALESCE(purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'), 0) AS "todaySupplierPayments",
        COALESCE((SELECT COUNT(*) FROM suppliers), 0) AS supplier_count,
        COALESCE((SELECT COUNT(*) FROM suppliers WHERE active = TRUE), 0) AS active_supplier_count
      `
    ),
    getSupplierSummaryRows(),
    getCustomerSummaryRows(),
  ]);
  const metrics = metricsResult.rows[0] || {};
  const supplierSummary = buildSupplierSummaryPayload(supplierRows);
  const customerSummary = buildCustomerSummaryPayload(customerRows);
  return {
    todaySales: Number(metrics.todaySales || 0),
    todayProfit: Number(metrics.todayProfit || 0),
    stockValue: Number(metrics.stockValue || 0),
    lowStockItems: Number(metrics.lowStockItems || 0),
    transactions: Number(metrics.transactions || 0),
    supplierOutstanding: Number(supplierSummary.outstandingBalance || 0),
    customerOutstanding: Number(customerSummary.outstandingBalance || 0),
    todayExpenses: Number(metrics.todayExpenses || 0),
    todayReturns: Number(metrics.todayReturns || 0),
    monthlyReturns: Number(metrics.monthlyReturns || 0),
    todayWaste: Number(metrics.todayWaste || 0),
    monthlyWaste: Number(metrics.monthlyWaste || 0),
    monthlyWasteQuantity: Number(metrics.monthlyWasteQuantity || 0),
    wastePercentage: Number(metrics.stockValue || 0) > 0
      ? roundCurrency((Number(metrics.monthlyWaste || 0) / (Number(metrics.stockValue || 0) + Number(metrics.monthlyWaste || 0))) * 100)
      : 0,
    totalRebateReceived: Number(metrics.totalRebateReceived || 0),
    todaySupplierPayments: Number(metrics.todaySupplierPayments || 0),
    total_supplier_outstanding: Number(supplierSummary.outstandingBalance || 0),
    total_rebate_received: Number(metrics.totalRebateReceived || 0),
    todays_supplier_payments: Number(metrics.todaySupplierPayments || 0),
    supplier_count: Number(metrics.supplier_count || 0),
    active_supplier_count: Number(metrics.active_supplier_count || 0),
  };
};

const getDashboardSalesTrend = async (dateFrom, dateTo) => {
  const result = await pool.query(
    `
    WITH days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day
    ),
    sales_by_day AS (
      SELECT sale_date::date AS day, SUM(total_amount) AS sales
      FROM sales
      WHERE sale_status <> 'CANCELLED'
        AND sale_date BETWEEN $1 AND $2
      GROUP BY sale_date
    )
    SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS date, COALESCE(sales_by_day.sales, 0) AS sales
    FROM days
    LEFT JOIN sales_by_day ON sales_by_day.day = days.day
    ORDER BY days.day
    `,
    [dateFrom, dateTo]
  );
  return result.rows.map((row) => ({ date: row.date, sales: Number(row.sales || 0) }));
};

const getDashboardProfitTrend = async (dateFrom, dateTo) => {
  const result = await pool.query(
    `
    WITH days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day
    ),
    profit_by_day AS (
      SELECT sale_date::date AS day, SUM(profit) AS gross_profit
      FROM sales
      WHERE sale_status <> 'CANCELLED'
        AND sale_date BETWEEN $1 AND $2
      GROUP BY sale_date
    )
    SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS date, COALESCE(profit_by_day.gross_profit, 0) AS "grossProfit"
    FROM days
    LEFT JOIN profit_by_day ON profit_by_day.day = days.day
    ORDER BY days.day
    `,
    [dateFrom, dateTo]
  );
  return result.rows.map((row) => ({ date: row.date, grossProfit: Number(row.grossProfit || 0) }));
};

const getDashboardExpenseTrend = async (dateFrom, dateTo) => {
  const result = await pool.query(
    `
    WITH days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day
    ),
    expense_by_day AS (
      SELECT expense_date::date AS day, SUM(amount) AS expenses
      FROM expenses
      WHERE active IS DISTINCT FROM FALSE
        AND expense_date BETWEEN $1 AND $2
      GROUP BY expense_date
    )
    SELECT TO_CHAR(days.day, 'YYYY-MM-DD') AS date, COALESCE(expense_by_day.expenses, 0) AS expenses
    FROM days
    LEFT JOIN expense_by_day ON expense_by_day.day = days.day
    ORDER BY days.day
    `,
    [dateFrom, dateTo]
  );
  return result.rows.map((row) => ({ date: row.date, expenses: Number(row.expenses || 0) }));
};

const getDashboardPurchaseSalesComparison = async (dateFrom, dateTo) => {
  const result = await pool.query(
    `
    WITH days AS (
      SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day
    ),
    sales_by_day AS (
      SELECT sale_date::date AS day, SUM(total_amount) AS sales
      FROM sales
      WHERE sale_status <> 'CANCELLED'
        AND sale_date BETWEEN $1 AND $2
      GROUP BY sale_date
    ),
    purchases_by_day AS (
      SELECT purchase_date::date AS day, SUM(COALESCE(NULLIF(net_payable, 0), total_amount, 0)) AS purchases
      FROM purchases
      WHERE purchase_date BETWEEN $1 AND $2
        AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'
        AND COALESCE(purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
      GROUP BY purchase_date
    )
    SELECT
      TO_CHAR(days.day, 'YYYY-MM-DD') AS date,
      COALESCE(purchases_by_day.purchases, 0) AS purchases,
      COALESCE(sales_by_day.sales, 0) AS sales
    FROM days
    LEFT JOIN purchases_by_day ON purchases_by_day.day = days.day
    LEFT JOIN sales_by_day ON sales_by_day.day = days.day
    ORDER BY days.day
    `,
    [dateFrom, dateTo]
  );
  return result.rows.map((row) => ({
    date: row.date,
    purchases: Number(row.purchases || 0),
    sales: Number(row.sales || 0),
  }));
};

const getDashboardTopSellingProducts = async (dateFrom, dateTo) => {
  const result = await pool.query(
    `
    SELECT
      p.id AS product_id,
      p.product_name,
      p.unit,
      SUM(si.quantity) AS quantity_sold,
      SUM(COALESCE(si.net_amount, si.amount, 0)) AS revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    JOIN products p ON p.id = si.product_id
    WHERE s.sale_status <> 'CANCELLED'
      AND s.sale_date BETWEEN $1 AND $2
    GROUP BY p.id, p.product_name, p.unit
    ORDER BY quantity_sold DESC, revenue DESC, p.product_name
    LIMIT 8
    `,
    [dateFrom, dateTo]
  );
  return result.rows.map((row) => ({
    product_id: row.product_id,
    product_name: row.product_name,
    unit: row.unit,
    quantity_sold: Number(row.quantity_sold || 0),
    revenue: Number(row.revenue || 0),
  }));
};

const getDashboardLowStockItems = async () => {
  const result = await pool.query(
    `
    SELECT *
    FROM (
      SELECT
        p.id AS product_id,
        p.product_name,
        p.unit,
        COALESCE(p.minimum_stock, 5) AS minimum_stock,
        COALESCE(SUM(ib.remaining_qty), 0) AS current_stock
      FROM products p
      LEFT JOIN inventory_batches ib ON ib.product_id = p.id
        AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
      WHERE p.active IS DISTINCT FROM FALSE
      GROUP BY p.id, p.product_name, p.unit, p.minimum_stock
    ) stock
    WHERE stock.current_stock <= stock.minimum_stock
    ORDER BY (stock.current_stock - stock.minimum_stock), stock.product_name
    LIMIT 10
    `
  );
  return result.rows.map((row) => ({
    product_id: row.product_id,
    product_name: row.product_name,
    unit: row.unit,
    minimum_stock: Number(row.minimum_stock || 0),
    current_stock: Number(row.current_stock || 0),
  }));
};

const buildDashboardInsights = ({ summary, salesTrend, expenseTrend, topSellingProducts }) => {
  const insights = [];
  const lastSales = salesTrend.at(-1)?.sales || 0;
  const previousSales = salesTrend.at(-2)?.sales || 0;
  const salesDiff = roundCurrency(lastSales - previousSales);
  if (previousSales > 0) {
    const percentage = Math.round((salesDiff / previousSales) * 100);
    insights.push(`Sales ${salesDiff >= 0 ? "increased" : "decreased"} ${Math.abs(percentage)}% vs previous day.`);
  } else if (lastSales > 0) {
    insights.push(`Sales started at ${roundCurrency(lastSales).toLocaleString("en-IN")} INR for the latest day.`);
  } else {
    insights.push("No sales recorded for the selected period.");
  }

  const lastExpenses = expenseTrend.at(-1)?.expenses || 0;
  const previousExpenses = expenseTrend.at(-2)?.expenses || 0;
  const expenseDiff = roundCurrency(lastExpenses - previousExpenses);
  if (expenseDiff !== 0) {
    insights.push(`Expenses ${expenseDiff >= 0 ? "increased" : "reduced"} by ${roundCurrency(Math.abs(expenseDiff)).toLocaleString("en-IN")} INR vs previous day.`);
  } else {
    insights.push("Expenses are unchanged vs previous day.");
  }

  if (topSellingProducts.length) {
    insights.push(`Top selling product: ${topSellingProducts[0].product_name}.`);
  } else {
    insights.push("No top product yet because no items were sold in this period.");
  }

  insights.push(`Supplier outstanding is ${roundCurrency(summary.supplierOutstanding || 0).toLocaleString("en-IN")} INR.`);
  return insights;
};

const getDashboardAnalyticsPayload = async (query = {}) => {
  const range = parseDashboardRange(query);
  const [
    summary,
    salesTrend,
    profitTrend,
    expenseTrend,
    purchaseSalesComparison,
    topSellingProducts,
    lowStockItems,
  ] = await Promise.all([
    getDashboardSummary(),
    getDashboardSalesTrend(range.dateFrom, range.dateTo),
    getDashboardProfitTrend(range.dateFrom, range.dateTo),
    getDashboardExpenseTrend(range.dateFrom, range.dateTo),
    getDashboardPurchaseSalesComparison(range.dateFrom, range.dateTo),
    getDashboardTopSellingProducts(range.dateFrom, range.dateTo),
    getDashboardLowStockItems(),
  ]);
  const expensesByDate = new Map(expenseTrend.map((row) => [row.date, row.expenses]));
  const netProfitTrend = profitTrend.map((row) => {
    const expenses = Number(expensesByDate.get(row.date) || 0);
    return {
      date: row.date,
      grossProfit: row.grossProfit,
      expenses,
      netProfit: roundCurrency(Number(row.grossProfit || 0) - expenses),
    };
  });
  return {
    dateFrom: range.dateFrom,
    dateTo: range.dateTo,
    days: range.days,
    summary,
    salesTrend,
    profitTrend,
    expenseTrend,
    netProfitTrend,
    purchaseSalesComparison,
    topSellingProducts,
    lowStockItems,
    insights: buildDashboardInsights({ summary, salesTrend, expenseTrend, topSellingProducts }),
  };
};

const getSystemInfo = async (deviceId = "") => {
  const lanIp = getPrimaryLanIp();
  const [dbResult, backupResult, branchResult, deviceResult] = await Promise.all([
    pool.query("SELECT CURRENT_DATABASE() AS database_name, NOW() AS checked_at"),
    pool.query("SELECT * FROM backup_logs ORDER BY completed_at DESC NULLS LAST, id DESC LIMIT 1"),
    pool.query("SELECT * FROM branches WHERE active IS DISTINCT FROM FALSE ORDER BY id LIMIT 1"),
    deviceId
      ? pool.query("SELECT * FROM authorized_devices WHERE device_id = $1 LIMIT 1", [deviceId])
      : Promise.resolve({ rows: [] }),
  ]);
  return {
    softwareVersion: "1.0.5",
    backendStatus: "Online",
    databaseStatus: dbResult.rows[0]?.database_name ? "Connected" : "Unknown",
    databaseName: dbResult.rows[0]?.database_name || "",
    serverHost: host,
    serverPort: port,
    serverIp: lanIp,
    lanApiUrl: `http://${lanIp}:${port}`,
    lanFrontendUrl: `http://${lanIp}:5173`,
    currentDevice: deviceResult.rows[0] || null,
    currentBranch: branchResult.rows[0] || null,
    lastBackup: backupResult.rows[0] || null,
    backupLocation: backupDirectory,
  };
};

const getSettingsBundle = async (userId, deviceId = "") => {
  const [businessResult, saleRateResult, mandiResult, rebateResult, discountResult, roleResult, updateResult, syncResult, syncQueueResult, posResult, paymentResult, whatsappResult, manager] = await Promise.all([
    pool.query("SELECT * FROM business_settings WHERE id = 1"),
    pool.query("SELECT * FROM sale_rate_settings WHERE id = 1"),
    pool.query("SELECT * FROM mandi_tax_rules ORDER BY origin_type"),
    pool.query("SELECT * FROM rebate_rules ORDER BY pay_within_days, id"),
    pool.query("SELECT * FROM sale_discount_rules ORDER BY minimum_bill_amount, maximum_bill_amount NULLS LAST, id"),
    pool.query("SELECT * FROM role_permission_settings ORDER BY CASE role_name WHEN 'Owner' THEN 1 WHEN 'Admin' THEN 2 WHEN 'Cashier' THEN 3 WHEN 'Purchase Manager' THEN 4 WHEN 'Inventory Manager' THEN 5 ELSE 6 END"),
    pool.query("SELECT * FROM update_center WHERE id = 1"),
    pool.query("SELECT * FROM sync_settings WHERE id = 1"),
    pool.query("SELECT COUNT(*)::INTEGER AS pending_count FROM sync_queue WHERE sync_status = 'PENDING'"),
    pool.query("SELECT * FROM pos_settings WHERE id = 1"),
    pool.query("SELECT * FROM payment_settings WHERE id = 1"),
    pool.query("SELECT * FROM whatsapp_settings WHERE id = 1"),
    userId ? requireRateManager(userId) : Promise.resolve(null),
  ]);
  const usersResult = manager ? await pool.query(
    `
    SELECT
      u.id, u.full_name, u.username, u.mobile_number, u.email, u.active,
      u.joining_date, u.notes, u.last_login_at, u.created_at, u.updated_at,
      r.role_name AS role, b.branch_name AS branch
    FROM users u
    LEFT JOIN roles r ON r.id = u.role_id
    LEFT JOIN branches b ON b.id = u.branch_id
    ORDER BY u.active DESC, u.full_name
    `
  ) : { rows: [] };
  const [devicesResult, activationResult, branchesResult, countersResult, backupSettingsResult, backupLogsResult, systemInfo] = manager ? await Promise.all([
    pool.query(`
      SELECT d.*, b.branch_name, c.counter_name, u.full_name AS approved_by_name
      FROM authorized_devices d
      LEFT JOIN branches b ON b.id = d.assigned_branch_id
      LEFT JOIN counters c ON c.id = d.assigned_counter_id
      LEFT JOIN users u ON u.id = d.approved_by
      ORDER BY d.status = 'PENDING' DESC, d.updated_at DESC, d.id DESC
    `),
    pool.query(`
      SELECT ac.id, ac.code_label, ac.branch_id, ac.counter_id, b.branch_name, c.counter_name,
             ac.created_by, u.full_name AS created_by_name, ac.created_at, ac.expires_at,
             ac.used_by_device_id, ac.used_at, ac.status
      FROM activation_codes ac
      LEFT JOIN branches b ON b.id = ac.branch_id
      LEFT JOIN counters c ON c.id = ac.counter_id
      LEFT JOIN users u ON u.id = ac.created_by
      ORDER BY ac.created_at DESC, ac.id DESC
      LIMIT 50
    `),
    pool.query("SELECT * FROM branches ORDER BY active DESC, id"),
    pool.query("SELECT c.*, b.branch_name FROM counters c LEFT JOIN branches b ON b.id = c.branch_id ORDER BY c.active DESC, c.id"),
    pool.query("SELECT * FROM backup_settings WHERE id = 1"),
    pool.query("SELECT * FROM backup_logs ORDER BY started_at DESC, id DESC LIMIT 20"),
    getSystemInfo(deviceId),
  ]) : [
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    { rows: [] },
    await getSystemInfo(deviceId),
  ];
  const syncSettings = syncResult.rows[0] || {};
  const whatsappSettings = whatsappResult.rows[0] || {};
  return {
    businessSettings: businessResult.rows[0] || {},
    saleRateSettings: saleRateResult.rows[0] || {},
    posSettings: posResult.rows[0] || {},
    paymentSettings: paymentResult.rows[0] || {},
    whatsappSettings: {
      enabled: whatsappSettings.enabled === true,
      phone_number_id: whatsappSettings.phone_number_id || "",
      default_country_code: whatsappSettings.default_country_code || "91",
      access_token_configured: Boolean(whatsappSettings.access_token),
      access_token_masked: maskAccessToken(whatsappSettings.access_token),
      updated_at: whatsappSettings.updated_at || "",
    },
    mandiTaxRules: mandiResult.rows,
    rebateRules: rebateResult.rows,
    discountRules: discountResult.rows,
    roles: roleResult.rows,
    users: usersResult.rows,
    updateCenter: updateResult.rows[0] || {},
    syncSettings: {
      ...syncSettings,
      pending_count: Number(syncQueueResult.rows[0]?.pending_count || syncSettings.pending_count || 0),
    },
    authorizedDevices: devicesResult.rows,
    activationCodes: activationResult.rows,
    branches: branchesResult.rows,
    counters: countersResult.rows,
    backupSettings: backupSettingsResult.rows[0] || {},
    backupLogs: backupLogsResult.rows,
    systemInfo,
    canManageSettings: Boolean(manager),
  };
};

const createDatabaseBackup = async ({ backupType = "Manual", createdBy = null } = {}) => {
  await ensureDirectory(backupDirectory);
  const startedAt = new Date();
  const timestamp = formatBackupTimestamp(startedAt);
  const baseName = `FroozERP_Backup_${timestamp}`;
  const workDir = path.join(backupDirectory, baseName);
  const jsonPath = path.join(workDir, `${baseName}.json`);
  const zipPath = path.join(backupDirectory, `${baseName}.zip`);
  const logResult = await pool.query(
    `
    INSERT INTO backup_logs (backup_file_name, backup_path, backup_type, started_at, status, created_by)
    VALUES ($1, $2, $3, $4, 'RUNNING', $5)
    RETURNING id
    `,
    [`${baseName}.zip`, zipPath, backupType, startedAt, createdBy]
  );
  const logId = logResult.rows[0].id;
  try {
    await ensureDirectory(workDir);
    const tablesResult = await pool.query(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
      `
    );
    const tables = {};
    for (const row of tablesResult.rows) {
      const tableName = row.table_name;
      const dataResult = await pool.query(`SELECT * FROM "${tableName}"`);
      tables[tableName] = dataResult.rows;
    }
    const payload = {
      generated_at: startedAt.toISOString(),
      backup_type: backupType,
      database: process.env.DB_NAME || "froozerp",
      tables,
    };
    await fs.promises.writeFile(jsonPath, JSON.stringify(payload, null, 2), "utf8");
    let finalPath = zipPath;
    let finalFileName = `${baseName}.zip`;
    try {
      const powershellPath = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : "powershell.exe";
      await execFileAsync(powershellPath, [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Compress-Archive -LiteralPath '${escapePowerShellSingleQuoted(jsonPath)}' -DestinationPath '${escapePowerShellSingleQuoted(zipPath)}' -Force`,
      ], { windowsHide: true });
      await fs.promises.rm(workDir, { recursive: true, force: true });
    } catch (zipError) {
      finalPath = jsonPath;
      finalFileName = `${baseName}.json`;
    }
    const stat = await fs.promises.stat(finalPath);
    const completedAt = new Date();
    await pool.query(
      `
      UPDATE backup_logs
      SET backup_file_name = $1,
          backup_path = $2,
          backup_size = $3,
          completed_at = $4,
          status = 'SUCCESS',
          error_message = NULL
      WHERE id = $5
      `,
      [finalFileName, finalPath, stat.size, completedAt, logId]
    );
    await cleanupOldBackups();
    return {
      id: logId,
      backup_file_name: finalFileName,
      backup_path: finalPath,
      backup_size: stat.size,
      backup_type: backupType,
      started_at: startedAt,
      completed_at: completedAt,
      status: "SUCCESS",
    };
  } catch (error) {
    await pool.query(
      `
      UPDATE backup_logs
      SET completed_at = CURRENT_TIMESTAMP,
          status = 'FAILED',
          error_message = $1
      WHERE id = $2
      `,
      [error.message || String(error), logId]
    );
    throw error;
  }
};

const cleanupOldBackups = async () => {
  const settingsResult = await pool.query("SELECT keep_last_backups FROM backup_settings WHERE id = 1");
  const keep = Math.max(Number(settingsResult.rows[0]?.keep_last_backups || 30), 1);
  const oldLogs = await pool.query(
    `
    SELECT id, backup_path
    FROM backup_logs
    WHERE status = 'SUCCESS'
    ORDER BY completed_at DESC NULLS LAST, id DESC
    OFFSET $1
    `,
    [keep]
  );
  for (const row of oldLogs.rows) {
    if (row.backup_path && String(row.backup_path).startsWith(backupDirectory)) {
      await fs.promises.rm(row.backup_path, { force: true }).catch(() => {});
    }
  }
};

const readDiscountRulePayload = (body) => {
  const minimumBillAmount = parseNonNegativeNumber(body.minimum_bill_amount);
  const maximumBillAmount = body.maximum_bill_amount === "" || body.maximum_bill_amount === null || body.maximum_bill_amount === undefined
    ? null
    : parseNonNegativeNumber(body.maximum_bill_amount);
  const discountType = normalizeDiscountType(body.discount_type);
  const paymentMode = normalizeDiscountPaymentMode(body.payment_mode);
  return {
    rule_name: cleanText(body.rule_name),
    minimum_bill_amount: minimumBillAmount,
    maximum_bill_amount: maximumBillAmount,
    discount_type: discountType,
    discount_value: parseNonNegativeNumber(body.discount_value),
    payment_mode: paymentMode,
    active: body.active !== false,
  };
};

const hasInvalidDiscountMaximum = (body, rule) =>
  rule.maximum_bill_amount === null &&
  body.maximum_bill_amount !== "" &&
  body.maximum_bill_amount !== null &&
  body.maximum_bill_amount !== undefined;

const calculateInvoiceDiscount = (rule, subtotal) => {
  if (!rule) return 0;
  const value = Number(rule.discount_value || 0);
  const amount = rule.discount_type === "PERCENTAGE"
    ? roundCurrency(subtotal * value / 100)
    : roundCurrency(value);
  return Math.min(amount, subtotal);
};

const getMatchingDiscountRule = async (client, subtotal, paymentMode) => {
  const settingsResult = await client.query("SELECT bill_level_slab_discount_enabled FROM sale_rate_settings WHERE id = 1");
  if (settingsResult.rows[0]?.bill_level_slab_discount_enabled === false) return null;
  const result = await client.query(
    `
    SELECT *
    FROM sale_discount_rules
    WHERE active = TRUE
      AND minimum_bill_amount <= $1
      AND (maximum_bill_amount IS NULL OR maximum_bill_amount >= $1)
      AND (payment_mode = 'ALL' OR payment_mode = $2)
    ORDER BY
      CASE WHEN payment_mode = $2 THEN 0 ELSE 1 END,
      minimum_bill_amount DESC,
      discount_value DESC,
      id DESC
    LIMIT 1
    `,
    [subtotal, paymentMode]
  );
  return result.rows[0] || null;
};

const SALES_MANDI_TAX_BASIS = new Set([
  "GROSS_BEFORE_DISCOUNTS",
  "AFTER_ITEM_DISCOUNT",
  "NET_AFTER_ALL_DISCOUNTS",
]);

const getSalesMandiTaxConfig = async (client) => {
  const result = await client.query(
    `SELECT enable_sales_mandi_tax, sales_mandi_tax_percent, sales_mandi_tax_basis, sales_mandi_tax_effective_date,
            sales_mandi_tax_customer_scope, sales_mandi_tax_product_scope, sales_mandi_tax_disable_reason
     FROM payment_settings
     WHERE id = 1`
  );
  const settings = result.rows[0] || {};
  const basis = String(settings.sales_mandi_tax_basis || "NET_AFTER_ALL_DISCOUNTS").toUpperCase();
  const customerScope = String(settings.sales_mandi_tax_customer_scope || "REGISTERED_CUSTOMERS").toUpperCase();
  const productScope = String(settings.sales_mandi_tax_product_scope || "ALL_PRODUCTS").toUpperCase();
  return {
    enabled: settings.enable_sales_mandi_tax === true,
    rate: Number(settings.sales_mandi_tax_percent || 0),
    basis: SALES_MANDI_TAX_BASIS.has(basis) ? basis : "NET_AFTER_ALL_DISCOUNTS",
    effectiveDate: settings.sales_mandi_tax_effective_date || null,
    customerScope: ["REGISTERED_CUSTOMERS", "ALL_CUSTOMERS", "NONE"].includes(customerScope) ? customerScope : "REGISTERED_CUSTOMERS",
    productScope: ["ALL_PRODUCTS", "FRUIT_PRODUCTS", "CATEGORY_CONFIGURED"].includes(productScope) ? productScope : "ALL_PRODUCTS",
    disableReason: settings.sales_mandi_tax_disable_reason || null,
  };
};

const calculateSalesMandiTax = ({ grossAmount, itemDiscountAmount, invoiceDiscountAmount, customerAccount, config }) => {
  const customerEligible = config?.customerScope === "ALL_CUSTOMERS" || (config?.customerScope === "REGISTERED_CUSTOMERS" && customerAccount && customerAccount.system_account !== true);
  const eligible = config?.customerScope !== "NONE" && config?.enabled === true && customerEligible && Number(config.rate || 0) > 0;
  if (!eligible) {
    return {
      taxableAmount: 0,
      taxAmount: 0,
      taxRate: 0,
      taxBasis: config?.basis || "NET_AFTER_ALL_DISCOUNTS",
      taxEffectiveDate: config?.effectiveDate || null,
      taxConfigSnapshot: null,
    };
  }
  const gross = roundCurrency(grossAmount);
  const afterItem = roundCurrency(grossAmount - itemDiscountAmount);
  const afterAllDiscounts = roundCurrency(grossAmount - itemDiscountAmount - invoiceDiscountAmount);
  const taxableAmount = roundCurrency(Math.max(
    config.basis === "GROSS_BEFORE_DISCOUNTS"
      ? gross
      : config.basis === "AFTER_ITEM_DISCOUNT"
        ? afterItem
        : afterAllDiscounts,
    0
  ));
  const taxRate = Number(config.rate || 0);
  const taxAmount = roundCurrency(taxableAmount * taxRate / 100);
  return {
    taxableAmount,
    taxAmount,
    taxRate,
    taxBasis: config.basis,
    taxEffectiveDate: config.effectiveDate,
    taxConfigSnapshot: {
      tax_type: "MANDI_TAX",
      tax_rate: taxRate,
      taxable_basis: config.basis,
      taxable_amount: taxableAmount,
      tax_amount: taxAmount,
      effective_date: config.effectiveDate,
      customer_scope: config.customerScope,
      product_scope: config.productScope,
      source: "payment_settings",
    },
  };
};

const insertSalePaymentAllocation = async (client, { saleId, payment, userId, branchId, deviceId }) => {
  await client.query(
    `
    INSERT INTO sale_payments (
      sale_id, payment_mode, amount, reference_number, payment_time,
      user_id, branch_id, device_id, status
    )
    VALUES ($1, $2, $3, $4, COALESCE($5::timestamp, CURRENT_TIMESTAMP), $6, $7, $8, 'POSTED')
    `,
    [
      saleId,
      payment.mode,
      payment.amount,
      nullableText(payment.reference_number || payment.reference || payment.transaction_reference),
      payment.payment_time || payment.paid_at || null,
      userId || null,
      branchId || null,
      cleanText(deviceId || payment.device_id),
    ]
  );
};

const getSalePermissionUser = async (userId, action, client = pool) => {
  const parsedUserId = parsePositiveInteger(userId);
  if (!parsedUserId || !["edit", "cancel"].includes(action)) return null;
  const result = await client.query(
    `
    SELECT
      u.id,
      u.full_name,
      r.role_name,
      COALESCE(sp.can_edit_sales, r.role_name = 'Owner') AS can_edit_sales,
      COALESCE(sp.can_cancel_sales, r.role_name = 'Owner') AS can_cancel_sales
    FROM users u
    JOIN roles r ON r.id = u.role_id
    LEFT JOIN sale_permission_settings sp ON sp.role_name = r.role_name
    WHERE u.id = $1 AND u.active = TRUE
    `,
    [parsedUserId]
  );
  const user = result.rows[0];
  if (!user) return null;
  if (user.role_name === "Owner") return user;
  if (action === "edit" && user.can_edit_sales) return user;
  if (action === "cancel" && user.can_cancel_sales) return user;
  return null;
};

const getSaleSnapshot = async (client, saleId) => {
  const saleResult = await client.query("SELECT * FROM sales WHERE id = $1", [saleId]);
  const itemsResult = await client.query("SELECT * FROM sale_items WHERE sale_id = $1 ORDER BY id", [saleId]);
  const paymentsResult = await client.query("SELECT * FROM sale_payments WHERE sale_id = $1 ORDER BY id", [saleId]);
  const allocationsResult = await client.query(
    `
    SELECT sba.*, si.product_id
    FROM sale_batch_allocations sba
    JOIN sale_items si ON si.id = sba.sale_item_id
    WHERE si.sale_id = $1
    ORDER BY sba.id
    `,
    [saleId]
  );
  return {
    sale: saleResult.rows[0] || null,
    items: itemsResult.rows,
    payments: paymentsResult.rows,
    allocations: allocationsResult.rows,
  };
};

const restoreSaleInventory = async (client, saleId, userId, reason, transactionType = "IN") => {
  const allocationsResult = await client.query(
    `
    SELECT sba.inventory_batch_id, sba.quantity, si.product_id, s.invoice_no, s.branch_id
    FROM sale_batch_allocations sba
    JOIN sale_items si ON si.id = sba.sale_item_id
    JOIN sales s ON s.id = si.sale_id
    WHERE si.sale_id = $1
    ORDER BY sba.id
    FOR UPDATE
    `,
    [saleId]
  );
  for (const allocation of allocationsResult.rows) {
    await client.query(
      "UPDATE inventory_batches SET remaining_qty = remaining_qty + $1 WHERE id = $2",
      [allocation.quantity, allocation.inventory_batch_id]
    );
    await client.query(
      `
      INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        allocation.product_id,
        allocation.quantity,
        transactionType,
        `${reason} ${allocation.invoice_no || `#${saleId}`}`,
        userId,
        allocation.branch_id,
      ]
    );
  }
};

const insertCustomerLedgerEntry = async (client, sale, transactionType, amount, userId, remarks) => {
  const ledgerAmount = roundCurrency(Math.abs(Number(amount || 0)));
  if (!ledgerAmount && !sale.customer_mobile && !sale.customer_name) return;
  const isCredit = ["SALE_EDIT_CREDIT", "SALE_CANCELLED"].includes(transactionType);
  await client.query(
    `
    INSERT INTO customer_ledger (
      sale_id, customer_id, customer_name, customer_mobile, transaction_type,
      debit_amount, credit_amount, balance_delta, remarks, created_by, transaction_date
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    `,
    [
      sale.id,
      sale.customer_id || null,
      sale.customer_name || null,
      sale.customer_mobile || null,
      transactionType,
      isCredit ? 0 : ledgerAmount,
      isCredit ? ledgerAmount : 0,
      isCredit ? -ledgerAmount : ledgerAmount,
      remarks,
      userId,
      sale.sale_date || sale.transaction_date || toDateKey(new Date()),
    ]
  );
};

const buildSalePayload = async (client, { items, branchId, createdBy, customer, invoiceDiscount, payments, allowRateOverride }) => {
  const parsedItems = (Array.isArray(items) ? items : []).map((item) => ({
    saleItemId: parsePositiveInteger(item.id || item.sale_item_id),
    productId: parsePositiveInteger(item.product_id),
    inventoryBatchId: parsePositiveInteger(item.inventory_batch_id),
    quantity: parsePositiveNumber(item.quantity),
    discountAmount: parseNonNegativeNumber(item.discount_amount),
    requestedRate: parsePositiveNumber(item.selling_rate),
    lotDiscountId: parsePositiveInteger(item.lot_discount_id),
    lotDiscountType: item.lot_discount_type ? String(item.lot_discount_type).trim().toUpperCase() : null,
    lotDiscountValue: parseNonNegativeNumber(item.lot_discount_value),
  }));
  const selectedCustomerId = parsePositiveInteger(customer?.account_id || customer?.customer_id);
  const customerMobile = customer?.mobile?.trim() || null;
  const customerNotes = customer?.notes?.trim() || null;

  if (
    !branchId ||
    parsedItems.length === 0 ||
    parsedItems.some((item) => !item.productId || !item.quantity || item.discountAmount === null)
  ) {
    return { error: { status: 400, message: "Add valid products and quantities before checkout" } };
  }
  const itemKeys = parsedItems.map((item) => `${item.productId}-${item.inventoryBatchId || "FIFO"}`);
  if (new Set(itemKeys).size !== itemKeys.length) {
    return { error: { status: 400, message: "Combine duplicate product lots into one cart item" } };
  }
  if (customerMobile && !/^\d{10,15}$/.test(customerMobile)) {
    return { error: { status: 400, message: "Enter a valid customer mobile number" } };
  }

  let customerAccount;
  if (selectedCustomerId) {
    const customerResult = await client.query("SELECT * FROM customers WHERE id = $1 AND active = TRUE FOR SHARE", [selectedCustomerId]);
    if (customerResult.rows.length === 0) {
      return { error: { status: 400, message: "Selected customer account is not active" } };
    }
    customerAccount = customerResult.rows[0];
  } else {
    customerAccount = await getWalkInCustomer(client);
    if (!customerAccount) {
      return { error: { status: 500, message: "Walk-in Customer account is not configured" } };
    }
  }
  const customerId = customerAccount.id;
  const customerName = customerAccount.customer_name || "Walk-in Customer";

  const productIds = [...new Set(parsedItems.map((item) => item.productId))];
  const productResult = await client.query(
    "SELECT id, product_name, selling_rate, unit FROM products WHERE id = ANY($1::int[]) AND active = TRUE ORDER BY id FOR SHARE",
    [productIds]
  );
  if (productResult.rows.length !== productIds.length) {
    return { error: { status: 404, message: "One or more products could not be found" } };
  }

  const productsById = new Map(productResult.rows.map((product) => [product.id, product]));
  const invoiceItems = [];
  let grossAmount = 0;
  let itemDiscountAmount = 0;
  let totalCost = 0;
  for (const requestedItem of parsedItems) {
    const product = productsById.get(requestedItem.productId);
    const batchParams = [requestedItem.productId, branchId];
    let batchFilter = "";
    if (requestedItem.inventoryBatchId) {
      batchParams.push(requestedItem.inventoryBatchId);
      batchFilter = `AND id = $${batchParams.length}`;
    }
    const batchesResult = await client.query(
      `
      SELECT
        id,
        remaining_qty,
        COALESCE(effective_cost_per_unit, purchase_rate) AS purchase_rate,
        COALESCE(purchase_bill_status, 'BILL_COMPLETED') AS purchase_bill_status,
        COALESCE(temporary_sale_rate, 0) AS temporary_sale_rate,
        lot_name,
        lot_size
      FROM inventory_batches
      WHERE product_id = $1
        AND branch_id = $2
        ${batchFilter}
        AND remaining_qty > 0
        AND COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED'
      ORDER BY purchase_date, created_at, id
      FOR UPDATE
      `,
      batchParams
    );
    const availableStock = batchesResult.rows.reduce((total, batch) => total + Number(batch.remaining_qty), 0);
    if (availableStock < requestedItem.quantity) {
      return {
        error: {
          status: 409,
          message: requestedItem.inventoryBatchId ? "Selected lot does not have enough stock." : `Insufficient stock for ${product.product_name}. Available quantity: ${availableStock}`,
          product_id: requestedItem.productId,
          available_stock: availableStock,
        },
      };
    }

    const defaultSellingRate = Number(
      requestedItem.inventoryBatchId && Number(batchesResult.rows[0]?.temporary_sale_rate || 0) > 0
        ? batchesResult.rows[0].temporary_sale_rate
        : product.selling_rate
    );
    const hasRequestedRate = requestedItem.requestedRate !== null && requestedItem.requestedRate !== undefined;
    const sellingRate = hasRequestedRate ? Number(requestedItem.requestedRate) : defaultSellingRate;
    const manualRateOverride = hasRequestedRate && roundCurrency(sellingRate) !== roundCurrency(defaultSellingRate);
    if (!Number.isFinite(sellingRate) || sellingRate <= 0) {
      return { error: { status: 400, message: `${product.product_name} does not have a valid selling rate` } };
    }
    if (manualRateOverride && !allowRateOverride) {
      return { error: { status: 403, message: "You do not have permission to change sale rate" } };
    }

    const itemGross = roundCurrency(requestedItem.quantity * sellingRate);
    if (requestedItem.discountAmount > itemGross) {
      return { error: { status: 400, message: `Discount cannot exceed the value of ${product.product_name}` } };
    }

    let quantityToDeduct = requestedItem.quantity;
    let itemCost = 0;
    const allocations = [];
    for (const batch of batchesResult.rows) {
      if (quantityToDeduct <= 0) break;
      const deductedQuantity = Math.min(quantityToDeduct, Number(batch.remaining_qty));
      const costAmount = roundCurrency(deductedQuantity * Number(batch.purchase_rate));
      await client.query("UPDATE inventory_batches SET remaining_qty = remaining_qty - $1 WHERE id = $2", [deductedQuantity, batch.id]);
      allocations.push({
        inventoryBatchId: batch.id,
        quantity: deductedQuantity,
        purchaseRate: Number(batch.purchase_rate),
        costAmount,
        costStatus: batch.purchase_bill_status === "BILL_PENDING" ? "PROVISIONAL" : "FINAL",
        lotName: batch.lot_name,
        lotSize: batch.lot_size,
      });
      quantityToDeduct -= deductedQuantity;
      itemCost += costAmount;
    }

    invoiceItems.push({
      ...requestedItem,
      product,
      sellingRate,
      defaultSellingRate,
      manualRateOverride,
      grossAmount: itemGross,
      netAmount: roundCurrency(itemGross - requestedItem.discountAmount),
      costAmount: roundCurrency(itemCost),
      costStatus: allocations.some((allocation) => allocation.costStatus === "PROVISIONAL") ? "PROVISIONAL" : "FINAL",
      inventoryBatchId: requestedItem.inventoryBatchId || allocations[0]?.inventoryBatchId || null,
      lotName: allocations[0]?.lotName || null,
      lotSize: allocations[0]?.lotSize || null,
      allocations,
    });
    grossAmount += itemGross;
    itemDiscountAmount += requestedItem.discountAmount;
    totalCost += itemCost;
  }

  grossAmount = roundCurrency(grossAmount);
  itemDiscountAmount = roundCurrency(itemDiscountAmount);
  totalCost = roundCurrency(totalCost);
  const subtotalAfterItemDiscounts = roundCurrency(grossAmount - itemDiscountAmount);
  const requestedPaymentsInput = Array.isArray(payments) && payments.length > 0 ? payments : null;
  const allowedPaymentModes = new Set(["CASH", "UPI", "CARD", "BANK_TRANSFER", "CREDIT"]);
  const paymentModes = requestedPaymentsInput
    ? requestedPaymentsInput.map((payment) => String(payment.mode || "").toUpperCase())
    : ["CASH"];
  if (paymentModes.some((mode) => !allowedPaymentModes.has(mode))) {
    return { error: { status: 400, message: "Select a valid payment mode" } };
  }
  const paymentMode = paymentModes.length > 1 ? "MIXED" : paymentModes[0];
  const discountRule = await getMatchingDiscountRule(client, grossAmount, paymentMode);
  const parsedInvoiceDiscount = parseNonNegativeNumber(invoiceDiscount);
  if (parsedInvoiceDiscount === null) return { error: { status: 400, message: "Enter a valid invoice discount" } };
  const invoiceDiscountAmount = discountRule
    ? Math.min(calculateInvoiceDiscount(discountRule, grossAmount), subtotalAfterItemDiscounts)
    : parsedInvoiceDiscount;
  if (invoiceDiscountAmount > subtotalAfterItemDiscounts) {
    return { error: { status: 400, message: "Invoice discount cannot exceed the cart subtotal" } };
  }

  const salesMandiTaxConfig = await getSalesMandiTaxConfig(client);
  const salesMandiTax = calculateSalesMandiTax({
    grossAmount,
    itemDiscountAmount,
    invoiceDiscountAmount,
    customerAccount,
    config: salesMandiTaxConfig,
  });
  const taxAmount = salesMandiTax.taxAmount;
  const totalAmount = roundCurrency(subtotalAfterItemDiscounts - invoiceDiscountAmount + taxAmount);
  const profit = roundCurrency(totalAmount - totalCost);
  const requestedPayments = requestedPaymentsInput || [{ mode: "CASH", amount: totalAmount }];
  const parsedPayments = requestedPayments.map((payment) => ({
    mode: String(payment.mode || "").toUpperCase(),
    amount: parsePositiveNumber(payment.amount),
    reference_number: nullableText(payment.reference_number || payment.reference || payment.transaction_reference),
    payment_time: payment.payment_time || payment.paid_at || null,
    device_id: cleanText(payment.device_id),
  }));
  const paidAmount = roundCurrency(parsedPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
  if (
    parsedPayments.some((payment) => !allowedPaymentModes.has(payment.mode) || !payment.amount) ||
    Math.abs(paidAmount - totalAmount) > 0.01
  ) {
    return { error: { status: 400, message: "Payment amounts must match the invoice total" } };
  }

  return {
    invoiceItems,
    payments: parsedPayments,
    customerId,
    customerName,
    customerMobile,
    customerNotes,
    paymentMode,
    grossAmount,
    itemDiscountAmount,
    invoiceDiscountAmount,
    taxAmount,
    taxableAmount: salesMandiTax.taxableAmount,
    mandiTaxRate: salesMandiTax.taxRate,
    mandiTaxBasis: salesMandiTax.taxBasis,
    mandiTaxEffectiveDate: salesMandiTax.taxEffectiveDate,
    taxConfigSnapshot: salesMandiTax.taxConfigSnapshot,
    totalAmount,
    totalCost,
    profit,
    discountRule,
    createdBy,
    branchId,
  };
};

app.get("/purchase-rules", async (req, res) => {
  try {
    const [mandiResult, rebateResult] = await Promise.all([
      pool.query("SELECT * FROM mandi_tax_rules WHERE active = TRUE ORDER BY origin_type"),
      pool.query("SELECT * FROM rebate_rules WHERE active = TRUE ORDER BY pay_within_days, id"),
    ]);
    return res.json({ mandiTaxRules: mandiResult.rows, rebateRules: rebateResult.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Purchase Rules" });
  }
});

app.get("/settings/purchase-rules", async (req, res) => {
  try {
    const [mandiResult, rebateResult] = await Promise.all([
      pool.query("SELECT * FROM mandi_tax_rules ORDER BY origin_type"),
      pool.query("SELECT * FROM rebate_rules ORDER BY pay_within_days, id"),
    ]);
    return res.json({ mandiTaxRules: mandiResult.rows, rebateRules: rebateResult.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Settings" });
  }
});

app.get("/settings", async (req, res) => {
  try {
    return res.json(await getSettingsBundle(req.query.user_id, req.query.device_id));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Settings" });
  }
});

app.get("/settings/role-permissions", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM role_permission_settings ORDER BY role_name");
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Role Permissions" });
  }
});

app.put("/settings/role-permissions/:roleName", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage role permissions" });
    const roleName = cleanText(req.params.roleName);
    const permissions = req.body.permissions && typeof req.body.permissions === "object" ? req.body.permissions : {};
    const normalized = PERMISSION_KEYS.reduce((payload, key) => ({ ...payload, [key]: Boolean(permissions[key]) }), {});
    const result = await pool.query(
      `
      INSERT INTO role_permission_settings (role_name, permissions, updated_by, updated_at)
      VALUES ($1, $2::jsonb, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (role_name)
      DO UPDATE SET permissions = EXCLUDED.permissions, updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP
      RETURNING *
      `,
      [roleName, JSON.stringify(normalized), manager.id]
    );
    await pool.query(
      `
      INSERT INTO sale_permission_settings (role_name, can_edit_sales, can_cancel_sales, updated_at)
      VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (role_name)
      DO UPDATE SET can_edit_sales = EXCLUDED.can_edit_sales, can_cancel_sales = EXCLUDED.can_cancel_sales, updated_at = CURRENT_TIMESTAMP
      `,
      [roleName, Boolean(normalized.sale_edit), Boolean(normalized.invoice_cancellation)]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Role Permissions" });
  }
});

app.get("/settings/update-center", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM update_center WHERE id = 1");
    return res.json(result.rows[0] || {});
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Update Center" });
  }
});

app.put("/settings/update-center", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage update settings" });
    const result = await pool.query(
      `
      UPDATE update_center
      SET current_version = $1, release_date = $2, changelog = $3, update_status = $4, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [
        cleanText(req.body.current_version) || "1.0.0",
        req.body.release_date || toDateKey(new Date()),
        cleanText(req.body.changelog) || "Future update channel prepared.",
        cleanText(req.body.update_status) || "READY_FOR_FUTURE_UPDATES",
      ]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Update Center" });
  }
});

app.get("/settings/sync-status", async (req, res) => {
  try {
    const [settingsResult, queueResult] = await Promise.all([
      pool.query("SELECT * FROM sync_settings WHERE id = 1"),
      pool.query("SELECT sync_status, COUNT(*)::INTEGER AS count FROM sync_queue GROUP BY sync_status"),
    ]);
    const pending = queueResult.rows.find((row) => row.sync_status === "PENDING")?.count || 0;
    return res.json({
      ...(settingsResult.rows[0] || {}),
      pending_count: Number(pending),
      queue: queueResult.rows,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sync Status" });
  }
});

app.put("/settings/sync-status", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage sync settings" });
    const result = await pool.query(
      `
      UPDATE sync_settings
      SET device_display_name = $1, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [cleanText(req.body.device_display_name) || "Main Counter Device"]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Sync Settings" });
  }
});

app.put("/settings/pos", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage POS settings" });
    const connectionType = cleanText(req.body.scale_connection_type).toUpperCase();
    const allowedConnections = new Set(["USB", "SERIAL", "BLUETOOTH", "MANUAL_FALLBACK"]);
    const baudRate = parsePositiveInteger(req.body.scale_baud_rate) || 9600;
    const result = await pool.query(
      `
      UPDATE pos_settings
      SET enable_weighing_scale = $1,
          scale_connection_type = $2,
          scale_com_port = $3,
          scale_baud_rate = $4,
          scale_auto_read = $5,
          updated_by = $6,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [
        req.body.enable_weighing_scale === true,
        allowedConnections.has(connectionType) ? connectionType : "MANUAL_FALLBACK",
        nullableText(req.body.scale_com_port),
        baudRate,
        req.body.scale_auto_read === true,
        manager.id,
      ]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating POS Settings" });
  }
});

app.put("/settings/payment", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage payment settings" });
    const salesMandiTaxPercent = parseNonNegativeNumber(req.body.sales_mandi_tax_percent);
    const salesMandiTaxBasis = cleanText(req.body.sales_mandi_tax_basis).toUpperCase() || "NET_AFTER_ALL_DISCOUNTS";
    const salesMandiTaxCustomerScope = ["REGISTERED_CUSTOMERS", "ALL_CUSTOMERS", "NONE"].includes(cleanText(req.body.sales_mandi_tax_customer_scope).toUpperCase())
      ? cleanText(req.body.sales_mandi_tax_customer_scope).toUpperCase()
      : "REGISTERED_CUSTOMERS";
    const salesMandiTaxProductScope = ["ALL_PRODUCTS", "FRUIT_PRODUCTS", "CATEGORY_CONFIGURED"].includes(cleanText(req.body.sales_mandi_tax_product_scope).toUpperCase())
      ? cleanText(req.body.sales_mandi_tax_product_scope).toUpperCase()
      : "ALL_PRODUCTS";
    if (salesMandiTaxPercent === null || !SALES_MANDI_TAX_BASIS.has(salesMandiTaxBasis)) {
      return res.status(400).json({ message: "Enter valid sales Mandi Tax settings" });
    }
    const result = await pool.query(
      `
      UPDATE payment_settings
      SET business_upi_id = $1,
          upi_payee_name = $2,
          enable_upi_qr_on_invoice = $3,
          show_upi_qr_on_all_bills = $4,
          qr_display_size = $5,
          enable_sales_mandi_tax = $6,
          sales_mandi_tax_percent = $7,
          sales_mandi_tax_basis = $8,
          sales_mandi_tax_effective_date = $9,
          sales_mandi_tax_customer_scope = $10,
          sales_mandi_tax_product_scope = $11,
          sales_mandi_tax_disable_reason = $12,
          updated_by = $13,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [
        nullableText(req.body.business_upi_id),
        nullableText(req.body.upi_payee_name),
        req.body.enable_upi_qr_on_invoice === true,
        req.body.show_upi_qr_on_all_bills === true,
        ["SMALL", "MEDIUM", "LARGE"].includes(cleanText(req.body.qr_display_size).toUpperCase()) ? cleanText(req.body.qr_display_size).toUpperCase() : "MEDIUM",
        req.body.enable_sales_mandi_tax === true,
        salesMandiTaxPercent,
        salesMandiTaxBasis,
        isDateInput(req.body.sales_mandi_tax_effective_date) ? req.body.sales_mandi_tax_effective_date : null,
        salesMandiTaxCustomerScope,
        salesMandiTaxProductScope,
        nullableText(req.body.sales_mandi_tax_disable_reason),
        manager.id,
      ]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Payment Settings" });
  }
});

app.put("/settings/whatsapp", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage WhatsApp settings" });
    const existing = await pool.query("SELECT * FROM whatsapp_settings WHERE id = 1");
    const existingToken = existing.rows[0]?.access_token || "";
    const suppliedToken = cleanText(req.body.access_token);
    const tokenToStore = suppliedToken && !suppliedToken.includes("...") ? suppliedToken : existingToken;
    const countryCode = cleanText(req.body.default_country_code).replace(/\D/g, "") || "91";
    const result = await pool.query(
      `
      UPDATE whatsapp_settings
      SET enabled = $1,
          phone_number_id = $2,
          access_token = $3,
          default_country_code = $4,
          updated_by = $5,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [
        req.body.enabled === true,
        nullableText(req.body.phone_number_id),
        tokenToStore || null,
        countryCode,
        manager.id,
      ]
    );
    const row = result.rows[0] || {};
    return res.json({
      enabled: row.enabled === true,
      phone_number_id: row.phone_number_id || "",
      default_country_code: row.default_country_code || "91",
      access_token_configured: Boolean(row.access_token),
      access_token_masked: maskAccessToken(row.access_token),
      updated_at: row.updated_at || "",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating WhatsApp Settings" });
  }
});

app.post("/settings/whatsapp/test", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can test WhatsApp settings" });
    const settingsResult = await pool.query("SELECT * FROM whatsapp_settings WHERE id = 1");
    const settings = settingsResult.rows[0] || {};
    if (settings.enabled !== true || !settings.phone_number_id || !settings.access_token) {
      return res.status(400).json({ message: "WhatsApp API is not configured." });
    }
    const response = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(settings.phone_number_id)}?fields=display_phone_number,verified_name`, {
      headers: { Authorization: `Bearer ${settings.access_token}` },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({ message: payload?.error?.message || "WhatsApp test connection failed" });
    }
    return res.json({ success: true, phone: payload.display_phone_number || "", name: payload.verified_name || "" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Unable to test WhatsApp connection" });
  }
});

const insertWhatsappLog = async ({ sourceType, sourceId, accountId, accountType, phoneNumber, documentName, status, errorMessage, sentByUserId }, client = pool) => {
  await client.query(
    `
    INSERT INTO whatsapp_send_logs (
      source_type, source_id, account_id, account_type, phone_number, document_name,
      status, error_message, sent_by_user_id
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      cleanText(sourceType) || "report",
      cleanText(sourceId) || null,
      parsePositiveInteger(accountId),
      cleanText(accountType) || null,
      cleanText(phoneNumber),
      cleanText(documentName) || "FroozERP_Document.pdf",
      cleanText(status) || "failed",
      cleanText(errorMessage) || null,
      parsePositiveInteger(sentByUserId),
    ]
  );
};

app.post("/api/whatsapp/send-document", async (req, res) => {
  const {
    phoneNumbers = [],
    pdfBase64,
    pdfFile,
    caption = "",
    documentName = "FroozERP_Document.pdf",
    sourceType = "report",
    sourceId = "",
    sentByUserId,
  } = req.body || {};
  try {
    const settingsResult = await pool.query("SELECT * FROM whatsapp_settings WHERE id = 1");
    const settings = settingsResult.rows[0] || {};
    const recipients = (Array.isArray(phoneNumbers) ? phoneNumbers : [])
      .map((entry) => {
        const rawNumber = typeof entry === "string" ? entry : entry.phoneNumber || entry.phone_number || "";
        const phoneNumber = normalizeWhatsappPhone(rawNumber, settings.default_country_code || "91");
        return {
          originalNumber: rawNumber,
          phoneNumber,
          accountId: typeof entry === "object" ? entry.accountId || entry.account_id : null,
          accountType: typeof entry === "object" ? entry.accountType || entry.account_type : "manual",
        };
      });

    if (!recipients.length) return res.status(400).json({ message: "Select at least one WhatsApp number." });

    const invalidResults = recipients
      .filter((recipient) => !recipient.phoneNumber)
      .map((recipient) => ({
        phoneNumber: recipient.originalNumber,
        status: "invalid number",
        errorMessage: "Enter a valid WhatsApp number with country code or a 10 digit Indian mobile number.",
      }));
    for (const invalid of invalidResults) {
      await insertWhatsappLog({
        sourceType,
        sourceId,
        phoneNumber: invalid.phoneNumber || "invalid",
        documentName,
        status: "invalid number",
        errorMessage: invalid.errorMessage,
        sentByUserId,
      });
    }
    const validRecipients = recipients.filter((recipient) => recipient.phoneNumber);
    if (!validRecipients.length) return res.json({ configured: false, results: invalidResults });

    if (settings.enabled !== true || !settings.phone_number_id || !settings.access_token) {
      const results = validRecipients.map((recipient) => ({
        phoneNumber: recipient.phoneNumber,
        status: "WhatsApp not configured",
        errorMessage: "WhatsApp API not configured. PDF exported for manual sharing.",
      }));
      for (const recipient of validRecipients) {
        await insertWhatsappLog({
          sourceType,
          sourceId,
          accountId: recipient.accountId,
          accountType: recipient.accountType,
          phoneNumber: recipient.phoneNumber,
          documentName,
          status: "WhatsApp not configured",
          errorMessage: "WhatsApp API not configured. PDF exported for manual sharing.",
          sentByUserId,
        });
      }
      return res.json({ configured: false, results: [...invalidResults, ...results] });
    }

    const base64Payload = cleanText(pdfBase64 || pdfFile).replace(/^data:application\/pdf;base64,/i, "");
    if (!base64Payload) return res.status(400).json({ message: "PDF document data is required." });
    const pdfBuffer = Buffer.from(base64Payload, "base64");
    const mediaForm = new FormData();
    mediaForm.append("messaging_product", "whatsapp");
    mediaForm.append("type", "application/pdf");
    mediaForm.append("file", new Blob([pdfBuffer], { type: "application/pdf" }), safeDocumentFileName(documentName).replace(/\.pdf$/i, "") + ".pdf");
    const uploadResponse = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(settings.phone_number_id)}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.access_token}` },
      body: mediaForm,
    });
    const uploadPayload = await uploadResponse.json().catch(() => ({}));
    if (!uploadResponse.ok || !uploadPayload.id) {
      const errorMessage = uploadPayload?.error?.message || "Unable to upload PDF to WhatsApp.";
      const failed = validRecipients.map((recipient) => ({
        phoneNumber: recipient.phoneNumber,
        status: "failed",
        errorMessage,
      }));
      for (const recipient of validRecipients) {
        await insertWhatsappLog({
          sourceType,
          sourceId,
          accountId: recipient.accountId,
          accountType: recipient.accountType,
          phoneNumber: recipient.phoneNumber,
          documentName,
          status: "failed",
          errorMessage,
          sentByUserId,
        });
      }
      return res.status(uploadResponse.status || 502).json({ configured: true, results: [...invalidResults, ...failed], message: errorMessage });
    }

    const results = [];
    for (const recipient of validRecipients) {
      try {
        const sendResponse = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(settings.phone_number_id)}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${settings.access_token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: recipient.phoneNumber,
            type: "document",
            document: {
              id: uploadPayload.id,
              filename: safeDocumentFileName(documentName).replace(/\.pdf$/i, "") + ".pdf",
              caption: cleanText(caption) || "FroozERP document",
            },
          }),
        });
        const sendPayload = await sendResponse.json().catch(() => ({}));
        const success = sendResponse.ok;
        const status = success ? "sent" : "failed";
        const errorMessage = success ? "" : sendPayload?.error?.message || "WhatsApp send failed.";
        await insertWhatsappLog({
          sourceType,
          sourceId,
          accountId: recipient.accountId,
          accountType: recipient.accountType,
          phoneNumber: recipient.phoneNumber,
          documentName,
          status,
          errorMessage,
          sentByUserId,
        });
        results.push({ phoneNumber: recipient.phoneNumber, status, errorMessage });
      } catch (sendError) {
        const errorMessage = sendError.message || "WhatsApp send failed.";
        await insertWhatsappLog({
          sourceType,
          sourceId,
          accountId: recipient.accountId,
          accountType: recipient.accountType,
          phoneNumber: recipient.phoneNumber,
          documentName,
          status: "failed",
          errorMessage,
          sentByUserId,
        });
        results.push({ phoneNumber: recipient.phoneNumber, status: "failed", errorMessage });
      }
    }
    return res.json({ configured: true, results: [...invalidResults, ...results] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Unable to send WhatsApp document" });
  }
});

app.put("/settings/business", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage business settings" });
    const result = await pool.query(
      `
      UPDATE business_settings
      SET
        business_name = $1,
        brand_name = $2,
        company_name = $3,
        address = $4,
        phone_number = $5,
        gst_number = $6,
        logo_url = $7,
        compact_logo_text = $8,
        invoice_footer_text = $9,
        default_printer_type = $10,
        receipt_width = $11,
        auto_print_after_billing = $12,
        show_item_discount_column_pos = $13,
        show_item_discount_column_receipt = $14,
        show_bill_discount_row_receipt = $15,
        hide_zero_discount_rows = $16,
        default_invoice_print = $17,
        default_report_print = $18,
        show_print_preview_before_print = $19,
        updated_by = $20,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [
        cleanText(req.body.business_name) || "FroozERP Retail",
        cleanText(req.body.brand_name) || "FEEL THE FREAKIN' FROOZ",
        cleanText(req.body.company_name) || "SRT Company",
        nullableText(req.body.address),
        nullableText(req.body.phone_number),
        nullableText(req.body.gst_number),
        nullableText(req.body.logo_url),
        nullableText(req.body.compact_logo_text) || "FTF",
        nullableText(req.body.invoice_footer_text) || "Thank you for shopping with FEEL THE FREAKIN' FROOZ.",
        cleanText(req.body.default_printer_type).toUpperCase() === "A4" ? "A4" : "THERMAL",
        cleanText(req.body.receipt_width).toUpperCase() === "58MM" ? "58MM" : "80MM",
        req.body.auto_print_after_billing === true,
        req.body.show_item_discount_column_pos !== false,
        req.body.show_item_discount_column_receipt !== false,
        req.body.show_bill_discount_row_receipt !== false,
        req.body.hide_zero_discount_rows !== false,
        cleanText(req.body.default_invoice_print).toUpperCase() === "A4_INVOICE" ? "A4_INVOICE" : "THERMAL_RECEIPT",
        "A4_REPORT",
        req.body.show_print_preview_before_print !== false,
        manager.id,
      ]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Business Settings" });
  }
});

app.put("/settings/sale-rate", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const desiredMargin = parseNonNegativeNumber(req.body.desired_margin_percent);
    const roundingRule = String(req.body.rounding_rule || "NEAREST_RUPEE").toUpperCase();
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage sale rate settings" });
    if (desiredMargin === null || !ROUNDING_RULES.has(roundingRule)) {
      return res.status(400).json({ message: "Enter valid sale rate settings" });
    }
    const lotSelectionMode = ["AUTO_FIFO", "MANUAL", "ASK_MULTIPLE"].includes(String(req.body.pos_lot_selection_mode || "ASK_MULTIPLE").toUpperCase())
      ? String(req.body.pos_lot_selection_mode || "ASK_MULTIPLE").toUpperCase()
      : "ASK_MULTIPLE";
    const result = await pool.query(
      `
      UPDATE sale_rate_settings
      SET desired_margin_percent = $1, rounding_rule = $2, suggestion_enabled = $3,
          bill_level_slab_discount_enabled = $4,
          pos_lot_selection_mode = $5,
          notes = $6, updated_by = $7, updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [desiredMargin, roundingRule, req.body.suggestion_enabled !== false, req.body.bill_level_slab_discount_enabled !== false, lotSelectionMode, nullableText(req.body.notes), manager.id]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Sale Rate Settings" });
  }
});

const readUserPayload = (body) => ({
  full_name: cleanText(body.full_name),
  username: cleanText(body.username),
  mobile_number: nullableText(body.mobile_number),
  email: nullableText(body.email),
  recovery_enabled: body.recovery_enabled !== false,
  staff_self_recovery_enabled: body.staff_self_recovery_enabled === true,
  role: cleanText(body.role || "Cashier"),
  active: body.active !== false,
  joining_date: body.joining_date || toDateKey(new Date()),
  notes: nullableText(body.notes),
});

const findDuplicateUser = async ({ username, mobile_number, email, userId = null }) => {
  const result = await pool.query(
    `
    SELECT id, username, mobile_number, email
    FROM users
    WHERE ($1::INT IS NULL OR id <> $1)
      AND (
        LOWER(username) = LOWER($2)
        OR ($3::TEXT IS NOT NULL AND mobile_number IS NOT NULL AND mobile_number = $3)
        OR ($4::TEXT IS NOT NULL AND email IS NOT NULL AND LOWER(email) = LOWER($4))
      )
    LIMIT 1
    `,
    [userId, username, mobile_number, email]
  );
  const duplicate = result.rows[0];
  if (!duplicate) return "";
  if (duplicate.username?.toLowerCase() === username.toLowerCase()) return "This username already exists.";
  if (mobile_number && duplicate.mobile_number === mobile_number) return "This mobile number already exists.";
  if (email && duplicate.email?.toLowerCase() === email.toLowerCase()) return "This email already exists.";
  return "This user already exists.";
};

const getRoleIdByName = async (roleName, client = pool) => {
  const result = await client.query("SELECT id FROM roles WHERE role_name = $1", [roleName]);
  return result.rows[0]?.id || null;
};

const getUserTransactionCount = async (userId) => {
  const result = await pool.query(
    `
    SELECT
      COALESCE((SELECT COUNT(*) FROM sales WHERE created_by = $1), 0)
      + COALESCE((SELECT COUNT(*) FROM purchases WHERE created_by = $1), 0)
      + COALESCE((SELECT COUNT(*) FROM supplier_payments WHERE created_by = $1), 0)
      + COALESCE((SELECT COUNT(*) FROM customer_payments WHERE created_by = $1), 0)
      + COALESCE((SELECT COUNT(*) FROM expenses WHERE created_by = $1), 0)
      + COALESCE((SELECT COUNT(*) FROM sale_returns WHERE created_by = $1), 0)
      + COALESCE((SELECT COUNT(*) FROM waste_entries WHERE created_by = $1), 0) AS transaction_count
    `,
    [userId]
  );
  return Number(result.rows[0]?.transaction_count || 0);
};

app.get("/users", async (req, res) => {
  try {
    const manager = await requireRateManager(req.query.updated_by || req.query.user_id);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can view users" });
    const result = await pool.query(
      `
      SELECT
        u.id, u.full_name, u.username, u.mobile_number, u.email, u.active,
        u.joining_date, u.notes, u.last_login_at, u.created_at, u.updated_at,
        u.verified_email, u.verified_mobile, u.recovery_enabled,
        u.recovery_email, u.recovery_email_verified, u.recovery_email_verified_at,
        u.recovery_mobile, u.recovery_mobile_verified, u.recovery_mobile_verified_at,
        u.pending_recovery_email, u.pending_recovery_mobile,
        u.staff_self_recovery_enabled, u.force_password_change,
        u.session_revocation_version, u.locked_until,
        r.role_name AS role, b.branch_name AS branch
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      LEFT JOIN branches b ON b.id = u.branch_id
      ORDER BY u.active DESC, u.full_name
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Users" });
  }
});

app.post("/users", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can add users" });
    const payload = readUserPayload(req.body);
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirm_password || "");
    const roleId = await getRoleIdByName(payload.role);
    if (!payload.full_name || !payload.username || !roleId || password.length < 4 || password !== confirmPassword) {
      return res.status(400).json({ message: "Enter valid user details and matching password" });
    }
    const duplicateMessage = await findDuplicateUser(payload);
    if (duplicateMessage) return res.status(409).json({ message: duplicateMessage });
    const result = await pool.query(
      `
      INSERT INTO users (
        full_name, username, password_hash, role_id, branch_id, active,
        mobile_number, email, recovery_enabled, staff_self_recovery_enabled,
        joining_date, notes, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
      RETURNING id, full_name, username, mobile_number, email, verified_email, verified_mobile, recovery_email, recovery_email_verified, recovery_mobile, recovery_mobile_verified, recovery_enabled, staff_self_recovery_enabled, active, joining_date, notes, created_at, updated_at
      `,
      [
        payload.full_name, payload.username, hashPassword(password), roleId,
        parsePositiveInteger(req.body.branch_id) || manager.branch_id || 1,
        payload.active, payload.mobile_number, payload.email,
        payload.recovery_enabled, payload.staff_self_recovery_enabled,
        payload.joining_date, payload.notes,
      ]
    );
    return res.status(201).json({ ...result.rows[0], role: payload.role });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving User" });
  }
});

app.put("/users/:id", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const userId = parsePositiveInteger(req.params.id);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can edit users" });
    if (!userId) return res.status(400).json({ message: "Invalid user" });
    const payload = readUserPayload(req.body);
    const roleId = await getRoleIdByName(payload.role);
    if (!payload.full_name || !payload.username || !roleId) {
      return res.status(400).json({ message: "Enter valid user details" });
    }
    const duplicateMessage = await findDuplicateUser({ ...payload, userId });
    if (duplicateMessage) return res.status(409).json({ message: duplicateMessage });
    const result = await pool.query(
      `
      UPDATE users
      SET full_name = $1, username = $2, role_id = $3, active = $4,
          mobile_number = $5, email = $6, joining_date = $7, notes = $8,
          recovery_enabled = $9, staff_self_recovery_enabled = $10,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $11
      RETURNING id, full_name, username, mobile_number, email, verified_email, verified_mobile, recovery_email, recovery_email_verified, recovery_mobile, recovery_mobile_verified, recovery_enabled, staff_self_recovery_enabled, active, joining_date, notes, last_login_at, created_at, updated_at
      `,
      [
        payload.full_name, payload.username, roleId, payload.active,
        payload.mobile_number, payload.email, payload.joining_date, payload.notes,
        payload.recovery_enabled, payload.staff_self_recovery_enabled,
        userId,
      ]
    );
    return result.rows[0] ? res.json({ ...result.rows[0], role: payload.role }) : res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating User" });
  }
});

app.put("/users/:id/password", async (req, res) => {
  try {
    const userId = parsePositiveInteger(req.params.id);
    const actorId = parsePositiveInteger(req.body.updated_by);
    const manager = await requireRateManager(actorId);
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirm_password || "");
    if (!userId || (!manager && actorId !== userId)) return res.status(403).json({ message: "Not allowed to change this password" });
    if (password.length < 4 || password !== confirmPassword) return res.status(400).json({ message: "Enter matching password with at least 4 characters" });
    const result = await pool.query(
      `
      UPDATE users
      SET password_hash = $1,
          password_changed_at = CURRENT_TIMESTAMP,
          session_revocation_version = COALESCE(session_revocation_version, 0) + 1,
          force_password_change = FALSE,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING id, username
      `,
      [hashPassword(password), userId]
    );
    if (result.rows[0]) {
      await writeAuthAudit({
        userId,
        actorUserId: actorId,
        username: result.rows[0].username,
        action: manager ? "ADMIN_PASSWORD_RESET" : "USER_PASSWORD_CHANGE",
        safeCode: "PASSWORD_UPDATED",
        ipAddress: req.ip,
      });
    }
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Password" });
  }
});

app.post("/users/:id/deactivate", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const userId = parsePositiveInteger(req.params.id);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can deactivate users" });
    if (!userId || userId === manager.id) return res.status(400).json({ message: "Invalid user deactivation request" });
    const result = await pool.query("UPDATE users SET active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id", [userId]);
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Deactivating User" });
  }
});

app.post("/users/:id/reactivate", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const userId = parsePositiveInteger(req.params.id);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can reactivate users" });
    const result = await pool.query("UPDATE users SET active = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING id", [userId]);
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Reactivating User" });
  }
});

app.delete("/users/:id", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const userId = parsePositiveInteger(req.params.id);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can delete users" });
    if (!userId || userId === manager.id) return res.status(400).json({ message: "Invalid user delete request" });
    const transactionCount = await getUserTransactionCount(userId);
    if (transactionCount > 0) {
      await pool.query("UPDATE users SET active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [userId]);
      return res.json({ success: true, deactivated: true, message: "User has transaction history and was deactivated instead of deleted." });
    }
    const result = await pool.query("DELETE FROM users WHERE id = $1 RETURNING id", [userId]);
    return result.rows[0] ? res.json({ success: true, deleted: true }) : res.status(404).json({ message: "User not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Deleting User" });
  }
});

app.get("/auth/recovery/config", async (req, res) => {
  try {
    const supportContacts = await getSupportContacts({ staffOnly: true });
    return res.json({
      provider_status: getRecoveryProviderStatus(),
      support_contacts: supportContacts,
      public_message: recoveryGenericMessage,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ code: "RECOVERY_CONFIG_ERROR", message: "Unable to load recovery configuration" });
  }
});

app.get("/auth/recovery/profile", async (req, res) => {
  try {
    const userId = parsePositiveInteger(req.query.user_id);
    const actor = await requireSelfOrRateManager(userId, req.query.updated_by || req.query.user_id);
    if (!actor) return res.status(403).json({ code: "BRANCH_ACCESS_DENIED", message: "Not allowed to view recovery profile" });
    const result = await pool.query(
      `
      SELECT id, username, full_name, recovery_enabled,
             recovery_email, recovery_email_verified, recovery_email_verified_at, pending_recovery_email,
             recovery_mobile, recovery_mobile_verified, recovery_mobile_verified_at, pending_recovery_mobile
      FROM users
      WHERE id = $1
      `,
      [userId]
    );
    const profile = result.rows[0];
    if (!profile) return res.status(404).json({ code: "USER_NOT_FOUND", message: "User not found" });
    return res.json({
      ...profile,
      masked_recovery_email: maskEmail(profile.recovery_email),
      masked_recovery_mobile: maskMobile(profile.recovery_mobile),
      provider_status: getRecoveryProviderStatus(),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ code: "RECOVERY_PROFILE_ERROR", message: "Unable to load recovery profile" });
  }
});

app.post("/auth/recovery/contact/request", async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = parsePositiveInteger(req.body.user_id);
    const actor = await requireSelfOrRateManager(userId, req.body.updated_by || req.body.user_id, client);
    const contactType = cleanText(req.body.contact_type).toLowerCase();
    if (!actor) return res.status(403).json({ code: "BRANCH_ACCESS_DENIED", message: "Not allowed to update recovery contact" });
    if (!["email", "mobile"].includes(contactType)) return res.status(400).json({ code: "INVALID_CONTACT_TYPE", message: "Select email or mobile recovery contact." });
    const normalized = contactType === "email"
      ? normalizeRecoveryEmail(req.body.contact_value)
      : normalizeRecoveryMobile(req.body.contact_value);
    if (!normalized) {
      return res.status(400).json({
        code: "INVALID_RECOVERY_CONTACT",
        message: contactType === "email" ? "Enter a valid recovery email address." : "Enter a valid Indian mobile number.",
      });
    }
    const duplicateResult = await client.query(
      `
      SELECT id, username
      FROM users
      WHERE id <> $1
        AND (
          ($2 = 'email' AND LOWER(COALESCE(recovery_email, verified_email, '')) = LOWER($3))
          OR ($2 = 'mobile' AND COALESCE(recovery_mobile, verified_mobile, '') = $3)
        )
      LIMIT 1
      `,
      [userId, contactType, normalized]
    );
    if (duplicateResult.rows[0]) {
      return res.status(409).json({ code: "RECOVERY_CONTACT_IN_USE", message: "This recovery contact is already configured for another user." });
    }
    const userResult = await client.query("SELECT id, username, full_name FROM users WHERE id = $1 AND active = TRUE", [userId]);
    const targetUser = userResult.rows[0];
    if (!targetUser) return res.status(404).json({ code: "USER_NOT_FOUND", message: "User not found" });
    const method = contactType === "email" ? "email" : "mobile";
    const delivery = await createOtpRequest({
      client,
      user: targetUser,
      purpose: contactType === "email" ? "contact_email" : "contact_mobile",
      method,
      contact: normalized,
      req,
      deviceId: cleanText(req.body.device_id),
    });
    if (!delivery.delivery.delivered) {
      await invalidateOtpRequest(delivery.requestId, client);
      return res.status(503).json({
        code: method === "email" ? "EMAIL_PROVIDER_NOT_CONFIGURED" : "SMS_PROVIDER_NOT_CONFIGURED",
        message: method === "email"
          ? "Email recovery is not configured. Ask the administrator to configure SMTP settings."
          : "SMS recovery is not configured. Please use verified email recovery or contact the administrator.",
        provider_status: getRecoveryProviderStatus(),
        delivery_status: delivery.delivery.status,
      });
    }
    await client.query("BEGIN");
    await client.query(
      contactType === "email"
        ? "UPDATE users SET pending_recovery_email = $1, recovery_email_verified = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $2"
        : "UPDATE users SET pending_recovery_mobile = $1, recovery_mobile_verified = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [normalized, userId]
    );
    await writeAuthAudit({
      userId,
      actorUserId: actor.id,
      username: targetUser.username,
      action: contactType === "email" ? "RECOVERY_EMAIL_OTP_REQUESTED" : "RECOVERY_MOBILE_OTP_REQUESTED",
      safeCode: "OTP_REQUESTED",
      deviceId: cleanText(req.body.device_id),
      ipAddress: req.ip,
      details: { method, provider: delivery.delivery.provider },
    }, client);
    await client.query("COMMIT");
    return res.json({
      success: true,
      code: "OTP_SENT",
      request_id: delivery.requestId,
      masked_contact: contactType === "email" ? maskEmail(normalized) : maskMobile(normalized),
      provider_status: getRecoveryProviderStatus(),
      development_otp: recoveryDevOtpEnabled ? delivery.delivery.development_code : undefined,
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(error);
    return res.status(500).json({ code: "RECOVERY_CONTACT_REQUEST_ERROR", message: "Unable to send recovery contact verification code" });
  } finally {
    client.release();
  }
});

app.post("/auth/recovery/contact/verify", async (req, res) => {
  const client = await pool.connect();
  try {
    const userId = parsePositiveInteger(req.body.user_id);
    const actor = await requireSelfOrRateManager(userId, req.body.updated_by || req.body.user_id, client);
    const contactType = cleanText(req.body.contact_type).toLowerCase();
    if (!actor) return res.status(403).json({ code: "BRANCH_ACCESS_DENIED", message: "Not allowed to verify recovery contact" });
    if (!["email", "mobile"].includes(contactType)) return res.status(400).json({ code: "INVALID_CONTACT_TYPE", message: "Select email or mobile recovery contact." });
    const purpose = contactType === "email" ? "contact_email" : "contact_mobile";
    await client.query("BEGIN");
    const verification = await verifyOtpRequest({ requestId: cleanText(req.body.request_id), otp: cleanText(req.body.otp), purpose, client });
    if (!verification.ok) {
      await writeAuthAudit({
        userId,
        actorUserId: actor.id,
        action: contactType === "email" ? "RECOVERY_EMAIL_OTP_FAILED" : "RECOVERY_MOBILE_OTP_FAILED",
        safeCode: verification.code,
        deviceId: cleanText(req.body.device_id),
        ipAddress: req.ip,
      }, client);
      await client.query("COMMIT");
      return res.status(verification.status).json({ code: verification.code, message: verification.message });
    }
    if (Number(verification.request.user_id) !== Number(userId)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ code: "RECOVERY_REQUEST_MISMATCH", message: "Verification request does not match this user." });
    }
    const pendingColumn = contactType === "email" ? "pending_recovery_email" : "pending_recovery_mobile";
    const pendingResult = await client.query(`SELECT username, ${pendingColumn} AS pending_contact FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    const pendingContact = pendingResult.rows[0]?.pending_contact;
    if (!pendingContact) {
      await client.query("ROLLBACK");
      return res.status(400).json({ code: "NO_PENDING_CONTACT", message: "No pending recovery contact is waiting for verification." });
    }
    await client.query(
      contactType === "email"
        ? `UPDATE users
           SET recovery_email = pending_recovery_email,
               verified_email = pending_recovery_email,
               recovery_email_verified = TRUE,
               recovery_email_verified_at = CURRENT_TIMESTAMP,
               pending_recovery_email = NULL,
               recovery_enabled = TRUE,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`
        : `UPDATE users
           SET recovery_mobile = pending_recovery_mobile,
               verified_mobile = pending_recovery_mobile,
               recovery_mobile_verified = TRUE,
               recovery_mobile_verified_at = CURRENT_TIMESTAMP,
               pending_recovery_mobile = NULL,
               recovery_enabled = TRUE,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
      [userId]
    );
    await client.query("UPDATE account_recovery_requests SET used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE request_id = $1", [cleanText(req.body.request_id)]);
    await writeAuthAudit({
      userId,
      actorUserId: actor.id,
      username: pendingResult.rows[0]?.username,
      action: contactType === "email" ? "RECOVERY_EMAIL_VERIFIED" : "RECOVERY_MOBILE_VERIFIED",
      safeCode: "CONTACT_VERIFIED",
      deviceId: cleanText(req.body.device_id),
      ipAddress: req.ip,
      details: { contact_type: contactType },
    }, client);
    await client.query("COMMIT");
    return res.json({
      success: true,
      code: "CONTACT_VERIFIED",
      message: contactType === "email" ? "Recovery email verified." : "Recovery mobile verified.",
      masked_contact: contactType === "email" ? maskEmail(pendingContact) : maskMobile(pendingContact),
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(error);
    return res.status(500).json({ code: "RECOVERY_CONTACT_VERIFY_ERROR", message: "Unable to verify recovery contact" });
  } finally {
    client.release();
  }
});

app.get("/auth/recovery/readiness-report", async (req, res) => {
  try {
    const manager = await requireRateManager(req.query.user_id || req.query.updated_by);
    if (!manager) return res.status(403).json({ code: "BRANCH_ACCESS_DENIED", message: "Only Owner or Admin can view recovery readiness" });
    const result = await pool.query(
      `
      SELECT u.id, u.full_name, u.username, u.email, u.mobile_number, r.role_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.active = TRUE
        AND NOT (
          (COALESCE(u.recovery_email_verified, FALSE) = TRUE AND COALESCE(u.recovery_email, '') <> '')
          OR (COALESCE(u.recovery_mobile_verified, FALSE) = TRUE AND COALESCE(u.recovery_mobile, '') <> '')
          OR COALESCE(u.verified_email, '') <> ''
          OR COALESCE(u.verified_mobile, '') <> ''
        )
      ORDER BY r.role_name, u.username
      `
    );
    return res.json({
      missing_verified_contacts: result.rows,
      provider_status: getRecoveryProviderStatus(),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ code: "RECOVERY_REPORT_ERROR", message: "Unable to load recovery readiness report" });
  }
});

app.post("/auth/recovery/options", async (req, res) => {
  try {
    const identifier = cleanText(req.body.identifier);
    const purpose = cleanText(req.body.purpose || "password").toLowerCase();
    const user = await findRecoveryUser(identifier);
    const eligibility = ensureRecoveryEligible(user);
    const response = {
      success: true,
      code: eligibility.code || "RECOVERY_OPTIONS_READY",
      message: eligibility.ok ? "Select a verified recovery method." : (eligibility.message || recoveryGenericMessage),
      methods: eligibility.ok ? eligibility.methods : [],
      provider_status: getRecoveryProviderStatus(),
      support_contacts: await getSupportContacts({ staffOnly: true }),
    };
    await writeAuthAudit({
      userId: user?.id,
      username: user?.username || identifier,
      action: "RECOVERY_OPTIONS",
      safeCode: response.code,
      deviceId: cleanText(req.body.device_id),
      ipAddress: req.ip,
      details: { purpose },
    });
    return res.json(response);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ code: "RECOVERY_OPTIONS_ERROR", message: "Unable to check recovery options" });
  }
});

app.post("/auth/recovery/send-otp", async (req, res) => {
  try {
    const identifier = cleanText(req.body.identifier);
    const purpose = cleanText(req.body.purpose || "password").toLowerCase() === "username" ? "username" : "password";
    const method = cleanText(req.body.method).toLowerCase();
    const user = await findRecoveryUser(identifier);
    const eligibility = ensureRecoveryEligible(user);
    if (!eligibility.ok) {
      await writeAuthAudit({
        userId: user?.id,
        username: user?.username || identifier,
        action: "RECOVERY_OTP_REQUEST",
        safeCode: eligibility.code || "GENERIC_RESPONSE",
        deviceId: cleanText(req.body.device_id),
        ipAddress: req.ip,
        details: { purpose, method },
      });
      return res.json({
        success: true,
        code: eligibility.code || "GENERIC_RESPONSE",
        message: eligibility.message || recoveryGenericMessage,
        provider_status: getRecoveryProviderStatus(),
      });
    }
    const selectedMethod = eligibility.methods.find((entry) => entry.method === method);
    if (!selectedMethod) {
      return res.status(400).json({ code: "RECOVERY_METHOD_UNAVAILABLE", message: "Select an available recovery method." });
    }
    const recentResult = await pool.query(
      `
      SELECT
        COUNT(*) FILTER (WHERE created_at > CURRENT_TIMESTAMP - INTERVAL '15 minutes')::INTEGER AS recent_count,
        MAX(created_at) AS last_created_at,
        MAX(resend_available_at) AS resend_available_at
      FROM account_recovery_requests
      WHERE user_id = $1 AND purpose = $2 AND method = $3
      `,
      [user.id, purpose, method]
    );
    const recent = recentResult.rows[0] || {};
    if (Number(recent.recent_count || 0) >= 5) {
      await writeAuthAudit({
        userId: user.id,
        username: user.username,
        action: "RECOVERY_OTP_RATE_LIMITED",
        safeCode: "RATE_LIMITED",
        deviceId: cleanText(req.body.device_id),
        ipAddress: req.ip,
        details: { purpose, method },
      });
      return res.status(429).json({ code: "RATE_LIMITED", message: "Too many recovery attempts. Try again later." });
    }
    if (recent.resend_available_at && new Date(recent.resend_available_at).getTime() > Date.now()) {
      return res.status(429).json({ code: "RESEND_COOLDOWN", message: "Please wait before requesting another verification code." });
    }
    const contact = method === "email"
      ? cleanText(user.recovery_email || user.verified_email)
      : cleanText(user.recovery_mobile || user.verified_mobile);
    const requestId = `rec_${crypto.randomUUID()}`;
    const otp = generateOtpCode();
    await pool.query(
      `
      UPDATE account_recovery_requests
      SET invalidated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE user_id = $1 AND purpose = $2 AND method = $3 AND used_at IS NULL AND invalidated_at IS NULL
      `,
      [user.id, purpose, method]
    );
    await pool.query(
      `
      INSERT INTO account_recovery_requests (
        request_id, user_id, purpose, method, contact_hash, otp_hash,
        expires_at, resend_available_at, requested_ip, requested_device_id, user_agent
      )
      VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP + INTERVAL '10 minutes',
              CURRENT_TIMESTAMP + INTERVAL '60 seconds', $7, $8, $9)
      `,
      [
        requestId,
        user.id,
        purpose,
        method,
        hashSensitiveValue(contact),
        hashOtp(requestId, otp),
        req.ip,
        cleanText(req.body.device_id),
        cleanText(req.get("user-agent")),
      ]
    );
    const delivery = await sendRecoveryOtp({ method, contact, code: otp, purpose });
    await writeAuthAudit({
      userId: user.id,
      username: user.username,
      action: "RECOVERY_OTP_REQUESTED",
      safeCode: delivery.delivered ? "OTP_REQUESTED" : "PROVIDER_DELIVERY_FAILED",
      deviceId: cleanText(req.body.device_id),
      ipAddress: req.ip,
      details: { purpose, method, provider: delivery.provider, delivery_status: delivery.status },
    });
    if (!delivery.delivered) {
      await invalidateOtpRequest(requestId);
      return res.status(503).json({
        success: false,
        code: delivery.status === "not_configured" ? "PROVIDER_NOT_CONFIGURED" : "PROVIDER_DELIVERY_FAILED",
        message: method === "email"
          ? "Email recovery is not configured or the provider rejected the request."
          : "SMS recovery is not configured. Please use verified email recovery or contact the administrator.",
        provider_status: getRecoveryProviderStatus(),
        delivery_status: delivery.status,
      });
    }
    return res.json({
      success: true,
      code: "OTP_SENT",
      message: recoveryGenericMessage,
      request_id: requestId,
      expires_in_seconds: 600,
      provider_status: getRecoveryProviderStatus(),
      delivery_status: delivery.status,
      development_otp: recoveryDevOtpEnabled ? delivery.development_code : undefined,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ code: "RECOVERY_OTP_ERROR", message: "Unable to send recovery code" });
  }
});

app.post("/auth/recovery/verify-otp", async (req, res) => {
  try {
    const requestId = cleanText(req.body.request_id);
    const otp = cleanText(req.body.otp);
    const result = await pool.query(
      `
      SELECT rr.*, u.username, u.active, u.full_name,
             u.recovery_email, u.verified_email, u.recovery_mobile, u.verified_mobile
      FROM account_recovery_requests rr
      JOIN users u ON u.id = rr.user_id
      WHERE rr.request_id = $1
      LIMIT 1
      `,
      [requestId]
    );
    const request = result.rows[0];
    if (!request || request.used_at || request.invalidated_at || new Date(request.expires_at).getTime() <= Date.now()) {
      return res.status(400).json({ code: "OTP_EXPIRED_OR_INVALID", message: "The verification code is invalid or expired." });
    }
    if (Number(request.attempt_count || 0) >= 5) {
      return res.status(429).json({ code: "OTP_ATTEMPTS_EXCEEDED", message: "Too many incorrect verification attempts." });
    }
    const expected = Buffer.from(request.otp_hash, "hex");
    const actual = Buffer.from(hashOtp(requestId, otp), "hex");
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
      await pool.query(
        "UPDATE account_recovery_requests SET attempt_count = COALESCE(attempt_count, 0) + 1, updated_at = CURRENT_TIMESTAMP WHERE request_id = $1",
        [requestId]
      );
      await writeAuthAudit({
        userId: request.user_id,
        username: request.username,
        action: "RECOVERY_OTP_FAILED",
        safeCode: "OTP_INVALID",
        deviceId: cleanText(req.body.device_id),
        ipAddress: req.ip,
      });
      return res.status(400).json({ code: "OTP_INVALID", message: "The verification code is invalid or expired." });
    }
    const verificationToken = crypto.randomBytes(32).toString("hex");
    await pool.query(
      `
      UPDATE account_recovery_requests
      SET verified_at = CURRENT_TIMESTAMP,
          verification_token_hash = $2,
          verification_expires_at = CURRENT_TIMESTAMP + INTERVAL '10 minutes',
          updated_at = CURRENT_TIMESTAMP
      WHERE request_id = $1
      `,
      [requestId, hashRecoveryToken(requestId, verificationToken)]
    );
    await writeAuthAudit({
      userId: request.user_id,
      username: request.username,
      action: "RECOVERY_OTP_VERIFIED",
      safeCode: "OTP_VERIFIED",
      deviceId: cleanText(req.body.device_id),
      ipAddress: req.ip,
      details: { purpose: request.purpose, method: request.method },
    });
    const response = {
      success: true,
      code: "OTP_VERIFIED",
      message: request.purpose === "username" ? "Username recovered." : "Verification complete. Set a new password.",
      verification_token: verificationToken,
    };
    if (request.purpose === "username") {
      response.username = request.username;
      const notifyContact = request.method === "email"
        ? cleanText(request.recovery_email || request.verified_email)
        : cleanText(request.recovery_mobile || request.verified_mobile);
      if (notifyContact) {
        const notifyResult = await sendRecoveryNotification({
          method: request.method,
          contact: notifyContact,
          subject: "Your FroozERP username",
          message: `Your FroozERP username is ${request.username}. If you did not request this, contact your administrator immediately.`,
          html: `<p>Your FroozERP username is <strong>${request.username}</strong>.</p><p>If you did not request this, contact your administrator immediately.</p>`,
        }).catch((error) => ({ delivered: false, status: "notification_failed", error: error.message || String(error) }));
        await writeAuthAudit({
          userId: request.user_id,
          username: request.username,
          action: "RECOVERY_USERNAME_NOTICE",
          safeCode: notifyResult.delivered ? "NOTICE_SENT" : "NOTICE_NOT_SENT",
          deviceId: cleanText(req.body.device_id),
          ipAddress: req.ip,
          details: { method: request.method, status: notifyResult.status },
        });
      }
    }
    return res.json(response);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ code: "RECOVERY_VERIFY_ERROR", message: "Unable to verify recovery code" });
  }
});

app.post("/auth/recovery/reset-password", async (req, res) => {
  const client = await pool.connect();
  try {
    const requestId = cleanText(req.body.request_id);
    const token = cleanText(req.body.verification_token);
    const password = String(req.body.new_password || "");
    const confirmPassword = String(req.body.confirm_password || "");
    if (password.length < 4 || password !== confirmPassword) {
      return res.status(400).json({ code: "PASSWORD_POLICY_FAILED", message: "Enter matching password with at least 4 characters." });
    }
    await client.query("BEGIN");
    const result = await client.query(
      `
      SELECT rr.*, u.username, u.recovery_email, u.verified_email, u.recovery_mobile, u.verified_mobile
      FROM account_recovery_requests rr
      JOIN users u ON u.id = rr.user_id
      WHERE rr.request_id = $1
      FOR UPDATE
      `,
      [requestId]
    );
    const request = result.rows[0];
    if (
      !request ||
      request.purpose !== "password" ||
      request.used_at ||
      request.invalidated_at ||
      !request.verified_at ||
      !request.verification_token_hash ||
      new Date(request.verification_expires_at || 0).getTime() <= Date.now() ||
      hashRecoveryToken(requestId, token) !== request.verification_token_hash
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({ code: "RECOVERY_TOKEN_INVALID", message: "Password reset verification expired. Start again." });
    }
    await client.query(
      `
      UPDATE users
      SET password_hash = $1,
          force_password_change = FALSE,
          session_revocation_version = COALESCE(session_revocation_version, 0) + 1,
          password_changed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [hashPassword(password), request.user_id]
    );
    await client.query(
      "UPDATE account_recovery_requests SET used_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE request_id = $1",
      [requestId]
    );
    await writeAuthAudit({
      userId: request.user_id,
      username: request.username,
      action: "RECOVERY_PASSWORD_RESET",
      safeCode: "PASSWORD_RESET_SUCCESS",
      deviceId: cleanText(req.body.device_id),
      ipAddress: req.ip,
      details: { method: request.method },
    }, client);
    await client.query("COMMIT");
    const notifyContact = request.method === "email"
      ? cleanText(request.recovery_email || request.verified_email)
      : cleanText(request.recovery_mobile || request.verified_mobile);
    if (notifyContact) {
      const notifyResult = await sendRecoveryNotification({
        method: request.method,
        contact: notifyContact,
        subject: "FroozERP password changed",
        message: "Your FroozERP password was changed. If you did not make this change, contact your administrator immediately.",
        html: "<p>Your FroozERP password was changed.</p><p>If you did not make this change, contact your administrator immediately.</p>",
      }).catch((error) => ({ delivered: false, status: "notification_failed", error: error.message || String(error) }));
      await writeAuthAudit({
        userId: request.user_id,
        username: request.username,
        action: "RECOVERY_PASSWORD_CHANGED_NOTICE",
        safeCode: notifyResult.delivered ? "NOTICE_SENT" : "NOTICE_NOT_SENT",
        deviceId: cleanText(req.body.device_id),
        ipAddress: req.ip,
        details: { method: request.method, status: notifyResult.status },
      });
    }
    return res.json({ success: true, code: "PASSWORD_RESET_SUCCESS", message: "Password changed. Sign in again with the new password." });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(error);
    return res.status(500).json({ code: "RECOVERY_PASSWORD_RESET_ERROR", message: "Unable to reset password" });
  } finally {
    client.release();
  }
});

app.post("/users/:id/recovery-action", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const userId = parsePositiveInteger(req.params.id);
    const action = cleanText(req.body.action).toUpperCase();
    if (!manager) return res.status(403).json({ code: "BRANCH_ACCESS_DENIED", message: "Only Owner or Admin can manage recovery actions" });
    if (!userId || userId === manager.id) return res.status(400).json({ code: "INVALID_USER_ACTION", message: "Select a valid staff account." });
    const userResult = await pool.query(
      `
      SELECT u.id, u.username, u.email, u.mobile_number, u.verified_email, u.verified_mobile, r.role_name
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1
      `,
      [userId]
    );
    const target = userResult.rows[0];
    if (!target) return res.status(404).json({ code: "USER_NOT_FOUND", message: "User not found" });
    if (RATE_MANAGER_ROLES.has(target.role_name) && manager.role_name !== "Owner") {
      return res.status(403).json({ code: "BRANCH_ACCESS_DENIED", message: "Only Owner can manage Owner/Admin recovery actions." });
    }
    if (action === "RESET_PASSWORD") {
      const requestedPassword = String(req.body.temporary_password || "");
      const temporaryPassword = requestedPassword.length >= 4 ? requestedPassword : generateTemporaryPassword();
      await pool.query(
        `
        UPDATE users
        SET password_hash = $1,
            force_password_change = TRUE,
            session_revocation_version = COALESCE(session_revocation_version, 0) + 1,
            password_changed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $2
        `,
        [hashPassword(temporaryPassword), userId]
      );
      await writeAuthAudit({
        userId,
        actorUserId: manager.id,
        username: target.username,
        action: "ADMIN_STAFF_PASSWORD_RESET",
        safeCode: "TEMPORARY_PASSWORD_SET",
        ipAddress: req.ip,
      });
      return res.json({
        success: true,
        code: "TEMPORARY_PASSWORD_SET",
        temporary_password: requestedPassword.length >= 4 ? undefined : temporaryPassword,
        message: "Temporary password set. The user must change it at next login.",
      });
    }
    if (action === "UNLOCK_ACCOUNT") {
      await pool.query("UPDATE users SET locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [userId]);
    } else if (action === "RESEND_USERNAME") {
      await writeAuthAudit({ userId, actorUserId: manager.id, username: target.username, action: "ADMIN_RESEND_USERNAME", safeCode: "USERNAME_RESEND_REQUESTED", ipAddress: req.ip });
      return res.json({
        success: true,
        code: "USERNAME_RESEND_REQUESTED",
        message: getRecoveryProviderStatus().email === "not_configured" && getRecoveryProviderStatus().sms === "not_configured"
          ? "Username resend provider is not configured. Share the username manually through an approved business contact."
          : "Username resend requested through the configured provider.",
      });
    } else if (action === "DISABLE_USER") {
      await pool.query("UPDATE users SET active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [userId]);
    } else if (action === "REVOKE_SESSIONS") {
      await pool.query("UPDATE users SET session_revocation_version = COALESCE(session_revocation_version, 0) + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [userId]);
    } else if (action === "REQUIRE_PASSWORD_CHANGE") {
      await pool.query("UPDATE users SET force_password_change = TRUE, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [userId]);
    } else {
      return res.status(400).json({ code: "INVALID_RECOVERY_ACTION", message: "Select a valid recovery action." });
    }
    await writeAuthAudit({
      userId,
      actorUserId: manager.id,
      username: target.username,
      action: `ADMIN_${action}`,
      safeCode: "OK",
      ipAddress: req.ip,
    });
    return res.json({ success: true, code: "OK", message: "User recovery action completed." });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ code: "USER_RECOVERY_ACTION_ERROR", message: "Unable to complete user recovery action" });
  }
});

app.get("/settings/discount-rules", async (req, res) => {
  try {
    const includeInactive = req.query.include_inactive === "true";
    const result = await pool.query(
      `
      SELECT *
      FROM sale_discount_rules
      ${includeInactive ? "" : "WHERE active = TRUE"}
      ORDER BY minimum_bill_amount, maximum_bill_amount NULLS LAST, id
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Discount Rules" });
  }
});

app.post("/settings/discount-rules", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    const rule = readDiscountRulePayload(req.body);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage discount rules" });
    if (
      !rule.rule_name ||
      rule.minimum_bill_amount === null ||
      hasInvalidDiscountMaximum(req.body, rule) ||
      rule.discount_value === null ||
      !DISCOUNT_TYPES.has(rule.discount_type) ||
      !DISCOUNT_PAYMENT_MODES.has(rule.payment_mode) ||
      (rule.maximum_bill_amount !== null && rule.maximum_bill_amount < rule.minimum_bill_amount)
    ) {
      return res.status(400).json({ message: "Enter valid discount rule details" });
    }
    const result = await pool.query(
      `
      INSERT INTO sale_discount_rules (
        rule_name, minimum_bill_amount, maximum_bill_amount, discount_type,
        discount_value, payment_mode, active, updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        rule.rule_name, rule.minimum_bill_amount, rule.maximum_bill_amount, rule.discount_type,
        rule.discount_value, rule.payment_mode, rule.active, manager.id,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Adding Discount Rule" });
  }
});

app.put("/settings/discount-rules/:id", async (req, res) => {
  try {
    const ruleId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.updated_by);
    const rule = readDiscountRulePayload(req.body);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage discount rules" });
    if (
      !ruleId ||
      !rule.rule_name ||
      rule.minimum_bill_amount === null ||
      hasInvalidDiscountMaximum(req.body, rule) ||
      rule.discount_value === null ||
      !DISCOUNT_TYPES.has(rule.discount_type) ||
      !DISCOUNT_PAYMENT_MODES.has(rule.payment_mode) ||
      (rule.maximum_bill_amount !== null && rule.maximum_bill_amount < rule.minimum_bill_amount)
    ) {
      return res.status(400).json({ message: "Enter valid discount rule details" });
    }
    const result = await pool.query(
      `
      UPDATE sale_discount_rules
      SET
        rule_name = $1,
        minimum_bill_amount = $2,
        maximum_bill_amount = $3,
        discount_type = $4,
        discount_value = $5,
        payment_mode = $6,
        active = $7,
        updated_by = $8,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $9
      RETURNING *
      `,
      [
        rule.rule_name, rule.minimum_bill_amount, rule.maximum_bill_amount, rule.discount_type,
        rule.discount_value, rule.payment_mode, rule.active, manager.id, ruleId,
      ]
    );
    return result.rows[0] ? res.json(result.rows[0]) : res.status(404).json({ message: "Discount rule not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Discount Rule" });
  }
});

app.delete("/settings/discount-rules/:id", async (req, res) => {
  try {
    const ruleId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage discount rules" });
    if (!ruleId) return res.status(400).json({ message: "Invalid discount rule" });
    const result = await pool.query("DELETE FROM sale_discount_rules WHERE id = $1 RETURNING id", [ruleId]);
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Discount rule not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Deleting Discount Rule" });
  }
});

app.get("/lot-discounts", async (req, res) => {
  try {
    const values = [];
    const filters = [];
    if (req.query.product_id) {
      values.push(parsePositiveInteger(req.query.product_id));
      filters.push(`ld.product_id = $${values.length}`);
    }
    if (req.query.active !== undefined) {
      values.push(String(req.query.active) === "true");
      filters.push(`ld.active = $${values.length}`);
    }
    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await pool.query(
      `
      SELECT
        ld.*,
        p.product_name,
        p.unit,
        ib.batch_no,
        ib.lot_name,
        ib.lot_size,
        ib.supplier_name,
        ib.remaining_qty,
        COALESCE(ib.temporary_sale_rate, p.selling_rate, 0) AS current_sale_rate,
        COALESCE(ib.effective_cost_per_unit, ib.purchase_rate, 0) AS cost_rate,
        ib.batch_status
      FROM lot_discounts ld
      JOIN products p ON p.id = ld.product_id
      JOIN inventory_batches ib ON ib.id = ld.inventory_batch_id
      ${whereClause}
      ORDER BY ld.active DESC, p.product_name, ib.lot_name NULLS LAST, ld.start_date DESC, ld.id DESC
      `,
      values
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Lot Discounts" });
  }
});

app.post("/lot-discounts", async (req, res) => {
  const client = await pool.connect();
  try {
    const manager = await requireRateManager(req.body.created_by || req.body.updated_by, client);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage discounts" });
    const productId = parsePositiveInteger(req.body.product_id);
    const lotIds = Array.isArray(req.body.inventory_batch_ids)
      ? req.body.inventory_batch_ids.map(parsePositiveInteger).filter(Boolean)
      : [parsePositiveInteger(req.body.inventory_batch_id)].filter(Boolean);
    const discountType = String(req.body.discount_type || "").trim().toUpperCase();
    const discountValue = parseNonNegativeNumber(req.body.discount_value);
    const startDate = toBusinessDateKey(req.body.start_date || new Date());
    const endDate = req.body.end_date ? toBusinessDateKey(req.body.end_date) : null;
    if (!productId || lotIds.length === 0 || !LOT_DISCOUNT_TYPES.has(discountType) || discountValue === null || (endDate && endDate < startDate)) {
      return res.status(400).json({ message: "Enter valid lot discount details" });
    }

    await client.query("BEGIN");
    const lotsResult = await client.query(
      `
      SELECT ib.id, ib.product_id, ib.lot_name, ib.batch_no, p.product_name
      FROM inventory_batches ib
      JOIN products p ON p.id = ib.product_id
      WHERE ib.id = ANY($1::INT[])
        AND ib.product_id = $2
        AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
      FOR SHARE
      `,
      [lotIds, productId]
    );
    if (lotsResult.rows.length !== lotIds.length) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Select valid active lots for this product" });
    }

    const created = [];
    for (const lot of lotsResult.rows) {
      const result = await client.query(
        `
        INSERT INTO lot_discounts (
          product_id, inventory_batch_id, discount_type, discount_value,
          start_date, end_date, active, remarks, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
        `,
        [
          productId, lot.id, discountType, discountValue, startDate, endDate,
          req.body.active !== false, nullableText(req.body.remarks), manager.id,
        ]
      );
      const discount = result.rows[0];
      created.push(discount);
      await client.query(
        `
        INSERT INTO lot_discount_audit (
          discount_id, product_id, inventory_batch_id, action, old_value, new_value, remarks, changed_by
        )
        VALUES ($1, $2, $3, 'CREATE', NULL, $4, $5, $6)
        `,
        [discount.id, productId, lot.id, discount, nullableText(req.body.remarks), manager.id]
      );
    }
    await client.query("COMMIT");
    return res.status(201).json(created);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Saving Lot Discount" });
  } finally {
    client.release();
  }
});

app.put("/lot-discounts/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const discountId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.updated_by, client);
    const discountType = String(req.body.discount_type || "").trim().toUpperCase();
    const discountValue = parseNonNegativeNumber(req.body.discount_value);
    const startDate = toBusinessDateKey(req.body.start_date || new Date());
    const endDate = req.body.end_date ? toBusinessDateKey(req.body.end_date) : null;
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage discounts" });
    if (!discountId || !LOT_DISCOUNT_TYPES.has(discountType) || discountValue === null || (endDate && endDate < startDate)) {
      return res.status(400).json({ message: "Enter valid lot discount details" });
    }
    await client.query("BEGIN");
    const oldResult = await client.query("SELECT * FROM lot_discounts WHERE id = $1 FOR UPDATE", [discountId]);
    if (oldResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Lot discount not found" });
    }
    const result = await client.query(
      `
      UPDATE lot_discounts
      SET discount_type = $1, discount_value = $2, start_date = $3, end_date = $4,
          active = $5, remarks = $6, edited_by = $7, edited_at = CURRENT_TIMESTAMP,
          deactivated_by = CASE WHEN $5 = FALSE AND active = TRUE THEN $7 ELSE deactivated_by END,
          deactivated_at = CASE WHEN $5 = FALSE AND active = TRUE THEN CURRENT_TIMESTAMP ELSE deactivated_at END
      WHERE id = $8
      RETURNING *
      `,
      [discountType, discountValue, startDate, endDate, req.body.active !== false, nullableText(req.body.remarks), manager.id, discountId]
    );
    const updated = result.rows[0];
    await client.query(
      `
      INSERT INTO lot_discount_audit (
        discount_id, product_id, inventory_batch_id, action, old_value, new_value, remarks, changed_by
      )
      VALUES ($1, $2, $3, 'UPDATE', $4, $5, $6, $7)
      `,
      [discountId, updated.product_id, updated.inventory_batch_id, oldResult.rows[0], updated, nullableText(req.body.remarks), manager.id]
    );
    await client.query("COMMIT");
    return res.json(updated);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Updating Lot Discount" });
  } finally {
    client.release();
  }
});

app.post("/lot-discounts/:id/deactivate", async (req, res) => {
  const client = await pool.connect();
  try {
    const discountId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.updated_by, client);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage discounts" });
    if (!discountId) return res.status(400).json({ message: "Invalid discount" });
    await client.query("BEGIN");
    const oldResult = await client.query("SELECT * FROM lot_discounts WHERE id = $1 FOR UPDATE", [discountId]);
    if (oldResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Lot discount not found" });
    }
    const result = await client.query(
      `
      UPDATE lot_discounts
      SET active = FALSE, deactivated_by = $1, deactivated_at = CURRENT_TIMESTAMP,
          edited_by = $1, edited_at = CURRENT_TIMESTAMP
      WHERE id = $2
      RETURNING *
      `,
      [manager.id, discountId]
    );
    await client.query(
      `
      INSERT INTO lot_discount_audit (
        discount_id, product_id, inventory_batch_id, action, old_value, new_value, remarks, changed_by
      )
      VALUES ($1, $2, $3, 'DEACTIVATE', $4, $5, $6, $7)
      `,
      [discountId, result.rows[0].product_id, result.rows[0].inventory_batch_id, oldResult.rows[0], result.rows[0], nullableText(req.body.remarks), manager.id]
    );
    await client.query("COMMIT");
    return res.json({ success: true, discount: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Deactivating Lot Discount" });
  } finally {
    client.release();
  }
});

app.post("/settings/mandi-tax-rules", async (req, res) => {
  try {
    const taxPercent = parseNonNegativeNumber(req.body.tax_percent);
    const originType = String(req.body.origin_type || "").toUpperCase();
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage settings" });
    if (!originType || taxPercent === null) return res.status(400).json({ message: "Enter valid mandi tax rule details" });
    const result = await pool.query(
      `
      INSERT INTO mandi_tax_rules (origin_type, tax_percent, active, updated_by)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [originType, taxPercent, req.body.active !== false, manager.id]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    if (error.code === "23505") return res.status(409).json({ message: "Mandi tax rule already exists for this origin type" });
    return res.status(500).json({ message: "Error Adding Mandi Tax Rule" });
  }
});

app.put("/settings/mandi-tax-rules/:id", async (req, res) => {
  try {
    const ruleId = parsePositiveInteger(req.params.id);
    const taxPercent = parseNonNegativeNumber(req.body.tax_percent);
    const manager = await requireRateManager(req.body.updated_by);
    if (!ruleId || taxPercent === null || !manager) {
      return res.status(manager ? 400 : 403).json({ message: manager ? "Enter a valid mandi tax rate" : "Only Owner or Admin can manage settings" });
    }
    const result = await pool.query(
      `
      UPDATE mandi_tax_rules
      SET tax_percent = $1, active = $2, updated_by = $3, updated_at = CURRENT_TIMESTAMP
      WHERE id = $4
      RETURNING *
      `,
      [taxPercent, req.body.active !== false, manager.id, ruleId]
    );
    return result.rows[0] ? res.json(result.rows[0]) : res.status(404).json({ message: "Mandi tax rule not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Mandi Tax Rule" });
  }
});

app.delete("/settings/mandi-tax-rules/:id", async (req, res) => {
  try {
    const ruleId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage settings" });
    if (!ruleId) return res.status(400).json({ message: "Invalid mandi tax rule" });
    const result = await pool.query("DELETE FROM mandi_tax_rules WHERE id = $1 RETURNING id", [ruleId]);
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Mandi tax rule not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Deleting Mandi Tax Rule" });
  }
});

app.post("/settings/rebate-rules", async (req, res) => {
  try {
    const { rule_name, pay_within_days, rebate_percent, active, updated_by } = req.body;
    const parsedDays = parseNonNegativeNumber(pay_within_days);
    const parsedPercent = parseNonNegativeNumber(rebate_percent);
    const manager = await requireRateManager(updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage settings" });
    if (!rule_name?.trim() || !Number.isInteger(parsedDays) || parsedPercent === null) {
      return res.status(400).json({ message: "Enter valid rebate rule details" });
    }
    const result = await pool.query(
      `
      INSERT INTO rebate_rules (rule_name, pay_within_days, rebate_percent, active, updated_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [rule_name.trim(), parsedDays, parsedPercent, active !== false, manager.id]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Adding Rebate Rule" });
  }
});

app.put("/settings/rebate-rules/:id", async (req, res) => {
  try {
    const ruleId = parsePositiveInteger(req.params.id);
    const { rule_name, pay_within_days, rebate_percent, active, updated_by } = req.body;
    const parsedDays = parseNonNegativeNumber(pay_within_days);
    const parsedPercent = parseNonNegativeNumber(rebate_percent);
    const manager = await requireRateManager(updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage settings" });
    if (!ruleId || !rule_name?.trim() || !Number.isInteger(parsedDays) || parsedPercent === null) {
      return res.status(400).json({ message: "Enter valid rebate rule details" });
    }
    const result = await pool.query(
      `
      UPDATE rebate_rules
      SET rule_name = $1, pay_within_days = $2, rebate_percent = $3, active = $4, updated_by = $5, updated_at = CURRENT_TIMESTAMP
      WHERE id = $6
      RETURNING *
      `,
      [rule_name.trim(), parsedDays, parsedPercent, active !== false, manager.id, ruleId]
    );
    return result.rows[0] ? res.json(result.rows[0]) : res.status(404).json({ message: "Rebate rule not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Rebate Rule" });
  }
});

app.delete("/settings/rebate-rules/:id", async (req, res) => {
  try {
    const ruleId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage settings" });
    if (!ruleId) return res.status(400).json({ message: "Invalid rebate rule" });
    const result = await pool.query("DELETE FROM rebate_rules WHERE id = $1 RETURNING id", [ruleId]);
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Rebate rule not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Deleting Rebate Rule" });
  }
});

app.get("/", (req, res) => {
  res.send("FroozERP Backend Running");
});

const readDevicePayload = (body = {}, req = {}) => ({
  device_id: cleanText(body.device_id),
  device_name: cleanText(body.device_name) || "Unnamed Device",
  device_type: cleanText(body.device_type) || "Browser",
  user_agent: cleanText(body.user_agent || req.get?.("user-agent")),
  local_ip: cleanText(body.local_ip || req.ip),
  assigned_branch_id: parsePositiveInteger(body.assigned_branch_id) || 1,
  assigned_counter_id: parsePositiveInteger(body.assigned_counter_id),
});

const upsertDeviceRequest = async (device, client = pool) => {
  if (!device.device_id) return null;
  const result = await client.query(
    `
    INSERT INTO authorized_devices (
      device_id, device_name, device_type, user_agent, local_ip,
      assigned_branch_id, assigned_counter_id, status, request_time, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (device_id) DO UPDATE
    SET device_name = EXCLUDED.device_name,
        device_type = EXCLUDED.device_type,
        user_agent = EXCLUDED.user_agent,
        local_ip = EXCLUDED.local_ip,
        updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
    [
      device.device_id,
      device.device_name,
      device.device_type,
      device.user_agent,
      device.local_ip,
      device.assigned_branch_id,
      device.assigned_counter_id,
    ]
  );
  return result.rows[0];
};

const approveDevice = async ({ deviceId, approvedBy, branchId = 1, counterId = null, reason = "Approved" }, client = pool) => {
  const beforeResult = await client.query("SELECT * FROM authorized_devices WHERE device_id = $1", [deviceId]);
  const result = await client.query(
    `
    UPDATE authorized_devices
    SET status = 'APPROVED',
        approved_by = $2,
        approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP),
        assigned_branch_id = COALESCE($3, assigned_branch_id, 1),
        assigned_counter_id = COALESCE($4, assigned_counter_id),
        last_active_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE device_id = $1
    RETURNING *
    `,
    [deviceId, approvedBy, branchId, counterId]
  );
  await client.query(
    `
    INSERT INTO device_audit_trail (device_id, action, old_value, new_value, reason, changed_by)
    VALUES ($1, 'APPROVE', $2::jsonb, $3::jsonb, $4, $5)
    `,
    [deviceId, JSON.stringify(beforeResult.rows[0] || {}), JSON.stringify(result.rows[0] || {}), reason, approvedBy]
  );
  return result.rows[0];
};

const normalizeSyncStatus = (value) => String(value || "").trim().toLowerCase();
const SYNC_OPERATION_TYPES = new Set(["UPSERT", "DELETE", "CREATE", "UPDATE", "SALE_EDIT", "SALE_CANCEL"]);
const SYNC_ENTITY_TYPES = new Set(["sync_test", "pos_sale"]);
const syncRateWindow = new Map();

const requireSyncContext = async ({ userId, deviceId, branchId }, client = pool) => {
  const parsedUserId = parsePositiveInteger(userId);
  const parsedBranchId = parsePositiveInteger(branchId) || 1;
  const cleanDeviceId = cleanText(deviceId);
  if (!parsedUserId || !cleanDeviceId) {
    return { error: { status: 401, message: "Sync requires user_id and device_id" } };
  }
  const userResult = await client.query(
    `
    SELECT u.id, u.full_name, u.branch_id, u.active, r.role_name
    FROM users u
    JOIN roles r ON r.id = u.role_id
    WHERE u.id = $1 AND u.active = TRUE
    `,
    [parsedUserId]
  );
  const user = userResult.rows[0];
  if (!user) return { error: { status: 401, message: "Sync user is not active" } };
  const deviceResult = await client.query(
    "SELECT * FROM authorized_devices WHERE device_id = $1 LIMIT 1",
    [cleanDeviceId]
  );
  const device = deviceResult.rows[0];
  if (!device) return { error: { status: 403, message: "Device is not registered for sync" } };
  if (device.status !== "APPROVED") {
    return { error: { status: 403, message: "Device is not approved for sync" } };
  }
  if (["DISABLED", "REVOKED"].includes(String(device.status || "").toUpperCase())) {
    return { error: { status: 403, message: "Device is disabled or revoked" } };
  }
  const deviceBranchId = Number(device.assigned_branch_id || parsedBranchId || 1);
  if (deviceBranchId !== parsedBranchId) {
    return { error: { status: 403, message: "Device is not assigned to this branch" } };
  }
  return { user, device, branchId: parsedBranchId, deviceId: cleanDeviceId };
};

const rateLimitSyncRequest = (req, res, next) => {
  const key = `${req.ip}:${cleanText(req.body?.device_id || req.query?.device_id || "unknown")}`;
  const now = Date.now();
  const current = syncRateWindow.get(key) || { startedAt: now, count: 0 };
  if (now - current.startedAt > 60_000) {
    current.startedAt = now;
    current.count = 0;
  }
  current.count += 1;
  syncRateWindow.set(key, current);
  if (current.count > 120) {
    return res.status(429).json({ message: "Too many sync requests. Please retry shortly." });
  }
  return next();
};

const logSyncChange = async (client, { branchId = 1, entityType, entityId, operationType = "UPSERT", version = 1, payload = {} }) => {
  const result = await client.query(
    `
    INSERT INTO sync_change_log (
      branch_id, entity_type, entity_id, operation_type, entity_version, payload
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb)
    RETURNING change_id, created_at
    `,
    [branchId, entityType, String(entityId), operationType, version, JSON.stringify(payload)]
  );
  return result.rows[0];
};

const seedReferenceChangeLog = async () => {
  await pool.query(`
    INSERT INTO sync_change_log (branch_id, entity_type, entity_id, operation_type, entity_version, payload, created_at)
    SELECT
      1,
      'product_category',
      pc.global_id,
      CASE WHEN pc.deleted_at IS NULL AND pc.active IS DISTINCT FROM FALSE THEN 'UPSERT' ELSE 'DELETE' END,
      pc.entity_version,
      TO_JSONB(pc),
      COALESCE(pc.updated_at, pc.created_at, CURRENT_TIMESTAMP)
    FROM product_categories pc
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_change_log scl
      WHERE scl.entity_type = 'product_category' AND scl.entity_id = pc.global_id
    );

    INSERT INTO sync_change_log (branch_id, entity_type, entity_id, operation_type, entity_version, payload, created_at)
    SELECT
      1,
      'product',
      p.global_id,
      CASE WHEN p.deleted_at IS NULL AND p.active IS DISTINCT FROM FALSE THEN 'UPSERT' ELSE 'DELETE' END,
      p.entity_version,
      TO_JSONB(p),
      COALESCE(p.selling_rate_updated_at, p.created_at, CURRENT_TIMESTAMP)
    FROM products p
    WHERE NOT EXISTS (
      SELECT 1 FROM sync_change_log scl
      WHERE scl.entity_type = 'product' AND scl.entity_id = p.global_id
    );
  `);
};

const processedAckFromRow = (row) => ({
  operation_id: row.operation_id,
  status: row.result_status,
  server_entity_version: row.result_payload?.server_entity_version || null,
  server_updated_at: row.result_payload?.server_updated_at || row.processed_at,
  error_code: row.result_payload?.error_code || null,
  message: row.result_payload?.message || "Already processed",
});

const storeProcessedOperation = async (client, operation, deviceId, ack) => {
  await client.query(
    `
    INSERT INTO sync_processed_operations (
      operation_id, device_id, entity_type, entity_id, result_status, result_payload, processed_at
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, CURRENT_TIMESTAMP)
    ON CONFLICT (operation_id) DO NOTHING
    `,
    [
      operation.operation_id,
      deviceId,
      operation.entity_type,
      operation.entity_id,
      ack.status,
      JSON.stringify({
        ...ack,
        server_entity_version: ack.server_entity_version || null,
        server_updated_at: ack.server_updated_at || new Date().toISOString(),
      }),
    ]
  );
};

const rejectOperation = (operation, errorCode, message) => ({
  operation_id: operation.operation_id,
  status: errorCode === "CONFLICT" ? "conflict" : "rejected",
  server_entity_version: null,
  server_updated_at: new Date().toISOString(),
  error_code: errorCode,
  message,
});

const processSyncTestOperation = async (client, operation, context) => {
  const payload = operation.payload || {};
  const value = cleanText(payload.value);
  if (!value) return rejectOperation(operation, "VALIDATION_ERROR", "sync_test.value is required");
  if (operation.operation_type === "DELETE") {
    const result = await client.query(
      `
      UPDATE sync_test_entities
      SET deleted_at = CURRENT_TIMESTAMP,
          entity_version = entity_version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND branch_id = $2
      RETURNING *
      `,
      [operation.entity_id, context.branchId]
    );
    const row = result.rows[0];
    if (!row) return rejectOperation(operation, "NOT_FOUND", "Sync test entity not found");
    const change = await logSyncChange(client, {
      branchId: context.branchId,
      entityType: "sync_test",
      entityId: row.id,
      operationType: "DELETE",
      version: row.entity_version,
      payload: row,
    });
    return {
      operation_id: operation.operation_id,
      status: "accepted",
      server_entity_version: row.entity_version,
      server_updated_at: change.created_at,
      error_code: null,
      message: "Deleted",
    };
  }
  const result = await client.query(
    `
    INSERT INTO sync_test_entities (id, branch_id, device_id, value, entity_version, updated_at)
    VALUES ($1, $2, $3, $4, 1, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE
    SET value = EXCLUDED.value,
        device_id = EXCLUDED.device_id,
        entity_version = sync_test_entities.entity_version + 1,
        deleted_at = NULL,
        updated_at = CURRENT_TIMESTAMP
    RETURNING *
    `,
    [operation.entity_id, context.branchId, context.deviceId, value]
  );
  const row = result.rows[0];
  const change = await logSyncChange(client, {
    branchId: context.branchId,
    entityType: "sync_test",
    entityId: row.id,
    operationType: "UPSERT",
    version: row.entity_version,
    payload: row,
  });
  return {
    operation_id: operation.operation_id,
    status: "accepted",
    server_entity_version: row.entity_version,
    server_updated_at: change.created_at,
    error_code: null,
    message: "Accepted",
  };
};

const normalizeSyncSaleItems = async (client, items = []) => {
  const normalized = [];
  for (const item of Array.isArray(items) ? items : []) {
    const lotId = parsePositiveInteger(item.inventory_batch_id || item.lot_id);
    let productId = parsePositiveInteger(item.product_id);
    if (!productId) {
      const productKey = cleanText(item.product_id);
      if (productKey) {
        const productResult = await client.query(
          "SELECT id FROM products WHERE global_id = $1 OR id::text = $1 LIMIT 1",
          [productKey]
        );
        productId = parsePositiveInteger(productResult.rows[0]?.id);
      }
    }
    if (!productId && lotId) {
      const lotResult = await client.query("SELECT product_id FROM inventory_batches WHERE id = $1 LIMIT 1", [lotId]);
      productId = parsePositiveInteger(lotResult.rows[0]?.product_id);
    }
    normalized.push({
      ...item,
      product_id: productId,
      inventory_batch_id: lotId,
      lot_id: lotId,
      selling_rate: item.selling_rate ?? item.rate,
      discount_amount: item.discount_amount ?? item.discount ?? 0,
    });
  }
  return normalized;
};

const syncSaleEnvelope = (operation) => {
  const payload = operation.payload || {};
  const sale = payload.sale || {};
  const invoice = sale.invoice || payload.invoice || {};
  const oldInvoice = payload.old_snapshot?.invoice || {};
  const invoiceGlobalId = cleanText(
    invoice.invoice_global_id ||
    invoice.id ||
    oldInvoice.invoice_global_id ||
    oldInvoice.id ||
    payload.invoice_global_id ||
    operation.entity_id
  );
  const offlineInvoiceRef = cleanText(
    invoice.offline_invoice_ref ||
    oldInvoice.offline_invoice_ref ||
    payload.offline_invoice_ref
  );
  return {
    payload,
    sale,
    invoice,
    invoiceGlobalId,
    offlineInvoiceRef,
    reason: cleanText(payload.reason || invoice.edit_reason || invoice.cancellation_reason),
    version: Number(payload.new_version || invoice.entity_version || operation.version || 1),
  };
};

const findSyncedSaleForOperation = async (client, operation) => {
  const { invoiceGlobalId, offlineInvoiceRef } = syncSaleEnvelope(operation);
  if (!invoiceGlobalId && !offlineInvoiceRef) return null;
  const result = await client.query(
    `
    SELECT *
    FROM sales
    WHERE ($1 <> '' AND global_id = $1)
       OR ($2 <> '' AND offline_invoice_ref = $2)
    ORDER BY id DESC
    LIMIT 1
    FOR UPDATE
    `,
    [invoiceGlobalId, offlineInvoiceRef]
  );
  return result.rows[0] || null;
};

const processPosSaleFoundationOperation = async (client, operation, context) => {
  const payload = operation.payload || {};
  const invoiceGlobalId = cleanText(payload.invoice_global_id || operation.entity_id);
  const offlineInvoiceRef = cleanText(payload.offline_invoice_ref);
  if (!invoiceGlobalId || !offlineInvoiceRef) {
    return rejectOperation(operation, "VALIDATION_ERROR", "POS sale requires invoice_global_id and offline_invoice_ref");
  }
  if (!Array.isArray(payload.items) || payload.items.length === 0) {
    return rejectOperation(operation, "VALIDATION_ERROR", "POS sale requires at least one item");
  }
  const existingSale = await client.query(
    "SELECT id, invoice_no, entity_version, created_at FROM sales WHERE global_id = $1 OR offline_invoice_ref = $2 LIMIT 1",
    [invoiceGlobalId, offlineInvoiceRef]
  );
  if (existingSale.rows[0]) {
    return {
      operation_id: operation.operation_id,
      status: "accepted",
      server_entity_version: existingSale.rows[0].entity_version || 1,
      server_updated_at: existingSale.rows[0].created_at,
      error_code: null,
      message: "POS sale already exists on server",
      result_payload: {
        sale_id: existingSale.rows[0].id,
        invoice_no: existingSale.rows[0].invoice_no,
        duplicate: true,
      },
    };
  }
  const duplicate = await client.query(
    "SELECT * FROM sync_pos_sale_staging WHERE invoice_global_id = $1 OR offline_invoice_ref = $2 LIMIT 1",
    [invoiceGlobalId, offlineInvoiceRef]
  );
  if (duplicate.rows[0]) {
    return {
      operation_id: operation.operation_id,
      status: "accepted",
      server_entity_version: duplicate.rows[0].entity_version,
      server_updated_at: duplicate.rows[0].updated_at,
      error_code: null,
      message: "POS sale foundation already staged",
    };
  }

  const conflict = async (reason, serverPayload = {}) => {
    await client.query(
      `
      INSERT INTO sync_conflict_log (
        operation_id, device_id, branch_id, entity_type, entity_id,
        local_version, server_version, local_payload, server_payload, reason
      )
      VALUES ($1, $2, $3, 'pos_sale', $4, $5, $6, $7::jsonb, $8::jsonb, $9)
      `,
      [
        operation.operation_id,
        context.deviceId,
        context.branchId,
        invoiceGlobalId,
        operation.version || 1,
        null,
        JSON.stringify(payload),
        JSON.stringify(serverPayload),
        reason,
      ]
    );
    return rejectOperation(operation, "CONFLICT", reason);
  };

  const invalidItem = payload.items.find((item) => Number(item.quantity || 0) <= 0);
  if (invalidItem) return conflict("Invalid POS item quantity; invoice retained locally for review");

  const normalizedItems = await normalizeSyncSaleItems(client, payload.items);
  const stockRequests = new Map();
  for (const item of normalizedItems) {
    const lotId = parsePositiveInteger(item.inventory_batch_id || item.lot_id);
    const productId = parsePositiveInteger(item.product_id);
    const quantity = parsePositiveNumber(item.quantity);
    if (!lotId || !productId || !quantity) {
      return rejectOperation(operation, "VALIDATION_ERROR", "POS sale items require product, lot and quantity");
    }
    const key = String(lotId);
    const existing = stockRequests.get(key) || { lotId, productId, quantity: 0 };
    existing.quantity += quantity;
    stockRequests.set(key, existing);
  }
  const lotIds = [...stockRequests.values()].map((request) => request.lotId);
  const lotsResult = await client.query(
    "SELECT id, product_id, remaining_qty FROM inventory_batches WHERE id = ANY($1::int[]) AND branch_id = $2 FOR UPDATE",
    [lotIds, context.branchId]
  );
  const lotsById = new Map(lotsResult.rows.map((row) => [Number(row.id), row]));
  for (const request of stockRequests.values()) {
    const lot = lotsById.get(request.lotId);
    if (!lot || Number(lot.product_id) !== Number(request.productId)) {
      return conflict("Server lot is unavailable or belongs to another product", { lot_id: request.lotId });
    }
    if (Number(lot.remaining_qty || 0) < request.quantity) {
      return conflict("Server stock is insufficient; local invoice retained for owner review", {
        lot_id: request.lotId,
        requested_quantity: request.quantity,
        available_quantity: Number(lot.remaining_qty || 0),
      });
    }
  }

  const salePayload = await buildSalePayload(client, {
    items: normalizedItems.map((item) => ({
      product_id: item.product_id,
      inventory_batch_id: item.inventory_batch_id || item.lot_id,
      quantity: item.quantity,
      selling_rate: item.selling_rate ?? item.rate,
      discount_amount: item.discount_amount ?? item.discount ?? 0,
      lot_discount_id: item.lot_discount_id || null,
      lot_discount_type: item.lot_discount_type || null,
      lot_discount_value: item.lot_discount_value || 0,
    })),
    branchId: context.branchId,
    createdBy: context.user.id,
    customer: payload.customer || {},
    invoiceDiscount: payload.bill_discount_total || payload.invoice_discount || 0,
    payments: payload.payments || [],
    allowRateOverride: true,
  });
  if (salePayload.error) {
    if (salePayload.error.status === 409) {
      return conflict(salePayload.error.message || "POS sale conflict; invoice retained locally for review", salePayload.error);
    }
    return rejectOperation(operation, "VALIDATION_ERROR", salePayload.error.message || "POS sale validation failed");
  }

  const transactionDate = toBusinessDateKey(payload.bill_date || payload.bill_datetime || new Date());
  const requestedBillDateTime = cleanText(payload.bill_datetime) || `${transactionDate}T00:00`;
  const saleResult = await client.query(
    `
    INSERT INTO sales (
      total_amount, total_cost, profit, branch_id, created_by, customer_id,
      customer_name, customer_mobile, customer_notes, payment_mode,
      gross_amount, item_discount_amount, invoice_discount_amount, tax_amount,
      taxable_amount, mandi_tax_rate, mandi_tax_basis, mandi_tax_effective_date, tax_config_snapshot,
      discount_rule_id, discount_rule_name, discount_rule_type, discount_rule_value,
      discount_rule_payment_mode, profit_status, sale_date, transaction_date,
      bill_datetime, backdated_bill, backdate_reason, due_date, credit_remarks, credit_status,
      global_id, offline_invoice_ref, source_device_id, entity_version
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
            $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31,
            $32, $33, $34, $35, $36, 1)
    RETURNING *
    `,
    [
      salePayload.totalAmount,
      salePayload.totalCost,
      salePayload.profit,
      context.branchId,
      context.user.id,
      salePayload.customerId,
      salePayload.customerName,
      salePayload.customerMobile,
      salePayload.customerNotes,
      salePayload.paymentMode,
      salePayload.grossAmount,
      salePayload.itemDiscountAmount,
      salePayload.invoiceDiscountAmount,
      salePayload.taxAmount,
      salePayload.taxableAmount || 0,
      salePayload.mandiTaxRate || 0,
      salePayload.mandiTaxBasis || null,
      salePayload.mandiTaxEffectiveDate || null,
      JSON.stringify(salePayload.taxConfigSnapshot || null),
      salePayload.discountRule?.id || null,
      salePayload.discountRule?.rule_name || null,
      salePayload.discountRule?.discount_type || null,
      salePayload.discountRule?.discount_value || 0,
      salePayload.discountRule?.payment_mode || null,
      salePayload.invoiceItems.some((item) => item.costStatus === "PROVISIONAL") ? "PROVISIONAL" : "FINAL",
      transactionDate,
      transactionDate,
      requestedBillDateTime,
      transactionDate < toDateKey(new Date()),
      cleanText(payload.date_override_reason) || (transactionDate < toDateKey(new Date()) ? "Backdated offline POS bill synced" : null),
      payload.credit_due_date ? toBusinessDateKey(payload.credit_due_date) : null,
      nullableText(payload.credit_remarks),
      salePayload.paymentMode === "CREDIT" ? "PENDING" : "PAID",
      invoiceGlobalId,
      offlineInvoiceRef,
      context.deviceId,
    ]
  );
  const sale = saleResult.rows[0];
  const invoiceNo = `FZ-${toDateKey(sale.sale_date).replaceAll("-", "")}-${String(sale.id).padStart(6, "0")}`;
  await client.query("UPDATE sales SET invoice_no = $1 WHERE id = $2", [invoiceNo, sale.id]);

  for (const item of salePayload.invoiceItems) {
    const subtotalAfterItemDiscounts = Math.max(salePayload.grossAmount - salePayload.itemDiscountAmount, 0);
    const invoiceDiscountShare = subtotalAfterItemDiscounts === 0
      ? 0
      : roundCurrency(salePayload.invoiceDiscountAmount * (item.netAmount / subtotalAfterItemDiscounts));
    const itemProfit = roundCurrency(item.netAmount - invoiceDiscountShare - item.costAmount);
    const saleItemResult = await client.query(
      `
      INSERT INTO sale_items (
        sale_id, product_id, quantity, selling_rate, amount, discount_amount, net_amount,
        cost_amount, profit, cost_status, default_selling_rate, manual_rate_override,
        lot_discount_id, lot_discount_type, lot_discount_value
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id
      `,
      [
        sale.id,
        item.productId,
        item.quantity,
        item.sellingRate,
        item.grossAmount,
        item.discountAmount,
        item.netAmount,
        item.costAmount,
        itemProfit,
        item.costStatus,
        item.defaultSellingRate,
        item.manualRateOverride,
        item.lotDiscountId || null,
        item.lotDiscountType || null,
        item.lotDiscountValue || 0,
      ]
    );
    const saleItemId = saleItemResult.rows[0].id;
    for (const allocation of item.allocations) {
      await client.query(
        `
        INSERT INTO sale_batch_allocations (
          sale_item_id, inventory_batch_id, quantity, purchase_rate, cost_amount
        )
        VALUES ($1, $2, $3, $4, $5)
        `,
        [saleItemId, allocation.inventoryBatchId, allocation.quantity, allocation.purchaseRate, allocation.costAmount]
      );
    }
    await client.query(
      `
      INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
      VALUES ($1, $2, 'OUT', $3, $4, $5)
      `,
      [item.productId, item.quantity, `Offline invoice ${offlineInvoiceRef} synced as ${invoiceNo}`, context.user.id, context.branchId]
    );
  }

  for (const payment of salePayload.payments.filter((entry) => entry.mode !== "CREDIT")) {
    await insertSalePaymentAllocation(client, {
      saleId: sale.id,
      payment,
      userId: context.user.id,
      branchId: context.branchId,
      deviceId: context.deviceId,
    });
  }

  await insertCustomerLedgerEntry(
    client,
    { ...sale, invoice_no: invoiceNo, customer_name: salePayload.customerName, customer_mobile: salePayload.customerMobile },
    "SALE",
    salePayload.totalAmount,
    context.user.id,
    `Offline invoice ${offlineInvoiceRef} synced as ${invoiceNo}`
  );

  const result = await client.query(
    `
    INSERT INTO sync_pos_sale_staging (
      invoice_global_id, offline_invoice_ref, branch_id, device_id, created_by, payload, result_status
    )
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'live_sale_created')
    RETURNING *
    `,
    [invoiceGlobalId, offlineInvoiceRef, context.branchId, context.deviceId, context.user.id, JSON.stringify(payload)]
  );
  const row = result.rows[0];
  const change = await logSyncChange(client, {
    branchId: context.branchId,
    entityType: "pos_sale",
    entityId: invoiceGlobalId,
    operationType: "UPSERT",
    version: sale.entity_version || row.entity_version || 1,
    payload: { ...sale, invoice_no: invoiceNo, offline_invoice_ref: offlineInvoiceRef },
  });
  return {
    operation_id: operation.operation_id,
    status: "accepted",
    server_entity_version: sale.entity_version || row.entity_version || 1,
    server_updated_at: change.created_at || row.updated_at,
    error_code: null,
    message: "POS sale synced",
    result_payload: {
      sale_id: sale.id,
      invoice_no: invoiceNo,
      offline_invoice_ref: offlineInvoiceRef,
    },
  };
};

const processPosSaleEditOperation = async (client, operation, context) => {
  const envelope = syncSaleEnvelope(operation);
  const { payload, sale, invoice, invoiceGlobalId, offlineInvoiceRef, reason, version } = envelope;
  if (!reason) return rejectOperation(operation, "VALIDATION_ERROR", "Offline sale edit requires a reason");
  const editor = await getSalePermissionUser(context.user.id, "edit", client);
  if (!editor) return rejectOperation(operation, "AUTHORIZATION_ERROR", "Sync user is not allowed to edit sales");
  const currentSale = await findSyncedSaleForOperation(client, operation);
  if (!currentSale) {
    return rejectOperation(operation, "DEPENDENCY_MISSING", "Original offline sale must sync before its edit can be applied");
  }
  if (currentSale.sale_status === "CANCELLED") {
    return rejectOperation(operation, "CONFLICT", "Cancelled invoices cannot be edited");
  }
  if (Number(currentSale.entity_version || 1) >= version && currentSale.sale_status === "EDITED") {
    return {
      operation_id: operation.operation_id,
      status: "accepted",
      server_entity_version: currentSale.entity_version || version,
      server_updated_at: currentSale.edited_at || currentSale.created_at,
      error_code: null,
      message: "Offline sale edit already applied",
      result_payload: { sale_id: currentSale.id, invoice_no: currentSale.invoice_no, offline_invoice_ref: offlineInvoiceRef, duplicate: true },
    };
  }

  const requestedSaleDate = invoice.bill_date || invoice.sale_date
    ? toBusinessDateKey(invoice.bill_date || invoice.sale_date)
    : toDateKey(currentSale.sale_date);
  const editedInvoiceNo = `FZ-${requestedSaleDate.replaceAll("-", "")}-${String(currentSale.id).padStart(6, "0")}`;
  const oldSnapshot = await getSaleSnapshot(client, currentSale.id);
  await restoreSaleInventory(client, currentSale.id, editor.id, "Offline edit reversal for invoice", "IN");
  await client.query("DELETE FROM sale_batch_allocations WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id = $1)", [currentSale.id]);
  await client.query("DELETE FROM sale_items WHERE sale_id = $1", [currentSale.id]);
  await client.query("DELETE FROM sale_payments WHERE sale_id = $1", [currentSale.id]);

  const normalizedItems = await normalizeSyncSaleItems(client, sale.items || payload.items);
  const salePayload = await buildSalePayload(client, {
    items: normalizedItems,
    branchId: parsePositiveInteger(invoice.branch_id) || context.branchId,
    createdBy: editor.id,
    customer: {
      account_id: invoice.customer_id || "",
      name: invoice.customer_name || "",
      mobile: invoice.customer_mobile || "",
      notes: invoice.customer_notes || "",
    },
    invoiceDiscount: invoice.bill_discount_total || invoice.invoice_discount_amount || 0,
    payments: (sale.payments || []).filter((payment) => payment.posting_type !== "PAYMENT_REVERSAL"),
    allowRateOverride: ["Owner", "Admin"].includes(editor.role_name),
  });
  if (salePayload.error) {
    return rejectOperation(operation, salePayload.error.status === 409 ? "CONFLICT" : "VALIDATION_ERROR", salePayload.error.message || "Offline sale edit validation failed");
  }

  const updateResult = await client.query(
    `
    UPDATE sales
    SET
      total_amount = $1,
      total_cost = $2,
      profit = $3,
      branch_id = $4,
      customer_id = $5,
      customer_name = $6,
      customer_mobile = $7,
      customer_notes = $8,
      payment_mode = $9,
      gross_amount = $10,
      item_discount_amount = $11,
      invoice_discount_amount = $12,
      tax_amount = $13,
      taxable_amount = $14,
      mandi_tax_rate = $15,
      mandi_tax_basis = $16,
      mandi_tax_effective_date = $17,
      tax_config_snapshot = $18::jsonb,
      discount_rule_id = $19,
      discount_rule_name = $20,
      discount_rule_type = $21,
      discount_rule_value = $22,
      discount_rule_payment_mode = $23,
      sale_date = $24,
      transaction_date = $24,
      bill_datetime = COALESCE($27::timestamp, bill_datetime),
      invoice_no = $29,
      sale_status = 'EDITED',
      edited_by = $25,
      edited_at = CURRENT_TIMESTAMP,
      edit_reason = $26,
      entity_version = GREATEST(COALESCE(entity_version, 1), $30)
    WHERE id = $28
    RETURNING *
    `,
    [
      salePayload.totalAmount, salePayload.totalCost, salePayload.profit, salePayload.branchId,
      salePayload.customerId, salePayload.customerName, salePayload.customerMobile, salePayload.customerNotes, salePayload.paymentMode,
      salePayload.grossAmount, salePayload.itemDiscountAmount, salePayload.invoiceDiscountAmount, salePayload.taxAmount,
      salePayload.taxableAmount || 0,
      salePayload.mandiTaxRate || 0,
      salePayload.mandiTaxBasis || null,
      salePayload.mandiTaxEffectiveDate || null,
      JSON.stringify(salePayload.taxConfigSnapshot || null),
      salePayload.discountRule?.id || null, salePayload.discountRule?.rule_name || null,
      salePayload.discountRule?.discount_type || null, salePayload.discountRule?.discount_value || 0,
      salePayload.discountRule?.payment_mode || null,
      requestedSaleDate,
      editor.id,
      reason,
      invoice.bill_datetime || `${requestedSaleDate}T00:00`,
      currentSale.id,
      editedInvoiceNo,
      version,
    ]
  );
  const updatedSale = updateResult.rows[0];

  for (const item of salePayload.invoiceItems) {
    const subtotalAfterItemDiscounts = Math.max(salePayload.grossAmount - salePayload.itemDiscountAmount, 0);
    const invoiceDiscountShare = subtotalAfterItemDiscounts === 0
      ? 0
      : roundCurrency(salePayload.invoiceDiscountAmount * (item.netAmount / subtotalAfterItemDiscounts));
    const itemProfit = roundCurrency(item.netAmount - invoiceDiscountShare - item.costAmount);
    const saleItemResult = await client.query(
      `
      INSERT INTO sale_items (
        sale_id, product_id, quantity, selling_rate, amount, discount_amount, net_amount,
        cost_amount, profit, cost_status, default_selling_rate, manual_rate_override,
        lot_discount_id, lot_discount_type, lot_discount_value
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id
      `,
      [
        currentSale.id, item.productId, item.quantity, item.sellingRate, item.grossAmount,
        item.discountAmount, item.netAmount, item.costAmount, itemProfit,
        item.costStatus, item.defaultSellingRate, item.manualRateOverride,
        item.lotDiscountId || null, item.lotDiscountType || null, item.lotDiscountValue || 0,
      ]
    );
    const saleItemId = saleItemResult.rows[0].id;
    for (const allocation of item.allocations) {
      await client.query(
        `
        INSERT INTO sale_batch_allocations (
          sale_item_id, inventory_batch_id, quantity, purchase_rate, cost_amount
        )
        VALUES ($1, $2, $3, $4, $5)
        `,
        [saleItemId, allocation.inventoryBatchId, allocation.quantity, allocation.purchaseRate, allocation.costAmount]
      );
    }
    await client.query(
      `
      INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
      VALUES ($1, $2, 'OUT', $3, $4, $5)
      `,
      [item.productId, item.quantity, `Offline edit synced for invoice ${updatedSale.invoice_no}`, editor.id, salePayload.branchId]
    );
  }

  for (const payment of salePayload.payments) {
    await insertSalePaymentAllocation(client, {
      saleId: currentSale.id,
      payment,
      userId: editor.id,
      branchId: salePayload.branchId,
      deviceId: context.deviceId,
    });
  }
  await client.query(
    `
    INSERT INTO sale_audit_trail (sale_id, action, field_name, old_value, new_value, reason, edited_by)
    VALUES ($1, 'EDIT', 'offline_sync_invoice', $2::jsonb, $3::jsonb, $4, $5)
    `,
    [currentSale.id, JSON.stringify(oldSnapshot), JSON.stringify(await getSaleSnapshot(client, currentSale.id)), reason, editor.id]
  );
  const customerChanged = String(currentSale.customer_id || "") !== String(salePayload.customerId || "")
    || String(currentSale.customer_name || "") !== String(salePayload.customerName || "");
  const delta = roundCurrency(salePayload.totalAmount - Number(currentSale.total_amount || 0));
  if (customerChanged) {
    await insertCustomerLedgerEntry(
      client,
      currentSale,
      "SALE_EDIT_CREDIT",
      Number(currentSale.total_amount || 0),
      editor.id,
      `Invoice ${updatedSale.invoice_no} customer changed during offline sync edit: ${reason}`
    );
    await insertCustomerLedgerEntry(
      client,
      updatedSale,
      "SALE_EDIT_DEBIT",
      salePayload.totalAmount,
      editor.id,
      `Invoice ${updatedSale.invoice_no} moved to selected customer during offline sync edit: ${reason}`
    );
  } else if (delta !== 0 || salePayload.customerMobile || salePayload.customerName) {
    await insertCustomerLedgerEntry(
      client,
      updatedSale,
      delta >= 0 ? "SALE_EDIT_DEBIT" : "SALE_EDIT_CREDIT",
      delta,
      editor.id,
      `Offline invoice ${updatedSale.invoice_no} edited during sync: ${reason}`
    );
  }
  const change = await logSyncChange(client, {
    branchId: context.branchId,
    entityType: "pos_sale",
    entityId: invoiceGlobalId || operation.entity_id,
    operationType: "SALE_EDIT",
    version: updatedSale.entity_version || version,
    payload: { ...updatedSale, offline_invoice_ref: offlineInvoiceRef },
  });
  return {
    operation_id: operation.operation_id,
    status: "accepted",
    server_entity_version: updatedSale.entity_version || version,
    server_updated_at: change.created_at || updatedSale.edited_at,
    error_code: null,
    message: "Offline sale edit synced",
    result_payload: { sale_id: updatedSale.id, invoice_no: updatedSale.invoice_no, offline_invoice_ref: offlineInvoiceRef },
  };
};

const processPosSaleCancelOperation = async (client, operation, context) => {
  const { payload, invoice, invoiceGlobalId, offlineInvoiceRef, reason, version } = syncSaleEnvelope(operation);
  const cancelReason = reason || "Offline invoice cancelled";
  const canceller = await getSalePermissionUser(context.user.id, "cancel", client);
  if (!canceller) return rejectOperation(operation, "AUTHORIZATION_ERROR", "Sync user is not allowed to cancel sales");
  const currentSale = await findSyncedSaleForOperation(client, operation);
  if (!currentSale) {
    return rejectOperation(operation, "DEPENDENCY_MISSING", "Original offline sale must sync before its cancellation can be applied");
  }
  if (currentSale.sale_status === "CANCELLED") {
    return {
      operation_id: operation.operation_id,
      status: "accepted",
      server_entity_version: currentSale.entity_version || version,
      server_updated_at: currentSale.cancelled_at || currentSale.created_at,
      error_code: null,
      message: "Offline sale cancellation already applied",
      result_payload: { sale_id: currentSale.id, invoice_no: currentSale.invoice_no, offline_invoice_ref: offlineInvoiceRef, duplicate: true },
    };
  }
  const oldSnapshot = await getSaleSnapshot(client, currentSale.id);
  await restoreSaleInventory(client, currentSale.id, canceller.id, "Offline cancellation reversal for invoice", "IN");
  await client.query("DELETE FROM sale_batch_allocations WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id = $1)", [currentSale.id]);
  await client.query("UPDATE sale_payments SET status = 'REVERSED' WHERE sale_id = $1", [currentSale.id]);
  const updateResult = await client.query(
    `
    UPDATE sales
    SET sale_status = 'CANCELLED',
        cancelled_by = $1,
        cancelled_at = COALESCE($2::timestamp, CURRENT_TIMESTAMP),
        cancellation_reason = $3,
        entity_version = GREATEST(COALESCE(entity_version, 1), $5)
    WHERE id = $4
    RETURNING *
    `,
    [canceller.id, invoice.cancelled_at || payload.cancelled_at || null, cancelReason, currentSale.id, version]
  );
  const cancelledSale = updateResult.rows[0];
  await client.query(
    `
    INSERT INTO sale_audit_trail (sale_id, action, field_name, old_value, new_value, reason, edited_by)
    VALUES ($1, 'CANCEL', 'offline_sync_invoice', $2::jsonb, $3::jsonb, $4, $5)
    `,
    [currentSale.id, JSON.stringify(oldSnapshot), JSON.stringify(await getSaleSnapshot(client, currentSale.id)), cancelReason, canceller.id]
  );
  await insertCustomerLedgerEntry(
    client,
    cancelledSale,
    "SALE_CANCELLED",
    Number(currentSale.total_amount || 0),
    canceller.id,
    `Offline invoice ${cancelledSale.invoice_no} cancelled during sync: ${cancelReason}`
  );
  const change = await logSyncChange(client, {
    branchId: context.branchId,
    entityType: "pos_sale",
    entityId: invoiceGlobalId || operation.entity_id,
    operationType: "SALE_CANCEL",
    version: cancelledSale.entity_version || version,
    payload: { ...cancelledSale, offline_invoice_ref: offlineInvoiceRef },
  });
  return {
    operation_id: operation.operation_id,
    status: "accepted",
    server_entity_version: cancelledSale.entity_version || version,
    server_updated_at: change.created_at || cancelledSale.cancelled_at,
    error_code: null,
    message: "Offline sale cancellation synced",
    result_payload: { sale_id: cancelledSale.id, invoice_no: cancelledSale.invoice_no, offline_invoice_ref: offlineInvoiceRef },
  };
};

const processSyncOperation = async (client, operation, context) => {
  if (!operation || typeof operation !== "object") {
    return rejectOperation({ operation_id: "" }, "VALIDATION_ERROR", "Invalid operation");
  }
  operation.operation_id = cleanText(operation.operation_id);
  operation.entity_type = cleanText(operation.entity_type);
  operation.entity_id = cleanText(operation.entity_id);
  operation.operation_type = cleanText(operation.operation_type || "UPSERT").toUpperCase();
  operation.version = Number(operation.version || operation.entity_version || 1);
  if (!operation.operation_id || !operation.entity_type || !operation.entity_id) {
    return rejectOperation(operation, "VALIDATION_ERROR", "operation_id, entity_type and entity_id are required");
  }
  if (!SYNC_ENTITY_TYPES.has(operation.entity_type)) {
    return rejectOperation(operation, "UNSUPPORTED_ENTITY", `Unsupported Phase 2 sync entity: ${operation.entity_type}`);
  }
  if (!SYNC_OPERATION_TYPES.has(operation.operation_type)) {
    return rejectOperation(operation, "UNSUPPORTED_OPERATION", `Unsupported operation type: ${operation.operation_type}`);
  }
  const processed = await client.query(
    "SELECT * FROM sync_processed_operations WHERE operation_id = $1 FOR UPDATE",
    [operation.operation_id]
  );
  if (processed.rows[0]) return processedAckFromRow(processed.rows[0]);
  const ack = operation.entity_type === "sync_test"
    ? await processSyncTestOperation(client, operation, context)
    : operation.operation_type === "SALE_EDIT"
      ? await processPosSaleEditOperation(client, operation, context)
      : operation.operation_type === "SALE_CANCEL"
        ? await processPosSaleCancelOperation(client, operation, context)
        : await processPosSaleFoundationOperation(client, operation, context);
  await storeProcessedOperation(client, operation, context.deviceId, ack);
  return ack;
};

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    return res.json({ status: "ok", server_time: new Date().toISOString() });
  } catch (error) {
    console.error("Health check failed", error.message);
    return res.status(503).json({ status: "error", message: "Backend unavailable" });
  }
});

app.post("/api/sync/register-device", rateLimitSyncRequest, async (req, res) => {
  try {
    const device = readDevicePayload({
      ...req.body,
      device_type: req.body.platform || req.body.device_type || "Desktop",
    }, req);
    if (!device.device_id) return res.status(400).json({ message: "device_id is required" });
    const saved = await upsertDeviceRequest(device);
    await pool.query(
      `
      UPDATE authorized_devices
      SET platform = $2,
          app_version = $3,
          updated_at = CURRENT_TIMESTAMP
      WHERE device_id = $1
      `,
      [device.device_id, cleanText(req.body.platform) || device.device_type, cleanText(req.body.app_version) || "1.0.0"]
    );
    return res.json({
      device_id: saved.device_id,
      status: saved.status,
      branch_id: saved.assigned_branch_id || 1,
      message: saved.status === "APPROVED" ? "Device registered" : "Device pending approval",
    });
  } catch (error) {
    console.error("Device sync registration failed", error.message);
    return res.status(500).json({ message: "Device registration failed" });
  }
});

app.post("/api/sync/push", rateLimitSyncRequest, async (req, res) => {
  const client = await pool.connect();
  try {
    const operations = Array.isArray(req.body.operations) ? req.body.operations : [];
    if (operations.length > 100) return res.status(413).json({ message: "Sync push batch is too large" });
    await client.query("BEGIN");
    const context = await requireSyncContext({
      userId: req.body.user_id,
      deviceId: req.body.device_id,
      branchId: req.body.branch_id,
    }, client);
    if (context.error) {
      await client.query("ROLLBACK");
      return res.status(context.error.status).json({ message: context.error.message });
    }
    const sorted = [...operations].sort((a, b) =>
      String(a.created_at || "").localeCompare(String(b.created_at || "")) ||
      String(a.operation_id || "").localeCompare(String(b.operation_id || ""))
    );
    const acknowledgements = [];
    for (const operation of sorted) {
      const ack = await processSyncOperation(client, operation, context);
      acknowledgements.push(ack);
    }
    await client.query(
      "UPDATE authorized_devices SET last_sync_at = CURRENT_TIMESTAMP, sync_status = 'PUSHED', updated_at = CURRENT_TIMESTAMP WHERE device_id = $1",
      [context.deviceId]
    );
    await client.query("COMMIT");
    return res.json({
      device_id: context.deviceId,
      branch_id: context.branchId,
      server_time: new Date().toISOString(),
      acknowledgements,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Sync push failed", error.message);
    return res.status(500).json({ message: "Sync push failed" });
  } finally {
    client.release();
  }
});

app.get("/api/sync/pull", rateLimitSyncRequest, async (req, res) => {
  try {
    const context = await requireSyncContext({
      userId: req.query.user_id,
      deviceId: req.query.device_id,
      branchId: req.query.branch_id,
    });
    if (context.error) return res.status(context.error.status).json({ message: context.error.message });
    const cursor = Math.max(0, Number(req.query.cursor || 0));
    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 50)));
    const result = await pool.query(
      `
      SELECT change_id, branch_id, entity_type, entity_id, operation_type,
             entity_version AS version, payload, created_at AS updated_at
      FROM sync_change_log
      WHERE branch_id = $1
        AND change_id > $2
      ORDER BY change_id
      LIMIT $3
      `,
      [context.branchId, cursor, limit + 1]
    );
    const rows = result.rows.slice(0, limit);
    const nextCursor = rows.length ? String(rows[rows.length - 1].change_id) : String(cursor);
    await pool.query(
      "UPDATE authorized_devices SET last_sync_at = CURRENT_TIMESTAMP, sync_status = 'PULLED', updated_at = CURRENT_TIMESTAMP WHERE device_id = $1",
      [context.deviceId]
    );
    return res.json({
      changes: rows,
      next_cursor: nextCursor,
      server_time: new Date().toISOString(),
      has_more: result.rows.length > limit,
    });
  } catch (error) {
    console.error("Sync pull failed", error.message);
    return res.status(500).json({ message: "Sync pull failed" });
  }
});

app.get("/api/sync/status", rateLimitSyncRequest, async (req, res) => {
  try {
    const context = await requireSyncContext({
      userId: req.query.user_id,
      deviceId: req.query.device_id,
      branchId: req.query.branch_id,
    });
    if (context.error) return res.status(context.error.status).json({ message: context.error.message });
    const [processed, conflicts, changes] = await Promise.all([
      pool.query("SELECT COUNT(*)::INTEGER AS count FROM sync_processed_operations WHERE device_id = $1", [context.deviceId]),
      pool.query("SELECT COUNT(*)::INTEGER AS count FROM sync_conflict_log WHERE device_id = $1 AND status = 'open'", [context.deviceId]),
      pool.query("SELECT COALESCE(MAX(change_id), 0)::BIGINT AS cursor FROM sync_change_log WHERE branch_id = $1", [context.branchId]),
    ]);
    return res.json({
      device_id: context.deviceId,
      branch_id: context.branchId,
      processed_operations: processed.rows[0]?.count || 0,
      open_conflicts: conflicts.rows[0]?.count || 0,
      latest_cursor: String(changes.rows[0]?.cursor || 0),
      server_time: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Sync status failed", error.message);
    return res.status(500).json({ message: "Sync status failed" });
  }
});

app.post("/devices/activate", async (req, res) => {
  const client = await pool.connect();
  try {
    const device = readDevicePayload(req.body, req);
    const codeHash = hashActivationCode(req.body.activation_code);
    if (!device.device_id || !codeHash) {
      return res.status(400).json({ message: "Device ID and activation code are required" });
    }
    await client.query("BEGIN");
    await upsertDeviceRequest(device, client);
    const codeResult = await client.query(
      `
      SELECT *
      FROM activation_codes
      WHERE code_hash = $1
        AND status = 'ACTIVE'
        AND expires_at > CURRENT_TIMESTAMP
      FOR UPDATE
      `,
      [codeHash]
    );
    const activationCode = codeResult.rows[0];
    if (!activationCode) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Activation code is invalid, expired or already used" });
    }
    const approvedDevice = await approveDevice({
      deviceId: device.device_id,
      approvedBy: activationCode.created_by,
      branchId: activationCode.branch_id || device.assigned_branch_id || 1,
      counterId: activationCode.counter_id || device.assigned_counter_id,
      reason: "Approved by one-time activation code",
    }, client);
    await client.query(
      `
      UPDATE activation_codes
      SET status = 'USED',
          used_by_device_id = $1,
          used_at = CURRENT_TIMESTAMP
      WHERE id = $2
      `,
      [device.device_id, activationCode.id]
    );
    await client.query("COMMIT");
    return res.json({ success: true, device: approvedDevice });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Device activation failed" });
  } finally {
    client.release();
  }
});

app.put("/settings/devices/:deviceId", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage authorized devices" });
    const deviceId = cleanText(req.params.deviceId);
    const action = cleanText(req.body.action).toUpperCase();
    if (!deviceId || !["APPROVE", "REJECT", "DISABLE", "RENAME"].includes(action)) {
      return res.status(400).json({ message: "Select valid device action" });
    }
    const beforeResult = await pool.query("SELECT * FROM authorized_devices WHERE device_id = $1", [deviceId]);
    if (!beforeResult.rows[0]) return res.status(404).json({ message: "Device not found" });
    let result;
    if (action === "APPROVE") {
      result = { rows: [await approveDevice({
        deviceId,
        approvedBy: manager.id,
        branchId: parsePositiveInteger(req.body.assigned_branch_id) || 1,
        counterId: parsePositiveInteger(req.body.assigned_counter_id),
        reason: cleanText(req.body.reason) || "Owner/Admin approval",
      })] };
    } else if (action === "RENAME") {
      result = await pool.query(
        `
        UPDATE authorized_devices
        SET device_name = COALESCE($2, device_name),
            assigned_branch_id = COALESCE($3, assigned_branch_id),
            assigned_counter_id = COALESCE($4, assigned_counter_id),
            updated_at = CURRENT_TIMESTAMP
        WHERE device_id = $1
        RETURNING *
        `,
        [deviceId, nullableText(req.body.device_name), parsePositiveInteger(req.body.assigned_branch_id), parsePositiveInteger(req.body.assigned_counter_id)]
      );
    } else {
      result = await pool.query(
        `
        UPDATE authorized_devices
        SET status = $2,
            updated_at = CURRENT_TIMESTAMP
        WHERE device_id = $1
        RETURNING *
        `,
        [deviceId, action === "REJECT" ? "REJECTED" : "DISABLED"]
      );
    }
    await pool.query(
      `
      INSERT INTO device_audit_trail (device_id, action, old_value, new_value, reason, changed_by)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
      `,
      [deviceId, action, JSON.stringify(beforeResult.rows[0]), JSON.stringify(result.rows[0]), cleanText(req.body.reason), manager.id]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Device" });
  }
});

app.post("/settings/activation-codes", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.created_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can generate activation codes" });
    const expiresHours = Math.max(Number(req.body.expires_in_hours || 24), 1);
    const code = generateActivationCode();
    const result = await pool.query(
      `
      INSERT INTO activation_codes (
        code_hash, code_label, branch_id, counter_id, created_by, expires_at, status
      )
      VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP + ($6 || ' hours')::interval, 'ACTIVE')
      RETURNING id, code_label, branch_id, counter_id, created_by, created_at, expires_at, status
      `,
      [
        hashActivationCode(code),
        nullableText(req.body.code_label) || "Device activation",
        parsePositiveInteger(req.body.branch_id) || 1,
        parsePositiveInteger(req.body.counter_id),
        manager.id,
        expiresHours,
      ]
    );
    return res.json({ ...result.rows[0], code });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Generating Activation Code" });
  }
});

app.put("/settings/activation-codes/:id/revoke", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can revoke activation codes" });
    const codeId = parsePositiveInteger(req.params.id);
    const result = await pool.query("UPDATE activation_codes SET status = 'REVOKED' WHERE id = $1 RETURNING id", [codeId]);
    return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Activation code not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Revoking Activation Code" });
  }
});

app.post("/settings/branches", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage branches" });
    const result = await pool.query(
      `
      INSERT INTO branches (branch_name, address, phone_number, gst_number, active)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `,
      [cleanText(req.body.branch_name), nullableText(req.body.address), nullableText(req.body.phone_number), nullableText(req.body.gst_number), req.body.active !== false]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Branch" });
  }
});

app.post("/settings/counters", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage counters" });
    const result = await pool.query(
      `
      INSERT INTO counters (branch_id, counter_name, counter_type, active)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [parsePositiveInteger(req.body.branch_id) || 1, cleanText(req.body.counter_name), cleanText(req.body.counter_type) || "RETAIL_COUNTER", req.body.active !== false]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Counter" });
  }
});

app.put("/settings/backup", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.updated_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage backups" });
    const result = await pool.query(
      `
      UPDATE backup_settings
      SET auto_backup_enabled = $1,
          backup_on_shutdown = $2,
          daily_backup_time = $3,
          keep_last_backups = $4,
          backup_location = $5,
          updated_by = $6,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
      RETURNING *
      `,
      [
        req.body.auto_backup_enabled !== false,
        req.body.backup_on_shutdown !== false,
        cleanText(req.body.daily_backup_time) || "23:59",
        Math.max(Number(req.body.keep_last_backups || 30), 1),
        nullableText(req.body.backup_location) || backupDirectory,
        manager.id,
      ]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Backup Settings" });
  }
});

app.post("/settings/backup-now", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.created_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can run backups" });
    const backup = await createDatabaseBackup({ backupType: req.body.backup_type || "Manual", createdBy: manager.id });
    return res.json(backup);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: `Backup failed: ${error.message || "Unknown error"}` });
  }
});

app.post("/settings/safe-shutdown", async (req, res) => {
  try {
    const manager = await requireRateManager(req.body.created_by);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can safely close software" });
    const backup = await createDatabaseBackup({ backupType: "Shutdown", createdBy: manager.id });
    return res.json({
      ...backup,
      message: "Backup completed. You may now close the server window.",
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: `Safe shutdown backup failed: ${error.message || "Unknown error"}` });
  }
});

app.get("/settings/system-info", async (req, res) => {
  try {
    return res.json(await getSystemInfo(req.query.device_id));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading System Info" });
  }
});

app.post("/login", async (req, res) => {
  try {
    const username = cleanText(req.body.username);
    const password = String(req.body.password || "");
    const devicePayload = readDevicePayload(req.body, req);

    const result = await pool.query(
      `
      SELECT
        u.id,
        u.full_name,
        u.username,
        u.password_hash,
        u.mobile_number,
        u.email,
        u.joining_date,
        u.notes,
        u.last_login_at,
        u.branch_id,
        u.active,
        u.force_password_change,
        u.session_revocation_version,
        u.locked_until,
        r.role_name,
        b.branch_name,
        b.active AS branch_active
      FROM users u
      JOIN roles r ON u.role_id = r.id
      JOIN branches b ON u.branch_id = b.id
      WHERE LOWER(u.username) = LOWER($1)
      `,
      [username]
    );

    if (result.rows.length === 0) {
      return authFailure(res, {
        code: "INVALID_CREDENTIALS",
        username,
        deviceId: devicePayload.device_id,
        ipAddress: req.ip,
        details: { stage: "user_lookup" },
      });
    }

    const user = result.rows[0];
    if (user.active === false) {
      return authFailure(res, {
        status: 403,
        code: "USER_DISABLED",
        publicMessage: "This user account is disabled. Contact your Owner or Administrator.",
        userId: user.id,
        username: user.username,
        deviceId: devicePayload.device_id,
        ipAddress: req.ip,
        details: { stage: "user_status" },
      });
    }
    if (user.branch_active === false) {
      return authFailure(res, {
        status: 403,
        code: "BRANCH_ACCESS_DENIED",
        publicMessage: "This branch is not authorised for login.",
        userId: user.id,
        username: user.username,
        deviceId: devicePayload.device_id,
        ipAddress: req.ip,
        details: { stage: "branch_status", branch_id: user.branch_id },
      });
    }
    if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
      return authFailure(res, {
        status: 423,
        code: "USER_LOCKED",
        publicMessage: "This account is temporarily locked. Contact your Owner or Administrator.",
        userId: user.id,
        username: user.username,
        deviceId: devicePayload.device_id,
        ipAddress: req.ip,
        details: { stage: "user_locked" },
      });
    }
    if (!passwordMatches(password, user.password_hash)) {
      return authFailure(res, {
        code: "INVALID_CREDENTIALS",
        publicMessage: "Invalid username or password.",
        userId: user.id,
        username: user.username,
        deviceId: devicePayload.device_id,
        ipAddress: req.ip,
        details: { stage: "password_verification" },
      });
    }
    if (!devicePayload.device_id) {
      return authFailure(res, {
        status: 403,
        code: "DEVICE_ID_REQUIRED",
        publicMessage: "Device ID is required for FroozERP access.",
        userId: user.id,
        username: user.username,
        ipAddress: req.ip,
        details: { stage: "device_identity" },
      });
    }
    let device = await upsertDeviceRequest(devicePayload);
    const approvedCountResult = await pool.query("SELECT COUNT(*)::INTEGER AS count FROM authorized_devices WHERE status = 'APPROVED'");
    const approvedCount = Number(approvedCountResult.rows[0]?.count || 0);
    if (approvedCount === 0 && ["Owner", "Admin"].includes(user.role_name)) {
      device = await approveDevice({
        deviceId: devicePayload.device_id,
        approvedBy: user.id,
        branchId: user.branch_id || 1,
        counterId: devicePayload.assigned_counter_id,
        reason: "Bootstrap approval for first Owner/Admin device",
      });
    }
    if (device.status !== "APPROVED") {
      const deviceStatus = String(device.status || "").toUpperCase();
      const code = deviceStatus === "DISABLED"
        ? "DEVICE_DISABLED"
        : deviceStatus === "REVOKED"
          ? "DEVICE_REVOKED"
          : "DEVICE_PENDING_APPROVAL";
      await writeAuthAudit({
        userId: user.id,
        username: user.username,
        action: "LOGIN_FAILED",
        safeCode: code,
        deviceId: device.device_id,
        ipAddress: req.ip,
        details: { stage: "device_authorisation", device_status: device.status },
      });
      return res.status(403).json({
        code,
        message: code === "DEVICE_DISABLED" || code === "DEVICE_REVOKED"
          ? "This device is disabled for FroozERP access."
          : "This device is pending owner approval.",
        device_id: device.device_id,
        device_status: device.status,
      });
    }
    await pool.query(
      "UPDATE authorized_devices SET last_active_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE device_id = $1",
      [device.device_id]
    );
    const hashed = hashPassword(password);
    await pool.query(
      "UPDATE users SET password_hash = $1, last_login_at = CURRENT_TIMESTAMP WHERE id = $2",
      [hashed, user.id]
    );
    await writeAuthAudit({
      userId: user.id,
      username: user.username,
      action: "LOGIN_SUCCESS",
      safeCode: "OK",
      deviceId: device.device_id,
      ipAddress: req.ip,
      details: { branch_id: user.branch_id, role: user.role_name },
    });

    return res.json({
      id: user.id,
      full_name: user.full_name,
      username: user.username,
      role: user.role_name,
      branch_id: user.branch_id,
      branch: user.branch_name,
      mobile_number: user.mobile_number,
      email: user.email,
      joining_date: user.joining_date,
      notes: user.notes,
      last_login_at: new Date().toISOString(),
      force_password_change: user.force_password_change === true,
      session_revocation_version: user.session_revocation_version || 0,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Login Error" });
  }
});

app.get("/product-categories", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        pc.*,
        COUNT(p.id)::INTEGER AS item_count,
        COALESCE(SUM(CASE WHEN p.active IS DISTINCT FROM FALSE THEN 1 ELSE 0 END), 0)::INTEGER AS active_item_count
      FROM product_categories pc
      LEFT JOIN products p ON p.category_id = pc.id
      GROUP BY pc.id
      ORDER BY pc.active DESC, pc.category_name
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Database Error" });
  }
});

app.post("/product-categories", async (req, res) => {
  const client = await pool.connect();
  try {
    const manager = await requireRateManager(req.body.created_by || req.body.updated_by, client);
    const categoryName = cleanText(req.body.category_name);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage categories" });
    if (!categoryName) return res.status(400).json({ message: "Please enter category name." });
    await client.query("BEGIN");
    const duplicate = await findCategoryByName(client, categoryName);
    if (duplicate) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Category already exists." });
    }
    const result = await client.query(
      `
      INSERT INTO product_categories (global_id, category_name, active, remarks, created_by, updated_by)
      VALUES ($5, $1, $2, $3, $4, $4)
      RETURNING *
      `,
      [categoryName, req.body.active !== false, nullableText(req.body.remarks), manager.id, `category-${crypto.randomUUID()}`]
    );
    await client.query(
      `
      INSERT INTO product_category_audit_trail (category_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'CREATE', NULL, $2::jsonb, $3, $4)
      `,
      [result.rows[0].id, JSON.stringify(result.rows[0]), cleanText(req.body.reason) || "Category created", manager.id]
    );
    await logSyncChange(client, {
      branchId: 1,
      entityType: "product_category",
      entityId: result.rows[0].global_id,
      operationType: "UPSERT",
      version: result.rows[0].entity_version || 1,
      payload: result.rows[0],
    });
    await client.query("COMMIT");
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    if (error.code === "23505") return res.status(409).json({ message: "Category already exists." });
    return res.status(500).json({ message: "Error Saving Category" });
  } finally {
    client.release();
  }
});

app.put("/product-categories/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const categoryId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body.updated_by, client);
    const categoryName = cleanText(req.body.category_name);
    const reason = cleanText(req.body.reason) || "Category updated";
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage categories" });
    if (!categoryId || !categoryName) return res.status(400).json({ message: "Please enter category name." });
    await client.query("BEGIN");
    const currentResult = await client.query("SELECT * FROM product_categories WHERE id = $1 FOR UPDATE", [categoryId]);
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Category not found" });
    }
    const duplicate = await client.query("SELECT id FROM product_categories WHERE LOWER(category_name) = LOWER($1) AND id <> $2 LIMIT 1", [categoryName, categoryId]);
    if (duplicate.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Category already exists." });
    }
    const result = await client.query(
      `
      UPDATE product_categories
      SET category_name = $1, active = $2, remarks = $3, updated_by = $4,
          entity_version = entity_version + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
      `,
      [categoryName, req.body.active !== false, nullableText(req.body.remarks), manager.id, categoryId]
    );
    await client.query("UPDATE products SET category = $1 WHERE category_id = $2", [categoryName, categoryId]);
    await client.query(
      `
      INSERT INTO product_category_audit_trail (category_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [categoryId, JSON.stringify(current), JSON.stringify(result.rows[0]), reason, manager.id]
    );
    await logSyncChange(client, {
      branchId: 1,
      entityType: "product_category",
      entityId: result.rows[0].global_id,
      operationType: "UPSERT",
      version: result.rows[0].entity_version || 1,
      payload: result.rows[0],
    });
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    if (error.code === "23505") return res.status(409).json({ message: "Category already exists." });
    return res.status(500).json({ message: "Error Updating Category" });
  } finally {
    client.release();
  }
});

app.delete("/product-categories/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const categoryId = parsePositiveInteger(req.params.id);
    const manager = await requireRateManager(req.body?.updated_by || req.query.updated_by, client);
    const reason = cleanText(req.body?.reason || req.query.reason) || "Category removed";
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage categories" });
    if (!categoryId) return res.status(400).json({ message: "Invalid category" });
    await client.query("BEGIN");
    const currentResult = await client.query("SELECT * FROM product_categories WHERE id = $1 FOR UPDATE", [categoryId]);
    const current = currentResult.rows[0];
    if (!current) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Category not found" });
    }
    const usageResult = await client.query("SELECT COUNT(*)::INTEGER AS usage_count FROM products WHERE category_id = $1", [categoryId]);
    if (Number(usageResult.rows[0].usage_count || 0) > 0) {
      const result = await client.query("UPDATE product_categories SET active = FALSE, deleted_at = CURRENT_TIMESTAMP, entity_version = entity_version + 1, updated_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *", [manager.id, categoryId]);
      await client.query(
        `
        INSERT INTO product_category_audit_trail (category_id, action, old_value, new_value, reason, edited_by)
        VALUES ($1, 'DEACTIVATE', $2::jsonb, $3::jsonb, $4, $5)
        `,
        [categoryId, JSON.stringify(current), JSON.stringify(result.rows[0]), "This category has items or transactions. It can only be deactivated.", manager.id]
      );
      await logSyncChange(client, {
        branchId: 1,
        entityType: "product_category",
        entityId: result.rows[0].global_id,
        operationType: "DELETE",
        version: result.rows[0].entity_version || 1,
        payload: result.rows[0],
      });
      await client.query("COMMIT");
      return res.status(409).json({ message: "This category has items or transactions. It can only be deactivated.", category: result.rows[0] });
    }
    const tombstoneResult = await client.query(
      "UPDATE product_categories SET active = FALSE, deleted_at = CURRENT_TIMESTAMP, entity_version = entity_version + 1, updated_by = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *",
      [manager.id, categoryId]
    );
    await client.query(
      `
      INSERT INTO product_category_audit_trail (category_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'DELETE', $2::jsonb, NULL, $3, $4)
      `,
      [null, JSON.stringify(current), reason, manager.id]
    );
    await logSyncChange(client, {
      branchId: 1,
      entityType: "product_category",
      entityId: tombstoneResult.rows[0].global_id,
      operationType: "DELETE",
      version: tombstoneResult.rows[0].entity_version || 1,
      payload: tombstoneResult.rows[0],
    });
    await client.query("COMMIT");
    return res.json({ success: true });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Removing Category" });
  } finally {
    client.release();
  }
});

app.get("/product-duplicate-archive-log", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        log.*,
        archived.product_name AS archived_product_name,
        archived.category AS archived_category,
        kept.product_name AS kept_product_name,
        kept.category AS kept_category
      FROM product_duplicate_archive_log log
      LEFT JOIN products archived ON archived.id = log.duplicate_product_id
      LEFT JOIN products kept ON kept.id = log.kept_product_id
      ORDER BY log.archived_at DESC, log.id DESC
      LIMIT 50
      `
    );
    return res.json({
      count: result.rows.length,
      message: result.rows.length ? "Duplicate products were archived. Review product master." : "",
      rows: result.rows,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Product Duplicate Archive Log" });
  }
});

app.get("/products", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.*,
        pc.category_name,
        COALESCE(stock.current_stock, 0) AS current_stock,
        COALESCE(stock.lot_count, 0) AS lot_count
      FROM products p
      LEFT JOIN product_categories pc ON pc.id = p.category_id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::INTEGER AS lot_count, SUM(remaining_qty) AS current_stock
        FROM inventory_batches ib
        WHERE ib.product_id = p.id
          AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
      ) stock ON TRUE
      ORDER BY COALESCE(pc.category_name, p.category, 'Fruit'), p.product_name
    `);
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Database Error" });
  }
});

app.post("/products", async (req, res) => {
  const client = await pool.connect();
  try {
    const { product_name, selling_rate, unit, barcode, origin_type, category, category_id, minimum_stock, active, created_by, remarks, branch_id } = req.body;
    const parsedSellingRate = parsePositiveNumber(selling_rate);
    const parsedMinimumStock = parseNonNegativeNumber(minimum_stock);
    const parsedOriginType = String(origin_type || "LOCAL").toUpperCase();
    const parsedUnit = normalizeProductUnit(unit);
    const rateManager = await requireRateManager(created_by, client);

    if (!rateManager) return res.status(403).json({ message: "Only Owner or Admin can create owner-approved selling rates" });
    if (!product_name?.trim() || !parsedUnit || !parsedSellingRate || parsedMinimumStock === null || !["LOCAL", "IMPORTED"].includes(parsedOriginType)) {
      return res.status(400).json({ message: "Enter valid product details" });
    }
    await client.query("BEGIN");
    let selectedCategory = await getCategoryById(client, parsePositiveInteger(category_id));
    if (!selectedCategory) {
      selectedCategory = await findCategoryByName(client, category || "Fruit");
    }
    if (!selectedCategory) {
      const categoryResult = await client.query(
        "INSERT INTO product_categories (global_id, category_name, active, created_by, updated_by) VALUES ($1, $2, TRUE, $3, $3) RETURNING *",
        [`category-${crypto.randomUUID()}`, cleanText(category || "Fruit"), rateManager.id]
      );
      selectedCategory = categoryResult.rows[0];
      await logSyncChange(client, {
        branchId: 1,
        entityType: "product_category",
        entityId: selectedCategory.global_id,
        operationType: "UPSERT",
        version: selectedCategory.entity_version || 1,
        payload: selectedCategory,
      });
    }
    if (selectedCategory.active === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Selected category is inactive." });
    }
    const duplicateResult = await client.query(
      "SELECT id FROM products WHERE LOWER(product_name) = LOWER($1) AND active IS DISTINCT FROM FALSE LIMIT 1",
      [product_name.trim()]
    );
    if (duplicateResult.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This product already exists." });
    }

    const result = await client.query(
      `
      INSERT INTO products (
        global_id, product_name, selling_rate, unit, barcode, origin_type, category, category_id,
        minimum_stock, active, remarks, selling_rate_updated_by
      )
      VALUES ($12, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
      `,
      [
        product_name.trim(), parsedSellingRate, parsedUnit, barcode?.trim() || null, parsedOriginType,
        selectedCategory.category_name, selectedCategory.id, parsedMinimumStock, active !== false,
        nullableText(remarks), rateManager.id, `product-${crypto.randomUUID()}`,
      ]
    );
    const product = result.rows[0];
    await client.query(
      `
      INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'CREATE', NULL, $2::jsonb, $3, $4)
      `,
      [product.id, JSON.stringify(product), "Product item created", rateManager.id]
    );
    await logSyncChange(client, {
      branchId: parsePositiveInteger(branch_id) || 1,
      entityType: "product",
      entityId: product.global_id,
      operationType: "UPSERT",
      version: product.entity_version || 1,
      payload: product,
    });
    const openingLots = Array.isArray(req.body.opening_stock_lots) ? req.body.opening_stock_lots : [];
    const createdLots = [];
    for (const lot of openingLots) {
      const lotResult = await insertOpeningStockLot(client, {
        product,
        lot,
        actorId: rateManager.id,
        branchId: parsePositiveInteger(branch_id) || 1,
      });
      if (lotResult.error) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: lotResult.error });
      }
      createdLots.push(lotResult.batch);
    }
    await client.query("COMMIT");
    return res.status(201).json({ ...product, opening_stock_lots: createdLots });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    if (error.code === "23505") {
      return res.status(409).json({ message: "This product already exists." });
    }
    return res.status(500).json({ message: "Error Adding Product" });
  } finally {
    client.release();
  }
});

app.put("/products/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const productId = parsePositiveInteger(req.params.id);
    const { product_name, selling_rate, unit, barcode, origin_type, category, category_id, minimum_stock, active, updated_by, rate_change_reason, remarks } = req.body;
    const parsedSellingRate = parsePositiveNumber(selling_rate);
    const parsedMinimumStock = parseNonNegativeNumber(minimum_stock);
    const parsedOriginType = String(origin_type || "").toUpperCase();
    const parsedUnit = normalizeProductUnit(unit);

    if (!productId || !product_name?.trim() || !parsedUnit || !parsedSellingRate || parsedMinimumStock === null || !["LOCAL", "IMPORTED"].includes(parsedOriginType)) {
      return res.status(400).json({ message: "Enter valid product details" });
    }

    await client.query("BEGIN");
    const currentResult = await client.query("SELECT * FROM products WHERE id = $1 FOR UPDATE", [productId]);
    if (currentResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }
    const current = currentResult.rows[0];
    let selectedCategory = await getCategoryById(client, parsePositiveInteger(category_id));
    if (!selectedCategory) {
      selectedCategory = await findCategoryByName(client, category || current.category || "Fruit");
    }
    if (!selectedCategory || selectedCategory.active === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Selected category is inactive or missing." });
    }
    const duplicateResult = await client.query(
      "SELECT id FROM products WHERE LOWER(product_name) = LOWER($1) AND id <> $2 AND active IS DISTINCT FROM FALSE LIMIT 1",
      [product_name.trim(), productId]
    );
    if (duplicateResult.rows.length > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This product already exists." });
    }
    const sellingRateChanged = Number(current.selling_rate) !== parsedSellingRate;
    const rateManager = sellingRateChanged ? await requireRateManager(updated_by, client) : null;
    if (sellingRateChanged && !rateManager) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Only Owner or Admin can change selling rates" });
    }

    const result = await client.query(
      `
      UPDATE products
      SET
        product_name = $1, selling_rate = $2, unit = $3, barcode = $4,
        origin_type = $5, category = $6, category_id = $7, minimum_stock = $8, active = $9,
        remarks = $10,
        entity_version = entity_version + 1,
        selling_rate_updated_at = CASE WHEN selling_rate <> $2 THEN CURRENT_TIMESTAMP ELSE selling_rate_updated_at END,
        selling_rate_updated_by = CASE WHEN selling_rate <> $2 THEN $11 ELSE selling_rate_updated_by END
      WHERE id = $12
      RETURNING *
      `,
      [
        product_name.trim(), parsedSellingRate, parsedUnit, barcode?.trim() || null,
        parsedOriginType, selectedCategory.category_name, selectedCategory.id, parsedMinimumStock, active !== false,
        nullableText(remarks), rateManager?.id || null, productId,
      ]
    );

    if (sellingRateChanged) {
      await client.query(
        `
        INSERT INTO sale_rate_history (product_id, old_selling_rate, new_selling_rate, changed_by, reason)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [productId, current.selling_rate, parsedSellingRate, rateManager.id, rate_change_reason?.trim() || "Product Master update"]
      );
    }
    await client.query(
      `
      INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [productId, JSON.stringify(current), JSON.stringify(result.rows[0]), rate_change_reason?.trim() || "Product master update", parsePositiveInteger(updated_by) || rateManager?.id || null]
    );
    await logSyncChange(client, {
      branchId: 1,
      entityType: sellingRateChanged ? "sale_rate" : "product",
      entityId: result.rows[0].global_id,
      operationType: "UPSERT",
      version: result.rows[0].entity_version || 1,
      payload: result.rows[0],
    });
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    if (error.code === "23505") {
      return res.status(409).json({ message: "This product already exists." });
    }
    return res.status(500).json({ message: "Error Updating Product" });
  } finally {
    client.release();
  }
});

const addOpeningStockLotsForProduct = async (req, res, productIdParam = "id") => {
  const client = await pool.connect();
  try {
    const productId = parsePositiveInteger(req.params[productIdParam]);
    const manager = await requireRateManager(req.body.created_by || req.body.updated_by, client);
    const lots = Array.isArray(req.body.opening_stock_lots) ? req.body.opening_stock_lots : [req.body];
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can add opening stock" });
    if (!productId || lots.length === 0) return res.status(400).json({ message: "Please add opening stock lots." });
    await client.query("BEGIN");
    const productResult = await client.query("SELECT * FROM products WHERE id = $1 AND active IS DISTINCT FROM FALSE FOR UPDATE", [productId]);
    const product = productResult.rows[0];
    if (!product) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }
    const createdLots = [];
    for (const lot of lots) {
      const lotResult = await insertOpeningStockLot(client, {
        product,
        lot,
        actorId: manager.id,
        branchId: parsePositiveInteger(req.body.branch_id) || 1,
      });
      if (lotResult.error) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: lotResult.error });
      }
      createdLots.push(lotResult.batch);
    }
    await client.query("COMMIT");
    return res.status(201).json({ success: true, lots: createdLots });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Adding Opening Stock" });
  } finally {
    client.release();
  }
};

app.post("/products/:id/opening-stock", (req, res) => addOpeningStockLotsForProduct(req, res, "id"));

app.post("/products/:productId/opening-stock-lots", (req, res) => addOpeningStockLotsForProduct(req, res, "productId"));

const lotUsage = (lot) => Math.max(0, Number(lot.purchase_qty || 0) - Number(lot.remaining_qty || 0));

const stockInventorySelectSql = `
  SELECT
    ib.id,
    ib.product_id,
    p.product_name,
    p.category,
    p.category_id,
    p.unit,
    p.barcode,
    p.selling_rate,
    ib.batch_no,
    ib.lot_name,
    ib.lot_size,
    ib.batch_status,
    ib.stock_source,
    ib.purchase_qty,
    ib.remaining_qty,
    ib.purchase_rate,
    ib.effective_cost_per_unit,
    ib.temporary_sale_rate,
    ib.mandi_tax_amount,
    ib.freight_charges,
    ib.labour_charges,
    ib.other_charges,
    ib.gross_amount,
    ib.rebate_amount,
    ib.net_payable,
    ib.payment_timing,
    ib.balance_amount,
    ib.supplier_id,
    ib.supplier_name,
    ib.remarks,
    ib.purchase_date,
    ib.created_at,
    COALESCE(sold_summary.sold_qty, 0) AS sold_qty,
    COALESCE(ib.returned_qty, 0) AS returned_qty,
    COALESCE(ib.waste_qty, 0) AS waste_qty,
    COALESCE(ib.adjusted_qty, 0) AS adjusted_qty,
    COALESCE(ib.transfer_in_qty, 0) AS transfer_in_qty,
    COALESCE(ib.transfer_out_qty, 0) AS transfer_out_qty,
    COALESCE(ib.remaining_qty, 0) AS balance_qty,
    latest_audit.edited_at AS last_edited_at,
    latest_audit.edited_by_name AS last_edited_by_name
  FROM inventory_batches ib
  JOIN products p ON p.id = ib.product_id
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(sba.quantity), 0) AS sold_qty
    FROM sale_batch_allocations sba
    JOIN sale_items si ON si.id = sba.sale_item_id
    JOIN sales s ON s.id = si.sale_id
    WHERE sba.inventory_batch_id = ib.id
      AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
  ) sold_summary ON TRUE
  LEFT JOIN LATERAL (
    SELECT pat.edited_at, u.full_name AS edited_by_name
    FROM product_audit_trail pat
    LEFT JOIN users u ON u.id = pat.edited_by
    WHERE pat.product_id = ib.product_id
      AND COALESCE((pat.new_value->>'id')::INTEGER, (pat.old_value->>'id')::INTEGER) = ib.id
      AND pat.action IN (
        'OPENING_STOCK',
        'OPENING_STOCK_LOT_ADDED',
        'INVENTORY_LOT_EDIT',
        'INVENTORY_LOT_ADD_QTY',
        'INVENTORY_LOT_ADJUST',
        'INVENTORY_LOT_DEACTIVATE',
        'INVENTORY_LOT_REACTIVATE',
        'INVENTORY_LOT_TRANSFER_OUT',
        'INVENTORY_LOT_TRANSFER_IN'
      )
    ORDER BY pat.edited_at DESC, pat.id DESC
    LIMIT 1
  ) latest_audit ON TRUE
`;

app.get("/products/:id/lots", async (req, res) => {
  try {
    const productId = parsePositiveInteger(req.params.id);
    if (!productId) return res.status(400).json({ message: "Invalid product" });
    const [lotsResult, auditResult] = await Promise.all([
      pool.query(
        `
        ${stockInventorySelectSql}
        WHERE ib.product_id = $1
        ORDER BY COALESCE(ib.purchase_date, ib.created_at::date), ib.created_at, ib.id
        `,
        [productId]
      ),
      pool.query(
        `
        SELECT pat.*, u.full_name AS edited_by_name
        FROM product_audit_trail pat
        LEFT JOIN users u ON u.id = pat.edited_by
        WHERE pat.product_id = $1
          AND pat.action IN ('OPENING_STOCK', 'OPENING_STOCK_LOT_ADDED', 'INVENTORY_LOT_EDIT', 'INVENTORY_LOT_ADD_QTY', 'INVENTORY_LOT_ADJUST', 'INVENTORY_LOT_DEACTIVATE', 'INVENTORY_LOT_REACTIVATE', 'INVENTORY_LOT_TRANSFER_OUT', 'INVENTORY_LOT_TRANSFER_IN')
        ORDER BY pat.edited_at DESC, pat.id DESC
        LIMIT 50
        `,
        [productId]
      ),
    ]);
    return res.json({ lots: lotsResult.rows, audit: auditResult.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Product Lots" });
  }
});

app.put(["/inventory-lots/:lotId", "/lots/:lotId"], async (req, res) => {
  const client = await pool.connect();
  try {
    const lotId = parsePositiveInteger(req.params.lotId);
    const manager = await requireRateManager(req.body.updated_by || req.body.edited_by, client);
    const purchaseRate = parsePositiveNumber(req.body.purchase_rate || req.body.opening_cost);
    const saleRate = parsePositiveNumber(req.body.sale_rate);
    const reason = cleanText(req.body.reason || "Opening stock lot edited");
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can edit opening stock lots" });
    if (!lotId || !purchaseRate) return res.status(400).json({ message: "Enter valid lot details and cost rate" });
    await client.query("BEGIN");
    const lotResult = await client.query("SELECT * FROM inventory_batches WHERE id = $1 FOR UPDATE", [lotId]);
    const lot = lotResult.rows[0];
    if (!lot) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Inventory lot not found" });
    }
    const oldPurchaseQty = Number(lot.purchase_qty || 0);
    const oldRemainingQty = Number(lot.remaining_qty || 0);
    const requestedPurchaseQty = req.body.purchase_qty === undefined || req.body.purchase_qty === null || req.body.purchase_qty === ""
      ? oldPurchaseQty
      : parseNonNegativeNumber(req.body.purchase_qty);
    if (requestedPurchaseQty === null) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Enter a valid opening quantity" });
    }
    const quantityDiff = roundUnitCost(requestedPurchaseQty - oldPurchaseQty);
    const nextRemainingQty = roundUnitCost(oldRemainingQty + quantityDiff);
    if (nextRemainingQty < 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: `Cannot reduce opening quantity below already used stock. Minimum opening quantity is ${roundUnitCost(oldPurchaseQty - oldRemainingQty)}.` });
    }
    const supplierId = parsePositiveInteger(req.body.supplier_id);
    const supplierName = supplierId ? nullableText(req.body.supplier_name) || lot.supplier_name : null;
    const lotName = cleanText(req.body.lot_name || req.body.lot_number || lot.lot_name || "Opening Stock Lot");
    const lotSize = nullableText(req.body.lot_size || req.body.size_grade || req.body.size);
    const purchaseDate = isDateInput(req.body.opening_stock_date || req.body.purchase_date) ? (req.body.opening_stock_date || req.body.purchase_date) : toDateKey(lot.purchase_date || new Date());
    const remarks = nullableText(req.body.remarks);
    const netPayable = roundCurrency(requestedPurchaseQty * purchaseRate);
    const updateResult = await client.query(
      `
      UPDATE inventory_batches
      SET lot_name = $1, lot_size = $2, supplier_id = $3, supplier_name = $4,
          purchase_qty = $5::numeric, remaining_qty = $6::numeric,
          purchase_rate = $7, effective_cost_per_unit = $7,
          gross_amount = $8, net_payable = $8,
          balance_amount = 0, temporary_sale_rate = COALESCE($9, temporary_sale_rate),
          purchase_date = $10, remarks = $11,
          batch_status = CASE
            WHEN COALESCE(batch_status, 'ACTIVE') = 'CANCELLED' THEN batch_status
            WHEN $6::numeric > 0 THEN 'ACTIVE'
            ELSE batch_status
          END
      WHERE id = $12
      RETURNING *
      `,
      [
        lotName, lotSize, supplierId || null, supplierName,
        requestedPurchaseQty, nextRemainingQty, purchaseRate, netPayable, saleRate || null,
        purchaseDate, remarks, lotId,
      ]
    );
    if (quantityDiff !== 0) {
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, $3, $4, $5, $6)",
        [lot.product_id, Math.abs(quantityDiff), quantityDiff > 0 ? "IN" : "OUT", `Lot opening quantity edited: ${reason}`, manager.id, lot.branch_id || 1]
      );
    }
    if (saleRate && Number(saleRate) !== Number(lot.temporary_sale_rate || 0)) {
      await client.query("UPDATE products SET selling_rate = $1, selling_rate_updated_at = CURRENT_TIMESTAMP, selling_rate_updated_by = $2 WHERE id = $3", [saleRate, manager.id, lot.product_id]);
    }
    await client.query(
      "INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'INVENTORY_LOT_EDIT', $2::jsonb, $3::jsonb, $4, $5)",
      [lot.product_id, JSON.stringify(lot), JSON.stringify(updateResult.rows[0]), reason, manager.id]
    );
    await client.query("COMMIT");
    return res.json(updateResult.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Updating Inventory Lot" });
  } finally {
    client.release();
  }
});

app.post("/inventory-lots/:lotId/add-quantity", async (req, res) => {
  const client = await pool.connect();
  try {
    const lotId = parsePositiveInteger(req.params.lotId);
    const quantity = parsePositiveNumber(req.body.quantity);
    const manager = await requireRateManager(req.body.updated_by || req.body.created_by, client);
    const reason = cleanText(req.body.reason || "Quantity added to lot");
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can add lot quantity" });
    if (!lotId || !quantity) return res.status(400).json({ message: "Enter quantity to add" });
    await client.query("BEGIN");
    const lotResult = await client.query("SELECT * FROM inventory_batches WHERE id = $1 FOR UPDATE", [lotId]);
    const lot = lotResult.rows[0];
    if (!lot) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Inventory lot not found" });
    }
    const updateResult = await client.query(
      "UPDATE inventory_batches SET purchase_qty = purchase_qty + $1, remaining_qty = remaining_qty + $1, gross_amount = ROUND(((purchase_qty + $1) * purchase_rate)::NUMERIC, 2), net_payable = ROUND(((purchase_qty + $1) * purchase_rate)::NUMERIC, 2) WHERE id = $2 RETURNING *",
      [quantity, lotId]
    );
    await client.query("INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'IN', $3, $4, $5)", [lot.product_id, quantity, reason, manager.id, lot.branch_id || 1]);
    await client.query("INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'INVENTORY_LOT_ADD_QTY', $2::jsonb, $3::jsonb, $4, $5)", [lot.product_id, JSON.stringify(lot), JSON.stringify(updateResult.rows[0]), reason, manager.id]);
    await client.query("COMMIT");
    return res.json(updateResult.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Adding Lot Quantity" });
  } finally {
    client.release();
  }
});

app.post(["/inventory-lots/:lotId/adjust", "/lots/:lotId/adjust-stock"], async (req, res) => {
  const client = await pool.connect();
  try {
    const lotId = parsePositiveInteger(req.params.lotId);
    const physicalQuantity = parseNonNegativeNumber(req.body.physical_quantity ?? req.body.balance_qty ?? req.body.new_balance_qty ?? req.body.new_quantity ?? req.body.quantity);
    const manager = await requireRateManager(req.body.updated_by || req.body.created_by, client);
    const reason = cleanText(req.body.reason);
    const adjustmentType = cleanText(req.body.adjustment_type || "Physical Count Correction");
    const adjustmentDate = isDateInput(req.body.adjustment_date) ? req.body.adjustment_date : toDateKey(new Date());
    const remarks = nullableText(req.body.remarks);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can adjust lot quantity" });
    if (!lotId || physicalQuantity === null || !reason) return res.status(400).json({ message: "Enter physical quantity and adjustment reason" });
    await client.query("BEGIN");
    const lotResult = await client.query("SELECT * FROM inventory_batches WHERE id = $1 FOR UPDATE", [lotId]);
    const lot = lotResult.rows[0];
    if (!lot) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Inventory lot not found" });
    }
    const oldBalance = Number(lot.remaining_qty || 0);
    const diff = roundUnitCost(physicalQuantity - oldBalance);
    const updateResult = await client.query(
      `
      UPDATE inventory_batches
      SET remaining_qty = $1::numeric,
          adjusted_qty = COALESCE(adjusted_qty, 0) + $2::numeric,
          batch_status = CASE
            WHEN COALESCE(batch_status, 'ACTIVE') = 'CANCELLED' THEN batch_status
            WHEN $1::numeric > 0 THEN 'ACTIVE'
            ELSE batch_status
          END,
          remarks = COALESCE($3, remarks)
      WHERE id = $4
      RETURNING *
      `,
      [physicalQuantity, diff, remarks, lotId]
    );
    if (diff !== 0) {
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, $3, $4, $5, $6)",
        [lot.product_id, Math.abs(diff), diff > 0 ? "IN" : "OUT", `${adjustmentType}: ${reason}`, manager.id, lot.branch_id || 1]
      );
    }
    await client.query(
      `
      INSERT INTO stock_adjustments (
        product_id, inventory_batch_id, adjustment_date, adjustment_type,
        quantity_before, physical_quantity, adjustment_quantity,
        reason, remarks, adjusted_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        lot.product_id,
        lotId,
        adjustmentDate,
        adjustmentType,
        oldBalance,
        physicalQuantity,
        diff,
        reason,
        remarks,
        manager.id,
      ]
    );
    const newValue = { ...updateResult.rows[0], adjustment_type: adjustmentType, adjustment_qty: diff, physical_quantity: physicalQuantity, remarks };
    await client.query("INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'INVENTORY_LOT_ADJUST', $2::jsonb, $3::jsonb, $4, $5)", [lot.product_id, JSON.stringify(lot), JSON.stringify(newValue), reason, manager.id]);
    await client.query("COMMIT");
    return res.json(updateResult.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: `Error Adjusting Inventory Lot: ${error.message}` });
  } finally {
    client.release();
  }
});

app.post("/inventory-lots/:lotId/deactivate", async (req, res) => {
  const client = await pool.connect();
  try {
    const lotId = parsePositiveInteger(req.params.lotId);
    const manager = await requireRateManager(req.body.updated_by || req.body.deactivated_by, client);
    const reason = cleanText(req.body.reason);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can deactivate lots" });
    if (!lotId || !reason) return res.status(400).json({ message: "Reason is required" });
    await client.query("BEGIN");
    const lotResult = await client.query("SELECT * FROM inventory_batches WHERE id = $1 FOR UPDATE", [lotId]);
    const lot = lotResult.rows[0];
    if (!lot) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Inventory lot not found" });
    }
    const usedQty = lotUsage(lot);
    if (usedQty > 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cannot deactivate this lot because stock from this lot has already been used." });
    }
    const updateResult = await client.query("UPDATE inventory_batches SET batch_status = 'CANCELLED', remaining_qty = 0 WHERE id = $1 RETURNING *", [lotId]);
    if (Number(lot.remaining_qty || 0) > 0) {
      await client.query("INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'OUT', $3, $4, $5)", [lot.product_id, Number(lot.remaining_qty), reason, manager.id, lot.branch_id || 1]);
    }
    await client.query("INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'INVENTORY_LOT_DEACTIVATE', $2::jsonb, $3::jsonb, $4, $5)", [lot.product_id, JSON.stringify(lot), JSON.stringify(updateResult.rows[0]), reason, manager.id]);
    await client.query("COMMIT");
    return res.json(updateResult.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Deactivating Inventory Lot" });
  } finally {
    client.release();
  }
});

app.post("/inventory-lots/:lotId/reactivate", async (req, res) => {
  const client = await pool.connect();
  try {
    const lotId = parsePositiveInteger(req.params.lotId);
    const manager = await requireRateManager(req.body.updated_by || req.body.reactivated_by, client);
    const reason = cleanText(req.body.reason);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can reactivate lots" });
    if (!lotId || !reason) return res.status(400).json({ message: "Reason is required" });
    await client.query("BEGIN");
    const lotResult = await client.query("SELECT * FROM inventory_batches WHERE id = $1 FOR UPDATE", [lotId]);
    const lot = lotResult.rows[0];
    if (!lot) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Inventory lot not found" });
    }
    const usedQty = lotUsage(lot);
    const nextRemaining = Math.max(Number(lot.purchase_qty || 0) - usedQty, 0);
    const updateResult = await client.query(
      "UPDATE inventory_batches SET batch_status = 'ACTIVE', remaining_qty = $1 WHERE id = $2 RETURNING *",
      [nextRemaining, lotId]
    );
    if (nextRemaining > Number(lot.remaining_qty || 0)) {
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'IN', $3, $4, $5)",
        [lot.product_id, nextRemaining - Number(lot.remaining_qty || 0), reason, manager.id, lot.branch_id || 1]
      );
    }
    await client.query(
      "INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'INVENTORY_LOT_REACTIVATE', $2::jsonb, $3::jsonb, $4, $5)",
      [lot.product_id, JSON.stringify(lot), JSON.stringify(updateResult.rows[0]), reason, manager.id]
    );
    await client.query("COMMIT");
    return res.json(updateResult.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Reactivating Inventory Lot" });
  } finally {
    client.release();
  }
});

app.post("/lots/transfer-stock", async (req, res) => {
  const client = await pool.connect();
  try {
    const fromLotId = parsePositiveInteger(req.body.from_lot_id || req.body.from_inventory_batch_id);
    const toLotId = parsePositiveInteger(req.body.to_lot_id || req.body.to_inventory_batch_id);
    const quantity = parsePositiveNumber(req.body.quantity);
    const manager = await requireRateManager(req.body.updated_by || req.body.created_by, client);
    const reason = cleanText(req.body.reason);
    const remarks = nullableText(req.body.remarks);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can transfer stock between lots" });
    if (!fromLotId || !toLotId || fromLotId === toLotId || !quantity || !reason) {
      return res.status(400).json({ message: "Select source lot, destination lot, quantity and reason" });
    }
    await client.query("BEGIN");
    const lotsResult = await client.query(
      `
      SELECT *
      FROM inventory_batches
      WHERE id = ANY($1::int[])
      ORDER BY id
      FOR UPDATE
      `,
      [[fromLotId, toLotId]]
    );
    const fromLot = lotsResult.rows.find((lot) => Number(lot.id) === fromLotId);
    const toLot = lotsResult.rows.find((lot) => Number(lot.id) === toLotId);
    if (!fromLot || !toLot) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Source or destination lot not found" });
    }
    if (String(toLot.batch_status || "ACTIVE").toUpperCase() === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cannot transfer stock into a cancelled lot" });
    }
    if (Number(fromLot.remaining_qty || 0) < quantity) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Quantity to move cannot exceed source lot balance" });
    }
    const sourceUpdate = await client.query(
      `
      UPDATE inventory_batches
      SET remaining_qty = remaining_qty - $1,
          transfer_out_qty = COALESCE(transfer_out_qty, 0) + $1,
          remarks = COALESCE($2, remarks)
      WHERE id = $3
      RETURNING *
      `,
      [quantity, remarks, fromLotId]
    );
    const destinationUpdate = await client.query(
      `
      UPDATE inventory_batches
      SET remaining_qty = remaining_qty + $1,
          transfer_in_qty = COALESCE(transfer_in_qty, 0) + $1,
          batch_status = CASE WHEN COALESCE(batch_status, 'ACTIVE') = 'CANCELLED' THEN batch_status ELSE 'ACTIVE' END,
          remarks = COALESCE($2, remarks)
      WHERE id = $3
      RETURNING *
      `,
      [quantity, remarks, toLotId]
    );
    await client.query(
      "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'OUT', $3, $4, $5), ($6, $2, 'IN', $3, $4, $7)",
      [
        fromLot.product_id,
        quantity,
        `Stock transfer ${fromLotId} -> ${toLotId}: ${reason}`,
        manager.id,
        fromLot.branch_id || 1,
        toLot.product_id,
        toLot.branch_id || fromLot.branch_id || 1,
      ]
    );
    await client.query(
      "INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'INVENTORY_LOT_TRANSFER_OUT', $2::jsonb, $3::jsonb, $4, $5), ($6, 'INVENTORY_LOT_TRANSFER_IN', $7::jsonb, $8::jsonb, $4, $5)",
      [
        fromLot.product_id,
        JSON.stringify(fromLot),
        JSON.stringify({ ...sourceUpdate.rows[0], transfer_quantity: quantity, transfer_to_lot_id: toLotId, remarks }),
        reason,
        manager.id,
        toLot.product_id,
        JSON.stringify(toLot),
        JSON.stringify({ ...destinationUpdate.rows[0], transfer_quantity: quantity, transfer_from_lot_id: fromLotId, remarks }),
      ]
    );
    await client.query("COMMIT");
    return res.json({ success: true, from_lot: sourceUpdate.rows[0], to_lot: destinationUpdate.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Transferring Stock" });
  } finally {
    client.release();
  }
});

app.get("/stock-inventory/audit", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        pat.*,
        p.product_name,
        p.category,
        u.full_name AS edited_by_name,
        COALESCE(
          (pat.new_value->>'id')::INTEGER,
          (pat.old_value->>'id')::INTEGER,
          (pat.new_value->>'inventory_batch_id')::INTEGER,
          (pat.old_value->>'inventory_batch_id')::INTEGER
        ) AS lot_id,
        COALESCE(pat.new_value->>'lot_name', pat.old_value->>'lot_name', pat.new_value->>'batch_no', pat.old_value->>'batch_no') AS lot_name
      FROM product_audit_trail pat
      JOIN products p ON p.id = pat.product_id
      LEFT JOIN users u ON u.id = pat.edited_by
      WHERE pat.action IN (
        'OPENING_STOCK',
        'OPENING_STOCK_LOT_ADDED',
        'INVENTORY_LOT_EDIT',
        'INVENTORY_LOT_ADD_QTY',
        'INVENTORY_LOT_ADJUST',
        'INVENTORY_LOT_DEACTIVATE',
        'INVENTORY_LOT_REACTIVATE',
        'INVENTORY_LOT_TRANSFER_OUT',
        'INVENTORY_LOT_TRANSFER_IN'
      )
      ORDER BY pat.edited_at DESC, pat.id DESC
      LIMIT 500
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Stock Audit Trail" });
  }
});

app.get("/stock-adjustments", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        sa.*,
        p.product_name,
        p.category,
        ib.lot_name,
        ib.lot_size,
        ib.batch_no,
        u.full_name AS adjusted_by_name
      FROM stock_adjustments sa
      JOIN products p ON p.id = sa.product_id
      JOIN inventory_batches ib ON ib.id = sa.inventory_batch_id
      LEFT JOIN users u ON u.id = sa.adjusted_by
      ORDER BY sa.adjustment_date DESC, sa.created_at DESC, sa.id DESC
      LIMIT 500
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: `Error Loading Stock Adjustments: ${error.message}` });
  }
});

app.get("/lots/:lotId/audit-trail", async (req, res) => {
  try {
    const lotId = parsePositiveInteger(req.params.lotId);
    if (!lotId) return res.status(400).json({ message: "Invalid lot" });
    const result = await pool.query(
      `
      SELECT
        pat.*,
        p.product_name,
        p.category,
        u.full_name AS edited_by_name,
        COALESCE(pat.new_value->>'lot_name', pat.old_value->>'lot_name', pat.new_value->>'batch_no', pat.old_value->>'batch_no') AS lot_name
      FROM product_audit_trail pat
      JOIN products p ON p.id = pat.product_id
      LEFT JOIN users u ON u.id = pat.edited_by
      WHERE COALESCE((pat.new_value->>'id')::INTEGER, (pat.old_value->>'id')::INTEGER, (pat.new_value->>'inventory_batch_id')::INTEGER, (pat.old_value->>'inventory_batch_id')::INTEGER) = $1
      ORDER BY pat.edited_at DESC, pat.id DESC
      `,
      [lotId]
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Lot Audit Trail" });
  }
});

app.post("/products/:id/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const productId = parsePositiveInteger(req.params.id);
    const userId = parsePositiveInteger(req.body.cancelled_by) || parsePositiveInteger(req.body.updated_by);
    const reason = cleanText(req.body.reason);
    const manager = await requireRateManager(userId, client);
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can deactivate products" });
    if (!productId || !reason) return res.status(400).json({ message: "Reason is required" });
    await client.query("BEGIN");
    const productResult = await client.query("SELECT * FROM products WHERE id = $1 FOR UPDATE", [productId]);
    const product = productResult.rows[0];
    if (!product) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Product not found" });
    }
    const usageResult = await client.query(
      `
      SELECT
        COALESCE((SELECT COUNT(*) FROM purchase_items WHERE product_id = $1), 0)
        + COALESCE((SELECT COUNT(*) FROM sale_items WHERE product_id = $1), 0)
        + COALESCE((SELECT COUNT(*) FROM inventory_batches WHERE product_id = $1), 0)
        + COALESCE((SELECT COUNT(*) FROM sale_return_items WHERE product_id = $1), 0)
        + COALESCE((SELECT COUNT(*) FROM waste_entries WHERE product_id = $1), 0) AS usage_count
      `,
      [productId]
    );
    const result = await client.query(
      "UPDATE products SET active = FALSE, deleted_at = CURRENT_TIMESTAMP, entity_version = entity_version + 1 WHERE id = $1 RETURNING *",
      [productId]
    );
    await client.query(
      `
      INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
      `,
      [productId, Number(usageResult.rows[0].usage_count || 0) > 0 ? "DEACTIVATE" : "CANCEL", JSON.stringify(product), JSON.stringify(result.rows[0]), reason, manager.id]
    );
    await logSyncChange(client, {
      branchId: 1,
      entityType: "product",
      entityId: result.rows[0].global_id,
      operationType: "DELETE",
      version: result.rows[0].entity_version || 1,
      payload: result.rows[0],
    });
    await client.query("COMMIT");
    return res.json({ success: true, product: result.rows[0], had_transactions: Number(usageResult.rows[0].usage_count || 0) > 0 });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Cancelling Product" });
  } finally {
    client.release();
  }
});

app.get("/inventory", async (req, res) => {
  try {
    const includeCancelled = String(req.query.include_cancelled || "").toLowerCase() === "true";
    const result = await pool.query(`
      ${stockInventorySelectSql}
      WHERE ($1::boolean = TRUE OR COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED')
      ORDER BY ib.purchase_date, ib.created_at, ib.id
    `, [includeCancelled]);

    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Inventory Error" });
  }
});

app.get("/stock", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        p.id,
        p.product_name,
        p.category,
        p.category_id,
        p.barcode,
        p.unit,
        COALESCE(SUM(ib.remaining_qty), 0) AS current_stock
      FROM products p
      LEFT JOIN inventory_batches ib ON ib.product_id = p.id
        AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
      GROUP BY p.id, p.product_name, p.unit
      ORDER BY p.product_name
    `);

    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Stock" });
  }
});

app.get("/sale-rates", async (req, res) => {
  try {
    if (!await requireRateManager(req.query.user_id)) {
      return res.status(403).json({ message: "Only Owner or Admin can manage selling rates" });
    }
    const settingsResult = await pool.query("SELECT * FROM sale_rate_settings WHERE id = 1");
    const saleRateSettings = settingsResult.rows[0] || {};
    const desiredMargin = parseNonNegativeNumber(req.query.desired_margin) ?? Number(saleRateSettings.desired_margin_percent || 25);
    const roundingRule = ROUNDING_RULES.has(saleRateSettings.rounding_rule)
      ? saleRateSettings.rounding_rule
      : "NEAREST_RUPEE";
    const result = await pool.query(
      `
      SELECT
        CASE WHEN ib.id IS NULL THEN -p.id ELSE ib.id END AS id,
        p.id AS product_id,
        ib.id AS inventory_batch_id,
        p.product_name,
        p.category,
        p.origin_type,
        p.unit,
        COALESCE(NULLIF(ib.temporary_sale_rate, 0), p.selling_rate) AS selling_rate,
        ib.lot_name,
        ib.lot_size,
        p.selling_rate_updated_at,
        u.full_name AS updated_by_name,
        COALESCE(ib.remaining_qty, stock.current_stock, 0) AS current_stock,
        CASE WHEN COALESCE(ib.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_PENDING' THEN COALESCE(ib.remaining_qty, 0) ELSE 0 END AS pending_bill_stock,
        COALESCE(ib.temporary_sale_rate, 0) AS temporary_sale_rate,
        COALESCE(ib.effective_cost_per_unit, latest.effective_cost_per_unit, 0) AS latest_effective_cost,
        CASE
          WHEN COALESCE(ib.effective_cost_per_unit, latest.effective_cost_per_unit, 0) > 0
            THEN COALESCE(ib.effective_cost_per_unit, latest.effective_cost_per_unit, 0) * (1 + $1 / 100.0)
          ELSE COALESCE(NULLIF(ib.temporary_sale_rate, 0), p.selling_rate)
        END AS suggested_selling_rate
      FROM products p
      LEFT JOIN users u ON u.id = p.selling_rate_updated_by
      LEFT JOIN inventory_batches ib ON ib.product_id = p.id
        AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
        AND ib.remaining_qty > 0
      LEFT JOIN LATERAL (
        SELECT ib.effective_cost_per_unit
        FROM inventory_batches ib
        WHERE ib.product_id = p.id
          AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
        ORDER BY ib.purchase_date DESC, ib.created_at DESC, ib.id DESC
        LIMIT 1
      ) latest ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          SUM(ib.remaining_qty) AS current_stock,
          SUM(CASE WHEN COALESCE(ib.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_PENDING' THEN ib.remaining_qty ELSE 0 END) AS pending_bill_stock,
          MAX(CASE WHEN COALESCE(ib.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_PENDING' THEN ib.temporary_sale_rate ELSE 0 END) AS temporary_sale_rate
        FROM inventory_batches ib
        WHERE ib.product_id = p.id
          AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
      ) stock ON TRUE
      WHERE p.active = TRUE
      ORDER BY p.product_name, ib.purchase_date, ib.created_at, ib.id
      `,
      [desiredMargin]
    );
    return res.json(result.rows.map((row) => ({
      ...row,
      suggested_selling_rate: applySaleRateRounding(row.suggested_selling_rate, roundingRule),
    })));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sale Rates" });
  }
});

app.post("/sale-rates/bulk", async (req, res) => {
  const client = await pool.connect();
  try {
    const manager = await requireRateManager(req.body.changed_by, client);
    const updates = Array.isArray(req.body.updates) ? req.body.updates : [];
    if (!manager) return res.status(403).json({ message: "Only Owner or Admin can manage selling rates" });
    if (updates.length === 0) return res.status(400).json({ message: "Add at least one selling rate update" });

    await client.query("BEGIN");
    const saved = [];
    for (const update of updates) {
      const productId = parsePositiveInteger(update.product_id);
      const inventoryBatchId = parsePositiveInteger(update.inventory_batch_id);
      const newRate = parsePositiveNumber(update.new_selling_rate);
      if (!productId || !newRate) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Enter valid selling rates" });
      }
      if (inventoryBatchId) {
        const batchResult = await client.query(
          "SELECT ib.*, p.product_name, p.selling_rate AS product_selling_rate FROM inventory_batches ib JOIN products p ON p.id = ib.product_id WHERE ib.id = $1 AND ib.product_id = $2 AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED' FOR UPDATE",
          [inventoryBatchId, productId]
        );
        if (batchResult.rows.length === 0) {
          await client.query("ROLLBACK");
          return res.status(404).json({ message: "Inventory lot not found" });
        }
        const batch = batchResult.rows[0];
        const oldRate = Number(batch.temporary_sale_rate || batch.product_selling_rate || 0);
        if (oldRate === newRate) continue;
        const updatedBatch = await client.query(
          "UPDATE inventory_batches SET temporary_sale_rate = $1 WHERE id = $2 RETURNING *",
          [newRate, inventoryBatchId]
        );
        await client.query(
          "INSERT INTO sale_rate_history (product_id, old_selling_rate, new_selling_rate, changed_by, reason) VALUES ($1, $2, $3, $4, $5)",
          [productId, oldRate, newRate, manager.id, update.reason?.trim() || `Lot rate update ${batch.lot_name || batch.batch_no}`]
        );
        saved.push({ ...updatedBatch.rows[0], product_name: batch.product_name });
        continue;
      }
      const currentResult = await client.query("SELECT id, selling_rate FROM products WHERE id = $1 AND active = TRUE FOR UPDATE", [productId]);
      if (currentResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Product not found" });
      }
      const oldRate = Number(currentResult.rows[0].selling_rate);
      if (oldRate === newRate) continue;
      const productResult = await client.query(
        `
        UPDATE products
        SET selling_rate = $1, selling_rate_updated_at = CURRENT_TIMESTAMP, selling_rate_updated_by = $2
        WHERE id = $3
        RETURNING *
        `,
        [newRate, manager.id, productId]
      );
      await client.query(
        `
        INSERT INTO sale_rate_history (product_id, old_selling_rate, new_selling_rate, changed_by, reason)
        VALUES ($1, $2, $3, $4, $5)
        `,
        [productId, oldRate, newRate, manager.id, update.reason?.trim() || "Daily sale rate update"]
      );
      saved.push(productResult.rows[0]);
    }
    await client.query("COMMIT");
    return res.json({ success: true, updated_count: saved.length, products: saved });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Updating Sale Rates" });
  } finally {
    client.release();
  }
});

app.get("/sale-rate-history", async (req, res) => {
  try {
    if (!await requireRateManager(req.query.user_id)) {
      return res.status(403).json({ message: "Only Owner or Admin can view selling rate history" });
    }
    const result = await pool.query(
      `
      SELECT h.*, p.product_name, u.full_name AS changed_by_name
      FROM sale_rate_history h
      JOIN products p ON p.id = h.product_id
      JOIN users u ON u.id = h.changed_by
      ORDER BY h.changed_at DESC, h.id DESC
      LIMIT 100
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sale Rate History" });
  }
});

const loadUnifiedAccounts = async () => {
  const [customerRows, supplierRows, genericRows] = await Promise.all([
    getCustomerSummaryRows(),
    getSupplierSummaryRows(),
    pool.query("SELECT * FROM accounts ORDER BY active DESC, account_name"),
  ]);
  return [
    ...customerRows.map((account) => ({
      ...account,
      account_key: `CUSTOMER-${account.id}`,
      source: "CUSTOMER",
      source_id: account.id,
      account_type: "CUSTOMER",
      account_name: account.customer_name,
      mobile_number: account.mobile_number,
      outstanding_balance: Number(account.outstanding_balance || 0),
      receivable_balance: Number(account.outstanding_balance || 0),
      payable_balance: 0,
    })),
    ...supplierRows.map((account) => ({
      ...account,
      account_key: `SUPPLIER-${account.id}`,
      source: "SUPPLIER",
      source_id: account.id,
      account_type: accountTypeFromSupplierType(account.supplier_type),
      account_name: account.supplier_name,
      mobile_number: account.mobile_number,
      outstanding_balance: Number(account.outstanding_balance || 0),
      receivable_balance: 0,
      payable_balance: Number(account.outstanding_balance || 0),
    })),
    ...genericRows.rows.map((account) => ({
      ...account,
      account_key: `ACCOUNT-${account.id}`,
      source: "ACCOUNT",
      source_id: account.id,
      outstanding_balance: Number(account.opening_balance || 0),
      receivable_balance: 0,
      payable_balance: Number(account.opening_balance || 0),
    })),
  ].sort((left, right) => Number(right.active === true) - Number(left.active === true) || left.account_name.localeCompare(right.account_name));
};

const getUnifiedPaymentRows = async ({ accountKey } = {}) => {
  const filters = [];
  const supplierFilters = [];
  const customerValues = [];
  const supplierValues = [];
  if (accountKey) {
    const [source, idValue] = String(accountKey).split("-");
    const sourceId = parsePositiveInteger(Number(idValue));
    if (source === "CUSTOMER" && sourceId) {
      customerValues.push(sourceId);
      filters.push(`cp.customer_id = $${customerValues.length}`);
      supplierFilters.push("FALSE");
    } else if (source === "SUPPLIER" && sourceId) {
      supplierValues.push(sourceId);
      supplierFilters.push(`sp.supplier_id = $${supplierValues.length}`);
      filters.push("FALSE");
    } else {
      filters.push("FALSE");
      supplierFilters.push("FALSE");
    }
  }
  const customerWhere = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const supplierWhere = supplierFilters.length ? `WHERE ${supplierFilters.join(" AND ")}` : "";
  const [customerResult, supplierResult] = await Promise.all([
    pool.query(
      `
      SELECT
        'CUSTOMER-' || cp.id AS payment_key,
        'CUSTOMER' AS payment_source,
        cp.id,
        'CUSTOMER-' || c.id AS account_key,
        c.customer_name AS account_name,
        c.customer_type AS account_type,
        cp.payment_date,
        cp.payment_amount,
        0::NUMERIC AS rebate_amount,
        cp.payment_mode,
        cp.reference_number,
        cp.remarks,
        cp.cancelled,
        cp.cancelled_at,
        cp.cancellation_reason,
        cp.edited_at,
        cp.edit_reason,
        cp.created_at
      FROM customer_payments cp
      JOIN customers c ON c.id = cp.customer_id
      ${customerWhere}
      ORDER BY cp.payment_date DESC, cp.created_at DESC, cp.id DESC
      LIMIT 250
      `,
      customerValues
    ),
    pool.query(
      `
      SELECT
        'SUPPLIER-' || sp.id AS payment_key,
        'SUPPLIER' AS payment_source,
        sp.id,
        'SUPPLIER-' || s.id AS account_key,
        s.supplier_name AS account_name,
        s.supplier_type AS account_type,
        sp.payment_date,
        sp.payment_amount,
        sp.rebate_amount,
        sp.payment_mode,
        sp.reference_number,
        sp.remarks,
        sp.cancelled,
        sp.cancelled_at,
        sp.cancellation_reason,
        sp.edited_at,
        sp.edit_reason,
        sp.created_at
      FROM supplier_payments sp
      JOIN suppliers s ON s.id = sp.supplier_id
      ${supplierWhere}
      ORDER BY sp.payment_date DESC, sp.created_at DESC, sp.id DESC
      LIMIT 250
      `,
      supplierValues
    ),
  ]);
  return [...customerResult.rows, ...supplierResult.rows]
    .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))
    .slice(0, 250);
};

const getReportDateRange = (query = {}) => {
  const today = new Date();
  const end = new Date(today);
  const start = new Date(today);
  const range = String(query.range || "today").toLowerCase();
  if (isDateInput(query.date_from) && isDateInput(query.date_to) && query.date_from <= query.date_to) {
    return { dateFrom: query.date_from, dateTo: query.date_to, range: "custom" };
  }
  if (range === "yesterday") {
    start.setDate(today.getDate() - 1);
    end.setDate(today.getDate() - 1);
  } else if (range === "week") {
    const day = today.getDay() || 7;
    start.setDate(today.getDate() - day + 1);
  } else if (range === "month") {
    start.setDate(1);
  }
  return { dateFrom: toDateKey(start), dateTo: toDateKey(end), range };
};

app.get("/accounts", async (req, res) => {
  try {
    const search = cleanText(req.query.search).toLowerCase();
    const accountType = req.query.account_type ? normalizeAccountType(req.query.account_type) : "";
    const rows = await loadUnifiedAccounts();
    return res.json(rows.filter((account) =>
      (!accountType || account.account_type === accountType) &&
      (!search || account.account_name.toLowerCase().includes(search) || String(account.mobile_number || "").includes(search))
    ));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Accounts" });
  }
});

app.post("/accounts", async (req, res) => {
  try {
    const account = readAccountPayload(req.body);
    if (!account.account_name || !ACCOUNT_TYPES.has(account.account_type) || account.opening_balance === null) {
      return res.status(400).json({ message: "Enter valid account details" });
    }
    if (account.account_type === "CUSTOMER") {
      const duplicate = await pool.query(
        "SELECT id FROM customers WHERE LOWER(customer_name) = LOWER($1) AND COALESCE(mobile_number, '') = COALESCE($2, '') LIMIT 1",
        [account.account_name, account.mobile_number]
      );
      if (duplicate.rows.length) return res.status(409).json({ message: "This customer already exists." });
      const result = await pool.query(
        `
        INSERT INTO customers (
          customer_name, customer_type, firm_name, mobile_number, alternate_number, address,
          city, gst_number, bank_name, account_number, ifsc_code, upi_id, notes,
          opening_balance, active, whatsapp_number, whatsapp_opt_in
        )
        VALUES ($1, 'RETAIL', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        RETURNING id
        `,
        [
          account.account_name, account.firm_name, account.mobile_number, account.alternate_number,
          account.address, account.city, account.gst_number, account.bank_name, account.account_number,
          account.ifsc_code, account.upi_id, account.notes, account.opening_balance, account.active,
          account.whatsapp_number, account.whatsapp_opt_in,
        ]
      );
      return res.status(201).json({ success: true, account_key: `CUSTOMER-${result.rows[0].id}` });
    }
    if (["SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(account.account_type)) {
      const duplicate = await pool.query(
        `
        SELECT id
        FROM suppliers
        WHERE LOWER(supplier_name) = LOWER($1)
           OR ($2::TEXT IS NOT NULL AND LOWER(COALESCE(firm_name, '')) = LOWER($2))
        LIMIT 1
        `,
        [account.account_name, account.firm_name]
      );
      if (duplicate.rows.length) return res.status(409).json({ message: "This supplier already exists." });
      const result = await pool.query(
        `
        INSERT INTO suppliers (
          supplier_name, firm_name, mobile_number, alternate_number, address, city,
          gst_number, bank_name, account_number, ifsc_code, upi_id, notes,
          opening_balance, supplier_type, active, whatsapp_number, whatsapp_opt_in
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        RETURNING id
        `,
        [
          account.account_name, account.firm_name, account.mobile_number, account.alternate_number,
          account.address, account.city, account.gst_number, account.bank_name, account.account_number,
          account.ifsc_code, account.upi_id, account.notes, account.opening_balance,
          supplierTypeFromAccountType(account.account_type), account.active,
          account.whatsapp_number, account.whatsapp_opt_in,
        ]
      );
      return res.status(201).json({ success: true, account_key: `SUPPLIER-${result.rows[0].id}` });
    }
    const result = await pool.query(
      `
      INSERT INTO accounts (
        account_name, account_type, firm_name, mobile_number, alternate_number, address, city,
        gst_number, bank_name, account_number, ifsc_code, upi_id, opening_balance, active, notes,
        whatsapp_number, whatsapp_opt_in
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING id
      `,
      [
        account.account_name, account.account_type, account.firm_name, account.mobile_number,
        account.alternate_number, account.address, account.city, account.gst_number,
        account.bank_name, account.account_number, account.ifsc_code, account.upi_id,
        account.opening_balance, account.active, account.notes,
        account.whatsapp_number, account.whatsapp_opt_in,
      ]
    );
    return res.status(201).json({ success: true, account_key: `ACCOUNT-${result.rows[0].id}` });
  } catch (error) {
    console.error(error);
    if (error.code === "23505") {
      return res.status(409).json({ message: "This customer/supplier already exists." });
    }
    return res.status(500).json({ message: "Error Saving Account" });
  }
});

app.put("/accounts/:accountKey", async (req, res) => {
  try {
    const [source, idValue] = String(req.params.accountKey || "").split("-");
    const sourceId = parsePositiveInteger(Number(idValue));
    const account = readAccountPayload(req.body);
    if (!sourceId || !account.account_name || !ACCOUNT_TYPES.has(account.account_type) || account.opening_balance === null) {
      return res.status(400).json({ message: "Enter valid account details" });
    }
    if (source === "CUSTOMER") {
      const existingCustomer = await pool.query("SELECT id, system_account FROM customers WHERE id = $1", [sourceId]);
      if (existingCustomer.rows[0]?.system_account === true && (account.account_name !== "Walk-in Customer" || account.active !== true)) {
        return res.status(400).json({ message: "Walk-in Customer is a protected system account." });
      }
      const duplicate = await pool.query(
        "SELECT id FROM customers WHERE id <> $3 AND LOWER(customer_name) = LOWER($1) AND COALESCE(mobile_number, '') = COALESCE($2, '') LIMIT 1",
        [account.account_name, account.mobile_number, sourceId]
      );
      if (duplicate.rows.length) return res.status(409).json({ message: "This customer already exists." });
      const result = await pool.query(
        `
        UPDATE customers
        SET customer_name = $1, firm_name = $2, mobile_number = $3, alternate_number = $4,
            address = $5, city = $6, gst_number = $7, bank_name = $8, account_number = $9,
            ifsc_code = $10, upi_id = $11, opening_balance = $12, active = $13,
            notes = $14, whatsapp_number = $15, whatsapp_opt_in = $16, updated_at = CURRENT_TIMESTAMP
        WHERE id = $17
        RETURNING id
        `,
        [
          account.account_name, account.firm_name, account.mobile_number, account.alternate_number,
          account.address, account.city, account.gst_number, account.bank_name, account.account_number,
          account.ifsc_code, account.upi_id, account.opening_balance, account.active, account.notes,
          account.whatsapp_number, account.whatsapp_opt_in, sourceId,
        ]
      );
      return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Account not found" });
    }
    if (source === "SUPPLIER") {
      const duplicate = await pool.query(
        `
        SELECT id
        FROM suppliers
        WHERE id <> $3
          AND (
            LOWER(supplier_name) = LOWER($1)
            OR ($2::TEXT IS NOT NULL AND LOWER(COALESCE(firm_name, '')) = LOWER($2))
          )
        LIMIT 1
        `,
        [account.account_name, account.firm_name, sourceId]
      );
      if (duplicate.rows.length) return res.status(409).json({ message: "This supplier already exists." });
      const result = await pool.query(
        `
        UPDATE suppliers
        SET supplier_name = $1, firm_name = $2, mobile_number = $3, alternate_number = $4,
            address = $5, city = $6, gst_number = $7, bank_name = $8, account_number = $9,
            ifsc_code = $10, upi_id = $11, opening_balance = $12, supplier_type = $13,
            active = $14, notes = $15, whatsapp_number = $16, whatsapp_opt_in = $17, updated_at = CURRENT_TIMESTAMP
        WHERE id = $18
        RETURNING id
        `,
        [
          account.account_name, account.firm_name, account.mobile_number, account.alternate_number,
          account.address, account.city, account.gst_number, account.bank_name, account.account_number,
          account.ifsc_code, account.upi_id, account.opening_balance,
          supplierTypeFromAccountType(account.account_type), account.active, account.notes,
          account.whatsapp_number, account.whatsapp_opt_in, sourceId,
        ]
      );
      return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Account not found" });
    }
    if (source === "ACCOUNT") {
      const result = await pool.query(
        `
        UPDATE accounts
        SET account_name = $1, account_type = $2, firm_name = $3, mobile_number = $4,
            alternate_number = $5, address = $6, city = $7, gst_number = $8,
            bank_name = $9, account_number = $10, ifsc_code = $11, upi_id = $12,
            opening_balance = $13, active = $14, notes = $15,
            whatsapp_number = $16, whatsapp_opt_in = $17, updated_at = CURRENT_TIMESTAMP
        WHERE id = $18
        RETURNING id
        `,
        [
          account.account_name, account.account_type, account.firm_name, account.mobile_number,
          account.alternate_number, account.address, account.city, account.gst_number,
          account.bank_name, account.account_number, account.ifsc_code, account.upi_id,
          account.opening_balance, account.active, account.notes,
          account.whatsapp_number, account.whatsapp_opt_in, sourceId,
        ]
      );
      return result.rows[0] ? res.json({ success: true }) : res.status(404).json({ message: "Account not found" });
    }
    return res.status(400).json({ message: "Invalid account" });
  } catch (error) {
    console.error(error);
    if (error.code === "23505") {
      return res.status(409).json({ message: "This customer/supplier already exists." });
    }
    return res.status(500).json({ message: "Error Updating Account" });
  }
});

app.get("/accounts/outstanding", async (req, res) => {
  try {
    const accounts = await loadUnifiedAccounts();
    const customerOutstanding = accounts.filter((account) => account.account_type === "CUSTOMER");
    const supplierOutstanding = accounts.filter((account) => ["SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(account.account_type));
    return res.json({
      customerOutstanding,
      supplierOutstanding,
      totalReceivable: roundCurrency(customerOutstanding.reduce((sum, account) => sum + Number(account.receivable_balance || 0), 0)),
      totalPayable: roundCurrency(supplierOutstanding.reduce((sum, account) => sum + Number(account.payable_balance || 0), 0)),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Account Outstanding" });
  }
});

app.get("/accounts/ledger", async (req, res) => {
  try {
    const accountKey = String(req.query.account_key || "");
    const [source, idValue] = accountKey.split("-");
    const sourceId = parsePositiveInteger(Number(idValue));
    if (!sourceId || !["CUSTOMER", "SUPPLIER", "ACCOUNT"].includes(source)) {
      return res.json({ account: null, ledger: [] });
    }
    if (source === "CUSTOMER") {
      const customers = await getCustomerSummaryRows({ customerId: sourceId });
      if (customers.length === 0) return res.json({ account: null, ledger: [] });
      const ledgerResult = await pool.query(
        `
        SELECT *
        FROM (
          SELECT s.sale_date AS date, 'Sale' AS transaction_type,
            COALESCE(s.invoice_no, 'Sale #' || s.id) AS invoice_no,
            s.total_amount AS sale_amount,
            s.payment_mode,
            s.total_amount AS debit,
            COALESCE(pay.total_paid, 0) AS credit,
            s.total_amount - COALESCE(pay.total_paid, 0) AS delta,
            COALESCE(s.customer_name, c.customer_name, 'Walk-in Customer') || ' - ' || COALESCE(s.invoice_no, 'Sale #' || s.id) AS remarks,
            s.created_at
          FROM sales s
          JOIN customers c ON c.id = $1
          LEFT JOIN (
            SELECT sale_id, SUM(amount) AS total_paid
            FROM sale_payments
            GROUP BY sale_id
          ) pay ON pay.sale_id = s.id
          WHERE s.sale_status <> 'CANCELLED'
            AND (
              s.customer_id = $1
              OR (s.customer_id IS NULL AND s.customer_mobile IS NOT NULL AND s.customer_mobile = $2)
              OR (s.customer_id IS NULL AND c.system_account = TRUE AND (s.customer_name IS NULL OR LOWER(COALESCE(s.customer_name, '')) LIKE '%walk-in%'))
              OR (s.customer_id IS NULL AND c.system_account IS DISTINCT FROM TRUE AND s.customer_mobile IS NULL AND s.customer_name IS NOT NULL AND LOWER(s.customer_name) = LOWER($3))
            )
          UNION ALL
          SELECT cp.payment_date AS date, 'Customer Payment' AS transaction_type,
            COALESCE(cp.reference_number, '') AS invoice_no,
            0::NUMERIC AS sale_amount,
            cp.payment_mode,
            0 AS debit,
            cp.payment_amount AS credit,
            -cp.payment_amount AS delta,
            COALESCE(cp.remarks, cp.reference_number, 'Customer payment') AS remarks,
            cp.created_at
          FROM customer_payments cp
          WHERE cp.customer_id = $1 AND cp.cancelled = FALSE
        ) entries
        ORDER BY date, created_at
        `,
        [sourceId, customers[0].mobile_number || "", customers[0].customer_name]
      );
      let balance = Number(customers[0].opening_balance || 0);
      const ledger = [];
      if (balance > 0) {
        ledger.push({ date: toDateKey(customers[0].created_at), transaction_type: "Opening Balance", debit: balance, credit: 0, balance, remarks: "Opening customer receivable balance" });
      }
      for (const row of ledgerResult.rows) {
        balance = roundCurrency(balance + Number(row.delta || 0));
        ledger.push({
          date: toDateKey(row.date),
          invoice_no: row.invoice_no || "",
          transaction_type: row.transaction_type,
          sale_amount: Number(row.sale_amount || 0),
          payment_mode: row.payment_mode || "",
          debit: Number(row.debit || 0),
          credit: Number(row.credit || 0),
          balance,
          remarks: row.remarks || "",
        });
      }
      return res.json({ account: customers[0], ledger });
    }
    if (source === "SUPPLIER") {
      const supplierPayload = await pool.query("SELECT * FROM suppliers WHERE id = $1", [sourceId]);
      if (supplierPayload.rows.length === 0) return res.json({ account: null, ledger: [] });
      const ledgerPayload = await (async () => {
        const suppliers = await getSupplierSummaryRows({ supplierId: sourceId });
        const ledgerResult = await pool.query(
          `
          SELECT *
          FROM (
            SELECT p.purchase_date AS date, 'Purchase' AS transaction_type,
              COALESCE(NULLIF(p.gross_amount, 0), p.total_amount, 0) AS debit,
              COALESCE(p.rebate_amount, 0) + COALESCE(p.paid_amount, 0) AS credit,
              COALESCE(NULLIF(p.gross_amount, 0), p.total_amount, 0) - COALESCE(p.rebate_amount, 0) - COALESCE(p.paid_amount, 0) AS delta,
              p.supplier_name AS account_name,
              COALESCE(p.payment_timing, '') AS remarks,
              p.created_at
            FROM purchases p
            WHERE p.supplier_id = $1
              AND COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
              AND COALESCE(p.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
            UNION ALL
            SELECT sp.payment_date AS date,
              CASE WHEN sp.rebate_amount > 0 AND sp.payment_amount = 0 THEN 'Rebate' ELSE 'Supplier Payment' END AS transaction_type,
              0 AS debit,
              sp.payment_amount + sp.rebate_amount AS credit,
              -(sp.payment_amount + sp.rebate_amount) AS delta,
              s.supplier_name AS account_name,
              COALESCE(sp.remarks, sp.reference_number, '') AS remarks,
              sp.created_at
            FROM supplier_payments sp
            JOIN suppliers s ON s.id = sp.supplier_id
            WHERE sp.supplier_id = $1 AND sp.cancelled = FALSE
          ) entries
          ORDER BY date, created_at
          `,
          [sourceId]
        );
        let balance = Number(suppliers[0]?.opening_balance || 0);
        const ledger = [];
        if (balance > 0) {
          ledger.push({ date: toDateKey(suppliers[0].created_at), transaction_type: "Opening Balance", debit: balance, credit: 0, balance, remarks: "Opening supplier payable balance" });
        }
        for (const row of ledgerResult.rows) {
          balance = roundCurrency(balance + Number(row.delta || 0));
          ledger.push({
            date: toDateKey(row.date),
            transaction_type: row.transaction_type,
            debit: Number(row.debit || 0),
            credit: Number(row.credit || 0),
            balance,
            remarks: row.remarks || "",
          });
        }
        return { account: suppliers[0] || supplierPayload.rows[0], ledger };
      })();
      return res.json(ledgerPayload);
    }
    const accountResult = await pool.query("SELECT * FROM accounts WHERE id = $1", [sourceId]);
    const account = accountResult.rows[0];
    if (!account) return res.json({ account: null, ledger: [] });
    const opening = Number(account.opening_balance || 0);
    return res.json({
      account,
      ledger: opening > 0 ? [{
        date: toDateKey(account.created_at),
        transaction_type: "Opening Balance",
        debit: opening,
        credit: 0,
        balance: opening,
        remarks: "Opening account balance",
      }] : [],
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Account Ledger" });
  }
});

app.get("/accounts/payments", async (req, res) => {
  try {
    return res.json(await getUnifiedPaymentRows({ accountKey: req.query.account_key }));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Account Payments" });
  }
});

app.post("/accounts/payments", async (req, res) => {
  try {
    const accountKey = String(req.body.account_key || "");
    const [source, idValue] = accountKey.split("-");
    const sourceId = parsePositiveInteger(Number(idValue));
    const action = String(req.body.payment_action || "").toUpperCase();
    const amount = parseNonNegativeNumber(req.body.amount);
    const rebateAmount = parseNonNegativeNumber(req.body.rebate_amount);
    const paymentMode = normalizePaymentMode(req.body.payment_mode || "CASH");
    if (!sourceId || amount === null || !SUPPLIER_PAYMENT_MODES.has(paymentMode)) {
      return res.status(400).json({ message: "Enter valid account payment details" });
    }
    if (action === "RECEIVE_CUSTOMER" && source === "CUSTOMER") {
      if (amount <= 0) {
        return res.status(400).json({ message: "Customer payment amount must be greater than zero" });
      }
      const result = await pool.query(
        `
        INSERT INTO customer_payments (
          customer_id, payment_date, payment_amount, payment_mode, reference_number,
          remarks, branch_id, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
        `,
        [
          sourceId, req.body.payment_date || toDateKey(new Date()), amount, paymentMode,
          nullableText(req.body.reference_number), nullableText(req.body.remarks),
          parsePositiveInteger(req.body.branch_id), parsePositiveInteger(req.body.created_by) || 1,
        ]
      );
      return res.status(201).json(result.rows[0]);
    }
    if (["PAY_SUPPLIER", "SUPPLIER_REBATE"].includes(action) && source === "SUPPLIER") {
      const supplierPaymentAmount = action === "SUPPLIER_REBATE" ? 0 : amount;
      const supplierRebateAmount = action === "SUPPLIER_REBATE" ? amount : Number(rebateAmount || 0);
      if (supplierPaymentAmount + supplierRebateAmount <= 0) {
        return res.status(400).json({ message: "Enter payment amount or rebate amount" });
      }
      const result = await pool.query(
        `
        INSERT INTO supplier_payments (
          supplier_id, payment_date, payment_amount, rebate_amount, payment_mode,
          reference_number, remarks, branch_id, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING *
        `,
        [
          sourceId, req.body.payment_date || toDateKey(new Date()),
          supplierPaymentAmount,
          supplierRebateAmount,
          paymentMode, nullableText(req.body.reference_number), nullableText(req.body.remarks),
          parsePositiveInteger(req.body.branch_id), parsePositiveInteger(req.body.created_by) || 1,
        ]
      );
      return res.status(201).json(result.rows[0]);
    }
    return res.status(400).json({ message: "Selected account type does not match payment action" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Account Payment" });
  }
});

app.put("/accounts/payments/:paymentKey", async (req, res) => {
  const client = await pool.connect();
  try {
    const [source, idValue] = String(req.params.paymentKey || "").split("-");
    const paymentId = parsePositiveInteger(Number(idValue));
    const accountKey = String(req.body.account_key || "");
    const [accountSource, accountIdValue] = accountKey.split("-");
    const accountId = parsePositiveInteger(Number(accountIdValue));
    const paymentAmount = parseNonNegativeNumber(req.body.payment_amount ?? req.body.amount);
    const rebateAmount = parseNonNegativeNumber(req.body.rebate_amount);
    const paymentMode = normalizePaymentMode(req.body.payment_mode || "CASH");
    const editedBy = parsePositiveInteger(req.body.edited_by) || parsePositiveInteger(req.body.created_by) || 1;
    const reason = cleanText(req.body.reason);
    const paymentDate = req.body.payment_date || toDateKey(new Date());
    if (!paymentId || !accountId || !reason || paymentAmount === null || !SUPPLIER_PAYMENT_MODES.has(paymentMode)) {
      return res.status(400).json({ message: "Enter valid payment edit details and reason" });
    }
    await client.query("BEGIN");
    if (source === "CUSTOMER" && accountSource === "CUSTOMER") {
      if (paymentAmount <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Customer payment amount must be greater than zero" });
      }
      const oldResult = await client.query("SELECT * FROM customer_payments WHERE id = $1 FOR UPDATE", [paymentId]);
      const oldPayment = oldResult.rows[0];
      if (!oldPayment) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Customer payment not found" });
      }
      if (oldPayment.cancelled) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Cancelled customer payments cannot be edited" });
      }
      const result = await client.query(
        `
        UPDATE customer_payments
        SET customer_id = $1, payment_date = $2, payment_amount = $3, payment_mode = $4,
            reference_number = $5, remarks = $6, branch_id = $7,
            edited_by = $8, edited_at = CURRENT_TIMESTAMP, edit_reason = $9
        WHERE id = $10
        RETURNING *
        `,
        [
          accountId, paymentDate, paymentAmount, paymentMode, nullableText(req.body.reference_number),
          nullableText(req.body.remarks), parsePositiveInteger(req.body.branch_id), editedBy, reason, paymentId,
        ]
      );
      await client.query(
        `
        INSERT INTO customer_payment_audit (customer_payment_id, action, old_value, new_value, reason, edited_by)
        VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
        `,
        [paymentId, JSON.stringify(oldPayment), JSON.stringify(result.rows[0]), reason, editedBy]
      );
      await client.query("COMMIT");
      return res.json(result.rows[0]);
    }
    if (source === "SUPPLIER" && accountSource === "SUPPLIER") {
      if (rebateAmount === null || paymentAmount + rebateAmount <= 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Supplier payment or rebate must be greater than zero" });
      }
      const oldResult = await client.query("SELECT * FROM supplier_payments WHERE id = $1 FOR UPDATE", [paymentId]);
      const oldPayment = oldResult.rows[0];
      if (!oldPayment) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Supplier payment not found" });
      }
      if (oldPayment.cancelled) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Cancelled supplier payments cannot be edited" });
      }
      const result = await client.query(
        `
        UPDATE supplier_payments
        SET supplier_id = $1, payment_date = $2, payment_amount = $3, rebate_amount = $4,
            payment_mode = $5, reference_number = $6, remarks = $7, branch_id = $8,
            edited_by = $9, edited_at = CURRENT_TIMESTAMP, edit_reason = $10
        WHERE id = $11
        RETURNING *
        `,
        [
          accountId, paymentDate, paymentAmount, rebateAmount, paymentMode, nullableText(req.body.reference_number),
          nullableText(req.body.remarks), parsePositiveInteger(req.body.branch_id), editedBy, reason, paymentId,
        ]
      );
      await client.query(
        `
        INSERT INTO supplier_payment_audit (supplier_payment_id, action, old_value, new_value, reason, edited_by)
        VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
        `,
        [paymentId, JSON.stringify(oldPayment), JSON.stringify(result.rows[0]), reason, editedBy]
      );
      await client.query("COMMIT");
      return res.json(result.rows[0]);
    }
    await client.query("ROLLBACK");
    return res.status(400).json({ message: "Payment type and account type do not match" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Updating Account Payment" });
  } finally {
    client.release();
  }
});

app.post("/accounts/payments/:paymentKey/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const [source, idValue] = String(req.params.paymentKey || "").split("-");
    const paymentId = parsePositiveInteger(Number(idValue));
    const cancelledBy = parsePositiveInteger(req.body.cancelled_by) || 1;
    const reason = cleanText(req.body.reason);
    if (!paymentId || !reason) return res.status(400).json({ message: "Cancellation reason is required" });
    await client.query("BEGIN");
    if (source === "CUSTOMER") {
      const oldResult = await client.query("SELECT * FROM customer_payments WHERE id = $1 FOR UPDATE", [paymentId]);
      const oldPayment = oldResult.rows[0];
      if (!oldPayment) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Customer payment not found" });
      }
      if (oldPayment.cancelled) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Customer payment is already cancelled" });
      }
      const result = await client.query(
        `
        UPDATE customer_payments
        SET cancelled = TRUE, cancelled_by = $1, cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = $2
        WHERE id = $3
        RETURNING *
        `,
        [cancelledBy, reason, paymentId]
      );
      await client.query(
        `
        INSERT INTO customer_payment_audit (customer_payment_id, action, old_value, new_value, reason, edited_by)
        VALUES ($1, 'CANCEL', $2::jsonb, $3::jsonb, $4, $5)
        `,
        [paymentId, JSON.stringify(oldPayment), JSON.stringify(result.rows[0]), reason, cancelledBy]
      );
      await client.query("COMMIT");
      return res.json({ success: true, payment: result.rows[0] });
    }
    if (source === "SUPPLIER") {
      const oldResult = await client.query("SELECT * FROM supplier_payments WHERE id = $1 FOR UPDATE", [paymentId]);
      const oldPayment = oldResult.rows[0];
      if (!oldPayment) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Supplier payment not found" });
      }
      if (oldPayment.cancelled) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Supplier payment is already cancelled" });
      }
      const result = await client.query(
        `
        UPDATE supplier_payments
        SET cancelled = TRUE, cancelled_by = $1, cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = $2
        WHERE id = $3
        RETURNING *
        `,
        [cancelledBy, reason, paymentId]
      );
      await client.query(
        `
        INSERT INTO supplier_payment_audit (supplier_payment_id, action, old_value, new_value, reason, edited_by)
        VALUES ($1, 'CANCEL', $2::jsonb, $3::jsonb, $4, $5)
        `,
        [paymentId, JSON.stringify(oldPayment), JSON.stringify(result.rows[0]), reason, cancelledBy]
      );
      await client.query("COMMIT");
      return res.json({ success: true, payment: result.rows[0] });
    }
    await client.query("ROLLBACK");
    return res.status(400).json({ message: "Invalid payment" });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Cancelling Account Payment" });
  } finally {
    client.release();
  }
});

app.get("/accounts/payments/:paymentKey/audit", async (req, res) => {
  try {
    const [source, idValue] = String(req.params.paymentKey || "").split("-");
    const paymentId = parsePositiveInteger(Number(idValue));
    if (!paymentId) return res.json([]);
    if (source === "CUSTOMER") {
      const result = await pool.query(
        `
        SELECT cpa.*, u.full_name AS edited_by_name
        FROM customer_payment_audit cpa
        LEFT JOIN users u ON u.id = cpa.edited_by
        WHERE cpa.customer_payment_id = $1
        ORDER BY cpa.edited_at DESC, cpa.id DESC
        `,
        [paymentId]
      );
      return res.json(result.rows);
    }
    if (source === "SUPPLIER") {
      const result = await pool.query(
        `
        SELECT spa.*, u.full_name AS edited_by_name
        FROM supplier_payment_audit spa
        LEFT JOIN users u ON u.id = spa.edited_by
        WHERE spa.supplier_payment_id = $1
        ORDER BY spa.edited_at DESC, spa.id DESC
        `,
        [paymentId]
      );
      return res.json(result.rows);
    }
    return res.json([]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Payment Audit" });
  }
});

app.get("/suppliers", async (req, res) => {
  try {
    const active = req.query.active === undefined ? undefined : String(req.query.active) === "true";
    const rows = await getSupplierSummaryRows({
      active,
      search: cleanText(req.query.search),
    });
    return res.json(rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Suppliers" });
  }
});

app.post("/suppliers", async (req, res) => {
  try {
    const supplier = readSupplierPayload(req.body);
    if (!supplier.supplier_name || supplier.opening_balance === null || !SUPPLIER_TYPES.has(supplier.supplier_type)) {
      return res.status(400).json({ message: "Enter valid supplier account details" });
    }
    const duplicate = await pool.query(
      `
      SELECT id
      FROM suppliers
      WHERE LOWER(supplier_name) = LOWER($1)
         OR ($2::TEXT IS NOT NULL AND LOWER(COALESCE(firm_name, '')) = LOWER($2))
      LIMIT 1
      `,
      [supplier.supplier_name, supplier.firm_name]
    );
    if (duplicate.rows.length) return res.status(409).json({ message: "This supplier already exists." });

    const result = await pool.query(
      `
      INSERT INTO suppliers (
        supplier_name, firm_name, mobile_number, alternate_number, address, city,
        gst_number, bank_name, account_number, ifsc_code, upi_id, notes,
        opening_balance, supplier_type, active, whatsapp_number, whatsapp_opt_in
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *
      `,
      [
        supplier.supplier_name, supplier.firm_name, supplier.mobile_number, supplier.alternate_number,
        supplier.address, supplier.city, supplier.gst_number, supplier.bank_name, supplier.account_number,
        supplier.ifsc_code, supplier.upi_id, supplier.notes, supplier.opening_balance, supplier.supplier_type,
        supplier.active, supplier.whatsapp_number, supplier.whatsapp_opt_in,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    if (error.code === "23505") return res.status(409).json({ message: "This supplier already exists." });
    return res.status(500).json({ message: "Error Saving Supplier" });
  }
});

app.get("/suppliers/:id", async (req, res) => {
  try {
    const supplierId = parsePositiveInteger(req.params.id);
    if (!supplierId) return res.status(400).json({ message: "Invalid supplier" });
    const rows = await getSupplierSummaryRows({ supplierId });
    return rows[0] ? res.json(rows[0]) : res.status(404).json({ message: "Supplier not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Supplier" });
  }
});

app.put("/suppliers/:id", async (req, res) => {
  try {
    const supplierId = parsePositiveInteger(req.params.id);
    const supplier = readSupplierPayload(req.body);
    if (!supplierId || !supplier.supplier_name || supplier.opening_balance === null || !SUPPLIER_TYPES.has(supplier.supplier_type)) {
      return res.status(400).json({ message: "Enter valid supplier account details" });
    }
    const duplicate = await pool.query(
      `
      SELECT id
      FROM suppliers
      WHERE id <> $3
        AND (
          LOWER(supplier_name) = LOWER($1)
          OR ($2::TEXT IS NOT NULL AND LOWER(COALESCE(firm_name, '')) = LOWER($2))
        )
      LIMIT 1
      `,
      [supplier.supplier_name, supplier.firm_name, supplierId]
    );
    if (duplicate.rows.length) return res.status(409).json({ message: "This supplier already exists." });

    const result = await pool.query(
      `
      UPDATE suppliers
      SET
        supplier_name = $1,
        firm_name = $2,
        mobile_number = $3,
        alternate_number = $4,
        address = $5,
        city = $6,
        gst_number = $7,
        bank_name = $8,
        account_number = $9,
        ifsc_code = $10,
        upi_id = $11,
        notes = $12,
        opening_balance = $13,
        supplier_type = $14,
        active = $15,
        whatsapp_number = $16,
        whatsapp_opt_in = $17,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $18
      RETURNING *
      `,
      [
        supplier.supplier_name, supplier.firm_name, supplier.mobile_number, supplier.alternate_number,
        supplier.address, supplier.city, supplier.gst_number, supplier.bank_name, supplier.account_number,
        supplier.ifsc_code, supplier.upi_id, supplier.notes, supplier.opening_balance, supplier.supplier_type,
        supplier.active, supplier.whatsapp_number, supplier.whatsapp_opt_in, supplierId,
      ]
    );
    return result.rows[0] ? res.json(result.rows[0]) : res.status(404).json({ message: "Supplier not found" });
  } catch (error) {
    console.error(error);
    if (error.code === "23505") return res.status(409).json({ message: "This supplier already exists." });
    return res.status(500).json({ message: "Error Updating Supplier" });
  }
});

app.delete("/suppliers/:id", async (req, res) => {
  try {
    const supplierId = parsePositiveInteger(req.params.id);
    if (!supplierId) return res.status(400).json({ message: "Invalid supplier" });
    const result = await pool.query(
      "UPDATE suppliers SET active = FALSE, updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *",
      [supplierId]
    );
    return result.rows[0]
      ? res.json({ success: true, supplier: result.rows[0], message: "Supplier marked inactive" })
      : res.status(404).json({ message: "Supplier not found" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Updating Supplier Status" });
  }
});

app.get("/supplier-summary", async (req, res) => {
  try {
    const supplierId = req.query.supplier_id ? parsePositiveInteger(req.query.supplier_id) : null;
    if (req.query.supplier_id && !supplierId) return res.status(400).json({ message: "Invalid supplier" });
    const rows = await getSupplierSummaryRows({ supplierId });
    return res.json(buildSupplierSummaryPayload(rows));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Supplier Summary" });
  }
});

app.get("/customers", async (req, res) => {
  try {
    const active = req.query.active === undefined ? undefined : String(req.query.active) === "true";
    const rows = await getCustomerSummaryRows({ active, search: cleanText(req.query.search) });
    return res.json(rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Customers" });
  }
});

app.post("/customers", async (req, res) => {
  try {
    const customer = readCustomerPayload(req.body);
    if (!customer.customer_name || !CUSTOMER_TYPES.has(customer.customer_type) || customer.opening_balance === null) {
      return res.status(400).json({ message: "Enter valid customer details" });
    }
    const duplicate = await pool.query(
      "SELECT id FROM customers WHERE LOWER(customer_name) = LOWER($1) AND COALESCE(mobile_number, '') = COALESCE($2, '') LIMIT 1",
      [customer.customer_name, customer.mobile_number]
    );
    if (duplicate.rows.length) return res.status(409).json({ message: "This customer already exists." });
    const result = await pool.query(
      `
      INSERT INTO customers (
        customer_name, customer_type, firm_name, mobile_number, alternate_number, address,
        city, gst_number, bank_name, account_number, ifsc_code, upi_id, notes,
        opening_balance, active, whatsapp_number, whatsapp_opt_in
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      RETURNING *
      `,
      [
        customer.customer_name, customer.customer_type, customer.firm_name, customer.mobile_number,
        customer.alternate_number, customer.address, customer.city, customer.gst_number,
        customer.bank_name, customer.account_number, customer.ifsc_code, customer.upi_id,
        customer.notes, customer.opening_balance, customer.active, customer.whatsapp_number, customer.whatsapp_opt_in,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    if (error.code === "23505") return res.status(409).json({ message: "This customer already exists." });
    return res.status(500).json({ message: "Error Saving Customer" });
  }
});

app.put("/customers/:id", async (req, res) => {
  try {
    const customerId = parsePositiveInteger(req.params.id);
    const customer = readCustomerPayload(req.body);
    if (!customerId || !customer.customer_name || !CUSTOMER_TYPES.has(customer.customer_type) || customer.opening_balance === null) {
      return res.status(400).json({ message: "Enter valid customer details" });
    }
    const existingCustomer = await pool.query("SELECT id, system_account FROM customers WHERE id = $1", [customerId]);
    if (existingCustomer.rows[0]?.system_account === true && (customer.customer_name !== "Walk-in Customer" || customer.active !== true)) {
      return res.status(400).json({ message: "Walk-in Customer is a protected system account." });
    }
    const duplicate = await pool.query(
      "SELECT id FROM customers WHERE id <> $3 AND LOWER(customer_name) = LOWER($1) AND COALESCE(mobile_number, '') = COALESCE($2, '') LIMIT 1",
      [customer.customer_name, customer.mobile_number, customerId]
    );
    if (duplicate.rows.length) return res.status(409).json({ message: "This customer already exists." });
    const result = await pool.query(
      `
      UPDATE customers
      SET customer_name = $1, customer_type = $2, firm_name = $3, mobile_number = $4,
          alternate_number = $5, address = $6, city = $7, gst_number = $8,
          bank_name = $9, account_number = $10, ifsc_code = $11, upi_id = $12,
          notes = $13, opening_balance = $14, active = $15,
          whatsapp_number = $16, whatsapp_opt_in = $17,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $18
      RETURNING *
      `,
      [
        customer.customer_name, customer.customer_type, customer.firm_name, customer.mobile_number,
        customer.alternate_number, customer.address, customer.city, customer.gst_number,
        customer.bank_name, customer.account_number, customer.ifsc_code, customer.upi_id,
        customer.notes, customer.opening_balance, customer.active, customer.whatsapp_number, customer.whatsapp_opt_in, customerId,
      ]
    );
    return result.rows[0] ? res.json(result.rows[0]) : res.status(404).json({ message: "Customer not found" });
  } catch (error) {
    console.error(error);
    if (error.code === "23505") return res.status(409).json({ message: "This customer already exists." });
    return res.status(500).json({ message: "Error Updating Customer" });
  }
});

app.get("/customer-summary", async (req, res) => {
  try {
    const customerId = req.query.customer_id ? parsePositiveInteger(req.query.customer_id) : null;
    if (req.query.customer_id && !customerId) return res.status(400).json({ message: "Invalid customer" });
    const rows = await getCustomerSummaryRows({ customerId });
    return res.json(buildCustomerSummaryPayload(rows));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Customer Summary" });
  }
});

app.post("/customer-payments", async (req, res) => {
  try {
    const customerId = parsePositiveInteger(req.body.customer_id);
    const paymentAmount = parsePositiveNumber(req.body.payment_amount);
    const paymentMode = String(req.body.payment_mode || "CASH").trim().toUpperCase();
    const paymentDate = req.body.payment_date || toDateKey(new Date());
    if (!customerId || !paymentAmount || !["CASH", "UPI", "CARD", "BANK_TRANSFER"].includes(paymentMode)) {
      return res.status(400).json({ message: "Enter valid customer payment details" });
    }
    const customerResult = await pool.query("SELECT id FROM customers WHERE id = $1 AND active = TRUE", [customerId]);
    if (customerResult.rows.length === 0) return res.status(400).json({ message: "Select an active customer" });
    const result = await pool.query(
      `
      INSERT INTO customer_payments (
        customer_id, payment_date, payment_amount, payment_mode, reference_number,
        remarks, branch_id, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        customerId, paymentDate, paymentAmount, paymentMode, nullableText(req.body.reference_number),
        nullableText(req.body.remarks), parsePositiveInteger(req.body.branch_id), parsePositiveInteger(req.body.created_by) || 1,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Customer Payment" });
  }
});

app.get("/stock-inventory", async (req, res) => {
  try {
    const includeCancelled = String(req.query.include_cancelled ?? "true").toLowerCase() !== "false";
    const [lotsResult, auditResult] = await Promise.all([
      pool.query(`
        ${stockInventorySelectSql}
        WHERE ($1::boolean = TRUE OR COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED')
        ORDER BY ib.purchase_date, ib.created_at, ib.id
      `, [includeCancelled]),
      pool.query(
        `
        SELECT pat.*, p.product_name, p.category, u.full_name AS edited_by_name
        FROM product_audit_trail pat
        JOIN products p ON p.id = pat.product_id
        LEFT JOIN users u ON u.id = pat.edited_by
        WHERE pat.action LIKE 'INVENTORY_LOT_%' OR pat.action IN ('OPENING_STOCK', 'OPENING_STOCK_LOT_ADDED')
        ORDER BY pat.edited_at DESC, pat.id DESC
        LIMIT 500
        `
      ),
    ]);
    return res.json({ lots: lotsResult.rows, audit: auditResult.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Stock Inventory Error" });
  }
});

app.get("/pending-bills/customer", async (req, res) => {
  try {
    const creditSalesResult = await pool.query(
      `
      SELECT
        s.id,
        s.invoice_no,
        s.sale_date,
        s.due_date,
        s.customer_id,
        COALESCE(c.customer_name, s.customer_name, 'Walk-in Customer') AS customer_name,
        s.customer_mobile,
        s.gross_amount,
        s.item_discount_amount,
        s.invoice_discount_amount,
        s.total_amount,
        s.sale_status,
        COALESCE(pay.sale_paid, 0) AS sale_paid,
        COALESCE(
          STRING_AGG(
            p.product_name ||
            COALESCE(' ' || NULLIF(TRIM(CONCAT(ib.lot_name, CASE WHEN ib.lot_size IS NOT NULL THEN ' / ' || ib.lot_size ELSE '' END)), ''), '') ||
            ' ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM si.quantity::TEXT)) || ' ' || COALESCE(p.unit, '') ||
            ' @ ' || si.selling_rate::TEXT,
            E'\\n' ORDER BY si.id
          ),
          'No items'
        ) AS item_narration
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      LEFT JOIN sale_batch_allocations sba ON sba.sale_item_id = si.id
      LEFT JOIN inventory_batches ib ON ib.id = sba.inventory_batch_id
      LEFT JOIN (
        SELECT sale_id, SUM(amount) AS sale_paid
        FROM sale_payments
        GROUP BY sale_id
      ) pay ON pay.sale_id = s.id
      WHERE s.payment_mode = 'CREDIT'
        AND COALESCE(s.sale_status, 'COMPLETED') <> 'CANCELLED'
      GROUP BY s.id, c.customer_name, pay.sale_paid
      ORDER BY s.customer_id NULLS LAST, s.sale_date, s.id
      `
    );
    const paymentsResult = await pool.query(
      `
      SELECT
        cp.customer_id,
        SUM(cp.payment_amount) AS total_received
      FROM customer_payments cp
      WHERE COALESCE(cp.cancelled, FALSE) = FALSE
      GROUP BY cp.customer_id
      `
    );
    const paymentByCustomer = new Map(paymentsResult.rows.map((row) => [Number(row.customer_id), Number(row.total_received || 0)]));
    const invoices = [];
    const summaries = new Map();
    for (const row of creditSalesResult.rows) {
      const customerId = Number(row.customer_id || 0);
      const key = String(customerId || row.customer_name || "Walk-in Customer");
      const total = Number(row.total_amount || 0);
      const salePaid = Number(row.sale_paid || 0);
      const summary = summaries.get(key) || {
        key,
        customer_id: customerId || null,
        customer_name: row.customer_name || "Walk-in Customer",
        from: row.sale_date,
        to: row.sale_date,
        pending_bill_count: 0,
        total_credit_amount: 0,
        amount_received: 0,
        balance: 0,
        rows: [],
        remainingCustomerReceipts: Number(paymentByCustomer.get(customerId) || 0),
      };
      const allocatedCustomerPayment = Math.min(summary.remainingCustomerReceipts, Math.max(total - salePaid, 0));
      summary.remainingCustomerReceipts = roundCurrency(summary.remainingCustomerReceipts - allocatedCustomerPayment);
      const received = roundCurrency(salePaid + allocatedCustomerPayment);
      const balance = roundCurrency(Math.max(total - received, 0));
      const status = balance <= 0.01 ? "Paid" : received > 0 ? "Partially Paid" : "Pending";
      const invoice = {
        ...row,
        customer_id: customerId || null,
        gross_amount: Number(row.gross_amount || total),
        item_discount_amount: Number(row.item_discount_amount || 0),
        invoice_discount_amount: Number(row.invoice_discount_amount || 0),
        total_amount: total,
        received_amount: received,
        balance_amount: balance,
        credit_status: status,
      };
      invoices.push(invoice);
      if (balance > 0.01) summary.pending_bill_count += 1;
      summary.from = row.sale_date < summary.from ? row.sale_date : summary.from;
      summary.to = row.sale_date > summary.to ? row.sale_date : summary.to;
      summary.total_credit_amount = roundCurrency(summary.total_credit_amount + total);
      summary.amount_received = roundCurrency(summary.amount_received + received);
      summary.balance = roundCurrency(summary.balance + balance);
      summary.rows.push(invoice);
      summaries.set(key, summary);
    }
    const summaryRows = [...summaries.values()]
      .map(({ remainingCustomerReceipts, ...summary }) => summary)
      .filter((summary) => summary.balance > 0.01)
      .sort((left, right) => left.customer_name.localeCompare(right.customer_name));
    return res.json({ summary: summaryRows, invoices });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Customer Pending Bills" });
  }
});

app.get("/customer-ledger", async (req, res) => {
  try {
    const customerId = req.query.customer_id ? parsePositiveInteger(req.query.customer_id) : null;
    if (req.query.customer_id && !customerId) return res.status(400).json({ message: "Invalid customer" });
    const customers = await getCustomerSummaryRows({ customerId });
    if (customerId && customers.length === 0) return res.status(404).json({ message: "Customer not found" });
    if (customers.length === 0) return res.json({ customers: [], ledger: [] });
    const ids = customers.map((customer) => customer.id);
    const [salesResult, paymentResult] = await Promise.all([
      pool.query(
        `
        SELECT s.*, c.id AS customer_id, COALESCE(pay.total_paid, 0) AS total_paid
        FROM sales s
        JOIN customers c ON (
          s.customer_id = c.id
          OR (s.customer_id IS NULL AND s.customer_mobile IS NOT NULL AND c.mobile_number = s.customer_mobile)
          OR (s.customer_id IS NULL AND c.system_account = TRUE AND (s.customer_name IS NULL OR LOWER(COALESCE(s.customer_name, '')) LIKE '%walk-in%'))
          OR (s.customer_id IS NULL AND c.system_account IS DISTINCT FROM TRUE AND s.customer_mobile IS NULL AND s.customer_name IS NOT NULL AND LOWER(c.customer_name) = LOWER(s.customer_name))
        )
        LEFT JOIN (
          SELECT sale_id, SUM(amount) AS total_paid FROM sale_payments GROUP BY sale_id
        ) pay ON pay.sale_id = s.id
        WHERE c.id = ANY($1::INT[])
        ORDER BY s.sale_date, s.created_at, s.id
        `,
        [ids]
      ),
      pool.query(
        `
        SELECT cp.*, c.customer_name
        FROM customer_payments cp
        JOIN customers c ON c.id = cp.customer_id
        WHERE cp.customer_id = ANY($1::INT[])
          AND cp.cancelled = FALSE
        ORDER BY cp.payment_date, cp.created_at, cp.id
        `,
        [ids]
      ),
    ]);
    const ledgersByCustomer = new Map(ids.map((id) => [id, []]));
    const pushEvent = (event) => {
      if (!ledgersByCustomer.has(event.customer_id)) ledgersByCustomer.set(event.customer_id, []);
      ledgersByCustomer.get(event.customer_id).push(event);
    };
    for (const customer of customers) {
      if (Number(customer.opening_balance || 0) > 0) {
        pushEvent({
          customer_id: customer.id,
          customer_name: customer.customer_name,
          transaction_date: toDateKey(customer.created_at),
          sort_key: `O-${customer.id}`,
          transaction_type: "Opening Balance",
          debit_amount: Number(customer.opening_balance),
          credit_amount: 0,
          balance_delta: Number(customer.opening_balance),
          remarks: "Opening customer receivable balance",
        });
      }
    }
    for (const sale of salesResult.rows) {
      if (sale.sale_status !== "CANCELLED") {
        pushEvent({
          customer_id: sale.customer_id,
          customer_name: sale.customer_name,
          transaction_date: toDateKey(sale.sale_date),
          sort_key: `S-${String(sale.id).padStart(8, "0")}-0`,
          transaction_type: "Sale",
          invoice_no: sale.invoice_no || `Sale #${sale.id}`,
          sale_amount: Number(sale.total_amount || 0),
          payment_mode: sale.payment_mode || "",
          debit_amount: Number(sale.total_amount || 0),
          credit_amount: 0,
          balance_delta: Number(sale.total_amount || 0),
          remarks: `${sale.customer_name || "Walk-in Customer"} - ${sale.invoice_no || `Sale #${sale.id}`}`,
        });
        if (Number(sale.total_paid || 0) > 0) {
          pushEvent({
            customer_id: sale.customer_id,
            customer_name: sale.customer_name,
            transaction_date: toDateKey(sale.sale_date),
            sort_key: `S-${String(sale.id).padStart(8, "0")}-1`,
            transaction_type: "Sale Payment",
            invoice_no: sale.invoice_no || `Sale #${sale.id}`,
            sale_amount: 0,
            payment_mode: sale.payment_mode || "",
            debit_amount: 0,
            credit_amount: Number(sale.total_paid || 0),
            balance_delta: -Number(sale.total_paid || 0),
            remarks: `Payment for ${sale.invoice_no || `Sale #${sale.id}`}`,
          });
        }
      }
    }
    for (const payment of paymentResult.rows) {
      pushEvent({
        customer_id: payment.customer_id,
        customer_name: payment.customer_name,
        transaction_date: toDateKey(payment.payment_date),
        sort_key: `CP-${String(payment.id).padStart(8, "0")}`,
        transaction_type: "Customer Payment",
        invoice_no: payment.reference_number || "",
        sale_amount: 0,
        payment_mode: payment.payment_mode || "",
        debit_amount: 0,
        credit_amount: Number(payment.payment_amount || 0),
        balance_delta: -Number(payment.payment_amount || 0),
        remarks: payment.remarks || payment.reference_number || "Customer payment",
      });
    }
    const ledger = [];
    for (const customer of customers) {
      let runningBalance = 0;
      const rows = (ledgersByCustomer.get(customer.id) || []).sort((left, right) =>
        left.transaction_date.localeCompare(right.transaction_date) || left.sort_key.localeCompare(right.sort_key)
      );
      for (const row of rows) {
        runningBalance = roundCurrency(runningBalance + Number(row.balance_delta || 0));
        ledger.push({ ...row, running_balance: runningBalance });
      }
    }
    return res.json({ customers, ledger });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Customer Ledger" });
  }
});

app.get("/dashboard-metrics", async (req, res) => {
  try {
    return res.json(await getDashboardSummary());
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Dashboard Metrics" });
  }
});

app.get("/dashboard-analytics", async (req, res) => {
  try {
    return res.json(await getDashboardAnalyticsPayload(req.query));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Dashboard Analytics" });
  }
});

app.get("/dashboard-sales-trend", async (req, res) => {
  try {
    const { dateFrom, dateTo, days } = parseDashboardRange(req.query);
    return res.json({ dateFrom, dateTo, days, data: await getDashboardSalesTrend(dateFrom, dateTo) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sales Trend" });
  }
});

app.get("/dashboard-profit-trend", async (req, res) => {
  try {
    const { dateFrom, dateTo, days } = parseDashboardRange(req.query);
    return res.json({ dateFrom, dateTo, days, data: await getDashboardProfitTrend(dateFrom, dateTo) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Profit Trend" });
  }
});

app.get("/dashboard-expense-trend", async (req, res) => {
  try {
    const { dateFrom, dateTo, days } = parseDashboardRange(req.query);
    return res.json({ dateFrom, dateTo, days, data: await getDashboardExpenseTrend(dateFrom, dateTo) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Expense Trend" });
  }
});

app.get("/reports/balance-sheet", async (req, res) => {
  try {
    const reportRange = getReportDateRange(req.query);
    const dateFrom = req.query.date_from || reportRange.dateFrom;
    const dateTo = req.query.date_to || reportRange.dateTo;
    const snapshot = await getBalanceSheetSnapshot({ dateTo });
    return res.json({
      dateFrom,
      dateTo,
      asAtDate: snapshot.asAtDate,
      cash: snapshot.cash,
      bank: snapshot.bank,
      inventory: snapshot.inventory,
      customerReceivable: snapshot.customerReceivable,
      supplierPayable: snapshot.supplierPayable,
      netProfit: snapshot.netProfit,
      ownerCapital: snapshot.ownerCapital,
      netPosition: snapshot.netPosition,
      totalAssets: snapshot.totalAssets,
      totalLiabilities: snapshot.totalLiabilities,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Balance Sheet" });
  }
});

app.get("/reports/cash-book", async (req, res) => {
  try {
    const reportRange = getReportDateRange(req.query);
    const dateFrom = req.query.date_from || reportRange.dateFrom;
    const dateTo = req.query.date_to || reportRange.dateTo;
    const report = await getCashBookReport({
      dateFrom,
      dateTo,
      paymentMode: req.query.payment_mode,
      accountFilter: req.query.account_filter,
      partyFilter: req.query.party_filter,
      search: req.query.search,
      groupByDate: String(req.query.group_by_date || "").toLowerCase() === "true",
    });
    return res.json(report);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Cash Book" });
  }
});

app.get("/contra-entries", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT *
      FROM contra_entries
      WHERE cancelled = FALSE
      ORDER BY contra_date DESC, created_at DESC, id DESC
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Contra Entries" });
  }
});

app.post("/contra-entries", async (req, res) => {
  try {
    const contraType = String(req.body.contra_type || "").trim().toUpperCase();
    const amount = parsePositiveNumber(req.body.amount);
    if (!["CASH_TO_BANK", "BANK_TO_CASH"].includes(contraType)) {
      return res.status(400).json({ message: "Select valid contra type" });
    }
    if (!amount) {
      return res.status(400).json({ message: "Enter valid contra amount" });
    }
    const contraDate = isDateInput(req.body.contra_date) ? req.body.contra_date : toDateKey(new Date());
    const result = await pool.query(
      `
      INSERT INTO contra_entries (
        contra_date, contra_type, amount, cash_account, bank_account,
        reference_number, remarks, branch_id, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
      `,
      [
        contraDate,
        contraType,
        amount,
        cleanText(req.body.cash_account) || "Cash",
        cleanText(req.body.bank_account) || "Bank",
        nullableText(req.body.reference_number),
        nullableText(req.body.remarks),
        parsePositiveInteger(req.body.branch_id),
        parsePositiveInteger(req.body.created_by),
      ]
    );
    return res.json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Contra Entry" });
  }
});

app.get("/reports/balance-sheet/details/:lineKey", async (req, res) => {
  try {
    const lineKey = String(req.params.lineKey || "").toLowerCase();
    const reportRange = getReportDateRange(req.query);
    const dateFrom = req.query.date_from || reportRange.dateFrom;
    const dateTo = req.query.date_to || reportRange.dateTo;
    const snapshot = await getBalanceSheetSnapshot({ dateTo });
    const titles = {
      cash_in_hand: "Cash in Hand Detail",
      cash_at_bank: "Cash at Bank / Bank Balance Detail",
      inventory: "Inventory / Closing Stock Detail",
      customer_receivables: "Customer Receivables / Sundry Debtors Detail",
      supplier_payables: "Supplier Payables / Trade Creditors Detail",
      net_profit: "Net Profit Detail",
      owner_equity: "Capital / Owner Equity Detail",
      loans: "Loans / Credit Balances Detail",
      other_liabilities: "Other Liabilities Detail",
      other_assets: "Other Assets Detail",
    };
    if (!titles[lineKey]) {
      return res.status(404).json({ message: "Balance Sheet line not found" });
    }

    if (lineKey === "cash_in_hand" || lineKey === "cash_at_bank") {
      const cashBook = await getCashBookReport({ dateFrom, dateTo, lineKey });
      const isCash = lineKey === "cash_in_hand";
      const openingBalance = isCash ? cashBook.opening_cash : cashBook.opening_bank;
      const debitDuringRange = isCash ? cashBook.cash_receipts : cashBook.bank_receipts;
      const creditDuringRange = isCash ? cashBook.cash_payments : cashBook.bank_payments;
      const closingBalance = isCash ? cashBook.closing_cash : cashBook.closing_bank;
      const rows = cashBook.rows.map((row) => ({
        transaction_date: row.date,
        voucher_type: row.source_type,
        voucher_no: row.reference_no,
        party_name: row.party_name,
        payment_mode: row.payment_mode,
        debit: isCash ? row.receipt_cash : row.receipt_bank,
        credit: isCash ? row.payment_cash : row.payment_bank,
        balance: isCash ? row.cash_balance : row.bank_balance,
        narration: row.narration,
        date_key: row.date,
      }));
      return res.json({
        lineKey,
        title: titles[lineKey],
        amount: closingBalance,
        dateFrom,
        dateTo,
        asAtDate: snapshot.asAtDate,
        openingBalance,
        debitDuringRange,
        creditDuringRange,
        closingBalance,
        columns: ["Date", "Voucher Type", "Voucher No", "Party", "Payment Mode", "Debit", "Credit", "Balance", "Narration"],
        rows,
        breakdown: [
          { label: `Opening Balance before ${dateFrom}`, value: openingBalance },
          { label: "Debit during range", value: debitDuringRange },
          { label: "Credit during range", value: creditDuringRange },
          { label: `Closing Balance as at ${dateTo}`, value: closingBalance },
        ],
      });
    }

    if (lineKey === "inventory") {
      const result = await pool.query(
        `
        SELECT
          p.product_name,
          COALESCE(ib.lot_name, ib.batch_no) AS lot,
          ib.lot_size,
          ib.remaining_qty AS quantity,
          COALESCE(ib.effective_cost_per_unit, ib.purchase_rate, 0) AS cost_rate,
          ib.remaining_qty * COALESCE(ib.effective_cost_per_unit, ib.purchase_rate, 0) AS value,
          ib.supplier_name
        FROM inventory_batches ib
        JOIN products p ON p.id = ib.product_id
        WHERE COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
          AND COALESCE(ib.remaining_qty, 0) <> 0
          AND ib.created_at::date <= $1
        ORDER BY p.product_name, ib.created_at, ib.id
        `,
        [dateTo]
      );
      return res.json({
        lineKey,
        title: titles[lineKey],
        amount: snapshot.inventory,
        dateFrom,
        dateTo,
        asAtDate: snapshot.asAtDate,
        openingBalance: 0,
        debitDuringRange: 0,
        creditDuringRange: 0,
        closingBalance: snapshot.inventory,
        columns: ["Product", "Lot", "Size", "Qty", "Cost", "Value", "Supplier"],
        rows: result.rows,
        breakdown: [{ label: `Closing stock valuation as at ${dateTo}`, value: snapshot.inventory }],
      });
    }

    if (lineKey === "supplier_payables") {
      const openingRows = await getSupplierSummaryRows({ dateTo: previousDateKey(dateFrom) });
      const openingBalance = roundCurrency(openingRows.reduce((sum, row) => sum + Number(row.outstanding_balance || 0), 0));
      const debitDuringRange = roundCurrency(Math.max(0, openingBalance - snapshot.supplierPayable));
      const creditDuringRange = roundCurrency(Math.max(0, snapshot.supplierPayable - openingBalance));
      return res.json({
        lineKey,
        title: titles[lineKey],
        amount: snapshot.supplierPayable,
        dateFrom,
        dateTo,
        asAtDate: snapshot.asAtDate,
        openingBalance,
        debitDuringRange,
        creditDuringRange,
        closingBalance: snapshot.supplierPayable,
        columns: ["Supplier", "Opening", "Purchases", "Payments", "Rebates", "Balance"],
        rows: snapshot.supplierRows.map((row) => ({
          supplier_name: row.supplier_name,
          opening_balance: row.opening_balance,
          purchases: row.total_purchases,
          payments: row.total_paid,
          rebates: row.total_rebate_received,
          balance: row.outstanding_balance,
        })),
        breakdown: [
          { label: `Opening Payable before ${dateFrom}`, value: openingBalance },
          { label: `Closing Payable as at ${dateTo}`, value: snapshot.supplierPayable },
        ],
      });
    }

    if (lineKey === "customer_receivables") {
      const openingRows = await getCustomerSummaryRows({ dateTo: previousDateKey(dateFrom) });
      const openingBalance = roundCurrency(openingRows.reduce((sum, row) => sum + Number(row.outstanding_balance || 0), 0));
      const debitDuringRange = roundCurrency(Math.max(0, snapshot.customerReceivable - openingBalance));
      const creditDuringRange = roundCurrency(Math.max(0, openingBalance - snapshot.customerReceivable));
      return res.json({
        lineKey,
        title: titles[lineKey],
        amount: snapshot.customerReceivable,
        dateFrom,
        dateTo,
        asAtDate: snapshot.asAtDate,
        openingBalance,
        debitDuringRange,
        creditDuringRange,
        closingBalance: snapshot.customerReceivable,
        columns: ["Customer", "Opening", "Credit Sales", "Receipts", "Returns", "Balance"],
        rows: snapshot.customerRows.map((row) => ({
          customer_name: row.customer_name,
          opening_balance: row.opening_balance,
          credit_sales: row.total_sales,
          receipts: row.total_paid,
          returns: row.total_cancelled,
          balance: row.outstanding_balance,
        })),
        breakdown: [
          { label: `Opening Receivable before ${dateFrom}`, value: openingBalance },
          { label: `Closing Receivable as at ${dateTo}`, value: snapshot.customerReceivable },
        ],
      });
    }

    if (lineKey === "net_profit") {
      const openingSnapshot = await getBalanceSheetSnapshot({ dateTo: previousDateKey(dateFrom) });
      const openingBalance = openingSnapshot.netProfit;
      const debitDuringRange = roundCurrency(Math.max(0, openingBalance - snapshot.netProfit));
      const creditDuringRange = roundCurrency(Math.max(0, snapshot.netProfit - openingBalance));
      return res.json({
        lineKey,
        title: titles[lineKey],
        amount: snapshot.netProfit,
        dateFrom,
        dateTo,
        asAtDate: snapshot.asAtDate,
        openingBalance,
        debitDuringRange,
        creditDuringRange,
        closingBalance: snapshot.netProfit,
        columns: ["Particular", "Amount"],
        rows: [
          { particular: "Sales Revenue", amount: snapshot.profitLoss.salesRevenue },
          { particular: "Cost of Goods Sold", amount: -snapshot.profitLoss.costOfGoodsSold },
          { particular: "Gross Profit", amount: snapshot.profitLoss.grossProfit },
          { particular: "Expenses", amount: -snapshot.profitLoss.expenses },
          { particular: "Net Profit", amount: snapshot.netProfit },
        ],
        breakdown: [
          { label: "Sales Revenue", value: snapshot.profitLoss.salesRevenue },
          { label: "Cost of Goods Sold", value: snapshot.profitLoss.costOfGoodsSold },
          { label: "Expenses", value: snapshot.profitLoss.expenses },
          { label: "Net Profit", value: snapshot.netProfit },
        ],
      });
    }

    if (lineKey === "owner_equity") {
      const openingSnapshot = await getBalanceSheetSnapshot({ dateTo: previousDateKey(dateFrom) });
      const openingBalance = openingSnapshot.ownerCapital;
      const debitDuringRange = roundCurrency(Math.max(0, openingBalance - snapshot.ownerCapital));
      const creditDuringRange = roundCurrency(Math.max(0, snapshot.ownerCapital - openingBalance));
      return res.json({
        lineKey,
        title: titles[lineKey],
        amount: snapshot.ownerCapital,
        dateFrom,
        dateTo,
        asAtDate: snapshot.asAtDate,
        openingBalance,
        debitDuringRange,
        creditDuringRange,
        closingBalance: snapshot.ownerCapital,
        columns: ["Particular", "Amount"],
        rows: [
          { particular: "Total Assets", amount: snapshot.totalAssets },
          { particular: "Less Supplier Payables", amount: -snapshot.supplierPayable },
          { particular: "Less Net Profit", amount: -snapshot.netProfit },
          { particular: "Balancing Owner Equity", amount: snapshot.ownerCapital },
        ],
        breakdown: [
          { label: "Total Assets", value: snapshot.totalAssets },
          { label: "Supplier Payables", value: snapshot.supplierPayable },
          { label: "Net Profit", value: snapshot.netProfit },
          { label: "Owner Equity / Balancing Figure", value: snapshot.ownerCapital },
        ],
      });
    }

    return res.json({
      lineKey,
      title: titles[lineKey],
      amount: 0,
      dateFrom,
      dateTo,
      asAtDate: snapshot.asAtDate,
      openingBalance: 0,
      debitDuringRange: 0,
      creditDuringRange: 0,
      closingBalance: 0,
      columns: ["Particular", "Amount"],
      rows: [],
      breakdown: [{ label: "No source transactions configured yet", value: 0 }],
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Balance Sheet Details" });
  }
});

app.get("/reports/day-book", async (req, res) => {
  try {
    const reportRange = getReportDateRange(req.query);
    const dateFrom = req.query.date_from || reportRange.dateFrom;
    const dateTo = req.query.date_to || reportRange.dateTo;
    const search = cleanText(req.query.search).toLowerCase();
    const accountType = req.query.account_type ? normalizeAccountType(req.query.account_type) : "";
    const voucherType = cleanText(req.query.voucher_type);
    const paymentMode = normalizePaymentMode(req.query.payment_mode || "");
    const clubbed = String(req.query.clubbed || "").toLowerCase() === "true";
    const bankModes = new Set(BANK_PAYMENT_MODES);
    const canonicalVoucher = (row) => {
      const raw = String(row.transaction_type || row.voucher_type || "").toLowerCase();
      if (raw.includes("sale return")) return "Sale Return";
      if (raw.includes("customer sale") || raw === "sale" || raw.includes("pos sale")) return "POS Sale";
      if (raw.includes("supplier purchase") || raw === "purchase") return "Purchase";
      if (raw.includes("supplier payment")) return "Supplier Payment";
      if (raw.includes("customer payment") || raw.includes("customer receipt") || raw === "receipt") return "Customer Receipt";
      if (raw.includes("expense")) return "Expense";
      if (raw.includes("waste")) return "Waste";
      if (raw.includes("opening")) return "Opening Stock";
      if (raw.includes("adjust")) return "Stock Adjustment";
      if (raw.includes("capital")) return "Owner Capital";
      if (raw.includes("drawing")) return "Drawings";
      return row.transaction_type || row.voucher_type || "";
    };
    const result = await pool.query(
      `
      SELECT *
      FROM (
        SELECT s.sale_date AS date, 'POS Sale' AS transaction_type,
          COALESCE(s.customer_name, 'Walk-in Customer') AS party_name,
          'CUSTOMER' AS account_type,
          COALESCE(s.invoice_no, 'SALE-' || s.id) AS voucher_no,
          sp.payment_mode,
          CASE WHEN sp.payment_mode = 'CREDIT' THEN s.total_amount ELSE 0 END AS debit,
          CASE WHEN sp.payment_mode = 'CREDIT' THEN 0 ELSE sp.amount END AS credit,
          COALESCE(s.invoice_no, 'POS sale') AS narration
        FROM sales s
        LEFT JOIN sale_payments sp ON sp.sale_id = s.id
        WHERE s.sale_status <> 'CANCELLED' AND s.sale_date BETWEEN $1 AND $2
        UNION ALL
        SELECT p.purchase_date AS date, 'Purchase' AS transaction_type,
          COALESCE(s.supplier_name, p.supplier_name, 'Supplier') AS party_name,
          'SUPPLIER' AS account_type,
          COALESCE(p.bill_number, 'PUR-' || p.id) AS voucher_no,
          COALESCE(p.payment_mode, CASE WHEN p.purchase_type = 'CREDIT' THEN 'CREDIT' ELSE '' END) AS payment_mode,
          COALESCE(NULLIF(p.net_payable, 0), p.total_amount, 0) AS debit,
          CASE WHEN p.purchase_type = 'CREDIT' THEN COALESCE(NULLIF(p.net_payable, 0), p.total_amount, 0) ELSE 0 END AS credit,
          COALESCE(p.remarks, 'Purchase') AS narration
        FROM purchases p
        LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
          AND COALESCE(p.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
          AND p.purchase_date BETWEEN $1 AND $2
        UNION ALL
        SELECT sp.payment_date AS date, 'Supplier Payment' AS transaction_type,
          s.supplier_name AS party_name,
          'SUPPLIER' AS account_type,
          COALESCE(sp.reference_number, 'SP-' || sp.id) AS voucher_no,
          sp.payment_mode,
          sp.payment_amount + sp.rebate_amount AS debit,
          0::NUMERIC AS credit,
          COALESCE(sp.remarks, 'Supplier payment') AS narration
        FROM supplier_payments sp
        JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.cancelled = FALSE AND sp.payment_date BETWEEN $1 AND $2
        UNION ALL
        SELECT cp.payment_date AS date, 'Customer Receipt' AS transaction_type,
          c.customer_name AS party_name,
          'CUSTOMER' AS account_type,
          COALESCE(cp.reference_number, 'CP-' || cp.id) AS voucher_no,
          cp.payment_mode,
          0::NUMERIC AS debit,
          cp.payment_amount AS credit,
          COALESCE(cp.remarks, 'Customer receipt') AS narration
        FROM customer_payments cp
        JOIN customers c ON c.id = cp.customer_id
        WHERE cp.cancelled = FALSE AND cp.payment_date BETWEEN $1 AND $2
        UNION ALL
        SELECT e.expense_date AS date, 'Expense' AS transaction_type,
          COALESCE(e.paid_to, e.vendor_name, e.category) AS party_name,
          'EXPENSE' AS account_type,
          COALESCE(e.reference_number, 'EXP-' || e.id) AS voucher_no,
          e.payment_mode,
          e.amount AS debit,
          0::NUMERIC AS credit,
          COALESCE(e.remarks, e.category) AS narration
        FROM expenses e
        WHERE e.active IS DISTINCT FROM FALSE
          AND COALESCE(e.status, 'ACTIVE') <> 'CANCELLED'
          AND e.expense_date BETWEEN $1 AND $2
        UNION ALL
        SELECT sr.return_date AS date, 'Sale Return' AS transaction_type,
          COALESCE(sr.customer_name, 'Walk-in Customer') AS party_name,
          'CUSTOMER' AS account_type,
          COALESCE(sr.return_no, 'RET-' || sr.id) AS voucher_no,
          sr.refund_type AS payment_mode,
          0::NUMERIC AS debit,
          sr.total_return_amount AS credit,
          COALESCE(sr.return_reason, 'Sale return') AS narration
        FROM sale_returns sr
        WHERE sr.return_date BETWEEN $1 AND $2
        UNION ALL
        SELECT we.waste_date AS date, 'Waste' AS transaction_type,
          p.product_name AS party_name,
          'INVENTORY' AS account_type,
          'WST-' || we.id AS voucher_no,
          '' AS payment_mode,
          we.cost_amount AS debit,
          0::NUMERIC AS credit,
          COALESCE(we.remarks, we.waste_type) AS narration
        FROM waste_entries we
        JOIN products p ON p.id = we.product_id
        WHERE we.waste_date BETWEEN $1 AND $2
        UNION ALL
        SELECT ib.created_at::date AS date, 'Opening Stock' AS transaction_type,
          p.product_name AS party_name,
          'INVENTORY' AS account_type,
          COALESCE(ib.batch_no, 'OPEN-' || ib.id) AS voucher_no,
          '' AS payment_mode,
          ib.purchase_qty * COALESCE(ib.effective_cost_per_unit, ib.purchase_rate, 0) AS debit,
          0::NUMERIC AS credit,
          COALESCE(ib.remarks, 'Opening stock') AS narration
        FROM inventory_batches ib
        JOIN products p ON p.id = ib.product_id
        WHERE ib.stock_source = 'OPENING_STOCK'
          AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
          AND ib.created_at::date BETWEEN $1 AND $2
      ) rows
      ORDER BY date DESC, transaction_type, party_name
      `,
      [dateFrom, dateTo]
    );
    const matches = (row) => {
      const rowVoucherType = canonicalVoucher(row);
      if (accountType === "CASH" && row.payment_mode !== "CASH") return false;
      if (accountType === "BANK" && !bankModes.has(row.payment_mode)) return false;
      if (accountType && !["CASH", "BANK"].includes(accountType) && row.account_type !== accountType) return false;
      if (voucherType && rowVoucherType !== voucherType) return false;
      if (paymentMode === "OTHER" && ["CASH", "UPI", "CARD", "BANK_TRANSFER", "CREDIT", "CHEQUE"].includes(row.payment_mode)) return false;
      if (paymentMode && paymentMode !== "OTHER" && row.payment_mode !== paymentMode) return false;
      if (search) {
        const haystack = Object.values(row).join(" ").toLowerCase();
        if (!haystack.includes(search)) return false;
      }
      return true;
    };
    const rows = result.rows.filter(matches).map((row) => ({ ...row, voucher_type: canonicalVoucher(row) }));
    const finalRows = clubbed ? [...rows.reduce((groups, row) => {
      const key = `${toDateKey(row.date)}-${row.voucher_type}-${row.party_name}-${row.payment_mode || ""}`;
      const current = groups.get(key) || { ...row, voucher_no: "Multiple", debit: 0, credit: 0, transaction_count: 0, narration: "" };
      current.debit += Number(row.debit || 0);
      current.credit += Number(row.credit || 0);
      current.transaction_count += 1;
      current.narration = [current.narration, row.narration].filter(Boolean).join("\n");
      current.narration_summary = `${row.voucher_type} - ${current.transaction_count} ${current.transaction_count === 1 ? "entry" : "entries"}${row.payment_mode ? ` - ${row.payment_mode}` : ""}`;
      groups.set(key, current);
      return groups;
    }, new Map()).values()] : rows;
    return res.json({
      dateFrom,
      dateTo,
      filters: { account_type: accountType, voucher_type: voucherType, payment_mode: paymentMode, search, clubbed },
      rows: finalRows,
      summary: {
        debit: roundCurrency(finalRows.reduce((sum, row) => sum + Number(row.debit || 0), 0)),
        credit: roundCurrency(finalRows.reduce((sum, row) => sum + Number(row.credit || 0), 0)),
        rows: finalRows.length,
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Day Book" });
  }
});

app.get("/reports/summary", async (req, res) => {
  try {
    const reportRange = getReportDateRange(req.query);
    const dateFrom = req.query.date_from || reportRange.dateFrom || "1900-01-01";
    const dateTo = req.query.date_to || reportRange.dateTo || "2999-12-31";
    const [
      salesResult,
      pendingPurchaseResult,
      stockWithoutBillResult,
      provisionalSalesResult,
      purchaseResult,
      purchaseHistoryResult,
      supplierRows,
      customerRows,
      discountResult,
      expenseResult,
      paymentResult,
      returnResult,
      returnReasonResult,
      wasteResult,
      wasteProductResult,
      stockResult,
      ledgerResult,
      dayToDayResult,
      salesProductResult,
      salesCustomerResult,
      salesHistoryResult,
      salesChangeResult,
      purchaseProductResult,
      purchaseSupplierResult,
      purchaseChangeResult,
      returnHistoryResult,
      stockMovementResult,
      profitLossResult,
      paymentModeSummaryResult,
    ] = await Promise.all([
      pool.query(
        `
        SELECT
          sale_date,
          COUNT(*)::INTEGER AS transaction_count,
          SUM(total_amount) AS total_sales,
          SUM(total_cost) AS total_cost,
          SUM(profit) AS total_profit,
          COALESCE((
            SELECT SUM(sp.amount)
            FROM sale_payments sp
            JOIN sales sx ON sx.id = sp.sale_id
            WHERE sx.sale_status <> 'CANCELLED'
              AND sx.sale_date = s.sale_date
              AND sp.payment_mode = 'CASH'
          ), 0) AS cash_sales,
          COALESCE((
            SELECT SUM(sp.amount)
            FROM sale_payments sp
            JOIN sales sx ON sx.id = sp.sale_id
            WHERE sx.sale_status <> 'CANCELLED'
              AND sx.sale_date = s.sale_date
              AND sp.payment_mode = 'UPI'
          ), 0) AS upi_sales,
          COALESCE((
            SELECT SUM(sp.amount)
            FROM sale_payments sp
            JOIN sales sx ON sx.id = sp.sale_id
            WHERE sx.sale_status <> 'CANCELLED'
              AND sx.sale_date = s.sale_date
              AND sp.payment_mode IN ('CARD', 'BANK_TRANSFER')
          ), 0) AS bank_card_sales
        FROM sales s
        WHERE s.sale_status <> 'CANCELLED'
          AND s.sale_date BETWEEN $1 AND $2
        GROUP BY s.sale_date
        ORDER BY sale_date DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.id,
          p.purchase_date,
          p.supplier_name,
          p.temporary_sale_rate,
          p.expected_purchase_rate,
          p.remarks,
          pi.product_id,
          pr.product_name,
          pr.category,
          pr.unit,
          pi.quantity,
          COALESCE(pi.lot_name, p.lot_name, ib.lot_name) AS lot_name,
          COALESCE(pi.lot_size, p.lot_size, ib.lot_size) AS lot_size,
          ib.batch_no,
          ib.stock_source,
          ib.remaining_qty
        FROM purchases p
        LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
        LEFT JOIN products pr ON pr.id = pi.product_id
        LEFT JOIN inventory_batches ib ON ib.purchase_id = p.id
        WHERE COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
          AND COALESCE(p.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_PENDING'
          AND p.purchase_date BETWEEN $1 AND $2
        ORDER BY p.purchase_date DESC, p.id DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          ib.id,
          ib.batch_no,
          ib.purchase_id,
          ib.supplier_name,
          p.product_name,
          p.category,
          p.unit,
          ib.lot_name,
          ib.lot_size,
          ib.stock_source,
          ib.purchase_qty,
          ib.remaining_qty,
          ib.temporary_sale_rate,
          ib.purchase_rate AS expected_purchase_rate,
          ib.created_at::date AS arrival_date
        FROM inventory_batches ib
        JOIN products p ON p.id = ib.product_id
        WHERE COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
          AND COALESCE(ib.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_PENDING'
          AND ib.created_at::date BETWEEN $1 AND $2
        ORDER BY ib.created_at DESC, ib.id DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          s.id,
          s.invoice_no,
          s.sale_date,
          COALESCE(s.customer_name, 'Walk-in Customer') AS customer_name,
          s.payment_mode,
          s.total_amount,
          s.total_cost,
          s.profit,
          s.profit_status,
          STRING_AGG(DISTINCT p.product_name, ', ' ORDER BY p.product_name) AS products
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        JOIN products p ON p.id = si.product_id
        WHERE s.sale_status <> 'CANCELLED'
          AND COALESCE(s.profit_status, 'FINAL') = 'PROVISIONAL'
          AND s.sale_date BETWEEN $1 AND $2
        GROUP BY s.id
        ORDER BY s.sale_date DESC, s.id DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          purchase_date,
          COUNT(*)::INTEGER AS purchase_count,
          SUM(COALESCE(NULLIF(gross_amount, 0), total_amount, 0)) AS gross_purchase,
          SUM(COALESCE(rebate_amount, 0)) AS rebate_received,
          SUM(COALESCE(NULLIF(net_payable, 0), total_amount, 0)) AS net_purchase,
          SUM(COALESCE(paid_amount, 0)) AS paid_amount,
          SUM(COALESCE(balance_amount, 0)) AS balance_amount
        FROM purchases
        WHERE purchase_date BETWEEN $1 AND $2
          AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'
          AND COALESCE(purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
        GROUP BY purchase_date
        ORDER BY purchase_date DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.id,
          p.purchase_date,
          p.supplier_id,
          p.supplier_name,
          p.purchase_status,
          p.purchase_bill_status,
          p.purchase_type,
          p.payment_mode,
          p.payment_reference_number,
          p.bill_number,
          p.bill_date,
          s.firm_name,
          p.temporary_sale_rate,
          p.expected_purchase_rate,
          p.gross_amount,
          p.mandi_tax_amount,
          p.freight_charges,
          p.labour_charges,
          p.other_charges,
          p.rebate_amount,
          p.rebate_rule_id,
          p.net_payable,
          p.paid_amount,
          p.balance_amount,
          p.remarks,
          pi.id AS item_id,
          pi.product_id,
          pi.quantity,
          pi.purchase_rate,
          COALESCE(pi.lot_name, p.lot_name, ib.lot_name) AS lot_name,
          COALESCE(pi.lot_size, p.lot_size, ib.lot_size) AS lot_size,
          pi.basic_amount AS item_basic_amount,
          pi.net_payable AS item_net_payable,
          pi.effective_cost_per_unit,
          pr.product_name,
          pr.category,
          pr.unit,
          pr.origin_type,
          ib.id AS inventory_batch_id,
          ib.batch_no,
          ib.stock_source,
          ib.purchase_qty AS batch_purchase_qty,
          ib.remaining_qty AS batch_remaining_qty,
          ib.batch_status
        FROM purchases p
        LEFT JOIN suppliers s ON s.id = p.supplier_id
        LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
        LEFT JOIN products pr ON pr.id = pi.product_id
        LEFT JOIN inventory_batches ib ON ib.purchase_id = p.id
        WHERE p.purchase_date BETWEEN $1 AND $2
          AND (
            COALESCE(p.purchase_status, 'ACTIVE') = 'CANCELLED'
            OR COALESCE(p.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
          )
        ORDER BY p.purchase_date DESC, p.supplier_name, p.id DESC
        `,
        [dateFrom, dateTo]
      ),
      getSupplierSummaryRows(),
      getCustomerSummaryRows(),
      pool.query(
        `
        SELECT
          s.sale_date,
          s.invoice_no,
          s.payment_mode,
          p.product_name,
          p.unit,
          COALESCE(ib.lot_name, ib.batch_no, '') AS lot_name,
          ib.lot_size,
          si.lot_discount_type AS discount_type,
          si.lot_discount_value AS discount_value,
          SUM(si.quantity) AS quantity_sold,
          SUM(
            CASE
              WHEN si.lot_discount_type = 'SPECIAL_RATE'
              THEN si.quantity * COALESCE(si.default_selling_rate, si.selling_rate)
              ELSE si.amount
            END
          ) AS gross_amount,
          SUM(
            COALESCE(si.discount_amount, 0) +
            CASE
              WHEN si.lot_discount_type = 'SPECIAL_RATE'
              THEN GREATEST((COALESCE(si.default_selling_rate, si.selling_rate) - si.selling_rate) * si.quantity, 0)
              ELSE 0
            END
          ) AS discount_amount,
          SUM(COALESCE(si.net_amount, si.amount - COALESCE(si.discount_amount, 0))) AS net_amount,
          SUM(COALESCE(si.profit, 0)) AS profit_impact
        FROM sales s
        JOIN sale_items si ON si.sale_id = s.id
        JOIN products p ON p.id = si.product_id
        LEFT JOIN sale_batch_allocations sba ON sba.sale_item_id = si.id
        LEFT JOIN inventory_batches ib ON ib.id = sba.inventory_batch_id
        WHERE s.sale_status <> 'CANCELLED'
          AND s.sale_date BETWEEN $1 AND $2
          AND (
            COALESCE(si.discount_amount, 0) > 0
            OR si.lot_discount_id IS NOT NULL
            OR COALESCE(s.invoice_discount_amount, 0) > 0
          )
        GROUP BY
          s.sale_date, s.invoice_no, s.payment_mode, p.product_name, p.unit,
          COALESCE(ib.lot_name, ib.batch_no, ''), ib.lot_size,
          si.lot_discount_type, si.lot_discount_value
        ORDER BY s.sale_date DESC, p.product_name, lot_name
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          e.id,
          e.expense_date,
          category,
          payment_mode,
          amount,
          COALESCE(e.paid_to, e.vendor_name, '') AS paid_to,
          e.vendor_name,
          e.reference_number,
          e.remarks,
          COALESCE(e.status, CASE WHEN e.active IS DISTINCT FROM FALSE THEN 'ACTIVE' ELSE 'CANCELLED' END) AS status,
          e.active,
          e.cancelled_at,
          e.cancellation_reason,
          e.edited_at,
          e.edit_reason,
          u.full_name AS created_by_name,
          eu.full_name AS edited_by_name,
          cu.full_name AS cancelled_by_name
        FROM expenses e
        LEFT JOIN users u ON u.id = e.created_by
        LEFT JOIN users eu ON eu.id = e.edited_by
        LEFT JOIN users cu ON cu.id = e.cancelled_by
        WHERE e.expense_date BETWEEN $1 AND $2
        ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT *
        FROM (
          SELECT
            cp.payment_date,
            'Customer Receipt' AS payment_type,
            c.customer_name AS party_name,
            cp.payment_amount,
            0::NUMERIC AS rebate_amount,
            cp.payment_mode,
            cp.reference_number,
            cp.remarks,
            cp.cancelled
          FROM customer_payments cp
          JOIN customers c ON c.id = cp.customer_id
          WHERE cp.payment_date BETWEEN $1 AND $2
          UNION ALL
          SELECT
            sp.payment_date,
            'Supplier Payment' AS payment_type,
            s.supplier_name AS party_name,
            sp.payment_amount,
            sp.rebate_amount,
            sp.payment_mode,
            sp.reference_number,
            sp.remarks,
            sp.cancelled
          FROM supplier_payments sp
          JOIN suppliers s ON s.id = sp.supplier_id
          WHERE sp.payment_date BETWEEN $1 AND $2
        ) payments
        ORDER BY payment_date DESC, party_name
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          sr.return_date,
          COUNT(*)::INTEGER AS return_count,
          SUM(sr.total_return_amount) AS return_value,
          SUM(item_summary.return_quantity) AS return_quantity
        FROM sale_returns sr
        LEFT JOIN (
          SELECT sale_return_id, SUM(return_quantity) AS return_quantity
          FROM sale_return_items
          GROUP BY sale_return_id
        ) item_summary ON item_summary.sale_return_id = sr.id
        WHERE sr.return_date BETWEEN $1 AND $2
        GROUP BY sr.return_date
        ORDER BY sr.return_date DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          return_reason,
          COUNT(*)::INTEGER AS return_count,
          SUM(total_return_amount) AS return_value
        FROM sale_returns
        WHERE return_date BETWEEN $1 AND $2
        GROUP BY return_reason
        ORDER BY return_count DESC, return_value DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          waste_date,
          waste_type,
          COUNT(*)::INTEGER AS entry_count,
          SUM(quantity) AS waste_quantity,
          SUM(cost_amount) AS waste_cost
        FROM waste_entries
        WHERE waste_date BETWEEN $1 AND $2
        GROUP BY waste_date, waste_type
        ORDER BY waste_date DESC, waste_type
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.product_name,
          p.unit,
          SUM(we.quantity) AS waste_quantity,
          SUM(we.cost_amount) AS waste_cost
        FROM waste_entries we
        JOIN products p ON p.id = we.product_id
        WHERE we.waste_date BETWEEN $1 AND $2
        GROUP BY p.product_name, p.unit
        ORDER BY waste_quantity DESC, waste_cost DESC
        LIMIT 20
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.id AS product_id,
          p.product_name,
          p.category,
          p.unit,
          p.minimum_stock,
          COALESCE(SUM(ib.remaining_qty), 0) AS current_stock,
          COALESCE(SUM(ib.remaining_qty * COALESCE(ib.effective_cost_per_unit, ib.purchase_rate)), 0) AS stock_value
        FROM products p
        LEFT JOIN inventory_batches ib ON ib.product_id = p.id
          AND COALESCE(ib.batch_status, 'ACTIVE') <> 'CANCELLED'
        WHERE p.active IS DISTINCT FROM FALSE
        GROUP BY p.id
        ORDER BY p.product_name
        `
      ),
      pool.query(
        `
        SELECT *
        FROM (
          SELECT p.purchase_date AS date, 'Supplier Purchase' AS transaction_type,
            p.supplier_name AS party_name,
            'SUPPLIER' AS account_type,
            'SUPPLIER-' || COALESCE(p.supplier_id, 0) AS account_key,
            'Purchase' AS voucher_type,
            COALESCE(p.bill_number, 'PUR-' || p.id) AS voucher_no,
            COALESCE(p.payment_mode, '') AS payment_mode,
            0::NUMERIC AS debit,
            COALESCE(NULLIF(p.net_payable, 0), NULLIF(p.gross_amount, 0), p.total_amount, 0) AS credit,
            COALESCE(p.payment_status, '') AS status,
            COALESCE(p.remarks, 'Purchase #' || p.id) AS remarks,
            COALESCE(
              STRING_AGG(pr.product_name || ' ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM pi.quantity::TEXT)) || COALESCE(pr.unit, '') || ' @ ' || pi.purchase_rate || ' = ' || pi.basic_amount, E'\n' ORDER BY pi.id),
              COALESCE(p.remarks, 'Purchase #' || p.id)
            ) AS narration
          FROM purchases p
          LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
          LEFT JOIN products pr ON pr.id = pi.product_id
          WHERE p.purchase_date BETWEEN $1 AND $2
            AND COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
          GROUP BY p.id
          UNION ALL
          SELECT p.purchase_date AS date, 'Supplier Rebate' AS transaction_type,
            p.supplier_name AS party_name,
            'SUPPLIER' AS account_type,
            'SUPPLIER-' || COALESCE(p.supplier_id, 0) AS account_key,
            'Rebate' AS voucher_type,
            COALESCE(p.bill_number, 'PUR-' || p.id) AS voucher_no,
            COALESCE(p.payment_mode, '') AS payment_mode,
            COALESCE(p.rebate_amount, 0) AS debit,
            0::NUMERIC AS credit,
            COALESCE(p.payment_status, '') AS status,
            COALESCE(p.remarks, 'Supplier rebate') AS remarks,
            'Rebate received against ' || COALESCE(p.bill_number, 'Purchase #' || p.id) AS narration
          FROM purchases p
          WHERE p.purchase_date BETWEEN $1 AND $2
            AND COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
            AND COALESCE(p.rebate_amount, 0) > 0
          UNION ALL
          SELECT p.cancelled_at::date AS date, 'Supplier Purchase Cancellation' AS transaction_type,
            p.supplier_name AS party_name,
            'SUPPLIER' AS account_type,
            'SUPPLIER-' || COALESCE(p.supplier_id, 0) AS account_key,
            'Purchase Cancellation' AS voucher_type,
            COALESCE(p.bill_number, 'PUR-' || p.id) AS voucher_no,
            COALESCE(p.payment_mode, '') AS payment_mode,
            COALESCE(NULLIF(p.net_payable, 0), NULLIF(p.gross_amount, 0), p.total_amount, 0) AS debit,
            0::NUMERIC AS credit,
            'CANCELLED' AS status,
            COALESCE(p.cancellation_reason, 'Purchase cancelled') AS remarks,
            COALESCE(p.cancellation_reason, 'Purchase cancelled') AS narration
          FROM purchases p
          WHERE p.cancelled_at::date BETWEEN $1 AND $2
            AND COALESCE(p.purchase_status, 'ACTIVE') = 'CANCELLED'
          UNION ALL
          SELECT sp.payment_date AS date, 'Supplier Payment' AS transaction_type,
            s.supplier_name AS party_name,
            'SUPPLIER' AS account_type,
            'SUPPLIER-' || s.id AS account_key,
            'Payment' AS voucher_type,
            COALESCE(sp.reference_number, 'SP-' || sp.id) AS voucher_no,
            sp.payment_mode,
            sp.payment_amount + sp.rebate_amount AS debit,
            0::NUMERIC AS credit,
            CASE WHEN sp.cancelled THEN 'CANCELLED' ELSE 'ACTIVE' END AS status,
            COALESCE(sp.remarks, sp.reference_number, 'Supplier payment') AS remarks,
            COALESCE(sp.remarks, 'Supplier payment') || CASE WHEN COALESCE(sp.rebate_amount, 0) > 0 THEN ' | Rebate ' || sp.rebate_amount ELSE '' END AS narration
          FROM supplier_payments sp
          JOIN suppliers s ON s.id = sp.supplier_id
          WHERE sp.payment_date BETWEEN $1 AND $2
          UNION ALL
          SELECT s.sale_date AS date, 'Customer Sale' AS transaction_type,
            COALESCE(s.customer_name, c.customer_name, 'Walk-in Customer') AS party_name,
            'CUSTOMER' AS account_type,
            'CUSTOMER-' || COALESCE(s.customer_id, c.id, 0) AS account_key,
            'Sale' AS voucher_type,
            COALESCE(s.invoice_no, 'SALE-' || s.id) AS voucher_no,
            s.payment_mode,
            s.total_amount AS debit,
            COALESCE(pay.total_paid, 0) AS credit,
            COALESCE(s.sale_status, 'COMPLETED') AS status,
            COALESCE(s.invoice_no, 'Sale #' || s.id) AS remarks,
            COALESCE(
              STRING_AGG(pr.product_name || ' ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM si.quantity::TEXT)) || COALESCE(pr.unit, '') || ' @ ' || si.selling_rate || ' = ' || si.amount, E'\n' ORDER BY si.id),
              COALESCE(s.invoice_no, 'Sale #' || s.id)
            ) AS narration
          FROM sales s
          LEFT JOIN customers c ON c.id = s.customer_id
          LEFT JOIN (SELECT sale_id, SUM(amount) AS total_paid FROM sale_payments GROUP BY sale_id) pay ON pay.sale_id = s.id
          LEFT JOIN sale_items si ON si.sale_id = s.id
          LEFT JOIN products pr ON pr.id = si.product_id
          WHERE s.sale_date BETWEEN $1 AND $2
            AND s.sale_status <> 'CANCELLED'
          GROUP BY s.id, c.id, c.customer_name, pay.total_paid
          UNION ALL
          SELECT s.cancelled_at::date AS date, 'Customer Sale Cancellation' AS transaction_type,
            COALESCE(s.customer_name, c.customer_name, 'Walk-in Customer') AS party_name,
            'CUSTOMER' AS account_type,
            'CUSTOMER-' || COALESCE(s.customer_id, c.id, 0) AS account_key,
            'Sale Cancellation' AS voucher_type,
            COALESCE(s.invoice_no, 'SALE-' || s.id) AS voucher_no,
            s.payment_mode,
            0::NUMERIC AS debit,
            s.total_amount AS credit,
            'CANCELLED' AS status,
            COALESCE(s.cancellation_reason, 'Invoice cancelled') AS remarks,
            COALESCE(s.cancellation_reason, 'Invoice cancelled') AS narration
          FROM sales s
          LEFT JOIN customers c ON c.id = s.customer_id
          WHERE s.cancelled_at::date BETWEEN $1 AND $2
            AND s.sale_status = 'CANCELLED'
          UNION ALL
          SELECT cp.payment_date AS date, 'Customer Payment' AS transaction_type,
            c.customer_name AS party_name,
            'CUSTOMER' AS account_type,
            'CUSTOMER-' || c.id AS account_key,
            'Receipt' AS voucher_type,
            COALESCE(cp.reference_number, 'CP-' || cp.id) AS voucher_no,
            cp.payment_mode,
            0::NUMERIC AS debit,
            cp.payment_amount AS credit,
            CASE WHEN cp.cancelled THEN 'CANCELLED' ELSE 'ACTIVE' END AS status,
            COALESCE(cp.remarks, cp.reference_number, 'Customer payment') AS remarks,
            COALESCE(cp.remarks, 'Customer payment received') AS narration
          FROM customer_payments cp
          JOIN customers c ON c.id = cp.customer_id
          WHERE cp.payment_date BETWEEN $1 AND $2
          UNION ALL
          SELECT e.expense_date AS date, 'Expense' AS transaction_type,
            COALESCE(e.paid_to, e.vendor_name, e.category) AS party_name,
            'EXPENSE_VENDOR' AS account_type,
            'EXPENSE-' || e.id AS account_key,
            'Expense' AS voucher_type,
            COALESCE(e.reference_number, 'EXP-' || e.id) AS voucher_no,
            e.payment_mode,
            e.amount AS debit,
            0::NUMERIC AS credit,
            COALESCE(e.status, CASE WHEN e.active IS DISTINCT FROM FALSE THEN 'ACTIVE' ELSE 'CANCELLED' END) AS status,
            COALESCE(e.remarks, e.category) AS remarks,
            e.category || CASE WHEN COALESCE(e.paid_to, e.vendor_name, '') <> '' THEN ' paid to ' || COALESCE(e.paid_to, e.vendor_name) ELSE '' END AS narration
          FROM expenses e
          WHERE e.expense_date BETWEEN $1 AND $2
          UNION ALL
          SELECT sr.return_date AS date, 'Sale Return' AS transaction_type,
            COALESCE(sr.customer_name, 'Walk-in Customer') AS party_name,
            'CUSTOMER' AS account_type,
            'CUSTOMER-' || COALESCE(s.customer_id, 0) AS account_key,
            'Sale Return' AS voucher_type,
            COALESCE(sr.return_no, 'RET-' || sr.id) AS voucher_no,
            sr.refund_type AS payment_mode,
            0::NUMERIC AS debit,
            sr.total_return_amount AS credit,
            'ACTIVE' AS status,
            COALESCE(sr.return_reason, 'Sale return') AS remarks,
            COALESCE(
              STRING_AGG(pr.product_name || ' ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM sri.return_quantity::TEXT)) || COALESCE(pr.unit, '') || ' @ ' || sri.selling_rate || ' = ' || sri.return_amount, E'\n' ORDER BY sri.id),
              COALESCE(sr.return_reason, 'Sale return')
            ) AS narration
          FROM sale_returns sr
          LEFT JOIN sales s ON s.id = sr.sale_id
          LEFT JOIN sale_return_items sri ON sri.sale_return_id = sr.id
          LEFT JOIN products pr ON pr.id = sri.product_id
          WHERE sr.return_date BETWEEN $1 AND $2
          GROUP BY sr.id, s.customer_id
          UNION ALL
          SELECT we.waste_date AS date, 'Waste' AS transaction_type,
            p.product_name AS party_name,
            'OTHER' AS account_type,
            'WASTE-' || we.id AS account_key,
            'Waste' AS voucher_type,
            'WST-' || we.id AS voucher_no,
            '' AS payment_mode,
            we.cost_amount AS debit,
            0::NUMERIC AS credit,
            'ACTIVE' AS status,
            COALESCE(we.remarks, we.waste_type) AS remarks,
            p.product_name || ' ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM we.quantity::TEXT)) || COALESCE(p.unit, '') || ' wasted: ' || we.waste_type AS narration
          FROM waste_entries we
          JOIN products p ON p.id = we.product_id
          WHERE we.waste_date BETWEEN $1 AND $2
        ) ledger
        ORDER BY date DESC, transaction_type, party_name
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        WITH days AS (
          SELECT generate_series($1::date, $2::date, INTERVAL '1 day')::date AS day
        ),
        sales_by_day AS (
          SELECT sale_date::date AS day, SUM(total_amount) AS sales, SUM(profit) AS profit, COUNT(*) AS transactions
          FROM sales
          WHERE sale_status <> 'CANCELLED' AND sale_date BETWEEN $1 AND $2
          GROUP BY sale_date
        ),
        purchases_by_day AS (
          SELECT purchase_date::date AS day, SUM(COALESCE(NULLIF(net_payable, 0), total_amount, 0)) AS purchases
          FROM purchases
          WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED' AND purchase_date BETWEEN $1 AND $2
          GROUP BY purchase_date
        ),
        expenses_by_day AS (
          SELECT expense_date::date AS day, SUM(amount) AS expenses
          FROM expenses
          WHERE active IS DISTINCT FROM FALSE AND expense_date BETWEEN $1 AND $2
          GROUP BY expense_date
        ),
        sales_payments_by_day AS (
          SELECT s.sale_date::date AS day,
            SUM(CASE WHEN sp.payment_mode = 'CASH' THEN sp.amount ELSE 0 END) AS cash_sales,
            SUM(CASE WHEN sp.payment_mode = 'UPI' THEN sp.amount ELSE 0 END) AS upi_sales,
            SUM(CASE WHEN sp.payment_mode IN ('CARD', 'BANK_TRANSFER') THEN sp.amount ELSE 0 END) AS bank_card_sales
          FROM sale_payments sp
          JOIN sales s ON s.id = sp.sale_id
          WHERE s.sale_status <> 'CANCELLED' AND s.sale_date BETWEEN $1 AND $2
          GROUP BY s.sale_date
        ),
        customer_receipts_by_day AS (
          SELECT payment_date::date AS day,
            SUM(CASE WHEN payment_mode = 'CASH' THEN payment_amount ELSE 0 END) AS cash_receipts,
            SUM(CASE WHEN payment_mode = 'UPI' THEN payment_amount ELSE 0 END) AS upi_receipts,
            SUM(CASE WHEN payment_mode IN ('CARD', 'BANK_TRANSFER') THEN payment_amount ELSE 0 END) AS bank_card_receipts
          FROM customer_payments
          WHERE cancelled = FALSE AND payment_date BETWEEN $1 AND $2
          GROUP BY payment_date
        ),
        supplier_payments_by_day AS (
          SELECT payment_date::date AS day,
            SUM(CASE WHEN payment_mode = 'CASH' THEN payment_amount ELSE 0 END) AS cash_supplier_payments,
            SUM(CASE WHEN payment_mode = 'UPI' THEN payment_amount ELSE 0 END) AS upi_supplier_payments,
            SUM(CASE WHEN payment_mode IN ('BANK_TRANSFER', 'CHEQUE') THEN payment_amount ELSE 0 END) AS bank_supplier_payments
          FROM supplier_payments
          WHERE cancelled = FALSE AND payment_date BETWEEN $1 AND $2
          GROUP BY payment_date
        ),
        returns_by_day AS (
          SELECT return_date::date AS day, SUM(total_return_amount) AS returns
          FROM sale_returns
          WHERE return_date BETWEEN $1 AND $2
          GROUP BY return_date
        ),
        waste_by_day AS (
          SELECT waste_date::date AS day, SUM(cost_amount) AS waste
          FROM waste_entries
          WHERE waste_date BETWEEN $1 AND $2
          GROUP BY waste_date
        )
        SELECT
          TO_CHAR(days.day, 'YYYY-MM-DD') AS date,
          COALESCE(sales_by_day.sales, 0) AS sales,
          COALESCE(sales_by_day.profit, 0) AS profit,
          COALESCE(sales_by_day.transactions, 0)::INTEGER AS transactions,
          COALESCE(purchases_by_day.purchases, 0) AS purchases,
          COALESCE(expenses_by_day.expenses, 0) AS expenses,
          COALESCE(sales_payments_by_day.cash_sales, 0) AS cash_sales,
          COALESCE(sales_payments_by_day.upi_sales, 0) AS upi_sales,
          COALESCE(sales_payments_by_day.bank_card_sales, 0) AS bank_card_sales,
          COALESCE(customer_receipts_by_day.cash_receipts, 0) AS customer_cash_receipts,
          COALESCE(customer_receipts_by_day.upi_receipts, 0) AS customer_upi_receipts,
          COALESCE(customer_receipts_by_day.bank_card_receipts, 0) AS customer_bank_card_receipts,
          COALESCE(supplier_payments_by_day.cash_supplier_payments, 0) AS supplier_cash_payments,
          COALESCE(supplier_payments_by_day.upi_supplier_payments, 0) AS supplier_upi_payments,
          COALESCE(supplier_payments_by_day.bank_supplier_payments, 0) AS supplier_bank_payments,
          COALESCE(returns_by_day.returns, 0) AS returns,
          COALESCE(waste_by_day.waste, 0) AS waste,
          COALESCE(sales_by_day.profit, 0) - COALESCE(expenses_by_day.expenses, 0) - COALESCE(waste_by_day.waste, 0) AS net_profit
        FROM days
        LEFT JOIN sales_by_day ON sales_by_day.day = days.day
        LEFT JOIN purchases_by_day ON purchases_by_day.day = days.day
        LEFT JOIN expenses_by_day ON expenses_by_day.day = days.day
        LEFT JOIN sales_payments_by_day ON sales_payments_by_day.day = days.day
        LEFT JOIN customer_receipts_by_day ON customer_receipts_by_day.day = days.day
        LEFT JOIN supplier_payments_by_day ON supplier_payments_by_day.day = days.day
        LEFT JOIN returns_by_day ON returns_by_day.day = days.day
        LEFT JOIN waste_by_day ON waste_by_day.day = days.day
        ORDER BY days.day DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.product_name,
          p.unit,
          SUM(COALESCE(sba.quantity, si.quantity)) AS quantity_sold,
          SUM(ROUND((COALESCE(si.net_amount, si.amount - COALESCE(si.discount_amount, 0)) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2)) AS revenue,
          SUM(ROUND((COALESCE(si.cost_amount, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2)) AS cost,
          SUM(ROUND((COALESCE(si.profit, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2)) AS profit,
          ib.lot_name,
          ib.lot_size
        FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        JOIN products p ON p.id = si.product_id
        LEFT JOIN sale_batch_allocations sba ON sba.sale_item_id = si.id
        LEFT JOIN inventory_batches ib ON ib.id = sba.inventory_batch_id
        WHERE s.sale_status <> 'CANCELLED'
          AND s.sale_date BETWEEN $1 AND $2
        GROUP BY p.product_name, p.unit, ib.lot_name, ib.lot_size
        ORDER BY quantity_sold DESC, revenue DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          COALESCE(c.customer_name, NULLIF(s.customer_name, ''), 'Walk-in Customer') AS customer_name,
          COALESCE(c.mobile_number, s.customer_mobile, '') AS customer_mobile,
          COALESCE(s.customer_id, c.id) AS customer_id,
          COUNT(*)::INTEGER AS invoice_count,
          SUM(s.total_amount) AS total_sales,
          SUM(s.profit) AS total_profit
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.sale_status <> 'CANCELLED'
          AND s.sale_date BETWEEN $1 AND $2
        GROUP BY COALESCE(c.customer_name, NULLIF(s.customer_name, ''), 'Walk-in Customer'), COALESCE(c.mobile_number, s.customer_mobile, ''), COALESCE(s.customer_id, c.id)
        ORDER BY total_sales DESC, invoice_count DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          s.id,
          s.invoice_no,
          s.sale_date,
          s.created_at,
          s.sale_status,
          s.customer_id,
          COALESCE(s.customer_name, c.customer_name, 'Walk-in Customer') AS customer_name,
          s.customer_mobile,
          s.payment_mode,
          s.gross_amount,
          COALESCE(s.item_discount_amount, 0) AS item_discount_amount,
          COALESCE(s.invoice_discount_amount, 0) AS invoice_discount_amount,
          COALESCE(s.item_discount_amount, 0) + COALESCE(s.invoice_discount_amount, 0) AS discount_amount,
          s.total_amount,
          s.total_cost,
          s.profit,
          COALESCE(
            JSON_AGG(
              JSON_BUILD_OBJECT(
                'id', si.id,
                'sale_item_id', si.id,
                'product_id', si.product_id,
                'product_name', p.product_name,
                'category', p.category,
                'inventory_batch_id', sba.inventory_batch_id,
                'lot_name', ib.lot_name,
                'lot_size', ib.lot_size,
                'unit', p.unit,
                'quantity', COALESCE(sba.quantity, si.quantity),
                'item_total_quantity', si.quantity,
                'selling_rate', si.selling_rate,
                'gross_amount', ROUND((si.amount * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2),
                'discount_amount', ROUND((COALESCE(si.discount_amount, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2),
                'net_amount', ROUND((COALESCE(si.net_amount, si.amount - COALESCE(si.discount_amount, 0)) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2),
                'cost_amount', ROUND((COALESCE(si.cost_amount, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2),
                'profit', ROUND((COALESCE(si.profit, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2),
                'cost_status', si.cost_status,
                'default_selling_rate', si.default_selling_rate,
                'manual_rate_override', COALESCE(si.manual_rate_override, FALSE),
                'lot_discount_id', si.lot_discount_id,
                'lot_discount_type', si.lot_discount_type,
                'lot_discount_value', COALESCE(si.lot_discount_value, 0)
              )
              ORDER BY si.id, sba.id
            ) FILTER (WHERE si.id IS NOT NULL),
            '[]'::json
          ) AS items
        FROM sales s
        LEFT JOIN customers c ON c.id = s.customer_id
        LEFT JOIN sale_items si ON si.sale_id = s.id
        LEFT JOIN products p ON p.id = si.product_id
        LEFT JOIN sale_batch_allocations sba ON sba.sale_item_id = si.id
        LEFT JOIN inventory_batches ib ON ib.id = sba.inventory_batch_id
        WHERE s.sale_date BETWEEN $1 AND $2
        GROUP BY
          s.id,
          s.invoice_no,
          s.sale_date,
          s.created_at,
          s.sale_status,
          s.customer_id,
          s.customer_name,
          c.customer_name,
          s.customer_mobile,
          s.payment_mode,
          s.gross_amount,
          s.item_discount_amount,
          s.invoice_discount_amount,
          s.total_amount,
          s.total_cost,
          s.profit
        ORDER BY s.sale_date DESC, s.created_at DESC, s.id DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          s.id,
          s.invoice_no,
          s.sale_date,
          s.sale_status,
          s.total_amount,
          s.cancelled_at,
          s.cancellation_reason,
          s.edit_reason,
          u.full_name AS changed_by_name,
          s.edited_at
        FROM sales s
        LEFT JOIN users u ON u.id = COALESCE(s.cancelled_by, s.edited_by)
        WHERE (s.sale_status IN ('EDITED', 'CANCELLED') OR s.edited_at IS NOT NULL OR s.cancelled_at IS NOT NULL)
          AND s.sale_date BETWEEN $1 AND $2
        ORDER BY COALESCE(s.cancelled_at, s.edited_at, s.created_at) DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.category,
          p.product_name,
          p.unit,
          SUM(pi.quantity) AS quantity_purchased,
          SUM(pi.net_payable) AS net_purchase,
          SUM(pi.mandi_tax_amount) AS mandi_tax,
          SUM(pi.rebate_amount) AS rebate
        FROM purchase_items pi
        JOIN purchases pur ON pur.id = pi.purchase_id
        JOIN products p ON p.id = pi.product_id
        WHERE COALESCE(pur.purchase_status, 'ACTIVE') <> 'CANCELLED'
          AND pur.purchase_date BETWEEN $1 AND $2
        GROUP BY p.category, p.product_name, p.unit
        ORDER BY quantity_purchased DESC, net_purchase DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          supplier_name,
          COUNT(*)::INTEGER AS purchase_count,
          SUM(COALESCE(NULLIF(gross_amount, 0), total_amount, 0)) AS gross_purchase,
          SUM(COALESCE(rebate_amount, 0)) AS rebate_received,
          SUM(COALESCE(NULLIF(net_payable, 0), total_amount, 0)) AS net_purchase,
          SUM(COALESCE(paid_amount, 0)) AS paid_amount,
          SUM(COALESCE(balance_amount, 0)) AS balance_amount
        FROM purchases
        WHERE COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'
          AND purchase_date BETWEEN $1 AND $2
        GROUP BY supplier_name
        ORDER BY net_purchase DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          p.id,
          p.purchase_date,
          p.supplier_name,
          p.purchase_status,
          p.net_payable,
          p.cancelled_at,
          p.cancellation_reason,
          p.edited_at,
          p.edit_reason,
          u.full_name AS changed_by_name
        FROM purchases p
        LEFT JOIN users u ON u.id = COALESCE(p.cancelled_by, p.edited_by)
        WHERE (p.purchase_status IN ('EDITED', 'CANCELLED') OR p.edited_at IS NOT NULL OR p.cancelled_at IS NOT NULL)
          AND p.purchase_date BETWEEN $1 AND $2
        ORDER BY COALESCE(p.cancelled_at, p.edited_at, p.created_at) DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          sr.return_no,
          sr.return_date,
          s.invoice_no,
          COALESCE(sr.customer_name, 'Walk-in Customer') AS customer_name,
          sr.customer_mobile,
          sr.refund_type,
          sr.total_return_amount,
          sr.return_reason,
          STRING_AGG(p.product_name || ' x ' || sri.return_quantity, ', ' ORDER BY sri.id) AS items
        FROM sale_returns sr
        LEFT JOIN sales s ON s.id = sr.sale_id
        LEFT JOIN sale_return_items sri ON sri.sale_return_id = sr.id
        LEFT JOIN products p ON p.id = sri.product_id
        WHERE sr.return_date BETWEEN $1 AND $2
        GROUP BY sr.id, s.invoice_no
        ORDER BY sr.return_date DESC, sr.id DESC
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          st.created_at::date AS movement_date,
          p.product_name,
          p.unit,
          st.transaction_type,
          SUM(st.quantity) AS quantity,
          COUNT(*)::INTEGER AS movement_count,
          STRING_AGG(DISTINCT COALESCE(st.remarks, ''), ', ') AS remarks
        FROM stock_transactions st
        JOIN products p ON p.id = st.product_id
        WHERE st.created_at::date BETWEEN $1 AND $2
        GROUP BY st.created_at::date, p.product_name, p.unit, st.transaction_type
        ORDER BY movement_date DESC, p.product_name, st.transaction_type
      `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          COALESCE((SELECT SUM(total_amount) FROM sales WHERE sale_status <> 'CANCELLED' AND sale_date BETWEEN $1 AND $2), 0) AS sales_revenue,
          COALESCE((SELECT SUM(total_cost) FROM sales WHERE sale_status <> 'CANCELLED' AND sale_date BETWEEN $1 AND $2), 0) AS purchase_cost,
          COALESCE((SELECT SUM(mandi_tax_amount) FROM purchases WHERE purchase_date BETWEEN $1 AND $2 AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'), 0) AS mandi_tax,
          COALESCE((SELECT SUM(freight_charges) FROM purchases WHERE purchase_date BETWEEN $1 AND $2 AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'), 0) AS freight_charges,
          COALESCE((SELECT SUM(labour_charges) FROM purchases WHERE purchase_date BETWEEN $1 AND $2 AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'), 0) AS labour_charges,
          COALESCE((SELECT SUM(other_charges) FROM purchases WHERE purchase_date BETWEEN $1 AND $2 AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'), 0) AS other_purchase_charges,
          COALESCE((SELECT SUM(amount) FROM expenses WHERE active IS DISTINCT FROM FALSE AND COALESCE(status, 'ACTIVE') <> 'CANCELLED' AND expense_date BETWEEN $1 AND $2), 0) AS expenses,
          COALESCE((SELECT SUM(rebate_amount) FROM purchases WHERE purchase_date BETWEEN $1 AND $2 AND COALESCE(purchase_status, 'ACTIVE') <> 'CANCELLED'), 0)
            + COALESCE((SELECT SUM(rebate_amount) FROM supplier_payments WHERE cancelled = FALSE AND payment_date BETWEEN $1 AND $2), 0) AS supplier_rebate_received,
          COALESCE((
            SELECT JSON_AGG(JSON_BUILD_OBJECT('category', category, 'amount', total_amount) ORDER BY category)
            FROM (
              SELECT category, SUM(amount) AS total_amount
              FROM expenses
              WHERE active IS DISTINCT FROM FALSE
                AND COALESCE(status, 'ACTIVE') <> 'CANCELLED'
                AND expense_date BETWEEN $1 AND $2
              GROUP BY category
            ) expense_categories
          ), '[]'::json) AS expense_categories
        `,
        [dateFrom, dateTo]
      ),
      pool.query(
        `
        SELECT
          transaction_date,
          source,
          payment_mode,
          COUNT(*)::INTEGER AS transaction_count,
          SUM(amount) AS total_amount
        FROM (
          SELECT s.sale_date AS transaction_date, 'Sales' AS source, sp.payment_mode, sp.amount
          FROM sale_payments sp
          JOIN sales s ON s.id = sp.sale_id
          WHERE s.sale_status <> 'CANCELLED' AND s.sale_date BETWEEN $1 AND $2
          UNION ALL
          SELECT cp.payment_date AS transaction_date, 'Customer Receipt' AS source, cp.payment_mode, cp.payment_amount AS amount
          FROM customer_payments cp
          WHERE cp.cancelled = FALSE AND cp.payment_date BETWEEN $1 AND $2
          UNION ALL
          SELECT sp.payment_date AS transaction_date, 'Supplier Payment' AS source, sp.payment_mode, sp.payment_amount AS amount
          FROM supplier_payments sp
          WHERE sp.cancelled = FALSE AND sp.payment_date BETWEEN $1 AND $2
          UNION ALL
          SELECT e.expense_date AS transaction_date, 'Expense' AS source, e.payment_mode, e.amount
          FROM expenses e
          WHERE e.active IS DISTINCT FROM FALSE AND e.expense_date BETWEEN $1 AND $2
        ) mode_rows
        GROUP BY transaction_date, source, payment_mode
        ORDER BY transaction_date DESC, source, payment_mode
        `,
        [dateFrom, dateTo]
      ),
    ]);
    const balanceSheetSnapshot = await getBalanceSheetSnapshot({ dateTo });
    const profitLoss = profitLossResult.rows[0] || {};
    const customerReceivable = customerRows.reduce((sum, row) => sum + Number(row.outstanding_balance || 0), 0);
    const supplierPayable = supplierRows.reduce((sum, row) => sum + Number(row.outstanding_balance || 0), 0);
    const purchaseCost = Number(profitLoss.purchase_cost || 0);
    const mandiTax = Number(profitLoss.mandi_tax || 0);
    const freightCharges = Number(profitLoss.freight_charges || 0);
    const labourCharges = Number(profitLoss.labour_charges || 0);
    const otherPurchaseCharges = Number(profitLoss.other_purchase_charges || 0);
    const supplierRebateReceived = Number(profitLoss.supplier_rebate_received || 0);
    const costOfGoodsSold = purchaseCost + mandiTax + freightCharges + labourCharges + otherPurchaseCharges - supplierRebateReceived;
    const grossProfit = Number(profitLoss.sales_revenue || 0) - costOfGoodsSold;
    const netProfit = grossProfit - Number(profitLoss.expenses || 0);
    return res.json({
      dateFrom,
      dateTo,
      salesReport: salesResult.rows,
      purchaseReport: purchaseResult.rows,
      supplierOutstandingReport: supplierRows,
      customerOutstandingReport: customerRows,
      discountReport: discountResult.rows,
      expenseReport: expenseResult.rows,
      paymentReport: paymentResult.rows,
      paymentModeSummary: paymentModeSummaryResult.rows,
      returnReport: returnResult.rows,
      returnReasonReport: returnReasonResult.rows,
      wasteReport: wasteResult.rows,
      wasteProductReport: wasteProductResult.rows,
      mostWastedProducts: wasteProductResult.rows.slice(0, 5),
      stockReport: stockResult.rows,
      ledgerReport: ledgerResult.rows,
      dayToDayReport: ledgerResult.rows,
      salesProductReport: salesProductResult.rows,
      salesCustomerReport: salesCustomerResult.rows,
      salesHistoryReport: salesHistoryResult.rows,
      salesChangeReport: salesChangeResult.rows,
      purchaseHistoryReport: purchaseHistoryResult.rows,
      purchaseProductReport: purchaseProductResult.rows,
      purchaseSupplierReport: purchaseSupplierResult.rows,
      purchaseChangeReport: purchaseChangeResult.rows,
      pendingPurchaseBillsReport: pendingPurchaseResult.rows,
      stockWithoutBillReport: stockWithoutBillResult.rows,
      provisionalProfitSalesReport: provisionalSalesResult.rows,
      returnHistoryReport: returnHistoryResult.rows,
      stockMovementReport: stockMovementResult.rows,
      balanceSheet: {
        cash: balanceSheetSnapshot.cash,
        bank: balanceSheetSnapshot.bank,
        inventory: balanceSheetSnapshot.inventory,
        customerReceivable: balanceSheetSnapshot.customerReceivable,
        supplierPayable: balanceSheetSnapshot.supplierPayable,
        netProfit: balanceSheetSnapshot.netProfit,
        ownerCapital: balanceSheetSnapshot.ownerCapital,
        netPosition: balanceSheetSnapshot.netPosition,
        totalAssets: balanceSheetSnapshot.totalAssets,
        totalLiabilities: balanceSheetSnapshot.totalLiabilities,
      },
      profitLoss: {
        salesRevenue: roundCurrency(Number(profitLoss.sales_revenue || 0)),
        purchaseCost: roundCurrency(purchaseCost),
        mandiTax: roundCurrency(mandiTax),
        freightCharges: roundCurrency(freightCharges),
        labourCharges: roundCurrency(labourCharges),
        otherPurchaseCharges: roundCurrency(otherPurchaseCharges),
        supplierRebateReceived: roundCurrency(supplierRebateReceived),
        costOfGoodsSold: roundCurrency(costOfGoodsSold),
        expenses: roundCurrency(Number(profitLoss.expenses || 0)),
        expenseCategories: Array.isArray(profitLoss.expense_categories) ? profitLoss.expense_categories : [],
        cashSales: roundCurrency(paymentModeSummaryResult.rows.filter((row) => row.source === "Sales" && row.payment_mode === "CASH").reduce((sum, row) => sum + Number(row.total_amount || 0), 0)),
        upiSales: roundCurrency(paymentModeSummaryResult.rows.filter((row) => row.source === "Sales" && row.payment_mode === "UPI").reduce((sum, row) => sum + Number(row.total_amount || 0), 0)),
        bankCardSales: roundCurrency(paymentModeSummaryResult.rows.filter((row) => row.source === "Sales" && ["CARD", "BANK_TRANSFER"].includes(row.payment_mode)).reduce((sum, row) => sum + Number(row.total_amount || 0), 0)),
        grossProfit: roundCurrency(grossProfit),
        netProfit: roundCurrency(netProfit),
      },
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Reports" });
  }
});

app.get("/expenses", async (req, res) => {
  try {
    const filters = [];
    const values = [];
    if (req.query.date_from) {
      values.push(req.query.date_from);
      filters.push(`e.expense_date >= $${values.length}`);
    }
    if (req.query.date_to) {
      values.push(req.query.date_to);
      filters.push(`e.expense_date <= $${values.length}`);
    }
    if (req.query.category) {
      values.push(cleanText(req.query.category));
      filters.push(`LOWER(e.category) = LOWER($${values.length})`);
    }
    if (req.query.payment_mode) {
      values.push(normalizePaymentMode(req.query.payment_mode));
      filters.push(`e.payment_mode = $${values.length}`);
    }
    if (req.query.status) {
      values.push(String(req.query.status).toUpperCase());
      filters.push(`COALESCE(e.status, CASE WHEN e.active IS DISTINCT FROM FALSE THEN 'ACTIVE' ELSE 'CANCELLED' END) = $${values.length}`);
    }
    if (req.query.search) {
      values.push(`%${cleanText(req.query.search).toLowerCase()}%`);
      filters.push(`(
        LOWER(e.category) LIKE $${values.length}
        OR LOWER(COALESCE(e.vendor_name, e.paid_to, '')) LIKE $${values.length}
        OR LOWER(COALESCE(e.reference_number, '')) LIKE $${values.length}
        OR LOWER(COALESCE(e.remarks, '')) LIKE $${values.length}
      )`);
    }
    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const result = await pool.query(
      `
      SELECT e.*, COALESCE(e.paid_to, e.vendor_name) AS paid_to, u.full_name AS created_by_name,
             eu.full_name AS edited_by_name, cu.full_name AS cancelled_by_name
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      LEFT JOIN users eu ON eu.id = e.edited_by
      LEFT JOIN users cu ON cu.id = e.cancelled_by
      ${whereClause}
      ORDER BY e.expense_date DESC, e.created_at DESC, e.id DESC
      `,
      values
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Expenses" });
  }
});

app.post("/expenses", async (req, res) => {
  try {
    const amount = parsePositiveNumber(req.body.amount);
    const category = cleanText(req.body.category);
    const paymentMode = normalizePaymentMode(req.body.payment_mode || "CASH");
    if (!category || !amount || !SUPPLIER_PAYMENT_MODES.has(paymentMode)) {
      return res.status(400).json({ message: "Enter valid expense details" });
    }
    const result = await pool.query(
      `
      INSERT INTO expenses (
        expense_date, category, amount, payment_mode, reference_number,
        vendor_name, paid_to, remarks, branch_id, created_by, active, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'ACTIVE')
      RETURNING *
      `,
      [
        req.body.expense_date || toDateKey(new Date()), category, amount, paymentMode,
        nullableText(req.body.reference_number), nullableText(req.body.vendor_name || req.body.paid_to),
        nullableText(req.body.paid_to || req.body.vendor_name),
        nullableText(req.body.remarks), parsePositiveInteger(req.body.branch_id),
        parsePositiveInteger(req.body.created_by) || 1, req.body.active !== false,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Expense" });
  }
});

app.put("/expenses/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const expenseId = parsePositiveInteger(req.params.id);
    const amount = parsePositiveNumber(req.body.amount);
    const category = cleanText(req.body.category);
    const paymentMode = normalizePaymentMode(req.body.payment_mode || "CASH");
    if (!expenseId || !category || !amount || !SUPPLIER_PAYMENT_MODES.has(paymentMode)) {
      return res.status(400).json({ message: "Enter valid expense details" });
    }
    await client.query("BEGIN");
    const oldResult = await client.query("SELECT * FROM expenses WHERE id = $1 FOR UPDATE", [expenseId]);
    const oldExpense = oldResult.rows[0];
    if (!oldExpense) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Expense not found" });
    }
    if (oldExpense.status === "CANCELLED" || oldExpense.active === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cancelled expenses cannot be edited" });
    }
    const editorId = parsePositiveInteger(req.body.edited_by) || parsePositiveInteger(req.body.created_by) || 1;
    const reason = cleanText(req.body.reason || req.body.edit_reason || "Expense updated");
    const result = await client.query(
      `
      UPDATE expenses
      SET expense_date = $1, category = $2, amount = $3, payment_mode = $4,
          reference_number = $5, vendor_name = $6, paid_to = $7, remarks = $8,
          branch_id = $9, active = TRUE, status = 'ACTIVE',
          edited_by = $10, edited_at = CURRENT_TIMESTAMP, edit_reason = $11,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $12
      RETURNING *
      `,
      [
        req.body.expense_date || toDateKey(new Date()), category, amount, paymentMode,
        nullableText(req.body.reference_number), nullableText(req.body.vendor_name || req.body.paid_to),
        nullableText(req.body.paid_to || req.body.vendor_name),
        nullableText(req.body.remarks), parsePositiveInteger(req.body.branch_id),
        editorId, reason, expenseId,
      ]
    );
    await client.query(
      `
      INSERT INTO expense_audit_trail (expense_id, action, old_value, new_value, reason, changed_by)
      VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [expenseId, JSON.stringify(oldExpense), JSON.stringify(result.rows[0]), reason, editorId]
    );
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Updating Expense" });
  } finally {
    client.release();
  }
});

app.post("/expenses/:id/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const expenseId = parsePositiveInteger(req.params.id);
    const reason = cleanText(req.body.reason);
    const cancelledBy = parsePositiveInteger(req.body.cancelled_by) || 1;
    if (!expenseId || !reason) return res.status(400).json({ message: "Cancellation reason is required" });
    await client.query("BEGIN");
    const oldResult = await client.query("SELECT * FROM expenses WHERE id = $1 FOR UPDATE", [expenseId]);
    const oldExpense = oldResult.rows[0];
    if (!oldExpense) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Expense not found" });
    }
    if (oldExpense.status === "CANCELLED" || oldExpense.active === false) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Expense is already cancelled" });
    }
    const result = await client.query(
      `
      UPDATE expenses
      SET active = FALSE, status = 'CANCELLED',
          cancelled_by = $1, cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $3
      RETURNING *
      `,
      [cancelledBy, reason, expenseId]
    );
    await client.query(
      `
      INSERT INTO expense_audit_trail (expense_id, action, old_value, new_value, reason, changed_by)
      VALUES ($1, 'CANCEL', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [expenseId, JSON.stringify(oldExpense), JSON.stringify(result.rows[0]), reason, cancelledBy]
    );
    await client.query("COMMIT");
    return res.json({ success: true, expense: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Cancelling Expense" });
  } finally {
    client.release();
  }
});

app.get("/supplier-payments", async (req, res) => {
  try {
    const supplierId = req.query.supplier_id ? parsePositiveInteger(req.query.supplier_id) : null;
    if (req.query.supplier_id && !supplierId) return res.status(400).json({ message: "Invalid supplier" });
    const values = supplierId ? [supplierId] : [];
    const result = await pool.query(
      `
      SELECT sp.*, s.supplier_name, s.firm_name
      FROM supplier_payments sp
      JOIN suppliers s ON s.id = sp.supplier_id
      ${supplierId ? "WHERE sp.supplier_id = $1" : ""}
      ORDER BY sp.payment_date DESC, sp.created_at DESC, sp.id DESC
      `,
      values
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Supplier Payments" });
  }
});

app.post("/supplier-payments", async (req, res) => {
  try {
    const supplierId = parsePositiveInteger(req.body.supplier_id);
    const paymentAmount = parseNonNegativeNumber(req.body.payment_amount);
    const rebateAmount = parseNonNegativeNumber(req.body.rebate_received ?? req.body.rebate_amount);
    const paymentMode = normalizePaymentMode(req.body.payment_mode);
    const branchId = parsePositiveInteger(req.body.branch_id);
    const createdBy = parsePositiveInteger(req.body.created_by) || 1;
    const paymentDate = req.body.payment_date || toDateKey(new Date());

    if (
      !supplierId ||
      paymentAmount === null ||
      rebateAmount === null ||
      paymentAmount + rebateAmount <= 0 ||
      !SUPPLIER_PAYMENT_MODES.has(paymentMode)
    ) {
      return res.status(400).json({ message: "Enter valid supplier payment details" });
    }

    const supplierResult = await pool.query("SELECT id FROM suppliers WHERE id = $1 AND active = TRUE", [supplierId]);
    if (supplierResult.rows.length === 0) {
      return res.status(400).json({ message: "Select an active supplier account" });
    }

    const result = await pool.query(
      `
      INSERT INTO supplier_payments (
        supplier_id, payment_date, payment_amount, rebate_amount, payment_mode,
        reference_number, remarks, branch_id, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
      `,
      [
        supplierId, paymentDate, paymentAmount, rebateAmount, paymentMode,
        nullableText(req.body.reference_number), nullableText(req.body.remarks), branchId, createdBy,
      ]
    );
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Saving Supplier Payment" });
  }
});

app.put("/supplier-payments/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const paymentId = parsePositiveInteger(req.params.id);
    const supplierId = parsePositiveInteger(req.body.supplier_id);
    const paymentAmount = parseNonNegativeNumber(req.body.payment_amount);
    const rebateAmount = parseNonNegativeNumber(req.body.rebate_received ?? req.body.rebate_amount);
    const paymentMode = normalizePaymentMode(req.body.payment_mode);
    const editedBy = parsePositiveInteger(req.body.edited_by) || parsePositiveInteger(req.body.created_by) || 1;
    const reason = cleanText(req.body.reason);
    const paymentDate = req.body.payment_date || toDateKey(new Date());
    if (!paymentId || !supplierId || paymentAmount === null || rebateAmount === null || paymentAmount + rebateAmount <= 0 || !SUPPLIER_PAYMENT_MODES.has(paymentMode) || !reason) {
      return res.status(400).json({ message: "Enter valid supplier payment edit details and reason" });
    }
    await client.query("BEGIN");
    const oldResult = await client.query("SELECT * FROM supplier_payments WHERE id = $1 FOR UPDATE", [paymentId]);
    const oldPayment = oldResult.rows[0];
    if (!oldPayment) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Supplier payment not found" });
    }
    if (oldPayment.cancelled) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cancelled supplier payments cannot be edited" });
    }
    const supplierResult = await client.query("SELECT id FROM suppliers WHERE id = $1 AND active = TRUE", [supplierId]);
    if (supplierResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Select an active supplier account" });
    }
    const result = await client.query(
      `
      UPDATE supplier_payments
      SET supplier_id = $1, payment_date = $2, payment_amount = $3, rebate_amount = $4,
          payment_mode = $5, reference_number = $6, remarks = $7, branch_id = $8,
          edited_by = $9, edited_at = CURRENT_TIMESTAMP, edit_reason = $10
      WHERE id = $11
      RETURNING *
      `,
      [
        supplierId, paymentDate, paymentAmount, rebateAmount, paymentMode,
        nullableText(req.body.reference_number), nullableText(req.body.remarks),
        parsePositiveInteger(req.body.branch_id), editedBy, reason, paymentId,
      ]
    );
    await client.query(
      `
      INSERT INTO supplier_payment_audit (supplier_payment_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [paymentId, JSON.stringify(oldPayment), JSON.stringify(result.rows[0]), reason, editedBy]
    );
    await client.query("COMMIT");
    return res.json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Updating Supplier Payment" });
  } finally {
    client.release();
  }
});

app.post("/supplier-payments/:id/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const paymentId = parsePositiveInteger(req.params.id);
    const cancelledBy = parsePositiveInteger(req.body.cancelled_by) || 1;
    const reason = cleanText(req.body.reason);
    if (!paymentId || !reason) return res.status(400).json({ message: "Cancellation reason is required" });
    await client.query("BEGIN");
    const oldResult = await client.query("SELECT * FROM supplier_payments WHERE id = $1 FOR UPDATE", [paymentId]);
    const oldPayment = oldResult.rows[0];
    if (!oldPayment) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Supplier payment not found" });
    }
    if (oldPayment.cancelled) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Supplier payment is already cancelled" });
    }
    const result = await client.query(
      `
      UPDATE supplier_payments
      SET cancelled = TRUE, cancelled_by = $1, cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = $2
      WHERE id = $3
      RETURNING *
      `,
      [cancelledBy, reason, paymentId]
    );
    await client.query(
      `
      INSERT INTO supplier_payment_audit (supplier_payment_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'CANCEL', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [paymentId, JSON.stringify(oldPayment), JSON.stringify(result.rows[0]), reason, cancelledBy]
    );
    await client.query("COMMIT");
    return res.json({ success: true, payment: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Cancelling Supplier Payment" });
  } finally {
    client.release();
  }
});

app.get("/supplier-ledger", async (req, res) => {
  try {
    const supplierId = req.query.supplier_id ? parsePositiveInteger(req.query.supplier_id) : null;
    if (req.query.supplier_id && !supplierId) return res.status(400).json({ message: "Invalid supplier" });

    const suppliers = await getSupplierSummaryRows({ supplierId });
    if (supplierId && suppliers.length === 0) return res.status(404).json({ message: "Supplier not found" });
    if (suppliers.length === 0) return res.json({ suppliers: [], ledger: [] });

    const supplierIds = suppliers.map((supplier) => supplier.id);
    const [purchaseResult, paymentResult] = await Promise.all([
      pool.query(
        `
        SELECT
          p.id,
          p.supplier_id,
          p.supplier_name,
          p.purchase_date,
          p.created_at,
          COALESCE(NULLIF(p.gross_amount, 0), p.total_amount, 0) AS gross_amount,
          COALESCE(p.rebate_amount, 0) AS rebate_amount,
          COALESCE(NULLIF(p.net_payable, 0), p.total_amount, 0) AS net_payable,
          COALESCE(p.paid_amount, 0) AS paid_amount,
          p.payment_date,
          p.payment_status,
          p.payment_timing,
          STRING_AGG(pr.product_name || ' x ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM pi.quantity::TEXT)), ', ' ORDER BY pi.id) AS item_summary
        FROM purchases p
        LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
        LEFT JOIN products pr ON pr.id = pi.product_id
        WHERE p.supplier_id = ANY($1::INT[])
          AND COALESCE(p.purchase_status, 'ACTIVE') <> 'CANCELLED'
          AND COALESCE(p.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_COMPLETED'
        GROUP BY p.id
        ORDER BY p.purchase_date, p.created_at, p.id
        `,
        [supplierIds]
      ),
      pool.query(
        `
        SELECT sp.*, s.supplier_name
        FROM supplier_payments sp
        JOIN suppliers s ON s.id = sp.supplier_id
        WHERE sp.supplier_id = ANY($1::INT[])
          AND sp.cancelled = FALSE
        ORDER BY sp.payment_date, sp.created_at, sp.id
        `,
        [supplierIds]
      ),
    ]);

    const ledgersBySupplier = new Map(supplierIds.map((id) => [id, []]));
    const pushEvent = (event) => {
      if (!ledgersBySupplier.has(event.supplier_id)) ledgersBySupplier.set(event.supplier_id, []);
      ledgersBySupplier.get(event.supplier_id).push(event);
    };

    for (const supplier of suppliers) {
      if (Number(supplier.opening_balance) > 0) {
        pushEvent({
          supplier_id: supplier.id,
          supplier_name: supplier.supplier_name,
          transaction_date: toDateKey(supplier.created_at),
          sort_date: toDateKey(supplier.created_at),
          sort_key: `0000-${supplier.id}`,
          transaction_type: "Opening Balance",
          purchase_amount: 0,
          payment_amount: 0,
          rebate_amount: 0,
          balance_delta: Number(supplier.opening_balance),
          remarks: "Opening supplier payable balance",
        });
      }
    }

    for (const purchase of purchaseResult.rows) {
      const grossAmount = Number(purchase.gross_amount || 0);
      const rebateAmount = Number(purchase.rebate_amount || 0);
      const paidAmount = Number(purchase.paid_amount || 0);
      pushEvent({
        supplier_id: purchase.supplier_id,
        supplier_name: purchase.supplier_name,
        transaction_date: toDateKey(purchase.purchase_date),
        sort_date: toDateKey(purchase.purchase_date),
        sort_key: `P-${String(purchase.id).padStart(8, "0")}-0`,
        transaction_type: "Purchase",
        purchase_id: purchase.id,
        purchase_amount: grossAmount,
        payment_amount: 0,
        rebate_amount: rebateAmount,
        balance_delta: roundCurrency(grossAmount - rebateAmount),
        remarks: `${purchase.item_summary || "Purchase"}${purchase.payment_timing ? ` - ${purchase.payment_timing}` : ""}`,
      });
      if (paidAmount > 0) {
        const paidDate = purchase.payment_date || purchase.purchase_date;
        pushEvent({
          supplier_id: purchase.supplier_id,
          supplier_name: purchase.supplier_name,
          transaction_date: toDateKey(paidDate),
          sort_date: toDateKey(paidDate),
          sort_key: `P-${String(purchase.id).padStart(8, "0")}-1`,
          transaction_type: "Payment",
          purchase_id: purchase.id,
          purchase_amount: 0,
          payment_amount: paidAmount,
          rebate_amount: 0,
          balance_delta: -paidAmount,
          remarks: `Paid during purchase #${purchase.id}`,
        });
      }
    }

    for (const payment of paymentResult.rows) {
      const paymentAmount = Number(payment.payment_amount || 0);
      const rebateAmount = Number(payment.rebate_amount || 0);
      if (paymentAmount > 0) {
        pushEvent({
          supplier_id: payment.supplier_id,
          supplier_name: payment.supplier_name,
          transaction_date: toDateKey(payment.payment_date),
          sort_date: toDateKey(payment.payment_date),
          sort_key: `SP-${String(payment.id).padStart(8, "0")}-0`,
          transaction_type: "Payment",
          supplier_payment_id: payment.id,
          purchase_amount: 0,
          payment_amount: paymentAmount,
          rebate_amount: 0,
          balance_delta: -paymentAmount,
          remarks: payment.remarks || payment.reference_number || "Supplier payment",
        });
      }
      if (rebateAmount > 0) {
        pushEvent({
          supplier_id: payment.supplier_id,
          supplier_name: payment.supplier_name,
          transaction_date: toDateKey(payment.payment_date),
          sort_date: toDateKey(payment.payment_date),
          sort_key: `SP-${String(payment.id).padStart(8, "0")}-1`,
          transaction_type: "Rebate",
          supplier_payment_id: payment.id,
          purchase_amount: 0,
          payment_amount: 0,
          rebate_amount: rebateAmount,
          balance_delta: -rebateAmount,
          remarks: payment.remarks || payment.reference_number || "Rebate received",
        });
      }
    }

    const ledger = [];
    for (const supplier of suppliers) {
      let runningBalance = 0;
      const rows = (ledgersBySupplier.get(supplier.id) || []).sort((left, right) =>
        left.sort_date.localeCompare(right.sort_date) || left.sort_key.localeCompare(right.sort_key)
      );
      for (const row of rows) {
        runningBalance = roundCurrency(runningBalance + Number(row.balance_delta || 0));
        ledger.push({
          ...row,
          running_balance: runningBalance,
        });
      }
    }

    return res.json({ suppliers, ledger });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Supplier Ledger" });
  }
});

const readPurchaseEntryPayload = (body) => {
  const purchaseType = String(body.purchase_type || "CREDIT").trim().toUpperCase();
  const purchaseBillStatus = String(body.purchase_bill_status || "BILL_COMPLETED").trim().toUpperCase();
  return {
    supplierId: parsePositiveInteger(body.supplier_id),
    productId: parsePositiveInteger(body.product_id),
    quantity: parsePositiveNumber(body.quantity),
    purchaseRate: parsePositiveNumber(body.purchase_rate),
    expectedPurchaseRate: parseNonNegativeNumber(body.expected_purchase_rate),
    temporarySaleRate: parsePositiveNumber(body.temporary_sale_rate),
    freightCharges: parseNonNegativeNumber(body.freight_charges),
    labourCharges: parseNonNegativeNumber(body.labour_charges),
    otherCharges: parseNonNegativeNumber(body.other_charges),
    paidAmountInput: parseNonNegativeNumber(body.paid_amount),
    rebateRuleId: parsePositiveInteger(body.rebate_rule_id),
    paymentDate: isDateInput(body.payment_date) ? body.payment_date : null,
    purchaseType,
    purchaseBillStatus,
    paymentMode: normalizePaymentMode(body.payment_mode),
    paymentReferenceNumber: nullableText(body.payment_reference_number),
    purchaseDate: isDateInput(body.purchase_date || body.arrival_date) ? (body.purchase_date || body.arrival_date) : toDateKey(new Date()),
    billNumber: nullableText(body.bill_number),
    billDate: isDateInput(body.bill_date) ? body.bill_date : null,
    lotName: nullableText(body.lot_name || body.lot_number),
    lotSize: nullableText(body.lot_size || body.size_grade || body.size),
    unit: nullableText(body.unit),
    originType: nullableText(body.origin_type) ? String(body.origin_type).trim().toUpperCase() : null,
    branchId: parsePositiveInteger(body.branch_id),
    actorId: parsePositiveInteger(body.created_by || body.edited_by) || 1,
    remarks: nullableText(body.remarks),
  };
};

const validatePurchaseEntry = (entry) => {
  if (!entry.supplierId) return "Please select supplier";
  if (!PURCHASE_BILL_STATUSES.has(entry.purchaseBillStatus)) return "Select a valid purchase bill status";
  if (entry.purchaseBillStatus === "BILL_PENDING") {
    if (!entry.productId) return "Please select product";
    if (!entry.quantity) return "Please enter quantity";
    if (!entry.branchId) return "Please select branch";
    if (!entry.temporarySaleRate) return "Please enter temporary sale rate";
    if (entry.expectedPurchaseRate === null) return "Please enter expected purchase rate";
    return "";
  }
  if (!entry.productId) return "Please select product";
  if (!entry.quantity) return "Please enter quantity";
  if (!entry.purchaseRate) return "Please enter purchase rate";
  if (entry.freightCharges === null) return "Please enter freight charges";
  if (entry.labourCharges === null) return "Please enter labour charges";
  if (entry.otherCharges === null) return "Please enter other charges";
  if (entry.paidAmountInput === null) return "Please enter paid amount";
  if (!entry.rebateRuleId) return "Please select rebate rule";
  if (!entry.branchId) return "Please select branch";
  if (!["CASH", "CREDIT"].includes(entry.purchaseType)) return "Please select Cash or Credit purchase";
  if (entry.purchaseType === "CASH" && (!SUPPLIER_PAYMENT_MODES.has(entry.paymentMode) || entry.paidAmountInput <= 0)) {
    return "Cash purchase requires payment mode and paid amount";
  }
  return "";
};

const buildPurchaseFinancials = async (client, entry) => {
  const supplierResult = await client.query(
    "SELECT id, supplier_name FROM suppliers WHERE id = $1 AND active = TRUE FOR SHARE",
    [entry.supplierId]
  );
  if (supplierResult.rows.length === 0) return { error: "Add New Supplier" };

  const productResult = await client.query(
    "SELECT id, product_name, origin_type, unit FROM products WHERE id = $1 AND active = TRUE FOR SHARE",
    [entry.productId]
  );
  if (productResult.rows.length === 0) return { error: "Product not found", status: 404 };

  const supplier = supplierResult.rows[0];
  const product = productResult.rows[0];
  const originType = entry.originType || product.origin_type || "LOCAL";
  const unit = entry.unit || product.unit || "";
  const [mandiResult, rebateResult] = await Promise.all([
    client.query("SELECT * FROM mandi_tax_rules WHERE origin_type = $1 AND active = TRUE", [originType]),
    client.query("SELECT * FROM rebate_rules WHERE id = $1 AND active = TRUE", [entry.rebateRuleId]),
  ]);
  if (mandiResult.rows.length === 0 || rebateResult.rows.length === 0) {
    return { error: "Select active mandi tax and rebate rules" };
  }

  const mandiTaxPercent = Number(mandiResult.rows[0].tax_percent);
  const rebateRule = rebateResult.rows[0];
  const rebatePercent = Number(rebateRule.rebate_percent);
  const basicAmount = roundCurrency(entry.quantity * entry.purchaseRate);
  const mandiTaxAmount = roundCurrency(basicAmount * mandiTaxPercent / 100);
  const grossAmount = roundCurrency(basicAmount + mandiTaxAmount + entry.freightCharges + entry.labourCharges + entry.otherCharges);
  const rebateAmount = roundCurrency(grossAmount * rebatePercent / 100);
  const netPayable = roundCurrency(grossAmount - rebateAmount);
  const paidAmount = entry.purchaseType === "CREDIT" ? 0 : entry.paidAmountInput;
  if (paidAmount > netPayable) return { error: "Paid amount cannot exceed net payable amount" };
  const balanceAmount = roundCurrency(netPayable - paidAmount);
  const effectiveCostPerUnit = roundUnitCost(netPayable / entry.quantity);
  const paymentStatus = balanceAmount === 0 ? "PAID" : paidAmount > 0 ? "PARTIAL" : "PENDING";

  return {
    supplier,
    product,
    originType,
    unit,
    rebateRule,
    financials: {
      mandiTaxPercent,
      rebatePercent,
      basicAmount,
      mandiTaxAmount,
      grossAmount,
      rebateAmount,
      netPayable,
      paidAmount,
      balanceAmount,
      effectiveCostPerUnit,
      paymentStatus,
    },
  };
};

const getCategoryById = async (client, categoryId) => {
  if (!categoryId) return null;
  const result = await client.query("SELECT * FROM product_categories WHERE id = $1 AND active = TRUE", [categoryId]);
  return result.rows[0] || null;
};

const findCategoryByName = async (client, categoryName) => {
  const name = cleanText(categoryName);
  if (!name) return null;
  const result = await client.query("SELECT * FROM product_categories WHERE LOWER(category_name) = LOWER($1)", [name]);
  return result.rows[0] || null;
};

const insertOpeningStockLot = async (client, { product, lot, actorId, branchId }) => {
  const quantity = parsePositiveNumber(lot.quantity);
  const purchaseRate = parsePositiveNumber(lot.purchase_rate || lot.opening_cost);
  const saleRate = parsePositiveNumber(lot.sale_rate) || Number(product.selling_rate || 0);
  const lotSize = nullableText(lot.lot_size || lot.size_grade || lot.size);
  let lotName = cleanText(lot.lot_name || lot.lot_number);
  if (!lotName) {
    const countResult = await client.query(
      "SELECT COUNT(*)::INTEGER AS lot_count FROM inventory_batches WHERE product_id = $1 AND stock_source = 'OPENING_STOCK'",
      [product.id]
    );
    lotName = `Opening Lot ${Number(countResult.rows[0]?.lot_count || 0) + 1}`;
  }
  const openingDate = isDateInput(lot.opening_stock_date || lot.purchase_date) ? (lot.opening_stock_date || lot.purchase_date) : toDateKey(new Date());
  const supplierId = parsePositiveInteger(lot.supplier_id);
  const supplierName = nullableText(lot.supplier_name);
  const remarks = nullableText(lot.remarks) || "Opening stock";
  const allowDuplicateLot = lot.allow_duplicate_lot === true || lot.allow_duplicate_lot === "true";
  if (!quantity) return { error: "Please enter lot quantity." };
  if (!purchaseRate) return { error: "Please enter opening stock rate." };
  if (!saleRate || saleRate <= 0) return { error: "Please enter sale rate." };

  const duplicateResult = await client.query(
    `
    SELECT id
    FROM inventory_batches
    WHERE product_id = $1
      AND LOWER(COALESCE(lot_name, '')) = LOWER($2)
      AND COALESCE(purchase_date, created_at::date) = $3
      AND COALESCE(supplier_id, 0) = COALESCE($4, 0)
      AND LOWER(COALESCE(lot_size, '')) = LOWER(COALESCE($5, ''))
      AND COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED'
    LIMIT 1
    `,
    [product.id, lotName, openingDate, supplierId, lotSize]
  );
  if (duplicateResult.rows.length > 0 && !allowDuplicateLot) {
    return { error: "This lot already exists. Add as separate lot anyway?" };
  }

  const batchNo = `OPEN-${Date.now()}-${product.id}-${Math.floor(Math.random() * 10000)}`;
  const netPayable = roundCurrency(quantity * purchaseRate);
  const batchResult = await client.query(
    `
    INSERT INTO inventory_batches (
      product_id, batch_no, purchase_qty, remaining_qty, purchase_rate, effective_cost_per_unit,
      supplier_id, supplier_name, branch_id, gross_amount, net_payable, balance_amount,
      batch_status, purchase_bill_status, temporary_sale_rate, lot_name, lot_size,
      stock_source, remarks, purchase_date
    )
    VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7, $8, $8, 0, 'ACTIVE', 'BILL_COMPLETED', $9, $10, $11, 'OPENING_STOCK', $12, $13)
    RETURNING *
    `,
    [
      product.id, batchNo, quantity, purchaseRate, supplierId, supplierName,
      branchId || 1, netPayable, saleRate, lotName, lotSize, remarks, openingDate,
    ]
  );
  await client.query(
    `
    INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
    VALUES ($1, $2, 'IN', $3, $4, $5)
    `,
    [product.id, quantity, `Opening stock ${lotName}`, actorId || null, branchId || 1]
  );
  if (saleRate > 0 && Number(product.selling_rate || 0) !== saleRate) {
    await client.query(
      "UPDATE products SET selling_rate = $1, selling_rate_updated_at = CURRENT_TIMESTAMP, selling_rate_updated_by = $2 WHERE id = $3",
      [saleRate, actorId || null, product.id]
    );
    await client.query(
      "INSERT INTO sale_rate_history (product_id, old_selling_rate, new_selling_rate, changed_by, reason) VALUES ($1, $2, $3, $4, $5)",
      [product.id, product.selling_rate || 0, saleRate, actorId || 1, `Opening stock sale rate for ${lotName}`]
    );
  }
  await client.query(
    `
    INSERT INTO product_audit_trail (product_id, action, old_value, new_value, reason, edited_by)
    VALUES ($1, 'OPENING_STOCK_LOT_ADDED', NULL, $2::jsonb, $3, $4)
    `,
    [
      product.id,
      JSON.stringify({
        ...batchResult.rows[0],
        product_name: product.product_name,
        supplier_name: supplierName,
        lot_name: lotName,
        lot_size: lotSize,
        quantity,
        cost_rate: purchaseRate,
        sale_rate: saleRate,
        opening_stock_date: openingDate,
      }),
      remarks,
      actorId || null,
    ]
  );
  return { batch: batchResult.rows[0] };
};

const getPurchasePartiesForArrival = async (client, entry) => {
  const [supplierResult, productResult] = await Promise.all([
    client.query("SELECT id, supplier_name FROM suppliers WHERE id = $1 AND active = TRUE FOR SHARE", [entry.supplierId]),
    client.query("SELECT id, product_name, origin_type, unit, selling_rate FROM products WHERE id = $1 AND active = TRUE FOR SHARE", [entry.productId]),
  ]);
  if (supplierResult.rows.length === 0) return { error: "Add New Supplier" };
  if (productResult.rows.length === 0) return { error: "Product not found", status: 404 };
  return { supplier: supplierResult.rows[0], product: productResult.rows[0] };
};

const recalculateSalesForBatch = async (client, batchId) => {
  const saleRows = await client.query(
    `
    SELECT DISTINCT si.sale_id
    FROM sale_batch_allocations sba
    JOIN sale_items si ON si.id = sba.sale_item_id
    WHERE sba.inventory_batch_id = $1
    `,
    [batchId]
  );
  for (const row of saleRows.rows) {
    const saleId = row.sale_id;
    await client.query(
      `
      WITH item_costs AS (
        SELECT
          si.id,
          COALESCE(SUM(sba.cost_amount), 0) AS cost_amount,
          BOOL_OR(COALESCE(ib.purchase_bill_status, 'BILL_COMPLETED') = 'BILL_PENDING') AS provisional
        FROM sale_items si
        LEFT JOIN sale_batch_allocations sba ON sba.sale_item_id = si.id
        LEFT JOIN inventory_batches ib ON ib.id = sba.inventory_batch_id
        WHERE si.sale_id = $1
        GROUP BY si.id
      ),
      sale_subtotal AS (
        SELECT sale_id, SUM(COALESCE(net_amount, amount)) AS subtotal
        FROM sale_items
        WHERE sale_id = $1
        GROUP BY sale_id
      )
      UPDATE sale_items si
      SET
        cost_amount = item_costs.cost_amount,
        cost_status = CASE WHEN item_costs.provisional THEN 'PROVISIONAL' ELSE 'FINAL' END,
        profit = ROUND((
          COALESCE(si.net_amount, si.amount)
          - CASE
              WHEN sale_subtotal.subtotal > 0
              THEN COALESCE(s.invoice_discount_amount, 0) * (COALESCE(si.net_amount, si.amount) / sale_subtotal.subtotal)
              ELSE 0
            END
          - item_costs.cost_amount
        )::NUMERIC, 2)
      FROM item_costs, sales s, sale_subtotal
      WHERE si.id = item_costs.id
        AND s.id = si.sale_id
        AND sale_subtotal.sale_id = si.sale_id
        AND si.sale_id = $1
      `,
      [saleId]
    );
    await client.query(
      `
      UPDATE sales s
      SET
        total_cost = COALESCE(costs.total_cost, 0),
        profit = ROUND((s.total_amount - COALESCE(costs.total_cost, 0))::NUMERIC, 2),
        profit_status = CASE WHEN COALESCE(costs.has_provisional, FALSE) THEN 'PROVISIONAL' ELSE 'FINAL' END
      FROM (
        SELECT
          sale_id,
          SUM(cost_amount) AS total_cost,
          BOOL_OR(cost_status = 'PROVISIONAL') AS has_provisional
        FROM sale_items
        WHERE sale_id = $1
        GROUP BY sale_id
      ) costs
      WHERE s.id = costs.sale_id
      `,
      [saleId]
    );
  }
};

app.get("/purchases", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        p.*,
        pi.product_id,
        pi.quantity,
        pi.purchase_rate,
        pi.lot_name AS item_lot_name,
        pi.lot_size AS item_lot_size,
        pr.product_name,
        pr.category,
        pr.category_id,
        pr.unit,
        ib.id AS inventory_batch_id,
        ib.batch_no,
        ib.lot_name,
        ib.lot_size,
        ib.stock_source,
        ib.purchase_qty AS batch_purchase_qty,
        ib.remaining_qty AS batch_remaining_qty,
        ib.batch_status
      FROM purchases p
      LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
      LEFT JOIN products pr ON pr.id = pi.product_id
      LEFT JOIN inventory_batches ib ON ib.purchase_id = p.id
      ORDER BY p.purchase_date DESC, p.created_at DESC, p.id DESC
      LIMIT 250
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Purchases" });
  }
});

app.post("/purchase", async (req, res) => {
  const client = await pool.connect();

  try {
    const entry = readPurchaseEntryPayload(req.body);
    const validationMessage = validatePurchaseEntry(entry);
    if (validationMessage) return res.status(400).json({ message: validationMessage });

    await client.query("BEGIN");
    if (entry.purchaseBillStatus === "BILL_PENDING") {
      const manager = await requireRateManager(entry.actorId, client);
      if (!manager) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Only Owner or Admin can set temporary sale rates for pending stock" });
      }
      const arrival = await getPurchasePartiesForArrival(client, entry);
      if (arrival.error) {
        await client.query("ROLLBACK");
        return res.status(arrival.status || 400).json({ message: arrival.error });
      }
      const provisionalCost = Number(entry.expectedPurchaseRate || 0);
      const provisionalAmount = roundCurrency(entry.quantity * provisionalCost);
      const itemUnit = entry.unit || arrival.product.unit || "";
      const itemOriginType = entry.originType || arrival.product.origin_type || "LOCAL";
      const purchaseResult = await client.query(
        `
        INSERT INTO purchases (
          supplier_id, supplier_name, total_amount, branch_id, created_by,
          basic_amount, gross_amount, net_payable, paid_amount, balance_amount,
          effective_cost_per_unit, purchase_type, payment_status, purchase_date,
          remarks, purchase_bill_status, temporary_sale_rate, expected_purchase_rate
        )
        VALUES ($1, $2, 0, $3, $4, 0, 0, 0, 0, 0, $5, 'PENDING_BILL', 'BILL_PENDING', $6, $7, 'BILL_PENDING', $8, $9)
        RETURNING *
        `,
        [
          arrival.supplier.id, arrival.supplier.supplier_name, entry.branchId, entry.actorId,
          provisionalCost, entry.purchaseDate, entry.remarks, entry.temporarySaleRate, provisionalCost,
        ]
      );
      const purchase = purchaseResult.rows[0];
      await client.query(
        `
        INSERT INTO purchase_items (
          purchase_id, product_id, quantity, purchase_rate, amount, basic_amount,
          net_payable, effective_cost_per_unit, lot_name, lot_size, unit, origin_type
        )
        VALUES ($1, $2, $3, $4, $5, 0, 0, $4, $6, $7, $8, $9)
        `,
        [purchase.id, entry.productId, entry.quantity, provisionalCost, provisionalAmount, entry.lotName, entry.lotSize, itemUnit, itemOriginType]
      );
      const batchNo = `PENDING-${Date.now()}-${purchase.id}`;
      await client.query(
        `
        INSERT INTO inventory_batches (
          product_id, batch_no, purchase_qty, remaining_qty, purchase_rate, effective_cost_per_unit,
          supplier_id, supplier_name, branch_id, gross_amount, net_payable, balance_amount,
          purchase_id, batch_status, purchase_bill_status, temporary_sale_rate, lot_name, lot_size,
          unit, origin_type
        )
        VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7, 0, 0, 0, $8, 'ACTIVE', 'BILL_PENDING', $9, $10, $11, $12, $13)
        `,
        [
          entry.productId, batchNo, entry.quantity, provisionalCost, arrival.supplier.id,
          arrival.supplier.supplier_name, entry.branchId, purchase.id, entry.temporarySaleRate,
          entry.lotName, entry.lotSize, itemUnit, itemOriginType,
        ]
      );
      await client.query(
        "UPDATE products SET selling_rate = $1, selling_rate_updated_at = CURRENT_TIMESTAMP, selling_rate_updated_by = $2 WHERE id = $3",
        [entry.temporarySaleRate, manager.id, entry.productId]
      );
      await client.query(
        "INSERT INTO sale_rate_history (product_id, old_selling_rate, new_selling_rate, changed_by, reason) VALUES ($1, $2, $3, $4, $5)",
        [entry.productId, arrival.product.selling_rate || 0, entry.temporarySaleRate, manager.id, `Temporary sale rate for pending purchase #${purchase.id}`]
      );
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'IN', $3, $4, $5)",
        [entry.productId, entry.quantity, `Stock arrival pending bill #${purchase.id}`, entry.actorId, entry.branchId]
      );
      await client.query("COMMIT");
      return res.status(201).json({
        success: true,
        message: "Stock Arrival Saved - Bill Pending",
        purchase_id: purchase.id,
        purchase: { ...purchase, product_name: arrival.product.product_name },
      });
    }

    const calculation = await buildPurchaseFinancials(client, entry);
    if (calculation.error) {
      await client.query("ROLLBACK");
      return res.status(calculation.status || 400).json({ message: calculation.error });
    }
    const { supplier, product, originType, unit, rebateRule, financials } = calculation;
    const itemUnit = entry.unit || unit || product.unit || "";
    const itemOriginType = entry.originType || originType || product.origin_type || "LOCAL";

    const purchaseResult = await client.query(
      `
      INSERT INTO purchases (
        supplier_id, supplier_name, total_amount, branch_id, created_by, basic_amount,
        mandi_tax_percent, mandi_tax_amount, other_charges, gross_amount,
        rebate_percent, rebate_amount, net_payable, paid_amount, balance_amount,
        payment_timing, effective_cost_per_unit, freight_charges, labour_charges,
        rebate_rule_id, payment_due_days, payment_status, payment_date,
        purchase_type, payment_mode, payment_reference_number, remarks, purchase_bill_status, bill_number, bill_date
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, 'BILL_COMPLETED', $28, $29)
      RETURNING *
      `,
      [
        supplier.id, supplier.supplier_name, financials.netPayable, entry.branchId, entry.actorId, financials.basicAmount,
        financials.mandiTaxPercent, financials.mandiTaxAmount, entry.otherCharges, financials.grossAmount,
        financials.rebatePercent, financials.rebateAmount, financials.netPayable, financials.paidAmount, financials.balanceAmount,
        rebateRule.rule_name, financials.effectiveCostPerUnit, entry.freightCharges, entry.labourCharges,
        rebateRule.id, rebateRule.pay_within_days, financials.paymentStatus, entry.purchaseType === "CREDIT" ? null : entry.paymentDate,
        entry.purchaseType, entry.purchaseType === "CASH" ? entry.paymentMode : null, entry.purchaseType === "CASH" ? entry.paymentReferenceNumber : null,
        entry.remarks,
        entry.billNumber,
        entry.billDate,
      ]
    );
    const purchase = purchaseResult.rows[0];

    await client.query(
      `
      INSERT INTO purchase_items (
        purchase_id, product_id, quantity, purchase_rate, amount, basic_amount,
        mandi_tax_amount, other_charges, rebate_amount, net_payable, effective_cost_per_unit,
        freight_charges, labour_charges, lot_name, lot_size, unit, origin_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
      `,
      [
        purchase.id, entry.productId, entry.quantity, entry.purchaseRate, financials.netPayable, financials.basicAmount,
        financials.mandiTaxAmount, entry.otherCharges, financials.rebateAmount, financials.netPayable, financials.effectiveCostPerUnit,
        entry.freightCharges, entry.labourCharges, entry.lotName, entry.lotSize, itemUnit, itemOriginType,
      ]
    );

    const batchNo = `BATCH-${Date.now()}-${purchase.id}`;
    await client.query(
      `
      INSERT INTO inventory_batches (
        product_id, batch_no, purchase_qty, remaining_qty, purchase_rate, effective_cost_per_unit,
        supplier_id, supplier_name, branch_id, mandi_tax_amount, freight_charges, labour_charges,
        other_charges, gross_amount, rebate_amount, net_payable, payment_timing, balance_amount,
        purchase_id, batch_status, purchase_bill_status, lot_name, lot_size, unit, origin_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'ACTIVE', 'BILL_COMPLETED', $20, $21, $22, $23)
      `,
      [
        entry.productId,
        batchNo,
        entry.quantity,
        entry.quantity,
        entry.purchaseRate,
        financials.effectiveCostPerUnit,
        supplier.id,
        supplier.supplier_name,
        entry.branchId,
        financials.mandiTaxAmount,
        entry.freightCharges,
        entry.labourCharges,
        entry.otherCharges,
        financials.grossAmount,
        financials.rebateAmount,
        financials.netPayable,
        rebateRule.rule_name,
        financials.balanceAmount,
        purchase.id,
        entry.lotName,
        entry.lotSize,
        itemUnit,
        itemOriginType,
      ]
    );

    await client.query(
      `
      INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
      VALUES ($1, $2, 'IN', $3, $4, $5)
      `,
      [entry.productId, entry.quantity, `Purchase #${purchase.id}`, entry.actorId, entry.branchId]
    );

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "Purchase Saved",
      purchase_id: purchase.id,
      purchase: {
        ...purchase,
        supplier_name: supplier.supplier_name,
        product_name: product.product_name,
        origin_type: originType,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Purchase Error" });
  } finally {
    client.release();
  }
});

app.post("/purchase-bill", async (req, res) => {
  const client = await pool.connect();

  try {
    const baseEntry = readPurchaseEntryPayload(req.body);
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    if (!baseEntry.supplierId) return res.status(400).json({ message: "Add New Supplier" });
    if (!baseEntry.branchId) return res.status(400).json({ message: "Select branch before saving purchase" });
    if (!PURCHASE_BILL_STATUSES.has(baseEntry.purchaseBillStatus)) {
      return res.status(400).json({ message: "Select a valid purchase bill status" });
    }
    if (rawItems.length === 0) return res.status(400).json({ message: "Add at least one purchase item" });
    if (baseEntry.purchaseBillStatus === "BILL_COMPLETED" && !["CASH", "CREDIT"].includes(baseEntry.purchaseType)) {
      return res.status(400).json({ message: "Select Cash or Credit purchase" });
    }
    if (baseEntry.purchaseBillStatus === "BILL_COMPLETED" && !baseEntry.rebateRuleId) {
      return res.status(400).json({ message: "Select active mandi tax and rebate rules" });
    }
    if (
      baseEntry.purchaseType === "CASH" &&
      baseEntry.purchaseBillStatus === "BILL_COMPLETED" &&
      (!SUPPLIER_PAYMENT_MODES.has(baseEntry.paymentMode) || !baseEntry.paidAmountInput)
    ) {
      return res.status(400).json({ message: "Cash purchase requires payment mode and paid amount" });
    }

    const entries = rawItems.map((item) => readPurchaseEntryPayload({
      ...req.body,
      product_id: item.product_id,
      quantity: item.quantity,
      purchase_rate: item.purchase_rate,
      expected_purchase_rate: item.expected_purchase_rate,
      temporary_sale_rate: item.temporary_sale_rate,
      unit: item.unit,
      origin_type: item.origin_type,
      lot_name: item.lot_name,
      lot_size: item.lot_size,
      remarks: cleanText(item.remarks) || baseEntry.remarks,
      paid_amount: 0,
      purchase_type: baseEntry.purchaseBillStatus === "BILL_COMPLETED" ? "CREDIT" : "PENDING_BILL",
    }));

    const validationMessages = entries.map(validatePurchaseEntry).filter(Boolean);
    if (validationMessages.length) return res.status(400).json({ message: validationMessages[0] });

    await client.query("BEGIN");
    if (baseEntry.purchaseBillStatus === "BILL_PENDING") {
      const manager = await requireRateManager(baseEntry.actorId, client);
      if (!manager) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Only Owner or Admin can set temporary sale rates for pending stock" });
      }

      const createdPurchases = [];
      for (const entry of entries) {
        const arrival = await getPurchasePartiesForArrival(client, entry);
        if (arrival.error) {
          await client.query("ROLLBACK");
          return res.status(arrival.status || 400).json({ message: arrival.error });
        }
        const provisionalCost = Number(entry.expectedPurchaseRate || 0);
        const provisionalAmount = roundCurrency(entry.quantity * provisionalCost);
        const itemUnit = entry.unit || arrival.product.unit || "";
        const itemOriginType = entry.originType || arrival.product.origin_type || "LOCAL";
        const purchaseResult = await client.query(
          `
          INSERT INTO purchases (
            supplier_id, supplier_name, total_amount, branch_id, created_by,
            basic_amount, gross_amount, net_payable, paid_amount, balance_amount,
            effective_cost_per_unit, purchase_type, payment_status, purchase_date,
            remarks, purchase_bill_status, temporary_sale_rate, expected_purchase_rate,
            bill_number, bill_date, lot_name, lot_size, stock_source
          )
          VALUES ($1, $2, 0, $3, $4, 0, 0, 0, 0, 0, $5, 'PENDING_BILL', 'BILL_PENDING', $6, $7, 'BILL_PENDING', $8, $9, $10, $11, $12, $13, 'PURCHASE')
          RETURNING *
          `,
          [
            arrival.supplier.id, arrival.supplier.supplier_name, entry.branchId, entry.actorId,
            provisionalCost, entry.purchaseDate, entry.remarks, entry.temporarySaleRate, provisionalCost,
            entry.billNumber, entry.billDate, entry.lotName, entry.lotSize,
          ]
        );
        const purchase = purchaseResult.rows[0];
        await client.query(
          `
          INSERT INTO purchase_items (
            purchase_id, product_id, quantity, purchase_rate, amount, basic_amount,
            net_payable, effective_cost_per_unit, lot_name, lot_size, unit, origin_type
          )
          VALUES ($1, $2, $3, $4, $5, 0, 0, $4, $6, $7, $8, $9)
          `,
          [purchase.id, entry.productId, entry.quantity, provisionalCost, provisionalAmount, entry.lotName, entry.lotSize, itemUnit, itemOriginType]
        );
        const batchNo = `PENDING-${Date.now()}-${purchase.id}`;
        await client.query(
          `
          INSERT INTO inventory_batches (
            product_id, batch_no, purchase_qty, remaining_qty, purchase_rate, effective_cost_per_unit,
            supplier_id, supplier_name, branch_id, gross_amount, net_payable, balance_amount,
            purchase_id, batch_status, purchase_bill_status, temporary_sale_rate, lot_name, lot_size,
            stock_source, remarks, purchase_date, unit, origin_type
          )
          VALUES ($1, $2, $3, $3, $4, $4, $5, $6, $7, 0, 0, 0, $8, 'ACTIVE', 'BILL_PENDING', $9, $10, $11, 'PURCHASE', $12, $13, $14, $15)
          `,
          [
            entry.productId, batchNo, entry.quantity, provisionalCost, arrival.supplier.id,
            arrival.supplier.supplier_name, entry.branchId, purchase.id, entry.temporarySaleRate,
            entry.lotName, entry.lotSize, entry.remarks, entry.purchaseDate, itemUnit, itemOriginType,
          ]
        );
        await client.query(
          "UPDATE products SET selling_rate = $1, selling_rate_updated_at = CURRENT_TIMESTAMP, selling_rate_updated_by = $2 WHERE id = $3",
          [entry.temporarySaleRate, manager.id, entry.productId]
        );
        await client.query(
          "INSERT INTO sale_rate_history (product_id, old_selling_rate, new_selling_rate, changed_by, reason) VALUES ($1, $2, $3, $4, $5)",
          [entry.productId, arrival.product.selling_rate || 0, entry.temporarySaleRate, manager.id, `Temporary sale rate for pending purchase #${purchase.id}`]
        );
        await client.query(
          "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'IN', $3, $4, $5)",
          [entry.productId, entry.quantity, `Stock arrival pending bill #${purchase.id}`, entry.actorId, entry.branchId]
        );
        await client.query(
          "INSERT INTO purchase_audit_trail (purchase_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'ADDED_ITEM', NULL, $2::jsonb, $3, $4)",
          [purchase.id, JSON.stringify({ purchase, product_name: arrival.product.product_name }), "Purchase cart item added", manager.id]
        );
        createdPurchases.push({ ...purchase, product_name: arrival.product.product_name });
      }
      await client.query("COMMIT");
      return res.status(201).json({
        success: true,
        message: "Stock Arrival Saved - Bill Pending",
        purchase_ids: createdPurchases.map((purchase) => purchase.id),
        purchases: createdPurchases,
      });
    }

    const completedEntries = [];
    const itemBasicTotal = entries.reduce((sum, entry) => sum + Number(entry.quantity || 0) * Number(entry.purchaseRate || 0), 0);
    if (itemBasicTotal <= 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Completed purchase items require valid purchase rates" });
    }
    let usedFreight = 0;
    let usedLabour = 0;
    let usedOther = 0;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const itemBasic = Number(entry.quantity || 0) * Number(entry.purchaseRate || 0);
      const isLast = index === entries.length - 1;
      const freight = isLast ? roundCurrency(baseEntry.freightCharges - usedFreight) : roundCurrency(baseEntry.freightCharges * itemBasic / itemBasicTotal);
      const labour = isLast ? roundCurrency(baseEntry.labourCharges - usedLabour) : roundCurrency(baseEntry.labourCharges * itemBasic / itemBasicTotal);
      const other = isLast ? roundCurrency(baseEntry.otherCharges - usedOther) : roundCurrency(baseEntry.otherCharges * itemBasic / itemBasicTotal);
      usedFreight = roundCurrency(usedFreight + freight);
      usedLabour = roundCurrency(usedLabour + labour);
      usedOther = roundCurrency(usedOther + other);
      const itemEntry = { ...entry, freightCharges: freight, labourCharges: labour, otherCharges: other, purchaseType: "CREDIT", paidAmountInput: 0 };
      const calculation = await buildPurchaseFinancials(client, itemEntry);
      if (calculation.error) {
        await client.query("ROLLBACK");
        return res.status(calculation.status || 400).json({ message: calculation.error });
      }
      completedEntries.push({ entry: itemEntry, ...calculation });
    }

    const netTotal = roundCurrency(completedEntries.reduce((sum, item) => sum + Number(item.financials.netPayable || 0), 0));
    if (baseEntry.purchaseType === "CASH" && baseEntry.paidAmountInput > netTotal) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Paid amount cannot exceed net payable amount" });
    }
    let usedPaid = 0;
    const createdPurchases = [];
    for (let index = 0; index < completedEntries.length; index += 1) {
      const item = completedEntries[index];
      const { entry, supplier, product, originType, unit, rebateRule } = item;
      const itemUnit = entry.unit || unit || product.unit || "";
      const itemOriginType = entry.originType || originType || product.origin_type || "LOCAL";
      const isLast = index === completedEntries.length - 1;
      const paidAmount = baseEntry.purchaseType === "CASH"
        ? isLast
          ? roundCurrency(baseEntry.paidAmountInput - usedPaid)
          : roundCurrency(baseEntry.paidAmountInput * Number(item.financials.netPayable || 0) / netTotal)
        : 0;
      usedPaid = roundCurrency(usedPaid + paidAmount);
      const balanceAmount = roundCurrency(Number(item.financials.netPayable || 0) - paidAmount);
      const financials = {
        ...item.financials,
        paidAmount,
        balanceAmount,
        paymentStatus: balanceAmount === 0 ? "PAID" : paidAmount > 0 ? "PARTIAL" : "PENDING",
      };
      const purchaseResult = await client.query(
        `
        INSERT INTO purchases (
          supplier_id, supplier_name, total_amount, branch_id, created_by, basic_amount,
          mandi_tax_percent, mandi_tax_amount, other_charges, gross_amount,
          rebate_percent, rebate_amount, net_payable, paid_amount, balance_amount,
          payment_timing, effective_cost_per_unit, freight_charges, labour_charges,
          rebate_rule_id, payment_due_days, payment_status, payment_date,
          purchase_type, payment_mode, payment_reference_number, remarks, purchase_bill_status, bill_number, bill_date,
          lot_name, lot_size, stock_source
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, 'BILL_COMPLETED', $28, $29, $30, $31, 'PURCHASE')
        RETURNING *
        `,
        [
          supplier.id, supplier.supplier_name, financials.netPayable, entry.branchId, entry.actorId, financials.basicAmount,
          financials.mandiTaxPercent, financials.mandiTaxAmount, entry.otherCharges, financials.grossAmount,
          financials.rebatePercent, financials.rebateAmount, financials.netPayable, financials.paidAmount, financials.balanceAmount,
          rebateRule.rule_name, financials.effectiveCostPerUnit, entry.freightCharges, entry.labourCharges,
          rebateRule.id, rebateRule.pay_within_days, financials.paymentStatus, baseEntry.purchaseType === "CREDIT" ? null : baseEntry.paymentDate,
          baseEntry.purchaseType, baseEntry.purchaseType === "CASH" ? baseEntry.paymentMode : null, baseEntry.purchaseType === "CASH" ? baseEntry.paymentReferenceNumber : null,
          entry.remarks, entry.billNumber, entry.billDate, entry.lotName, entry.lotSize,
        ]
      );
      const purchase = purchaseResult.rows[0];
      await client.query(
        `
        INSERT INTO purchase_items (
          purchase_id, product_id, quantity, purchase_rate, amount, basic_amount,
          mandi_tax_amount, other_charges, rebate_amount, net_payable, effective_cost_per_unit,
          freight_charges, labour_charges, lot_name, lot_size, unit, origin_type
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
        `,
        [
          purchase.id, entry.productId, entry.quantity, entry.purchaseRate, financials.netPayable, financials.basicAmount,
          financials.mandiTaxAmount, entry.otherCharges, financials.rebateAmount, financials.netPayable, financials.effectiveCostPerUnit,
          entry.freightCharges, entry.labourCharges, entry.lotName, entry.lotSize, itemUnit, itemOriginType,
        ]
      );
      const batchNo = `BATCH-${Date.now()}-${purchase.id}`;
      await client.query(
        `
        INSERT INTO inventory_batches (
          product_id, batch_no, purchase_qty, remaining_qty, purchase_rate, effective_cost_per_unit,
          supplier_id, supplier_name, branch_id, mandi_tax_amount, freight_charges, labour_charges,
          other_charges, gross_amount, rebate_amount, net_payable, payment_timing, balance_amount,
          purchase_id, batch_status, purchase_bill_status, lot_name, lot_size, stock_source, remarks, purchase_date, unit, origin_type
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'ACTIVE', 'BILL_COMPLETED', $20, $21, 'PURCHASE', $22, $23, $24, $25)
        `,
        [
          entry.productId, batchNo, entry.quantity, entry.quantity, entry.purchaseRate, financials.effectiveCostPerUnit,
          supplier.id, supplier.supplier_name, entry.branchId, financials.mandiTaxAmount, entry.freightCharges, entry.labourCharges,
          entry.otherCharges, financials.grossAmount, financials.rebateAmount, financials.netPayable, rebateRule.rule_name,
          financials.balanceAmount, purchase.id, entry.lotName, entry.lotSize, entry.remarks, entry.purchaseDate, itemUnit, itemOriginType,
        ]
      );
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'IN', $3, $4, $5)",
        [entry.productId, entry.quantity, `Purchase #${purchase.id}`, entry.actorId, entry.branchId]
      );
      await client.query(
        "INSERT INTO purchase_audit_trail (purchase_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'ADDED_ITEM', NULL, $2::jsonb, $3, $4)",
        [purchase.id, JSON.stringify({ purchase, product_name: product.product_name, origin_type: originType }), "Purchase cart item added", entry.actorId]
      );
      createdPurchases.push({ ...purchase, product_name: product.product_name, origin_type: originType });
    }

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "Purchase Saved",
      purchase_ids: createdPurchases.map((purchase) => purchase.id),
      purchases: createdPurchases,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Purchase Bill Error" });
  } finally {
    client.release();
  }
});

app.put("/purchase/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const purchaseId = parsePositiveInteger(Number(req.params.id));
    const reason = cleanText(req.body.reason);
    const entry = readPurchaseEntryPayload(req.body);
    const validationMessage = validatePurchaseEntry(entry);
    if (!purchaseId) return res.status(400).json({ message: "Invalid purchase" });
    if (!reason) return res.status(400).json({ message: "Edit reason is required" });
    if (validationMessage) return res.status(400).json({ message: validationMessage });

    await client.query("BEGIN");
    const manager = await requireRateManager(req.body.edited_by || entry.actorId, client);
    if (!manager) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Only Owner or Admin can edit purchases" });
    }

    const oldPurchaseResult = await client.query("SELECT * FROM purchases WHERE id = $1 FOR UPDATE", [purchaseId]);
    const oldPurchase = oldPurchaseResult.rows[0];
    if (!oldPurchase) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Purchase not found" });
    }
    if (oldPurchase.purchase_status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cancelled purchase cannot be edited" });
    }

    const oldItemResult = await client.query("SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY id LIMIT 1 FOR UPDATE", [purchaseId]);
    const oldItem = oldItemResult.rows[0];
    if (!oldItem) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Purchase item not found" });
    }

    const batchResult = await client.query(
      `
      SELECT *
      FROM inventory_batches
      WHERE purchase_id = $1 OR (purchase_id IS NULL AND batch_no LIKE $2)
      ORDER BY purchase_id NULLS LAST, id
      LIMIT 1
      FOR UPDATE
      `,
      [purchaseId, `%-${purchaseId}`]
    );
    const batch = batchResult.rows[0];
    if (!batch) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Linked inventory batch not found" });
    }

    const oldQuantity = Number(batch.purchase_qty || oldItem.quantity || 0);
    const oldRemaining = Number(batch.remaining_qty || 0);
    const soldQuantity = roundUnitCost(oldQuantity - oldRemaining);
    const productChanged = Number(oldItem.product_id) !== Number(entry.productId);
    if (entry.purchaseBillStatus === "BILL_PENDING") {
      if (oldPurchase.purchase_bill_status !== "BILL_PENDING") {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Only pending bill arrivals can be edited as pending entries" });
      }
      const managerForRate = await requireRateManager(entry.actorId, client);
      if (!managerForRate) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "Only Owner or Admin can update temporary sale rates" });
      }
      if (productChanged && soldQuantity > 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "This purchase batch has already been sold. Product cannot be changed safely." });
      }
      if (entry.quantity < soldQuantity) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: `Quantity cannot be less than already sold quantity (${soldQuantity}).` });
      }
      const arrival = await getPurchasePartiesForArrival(client, entry);
      if (arrival.error) {
        await client.query("ROLLBACK");
        return res.status(arrival.status || 400).json({ message: arrival.error });
      }
      const nextRemainingForPending = productChanged ? entry.quantity : roundUnitCost(oldRemaining + (entry.quantity - oldQuantity));
      const provisionalCost = Number(entry.expectedPurchaseRate || 0);
      const oldSnapshot = { purchase: oldPurchase, item: oldItem, batch };
      const purchaseResult = await client.query(
        `
        UPDATE purchases
        SET supplier_id = $1, supplier_name = $2, branch_id = $3, purchase_date = $4,
            remarks = $5, temporary_sale_rate = $6, expected_purchase_rate = $7,
            effective_cost_per_unit = $7, edited_by = $8, edited_at = CURRENT_TIMESTAMP,
            edit_reason = $9, lot_name = $11, lot_size = $12
        WHERE id = $10
        RETURNING *
        `,
        [
          arrival.supplier.id, arrival.supplier.supplier_name, entry.branchId, entry.purchaseDate,
          entry.remarks, entry.temporarySaleRate, provisionalCost, manager.id, reason, purchaseId,
          entry.lotName, entry.lotSize,
        ]
      );
      await client.query(
        `
        UPDATE purchase_items
        SET product_id = $1, quantity = $2, purchase_rate = $3,
            amount = $4, effective_cost_per_unit = $3, lot_name = $6, lot_size = $7
        WHERE id = $5
        `,
        [entry.productId, entry.quantity, provisionalCost, roundCurrency(entry.quantity * provisionalCost), oldItem.id, entry.lotName, entry.lotSize]
      );
      const batchUpdateResult = await client.query(
        `
        UPDATE inventory_batches
        SET product_id = $1, purchase_qty = $2, remaining_qty = $3,
            purchase_rate = $4, effective_cost_per_unit = $4,
            supplier_id = $5, supplier_name = $6, branch_id = $7,
            purchase_bill_status = 'BILL_PENDING', temporary_sale_rate = $8,
            lot_name = $10, lot_size = $11, remarks = $12, purchase_date = $13
        WHERE id = $9
        RETURNING *
        `,
        [
          entry.productId, entry.quantity, nextRemainingForPending, provisionalCost,
          arrival.supplier.id, arrival.supplier.supplier_name, entry.branchId,
          entry.temporarySaleRate, batch.id, entry.lotName, entry.lotSize, entry.remarks, entry.purchaseDate,
        ]
      );
      await client.query(
        "UPDATE products SET selling_rate = $1, selling_rate_updated_at = CURRENT_TIMESTAMP, selling_rate_updated_by = $2 WHERE id = $3",
        [entry.temporarySaleRate, managerForRate.id, entry.productId]
      );
      if (productChanged) {
        await client.query(
          "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'OUT', $3, $4, $5), ($6, $7, 'IN', $8, $4, $5)",
          [oldItem.product_id, oldRemaining, `Pending arrival #${purchaseId} product changed`, manager.id, entry.branchId, entry.productId, entry.quantity, `Pending arrival #${purchaseId} product changed`]
        );
      } else if (entry.quantity !== oldQuantity) {
        const delta = roundUnitCost(entry.quantity - oldQuantity);
        await client.query(
          "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, $3, $4, $5, $6)",
          [entry.productId, Math.abs(delta), delta > 0 ? "IN" : "OUT", `Pending arrival #${purchaseId} edited`, manager.id, entry.branchId]
        );
      }
      const newSnapshot = { purchase: purchaseResult.rows[0], batch: batchUpdateResult.rows[0] };
      await client.query(
        "INSERT INTO purchase_audit_trail (purchase_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'EDIT_PENDING_ARRIVAL', $2::jsonb, $3::jsonb, $4, $5)",
        [purchaseId, JSON.stringify(oldSnapshot), JSON.stringify(newSnapshot), reason, manager.id]
      );
      await client.query("COMMIT");
      return res.json({ success: true, purchase: purchaseResult.rows[0] });
    }
    if (productChanged && soldQuantity > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This purchase batch has already been sold. Product cannot be changed safely." });
    }
    if (entry.quantity < soldQuantity) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: `Quantity cannot be less than already sold quantity (${soldQuantity}).` });
    }
    const nextRemaining = productChanged ? entry.quantity : roundUnitCost(oldRemaining + (entry.quantity - oldQuantity));
    if (nextRemaining < 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "Inventory would become negative. Reduce sold stock first." });
    }

    const calculation = await buildPurchaseFinancials(client, entry);
    if (calculation.error) {
      await client.query("ROLLBACK");
      return res.status(calculation.status || 400).json({ message: calculation.error });
    }
    const { supplier, product, originType, rebateRule, financials } = calculation;
    const oldSnapshot = { purchase: oldPurchase, item: oldItem, batch };

    const purchaseResult = await client.query(
      `
      UPDATE purchases
      SET supplier_id = $1, supplier_name = $2, total_amount = $3, branch_id = $4,
          basic_amount = $5, mandi_tax_percent = $6, mandi_tax_amount = $7,
          other_charges = $8, gross_amount = $9, rebate_percent = $10,
          rebate_amount = $11, net_payable = $12, paid_amount = $13,
          balance_amount = $14, payment_timing = $15, effective_cost_per_unit = $16,
          freight_charges = $17, labour_charges = $18, rebate_rule_id = $19,
          payment_due_days = $20, payment_status = $21, payment_date = $22,
          purchase_type = $23, payment_mode = $24, payment_reference_number = $25,
          remarks = $26, purchase_status = 'EDITED', edited_by = $27,
          edited_at = CURRENT_TIMESTAMP, edit_reason = $28,
          purchase_bill_status = 'BILL_COMPLETED', bill_number = $29, bill_date = $30,
          lot_name = $32, lot_size = $33, stock_source = 'PURCHASE'
      WHERE id = $31
      RETURNING *
      `,
      [
        supplier.id, supplier.supplier_name, financials.netPayable, entry.branchId,
        financials.basicAmount, financials.mandiTaxPercent, financials.mandiTaxAmount,
        entry.otherCharges, financials.grossAmount, financials.rebatePercent,
        financials.rebateAmount, financials.netPayable, financials.paidAmount,
        financials.balanceAmount, rebateRule.rule_name, financials.effectiveCostPerUnit,
        entry.freightCharges, entry.labourCharges, rebateRule.id,
        rebateRule.pay_within_days, financials.paymentStatus,
        entry.purchaseType === "CREDIT" ? null : entry.paymentDate,
        entry.purchaseType, entry.purchaseType === "CASH" ? entry.paymentMode : null,
        entry.purchaseType === "CASH" ? entry.paymentReferenceNumber : null,
        entry.remarks, manager.id, reason, entry.billNumber, entry.billDate, purchaseId,
        entry.lotName, entry.lotSize,
      ]
    );

    await client.query(
      `
      UPDATE purchase_items
      SET product_id = $1, quantity = $2, purchase_rate = $3, amount = $4,
          basic_amount = $5, mandi_tax_amount = $6, other_charges = $7,
          rebate_amount = $8, net_payable = $9, effective_cost_per_unit = $10,
          freight_charges = $11, labour_charges = $12, lot_name = $14, lot_size = $15
      WHERE id = $13
      `,
      [
        entry.productId, entry.quantity, entry.purchaseRate, financials.netPayable,
        financials.basicAmount, financials.mandiTaxAmount, entry.otherCharges,
        financials.rebateAmount, financials.netPayable, financials.effectiveCostPerUnit,
        entry.freightCharges, entry.labourCharges, oldItem.id, entry.lotName, entry.lotSize,
      ]
    );

    const batchUpdateResult = await client.query(
      `
      UPDATE inventory_batches
      SET purchase_id = $1, product_id = $2, purchase_qty = $3, remaining_qty = $4,
          purchase_rate = $5, effective_cost_per_unit = $6, supplier_id = $7,
          supplier_name = $8, branch_id = $9, mandi_tax_amount = $10,
          freight_charges = $11, labour_charges = $12, other_charges = $13,
          gross_amount = $14, rebate_amount = $15, net_payable = $16,
          payment_timing = $17, balance_amount = $18, batch_status = 'ACTIVE',
          purchase_bill_status = 'BILL_COMPLETED', lot_name = $20, lot_size = $21,
          stock_source = 'PURCHASE', remarks = $22, purchase_date = $23
      WHERE id = $19
      RETURNING *
      `,
      [
        purchaseId, entry.productId, entry.quantity, nextRemaining, entry.purchaseRate,
        financials.effectiveCostPerUnit, supplier.id, supplier.supplier_name, entry.branchId,
        financials.mandiTaxAmount, entry.freightCharges, entry.labourCharges, entry.otherCharges,
        financials.grossAmount, financials.rebateAmount, financials.netPayable,
        rebateRule.rule_name, financials.balanceAmount, batch.id,
        entry.lotName, entry.lotSize, entry.remarks, entry.purchaseDate,
      ]
    );

    if (productChanged) {
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'OUT', $3, $4, $5), ($6, $7, 'IN', $8, $4, $5)",
        [oldItem.product_id, oldRemaining, `Purchase #${purchaseId} product changed`, manager.id, entry.branchId, entry.productId, entry.quantity, `Purchase #${purchaseId} product changed`]
      );
    } else if (entry.quantity !== oldQuantity) {
      const delta = roundUnitCost(entry.quantity - oldQuantity);
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, $3, $4, $5, $6)",
        [entry.productId, Math.abs(delta), delta > 0 ? "IN" : "OUT", `Purchase #${purchaseId} edited`, manager.id, entry.branchId]
      );
    }

    const newSnapshot = {
      purchase: purchaseResult.rows[0],
      item: { ...oldItem, product_id: entry.productId, quantity: entry.quantity, purchase_rate: entry.purchaseRate },
      batch: batchUpdateResult.rows[0],
      product_name: product.product_name,
      origin_type: originType,
    };
    await client.query(
      `
      INSERT INTO purchase_audit_trail (purchase_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'EDIT', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [purchaseId, JSON.stringify(oldSnapshot), JSON.stringify(newSnapshot), reason, manager.id]
    );

    await client.query("COMMIT");
    return res.json({ success: true, purchase: newSnapshot.purchase });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Updating Purchase" });
  } finally {
    client.release();
  }
});

app.post("/purchase/:id/complete-bill", async (req, res) => {
  const client = await pool.connect();
  try {
    const purchaseId = parsePositiveInteger(Number(req.params.id));
    const entry = readPurchaseEntryPayload({ ...req.body, purchase_bill_status: "BILL_COMPLETED" });
    const validationMessage = validatePurchaseEntry(entry);
    if (!purchaseId) return res.status(400).json({ message: "Invalid purchase" });
    if (validationMessage) return res.status(400).json({ message: validationMessage });

    await client.query("BEGIN");
    const manager = await requireRateManager(req.body.edited_by || entry.actorId, client);
    if (!manager) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Only Owner or Admin can complete pending purchase bills" });
    }
    const oldPurchaseResult = await client.query("SELECT * FROM purchases WHERE id = $1 FOR UPDATE", [purchaseId]);
    const oldPurchase = oldPurchaseResult.rows[0];
    if (!oldPurchase) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Purchase not found" });
    }
    if (oldPurchase.purchase_status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cancelled purchase cannot be completed" });
    }
    if (oldPurchase.purchase_bill_status !== "BILL_PENDING") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Only pending purchase bills can be completed" });
    }
    const oldItemResult = await client.query("SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY id LIMIT 1 FOR UPDATE", [purchaseId]);
    const oldItem = oldItemResult.rows[0];
    const batchResult = await client.query("SELECT * FROM inventory_batches WHERE purchase_id = $1 ORDER BY id LIMIT 1 FOR UPDATE", [purchaseId]);
    const batch = batchResult.rows[0];
    if (!oldItem || !batch) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Linked pending inventory batch not found" });
    }
    const oldQuantity = Number(batch.purchase_qty || oldItem.quantity || 0);
    const oldRemaining = Number(batch.remaining_qty || 0);
    const soldQuantity = roundUnitCost(oldQuantity - oldRemaining);
    if (Number(oldItem.product_id) !== Number(entry.productId) && soldQuantity > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: "This pending arrival has already been sold. Product cannot be changed while completing the bill." });
    }
    if (entry.quantity < soldQuantity) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: `Quantity cannot be less than already sold quantity (${soldQuantity}).` });
    }
    const nextRemaining = roundUnitCost(oldRemaining + (entry.quantity - oldQuantity));
    const calculation = await buildPurchaseFinancials(client, entry);
    if (calculation.error) {
      await client.query("ROLLBACK");
      return res.status(calculation.status || 400).json({ message: calculation.error });
    }
    const { supplier, rebateRule, financials } = calculation;
    const oldSnapshot = { purchase: oldPurchase, item: oldItem, batch };
    const purchaseResult = await client.query(
      `
      UPDATE purchases
      SET supplier_id = $1, supplier_name = $2, total_amount = $3, branch_id = $4,
          basic_amount = $5, mandi_tax_percent = $6, mandi_tax_amount = $7,
          other_charges = $8, gross_amount = $9, rebate_percent = $10,
          rebate_amount = $11, net_payable = $12, paid_amount = $13,
          balance_amount = $14, payment_timing = $15, effective_cost_per_unit = $16,
          freight_charges = $17, labour_charges = $18, rebate_rule_id = $19,
          payment_due_days = $20, payment_status = $21, payment_date = $22,
          purchase_type = $23, payment_mode = $24, payment_reference_number = $25,
          remarks = $26, purchase_status = 'ACTIVE', purchase_bill_status = 'BILL_COMPLETED',
          bill_number = $27, bill_date = $28, edited_by = $29,
          edited_at = CURRENT_TIMESTAMP, edit_reason = $30,
          lot_name = $32, lot_size = $33, stock_source = 'PURCHASE'
      WHERE id = $31
      RETURNING *
      `,
      [
        supplier.id, supplier.supplier_name, financials.netPayable, entry.branchId,
        financials.basicAmount, financials.mandiTaxPercent, financials.mandiTaxAmount,
        entry.otherCharges, financials.grossAmount, financials.rebatePercent,
        financials.rebateAmount, financials.netPayable, financials.paidAmount,
        financials.balanceAmount, rebateRule.rule_name, financials.effectiveCostPerUnit,
        entry.freightCharges, entry.labourCharges, rebateRule.id,
        rebateRule.pay_within_days, financials.paymentStatus,
        entry.purchaseType === "CREDIT" ? null : entry.paymentDate,
        entry.purchaseType, entry.purchaseType === "CASH" ? entry.paymentMode : null,
        entry.purchaseType === "CASH" ? entry.paymentReferenceNumber : null,
        entry.remarks, entry.billNumber, entry.billDate, manager.id,
        cleanText(req.body.reason) || "Pending purchase bill completed", purchaseId,
        entry.lotName, entry.lotSize,
      ]
    );
    await client.query(
      `
      UPDATE purchase_items
      SET product_id = $1, quantity = $2, purchase_rate = $3, amount = $4,
          basic_amount = $5, mandi_tax_amount = $6, other_charges = $7,
          rebate_amount = $8, net_payable = $9, effective_cost_per_unit = $10,
          freight_charges = $11, labour_charges = $12, lot_name = $14, lot_size = $15
      WHERE id = $13
      `,
      [
        entry.productId, entry.quantity, entry.purchaseRate, financials.netPayable,
        financials.basicAmount, financials.mandiTaxAmount, entry.otherCharges,
        financials.rebateAmount, financials.netPayable, financials.effectiveCostPerUnit,
        entry.freightCharges, entry.labourCharges, oldItem.id, entry.lotName, entry.lotSize,
      ]
    );
    const batchUpdateResult = await client.query(
      `
      UPDATE inventory_batches
      SET product_id = $1, purchase_qty = $2, remaining_qty = $3,
          purchase_rate = $4, effective_cost_per_unit = $5, supplier_id = $6,
          supplier_name = $7, branch_id = $8, mandi_tax_amount = $9,
          freight_charges = $10, labour_charges = $11, other_charges = $12,
          gross_amount = $13, rebate_amount = $14, net_payable = $15,
          payment_timing = $16, balance_amount = $17, purchase_bill_status = 'BILL_COMPLETED',
          temporary_sale_rate = 0, lot_name = $19, lot_size = $20,
          stock_source = 'PURCHASE', remarks = $21, purchase_date = $22
      WHERE id = $18
      RETURNING *
      `,
      [
        entry.productId, entry.quantity, nextRemaining, entry.purchaseRate, financials.effectiveCostPerUnit,
        supplier.id, supplier.supplier_name, entry.branchId, financials.mandiTaxAmount,
        entry.freightCharges, entry.labourCharges, entry.otherCharges, financials.grossAmount,
        financials.rebateAmount, financials.netPayable, rebateRule.rule_name, financials.balanceAmount, batch.id,
        entry.lotName, entry.lotSize, entry.remarks, entry.purchaseDate,
      ]
    );
    await client.query(
      "UPDATE sale_batch_allocations SET purchase_rate = $1, cost_amount = ROUND((quantity * $1)::NUMERIC, 2) WHERE inventory_batch_id = $2",
      [financials.effectiveCostPerUnit, batch.id]
    );
    await recalculateSalesForBatch(client, batch.id);
    if (entry.quantity !== oldQuantity) {
      const delta = roundUnitCost(entry.quantity - oldQuantity);
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, $3, $4, $5, $6)",
        [entry.productId, Math.abs(delta), delta > 0 ? "IN" : "OUT", `Pending bill #${purchaseId} completed quantity adjustment`, manager.id, entry.branchId]
      );
    }
    const newSnapshot = { purchase: purchaseResult.rows[0], batch: batchUpdateResult.rows[0] };
    await client.query(
      "INSERT INTO purchase_audit_trail (purchase_id, action, old_value, new_value, reason, edited_by) VALUES ($1, 'COMPLETE_BILL', $2::jsonb, $3::jsonb, $4, $5)",
      [purchaseId, JSON.stringify(oldSnapshot), JSON.stringify(newSnapshot), cleanText(req.body.reason) || "Pending purchase bill completed", manager.id]
    );
    await client.query("COMMIT");
    return res.json({ success: true, purchase: purchaseResult.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Completing Pending Purchase Bill" });
  } finally {
    client.release();
  }
});

app.post("/purchase/:id/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const purchaseId = parsePositiveInteger(Number(req.params.id));
    const reason = cleanText(req.body.reason);
    const cancelledBy = parsePositiveInteger(req.body.cancelled_by);
    if (!purchaseId || !reason) return res.status(400).json({ message: "Cancellation reason is required" });

    await client.query("BEGIN");
    const manager = await requireRateManager(cancelledBy, client);
    if (!manager) {
      await client.query("ROLLBACK");
      return res.status(403).json({ message: "Only Owner or Admin can cancel purchases" });
    }
    const purchaseResult = await client.query("SELECT * FROM purchases WHERE id = $1 FOR UPDATE", [purchaseId]);
    const purchase = purchaseResult.rows[0];
    if (!purchase) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Purchase not found" });
    }
    if (purchase.purchase_status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Purchase is already cancelled" });
    }
    const itemResult = await client.query("SELECT * FROM purchase_items WHERE purchase_id = $1 ORDER BY id LIMIT 1 FOR UPDATE", [purchaseId]);
    const item = itemResult.rows[0];
    const batchResult = await client.query(
      `
      SELECT *
      FROM inventory_batches
      WHERE purchase_id = $1 OR (purchase_id IS NULL AND batch_no LIKE $2)
      ORDER BY purchase_id NULLS LAST, id
      LIMIT 1
      FOR UPDATE
      `,
      [purchaseId, `%-${purchaseId}`]
    );
    const batch = batchResult.rows[0];
    if (!item || !batch) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Linked purchase inventory not found" });
    }
    const purchaseQty = Number(batch.purchase_qty || item.quantity || 0);
    const remainingQty = Number(batch.remaining_qty || 0);
    const soldQuantity = roundUnitCost(purchaseQty - remainingQty);
    if (soldQuantity > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        message: purchase.purchase_bill_status === "BILL_PENDING"
          ? "Cannot cancel. Stock from this arrival has already been sold."
          : "This purchase cannot be cancelled because stock from this batch has already been sold.",
      });
    }
    const oldSnapshot = { purchase, item, batch };
    const updatedPurchase = await client.query(
      `
      UPDATE purchases
      SET purchase_status = 'CANCELLED', cancelled_by = $1, cancelled_at = CURRENT_TIMESTAMP,
          cancellation_reason = $2, balance_amount = 0, payment_status = 'CANCELLED'
      WHERE id = $3
      RETURNING *
      `,
      [manager.id, reason, purchaseId]
    );
    const updatedBatch = await client.query(
      `
      UPDATE inventory_batches
      SET remaining_qty = 0, batch_status = 'CANCELLED', purchase_id = $1
      WHERE id = $2
      RETURNING *
      `,
      [purchaseId, batch.id]
    );
    if (remainingQty > 0) {
      await client.query(
        "INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id) VALUES ($1, $2, 'OUT', $3, $4, $5)",
        [item.product_id, remainingQty, `Purchase #${purchaseId} cancelled`, manager.id, purchase.branch_id]
      );
    }
    const newSnapshot = { purchase: updatedPurchase.rows[0], item, batch: updatedBatch.rows[0] };
    await client.query(
      `
      INSERT INTO purchase_audit_trail (purchase_id, action, old_value, new_value, reason, edited_by)
      VALUES ($1, 'CANCEL', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [purchaseId, JSON.stringify(oldSnapshot), JSON.stringify(newSnapshot), reason, manager.id]
    );
    await client.query("COMMIT");
    return res.json({ success: true, purchase: updatedPurchase.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Cancelling Purchase" });
  } finally {
    client.release();
  }
});

app.post("/sales", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      product_id,
      quantity,
      branch_id,
      created_by,
      customer,
      invoice_discount,
      payments,
      bill_datetime,
      bill_date,
      date_override_reason,
      backdate_reason,
    } = req.body;
    const parsedBranchId = parsePositiveInteger(branch_id);
    const parsedCreatedBy = parsePositiveInteger(created_by) || 1;
    const parsedInvoiceDiscount = parseNonNegativeNumber(invoice_discount);
    const rawBillDateTime = cleanText(bill_datetime || "");
    const rawBillDate = cleanText(bill_date || rawBillDateTime || "");
    const transactionDate = toBusinessDateKey(rawBillDate);
    const requestedBillDateTime = rawBillDateTime || `${transactionDate}T00:00`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate)) {
      return res.status(400).json({ message: "Select a valid bill date" });
    }
    const todayDate = toDateKey(new Date());
    const isBackdatedBill = transactionDate < todayDate;
    const isFutureBill = transactionDate > todayDate;
    if (transactionDate !== todayDate) {
      const dateOverrideUser = await getPermissionUser(parsedCreatedBy, "pos_date_override", ["Owner", "Admin"], client);
      if (!dateOverrideUser) {
        return res.status(403).json({ message: "You do not have permission to change bill date" });
      }
      if (isBackdatedBill && req.body.backdate_confirmed !== true) {
        return res.status(409).json({
          message: `You are creating a backdated POS bill for ${transactionDate}. Continue?`,
          requires_backdate_confirmation: true,
          bill_date: transactionDate,
        });
      }
      if (isFutureBill) {
        if (!["Owner", "Admin"].includes(dateOverrideUser.role_name)) {
          return res.status(403).json({ message: "Only Owner/Admin can confirm a future bill date" });
        }
        if (req.body.future_date_confirmed !== true) {
          return res.status(409).json({
            message: `You are creating a future-dated POS bill for ${transactionDate}. Continue?`,
            requires_future_date_confirmation: true,
            bill_date: transactionDate,
          });
        }
      }
    }
    const requestedItems = Array.isArray(req.body.items)
      ? req.body.items
      : [{ product_id, quantity, discount_amount: 0 }];
    const parsedItems = requestedItems.map((item) => ({
      productId: parsePositiveInteger(item.product_id),
      inventoryBatchId: parsePositiveInteger(item.inventory_batch_id),
      quantity: parsePositiveNumber(item.quantity),
      discountAmount: parseNonNegativeNumber(item.discount_amount),
      lotDiscountId: parsePositiveInteger(item.lot_discount_id),
      lotDiscountType: item.lot_discount_type ? String(item.lot_discount_type).trim().toUpperCase() : null,
      lotDiscountValue: parseNonNegativeNumber(item.lot_discount_value),
      hasRequestedRate: item.selling_rate !== undefined && item.selling_rate !== null && String(item.selling_rate).trim() !== "",
      requestedRate: item.selling_rate !== undefined && item.selling_rate !== null && String(item.selling_rate).trim() !== ""
        ? parseNonNegativeNumber(item.selling_rate)
        : null,
    }));
    const selectedCustomerId = parsePositiveInteger(customer?.account_id || customer?.customer_id);
    const customerMobile = customer?.mobile?.trim() || null;
    const customerNotes = customer?.notes?.trim() || null;

    if (
      !parsedBranchId ||
      parsedInvoiceDiscount === null ||
      parsedItems.length === 0 ||
      parsedItems.some((item) =>
        !item.productId ||
        !item.quantity ||
        item.discountAmount === null ||
        (item.lotDiscountType && !LOT_DISCOUNT_TYPES.has(item.lotDiscountType)) ||
        (item.lotDiscountType && item.lotDiscountValue === null) ||
        (item.hasRequestedRate && item.requestedRate === null)
      )
    ) {
      return res.status(400).json({ message: "Add valid products and quantities before checkout" });
    }
    const itemKeys = parsedItems.map((item) => `${item.productId}-${item.inventoryBatchId || "FIFO"}`);
    if (new Set(itemKeys).size !== itemKeys.length) {
      return res.status(400).json({ message: "Combine duplicate product lots into one cart item" });
    }
    if (customerMobile && !/^\d{10,15}$/.test(customerMobile)) {
      return res.status(400).json({ message: "Enter a valid customer mobile number" });
    }

    await client.query("BEGIN");

    let customerAccount;
    if (selectedCustomerId) {
      const customerResult = await client.query("SELECT * FROM customers WHERE id = $1 AND active = TRUE FOR SHARE", [selectedCustomerId]);
      if (customerResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Selected customer account is not active" });
      }
      customerAccount = customerResult.rows[0];
    } else {
      customerAccount = await getWalkInCustomer(client);
      if (!customerAccount) {
        await client.query("ROLLBACK");
        return res.status(500).json({ message: "Walk-in Customer account is not configured" });
      }
    }
    const customerId = customerAccount.id;
    const customerName = customerAccount.customer_name || "Walk-in Customer";

    const productIds = [...new Set(parsedItems.map((item) => item.productId))];
    const productResult = await client.query(
      "SELECT id, product_name, selling_rate, unit FROM products WHERE id = ANY($1::int[]) AND active = TRUE ORDER BY id FOR SHARE",
      [productIds]
    );
    if (productResult.rows.length !== productIds.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "One or more products could not be found" });
    }

    const productsById = new Map(productResult.rows.map((product) => [product.id, product]));
    const invoiceItems = [];
    let grossAmount = 0;
    let itemDiscountAmount = 0;
    let totalCost = 0;
    let rateOverrideUser = null;
    for (const requestedItem of parsedItems) {
      const product = productsById.get(requestedItem.productId);
      const batchParams = [requestedItem.productId, parsedBranchId];
      let batchFilter = "";
      if (requestedItem.inventoryBatchId) {
        batchParams.push(requestedItem.inventoryBatchId);
        batchFilter = `AND id = $${batchParams.length}`;
      }
      const batchesResult = await client.query(
        `
        SELECT
          id,
          remaining_qty,
          COALESCE(effective_cost_per_unit, purchase_rate) AS purchase_rate,
          COALESCE(purchase_bill_status, 'BILL_COMPLETED') AS purchase_bill_status,
          COALESCE(temporary_sale_rate, 0) AS temporary_sale_rate,
          lot_name,
          lot_size
          FROM inventory_batches
          WHERE product_id = $1
            AND branch_id = $2
            ${batchFilter}
            AND remaining_qty > 0
            AND COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED'
          ORDER BY purchase_date, created_at, id
        FOR UPDATE
        `,
        batchParams
      );
      if (requestedItem.inventoryBatchId && batchesResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ message: "Selected lot does not have enough stock." });
      }
      const defaultSellingRate = Number(requestedItem.inventoryBatchId && Number(batchesResult.rows[0]?.temporary_sale_rate || 0) > 0
        ? batchesResult.rows[0].temporary_sale_rate
        : product.selling_rate);
      const lotSpecialRate = requestedItem.lotDiscountType === "SPECIAL_RATE" && requestedItem.hasRequestedRate;
      const manualRateOverride = requestedItem.hasRequestedRate && !lotSpecialRate && roundCurrency(requestedItem.requestedRate) !== roundCurrency(defaultSellingRate);
      if (manualRateOverride && !rateOverrideUser) {
        rateOverrideUser = await getPermissionUser(parsedCreatedBy, "manual_pos_rate_override", ["Owner", "Admin"], client);
      }
      if (manualRateOverride && !rateOverrideUser) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "You do not have permission to change sale rate" });
      }
      if (manualRateOverride && requestedItem.requestedRate === 0) {
        if (!["Owner", "Admin"].includes(rateOverrideUser.role_name) || req.body.zero_rate_confirmed !== true) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            message: "Zero sale rate requires Owner/Admin confirmation",
            requires_zero_rate_confirmation: true,
            product_name: product.product_name,
          });
        }
      }
      const sellingRate = manualRateOverride || lotSpecialRate ? Number(requestedItem.requestedRate) : defaultSellingRate;
      if (!Number.isFinite(sellingRate) || sellingRate < 0 || (sellingRate === 0 && !(manualRateOverride && req.body.zero_rate_confirmed === true))) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: `${product.product_name} does not have a valid selling rate` });
      }

      const itemGross = roundCurrency(requestedItem.quantity * sellingRate);
      if (requestedItem.discountAmount > itemGross) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: `Discount cannot exceed the value of ${product.product_name}` });
      }

      const availableStock = batchesResult.rows.reduce(
        (total, batch) => total + Number(batch.remaining_qty),
        0
      );
      if (availableStock < requestedItem.quantity) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          message: requestedItem.inventoryBatchId
            ? "Selected lot does not have enough stock."
            : `Insufficient stock for ${product.product_name}. Available quantity: ${availableStock}`,
          product_id: requestedItem.productId,
          available_stock: availableStock,
        });
      }

      let quantityToDeduct = requestedItem.quantity;
      let itemCost = 0;
      const allocations = [];
      for (const batch of batchesResult.rows) {
        if (quantityToDeduct <= 0) break;

        const deductedQuantity = Math.min(quantityToDeduct, Number(batch.remaining_qty));
        const costAmount = roundCurrency(deductedQuantity * Number(batch.purchase_rate));
        await client.query(
          "UPDATE inventory_batches SET remaining_qty = remaining_qty - $1 WHERE id = $2",
          [deductedQuantity, batch.id]
        );
        allocations.push({
          inventoryBatchId: batch.id,
          quantity: deductedQuantity,
          purchaseRate: Number(batch.purchase_rate),
          costAmount,
          costStatus: batch.purchase_bill_status === "BILL_PENDING" ? "PROVISIONAL" : "FINAL",
          lotName: batch.lot_name,
          lotSize: batch.lot_size,
        });
        quantityToDeduct -= deductedQuantity;
        itemCost += costAmount;
      }

      const costPerUnit = requestedItem.quantity > 0 ? itemCost / requestedItem.quantity : 0;
      if (manualRateOverride && sellingRate < costPerUnit) {
        if (!["Owner", "Admin"].includes(rateOverrideUser.role_name)) {
          await client.query("ROLLBACK");
          return res.status(403).json({ message: "Only Owner/Admin can confirm below-cost sale" });
        }
        if (req.body.below_cost_confirmed !== true) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            message: `This rate is below cost for ${product.product_name}. Continue?`,
            requires_below_cost_confirmation: true,
            product_name: product.product_name,
            cost_per_unit: roundCurrency(costPerUnit),
            selling_rate: sellingRate,
          });
        }
      }

      invoiceItems.push({
        ...requestedItem,
        product,
        sellingRate,
        defaultSellingRate,
        manualRateOverride,
        inventoryBatchId: requestedItem.inventoryBatchId || allocations[0]?.inventoryBatchId || null,
        lotName: allocations[0]?.lotName || null,
        lotSize: allocations[0]?.lotSize || null,
        grossAmount: itemGross,
        netAmount: roundCurrency(itemGross - requestedItem.discountAmount),
        costAmount: roundCurrency(itemCost),
        costStatus: allocations.some((allocation) => allocation.costStatus === "PROVISIONAL") ? "PROVISIONAL" : "FINAL",
        allocations,
      });
      grossAmount += itemGross;
      itemDiscountAmount += requestedItem.discountAmount;
      totalCost += itemCost;
    }

    grossAmount = roundCurrency(grossAmount);
    itemDiscountAmount = roundCurrency(itemDiscountAmount);
    totalCost = roundCurrency(totalCost);
    const subtotalAfterItemDiscounts = roundCurrency(grossAmount - itemDiscountAmount);

    const requestedPaymentsInput = Array.isArray(payments) && payments.length > 0 ? payments : null;
    const allowedPaymentModes = new Set(["CASH", "UPI", "CARD", "BANK_TRANSFER", "CREDIT"]);
    const paymentModes = requestedPaymentsInput
      ? requestedPaymentsInput.map((payment) => String(payment.mode || "").toUpperCase())
      : ["CASH"];
    if (paymentModes.some((mode) => !allowedPaymentModes.has(mode))) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Select a valid payment mode" });
    }
    const paymentMode = paymentModes.length > 1 ? "MIXED" : paymentModes[0];
    if (paymentMode === "MIXED" && paymentModes.includes("CREDIT")) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Credit sale cannot be mixed with cash or bank payment in one bill" });
    }
    const discountRule = await getMatchingDiscountRule(client, grossAmount, paymentMode);
    const automaticInvoiceDiscount = Math.min(calculateInvoiceDiscount(discountRule, grossAmount), subtotalAfterItemDiscounts);
    const invoiceDiscountAmount = discountRule ? automaticInvoiceDiscount : parsedInvoiceDiscount;

    if (invoiceDiscountAmount > subtotalAfterItemDiscounts) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invoice discount cannot exceed the cart subtotal" });
    }

    const salesMandiTaxConfig = await getSalesMandiTaxConfig(client);
    const salesMandiTax = calculateSalesMandiTax({
      grossAmount,
      itemDiscountAmount,
      invoiceDiscountAmount,
      customerAccount,
      config: salesMandiTaxConfig,
    });
    const taxAmount = salesMandiTax.taxAmount;
    const totalAmount = roundCurrency(subtotalAfterItemDiscounts - invoiceDiscountAmount + taxAmount);
    const profit = roundCurrency(totalAmount - totalCost);
    const profitStatus = invoiceItems.some((item) => item.costStatus === "PROVISIONAL") ? "PROVISIONAL" : "FINAL";
    const requestedPayments = requestedPaymentsInput || [{ mode: "CASH", amount: totalAmount }];
    const parsedPayments = requestedPayments.map((payment) => ({
      mode: String(payment.mode || "").toUpperCase(),
      amount: parsePositiveNumber(payment.amount),
      reference_number: nullableText(payment.reference_number || payment.reference || payment.transaction_reference),
      payment_time: payment.payment_time || payment.paid_at || null,
      device_id: cleanText(payment.device_id),
    }));
    const paidAmount = roundCurrency(parsedPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
    if (
      parsedPayments.some((payment) => !allowedPaymentModes.has(payment.mode) || !payment.amount) ||
      Math.abs(paidAmount - totalAmount) > 0.01
    ) {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Payment amounts must match the invoice total" });
    }
    const creditDueDate = req.body.credit_due_date ? toBusinessDateKey(req.body.credit_due_date) : null;
    const creditRemarks = nullableText(req.body.credit_remarks);

    const saleResult = await client.query(
      `
      INSERT INTO sales (
        total_amount, total_cost, profit, branch_id, created_by, customer_id,
        customer_name, customer_mobile, customer_notes, payment_mode,
        gross_amount, item_discount_amount, invoice_discount_amount, tax_amount,
        taxable_amount, mandi_tax_rate, mandi_tax_basis, mandi_tax_effective_date, tax_config_snapshot,
        discount_rule_id, discount_rule_name, discount_rule_type, discount_rule_value,
        discount_rule_payment_mode, profit_status, sale_date, transaction_date,
        bill_datetime, backdated_bill, backdate_reason, due_date, credit_remarks, credit_status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33)
      RETURNING *
      `,
      [
        totalAmount, totalCost, profit, parsedBranchId, parsedCreatedBy, customerId,
        customerName, customerMobile, customerNotes, paymentMode,
        grossAmount, itemDiscountAmount, invoiceDiscountAmount, taxAmount,
        salesMandiTax.taxableAmount,
        salesMandiTax.taxRate,
        salesMandiTax.taxBasis,
        salesMandiTax.taxEffectiveDate,
        JSON.stringify(salesMandiTax.taxConfigSnapshot || null),
        discountRule?.id || null,
        discountRule?.rule_name || null,
        discountRule?.discount_type || null,
        discountRule?.discount_value || 0,
        discountRule?.payment_mode || null,
        profitStatus,
        transactionDate,
        transactionDate,
        requestedBillDateTime,
        isBackdatedBill,
        cleanText(date_override_reason || backdate_reason) || (isBackdatedBill ? "Backdated POS bill created" : null),
        creditDueDate,
        creditRemarks,
        paymentMode === "CREDIT" ? "PENDING" : "PAID",
      ]
    );
    const sale = saleResult.rows[0];
    const invoiceNo = `FZ-${toDateKey(sale.sale_date).replaceAll("-", "")}-${String(sale.id).padStart(6, "0")}`;
    await client.query(
      "UPDATE sales SET invoice_no = $1 WHERE id = $2",
      [invoiceNo, sale.id]
    );

    for (const item of invoiceItems) {
      const invoiceDiscountShare = subtotalAfterItemDiscounts === 0
        ? 0
        : roundCurrency(invoiceDiscountAmount * (item.netAmount / subtotalAfterItemDiscounts));
      const itemProfit = roundCurrency(item.netAmount - invoiceDiscountShare - item.costAmount);
      const saleItemResult = await client.query(
        `
        INSERT INTO sale_items (
          sale_id, product_id, quantity, selling_rate, amount, discount_amount, net_amount,
          cost_amount, profit, cost_status, default_selling_rate, manual_rate_override,
          lot_discount_id, lot_discount_type, lot_discount_value
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id
        `,
        [
          sale.id, item.productId, item.quantity, item.sellingRate, item.grossAmount,
          item.discountAmount, item.netAmount, item.costAmount, itemProfit, item.costStatus,
          item.defaultSellingRate, item.manualRateOverride,
          item.lotDiscountId || null,
          item.lotDiscountType || null,
          item.lotDiscountValue || 0,
        ]
      );
      const saleItemId = saleItemResult.rows[0].id;

      if (item.manualRateOverride) {
        await client.query(
          `
          INSERT INTO pos_rate_override_audit (
            sale_id, sale_item_id, product_id, product_name, default_rate,
            manual_rate, changed_by, invoice_no, reason
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            sale.id,
            saleItemId,
            item.productId,
            item.product.product_name,
            item.defaultSellingRate,
            item.sellingRate,
            parsedCreatedBy,
            invoiceNo,
            cleanText(item.rate_override_reason || req.body.rate_override_reason) || null,
          ]
        );
      }

      for (const allocation of item.allocations) {
        await client.query(
          `
          INSERT INTO sale_batch_allocations (
            sale_item_id, inventory_batch_id, quantity, purchase_rate, cost_amount
          )
          VALUES ($1, $2, $3, $4, $5)
          `,
          [
            saleItemId,
            allocation.inventoryBatchId,
            allocation.quantity,
            allocation.purchaseRate,
            allocation.costAmount,
          ]
        );
      }

      await client.query(
        `
        INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
        VALUES ($1, $2, 'OUT', $3, $4, $5)
        `,
        [item.productId, item.quantity, `Invoice ${invoiceNo}`, parsedCreatedBy, parsedBranchId]
      );
    }

    for (const payment of parsedPayments.filter((entry) => entry.mode !== "CREDIT")) {
      await insertSalePaymentAllocation(client, {
        saleId: sale.id,
        payment,
        userId: parsedCreatedBy,
        branchId: parsedBranchId,
        deviceId: cleanText(req.body.device_id || req.body.source_device_id),
      });
    }

    await insertCustomerLedgerEntry(
      client,
      { ...sale, customer_name: customerName, customer_mobile: customerMobile },
      "SALE",
      totalAmount,
      parsedCreatedBy,
      `Invoice ${invoiceNo}`
    );

    await client.query("COMMIT");
    return res.status(201).json({
      success: true,
      message: "Invoice Saved",
      sale: {
        ...sale,
        invoice_no: invoiceNo,
        discount_rule: discountRule,
        items: invoiceItems.map((item) => ({
          product_id: item.productId,
          product_name: item.product.product_name,
          unit: item.product.unit,
          quantity: item.quantity,
          selling_rate: item.sellingRate,
          default_selling_rate: item.defaultSellingRate,
          manual_rate_override: item.manualRateOverride,
          inventory_batch_id: item.inventoryBatchId,
          lot_name: item.lotName,
          lot_size: item.lotSize,
          amount: item.grossAmount,
          discount_amount: item.discountAmount,
          net_amount: item.netAmount,
          lot_discount_id: item.lotDiscountId || null,
          lot_discount_type: item.lotDiscountType || null,
          lot_discount_value: item.lotDiscountValue || 0,
        })),
        payments: parsedPayments,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Sale Error" });
  } finally {
    client.release();
  }
});

app.get("/sales", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        s.id,
        s.invoice_no,
        s.sale_date,
        s.created_at,
        s.customer_id,
        COALESCE(s.customer_name, c.customer_name, 'Walk-in Customer') AS customer_name,
        s.customer_mobile,
        s.payment_mode,
        s.profit_status,
        s.sale_status,
        s.cancelled_at,
        s.cancellation_reason,
        s.edited_at,
        s.edit_reason,
        s.gross_amount,
        s.item_discount_amount,
        s.invoice_discount_amount,
        s.discount_rule_id,
        s.discount_rule_name,
        s.discount_rule_type,
        s.discount_rule_value,
        s.discount_rule_payment_mode,
        s.tax_amount,
        s.total_amount AS amount,
        s.total_cost AS cost_amount,
        s.profit,
        COUNT(si.id)::INTEGER AS item_count,
        COALESCE(BOOL_OR(COALESCE(si.manual_rate_override, FALSE)), FALSE) AS manual_rate_override_applied,
        COALESCE(
          STRING_AGG(
            p.product_name ||
            COALESCE(' ' || NULLIF(TRIM(CONCAT(ib.lot_name, CASE WHEN ib.lot_size IS NOT NULL THEN ' / ' || ib.lot_size ELSE '' END)), ''), '') ||
            ' x ' || TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM si.quantity::TEXT)),
            ', ' ORDER BY si.id
          ),
          'No active items'
        ) AS item_summary
      FROM sales s
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN sale_items si ON si.sale_id = s.id
      LEFT JOIN products p ON p.id = si.product_id
      LEFT JOIN sale_batch_allocations sba ON sba.sale_item_id = si.id
      LEFT JOIN inventory_batches ib ON ib.id = sba.inventory_batch_id
      GROUP BY s.id, c.customer_name
      ORDER BY s.created_at DESC, s.id DESC
    `);

    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sales History" });
  }
});

const salesHistoryDateParams = (query) => {
  const reportRange = getReportDateRange(query);
  return {
    dateFrom: query.date_from || reportRange.dateFrom || "1900-01-01",
    dateTo: query.date_to || reportRange.dateTo || "2999-12-31",
  };
};

const loadSalesHistoryStructured = async ({ dateFrom, dateTo, saleId = null, flat = false }) => {
  const params = saleId ? [dateFrom, dateTo, saleId] : [dateFrom, dateTo];
  const saleFilter = saleId ? "AND s.id = $3" : "";
  const query = flat ? `
    SELECT
      s.id AS sale_id,
      s.invoice_no,
      s.sale_date,
      s.created_at,
      COALESCE(s.sale_status, 'COMPLETED') AS sale_status,
      s.customer_id,
      COALESCE(s.customer_name, c.customer_name, 'Walk-in Customer') AS customer_name,
      s.customer_mobile,
      s.payment_mode,
      si.id AS sale_item_id,
      si.product_id,
      p.product_name,
      p.category,
      p.unit,
      sba.inventory_batch_id,
      ib.lot_name,
      ib.lot_size,
      COALESCE(sba.quantity, si.quantity) AS quantity,
      si.selling_rate,
      ROUND((si.amount * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2) AS gross_amount,
      ROUND((COALESCE(si.discount_amount, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2) AS item_discount_amount,
      ROUND((COALESCE(si.net_amount, si.amount - COALESCE(si.discount_amount, 0)) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2) AS net_amount,
      ROUND((COALESCE(si.cost_amount, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2) AS cost_amount,
      ROUND((COALESCE(si.profit, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2) AS profit,
      si.cost_status,
      COALESCE(si.manual_rate_override, FALSE) AS manual_rate_override
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN products p ON p.id = si.product_id
    LEFT JOIN sale_batch_allocations sba ON sba.sale_item_id = si.id
    LEFT JOIN inventory_batches ib ON ib.id = sba.inventory_batch_id
    WHERE s.sale_date BETWEEN $1 AND $2
      ${saleFilter}
    ORDER BY s.sale_date DESC, s.created_at DESC, s.id DESC, si.id, sba.id
  ` : `
    SELECT
      s.id,
      s.invoice_no,
      s.sale_date,
      s.created_at,
      COALESCE(s.sale_status, 'COMPLETED') AS sale_status,
      s.customer_id,
      COALESCE(s.customer_name, c.customer_name, 'Walk-in Customer') AS customer_name,
      s.customer_mobile,
      s.payment_mode,
      s.gross_amount,
      COALESCE(s.item_discount_amount, 0) AS item_discount_amount,
      COALESCE(s.invoice_discount_amount, 0) AS invoice_discount_amount,
      COALESCE(s.item_discount_amount, 0) + COALESCE(s.invoice_discount_amount, 0) AS discount_amount,
      s.total_amount,
      s.total_cost,
      s.profit,
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', si.id,
            'sale_item_id', si.id,
            'product_id', si.product_id,
            'product_name', p.product_name,
            'category', p.category,
            'inventory_batch_id', sba.inventory_batch_id,
            'lot_name', ib.lot_name,
            'lot_size', ib.lot_size,
            'unit', p.unit,
            'quantity', COALESCE(sba.quantity, si.quantity),
            'selling_rate', si.selling_rate,
            'gross_amount', ROUND((si.amount * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2),
            'discount_amount', ROUND((COALESCE(si.discount_amount, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2),
            'net_amount', ROUND((COALESCE(si.net_amount, si.amount - COALESCE(si.discount_amount, 0)) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2),
            'cost_amount', ROUND((COALESCE(si.cost_amount, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2),
            'profit', ROUND((COALESCE(si.profit, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2),
            'cost_status', si.cost_status,
            'manual_rate_override', COALESCE(si.manual_rate_override, FALSE)
          )
          ORDER BY si.id, sba.id
        ) FILTER (WHERE si.id IS NOT NULL),
        '[]'::json
      ) AS items
    FROM sales s
    LEFT JOIN customers c ON c.id = s.customer_id
    LEFT JOIN sale_items si ON si.sale_id = s.id
    LEFT JOIN products p ON p.id = si.product_id
    LEFT JOIN sale_batch_allocations sba ON sba.sale_item_id = si.id
    LEFT JOIN inventory_batches ib ON ib.id = sba.inventory_batch_id
    WHERE s.sale_date BETWEEN $1 AND $2
      ${saleFilter}
    GROUP BY s.id, c.customer_name
    ORDER BY s.sale_date DESC, s.created_at DESC, s.id DESC
  `;
  const result = await pool.query(query, params);
  return result.rows;
};

app.get("/sales-history", async (req, res) => {
  try {
    const range = salesHistoryDateParams(req.query);
    return res.json(await loadSalesHistoryStructured(range));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sales History" });
  }
});

app.get("/sales-history/items", async (req, res) => {
  try {
    const range = salesHistoryDateParams(req.query);
    return res.json(await loadSalesHistoryStructured({ ...range, flat: true }));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sales History Items" });
  }
});

app.get("/sales-history/lots", async (req, res) => {
  try {
    const range = salesHistoryDateParams(req.query);
    return res.json(await loadSalesHistoryStructured({ ...range, flat: true }));
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sales History Lots" });
  }
});

app.get("/sales-history/:id", async (req, res) => {
  try {
    const saleId = parsePositiveInteger(req.params.id);
    if (!saleId) return res.status(400).json({ message: "Invalid invoice" });
    const rows = await loadSalesHistoryStructured({ dateFrom: "1900-01-01", dateTo: "2999-12-31", saleId });
    if (!rows.length) return res.status(404).json({ message: "Invoice not found" });
    return res.json(rows[0]);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sales History Invoice" });
  }
});

app.get("/sales-report/changes", async (req, res) => {
  try {
    const [editedResult, cancelledResult, totalsResult] = await Promise.all([
      pool.query(
        `
        SELECT
          s.id, s.invoice_no, s.sale_date, s.total_amount, s.edited_at, s.edit_reason,
          u.full_name AS edited_by_name, s.customer_name, s.customer_mobile
        FROM sales s
        LEFT JOIN users u ON u.id = s.edited_by
        WHERE s.sale_status = 'EDITED'
        ORDER BY s.edited_at DESC NULLS LAST, s.id DESC
        `
      ),
      pool.query(
        `
        SELECT
          s.id, s.invoice_no, s.sale_date, s.total_amount, s.cancelled_at, s.cancellation_reason,
          u.full_name AS cancelled_by_name, s.customer_name, s.customer_mobile
        FROM sales s
        LEFT JOIN users u ON u.id = s.cancelled_by
        WHERE s.sale_status = 'CANCELLED'
        ORDER BY s.cancelled_at DESC NULLS LAST, s.id DESC
        `
      ),
      pool.query("SELECT COALESCE(SUM(total_amount), 0) AS total_cancelled_amount FROM sales WHERE sale_status = 'CANCELLED'"),
    ]);
    return res.json({
      editedBills: editedResult.rows,
      cancelledBills: cancelledResult.rows,
      totalCancelledAmount: Number(totalsResult.rows[0]?.total_cancelled_amount || 0),
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sale Change Report" });
  }
});

app.get("/sale-returns", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        sr.*,
        s.invoice_no,
        u.full_name AS created_by_name,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', sri.id,
              'product_id', sri.product_id,
              'product_name', p.product_name,
              'unit', p.unit,
              'return_quantity', sri.return_quantity,
              'selling_rate', sri.selling_rate,
              'return_amount', sri.return_amount,
              'cost_amount', sri.cost_amount
            ) ORDER BY sri.id
          ) FILTER (WHERE sri.id IS NOT NULL),
          '[]'
        ) AS items
      FROM sale_returns sr
      JOIN sales s ON s.id = sr.sale_id
      LEFT JOIN sale_return_items sri ON sri.sale_return_id = sr.id
      LEFT JOIN products p ON p.id = sri.product_id
      LEFT JOIN users u ON u.id = sr.created_by
      GROUP BY sr.id, s.invoice_no, u.full_name
      ORDER BY sr.return_date DESC, sr.created_at DESC, sr.id DESC
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sale Returns" });
  }
});

app.get("/sale-returns/options/:saleId", async (req, res) => {
  try {
    const saleId = parsePositiveInteger(req.params.saleId);
    if (!saleId) return res.status(400).json({ message: "Invalid invoice" });
    const [saleResult, itemsResult] = await Promise.all([
      pool.query("SELECT id, invoice_no, customer_name, customer_mobile, sale_date, total_amount, sale_status FROM sales WHERE id = $1", [saleId]),
      pool.query(
        `
        SELECT
          si.id AS sale_item_id,
          si.product_id,
          p.product_name,
          p.unit,
          si.quantity AS sold_quantity,
          COALESCE(returned.returned_quantity, 0) AS returned_quantity,
          si.quantity - COALESCE(returned.returned_quantity, 0) AS returnable_quantity,
          si.selling_rate,
          COALESCE(si.net_amount, si.amount) AS net_amount,
          si.cost_amount
        FROM sale_items si
        JOIN products p ON p.id = si.product_id
        LEFT JOIN (
          SELECT sale_item_id, SUM(return_quantity) AS returned_quantity
          FROM sale_return_items
          GROUP BY sale_item_id
        ) returned ON returned.sale_item_id = si.id
        WHERE si.sale_id = $1
        ORDER BY si.id
        `,
        [saleId]
      ),
    ]);
    const sale = saleResult.rows[0];
    if (!sale) return res.status(404).json({ message: "Invoice not found" });
    return res.json({ sale, items: itemsResult.rows });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Return Options" });
  }
});

app.post("/sale-returns", async (req, res) => {
  const client = await pool.connect();
  try {
    const saleId = parsePositiveInteger(req.body.sale_id);
    const refundType = normalizeRefundType(req.body.refund_type);
    const returnReason = cleanText(req.body.return_reason);
    const createdBy = parsePositiveInteger(req.body.created_by) || 1;
    const branchId = parsePositiveInteger(req.body.branch_id);
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    if (!saleId || !REFUND_TYPES.has(refundType) || !returnReason || items.length === 0) {
      return res.status(400).json({ message: "Select invoice, products, refund type and return reason" });
    }
    await client.query("BEGIN");
    const saleResult = await client.query("SELECT * FROM sales WHERE id = $1 FOR SHARE", [saleId]);
    const sale = saleResult.rows[0];
    if (!sale || sale.sale_status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Select an active invoice for return" });
    }
    const returnNo = `RET-${Date.now()}`;
    const returnResult = await client.query(
      `
      INSERT INTO sale_returns (
        return_no, sale_id, customer_name, customer_mobile, return_date,
        refund_type, return_reason, total_return_amount, total_cost_amount,
        branch_id, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, $9)
      RETURNING *
      `,
      [
        returnNo, saleId, nullableText(req.body.customer_name) || sale.customer_name,
        nullableText(req.body.customer_mobile) || sale.customer_mobile,
        req.body.return_date || toDateKey(new Date()), refundType, returnReason,
        branchId || sale.branch_id, createdBy,
      ]
    );
    const saleReturn = returnResult.rows[0];
    let totalReturnAmount = 0;
    let totalCostAmount = 0;
    for (const requested of items) {
      const saleItemId = parsePositiveInteger(requested.sale_item_id);
      const returnQuantity = parsePositiveNumber(requested.return_quantity);
      if (!saleItemId || !returnQuantity) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Enter valid return quantities" });
      }
      const itemResult = await client.query(
        `
        SELECT
          si.*,
          p.product_name,
          COALESCE(returned.returned_quantity, 0) AS returned_quantity
        FROM sale_items si
        JOIN products p ON p.id = si.product_id
        LEFT JOIN (
          SELECT sale_item_id, SUM(return_quantity) AS returned_quantity
          FROM sale_return_items
          GROUP BY sale_item_id
        ) returned ON returned.sale_item_id = si.id
        WHERE si.id = $1 AND si.sale_id = $2
        FOR SHARE
        `,
        [saleItemId, saleId]
      );
      const saleItem = itemResult.rows[0];
      const returnable = Number(saleItem?.quantity || 0) - Number(saleItem?.returned_quantity || 0);
      if (!saleItem || returnQuantity > returnable) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: `${saleItem?.product_name || "Item"} return quantity exceeds returnable quantity` });
      }
      const returnAmount = roundCurrency((Number(saleItem.net_amount || saleItem.amount || 0) / Number(saleItem.quantity)) * returnQuantity);
      let quantityToRestore = returnQuantity;
      let costAmount = 0;
      const allocations = await client.query(
        `
        SELECT *
        FROM sale_batch_allocations
        WHERE sale_item_id = $1
        ORDER BY id
        FOR SHARE
        `,
        [saleItemId]
      );
      for (const allocation of allocations.rows) {
        if (quantityToRestore <= 0) break;
        const restoreQuantity = Math.min(quantityToRestore, Number(allocation.quantity));
        await client.query(
          "UPDATE inventory_batches SET remaining_qty = remaining_qty + $1, returned_qty = COALESCE(returned_qty, 0) + $1, batch_status = CASE WHEN COALESCE(batch_status, 'ACTIVE') = 'CANCELLED' THEN batch_status ELSE 'ACTIVE' END WHERE id = $2",
          [restoreQuantity, allocation.inventory_batch_id]
        );
        costAmount += roundCurrency(restoreQuantity * Number(allocation.purchase_rate));
        quantityToRestore -= restoreQuantity;
      }
      if (quantityToRestore > 0.0001) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Unable to map return quantity to original inventory batch" });
      }
      await client.query(
        `
        INSERT INTO sale_return_items (
          sale_return_id, sale_item_id, product_id, return_quantity,
          selling_rate, return_amount, cost_amount
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [saleReturn.id, saleItemId, saleItem.product_id, returnQuantity, saleItem.selling_rate, returnAmount, roundCurrency(costAmount)]
      );
      await client.query(
        `
        INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
        VALUES ($1, $2, 'IN', $3, $4, $5)
        `,
        [saleItem.product_id, returnQuantity, `Sale return ${returnNo}: ${returnReason}`, createdBy, branchId || sale.branch_id]
      );
      totalReturnAmount += returnAmount;
      totalCostAmount += costAmount;
    }
    const updateResult = await client.query(
      `
      UPDATE sale_returns
      SET total_return_amount = $1, total_cost_amount = $2
      WHERE id = $3
      RETURNING *
      `,
      [roundCurrency(totalReturnAmount), roundCurrency(totalCostAmount), saleReturn.id]
    );
    await client.query("COMMIT");
    return res.status(201).json(updateResult.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Saving Sale Return" });
  } finally {
    client.release();
  }
});

app.get("/waste-entries", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT we.*, p.product_name, p.unit, u.full_name AS created_by_name
      FROM waste_entries we
      JOIN products p ON p.id = we.product_id
      LEFT JOIN users u ON u.id = we.created_by
      ORDER BY we.waste_date DESC, we.created_at DESC, we.id DESC
      `
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Waste Entries" });
  }
});

app.post("/waste-entries", async (req, res) => {
  const client = await pool.connect();
  try {
    const productId = parsePositiveInteger(req.body.product_id);
    const quantity = parsePositiveNumber(req.body.quantity);
    const wasteType = normalizeWasteType(req.body.waste_type);
    const branchId = parsePositiveInteger(req.body.branch_id);
    const createdBy = parsePositiveInteger(req.body.created_by) || 1;
    if (!productId || !quantity || !branchId || !WASTE_TYPES.has(wasteType)) {
      return res.status(400).json({ message: "Enter valid waste details" });
    }
    await client.query("BEGIN");
    const batchesResult = await client.query(
      `
      SELECT id, remaining_qty, COALESCE(effective_cost_per_unit, purchase_rate) AS purchase_rate
      FROM inventory_batches
      WHERE product_id = $1
        AND branch_id = $2
        AND remaining_qty > 0
        AND COALESCE(batch_status, 'ACTIVE') <> 'CANCELLED'
      ORDER BY purchase_date, created_at, id
      FOR UPDATE
      `,
      [productId, branchId]
    );
    const availableStock = batchesResult.rows.reduce((sum, batch) => sum + Number(batch.remaining_qty), 0);
    if (availableStock < quantity) {
      await client.query("ROLLBACK");
      return res.status(409).json({ message: `Insufficient stock for waste entry. Available quantity: ${availableStock}` });
    }
    let quantityToDeduct = quantity;
    let costAmount = 0;
    for (const batch of batchesResult.rows) {
      if (quantityToDeduct <= 0) break;
      const deductedQuantity = Math.min(quantityToDeduct, Number(batch.remaining_qty));
      await client.query(
        "UPDATE inventory_batches SET remaining_qty = remaining_qty - $1, waste_qty = COALESCE(waste_qty, 0) + $1 WHERE id = $2",
        [deductedQuantity, batch.id]
      );
      costAmount += roundCurrency(deductedQuantity * Number(batch.purchase_rate));
      quantityToDeduct -= deductedQuantity;
    }
    const result = await client.query(
      `
      INSERT INTO waste_entries (
        product_id, waste_date, quantity, waste_type, remarks,
        cost_amount, branch_id, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
      `,
      [
        productId, req.body.waste_date || toDateKey(new Date()), quantity, wasteType,
        nullableText(req.body.remarks), roundCurrency(costAmount), branchId, createdBy,
      ]
    );
    await client.query(
      `
      INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
      VALUES ($1, $2, 'OUT', $3, $4, $5)
      `,
      [productId, quantity, `Waste entry ${wasteType}`, createdBy, branchId]
    );
    await client.query("COMMIT");
    return res.status(201).json(result.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Error Saving Waste Entry" });
  } finally {
    client.release();
  }
});

app.get("/sales/:id/audit", async (req, res) => {
  try {
    const saleId = parsePositiveInteger(req.params.id);
    if (!saleId) return res.status(400).json({ message: "Invalid invoice" });
    const result = await pool.query(
      `
      SELECT sat.*, u.full_name AS edited_by_name
      FROM sale_audit_trail sat
      LEFT JOIN users u ON u.id = sat.edited_by
      WHERE sat.sale_id = $1
      ORDER BY sat.edited_at DESC, sat.id DESC
      `,
      [saleId]
    );
    return res.json(result.rows);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Sale Change History" });
  }
});

app.put("/sales/:id", async (req, res) => {
  const client = await pool.connect();
  try {
    const saleId = parsePositiveInteger(req.params.id);
    const reason = cleanText(req.body.reason);
    const editor = await getSalePermissionUser(req.body.edited_by, "edit", client);
    if (!saleId) return res.status(400).json({ message: "Invalid invoice" });
    if (!reason) return res.status(400).json({ message: "Edit reason is required" });
    if (!editor) return res.status(403).json({ message: "You do not have permission to edit completed sales" });

    await client.query("BEGIN");
    const saleLockResult = await client.query("SELECT * FROM sales WHERE id = $1 FOR UPDATE", [saleId]);
    const currentSale = saleLockResult.rows[0];
    if (!currentSale) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Invoice not found" });
    }
    if (currentSale.sale_status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Cancelled invoices cannot be edited" });
    }
    const requestedSaleDate = req.body.bill_date || req.body.sale_date
      ? toBusinessDateKey(req.body.bill_date || req.body.sale_date)
      : toDateKey(currentSale.sale_date);
    if (requestedSaleDate !== toDateKey(currentSale.sale_date)) {
      const dateEditor = await getPermissionUser(editor.id, "sale_date_edit", ["Owner", "Admin"], client);
      if (!dateEditor) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "You do not have permission to edit bill date" });
      }
    }
    const editedInvoiceNo = `FZ-${requestedSaleDate.replaceAll("-", "")}-${String(saleId).padStart(6, "0")}`;

    const oldSnapshot = await getSaleSnapshot(client, saleId);
    await restoreSaleInventory(client, saleId, editor.id, "Edit reversal for invoice", "IN");
    await client.query("DELETE FROM sale_batch_allocations WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id = $1)", [saleId]);
    await client.query("DELETE FROM sale_items WHERE sale_id = $1", [saleId]);
    await client.query("DELETE FROM sale_payments WHERE sale_id = $1", [saleId]);

    const salePayload = await buildSalePayload(client, {
      items: req.body.items,
      branchId: parsePositiveInteger(req.body.branch_id) || currentSale.branch_id,
      createdBy: editor.id,
      customer: req.body.customer,
      invoiceDiscount: req.body.invoice_discount,
      payments: req.body.payments,
      allowRateOverride: ["Owner", "Admin"].includes(editor.role_name),
    });
    if (salePayload.error) {
      await client.query("ROLLBACK");
      return res.status(salePayload.error.status).json(salePayload.error);
    }

    const updateResult = await client.query(
      `
      UPDATE sales
      SET
        total_amount = $1,
        total_cost = $2,
        profit = $3,
        branch_id = $4,
        customer_id = $5,
        customer_name = $6,
        customer_mobile = $7,
        customer_notes = $8,
        payment_mode = $9,
        gross_amount = $10,
        item_discount_amount = $11,
        invoice_discount_amount = $12,
        tax_amount = $13,
        taxable_amount = $14,
        mandi_tax_rate = $15,
        mandi_tax_basis = $16,
        mandi_tax_effective_date = $17,
        tax_config_snapshot = $18::jsonb,
        discount_rule_id = $19,
        discount_rule_name = $20,
        discount_rule_type = $21,
        discount_rule_value = $22,
        discount_rule_payment_mode = $23,
        sale_date = $24,
        transaction_date = $24,
        bill_datetime = COALESCE($27::timestamp, bill_datetime),
        invoice_no = $29,
        sale_status = 'EDITED',
        edited_by = $25,
        edited_at = CURRENT_TIMESTAMP,
        edit_reason = $26
      WHERE id = $28
      RETURNING *
      `,
      [
        salePayload.totalAmount, salePayload.totalCost, salePayload.profit, salePayload.branchId,
        salePayload.customerId, salePayload.customerName, salePayload.customerMobile, salePayload.customerNotes, salePayload.paymentMode,
        salePayload.grossAmount, salePayload.itemDiscountAmount, salePayload.invoiceDiscountAmount, salePayload.taxAmount,
        salePayload.taxableAmount || 0,
        salePayload.mandiTaxRate || 0,
        salePayload.mandiTaxBasis || null,
        salePayload.mandiTaxEffectiveDate || null,
        JSON.stringify(salePayload.taxConfigSnapshot || null),
        salePayload.discountRule?.id || null, salePayload.discountRule?.rule_name || null,
        salePayload.discountRule?.discount_type || null, salePayload.discountRule?.discount_value || 0,
        salePayload.discountRule?.payment_mode || null,
        requestedSaleDate,
        editor.id,
        reason,
        req.body.bill_datetime || `${requestedSaleDate}T00:00`,
        saleId,
        editedInvoiceNo,
      ]
    );
    const updatedSale = updateResult.rows[0];

    for (const item of salePayload.invoiceItems) {
      const invoiceDiscountShare = salePayload.grossAmount - salePayload.itemDiscountAmount === 0
        ? 0
        : roundCurrency(salePayload.invoiceDiscountAmount * (item.netAmount / (salePayload.grossAmount - salePayload.itemDiscountAmount)));
      const itemProfit = roundCurrency(item.netAmount - invoiceDiscountShare - item.costAmount);
      const saleItemResult = await client.query(
        `
        INSERT INTO sale_items (
          sale_id, product_id, quantity, selling_rate, amount, discount_amount, net_amount,
          cost_amount, profit, cost_status, default_selling_rate, manual_rate_override,
          lot_discount_id, lot_discount_type, lot_discount_value
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING id
        `,
        [
          saleId, item.productId, item.quantity, item.sellingRate, item.grossAmount,
          item.discountAmount, item.netAmount, item.costAmount, itemProfit,
          item.costStatus, item.defaultSellingRate, item.manualRateOverride,
          item.lotDiscountId || null, item.lotDiscountType || null, item.lotDiscountValue || 0,
        ]
      );
      const saleItemId = saleItemResult.rows[0].id;
      if (item.manualRateOverride) {
        await client.query(
          `
          INSERT INTO pos_rate_override_audit (
            sale_id, sale_item_id, product_id, product_name, default_rate,
            manual_rate, changed_by, invoice_no, reason
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          `,
          [
            saleId,
            saleItemId,
            item.productId,
            item.product.product_name,
            item.defaultSellingRate,
            item.sellingRate,
            editor.id,
            updatedSale.invoice_no,
            reason,
          ]
        );
      }
      for (const allocation of item.allocations) {
        await client.query(
          `
          INSERT INTO sale_batch_allocations (
            sale_item_id, inventory_batch_id, quantity, purchase_rate, cost_amount
          )
          VALUES ($1, $2, $3, $4, $5)
          `,
          [saleItemId, allocation.inventoryBatchId, allocation.quantity, allocation.purchaseRate, allocation.costAmount]
        );
      }
      await client.query(
        `
        INSERT INTO stock_transactions (product_id, quantity, transaction_type, remarks, user_id, branch_id)
        VALUES ($1, $2, 'OUT', $3, $4, $5)
        `,
        [item.productId, item.quantity, `Edited invoice ${updatedSale.invoice_no}`, editor.id, salePayload.branchId]
      );
    }

    for (const payment of salePayload.payments) {
      await insertSalePaymentAllocation(client, {
        saleId,
        payment,
        userId: editor.id,
        branchId: salePayload.branchId,
        deviceId: cleanText(req.body.device_id || req.body.source_device_id),
      });
    }

    await client.query(
      `
      INSERT INTO sale_audit_trail (sale_id, action, field_name, old_value, new_value, reason, edited_by)
      VALUES ($1, 'EDIT', 'invoice', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [saleId, JSON.stringify(oldSnapshot), JSON.stringify(await getSaleSnapshot(client, saleId)), reason, editor.id]
    );

    const customerChanged = String(currentSale.customer_id || "") !== String(salePayload.customerId || "")
      || String(currentSale.customer_name || "") !== String(salePayload.customerName || "");
    const delta = roundCurrency(salePayload.totalAmount - Number(currentSale.total_amount || 0));
    if (customerChanged) {
      await insertCustomerLedgerEntry(
        client,
        currentSale,
        "SALE_EDIT_CREDIT",
        Number(currentSale.total_amount || 0),
        editor.id,
        `Invoice ${updatedSale.invoice_no} customer changed: ${reason}`
      );
      await insertCustomerLedgerEntry(
        client,
        updatedSale,
        "SALE_EDIT_DEBIT",
        salePayload.totalAmount,
        editor.id,
        `Invoice ${updatedSale.invoice_no} moved to selected customer: ${reason}`
      );
    } else if (delta !== 0 || salePayload.customerMobile || salePayload.customerName) {
      await insertCustomerLedgerEntry(
        client,
        updatedSale,
        delta >= 0 ? "SALE_EDIT_DEBIT" : "SALE_EDIT_CREDIT",
        delta,
        editor.id,
        `Invoice ${updatedSale.invoice_no} edited: ${reason}`
      );
    }

    await client.query("COMMIT");
    return res.json({ success: true, message: "Invoice Updated", sale: updatedSale });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Sale Edit Error" });
  } finally {
    client.release();
  }
});

app.post("/sales/:id/cancel", async (req, res) => {
  const client = await pool.connect();
  try {
    const saleId = parsePositiveInteger(req.params.id);
    const reason = cleanText(req.body.reason);
    const canceller = await getSalePermissionUser(req.body.cancelled_by, "cancel", client);
    if (!saleId) return res.status(400).json({ message: "Invalid invoice" });
    if (!reason) return res.status(400).json({ message: "Cancellation reason is required" });
    if (!canceller) return res.status(403).json({ message: "You do not have permission to cancel completed sales" });

    await client.query("BEGIN");
    const saleLockResult = await client.query("SELECT * FROM sales WHERE id = $1 FOR UPDATE", [saleId]);
    const currentSale = saleLockResult.rows[0];
    if (!currentSale) {
      await client.query("ROLLBACK");
      return res.status(404).json({ message: "Invoice not found" });
    }
    if (currentSale.sale_status === "CANCELLED") {
      await client.query("ROLLBACK");
      return res.status(400).json({ message: "Invoice is already cancelled" });
    }
    const oldSnapshot = await getSaleSnapshot(client, saleId);
    await restoreSaleInventory(client, saleId, canceller.id, "Cancellation reversal for invoice", "IN");
    await client.query("DELETE FROM sale_batch_allocations WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id = $1)", [saleId]);
    await client.query("UPDATE sale_payments SET status = 'REVERSED' WHERE sale_id = $1", [saleId]);
    const updateResult = await client.query(
      `
      UPDATE sales
      SET sale_status = 'CANCELLED',
          cancelled_by = $1,
          cancelled_at = CURRENT_TIMESTAMP,
          cancellation_reason = $2
      WHERE id = $3
      RETURNING *
      `,
      [canceller.id, reason, saleId]
    );
    const cancelledSale = updateResult.rows[0];
    await client.query(
      `
      INSERT INTO sale_audit_trail (sale_id, action, field_name, old_value, new_value, reason, edited_by)
      VALUES ($1, 'CANCEL', 'invoice', $2::jsonb, $3::jsonb, $4, $5)
      `,
      [saleId, JSON.stringify(oldSnapshot), JSON.stringify(await getSaleSnapshot(client, saleId)), reason, canceller.id]
    );
    await insertCustomerLedgerEntry(
      client,
      cancelledSale,
      "SALE_CANCELLED",
      Number(currentSale.total_amount || 0),
      canceller.id,
      `Invoice ${cancelledSale.invoice_no} cancelled: ${reason}`
    );
    await client.query("COMMIT");
    return res.json({ success: true, message: "Invoice Cancelled", sale: cancelledSale });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(error);
    return res.status(500).json({ message: "Sale Cancellation Error" });
  } finally {
    client.release();
  }
});

app.get("/sales/:id", async (req, res) => {
  try {
    const saleId = parsePositiveInteger(req.params.id);
    if (!saleId) return res.status(400).json({ message: "Invalid invoice" });

    const saleResult = await pool.query(
      `
      SELECT s.*, b.branch_name, u.full_name AS created_by_name
      FROM sales s
      LEFT JOIN branches b ON b.id = s.branch_id
      LEFT JOIN users u ON u.id = s.created_by
      WHERE s.id = $1
      `,
      [saleId]
    );
    if (saleResult.rows.length === 0) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    const [itemsResult, paymentsResult] = await Promise.all([
      pool.query(
        `
        SELECT
          si.id, si.id AS sale_item_id, si.product_id, p.product_name, p.category, p.unit,
          COALESCE(sba.quantity, si.quantity) AS quantity,
          si.quantity AS item_total_quantity,
          si.selling_rate,
          sba.inventory_batch_id, ib.lot_name, ib.lot_size,
          ROUND((si.amount * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2) AS amount,
          ROUND((COALESCE(si.discount_amount, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2) AS discount_amount,
          ROUND((COALESCE(si.net_amount, si.amount - COALESCE(si.discount_amount, 0)) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2) AS net_amount,
          ROUND((COALESCE(si.cost_amount, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2) AS cost_amount,
          ROUND((COALESCE(si.profit, 0) * CASE WHEN si.quantity > 0 THEN COALESCE(sba.quantity, si.quantity) / si.quantity ELSE 1 END)::NUMERIC, 2) AS profit,
          si.cost_status, si.default_selling_rate, si.manual_rate_override,
          si.lot_discount_id, si.lot_discount_type, si.lot_discount_value
        FROM sale_items si
        JOIN products p ON p.id = si.product_id
        LEFT JOIN sale_batch_allocations sba ON sba.sale_item_id = si.id
        LEFT JOIN inventory_batches ib ON ib.id = sba.inventory_batch_id
        WHERE si.sale_id = $1
        ORDER BY si.id, sba.id
        `,
        [saleId]
      ),
      pool.query(
        "SELECT payment_mode AS mode, amount, reference_number, payment_time, status FROM sale_payments WHERE sale_id = $1 ORDER BY id",
        [saleId]
      ),
    ]);

    return res.json({
      ...saleResult.rows[0],
      items: itemsResult.rows,
      payments: paymentsResult.rows,
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ message: "Error Loading Invoice" });
  }
});

initializeDatabase()
  .then(async () => {
    await seedReferenceChangeLog();
    let lastScheduledBackupDate = "";
    setInterval(async () => {
      try {
        const settingsResult = await pool.query("SELECT * FROM backup_settings WHERE id = 1");
        const settings = settingsResult.rows[0] || {};
        if (settings.auto_backup_enabled === false) return;
        const now = new Date();
        const today = toDateKey(now);
        const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        if (currentTime === (settings.daily_backup_time || "23:59") && lastScheduledBackupDate !== today) {
          lastScheduledBackupDate = today;
          await createDatabaseBackup({ backupType: "Scheduled" });
        }
      } catch (error) {
        console.error("Scheduled backup failed", error);
      }
    }, 60 * 1000);

    const runShutdownBackup = async (signal) => {
      try {
        const settingsResult = await pool.query("SELECT backup_on_shutdown FROM backup_settings WHERE id = 1");
        if (settingsResult.rows[0]?.backup_on_shutdown !== false) {
          await createDatabaseBackup({ backupType: "Shutdown" });
        }
      } catch (error) {
        console.error("Shutdown backup failed", error);
      } finally {
        process.exit(signal === "SIGINT" ? 0 : 0);
      }
    };
    process.once("SIGINT", () => runShutdownBackup("SIGINT"));
    process.once("SIGTERM", () => runShutdownBackup("SIGTERM"));

    app.listen(port, host, () => {
      const lanIp = getPrimaryLanIp();
      console.log(`Server running on ${host}:${port}`);
      console.log(`LAN API URL: http://${lanIp}:${port}`);
    });
  })
  .catch((error) => {
    console.error("Database initialization failed", error);
    process.exit(1);
  });
