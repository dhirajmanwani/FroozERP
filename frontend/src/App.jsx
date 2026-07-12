import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios from "axios";
import html2canvas from "html2canvas";
import { jsPDF } from "jspdf";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.mjs?url";
import QRCode from "qrcode";
import "./App.css";
import {
  cacheLocalReferenceSnapshot,
  cancelLocalPosSale,
  completeLocalPosSale,
  editLocalPosSale,
  getOrCreateLocalDeviceIdentity,
  initializeLocalDatabase,
  isTauriRuntime,
  listLocalPosSales,
  loadLocalReferenceSnapshot,
  loadLocalPosSale,
} from "./local/localDatabase";
import {
  authenticateOfflineSession,
  cacheOfflineSession,
  readOfflineSession,
  verifyOfflineSessionRecord,
} from "./local/offlineSession";
import {
  connectivityEventNames,
  subscribeConnectivity,
} from "./local/connectivityService";
import {
  checkBackendHealth,
  getSyncStatus,
  queueSafeSyncTest,
  retryFailedOperations,
  syncNow,
} from "./local/syncService";

const isDesktopShell = () => Boolean(window.__TAURI_INTERNALS__ || window.__TAURI__);
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const normalizeApiBase = (value) => String(value || "").trim().replace(/\/$/, "");
const getCurrentOrigin = () => {
  if (typeof window === "undefined" || !window.location) return "";
  return normalizeApiBase(window.location.origin || `${window.location.protocol}//${window.location.host}`);
};
const isRailwayProductionHost = () => {
  if (typeof window === "undefined" || !window.location) return false;
  return String(window.location.hostname || "").toLowerCase().endsWith(".up.railway.app");
};
const API_MODES = Object.freeze({
  LOCAL_ONLY: "LOCAL_ONLY",
  CLOUD_ONLY: "CLOUD_ONLY",
  HYBRID: "HYBRID",
  LOCAL_SINGLE_DEVICE: "LOCAL_SINGLE_DEVICE",
  BRANCH_LAN_SERVER: "BRANCH_LAN_SERVER",
  BRANCH_LAN_CLIENT: "BRANCH_LAN_CLIENT",
  CLOUD_PRODUCTION: "CLOUD_PRODUCTION",
  FIELD_REMOTE_DEVICE: "FIELD_REMOTE_DEVICE",
  CUSTOM_API_URL: "CUSTOM_API_URL",
  SIMULATED_OFFLINE: "SIMULATED_OFFLINE",
});
const CLOUD_CONNECTION_MODES = Object.freeze({
  ONLINE: "ONLINE",
  SIMULATE_OFFLINE: "SIMULATE_OFFLINE",
});
const API_MODE_OPTIONS = [
  [API_MODES.HYBRID, "Hybrid: Local + Cloud"],
  [API_MODES.LOCAL_ONLY, "Local Only"],
  [API_MODES.CLOUD_ONLY, "Cloud Only"],
  [API_MODES.LOCAL_SINGLE_DEVICE, "Local Single Device"],
  [API_MODES.BRANCH_LAN_SERVER, "Branch LAN Server"],
  [API_MODES.BRANCH_LAN_CLIENT, "Branch LAN Client"],
  [API_MODES.CLOUD_PRODUCTION, "Cloud Production"],
  [API_MODES.FIELD_REMOTE_DEVICE, "Field Remote Device"],
  [API_MODES.CUSTOM_API_URL, "Custom API URL"],
];
const normalizeApiMode = (value) => {
  const mode = String(value || "").trim().toUpperCase();
  if (mode === "LOCAL_SHOP_SERVER") return API_MODES.LOCAL_SINGLE_DEVICE;
  if (mode === "LOCAL") return API_MODES.LOCAL_ONLY;
  if (mode === "CLOUD") return API_MODES.CLOUD_ONLY;
  return API_MODES[mode] || API_MODES.LOCAL_SINGLE_DEVICE;
};
const readSavedApiConfig = () => {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    return JSON.parse(window.localStorage.getItem("froozerp.apiConfig") || "{}") || {};
  } catch {
    return {};
  }
};
const writeSavedApiConfig = (config) => {
  if (typeof window === "undefined" || !window.localStorage) return;
  window.localStorage.setItem("froozerp.apiConfig", JSON.stringify(config));
};
const sanitizeSavedApiConfigForRuntime = (config) => {
  if (!isRailwayProductionHost()) return config;
  const railwayOrigin = getCurrentOrigin();
  const savedMode = normalizeApiMode(config.mode);
  const localModeSaved = [
    API_MODES.LOCAL_SINGLE_DEVICE,
    API_MODES.BRANCH_LAN_SERVER,
    API_MODES.BRANCH_LAN_CLIENT,
  ].includes(savedMode);
  const pointsToLocalApi = [config.localApiUrl, config.branchLanApiUrl, config.cloudApiUrl, config.customApiUrl]
    .some((value) => {
      const url = String(value || "").trim();
      return /localhost|127\.0\.0\.1|\[::1\]|:5000/i.test(url);
    });
  if (localModeSaved || pointsToLocalApi) {
    const nextConfig = {
      ...config,
      mode: API_MODES.CLOUD_PRODUCTION,
      cloudApiUrl: railwayOrigin,
    };
    writeSavedApiConfig(nextConfig);
    return nextConfig;
  }
  return {
    ...config,
    mode: API_MODES.CLOUD_PRODUCTION,
    cloudApiUrl: railwayOrigin,
  };
};
const RAILWAY_PRODUCTION_HOST = isRailwayProductionHost();
const RAILWAY_PRODUCTION_API_URL = RAILWAY_PRODUCTION_HOST ? getCurrentOrigin() : "";
const DEFAULT_PRODUCTION_CLOUD_API_URL = "https://froozerp-production.up.railway.app";
const SAVED_API_CONFIG = sanitizeSavedApiConfigForRuntime(readSavedApiConfig());
const normalizeCloudConnectionMode = (value) => (
  String(value || "").trim().toUpperCase() === CLOUD_CONNECTION_MODES.SIMULATE_OFFLINE
    ? CLOUD_CONNECTION_MODES.SIMULATE_OFFLINE
    : CLOUD_CONNECTION_MODES.ONLINE
);
const FROOZERP_CLOUD_SIMULATED_OFFLINE = normalizeCloudConnectionMode(SAVED_API_CONFIG.cloudConnectionMode) === CLOUD_CONNECTION_MODES.SIMULATE_OFFLINE;
const savedModeForRuntime = normalizeApiMode(SAVED_API_CONFIG.mode);
const legacyDesktopLocalMode = isDesktopShell() && [
  API_MODES.LOCAL_SINGLE_DEVICE,
  API_MODES.BRANCH_LAN_SERVER,
].includes(savedModeForRuntime);
const API_MODE = normalizeApiMode(
  RAILWAY_PRODUCTION_HOST ? API_MODES.CLOUD_PRODUCTION :
  (legacyDesktopLocalMode ? API_MODES.HYBRID : SAVED_API_CONFIG.mode) ||
  import.meta.env.VITE_API_MODE ||
  window.__FROOZERP_API_MODE__ ||
  (isDesktopShell() ? API_MODES.HYBRID : API_MODES.LOCAL_ONLY)
);
const LOCAL_API_URL = normalizeApiBase(
  SAVED_API_CONFIG.localApiUrl ||
  import.meta.env.VITE_LOCAL_API_URL ||
  window.__FROOZERP_LOCAL_API_URL__ ||
  (isDesktopShell() ? "http://127.0.0.1:5000" : `${window.location.protocol}//${window.location.hostname}:5000`)
);
const BRANCH_LAN_API_URL = normalizeApiBase(
  SAVED_API_CONFIG.branchLanApiUrl ||
  import.meta.env.VITE_BRANCH_LAN_API_URL ||
  window.__FROOZERP_BRANCH_LAN_API_URL__ ||
  ""
);
const CLOUD_API_URL = normalizeApiBase(
  RAILWAY_PRODUCTION_API_URL ||
  SAVED_API_CONFIG.cloudApiUrl ||
  import.meta.env.VITE_CLOUD_API_URL ||
  window.__FROOZERP_CLOUD_API_URL__ ||
  (isDesktopShell() ? DEFAULT_PRODUCTION_CLOUD_API_URL : "")
);
const CUSTOM_API_URL = normalizeApiBase(
  SAVED_API_CONFIG.customApiUrl ||
  import.meta.env.VITE_CUSTOM_API_URL ||
  window.__FROOZERP_CUSTOM_API_URL__ ||
  ""
);
const BRANCH_SERVER_BIND_HOST = String(
  SAVED_API_CONFIG.branchServerBindHost ||
  import.meta.env.VITE_BRANCH_SERVER_BIND_HOST ||
  window.__FROOZERP_BRANCH_SERVER_BIND_HOST__ ||
  "0.0.0.0"
).trim();
const BRANCH_SERVER_PORT = String(
  SAVED_API_CONFIG.branchServerPort ||
  import.meta.env.VITE_BRANCH_SERVER_PORT ||
  window.__FROOZERP_BRANCH_SERVER_PORT__ ||
  "5000"
).trim();
const CONFIGURED_COMPANY_ID = String(SAVED_API_CONFIG.companyId || import.meta.env.VITE_COMPANY_ID || "").trim();
const CONFIGURED_BRANCH_ID = String(SAVED_API_CONFIG.branchId || import.meta.env.VITE_BRANCH_ID || "1").trim();
const CONFIGURED_SUB_BRANCH_ID = String(SAVED_API_CONFIG.subBranchId || import.meta.env.VITE_SUB_BRANCH_ID || "").trim();
const CONFIGURED_DEVICE_ID = String(SAVED_API_CONFIG.deviceId || import.meta.env.VITE_DEVICE_ID || "").trim();
const CONFIGURED_DEVICE_NAME = String(SAVED_API_CONFIG.deviceName || import.meta.env.VITE_DEVICE_NAME || "").trim();
const resolveConfiguredApiUrl = () => {
  if (RAILWAY_PRODUCTION_API_URL) return RAILWAY_PRODUCTION_API_URL;
  if (API_MODE === API_MODES.LOCAL_ONLY || API_MODE === API_MODES.HYBRID) return LOCAL_API_URL;
  if (API_MODE === API_MODES.CLOUD_ONLY && CLOUD_API_URL) return CLOUD_API_URL;
  if (API_MODE === API_MODES.BRANCH_LAN_CLIENT && BRANCH_LAN_API_URL) return BRANCH_LAN_API_URL;
  if (API_MODE === API_MODES.CLOUD_PRODUCTION && CLOUD_API_URL) return CLOUD_API_URL;
  if (API_MODE === API_MODES.FIELD_REMOTE_DEVICE && CLOUD_API_URL) return CLOUD_API_URL;
  if (API_MODE === API_MODES.CUSTOM_API_URL && CUSTOM_API_URL) return CUSTOM_API_URL;
  if (import.meta.env.VITE_API_URL || window.__FROOZERP_API_URL__) {
    return normalizeApiBase(import.meta.env.VITE_API_URL || window.__FROOZERP_API_URL__);
  }
  return LOCAL_API_URL;
};
const API_URL = resolveConfiguredApiUrl();
const LOCAL_OPERATIONAL_API_URL = API_MODE === API_MODES.CLOUD_ONLY ? API_URL : LOCAL_API_URL;
const CLOUD_OPERATIONAL_API_URL = CLOUD_API_URL;
const SYNC_API_URL = CLOUD_OPERATIONAL_API_URL || API_URL;
const API_CONFIG = {
  mode: API_MODE,
  apiUrl: API_URL,
  localOperationalApiUrl: LOCAL_OPERATIONAL_API_URL,
  cloudOperationalApiUrl: CLOUD_OPERATIONAL_API_URL || "Not configured",
  syncApiUrl: SYNC_API_URL,
  localApiUrl: LOCAL_API_URL,
  branchLanApiUrl: BRANCH_LAN_API_URL || "Not configured",
  cloudApiUrl: CLOUD_API_URL || "Not configured",
  customApiUrl: CUSTOM_API_URL || "Not configured",
  branchServerBindHost: BRANCH_SERVER_BIND_HOST,
  branchServerPort: BRANCH_SERVER_PORT,
  companyId: CONFIGURED_COMPANY_ID || "Not configured",
  branchId: CONFIGURED_BRANCH_ID || "Not configured",
  subBranchId: CONFIGURED_SUB_BRANCH_ID || "Not configured",
  deviceId: CONFIGURED_DEVICE_ID || "Local SQLite identity",
  deviceName: CONFIGURED_DEVICE_NAME || "Local SQLite identity",
};
const SYNC_FRESHNESS_MS = 5 * 60 * 1000;

const API_MODE_LABELS = {
  LOCAL_SINGLE_DEVICE: "Local Single Device",
  BRANCH_LAN_SERVER: "Branch LAN Server",
  BRANCH_LAN_CLIENT: "Branch LAN Client",
  CLOUD_PRODUCTION: "Cloud Production",
  FIELD_REMOTE_DEVICE: "Field Remote Device",
  CUSTOM_API_URL: "Custom API URL",
  LOCAL_ONLY: "Local Only",
  CLOUD_ONLY: "Cloud Only",
  HYBRID: "Hybrid: Local + Cloud",
};

const getApiModeLabel = () => API_MODE_LABELS[API_MODE] || API_MODE;
const isCloudMode = (mode = API_MODE) => [API_MODES.CLOUD_ONLY, API_MODES.CLOUD_PRODUCTION, API_MODES.FIELD_REMOTE_DEVICE].includes(mode);
const isHybridMode = (mode = API_MODE) => mode === API_MODES.HYBRID;
const usesCloudBackend = (mode = API_MODE) => isHybridMode(mode) || isCloudMode(mode);

const isLocalEndpoint = (value) => /^(https?:\/\/)?(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(String(value || "").trim());
const isPrivateNetworkHost = (hostname) => {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (/^(10|127|169\.254|192\.168)\./.test(host)) return true;
  const private172 = host.match(/^172\.(\d{1,3})\./);
  if (private172) {
    const secondOctet = Number(private172[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  }
  return /^(fc|fd|fe80:)/i.test(host);
};
const isValidHttpApiUrl = (value) => {
  try {
    const parsed = new URL(String(value || "").trim());
    return ["http:", "https:"].includes(parsed.protocol) && Boolean(parsed.hostname);
  } catch {
    return false;
  }
};
const isRealCloudUrl = (value) => {
  const url = String(value || "").trim();
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:"
      && !isLocalEndpoint(url)
      && !isPrivateNetworkHost(parsed.hostname)
      && parsed.port !== "5000";
  } catch {
    return false;
  }
};
const CLOUD_CONFIGURED = isRealCloudUrl(CLOUD_API_URL);

const formatStatusDateTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("en-IN");
};

const isFreshStatusDateTime = (value, maxAgeMs = SYNC_FRESHNESS_MS) => {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && Date.now() - time <= maxAgeMs;
};

const probeRealInternet = async (timeoutMs = 4000) => {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch("https://www.gstatic.com/generate_204", {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timer);
  }
};

const buildConnectionStatusModel = ({ backendHealth = {}, cloudHealth = {}, deviceRegistration = null, syncStatus = {}, internetAvailable = true, currentUser = null }) => {
  const pending = Number(syncStatus?.pendingOperations || 0);
  const failed = Number(syncStatus?.failedOperations || 0);
  const conflicts = Number(syncStatus?.conflictOperations || 0);
  const localOnline = backendHealth?.online === true;
  const localOffline = backendHealth?.online === false;
  const cloudOnline = cloudHealth?.online === true;
  const cloudOffline = cloudHealth?.online === false;
  const cloudPaused = FROOZERP_CLOUD_SIMULATED_OFFLINE || cloudHealth?.reasonCode === "APP_SIMULATED_OFFLINE" || syncStatus?.lastFailureKind === "APP_SIMULATED_OFFLINE";
  const backendOnline = isCloudMode() ? cloudOnline : localOnline;
  const backendOffline = isCloudMode() ? cloudOffline : localOffline;
  const cloudReachable = !cloudPaused && usesCloudBackend() && CLOUD_CONFIGURED && cloudOnline;
  const deviceApproved = ["APPROVED", "ACTIVE"].includes(String(deviceRegistration?.status || "").toUpperCase());
  const devicePending = ["PENDING", "PENDING_APPROVAL"].includes(String(deviceRegistration?.status || "").toUpperCase());
  const cloudSyncActive = cloudReachable && deviceApproved && !syncStatus?.lastError;
  const fieldRemoteMode = API_MODE === API_MODES.FIELD_REMOTE_DEVICE;
  const apiModeLabel = getApiModeLabel();
  const lastSyncAt = syncStatus?.lastSuccessfulSyncAt || syncStatus?.lastPullAt || syncStatus?.lastPushAt;
  const lastSyncText = formatStatusDateTime(lastSyncAt);
  const freshSync = cloudSyncActive && isFreshStatusDateTime(lastSyncAt);

  let localBackendStatus;
  let cloudBackendStatus;
  if (API_MODE === API_MODES.HYBRID || API_MODE === API_MODES.LOCAL_ONLY || API_MODE === API_MODES.LOCAL_SINGLE_DEVICE) {
    localBackendStatus = localOnline ? "Local Server Connected" : localOffline ? "Local Server Offline" : "Checking Local Server";
    cloudBackendStatus = cloudPaused
      ? "Cloud Backend Paused"
      : !CLOUD_CONFIGURED
      ? "Cloud Not Configured"
      : cloudOnline
        ? devicePending ? "Cloud Connected - Device Approval Pending" : "Cloud Backend Connected"
        : cloudOffline ? "Cloud Temporarily Unavailable" : "Checking Cloud Backend";
  } else if (API_MODE === API_MODES.BRANCH_LAN_SERVER) {
    localBackendStatus = localOnline ? "Branch Server Connected" : localOffline ? "Branch Server Offline" : "Checking Branch Server";
    cloudBackendStatus = cloudPaused ? "Cloud Backend Paused" : CLOUD_CONFIGURED ? (cloudOnline ? "Cloud Backend Connected" : cloudOffline ? "Cloud Temporarily Unavailable" : "Checking Cloud Backend") : "Cloud Not Configured";
  } else if (API_MODE === API_MODES.BRANCH_LAN_CLIENT) {
    localBackendStatus = BRANCH_LAN_API_URL
      ? localOnline ? "LAN Client Connected" : localOffline ? "Branch Server Offline" : "Checking Branch Server"
      : "Branch Server URL Required";
    cloudBackendStatus = cloudPaused ? "Cloud Backend Paused" : CLOUD_CONFIGURED ? (cloudOnline ? "Cloud Backend Connected" : cloudOffline ? "Cloud Temporarily Unavailable" : "Checking Cloud Backend") : "Cloud Not Configured";
  } else if (API_MODE === API_MODES.CLOUD_ONLY || API_MODE === API_MODES.CLOUD_PRODUCTION || fieldRemoteMode) {
    localBackendStatus = "Not Used In This Mode";
    cloudBackendStatus = cloudPaused
      ? "Cloud Backend Paused"
      : CLOUD_CONFIGURED
      ? cloudOnline
        ? fieldRemoteMode ? "Cloud Connected - Field Remote Not Ready" : "Cloud Connected"
        : cloudOffline ? "Cloud Configured But Offline" : "Checking Cloud"
      : "Cloud Not Configured";
  } else {
    localBackendStatus = isLocalEndpoint(API_URL)
      ? localOnline ? "Local Server Connected" : localOffline ? "Local Server Offline" : "Checking Local Server"
      : "Custom API Selected";
    cloudBackendStatus = cloudPaused ? "Cloud Backend Paused" : CLOUD_CONFIGURED ? "Cloud Configured - Not Checked" : "Cloud Not Configured";
  }

  let syncSummary = "Backend status not checked";
  if (cloudPaused) {
    syncSummary = pending > 0 ? `Sync Paused - ${pending} pending` : "Sync Paused";
  } else if (failed > 0 || syncStatus?.lastError) {
    syncSummary = "Sync Failed";
  } else if (conflicts > 0) {
    syncSummary = "Conflict";
  } else if (syncStatus?.syncing) {
    const done = Number(syncStatus?.syncProgressDone || 0);
    const total = Number(syncStatus?.syncProgressTotal || pending || 0);
    syncSummary = total ? `Sync Active - ${done} of ${total}` : "Sync Active";
  } else if (fieldRemoteMode) {
    syncSummary = CLOUD_CONFIGURED
      ? "Field Remote Not Ready - purchase offline sync required"
      : "Field Remote Not Ready - Cloud and purchase sync required";
  } else if (devicePending && cloudReachable) {
    syncSummary = "Cloud connected - device approval pending";
  } else if (cloudOffline && usesCloudBackend()) {
    syncSummary = pending > 0 ? `Pending local changes - ${pending}` : "Cloud temporarily unavailable";
  } else if (pending > 0) {
    syncSummary = `Pending local changes - ${pending}`;
  } else if (freshSync) {
    syncSummary = "Cloud connected - synced";
  } else if (cloudSyncActive) {
    syncSummary = "Cloud sync active";
  } else if ((API_MODE === API_MODES.LOCAL_ONLY || API_MODE === API_MODES.LOCAL_SINGLE_DEVICE || API_MODE === API_MODES.BRANCH_LAN_SERVER || API_MODE === API_MODES.BRANCH_LAN_CLIENT) && localOnline) {
    syncSummary = "No pending local changes - Cloud sync not active";
  } else if (localOnline && cloudReachable) {
    syncSummary = "Local ready - cloud connected";
  } else if (localOnline) {
    syncSummary = "Local mode active";
  } else if (backendOnline) {
    syncSummary = "Selected backend reachable";
  }

  let banner = "Checking FroozERP backend status...";
  if (cloudPaused) {
    banner = "Simulated Offline Mode - Internet is available on this computer, but FroozERP cloud access is intentionally disabled.";
  } else if (localOnline && cloudReachable) {
    banner = "Local server connected • Cloud backend connected";
  } else if (localOnline && cloudOffline && usesCloudBackend()) {
    banner = "Local mode active • Cloud temporarily unavailable.";
  } else if (backendOffline) {
    banner = isCloudMode()
      ? `Cloud offline. Local work is saved safely. Pending sync: ${pending}.`
      : "Offline mode active. FroozERP is using local SQLite data. Changes will sync when backend/cloud is reachable.";
  } else if (fieldRemoteMode) {
    banner = "Field Remote Device requires Cloud Production and purchase offline sync. Current version only prepares configuration.";
  } else if ((API_MODE === API_MODES.LOCAL_ONLY || API_MODE === API_MODES.LOCAL_SINGLE_DEVICE || API_MODE === API_MODES.BRANCH_LAN_SERVER || API_MODE === API_MODES.BRANCH_LAN_CLIENT) && localOnline) {
    banner = "Local server connected.";
  } else if (cloudReachable) {
    banner = freshSync ? `Cloud online. Last sync completed at ${lastSyncText}.` : "Cloud online. Sync has not completed recently.";
  } else if (backendOnline) {
    banner = "Selected backend API is reachable.";
  }

  return {
    apiModeLabel,
    internetStatus: internetAvailable ? "Internet Available" : "No Internet",
    froozErpCloudAccess: cloudPaused ? "Disabled by Owner" : "Online",
    localBackendStatus,
    cloudBackendStatus,
    authenticationStatus: currentUser ? "Signed in" : "Not signed in",
    deviceRegistrationStatus: deviceRegistration?.status || (CLOUD_CONFIGURED ? "Not checked" : "Not configured"),
    currentApiUrl: backendHealth?.apiUrl || API_URL,
    cloudApiUrl: cloudHealth?.apiUrl || CLOUD_API_URL,
    lastHealthCheck: formatStatusDateTime(backendHealth?.lastCheckedAt) || "Not checked",
    lastSuccessfulSync: lastSyncText || "Not synced",
    pending,
    failed,
    conflicts,
    syncSummary,
    cloudConnectionMode: cloudPaused ? "Simulate Offline" : "Online",
    banner,
    detail: `${syncSummary}. API mode: ${apiModeLabel}.`,
  };
};

const writeDiagnosticLog = async (level, message, details = {}) => {
  const entry = `[FroozERP app] ${message} ${JSON.stringify(details)}`;
  console.info(entry);
  if (!isDesktopShell()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("app_log", { level, message: entry });
  } catch {
    // Browser/dev mode keeps console logging.
  }
};

const invokeTauriCommand = async (command, args = {}) => {
  if (!isDesktopShell()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, args);
};

const listenTauriEvent = async (eventName, handler) => {
  if (!isDesktopShell()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen(eventName, handler);
};

const currency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
});
const receiptCurrency = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const APP_VERSION = "1.0.38";
const APP_DISPLAY_NAME = "FroozERP - Feel the Freakin' Frooz";
const APP_COMPANY = "SRT Company";
const APPLICATION_FONT_SIZE_STORAGE_KEY = "froozerp_application_font_size";
const FROST_ACTIVE_TAB_STORAGE_KEY = "froozerp_frost_active_tab";
const FROST_RECENT_CONVERSATION_STORAGE_KEY = "froozerp_frost_recent_conversation";
const getStoredFrostConversation = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(FROST_RECENT_CONVERSATION_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.slice(0, 20) : [];
  } catch {
    return [];
  }
};
const applicationFontSizeOptions = [
  { value: "SMALL", label: "Small", scale: "90%" },
  { value: "MEDIUM", label: "Medium", scale: "100%" },
  { value: "LARGE", label: "Large", scale: "115%" },
  { value: "EXTRA_LARGE", label: "Extra Large", scale: "130%" },
];
const normalizeApplicationFontSize = (value) =>
  applicationFontSizeOptions.some((option) => option.value === value) ? value : "MEDIUM";
const getStoredApplicationFontSize = () => {
  try {
    return normalizeApplicationFontSize(localStorage.getItem(APPLICATION_FONT_SIZE_STORAGE_KEY));
  } catch {
    return "MEDIUM";
  }
};
const PRINT_PROFILE_STORAGE_PREFIX = "froozerp_print_profile";
const readStoredPrintProfile = (documentType) => {
  try {
    return localStorage.getItem(`${PRINT_PROFILE_STORAGE_PREFIX}_${documentType}`) || "";
  } catch {
    return "";
  }
};
const rememberPrintProfile = (documentType, profile) => {
  try {
    localStorage.setItem(`${PRINT_PROFILE_STORAGE_PREFIX}_${documentType}`, profile);
  } catch {
    // Printing still works when local storage is unavailable.
  }
};
const PRINT_PAGE_PROFILE_STYLE_ID = "froozerp-print-page-profile";
const printPageProfileCss = (profile) => {
  if (profile === "A4_LANDSCAPE") return "@media print { @page { size: A4 landscape; margin: 0; } }";
  if (profile === "THERMAL_58") return "@media print { @page { size: 58mm 220mm; margin: 0; } }";
  if (profile === "THERMAL_80") return "@media print { @page { size: 80mm 220mm; margin: 0; } }";
  return "@media print { @page { size: A4 portrait; margin: 0; } }";
};
const applyPrintPageProfile = (profile) => {
  let style = document.getElementById(PRINT_PAGE_PROFILE_STYLE_ID);
  if (!style) {
    style = document.createElement("style");
    style.id = PRINT_PAGE_PROFILE_STYLE_ID;
    document.head.appendChild(style);
  }
  style.textContent = printPageProfileCss(profile);
};
const clearPrintPageProfile = () => {
  document.getElementById(PRINT_PAGE_PROFILE_STYLE_ID)?.remove();
};
const schedulePrintPageProfileCleanup = () => {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.removeEventListener("afterprint", cleanup);
    clearPrintPageProfile();
  };
  window.addEventListener("afterprint", cleanup, { once: true });
  setTimeout(cleanup, 30000);
};
const UPDATE_FEED_URL = (
  import.meta.env.VITE_UPDATE_FEED_URL ||
  window.__FROOZERP_UPDATE_FEED_URL__ ||
  "https://github.com/dhirajmanwani/FroozERP/releases/latest/download/latest.json"
).trim();
const roundUi = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
const createPurchaseLineId = () => {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `purchase-line-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};
const normalizePurchaseLinePart = (value) => String(value ?? "").trim().toLowerCase();
const buildPurchaseLineIdentity = (item) => [
  String(item?.product_id || ""),
  normalizePurchaseLinePart(item?.lot_name),
  normalizePurchaseLinePart(item?.lot_size),
  normalizePurchaseLinePart(item?.unit),
  normalizePurchaseLinePart(item?.origin_type),
  String(Number(item?.purchase_rate || 0)),
  String(Number(item?.temporary_sale_rate || 0)),
].join("|");
const defaultPurchaseRules = {
  mandiTaxRules: [],
  rebateRules: [],
};

const icons = {
  dashboard: "grid",
  products: "box",
  purchase: "cart",
  "pending-bills": "alert",
  inventory: "layers",
  returns: "history",
  waste: "alert",
  sales: "receipt",
  discounts: "wallet",
  expenses: "wallet",
  accounts: "users",
  reports: "chart",
  settings: "settings",
  "sale-rates": "trend",
  frost: "message",
};

const navigationItems = [
  ["dashboard", "Dashboard"],
  ["products", "Products"],
  ["purchase", "Purchase Entry"],
  ["pending-bills", "Pending Bills"],
  ["accounts", "Accounts"],
  ["returns", "Sale Returns"],
  ["waste", "Waste Management"],
  ["sales", "POS Billing"],
  ["discounts", "Discounts"],
  ["sale-rates", "Sale Rate Update"],
  ["expenses", "Expenses"],
  ["reports", "Reports"],
  ["settings", "Settings"],
];

const offlineLocalDataViews = new Set(["dashboard", "products", "sales", "reports", "settings"]);
const offlineBackendRequiredViews = new Set(["purchase", "pending-bills", "accounts", "returns", "waste", "discounts", "sale-rates", "expenses"]);

const getErrorMessage = (error, fallback) =>
  error.response?.data?.message || fallback;

const getFrostDiagnosticMessage = (error, { offlineMode = false, internetAvailable = true, backendHealth = {} } = {}) => {
  const status = error?.response?.status;
  const serverMessage = error?.response?.data?.message;
  if (status === 401) return "FROST session expired. Sign in again to refresh owner permissions.";
  if (status === 403) return serverMessage || "FROST is blocked by this user's role permissions.";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "Internet is unavailable. FROST will use local/offline facts where available.";
  if (!internetAvailable && isCloudMode()) return "Internet is unavailable, so the cloud backend cannot be reached.";
  if (backendHealth?.online === false) return isCloudMode()
    ? "Cloud backend unavailable. Check Cloud Backend diagnostics and retry FROST."
    : "Local backend unavailable. Start or reconnect the local FroozERP server, then retry FROST.";
  if (error?.code === "ECONNABORTED") return "FROST request timed out. Check backend load and retry without reloading the app.";
  if (serverMessage) return serverMessage;
  if (offlineMode) return "FROST explanations are offline. Deterministic local facts remain available where cached.";
  return "FROST data could not be loaded. Check API mode, authentication, and backend diagnostics, then retry.";
};

const buildFrostRequestDiagnostic = ({ label, method = "GET", url, response, error, context = {} }) => {
  const status = response?.status || error?.response?.status || null;
  const body = response?.data || error?.response?.data || null;
  const message = body?.message || error?.message || (status ? `HTTP ${status}` : "Request did not complete");
  return {
    label,
    method,
    url,
    status,
    ok: Boolean(response && status >= 200 && status < 300),
    message,
    code: body?.code || error?.code || "",
    apiMode: API_CONFIG.mode,
    apiUrl: API_URL,
    userId: context.user?.id || "",
    role: context.user?.role || context.user?.role_name || "",
    branchId: context.user?.branch_id || API_CONFIG.branchId || "",
    deviceId: context.deviceId || "",
    localBackendHealth: context.backendHealth?.online === true ? "connected" : context.backendHealth?.online === false ? "offline" : "not checked",
    cloudBackendHealth: context.cloudHealth?.online === true ? "connected" : context.cloudHealth?.online === false ? "offline" : "not checked",
    authStatus: context.user?.id ? "signed in" : "not signed in",
  };
};

const frostDiagnosticsSummary = (diagnostics = []) => {
  const failed = diagnostics.filter((item) => item.ok === false);
  if (failed.length === 0) return "";
  const first = failed[0];
  if (first.status === 401) return "FROST session expired. Sign in again to refresh owner permissions.";
  if (first.status === 403) return first.message || "FROST is blocked by owner role permissions.";
  if (first.status === 404) return `${first.label} endpoint is not available in the selected backend. Installed frontend and backend may be out of sync.`;
  if (first.localBackendHealth === "offline" && !isCloudMode()) return "Local backend is not running. Start FroozERP local server, then refresh FROST.";
  if (first.cloudBackendHealth === "offline" && isCloudMode()) return "Cloud backend is unavailable. FROST cannot load cloud business data right now.";
  return `${first.label} failed: ${first.message}`;
};
const getAuthErrorMessage = (error, fallback) => {
  const code = error.response?.data?.code;
  const message = error.response?.data?.message;
  if (code === "INVALID_CREDENTIALS") return "Invalid username or password.";
  if (code === "USER_DISABLED") return message || "This user account is disabled. Contact your Owner or Administrator.";
  if (code === "DEVICE_PENDING_APPROVAL") return message || "This device is pending owner approval.";
  if (["DEVICE_DISABLED", "DEVICE_REVOKED"].includes(code)) return message || "This device is disabled for FroozERP access.";
  if (code === "BRANCH_ACCESS_DENIED") return message || "This branch is not authorised for login.";
  if (code === "SERVER_UNAVAILABLE") return message || "FroozERP backend is unavailable.";
  return message || fallback;
};

const hasObjectContent = (value) =>
  Boolean(value) && typeof value === "object" && Object.keys(value).length > 0;

const localSnapshotToInvoice = (snapshot) => {
  const invoice = snapshot?.invoice || snapshot || {};
  const items = snapshot?.items || invoice.items || [];
  const payments = snapshot?.payments || invoice.payments || [];
  return {
    ...invoice,
    id: invoice.id || invoice.invoice_global_id,
    sale_id: invoice.id || invoice.invoice_global_id,
    invoice_no: invoice.server_invoice_no || invoice.offline_invoice_ref || invoice.invoice_no,
    sale_status: invoice.status || invoice.sale_status || "COMPLETED",
    sale_date: invoice.bill_date || invoice.sale_date,
    transaction_date: invoice.bill_date || invoice.transaction_date,
    customer_name: invoice.customer_name,
    customer_mobile: invoice.customer_mobile,
    customer_id: invoice.customer_id,
    gross_amount: Number(invoice.gross_total ?? invoice.gross_amount ?? 0),
    item_discount_amount: Number(invoice.item_discount_total ?? invoice.item_discount_amount ?? 0),
    invoice_discount_amount: Number(invoice.bill_discount_total ?? invoice.invoice_discount_amount ?? 0),
    taxable_amount: Number(invoice.taxable_amount ?? 0),
    mandi_tax_rate: Number(invoice.mandi_tax_rate ?? 0),
    mandi_tax_basis: invoice.mandi_tax_basis,
    tax_config_snapshot: invoice.tax_config_snapshot,
    tax_amount: Number(invoice.tax_total ?? invoice.tax_amount ?? 0),
    total_amount: Number(invoice.net_total ?? invoice.total_amount ?? 0),
    payment_mode: invoice.payment_mode || "CASH",
    edit_reason: invoice.edit_reason,
    cancellation_reason: invoice.cancellation_reason,
    items: items.map((item) => ({
      ...item,
      id: item.id || item.item_global_id,
      product_id: item.product_id,
      product_name: item.product_name,
      inventory_batch_id: item.inventory_batch_id || item.lot_id,
      lot_id: item.lot_id || item.inventory_batch_id,
      lot_name: item.lot_name,
      lot_size: item.lot_size,
      quantity: Number(item.quantity || 0),
      selling_rate: Number(item.selling_rate ?? item.rate ?? 0),
      rate: Number(item.rate ?? item.selling_rate ?? 0),
      discount_amount: Number(item.discount_amount ?? item.discount ?? 0),
      discount: Number(item.discount ?? item.discount_amount ?? 0),
      amount: Number(item.amount ?? item.net_amount ?? 0),
      net_amount: Number(item.net_amount ?? item.amount ?? 0),
      unit: item.unit,
      stock_movement_id: item.stock_movement_id,
    })),
    payments,
    sync_status: invoice.sync_status,
    entity_version: invoice.entity_version,
  };
};

const getClientDeviceInfo = () => {
  const storageKey = "froozerp_device_id";
  let deviceId = localStorage.getItem(storageKey);
  if (!deviceId) {
    deviceId = `FZDEV-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    localStorage.setItem(storageKey, deviceId);
  }
  const userAgent = navigator.userAgent || "Browser";
  const isAndroid = /android/i.test(userAgent);
  const isTablet = /ipad|tablet/i.test(userAgent) || (isAndroid && !/mobile/i.test(userAgent));
  const isPhone = /mobile|iphone/i.test(userAgent) && !isTablet;
  const browser = /chrome|crios/i.test(userAgent) ? "Chrome" : /firefox|fxios/i.test(userAgent) ? "Firefox" : /safari/i.test(userAgent) ? "Safari" : "Browser";
  const deviceType = isAndroid
    ? isTablet ? `Android Tablet - ${browser}` : `Android Phone - ${browser}`
    : isTablet ? `Tablet Browser - ${browser}` : isPhone ? `Mobile Browser - ${browser}` : `Desktop Browser - ${browser}`;
  return {
    device_id: deviceId,
    device_name: localStorage.getItem("froozerp_device_name") || `${deviceType} - ${window.location.hostname}`,
    device_type: deviceType,
    user_agent: userAgent,
  };
};

const resolveLocalDeviceInfo = async (fallback = getClientDeviceInfo()) => {
  if (!isTauriRuntime()) return fallback;
  const identity = await getOrCreateLocalDeviceIdentity().catch(() => null);
  if (!identity?.device_id) return fallback;
  localStorage.setItem("froozerp_device_id", identity.device_id);
  if (identity.device_name) localStorage.setItem("froozerp_device_name", identity.device_name);
  return {
    ...fallback,
    device_id: identity.device_id,
    device_name: identity.device_name || fallback.device_name,
    device_type: identity.platform || fallback.device_type,
    branch_id: identity.branch_id || fallback.branch_id,
  };
};

const toDateKey = (date) =>
  typeof date === "string" ? date.slice(0, 10) : date.toLocaleDateString("en-CA");
const formatDisplayDate = (dateValue) => {
  const key = toDateKey(dateValue || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return key || "-";
  const [year, month, day] = key.split("-");
  return `${day}/${month}/${year}`;
};
const formatFileDate = (dateValue) => formatDisplayDate(dateValue).replaceAll("/", "-");
const safeFileName = (value) =>
  String(value || "FroozERP_Document")
    .replace(/&/g, " and ")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 140);
const withDocumentTitle = (fileName, action) => {
  const previousTitle = document.title;
  document.title = safeFileName(fileName).replace(/\.pdf$/i, "");
  action();
  setTimeout(() => {
    document.title = previousTitle;
  }, 1000);
};
const getReportPrintProfile = (reportClassName = "") => (
  /(sales-history|purchase-history|cash-book|stock-inventory)/i.test(reportClassName)
    ? "A4_LANDSCAPE"
    : "A4_PORTRAIT"
);
const parseSafeDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) ? raw.replace(" ", "T") : raw;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};
const formatEntryTime = (invoice = {}) => {
  const timeOnly = String(invoice.entry_time || invoice.sale_time || invoice.bill_time || "").trim();
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(timeOnly)) {
    const [hours, minutes] = timeOnly.split(":").map(Number);
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
  }
  const savedTimestamp = parseSafeDate(
    invoice.created_at ||
    invoice.createdAt ||
    invoice.bill_datetime ||
    invoice.sale_datetime ||
    invoice.transaction_time ||
    invoice.updated_at
  );
  if (!savedTimestamp) return "Not recorded";
  return savedTimestamp.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
};
const ensurePdfBlob = (blob) => {
  if (!blob) throw new Error("PDF data is missing");
  return blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" });
};
const savePdfResult = async ({ blob, fileName, pdf }) => {
  const finalFileName = safeFileName(fileName).replace(/\.pdf$/i, "") + ".pdf";
  const pdfBlob = ensurePdfBlob(blob);
  if (isDesktopShell()) {
    const bytes = Array.from(new Uint8Array(await pdfBlob.arrayBuffer()));
    const savedPath = await invokeTauriCommand("save_pdf_with_dialog", {
      fileName: finalFileName,
      bytes,
    });
    return { fileName: finalFileName, method: "tauri-save-dialog", path: savedPath, canceled: !savedPath };
  }
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: finalFileName,
        types: [{
          description: "PDF document",
          accept: { "application/pdf": [".pdf"] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(pdfBlob);
      await writable.close();
      return { fileName: finalFileName, method: "save-picker" };
    } catch (error) {
      if (error?.name === "AbortError") return { fileName: finalFileName, canceled: true };
      console.warn("FroozERP PDF save picker unavailable; using browser download fallback.", error);
    }
  }
  pdf.save(finalFileName);
  return { fileName: finalFileName, method: "browser-download" };
};
const openPdfInSystemViewer = async ({ blob, fileName }) => {
  const pdfBlob = ensurePdfBlob(blob);
  const bytes = Array.from(new Uint8Array(await pdfBlob.arrayBuffer()));
  const openedPath = await invokeTauriCommand("open_pdf_in_system_viewer", {
    fileName: safeFileName(fileName).replace(/\.pdf$/i, "") + ".pdf",
    bytes,
  });
  if (openedPath) return openedPath;
  const url = URL.createObjectURL(pdfBlob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return url;
};
const exportElementToPdf = async ({ element, fileName, mode = "A4", receiptWidth = "80MM", printProfile = "", save = true }) => {
  if (!element) throw new Error("Nothing to export");
  const isThermal = mode === "THERMAL";
  const resolvedProfile = isThermal ? (receiptWidth === "58MM" ? "THERMAL_58" : "THERMAL_80") : (printProfile || "A4_PORTRAIT");
  element.dataset.printProfile = resolvedProfile;
  element.classList.add("pdf-export-mode", isThermal ? "pdf-export-thermal" : "pdf-export-a4");
  if (!isThermal) {
    element.classList.add(resolvedProfile === "A4_LANDSCAPE" ? "pdf-export-a4-landscape" : "pdf-export-a4-portrait");
  }
  document.body.classList.add("pdf-export-active");
  try {
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvas = await html2canvas(element, {
      backgroundColor: "#ffffff",
      scale: Math.max(2, Math.min(3, window.devicePixelRatio || 2)),
      useCORS: true,
      scrollX: 0,
      scrollY: 0,
      windowWidth: Math.max(document.documentElement.clientWidth, element.scrollWidth),
      windowHeight: Math.max(document.documentElement.clientHeight, element.scrollHeight),
    });
    const imgData = canvas.toDataURL("image/png");
    const isLandscapeReport = !isThermal && resolvedProfile === "A4_LANDSCAPE";
    const pageWidth = isThermal ? (receiptWidth === "58MM" ? 58 : 80) : isLandscapeReport ? 297 : 210;
    const imgHeight = (canvas.height * pageWidth) / canvas.width;
    const pageHeight = isThermal ? Math.max(120, imgHeight) : isLandscapeReport ? 210 : 297;
    const pdf = new jsPDF(isLandscapeReport ? "l" : "p", "mm", isThermal ? [pageWidth, pageHeight] : "a4");
    if (isThermal) {
      pdf.addImage(imgData, "PNG", 0, 0, pageWidth, imgHeight);
    } else {
      let yOffset = 0;
      let remainingHeight = imgHeight;
      pdf.addImage(imgData, "PNG", 0, yOffset, pageWidth, imgHeight);
      remainingHeight -= pageHeight;
      while (remainingHeight > 0) {
        yOffset -= pageHeight;
        pdf.addPage();
        pdf.addImage(imgData, "PNG", 0, yOffset, pageWidth, imgHeight);
        remainingHeight -= pageHeight;
      }
    }
    const finalFileName = safeFileName(fileName).replace(/\.pdf$/i, "") + ".pdf";
    const blob = ensurePdfBlob(pdf.output("blob"));
    const saveResult = save ? await savePdfResult({ blob, fileName: finalFileName, pdf }) : null;
    return { blob, fileName: finalFileName, pdf, saveResult };
  } finally {
    delete element.dataset.printProfile;
    element.classList.remove("pdf-export-mode", "pdf-export-thermal", "pdf-export-a4", "pdf-export-a4-landscape", "pdf-export-a4-portrait");
    document.body.classList.remove("pdf-export-active");
  }
};

const normalizeWhatsappNumber = (value, defaultCountryCode = "91") => {
  let digits = String(value || "").trim().replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("+")) digits = digits.slice(1);
  digits = digits.replace(/\D/g, "");
  const countryCode = String(defaultCountryCode || "91").replace(/\D/g, "") || "91";
  if (digits.length === 10) digits = `${countryCode}${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : "";
};

const blobToBase64 = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onloadend = () => resolve(String(reader.result || "").replace(/^data:application\/pdf;base64,/i, ""));
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

const buildWhatsappRecipients = ({ customers = [], suppliers = [], accounts = [] } = {}) => {
  const recipients = [];
  const add = ({ id, type, name, mobile, whatsappNumber, optIn = true }) => {
    const displayName = String(name || "").trim();
    const rawNumber = String(whatsappNumber || mobile || "").trim();
    if (!displayName) return;
    recipients.push({
      key: `${type}-${id || displayName}-${rawNumber}`,
      accountId: id || null,
      accountType: type,
      name: displayName,
      phoneNumber: rawNumber,
      mobileNumber: mobile || "",
      whatsappNumber: whatsappNumber || "",
      optIn: optIn !== false,
    });
  };
  customers.forEach((customer) => add({
    id: customer.id,
    type: "customer",
    name: customer.customer_name || customer.account_name,
    mobile: customer.mobile_number,
    whatsappNumber: customer.whatsapp_number,
    optIn: customer.whatsapp_opt_in,
  }));
  suppliers.forEach((supplier) => add({
    id: supplier.id,
    type: "supplier",
    name: supplier.supplier_name || supplier.account_name,
    mobile: supplier.mobile_number,
    whatsappNumber: supplier.whatsapp_number,
    optIn: supplier.whatsapp_opt_in,
  }));
  accounts.forEach((account) => {
    if (account.source === "CUSTOMER" || account.source === "SUPPLIER") return;
    add({
      id: account.source_id || account.id,
      type: String(account.account_type || "manual").toLowerCase(),
      name: account.account_name,
      mobile: account.mobile_number,
      whatsappNumber: account.whatsapp_number,
      optIn: account.whatsapp_opt_in,
    });
  });
  const seen = new Set();
  return recipients.filter((recipient) => {
    const fingerprint = `${recipient.accountType}-${recipient.accountId || ""}-${recipient.name}-${recipient.phoneNumber}`;
    if (seen.has(fingerprint)) return false;
    seen.add(fingerprint);
    return true;
  });
};

const openWhatsappWebFallback = async ({ caption, fileName, numbers = [] }) => {
  try {
    await navigator.clipboard?.writeText?.(caption || "");
  } catch {
    // Clipboard is a convenience only.
  }
  const targets = numbers.length ? numbers : [""];
  targets.slice(0, 5).forEach((number) => {
    const url = number
      ? `https://wa.me/${number}?text=${encodeURIComponent(caption || `FroozERP document exported as ${fileName}. Please attach the PDF manually.`)}`
      : `https://wa.me/?text=${encodeURIComponent(caption || `FroozERP document exported as ${fileName}. Please attach the PDF manually.`)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  });
};

const supplierPaymentModes = [
  ["CASH", "Cash"],
  ["UPI", "UPI"],
  ["BANK_TRANSFER", "Bank Transfer"],
  ["CHEQUE", "Cheque"],
];
const bankPaymentModes = new Set(["UPI", "CARD", "BANK_TRANSFER", "BANK", "CHEQUE"]);

const accountTypes = [
  ["CUSTOMER", "Customer"],
  ["SUPPLIER", "Supplier"],
  ["TRANSPORT_VENDOR", "Transport Vendor"],
  ["COMMISSION_AGENT", "Commission Agent"],
  ["STAFF", "Staff"],
  ["OTHER", "Other"],
];

const accountPaymentActions = [
  ["RECEIVE_CUSTOMER", "Receive Payment from Customer"],
  ["PAY_SUPPLIER", "Pay Supplier"],
];

const defaultRolePermissions = {
  Owner: { all: true },
  Admin: { all: true },
  Cashier: { sales: true, accounts: true, "pending-bills": true },
  "Purchase Manager": { purchase: true, "pending-bills": true, accounts: true, reports: true },
  "Inventory Manager": { products: true, waste: true, reports: true },
};

const modulePermissionMap = {
  dashboard: "dashboard",
  products: "inventory",
  purchase: "purchases",
  "pending-bills": "billing",
  accounts: "supplier_accounts",
  returns: "billing",
  waste: "waste_management",
  sales: "billing",
  discounts: "discounts",
  "sale-rates": "discounts",
  expenses: "reports",
  reports: "reports",
  settings: "settings",
};

const ledgerModes = [
  ["ANY", "Any Account Ledger"],
  ["CUSTOMER", "Customer Ledger"],
  ["SUPPLIER", "Supplier Ledger"],
];

const discountTypes = [
  ["FLAT_AMOUNT", "Flat Amount"],
  ["PERCENTAGE", "Percentage"],
];

const dashboardRanges = [
  ["7", "Last 7 Days"],
  ["15", "Last 15 Days"],
  ["30", "Last 30 Days"],
  ["custom", "Custom Range"],
];

const emptyDashboardAnalytics = {
  dateFrom: "",
  dateTo: "",
  days: 7,
  summary: {
    todaySales: 0,
    todayProfit: 0,
    stockValue: 0,
    lowStockItems: 0,
    transactions: 0,
    supplierOutstanding: 0,
    customerOutstanding: 0,
    todayExpenses: 0,
    todayReturns: 0,
    monthlyReturns: 0,
    todayWaste: 0,
    monthlyWaste: 0,
    wastePercentage: 0,
    totalRebateReceived: 0,
    todaySupplierPayments: 0,
  },
  salesTrend: [],
  profitTrend: [],
  expenseTrend: [],
  netProfitTrend: [],
  purchaseSalesComparison: [],
  topSellingProducts: [],
  lowStockItems: [],
  insights: [],
};

const discountPaymentModes = [
  ["ALL", "All"],
  ["CASH", "Cash"],
  ["UPI", "UPI"],
  ["CARD", "Card"],
];

const roundingRules = [
  ["NEAREST_RUPEE", "Nearest rupee"],
  ["ROUND_UP_5", "Round up to ₹5"],
  ["ROUND_UP_10", "Round up to ₹10"],
  ["NO_ROUND", "No rounding"],
];

const defaultBusinessSettings = {
  business_name: "FroozERP Retail",
  brand_name: "FEEL THE FREAKIN' FROOZ",
  company_name: "SRT Company",
  address: "",
  phone_number: "",
  gst_number: "",
  logo_url: "",
  compact_logo_text: "FTF",
  invoice_footer_text: "Thank you for shopping with FEEL THE FREAKIN' FROOZ.",
  default_printer_type: "THERMAL",
  receipt_width: "80MM",
  auto_print_after_billing: false,
  default_invoice_print: "THERMAL_RECEIPT",
  default_report_print: "A4_REPORT",
  show_print_preview_before_print: true,
  show_item_discount_column_pos: true,
  show_item_discount_column_receipt: true,
  show_bill_discount_row_receipt: true,
  hide_zero_discount_rows: true,
};

const defaultSaleRateSettings = {
  desired_margin_percent: 25,
  rounding_rule: "NEAREST_RUPEE",
  suggestion_enabled: true,
  bill_level_slab_discount_enabled: true,
  pos_lot_selection_mode: "ASK_MULTIPLE",
  notes: "",
};

const defaultPosSettings = {
  enable_weighing_scale: false,
  scale_connection_type: "MANUAL_FALLBACK",
  scale_com_port: "",
  scale_baud_rate: 9600,
  scale_auto_read: false,
};

const defaultPaymentSettings = {
  business_upi_id: "",
  upi_payee_name: "FEEL THE FREAKIN' FROOZ",
  enable_upi_qr_on_invoice: false,
  show_upi_qr_on_all_bills: false,
  qr_display_size: "MEDIUM",
  enable_sales_mandi_tax: false,
  sales_mandi_tax_percent: 0,
  sales_mandi_tax_basis: "NET_AFTER_ALL_DISCOUNTS",
  sales_mandi_tax_effective_date: "",
  sales_mandi_tax_customer_scope: "REGISTERED_CUSTOMERS",
  sales_mandi_tax_product_scope: "ALL_PRODUCTS",
  sales_mandi_tax_disable_reason: "",
};

const defaultWhatsappSettings = {
  enabled: false,
  phone_number_id: "",
  access_token: "",
  access_token_configured: false,
  access_token_masked: "",
  default_country_code: "91",
};

const defaultDeviceControlSettings = {
  fullscreen_lock_enabled: false,
  require_exit_code_to_close: true,
  exit_code_configured: false,
  updated_at: "",
};

function BrandLogo({ compact = false, invoice = false, splash = false }) {
  const assetBase = import.meta.env.BASE_URL || "/";
  const assetPath = (path) => `${assetBase}${path}`.replace(/([^:]\/)\/+/g, "$1");
  const imageSrc = compact ? assetPath("branding/frooz-symbol-192.png") : invoice ? assetPath("branding/frooz-logo-invoice-320.png") : assetPath("branding/frooz-logo-full-512.png");
  const alt = compact ? "FroozERP" : "Feel the Freakin' Frooz official logo";
  return (
    <div className={`${invoice ? "brand-lockup brand-lockup-invoice" : "brand-lockup"} ${compact ? "brand-lockup-compact" : ""} ${splash ? "brand-lockup-splash" : ""}`}>
      <span className="brand-monogram">
        <img alt={alt} src={imageSrc} />
      </span>
      {!compact && (
        <span className="brand-copy">
          <strong>FroozERP</strong>
          <small>Feel the Freakin&apos; Frooz - by SRT Company</small>
        </span>
      )}
    </div>
  );
}

function Icon({ name, size = 18 }) {
  const paths = {
    grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
    box: <><path d="m21 8-9 5-9-5" /><path d="M3 8l9-5 9 5v8l-9 5-9-5Z" /><path d="M12 13v8" /></>,
    cart: <><circle cx="9" cy="20" r="1" /><circle cx="19" cy="20" r="1" /><path d="M3 4h2l3 11h11l2-7H7" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5Z" /><path d="m3 12 9 5 9-5" /><path d="m3 16 9 5 9-5" /></>,
    receipt: <><path d="M5 3v18l3-2 4 2 4-2 3 2V3l-3 2-4-2-4 2Z" /><path d="M9 9h6M9 13h6" /></>,
    history: <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 3v6h6M12 7v5l3 2" /></>,
    wallet: <><path d="M4 5h16v14H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /><path d="M16 12h4M16 12h.01" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></>,
    chart: <><path d="M3 3v18h18" /><path d="m7 16 4-5 4 3 5-7" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.8 1.8 0 0 0 .4 2l.1.1-2.8 2.8-.1-.1a1.8 1.8 0 0 0-2-.4 1.8 1.8 0 0 0-1 1.6v.2h-4V21a1.8 1.8 0 0 0-1-1.6 1.8 1.8 0 0 0-2 .4l-.1.1-2.8-2.8.1-.1a1.8 1.8 0 0 0 .4-2A1.8 1.8 0 0 0 3 14H2.8v-4H3a1.8 1.8 0 0 0 1.6-1 1.8 1.8 0 0 0-.4-2l-.1-.1 2.8-2.8.1.1a1.8 1.8 0 0 0 2 .4A1.8 1.8 0 0 0 10 3v-.2h4V3a1.8 1.8 0 0 0 1 1.6 1.8 1.8 0 0 0 2-.4l.1-.1 2.8 2.8-.1.1a1.8 1.8 0 0 0-.4 2A1.8 1.8 0 0 0 21 10h.2v4H21a1.8 1.8 0 0 0-1.6 1Z" /></>,
    trend: <><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></>,
    rupee: <><path d="M6 4h12M6 8h12M7 4c5 0 6 8 0 8h-1l8 8" /></>,
    alert: <><path d="m12 3 10 18H2Z" /><path d="M12 9v4M12 17h.01" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3M21 19V5a2 2 0 0 0-2-2h-6" /></>,
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
    barcode: <><path d="M3 5v14M7 5v14M11 5v14M15 5v14M19 5v14M21 5v14" /></>,
    trash: <><path d="M4 7h16M10 11v6M14 11v6M9 7V4h6v3M6 7l1 14h10l1-14" /></>,
    print: <><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6Z" /></>,
    message: <><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.8 8.8 0 0 1-3.8-1L3 20l1.3-4A8.3 8.3 0 1 1 21 11.5Z" /></>,
    close: <><path d="M18 6 6 18M6 6l12 12" /></>,
  };

  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      width={size}
    >
      {paths[name]}
    </svg>
  );
}

class ModuleErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, errorInfo) {
    const safeMessage = error?.message || "Unexpected module render error";
    console.error("FroozERP module error", {
      message: safeMessage,
      componentStack: errorInfo?.componentStack || "",
    });
  }

  render() {
    if (this.state.error) {
      return (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Module Error</span>
                <strong>Unable to open this screen</strong>
              </div>
              <button className="remove-button" onClick={this.props.onClose}><Icon name="close" /></button>
            </div>
            <div className="cart-empty">
              {this.state.error?.message || "Unexpected error while rendering this module."}
            </div>
          </section>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const initialView = (() => {
    const requestedView = new URLSearchParams(window.location.search).get("view");
    return navigationItems.some(([view]) => view === requestedView) ? requestedView : "dashboard";
  })();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState(null);
  const [deviceInfo, setDeviceInfo] = useState(() => getClientDeviceInfo());
  const [localDbStatus, setLocalDbStatus] = useState(null);
  const [syncStatus, setSyncStatus] = useState(null);
  const [syncMessage, setSyncMessage] = useState("");
  const [startupError, setStartupError] = useState("");
  const [startupNotice, setStartupNotice] = useState("");
  const [backendHealth, setBackendHealth] = useState({
    apiUrl: API_URL,
    url: `${API_URL}/api/health`,
    online: null,
    checking: false,
    reachabilityStatus: "checking",
    status: "checking",
    httpStatus: null,
    reasonCode: "NOT_CHECKED",
    message: "Backend reachability has not been checked yet.",
    lastCheckedAt: "",
    lastOnlineAt: "",
    lastErrorAt: "",
  });
  const [localBackendService, setLocalBackendService] = useState(null);
  const [cloudHealth, setCloudHealth] = useState({
    apiUrl: CLOUD_API_URL,
    url: CLOUD_API_URL ? `${CLOUD_API_URL}/api/health` : "",
    online: null,
    checking: false,
    reachabilityStatus: CLOUD_CONFIGURED ? "checking" : "not_configured",
    status: CLOUD_CONFIGURED ? "checking" : "not_configured",
    httpStatus: null,
    reasonCode: CLOUD_CONFIGURED ? "NOT_CHECKED" : "CLOUD_NOT_CONFIGURED",
    message: CLOUD_CONFIGURED ? "Cloud backend reachability has not been checked yet." : "Cloud backend is not configured.",
    lastCheckedAt: "",
    lastOnlineAt: "",
    lastErrorAt: "",
  });
  const [cloudDeviceRegistration, setCloudDeviceRegistration] = useState(null);
  const [cloudDiagnostics, setCloudDiagnostics] = useState(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [offlineMode, setOfflineMode] = useState(false);
  const [offlineReady, setOfflineReady] = useState(false);
  const [lastReferenceSyncAt, setLastReferenceSyncAt] = useState("");
  const [deviceGate, setDeviceGate] = useState(null);
  const [activationCode, setActivationCode] = useState("");
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [activeView, setActiveView] = useState(initialView);
  const [applicationFontSize, setApplicationFontSize] = useState(getStoredApplicationFontSize);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [internetAvailable, setInternetAvailable] = useState(() => (
    typeof navigator === "undefined" ? true : navigator.onLine !== false
  ));
  const [products, setProducts] = useState([]);
  const [productCategories, setProductCategories] = useState([]);
  const [productDuplicateWarning, setProductDuplicateWarning] = useState("");
  const [inventory, setInventory] = useState([]);
  const [salesHistory, setSalesHistory] = useState([]);
  const [saleReturns, setSaleReturns] = useState([]);
  const [wasteEntries, setWasteEntries] = useState([]);
  const [purchaseRules, setPurchaseRules] = useState(defaultPurchaseRules);
  const [settingsRules, setSettingsRules] = useState(defaultPurchaseRules);
  const [settingsData, setSettingsData] = useState({
    businessSettings: defaultBusinessSettings,
    saleRateSettings: defaultSaleRateSettings,
    posSettings: defaultPosSettings,
    paymentSettings: defaultPaymentSettings,
    whatsappSettings: defaultWhatsappSettings,
    deviceControlSettings: defaultDeviceControlSettings,
    discountRules: [],
    roles: [],
    users: [],
    updateCenter: {},
    syncSettings: {},
    backupSettings: {},
    backupLogs: [],
    exitAttemptLogs: [],
    authorizedDevices: [],
    activationCodes: [],
    branches: [],
    counters: [],
    systemInfo: {},
    canManageSettings: false,
  });
  const [discountRules, setDiscountRules] = useState([]);
  const [lotDiscounts, setLotDiscounts] = useState([]);
  const [customerPendingBills, setCustomerPendingBills] = useState({ summary: [], invoices: [] });
  const [saleRates, setSaleRates] = useState([]);
  const [saleRateHistory, setSaleRateHistory] = useState([]);
  const [saleDesiredMargin, setSaleDesiredMargin] = useState("25");
  const [suppliers, setSuppliers] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [purchases, setPurchases] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [accountLedger, setAccountLedger] = useState({ account: null, ledger: [] });
  const [accountPayments, setAccountPayments] = useState([]);
  const [accountOutstanding, setAccountOutstanding] = useState({
    customerOutstanding: [],
    supplierOutstanding: [],
    totalReceivable: 0,
    totalPayable: 0,
  });
  const [reportsData, setReportsData] = useState({
    salesReport: [],
    purchaseReport: [],
    supplierOutstandingReport: [],
    customerOutstandingReport: [],
    discountReport: [],
    expenseReport: [],
    paymentReport: [],
    paymentModeSummary: [],
    returnReport: [],
    returnReasonReport: [],
    wasteReport: [],
    wasteProductReport: [],
    mostWastedProducts: [],
    pendingPurchaseBillsReport: [],
    stockWithoutBillReport: [],
    provisionalProfitSalesReport: [],
    stockLotReport: [],
    balanceSheet: {},
    profitLoss: {},
  });
  const [expenses, setExpenses] = useState([]);
  const [dashboardRange, setDashboardRange] = useState("7");
  const [dashboardCustomRange, setDashboardCustomRange] = useState({
    date_from: toDateKey(new Date()),
    date_to: toDateKey(new Date()),
  });
  const [dashboardAnalytics, setDashboardAnalytics] = useState(emptyDashboardAnalytics);
  const [dashboardError, setDashboardError] = useState("");
  const [aiAssistantData, setAiAssistantData] = useState({
    briefing: null,
    alerts: [],
    reminders: [],
    suggestedQuestions: [],
    history: getStoredFrostConversation(),
    frost: null,
    provider: null,
    providers: [],
    engines: [],
    usage: null,
    voice: { status: "idle", transcript: "", error: "", supported: false },
    activeTab: "briefing",
    memories: [],
    predictions: { inventory: [], sales: [], cashflow: [], waste: [] },
    profitAdvisor: [],
    autonomous: null,
    dailyPlan: null,
    diagnostics: [],
    period: { range: "today", label: "Today" },
    loading: false,
    error: "",
  });
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiRange, setAiRange] = useState("today");
  const [frostActiveTab, setFrostActiveTab] = useState(() => {
    try {
      return localStorage.getItem(FROST_ACTIVE_TAB_STORAGE_KEY) || "briefing";
    } catch {
      return "briefing";
    }
  });
  const [frostDrawerOpen, setFrostDrawerOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const frostVoiceRef = useRef({ peer: null, stream: null, audio: null, channel: null });
  const [supplierDashboard, setSupplierDashboard] = useState({
    todaySales: 0,
    todayProfit: 0,
    stockValue: 0,
    lowStockItems: 0,
    transactions: 0,
    supplierOutstanding: 0,
    customerOutstanding: 0,
    todayExpenses: 0,
    todayReturns: 0,
    monthlyReturns: 0,
    todayWaste: 0,
    monthlyWaste: 0,
    wastePercentage: 0,
    totalRebateReceived: 0,
    todaySupplierPayments: 0,
    total_supplier_outstanding: 0,
    total_rebate_received: 0,
    todays_supplier_payments: 0,
  });

  const [productName, setProductName] = useState("");
  const [sellingRate, setSellingRate] = useState("");
  const [productBarcode, setProductBarcode] = useState("");
  const [productOriginType, setProductOriginType] = useState("LOCAL");
  const [productCategory, setProductCategory] = useState("Fruit");
  const [productCategoryId, setProductCategoryId] = useState("");
  const [newProductCategoryName, setNewProductCategoryName] = useState("");
  const [productMinimumStock, setProductMinimumStock] = useState("");
  const [productActive, setProductActive] = useState(true);
  const [productRemarks, setProductRemarks] = useState("");
  const [addOpeningStock, setAddOpeningStock] = useState(false);
  const [openingStockLots, setOpeningStockLots] = useState([]);
  const [openingStockDraft, setOpeningStockDraft] = useState({
    lot_name: "",
    lot_size: "",
    quantity: "",
    purchase_rate: "",
    sale_rate: "",
    opening_stock_date: toDateKey(new Date()),
    supplier_id: "",
    remarks: "",
  });
  const [lotPanelProduct, setLotPanelProduct] = useState(null);
  const [productLots, setProductLots] = useState([]);
  const [productLotAudit, setProductLotAudit] = useState([]);
  const [productListSearch, setProductListSearch] = useState("");
  const [lotListSearch, setLotListSearch] = useState("");
  const [showEmptyLots, setShowEmptyLots] = useState(false);
  const [showInventoryEmptyLots, setShowInventoryEmptyLots] = useState(false);
  const [showOpeningLotForm, setShowOpeningLotForm] = useState(false);
  const [lotAction, setLotAction] = useState(null);
  const [lotDraft, setLotDraft] = useState({
    lot_name: "",
    lot_size: "",
    supplier_id: "",
    purchase_qty: "",
    purchase_rate: "",
    sale_rate: "",
    opening_stock_date: "",
    remarks: "",
    quantity: "",
    new_quantity: "",
    adjustment_date: toDateKey(new Date()),
    reason: "",
  });
  const [editingProductId, setEditingProductId] = useState(null);
  const [unit, setUnit] = useState("");
  const [purchaseSupplierId, setPurchaseSupplierId] = useState("");
  const [purchaseProductId, setPurchaseProductId] = useState("");
  const [purchaseQuantity, setPurchaseQuantity] = useState("");
  const [purchaseRateInput, setPurchaseRateInput] = useState("");
  const [purchaseFreightCharges, setPurchaseFreightCharges] = useState("");
  const [purchaseLabourCharges, setPurchaseLabourCharges] = useState("");
  const [purchaseOtherCharges, setPurchaseOtherCharges] = useState("");
  const [purchasePaidAmount, setPurchasePaidAmount] = useState("");
  const [purchaseBillStatus, setPurchaseBillStatus] = useState("BILL_COMPLETED");
  const [purchaseDate, setPurchaseDate] = useState(toDateKey(new Date()));
  const [temporarySaleRate, setTemporarySaleRate] = useState("");
  const [expectedPurchaseRate, setExpectedPurchaseRate] = useState("");
  const [purchaseBillNumber, setPurchaseBillNumber] = useState("");
  const [purchaseBillDate, setPurchaseBillDate] = useState("");
  const [purchaseType, setPurchaseType] = useState("CREDIT");
  const [purchasePaymentMode, setPurchasePaymentMode] = useState("CASH");
  const [purchasePaymentReference, setPurchasePaymentReference] = useState("");
  const [purchaseRebateRuleId, setPurchaseRebateRuleId] = useState("");
  const [purchasePaymentDate, setPurchasePaymentDate] = useState("");
  const [purchaseRemarks, setPurchaseRemarks] = useState("");
  const [purchaseItemRemarks, setPurchaseItemRemarks] = useState("");
  const [purchaseLotName, setPurchaseLotName] = useState("");
  const [purchaseLotSize, setPurchaseLotSize] = useState("");
  const [purchaseCart, setPurchaseCart] = useState([]);
  const [editingPurchaseItemLineId, setEditingPurchaseItemLineId] = useState(null);
  const [editingPurchaseId, setEditingPurchaseId] = useState(null);
  const [purchaseAmendmentMode, setPurchaseAmendmentMode] = useState(false);
  const [amendmentDate, setAmendmentDate] = useState("");
  const [amendmentSupplierId, setAmendmentSupplierId] = useState("");
  const [selectedInvoice, setSelectedInvoice] = useState(null);
  const [selectedInvoicePrintMode, setSelectedInvoicePrintMode] = useState(null);
  const [cancelDraft, setCancelDraft] = useState(null);
  const [posRefreshToken, setPosRefreshToken] = useState(0);
  const [editingSale, setEditingSale] = useState(null);
  const [saleEditLoading, setSaleEditLoading] = useState(false);
  const [saleEditError, setSaleEditError] = useState("");
  const [changeHistory, setChangeHistory] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [exitCodeModalOpen, setExitCodeModalOpen] = useState(false);
  const [exitCodeInput, setExitCodeInput] = useState("");
  const [exitCodeError, setExitCodeError] = useState("");
  const [exitAttemptCount, setExitAttemptCount] = useState(0);
  const [loginDeviceControlSettings, setLoginDeviceControlSettings] = useState(defaultDeviceControlSettings);
  const [accountLedgerFocusKey, setAccountLedgerFocusKey] = useState("");

  useEffect(() => {
    const normalized = normalizeApplicationFontSize(applicationFontSize);
    document.documentElement.dataset.appFontSize = normalized.toLowerCase().replace("_", "-");
    try {
      localStorage.setItem(APPLICATION_FONT_SIZE_STORAGE_KEY, normalized);
    } catch {
      // Device-local accessibility preference only; ignore locked storage.
    }
  }, [applicationFontSize]);
  useEffect(() => {
    try {
      localStorage.setItem(FROST_ACTIVE_TAB_STORAGE_KEY, frostActiveTab);
    } catch {
      // Device-local FROST preference only.
    }
  }, [frostActiveTab]);
  useEffect(() => {
    try {
      localStorage.setItem(FROST_RECENT_CONVERSATION_STORAGE_KEY, JSON.stringify((aiAssistantData.history || []).slice(0, 20)));
    } catch {
      // Device-local FROST conversation cache only.
    }
  }, [aiAssistantData.history]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setFrostDrawerOpen(false);
        setCommandPaletteOpen(false);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        const target = event.target;
        const isEditing = ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName) || target?.isContentEditable;
        if (isEditing) return;
        event.preventDefault();
        if (user) setCommandPaletteOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [user]);

  useEffect(() => {
    if (!user || !frostDrawerOpen) return;
    loadAiAssistant(aiRange);
  }, [user, frostDrawerOpen]);

  useEffect(() => {
    const updateInternetStatus = () => {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setInternetAvailable(false);
      }
    };
    window.addEventListener("online", updateInternetStatus);
    window.addEventListener("offline", updateInternetStatus);
    updateInternetStatus();
    return () => {
      window.removeEventListener("online", updateInternetStatus);
      window.removeEventListener("offline", updateInternetStatus);
    };
  }, []);

  const connectionStatus = buildConnectionStatusModel({ backendHealth, cloudHealth, deviceRegistration: cloudDeviceRegistration, syncStatus, internetAvailable, currentUser: user });

  useEffect(() => {
    const fullscreenEnabled = settingsData.deviceControlSettings?.fullscreen_lock_enabled === true;
    invokeTauriCommand("set_kiosk_mode", { enabled: fullscreenEnabled }).catch((error) => {
      if (fullscreenEnabled) writeDiagnosticLog("ERROR", "Unable to apply fullscreen lock mode", { error: String(error?.message || error) });
    });
  }, [settingsData.deviceControlSettings?.fullscreen_lock_enabled]);

  useEffect(() => {
    if (user) return undefined;
    let cancelled = false;
    const loadLoginDeviceControl = async () => {
      try {
        const response = await axios.get(`${API_URL}/settings`, { params: { device_id: deviceInfo.device_id } });
        if (cancelled) return;
        const nextSettings = { ...defaultDeviceControlSettings, ...(response.data?.deviceControlSettings || {}) };
        setLoginDeviceControlSettings(nextSettings);
        await invokeTauriCommand("set_kiosk_mode", { enabled: nextSettings.fullscreen_lock_enabled === true });
      } catch {
        if (!cancelled) setLoginDeviceControlSettings(defaultDeviceControlSettings);
      }
    };
    loadLoginDeviceControl();
    return () => {
      cancelled = true;
    };
  }, [user, deviceInfo.device_id]);

  useEffect(() => {
    let unlisten = () => {};
    listenTauriEvent("kiosk-exit-required", () => {
      setExitCodeError("");
      setExitCodeInput("");
      setExitCodeModalOpen(true);
    }).then((cleanup) => {
      unlisten = cleanup;
    }).catch(() => {});
    return () => unlisten();
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const requestedView = new URLSearchParams(window.location.search).get("view");
      if (requestedView && navigationItems.some(([view]) => view === requestedView)) {
        setActiveView(requestedView);
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    initializeLocalDatabase().then(async (status) => {
      if (cancelled) return;
      setLocalDbStatus(status);
      if (!isTauriRuntime()) return;
      const identity = await getOrCreateLocalDeviceIdentity().catch(() => null);
      if (!identity?.device_id || cancelled) return;
      localStorage.setItem("froozerp_device_id", identity.device_id);
      if (identity.device_name) localStorage.setItem("froozerp_device_name", identity.device_name);
      setDeviceInfo((current) => ({
        ...current,
        device_id: identity.device_id,
        device_name: identity.device_name || current.device_name,
        device_type: identity.platform || current.device_type,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshSyncStatus = async () => {
    const status = await getSyncStatus();
    setSyncStatus(status);
    return status;
  };

  const checkCloudBackendHealth = async (reason = "manual", timeoutMs = 5000) => {
    if (FROOZERP_CLOUD_SIMULATED_OFFLINE) {
      const paused = {
        apiUrl: CLOUD_API_URL,
        url: CLOUD_API_URL ? `${CLOUD_API_URL}/api/health` : "",
        online: false,
        checking: false,
        reachabilityStatus: "paused",
        status: "paused",
        httpStatus: null,
        reason,
        reasonCode: "APP_SIMULATED_OFFLINE",
        message: "FroozERP cloud access is disabled by the Owner.",
        lastCheckedAt: new Date().toISOString(),
      };
      setCloudHealth(paused);
      return paused;
    }
    if (!CLOUD_CONFIGURED) {
      const notConfigured = {
        apiUrl: CLOUD_API_URL,
        url: CLOUD_API_URL ? `${CLOUD_API_URL}/api/health` : "",
        online: false,
        checking: false,
        reachabilityStatus: "not_configured",
        status: "not_configured",
        httpStatus: null,
        reason,
        reasonCode: "CLOUD_NOT_CONFIGURED",
        message: "Cloud backend is not configured.",
        lastCheckedAt: new Date().toISOString(),
      };
      setCloudHealth(notConfigured);
      return notConfigured;
    }
    const url = `${CLOUD_API_URL}/api/health`;
    try {
      const response = await axios.get(url, { timeout: timeoutMs, headers: { "Cache-Control": "no-store" }, params: { t: Date.now() } });
      const health = response.data || {};
      const identityOk = health.app === "FroozERP" && String(health.api_version) === "1" && health.deployment_type === "cloud";
      const online = response.status >= 200 && response.status < 300 && String(health.status || "").toLowerCase() === "ok" && identityOk;
      const next = {
        apiUrl: CLOUD_API_URL,
        url,
        online,
        checking: false,
        reachabilityStatus: online ? "online" : "server_error",
        status: online ? "online" : "server_error",
        httpStatus: response.status,
        reason,
        reasonCode: online ? "ONLINE" : "CLOUD_IDENTITY_INVALID",
        message: online ? "FroozERP cloud backend is reachable." : "Cloud responded, but FroozERP cloud identity is incomplete.",
        data: health,
        lastCheckedAt: new Date().toISOString(),
        lastOnlineAt: online ? new Date().toISOString() : cloudHealth.lastOnlineAt,
        lastErrorAt: online ? cloudHealth.lastErrorAt : new Date().toISOString(),
      };
      setCloudHealth(next);
      return next;
    } catch (error) {
      const next = {
        apiUrl: CLOUD_API_URL,
        url,
        online: false,
        checking: false,
        reachabilityStatus: error.response ? "server_error" : "offline",
        status: error.response ? "server_error" : "offline",
        httpStatus: error.response?.status || null,
        reason,
        reasonCode: error.response ? "HTTP_FAILURE" : "BACKEND_UNAVAILABLE",
        message: error.response?.data?.message || error.message || "Cloud backend is unavailable.",
        lastCheckedAt: new Date().toISOString(),
        lastErrorAt: new Date().toISOString(),
      };
      setCloudHealth(next);
      return next;
    }
  };

  const registerCloudDevice = async (currentUser = user, latestDevice = deviceInfo) => {
    if (FROOZERP_CLOUD_SIMULATED_OFFLINE) {
      const registration = {
        status: "PAUSED",
        code: "APP_SIMULATED_OFFLINE",
        message: "FroozERP cloud access is disabled by the Owner.",
        checkedAt: new Date().toISOString(),
      };
      setCloudDeviceRegistration(registration);
      return registration;
    }
    if (!CLOUD_CONFIGURED || !currentUser?.id || !latestDevice?.device_id) return null;
    const payload = {
      device_id: latestDevice.device_id,
      device_name: latestDevice.device_name || "FroozERP Device",
      platform: "tauri-windows",
      app_version: APP_VERSION,
      branch_id: currentUser.branch_id || 1,
      user_id: currentUser.id,
      role: currentUser.role_name || currentUser.role || "",
      app_mode: API_MODE,
      company_id: CONFIGURED_COMPANY_ID || "1",
      sub_branch_id: CONFIGURED_SUB_BRANCH_ID || "",
      cloud_api_url: CLOUD_API_URL,
      local_api_url: LOCAL_API_URL,
    };
    try {
      const response = await axios.post(`${CLOUD_API_URL}/api/sync/register-device`, payload, { timeout: 8000 });
      const registration = { ...(response.data || {}), url: `${CLOUD_API_URL}/api/sync/register-device`, httpStatus: response.status, checkedAt: new Date().toISOString() };
      setCloudDeviceRegistration(registration);
      return registration;
    } catch (error) {
      const registration = {
        status: "ERROR",
        url: `${CLOUD_API_URL}/api/sync/register-device`,
        httpStatus: error.response?.status || null,
        message: error.response?.data?.message || error.message || "Cloud device registration failed.",
        checkedAt: new Date().toISOString(),
      };
      setCloudDeviceRegistration(registration);
      return registration;
    }
  };

  const runCloudDiagnostics = async () => {
    const startedAt = new Date().toISOString();
    const safeError = (error) => ({
      httpStatus: error.response?.status || null,
      message: error.response?.data?.message || error.message || "Request failed",
    });
    const check = async (label, url, action) => {
      const started = Date.now();
      try {
        const result = await action();
        return {
          label,
          ok: true,
          url,
          httpStatus: result?.status || result?.httpStatus || 200,
          message: result?.message || "OK",
          durationMs: Date.now() - started,
        };
      } catch (error) {
        const safe = safeError(error);
        return {
          label,
          ok: false,
          url,
          httpStatus: safe.httpStatus,
          message: safe.message,
          durationMs: Date.now() - started,
        };
      }
    };
    const latestDevice = await resolveLocalDeviceInfo(deviceInfo);
    const localHealthUrl = `${LOCAL_API_URL}/api/health`;
    const cloudHealthUrl = `${CLOUD_API_URL}/api/health`;
    const results = [];
    results.push(await check("Internet", "https://www.gstatic.com/generate_204", async () => {
      const reachable = await probeRealInternet(5000);
      if (!reachable) throw new Error("Internet probe failed");
      return { status: 200, message: "Internet reachable" };
    }));
    results.push(await check("Local /api/health", localHealthUrl, async () => {
      const response = await axios.get(localHealthUrl, { timeout: 5000, headers: { "Cache-Control": "no-store" } });
      return { status: response.status, message: response.data?.status === "ok" ? "Local backend healthy" : "Local backend health did not report ok" };
    }));
    if (FROOZERP_CLOUD_SIMULATED_OFFLINE) {
      const pausedMessage = "APP_SIMULATED_OFFLINE - FroozERP cloud access is disabled by the Owner.";
      results.push({ label: "Railway /api/health", ok: false, url: cloudHealthUrl, httpStatus: null, message: pausedMessage, durationMs: 0 });
      results.push({ label: "Railway authentication", ok: false, url: `${CLOUD_API_URL}/login`, httpStatus: null, message: pausedMessage, durationMs: 0 });
      results.push({ label: "Device registration/approval", ok: false, url: `${CLOUD_API_URL}/api/sync/register-device`, httpStatus: null, message: pausedMessage, durationMs: 0 });
    } else {
      results.push(await check("Railway /api/health", cloudHealthUrl, async () => {
        const response = await axios.get(cloudHealthUrl, { timeout: 7000, headers: { "Cache-Control": "no-store" } });
        return { status: response.status, message: response.data?.status === "ok" ? "Cloud backend healthy" : "Cloud backend health did not report ok" };
      }));
      results.push(await check("Railway authentication", `${CLOUD_API_URL}/login`, async () => ({
        status: user?.id ? 200 : 401,
        message: user?.id ? `Signed in as user ${user.id}` : "No active local session for cloud diagnostics",
      })));
      results.push(await check("Device registration/approval", `${CLOUD_API_URL}/api/sync/register-device`, async () => {
        const registration = await registerCloudDevice(user, latestDevice);
        return { httpStatus: registration?.httpStatus || 200, message: registration?.message || `Device ${registration?.status || "not checked"}` };
      }));
    }
    results.push(await check("FROST briefing endpoint", `${LOCAL_API_URL}/api/ai/briefing`, async () => {
      const response = await axios.get(`${LOCAL_API_URL}/api/ai/briefing`, {
        timeout: 8000,
        params: { user_id: user?.id, device_id: latestDevice.device_id, range: aiRange },
      });
      const cards = response.data?.cards || {};
      return { status: response.status, message: `FROST briefing loaded with ${Object.keys(cards).length} card groups` };
    }));
    const status = await getSyncStatus();
    setSyncStatus(status);
    results.push({
      label: "Pending sync count",
      ok: true,
      url: "local SQLite sync_outbox",
      httpStatus: null,
      message: `${Number(status.pendingOperations || 0)} pending, ${Number(status.failedOperations || 0)} failed`,
      durationMs: 0,
    });
    results.push({
      label: "Last sync result",
      ok: !status.lastError,
      url: SYNC_API_URL,
      httpStatus: status.lastHttpStatus || null,
      message: status.lastError || status.lastSuccessfulSyncAt || "No successful sync recorded yet",
      durationMs: 0,
    });
    setCloudDiagnostics({ startedAt, finishedAt: new Date().toISOString(), results });
    const nextCloud = await checkCloudBackendHealth("cloud-diagnostics", 7000);
    setStartupNotice(buildConnectionStatusModel({
      backendHealth,
      cloudHealth: nextCloud,
      deviceRegistration: cloudDeviceRegistration,
      syncStatus: status,
      internetAvailable,
      currentUser: user,
    }).banner);
    return results;
  };

  const userRef = useRef(user);
  const deviceInfoRef = useRef(deviceInfo);
  const syncStatusRef = useRef(syncStatus);
  const reconnectSyncRef = useRef(false);
  const lastAutoSyncStartedAtRef = useRef(0);
  const shouldStartBackgroundSync = () => {
    const now = Date.now();
    if (now - lastAutoSyncStartedAtRef.current < 30_000) return false;
    lastAutoSyncStartedAtRef.current = now;
    return true;
  };

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  useEffect(() => {
    deviceInfoRef.current = deviceInfo;
  }, [deviceInfo]);

  useEffect(() => {
    syncStatusRef.current = syncStatus;
  }, [syncStatus]);

  const runSyncNow = async (options = {}) => {
    if (!user) return null;
    const force = Boolean(options.force);
    if (!force && !shouldStartBackgroundSync()) return syncStatus;
    if (FROOZERP_CLOUD_SIMULATED_OFFLINE) {
      const status = {
        ...(await getSyncStatus()),
        online: false,
        syncing: false,
        lastFailureKind: "APP_SIMULATED_OFFLINE",
        lastError: "FroozERP cloud access is disabled by the Owner.",
        apiUrl: SYNC_API_URL,
      };
      setSyncStatus(status);
      setSyncMessage("Sync paused - FroozERP cloud access is disabled by the Owner.");
      return status;
    }
    if (force) lastAutoSyncStartedAtRef.current = Date.now();
    setSyncMessage("Syncing...");
    const status = await syncNow({
      apiUrl: SYNC_API_URL,
      user,
      deviceInfo,
      branchId: user.branch_id || 1,
    });
    setSyncStatus(status);
    const nextStatus = buildConnectionStatusModel({ backendHealth, cloudHealth, deviceRegistration: cloudDeviceRegistration, syncStatus: status, internetAvailable, currentUser: user });
    setSyncMessage(status.lastError ? `Sync failed: ${status.lastError}` : nextStatus.syncSummary);
    return status;
  };

  const applyConnectivityState = useCallback((health, statusInternetAvailable = internetAvailable, statusSyncStatus = syncStatusRef.current) => {
    setBackendHealth(health);
    if (health.online === null || health.checking) return;
    setOfflineMode(!health.online);
    if (health.online) {
      setStartupError((current) => {
        if (!current) return "";
        const recoverable = /backend|network|internet|offline|connect/i.test(current);
        return recoverable ? "" : current;
      });
      setStartupNotice((current) => (
        /offline|local sqlite|sync changes later|online login succeeded|local reference data/i.test(current || "")
          ? buildConnectionStatusModel({ backendHealth: health, cloudHealth, deviceRegistration: cloudDeviceRegistration, syncStatus: statusSyncStatus, internetAvailable: statusInternetAvailable, currentUser: userRef.current }).banner
          : current || buildConnectionStatusModel({ backendHealth: health, cloudHealth, deviceRegistration: cloudDeviceRegistration, syncStatus: statusSyncStatus, internetAvailable: statusInternetAvailable, currentUser: userRef.current }).banner
      ));
    } else {
      setStartupNotice("Offline mode is active. FroozERP loaded your local SQLite data and will sync changes later.");
      setSyncMessage("Offline - backend unavailable. Changes will sync later.");
    }
  }, [internetAvailable]);

  const ensureLocalBackendService = useCallback(async ({ restart = false, reason = "manual" } = {}) => {
    if (!isTauriRuntime() || isCloudMode()) return null;
    const command = restart ? "restart_local_backend_service" : "ensure_local_backend_service";
    try {
      const service = await invokeTauriCommand(command);
      setLocalBackendService({ ...service, reason, checkedAt: new Date().toISOString() });
      if (service?.healthy) {
        setStartupNotice(restart ? "Local FroozERP service restarted." : "Local FroozERP service is running.");
        setStartupError((current) => (/local backend|froozERP service|backend/i.test(current) ? "" : current));
      } else {
        setStartupError(service?.message || "Local FroozERP service stopped. Restart service.");
      }
      return service;
    } catch (error) {
      const message = getErrorMessage(error, "Unable to start local FroozERP service.");
      setLocalBackendService({ healthy: false, message, reason, checkedAt: new Date().toISOString() });
      setStartupError(message);
      return null;
    }
  }, []);

  const performConnectivityCheck = useCallback(async (reason = "manual", options = {}) => {
    if (isTauriRuntime() && !isCloudMode() && options.skipServiceStart !== true) {
      const service = await ensureLocalBackendService({ reason });
      if (service?.healthy) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
      }
    }
    const browserOnline = typeof navigator === "undefined" ? true : navigator.onLine !== false;
    const realInternet = browserOnline ? await probeRealInternet(options.timeoutMs || 4000) : false;
    setInternetAvailable(realInternet);
    const health = await checkBackendHealth(API_URL, {
      details: true,
      timeoutMs: options.timeoutMs || 3500,
      force: Boolean(options.force),
      reason,
      requireCloudIdentity: isCloudMode(),
    });
    const nextCloudHealth = usesCloudBackend()
      ? await checkCloudBackendHealth(reason, options.timeoutMs || 5000)
      : cloudHealth;
    applyConnectivityState(health, realInternet, syncStatusRef.current);
    const cloudReadyForSync = !usesCloudBackend() || nextCloudHealth?.online === true;
    if (health.online && cloudReadyForSync && userRef.current && !reconnectSyncRef.current && shouldStartBackgroundSync()) {
      reconnectSyncRef.current = true;
      syncNow({
        apiUrl: SYNC_API_URL,
        user: userRef.current,
        deviceInfo: deviceInfoRef.current,
        branchId: userRef.current.branch_id || 1,
        })
        .then((status) => {
          setSyncStatus(status);
          const nextStatus = buildConnectionStatusModel({ backendHealth: health, cloudHealth: nextCloudHealth, deviceRegistration: cloudDeviceRegistration, syncStatus: status, internetAvailable: realInternet, currentUser: userRef.current });
          setSyncMessage(status.lastError ? `Sync failed: ${status.lastError}` : nextStatus.syncSummary);
        })
        .finally(() => {
          reconnectSyncRef.current = false;
        });
    }
    return health;
  }, [applyConnectivityState, ensureLocalBackendService]);

  useEffect(() => subscribeConnectivity(applyConnectivityState), [applyConnectivityState]);

  useEffect(() => {
    performConnectivityCheck("startup", { force: true });
    const handleConnectivityEvent = (event) => {
      if (event.type === "visibilitychange" && document.hidden) return;
      performConnectivityCheck(event.type, { force: true });
    };
    for (const eventName of connectivityEventNames) {
      const target = eventName === "visibilitychange" ? document : window;
      target.addEventListener(eventName, handleConnectivityEvent);
    }
    const timer = window.setInterval(() => {
      performConnectivityCheck(backendHealth.online ? "periodic-online" : "periodic-offline");
    }, 15_000);
    return () => {
      window.clearInterval(timer);
      for (const eventName of connectivityEventNames) {
        const target = eventName === "visibilitychange" ? document : window;
        target.removeEventListener(eventName, handleConnectivityEvent);
      }
    };
  }, [backendHealth.online, performConnectivityCheck]);

  const queuePhase2SyncTest = async () => {
    if (!user) return;
    try {
      const entityId = await queueSafeSyncTest({
        value: `Phase 2 sync test ${new Date().toISOString()}`,
        user,
        deviceInfo,
        branchId: user.branch_id || 1,
      });
      setSyncMessage(`Queued safe sync test ${entityId}`);
      await refreshSyncStatus();
    } catch (error) {
      setSyncMessage(getErrorMessage(error, "Unable to queue safe sync test"));
    }
  };

  const retrySyncFailures = async () => {
    const status = await retryFailedOperations();
    setSyncStatus(status);
    setSyncMessage("Failed sync operations moved back to pending");
  };

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    refreshSyncStatus().then((status) => {
      if (!cancelled) setSyncStatus(status);
    });
    const timer = window.setInterval(() => {
      if (backendHealth.online) runSyncNow();
    }, 60_000);
    if (backendHealth.online) runSyncNow();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [user, deviceInfo.device_id, backendHealth.online, performConnectivityCheck]);

  const rolePermissionMap = useMemo(() => {
    const map = new Map();
    for (const role of settingsData.roles || []) map.set(role.role_name || role.role, role.permissions || {});
    return map;
  }, [settingsData.roles]);

  const hasModuleAccess = (view) => {
    if (!user) return false;
    const roleName = user.role;
    const permissions = rolePermissionMap.get(roleName);
    if (view === "dashboard") {
      if (roleName === "Owner") return true;
      if (permissions && Object.prototype.hasOwnProperty.call(permissions, "dashboard")) return Boolean(permissions.dashboard);
      return roleName === "Admin";
    }
    const defaultPermissions = defaultRolePermissions[roleName] || {};
    if (defaultPermissions.all || defaultPermissions[view]) return true;
    const permissionKey = modulePermissionMap[view];
    if (view === "accounts" && permissions) {
      return Boolean(permissions.customer_payments || permissions.supplier_payments || permissions.supplier_accounts);
    }
    if (!permissions || !permissionKey) return false;
    return Boolean(permissions[permissionKey]);
  };

  const hasRolePermission = (permissionKey) => {
    if (!user) return false;
    if (user.role === "Owner") return true;
    const permissions = rolePermissionMap.get(user.role);
    if (permissions && Object.prototype.hasOwnProperty.call(permissions, permissionKey)) {
      return Boolean(permissions[permissionKey]);
    }
    return ["Admin"].includes(user.role) && ["manual_pos_rate_override", "pos_date_override"].includes(permissionKey);
  };

  const requestControlledExit = async () => {
    let fullscreenEnabled = Boolean(user
      ? settingsData.deviceControlSettings?.fullscreen_lock_enabled
      : loginDeviceControlSettings?.fullscreen_lock_enabled);
    if (!user) {
      try {
        const response = await axios.get(`${API_URL}/settings`, {
          params: { device_id: deviceInfo.device_id },
          timeout: 5000,
        });
        const nextSettings = { ...defaultDeviceControlSettings, ...(response.data?.deviceControlSettings || {}) };
        setLoginDeviceControlSettings(nextSettings);
        fullscreenEnabled = Boolean(nextSettings.fullscreen_lock_enabled || nextSettings.require_exit_code_to_close);
      } catch {
        fullscreenEnabled = Boolean(
          loginDeviceControlSettings?.fullscreen_lock_enabled || loginDeviceControlSettings?.require_exit_code_to_close
        );
      }
    }
    if (fullscreenEnabled) {
      setExitCodeInput("");
      setExitCodeError("");
      setExitCodeModalOpen(true);
      return;
    }
    invokeTauriCommand("close_froozerp_window").catch(() => window.close());
  };

  const verifyExitCodeAndClose = async () => {
    try {
      if (exitAttemptCount >= 3) {
        await new Promise((resolve) => window.setTimeout(resolve, 800));
      }
      await axios.post(`${API_URL}/settings/device-control/verify-exit-code`, {
        user_id: user?.id || 1,
        device_id: deviceInfo.device_id,
        exit_code: exitCodeInput,
      });
      setExitCodeError("");
      setExitCodeModalOpen(false);
      setExitAttemptCount(0);
      await invokeTauriCommand("close_froozerp_window", { allowExit: true });
    } catch (error) {
      setExitAttemptCount((count) => count + 1);
      if (!error?.response) {
        setExitCodeError("Local backend is unavailable, so FroozERP cannot verify the Owner exit code. Start/reconnect the local backend, then try again.");
      } else if (error.response?.status === 409) {
        setExitCodeError(getErrorMessage(error, "No Owner exit code is configured. Open Settings > Security / Device Control and set a new code with Owner/Admin password."));
      } else if (error.response?.status === 403) {
        setExitCodeError("Invalid exit code. Owner/Admin can reset it in Settings > Security / Device Control using the current account password.");
      } else {
        setExitCodeError(getErrorMessage(error, "Unable to verify Owner exit code."));
      }
    }
  };

  const exitLockEnabled = user
    ? settingsData.deviceControlSettings?.fullscreen_lock_enabled
    : loginDeviceControlSettings?.fullscreen_lock_enabled;

  const exitCodeModal = exitCodeModalOpen && (
    <div className="modal-backdrop">
      <section className="invoice-modal change-history-modal kiosk-exit-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">Owner Exit Required</span>
            <strong>{exitLockEnabled ? "Fullscreen Lock Mode is enabled" : "Close FroozERP"}</strong>
          </div>
          <button className="remove-button" onClick={() => setExitCodeModalOpen(false)}><Icon name="close" /></button>
        </div>
        <div className="sale-edit-body">
          <p className="form-note">Enter the Owner exit code to leave fullscreen and close FroozERP. Staff cannot bypass this from the app UI.</p>
          <Field label="Exit Code">
            <input
              autoFocus
              inputMode="numeric"
              type="password"
              value={exitCodeInput}
              onChange={(event) => {
                setExitCodeInput(event.target.value.replace(/\D/g, ""));
                setExitCodeError("");
              }}
              onKeyDown={(event) => event.key === "Enter" && verifyExitCodeAndClose()}
            />
          </Field>
          {exitCodeError && <div className="error-banner">{exitCodeError}</div>}
          {exitAttemptCount >= 3 && <p className="form-note stock-low">Too many failed attempts. A short delay is applied before the next check.</p>}
          <div className="button-row">
            <button className="primary-button" disabled={!exitCodeInput || exitCodeInput.length < 4} onClick={verifyExitCodeAndClose}>Unlock and Exit</button>
            <button className="secondary-button" onClick={() => setExitCodeModalOpen(false)}>Stay in FroozERP</button>
          </div>
          <p className="form-note">Emergency note: if the exit code is forgotten, reset it from Settings &gt; Security / Device Control with the Owner/Admin password. Repair/update the app without deleting business data if Settings cannot open.</p>
        </div>
      </section>
    </div>
  );

  const getDefaultAllowedView = () => {
    const roleName = user?.role || "";
    const preferredByRole = {
      Owner: ["dashboard", "sales", "reports"],
      Admin: ["dashboard", "reports", "sales"],
      Cashier: ["sales", "pending-bills", "accounts"],
      "Purchase Manager": ["purchase", "pending-bills", "reports"],
      "Inventory Manager": ["reports", "products", "waste"],
    };
    const candidates = [...(preferredByRole[roleName] || []), ...navigationItems.map(([view]) => view)];
    return candidates.find((view) => hasModuleAccess(view) && (roleName === "Owner" || roleName === "Admin" || view !== "sale-rates")) || "sales";
  };

  useEffect(() => {
    if (!user) return;
    if (!hasModuleAccess(activeView)) {
      const fallback = getDefaultAllowedView();
      setActiveView(fallback);
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("view", fallback);
      window.history.replaceState({ view: fallback }, "", nextUrl);
    }
  }, [user, activeView, settingsData.roles]);

  const kpis = useMemo(() => {
    const today = toDateKey(new Date());
    const todaysSales = salesHistory.filter((sale) => toDateKey(sale.sale_date) === today);
    const total = (items, key) =>
      items.reduce((sum, item) => sum + Number(item[key] || 0), 0);
    const stockValue = inventory.reduce(
      (sum, item) => sum + Number(item.remaining_qty || 0) * Number(item.effective_cost_per_unit || item.purchase_rate || 0),
      0
    );
    const stockByProduct = inventory.reduce((stock, item) => {
      stock.set(item.product_name, (stock.get(item.product_name) || 0) + Number(item.remaining_qty || 0));
      return stock;
    }, new Map());
    const lowStockItems = [...stockByProduct.values()].filter((quantity) => quantity <= 5).length;
    const analyticsSummary = dashboardAnalytics.summary || {};
    const metrics = {
      todaySales: supplierDashboard.todaySales ?? total(todaysSales, "amount"),
      todayProfit: supplierDashboard.todayProfit ?? total(todaysSales, "profit"),
      stockValue: supplierDashboard.stockValue ?? stockValue,
      lowStockItems: supplierDashboard.lowStockItems ?? lowStockItems,
      transactions: supplierDashboard.transactions ?? todaysSales.length,
      supplierOutstanding: supplierDashboard.supplierOutstanding ?? supplierDashboard.total_supplier_outstanding ?? 0,
      customerOutstanding: analyticsSummary.customerOutstanding ?? supplierDashboard.customerOutstanding ?? 0,
      todayExpenses: analyticsSummary.todayExpenses ?? supplierDashboard.todayExpenses ?? 0,
      todayReturns: analyticsSummary.todayReturns ?? supplierDashboard.todayReturns ?? 0,
      monthlyReturns: analyticsSummary.monthlyReturns ?? supplierDashboard.monthlyReturns ?? 0,
      todayWaste: analyticsSummary.todayWaste ?? supplierDashboard.todayWaste ?? 0,
      monthlyWaste: analyticsSummary.monthlyWaste ?? supplierDashboard.monthlyWaste ?? 0,
      wastePercentage: analyticsSummary.wastePercentage ?? supplierDashboard.wastePercentage ?? 0,
      totalRebateReceived: supplierDashboard.totalRebateReceived ?? supplierDashboard.total_rebate_received ?? 0,
      todaySupplierPayments: supplierDashboard.todaySupplierPayments ?? supplierDashboard.todays_supplier_payments ?? 0,
    };

    return [
      ["Today's Sales", currency.format(Number(metrics.todaySales || 0)), "rupee"],
      ["Today's Profit", currency.format(Number(metrics.todayProfit || 0)), "trend"],
      ["Stock Value", currency.format(Number(metrics.stockValue || 0)), "layers"],
      ["Supplier Outstanding", currency.format(Number(metrics.supplierOutstanding || 0)), "wallet"],
      ["Customer Outstanding", currency.format(Number(metrics.customerOutstanding || 0)), "users"],
      ["Today's Expenses", currency.format(Number(metrics.todayExpenses || 0)), "wallet"],
      ["Total Rebate Received", currency.format(Number(metrics.totalRebateReceived || 0)), "trend"],
      ["Today's Supplier Payments", currency.format(Number(metrics.todaySupplierPayments || 0)), "rupee"],
      ["Today's Returns", currency.format(Number(metrics.todayReturns || 0)), "history"],
      ["Monthly Returns", currency.format(Number(metrics.monthlyReturns || 0)), "history"],
      ["Today's Waste", currency.format(Number(metrics.todayWaste || 0)), "alert"],
      ["Monthly Waste", currency.format(Number(metrics.monthlyWaste || 0)), "alert"],
      ["Waste Percentage", `${Number(metrics.wastePercentage || 0).toFixed(2)}%`, "chart"],
      ["Low Stock Items", Number(metrics.lowStockItems || 0), "alert"],
      ["Transactions", Number(metrics.transactions || 0), "receipt"],
    ];
  }, [dashboardAnalytics, inventory, salesHistory, supplierDashboard]);

  const activeSuppliers = useMemo(
    () => suppliers.filter((supplier) =>
      supplier.active !== false &&
      !["TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(supplier.supplier_type)
    ),
    [suppliers]
  );

  const selectedPurchaseProduct = useMemo(
    () => products.find((product) => String(product.id) === purchaseProductId),
    [products, purchaseProductId]
  );

  const amendmentSuppliers = useMemo(() => {
    const rows = purchases.filter((purchase) => !amendmentDate || toDateKey(purchase.purchase_date) === amendmentDate);
    return [...new Map(rows.map((purchase) => [String(purchase.supplier_id || purchase.supplier_name), purchase])).values()];
  }, [amendmentDate, purchases]);

  const amendmentPurchases = useMemo(() => purchases.filter((purchase) =>
    (!amendmentDate || toDateKey(purchase.purchase_date) === amendmentDate) &&
    (!amendmentSupplierId || String(purchase.supplier_id || "") === amendmentSupplierId)
  ), [amendmentDate, amendmentSupplierId, purchases]);

  const purchaseSummary = useMemo(() => {
    const quantity = Number(purchaseQuantity || 0);
    const rate = Number(purchaseRateInput || 0);
    if (purchaseBillStatus === "BILL_PENDING") {
      const expectedRate = Number(expectedPurchaseRate || 0);
      return {
        basicAmount: quantity * expectedRate,
        mandiTaxPercent: 0,
        mandiTaxAmount: 0,
        freightCharges: 0,
        labourCharges: 0,
        otherCharges: 0,
        grossAmount: quantity * expectedRate,
        rebatePercent: 0,
        rebateAmount: 0,
        netPayable: 0,
        balanceAmount: 0,
        effectiveCostPerUnit: expectedRate,
        paymentStatus: "Bill Pending",
      };
    }
    const otherCharges = Number(purchaseOtherCharges || 0);
    const paidAmount = purchaseType === "CASH" ? Number(purchasePaidAmount || 0) : 0;
    const freightCharges = Number(purchaseFreightCharges || 0);
    const labourCharges = Number(purchaseLabourCharges || 0);
    const mandiTaxPercent = Number(purchaseRules.mandiTaxRules.find((rule) => rule.origin_type === (selectedPurchaseProduct?.origin_type || "LOCAL"))?.tax_percent || 0);
    const rebateRule = purchaseRules.rebateRules.find((rule) => String(rule.id) === purchaseRebateRuleId);
    const rebatePercent = Number(rebateRule?.rebate_percent || 0);
    const basicAmount = quantity * rate;
    const mandiTaxAmount = basicAmount * mandiTaxPercent / 100;
    const grossAmount = basicAmount + mandiTaxAmount + freightCharges + labourCharges + otherCharges;
    const rebateAmount = grossAmount * rebatePercent / 100;
    const netPayable = grossAmount - rebateAmount;
    return {
      basicAmount,
      mandiTaxPercent,
      mandiTaxAmount,
      freightCharges,
      labourCharges,
      otherCharges,
      grossAmount,
      rebatePercent,
      rebateAmount,
      netPayable,
      balanceAmount: Math.max(netPayable - paidAmount, 0),
      effectiveCostPerUnit: quantity > 0 ? netPayable / quantity : 0,
      paymentStatus: netPayable > 0 && paidAmount >= netPayable ? "Paid" : paidAmount > 0 ? "Partial" : "Pending",
    };
  }, [expectedPurchaseRate, purchaseBillStatus, purchaseFreightCharges, purchaseLabourCharges, purchaseOtherCharges, purchasePaidAmount, purchaseQuantity, purchaseRateInput, purchaseRebateRuleId, purchaseRules, purchaseType, selectedPurchaseProduct]);

  const purchaseCartSummary = useMemo(() => {
    const items = editingPurchaseId ? [{
      quantity: Number(purchaseQuantity || 0),
      purchase_rate: Number(purchaseRateInput || 0),
      expected_purchase_rate: Number(expectedPurchaseRate || 0),
      origin_type: selectedPurchaseProduct?.origin_type || "LOCAL",
    }] : purchaseCart;
    const itemCount = items.length;
    const receivedQuantity = items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    if (purchaseBillStatus === "BILL_PENDING") {
      const provisionalCost = items.reduce(
        (sum, item) => sum + Number(item.quantity || 0) * Number(item.expected_purchase_rate || 0),
        0
      );
      return {
        itemCount,
        receivedQuantity,
        basicAmount: provisionalCost,
        mandiTaxPercent: 0,
        mandiTaxAmount: 0,
        freightCharges: 0,
        labourCharges: 0,
        otherCharges: 0,
        grossAmount: provisionalCost,
        rebatePercent: 0,
        rebateAmount: 0,
        netPayable: 0,
        balanceAmount: 0,
        effectiveCostPerUnit: receivedQuantity > 0 ? provisionalCost / receivedQuantity : 0,
        paymentStatus: "Bill Pending",
      };
    }
    const basicAmount = items.reduce(
      (sum, item) => sum + Number(item.quantity || 0) * Number(item.purchase_rate || 0),
      0
    );
    const mandiTaxAmount = items.reduce((sum, item) => {
      const origin = item.origin_type || "LOCAL";
      const rule = purchaseRules.mandiTaxRules.find((taxRule) => taxRule.origin_type === origin);
      return sum + Number(item.quantity || 0) * Number(item.purchase_rate || 0) * Number(rule?.tax_percent || 0) / 100;
    }, 0);
    const freightCharges = Number(purchaseFreightCharges || 0);
    const labourCharges = Number(purchaseLabourCharges || 0);
    const otherCharges = Number(purchaseOtherCharges || 0);
    const grossAmount = basicAmount + mandiTaxAmount + freightCharges + labourCharges + otherCharges;
    const rebateRule = purchaseRules.rebateRules.find((rule) => String(rule.id) === purchaseRebateRuleId);
    const rebatePercent = Number(rebateRule?.rebate_percent || 0);
    const rebateAmount = grossAmount * rebatePercent / 100;
    const netPayable = grossAmount - rebateAmount;
    const paidAmount = purchaseType === "CASH" ? Number(purchasePaidAmount || 0) : 0;
    return {
      itemCount,
      receivedQuantity,
      basicAmount,
      mandiTaxPercent: "Mixed",
      mandiTaxAmount,
      freightCharges,
      labourCharges,
      otherCharges,
      grossAmount,
      rebatePercent,
      rebateAmount,
      netPayable,
      balanceAmount: Math.max(netPayable - paidAmount, 0),
      effectiveCostPerUnit: receivedQuantity > 0 ? netPayable / receivedQuantity : 0,
      paymentStatus: netPayable > 0 && paidAmount >= netPayable ? "Paid" : paidAmount > 0 ? "Partial" : "Pending",
    };
  }, [editingPurchaseId, expectedPurchaseRate, purchaseBillStatus, purchaseCart, purchaseFreightCharges, purchaseLabourCharges, purchaseOtherCharges, purchasePaidAmount, purchaseQuantity, purchaseRateInput, purchaseRebateRuleId, purchaseRules, purchaseType, selectedPurchaseProduct]);

  const applySettingsBundle = (bundle = {}) => {
    const nextSaleRateSettings = { ...defaultSaleRateSettings, ...(bundle.saleRateSettings || {}) };
    setSettingsData({
      businessSettings: { ...defaultBusinessSettings, ...(bundle.businessSettings || {}) },
      saleRateSettings: nextSaleRateSettings,
      posSettings: { ...defaultPosSettings, ...(bundle.posSettings || {}) },
      paymentSettings: { ...defaultPaymentSettings, ...(bundle.paymentSettings || {}) },
      whatsappSettings: { ...defaultWhatsappSettings, ...(bundle.whatsappSettings || {}) },
      deviceControlSettings: { ...defaultDeviceControlSettings, ...(bundle.deviceControlSettings || {}) },
      discountRules: bundle.discountRules || [],
      roles: bundle.roles || [],
      users: bundle.users || [],
      updateCenter: bundle.updateCenter || {},
      syncSettings: bundle.syncSettings || {},
      backupSettings: bundle.backupSettings || {},
      backupLogs: bundle.backupLogs || [],
      exitAttemptLogs: bundle.exitAttemptLogs || [],
      authorizedDevices: bundle.authorizedDevices || [],
      activationCodes: bundle.activationCodes || [],
      branches: bundle.branches || [],
      counters: bundle.counters || [],
      systemInfo: bundle.systemInfo || {},
      canManageSettings: Boolean(bundle.canManageSettings),
    });
    setSettingsRules({
      mandiTaxRules: bundle.mandiTaxRules || [],
      rebateRules: bundle.rebateRules || [],
    });
    setDiscountRules((bundle.discountRules || []).filter((rule) => rule.active !== false));
    setLotDiscounts(bundle.lotDiscounts || []);
    setProductDuplicateWarning(bundle.productDuplicateWarning || "");
    setSaleRates(bundle.saleRates || []);
    setSaleRateHistory(bundle.saleRateHistory || []);
    setSaleDesiredMargin(String(nextSaleRateSettings.desired_margin_percent || 25));
  };

  const applyReferenceSnapshot = async (snapshot, { offline = false, nextView = null } = {}) => {
    const bundle = snapshot?.settings_bundle || {};
    setProducts(snapshot?.products || []);
    setProductCategories(snapshot?.categories || []);
    setInventory(snapshot?.inventory_lots || []);
    setCustomers(snapshot?.customers || []);
    setSalesHistory(snapshot?.sales_history || []);
    applySettingsBundle(bundle);
    setOfflineMode(offline);
    setOfflineReady(Boolean(snapshot?.reference_ready));
    setLastReferenceSyncAt(snapshot?.last_successful_sync_at || "");
    setSyncStatus((current) => ({
      ...(current || {}),
      online: !offline,
      syncing: false,
      pendingOperations: Number(snapshot?.pending_operations ?? current?.pendingOperations ?? 0),
      failedOperations: Number(snapshot?.failed_operations ?? current?.failedOperations ?? 0),
      conflictOperations: Number(snapshot?.conflict_operations ?? current?.conflictOperations ?? 0),
      lastSuccessfulSyncAt: snapshot?.last_successful_sync_at || current?.lastSuccessfulSyncAt || "",
      lastPushAt: current?.lastPushAt || "",
      lastPullAt: current?.lastPullAt || "",
      currentCursor: current?.currentCursor || "0",
      lastError: "",
    }));
    if (nextView) setActiveView(nextView);
    if (offline) {
      setSyncMessage("Offline - changes will sync later");
      setStartupNotice("Offline mode is active. FroozERP loaded your local SQLite data and will sync changes later.");
    } else {
      setSyncMessage("");
    }
  };

  const fetchOnlineReferenceSnapshot = async (currentUser, latestDevice) => {
    const [
      productsResponse,
      categoriesResponse,
      settingsResponse,
      inventoryResponse,
      customersResponse,
      salesResponse,
      duplicateLogResponse,
      lotDiscountsResponse,
    ] = await Promise.all([
      axios.get(`${API_URL}/products`),
      axios.get(`${API_URL}/product-categories`),
      axios.get(`${API_URL}/settings`, { params: { user_id: currentUser?.id, device_id: latestDevice.device_id } }),
      axios.get(`${API_URL}/inventory`, { params: { include_cancelled: true } }),
      axios.get(`${API_URL}/customers`),
      axios.get(`${API_URL}/sales`),
      axios.get(`${API_URL}/product-duplicate-archive-log`).catch(() => ({ data: { message: "" } })),
      axios.get(`${API_URL}/lot-discounts`).catch(() => ({ data: [] })),
    ]);

    const settingsPayload = settingsResponse.data || {};
    const branchId = String(currentUser?.branch_id || 1);
    const branchRecord = (settingsPayload.branches || []).find((row) => String(row.id) === branchId);

    return {
      cached_at: new Date().toISOString(),
      last_successful_sync_at: new Date().toISOString(),
      branch_context: {
        branch_id: branchId,
        branch_name: branchRecord?.branch_name || currentUser?.branch || "Main Branch",
      },
      user_profile: currentUser,
      device_identity: {
        ...latestDevice,
        platform: "tauri-windows",
        app_version: APP_VERSION,
        branch_id: branchId,
        registration_status: "approved",
      },
      products: productsResponse.data || [],
      categories: categoriesResponse.data || [],
      inventory_lots: inventoryResponse.data || [],
      customers: customersResponse.data || [],
      sales_history: salesResponse.data || [],
      settings_bundle: {
        businessSettings: settingsPayload.businessSettings || {},
        saleRateSettings: settingsPayload.saleRateSettings || {},
        posSettings: settingsPayload.posSettings || {},
        paymentSettings: settingsPayload.paymentSettings || {},
        deviceControlSettings: settingsPayload.deviceControlSettings || {},
        discountRules: settingsPayload.discountRules || [],
        roles: settingsPayload.roles || [],
        users: settingsPayload.users || [],
        updateCenter: settingsPayload.updateCenter || {},
        syncSettings: settingsPayload.syncSettings || {},
        backupSettings: settingsPayload.backupSettings || {},
        backupLogs: settingsPayload.backupLogs || [],
        exitAttemptLogs: settingsPayload.exitAttemptLogs || [],
        authorizedDevices: settingsPayload.authorizedDevices || [],
        activationCodes: settingsPayload.activationCodes || [],
        branches: settingsPayload.branches || [],
        counters: settingsPayload.counters || [],
        systemInfo: settingsPayload.systemInfo || {},
        canManageSettings: Boolean(settingsPayload.canManageSettings),
        mandiTaxRules: settingsPayload.mandiTaxRules || [],
        rebateRules: settingsPayload.rebateRules || [],
        lotDiscounts: lotDiscountsResponse.data || [],
        productDuplicateWarning: duplicateLogResponse.data?.message || "",
      },
    };
  };

  const hydrateOnlineSession = async (currentUser, latestDevice) => {
    const snapshot = await fetchOnlineReferenceSnapshot(currentUser, latestDevice);
    await applyReferenceSnapshot(snapshot, { offline: false, nextView: initialView });
    try {
      const offlineSession = await cacheOfflineSession({
        username,
        password,
        user: currentUser,
        deviceId: latestDevice.device_id,
        branchId: currentUser?.branch_id || 1,
        lastSuccessfulSyncAt: snapshot.last_successful_sync_at,
      });
      if (isTauriRuntime()) {
        const status = await cacheLocalReferenceSnapshot({
          ...snapshot,
          offline_auth: offlineSession,
        });
        setLocalDbStatus(status);
      }
    } catch (cacheError) {
      console.warn("Online login succeeded but local reference caching failed", cacheError);
    }
    setStartupNotice(buildConnectionStatusModel({
      backendHealth: { ...backendHealth, online: true },
      cloudHealth,
      deviceRegistration: cloudDeviceRegistration,
      syncStatus,
      internetAvailable,
      currentUser,
    }).banner);
    return snapshot;
  };

  const continueOffline = async (latestDevice = deviceInfo) => {
    latestDevice = await resolveLocalDeviceInfo(latestDevice || getClientDeviceInfo());
    const snapshot = await loadLocalReferenceSnapshot({
      username,
      deviceId: latestDevice.device_id,
    }).catch(() => null);
    const cachedOfflineRecord = hasObjectContent(snapshot?.offline_auth)
      ? snapshot.offline_auth
      : readOfflineSession();
    const offlineAuth = cachedOfflineRecord
      ? await verifyOfflineSessionRecord(cachedOfflineRecord, {
        username,
        password,
        deviceId: latestDevice.device_id,
      })
      : await authenticateOfflineSession({
        username,
        password,
        deviceId: latestDevice.device_id,
      });
    if (!offlineAuth.ok) {
      setStartupError(offlineAuth.message);
      return false;
    }
    if (!snapshot?.reference_ready) {
      setOfflineReady(false);
      setLastReferenceSyncAt(snapshot?.last_successful_sync_at || offlineAuth.session?.lastSuccessfulSyncAt || "");
      setStartupError("This device must connect to the internet once before offline use.");
      return false;
    }
    const offlineUser = hasObjectContent(snapshot?.user_profile)
      ? snapshot.user_profile
      : offlineAuth.session?.user;
    setUser({ ...offlineUser, offline_session: true });
    await applyReferenceSnapshot(snapshot, { offline: true, nextView: "sales" });
    return true;
  };

  const loadProducts = async () => {
    const [response, duplicateLogResponse] = await Promise.all([
      axios.get(`${API_URL}/products`),
      axios.get(`${API_URL}/product-duplicate-archive-log`).catch(() => ({ data: { message: "" } })),
    ]);
    setProducts(response.data);
    setProductDuplicateWarning(duplicateLogResponse.data?.message || "");
  };
  const loadProductCategories = async () => {
    const response = await axios.get(`${API_URL}/product-categories`);
    setProductCategories(response.data);
  };

  const loadPurchaseRules = async () => {
    const response = await axios.get(`${API_URL}/purchase-rules`);
    setPurchaseRules(response.data);
  };

  const loadPurchases = async () => {
    const response = await axios.get(`${API_URL}/purchases`);
    setPurchases(response.data);
  };

  const loadSettingsData = async (currentUser = user) => {
    const response = await axios.get(`${API_URL}/settings`, { params: { user_id: currentUser?.id, device_id: deviceInfo.device_id } });
    const data = response.data;
    const nextSaleRateSettings = { ...defaultSaleRateSettings, ...(data.saleRateSettings || {}) };
    setSettingsData({
      businessSettings: { ...defaultBusinessSettings, ...(data.businessSettings || {}) },
      saleRateSettings: nextSaleRateSettings,
      posSettings: { ...defaultPosSettings, ...(data.posSettings || {}) },
      paymentSettings: { ...defaultPaymentSettings, ...(data.paymentSettings || {}) },
      whatsappSettings: { ...defaultWhatsappSettings, ...(data.whatsappSettings || {}) },
      deviceControlSettings: { ...defaultDeviceControlSettings, ...(data.deviceControlSettings || {}) },
      discountRules: data.discountRules || [],
      roles: data.roles || [],
      users: data.users || [],
      updateCenter: data.updateCenter || {},
      syncSettings: data.syncSettings || {},
      backupSettings: data.backupSettings || {},
      backupLogs: data.backupLogs || [],
      exitAttemptLogs: data.exitAttemptLogs || [],
      authorizedDevices: data.authorizedDevices || [],
      activationCodes: data.activationCodes || [],
      branches: data.branches || [],
      counters: data.counters || [],
      systemInfo: data.systemInfo || {},
      canManageSettings: Boolean(data.canManageSettings),
    });
    setSettingsRules({
      mandiTaxRules: data.mandiTaxRules || [],
      rebateRules: data.rebateRules || [],
    });
    setDiscountRules((data.discountRules || []).filter((rule) => rule.active !== false));
    setSaleDesiredMargin(String(nextSaleRateSettings.desired_margin_percent || 25));
  };

  const loadDiscountRules = async () => {
    const response = await axios.get(`${API_URL}/settings/discount-rules`);
    setDiscountRules(response.data);
  };

  const loadLotDiscounts = async () => {
    const response = await axios.get(`${API_URL}/lot-discounts`);
    setLotDiscounts(response.data);
  };

  const loadCustomerPendingBills = async () => {
    const response = await axios.get(`${API_URL}/pending-bills/customer`);
    setCustomerPendingBills(response.data || { summary: [], invoices: [] });
  };

  const loadAiAssistant = async (range = aiRange) => {
    setAiAssistantData((current) => ({ ...current, loading: true, error: "" }));
    const params = { user_id: user?.id, device_id: deviceInfo.device_id, range };
    const context = { user, deviceId: deviceInfo.device_id, backendHealth, cloudHealth };
    const requests = [
      ["briefing", "FROST briefing", `${API_URL}/api/ai/briefing`, { required: true }],
      ["alerts", "FROST alerts", `${API_URL}/api/ai/alerts`, { required: true }],
      ["reminders", "FROST reminders", `${API_URL}/api/ai/reminders`, { required: true }],
      ["questions", "FROST suggested questions", `${API_URL}/api/ai/suggested-questions`, { required: true }],
      ["status", "FROST status", `${API_URL}/api/ai/frost/status`, { required: true }],
      ["compatibility", "FROST compatibility", `${API_URL}/api/system/compatibility`, { required: true, params: { frontend_version: APP_VERSION } }],
      ["memory", "FROST memory", `${API_URL}/api/ai/memory`, { fallback: { memories: [] } }],
      ["predictions", "FROST predictions", `${API_URL}/api/ai/predictions`, { fallback: { predictions: { inventory: [], sales: [], cashflow: [], waste: [] } } }],
      ["profit", "FROST profit advisor", `${API_URL}/api/ai/profit-advisor`, { fallback: { recommendations: [] } }],
      ["plan", "FROST daily plan", `${API_URL}/api/ai/daily-plan`, { fallback: null }],
      ["autonomous", "FROST decision center", `${API_URL}/api/ai/autonomous`, { fallback: null }],
    ];
    const settled = await Promise.all(requests.map(([key, label, url, options]) =>
      axios.get(url, { params: { ...params, ...(options.params || {}) }, timeout: 12000, headers: { "X-FroozERP-Frontend-Version": APP_VERSION } }).then((response) => ({
        key,
        label,
        response,
        data: response.data,
        diagnostic: buildFrostRequestDiagnostic({ label, url, response, context }),
      })).catch((error) => ({
        key,
        label,
        error,
        data: Object.prototype.hasOwnProperty.call(options, "fallback") ? options.fallback : null,
        diagnostic: buildFrostRequestDiagnostic({ label, url, error, context }),
        required: options.required === true,
      }))
    ));
    const byKey = Object.fromEntries(settled.map((item) => [item.key, item]));
    const diagnostics = settled.map((item) => item.diagnostic);
    const compatibility = byKey.compatibility?.data || null;
    const mismatchFailure = compatibility && compatibility.compatible === false
      ? {
          label: "FROST compatibility",
          error: new Error("FroozERP components are out of sync. Update or restart is required."),
          diagnostic: {
            ...byKey.compatibility.diagnostic,
            ok: false,
            message: `FroozERP components are out of sync. Frontend ${compatibility.frontendVersion}, backend ${compatibility.backendVersion}.`,
          },
          required: true,
        }
      : null;
    if (mismatchFailure) {
      diagnostics.push(mismatchFailure.diagnostic);
    }
    const requiredFailure = mismatchFailure || settled.find((item) => item.required && item.error);
    try {
      if (requiredFailure) throw requiredFailure.error;
      const briefingData = byKey.briefing?.data || {};
      const statusData = byKey.status?.data || {};
      setAiAssistantData((current) => ({
        ...current,
        briefing: briefingData,
        alerts: byKey.alerts?.data?.alerts || [],
        reminders: byKey.reminders?.data?.reminders || [],
        suggestedQuestions: byKey.questions?.data?.questions || [],
        frost: statusData,
        provider: statusData.provider || null,
        providers: statusData.providers || [],
        engines: statusData.engines || [],
        usage: statusData.usage || null,
        memories: byKey.memory?.data?.memories || [],
        predictions: byKey.predictions?.data?.predictions || { inventory: [], sales: [], cashflow: [], waste: [] },
        profitAdvisor: byKey.profit?.data?.recommendations || [],
        autonomous: byKey.autonomous?.data,
        dailyPlan: byKey.plan?.data,
        diagnostics,
        period: { range, ...(briefingData.period || {}) },
        loading: false,
        error: "",
      }));
    } catch (error) {
      setAiAssistantData((current) => ({
        ...current,
        loading: false,
        diagnostics,
        error: frostDiagnosticsSummary(diagnostics) || getFrostDiagnosticMessage(error, { offlineMode, internetAvailable, backendHealth }),
      }));
    }
  };

  const askAiAssistant = async (question = aiQuestion) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    setAiAssistantData((current) => ({ ...current, loading: true, error: "" }));
    try {
      const response = await axios.post(`${API_URL}/api/ai/query`, {
        user_id: user?.id,
        device_id: deviceInfo.device_id,
        question: trimmed,
        range: aiRange,
      });
      setAiAssistantData((current) => ({
        ...current,
        loading: false,
        period: { range: aiRange, ...(response.data.period || {}) },
        history: [
          {
            id: response.data.conversation_id || Date.now(),
            question: trimmed,
            answer: response.data.answer,
            facts: response.data.facts || [],
            period: response.data.period,
            provider: response.data.provider,
            usage: response.data.usage,
            cached: response.data.cached,
          },
          ...current.history,
        ].slice(0, 20),
      }));
      setAiQuestion("");
    } catch (error) {
      setAiAssistantData((current) => ({ ...current, loading: false, error: getFrostDiagnosticMessage(error, { offlineMode, internetAvailable, backendHealth }) }));
    }
  };

  const updateAiAlert = async (alertId, action) => {
    await axios.patch(`${API_URL}/api/ai/alerts/${alertId}`, { user_id: user?.id, action });
    await loadAiAssistant(aiRange);
  };

  const updateAiReminder = async (reminderId, action) => {
    await axios.patch(`${API_URL}/api/ai/reminders/${reminderId}`, { user_id: user?.id, action });
    await loadAiAssistant(aiRange);
  };

  const saveFrostSettings = async (frostSettings) => {
    await axios.put(`${API_URL}/api/ai/settings`, {
      user_id: user?.id,
      updated_by: user?.id,
      frost: frostSettings,
    });
    await loadAiAssistant(aiRange);
  };

  const stopFrostVoice = () => {
    const current = frostVoiceRef.current;
    if (current.channel) current.channel.close();
    if (current.peer) current.peer.close();
    if (current.stream) current.stream.getTracks().forEach((track) => track.stop());
    if (current.audio) current.audio.srcObject = null;
    frostVoiceRef.current = { peer: null, stream: null, audio: null, channel: null };
    setAiAssistantData((state) => ({ ...state, voice: { ...state.voice, status: "idle" } }));
  };

  const startFrostVoice = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      setAiAssistantData((state) => ({ ...state, voice: { status: "unavailable", supported: false, transcript: "", error: "Voice requires microphone and WebRTC support." } }));
      return;
    }
    setAiAssistantData((state) => ({ ...state, voice: { ...state.voice, status: "connecting", supported: true, error: "" } }));
    try {
      const sessionResponse = await axios.post(`${API_URL}/api/ai/voice/session`, {
        user_id: user?.id,
        device_id: deviceInfo.device_id,
        provider_key: "openai",
      });
      const session = sessionResponse.data;
      if (!session.configured || !session.clientSecret) {
        setAiAssistantData((state) => ({ ...state, voice: { status: "unconfigured", supported: true, transcript: "", error: session.message || "FROST voice is not configured." } }));
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: session.noiseSuppression !== false,
          autoGainControl: true,
        },
      });
      const peer = new RTCPeerConnection();
      const audio = new Audio();
      audio.autoplay = true;
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0];
        setAiAssistantData((state) => ({ ...state, voice: { ...state.voice, status: "speaking" } }));
      };
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      const channel = peer.createDataChannel("oai-events");
      channel.onopen = () => {
        channel.send(JSON.stringify({
          type: "session.update",
          session: {
            instructions: "You are FROST, FroozERP's business copilot. Speak naturally in Hindi, English, or Hinglish. Use business tools; never execute actions without owner confirmation.",
          },
        }));
        setAiAssistantData((state) => ({ ...state, voice: { ...state.voice, status: "listening" } }));
      };
      channel.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          const delta = message.delta || message.transcript || message.text || "";
          if (delta) {
            setAiAssistantData((state) => ({ ...state, voice: { ...state.voice, transcript: `${state.voice.transcript || ""}${delta}` } }));
          }
          if (String(message.type || "").includes("input_audio_buffer.speech_started")) {
            setAiAssistantData((state) => ({ ...state, voice: { ...state.voice, status: "listening" } }));
          }
          if (String(message.type || "").includes("response.audio.done")) {
            setAiAssistantData((state) => ({ ...state, voice: { ...state.voice, status: "listening" } }));
          }
        } catch {
          // Realtime data channel can include provider-specific events; ignore unknown payloads.
        }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const realtimeResponse = await fetch(session.realtimeUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.clientSecret}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });
      if (!realtimeResponse.ok) throw new Error("Realtime voice connection failed");
      const answer = { type: "answer", sdp: await realtimeResponse.text() };
      await peer.setRemoteDescription(answer);
      frostVoiceRef.current = { peer, stream, audio, channel };
    } catch (error) {
      stopFrostVoice();
      setAiAssistantData((state) => ({ ...state, voice: { status: "error", supported: true, transcript: "", error: getFrostDiagnosticMessage(error, { offlineMode, internetAvailable, backendHealth }) } }));
    }
  };

  const proposeFrostAction = async (action, payload = {}) => {
    try {
      const response = await axios.post(`${API_URL}/api/ai/actions/propose`, {
        user_id: user?.id,
        action_type: action,
        payload,
      });
      setSyncMessage(response.data.message || "FROST action recorded for approval.");
    } catch (error) {
      setSyncMessage(getErrorMessage(error, "Unable to record FROST action."));
    }
  };

  const proposeFrostMemory = async (content) => {
    try {
      await axios.post(`${API_URL}/api/ai/memory/propose`, {
        user_id: user?.id,
        content,
        source_type: "owner_statement",
      });
      setSyncMessage("FROST memory proposed for owner approval.");
      await loadAiAssistant(aiRange);
    } catch (error) {
      setSyncMessage(getErrorMessage(error, "Unable to propose FROST memory."));
    }
  };

  const updateFrostMemory = async (memoryId, action, payload = {}) => {
    try {
      const nextAction = String(action || "").toLowerCase();
      if (nextAction === "approve") {
        await axios.post(`${API_URL}/api/ai/memory/${memoryId}/approve`, { user_id: user?.id });
      } else if (nextAction === "delete") {
        await axios.delete(`${API_URL}/api/ai/memory/${memoryId}`, { data: { user_id: user?.id } });
      } else {
        await axios.patch(`${API_URL}/api/ai/memory/${memoryId}`, { user_id: user?.id, ...payload });
      }
      await loadAiAssistant(aiRange);
    } catch (error) {
      setSyncMessage(getErrorMessage(error, "Unable to update FROST memory."));
    }
  };

  const loadSaleRates = async (desiredMargin = saleDesiredMargin) => {
    const [ratesResponse, historyResponse] = await Promise.all([
      axios.get(`${API_URL}/sale-rates`, { params: { user_id: user.id, desired_margin: desiredMargin } }),
      axios.get(`${API_URL}/sale-rate-history`, { params: { user_id: user.id } }),
    ]);
    setSaleRates(ratesResponse.data);
    setSaleRateHistory(historyResponse.data);
  };

  const loadSupplierData = async (search = "") => {
    const params = search ? { search } : {};
    const suppliersResponse = await axios.get(`${API_URL}/suppliers`, { params });
    setSuppliers(suppliersResponse.data);
  };

  const loadCustomerData = async (search = "") => {
    const params = search ? { search } : {};
    const customersResponse = await axios.get(`${API_URL}/customers`, { params });
    setCustomers(customersResponse.data);
  };

  const loadAccounts = async () => {
    const response = await axios.get(`${API_URL}/accounts`);
    setAccounts(response.data);
  };

  const loadAccountLedger = async (accountKey = "") => {
    const response = await axios.get(`${API_URL}/accounts/ledger`, {
      params: accountKey ? { account_key: accountKey } : {},
    });
    setAccountLedger(response.data);
  };

  const loadAccountOutstanding = async () => {
    const response = await axios.get(`${API_URL}/accounts/outstanding`);
    setAccountOutstanding(response.data);
  };

  const loadAccountPayments = async (accountKey = "") => {
    const response = await axios.get(`${API_URL}/accounts/payments`, {
      params: accountKey ? { account_key: accountKey } : {},
    });
    setAccountPayments(response.data);
  };

  const loadReports = async (params = {}) => {
    if (isTauriRuntime() && offlineMode) {
      const snapshot = await loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id }).catch(() => null);
      const localRows = await listLocalPosSales().catch(() => []);
      const salesRows = localRows.map(localSnapshotToInvoice);
      setReportsData((current) => ({
        ...current,
        salesHistoryReport: salesRows,
        stockLotReport: snapshot?.inventory_lots || inventory,
        cashBookReport: salesRows.flatMap((sale) => (sale.payments || []).map((payment) => ({
          transaction_date: sale.sale_date,
          source: "LOCAL_POS",
          party_name: sale.customer_name || "Walk-in Customer",
          payment_mode: payment.mode || payment.payment_mode || sale.payment_mode,
          total_amount: Number(payment.amount || sale.total_amount || 0),
          transaction_count: 1,
        }))),
      }));
      return;
    }
    const [response, inventoryResponse, cashBookResponse] = await Promise.all([
      axios.get(`${API_URL}/reports/summary`, { params }),
      axios.get(`${API_URL}/inventory`, { params: { include_cancelled: true } }),
      axios.get(`${API_URL}/reports/cash-book`, { params }),
    ]);
    setReportsData({ ...response.data, stockLotReport: inventoryResponse.data, cashBookReport: cashBookResponse.data });
  };

  const loadExpenses = async () => {
    const response = await axios.get(`${API_URL}/expenses`);
    setExpenses(response.data);
  };

  const loadSalesHistory = async () => {
    if (isTauriRuntime() && offlineMode) {
      const localRows = await listLocalPosSales();
      setSalesHistory(localRows.map(localSnapshotToInvoice));
      return;
    }
    const response = await axios.get(`${API_URL}/sales`);
    setSalesHistory(response.data);
  };

  const loadSaleReturns = async () => {
    const response = await axios.get(`${API_URL}/sale-returns`);
    setSaleReturns(response.data);
  };

  const loadWasteEntries = async () => {
    const response = await axios.get(`${API_URL}/waste-entries`);
    setWasteEntries(response.data);
  };

  const getDashboardParams = (range = dashboardRange, customRange = dashboardCustomRange) => {
    const userParam = { user_id: user?.id };
    if (range === "custom") {
      return customRange.date_from && customRange.date_to
        ? { ...userParam, date_from: customRange.date_from, date_to: customRange.date_to }
        : { ...userParam, days: 7 };
    }
    return { ...userParam, days: range };
  };

  const loadDashboardAnalytics = async (range = dashboardRange, customRange = dashboardCustomRange) => {
    if (user && !hasModuleAccess("dashboard")) return;
    const response = await axios.get(`${API_URL}/dashboard-analytics`, {
      params: getDashboardParams(range, customRange),
    });
    setDashboardAnalytics(response.data);
    if (response.data.summary) setSupplierDashboard(response.data.summary);
    setDashboardError("");
  };

  const loadDashboardData = async () => {
    if (user && !hasModuleAccess("dashboard")) return;
    if (isTauriRuntime() && offlineMode) {
      const snapshot = await loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id }).catch(() => null);
      const localRows = await listLocalPosSales().catch(() => []);
      setInventory(snapshot?.inventory_lots || inventory);
      setSalesHistory(localRows.map(localSnapshotToInvoice));
      setSupplierDashboard((current) => current || {});
      setDashboardAnalytics((current) => current || {});
      setDashboardError("");
      return;
    }
    const requests = await Promise.allSettled([
      axios.get(`${API_URL}/inventory`),
      axios.get(`${API_URL}/sales`),
      axios.get(`${API_URL}/dashboard-metrics`, { params: { user_id: user?.id } }),
      axios.get(`${API_URL}/dashboard-analytics`, { params: getDashboardParams() }),
    ]);
    const [inventoryResult, salesResult, metricsResult, analyticsResult] = requests;
    if (inventoryResult.status === "fulfilled") setInventory(inventoryResult.value.data || []);
    if (salesResult.status === "fulfilled") setSalesHistory(salesResult.value.data || []);
    if (metricsResult.status === "fulfilled") setSupplierDashboard(metricsResult.value.data || {});
    if (analyticsResult.status === "fulfilled") setDashboardAnalytics(analyticsResult.value.data || emptyDashboardAnalytics);
    const failures = requests.filter((result) => result.status === "rejected");
    if (failures.length) {
      console.warn("Dashboard refresh partially failed", failures.map((result) => getErrorMessage(result.reason, result.reason?.message || "Unknown dashboard error")));
      setDashboardError("Some dashboard cards could not be refreshed. Other modules remain available.");
    } else {
      setDashboardError("");
    }
  };

  const changeDashboardRange = async (range) => {
    try {
      setDashboardRange(range);
      if (range !== "custom") await loadDashboardAnalytics(range, dashboardCustomRange);
    } catch (error) {
      console.warn("Dashboard analytics refresh failed", error);
      setDashboardError(getErrorMessage(error, "Dashboard analytics could not be refreshed."));
    }
  };

  const applyDashboardCustomRange = async () => {
    try {
      setDashboardRange("custom");
      await loadDashboardAnalytics("custom", dashboardCustomRange);
    } catch (error) {
      console.warn("Dashboard custom range refresh failed", error);
      setDashboardError(getErrorMessage(error, "Dashboard analytics could not be refreshed."));
    }
  };

  const login = async () => {
    setLoginBusy(true);
    setStartupError("");
    setStartupNotice("");
    try {
      const latestDevice = await resolveLocalDeviceInfo(getClientDeviceInfo());
      setDeviceInfo(latestDevice);
      const health = await performConnectivityCheck("login", { force: true, timeoutMs: 4000 });
      const backendOnline = health.online;

      if (!backendOnline) {
        setOfflineMode(true);
        const opened = await continueOffline(latestDevice);
        if (!opened) {
          setStartupError((current) => current || `Backend health check failed at ${health.url}: ${health.message}.`);
        }
        return;
      }

      writeDiagnosticLog("INFO", "login-request", { apiUrl: API_URL, endpoint: `${API_URL}/login`, deviceId: latestDevice.device_id });
      const response = await axios.post(`${API_URL}/login`, { username: username.trim(), password, ...latestDevice }, { timeout: 8000 });
      writeDiagnosticLog("INFO", "login-success", { apiUrl: API_URL, endpoint: `${API_URL}/login`, userId: response.data?.id, deviceId: latestDevice.device_id });
      setDeviceGate(null);
      setUser(response.data);
      await registerCloudDevice(response.data, latestDevice);
      if (response.data?.force_password_change) {
        setStartupNotice("Sign in succeeded. This account must change its temporary password from User Management before regular use.");
      }

      try {
        await hydrateOnlineSession(response.data, latestDevice);
      } catch (hydrateError) {
        console.error("Online hydration failed", hydrateError);
        setOfflineMode(false);
        setActiveView(initialView);
        setStartupNotice("Backend login succeeded. Some reference data could not be refreshed; empty sections remain usable and can be retried.");
        setSyncMessage(getErrorMessage(hydrateError, "Reference-data refresh is temporarily unavailable."));
      }
    } catch (error) {
      writeDiagnosticLog("ERROR", "login-failed", {
        apiUrl: API_URL,
        endpoint: `${API_URL}/login`,
        status: error.response?.status || null,
        code: error.response?.data?.code || "",
        message: error.response?.data?.message || error.message || "Login failed",
      });
      if (["DEVICE_NOT_APPROVED", "DEVICE_PENDING_APPROVAL", "DEVICE_DISABLED", "DEVICE_REVOKED", "DEVICE_ID_REQUIRED"].includes(error.response?.data?.code)) {
        setDeviceGate(error.response.data);
        setStartupError(error.response.data.message || "This device is not approved.");
        return;
      }
      if (isTauriRuntime()) {
        const latestDevice = await resolveLocalDeviceInfo(getClientDeviceInfo());
        const opened = await continueOffline(latestDevice);
        if (opened) return;
      }
      setStartupError(getAuthErrorMessage(error, `Unable to sign in through ${API_URL}. Connect once to the FroozERP backend to authorise this device.`));
    } finally {
      setLoginBusy(false);
    }
  };

  const retryOnline = async () => {
    setLoginBusy(true);
    setStartupError("");
    setStartupNotice(`Checking backend at ${API_URL}/api/health...`);
    try {
      const latestDevice = await resolveLocalDeviceInfo(getClientDeviceInfo());
      setDeviceInfo(latestDevice);
      const health = await performConnectivityCheck("retry-online", { force: true, timeoutMs: 4000 });
      if (health.online) {
        setStartupNotice(`Backend online at ${health.url}. Enter credentials and click Sign In to complete first online login.`);
      } else {
        setStartupError(`Backend health check failed at ${health.url}: ${health.message}`);
      }
      return health;
    } finally {
      setLoginBusy(false);
    }
  };

  const activateDevice = async () => {
    if (!activationCode.trim()) {
      alert("Enter activation code.");
      return;
    }
    try {
      const latestDevice = getClientDeviceInfo();
      const response = await axios.post(`${API_URL}/devices/activate`, {
        ...latestDevice,
        activation_code: activationCode,
      });
      setDeviceInfo(response.data.device || latestDevice);
      setDeviceGate(null);
      setActivationCode("");
      alert("Device activated. Please login again.");
    } catch (error) {
      alert(getErrorMessage(error, "Device activation failed"));
    }
  };

  const addProduct = async () => {
    try {
      const wasEditing = Boolean(editingProductId);
      const selectedCategory = productCategories.find((category) => String(category.id) === String(productCategoryId));
      const finalCategoryName = selectedCategory?.category_name || newProductCategoryName.trim() || productCategory.trim();
      const normalizedName = productName.trim().toLowerCase();
      const duplicateProduct = products.find((product) =>
        product.product_name?.trim().toLowerCase() === normalizedName &&
        Number(product.id) !== Number(editingProductId || 0)
      );
      if (duplicateProduct) {
        alert("This product already exists.");
        return;
      }
      if (!finalCategoryName) {
        alert("Please select or add product category.");
        return;
      }
      const parsedSellingRate = Number(sellingRate);
      const parsedMinimumStock = Number(productMinimumStock || 0);
      if (!productName.trim() || !unit || !Number.isFinite(parsedSellingRate) || parsedSellingRate <= 0) {
        alert("Enter an item name, unit and valid sale rate.");
        return;
      }
      if (!Number.isFinite(parsedMinimumStock) || parsedMinimumStock < 0) {
        alert("Enter a valid minimum stock quantity.");
        return;
      }
      const normalizedOpeningStockLots = (addOpeningStock ? openingStockLots : [])
        .filter((lot) => [
          lot.lot_name,
          lot.lot_size,
          lot.quantity,
          lot.purchase_rate,
          lot.sale_rate,
          lot.opening_stock_date,
          lot.supplier_id,
          lot.remarks,
        ].some((value) => String(value ?? "").trim() !== ""))
        .map((lot) => {
          const quantity = Number(lot.quantity);
          const purchaseRate = Number(lot.purchase_rate ?? lot.opening_cost);
          const saleRate = Number(lot.sale_rate ?? parsedSellingRate);
          return {
            ...lot,
            quantity: Number.isFinite(quantity) ? quantity : 0,
            purchase_rate: Number.isFinite(purchaseRate) ? purchaseRate : 0,
            opening_cost: Number.isFinite(purchaseRate) ? purchaseRate : 0,
            sale_rate: Number.isFinite(saleRate) ? saleRate : parsedSellingRate,
            supplier_id: lot.supplier_id || null,
            opening_stock_date: lot.opening_stock_date || null,
            lot_name: String(lot.lot_name || "").trim(),
            lot_size: String(lot.lot_size || "").trim(),
            remarks: String(lot.remarks || "").trim(),
          };
        });
      const payload = {
        product_name: productName.trim(),
        unit,
        barcode: productBarcode,
        origin_type: productOriginType,
        category: finalCategoryName || "Fruit",
        category_id: productCategoryId || null,
        minimum_stock: parsedMinimumStock,
        selling_rate: parsedSellingRate,
        sale_rate: parsedSellingRate,
        purchase_rate: normalizedOpeningStockLots[0]?.purchase_rate || 0,
        opening_stock: normalizedOpeningStockLots.reduce((sum, lot) => sum + lot.quantity, 0),
        quantity: normalizedOpeningStockLots.reduce((sum, lot) => sum + lot.quantity, 0),
        active: productActive,
        remarks: productRemarks,
        branch_id: Number(user.branch_id) || 1,
        created_by: user.id,
        updated_by: user.id,
        opening_stock_lots: !editingProductId ? normalizedOpeningStockLots : [],
      };
      if (editingProductId) {
        await axios.put(`${API_URL}/products/${editingProductId}`, payload);
        if (addOpeningStock && openingStockLots.length > 0) {
          await axios.post(`${API_URL}/products/${editingProductId}/opening-stock`, {
            opening_stock_lots: openingStockLots,
            branch_id: user.branch_id,
            created_by: user.id,
          });
        }
      } else {
        await axios.post(`${API_URL}/products`, payload);
      }
      resetProductForm();
      await Promise.all([loadProducts(), loadProductCategories(), loadDashboardData()]);
      alert(wasEditing ? "Product Updated" : "Product Added");
    } catch (error) {
      console.error("Product save failed", {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
        error,
      });
      alert(getErrorMessage(error, "Error Adding Product"));
    }
  };

  const resetProductForm = () => {
    setProductName("");
    setSellingRate("");
    setUnit("");
    setProductBarcode("");
    setProductOriginType("LOCAL");
    setProductCategory("Fruit");
    setProductCategoryId("");
    setNewProductCategoryName("");
    setProductMinimumStock("");
    setProductActive(true);
    setProductRemarks("");
    setAddOpeningStock(false);
    setOpeningStockLots([]);
    setOpeningStockDraft({
      lot_name: "",
      lot_size: "",
      quantity: "",
      purchase_rate: "",
      sale_rate: "",
      opening_stock_date: toDateKey(new Date()),
      supplier_id: "",
      remarks: "",
    });
    setLotPanelProduct(null);
    setProductLots([]);
    setProductLotAudit([]);
    setShowOpeningLotForm(false);
    setLotAction(null);
    setEditingProductId(null);
  };

  const saveProductCategory = async () => {
    try {
      const categoryName = newProductCategoryName.trim();
      if (!categoryName) {
        alert("Please enter category name.");
        return;
      }
      const duplicate = productCategories.find((category) => category.category_name?.trim().toLowerCase() === categoryName.toLowerCase());
      if (duplicate) {
        alert("Category already exists.");
        setProductCategoryId(String(duplicate.id));
        setProductCategory(duplicate.category_name);
        return;
      }
      const response = await axios.post(`${API_URL}/product-categories`, {
        category_name: categoryName,
        created_by: user.id,
      });
      await loadProductCategories();
      setProductCategoryId(String(response.data.id));
      setProductCategory(response.data.category_name);
      setNewProductCategoryName("");
      alert("Category saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save category"));
    }
  };

  const editProductCategory = async (category) => {
    const nextName = window.prompt("Edit category name", category.category_name);
    if (!nextName?.trim()) return;
    try {
      await axios.put(`${API_URL}/product-categories/${category.id}`, {
        category_name: nextName,
        active: category.active !== false,
        remarks: category.remarks || "",
        updated_by: user.id,
        reason: "Category renamed from Product Master",
      });
      await Promise.all([loadProductCategories(), loadProducts()]);
      alert("Category updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update category"));
    }
  };

  const deactivateProductCategory = async (category) => {
    const reason = window.prompt(`Enter reason to remove/deactivate ${category.category_name}`);
    if (!reason?.trim()) return;
    try {
      await axios.delete(`${API_URL}/product-categories/${category.id}`, {
        data: { updated_by: user.id, reason },
      });
      await loadProductCategories();
      alert("Category removed");
    } catch (error) {
      await loadProductCategories();
      alert(getErrorMessage(error, "This category has items or transactions. It can only be deactivated."));
    }
  };

  const getSupplierLabel = (supplierId) => {
    const supplier = activeSuppliers.find((item) => String(item.id) === String(supplierId));
    return supplier?.supplier_name || "";
  };

  const getOpeningLotName = (draft, nextIndex) => draft.lot_name.trim() || `Opening Lot ${nextIndex}`;

  const isSameOpeningLot = (left, right) =>
    String(left.product_id || editingProductId || "").toLowerCase() === String(right.product_id || editingProductId || "").toLowerCase() &&
    String(left.lot_name || "").trim().toLowerCase() === String(right.lot_name || "").trim().toLowerCase() &&
    String(left.supplier_id || "").trim() === String(right.supplier_id || "").trim() &&
    String(left.opening_stock_date || left.purchase_date || "").slice(0, 10) === String(right.opening_stock_date || right.purchase_date || "").slice(0, 10) &&
    String(left.lot_size || "").trim().toLowerCase() === String(right.lot_size || "").trim().toLowerCase();

  const resetOpeningStockDraft = () => {
    setOpeningStockDraft({
      lot_name: "",
      lot_size: "",
      quantity: "",
      purchase_rate: "",
      sale_rate: sellingRate,
      opening_stock_date: toDateKey(new Date()),
      supplier_id: "",
      remarks: "",
    });
  };

  const buildOpeningStockLotFromDraft = () => {
    const quantity = Number(openingStockDraft.quantity || 0);
    const purchaseRate = Number(openingStockDraft.purchase_rate || 0);
    const saleRate = Number(openingStockDraft.sale_rate || sellingRate || 0);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      alert("Please enter lot quantity.");
      return null;
    }
    if (!Number.isFinite(purchaseRate) || purchaseRate <= 0) {
      alert("Please enter opening stock rate.");
      return null;
    }
    if (!Number.isFinite(saleRate) || saleRate <= 0) {
      alert("Please enter sale rate.");
      return null;
    }
    const nextLotName = getOpeningLotName(openingStockDraft, productLots.length + openingStockLots.length + 1);
    const nextLot = {
      ...openingStockDraft,
      lot_name: nextLotName,
      supplier_name: getSupplierLabel(openingStockDraft.supplier_id),
      sale_rate: saleRate,
    };
    const duplicateLot = [...productLots, ...openingStockLots].find((lot) => isSameOpeningLot(lot, nextLot));
    if (duplicateLot) {
      const confirmed = window.confirm("This lot already exists. Add as separate lot anyway?");
      if (!confirmed) return null;
      nextLot.allow_duplicate_lot = true;
    }
    return nextLot;
  };

  const addOpeningStockLot = () => {
    const nextLot = buildOpeningStockLotFromDraft();
    if (!nextLot) return;
    setOpeningStockLots((current) => [...current, nextLot]);
    resetOpeningStockDraft();
  };

  const saveNewOpeningStockLot = async () => {
    const activeProductId = editingProductId || lotPanelProduct?.id;
    if (!activeProductId) {
      alert("Product id missing. Close this form and reopen it from the product lot panel.");
      return;
    }
    const nextLot = buildOpeningStockLotFromDraft();
    if (!nextLot) return;
    try {
      const payload = {
        ...nextLot,
        opening_cost: nextLot.purchase_rate,
        size_grade: nextLot.lot_size,
        created_by: user.id,
        branch_id: user.branch_id,
      };
      try {
        await axios.post(`${API_URL}/products/${activeProductId}/opening-stock-lots`, payload);
      } catch (error) {
        const message = getErrorMessage(error, "Unable to add opening stock lot");
        if (message.includes("Add as separate lot anyway?") && window.confirm("This lot already exists. Add as separate lot anyway?")) {
          await axios.post(`${API_URL}/products/${activeProductId}/opening-stock-lots`, { ...payload, allow_duplicate_lot: true });
        } else {
          throw error;
        }
      }
      resetOpeningStockDraft();
      setShowOpeningLotForm(false);
      setAddOpeningStock(false);
      await refreshLotContext(lotPanelProduct || { id: activeProductId, product_name: productName });
      alert("Opening stock lot added");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to add opening stock lot"));
    }
  };

  const loadProductLots = async (product, showPanel = true) => {
    try {
      const response = await axios.get(`${API_URL}/products/${product.id}/lots`);
      setProductLots(response.data.lots || []);
      setProductLotAudit(response.data.audit || []);
      if (showPanel) setLotPanelProduct(product);
    } catch (error) {
      alert(getErrorMessage(error, "Unable to load product lots"));
    }
  };

  const openLotAction = (type, lot) => {
    setLotAction({ type, lot });
    setLotDraft({
      lot_name: lot.lot_name || lot.batch_no || "",
      lot_size: lot.lot_size || "",
      supplier_id: lot.supplier_id ? String(lot.supplier_id) : "",
      purchase_qty: String(lot.purchase_qty || ""),
      purchase_rate: String(lot.purchase_rate || lot.effective_cost_per_unit || ""),
      sale_rate: String(lot.temporary_sale_rate || lot.selling_rate || ""),
      opening_stock_date: toDateKey(lot.purchase_date || new Date()),
      remarks: lot.remarks || "",
      quantity: "",
      new_quantity: String(lot.balance_qty ?? lot.remaining_qty ?? 0),
      adjustment_type: "Physical Count Correction",
      transfer_to_lot_id: "",
      transfer_quantity: "",
      adjustment_date: toDateKey(new Date()),
      reason: "",
    });
  };

  const closeLotAction = () => {
    setLotAction(null);
    setLotDraft({
      lot_name: "",
      lot_size: "",
      supplier_id: "",
      purchase_qty: "",
      purchase_rate: "",
      sale_rate: "",
      opening_stock_date: "",
      remarks: "",
      quantity: "",
      new_quantity: "",
      adjustment_type: "Physical Count Correction",
      transfer_to_lot_id: "",
      transfer_quantity: "",
      adjustment_date: toDateKey(new Date()),
      reason: "",
    });
  };

  const refreshLotContext = async (product = lotPanelProduct) => {
    const inventoryResponse = await axios.get(`${API_URL}/inventory`, { params: { include_cancelled: true } });
    setInventory(inventoryResponse.data);
    await Promise.all([loadProducts(), loadDashboardData(), loadReports()]);
    if (product?.id) await loadProductLots(product, true);
  };

  const saveLotAction = async () => {
    if (!lotAction?.lot?.id) return;
    try {
      const selectedSupplier = activeSuppliers.find((supplier) => String(supplier.id) === String(lotDraft.supplier_id));
      const basePayload = {
        updated_by: user.id,
        branch_id: user.branch_id,
        reason: lotDraft.reason,
      };
      if (lotAction.type === "edit") {
        const nextQty = Number(lotDraft.purchase_qty || 0);
        const nextCost = Number(lotDraft.purchase_rate || 0);
        if (!lotDraft.lot_name.trim()) {
          alert("Please enter lot name / number.");
          return;
        }
        if (!Number.isFinite(nextQty) || nextQty < 0) {
          alert("Please enter a valid opening quantity.");
          return;
        }
        if (!Number.isFinite(nextCost) || nextCost <= 0) {
          alert("Please enter a valid opening cost / purchase rate.");
          return;
        }
        await axios.put(`${API_URL}/inventory-lots/${lotAction.lot.id}`, {
          ...basePayload,
          lot_name: lotDraft.lot_name,
          lot_size: lotDraft.lot_size,
          supplier_id: lotDraft.supplier_id || null,
          supplier_name: selectedSupplier?.supplier_name || null,
          purchase_qty: lotDraft.purchase_qty,
          purchase_rate: lotDraft.purchase_rate,
          sale_rate: lotDraft.sale_rate,
          opening_stock_date: lotDraft.opening_stock_date,
          remarks: lotDraft.remarks,
          reason: lotDraft.reason || "Opening stock lot edited",
        });
        alert("Lot updated");
      }
      if (lotAction.type === "add") {
        if (Number(lotDraft.quantity || 0) <= 0) {
          alert("Enter quantity to add.");
          return;
        }
        await axios.post(`${API_URL}/inventory-lots/${lotAction.lot.id}/add-quantity`, {
          ...basePayload,
          quantity: lotDraft.quantity,
          reason: lotDraft.reason || "Quantity added to opening stock lot",
        });
        alert("Quantity added");
      }
      if (lotAction.type === "adjust") {
        const nextQty = Number(lotDraft.new_quantity || 0);
        if (!lotDraft.reason.trim()) {
          alert("Adjustment reason is required.");
          return;
        }
        if (!Number.isFinite(nextQty) || nextQty < 0) {
          alert("Please enter a valid physical quantity.");
          return;
        }
        await axios.post(`${API_URL}/inventory-lots/${lotAction.lot.id}/adjust`, {
          ...basePayload,
          physical_quantity: lotDraft.new_quantity,
          adjustment_type: lotDraft.adjustment_type,
          adjustment_date: lotDraft.adjustment_date,
          remarks: lotDraft.remarks,
          reason: lotDraft.reason,
        });
        alert("Lot adjusted");
      }
      if (lotAction.type === "transfer") {
        if (!lotDraft.reason.trim()) {
          alert("Transfer reason is required.");
          return;
        }
        if (!lotDraft.transfer_to_lot_id) {
          alert("Select destination lot.");
          return;
        }
        if (Number(lotDraft.transfer_quantity || 0) <= 0) {
          alert("Enter quantity to move.");
          return;
        }
        await axios.post(`${API_URL}/lots/transfer-stock`, {
          from_lot_id: lotAction.lot.id,
          to_lot_id: lotDraft.transfer_to_lot_id,
          quantity: lotDraft.transfer_quantity,
          reason: lotDraft.reason,
          remarks: lotDraft.remarks,
          updated_by: user.id,
        });
        alert("Stock transferred");
      }
      if (lotAction.type === "deactivate") {
        if (!lotDraft.reason.trim()) {
          alert("Reason is required to deactivate a lot.");
          return;
        }
        await axios.post(`${API_URL}/inventory-lots/${lotAction.lot.id}/deactivate`, {
          ...basePayload,
          reason: lotDraft.reason,
          deactivated_by: user.id,
        });
        alert("Lot deactivated");
      }
      if (lotAction.type === "reactivate") {
        if (!lotDraft.reason.trim()) {
          alert("Reason is required to reactivate a lot.");
          return;
        }
        await axios.post(`${API_URL}/inventory-lots/${lotAction.lot.id}/reactivate`, {
          ...basePayload,
          reason: lotDraft.reason,
          reactivated_by: user.id,
        });
        alert("Lot reactivated");
      }
      closeLotAction();
      await refreshLotContext();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update lot"));
    }
  };

  const resetPurchaseForm = () => {
    setPurchaseSupplierId("");
    setPurchaseProductId("");
    setPurchaseQuantity("");
    setPurchaseRateInput("");
    setPurchaseFreightCharges("");
    setPurchaseLabourCharges("");
    setPurchaseOtherCharges("");
    setPurchasePaidAmount("");
    setPurchaseBillStatus("BILL_COMPLETED");
    setPurchaseDate(toDateKey(new Date()));
    setTemporarySaleRate("");
    setExpectedPurchaseRate("");
    setPurchaseBillNumber("");
    setPurchaseBillDate("");
    setPurchaseType("CREDIT");
    setPurchasePaymentMode("CASH");
    setPurchasePaymentReference("");
    setPurchaseRebateRuleId("");
    setPurchasePaymentDate("");
    setPurchaseRemarks("");
    setPurchaseItemRemarks("");
    setPurchaseLotName("");
    setPurchaseLotSize("");
    setPurchaseCart([]);
    setEditingPurchaseItemLineId(null);
    setEditingPurchaseId(null);
    setPurchaseAmendmentMode(false);
    setAmendmentDate("");
    setAmendmentSupplierId("");
  };

  const resetPurchaseItemFields = () => {
    setPurchaseProductId("");
    setPurchaseQuantity("");
    setPurchaseRateInput("");
    setTemporarySaleRate("");
    setExpectedPurchaseRate("");
    setPurchaseItemRemarks("");
    setPurchaseLotName("");
    setPurchaseLotSize("");
    setEditingPurchaseItemLineId(null);
  };

  const addPurchaseCartItem = () => {
    const product = selectedPurchaseProduct;
    const quantity = Number(purchaseQuantity || 0);
    const purchaseRate = Number(purchaseRateInput || 0);
    const temporaryRate = Number(temporarySaleRate || 0);
    const expectedRate = Number(expectedPurchaseRate || 0);
    if (!purchaseSupplierId) {
      alert("Select supplier before adding purchase items.");
      return;
    }
    if (!product || quantity <= 0) {
      alert("Select product and enter quantity.");
      return;
    }
    if (!purchaseLotName.trim()) {
      alert("Please enter lot name / size.");
      return;
    }
    if (purchaseBillStatus === "BILL_PENDING" && temporaryRate <= 0) {
      alert("Pending bill stock requires a temporary sale rate.");
      return;
    }
    if (purchaseBillStatus === "BILL_COMPLETED" && purchaseRate <= 0) {
      alert("Completed bill items require a purchase rate.");
      return;
    }
    const item = {
      line_id: editingPurchaseItemLineId || createPurchaseLineId(),
      product_id: product.id,
      product_name: product.product_name,
      unit: product.unit,
      origin_type: product.origin_type || "LOCAL",
      quantity,
      purchase_rate: purchaseBillStatus === "BILL_PENDING" ? expectedRate : purchaseRate,
      temporary_sale_rate: temporaryRate,
      expected_purchase_rate: expectedRate,
      lot_name: purchaseLotName,
      lot_size: purchaseLotSize,
      remarks: purchaseItemRemarks,
    };
    setPurchaseCart((currentCart) => {
      const nextCart = [...currentCart];
      const itemIdentity = buildPurchaseLineIdentity(item);
      if (editingPurchaseItemLineId !== null) {
        const editingIndex = nextCart.findIndex((cartItem) => cartItem.line_id === editingPurchaseItemLineId);
        if (editingIndex < 0) return currentCart;
        const duplicateIndex = nextCart.findIndex((cartItem) =>
          cartItem.line_id !== editingPurchaseItemLineId &&
          buildPurchaseLineIdentity(cartItem) === itemIdentity
        );
        if (duplicateIndex >= 0) {
          const shouldMerge = window.confirm("This edited item exactly matches another purchase-cart row. Add this quantity to the existing row and remove the edited row?");
          if (!shouldMerge) return currentCart;
          nextCart[duplicateIndex] = {
            ...nextCart[duplicateIndex],
            quantity: Number(nextCart[duplicateIndex].quantity || 0) + quantity,
          };
          nextCart.splice(editingIndex, 1);
        } else {
          nextCart[editingIndex] = item;
        }
      } else {
        const existingIndex = nextCart.findIndex((cartItem) => buildPurchaseLineIdentity(cartItem) === itemIdentity);
        if (existingIndex >= 0) {
          const shouldMerge = window.confirm("This exact product lot already exists in the purchase cart. Add this quantity to the existing row?");
          if (!shouldMerge) return currentCart;
          nextCart[existingIndex] = {
            ...nextCart[existingIndex],
            quantity: Number(nextCart[existingIndex].quantity || 0) + quantity,
          };
        } else {
          nextCart.push(item);
        }
      }
      return nextCart;
    });
    resetPurchaseItemFields();
  };

  const editPurchaseCartItem = (lineId) => {
    const item = purchaseCart.find((cartItem) => cartItem.line_id === lineId);
    if (!item) return;
    setEditingPurchaseItemLineId(item.line_id);
    setPurchaseProductId(String(item.product_id));
    setPurchaseQuantity(String(item.quantity || ""));
    setPurchaseRateInput(String(item.purchase_rate || ""));
    setTemporarySaleRate(String(item.temporary_sale_rate || ""));
    setExpectedPurchaseRate(String(item.expected_purchase_rate || ""));
    setPurchaseLotName(item.lot_name || "");
    setPurchaseLotSize(item.lot_size || "");
    setPurchaseItemRemarks(item.remarks || "");
  };

  const removePurchaseCartItem = (lineId) => {
    setPurchaseCart((currentCart) => currentCart.filter((item) => item.line_id !== lineId));
    if (editingPurchaseItemLineId === lineId) resetPurchaseItemFields();
  };

  const validatePurchaseBeforeSave = () => {
    if (!purchaseSupplierId) return "Please select supplier";
    if (editingPurchaseId) {
      const productName = selectedPurchaseProduct?.product_name || "selected item";
      if (!purchaseProductId) return "Please select product";
      if (Number(purchaseQuantity || 0) <= 0) return `Please enter quantity for ${productName}`;
      if (purchaseBillStatus === "BILL_COMPLETED") {
        if (Number(purchaseRateInput || 0) <= 0) return `Please enter purchase rate for ${productName}`;
        if (!purchaseRebateRuleId) return "Please select rebate rule";
        if (purchaseType === "CASH" && Number(purchasePaidAmount || 0) <= 0) return "Please enter paid amount";
      }
      if (purchaseBillStatus === "BILL_PENDING" && Number(temporarySaleRate || 0) <= 0) return `Please enter temporary sale rate for ${productName}`;
      return "";
    }
    if (purchaseCart.length === 0) return "Please add at least one item";
    if (purchaseBillStatus === "BILL_COMPLETED") {
      const missingRate = purchaseCart.find((item) => Number(item.purchase_rate || 0) <= 0);
      if (missingRate) return `Please enter purchase rate for ${missingRate.product_name}`;
      if (!purchaseRebateRuleId) return "Please select rebate rule";
      if (purchaseType === "CASH" && Number(purchasePaidAmount || 0) <= 0) return "Please enter paid amount";
    }
    if (purchaseBillStatus === "BILL_PENDING") {
      const missingTempRate = purchaseCart.find((item) => Number(item.temporary_sale_rate || 0) <= 0);
      if (missingTempRate) return `Please enter temporary sale rate for ${missingTempRate.product_name}`;
    }
    return "";
  };

  const savePurchase = async () => {
    try {
      const wasEditing = Boolean(editingPurchaseId);
      const validationMessage = validatePurchaseBeforeSave();
      if (validationMessage) {
        alert(validationMessage);
        return;
      }
      const reason = editingPurchaseId ? window.prompt("Enter purchase edit reason") : "";
      if (editingPurchaseId && !reason?.trim()) return;
      const payload = {
        supplier_id: purchaseSupplierId,
        product_id: purchaseProductId,
        quantity: purchaseQuantity,
        purchase_rate: purchaseRateInput,
        purchase_bill_status: purchaseBillStatus,
        purchase_date: purchaseDate,
        temporary_sale_rate: temporarySaleRate,
        expected_purchase_rate: expectedPurchaseRate,
        freight_charges: purchaseFreightCharges,
        labour_charges: purchaseLabourCharges,
        other_charges: purchaseOtherCharges,
        paid_amount: purchaseType === "CASH" ? purchasePaidAmount : 0,
        rebate_rule_id: purchaseRebateRuleId,
        payment_date: purchasePaymentDate || null,
        purchase_type: purchaseType,
        payment_mode: purchaseType === "CASH" ? purchasePaymentMode : null,
        payment_reference_number: purchaseType === "CASH" ? purchasePaymentReference : null,
        bill_number: purchaseBillNumber,
        bill_date: purchaseBillDate || null,
        lot_name: purchaseLotName,
        lot_size: purchaseLotSize,
        branch_id: user.branch_id,
        created_by: user.id,
        edited_by: user.id,
        reason,
        remarks: purchaseRemarks,
      };
      if (editingPurchaseId && purchaseBillStatus === "BILL_COMPLETED" && purchases.find((purchase) => Number(purchase.id) === Number(editingPurchaseId))?.purchase_bill_status === "BILL_PENDING") {
        await axios.post(`${API_URL}/purchase/${editingPurchaseId}/complete-bill`, payload);
      } else if (editingPurchaseId) {
        await axios.put(`${API_URL}/purchase/${editingPurchaseId}`, payload);
      } else {
        if (purchaseCart.length === 0) {
          alert("Add at least one purchase item before saving.");
          return;
        }
        await axios.post(`${API_URL}/purchase-bill`, { ...payload, items: purchaseCart });
      }
      if (purchaseAmendmentMode) {
        setPurchaseCart([]);
        resetPurchaseItemFields();
      } else {
        resetPurchaseForm();
      }
      await Promise.all([loadDashboardData(), loadPurchases(), loadSupplierData(), loadAccounts(), loadAccountOutstanding()]);
      alert(purchaseBillStatus === "BILL_PENDING" ? "Stock Arrival Saved - Bill Pending" : wasEditing ? "Purchase Updated" : "Purchase Saved");
    } catch (error) {
      alert(getErrorMessage(error, "Purchase Error"));
    }
  };

  const loadInvoice = async (saleId, options = {}) => {
    try {
      if (isTauriRuntime() && (offlineMode || String(saleId || "").startsWith("invoice-") || String(saleId || "").startsWith("pos-invoice-"))) {
        const snapshot = await loadLocalPosSale(saleId);
        setSelectedInvoice(localSnapshotToInvoice(snapshot));
        setSelectedInvoicePrintMode(options.print ? (options.printMode || "THERMAL") : null);
        return;
      }
      const response = await axios.get(`${API_URL}/sales/${saleId}`);
      setSelectedInvoice(response.data);
      setSelectedInvoicePrintMode(options.print ? (options.printMode || "THERMAL") : null);
    } catch (error) {
      alert(getErrorMessage(error, "Error Loading Invoice"));
    }
  };

  const printSaleInvoice = async (saleId, printMode = "THERMAL") => {
    const invoiceId = saleId || "";
    if (!invoiceId) {
      alert("Unable to print invoice. Invoice ID is missing.");
      return;
    }
    await loadInvoice(invoiceId, { print: true, printMode });
  };

  const loadSaleForEdit = async (saleId) => {
    setSaleEditLoading(true);
    setSaleEditError("");
    try {
      if (isTauriRuntime() && (offlineMode || String(saleId || "").startsWith("invoice-") || String(saleId || "").startsWith("pos-invoice-"))) {
        const snapshot = await loadLocalPosSale(saleId);
        setEditingSale(localSnapshotToInvoice(snapshot));
        return;
      }
      const response = await axios.get(`${API_URL}/sales/${saleId}`);
      setEditingSale(response.data);
    } catch (error) {
      const message = getErrorMessage(error, "Error Loading Invoice");
      setSaleEditError(message);
      alert(message);
    } finally {
      setSaleEditLoading(false);
    }
  };

  const loadChangeHistory = async (saleId) => {
    try {
      const response = await axios.get(`${API_URL}/sales/${saleId}/audit`);
      setChangeHistory({ saleId, rows: response.data });
    } catch (error) {
      alert(getErrorMessage(error, "Error Loading Change History"));
    }
  };

  const getSaleDetailsForAction = async (sale) => {
    const saleId = sale.sale_id || sale.id || "";
    if (!saleId) {
      throw new Error("Unable to open invoice. Invoice ID is missing.");
    }
    if ((sale.items || []).length > 0 || (sale.payments || []).length > 0) return sale;
    if (isTauriRuntime() && (offlineMode || sale.sync_status || String(saleId).startsWith("invoice-") || String(saleId).startsWith("pos-invoice-"))) {
      const snapshot = await loadLocalPosSale(saleId);
      return localSnapshotToInvoice(snapshot);
    }
    const response = await axios.get(`${API_URL}/sales/${saleId}`);
    return response.data;
  };

  const refreshAfterSaleCancellation = async ({ local = false } = {}) => {
    setSelectedInvoice(null);
    setSelectedInvoicePrintMode(null);
    setPosRefreshToken((token) => token + 1);
    if (isTauriRuntime() && (offlineMode || local)) {
      const snapshot = await loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id }).catch(() => null);
      if (snapshot) {
        setProducts(snapshot.products || []);
        setInventory(snapshot.inventory_lots || []);
        setSalesHistory(snapshot.sales_history || []);
      }
      await refreshSyncStatus().catch(() => null);
      return;
    }
    const inventoryRefresh = axios.get(`${API_URL}/inventory`, { params: { include_cancelled: true } })
      .then((response) => setInventory(response.data));
    await Promise.all([
      loadProducts().catch(() => null),
      inventoryRefresh.catch(() => null),
      loadSalesHistory().catch(() => null),
      loadDashboardData().catch(() => null),
      loadReports().catch(() => null),
      loadCustomerPendingBills().catch(() => null),
      loadAccountOutstanding().catch(() => null),
    ]);
  };

  const cancelSale = async (sale) => {
    try {
      const fullSale = await getSaleDetailsForAction(sale);
      if (fullSale.sale_status === "CANCELLED") {
        alert("Invoice is already cancelled.");
        return false;
      }
      setCancelDraft({ sale: fullSale, reason: "", saving: false });
      return false;
    } catch (error) {
      alert(getErrorMessage(error, "Unable to open cancellation confirmation"));
      return false;
    }
  };

  const confirmCancelSale = async () => {
    if (!cancelDraft?.sale) return false;
    const sale = cancelDraft.sale;
    const reason = cancelDraft.reason || "";
    if (!reason.trim()) {
      alert("Cancellation reason is required.");
      return false;
    }
    const saleId = sale.sale_id || sale.id || "";
    if (!saleId) {
      alert("Unable to cancel invoice. Invoice ID is missing.");
      return false;
    }
    setCancelDraft((current) => current ? { ...current, saving: true } : current);
    try {
      if (isTauriRuntime() && (offlineMode || sale.sync_status || String(saleId).startsWith("invoice-") || String(saleId).startsWith("pos-invoice-"))) {
        const result = await cancelLocalPosSale({
          invoice_global_id: String(saleId),
          reason,
          user_id: String(user.id || ""),
          device_id: deviceInfo.device_id,
        });
        const localInvoice = localSnapshotToInvoice(result.invoice);
        setSalesHistory((rows) => rows.map((row) => String(row.id) === String(saleId) ? { ...row, ...localInvoice } : row));
        const snapshot = await loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id }).catch(() => null);
        if (snapshot) {
          setInventory(snapshot.inventory_lots || []);
        }
        await refreshSyncStatus();
        setCancelDraft(null);
        await refreshAfterSaleCancellation({ local: true });
        return true;
      }
      await axios.post(`${API_URL}/sales/${saleId}/cancel`, { reason, cancelled_by: user.id });
      await refreshAfterSaleCancellation();
      alert("Invoice cancelled");
      setCancelDraft(null);
      return true;
    } catch (error) {
      alert(getErrorMessage(error, "Unable to cancel invoice"));
      return false;
    } finally {
      setCancelDraft((current) => current ? { ...current, saving: false } : current);
    }
  };

  const selectPurchaseProduct = (event) => {
    const productId = event.target.value;
    setPurchaseProductId(productId);
    if (!productId) setPurchaseRateInput("");
  };

  const editProduct = (product) => {
    setProductName(product.product_name);
    setSellingRate(product.selling_rate);
    setUnit(product.unit);
    setProductBarcode(product.barcode || "");
    setProductOriginType(product.origin_type || "LOCAL");
    setProductCategory(product.category || "Fruit");
    setProductCategoryId(product.category_id ? String(product.category_id) : "");
    setProductMinimumStock(product.minimum_stock || "");
    setProductActive(product.active !== false);
    setProductRemarks(product.remarks || "");
    setAddOpeningStock(false);
    setOpeningStockLots([]);
    setShowOpeningLotForm(false);
    setEditingProductId(product.id);
    loadProductLots(product, true);
  };

  const cancelProductEdit = () => {
    resetProductForm();
  };

  const deactivateProduct = async (product) => {
    const reason = window.prompt(`Enter reason to deactivate/cancel ${product.product_name}`);
    if (!reason?.trim()) return;
    try {
      await axios.post(`${API_URL}/products/${product.id}/cancel`, { reason, cancelled_by: user.id });
      await Promise.all([loadProducts(), loadDashboardData()]);
      alert("Product marked inactive");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update product status"));
    }
  };

  const editPurchase = (purchase) => {
    setEditingPurchaseId(purchase.id);
    setPurchaseAmendmentMode(true);
    setAmendmentDate(toDateKey(purchase.purchase_date || new Date()));
    setAmendmentSupplierId(String(purchase.supplier_id || ""));
    setPurchaseBillStatus(purchase.purchase_bill_status || "BILL_COMPLETED");
    setPurchaseDate(toDateKey(purchase.purchase_date || new Date()));
    setPurchaseSupplierId(String(purchase.supplier_id || ""));
    setPurchaseProductId(String(purchase.product_id || ""));
    setPurchaseQuantity(String(purchase.quantity || ""));
    setPurchaseRateInput(String(purchase.purchase_rate || ""));
    setTemporarySaleRate(String(purchase.temporary_sale_rate || ""));
    setExpectedPurchaseRate(String(purchase.expected_purchase_rate || purchase.purchase_rate || ""));
    setPurchaseFreightCharges(String(purchase.freight_charges || 0));
    setPurchaseLabourCharges(String(purchase.labour_charges || 0));
    setPurchaseOtherCharges(String(purchase.other_charges || 0));
    setPurchasePaidAmount(String(purchase.paid_amount || ""));
    setPurchaseType(purchase.purchase_type || "CREDIT");
    setPurchasePaymentMode(purchase.payment_mode || "CASH");
    setPurchasePaymentReference(purchase.payment_reference_number || "");
    setPurchaseRebateRuleId(String(purchase.rebate_rule_id || ""));
    setPurchasePaymentDate(purchase.payment_date ? toDateKey(purchase.payment_date) : "");
    setPurchaseBillNumber(purchase.bill_number || "");
    setPurchaseBillDate(purchase.bill_date ? toDateKey(purchase.bill_date) : "");
    setPurchaseRemarks(purchase.remarks || "");
    setPurchaseItemRemarks(purchase.item_remarks || "");
    setPurchaseLotName(purchase.lot_name || purchase.item_lot_name || "");
    setPurchaseLotSize(purchase.lot_size || purchase.item_lot_size || "");
    setPurchaseCart([]);
    setEditingPurchaseItemLineId(null);
    setActiveView("purchase");
  };

  const openPurchaseAmendment = (purchase) => {
    setPurchaseAmendmentMode(true);
    setEditingPurchaseId(null);
    setAmendmentDate(toDateKey(purchase.purchase_date || new Date()));
    setAmendmentSupplierId(String(purchase.supplier_id || ""));
    setPurchaseDate(toDateKey(purchase.purchase_date || new Date()));
    setPurchaseSupplierId(String(purchase.supplier_id || ""));
    setPurchaseBillStatus(purchase.purchase_bill_status || "BILL_COMPLETED");
    setPurchaseType(purchase.purchase_type === "PENDING_BILL" ? "CREDIT" : purchase.purchase_type || "CREDIT");
    setPurchasePaymentMode(purchase.payment_mode || "CASH");
    setPurchasePaymentReference(purchase.payment_reference_number || "");
    setPurchaseBillNumber(purchase.bill_number || "");
    setPurchaseBillDate(purchase.bill_date ? toDateKey(purchase.bill_date) : "");
    setPurchaseFreightCharges("");
    setPurchaseLabourCharges("");
    setPurchaseOtherCharges("");
    setPurchasePaidAmount("");
    setPurchaseRebateRuleId(String(purchase.rebate_rule_id || ""));
    setPurchaseRemarks(purchase.remarks || "");
    setPurchaseCart([]);
    resetPurchaseItemFields();
    setActiveView("purchase");
  };

  const openBlankPurchaseAmendment = () => {
    setPurchaseAmendmentMode(true);
    setEditingPurchaseId(null);
    setAmendmentDate("");
    setAmendmentSupplierId("");
    setPurchaseDate(toDateKey(new Date()));
    setPurchaseSupplierId("");
    setPurchaseBillStatus("BILL_COMPLETED");
    setPurchaseType("CREDIT");
    setPurchasePaymentMode("CASH");
    setPurchasePaymentReference("");
    setPurchaseBillNumber("");
    setPurchaseBillDate("");
    setPurchaseFreightCharges("");
    setPurchaseLabourCharges("");
    setPurchaseOtherCharges("");
    setPurchasePaidAmount("");
    setPurchaseRebateRuleId("");
    setPurchaseRemarks("");
    setPurchaseCart([]);
    resetPurchaseItemFields();
    setActiveView("purchase");
  };

  const startForgottenPurchaseItem = () => {
    if (!amendmentDate || !amendmentSupplierId) {
      alert("Select purchase date and supplier first.");
      return;
    }
    setEditingPurchaseId(null);
    setPurchaseDate(amendmentDate);
    setPurchaseSupplierId(amendmentSupplierId);
    if (purchaseBillStatus === "BILL_PENDING") setPurchaseType("CREDIT");
    resetPurchaseItemFields();
  };

  const cancelPurchaseAmendment = () => {
    setEditingPurchaseId(null);
    resetPurchaseItemFields();
  };

  const completePendingPurchase = (purchase) => {
    editPurchase({
      ...purchase,
      purchase_bill_status: "BILL_COMPLETED",
      purchase_rate: purchase.expected_purchase_rate || purchase.purchase_rate || "",
    });
    setPurchaseBillStatus("BILL_COMPLETED");
    setPurchaseType("CREDIT");
    setPurchasePaidAmount("");
    setPurchasePaymentMode("CASH");
    setPurchasePaymentReference("");
    setPurchaseBillDate(toDateKey(new Date()));
  };

  const cancelPurchase = async (purchase) => {
    const reason = window.prompt(`Enter cancellation reason for Purchase #${purchase.id}`);
    if (!reason?.trim()) return;
    try {
      await axios.post(`${API_URL}/purchase/${purchase.id}/cancel`, { reason, cancelled_by: user.id });
      await Promise.all([loadPurchases(), loadDashboardData(), loadSupplierData(), loadAccounts(), loadAccountOutstanding()]);
      alert("Purchase cancelled");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to cancel purchase"));
    }
  };

  const openSupplierLedgerFromReport = async (purchase) => {
    const supplierId = Number(purchase.supplier_id || 0);
    if (!supplierId) {
      alert("Supplier account is not linked to this purchase.");
      return;
    }
    const accountKey = `SUPPLIER-${supplierId}`;
    setAccountLedgerFocusKey(accountKey);
    setActiveView("accounts");
    await loadAccountLedger(accountKey);
  };

  const openCustomerLedgerFromReport = async (sale) => {
    let customerRows = customers;
    if (!customerRows.length) {
      const response = await axios.get(`${API_URL}/customers`);
      customerRows = response.data;
      setCustomers(response.data);
    }
    const saleCustomerId = Number(sale.customer_id || 0);
    const saleMobile = String(sale.customer_mobile || "").trim();
    const saleName = String(sale.customer_name || "").trim().toLowerCase();
    const customer = customerRows.find((item) => {
      if (saleCustomerId && Number(item.id) === saleCustomerId) return true;
      const mobileMatches = saleMobile && String(item.mobile_number || "").trim() === saleMobile;
      const nameMatches = saleName && String(item.customer_name || "").trim().toLowerCase() === saleName;
      const walkInMatches = saleName.includes("walk-in") && item.system_account === true;
      return mobileMatches || nameMatches || walkInMatches;
    });
    if (!customer?.id) {
      alert("Customer account is not linked to this sale.");
      return;
    }
    const accountKey = `CUSTOMER-${customer.id}`;
    setAccountLedgerFocusKey(accountKey);
    setActiveView("accounts");
    await loadAccountLedger(accountKey);
  };

  const openSaleForEditFromReport = async (sale) => {
    if (!canEditSales) {
      alert("Your role cannot edit completed sales.");
      return;
    }
    const saleId = String(sale.sale_id || sale.id || "");
    if (!saleId) {
      alert("Sale invoice not found.");
      return;
    }
    const localEligible = isTauriRuntime() && (
      offlineMode ||
      sale.sync_status ||
      sale.offline_invoice_ref ||
      sale.localSale ||
      saleId.startsWith("invoice-") ||
      saleId.startsWith("pos-invoice-")
    );
    const preloadTasks = [];
    if (!products.length) preloadTasks.push(loadProducts());
    if (!inventory.length && !localEligible) {
      preloadTasks.push(
        axios.get(`${API_URL}/inventory`, { params: { include_cancelled: true } })
          .then((response) => setInventory(response.data))
      );
    }
    if (!inventory.length && localEligible) {
      preloadTasks.push(
        loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id })
          .then((snapshot) => {
            if (snapshot) setInventory(snapshot.inventory_lots || []);
          })
      );
    }
    if (!customers.length) preloadTasks.push(loadCustomerData());
    if (preloadTasks.length) await Promise.all(preloadTasks);
    await loadSaleForEdit(saleId);
  };

  const navigate = async (view) => {
    if (!hasModuleAccess(view)) {
      alert("Your role does not have access to this module.");
      return;
    }
    const currentUrlView = new URLSearchParams(window.location.search).get("view");
    if (currentUrlView !== view) {
      const nextUrl = new URL(window.location.href);
      nextUrl.searchParams.set("view", view);
      window.history.pushState({ view }, "", nextUrl);
    }
    if (offlineMode) {
      const snapshot = await loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id });
      if (!snapshot?.reference_ready) {
        setStartupError("This device must connect to the internet once before offline use.");
        return;
      }
      setSidebarOpen(false);
      await applyReferenceSnapshot(snapshot, { offline: true, nextView: view });
      if (offlineBackendRequiredViews.has(view)) {
        setSyncMessage("Offline - this module opens with local cached data where available. Some actions require the FroozERP backend.");
      } else if (offlineLocalDataViews.has(view)) {
        setSyncMessage("Offline - loaded local SQLite data for this module.");
      }
      if (view === "reports") await loadReports().catch(() => null);
      if (view === "dashboard") await loadDashboardData().catch(() => null);
      if (view === "sales") await Promise.all([loadSalesHistory(), loadReports()]).catch(() => null);
      return;
    }
    setSidebarOpen(false);
    setActiveView(view);
    try {
      if (view === "products") {
        await Promise.all([loadProducts(), loadProductCategories(), loadSupplierData(), loadDashboardData()]);
      }
      if (view === "sales") await Promise.all([loadDiscountRules(), loadLotDiscounts(), loadCustomerData()]);
      if (view === "discounts") {
        const inventoryResponse = await axios.get(`${API_URL}/inventory`);
        setInventory(inventoryResponse.data);
        await Promise.all([loadLotDiscounts(), loadProducts(), loadSupplierData()]);
      }
      if (["purchase", "pending-bills", "accounts"].includes(view)) {
        await loadSupplierData();
      }
      if (["purchase", "pending-bills"].includes(view)) await loadPurchases();
      if (view === "pending-bills") await Promise.all([loadCustomerPendingBills(), loadCustomerData()]);
      if (view === "accounts") {
        await Promise.all([loadAccounts(), loadCustomerData(), loadSupplierData(), loadAccountOutstanding()]);
      }
      if (view === "reports") await loadReports();
      if (view === "expenses") await loadExpenses();
      if (view === "returns") await loadSaleReturns();
      if (view === "waste") await loadWasteEntries();
      if (view === "dashboard") await loadDashboardData();
      if (view === "settings") await loadSettingsData();
      if (view === "sale-rates") await loadSaleRates();
    } catch (error) {
      console.warn(`Unable to refresh ${view}`, error);
      setSyncMessage(getErrorMessage(error, `${navigationItems.find(([itemView]) => itemView === view)?.[1] || "Module"} data could not be refreshed.`));
    }
  };

  if (!user) {
    return (
      <main className="login-page">
        <section className="login-panel">
          <div className="login-brand">
            <BrandLogo />
          </div>
          <div className="login-copy">
            <span className="eyebrow">Business Management</span>
            <h1>{APP_DISPLAY_NAME}</h1>
            <p>Preparing FroozERP, checking the local database, device authorisation and sync readiness.</p>
          </div>
          <div className="first-launch-steps">
            <span>Checking local database</span>
            <span>Checking device authorisation</span>
            <span>Preparing authorised reference data</span>
            <span>Ready for online or local-first POS</span>
          </div>
          <label>
            Username
            <input value={username} onChange={(event) => setUsername(event.target.value)} />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && login()}
            />
          </label>
          {(startupNotice || startupError || lastReferenceSyncAt) && (
            <div className={`startup-status-panel ${startupError ? "startup-status-error" : ""}`}>
              {startupNotice && <p>{startupNotice}</p>}
              {startupError && <p>{startupError}</p>}
              {lastReferenceSyncAt && <small>Last successful local data sync: {new Date(lastReferenceSyncAt).toLocaleString("en-IN")}</small>}
            </div>
          )}
          <div className="startup-api-panel">
            <span>{connectionStatus.apiModeLabel}</span>
            <code>{backendHealth.apiUrl}</code>
            <small>
              {connectionStatus.internetStatus} - {isCloudMode() ? connectionStatus.cloudBackendStatus : connectionStatus.localBackendStatus}
            </small>
            {isTauriRuntime() && !isCloudMode() && backendHealth.online === false && (
              <button className="table-action" onClick={async () => {
                await ensureLocalBackendService({ restart: true, reason: "login-restart-service" });
                await performConnectivityCheck("login-restart-service", { force: true, skipServiceStart: true });
              }}>
                Restart Service
              </button>
            )}
            {localBackendService?.message && <small>{localBackendService.message}</small>}
          </div>
          <div className="startup-actions">
            <button className="primary-button login-button" disabled={loginBusy} onClick={login}>
              {loginBusy ? "Signing In..." : "Sign In"}
            </button>
            <button className="recovery-link-button" disabled={loginBusy} onClick={() => setRecoveryOpen(true)}>
              Forgot Username or Password?
            </button>
            {isTauriRuntime() && (
              <>
                <button className="secondary-button" disabled={loginBusy} onClick={retryOnline}>
                  Retry Online
                </button>
                <button className="secondary-button" disabled={loginBusy} onClick={() => continueOffline()}>
                  Continue Offline
                </button>
              </>
            )}
            <button className="secondary-button login-close-exit-button" disabled={loginBusy} onClick={requestControlledExit}>
              Close &amp; Exit
            </button>
            <small className="login-exit-helper">
              {loginDeviceControlSettings.fullscreen_lock_enabled ? "Owner code required to close FroozERP" : "Close FroozERP safely"}
            </small>
          </div>
          {deviceGate && (
            <div className="device-activation-panel">
              <span className="eyebrow">Device Activation Required</span>
              <strong>This device is not approved.</strong>
              <small>Device ID: {deviceGate.device_id || deviceInfo.device_id}</small>
              <p>Ask the owner to approve this device from Settings, or enter a one-time activation code.</p>
              <input
                placeholder="Activation code"
                value={activationCode}
                onChange={(event) => setActivationCode(event.target.value.toUpperCase())}
              />
              <button className="secondary-button" onClick={activateDevice}>Activate Device</button>
            </div>
          )}
          {recoveryOpen && (
            <AccountRecoveryModal
              apiUrl={API_URL}
              backendHealth={backendHealth}
              deviceInfo={deviceInfo}
              onClose={() => setRecoveryOpen(false)}
              onCheckOnline={performConnectivityCheck}
              onRetryOnline={retryOnline}
            />
          )}
          {exitCodeModal}
        </section>
      </main>
    );
  }

  const activeLabel = navigationItems.find(([view]) => view === activeView)?.[1];
  const canManageRates = ["Owner", "Admin"].includes(user.role);
  const canEditSales = ["Owner", "Admin"].includes(user.role) || hasRolePermission("sale_edit");
  const canCancelSales = ["Owner", "Admin"].includes(user.role) || hasRolePermission("invoice_cancellation");
  const canManageStock = ["Owner", "Admin", "Inventory Manager"].includes(user.role);
  const lotBalanceQuantity = (lot) => Number(lot.balance_qty ?? lot.remaining_qty ?? 0);
  const lotUsedQuantity = (lot) => Number(lot.sold_qty ?? Math.max(Number(lot.purchase_qty || 0) - Number(lot.remaining_qty || 0), 0));
  const lotStatusLabel = (lot) => {
    const status = String(lot.batch_status || "ACTIVE").toUpperCase();
    if (status === "CANCELLED") return "Cancelled";
    if (status === "INACTIVE") return "Inactive";
    if (lotBalanceQuantity(lot) <= 0 && lotUsedQuantity(lot) > 0) return "Sold Out";
    return "Active";
  };
  const lotStatusClass = (lot) => {
    const label = lotStatusLabel(lot);
    if (label === "Active") return "stock-ok";
    if (label === "Sold Out") return "origin-rate";
    return "stock-low";
  };
  const visibleInventory = inventory.filter((batch) => showInventoryEmptyLots || lotBalanceQuantity(batch) > 0);
  const inventoryGroups = [...visibleInventory.reduce((groups, batch) => {
    const key = String(batch.product_id);
    const current = groups.get(key) || {
      product_id: batch.product_id,
      category: batch.category || "Fruit",
      product_name: batch.product_name,
      unit: batch.unit || "",
      total_stock: 0,
      stock_value: 0,
      lots: [],
    };
    const remaining = Number(batch.remaining_qty || 0);
    const cost = Number(batch.effective_cost_per_unit || batch.purchase_rate || 0);
    current.total_stock += remaining;
    current.stock_value += remaining * cost;
    current.lots.push(batch);
    groups.set(key, current);
    return groups;
  }, new Map()).values()].sort((left, right) => `${left.category}-${left.product_name}`.localeCompare(`${right.category}-${right.product_name}`));
  const productSearchText = productListSearch.trim().toLowerCase();
  const filteredProducts = products.filter((product) => {
    if (!productSearchText) return true;
    return [
      product.product_name,
      product.category_name,
      product.category,
      product.barcode,
      product.origin_type,
      product.selling_rate,
      product.active !== false ? "active" : "inactive",
      product.unit,
    ].some((value) => String(value ?? "").toLowerCase().includes(productSearchText));
  });
  const lotSearchText = lotListSearch.trim().toLowerCase();
  const filteredProductLots = productLots.filter((lot) => {
    if (!showEmptyLots && lotBalanceQuantity(lot) <= 0) return false;
    if (!lotSearchText) return true;
    return [
      lot.lot_name,
      lot.batch_no,
      lot.supplier_name,
      lot.lot_size,
      lot.purchase_date,
      lot.purchase_rate,
      lot.effective_cost_per_unit,
      lot.temporary_sale_rate,
      lot.selling_rate,
      lot.batch_status || "ACTIVE",
      lot.remarks,
      lotStatusLabel(lot),
    ].some((value) => String(value ?? "").toLowerCase().includes(lotSearchText));
  });

  const frostUnreadCount = (aiAssistantData.alerts || []).filter((alert) => ["CRITICAL", "HIGH", "ATTENTION"].includes(String(alert.severity || "").toUpperCase())).length;
  const openFrostDrawer = (tab = frostActiveTab || "briefing") => {
    setFrostActiveTab(tab);
    setFrostDrawerOpen(true);
  };
  const commandItems = [
    ["sales", "Open POS Billing", () => navigate("sales")],
    ["purchase", "New Purchase Entry", () => navigate("purchase")],
    ["pending-bills", "Open Pending Bills", () => navigate("pending-bills")],
    ["accounts", "Open Accounts", () => navigate("accounts")],
    ["reports", "Open Reports", () => navigate("reports")],
    ["sale-rates", "Open Sale Rate Update", () => navigate("sale-rates")],
    ["products", "Search Product", () => navigate("products")],
    ["accounts", "Search Customer", () => navigate("accounts")],
    ["accounts", "Search Supplier", () => navigate("accounts")],
    ["settings", "Open Update Center", () => navigate("settings")],
    ["settings", "Check Connection", () => { navigate("settings"); performConnectivityCheck("command-palette", { force: true }); }],
  ].filter(([view]) => hasModuleAccess(view) && (canManageRates || view !== "sale-rates"));
  return (
    <main className="erp-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <BrandLogo />
        </div>
        <span className="sidebar-section">Main Menu</span>
        <nav className="sidebar-nav">
          {navigationItems.filter(([view]) => hasModuleAccess(view) && (canManageRates || view !== "sale-rates")).map(([view, label]) => (
            <button
              className={activeView === view ? "nav-item nav-item-active" : "nav-item"}
              key={view}
              onClick={() => navigate(view)}
            >
              <Icon name={icons[view]} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
          <div className="sidebar-profile" onClick={() => setProfileOpen(true)} role="button" tabIndex={0} onKeyDown={(event) => event.key === "Enter" && setProfileOpen(true)}>
          <div className="user-avatar">{user.full_name.charAt(0)}</div>
          <div>
            <strong>{user.full_name}</strong>
            <small>{user.role}</small>
          </div>
          <button aria-label="Log out" className="logout-button" onClick={(event) => { event.stopPropagation(); setUser(null); setOfflineMode(false); setStartupError(""); setStartupNotice(""); }}>
            <Icon name="logout" size={17} />
          </button>
        </div>
      </aside>

      <button
        aria-label="Close sidebar"
        className={`sidebar-overlay ${sidebarOpen ? "sidebar-overlay-visible" : ""}`}
        onClick={() => setSidebarOpen(false)}
      />

      <section className="content-shell">
        <header className="topbar">
          <div className="topbar-heading">
            <button
              aria-label="Open sidebar"
              className="mobile-menu"
              onClick={() => setSidebarOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <BrandLogo compact />
            <div>
              <span className="eyebrow">Retail Operations Workspace</span>
              <h1>{activeLabel}</h1>
            </div>
          </div>
          <div className="branch-pill">
            <span className="status-dot" />
            {user.branch}
          </div>
          <div className="offline-pill">{connectionStatus.syncSummary}</div>
          {settingsData.deviceControlSettings?.fullscreen_lock_enabled && (
            <button className="secondary-button kiosk-exit-button" onClick={requestControlledExit}>
              Owner Exit
            </button>
          )}
        </header>

        <div className="content-area">
          {(startupNotice || startupError || syncMessage) && (
            <div className={`startup-status-panel ${startupError ? "startup-status-error" : ""}`}>
              {startupError && <p>{startupError}</p>}
              {!startupError && <p>{connectionStatus.banner}</p>}
              {!startupError && <small>{connectionStatus.detail}</small>}
              {isTauriRuntime() && !isCloudMode() && backendHealth.online === false && (
                <button className="table-action" onClick={async () => {
                  await ensureLocalBackendService({ restart: true, reason: "shell-restart-service" });
                  await performConnectivityCheck("shell-restart-service", { force: true, skipServiceStart: true });
                }}>
                  Restart Service
                </button>
              )}
              {localBackendService?.message && <small>{localBackendService.message}</small>}
            </div>
          )}
          {activeView === "dashboard" && !hasModuleAccess("dashboard") && (
            <section className="content-card">
              <div className="empty-state">
                <h2>You do not have permission to view Dashboard.</h2>
                <p>Ask the Owner or Administrator to enable the View Dashboard permission for your role.</p>
                <button className="primary-button" onClick={() => navigate(getDefaultAllowedView())}>Open Allowed Screen</button>
              </div>
            </section>
          )}

          {activeView === "dashboard" && hasModuleAccess("dashboard") && (
            <>
              {dashboardError && (
                <div className="startup-status-panel startup-status-error">
                  <p>{dashboardError}</p>
                </div>
              )}
              <section className="welcome-banner">
                <div>
                  <BrandLogo />
                  <span className="eyebrow">Retail Intelligence</span>
                  <h2>Good to see you, {user.full_name.split(" ")[0]}.</h2>
                  <p>Monitor today's performance and keep your inventory moving.</p>
                </div>
                <button className="primary-button" onClick={() => navigate("sales")}>
                  <Icon name="receipt" /> New POS Bill
                </button>
              </section>
              <section className="kpi-grid">
                {kpis.map(([label, value, icon]) => (
                  <article className="kpi-card" key={label}>
                    <div className="kpi-icon"><Icon name={icon} size={20} /></div>
                    <div>
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </div>
                  </article>
                ))}
              </section>
              <DashboardAnalytics
                analytics={dashboardAnalytics}
                customRange={dashboardCustomRange}
                onApplyCustomRange={applyDashboardCustomRange}
                onCustomRangeChange={setDashboardCustomRange}
                onNavigate={navigate}
                onRangeChange={changeDashboardRange}
                range={dashboardRange}
              />
              <section className="content-card">
                <div className="card-heading">
                  <div>
                    <span className="eyebrow">Quick Access</span>
                    <h2>Daily Operations</h2>
                  </div>
                </div>
                <div className="quick-grid">
                  {[["sales", "POS Billing"], ["purchase", "New Purchase"], ["accounts", "Accounts"], ["reports", "Stock Inventory"]].map(([view, label]) => (
                    <button className="quick-action" key={view} onClick={() => navigate(view)}>
                      <Icon name={icons[view]} />
                      <span>{label}</span>
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}

          {activeView === "products" && (
            <section className="settings-layout">
              <ModuleCard eyebrow="Product Master" title="Category, Item, Lot & Opening Stock" subtitle="Manage fruit categories, item masters and opening stock lots without disturbing FIFO inventory.">
                {productDuplicateWarning && <div className="cart-empty">{productDuplicateWarning}</div>}
                <div className="purchase-summary-grid supplier-payment-preview">
                  <SummaryMetric featured label="Categories" value={productCategories.length} />
                  <SummaryMetric label="Items" value={products.length} />
                  <SummaryMetric label="Active Items" value={products.filter((product) => product.active !== false).length} />
                  <SummaryMetric label="Inventory Lots" value={inventory.length} />
                </div>
              </ModuleCard>

              <ModuleCard eyebrow="Category Management" title="Fruit Categories" subtitle="Add, edit or deactivate categories. Categories with items are protected from hard deletion.">
                <div className="form-grid supplier-form-grid">
                  <Field label="Add New Category"><input value={newProductCategoryName} onChange={(event) => setNewProductCategoryName(event.target.value)} placeholder="Example: Mango" /></Field>
                  <Field label="Select Existing Category">
                    <select value={productCategoryId} onChange={(event) => {
                      const selected = productCategories.find((category) => String(category.id) === event.target.value);
                      setProductCategoryId(event.target.value);
                      setProductCategory(selected?.category_name || "");
                    }}>
                      <option value="">Select category</option>
                      {productCategories.filter((category) => category.active !== false).map((category) => <option key={category.id} value={category.id}>{category.category_name}</option>)}
                    </select>
                  </Field>
                  <button className="primary-button" onClick={saveProductCategory}>Save Category</button>
                </div>
                <DataTable headers={["Category", "Items", "Status", "Actions"]}>
                  {productCategories.map((category) => (
                    <tr key={category.id}>
                      <td className="primary-cell">{category.category_name}</td>
                      <td>{category.item_count || 0}</td>
                      <td><span className={category.active !== false ? "stock-ok" : "stock-low"}>{category.active !== false ? "Active" : "Inactive"}</span></td>
                      <td>
                        <div className="button-row table-actions-row">
                          <button className="table-action" onClick={() => editProductCategory(category)}>Edit</button>
                          <button className="remove-button" disabled={category.active === false} onClick={() => deactivateProductCategory(category)}>Remove / Deactivate</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </DataTable>
              </ModuleCard>

              <ModuleCard eyebrow="Item Management" title={editingProductId ? "Edit Item" : "Add Item Inside Category"} subtitle="Items are products used by POS, purchase, inventory, reports and FIFO costing.">
                <div className="form-grid supplier-form-grid">
                  <Field label="Category">
                    <select value={productCategoryId} onChange={(event) => {
                      const selected = productCategories.find((category) => String(category.id) === event.target.value);
                      setProductCategoryId(event.target.value);
                      setProductCategory(selected?.category_name || "");
                    }}>
                      <option value="">Select existing category</option>
                      {productCategories.filter((category) => category.active !== false).map((category) => <option key={category.id} value={category.id}>{category.category_name}</option>)}
                    </select>
                  </Field>
                  <Field label="Item Name"><input value={productName} onChange={(event) => setProductName(event.target.value)} placeholder="Example: Kesar" /></Field>
                  <Field label="Unit">
                    <select value={unit} onChange={(event) => setUnit(event.target.value)}>
                      <option value="">Select unit</option>
                      <option value="KG">KG</option>
                      <option value="BOX">Box</option>
                      <option value="PIECE">Piece</option>
                      <option value="DOZEN">Dozen</option>
                    </select>
                  </Field>
                  <Field label="Default Sale Rate"><input type="number" min="0" step="0.01" value={sellingRate} onChange={(event) => setSellingRate(event.target.value)} /></Field>
                  <Field label="Barcode (Optional)"><input value={productBarcode} onChange={(event) => setProductBarcode(event.target.value)} /></Field>
                  <Field label="Minimum Stock"><input type="number" min="0" step="0.001" value={productMinimumStock} onChange={(event) => setProductMinimumStock(event.target.value)} /></Field>
                  <Field label="Origin Type">
                    <select value={productOriginType} onChange={(event) => setProductOriginType(event.target.value)}>
                      <option value="LOCAL">Local</option>
                      <option value="IMPORTED">Imported</option>
                    </select>
                  </Field>
                  <label className="check-field"><input type="checkbox" checked={productActive} onChange={(event) => setProductActive(event.target.checked)} /><span>Active Item</span></label>
                </div>
                <Field label="Remarks"><textarea value={productRemarks} onChange={(event) => setProductRemarks(event.target.value)} /></Field>
                {!editingProductId && <label className="check-field"><input type="checkbox" checked={addOpeningStock} onChange={(event) => setAddOpeningStock(event.target.checked)} /><span>Add Opening Stock</span></label>}
                {addOpeningStock && !editingProductId && (
                  <div className="lot-entry-panel">
                    <div className="form-grid supplier-form-grid">
                      <Field label="Supplier (Optional)">
                        <select value={openingStockDraft.supplier_id} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, supplier_id: event.target.value })}>
                          <option value="">No supplier payable</option>
                          {activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.supplier_name}</option>)}
                        </select>
                      </Field>
                      <Field label="Lot Name / Number"><input value={openingStockDraft.lot_name} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, lot_name: event.target.value })} placeholder="Lot A" /></Field>
                      <Field label="Size / Grade"><input value={openingStockDraft.lot_size} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, lot_size: event.target.value })} placeholder="Small / Premium" /></Field>
                      <Field label="Quantity"><input type="number" min="0" step="0.001" value={openingStockDraft.quantity} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, quantity: event.target.value })} /></Field>
                      <Field label="Purchase Rate / Opening Cost"><input type="number" min="0" step="0.01" value={openingStockDraft.purchase_rate} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, purchase_rate: event.target.value })} /></Field>
                      <Field label="Sale Rate"><input type="number" min="0" step="0.01" value={openingStockDraft.sale_rate || sellingRate} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, sale_rate: event.target.value })} /></Field>
                      <Field label="Opening Stock Date"><input type="date" value={openingStockDraft.opening_stock_date} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, opening_stock_date: event.target.value })} /></Field>
                      <Field label="Lot Remarks"><input value={openingStockDraft.remarks} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, remarks: event.target.value })} /></Field>
                    </div>
                    <button className="secondary-button" onClick={addOpeningStockLot}>Add Opening Stock Lot</button>
                    <DataTable className="product-entry-table product-entry-lot-table" headers={["Supplier", "Lot", "Size", "Qty", "Cost", "Sale Rate", "Date", "Remarks", "Actions"]}>
                      {openingStockLots.map((lot, index) => (
                        <tr key={`${lot.lot_name}-${lot.opening_stock_date}-${index}`}>
                          <td>{lot.supplier_name || "-"}</td>
                          <td className="primary-cell product-name-cell" title={lot.lot_name || "-"}>{lot.lot_name || "-"}</td>
                          <td title={lot.lot_size || "-"}>{lot.lot_size || "-"}</td>
                          <td>{lot.quantity}</td>
                          <td>{currency.format(Number(lot.purchase_rate || 0))}</td>
                          <td>{currency.format(Number(lot.sale_rate || sellingRate || 0))}</td>
                          <td>{lot.opening_stock_date}</td>
                          <td title={lot.remarks || "-"}>{lot.remarks || "-"}</td>
                          <td><button className="remove-button" onClick={() => setOpeningStockLots((current) => current.filter((_, lotIndex) => lotIndex !== index))}>Remove</button></td>
                        </tr>
                      ))}
                      {openingStockLots.length === 0 && <tr><td colSpan="9" className="empty-cell">Add one or more opening stock lots before saving.</td></tr>}
                    </DataTable>
                  </div>
                )}
                {lotPanelProduct && (
                  <div className="lot-entry-panel">
                    <div className="report-toolbar">
                      <div>
                        <span className="eyebrow">Opening Stock / Lots</span>
                        <h3>{lotPanelProduct.product_name}</h3>
                        <p className="form-note">Existing inventory lots are editable here. Quantity cannot be reduced below stock already sold, wasted or otherwise used.</p>
                      </div>
                      <button className="secondary-button" onClick={() => loadProductLots(lotPanelProduct, true)}>Refresh Lots</button>
                    </div>
                    <label className="icon-input table-search-input">
                      <Icon name="search" />
                      <input
                        placeholder="Search lot, supplier, size..."
                        value={lotListSearch}
                        onChange={(event) => setLotListSearch(event.target.value)}
                      />
                    </label>
                    <label className="check-field report-check-field">
                      <input checked={showEmptyLots} type="checkbox" onChange={(event) => setShowEmptyLots(event.target.checked)} />
                      <span>Show Empty Lots</span>
                    </label>
                    <DataTable className="product-entry-table product-entry-lot-table" headers={["Supplier", "Lot", "Size/Grade", "Opening Date", "Opening Qty", "Sold Qty", "Balance Qty", "Cost", "Sale Rate", "Remarks", "Actions"]}>
                      {filteredProductLots.length ? filteredProductLots.map((lot) => (
                        <tr key={lot.id}>
                          <td title={lot.supplier_name || "No supplier payable"}>{lot.supplier_name || "No supplier payable"}</td>
                          <td className="primary-cell product-name-cell" title={lot.lot_name || lot.batch_no || `Lot #${lot.id}`}>{lot.lot_name || lot.batch_no || `Lot #${lot.id}`}<small className={`cell-note ${lotStatusClass(lot)}`}>{lotStatusLabel(lot)}</small></td>
                          <td title={lot.lot_size || "-"}>{lot.lot_size || "-"}</td>
                          <td>{formatDisplayDate(lot.purchase_date)}</td>
                          <td>{Number(lot.purchase_qty || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</td>
                          <td>{Number(lot.sold_qty || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</td>
                          <td>{Number(lot.balance_qty ?? lot.remaining_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</td>
                          <td>{currency.format(Number(lot.purchase_rate || lot.effective_cost_per_unit || 0))}</td>
                          <td>{currency.format(Number(lot.temporary_sale_rate || lot.selling_rate || 0))}</td>
                          <td title={lot.remarks || "-"}>{lot.remarks || "-"}</td>
                          <td>
                            <div className="button-row table-actions-row">
                              <button className="table-action" onClick={() => openLotAction("edit", lot)}>Edit</button>
                              <button className="table-action" disabled={lot.batch_status === "CANCELLED"} onClick={() => openLotAction("add", lot)}>Add Quantity</button>
                              <button className="table-action" disabled={lot.batch_status === "CANCELLED"} onClick={() => openLotAction("adjust", lot)}>Adjust</button>
                              <button className="table-action" disabled={lot.batch_status === "CANCELLED" || lotBalanceQuantity(lot) <= 0} onClick={() => openLotAction("transfer", lot)}>Transfer</button>
                              <button className="remove-button" disabled={lot.batch_status === "CANCELLED"} onClick={() => openLotAction("deactivate", lot)}>Deactivate</button>
                            </div>
                          </td>
                        </tr>
                      )) : (
                        <tr><td colSpan="11" className="empty-cell">{productLots.length ? (showEmptyLots ? "No matching lots found." : "No active lots found. Enable Show Empty Lots to view sold-out lots.") : "No lots found for this product."}</td></tr>
                      )}
                    </DataTable>
                    <div className="button-row">
                      <button className="secondary-button" onClick={() => {
                        resetOpeningStockDraft();
                        setAddOpeningStock(true);
                        setShowOpeningLotForm(true);
                      }}>Add New Opening Stock Lot</button>
                    </div>
                    {showOpeningLotForm && (
                      <div className="lot-entry-panel">
                        <div className="report-toolbar">
                          <div>
                            <span className="eyebrow">New Opening Lot</span>
                            <h3>Add lot for {lotPanelProduct.product_name}</h3>
                            <p className="form-note">This creates a separate opening stock batch for the same item. Existing lots are not overwritten or merged.</p>
                          </div>
                        </div>
                        <div className="form-grid supplier-form-grid">
                          <Field label="Supplier / Supplier Payable">
                            <select value={openingStockDraft.supplier_id} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, supplier_id: event.target.value })}>
                              <option value="">No supplier payable</option>
                              {activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.supplier_name}</option>)}
                            </select>
                          </Field>
                          <Field label="Lot Name / Number"><input value={openingStockDraft.lot_name} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, lot_name: event.target.value })} placeholder="Opening Lot 1" /></Field>
                          <Field label="Size / Grade"><input value={openingStockDraft.lot_size} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, lot_size: event.target.value })} placeholder="Small / Medium / Premium" /></Field>
                          <Field label="Quantity"><input type="number" min="0" step="0.001" value={openingStockDraft.quantity} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, quantity: event.target.value })} /></Field>
                          <Field label="Purchase Rate / Opening Cost"><input type="number" min="0" step="0.01" value={openingStockDraft.purchase_rate} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, purchase_rate: event.target.value })} /></Field>
                          <Field label="Sale Rate"><input type="number" min="0" step="0.01" value={openingStockDraft.sale_rate || sellingRate} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, sale_rate: event.target.value })} /></Field>
                          <Field label="Opening Stock Date"><input type="date" value={openingStockDraft.opening_stock_date} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, opening_stock_date: event.target.value })} /></Field>
                          <Field label="Lot Remarks"><input value={openingStockDraft.remarks} onChange={(event) => setOpeningStockDraft({ ...openingStockDraft, remarks: event.target.value })} /></Field>
                        </div>
                        <div className="button-row">
                          <button
  type="button"
  className="primary-button"
  onClick={saveNewOpeningStockLot}
>
  Save Lot
</button>
                          <button className="secondary-button" onClick={() => {
                            resetOpeningStockDraft();
                            setShowOpeningLotForm(false);
                            setAddOpeningStock(false);
                          }}>Cancel</button>
                        </div>
                      </div>
                    )}
                    {productLotAudit.length > 0 && (
                      <div className="lot-audit-panel">
                        <h3>Lot Audit Trail</h3>
                        <DataTable headers={["Action", "Edited At", "Edited By", "Reason"]}>
                          {productLotAudit.map((entry) => (
                            <tr key={entry.id}>
                              <td className="primary-cell">{entry.action}</td>
                              <td>{formatDisplayDate(entry.edited_at)}</td>
                              <td>{entry.edited_by_name || entry.edited_by || "-"}</td>
                              <td>{entry.reason || "-"}</td>
                            </tr>
                          ))}
                        </DataTable>
                      </div>
                    )}
                  </div>
                )}
                <div className="button-row">
                  <button className="primary-button" onClick={addProduct}>{editingProductId ? "Update Item" : "Add Item"}</button>
                  {editingProductId && <button className="secondary-button" onClick={cancelProductEdit}>Cancel Edit</button>}
                </div>
              </ModuleCard>

              <ModuleCard eyebrow="Item List" title="Category-Wise Items" subtitle="Inactive items stay in history but are hidden from POS by default.">
                <label className="icon-input table-search-input">
                  <Icon name="search" />
                  <input
                    placeholder="Search item, category, barcode..."
                    value={productListSearch}
                    onChange={(event) => setProductListSearch(event.target.value)}
                  />
                </label>
                <DataTable className="product-entry-table product-entry-item-table" headers={["Category", "Item", "Barcode", "Origin", "Sale Rate", "Min Stock", "Stock", "Lots", "Unit", "Status", "Actions"]}>
                  {filteredProducts.map((product) => (
                    <tr key={product.id}>
                      <td title={product.category_name || product.category || "Fruit"}>{product.category_name || product.category || "Fruit"}</td>
                      <td className="primary-cell product-name-cell" title={product.product_name || "-"}>{product.product_name}<small className="cell-note">{product.remarks || ""}</small></td>
                      <td title={product.barcode || "-"}>{product.barcode || "-"}</td>
                      <td><span className="tag">{product.origin_type || "LOCAL"}</span></td>
                      <td>{currency.format(Number(product.selling_rate))}</td>
                      <td>{product.minimum_stock || 0}</td>
                      <td>{Number(product.current_stock || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</td>
                      <td>{product.lot_count || 0}</td>
                      <td><span className="tag">{product.unit}</span></td>
                      <td><span className={product.active !== false ? "stock-ok" : "stock-low"}>{product.active !== false ? "Active" : "Inactive"}</span></td>
                      <td>
                        <div className="button-row table-actions-row">
                          <button className="table-action" onClick={() => editProduct(product)}>Edit</button>
                          <button className="table-action" onClick={() => loadProductLots(product, true)}>View Lots / Edit Lots</button>
                          <button className="remove-button" disabled={product.active === false} onClick={() => deactivateProduct(product)}>Deactivate</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {filteredProducts.length === 0 && <tr><td colSpan="11" className="empty-cell">No matching items found.</td></tr>}
                </DataTable>
              </ModuleCard>
            </section>
          )}

          {activeView === "purchase" && (
            <section className="settings-layout">
              {purchaseAmendmentMode && (
                <ModuleCard eyebrow="Purchase Amendment" title="Add / Edit Purchase" subtitle="Select date and supplier to amend old purchase entries without deleting history.">
                  <div className="form-grid supplier-form-grid">
                    <Field label="Purchase Date">
                      <input type="date" value={amendmentDate} onChange={(event) => {
                        setAmendmentDate(event.target.value);
                        setPurchaseDate(event.target.value);
                        setAmendmentSupplierId("");
                        setPurchaseSupplierId("");
                        setEditingPurchaseId(null);
                      }} />
                    </Field>
                    <Field label="Supplier On Date">
                      <select value={amendmentSupplierId} onChange={(event) => {
                        setAmendmentSupplierId(event.target.value);
                        setPurchaseSupplierId(event.target.value);
                        setEditingPurchaseId(null);
                      }}>
                        <option value="">Select supplier for this date</option>
                        {amendmentSuppliers.map((purchase) => (
                          <option key={purchase.supplier_id || purchase.supplier_name} value={purchase.supplier_id || ""}>{purchase.supplier_name}</option>
                        ))}
                      </select>
                    </Field>
                    <button className="secondary-button" onClick={startForgottenPurchaseItem}>Add Forgotten Item</button>
                    <button className="secondary-button" onClick={resetPurchaseForm}>Exit Amendment</button>
                  </div>
                  <DataTable headers={["Purchase", "Item", "Qty", "Rate", "Status", "Net", "Actions"]}>
                    {amendmentPurchases.map((purchase) => (
                      <tr key={purchase.id}>
                        <td><span className="batch-id">#{purchase.id}</span></td>
                        <td className="primary-cell">{purchase.product_name}<small className="cell-note">{purchase.batch_no || "-"}</small></td>
                        <td>{Number(purchase.quantity || 0).toLocaleString("en-IN")} {purchase.unit || ""}</td>
                        <td>{currency.format(Number(purchase.purchase_rate || purchase.expected_purchase_rate || 0))}</td>
                        <td><span className={purchase.purchase_status === "CANCELLED" ? "stock-low" : purchase.purchase_bill_status === "BILL_PENDING" ? "origin-rate" : "stock-ok"}>{purchase.purchase_status === "CANCELLED" ? "Cancelled" : purchase.purchase_bill_status === "BILL_PENDING" ? "Pending Bill" : "Completed Bill"}</span></td>
                        <td>{currency.format(Number(purchase.net_payable || purchase.total_amount || 0))}</td>
                        <td>
                          <div className="button-row table-actions-row">
                            <button className="table-action" disabled={purchase.purchase_status === "CANCELLED"} onClick={() => editPurchase(purchase)}>Edit</button>
                            {purchase.purchase_bill_status === "BILL_PENDING" && <button className="primary-button" disabled={purchase.purchase_status === "CANCELLED"} onClick={() => completePendingPurchase(purchase)}>Complete Bill</button>}
                            <button className="remove-button" disabled={purchase.purchase_status === "CANCELLED"} onClick={() => cancelPurchase(purchase)}>Cancel</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                  {amendmentDate && amendmentSupplierId && amendmentPurchases.length === 0 && <div className="cart-empty">No purchases found for selected date and supplier.</div>}
                </ModuleCard>
              )}
              <ModuleCard eyebrow="Procurement" title={editingPurchaseId ? `Add / Edit Purchase #${editingPurchaseId}` : "Purchase Entry"} subtitle={editingPurchaseId ? "Amend one historical purchase item with inventory protection." : "Select supplier once, add multiple fruit items, then save one purchase workflow."}>
                <div className="form-grid supplier-form-grid">
                  <Field label="Entry Type">
                    <select value={purchaseBillStatus} onChange={(event) => setPurchaseBillStatus(event.target.value)} disabled={Boolean(editingPurchaseId && purchases.find((purchase) => Number(purchase.id) === Number(editingPurchaseId))?.purchase_bill_status !== "BILL_PENDING")}>
                      <option value="BILL_COMPLETED">Completed Bill</option>
                      <option value="BILL_PENDING">Stock Arrival / Pending Bill</option>
                    </select>
                  </Field>
                  <Field label="Supplier Account">
                    <select value={purchaseSupplierId} onChange={(event) => setPurchaseSupplierId(event.target.value)}>
                      <option value="">Select saved supplier</option>
                      {activeSuppliers.map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.supplier_name}{supplier.firm_name ? ` - ${supplier.firm_name}` : ""}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={purchaseBillStatus === "BILL_PENDING" ? "Arrival Date" : "Purchase Date"}><input type="date" value={purchaseDate} onChange={(event) => setPurchaseDate(event.target.value)} /></Field>
                  {purchaseBillStatus === "BILL_COMPLETED" && (
                    <>
                      <Field label="Bill Number"><input value={purchaseBillNumber} onChange={(event) => setPurchaseBillNumber(event.target.value)} /></Field>
                      <Field label="Bill Date"><input type="date" value={purchaseBillDate} onChange={(event) => setPurchaseBillDate(event.target.value)} /></Field>
                    </>
                  )}
                </div>
              </ModuleCard>

              <ModuleCard eyebrow={editingPurchaseId ? "Purchase Item Amendment" : "Purchase Cart"} title={editingPurchaseId ? "Edit Purchase Item" : "Add Fruit Items"} subtitle={editingPurchaseId ? "Quantity reductions are blocked if stock from this batch has already been sold." : "Add all products from this supplier before saving the bill."}>
                <div className="form-grid supplier-form-grid">
                  <Field label="Product">
                    <select value={purchaseProductId} onChange={selectPurchaseProduct}>
                      <option value="">Select product</option>
                      {products.filter((product) => product.active !== false).map((product) => <option key={product.id} value={product.id}>{product.category || "Fruit"} - {product.product_name} ({product.unit})</option>)}
                    </select>
                  </Field>
                  <Field label="Lot Name / Number"><input value={purchaseLotName} onChange={(event) => setPurchaseLotName(event.target.value)} placeholder="Lot A / Supplier Bill Lot" /></Field>
                  <Field label="Size / Grade"><input value={purchaseLotSize} onChange={(event) => setPurchaseLotSize(event.target.value)} placeholder="Small / Premium" /></Field>
                  <Field label="Quantity"><input type="number" min="0" step="0.001" value={purchaseQuantity} onChange={(event) => setPurchaseQuantity(event.target.value)} /></Field>
                  {purchaseBillStatus === "BILL_PENDING" ? (
                    <>
                      <Field label="Temporary Sale Rate"><input type="number" min="0" step="0.01" value={temporarySaleRate} onChange={(event) => setTemporarySaleRate(event.target.value)} /></Field>
                      <Field label="Expected Purchase Rate"><input type="number" min="0" step="0.01" value={expectedPurchaseRate} onChange={(event) => setExpectedPurchaseRate(event.target.value)} /></Field>
                    </>
                  ) : (
                    <Field label="Purchase Rate"><input type="number" min="0" step="0.01" value={purchaseRateInput} onChange={(event) => setPurchaseRateInput(event.target.value)} /></Field>
                  )}
                  <Field label="Origin Type"><input value={selectedPurchaseProduct?.origin_type || "Select product"} readOnly /></Field>
                  <Field label="Item Remarks"><input value={purchaseItemRemarks} onChange={(event) => setPurchaseItemRemarks(event.target.value)} /></Field>
                </div>
                {!editingPurchaseId && (
                  <div className="button-row">
                    <button className="secondary-button" onClick={addPurchaseCartItem}>{editingPurchaseItemLineId !== null ? "Update Item" : purchaseAmendmentMode ? "Add Forgotten Item" : "Add Item"}</button>
                    {editingPurchaseItemLineId !== null && <button className="secondary-button" onClick={resetPurchaseItemFields}>Cancel Item Edit</button>}
                  </div>
                )}
                {!editingPurchaseId && (
                  <DataTable headers={["Product", "Lot / Size", "Qty", "Unit", "Origin", "Purchase / Expected Rate", "Temp Sale Rate", "Remarks", "Actions"]}>
                    {purchaseCart.map((item) => (
                      <tr key={item.line_id}>
                        <td className="primary-cell">{item.product_name}</td>
                        <td>{item.lot_name || "-"}{item.lot_size ? ` / ${item.lot_size}` : ""}</td>
                        <td>{item.quantity}</td>
                        <td>{item.unit}</td>
                        <td><span className="origin-rate">{item.origin_type}</span></td>
                        <td>{currency.format(Number(item.purchase_rate || item.expected_purchase_rate || 0))}</td>
                        <td>{item.temporary_sale_rate ? currency.format(Number(item.temporary_sale_rate)) : "-"}</td>
                        <td>{item.remarks || "-"}</td>
                        <td>
                          <div className="button-row table-actions-row">
                            <button className="table-action" onClick={() => editPurchaseCartItem(item.line_id)}>Edit</button>
                            <button className="remove-button" onClick={() => removePurchaseCartItem(item.line_id)}>Remove</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                )}
                {!editingPurchaseId && purchaseCart.length === 0 && <div className="cart-empty">No purchase items added yet.</div>}
              </ModuleCard>

              <ModuleCard eyebrow="Bill Details" title="Charges, Rebate and Payment" subtitle="These values are allocated across items by value when the bill is saved.">
                {purchaseBillStatus === "BILL_COMPLETED" && (
                  <div className="form-grid supplier-form-grid">
                    <Field label="Freight Charges"><input type="number" min="0" step="0.01" value={purchaseFreightCharges} onChange={(event) => setPurchaseFreightCharges(event.target.value)} /></Field>
                    <Field label="Labour Charges"><input type="number" min="0" step="0.01" value={purchaseLabourCharges} onChange={(event) => setPurchaseLabourCharges(event.target.value)} /></Field>
                    <Field label="Other Charges"><input type="number" min="0" step="0.01" value={purchaseOtherCharges} onChange={(event) => setPurchaseOtherCharges(event.target.value)} /></Field>
                    <Field label="Payment Timing / Rebate Rule">
                      <select value={purchaseRebateRuleId} onChange={(event) => setPurchaseRebateRuleId(event.target.value)}>
                        <option value="">Select rebate rule</option>
                        {purchaseRules.rebateRules.map((rule) => <option key={rule.id} value={rule.id}>{rule.rule_name} - {rule.pay_within_days} days - {rule.rebate_percent}%</option>)}
                      </select>
                    </Field>
                    <Field label="Payment Type">
                      <select value={purchaseType} onChange={(event) => setPurchaseType(event.target.value)}>
                        <option value="CREDIT">Credit Purchase</option>
                        <option value="CASH">Cash Purchase</option>
                      </select>
                    </Field>
                    {purchaseType === "CASH" && (
                      <>
                        <Field label="Payment Mode">
                          <select value={purchasePaymentMode} onChange={(event) => setPurchasePaymentMode(event.target.value)}>
                            {supplierPaymentModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                          </select>
                        </Field>
                        <Field label="Paid Amount"><input type="number" min="0" step="0.01" value={purchasePaidAmount} onChange={(event) => setPurchasePaidAmount(event.target.value)} /></Field>
                        <Field label="Payment Reference"><input value={purchasePaymentReference} onChange={(event) => setPurchasePaymentReference(event.target.value)} /></Field>
                        <Field label="Payment Date"><input type="date" value={purchasePaymentDate} onChange={(event) => setPurchasePaymentDate(event.target.value)} /></Field>
                      </>
                    )}
                  </div>
                )}
                <Field label="Bill Remarks"><textarea value={purchaseRemarks} onChange={(event) => setPurchaseRemarks(event.target.value)} /></Field>
                {activeSuppliers.length === 0 && <p className="form-note">No active supplier accounts found. Add New Supplier before saving a purchase.</p>}
                {purchaseBillStatus === "BILL_PENDING" && <p className="form-note">Purchase bill pending. Inventory will increase immediately and profit from this stock will be provisional until the bill is completed.</p>}
                <PurchaseSummary summary={editingPurchaseId ? purchaseSummary : purchaseCartSummary} />
                <div className="button-row">
                  <button className="primary-button" onClick={savePurchase}>{purchaseBillStatus === "BILL_PENDING" ? editingPurchaseId ? "Update Arrival Entry" : "Save Stock Arrival" : editingPurchaseId ? "Complete / Update Purchase" : "Save Purchase"}</button>
                  {editingPurchaseId && <button className="secondary-button" onClick={purchaseAmendmentMode ? cancelPurchaseAmendment : resetPurchaseForm}>Cancel Amendment</button>}
                  <button className="secondary-button" onClick={() => navigate("accounts")}>Add New Supplier</button>
                </div>
              </ModuleCard>
            </section>
          )}

          {activeView === "pending-bills" && (
            <PendingBillsModule
              customerPendingBills={customerPendingBills}
              customers={customers}
              onCancelPurchase={cancelPurchase}
              onCompletePurchase={completePendingPurchase}
              onEditPurchase={editPurchase}
              onReload={async () => {
                await Promise.all([loadPurchases(), loadCustomerPendingBills(), loadDashboardData(), loadReports()]);
              }}
              onOpenPurchaseAmendment={openPurchaseAmendment}
              onViewInvoice={loadInvoice}
              purchases={purchases}
              user={user}
            />
          )}

          {activeView === "accounts" && (
            <AccountsModule
              accounts={accounts}
              accountLedger={accountLedger}
              accountPayments={accountPayments}
              accountOutstanding={accountOutstanding}
              ledgerFocusKey={accountLedgerFocusKey}
              onLedgerLoad={loadAccountLedger}
              onPaymentsLoad={loadAccountPayments}
              onReload={async () => {
                await Promise.all([
                  loadAccounts(),
                  loadSupplierData(),
                  loadCustomerData(),
                  loadAccountOutstanding(),
                  loadAccountPayments(),
                ]);
              }}
              user={user}
            />
          )}

          {activeView === "returns" && (
            <SaleReturnModule
              onReload={async () => {
                await Promise.all([loadSaleReturns(), loadDashboardData(), loadSalesHistory()]);
              }}
              returns={saleReturns}
              salesHistory={salesHistory}
              user={user}
            />
          )}

          {activeView === "waste" && (
            <WasteManagementModule
              entries={wasteEntries}
              inventory={inventory}
              onReload={async () => {
                await Promise.all([loadWasteEntries(), loadDashboardData()]);
              }}
              products={products}
              user={user}
            />
          )}

          {activeView === "sales" && (
            <PosBilling
              customers={customers.filter((customer) => customer.active !== false)}
              deviceInfo={deviceInfo}
              discountRules={discountRules}
              lotDiscounts={lotDiscounts}
              inventory={inventory}
              onInvoice={setSelectedInvoice}
              onSaved={async (result) => {
                if (result?.localSale) {
                  setSalesHistory((rows) => [result.localSale, ...rows]);
                  setInventory((rows) => rows.map((lot) => {
                    const movement = result.localSale.items.find((item) => String(item.inventory_batch_id) === String(lot.id));
                    return movement
                      ? { ...lot, remaining_qty: Math.max(Number(lot.remaining_qty || 0) - Number(movement.quantity || 0), 0) }
                      : lot;
                  }));
                  await refreshSyncStatus();
                  return;
                }
                await Promise.all([loadDashboardData(), loadLotDiscounts(), loadCustomerPendingBills()]);
              }}
              paymentSettings={settingsData.paymentSettings}
              posSettings={settingsData.posSettings}
              printSettings={settingsData.businessSettings}
              products={products.filter((product) => product.active !== false)}
              refreshToken={posRefreshToken}
              saleRateSettings={settingsData.saleRateSettings}
              syncInBackground={runSyncNow}
              onConfigureMandiTax={() => setActiveView("settings")}
              canManualRateOverride={hasRolePermission("manual_pos_rate_override")}
              canPosDateOverride={hasRolePermission("pos_date_override")}
              user={user}
            />
          )}

          {activeView === "discounts" && (
            <DiscountManagementModule
              discounts={lotDiscounts}
              inventory={inventory}
              onReload={async () => {
                await Promise.all([loadLotDiscounts(), loadDashboardData()]);
              }}
              products={products.filter((product) => product.active !== false)}
              user={user}
            />
          )}

          {activeView === "sale-rates" && canManageRates && (
            <SaleRateManager
              history={saleRateHistory}
              onReload={async () => { await Promise.all([loadProducts(), loadSaleRates()]); }}
              onRefresh={loadSaleRates}
              rates={saleRates}
              desiredMargin={saleDesiredMargin}
              setDesiredMargin={setSaleDesiredMargin}
              user={user}
            />
          )}

          {activeView === "settings" && (
            <ModuleErrorBoundary onClose={() => setActiveView("dashboard")}>
              <SettingsModule
                applicationFontSize={applicationFontSize}
                backendHealth={backendHealth}
                canManage={canManageRates}
                cloudDeviceRegistration={cloudDeviceRegistration}
                cloudDiagnostics={cloudDiagnostics}
                cloudHealth={cloudHealth}
                connectionStatus={connectionStatus}
                localBackendService={localBackendService}
                localDbStatus={localDbStatus}
                onCheckConnection={() => performConnectivityCheck("settings-sync-check", { force: true, timeoutMs: 3500 })}
                onReload={async () => { await Promise.all([loadSettingsData(), loadPurchaseRules(), loadDiscountRules()]); }}
                onRetrySync={retrySyncFailures}
                onRunCloudDiagnostics={runCloudDiagnostics}
                onRunSync={() => runSyncNow({ force: true })}
                onQueueSyncTest={queuePhase2SyncTest}
                settingsData={settingsData}
                setApplicationFontSize={setApplicationFontSize}
                syncMessage={syncMessage}
                syncStatus={syncStatus}
                rules={settingsRules}
                user={user}
              />
            </ModuleErrorBoundary>
          )}

          {activeView === "reports" && (
            <ReportsModule
              accounts={accounts}
              canCancelSales={canCancelSales}
              canEditSales={canEditSales}
              canManageStock={canManageStock}
              customers={customers}
              data={reportsData}
              onCancelPurchase={cancelPurchase}
              onCompletePurchase={completePendingPurchase}
              onEditPurchase={editPurchase}
              onOpenCustomerLedger={openCustomerLedgerFromReport}
              onOpenBlankPurchaseAmendment={openBlankPurchaseAmendment}
              onOpenPurchaseAmendment={openPurchaseAmendment}
              onOpenSaleForEdit={openSaleForEditFromReport}
              onOpenSaleView={loadInvoice}
              onPrintSale={printSaleInvoice}
              onCancelSale={cancelSale}
              onOpenLotAction={openLotAction}
              onOpenSupplierLedger={openSupplierLedgerFromReport}
              onReload={loadReports}
              suppliers={suppliers}
              user={user}
            />
          )}

          {activeView === "expenses" && (
            <ExpensesModule
              expenses={expenses}
              onReload={loadExpenses}
              user={user}
            />
          )}
        </div>
      </section>
      {exitCodeModal}
      {selectedInvoice && (
        <InvoiceModal
          autoPrintMode={selectedInvoicePrintMode}
          canCancel={canCancelSales && selectedInvoice.sale_status !== "CANCELLED"}
          canEdit={canEditSales && selectedInvoice.sale_status !== "CANCELLED"}
          invoice={selectedInvoice}
          onCancel={async () => {
            const invoice = selectedInvoice;
            const cancelled = await cancelSale(invoice);
            if (cancelled) {
              setSelectedInvoice(null);
              setSelectedInvoicePrintMode(null);
            }
          }}
          onClose={() => {
            setSelectedInvoice(null);
            setSelectedInvoicePrintMode(null);
          }}
          onEdit={() => {
            const invoice = selectedInvoice;
            setSelectedInvoice(null);
            setSelectedInvoicePrintMode(null);
            openSaleForEditFromReport(invoice);
          }}
          paymentSettings={settingsData.paymentSettings}
          printSettings={settingsData.businessSettings}
          user={user}
        />
      )}
      {saleEditLoading && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="cart-empty">Loading invoice editor...</div>
          </section>
        </div>
      )}
      {saleEditError && !saleEditLoading && !editingSale && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Edit Bill</span>
                <strong>Unable to load invoice</strong>
              </div>
              <button className="remove-button" onClick={() => setSaleEditError("")}><Icon name="close" /></button>
            </div>
            <div className="cart-empty">{saleEditError}</div>
          </section>
        </div>
      )}
      {editingSale && (
        <ModuleErrorBoundary onClose={() => setEditingSale(null)}>
          <SaleEditModal
            deviceInfo={deviceInfo}
            invoice={editingSale}
            offlineMode={offlineMode}
            onClose={() => setEditingSale(null)}
            onAddCustomer={() => {
              setEditingSale(null);
              navigate("accounts");
            }}
            onSaved={async (result) => {
              setEditingSale(null);
              if (result?.localSale) {
                setSalesHistory((rows) => {
                  const exists = rows.some((row) => String(row.id || row.sale_id) === String(result.localSale.id || result.localSale.sale_id));
                  return exists
                    ? rows.map((row) => String(row.id || row.sale_id) === String(result.localSale.id || result.localSale.sale_id) ? { ...row, ...result.localSale } : row)
                    : [result.localSale, ...rows];
                });
                const snapshot = await loadLocalReferenceSnapshot({ username: user?.username, deviceId: deviceInfo.device_id }).catch(() => null);
                if (snapshot) {
                  setInventory(snapshot.inventory_lots || []);
                }
                await refreshSyncStatus();
                return;
              }
              await Promise.all([loadSalesHistory(), loadDashboardData(), loadReports()]);
            }}
            products={products.filter((product) => product.active !== false)}
            inventory={inventory}
            canSaleDateEdit={hasRolePermission("sale_date_edit")}
            customers={customers.filter((customer) => customer.active !== false)}
            paymentSettings={settingsData.paymentSettings}
            user={user}
          />
        </ModuleErrorBoundary>
      )}
      {cancelDraft && (
        <SaleCancelModal
          draft={cancelDraft}
          onClose={() => setCancelDraft(null)}
          onConfirm={confirmCancelSale}
          onReasonChange={(reason) => setCancelDraft((current) => current ? { ...current, reason } : current)}
        />
      )}
      {changeHistory && <ChangeHistoryModal history={changeHistory} onClose={() => setChangeHistory(null)} />}
      {lotAction && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Opening Stock Lot</span>
                <strong>
                  {lotAction.type === "edit" && "Edit Lot"}
                  {lotAction.type === "add" && "Add Quantity"}
                  {lotAction.type === "adjust" && "Adjust Quantity"}
                  {lotAction.type === "transfer" && "Transfer Stock"}
                  {lotAction.type === "deactivate" && "Deactivate Lot"}
                  {lotAction.type === "reactivate" && "Reactivate Lot"}
                </strong>
              </div>
              <button aria-label="Close lot editor" className="remove-button" onClick={closeLotAction}><Icon name="close" /></button>
            </div>
            <div className="sale-edit-body">
              <div className="purchase-summary-grid supplier-payment-preview">
                <SummaryMetric label="Product" value={lotAction.lot.product_name || lotPanelProduct?.product_name || "-"} />
                <SummaryMetric label="Lot" value={lotAction.lot.lot_name || lotAction.lot.batch_no || `#${lotAction.lot.id}`} />
                <SummaryMetric label="Opening Qty" value={Number(lotAction.lot.purchase_qty || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} />
                <SummaryMetric label="Used Qty" value={Number(lotAction.lot.sold_qty ?? (Number(lotAction.lot.purchase_qty || 0) - Number(lotAction.lot.remaining_qty || 0))).toLocaleString("en-IN", { maximumFractionDigits: 3 })} />
                <SummaryMetric label="Balance Qty" value={Number(lotAction.lot.balance_qty ?? lotAction.lot.remaining_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} featured />
              </div>

              {lotAction.type === "edit" && (
                <div className="form-grid supplier-form-grid">
                  <Field label="Lot Name / Number"><input value={lotDraft.lot_name} onChange={(event) => setLotDraft({ ...lotDraft, lot_name: event.target.value })} /></Field>
                  <Field label="Size / Grade"><input value={lotDraft.lot_size} onChange={(event) => setLotDraft({ ...lotDraft, lot_size: event.target.value })} /></Field>
                  <Field label="Supplier (Optional)">
                    <select value={lotDraft.supplier_id} onChange={(event) => setLotDraft({ ...lotDraft, supplier_id: event.target.value })}>
                      <option value="">No supplier</option>
                      {activeSuppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.supplier_name}</option>)}
                    </select>
                  </Field>
                  <Field label="Opening Quantity"><input min="0" step="0.001" type="number" value={lotDraft.purchase_qty} onChange={(event) => setLotDraft({ ...lotDraft, purchase_qty: event.target.value })} /></Field>
                  <Field label="Current Balance Qty"><input readOnly value={Number(lotAction.lot.balance_qty ?? lotAction.lot.remaining_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} /></Field>
                  <Field label="Opening Cost / Purchase Rate"><input min="0" step="0.01" type="number" value={lotDraft.purchase_rate} onChange={(event) => setLotDraft({ ...lotDraft, purchase_rate: event.target.value })} /></Field>
                  <Field label="Sale Rate"><input min="0" step="0.01" type="number" value={lotDraft.sale_rate} onChange={(event) => setLotDraft({ ...lotDraft, sale_rate: event.target.value })} /></Field>
                  <Field label="Opening Stock Date"><input type="date" value={lotDraft.opening_stock_date} onChange={(event) => setLotDraft({ ...lotDraft, opening_stock_date: event.target.value })} /></Field>
                  <Field label="Remarks"><input value={lotDraft.remarks} onChange={(event) => setLotDraft({ ...lotDraft, remarks: event.target.value })} /></Field>
                  <Field label="Reason"><input value={lotDraft.reason} onChange={(event) => setLotDraft({ ...lotDraft, reason: event.target.value })} placeholder="Reason for audit trail" /></Field>
                </div>
              )}

              {lotAction.type === "add" && (
                <div className="form-grid supplier-form-grid">
                  <Field label="Quantity To Add"><input min="0" step="0.001" type="number" value={lotDraft.quantity} onChange={(event) => setLotDraft({ ...lotDraft, quantity: event.target.value })} /></Field>
                  <Field label="Reason"><input value={lotDraft.reason} onChange={(event) => setLotDraft({ ...lotDraft, reason: event.target.value })} placeholder="Example: missed opening stock count" /></Field>
                </div>
              )}

              {lotAction.type === "adjust" && (
                <div className="form-grid supplier-form-grid">
                  <Field label="Current Software Qty"><input readOnly value={Number(lotAction.lot.balance_qty ?? lotAction.lot.remaining_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} /></Field>
                  <Field label="Physical / Corrected Quantity"><input min="0" step="0.001" type="number" value={lotDraft.new_quantity} onChange={(event) => setLotDraft({ ...lotDraft, new_quantity: event.target.value })} /></Field>
                  <Field label="Difference / Adjustment Qty"><input readOnly value={(Number(lotDraft.new_quantity || 0) - Number(lotAction.lot.balance_qty ?? lotAction.lot.remaining_qty ?? 0)).toLocaleString("en-IN", { maximumFractionDigits: 3 })} /></Field>
                  <Field label="Adjustment Type">
                    <select value={lotDraft.adjustment_type} onChange={(event) => setLotDraft({ ...lotDraft, adjustment_type: event.target.value })}>
                      <option>Increase Stock</option>
                      <option>Decrease Stock</option>
                      <option>Physical Count Correction</option>
                      <option>Damage</option>
                      <option>Missing</option>
                      <option>Found</option>
                      <option>Owner Adjustment</option>
                    </select>
                  </Field>
                  <Field label="Adjustment Date"><input type="date" value={lotDraft.adjustment_date} onChange={(event) => setLotDraft({ ...lotDraft, adjustment_date: event.target.value })} /></Field>
                  <Field label="Reason"><input value={lotDraft.reason} onChange={(event) => setLotDraft({ ...lotDraft, reason: event.target.value })} placeholder="Reason is mandatory" /></Field>
                  <Field label="Remarks"><input value={lotDraft.remarks} onChange={(event) => setLotDraft({ ...lotDraft, remarks: event.target.value })} /></Field>
                </div>
              )}

              {lotAction.type === "transfer" && (
                <div className="form-grid supplier-form-grid">
                  <Field label="From Lot"><input readOnly value={`${lotAction.lot.product_name || ""} - ${lotAction.lot.lot_name || lotAction.lot.batch_no || `Lot #${lotAction.lot.id}`}`} /></Field>
                  <Field label="Available Qty"><input readOnly value={Number(lotAction.lot.balance_qty ?? lotAction.lot.remaining_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} /></Field>
                  <Field label="To Lot">
                    <select value={lotDraft.transfer_to_lot_id} onChange={(event) => setLotDraft({ ...lotDraft, transfer_to_lot_id: event.target.value })}>
                      <option value="">Select destination lot</option>
                      {inventory
                        .filter((lot) => Number(lot.id) !== Number(lotAction.lot.id) && String(lot.batch_status || "ACTIVE").toUpperCase() !== "CANCELLED")
                        .map((lot) => (
                          <option key={lot.id} value={lot.id}>
                            {lot.product_name} - {lot.lot_name || lot.batch_no || `Lot #${lot.id}`}{lot.lot_size ? ` / ${lot.lot_size}` : ""} - Bal {Number(lot.balance_qty ?? lot.remaining_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}
                          </option>
                        ))}
                    </select>
                  </Field>
                  <Field label="Quantity To Move"><input min="0" step="0.001" type="number" value={lotDraft.transfer_quantity} onChange={(event) => setLotDraft({ ...lotDraft, transfer_quantity: event.target.value })} /></Field>
                  <Field label="Reason"><input value={lotDraft.reason} onChange={(event) => setLotDraft({ ...lotDraft, reason: event.target.value })} placeholder="Reason is mandatory" /></Field>
                  <Field label="Remarks"><input value={lotDraft.remarks} onChange={(event) => setLotDraft({ ...lotDraft, remarks: event.target.value })} /></Field>
                </div>
              )}

              {lotAction.type === "deactivate" && (
                <Field label="Reason"><textarea value={lotDraft.reason} onChange={(event) => setLotDraft({ ...lotDraft, reason: event.target.value })} placeholder="Reason is mandatory. Lots with used stock cannot be deactivated." /></Field>
              )}

              {lotAction.type === "reactivate" && (
                <Field label="Reason"><textarea value={lotDraft.reason} onChange={(event) => setLotDraft({ ...lotDraft, reason: event.target.value })} placeholder="Reason is mandatory. Reactivated lots return available unsold quantity to active stock." /></Field>
              )}

              <div className="button-row">
                <button className="primary-button" onClick={saveLotAction}>Save Lot Changes</button>
                <button className="secondary-button" onClick={closeLotAction}>Cancel</button>
              </div>
            </div>
          </section>
        </div>
      )}
      <FrostFloatingCopilot
        activeTab={frostActiveTab}
        data={aiAssistantData}
        onAlertAction={updateAiAlert}
        onAsk={askAiAssistant}
        onClose={() => setFrostDrawerOpen(false)}
        onMemoryAction={updateFrostMemory}
        onNavigate={navigate}
        onOpen={() => openFrostDrawer("briefing")}
        onProposeAction={proposeFrostAction}
        onProposeMemory={proposeFrostMemory}
        onQuestionChange={setAiQuestion}
        onRangeChange={(range) => {
          setAiRange(range);
          loadAiAssistant(range);
        }}
        onRefresh={() => loadAiAssistant(aiRange)}
        onReminderAction={updateAiReminder}
        onSaveSettings={saveFrostSettings}
        onSelectQuestion={(question) => askAiAssistant(question)}
        onStartVoice={startFrostVoice}
        onStopVoice={stopFrostVoice}
        onTabChange={setFrostActiveTab}
        open={frostDrawerOpen}
        question={aiQuestion}
        range={aiRange}
        unreadCount={frostUnreadCount}
        user={user}
      />
      {commandPaletteOpen && (
        <CommandPalette
          commands={commandItems}
          onClose={() => setCommandPaletteOpen(false)}
        />
      )}
      {profileOpen && <UserProfilePanel onClose={() => setProfileOpen(false)} onLogout={() => setUser(null)} user={user} />}
    </main>
  );
}

function FrostFloatingCopilot({
  activeTab,
  data,
  onAlertAction,
  onAsk,
  onClose,
  onMemoryAction,
  onNavigate,
  onOpen,
  onProposeAction,
  onProposeMemory,
  onQuestionChange,
  onRangeChange,
  onRefresh,
  onReminderAction,
  onSaveSettings,
  onSelectQuestion,
  onStartVoice,
  onStopVoice,
  onTabChange,
  open,
  question,
  range,
  unreadCount = 0,
  user,
}) {
  return (
    <>
      <button
        aria-label="Open FROST"
        className={`frost-floating-launcher ${unreadCount ? "frost-floating-launcher-alert" : ""}`}
        onClick={onOpen}
        type="button"
      >
        <span className="frost-orbit" />
        <strong>F</strong>
        {unreadCount > 0 && <em>{Math.min(unreadCount, 99)}</em>}
      </button>
      {open && <button aria-label="Close FROST" className="frost-drawer-backdrop" onClick={onClose} type="button" />}
      <aside aria-label="FROST" className={`frost-drawer ${open ? "frost-drawer-open" : ""}`}>
        <div className="frost-drawer-header">
          <div>
            <span className="eyebrow">Floating Copilot</span>
            <h2>FROST</h2>
          </div>
          <button aria-label="Close FROST" className="remove-button" onClick={onClose} type="button"><Icon name="close" /></button>
        </div>
        <div className="frost-drawer-body">
          <AiBusinessAssistantModule
            activeTab={activeTab}
            data={data}
            onAlertAction={onAlertAction}
            onAsk={onAsk}
            onMemoryAction={onMemoryAction}
            onNavigate={onNavigate}
            onProposeAction={onProposeAction}
            onProposeMemory={onProposeMemory}
            onQuestionChange={onQuestionChange}
            onRangeChange={onRangeChange}
            onRefresh={onRefresh}
            onReminderAction={onReminderAction}
            onSaveSettings={onSaveSettings}
            onSelectQuestion={onSelectQuestion}
            onStartVoice={onStartVoice}
            onStopVoice={onStopVoice}
            onTabChange={onTabChange}
            question={question}
            range={range}
            user={user}
          />
        </div>
      </aside>
    </>
  );
}

function CommandPalette({ commands = [], onClose }) {
  const [query, setQuery] = useState("");
  const filtered = commands.filter(([, label]) => label.toLowerCase().includes(query.trim().toLowerCase()));
  const runCommand = (command) => {
    command?.();
    onClose?.();
  };
  return (
    <div className="command-palette-backdrop" onClick={onClose}>
      <section className="command-palette" onClick={(event) => event.stopPropagation()}>
        <div className="command-palette-header">
          <span className="eyebrow">Command Palette</span>
          <button aria-label="Close command palette" className="remove-button" onClick={onClose} type="button"><Icon name="close" /></button>
        </div>
        <input autoFocus placeholder="Search commands" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="command-list">
          {filtered.map(([view, label, command]) => (
            <button key={`${view}-${label}`} onClick={() => runCommand(command)} type="button">
              <Icon name={icons[view] || "settings"} />
              <span>{label}</span>
            </button>
          ))}
          {filtered.length === 0 && <div className="cart-empty">No matching command.</div>}
        </div>
      </section>
    </div>
  );
}
const aiSeverityClass = (severity = "INFO") => `ai-severity ai-severity-${String(severity).toLowerCase()}`;

function AiBusinessAssistantModule({
  activeTab = "briefing",
  data,
  onAlertAction,
  onAsk,
  onNavigate,
  onQuestionChange,
  onRangeChange,
  onRefresh,
  onReminderAction,
  onMemoryAction,
  onProposeMemory,
  onSaveSettings,
  onStartVoice,
  onStopVoice,
  onTabChange,
  onProposeAction,
  onSelectQuestion,
  question,
  range,
  user,
}) {
  const briefing = data.briefing || {};
  const cards = briefing.cards || {};
  const latestAnswer = data.history[0];
  const canManageReminders = user?.role === "Owner" || user?.role === "Admin";
  const canManageFrost = user?.role === "Owner" || user?.role === "Admin";
  const periodLabel = data.period?.label || briefing.period?.label || "Current data";
  const cardValue = (section, key, fallback = 0) => cards[section]?.[key] ?? fallback;
  const money = (value) => currency.format(Number(value || 0));
  const tabItems = [
    ["briefing", "Briefing"],
    ["ask", "Ask FROST"],
    ["voice", "Voice"],
    ["alerts", "Alerts"],
    ["decision", "Decision Center"],
    ["predictions", "Predictions"],
    ["profit", "Profit Advisor"],
    ["memory", "Memory"],
    ["reminders", "Reminders"],
    ["history", "History"],
    ["settings", "Settings"],
  ];
  const openLinkedModule = (type) => {
    if (type === "customer") return onNavigate("accounts");
    if (type === "supplier" || type === "purchase") return onNavigate("pending-bills");
    if (type === "product") return onNavigate("products");
    return onNavigate("reports");
  };

  return (
    <section className="ai-assistant-shell">
      <div className="ai-toolbar">
        <div>
          <span className="eyebrow">Verified Business Facts</span>
          <h2>FROST</h2>
          <p>FroozERP AI operating system. Data period: {periodLabel}. Every figure comes from verified modules before explanation.</p>
        </div>
        <div className="button-row">
          <select value={range} onChange={(event) => onRangeChange(event.target.value)}>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="last_7_days">Last 7 Days</option>
            <option value="this_month">This Month</option>
          </select>
          <button className="secondary-button" disabled={data.loading} onClick={onRefresh}><Icon name="history" /> Refresh data</button>
        </div>
      </div>

      {data.error && (
        <div className="startup-status-panel startup-status-error">
          <p>{data.error}</p>
          {Object.keys(cards).length > 0 && <small>Showing last verified local values until refresh succeeds.</small>}
          {Boolean(data.diagnostics?.length) && (
            <div className="frost-diagnostics-list">
              {data.diagnostics.filter((item) => !item.ok).slice(0, 6).map((item) => (
                <small key={`${item.method}-${item.url}`}>
                  {item.label}: {item.status || "no response"} - {item.message} ({item.apiMode}, {item.localBackendHealth})
                </small>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="frost-tabs" role="tablist" aria-label="FROST sections">
        {tabItems.map(([key, label]) => (
          <button
            className={activeTab === key ? "frost-tab frost-tab-active" : "frost-tab"}
            key={key}
            onClick={() => onTabChange?.(key)}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === "briefing" && <div className="ai-brief-grid">
        <SummaryMetric featured label="Sales" value={money(cardValue("sales", "totalSales"))} />
        <SummaryMetric label="Gross Profit" positive value={money(cardValue("sales", "estimatedGrossProfit"))} />
        <SummaryMetric label="Customer Overdue" value={money(cardValue("customerOutstanding", "totalOutstanding"))} />
        <SummaryMetric label="Supplier Due" value={money(cardValue("supplierOutstanding", "totalOutstanding"))} />
        <SummaryMetric label="Pending Bills" value={cardValue("pendingPurchases", "count")} />
        <SummaryMetric label="Low Stock" value={cardValue("lowStock", "count")} />
      </div>}

      {(activeTab === "ask" || activeTab === "briefing") && <div className="ai-layout">
        {activeTab === "ask" && (
        <ModuleCard eyebrow="Ask FROST" title="Controlled Business Questions" subtitle="Answers use the shared FROST service layer. No write action is performed without owner approval.">
          {data.loading && <div className="ai-thinking"><span /> FROST is thinking</div>}
          <div className="ai-question-box">
            <textarea value={question} onChange={(event) => onQuestionChange(event.target.value)} placeholder="Ask about overdue payments, low stock, sales, profit, expenses or pending purchase bills." />
            <button className="primary-button" disabled={data.loading || !question.trim()} onClick={() => onAsk()}><Icon name="message" /> Ask</button>
          </div>
          <div className="ai-suggestion-grid">
            {(data.suggestedQuestions || []).map((item) => (
              <button className="ai-suggestion" key={item} disabled={data.loading} onClick={() => onSelectQuestion(item)}>{item}</button>
            ))}
          </div>
          {latestAnswer && (
            <article className="ai-answer-panel">
              <span className="eyebrow">{latestAnswer.period?.label || periodLabel}</span>
              <h3>{latestAnswer.question}</h3>
              <p>{latestAnswer.answer}</p>
              <small>Source modules: {[...new Set((latestAnswer.facts || []).map((fact) => fact.sourceModule))].join(", ") || "Verified FroozERP facts"}</small>
            </article>
          )}
        </ModuleCard>
        )}

        {activeTab === "briefing" && (
        <ModuleCard eyebrow="Daily Owner Brief" title="Top Recommendations" subtitle="Deterministic alerts remain available even when external AI providers are disabled.">
          <div className="ai-recommendations">
            {(data.dailyPlan?.top_priorities || []).slice(0, 5).map((item) => <p key={`priority-${item}`}>Start My Day: {item}</p>)}
            {(data.dailyPlan?.topPriorities || []).slice(0, 5).map((item) => <p key={`priority-${item}`}>Start My Day: {item}</p>)}
            {(briefing.recommendations || ["No briefing loaded yet."]).map((item) => <p key={item}>{item}</p>)}
            {(data.dailyPlan?.can_wait || []).slice(0, 3).map((item) => <p key={`wait-${item}`}>Can wait: {item}</p>)}
          </div>
          <div className="ai-collection-strip">
            <span>Cash {money(cardValue("collections", "cash"))}</span>
            <span>UPI {money(cardValue("collections", "upi"))}</span>
            <span>Card/Bank {money(cardValue("collections", "card"))}</span>
            <span>Waste {money(cardValue("waste", "totalWasteCost"))}</span>
          </div>
        </ModuleCard>
        )}
      </div>}

      {activeTab === "voice" && (
        <FrostVoicePanel
          onStart={onStartVoice}
          onStop={onStopVoice}
          voice={data.voice || {}}
        />
      )}

      {activeTab === "predictions" && (
        <FrostPredictionsPanel predictions={data.predictions || {}} onProposeAction={onProposeAction} />
      )}

      {activeTab === "decision" && (
        <FrostAutonomousDecisionCenter data={data.autonomous || {}} onProposeAction={onProposeAction} />
      )}

      {activeTab === "profit" && (
        <FrostProfitAdvisorPanel recommendations={data.profitAdvisor || []} onProposeAction={onProposeAction} />
      )}

      {activeTab === "memory" && (
        <FrostMemoryPanel
          canManage={canManageFrost}
          memories={data.memories || []}
          onMemoryAction={onMemoryAction}
          onProposeMemory={onProposeMemory}
        />
      )}

      {activeTab === "settings" && <FrostConfigurationPanel
        canManage={canManageFrost}
        data={data}
        onSave={onSaveSettings}
      />}

      {activeTab === "briefing" && <ModuleCard eyebrow="AI Briefing Cards" title="Owner Copilot Priorities" subtitle="Each action is read-only or recorded for owner approval. FROST never executes business changes directly.">
        <div className="frost-card-grid">
          {(briefing.insightCards || []).map((card) => (
            <article className={`frost-insight-card frost-priority-${String(card.priority || "Information").toLowerCase()}`} key={card.id}>
              <span>{card.priority}</span>
              <strong>{card.title}</strong>
              <p>{typeof card.value === "number" ? money(card.value) : card.value}</p>
              <small>{card.sourceModule}</small>
              <div className="button-row">
                {(card.actions || []).map((action) => (
                  <button className="table-action" key={action} onClick={() => onProposeAction(action, { card_id: card.id, source_module: card.sourceModule })}>{action}</button>
                ))}
              </div>
            </article>
          ))}
          {(!briefing.insightCards || briefing.insightCards.length === 0) && <div className="cart-empty">Refresh FROST to generate briefing cards.</div>}
        </div>
      </ModuleCard>}

      {(activeTab === "alerts" || activeTab === "reminders") && <div className="ai-layout ai-layout-single">
        {activeTab === "alerts" && (
        <ModuleCard eyebrow="Priority Alerts" title="Needs Attention" subtitle="Acknowledge, snooze or resolve after reviewing the linked module.">
          <DataTable headers={["Severity", "Alert", "Source", "Actions"]}>
            {(data.alerts || []).slice(0, 12).map((alert) => (
              <tr key={alert.id}>
                <td><span className={aiSeverityClass(alert.severity)}>{alert.severity}</span></td>
                <td className="primary-cell">{alert.title}<small className="cell-note">{alert.message}</small></td>
                <td><button className="table-action" onClick={() => openLinkedModule(alert.linked_entity_type)}>{alert.source_module}</button></td>
                <td>
                  <div className="button-row table-actions-row">
                    <button className="table-action" disabled={!canManageReminders} onClick={() => onAlertAction(alert.id, "ACKNOWLEDGE")}>Ack</button>
                    <button className="table-action" disabled={!canManageReminders} onClick={() => onAlertAction(alert.id, "SNOOZE")}>Snooze</button>
                    <button className="remove-button" disabled={!canManageReminders} onClick={() => onAlertAction(alert.id, "RESOLVE")}>Resolve</button>
                  </div>
                </td>
              </tr>
            ))}
            {(!data.alerts || data.alerts.length === 0) && <tr><td colSpan="4" className="empty-cell">No open AI alerts for this period.</td></tr>}
          </DataTable>
        </ModuleCard>
        )}

        {activeTab === "reminders" && (
        <ModuleCard eyebrow="Reminder Centre" title="Drafts and Follow-ups" subtitle="WhatsApp messages are drafts only until an owner reviews and approves them.">
          <DataTable headers={["Priority", "Reminder", "Due", "Actions"]}>
            {(data.reminders || []).slice(0, 10).map((reminder) => (
              <tr key={reminder.id}>
                <td><span className={aiSeverityClass(reminder.priority)}>{reminder.priority}</span></td>
                <td className="primary-cell">{reminder.title}<small className="cell-note">{reminder.draft_message || reminder.message}</small></td>
                <td>{formatDisplayDate(reminder.due_at)}</td>
                <td>
                  <div className="button-row table-actions-row">
                    <button className="table-action" disabled={!canManageReminders} onClick={() => onReminderAction(reminder.id, "ACKNOWLEDGE")}>Review</button>
                    <button className="table-action" disabled={!canManageReminders} onClick={() => onReminderAction(reminder.id, "SNOOZE")}>Snooze</button>
                    <button className="remove-button" disabled={!canManageReminders} onClick={() => onReminderAction(reminder.id, "RESOLVE")}>Resolve</button>
                  </div>
                </td>
              </tr>
            ))}
            {(!data.reminders || data.reminders.length === 0) && <tr><td colSpan="4" className="empty-cell">No reminders queued.</td></tr>}
          </DataTable>
        </ModuleCard>
        )}
      </div>}

      {activeTab === "history" && <ModuleCard eyebrow="Conversation History" title="Audited FROST Answers" subtitle="Questions, verified facts, token usage and provider context are recorded on the backend.">
        <div className="ai-history-list">
          {data.history.map((item) => (
            <article key={item.id} className="ai-history-item">
              <strong>{item.question}</strong>
              <p>{item.answer}</p>
              <small>{item.period?.label || periodLabel}{item.cached ? " - cached" : ""}{item.usage ? ` - ${item.usage.inputTokens + item.usage.outputTokens} estimated tokens` : ""}</small>
            </article>
          ))}
          {data.history.length === 0 && <div className="cart-empty">Ask a question to start an audited business conversation.</div>}
        </div>
      </ModuleCard>}
    </section>
  );
}

function FrostPredictionsPanel({ predictions = {}, onProposeAction }) {
  const groups = [
    ["inventory", "Inventory", predictions.inventory || []],
    ["sales", "Sales", predictions.sales || []],
    ["cashflow", "Cash Flow", predictions.cashflow || []],
    ["waste", "Waste", predictions.waste || []],
  ];
  return (
    <div className="frost-panel-stack">
      {groups.map(([key, label, rows]) => (
        <ModuleCard key={key} eyebrow="Predictive Intelligence" title={`${label} Predictions`} subtitle="Deterministic ranges only. FROST returns insufficient data instead of guessing.">
          <div className="frost-card-grid">
            {rows.map((item, index) => (
              <article className="frost-insight-card" key={`${item.type || key}-${item.entity_id || index}`}>
                <span>{Math.round(Number(item.confidence || 0) * 100)}% confidence</span>
                <strong>{item.title}</strong>
                <p>{item.payload?.status === "INSUFFICIENT_DATA" ? "Insufficient data" : item.payload?.range ? `${currency.format(item.payload.range[0])} - ${currency.format(item.payload.range[1])}` : item.payload?.likelyLowStockDate || item.recommendation}</p>
                <small>{item.prediction_period} - {item.reason}</small>
                <small>Minimum data: {item.minimum_data_requirement}</small>
                <button className="table-action" onClick={() => onProposeAction?.("review prediction", { prediction_type: item.type, entity_id: item.entity_id })}>Review</button>
              </article>
            ))}
            {rows.length === 0 && <div className="cart-empty">No {label.toLowerCase()} predictions available yet.</div>}
          </div>
        </ModuleCard>
      ))}
    </div>
  );
}

function FrostAutonomousDecisionCenter({ data = {}, onProposeAction }) {
  const health = data.health || data.decisionCenter?.health || {};
  const policy = data.policy || data.decisionCenter?.approval_policy || "All recommendations require owner approval before execution.";
  const topPricing = data.pricing || [];
  const topPurchases = data.purchases || [];
  const topWaste = data.waste || [];
  const topCustomers = data.customers || [];
  const topSuppliers = data.suppliers || [];
  const cashflow = data.cashflow || [];
  const demand = data.demand || [];
  const propose = (action, payload) => onProposeAction?.(action, { ...payload, source: "autonomous_decision_center" });
  return (
    <div className="frost-panel-stack">
      <ModuleCard eyebrow="Owner Decision Center" title="Autonomous Business Intelligence" subtitle={policy}>
        <div className="ai-brief-grid">
          <SummaryMetric featured label="Business Health" value={health.score !== undefined ? `${health.score}/100` : "n/a"} />
          <SummaryMetric label="Status" value={health.color || "Not scored"} />
          <SummaryMetric label="Pricing Ideas" value={topPricing.length} />
          <SummaryMetric label="Purchase Suggestions" value={topPurchases.length} />
          <SummaryMetric label="Waste Alerts" value={topWaste.filter((item) => item.color_status !== "Green").length} />
          <SummaryMetric label="Customer Opportunities" value={topCustomers.filter((item) => ["VIP", "INACTIVE", "GROWING"].includes(item.segment)).length} />
        </div>
      </ModuleCard>

      <ModuleCard eyebrow="Dynamic Pricing" title="Approval-Only Price Intelligence" subtitle="No sale rate changes are applied automatically.">
        <DataTable headers={["Fruit", "Recommendation", "Impact", "Priority", "Action"]}>
          {topPricing.slice(0, 8).map((item) => (
            <tr key={item.product_id}>
              <td className="primary-cell">{item.product_name}<small className="cell-note">Rate {currency.format(item.current_selling_rate)} - margin {item.margin_percent ?? "n/a"}%</small></td>
              <td>{item.action_text}<small className="cell-note">{item.reason}</small></td>
              <td>{currency.format(item.expected_revenue_impact)} revenue<small className="cell-note">{currency.format(item.expected_profit_impact)} profit - {Math.round(Number(item.confidence || 0) * 100)}%</small></td>
              <td><span className={aiSeverityClass(item.priority)}>{item.priority}</span></td>
              <td><button className="table-action" onClick={() => propose(item.action_text, { product_id: item.product_id })}>Review</button></td>
            </tr>
          ))}
          {topPricing.length === 0 && <tr><td colSpan="5" className="empty-cell">No pricing recommendations available.</td></tr>}
        </DataTable>
      </ModuleCard>

      <div className="ai-layout">
        <ModuleCard eyebrow="Smart Purchase Planner" title="Recommended Purchases" subtitle="FROST recommends quantities only; purchase bills still need owner approval.">
          <DataTable headers={["Fruit", "Qty", "Supplier", "Cost", "Action"]}>
            {topPurchases.slice(0, 8).map((item) => (
              <tr key={item.product_id}>
                <td className="primary-cell">{item.product_name}<small className="cell-note">{item.reason}</small></td>
                <td>{item.recommended_quantity}</td>
                <td>{item.suggested_supplier}</td>
                <td>{currency.format(item.expected_cost)}<small className="cell-note">{item.expected_stock_days || "n/a"} stock days</small></td>
                <td><button className="table-action" onClick={() => propose("review purchase suggestion", { product_id: item.product_id })}>Review</button></td>
              </tr>
            ))}
            {topPurchases.length === 0 && <tr><td colSpan="5" className="empty-cell">No purchase suggestions available.</td></tr>}
          </DataTable>
        </ModuleCard>

        <ModuleCard eyebrow="Waste Prevention" title="Lot Risk Monitor" subtitle="Discounts and display actions are recommendations only.">
          <DataTable headers={["Lot", "Risk", "Priority", "Action"]}>
            {topWaste.slice(0, 8).map((item) => (
              <tr key={item.lot_id}>
                <td className="primary-cell">{item.product_name}<small className="cell-note">{item.batch_no} - {item.remaining_qty} left</small></td>
                <td>{item.color_status}<small className="cell-note">Freshness {item.freshness_score}/100 - waste {Math.round(Number(item.waste_probability || 0) * 100)}%</small></td>
                <td>{item.selling_priority}</td>
                <td><button className="table-action" onClick={() => propose(item.discount_recommendation, { lot_id: item.lot_id, product_id: item.product_id })}>Review</button></td>
              </tr>
            ))}
            {topWaste.length === 0 && <tr><td colSpan="4" className="empty-cell">No lot risk rows available.</td></tr>}
          </DataTable>
        </ModuleCard>
      </div>

      <div className="ai-layout">
        <ModuleCard eyebrow="Customer Intelligence" title="Customer Opportunities" subtitle="FROST suggests follow-ups; no messages are sent automatically.">
          <DataTable headers={["Customer", "Segment", "Value", "Action"]}>
            {topCustomers.slice(0, 8).map((item) => (
              <tr key={item.customer_id}>
                <td className="primary-cell">{item.customer_name}<small className="cell-note">{item.favourite_fruits}</small></td>
                <td>{item.segment}<small className="cell-note">{item.recommendation}</small></td>
                <td>{currency.format(item.lifetime_value)}<small className="cell-note">Avg {currency.format(item.average_basket_value)}</small></td>
                <td><button className="table-action" onClick={() => propose(item.recommendation, { customer_id: item.customer_id })}>Review</button></td>
              </tr>
            ))}
            {topCustomers.length === 0 && <tr><td colSpan="4" className="empty-cell">No customer intelligence available.</td></tr>}
          </DataTable>
        </ModuleCard>

        <ModuleCard eyebrow="Supplier Intelligence" title="Supplier Scorecards" subtitle="Supplier scores use available purchase and profit data.">
          <DataTable headers={["Supplier", "Score", "Profit", "Action"]}>
            {topSuppliers.slice(0, 8).map((item) => (
              <tr key={`${item.supplier_id || item.supplier_name}`}>
                <td className="primary-cell">{item.supplier_name}<small className="cell-note">{item.reliability} reliability</small></td>
                <td>{item.supplier_score}/100</td>
                <td>{currency.format(item.profit_contribution)}</td>
                <td><button className="table-action" onClick={() => propose(item.recommendation, { supplier_id: item.supplier_id, supplier_name: item.supplier_name })}>{item.recommendation}</button></td>
              </tr>
            ))}
            {topSuppliers.length === 0 && <tr><td colSpan="4" className="empty-cell">No supplier intelligence available.</td></tr>}
          </DataTable>
        </ModuleCard>
      </div>

      <div className="ai-layout">
        <ModuleCard eyebrow="Cash Flow Predictor" title="Working Capital Windows" subtitle="Prediction ranges are deterministic and conservative.">
          <DataTable headers={["Period", "Incoming", "Outgoing", "Working Capital"]}>
            {cashflow.map((item) => (
              <tr key={item.period}>
                <td>{item.period}</td>
                <td>{currency.format(item.incoming_cash)}</td>
                <td>{currency.format(item.outgoing_cash)}</td>
                <td>{currency.format(item.working_capital)}<small className="cell-note">{item.future_shortage ? "Shortage risk" : "Manageable"}</small></td>
              </tr>
            ))}
            {cashflow.length === 0 && <tr><td colSpan="4" className="empty-cell">No cashflow prediction available.</td></tr>}
          </DataTable>
        </ModuleCard>

        <ModuleCard eyebrow="Demand Forecast" title="Shortage and Slow-Moving Signals" subtitle="Uses recent sales trends; festival calendar can be added later.">
          <DataTable headers={["Fruit", "7-Day Sales", "Purchase Need", "Signal"]}>
            {demand.slice(0, 8).map((item) => (
              <tr key={item.product_id}>
                <td className="primary-cell">{item.product_name}<small className="cell-note">{Math.round(Number(item.confidence || 0) * 100)}% confidence</small></td>
                <td>{item.expected_sales_7_days}</td>
                <td>{item.expected_purchase}</td>
                <td>{item.stock_shortage_warning ? "Shortage warning" : item.slow_moving ? "Slow moving" : "Normal"}</td>
              </tr>
            ))}
            {demand.length === 0 && <tr><td colSpan="4" className="empty-cell">No demand forecast available.</td></tr>}
          </DataTable>
        </ModuleCard>
      </div>
    </div>
  );
}

function FrostProfitAdvisorPanel({ recommendations = [], onProposeAction }) {
  return (
    <ModuleCard eyebrow="Profit Advisor" title="Grounded Margin Recommendations" subtitle="Recommendations are proposals only and require owner approval before any business action.">
      <DataTable headers={["Product", "Margin", "Recent", "Recommendation", "Action"]}>
        {recommendations.map((item) => (
          <tr key={item.product_id}>
            <td className="primary-cell">{item.product_name}<small className="cell-note">Cost {currency.format(item.current_purchase_cost)} - Rate {currency.format(item.current_selling_rate)}</small></td>
            <td>{item.estimated_gross_margin === null ? "No cost data" : `${item.estimated_gross_margin}%`}<small className="cell-note">Waste adjusted {item.waste_adjusted_margin === null ? "n/a" : `${item.waste_adjusted_margin}%`}</small></td>
            <td>{item.recent_sales_quantity} sold<small className="cell-note">{item.recent_waste} waste</small></td>
            <td>{item.proposed_action}<small className="cell-note">{item.expected_impact_range}</small></td>
            <td><button className="table-action" onClick={() => onProposeAction?.(item.proposed_action, { product_id: item.product_id, source: "profit_advisor" })}>Propose</button></td>
          </tr>
        ))}
        {recommendations.length === 0 && <tr><td colSpan="5" className="empty-cell">No profit recommendations available yet.</td></tr>}
      </DataTable>
    </ModuleCard>
  );
}

function FrostMemoryPanel({ canManage, memories = [], onMemoryAction, onProposeMemory }) {
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const filtered = memories.filter((memory) => {
    const text = `${memory.title || ""} ${memory.content || ""} ${memory.memory_type || ""} ${memory.entity_type || ""}`.toLowerCase();
    return text.includes(search.toLowerCase());
  });
  const submit = async () => {
    if (!draft.trim()) return;
    await onProposeMemory?.(draft.trim());
    setDraft("");
  };
  return (
    <ModuleCard eyebrow="Business Memory" title="Owner-Approved FROST Memory" subtitle="FROST proposes memories, but owner approval controls what becomes active. Secrets are rejected.">
      <div className="frost-memory-tools">
        <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Example: Remember Raj Traders is a VIP customer." />
        <button className="primary-button" disabled={!canManage || !draft.trim()} onClick={submit}><Icon name="message" /> Propose Memory</button>
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search memories" />
      </div>
      <DataTable headers={["Status", "Memory", "Source", "Actions"]}>
        {filtered.map((memory) => (
          <tr key={memory.id}>
            <td><span className={aiSeverityClass(memory.approval_status === "APPROVED" && memory.is_active ? "INFO" : "ATTENTION")}>{memory.approval_status}</span></td>
            <td className="primary-cell">{memory.title}<small className="cell-note">{memory.content}</small><small className="cell-note">{memory.memory_type} - confidence {Math.round(Number(memory.confidence || 0) * 100)}%</small></td>
            <td>{memory.source_type || "manual"}<small className="cell-note">Created {formatDisplayDate(memory.created_at)} - Last used {memory.last_used_at ? formatDisplayDate(memory.last_used_at) : "not used"}</small></td>
            <td>
              <div className="button-row table-actions-row">
                <button className="table-action" disabled={!canManage || memory.approval_status === "APPROVED"} onClick={() => onMemoryAction?.(memory.id, "APPROVE")}>Approve</button>
                <button className="table-action" disabled={!canManage} onClick={() => onMemoryAction?.(memory.id, "PATCH", { is_active: !memory.is_active })}>{memory.is_active ? "Disable" : "Enable"}</button>
                <button className="remove-button" disabled={!canManage} onClick={() => onMemoryAction?.(memory.id, "DELETE")}>Delete</button>
              </div>
            </td>
          </tr>
        ))}
        {filtered.length === 0 && <tr><td colSpan="4" className="empty-cell">No matching FROST memories.</td></tr>}
      </DataTable>
    </ModuleCard>
  );
}

function FrostVoicePanel({ onStart, onStop, voice }) {
  const active = ["connecting", "listening", "speaking"].includes(voice.status);
  return (
    <section className={`frost-voice-panel frost-voice-${voice.status || "idle"}`}>
      <div>
        <span className="eyebrow">Voice Copilot</span>
        <h3>Push-to-talk with FROST</h3>
        <p>Hindi, English and Hinglish ready. Wake word architecture is prepared and disabled.</p>
      </div>
      <div className="frost-voice-controls">
        <button className={active ? "remove-button frost-mic-button" : "primary-button frost-mic-button"} onClick={active ? onStop : onStart}>
          <Icon name={active ? "close" : "message"} /> {active ? "Interrupt / Stop" : "Hold to Talk"}
        </button>
        <span className="frost-voice-state">{voice.status || "idle"}</span>
      </div>
      {(voice.transcript || voice.error) && (
        <div className="frost-transcript">
          {voice.error ? <p>{voice.error}</p> : <p>{voice.transcript}</p>}
        </div>
      )}
    </section>
  );
}

function FrostConfigurationPanel({ canManage, data, onSave }) {
  const frost = data.frost?.frost || {};
  const [draft, setDraft] = useState({
    assistantName: "FROST",
    providerKey: frost.providerKey || "deterministic",
    model: frost.model || "",
    realtimeModel: frost.realtimeModel || "gpt-realtime",
    voice: frost.voice || "alloy",
    languageMode: frost.languageMode || "hindi_english_hinglish",
    enabled: frost.enabled === true,
    streamingEnabled: frost.streamingEnabled !== false,
    cacheEnabled: frost.cacheEnabled !== false,
    voicePrepared: frost.voicePrepared !== false,
    wakeWordEnabled: false,
    voiceActivityDetection: frost.voiceActivityDetection !== false,
    noiseSuppression: frost.noiseSuppression !== false,
    fullDuplexEnabled: frost.fullDuplexEnabled !== false,
    maxInputTokens: frost.maxInputTokens || 6000,
    maxOutputTokens: frost.maxOutputTokens || 1200,
    costAlertAmount: frost.costAlertAmount || 500,
  });

  useEffect(() => {
    setDraft({
      assistantName: "FROST",
      providerKey: frost.providerKey || "deterministic",
      model: frost.model || "",
      realtimeModel: frost.realtimeModel || "gpt-realtime",
      voice: frost.voice || "alloy",
      languageMode: frost.languageMode || "hindi_english_hinglish",
      enabled: frost.enabled === true,
      streamingEnabled: frost.streamingEnabled !== false,
      cacheEnabled: frost.cacheEnabled !== false,
      voicePrepared: frost.voicePrepared !== false,
      wakeWordEnabled: false,
      voiceActivityDetection: frost.voiceActivityDetection !== false,
      noiseSuppression: frost.noiseSuppression !== false,
      fullDuplexEnabled: frost.fullDuplexEnabled !== false,
      maxInputTokens: frost.maxInputTokens || 6000,
      maxOutputTokens: frost.maxOutputTokens || 1200,
      costAlertAmount: frost.costAlertAmount || 500,
    });
  }, [frost.providerKey, frost.model, frost.realtimeModel, frost.voice, frost.languageMode, frost.enabled, frost.streamingEnabled, frost.cacheEnabled, frost.voicePrepared, frost.voiceActivityDetection, frost.noiseSuppression, frost.fullDuplexEnabled, frost.maxInputTokens, frost.maxOutputTokens, frost.costAlertAmount]);

  const update = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const save = async () => {
    try {
      await onSave(draft);
      alert("FROST settings updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update FROST settings"));
    }
  };

  return (
    <ModuleCard eyebrow="FROST Configuration" title="AI Operating System" subtitle="Provider, engine and usage controls shared by every future AI module.">
      <div className="ai-config-grid">
        <Field label="Assistant"><input readOnly value="FROST" /></Field>
        <Field label="Provider">
          <select disabled={!canManage} value={draft.providerKey} onChange={(event) => update("providerKey", event.target.value)}>
            <option value="deterministic">Deterministic only</option>
            {(data.providers || []).map((provider) => <option key={provider.key} value={provider.key}>{provider.label}</option>)}
          </select>
        </Field>
        <Field label="Model / Deployment"><input disabled={!canManage} value={draft.model} onChange={(event) => update("model", event.target.value)} placeholder="Configured outside secrets" /></Field>
        <Field label="Realtime Model"><input disabled={!canManage} value={draft.realtimeModel} onChange={(event) => update("realtimeModel", event.target.value)} /></Field>
        <Field label="Voice">
          <select disabled={!canManage} value={draft.voice} onChange={(event) => update("voice", event.target.value)}>
            <option value="alloy">Alloy</option>
            <option value="verse">Verse</option>
            <option value="marin">Marin</option>
            <option value="cedar">Cedar</option>
          </select>
        </Field>
        <Field label="Language Mode">
          <select disabled={!canManage} value={draft.languageMode} onChange={(event) => update("languageMode", event.target.value)}>
            <option value="hindi_english_hinglish">Hindi + English + Hinglish</option>
            <option value="english">English</option>
            <option value="hindi">Hindi</option>
          </select>
        </Field>
        <Field label="Cost Alert"><input disabled={!canManage} min="0" type="number" value={draft.costAlertAmount} onChange={(event) => update("costAlertAmount", Number(event.target.value || 0))} /></Field>
        <label className="check-field"><input checked={draft.enabled} disabled={!canManage} type="checkbox" onChange={(event) => update("enabled", event.target.checked)} /><span>External provider enabled</span></label>
        <label className="check-field"><input checked={draft.streamingEnabled} disabled={!canManage} type="checkbox" onChange={(event) => update("streamingEnabled", event.target.checked)} /><span>Streaming responses</span></label>
        <label className="check-field"><input checked={draft.cacheEnabled} disabled={!canManage} type="checkbox" onChange={(event) => update("cacheEnabled", event.target.checked)} /><span>Response caching</span></label>
        <label className="check-field"><input checked={draft.voicePrepared} disabled={!canManage} type="checkbox" onChange={(event) => update("voicePrepared", event.target.checked)} /><span>Voice engine prepared</span></label>
        <label className="check-field"><input checked={draft.voiceActivityDetection} disabled={!canManage} type="checkbox" onChange={(event) => update("voiceActivityDetection", event.target.checked)} /><span>Voice activity detection</span></label>
        <label className="check-field"><input checked={draft.noiseSuppression} disabled={!canManage} type="checkbox" onChange={(event) => update("noiseSuppression", event.target.checked)} /><span>Noise suppression</span></label>
        <label className="check-field"><input checked={draft.fullDuplexEnabled} disabled={!canManage} type="checkbox" onChange={(event) => update("fullDuplexEnabled", event.target.checked)} /><span>Full duplex conversation</span></label>
        <label className="check-field"><input checked={false} disabled type="checkbox" /><span>Wake word disabled</span></label>
      </div>
      <div className="ai-engine-grid">
        {(data.engines || []).map((engine) => (
          <span key={engine.key} className="ai-engine-chip">{engine.key.replaceAll("_", " ")}<strong>{engine.status}</strong></span>
        ))}
      </div>
      <div className="ai-collection-strip">
        <span>Provider {data.provider?.name || "Deterministic FROST"}</span>
        <span>Requests today {data.usage?.request_count || 0}</span>
        <span>Input tokens {data.usage?.input_tokens || 0}</span>
        <span>Output tokens {data.usage?.output_tokens || 0}</span>
        <span>Estimated cost {currency.format(Number(data.usage?.estimated_cost || 0))}</span>
      </div>
      <div className="button-row">
        <button className="primary-button" disabled={!canManage} onClick={save}><Icon name="settings" /> Save FROST Settings</button>
      </div>
    </ModuleCard>
  );
}

function AccountRecoveryModal({ apiUrl, backendHealth, deviceInfo, onCheckOnline, onClose, onRetryOnline }) {
  const [mode, setMode] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [methods, setMethods] = useState([]);
  const [method, setMethod] = useState("");
  const [requestId, setRequestId] = useState("");
  const [otp, setOtp] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [recoveredUsername, setRecoveredUsername] = useState("");
  const [passwordDraft, setPasswordDraft] = useState({ new_password: "", confirm_password: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [step, setStep] = useState("choose");
  const [providerStatus, setProviderStatus] = useState(null);
  const [supportContacts, setSupportContacts] = useState([]);
  const [developmentOtp, setDevelopmentOtp] = useState("");

  const onlineRequired = backendHealth?.online === false;
  useEffect(() => {
    let cancelled = false;
    setStatus("Checking FroozERP service...");
    onCheckOnline?.("recovery-open", { force: true, timeoutMs: 3500 }).then((health) => {
      if (cancelled) return;
      if (health?.online) {
        setStatus("FroozERP service is online. Choose a recovery option.");
        if (step === "offline") setStep(mode ? "identify" : "choose");
      } else {
        setError(`Account recovery requires internet access. ${health?.message || "Backend is unavailable."}`);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (backendHealth?.checking) {
      setStatus("Checking FroozERP service...");
      return;
    }
    if (backendHealth?.online) {
      setError("");
      setStatus("FroozERP service is online. Continue account recovery.");
      if (step === "offline") setStep(mode ? "identify" : "choose");
    }
  }, [backendHealth?.checking, backendHealth?.online, mode, step]);
  const resetMessages = () => {
    setStatus("");
    setError("");
    setDevelopmentOtp("");
  };
  const recoveryPayload = () => ({
    identifier,
    purpose: mode,
    method,
    device_id: deviceInfo?.device_id,
  });
  const chooseMode = (nextMode) => {
    resetMessages();
    setMode(nextMode);
    setStep(onlineRequired ? "offline" : "identify");
  };
  const loadOptions = async () => {
    resetMessages();
    if (!identifier.trim()) {
      setError("Enter your registered username, email or mobile number.");
      return;
    }
    setBusy(true);
    try {
      const health = await (onCheckOnline?.("recovery-options", { force: true, timeoutMs: 4000 }) || checkBackendHealth(apiUrl, { details: true, timeoutMs: 4000 }));
      if (!health.online) {
        setStep("offline");
        setError(`Account recovery requires internet access. ${health.message}`);
        return;
      }
      writeDiagnosticLog("INFO", "recovery-options-request", { apiUrl, endpoint: `${apiUrl}/auth/recovery/options` });
      const response = await axios.post(`${apiUrl}/auth/recovery/options`, recoveryPayload(), { timeout: 8000 });
      setProviderStatus(response.data.provider_status || null);
      setSupportContacts(response.data.support_contacts || []);
      if (response.data.code === "STAFF_OWNER_ASSISTANCE_REQUIRED") {
        setStep("staff");
        setStatus(response.data.message);
        return;
      }
      if (!response.data.methods?.length) {
        setError(response.data.message || "No verified recovery method is available for this account.");
        return;
      }
      setMethods(response.data.methods);
      setMethod(response.data.methods[0]?.method || "");
      setStep("method");
      setStatus("Select where FroozERP should send the verification code.");
    } catch (requestError) {
      writeDiagnosticLog("ERROR", "recovery-options-failed", {
        apiUrl,
        endpoint: `${apiUrl}/auth/recovery/options`,
        status: requestError.response?.status || null,
        message: requestError.response?.data?.message || requestError.message || "Recovery options failed",
      });
      setError(getAuthErrorMessage(requestError, "Unable to load recovery options."));
    } finally {
      setBusy(false);
    }
  };
  const sendOtp = async () => {
    resetMessages();
    if (!method) {
      setError("Select a recovery method.");
      return;
    }
    setBusy(true);
    try {
      writeDiagnosticLog("INFO", "recovery-send-otp-request", { apiUrl, endpoint: `${apiUrl}/auth/recovery/send-otp` });
      const response = await axios.post(`${apiUrl}/auth/recovery/send-otp`, recoveryPayload(), { timeout: 8000 });
      setProviderStatus(response.data.provider_status || null);
      if (response.data.code === "PROVIDER_NOT_CONFIGURED" && !response.data.development_otp) {
        setError(response.data.message || "Recovery delivery provider is not configured.");
        return;
      }
      setRequestId(response.data.request_id || "");
      setDevelopmentOtp(response.data.development_otp || "");
      setStep("otp");
      setStatus(response.data.development_otp ? "Development recovery code generated for internal testing." : "Verification code sent.");
    } catch (requestError) {
      writeDiagnosticLog("ERROR", "recovery-send-otp-failed", {
        apiUrl,
        endpoint: `${apiUrl}/auth/recovery/send-otp`,
        status: requestError.response?.status || null,
        message: requestError.response?.data?.message || requestError.message || "Recovery OTP failed",
      });
      setError(getAuthErrorMessage(requestError, "Unable to send recovery code."));
    } finally {
      setBusy(false);
    }
  };
  const verifyOtp = async () => {
    resetMessages();
    setBusy(true);
    try {
      writeDiagnosticLog("INFO", "recovery-verify-otp-request", { apiUrl, endpoint: `${apiUrl}/auth/recovery/verify-otp` });
      const response = await axios.post(`${apiUrl}/auth/recovery/verify-otp`, {
        request_id: requestId,
        otp,
        device_id: deviceInfo?.device_id,
      }, { timeout: 8000 });
      setVerificationToken(response.data.verification_token || "");
      if (mode === "username") {
        setRecoveredUsername(response.data.username || "");
        setStep("username-result");
        setStatus("Username recovered successfully.");
      } else {
        setStep("reset");
        setStatus("Verification complete. Set a new password.");
      }
    } catch (requestError) {
      writeDiagnosticLog("ERROR", "recovery-verify-otp-failed", {
        apiUrl,
        endpoint: `${apiUrl}/auth/recovery/verify-otp`,
        status: requestError.response?.status || null,
        message: requestError.response?.data?.message || requestError.message || "Recovery verify failed",
      });
      setError(getAuthErrorMessage(requestError, "Unable to verify recovery code."));
    } finally {
      setBusy(false);
    }
  };
  const resetPassword = async () => {
    resetMessages();
    setBusy(true);
    try {
      const response = await axios.post(`${apiUrl}/auth/recovery/reset-password`, {
        request_id: requestId,
        verification_token: verificationToken,
        ...passwordDraft,
        device_id: deviceInfo?.device_id,
      }, { timeout: 8000 });
      setStep("done");
      setStatus(response.data.message || "Password changed. Sign in again with the new password.");
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, "Unable to reset password."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section className="invoice-modal recovery-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">FroozERP Account Recovery</span>
            <strong>Forgot Username or Password?</strong>
          </div>
          <button aria-label="Close recovery" className="remove-button" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="sale-edit-body recovery-body">
          <BrandLogo compact />
          {step === "choose" && (
            <div className="recovery-option-grid">
              <button className="secondary-button" onClick={() => chooseMode("username")}>Forgot Username</button>
              <button className="secondary-button" onClick={() => chooseMode("password")}>Forgot Password</button>
              <button className="secondary-button" onClick={() => setStep("staff")}>Contact Owner / Administrator</button>
            </div>
          )}
          {step === "offline" && (
            <div className="startup-status-panel startup-status-error">
              <p><strong>Internet connection required</strong></p>
              <p>Account recovery securely verifies your registered email or mobile number and therefore requires an online connection.</p>
              <div className="button-row">
                <button className="secondary-button" disabled={busy} onClick={onRetryOnline}>Retry Online</button>
                <button className="secondary-button" onClick={() => setStep("staff")}>Contact Owner / Administrator</button>
                <button className="secondary-button" onClick={onClose}>Back to Sign In</button>
              </div>
            </div>
          )}
          {step === "identify" && (
            <>
              <Field label="Registered username, email or mobile"><input value={identifier} onChange={(event) => setIdentifier(event.target.value)} /></Field>
              <button className="primary-button" disabled={busy} onClick={loadOptions}>{busy ? "Checking..." : "Continue"}</button>
            </>
          )}
          {step === "method" && (
            <>
              <Field label="Recovery Method">
                <select value={method} onChange={(event) => setMethod(event.target.value)}>
                  {methods.map((entry) => <option key={entry.method} value={entry.method}>{entry.label}</option>)}
                </select>
              </Field>
              <button className="primary-button" disabled={busy} onClick={sendOtp}>{busy ? "Sending..." : "Send Verification Code"}</button>
            </>
          )}
          {step === "otp" && (
            <>
              {developmentOtp && <div className="startup-status-panel"><p>Development test OTP: <strong>{developmentOtp}</strong></p></div>}
              <Field label="Verification Code"><input inputMode="numeric" value={otp} onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 8))} /></Field>
              <button className="primary-button" disabled={busy} onClick={verifyOtp}>{busy ? "Verifying..." : "Verify Code"}</button>
            </>
          )}
          {step === "username-result" && (
            <div className="startup-status-panel">
              <p>Recovered username</p>
              <strong>{recoveredUsername}</strong>
              <button className="primary-button" onClick={onClose}>Back to Sign In</button>
            </div>
          )}
          {step === "reset" && (
            <>
              <Field label="New Password">
                <input type={showPassword ? "text" : "password"} value={passwordDraft.new_password} onChange={(event) => setPasswordDraft({ ...passwordDraft, new_password: event.target.value })} />
              </Field>
              <Field label="Confirm New Password">
                <input type={showPassword ? "text" : "password"} value={passwordDraft.confirm_password} onChange={(event) => setPasswordDraft({ ...passwordDraft, confirm_password: event.target.value })} />
              </Field>
              <label className="check-field"><input checked={showPassword} type="checkbox" onChange={(event) => setShowPassword(event.target.checked)} /><span>Show password</span></label>
              <p className="form-note">Use a password the staff member cannot guess. FroozERP stores only a secure password hash.</p>
              <button className="primary-button" disabled={busy} onClick={resetPassword}>{busy ? "Saving..." : "Reset Password"}</button>
            </>
          )}
          {step === "staff" && (
            <div className="startup-status-panel">
              <p><strong>Account assistance required</strong></p>
              <p>For the security of your business, staff login recovery is managed by your authorised Owner or Administrator.</p>
              {supportContacts.length > 0 && supportContacts.map((contact) => (
                <small key={`${contact.contact_type}-${contact.contact_value}`}>{contact.label}: {contact.contact_value}</small>
              ))}
              <div className="button-row">
                <button className="secondary-button" onClick={() => setStep("choose")}>Back</button>
                <button className="primary-button" onClick={onClose}>Back to Sign In</button>
              </div>
            </div>
          )}
          {step === "done" && (
            <div className="startup-status-panel">
              <p>{status}</p>
              <button className="primary-button" onClick={onClose}>Back to Sign In</button>
            </div>
          )}
          {(status || error || providerStatus) && step !== "done" && (
            <div className={`startup-status-panel ${error ? "startup-status-error" : ""}`}>
              {status && <p>{status}</p>}
              {error && <p>{error}</p>}
              {providerStatus && (
                <small>Email: {providerStatus.email}; SMS: {providerStatus.sms}; Development: {providerStatus.development}</small>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function WhatsAppSendModal({
  caption,
  documentName,
  generatePdf,
  onClose,
  recipients = [],
  sourceId = "",
  sourceType = "report",
  title = "Send via WhatsApp",
  user,
}) {
  const [search, setSearch] = useState("");
  const [manualNumber, setManualNumber] = useState("");
  const [manualRecipients, setManualRecipients] = useState([]);
  const [selectedKeys, setSelectedKeys] = useState(() => new Set());
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState("");
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const allRecipients = useMemo(() => [...recipients, ...manualRecipients], [manualRecipients, recipients]);
  const filteredRecipients = useMemo(() => {
    const text = search.trim().toLowerCase();
    if (!text) return allRecipients;
    return allRecipients.filter((recipient) =>
      [recipient.name, recipient.phoneNumber, recipient.mobileNumber, recipient.whatsappNumber, recipient.accountType]
        .some((value) => String(value || "").toLowerCase().includes(text))
    );
  }, [allRecipients, search]);
  const selectedRecipients = allRecipients.filter((recipient) => selectedKeys.has(recipient.key));
  const toggleRecipient = (key) => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const selectAllVisible = () => {
    setSelectedKeys((current) => {
      const next = new Set(current);
      filteredRecipients.forEach((recipient) => {
        if (recipient.phoneNumber && recipient.optIn !== false) next.add(recipient.key);
      });
      return next;
    });
  };
  const clearSelected = () => setSelectedKeys(new Set());
  const addManualRecipient = () => {
    const normalized = normalizeWhatsappNumber(manualNumber);
    if (!normalized) {
      setError("Enter a valid WhatsApp number. Use 10 digit Indian mobile or international number with country code.");
      return;
    }
    const recipient = {
      key: `manual-${normalized}-${Date.now()}`,
      accountId: null,
      accountType: "manual",
      name: `Manual ${normalized}`,
      phoneNumber: normalized,
      mobileNumber: normalized,
      whatsappNumber: normalized,
      optIn: true,
    };
    setManualRecipients((rows) => [...rows, recipient]);
    setSelectedKeys((current) => new Set([...current, recipient.key]));
    setManualNumber("");
    setError("");
  };
  const send = async () => {
    setError("");
    setResults([]);
    if (selectedRecipients.length === 0) {
      setError("Select at least one WhatsApp number or add a manual number.");
      return;
    }
    const normalizedNumbers = selectedRecipients.map((recipient) => ({
      phoneNumber: normalizeWhatsappNumber(recipient.phoneNumber || recipient.whatsappNumber || recipient.mobileNumber),
      accountId: recipient.accountId,
      accountType: recipient.accountType,
      label: recipient.name,
    }));
    const invalid = normalizedNumbers.filter((entry) => !entry.phoneNumber);
    if (invalid.length) {
      setError(`${invalid.length} selected recipient has no valid WhatsApp number.`);
      return;
    }
    setSending(true);
    setStatus("Generating PDF...");
    let pdfResult = null;
    try {
      pdfResult = await generatePdf();
      const fileName = pdfResult.fileName || documentName;
      setStatus("Sending PDF on WhatsApp...");
      const pdfBase64 = await blobToBase64(pdfResult.blob);
      const response = await axios.post(`${API_URL}/api/whatsapp/send-document`, {
        phoneNumbers: normalizedNumbers,
        pdfBase64,
        caption,
        documentName: fileName,
        sourceType,
        sourceId,
        sentByUserId: user?.id,
      });
      const responseResults = response.data?.results || [];
      setResults(responseResults);
      if (response.data?.configured === false) {
        pdfResult.pdf?.save(fileName);
        await openWhatsappWebFallback({
          caption: `${caption}\n\nPDF exported as ${fileName}. Please attach the PDF manually in WhatsApp.`,
          fileName,
          numbers: normalizedNumbers.map((entry) => entry.phoneNumber),
        });
        setStatus("WhatsApp API not configured. PDF exported for manual sharing.");
      } else if (responseResults.some((item) => item.status !== "sent")) {
        setStatus("Some numbers failed. Check WhatsApp log.");
      } else {
        setStatus("PDF sent successfully.");
      }
    } catch (sendError) {
      const message = getErrorMessage(sendError, "Unable to send WhatsApp document");
      if (pdfResult?.pdf) {
        pdfResult.pdf.save(pdfResult.fileName || documentName);
        await openWhatsappWebFallback({
          caption: `${caption}\n\nPDF exported as ${pdfResult.fileName || documentName}. Please attach the PDF manually in WhatsApp.`,
          fileName: pdfResult.fileName || documentName,
          numbers: normalizedNumbers.map((entry) => entry.phoneNumber),
        });
        setStatus("PDF exported for manual sharing.");
      }
      setError(message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section className="invoice-modal whatsapp-send-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">WhatsApp Export</span>
            <strong>{title}</strong>
          </div>
          <button aria-label="Close WhatsApp send" className="remove-button" disabled={sending} onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="sale-edit-body">
          <div className="form-grid supplier-form-grid">
            <Field label="Search Customer / Supplier">
              <input placeholder="Search by customer, supplier or number..." value={search} onChange={(event) => setSearch(event.target.value)} />
            </Field>
            <Field label="Manual WhatsApp Number">
              <div className="inline-input-action">
                <input placeholder="10 digit or +country number" value={manualNumber} onChange={(event) => setManualNumber(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addManualRecipient(); }} />
                <button className="secondary-button" type="button" onClick={addManualRecipient}>Add</button>
              </div>
            </Field>
          </div>
          <div className="button-row">
            <button className="secondary-button" disabled={sending} onClick={selectAllVisible}>Select All Visible</button>
            <button className="secondary-button" disabled={sending} onClick={clearSelected}>Clear Selection</button>
            <span className="tag">{selectedRecipients.length} selected</span>
          </div>
          <div className="whatsapp-recipient-list">
            {filteredRecipients.map((recipient) => {
              const number = recipient.whatsappNumber || recipient.phoneNumber || recipient.mobileNumber;
              const unavailable = !number || recipient.optIn === false;
              return (
                <label className={`whatsapp-recipient-row ${unavailable ? "recipient-unavailable" : ""}`} key={recipient.key}>
                  <input checked={selectedKeys.has(recipient.key)} disabled={sending || unavailable} type="checkbox" onChange={() => toggleRecipient(recipient.key)} />
                  <span>
                    <strong>{recipient.name}</strong>
                    <small>{recipient.accountType || "account"} {recipient.optIn === false ? "- opt-out" : ""}</small>
                  </span>
                  <em>{unavailable ? "WhatsApp number not available" : number}</em>
                </label>
              );
            })}
            {filteredRecipients.length === 0 && <div className="cart-empty">No matching WhatsApp contacts found.</div>}
          </div>
          {(status || error) && (
            <div className={`startup-status-panel ${error ? "startup-status-error" : ""}`}>
              {status && <p>{status}</p>}
              {error && <p>{error}</p>}
            </div>
          )}
          {results.length > 0 && (
            <DataTable headers={["Number", "Status", "Message"]}>
              {results.map((row, index) => (
                <tr key={`${row.phoneNumber}-${index}`}>
                  <td>{row.phoneNumber}</td>
                  <td><span className={row.status === "sent" ? "stock-ok" : "stock-low"}>{row.status}</span></td>
                  <td>{row.errorMessage || "Done"}</td>
                </tr>
              ))}
            </DataTable>
          )}
          <div className="button-row">
            <button className="primary-button" disabled={sending || selectedRecipients.length === 0} onClick={send}>{sending ? "Sending..." : "Send PDF"}</button>
            <button className="secondary-button" disabled={sending} onClick={onClose}>Close</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function PdfPageCanvas({ page, zoom }) {
  const canvasRef = useRef(null);
  const [renderError, setRenderError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let renderTask = null;
    const render = async () => {
      try {
        setRenderError("");
        const viewport = page.getViewport({ scale: zoom });
        const canvas = canvasRef.current;
        if (!canvas) return;
        const context = canvas.getContext("2d", { alpha: false });
        const outputScale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
        canvas.width = Math.floor(viewport.width * outputScale);
        canvas.height = Math.floor(viewport.height * outputScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
      } catch (error) {
        if (!cancelled && error?.name !== "RenderingCancelledException") {
          setRenderError(error?.message || "Unable to render this PDF page.");
        }
      }
    };
    render();
    return () => {
      cancelled = true;
      renderTask?.cancel?.();
    };
  }, [page, zoom]);
  return (
    <div className="pdf-page-shell">
      <canvas ref={canvasRef} />
      {renderError && <div className="pdf-preview-error">{renderError}</div>}
    </div>
  );
}

function PdfPreviewModal({ blob, fileName, onClose, onSave }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pages, setPages] = useState([]);
  const [zoom, setZoom] = useState(1);
  const [opening, setOpening] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let loadingTask = null;
    const load = async () => {
      try {
        setLoading(true);
        setError("");
        const pdfBlob = ensurePdfBlob(blob);
        const header = new Uint8Array(await pdfBlob.slice(0, 5).arrayBuffer());
        const signature = String.fromCharCode(...header);
        if (signature !== "%PDF-") {
          throw new Error("The generated file is not a valid PDF document.");
        }
        const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
        loadingTask = pdfjsLib.getDocument({ data: bytes });
        const document = await loadingTask.promise;
        const loadedPages = [];
        for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
          loadedPages.push(await document.getPage(pageNumber));
        }
        if (!cancelled) setPages(loadedPages);
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError?.message || "Unable to preview this PDF inside FroozERP.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
      loadingTask?.destroy?.();
    };
  }, [blob]);
  const openFallback = async () => {
    setOpening(true);
    try {
      await openPdfInSystemViewer({ blob, fileName });
    } catch (openError) {
      console.error("FroozERP PDF system viewer failed", openError);
      alert("Unable to open PDF in system viewer. Please save the PDF and open it manually.");
    } finally {
      setOpening(false);
    }
  };
  const handleSave = async () => {
    setSaving(true);
    try {
      const result = await onSave?.();
      if (result?.canceled) return;
      if (result?.path) alert(`PDF saved successfully:\n${result.path}`);
    } catch (saveError) {
      alert(`Unable to save PDF: ${saveError.message || saveError}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section className="invoice-modal pdf-preview-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">PDF Preview</span>
            <strong>{fileName}</strong>
            <small>{loading ? "Loading PDF pages..." : error ? "Preview fallback available" : `${pages.length} page${pages.length === 1 ? "" : "s"} rendered inside FroozERP`}</small>
          </div>
          <div className="invoice-actions">
            <button className="secondary-button" disabled={loading || Boolean(error)} onClick={() => setZoom((value) => Math.max(0.65, Number((value - 0.1).toFixed(2))))}>Zoom -</button>
            <span className="tag">{Math.round(zoom * 100)}%</span>
            <button className="secondary-button" disabled={loading || Boolean(error)} onClick={() => setZoom((value) => Math.min(1.8, Number((value + 0.1).toFixed(2))))}>Zoom +</button>
            <button className="secondary-button" disabled={loading || Boolean(error)} onClick={() => window.print()}><Icon name="print" /> Print</button>
            <button className="primary-button" disabled={saving} onClick={handleSave}>{saving ? "Saving..." : "Save PDF"}</button>
            <button className="secondary-button" disabled={opening} onClick={openFallback}>{opening ? "Opening..." : "Open in System Viewer"}</button>
            <button aria-label="Close PDF preview" className="remove-button" onClick={onClose}><Icon name="close" /></button>
          </div>
        </div>
        <div className="pdf-preview-pages">
          {loading && <div className="cart-empty">Rendering PDF preview inside FroozERP...</div>}
          {error && (
            <div className="pdf-preview-fallback">
              <strong>Unable to render PDF preview inside FroozERP.</strong>
              <p>{error}</p>
              <button className="primary-button" disabled={opening} onClick={openFallback}>{opening ? "Opening..." : "Open PDF in system viewer"}</button>
            </div>
          )}
          {!loading && !error && pages.map((page, index) => (
            <PdfPageCanvas key={index + 1} page={page} zoom={zoom} />
          ))}
        </div>
      </section>
    </div>
  );
}

function ReportToolbar({ exporting = false, onPdfExport, onPdfView, onPrint, onWhatsApp, title }) {
  return (
    <div className="report-toolbar no-print">
      <strong>{title}</strong>
      <div className="button-row">
        <button className="secondary-button" onClick={onPrint}><Icon name="print" /> Print</button>
        {onPdfView && <button className="secondary-button" disabled={exporting} onClick={onPdfView}>{exporting ? "Preparing..." : "View PDF"}</button>}
        <button className="secondary-button" disabled={exporting} onClick={onPdfExport || onPrint}>{exporting ? "Exporting..." : "PDF Export"}</button>
        <button className="whatsapp-button" disabled={exporting} onClick={onWhatsApp || onPdfExport || onPrint}><Icon name="message" /> WhatsApp</button>
      </div>
    </div>
  );
}

function UserProfilePanel({ onClose, onLogout, user }) {
  const [passwordDraft, setPasswordDraft] = useState({ password: "", confirm_password: "" });
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [profile, setProfile] = useState(null);
  const [recoveryDraft, setRecoveryDraft] = useState({ email: "", mobile: "" });
  const [verification, setVerification] = useState({ type: "", requestId: "", otp: "", maskedContact: "" });
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const loadRecoveryProfile = async () => {
    try {
      const response = await axios.get(`${API_URL}/auth/recovery/profile`, {
        params: { user_id: user.id, updated_by: user.id },
      });
      setProfile(response.data);
      setRecoveryDraft({
        email: response.data.pending_recovery_email || response.data.recovery_email || "",
        mobile: response.data.pending_recovery_mobile || response.data.recovery_mobile || "",
      });
    } catch (loadError) {
      setError(getAuthErrorMessage(loadError, "Unable to load recovery profile"));
    }
  };
  useEffect(() => {
    loadRecoveryProfile();
  }, [user.id]);
  const savePassword = async () => {
    try {
      await axios.put(`${API_URL}/users/${user.id}/password`, {
        ...passwordDraft,
        updated_by: user.id,
      });
      setPasswordDraft({ password: "", confirm_password: "" });
      setShowPasswordForm(false);
      alert("Password changed");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to change password"));
    }
  };
  const requestContactOtp = async (type) => {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await axios.post(`${API_URL}/auth/recovery/contact/request`, {
        user_id: user.id,
        updated_by: user.id,
        contact_type: type,
        contact_value: type === "email" ? recoveryDraft.email : recoveryDraft.mobile,
      });
      setVerification({
        type,
        requestId: response.data.request_id,
        otp: response.data.development_otp || "",
        maskedContact: response.data.masked_contact || "",
      });
      setMessage(`Verification code sent to ${response.data.masked_contact}.`);
      await loadRecoveryProfile();
    } catch (requestError) {
      setError(getAuthErrorMessage(requestError, "Unable to send recovery contact OTP"));
    } finally {
      setBusy(false);
    }
  };
  const verifyContactOtp = async () => {
    if (!verification.type || !verification.requestId || !verification.otp.trim()) {
      setError("Enter the verification code.");
      return;
    }
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await axios.post(`${API_URL}/auth/recovery/contact/verify`, {
        user_id: user.id,
        updated_by: user.id,
        contact_type: verification.type,
        request_id: verification.requestId,
        otp: verification.otp,
      });
      setMessage(response.data.message || "Recovery contact verified.");
      setVerification({ type: "", requestId: "", otp: "", maskedContact: "" });
      await loadRecoveryProfile();
    } catch (verifyError) {
      setError(getAuthErrorMessage(verifyError, "Unable to verify recovery contact"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section className="invoice-modal profile-panel">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">User Profile</span>
            <strong>{user.full_name}</strong>
          </div>
          <button aria-label="Close profile" className="remove-button" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="sale-edit-body">
          <div className="purchase-summary-grid supplier-payment-preview">
            <SummaryMetric label="Role" value={user.role} featured />
            <SummaryMetric label="Branch" value={user.branch || "Main Branch"} />
            <SummaryMetric label="Last Login" value={user.last_login_at ? new Date(user.last_login_at).toLocaleString("en-IN") : "Not recorded"} />
            <SummaryMetric label="Device" value="Local Counter" />
          </div>
          <div className="form-grid supplier-form-grid">
            <Field label="Username"><input disabled value={user.username || ""} /></Field>
            <Field label="Mobile"><input disabled value={user.mobile_number || ""} /></Field>
            <Field label="Email"><input disabled value={user.email || ""} /></Field>
            <Field label="Joining Date"><input disabled value={user.joining_date ? toDateKey(user.joining_date) : ""} /></Field>
            <Field label="Notes"><textarea disabled value={user.notes || ""} /></Field>
          </div>
          <ModuleCard eyebrow="Recovery Security" title="Owner Recovery Contacts" subtitle="Recovery contacts are usable only after OTP verification. Password recovery requires backend connectivity.">
            <div className="purchase-summary-grid supplier-payment-preview">
              <SummaryMetric label="Email Status" value={profile?.recovery_email_verified ? "Verified" : profile?.pending_recovery_email ? "Pending" : "Not Verified"} featured={profile?.recovery_email_verified} />
              <SummaryMetric label="Mobile Status" value={profile?.recovery_mobile_verified ? "Verified" : profile?.pending_recovery_mobile ? "Pending" : "Not Verified"} featured={profile?.recovery_mobile_verified} />
              <SummaryMetric label="Email Provider" value={profile?.provider_status?.email || "Checking"} />
              <SummaryMetric label="SMS Provider" value={profile?.provider_status?.sms || "Checking"} />
            </div>
            <div className="form-grid supplier-form-grid">
              <Field label="Recovery Email">
                <input type="email" value={recoveryDraft.email} onChange={(event) => setRecoveryDraft({ ...recoveryDraft, email: event.target.value })} />
              </Field>
              <Field label="Recovery Mobile">
                <input value={recoveryDraft.mobile} onChange={(event) => setRecoveryDraft({ ...recoveryDraft, mobile: event.target.value })} placeholder="10 digits or +91XXXXXXXXXX" />
              </Field>
            </div>
            <div className="button-row">
              <button className="secondary-button" disabled={busy} onClick={() => requestContactOtp("email")}>Verify Email</button>
              <button className="secondary-button" disabled={busy} onClick={() => requestContactOtp("mobile")}>Verify Mobile</button>
              <button className="secondary-button" disabled={busy} onClick={loadRecoveryProfile}>Refresh Status</button>
            </div>
            {verification.requestId && (
              <div className="form-grid settings-add-grid">
                <Field label={`OTP for ${verification.maskedContact || verification.type}`}>
                  <input inputMode="numeric" value={verification.otp} onChange={(event) => setVerification({ ...verification, otp: event.target.value.replace(/\D/g, "").slice(0, 8) })} />
                </Field>
                <button className="primary-button" disabled={busy} onClick={verifyContactOtp}>{busy ? "Verifying..." : "Confirm Verification"}</button>
              </div>
            )}
            {(message || error) && (
              <div className={`startup-status-panel ${error ? "startup-status-error" : ""}`}>
                {message && <p>{message}</p>}
                {error && <p>{error}</p>}
              </div>
            )}
          </ModuleCard>
          {showPasswordForm && (
            <div className="form-grid settings-add-grid">
              <Field label="New Password"><input type="password" value={passwordDraft.password} onChange={(event) => setPasswordDraft({ ...passwordDraft, password: event.target.value })} /></Field>
              <Field label="Confirm Password"><input type="password" value={passwordDraft.confirm_password} onChange={(event) => setPasswordDraft({ ...passwordDraft, confirm_password: event.target.value })} /></Field>
            </div>
          )}
          <div className="button-row">
            <button className="secondary-button" onClick={() => setShowPasswordForm((visible) => !visible)}>{showPasswordForm ? "Cancel Password Change" : "Change Password"}</button>
            {showPasswordForm && <button className="primary-button" onClick={savePassword}>Save Password</button>}
            <button className="remove-button" onClick={onLogout}>Logout</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function PrintableReport({ beforePdfExport, beforePrint, children, fileName, reportClassName = "", title, user, whatsappRecipients = [] }) {
  const [printTarget, setPrintTarget] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [whatsappOpen, setWhatsappOpen] = useState(false);
  const [pdfPreview, setPdfPreview] = useState(null);
  const reportRef = useRef(null);
  const reportProfileKey = `report_${safeFileName(reportClassName || title || "report")}`;
  const printProfile = readStoredPrintProfile(reportProfileKey) || getReportPrintProfile(reportClassName);
  const printReport = () => {
    if (beforePrint && beforePrint() === false) return;
    rememberPrintProfile(reportProfileKey, printProfile);
    applyPrintPageProfile(printProfile);
    setTimeout(() => {
      setPrintTarget(true);
      setTimeout(() => {
        withDocumentTitle(fileName || title, () => window.print());
        setTimeout(() => {
          setPrintTarget(false);
          schedulePrintPageProfileCleanup();
        }, 1000);
      }, 50);
    }, 0);
  };
  const exportReport = async () => {
    if (beforePdfExport && beforePdfExport() === false) return;
    rememberPrintProfile(reportProfileKey, printProfile);
    setPrintTarget(true);
    setExporting(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      await exportElementToPdf({
        element: reportRef.current,
        fileName: fileName || `${title}.pdf`,
        mode: "A4",
        printProfile,
      });
    } catch (error) {
      alert(`Unable to export PDF: ${error.message}`);
    } finally {
      setExporting(false);
      setPrintTarget(false);
    }
  };
  const viewReportPdf = async () => {
    if (beforePdfExport && beforePdfExport() === false) return;
    rememberPrintProfile(reportProfileKey, printProfile);
    setPrintTarget(true);
    setExporting(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      const result = await exportElementToPdf({
        element: reportRef.current,
        fileName: fileName || `${title}.pdf`,
        mode: "A4",
        printProfile,
        save: false,
      });
      setPdfPreview({ ...result });
    } catch (error) {
      alert(`Unable to view PDF: ${error.message}`);
    } finally {
      setExporting(false);
      setPrintTarget(false);
    }
  };
  const generateWhatsappPdf = async () => {
    if (beforePdfExport && beforePdfExport() === false) return;
    rememberPrintProfile(reportProfileKey, printProfile);
    setPrintTarget(true);
    setExporting(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, 80));
      return await exportElementToPdf({
        element: reportRef.current,
        fileName: fileName || `${title}.pdf`,
        mode: "A4",
        printProfile,
        save: false,
      });
    } finally {
      setExporting(false);
      setPrintTarget(false);
    }
  };
  return (
    <section className={`print-section ${reportClassName} print-profile-${printProfile.toLowerCase().replace("_", "-")} ${printTarget ? "print-target" : ""}`}>
      <ReportToolbar exporting={exporting} onPdfExport={exportReport} onPdfView={viewReportPdf} onPrint={printReport} onWhatsApp={() => setWhatsappOpen(true)} title={title} />
      <div ref={reportRef} className="print-area report-paper">
        <header className="report-print-header">
          <BrandLogo invoice />
          <div>
            <strong>{title}</strong>
            <span>{new Date().toLocaleString("en-IN")}</span>
          </div>
        </header>
        {children}
      </div>
      {pdfPreview && (
        <PdfPreviewModal
          fileName={pdfPreview.fileName}
          blob={pdfPreview.blob}
          onClose={() => setPdfPreview(null)}
          onSave={() => savePdfResult(pdfPreview)}
        />
      )}
      {whatsappOpen && (
        <WhatsAppSendModal
          caption={`${title} exported from FroozERP`}
          documentName={fileName || `${title}.pdf`}
          generatePdf={generateWhatsappPdf}
          onClose={() => setWhatsappOpen(false)}
          recipients={whatsappRecipients}
          sourceId={fileName || title}
          sourceType="report"
          title={`Send ${title} via WhatsApp`}
          user={user}
        />
      )}
    </section>
  );
}

const matchesPendingBillSearch = (values, search) => {
  const text = String(search || "").trim().toLowerCase();
  if (!text) return true;
  return values.some((value) => String(value ?? "").toLowerCase().includes(text));
};

function PendingPurchaseBillsModule({ onCancelPurchase, onCompletePurchase, onEditPurchase, onOpenPurchaseAmendment, purchases, search = "" }) {
  const [selectedSupplierKey, setSelectedSupplierKey] = useState("");
  const basePendingRows = purchases.filter((purchase) =>
    purchase.purchase_status !== "CANCELLED" &&
    purchase.purchase_bill_status === "BILL_PENDING"
  );
  const narration = (purchase) => {
    const product = purchase.product_name || "Item";
    const qty = Number(purchase.quantity || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
    const unit = String(purchase.unit || "").toLowerCase();
    const rate = Number(purchase.expected_purchase_rate || purchase.purchase_rate || 0);
    return `${product} ${qty}${unit} @ ${receiptCurrency.format(rate)} = ${receiptCurrency.format(Number(purchase.quantity || 0) * rate)}`;
  };
  const estimatedValue = (purchase) => Number(purchase.quantity || 0) * Number(purchase.expected_purchase_rate || purchase.purchase_rate || 0);
  const pendingRows = basePendingRows.filter((purchase) => matchesPendingBillSearch([
    purchase.supplier_name,
    purchase.firm_name,
    purchase.purchase_date,
    purchase.bill_number,
    purchase.payment_mode,
    purchase.purchase_type,
    purchase.remarks,
    purchase.product_name,
    purchase.quantity,
    purchase.expected_purchase_rate,
    purchase.purchase_rate,
    estimatedValue(purchase),
    narration(purchase),
    "Pending Bill",
  ], search));
  const supplierSummaries = [...pendingRows.reduce((map, purchase) => {
    const key = String(purchase.supplier_id || purchase.supplier_name || "UNKNOWN");
    const summary = map.get(key) || {
      key,
      supplier_id: purchase.supplier_id,
      supplier_name: purchase.supplier_name || "Unknown Supplier",
      from: toDateKey(purchase.purchase_date),
      to: toDateKey(purchase.purchase_date),
      billCount: 0,
      itemCount: 0,
      estimatedValue: 0,
      rows: [],
    };
    const date = toDateKey(purchase.purchase_date);
    summary.from = date < summary.from ? date : summary.from;
    summary.to = date > summary.to ? date : summary.to;
    summary.billCount += 1;
    summary.itemCount += 1;
    summary.estimatedValue += estimatedValue(purchase);
    summary.rows.push(purchase);
    map.set(key, summary);
    return map;
  }, new Map()).values()].sort((left, right) => left.supplier_name.localeCompare(right.supplier_name));
  const selectedSupplier = supplierSummaries.find((summary) => summary.key === selectedSupplierKey);
  const selectedRows = selectedSupplier?.rows || [];

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Pending Purchase Bills" title="Supplier-Wise Pending Bills" subtitle="Operational queue for stock received before supplier bill completion.">
        <div className="purchase-summary-grid supplier-payment-preview">
          <SummaryMetric label="Pending Suppliers" value={supplierSummaries.length} featured />
          <SummaryMetric label="Pending Bills" value={pendingRows.length} />
          <SummaryMetric label="Estimated Value" value={currency.format(pendingRows.reduce((sum, row) => sum + estimatedValue(row), 0))} />
        </div>
        <DataTable headers={["Supplier Name", "Pending From Date", "Pending To Date", "Pending Bill Count", "Total Pending Items", "Estimated Value", "Action"]}>
          {supplierSummaries.map((summary) => (
            <tr key={summary.key}>
              <td className="primary-cell">{summary.supplier_name}</td>
              <td>{formatDisplayDate(summary.from)}</td>
              <td>{formatDisplayDate(summary.to)}</td>
              <td>{summary.billCount} bills</td>
              <td>{summary.itemCount} items</td>
              <td>{currency.format(summary.estimatedValue)}</td>
              <td><button className="table-action" onClick={() => setSelectedSupplierKey(summary.key)}>View</button></td>
            </tr>
          ))}
        </DataTable>
        {supplierSummaries.length === 0 && <div className="cart-empty">{basePendingRows.length ? "No matching pending bills found." : "No pending purchase bills."}</div>}
      </ModuleCard>

      {selectedSupplier && (
        <ModuleCard eyebrow="Supplier Drill-Down" title={selectedSupplier.supplier_name} subtitle="Complete, edit or safely cancel pending bill entries for this supplier.">
          <DataTable headers={["Date", "Items Narration", "Estimated Total", "Status", "Action"]}>
            {selectedRows.map((purchase) => (
              <tr className="report-row-clickable" key={purchase.id} onClick={() => onOpenPurchaseAmendment(purchase)}>
                <td>{formatDisplayDate(purchase.purchase_date)}</td>
                <td className="primary-cell purchase-items-cell">
                  <span title={narration(purchase)}>{narration(purchase)}</span>
                </td>
                <td>{currency.format(estimatedValue(purchase))}</td>
                <td><span className="origin-rate">Pending Bill</span></td>
                <td>
                  <div className="button-row table-actions-row">
                    <button className="primary-button" onClick={(event) => { event.stopPropagation(); onCompletePurchase(purchase); }}>Complete Bill</button>
                    <button className="table-action" onClick={(event) => { event.stopPropagation(); onEditPurchase(purchase); }}>Edit Pending Entry</button>
                    <button className="remove-button" onClick={(event) => { event.stopPropagation(); onCancelPurchase(purchase); }}>Cancel Pending Entry</button>
                  </div>
                </td>
              </tr>
            ))}
          </DataTable>
          <div className="button-row">
            <button className="secondary-button" onClick={() => onOpenPurchaseAmendment(selectedRows[0])}>Add Forgotten Item</button>
            <button className="secondary-button" onClick={() => setSelectedSupplierKey("")}>Back to Supplier Summary</button>
          </div>
        </ModuleCard>
      )}
    </section>
  );
}

function PendingBillsModule({ customerPendingBills = { summary: [], invoices: [] }, customers = [], onCancelPurchase, onCompletePurchase, onEditPurchase, onOpenPurchaseAmendment, onReload, onViewInvoice, purchases, user }) {
  const [activeTab, setActiveTab] = useState("purchase");
  const [selectedCustomerKey, setSelectedCustomerKey] = useState("");
  const [pendingSearch, setPendingSearch] = useState("");
  const [paymentDraft, setPaymentDraft] = useState({
    customer_id: "",
    payment_date: toDateKey(new Date()),
    payment_amount: "",
    payment_mode: "CASH",
    reference_number: "",
    remarks: "",
  });
  const rawSummaries = Array.isArray(customerPendingBills.summary) ? customerPendingBills.summary : [];
  const summaries = rawSummaries
    .map((summary) => {
      const rows = Array.isArray(summary.rows) ? summary.rows : [];
      const summaryMatches = matchesPendingBillSearch([
        summary.customer_name,
        summary.from,
        summary.to,
        summary.pending_bill_count,
        summary.total_credit_amount,
        summary.amount_received,
        summary.balance,
        "Customer Pending Bills",
      ], pendingSearch);
      const filteredRows = rows.filter((invoice) => matchesPendingBillSearch([
        summary.customer_name,
        invoice.customer_name,
        invoice.invoice_no,
        invoice.sale_date,
        invoice.bill_date,
        invoice.item_narration,
        invoice.gross_amount,
        invoice.item_discount_amount,
        invoice.invoice_discount_amount,
        invoice.total_amount,
        invoice.received_amount,
        invoice.balance_amount,
        invoice.due_date,
        invoice.credit_status,
        invoice.payment_mode,
        invoice.remarks,
      ], pendingSearch));
      return { ...summary, rows: summaryMatches ? rows : filteredRows };
    })
    .filter((summary) => matchesPendingBillSearch([
      summary.customer_name,
      summary.from,
      summary.to,
      summary.pending_bill_count,
      summary.total_credit_amount,
      summary.amount_received,
      summary.balance,
    ], pendingSearch) || summary.rows.length > 0);
  const selectedCustomer = summaries.find((summary) => summary.key === selectedCustomerKey);
  const canReceivePayment = ["Owner", "Admin", "Cashier"].includes(user.role);

  const openReceivePayment = (summary, invoice = null) => {
    if (!summary?.customer_id) {
      alert("Customer account is required before receiving payment.");
      return;
    }
    setSelectedCustomerKey(summary.key);
    setPaymentDraft({
      customer_id: summary.customer_id,
      payment_date: toDateKey(new Date()),
      payment_amount: invoice ? Number(invoice.balance_amount || 0).toFixed(2) : "",
      payment_mode: "CASH",
      reference_number: "",
      remarks: invoice?.invoice_no ? `Against credit invoice ${invoice.invoice_no}` : "Against customer pending bills",
    });
  };

  const saveCustomerPayment = async () => {
    if (!canReceivePayment) {
      alert("Your role cannot receive customer payments.");
      return;
    }
    if (!paymentDraft.customer_id || Number(paymentDraft.payment_amount || 0) <= 0) {
      alert("Enter valid customer payment details.");
      return;
    }
    try {
      await axios.post(`${API_URL}/customer-payments`, {
        ...paymentDraft,
        branch_id: user.branch_id,
        created_by: user.id,
      });
      setPaymentDraft({ customer_id: "", payment_date: toDateKey(new Date()), payment_amount: "", payment_mode: "CASH", reference_number: "", remarks: "" });
      await onReload();
      alert("Customer payment saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save customer payment"));
    }
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Operations" title="Pending Bills" subtitle="Complete supplier pending bills and settle customer credit invoices.">
        <label className="icon-input table-search-input">
          <Icon name="search" />
          <input
            placeholder="Search pending bill, customer, supplier, invoice..."
            value={pendingSearch}
            onChange={(event) => setPendingSearch(event.target.value)}
          />
        </label>
        <div className="settings-tabs">
          <button className={activeTab === "purchase" ? "tab-active" : ""} onClick={() => setActiveTab("purchase")}>Pending Purchase Bills</button>
          <button className={activeTab === "customer" ? "tab-active" : ""} onClick={() => setActiveTab("customer")}>Customer Pending Bills</button>
        </div>
      </ModuleCard>

      {activeTab === "purchase" && (
        <PendingPurchaseBillsModule
          onCancelPurchase={onCancelPurchase}
          onCompletePurchase={onCompletePurchase}
          onEditPurchase={onEditPurchase}
          onOpenPurchaseAmendment={onOpenPurchaseAmendment}
          purchases={purchases}
          search={pendingSearch}
        />
      )}

      {activeTab === "customer" && (
        <>
          <ModuleCard eyebrow="Customer Credit" title="Customer-Wise Pending Bills" subtitle="Credit POS bills stay here until customer receipts are entered.">
            <div className="purchase-summary-grid supplier-payment-preview">
              <SummaryMetric label="Customers Pending" value={summaries.length} featured />
              <SummaryMetric label="Credit Amount" value={currency.format(summaries.reduce((sum, row) => sum + Number(row.total_credit_amount || 0), 0))} />
              <SummaryMetric label="Balance" value={currency.format(summaries.reduce((sum, row) => sum + Number(row.balance || 0), 0))} />
            </div>
            <DataTable headers={["Customer Name", "Pending From Date", "Pending To Date", "Pending Bill Count", "Total Credit Amount", "Amount Received", "Balance", "Action"]}>
              {summaries.map((summary) => (
                <tr key={summary.key}>
                  <td className="primary-cell">{summary.customer_name}</td>
                  <td>{formatDisplayDate(summary.from)}</td>
                  <td>{formatDisplayDate(summary.to)}</td>
                  <td>{summary.pending_bill_count} bills</td>
                  <td>{currency.format(Number(summary.total_credit_amount || 0))}</td>
                  <td>{currency.format(Number(summary.amount_received || 0))}</td>
                  <td className="balance-cell">{currency.format(Number(summary.balance || 0))}</td>
                  <td><button className="table-action" onClick={() => setSelectedCustomerKey(summary.key)}>View</button></td>
                </tr>
              ))}
            </DataTable>
            {summaries.length === 0 && <div className="cart-empty">{rawSummaries.length ? "No matching pending bills found." : "No customer pending bills."}</div>}
          </ModuleCard>

          {selectedCustomer && (
            <ModuleCard eyebrow="Customer Drill-Down" title={selectedCustomer.customer_name} subtitle="Receive payment, view invoices and print customer credit statement.">
              <DataTable headers={["Bill Date", "Invoice Number", "Items / Narration", "Gross Amount", "Discount", "Net Amount", "Received", "Balance", "Due Date", "Status", "Action"]}>
                {selectedCustomer.rows.map((invoice) => (
                  <tr key={invoice.id}>
                    <td>{formatDisplayDate(invoice.sale_date)}</td>
                    <td><span className="batch-id">{invoice.invoice_no || `#${invoice.id}`}</span></td>
                    <td className="primary-cell purchase-items-cell"><span title={invoice.item_narration}>{String(invoice.item_narration || "").split("\n").slice(0, 2).join(", ")}</span></td>
                    <td>{currency.format(Number(invoice.gross_amount || 0))}</td>
                    <td>{currency.format(Number(invoice.item_discount_amount || 0) + Number(invoice.invoice_discount_amount || 0))}</td>
                    <td>{currency.format(Number(invoice.total_amount || 0))}</td>
                    <td>{currency.format(Number(invoice.received_amount || 0))}</td>
                    <td className="balance-cell">{currency.format(Number(invoice.balance_amount || 0))}</td>
                    <td>{invoice.due_date ? formatDisplayDate(invoice.due_date) : "-"}</td>
                    <td><span className={invoice.credit_status === "Paid" ? "stock-ok" : invoice.credit_status === "Partially Paid" ? "origin-rate" : "stock-low"}>{invoice.credit_status}</span></td>
                    <td>
                      <div className="button-row table-actions-row">
                        <button className="primary-button" disabled={Number(invoice.balance_amount || 0) <= 0} onClick={() => openReceivePayment(selectedCustomer, invoice)}>Receive Payment</button>
                        <button className="table-action" onClick={() => onViewInvoice(invoice.id)}>View Invoice</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </DataTable>
              <div className="button-row">
                <button className="secondary-button" onClick={() => openReceivePayment(selectedCustomer)}>Receive General Payment</button>
                <button className="secondary-button" onClick={() => window.print()}>Print Statement</button>
                <button className="secondary-button" onClick={() => setSelectedCustomerKey("")}>Back to Customer Summary</button>
              </div>
            </ModuleCard>
          )}

          {paymentDraft.customer_id && (
            <ModuleCard eyebrow="Customer Receipt" title="Receive Payment Against Credit" subtitle="Payment will reduce customer receivable and update Cash Book based on payment mode.">
              <div className="form-grid supplier-form-grid">
                <Field label="Customer">
                  <select value={paymentDraft.customer_id} onChange={(event) => setPaymentDraft({ ...paymentDraft, customer_id: event.target.value })}>
                    <option value="">Select customer</option>
                    {customers.filter((customer) => customer.active !== false).map((customer) => <option key={customer.id} value={customer.id}>{customer.customer_name}</option>)}
                  </select>
                </Field>
                <Field label="Payment Date"><input type="date" value={paymentDraft.payment_date} onChange={(event) => setPaymentDraft({ ...paymentDraft, payment_date: event.target.value })} /></Field>
                <Field label="Payment Amount"><input min="0" step="0.01" type="number" value={paymentDraft.payment_amount} onChange={(event) => setPaymentDraft({ ...paymentDraft, payment_amount: event.target.value })} /></Field>
                <Field label="Payment Mode">
                  <select value={paymentDraft.payment_mode} onChange={(event) => setPaymentDraft({ ...paymentDraft, payment_mode: event.target.value })}>
                    <option value="CASH">Cash</option>
                    <option value="UPI">UPI</option>
                    <option value="CARD">Card</option>
                    <option value="BANK_TRANSFER">Bank</option>
                  </select>
                </Field>
                <Field label="Reference Number"><input value={paymentDraft.reference_number} onChange={(event) => setPaymentDraft({ ...paymentDraft, reference_number: event.target.value })} /></Field>
                <Field label="Remarks"><input value={paymentDraft.remarks} onChange={(event) => setPaymentDraft({ ...paymentDraft, remarks: event.target.value })} /></Field>
              </div>
              <div className="button-row">
                <button className="primary-button" onClick={saveCustomerPayment}>Save Payment</button>
                <button className="secondary-button" onClick={() => setPaymentDraft({ customer_id: "", payment_date: toDateKey(new Date()), payment_amount: "", payment_mode: "CASH", reference_number: "", remarks: "" })}>Cancel</button>
              </div>
            </ModuleCard>
          )}
        </>
      )}
    </section>
  );
}

function DiscountManagementModule({ discounts = [], inventory = [], onReload, products = [], user }) {
  const [productId, setProductId] = useState("");
  const [selectedLotIds, setSelectedLotIds] = useState([]);
  const [form, setForm] = useState({
    discount_type: "FIXED_AMOUNT",
    discount_value: "",
    start_date: toDateKey(new Date()),
    end_date: "",
    active: true,
    remarks: "",
  });
  const canManage = ["Owner", "Admin"].includes(user.role);
  const productLots = inventory.filter((lot) =>
    String(lot.product_id) === String(productId) &&
    Number(lot.remaining_qty || 0) > 0 &&
    lot.batch_status !== "CANCELLED"
  );
  const activeDiscountForLot = (lotId) => discounts.find((discount) =>
    Number(discount.inventory_batch_id) === Number(lotId) &&
    discount.active !== false &&
    (!discount.end_date || toDateKey(discount.end_date) >= toDateKey(new Date()))
  );

  const toggleLot = (lotId) => {
    setSelectedLotIds((ids) => ids.includes(lotId) ? ids.filter((id) => id !== lotId) : [...ids, lotId]);
  };

  const saveDiscount = async () => {
    if (!canManage) {
      alert("Only Owner/Admin can create discounts.");
      return;
    }
    if (!productId || selectedLotIds.length === 0 || Number(form.discount_value || 0) < 0) {
      alert("Select product, lot and valid discount value.");
      return;
    }
    try {
      await axios.post(`${API_URL}/lot-discounts`, {
        product_id: productId,
        inventory_batch_ids: selectedLotIds,
        ...form,
        created_by: user.id,
      });
      setSelectedLotIds([]);
      setForm({ discount_type: "FIXED_AMOUNT", discount_value: "", start_date: toDateKey(new Date()), end_date: "", active: true, remarks: "" });
      await onReload();
      alert("Discount saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save discount"));
    }
  };

  const deactivateDiscount = async (discount) => {
    if (!canManage) {
      alert("Only Owner/Admin can deactivate discounts.");
      return;
    }
    const remarks = window.prompt("Reason / remarks for deactivation", "Discount deactivated") || "Discount deactivated";
    try {
      await axios.post(`${API_URL}/lot-discounts/${discount.id}/deactivate`, { updated_by: user.id, remarks });
      await onReload();
      alert("Discount deactivated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to deactivate discount"));
    }
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Retail Pricing" title="Discount Management" subtitle="Create item-wise and lot-wise retail POS discounts without changing permanent sale rates.">
        <div className="form-grid supplier-form-grid">
          <Field label="Product / Item">
            <select value={productId} onChange={(event) => { setProductId(event.target.value); setSelectedLotIds([]); }}>
              <option value="">Select product</option>
              {products.map((product) => <option key={product.id} value={product.id}>{product.category || "Fruit"} - {product.product_name}</option>)}
            </select>
          </Field>
          <Field label="Discount Type">
            <select value={form.discount_type} onChange={(event) => setForm({ ...form, discount_type: event.target.value })}>
              <option value="FIXED_AMOUNT">Fixed Amount Discount</option>
              <option value="PERCENTAGE">Percentage Discount</option>
              <option value="SPECIAL_RATE">Special Sale Rate</option>
            </select>
          </Field>
          <Field label="Discount Value"><input min="0" step="0.01" type="number" value={form.discount_value} onChange={(event) => setForm({ ...form, discount_value: event.target.value })} /></Field>
          <Field label="Start Date"><input type="date" value={form.start_date} onChange={(event) => setForm({ ...form, start_date: event.target.value })} /></Field>
          <Field label="End Date"><input type="date" value={form.end_date} onChange={(event) => setForm({ ...form, end_date: event.target.value })} /></Field>
          <Field label="Status">
            <select value={form.active ? "ACTIVE" : "INACTIVE"} onChange={(event) => setForm({ ...form, active: event.target.value === "ACTIVE" })}>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </select>
          </Field>
          <Field label="Remarks"><input value={form.remarks} onChange={(event) => setForm({ ...form, remarks: event.target.value })} /></Field>
        </div>
        <div className="button-row">
          <button className="secondary-button" disabled={productLots.length === 0} onClick={() => setSelectedLotIds(productLots.map((lot) => lot.id))}>Select All Active Lots</button>
          <button className="primary-button" disabled={!canManage} onClick={saveDiscount}>Save Discount</button>
        </div>
      </ModuleCard>

      <ModuleCard eyebrow="Lot Selection" title="Available Lots / Batches" subtitle="Discounts apply only to the selected stock lots.">
        <DataTable headers={["Select", "Lot Name / Number", "Size / Grade", "Supplier", "Available Qty", "Current Sale Rate", "Cost Rate", "Existing Discount", "Status"]}>
          {productLots.map((lot) => {
            const existing = activeDiscountForLot(lot.id);
            return (
              <tr key={lot.id}>
                <td><input checked={selectedLotIds.includes(lot.id)} type="checkbox" onChange={() => toggleLot(lot.id)} /></td>
                <td className="primary-cell">{lot.lot_name || lot.batch_no || `Lot #${lot.id}`}</td>
                <td>{lot.lot_size || "-"}</td>
                <td>{lot.supplier_name || "-"}</td>
                <td>{Number(lot.remaining_qty || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</td>
                <td>{currency.format(Number(lot.temporary_sale_rate || 0) > 0 ? Number(lot.temporary_sale_rate) : Number(lot.selling_rate || 0))}</td>
                <td>{currency.format(Number(lot.effective_cost_per_unit || lot.purchase_rate || 0))}</td>
                <td>{existing ? `${existing.discount_type} ${currency.format(Number(existing.discount_value || 0))}` : "-"}</td>
                <td><span className={lot.batch_status === "ACTIVE" || !lot.batch_status ? "stock-ok" : "stock-low"}>{lot.batch_status || "ACTIVE"}</span></td>
              </tr>
            );
          })}
        </DataTable>
        {productId && productLots.length === 0 && <div className="cart-empty">No active lots with stock for this product.</div>}
        {!productId && <div className="cart-empty">Select a product to view lots.</div>}
      </ModuleCard>

      <ModuleCard eyebrow="Active Discounts" title="Current Lot-Wise Discounts" subtitle="Reports and Sales History always keep discount accounting, even if receipt display hides it.">
        <DataTable headers={["Product", "Lot / Size", "Discount Type", "Value", "Start", "End", "Status", "Remarks", "Actions"]}>
          {discounts.map((discount) => (
            <tr key={discount.id}>
              <td className="primary-cell">{discount.product_name}</td>
              <td>{discount.lot_name || discount.batch_no || "-"}{discount.lot_size ? ` / ${discount.lot_size}` : ""}</td>
              <td>{discount.discount_type}</td>
              <td>{discount.discount_type === "PERCENTAGE" ? `${Number(discount.discount_value || 0)}%` : currency.format(Number(discount.discount_value || 0))}</td>
              <td>{formatDisplayDate(discount.start_date)}</td>
              <td>{discount.end_date ? formatDisplayDate(discount.end_date) : "Open"}</td>
              <td><span className={discount.active ? "stock-ok" : "stock-low"}>{discount.active ? "Active" : "Inactive"}</span></td>
              <td>{discount.remarks || "-"}</td>
              <td><button className="remove-button" disabled={!discount.active || !canManage} onClick={() => deactivateDiscount(discount)}>Deactivate</button></td>
            </tr>
          ))}
        </DataTable>
      </ModuleCard>
    </section>
  );
}

function ReportsModule({ accounts = [], canCancelSales, canEditSales, canManageStock, customers = [], data = {}, onCancelPurchase, onCompletePurchase, onEditPurchase, onOpenBlankPurchaseAmendment, onOpenCustomerLedger, onOpenLotAction, onOpenPurchaseAmendment, onOpenSaleForEdit, onOpenSaleView, onPrintSale, onCancelSale, onOpenSupplierLedger, onReload, suppliers = [], user }) {
  const [range, setRange] = useState("today");
  const [search, setSearch] = useState("");
  const [selectedCategory, setSelectedCategory] = useState("");
  const [selectedReport, setSelectedReport] = useState("");
  const [clubSalesItems, setClubSalesItems] = useState(false);
  const [salesPrintNarration, setSalesPrintNarration] = useState(false);
  const salesPrintNarrationRef = useRef(false);
  const [clubPurchaseItems, setClubPurchaseItems] = useState(false);
  const [purchasePrintNarration, setPurchasePrintNarration] = useState(false);
  const purchasePrintNarrationRef = useRef(false);
  const [salesFilters, setSalesFilters] = useState({
    date: "",
    status: "ACTIVE",
    viewMode: "INVOICE",
    customerMode: "ALL",
    customer: "",
    selectedCustomers: [],
    product: "",
    lot: "",
    paymentMode: "",
    userMode: "ALL",
    user: "",
    selectedUsers: [],
  });
  const [expandedSalesRows, setExpandedSalesRows] = useState({});
  const [accountReportFilters, setAccountReportFilters] = useState({
    accountType: "",
    accountName: "",
    voucherType: "",
    paymentMode: "",
  });
  const [clubLedgerEntries, setClubLedgerEntries] = useState(false);
  const [ledgerPrintNarration, setLedgerPrintNarration] = useState(false);
  const ledgerPrintNarrationRef = useRef(false);
  const [balanceSheetDetail, setBalanceSheetDetail] = useState(null);
  const [balanceSheetDetailLoading, setBalanceSheetDetailLoading] = useState(false);
  const [balanceSheetDetailError, setBalanceSheetDetailError] = useState("");
  const [cashBookDetail, setCashBookDetail] = useState(null);
  const whatsappRecipients = useMemo(() => buildWhatsappRecipients({ accounts, customers, suppliers }), [accounts, customers, suppliers]);
  const [cashBookFilters, setCashBookFilters] = useState({ paymentMode: "", accountFilter: "", bookAccount: "ALL" });
  const [cashBookViewMode, setCashBookViewMode] = useState("SUMMARY");
  const [cashBookGroupBy, setCashBookGroupBy] = useState("PERIOD");
  const [showCashBookRemarks, setShowCashBookRemarks] = useState(true);
  const [inventoryLotReportFilter, setInventoryLotReportFilter] = useState("ACTIVE");
  const [purchaseFilters, setPurchaseFilters] = useState({
    supplier: "",
    product: "",
    status: "ACTIVE",
    paymentType: "",
    date: "",
  });
  const [customRange, setCustomRange] = useState({
    date_from: toDateKey(new Date()),
    date_to: toDateKey(new Date()),
  });
  const currentReportParams = () => range === "custom" ? customRange : { range };
  const currentCashBookParams = (overrides = {}) => {
    const nextFilters = { ...cashBookFilters, ...(overrides.filters || {}) };
    const bookAccount = nextFilters.bookAccount || "ALL";
    const accountFilter = bookAccount === "CASH" ? "CASH" : ["BANK", "UPI", "CARD", "BANK_TRANSFER"].includes(bookAccount) ? "BANK" : "";
    const paymentMode = ["UPI", "CARD", "BANK_TRANSFER"].includes(bookAccount)
      ? bookAccount
      : nextFilters.paymentMode;
    return {
      ...currentReportParams(),
      payment_mode: paymentMode,
      account_filter: accountFilter,
      party_filter: nextFilters.accountFilter,
      search,
    };
  };
  const refreshReports = async () => {
    await onReload(selectedReport === "cashBook" ? currentCashBookParams() : currentReportParams());
  };
  const reloadCashBook = async (filters = cashBookFilters) => {
    await onReload(currentCashBookParams({ filters }));
  };
  const clearLedgerFilters = async () => {
    setAccountReportFilters({ accountType: "", accountName: "", voucherType: "", paymentMode: "" });
    await onReload(currentReportParams());
  };
  const openBalanceSheetDetail = async (lineKey) => {
    if (!lineKey) return;
    setBalanceSheetDetailLoading(true);
    setBalanceSheetDetailError("");
    setBalanceSheetDetail(null);
    try {
      const response = await axios.get(`${API_URL}/reports/balance-sheet/details/${lineKey}`, { params: currentReportParams() });
      setBalanceSheetDetail(response.data);
    } catch (error) {
      setBalanceSheetDetailError(getErrorMessage(error, "Unable to load Balance Sheet detail"));
    } finally {
      setBalanceSheetDetailLoading(false);
    }
  };
  const matchesSearch = (row) => !search.trim() || Object.values(row || {}).some((value) => {
    const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
    return text.toLowerCase().includes(search.trim().toLowerCase());
  });
  const filterRows = (rows) => {
    const safeRows = Array.isArray(rows)
      ? rows
      : Array.isArray(rows?.data)
        ? rows.data
        : Array.isArray(rows?.rows)
          ? rows.rows
          : Array.isArray(rows?.items)
            ? rows.items
            : [];
    return safeRows.filter(matchesSearch);
  };
  const totalOf = (rows, key) => rows.reduce((sum, row) => sum + Number(row[key] || 0), 0);
  const money = (value) => currency.format(Number(value || 0));
  const number = (value) => Number(value || 0).toLocaleString("en-IN");
  const stockRows = filterRows(data.stockReport);
  const lowStockRows = stockRows.filter((row) => Number(row.current_stock || 0) <= Number(row.minimum_stock || 0));
  const ledgerRows = filterRows(data.ledgerReport);
  const dayBookVoucherType = (row) => {
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
    return row.transaction_type || row.voucher_type || "-";
  };
  const accountNames = [...new Set(ledgerRows.map((row) => row.party_name).filter(Boolean))].sort();
  const voucherTypes = [
    "POS Sale",
    "Purchase",
    "Supplier Payment",
    "Customer Receipt",
    "Expense",
    "Sale Return",
    "Waste",
    "Stock Adjustment",
    "Opening Stock",
    "Owner Capital",
    "Drawings",
    ...new Set(ledgerRows.map(dayBookVoucherType).filter(Boolean)),
  ].filter((type, index, list) => list.indexOf(type) === index).sort();
  const filteredLedgerRows = ledgerRows.filter((row) => {
    if (accountReportFilters.accountType === "CASH" && row.payment_mode !== "CASH") return false;
    if (accountReportFilters.accountType === "BANK" && !bankPaymentModes.has(row.payment_mode)) return false;
    if (accountReportFilters.accountType === "EXPENSE" && !["EXPENSE", "EXPENSE_VENDOR"].includes(row.account_type)) return false;
    if (accountReportFilters.accountType && !["CASH", "BANK", "EXPENSE"].includes(accountReportFilters.accountType) && row.account_type !== accountReportFilters.accountType) return false;
    if (accountReportFilters.accountName && row.party_name !== accountReportFilters.accountName) return false;
    if (accountReportFilters.voucherType && dayBookVoucherType(row) !== accountReportFilters.voucherType) return false;
    if (accountReportFilters.paymentMode === "OTHER" && ["CASH", "UPI", "CARD", "BANK_TRANSFER", "CREDIT", "CHEQUE"].includes(row.payment_mode)) return false;
    if (accountReportFilters.paymentMode && accountReportFilters.paymentMode !== "OTHER" && row.payment_mode !== accountReportFilters.paymentMode) return false;
    return true;
  });
  const clubRowsByDateAccount = (rows) => {
    if (!clubLedgerEntries) return rows;
    const groups = new Map();
    for (const row of rows) {
      const voucherType = dayBookVoucherType(row);
      const key = `${toDateKey(row.date)}-${voucherType}-${row.party_name}-${row.payment_mode || "NONE"}`;
      const current = groups.get(key) || {
        ...row,
        display_voucher_type: voucherType,
        voucher_no: "Multiple",
        debit: 0,
        credit: 0,
        narration: "",
        remarks: "",
        transaction_count: 0,
      };
      current.debit += Number(row.debit || 0);
      current.credit += Number(row.credit || 0);
      current.transaction_count += 1;
      current.narration = [current.narration, row.narration || row.remarks].filter(Boolean).join("\n");
      current.remarks = [current.remarks, row.remarks].filter(Boolean).join("; ");
      current.narration_summary = `${voucherType} - ${current.transaction_count} ${current.transaction_count === 1 ? "entry" : "entries"}${row.payment_mode ? ` - ${row.payment_mode}` : ""}`;
      groups.set(key, current);
    }
    return [...groups.values()];
  };
  const withRunningBalance = (rows, mode = "RECEIVABLE") => {
    let balance = 0;
    return [...rows]
      .sort((left, right) => toDateKey(left.date).localeCompare(toDateKey(right.date)) || String(left.voucher_no || "").localeCompare(String(right.voucher_no || "")))
      .map((row) => {
        balance = roundUi(balance + (mode === "PAYABLE" ? Number(row.credit || 0) - Number(row.debit || 0) : Number(row.debit || 0) - Number(row.credit || 0)));
        return { ...row, running_balance: balance };
      })
      .sort((left, right) => toDateKey(right.date).localeCompare(toDateKey(left.date)) || String(right.voucher_no || "").localeCompare(String(left.voucher_no || "")));
  };
  const ledgerNarration = (row) => ledgerPrintNarration || ledgerPrintNarrationRef.current ? row.narration || row.remarks || "-" : row.remarks || row.narration || "-";
  const customerLedgerRows = withRunningBalance(clubRowsByDateAccount(filteredLedgerRows.filter((row) => row.account_type === "CUSTOMER")));
  const supplierLedgerRows = withRunningBalance(clubRowsByDateAccount(filteredLedgerRows.filter((row) => row.account_type === "SUPPLIER")), "PAYABLE");
  const accountStatementRows = withRunningBalance(clubRowsByDateAccount(filteredLedgerRows));
  const dayBookRows = clubRowsByDateAccount(filteredLedgerRows);
  const cashBookData = data.cashBookReport || {};
  const cashBookRows = filterRows(cashBookData.rows);
  const stockLotRows = filterRows(data.stockLotReport).filter((row) => {
    const status = String(row.batch_status || "ACTIVE").toUpperCase();
    const balance = Number(row.remaining_qty ?? row.balance_qty ?? 0);
    if (inventoryLotReportFilter === "ACTIVE") return balance > 0 && !["CANCELLED", "INACTIVE"].includes(status);
    if (inventoryLotReportFilter === "SOLD_OUT") return !["CANCELLED", "INACTIVE"].includes(status);
    return true;
  });
  const cashBookAccountMode = cashBookFilters.bookAccount || "ALL";
  const cashBookAccountLabel = cashBookAccountMode === "ALL"
    ? "Cash + Bank"
    : cashBookAccountMode === "CASH"
      ? "Cash"
      : cashBookAccountMode === "UPI"
      ? "UPI"
      : cashBookAccountMode === "CARD"
        ? "Card"
        : cashBookAccountMode === "BANK_TRANSFER"
          ? "Bank Transfer"
          : "Bank / UPI / Card";
  const cashBookOpeningCash = Number(cashBookData.opening_cash || 0);
  const cashBookOpeningBank = Number(cashBookData.opening_bank || 0);
  const cashBookReceiptsCash = Number(cashBookData.cash_receipts || 0);
  const cashBookReceiptsBank = Number(cashBookData.bank_receipts || 0);
  const cashBookPaymentsCash = Number(cashBookData.cash_payments || 0);
  const cashBookPaymentsBank = Number(cashBookData.bank_payments || 0);
  const cashBookClosingCash = Number(cashBookData.closing_cash || 0);
  const cashBookClosingBank = Number(cashBookData.closing_bank || 0);
  const salesChanges = filterRows(data.salesChangeReport);
  const editedBills = salesChanges.filter((row) => row.sale_status === "EDITED" || row.edited_at);
  const cancelledBills = salesChanges.filter((row) => row.sale_status === "CANCELLED" || row.cancelled_at);
  const purchaseChanges = filterRows(data.purchaseChangeReport);
  const wasteProductRows = filterRows(data.wasteProductReport);
  const purchaseHistoryRawRows = filterRows(data.purchaseHistoryReport).filter((row) =>
    row.purchase_status === "CANCELLED" || row.purchase_bill_status === "BILL_COMPLETED"
  );
  const purchaseSuppliers = [...new Map(purchaseHistoryRawRows.map((row) => [String(row.supplier_id || row.supplier_name), row])).values()];
  const purchaseProducts = [...new Map(purchaseHistoryRawRows.map((row) => [String(row.product_id || row.product_name), row])).values()];
  const purchaseStatusLabel = (row) => {
    if (row.purchase_status === "CANCELLED") return "Cancelled";
    if (row.purchase_bill_status === "BILL_PENDING") return "Pending Bill";
    return "Completed Bill";
  };
  const purchaseCharges = (row) => (
    Number(row.mandi_tax_amount || 0) +
    Number(row.freight_charges || 0) +
    Number(row.labour_charges || 0) +
    Number(row.other_charges || 0)
  );
  const purchaseItemBasic = (row) => Number(row.item_basic_amount || 0) || Number(row.quantity || 0) * Number(row.purchase_rate || row.expected_purchase_rate || 0);
  const purchaseItemNarration = (row) => {
    const product = row.product_name || "Item";
    const lotText = row.lot_name ? ` (${row.lot_name}${row.lot_size ? ` / ${row.lot_size}` : ""})` : "";
    const qty = Number(row.quantity || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
    const unit = String(row.unit || "").toLowerCase();
    const rate = Number(row.purchase_rate || row.expected_purchase_rate || 0);
    return `${product}${lotText} ${qty}${unit} @ ${money(rate)} = ${money(purchaseItemBasic(row))}`;
  };
  const filteredPurchaseHistoryRows = purchaseHistoryRawRows.filter((row) => {
    if (purchaseFilters.supplier && String(row.supplier_id || "") !== purchaseFilters.supplier) return false;
    if (purchaseFilters.product && String(row.product_id || "") !== purchaseFilters.product) return false;
    if (purchaseFilters.paymentType && row.purchase_type !== purchaseFilters.paymentType) return false;
    if (purchaseFilters.date && toDateKey(row.purchase_date) !== purchaseFilters.date) return false;
    if (purchaseFilters.status === "CANCELLED") return row.purchase_status === "CANCELLED";
    if (purchaseFilters.status === "BILL_COMPLETED") return row.purchase_status !== "CANCELLED" && row.purchase_bill_status === "BILL_COMPLETED";
    return row.purchase_status !== "CANCELLED";
  });
  const groupedPurchaseHistoryRows = (() => {
    if (!clubPurchaseItems) return filteredPurchaseHistoryRows.map((row) => ({
      ...row,
      display_key: `item-${row.id}-${row.item_id || row.product_id}`,
      item_summary: purchaseItemNarration(row),
      item_narration: purchaseItemNarration(row),
      gross_total: Number(row.gross_amount || 0) || purchaseItemBasic(row) + purchaseCharges(row),
      charges_total: purchaseCharges(row),
      rebate_total: Number(row.rebate_amount || 0),
      net_total: Number(row.net_payable || row.item_net_payable || 0),
      paid_total: Number(row.paid_amount || 0),
      balance_total: Number(row.balance_amount || 0),
      status_label: purchaseStatusLabel(row),
      source_rows: [row],
    }));
    const groups = new Map();
    for (const row of filteredPurchaseHistoryRows) {
      const key = `${toDateKey(row.purchase_date)}-${row.supplier_id || row.supplier_name}`;
      const existing = groups.get(key) || {
        ...row,
        display_key: `club-${key}`,
        quantity: 0,
        gross_total: 0,
        charges_total: 0,
        rebate_total: 0,
        net_total: 0,
        paid_total: 0,
        balance_total: 0,
        source_rows: [],
      };
      existing.source_rows.push(row);
      existing.gross_total += Number(row.gross_amount || 0) || purchaseItemBasic(row) + purchaseCharges(row);
      existing.charges_total += purchaseCharges(row);
      existing.rebate_total += Number(row.rebate_amount || 0);
      existing.net_total += Number(row.net_payable || row.item_net_payable || 0);
      existing.paid_total += Number(row.paid_amount || 0);
      existing.balance_total += Number(row.balance_amount || 0);
      groups.set(key, existing);
    }
    return [...groups.values()].map((group) => {
      const itemSummary = group.source_rows
        .slice(0, 3)
        .map((row) => `${row.product_name}${row.lot_name ? ` ${row.lot_name}` : ""} ${Number(row.quantity || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}${String(row.unit || "").toLowerCase()}`)
        .join(", ");
      const extraCount = Math.max(group.source_rows.length - 3, 0);
      const statuses = new Set(group.source_rows.map(purchaseStatusLabel));
      return {
        ...group,
        item_summary: `${itemSummary}${extraCount ? ` +${extraCount} more` : ""}`,
        item_narration: group.source_rows.map(purchaseItemNarration).join("\n"),
        status_label: statuses.size > 1 ? "Mixed" : [...statuses][0],
      };
    });
  })();
  const purchaseDateTotals = groupedPurchaseHistoryRows.reduce((totals, row) => {
    const date = toDateKey(row.purchase_date);
    const current = totals.get(date) || { net: 0, gross: 0 };
    current.net += row.status_label === "Cancelled" ? 0 : Number(row.net_total || 0);
    current.gross += row.status_label === "Cancelled" ? 0 : Number(row.gross_total || 0);
    totals.set(date, current);
    return totals;
  }, new Map());
  const purchaseNarrationDisplay = (row) => (
    purchasePrintNarration || purchasePrintNarrationRef.current ? row.item_narration : row.item_summary
  );
  const salesHistoryRawRows = Array.isArray(data.salesHistoryReport)
    ? data.salesHistoryReport
    : Array.isArray(data.salesHistoryReport?.rows)
      ? data.salesHistoryReport.rows
      : [];
  const saleItems = (row) => {
    if (Array.isArray(row.items)) return row.items;
    if (typeof row.items === "string") {
      try {
        const parsed = JSON.parse(row.items);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  };
  const saleStatusLabel = (row) => row.sale_status === "CANCELLED" ? "Cancelled" : row.sale_status === "EDITED" ? "Edited" : "Completed";
  const saleItemGross = (item) => Number(item.gross_amount ?? item.amount ?? 0) || Number(item.quantity || 0) * Number(item.selling_rate || 0);
  const saleItemDiscount = (item) => Number(item.discount_amount || 0);
  const saleItemNetBeforeInvoiceDiscount = (item) => Number(item.net_amount ?? (saleItemGross(item) - saleItemDiscount(item)));
  const saleLotLabel = (item) => item.lot_name || "No Lot Number";
  const officialWalkInCustomerName = "Walk-in Customer";
  const normalizeCustomerName = (value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "");
  const isWalkInSaleRow = (row) => {
    if (row.system_account === true || row.customer_system_account === true) return true;
    if (row.customer_id && String(row.customer_id) !== "1") return false;
    return ["", "1", normalizeCustomerName(officialWalkInCustomerName), "walkincust", "walkincustomer"].includes(normalizeCustomerName(row.customer_name));
  };
  const saleCustomerKey = (row) => isWalkInSaleRow(row) ? "WALK_IN" : String(row.customer_id || row.customer_account_id || row.customer_name || "UNKNOWN");
  const saleCustomerLabel = (row) => isWalkInSaleRow(row) ? officialWalkInCustomerName : (row.customer_name || "Unassigned Customer");
  const saleUserKey = (row) => String(row.created_by_user_id || row.created_by || row.user_id || row.sold_by_user_id || row.created_by_name || row.sold_by || "UNKNOWN");
  const saleUserLabel = (row) => row.created_by_name || row.sold_by || (saleUserKey(row) === "UNKNOWN" ? "Unknown User" : saleUserKey(row));
  const salePayments = (row) => {
    if (Array.isArray(row.payments) && row.payments.length) return row.payments;
    if (Array.isArray(row.payment_allocations) && row.payment_allocations.length) return row.payment_allocations;
    return [{ mode: row.payment_mode || "UNKNOWN", amount: Number(row.total_amount || row.net_total || 0) }];
  };
  const salePaymentAmount = (row, modes) => salePayments(row).reduce((sum, payment) => {
    const mode = String(payment.mode || payment.payment_mode || "").toUpperCase();
    return modes.has(mode) ? sum + Number(payment.amount || payment.payment_amount || 0) : sum;
  }, 0);
  const saleItemNarration = (item) => {
    const lot = item.lot_name || "No Lot Number";
    const qty = Number(item.quantity || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
    const unit = String(item.unit || "");
    const rate = Number(item.selling_rate || 0);
    return [
      `Item: ${item.product_name || "Item"}`,
      `Lot No: ${lot}`,
      `Qty: ${qty} ${unit}`.trim(),
      `Rate: ${money(rate)}`,
      `Amount: ${money(saleItemGross(item))}`,
    ].join("\n");
  };
  const normalizeSaleUnit = (unit) => String(unit || "UNIT").trim().toUpperCase() || "UNIT";
  const saleQuantityGroups = (items = []) => {
    const groups = new Map();
    for (const item of items) {
      const quantity = Number(item.quantity || 0);
      if (!quantity) continue;
      const unit = normalizeSaleUnit(item.unit);
      groups.set(unit, (groups.get(unit) || 0) + quantity);
    }
    return groups;
  };
  const formatSaleQuantityGroups = (groups) => {
    const entries = groups instanceof Map ? [...groups.entries()] : Object.entries(groups || {});
    if (!entries.length) return "-";
    return entries
      .sort(([unitA], [unitB]) => unitA.localeCompare(unitB))
      .map(([unit, quantity]) => {
        const numericQuantity = Number(quantity || 0);
        const quantityText = numericQuantity.toLocaleString("en-IN", Number.isInteger(numericQuantity)
          ? { maximumFractionDigits: 0 }
          : { minimumFractionDigits: 3, maximumFractionDigits: 3 });
        return `${quantityText} ${unit}`;
      })
      .join(" • ");
  };
  const saleQuantitySummary = (items = []) => formatSaleQuantityGroups(saleQuantityGroups(items));
  const combineSaleQuantityGroups = (rows = []) => {
    const groups = new Map();
    for (const row of rows) {
      const items = row.item_rows?.length
        ? row.item_rows
        : row.quantity !== undefined
          ? [row]
          : [];
      for (const item of items) {
        const quantity = Number(item.quantity || 0);
        if (!quantity) continue;
        const unit = normalizeSaleUnit(item.unit);
        groups.set(unit, (groups.get(unit) || 0) + quantity);
      }
    }
    return formatSaleQuantityGroups(groups);
  };
  const saleItemSearchText = (row, item) => [
    row.invoice_no,
    row.customer_name,
    row.customer_mobile,
    row.payment_mode,
    row.sale_status,
    toDateKey(row.sale_date),
    item.product_name,
    item.category,
    item.lot_name,
    item.lot_size,
    item.unit,
    item.quantity,
    item.selling_rate,
    saleItemGross(item),
    saleItemNetBeforeInvoiceDiscount(item),
  ].filter((value) => value !== undefined && value !== null).join(" ").toLowerCase();
  const saleHeaderSearchText = (row) => [
    row.invoice_no,
    row.customer_name,
    row.customer_mobile,
    row.payment_mode,
    row.sale_status,
    saleStatusLabel(row),
    toDateKey(row.sale_date),
    formatDisplayDate(row.sale_date),
    row.gross_amount,
    row.total_amount,
  ].filter((value) => value !== undefined && value !== null).join(" ").toLowerCase();
  const saleNarrationPreview = (items) => {
    const summary = items
      .slice(0, 2)
      .map((item) => `${item.product_name || "Item"}${item.lot_name ? ` ${item.lot_name}` : ""} ${Number(item.quantity || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}${String(item.unit || "").toLowerCase()}`)
      .join(", ");
    const extraCount = Math.max(items.length - 2, 0);
    return `${summary || "No item detail"}${extraCount ? ` +${extraCount} more` : ""}`;
  };
  const salesFilterOptions = salesHistoryRawRows.reduce((options, row) => {
    options.customers.set(saleCustomerKey(row), saleCustomerLabel(row));
    if (row.payment_mode) options.paymentModes.add(row.payment_mode);
    options.users.set(saleUserKey(row), saleUserLabel(row));
    for (const item of saleItems(row)) {
      if (item.product_id || item.product_name) options.products.set(String(item.product_id || item.product_name), item.product_name || "Item");
      const lotKey = String(item.inventory_batch_id || item.lot_name || "");
      if (lotKey) options.lots.set(lotKey, saleLotLabel(item));
    }
    return options;
  }, { customers: new Map(), products: new Map(), lots: new Map(), paymentModes: new Set(), users: new Map() });
  const filteredSalesHistoryRows = salesHistoryRawRows.filter((row) => {
    if (salesFilters.date && toDateKey(row.sale_date) !== salesFilters.date) return false;
    if (salesFilters.status === "CANCELLED") return row.sale_status === "CANCELLED";
    if (salesFilters.status === "EDITED") return row.sale_status === "EDITED";
    if (salesFilters.status === "ACTIVE") return row.sale_status !== "CANCELLED";
    return true;
  }).map((row) => {
    const allItems = saleItems(row);
    const selectorItems = allItems.filter((item) => {
      const customerKey = saleCustomerKey(row);
      if (salesFilters.customerMode === "WALK_IN" && customerKey !== "WALK_IN") return false;
      if (salesFilters.customerMode === "SINGLE" && salesFilters.customer && customerKey !== salesFilters.customer) return false;
      if (salesFilters.customerMode === "CUSTOM" && salesFilters.selectedCustomers.length > 0 && !salesFilters.selectedCustomers.includes(customerKey)) return false;
      if (salesFilters.product && String(item.product_id || item.product_name || "") !== salesFilters.product) return false;
      if (salesFilters.lot && String(item.inventory_batch_id || item.lot_name || "") !== salesFilters.lot) return false;
      if (salesFilters.paymentMode && row.payment_mode !== salesFilters.paymentMode) return false;
      const userKey = saleUserKey(row);
      if (salesFilters.userMode === "SINGLE" && salesFilters.user && userKey !== salesFilters.user) return false;
      if (salesFilters.userMode === "CUSTOM" && salesFilters.selectedUsers.length > 0 && !salesFilters.selectedUsers.includes(userKey)) return false;
      return true;
    });
    const hasSelectorFilter = Boolean(
      salesFilters.customerMode !== "ALL" ||
      salesFilters.userMode !== "ALL" ||
      salesFilters.product ||
      salesFilters.lot ||
      salesFilters.paymentMode
    );
    if (hasSelectorFilter && selectorItems.length === 0) return null;
    const searchText = search.trim().toLowerCase();
    if (!searchText) return { ...row, visible_items: selectorItems, all_items: allItems, showing_matched_only: false };
    const matchedItems = selectorItems.filter((item) => saleItemSearchText(row, item).includes(searchText));
    const headerMatches = saleHeaderSearchText(row).includes(searchText);
    if (matchedItems.length > 0) {
      return {
        ...row,
        visible_items: matchedItems,
        all_items: allItems,
        showing_matched_only: matchedItems.length < allItems.length || !headerMatches,
      };
    }
    if (headerMatches && selectorItems.length > 0) {
      return { ...row, visible_items: selectorItems, all_items: allItems, showing_matched_only: false };
    }
    return null;
  }).filter(Boolean);
  const salesHistoryRows = (() => {
    const buildItemRows = (row) => {
      const visibleItems = row.visible_items?.length ? row.visible_items : saleItems(row);
      const allItems = row.all_items?.length ? row.all_items : visibleItems;
      const invoiceDiscount = Number(row.invoice_discount_amount || 0);
      const allNetBeforeInvoiceDiscount = allItems.reduce((sum, item) => sum + saleItemNetBeforeInvoiceDiscount(item), 0);
      return visibleItems.map((item, index) => {
        const netBeforeInvoiceDiscount = saleItemNetBeforeInvoiceDiscount(item);
        const invoiceDiscountShare = allNetBeforeInvoiceDiscount ? invoiceDiscount * (netBeforeInvoiceDiscount / allNetBeforeInvoiceDiscount) : 0;
        return {
          ...row,
          sale_id: row.id,
          item_id: item.id,
          sale_item_id: item.sale_item_id || item.id,
          inventory_batch_id: item.inventory_batch_id,
          display_key: `sale-${row.id}-item-${item.id || index}-lot-${item.inventory_batch_id || "fifo"}-${index}`,
          item_name: item.product_name || "Item",
          lot_name: item.lot_name || "",
          lot_size: item.lot_size || "",
          category: item.category || "",
          quantity: Number(item.quantity || 0),
          unit: item.unit || "",
          rate: Number(item.selling_rate || 0),
          item_summary: saleItemNarration(item),
          item_narration: saleItemNarration(item),
          gross_total: saleItemGross(item),
          quantity_summary: saleQuantitySummary([item]),
          item_discount_total: saleItemDiscount(item),
          bill_discount_total: invoiceDiscountShare,
          discount_total: saleItemDiscount(item) + invoiceDiscountShare,
          net_total: netBeforeInvoiceDiscount - invoiceDiscountShare,
          cost_rate: Number(item.quantity || 0) ? Number(item.cost_amount || 0) / Number(item.quantity || 1) : 0,
          cost_amount: Number(item.cost_amount || 0),
          profit: Number(item.profit || 0),
          cost_status: item.cost_status,
          status_label: saleStatusLabel(row),
          manual_rate_override: Boolean(item.manual_rate_override),
          showing_matched_only: row.showing_matched_only,
          full_items: allItems,
        };
      });
    };
    if (salesFilters.viewMode === "CUSTOMER") {
      const groups = new Map();
      for (const row of filteredSalesHistoryRows) {
        const customerKey = saleCustomerKey(row);
        const itemRows = buildItemRows(row);
        const group = groups.get(customerKey) || {
          row_type: "CUSTOMER_GROUP",
          display_key: `customer-${customerKey}`,
          customer_key: customerKey,
          customer_name: saleCustomerLabel(row),
          invoices: new Set(),
          item_lines: 0,
          gross_total: 0,
          net_total: 0,
          cash_total: 0,
          upi_bank_total: 0,
          credit_total: 0,
          quantity_groups: new Map(),
          rows: [],
        };
        group.invoices.add(row.id);
        group.item_lines += itemRows.length;
        group.gross_total += Number(row.gross_total || row.total_amount || 0);
        group.net_total += Number(row.net_total || row.total_amount || 0);
        group.cash_total += salePaymentAmount(row, new Set(["CASH"]));
        group.upi_bank_total += salePaymentAmount(row, new Set(["UPI", "BANK", "BANK_TRANSFER"]));
        if (String(row.payment_mode || "").toUpperCase() === "CREDIT") {
          group.credit_total += Number(row.net_total || row.total_amount || 0);
        }
        for (const item of itemRows) {
          const unit = normalizeSaleUnit(item.unit);
          group.quantity_groups.set(unit, (group.quantity_groups.get(unit) || 0) + Number(item.quantity || 0));
        }
        group.rows.push(...itemRows.map((item, index) => ({
          ...item,
          row_type: "CUSTOMER_ITEM",
          display_key: `customer-item-${customerKey}-${item.display_key}`,
          customer_name: saleCustomerLabel(row),
          invoice_first_line: index === 0,
          invoice_item_count: itemRows.length,
        })));
        groups.set(customerKey, group);
      }
      return [...groups.values()].sort((left, right) => left.customer_name.localeCompare(right.customer_name)).flatMap((group) => [
        {
          ...group,
          invoice_count: group.invoices.size,
          quantity_summary: formatSaleQuantityGroups(group.quantity_groups),
        },
        ...group.rows,
      ]);
    }
    if (salesFilters.viewMode === "INVOICE" || clubSalesItems) {
      return filteredSalesHistoryRows.map((row) => {
        const items = row.visible_items?.length ? row.visible_items : saleItems(row);
        const itemRows = buildItemRows(row);
        return {
          ...row,
          sale_id: row.id,
          display_key: `sale-${row.id}`,
          item_summary: saleNarrationPreview(items),
          item_narration: items.map(saleItemNarration).join("\n") || "No item detail available",
          quantity_summary: saleQuantitySummary(items),
          gross_total: itemRows.reduce((sum, item) => sum + Number(item.gross_total || 0), 0),
          item_discount_total: itemRows.reduce((sum, item) => sum + Number(item.item_discount_total || 0), 0),
          bill_discount_total: itemRows.reduce((sum, item) => sum + Number(item.bill_discount_total || 0), 0),
          discount_total: itemRows.reduce((sum, item) => sum + Number(item.discount_total || 0), 0),
          net_total: itemRows.reduce((sum, item) => sum + Number(item.net_total || 0), 0),
          status_label: saleStatusLabel(row),
          manual_rate_override: items.some((item) => item.manual_rate_override),
          item_rows: itemRows,
          showing_matched_only: row.showing_matched_only,
        };
      });
    }
    return filteredSalesHistoryRows.flatMap(buildItemRows);
  })();
  const salesHasItemDiscount = salesHistoryRows.some((row) => row.row_type !== "CUSTOMER_GROUP" && Number(row.item_discount_total || 0) > 0);
  const salesHasBillDiscount = salesHistoryRows.some((row) => row.row_type !== "CUSTOMER_GROUP" && Number(row.bill_discount_total || 0) > 0);
  const salesHistoryHeaders = (() => {
    if (salesFilters.viewMode === "CUSTOMER") {
      return [
        "Date / Time",
        "Invoice",
        "Item Name",
        "Lot Number",
        "Quantity",
        "Unit",
        "Rate",
        ...(salesHasItemDiscount ? ["Item Discount"] : []),
        ...(salesHasBillDiscount ? ["Bill Discount"] : []),
        "Net Total",
        "Payment Mode",
        "Status",
      ];
    }
    if (salesFilters.viewMode === "INVOICE") {
      return [
        "Date",
        "Invoice",
        "Customer",
        "Item Summary",
        "Quantity",
        "Gross Total",
        ...(salesHasItemDiscount ? ["Item Discount"] : []),
        ...(salesHasBillDiscount ? ["Bill Discount"] : []),
        "Net Total",
        "Payment Mode",
        "Status",
      ];
    }
    return [
      "Date",
      "Invoice",
      "Customer",
      "Item Name",
      "Lot No.",
      "Quantity",
      "Unit",
      "Rate",
      "Gross Amount",
      ...(salesHasItemDiscount ? ["Item Discount"] : []),
      ...(salesHasBillDiscount ? ["Bill Discount"] : []),
      "Net Amount",
      "Payment Mode",
      "User",
    ];
  })();
  const salesNarrationDisplay = (row) => (
    salesPrintNarration || salesPrintNarrationRef.current ? row.item_narration : row.item_summary
  );
  const reports = {
    salesByDate: {
      title: "Sales by Date",
      rows: filterRows(data.salesReport),
      summary: (rows) => [["Sales", money(totalOf(rows, "total_sales")), true], ["Cash", money(totalOf(rows, "cash_sales"))], ["UPI", money(totalOf(rows, "upi_sales"))], ["Profit", money(totalOf(rows, "total_profit"))]],
      headers: ["Date", "Transactions", "Sales", "Cash", "UPI", "Bank/Card", "Cost", "Profit"],
      render: (row) => <tr key={row.sale_date}><td>{formatDisplayDate(row.sale_date)}</td><td>{row.transaction_count}</td><td>{money(row.total_sales)}</td><td>{money(row.cash_sales)}</td><td>{money(row.upi_sales)}</td><td>{money(row.bank_card_sales)}</td><td>{money(row.total_cost)}</td><td className="profit-cell">{money(row.total_profit)}</td></tr>,
    },
    salesByProduct: {
      title: "Sales by Product",
      rows: filterRows(data.salesProductReport),
      summary: (rows) => [["Revenue", money(totalOf(rows, "revenue")), true], ["Quantity Sold", number(totalOf(rows, "quantity_sold"))], ["Profit", money(totalOf(rows, "profit"))]],
      headers: ["Product", "Lot", "Quantity", "Rate", "Revenue", "Cost", "Profit"],
      render: (row) => <tr key={`${row.product_name}-${row.lot_name || "default"}-${row.lot_size || ""}`}><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{[row.lot_name, row.lot_size].filter(Boolean).join(" / ") || "-"}</td><td>{number(row.quantity_sold)}</td><td>{money(Number(row.quantity_sold || 0) ? Number(row.revenue || 0) / Number(row.quantity_sold || 1) : 0)}</td><td>{money(row.revenue)}</td><td>{money(row.cost)}</td><td className="profit-cell">{money(row.profit)}</td></tr>,
    },
    salesByCustomer: {
      title: "Sales by Customer",
      rows: filterRows(data.salesCustomerReport),
      summary: (rows) => [["Sales", money(totalOf(rows, "total_sales")), true], ["Invoices", number(totalOf(rows, "invoice_count"))], ["Profit", money(totalOf(rows, "total_profit"))]],
      headers: ["Customer", "Mobile", "Invoices", "Sales", "Profit"],
      render: (row) => <tr key={`${row.customer_name}-${row.customer_mobile}`}><td className="primary-cell">{row.customer_name}</td><td>{row.customer_mobile || "-"}</td><td>{row.invoice_count}</td><td>{money(row.total_sales)}</td><td className="profit-cell">{money(row.total_profit)}</td></tr>,
    },
    salesHistory: {
      title: "Sales History",
      rows: salesHistoryRows,
      summary: (rows) => {
        const activeRows = rows.filter((row) => row.row_type !== "CUSTOMER_GROUP" && row.status_label !== "Cancelled");
        const activeInvoices = filteredSalesHistoryRows.filter((row) => saleStatusLabel(row) !== "Cancelled");
        const invoiceCount = new Set(activeInvoices.map((row) => row.id)).size;
        const itemLineCount = activeRows.reduce((sum, row) => sum + (row.item_rows?.length || 1), 0);
        const totalCash = activeInvoices.reduce((sum, row) => sum + salePaymentAmount(row, new Set(["CASH"])), 0);
        const totalUpiBank = activeInvoices.reduce((sum, row) => sum + salePaymentAmount(row, new Set(["UPI", "BANK", "BANK_TRANSFER"])), 0);
        const grossTotal = activeInvoices.reduce((sum, row) => sum + Number(row.gross_total || row.total_amount || 0), 0);
        return [
          ["Total Quantity", combineSaleQuantityGroups(activeRows), true],
          ["Invoices", invoiceCount],
          ["Item Lines", number(itemLineCount)],
          ["Total Cash", money(totalCash)],
          ["Total UPI / Bank", money(totalUpiBank)],
          ["Gross Total", money(grossTotal)],
        ];
      },
      headers: salesHistoryHeaders,
      render: (row) => {
        const saleId = row.sale_id || row.id;
        const openInvoice = () => onOpenSaleView?.(saleId);
        if (row.row_type === "CUSTOMER_GROUP") {
          return (
            <tr className="date-total-row customer-sales-group-row" key={row.display_key}>
              <td colSpan={salesHistoryHeaders.length}>
                <div className="customer-sales-group-summary">
                  <strong>{row.customer_name}</strong>
                  <span>{row.invoice_count} invoice{row.invoice_count === 1 ? "" : "s"}</span>
                  <span>{row.item_lines} item line{row.item_lines === 1 ? "" : "s"}</span>
                  <span>{row.quantity_summary || "-"}</span>
                  <span>Gross {money(row.gross_total)}</span>
                  <span>Net {money(row.net_total)}</span>
                  <span>Cash {money(row.cash_total)}</span>
                  <span>UPI/Bank {money(row.upi_bank_total)}</span>
                  {Number(row.credit_total || 0) > 0 && <span>Credit {money(row.credit_total)}</span>}
                </div>
              </td>
            </tr>
          );
        }
        if (salesFilters.viewMode === "INVOICE") {
          const expanded = Boolean(expandedSalesRows[row.display_key]);
          return (
            <React.Fragment key={row.display_key}>
              <tr className={`report-row-clickable ${row.status_label === "Cancelled" ? "muted-row" : ""}`} onClick={openInvoice}>
                <td className="primary-cell date-cell">
                  {formatDisplayDate(row.sale_date)}
                </td>
                <td className="primary-cell">
                  {row.invoice_no || `#${row.sale_id}`}
                  {row.showing_matched_only && <small className="cell-note warning-note">Showing matched items only</small>}
                </td>
                <td className="primary-cell">
                  {row.customer_name || "Walk-in Customer"}
                  {row.customer_mobile && <small className="cell-note">{row.customer_mobile}</small>}
                </td>
                <td className="primary-cell purchase-items-cell sales-items-cell">
                  <span>{salesNarrationDisplay(row)}</span>
                  <small className="cell-note">{row.item_rows?.length || 0} item line{(row.item_rows?.length || 0) === 1 ? "" : "s"}</small>
                </td>
                <td className="status-cell">{row.quantity_summary || "-"}</td>
                <td className="amount-cell">{money(row.gross_total)}</td>
                {salesHasItemDiscount && <td className="amount-cell">{Number(row.item_discount_total || 0) ? money(row.item_discount_total) : "-"}</td>}
                {salesHasBillDiscount && <td className="amount-cell">{Number(row.bill_discount_total || 0) ? money(row.bill_discount_total) : "-"}</td>}
                <td className="amount-cell">{money(row.net_total)}</td>
                <td className="status-cell">{row.payment_mode || "-"}</td>
                <td className="status-cell">{row.status_label}</td>
              </tr>
              {expanded && (
                <tr className="sales-history-drilldown-row">
                  <td colSpan={salesHistoryHeaders.length}>
                    <DataTable headers={["Item", "Lot", "Qty", "Unit", "Rate", "Gross", ...(salesHasItemDiscount ? ["Item Disc."] : []), ...(salesHasBillDiscount ? ["Bill Disc."] : []), "Net", "Cost Rate", "Profit"]}>
                      {(row.item_rows || []).map((item) => (
                        <tr className="report-row-clickable" key={item.display_key} onClick={openInvoice}>
                          <td className="primary-cell">{item.item_name}</td>
                          <td>{item.lot_name || "No Lot Number"}</td>
                          <td>{number(item.quantity)}</td>
                          <td>{item.unit || "-"}</td>
                          <td>{money(item.rate)}</td>
                          <td>{money(item.gross_total)}</td>
                          {salesHasItemDiscount && <td>{Number(item.item_discount_total || 0) ? money(item.item_discount_total) : "-"}</td>}
                          {salesHasBillDiscount && <td>{Number(item.bill_discount_total || 0) ? money(item.bill_discount_total) : "-"}</td>}
                          <td>{money(item.net_total)}</td>
                          <td>{money(item.cost_rate)}</td>
                          <td className="profit-cell">{money(item.profit)}</td>
                        </tr>
                      ))}
                    </DataTable>
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        }
        return (
          <tr className={`report-row-clickable ${row.status_label === "Cancelled" ? "muted-row" : ""}`} key={row.display_key} onClick={openInvoice}>
            <td className="date-cell">{row.row_type === "CUSTOMER_ITEM" ? new Date(row.bill_datetime || row.created_at || row.sale_date).toLocaleString("en-IN", { dateStyle: "short", timeStyle: "short" }) : formatDisplayDate(row.sale_date)}</td>
            <td className="primary-cell">{row.invoice_no || `#${row.sale_id}`}{row.showing_matched_only && <small className="cell-note warning-note">Matched item</small>}</td>
            {salesFilters.viewMode !== "CUSTOMER" && <td className="primary-cell">{row.customer_name || "Walk-in Customer"}</td>}
            <td className="primary-cell">{row.item_name}</td>
            <td>{row.lot_name || "No Lot Number"}</td>
            <td>{number(row.quantity)}</td>
            <td>{row.unit || "-"}</td>
            <td>{money(row.rate)}</td>
            {salesFilters.viewMode !== "CUSTOMER" && <td className="amount-cell">{money(row.gross_total)}</td>}
            {salesHasItemDiscount && <td className="amount-cell">{Number(row.item_discount_total || 0) ? money(row.item_discount_total) : "-"}</td>}
            {salesHasBillDiscount && <td className="amount-cell">{row.row_type === "CUSTOMER_ITEM" && !row.invoice_first_line ? "-" : Number(row.bill_discount_total || 0) ? money(row.bill_discount_total) : "-"}</td>}
            <td className="amount-cell">{row.row_type === "CUSTOMER_ITEM" && !row.invoice_first_line ? "-" : money(row.net_total)}</td>
            <td className="status-cell">{row.row_type === "CUSTOMER_ITEM" && !row.invoice_first_line ? "-" : (row.payment_mode || "-")}</td>
            <td>{row.row_type === "CUSTOMER_ITEM" ? (row.invoice_first_line ? row.status_label : "-") : (row.created_by_name || row.sold_by || "-")}</td>
          </tr>
        );
      },
    },
    editedBills: {
      title: "Edited Bills",
      rows: editedBills,
      summary: (rows) => [["Edited Bills", rows.length, true], ["Total Amount", money(totalOf(rows, "total_amount"))]],
      headers: ["Invoice", "Date", "Amount", "Edited By", "Edited At", "Reason"],
      render: (row) => <tr key={row.id}><td>{row.invoice_no || `#${row.id}`}</td><td>{formatDisplayDate(row.sale_date)}</td><td>{money(row.total_amount)}</td><td>{row.changed_by_name || "-"}</td><td>{row.edited_at ? new Date(row.edited_at).toLocaleString("en-IN") : "-"}</td><td>{row.edit_reason || "-"}</td></tr>,
    },
    cancelledBills: {
      title: "Cancelled Bills",
      rows: cancelledBills,
      summary: (rows) => [["Cancelled Bills", rows.length, true], ["Cancelled Amount", money(totalOf(rows, "total_amount"))]],
      headers: ["Invoice", "Date", "Amount", "Cancelled By", "Cancelled At", "Reason"],
      render: (row) => <tr key={row.id}><td>{row.invoice_no || `#${row.id}`}</td><td>{formatDisplayDate(row.sale_date)}</td><td>{money(row.total_amount)}</td><td>{row.changed_by_name || "-"}</td><td>{row.cancelled_at ? new Date(row.cancelled_at).toLocaleString("en-IN") : "-"}</td><td>{row.cancellation_reason || "-"}</td></tr>,
    },
    provisionalProfitSales: {
      title: "Provisional Profit Sales",
      rows: filterRows(data.provisionalProfitSalesReport),
      summary: (rows) => [["Sales", money(totalOf(rows, "total_amount")), true], ["Provisional Profit", money(totalOf(rows, "profit"))], ["Invoices", rows.length]],
      headers: ["Invoice", "Date", "Customer", "Payment", "Products", "Amount", "Cost", "Provisional Profit"],
      render: (row) => <tr key={row.id}><td>{row.invoice_no}</td><td>{formatDisplayDate(row.sale_date)}</td><td>{row.customer_name}</td><td>{row.payment_mode}</td><td>{row.products || "-"}</td><td>{money(row.total_amount)}</td><td>{money(row.total_cost)}</td><td className="profit-cell">{money(row.profit)}</td></tr>,
    },
    discountReport: {
      title: "Discount Report",
      rows: filterRows(data.discountReport),
      summary: (rows) => [["Discount Amount", money(totalOf(rows, "discount_amount")), true], ["Gross Amount", money(totalOf(rows, "gross_amount"))], ["Net Amount", money(totalOf(rows, "net_amount"))], ["Profit Impact", money(totalOf(rows, "profit_impact"))]],
      headers: ["Date", "Product", "Lot", "Discount Type", "Discount Value", "Qty Sold", "Gross Amount", "Discount Amount", "Net Amount", "Profit Impact"],
      render: (row, index) => <tr key={`${row.sale_date}-${row.invoice_no}-${row.product_name}-${row.lot_name}-${index}`}><td>{formatDisplayDate(row.sale_date)}</td><td className="primary-cell">{row.product_name}<small className="cell-note">{row.invoice_no || row.payment_mode}</small></td><td>{row.lot_name || "-"}{row.lot_size ? ` / ${row.lot_size}` : ""}</td><td>{row.discount_type || "Bill / Manual"}</td><td>{row.discount_type === "PERCENTAGE" ? `${Number(row.discount_value || 0)}%` : money(row.discount_value)}</td><td>{number(row.quantity_sold)}</td><td>{money(row.gross_amount)}</td><td>{money(row.discount_amount)}</td><td>{money(row.net_amount)}</td><td>{money(row.profit_impact)}</td></tr>,
    },
    purchasesByDate: {
      title: "Purchases by Date",
      rows: filterRows(data.purchaseReport),
      summary: (rows) => [["Net Purchases", money(totalOf(rows, "net_purchase")), true], ["Paid", money(totalOf(rows, "paid_amount"))], ["Balance", money(totalOf(rows, "balance_amount"))]],
      headers: ["Date", "Bills", "Gross", "Rebate", "Net", "Paid", "Balance"],
      render: (row) => <tr key={row.purchase_date}><td>{row.purchase_date}</td><td>{row.purchase_count}</td><td>{money(row.gross_purchase)}</td><td>{money(row.rebate_received)}</td><td>{money(row.net_purchase)}</td><td>{money(row.paid_amount)}</td><td className="balance-cell">{money(row.balance_amount)}</td></tr>,
    },
    purchasesByProduct: {
      title: "Purchases by Product",
      rows: filterRows(data.purchaseProductReport),
      summary: (rows) => [["Net Purchases", money(totalOf(rows, "net_purchase")), true], ["Quantity", number(totalOf(rows, "quantity_purchased"))], ["Mandi Tax", money(totalOf(rows, "mandi_tax"))]],
      headers: ["Product", "Quantity", "Net Purchase", "Mandi Tax", "Rebate"],
      render: (row) => <tr key={row.product_name}><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{number(row.quantity_purchased)}</td><td>{money(row.net_purchase)}</td><td>{money(row.mandi_tax)}</td><td>{money(row.rebate)}</td></tr>,
    },
    purchasesBySupplier: {
      title: "Purchases by Supplier",
      rows: filterRows(data.purchaseSupplierReport),
      summary: (rows) => [["Net Purchases", money(totalOf(rows, "net_purchase")), true], ["Purchases", number(totalOf(rows, "purchase_count"))], ["Balance", money(totalOf(rows, "balance_amount"))]],
      headers: ["Supplier", "Bills", "Gross", "Rebate", "Net", "Paid", "Balance"],
      render: (row) => <tr key={row.supplier_name}><td className="primary-cell">{row.supplier_name}</td><td>{row.purchase_count}</td><td>{money(row.gross_purchase)}</td><td>{money(row.rebate_received)}</td><td>{money(row.net_purchase)}</td><td>{money(row.paid_amount)}</td><td className="balance-cell">{money(row.balance_amount)}</td></tr>,
    },
    purchaseOutstanding: {
      title: "Purchase Outstanding",
      rows: filterRows(data.supplierOutstandingReport),
      summary: (rows) => [["Outstanding", money(totalOf(rows, "outstanding_balance")), true], ["Purchases", money(totalOf(rows, "total_purchases"))], ["Paid", money(totalOf(rows, "total_paid"))]],
      headers: ["Supplier", "Purchases", "Paid", "Rebate", "Outstanding"],
      render: (row) => <tr key={row.id}><td className="primary-cell">{row.supplier_name}</td><td>{money(row.total_purchases)}</td><td>{money(row.total_paid)}</td><td>{money(row.total_rebate_received)}</td><td className="balance-cell">{money(row.outstanding_balance)}</td></tr>,
    },
    purchaseHistory: {
      title: "Purchase History",
      rows: groupedPurchaseHistoryRows,
      summary: (rows) => [
        ["Rows", rows.length, true],
        ["Gross Total", money(rows.filter((row) => row.status_label !== "Cancelled").reduce((sum, row) => sum + Number(row.gross_total || 0), 0))],
        ["Net Total", money(rows.filter((row) => row.status_label !== "Cancelled").reduce((sum, row) => sum + Number(row.net_total || 0), 0))],
        ["Balance", money(rows.filter((row) => row.status_label !== "Cancelled").reduce((sum, row) => sum + Number(row.balance_total || 0), 0))],
      ],
      headers: ["Date", "Supplier", "Narration", "Gross Total", "Net Total", "Status"],
      render: (row) => (
        <tr className="report-row-clickable" key={row.display_key} onClick={() => onOpenPurchaseAmendment?.(row.source_rows?.[0] || row)}>
          <td className="primary-cell date-cell">{formatDisplayDate(row.purchase_date)}</td>
          <td className="primary-cell">{row.supplier_name}{row.firm_name && <small className="cell-note">{row.firm_name}</small>}</td>
          <td className="primary-cell purchase-items-cell">
            <span title={row.item_narration}>{purchaseNarrationDisplay(row)}</span>
            <small className="cell-note">{clubPurchaseItems ? `${row.source_rows.length} item${row.source_rows.length === 1 ? "" : "s"}` : `${number(row.quantity)} ${row.unit || ""}`}</small>
          </td>
          <td className="amount-cell">{money(row.gross_total)}</td>
          <td className="amount-cell">{money(row.net_total)}</td>
          <td className="status-cell"><span className={row.status_label === "Cancelled" ? "stock-low" : row.status_label === "Pending Bill" ? "origin-rate" : "stock-ok"}>{row.status_label}</span></td>
        </tr>
      ),
    },
    purchaseEditCancel: {
      title: "Purchase Edit / Cancel Report",
      rows: purchaseChanges,
      summary: (rows) => [["Changed Purchases", rows.length, true], ["Cancelled", rows.filter((row) => row.purchase_status === "CANCELLED").length], ["Edited", rows.filter((row) => row.purchase_status === "EDITED").length]],
      headers: ["Purchase", "Date", "Supplier", "Status", "Amount", "Changed By", "Reason"],
      render: (row) => <tr key={row.id}><td>#{row.id}</td><td>{row.purchase_date}</td><td>{row.supplier_name}</td><td>{row.purchase_status}</td><td>{money(row.net_payable)}</td><td>{row.changed_by_name || "-"}</td><td>{row.cancellation_reason || row.edit_reason || "-"}</td></tr>,
    },
    pendingPurchaseBills: {
      title: "Pending Purchase Bills",
      rows: filterRows(data.pendingPurchaseBillsReport),
      summary: (rows) => [["Pending Bills", rows.length, true], ["Quantity", number(totalOf(rows, "quantity"))], ["Remaining", number(totalOf(rows, "remaining_qty"))]],
      headers: ["Purchase", "Date", "Supplier", "Product", "Qty", "Remaining", "Temp Sale Rate", "Expected Rate", "Remarks"],
      render: (row) => <tr key={row.id}><td>#{row.id}</td><td>{row.purchase_date}</td><td>{row.supplier_name}</td><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{number(row.quantity)}</td><td>{number(row.remaining_qty)}</td><td>{money(row.temporary_sale_rate)}</td><td>{money(row.expected_purchase_rate)}</td><td>{row.remarks || "-"}</td></tr>,
    },
    stockWithoutBill: {
      title: "Stock Received Without Bill",
      rows: filterRows(data.stockWithoutBillReport),
      summary: (rows) => [["Batches", rows.length, true], ["Received Qty", number(totalOf(rows, "purchase_qty"))], ["Remaining Qty", number(totalOf(rows, "remaining_qty"))]],
      headers: ["Arrival Date", "Batch", "Supplier", "Product", "Received", "Remaining", "Temp Sale Rate", "Expected Rate"],
      render: (row) => <tr key={row.id}><td>{row.arrival_date}</td><td><span className="batch-id">{row.batch_no}</span></td><td>{row.supplier_name}</td><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{number(row.purchase_qty)}</td><td>{number(row.remaining_qty)}</td><td>{money(row.temporary_sale_rate)}</td><td>{money(row.expected_purchase_rate)}</td></tr>,
    },
    customerLedger: {
      title: "Customer Ledger",
      rows: customerLedgerRows,
      summary: (rows) => [["Debits", money(totalOf(rows, "debit")), true], ["Credits", money(totalOf(rows, "credit"))], ["Rows", rows.length]],
      headers: ["Date", "Particulars / Narration", "Voucher Type", "Voucher No.", "Debit", "Credit", "Balance"],
      render: (row, index) => <tr key={`${row.date}-${index}`}><td>{formatDisplayDate(row.date)}</td><td className="primary-cell purchase-items-cell"><span title={row.narration || row.remarks}>{ledgerNarration(row)}</span><small className="cell-note">{row.party_name}</small></td><td>{row.voucher_type || row.transaction_type}</td><td>{row.voucher_no || "-"}</td><td>{money(row.debit)}</td><td>{money(row.credit)}</td><td className="balance-cell">{money(Math.abs(Number(row.running_balance || 0)))} {Number(row.running_balance || 0) >= 0 ? "Dr" : "Cr"}</td></tr>,
    },
    supplierLedger: {
      title: "Supplier Ledger",
      rows: supplierLedgerRows,
      summary: (rows) => [["Debits", money(totalOf(rows, "debit")), true], ["Credits", money(totalOf(rows, "credit"))], ["Rows", rows.length]],
      headers: ["Date", "Particulars / Narration", "Voucher Type", "Voucher No.", "Debit", "Credit", "Balance"],
      render: (row, index) => <tr key={`${row.date}-${index}`}><td>{formatDisplayDate(row.date)}</td><td className="primary-cell purchase-items-cell"><span title={row.narration || row.remarks}>{ledgerNarration(row)}</span><small className="cell-note">{row.party_name}</small></td><td>{row.voucher_type || row.transaction_type}</td><td>{row.voucher_no || "-"}</td><td>{money(row.debit)}</td><td>{money(row.credit)}</td><td className="balance-cell">{money(Math.abs(Number(row.running_balance || 0)))} {Number(row.running_balance || 0) >= 0 ? "Cr" : "Dr"}</td></tr>,
    },
    accountStatement: {
      title: "Account Statement",
      rows: accountStatementRows,
      summary: (rows) => [["Debits", money(totalOf(rows, "debit")), true], ["Credits", money(totalOf(rows, "credit"))], ["Rows", rows.length]],
      headers: ["Date", "Particulars / Narration", "Voucher Type", "Voucher No.", "Debit", "Credit", "Balance"],
      render: (row, index) => <tr key={`${row.date}-${index}`}><td>{formatDisplayDate(row.date)}</td><td className="primary-cell purchase-items-cell"><span title={row.narration || row.remarks}>{ledgerNarration(row)}</span><small className="cell-note">{row.party_name} - {row.account_type}</small></td><td>{row.voucher_type || row.transaction_type}</td><td>{row.voucher_no || "-"}</td><td>{money(row.debit)}</td><td>{money(row.credit)}</td><td className="balance-cell">{money(Math.abs(Number(row.running_balance || 0)))} {Number(row.running_balance || 0) >= 0 ? "Dr" : "Cr"}</td></tr>,
    },
    paymentReport: {
      title: "Payment Report",
      rows: filterRows(data.paymentReport),
      summary: (rows) => [["Payments", money(totalOf(rows, "payment_amount")), true], ["Rebates", money(totalOf(rows, "rebate_amount"))], ["Entries", rows.length]],
      headers: ["Date", "Type", "Party", "Payment", "Rebate", "Mode", "Status", "Reference"],
      render: (row, index) => <tr key={`${row.payment_date}-${index}`}><td>{row.payment_date}</td><td>{row.payment_type}</td><td className="primary-cell">{row.party_name}</td><td>{money(row.payment_amount)}</td><td>{money(row.rebate_amount)}</td><td>{row.payment_mode}</td><td>{row.cancelled ? "Cancelled" : "Active"}</td><td>{row.reference_number || "-"}</td></tr>,
    },
    paymentModeSummary: {
      title: "Payment Mode Summary",
      rows: filterRows(data.paymentModeSummary),
      summary: (rows) => [["Total Amount", money(totalOf(rows, "total_amount")), true], ["Transactions", number(totalOf(rows, "transaction_count"))], ["Modes", new Set(rows.map((row) => row.payment_mode)).size]],
      headers: ["Date", "Source", "Payment Mode", "Transactions", "Total Amount"],
      render: (row, index) => <tr key={`${row.transaction_date}-${row.source}-${row.payment_mode}-${index}`}><td>{formatDisplayDate(row.transaction_date)}</td><td>{row.source}</td><td><span className="tag">{row.payment_mode}</span></td><td>{row.transaction_count}</td><td className="primary-cell">{money(row.total_amount)}</td></tr>,
    },
    receivableReport: {
      title: "Receivable Report",
      rows: filterRows(data.customerOutstandingReport),
      summary: (rows) => [["Receivable", money(totalOf(rows, "outstanding_balance")), true], ["Sales", money(totalOf(rows, "total_sales"))], ["Paid", money(totalOf(rows, "total_paid"))]],
      headers: ["Customer", "Type", "Sales", "Paid", "Outstanding"],
      render: (row) => <tr key={row.id}><td className="primary-cell">{row.customer_name}</td><td>{row.customer_type}</td><td>{money(row.total_sales)}</td><td>{money(row.total_paid)}</td><td className="balance-cell">{money(row.outstanding_balance)}</td></tr>,
    },
    payableReport: {
      title: "Payable Report",
      rows: filterRows(data.supplierOutstandingReport),
      summary: (rows) => [["Payable", money(totalOf(rows, "outstanding_balance")), true], ["Purchases", money(totalOf(rows, "total_purchases"))], ["Paid", money(totalOf(rows, "total_paid"))]],
      headers: ["Supplier", "Purchases", "Paid", "Rebate", "Outstanding"],
      render: (row) => <tr key={row.id}><td className="primary-cell">{row.supplier_name}</td><td>{money(row.total_purchases)}</td><td>{money(row.total_paid)}</td><td>{money(row.total_rebate_received)}</td><td className="balance-cell">{money(row.outstanding_balance)}</td></tr>,
    },
    returnHistory: {
      title: "Sale Return History",
      rows: filterRows(data.returnHistoryReport),
      summary: (rows) => [["Return Value", money(totalOf(rows, "total_return_amount")), true], ["Returns", rows.length]],
      headers: ["Return No", "Date", "Invoice", "Customer", "Refund", "Value", "Reason", "Items"],
      render: (row) => <tr key={row.return_no}><td>{row.return_no}</td><td>{row.return_date}</td><td>{row.invoice_no || "-"}</td><td>{row.customer_name}</td><td>{row.refund_type}</td><td>{money(row.total_return_amount)}</td><td>{row.return_reason}</td><td>{row.items || "-"}</td></tr>,
    },
    returnValue: {
      title: "Return Value Report",
      rows: filterRows(data.returnReport),
      summary: (rows) => [["Return Value", money(totalOf(rows, "return_value")), true], ["Return Quantity", number(totalOf(rows, "return_quantity"))], ["Returns", number(totalOf(rows, "return_count"))]],
      headers: ["Date", "Returns", "Return Quantity", "Return Value"],
      render: (row) => <tr key={row.return_date}><td>{row.return_date}</td><td>{row.return_count}</td><td>{number(row.return_quantity)}</td><td>{money(row.return_value)}</td></tr>,
    },
    returnReason: {
      title: "Return Reason Analysis",
      rows: filterRows(data.returnReasonReport),
      summary: (rows) => [["Return Value", money(totalOf(rows, "return_value")), true], ["Returns", number(totalOf(rows, "return_count"))]],
      headers: ["Reason", "Returns", "Return Value"],
      render: (row) => <tr key={row.return_reason}><td className="primary-cell">{row.return_reason}</td><td>{row.return_count}</td><td>{money(row.return_value)}</td></tr>,
    },
    dailyWaste: {
      title: "Daily Waste",
      rows: filterRows(data.wasteReport),
      summary: (rows) => [["Waste Cost", money(totalOf(rows, "waste_cost")), true], ["Waste Quantity", number(totalOf(rows, "waste_quantity"))], ["Entries", number(totalOf(rows, "entry_count"))]],
      headers: ["Date", "Type", "Entries", "Quantity", "Cost"],
      render: (row) => <tr key={`${row.waste_date}-${row.waste_type}`}><td>{row.waste_date}</td><td>{row.waste_type}</td><td>{row.entry_count}</td><td>{number(row.waste_quantity)}</td><td>{money(row.waste_cost)}</td></tr>,
    },
    monthlyWaste: {
      title: "Monthly Waste",
      rows: filterRows(data.wasteReport),
      summary: (rows) => [["Waste Cost", money(totalOf(rows, "waste_cost")), true], ["Waste Quantity", number(totalOf(rows, "waste_quantity"))], ["Entries", number(totalOf(rows, "entry_count"))]],
      headers: ["Date", "Type", "Entries", "Quantity", "Cost"],
      render: (row) => <tr key={`${row.waste_date}-${row.waste_type}`}><td>{row.waste_date}</td><td>{row.waste_type}</td><td>{row.entry_count}</td><td>{number(row.waste_quantity)}</td><td>{money(row.waste_cost)}</td></tr>,
    },
    productWiseWaste: {
      title: "Product Wise Waste",
      rows: wasteProductRows,
      summary: (rows) => [["Waste Cost", money(totalOf(rows, "waste_cost")), true], ["Waste Quantity", number(totalOf(rows, "waste_quantity"))], ["Products", rows.length]],
      headers: ["Product", "Quantity", "Cost"],
      render: (row) => <tr key={row.product_name}><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{number(row.waste_quantity)}</td><td>{money(row.waste_cost)}</td></tr>,
    },
    mostWastedProducts: {
      title: "Most Wasted Products",
      rows: wasteProductRows.slice(0, 10),
      summary: (rows) => [["Waste Cost", money(totalOf(rows, "waste_cost")), true], ["Waste Quantity", number(totalOf(rows, "waste_quantity"))], ["Products", rows.length]],
      headers: ["Product", "Quantity", "Cost"],
      render: (row) => <tr key={row.product_name}><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{number(row.waste_quantity)}</td><td>{money(row.waste_cost)}</td></tr>,
    },
    wasteCost: {
      title: "Waste Cost Report",
      rows: filterRows(data.wasteReport),
      summary: (rows) => [["Waste Cost", money(totalOf(rows, "waste_cost")), true], ["Waste Quantity", number(totalOf(rows, "waste_quantity"))]],
      headers: ["Date", "Type", "Quantity", "Cost"],
      render: (row) => <tr key={`${row.waste_date}-${row.waste_type}`}><td>{row.waste_date}</td><td>{row.waste_type}</td><td>{number(row.waste_quantity)}</td><td>{money(row.waste_cost)}</td></tr>,
    },
    stockInventory: {
      title: "Stock Inventory",
      rows: stockLotRows,
      summary: () => [],
      headers: [],
      render: () => null,
    },
    currentStock: {
      title: "Current Stock",
      rows: stockRows,
      summary: (rows) => [["Stock Value", money(totalOf(rows, "stock_value")), true], ["Products", rows.length], ["Low Stock", lowStockRows.length]],
      headers: ["Product", "Category", "Stock", "Minimum", "Unit", "Value"],
      render: (row) => <tr key={row.product_id}><td className="primary-cell">{row.product_name}</td><td>{row.category}</td><td>{number(row.current_stock)}</td><td>{row.minimum_stock || 0}</td><td>{row.unit}</td><td>{money(row.stock_value)}</td></tr>,
    },
    lowStock: {
      title: "Low Stock",
      rows: lowStockRows,
      summary: (rows) => [["Low Stock Items", rows.length, true], ["Stock Value", money(totalOf(rows, "stock_value"))]],
      headers: ["Product", "Category", "Stock", "Minimum", "Unit", "Value"],
      render: (row) => <tr key={row.product_id}><td className="primary-cell">{row.product_name}</td><td>{row.category}</td><td className="stock-low">{number(row.current_stock)}</td><td>{row.minimum_stock || 0}</td><td>{row.unit}</td><td>{money(row.stock_value)}</td></tr>,
    },
    stockMovement: {
      title: "Stock Movement",
      rows: filterRows(data.stockMovementReport),
      summary: (rows) => [["Quantity", number(totalOf(rows, "quantity")), true], ["Movements", number(totalOf(rows, "movement_count"))]],
      headers: ["Date", "Product", "Type", "Quantity", "Count", "Remarks"],
      render: (row, index) => <tr key={`${row.movement_date}-${row.product_name}-${row.transaction_type}-${index}`}><td>{row.movement_date}</td><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{row.transaction_type}</td><td>{number(row.quantity)}</td><td>{row.movement_count}</td><td>{row.remarks || "-"}</td></tr>,
    },
    stockValuation: {
      title: "Stock Valuation",
      rows: stockRows,
      summary: (rows) => [["Stock Value", money(totalOf(rows, "stock_value")), true], ["Products", rows.length]],
      headers: ["Product", "Stock", "Unit", "Value"],
      render: (row) => <tr key={row.product_id}><td className="primary-cell">{row.product_name}</td><td>{number(row.current_stock)}</td><td>{row.unit}</td><td>{money(row.stock_value)}</td></tr>,
    },
    lotWiseStock: {
      title: "Lot Wise Stock",
      rows: stockLotRows,
      summary: (rows) => [["Lot Stock Value", money(rows.reduce((sum, row) => sum + Number(row.remaining_qty || 0) * Number(row.effective_cost_per_unit || row.purchase_rate || 0), 0)), true], ["Lots", rows.length], ["Categories", new Set(rows.map((row) => row.category || "Fruit")).size]],
      headers: ["Category", "Item", "Lot / Size", "Source", "Supplier", "Received", "Balance", "Cost", "Value", "Status"],
      render: (row) => {
        const status = String(row.batch_status || "ACTIVE").toUpperCase();
        const balance = Number(row.remaining_qty ?? row.balance_qty ?? 0);
        const statusLabel = status === "CANCELLED" ? "Cancelled" : status === "INACTIVE" ? "Inactive" : balance <= 0 ? "Sold Out" : "Active";
        return <tr key={row.id}><td>{row.category || "Fruit"}</td><td className="primary-cell">{row.product_name}<small className="cell-note">{row.unit}</small></td><td>{row.lot_name || row.batch_no}{row.lot_size ? ` / ${row.lot_size}` : ""}</td><td><span className="tag">{row.stock_source || "PURCHASE"}</span></td><td>{row.supplier_name || "-"}</td><td>{number(row.purchase_qty)}</td><td>{number(row.remaining_qty)}</td><td>{money(row.effective_cost_per_unit || row.purchase_rate)}</td><td>{money(Number(row.remaining_qty || 0) * Number(row.effective_cost_per_unit || row.purchase_rate || 0))}</td><td><span className={statusLabel === "Active" ? "stock-ok" : statusLabel === "Sold Out" ? "origin-rate" : "stock-low"}>{statusLabel}</span></td></tr>;
      },
    },
    profitLoss: {
      title: "Profit & Loss",
      rows: [
        { section: "Income", particular: "Sales Revenue", amount: Number(data.profitLoss?.salesRevenue || 0), emphasis: true },
        { section: "Income", particular: "Other Income", amount: 0 },
        { section: "Cost of Goods Sold", particular: "Purchase Cost", amount: -Number(data.profitLoss?.purchaseCost || 0) },
        { section: "Cost of Goods Sold", particular: "Mandi Tax", amount: -Number(data.profitLoss?.mandiTax || 0) },
        { section: "Cost of Goods Sold", particular: "Freight", amount: -Number(data.profitLoss?.freightCharges || 0) },
        { section: "Cost of Goods Sold", particular: "Labour", amount: -Number(data.profitLoss?.labourCharges || 0) },
        { section: "Cost of Goods Sold", particular: "Other Purchase Charges", amount: -Number(data.profitLoss?.otherPurchaseCharges || 0) },
        { section: "Cost of Goods Sold", particular: "Less Supplier Rebate Received", amount: Number(data.profitLoss?.supplierRebateReceived || 0) },
        { section: "Result", particular: "Gross Profit", amount: Number(data.profitLoss?.grossProfit || 0), emphasis: true },
        ...(Array.isArray(data.profitLoss?.expenseCategories) ? data.profitLoss.expenseCategories : []).map((row) => ({ section: "Expenses", particular: row.category, amount: -Number(row.amount || 0) })),
        { section: "Result", particular: Number(data.profitLoss?.netProfit || 0) < 0 ? "Net Loss" : "Net Profit", amount: Number(data.profitLoss?.netProfit || 0), emphasis: true },
      ].filter(matchesSearch),
      summary: () => [
        ["Sales Revenue", money(data.profitLoss?.salesRevenue), true],
        ["Gross Profit", money(data.profitLoss?.grossProfit)],
        ["Total Expenses", money(data.profitLoss?.expenses)],
        [Number(data.profitLoss?.netProfit || 0) < 0 ? "Net Loss" : "Net Profit", money(Math.abs(Number(data.profitLoss?.netProfit || 0)))],
      ],
      headers: ["Section", "Particulars", "Amount"],
      render: (row, index) => <tr className={row.emphasis ? "date-total-row" : ""} key={`${row.section}-${row.particular}-${index}`}><td>{row.section}</td><td className="primary-cell">{row.particular}</td><td className={row.amount < 0 ? "stock-low" : "profit-cell"}>{money(Math.abs(row.amount))}{row.amount < 0 ? " Dr" : ""}</td></tr>,
    },
    balanceSheet: {
      title: "Balance Sheet",
      rows: [
        { liability: "Capital / Owner Equity", liabilityKey: "owner_equity", liabilityAmount: Number(data.balanceSheet?.ownerCapital || 0), asset: "Cash in Hand", assetKey: "cash_in_hand", assetAmount: Number(data.balanceSheet?.cash || 0) },
        { liability: Number(data.balanceSheet?.netProfit || 0) < 0 ? "Net Loss" : "Net Profit", liabilityKey: "net_profit", liabilityAmount: Number(data.balanceSheet?.netProfit || 0), asset: "Cash at Bank / Bank Balance", assetKey: "cash_at_bank", assetAmount: Number(data.balanceSheet?.bank || 0) },
        { liability: "Supplier Payables / Trade Creditors", liabilityKey: "supplier_payables", liabilityAmount: Number(data.balanceSheet?.supplierPayable || 0), asset: "Inventory / Closing Stock", assetKey: "inventory", assetAmount: Number(data.balanceSheet?.inventory || 0) },
        { liability: "Loans / Credit Balances", liabilityKey: "loans", liabilityAmount: 0, asset: "Customer Receivables / Sundry Debtors", assetKey: "customer_receivables", assetAmount: Number(data.balanceSheet?.customerReceivable || 0) },
        { liability: "Other Liabilities", liabilityKey: "other_liabilities", liabilityAmount: 0, asset: "Other Assets", assetKey: "other_assets", assetAmount: 0 },
        { liability: "Total Liabilities", liabilityAmount: Number(data.balanceSheet?.totalLiabilities || 0), asset: "Total Assets", assetAmount: Number(data.balanceSheet?.totalAssets || 0), total: true },
      ].filter(matchesSearch),
      summary: () => [["Total Assets", money(data.balanceSheet?.totalAssets), true], ["Total Liabilities", money(data.balanceSheet?.totalLiabilities)], ["Inventory", money(data.balanceSheet?.inventory)]],
      headers: ["Liabilities", "Amount", "Assets", "Amount"],
      render: (row, index) => <tr className={row.total ? "date-total-row" : ""} key={`${row.liability}-${index}`}>
        <td className="primary-cell">{row.total ? row.liability : <button className="table-link-button" onClick={() => openBalanceSheetDetail(row.liabilityKey)}>{row.liability}</button>}</td>
        <td>{money(row.liabilityAmount)}</td>
        <td className="primary-cell">{row.total ? row.asset : <button className="table-link-button" onClick={() => openBalanceSheetDetail(row.assetKey)}>{row.asset}</button>}</td>
        <td>{money(row.assetAmount)}</td>
      </tr>,
    },
    cashBook: {
      title: "Cash Book",
      rows: cashBookRows,
      summary: () => [
        ["Opening Cash", money(cashBookOpeningCash), true],
        ["Opening Bank", money(cashBookOpeningBank), true],
        ["Cash Receipts", money(cashBookReceiptsCash)],
        ["Bank Receipts", money(cashBookReceiptsBank)],
        ["Cash Payments", money(cashBookPaymentsCash)],
        ["Bank Payments", money(cashBookPaymentsBank)],
        ["Closing Cash", money(cashBookClosingCash), true],
        ["Closing Bank", money(cashBookClosingBank), true],
        ["Total Closing", money(cashBookData.total_closing), true],
      ],
      headers: ["Date", "Particulars / Account", "Narration", "Receipt Cash", "Receipt Bank/UPI/Card", "Payment Cash", "Payment Bank/UPI/Card", "Cash Balance", "Bank Balance", "Total Balance", "Reference / Bill No"],
      render: (row, index) => <tr className="report-row-clickable" onClick={() => setCashBookDetail(row)} key={`${row.date}-${row.reference_no}-${index}`}><td className="date-cell">{formatDisplayDate(row.date)}</td><td className="primary-cell">{row.account_name || row.party_name}</td><td className="purchase-items-cell"><span title={row.narration}>{row.narration || "-"}</span></td><td className="amount-cell">{money(row.receipt_cash)}</td><td className="amount-cell">{money(row.receipt_bank)}</td><td className="amount-cell">{money(row.payment_cash)}</td><td className="amount-cell">{money(row.payment_bank)}</td><td className="amount-cell">{money(row.cash_balance)}</td><td className="amount-cell">{money(row.bank_balance)}</td><td className="profit-cell amount-cell">{money(row.total_balance)}</td><td>{row.reference_no || "-"}</td></tr>,
    },
    expenseReport: {
      title: "Expense Report",
      rows: filterRows(data.expenseReport),
      summary: (rows) => [["Total Expenses", money(totalOf(rows.filter((row) => row.status !== "CANCELLED"), "amount")), true], ["Cash", money(totalOf(rows.filter((row) => row.payment_mode === "CASH" && row.status !== "CANCELLED"), "amount"))], ["UPI", money(totalOf(rows.filter((row) => row.payment_mode === "UPI" && row.status !== "CANCELLED"), "amount"))], ["Cancelled", money(totalOf(rows.filter((row) => row.status === "CANCELLED"), "amount"))]],
      headers: ["Date", "Category", "Paid To", "Payment Mode", "Amount", "Reference", "Remarks", "Status"],
      render: (row) => <tr className={row.status === "CANCELLED" ? "muted-row" : ""} key={row.id}><td>{formatDisplayDate(row.expense_date)}</td><td className="primary-cell">{row.category}</td><td>{row.paid_to || row.vendor_name || "-"}</td><td>{row.payment_mode}</td><td>{money(row.amount)}</td><td>{row.reference_number || "-"}</td><td>{row.remarks || row.cancellation_reason || "-"}</td><td><span className={row.status === "CANCELLED" ? "stock-low" : "stock-ok"}>{row.status || "ACTIVE"}</span></td></tr>,
    },
  };
  const categories = [
    { id: "sales", title: "Sales Reports", icon: "receipt", description: "Unified sales history with item narration, discounts, payments and bill status.", reports: ["salesHistory", "discountReport"] },
    { id: "purchase", title: "Purchase Reports", icon: "cart", description: "Unified purchase history with item narration, bill status, payments and amendment actions.", reports: ["purchaseHistory"] },
    { id: "accounts", title: "Accounts & Ledger", icon: "users", description: "Customer ledger, supplier ledger, statements, payments and balances.", reports: ["customerLedger", "supplierLedger", "accountStatement", "paymentReport", "paymentModeSummary", "receivableReport", "payableReport"] },
    { id: "returns", title: "Sale Returns", icon: "history", description: "Return history, value and reason analysis.", reports: ["returnHistory", "returnValue", "returnReason"] },
    { id: "waste", title: "Waste Management", icon: "alert", description: "Daily, monthly, product-wise and cost-focused waste analysis.", reports: ["dailyWaste", "monthlyWaste", "productWiseWaste", "mostWastedProducts", "wasteCost"] },
    { id: "inventory", title: "Inventory Reports", icon: "layers", description: "Single stock inventory workspace for stock, lots, valuation, adjustments and audit.", reports: ["stockInventory"] },
    { id: "financial", title: "Financial Reports", icon: "wallet", description: "Profit and loss, balance sheet, cash book and expense reports.", reports: ["profitLoss", "balanceSheet", "cashBook", "expenseReport"] },
  ];
  const currentCategory = categories.find((category) => category.id === selectedCategory);
  const currentReport = reports[selectedReport];
  const profitLossLine = (label, value, options = {}) => {
    const numericValue = Number(value || 0);
    const amountClass = numericValue < 0 ? "pl-negative" : options.positive ? "pl-positive" : "";
    const formattedAmount = numericValue < 0 ? `(${money(Math.abs(numericValue))})` : money(numericValue);
    return (
      <div className={`pl-line ${options.indent ? "pl-line-indent" : ""} ${options.total ? "pl-line-total" : ""} ${options.highlight ? "pl-line-highlight" : ""}`} key={label}>
        <span>{label}</span>
        <strong className={amountClass}>{formattedAmount}</strong>
      </div>
    );
  };
  const renderProfitLossStatement = () => {
    const pl = data.profitLoss || {};
    const amount = (field) => Number(pl[field] || 0);
    const salesRevenue = amount("salesRevenue");
    const otherIncome = amount("otherIncome");
    const totalIncome = salesRevenue + otherIncome;
    const purchaseCost = amount("purchaseCost");
    const mandiTax = amount("mandiTax");
    const freightCharges = amount("freightCharges");
    const labourCharges = amount("labourCharges");
    const otherPurchaseCharges = amount("otherPurchaseCharges");
    const supplierRebateReceived = amount("supplierRebateReceived");
    const cogs = Number(pl.costOfGoodsSold ?? (purchaseCost + mandiTax + freightCharges + labourCharges + otherPurchaseCharges - supplierRebateReceived));
    const grossProfit = Number(pl.grossProfit ?? (totalIncome - cogs));
    const totalExpenses = amount("expenses");
    const netProfit = Number(pl.netProfit ?? (grossProfit - totalExpenses));
    const expenseCategories = Array.isArray(pl.expenseCategories) ? pl.expenseCategories : [];
    const knownExpenseLabels = [
      ["Rent", ["rent"]],
      ["Staff Salary", ["staff salary", "salary", "wages"]],
      ["Electricity", ["electricity", "power"]],
      ["Transport", ["transport", "transportation"]],
      ["Loading / Hamali", ["loading", "hamali", "labour"]],
      ["Packing", ["packing", "packaging"]],
      ["Repair", ["repair", "maintenance"]],
      ["Food / Tea / Misc", ["food", "tea", "misc"]],
    ];
    const matchedExpenseIndexes = new Set();
    const expenseRows = knownExpenseLabels.map(([label, needles]) => {
      const total = expenseCategories.reduce((sum, row, index) => {
        const category = String(row.category || "").toLowerCase();
        if (needles.some((needle) => category.includes(needle))) {
          matchedExpenseIndexes.add(index);
          return sum + Number(row.amount || 0);
        }
        return sum;
      }, 0);
      return { category: label, amount: total };
    }).filter((row) => row.amount > 0);
    const otherExpenses = expenseCategories.reduce((sum, row, index) => matchedExpenseIndexes.has(index) ? sum : sum + Number(row.amount || 0), 0);
    if (otherExpenses > 0) {
      expenseRows.push({ category: "Other Expenses", amount: otherExpenses });
    }
    const hasTransactions = [salesRevenue, otherIncome, purchaseCost, mandiTax, freightCharges, labourCharges, otherPurchaseCharges, supplierRebateReceived, totalExpenses].some((value) => Math.abs(Number(value || 0)) > 0);
    const periodFrom = data.dateFrom || customRange.date_from || "-";
    const periodTo = data.dateTo || customRange.date_to || "-";
    return (
      <div className="profit-loss-statement">
        <div className="pl-title-block">
          <span>Financial Report</span>
          <h2>PROFIT &amp; LOSS STATEMENT</h2>
          <p>For Period: {periodFrom} to {periodTo}</p>
        </div>
        {!hasTransactions && <div className="pl-empty-note">No transactions found for selected period.</div>}
        <section className="pl-section">
          <h3>INCOME</h3>
          {profitLossLine("Sales Revenue", salesRevenue, { indent: true })}
          {profitLossLine("Other Income", otherIncome, { indent: true })}
          {profitLossLine("TOTAL INCOME", totalIncome, { total: true })}
        </section>
        <section className="pl-section">
          <h3>LESS: COST OF GOODS SOLD</h3>
          {profitLossLine("Purchase Cost", purchaseCost, { indent: true })}
          {profitLossLine("Mandi Tax", mandiTax, { indent: true })}
          {profitLossLine("Freight", freightCharges, { indent: true })}
          {profitLossLine("Labour", labourCharges, { indent: true })}
          {profitLossLine("Other Purchase Charges", otherPurchaseCharges, { indent: true })}
          {profitLossLine("Less Supplier Rebate Received", -supplierRebateReceived, { indent: true })}
          {profitLossLine("TOTAL COGS", cogs, { total: true })}
        </section>
        <section className="pl-section pl-result-section">
          {profitLossLine("GROSS PROFIT", grossProfit, { highlight: true, positive: grossProfit >= 0 })}
        </section>
        <section className="pl-section">
          <h3>LESS: EXPENSES</h3>
          {expenseRows.length > 0 ? expenseRows.map((row) => profitLossLine(row.category, row.amount, { indent: true })) : <div className="pl-empty-note">No expenses recorded for this period.</div>}
          {profitLossLine("TOTAL EXPENSES", totalExpenses, { total: true })}
        </section>
        <section className={`pl-section pl-net-section ${netProfit >= 0 ? "pl-net-profit" : "pl-net-loss"}`}>
          {profitLossLine(netProfit >= 0 ? "NET PROFIT" : "NET LOSS", netProfit, { highlight: true, positive: netProfit >= 0 })}
        </section>
      </div>
    );
  };
  const renderFilters = () => (
    <div className={selectedReport === "purchaseHistory" ? "ledger-toolbar purchase-history-toolbar" : "ledger-toolbar"}>
      <Field label="Report Range">
        <select value={range} onChange={(event) => setRange(event.target.value)}>
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="week">This Week</option>
          <option value="month">This Month</option>
          <option value="custom">Custom Date Range</option>
        </select>
      </Field>
      {range === "custom" && (
        <>
          <Field label="Date From"><input type="date" value={customRange.date_from} onChange={(event) => setCustomRange({ ...customRange, date_from: event.target.value })} /></Field>
          <Field label="Date To"><input type="date" value={customRange.date_to} onChange={(event) => setCustomRange({ ...customRange, date_to: event.target.value })} /></Field>
        </>
      )}
      <Field label="Search / Filter"><input placeholder="Search this report" value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
      {["customerLedger", "supplierLedger", "accountStatement"].includes(selectedReport) && (
        <>
          <Field label="Account Type">
            <select value={accountReportFilters.accountType} onChange={(event) => setAccountReportFilters({ ...accountReportFilters, accountType: event.target.value })}>
              <option value="">All account types</option>
              <option value="CUSTOMER">Customer</option>
              <option value="SUPPLIER">Supplier</option>
              <option value="CASH">Cash</option>
              <option value="BANK">Bank</option>
              <option value="EXPENSE">Expense</option>
              <option value="INCOME">Income</option>
              <option value="INVENTORY">Inventory</option>
              <option value="CAPITAL">Capital</option>
              <option value="LIABILITY">Liability</option>
              <option value="ASSET">Asset</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
          <Field label="Account">
            <select value={accountReportFilters.accountName} onChange={(event) => setAccountReportFilters({ ...accountReportFilters, accountName: event.target.value })}>
              <option value="">All accounts</option>
              {accountNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </Field>
          <Field label="Voucher Type">
            <select value={accountReportFilters.voucherType} onChange={(event) => setAccountReportFilters({ ...accountReportFilters, voucherType: event.target.value })}>
              <option value="">All vouchers</option>
              {voucherTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </Field>
          <Field label="Payment Mode">
            <select value={accountReportFilters.paymentMode} onChange={(event) => setAccountReportFilters({ ...accountReportFilters, paymentMode: event.target.value })}>
              <option value="">All modes</option>
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="CARD">Card</option>
              <option value="BANK_TRANSFER">Bank Transfer</option>
              <option value="CREDIT">Credit</option>
              <option value="OTHER">Other</option>
              <option value="CHEQUE">Cheque</option>
            </select>
          </Field>
          <label className="check-field report-check-field">
            <input checked={clubLedgerEntries} type="checkbox" onChange={(event) => setClubLedgerEntries(event.target.checked)} />
            <span>Club Entries</span>
          </label>
          <button className="secondary-button" onClick={clearLedgerFilters}>Clear Ledger Filters</button>
        </>
      )}
      {selectedReport === "cashBook" && (
        <>
          <Field label="Book Account">
            <select value={cashBookFilters.bookAccount} onChange={(event) => {
              const next = { ...cashBookFilters, bookAccount: event.target.value, paymentMode: "" };
              setCashBookFilters(next);
              reloadCashBook(next);
            }}>
              <option value="ALL">All Cash + Bank</option>
              <option value="CASH">Cash</option>
              <option value="BANK">All Bank / UPI / Card</option>
              <option value="UPI">UPI</option>
              <option value="CARD">Card</option>
              <option value="BANK_TRANSFER">Bank Transfer</option>
            </select>
          </Field>
          <Field label="Payment Mode">
            <select value={cashBookFilters.paymentMode} onChange={(event) => {
              const next = { ...cashBookFilters, paymentMode: event.target.value };
              setCashBookFilters(next);
              reloadCashBook(next);
            }} disabled={["UPI", "CARD", "BANK_TRANSFER"].includes(cashBookFilters.bookAccount)}>
              <option value="">All modes</option>
              {cashBookFilters.bookAccount === "CASH" ? <option value="CASH">Cash</option> : cashBookFilters.bookAccount === "ALL" ? (
                <>
                  <option value="CASH">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="CARD">Card</option>
                  <option value="BANK_TRANSFER">Bank Transfer</option>
                </>
              ) : (
                <>
                  <option value="UPI">UPI</option>
                  <option value="CARD">Card</option>
                  <option value="BANK_TRANSFER">Bank Transfer</option>
                </>
              )}
            </select>
          </Field>
          <Field label="Account / Party">
            <select value={cashBookFilters.accountFilter} onChange={(event) => {
              const next = { ...cashBookFilters, accountFilter: event.target.value };
              setCashBookFilters(next);
              reloadCashBook(next);
            }}>
              <option value="">All accounts</option>
              <option value="CUSTOMER">Customer</option>
              <option value="SUPPLIER">Supplier</option>
              <option value="EXPENSE">Expense</option>
              <option value="EMPLOYEE">Employee</option>
              <option value="OWNER">Owner</option>
            </select>
          </Field>
          <Field label="View Mode">
            <select value={cashBookViewMode} onChange={(event) => setCashBookViewMode(event.target.value)}>
              <option value="SUMMARY">Account Summary</option>
              <option value="ENTRY">Entry-wise</option>
            </select>
          </Field>
          <Field label="Group By">
            <select value={cashBookGroupBy} onChange={(event) => setCashBookGroupBy(event.target.value)}>
              <option value="PERIOD">Entire Selected Period</option>
              <option value="DATE">Date-wise</option>
              <option value="MONTH">Month-wise</option>
            </select>
          </Field>
          <label className="check-field report-check-field">
            <input checked={showCashBookRemarks} type="checkbox" onChange={(event) => setShowCashBookRemarks(event.target.checked)} />
            <span>Show Entry Wise Remarks</span>
          </label>
          <button className="secondary-button" onClick={() => {
            const next = { paymentMode: "", accountFilter: "", bookAccount: "ALL" };
            setCashBookFilters(next);
            setCashBookViewMode("SUMMARY");
            setCashBookGroupBy("PERIOD");
            reloadCashBook(next);
          }}>Clear Cash Book Filters</button>
        </>
      )}
      {selectedReport === "lotWiseStock" && (
        <Field label="Lot Visibility">
          <select value={inventoryLotReportFilter} onChange={(event) => setInventoryLotReportFilter(event.target.value)}>
            <option value="ACTIVE">Active Stock Only</option>
            <option value="SOLD_OUT">Include Sold Out Lots</option>
            <option value="ALL">Include Cancelled/Inactive Lots</option>
          </select>
        </Field>
      )}
      {selectedReport === "salesHistory" && (
        <>
          <Field label="View Mode">
            <select value={salesFilters.viewMode} onChange={(event) => setSalesFilters({ ...salesFilters, viewMode: event.target.value })}>
              <option value="INVOICE">Invoice-wise</option>
              <option value="CUSTOMER">Customer-wise</option>
              <option value="ITEM">Item-wise</option>
              <option value="LOT">Lot-wise</option>
            </select>
          </Field>
          <Field label="Exact Date">
            <input type="date" value={salesFilters.date} onChange={(event) => setSalesFilters({ ...salesFilters, date: event.target.value })} />
          </Field>
          <Field label="Customer">
            <select value={salesFilters.customerMode} onChange={(event) => setSalesFilters({ ...salesFilters, customerMode: event.target.value, customer: "", selectedCustomers: [] })}>
              <option value="ALL">All Customers</option>
              <option value="WALK_IN">Walk-in Customer</option>
              <option value="SINGLE">Single Registered Customer</option>
              <option value="CUSTOM">Custom Customer Selection</option>
            </select>
          </Field>
          {salesFilters.customerMode === "SINGLE" && (
            <Field label="Select Customer">
              <select value={salesFilters.customer} onChange={(event) => setSalesFilters({ ...salesFilters, customer: event.target.value })}>
                <option value="">Choose customer</option>
                {[...salesFilterOptions.customers.entries()].filter(([key]) => key !== "WALK_IN").map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </Field>
          )}
          {salesFilters.customerMode === "CUSTOM" && (
            <Field label="Customers">
              <select multiple size="3" value={salesFilters.selectedCustomers} onChange={(event) => setSalesFilters({ ...salesFilters, selectedCustomers: [...event.target.selectedOptions].map((option) => option.value) })}>
                {[...salesFilterOptions.customers.entries()].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </Field>
          )}
          <Field label="User">
            <select value={salesFilters.userMode} onChange={(event) => setSalesFilters({ ...salesFilters, userMode: event.target.value, user: "", selectedUsers: [] })}>
              <option value="ALL">All Users</option>
              <option value="SINGLE">Single User</option>
              <option value="CUSTOM">Custom Selection</option>
            </select>
          </Field>
          {salesFilters.userMode === "SINGLE" && (
            <Field label="Select User">
              <select value={salesFilters.user} onChange={(event) => setSalesFilters({ ...salesFilters, user: event.target.value })}>
                <option value="">Choose user</option>
                {[...salesFilterOptions.users.entries()].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </Field>
          )}
          {salesFilters.userMode === "CUSTOM" && (
            <Field label="Users">
              <select multiple size="3" value={salesFilters.selectedUsers} onChange={(event) => setSalesFilters({ ...salesFilters, selectedUsers: [...event.target.selectedOptions].map((option) => option.value) })}>
                {[...salesFilterOptions.users.entries()].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </Field>
          )}
          <Field label="Product">
            <select value={salesFilters.product} onChange={(event) => setSalesFilters({ ...salesFilters, product: event.target.value })}>
              <option value="">All products</option>
              {[...salesFilterOptions.products.entries()].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </Field>
          <Field label="Lot">
            <select value={salesFilters.lot} onChange={(event) => setSalesFilters({ ...salesFilters, lot: event.target.value })}>
              <option value="">All lots</option>
              {[...salesFilterOptions.lots.entries()].map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </Field>
          <Field label="Payment Mode">
            <select value={salesFilters.paymentMode} onChange={(event) => setSalesFilters({ ...salesFilters, paymentMode: event.target.value })}>
              <option value="">All modes</option>
              {[...salesFilterOptions.paymentModes].sort().map((mode) => <option key={mode} value={mode}>{mode}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={salesFilters.status} onChange={(event) => setSalesFilters({ ...salesFilters, status: event.target.value })}>
              <option value="ACTIVE">Active Bills</option>
              <option value="ALL">All Bills</option>
              <option value="EDITED">Edited</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </Field>
          <label className="check-field report-check-field">
            <input checked={search.trim().length > 0} readOnly type="checkbox" />
            <span>{search.trim() ? "Showing matched items only where applicable" : "Item-level search ready"}</span>
          </label>
          <button className="secondary-button" onClick={() => setSalesFilters({ date: "", status: "ACTIVE", viewMode: "INVOICE", customerMode: "ALL", customer: "", selectedCustomers: [], product: "", lot: "", paymentMode: "", userMode: "ALL", user: "", selectedUsers: [] })}>Clear Sales Filters</button>
        </>
      )}
      {selectedReport === "purchaseHistory" && (
        <>
          <Field label="Supplier">
            <select value={purchaseFilters.supplier} onChange={(event) => setPurchaseFilters({ ...purchaseFilters, supplier: event.target.value })}>
              <option value="">All suppliers</option>
              {purchaseSuppliers.map((row) => <option key={row.supplier_id || row.supplier_name} value={row.supplier_id || ""}>{row.supplier_name}{row.firm_name ? ` - ${row.firm_name}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Product">
            <select value={purchaseFilters.product} onChange={(event) => setPurchaseFilters({ ...purchaseFilters, product: event.target.value })}>
              <option value="">All products</option>
              {purchaseProducts.map((row) => <option key={row.product_id || row.product_name} value={row.product_id || ""}>{row.product_name}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={purchaseFilters.status} onChange={(event) => setPurchaseFilters({ ...purchaseFilters, status: event.target.value })}>
              <option value="ACTIVE">Active Bills</option>
              <option value="BILL_COMPLETED">Completed Bill</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </Field>
          <Field label="Payment Type">
            <select value={purchaseFilters.paymentType} onChange={(event) => setPurchaseFilters({ ...purchaseFilters, paymentType: event.target.value })}>
              <option value="">All payment types</option>
              <option value="CASH">Cash</option>
              <option value="CREDIT">Credit</option>
              <option value="PENDING_BILL">Pending Bill</option>
            </select>
          </Field>
          <Field label="Exact Date">
            <input type="date" value={purchaseFilters.date} onChange={(event) => setPurchaseFilters({ ...purchaseFilters, date: event.target.value })} />
          </Field>
          <label className="check-field report-check-field">
            <input checked={clubPurchaseItems} type="checkbox" onChange={(event) => setClubPurchaseItems(event.target.checked)} />
            <span>Club Items</span>
          </label>
          <button className="secondary-button" onClick={() => setPurchaseFilters({ supplier: "", product: "", status: "ACTIVE", paymentType: "", date: "" })}>Clear Purchase Filters</button>
        </>
      )}
      <button className="secondary-button" onClick={refreshReports}>Refresh</button>
    </div>
  );
  const balanceDetailColumnValue = (row, column) => {
    const keyMap = {
      Date: "transaction_date",
      "Voucher Type": "voucher_type",
      "Voucher No": "voucher_no",
      Party: "party_name",
      "Payment Mode": "payment_mode",
      Debit: "debit",
      Credit: "credit",
      Balance: "balance",
      Narration: "narration",
      Product: "product_name",
      Lot: "lot",
      Size: "lot_size",
      Qty: "quantity",
      Cost: "cost_rate",
      Value: "value",
      Supplier: "supplier_name",
      Opening: "opening_balance",
      Purchases: "purchases",
      Payments: "payments",
      Rebates: "rebates",
      Customer: "customer_name",
      "Credit Sales": "credit_sales",
      Receipts: "receipts",
      Returns: "returns",
      Particular: "particular",
      Amount: "amount",
    };
    const key = keyMap[column] || column.toLowerCase().replace(/\s+/g, "_");
    const value = row?.[key];
    if (["Debit", "Credit", "Balance", "Cost", "Value", "Opening", "Purchases", "Payments", "Rebates", "Credit Sales", "Receipts", "Returns", "Amount"].includes(column)) {
      return money(value);
    }
    if (column === "Date") return formatDisplayDate(value);
    if (column === "Qty") return number(value);
    return value || "-";
  };
  const renderBalanceSheetDetailModal = () => {
    if (!balanceSheetDetail && !balanceSheetDetailLoading && !balanceSheetDetailError) return null;
    const columns = Array.isArray(balanceSheetDetail?.columns) ? balanceSheetDetail.columns : ["Particular", "Amount"];
    const rows = Array.isArray(balanceSheetDetail?.rows) ? balanceSheetDetail.rows : [];
    return (
      <div className="modal-backdrop">
        <section className="invoice-modal change-history-modal balance-detail-modal">
          <div className="invoice-modal-header">
            <div>
              <span className="eyebrow">Balance Sheet Drilldown</span>
              <h2>{balanceSheetDetail?.title || "Loading Detail"}</h2>
              <p>{balanceSheetDetail ? `${formatDisplayDate(balanceSheetDetail.dateFrom)} to ${formatDisplayDate(balanceSheetDetail.dateTo)} | Closing as at ${formatDisplayDate(balanceSheetDetail.asAtDate || balanceSheetDetail.dateTo)}` : "Fetching source transactions..."}</p>
            </div>
            <button className="secondary-button" onClick={() => { setBalanceSheetDetail(null); setBalanceSheetDetailError(""); }}>Close</button>
          </div>
          {balanceSheetDetailLoading && <div className="cart-empty">Loading balance sheet detail...</div>}
          {balanceSheetDetailError && <div className="error-banner">{balanceSheetDetailError}</div>}
          {balanceSheetDetail && (
            <>
              <div className="purchase-summary-grid supplier-payment-preview">
                {[
                  ["Opening Balance", balanceSheetDetail.openingBalance],
                  ["Debit During Range", balanceSheetDetail.debitDuringRange],
                  ["Credit During Range", balanceSheetDetail.creditDuringRange],
                  ["Closing Balance", balanceSheetDetail.closingBalance ?? balanceSheetDetail.amount],
                ].map(([label, value], index) => <SummaryMetric featured={index === 3} key={label} label={label} value={money(value)} />)}
              </div>
              {Array.isArray(balanceSheetDetail.breakdown) && balanceSheetDetail.breakdown.length > 0 && (
                <div className="balance-detail-breakdown">
                  {balanceSheetDetail.breakdown.map((item) => <span key={item.label}>{item.label}: <strong>{money(item.value)}</strong></span>)}
                </div>
              )}
              <DataTable headers={columns}>
                {rows.map((row, index) => (
                  <tr key={`${balanceSheetDetail.lineKey}-${index}`}>
                    {columns.map((column) => <td key={column}>{balanceDetailColumnValue(row, column)}</td>)}
                  </tr>
                ))}
              </DataTable>
              {rows.length === 0 && <div className="cart-empty">No source transactions found for this line.</div>}
            </>
          )}
        </section>
      </div>
    );
  };
  const renderCashBookDetailModal = () => {
    if (!cashBookDetail) return null;
    const sourceRows = cashBookDetail.source_rows || [cashBookDetail];
    const totalReceiptCash = sourceRows.reduce((sum, row) => sum + Number(row.receipt_cash || 0), 0);
    const totalReceiptBank = sourceRows.reduce((sum, row) => sum + Number(row.receipt_bank || 0), 0);
    const totalPaymentCash = sourceRows.reduce((sum, row) => sum + Number(row.payment_cash || 0), 0);
    const totalPaymentBank = sourceRows.reduce((sum, row) => sum + Number(row.payment_bank || 0), 0);
    return (
      <div className="modal-backdrop">
        <section className="invoice-modal change-history-modal">
          <div className="invoice-modal-header">
            <div>
              <span className="eyebrow">Cash Book Detail</span>
              <h2>{cashBookDetail.account_name || cashBookDetail.source_type || "Cash / Bank Movement"}</h2>
              <p>{cashBookDetail.group_label || formatDisplayDate(cashBookDetail.date)} | {sourceRows.length} entr{sourceRows.length === 1 ? "y" : "ies"}</p>
            </div>
            <button className="secondary-button" onClick={() => setCashBookDetail(null)}>Close</button>
          </div>
          <div className="purchase-summary-grid supplier-payment-preview">
            <SummaryMetric label="Receipt Cash" value={money(totalReceiptCash)} />
            <SummaryMetric label="Receipt Bank" value={money(totalReceiptBank)} />
            <SummaryMetric label="Payment Cash" value={money(totalPaymentCash)} />
            <SummaryMetric featured label="Payment Bank" value={money(totalPaymentBank)} />
          </div>
          <DataTable headers={["Date & Time", "Voucher / Invoice", "Type", "Party", "Mode", "Cash", "Bank", "Remarks", "Created By", "Source"]}>
            {sourceRows.map((row, index) => (
              <tr key={`${row.source_type}-${row.source_id}-${index}`}>
                <td>{formatDisplayDate(row.date)}<small className="cell-note">{row.entry_time ? new Date(row.entry_time).toLocaleTimeString("en-IN") : ""}</small></td>
                <td className="primary-cell">{row.reference_no || "-"}</td>
                <td>{row.source_type || "-"}</td>
                <td>{row.party_name || row.account_name || "-"}</td>
                <td>{row.payment_mode || "-"}</td>
                <td className="amount-cell">{money(Number(row.receipt_cash || 0) || Number(row.payment_cash || 0))}</td>
                <td className="amount-cell">{money(Number(row.receipt_bank || 0) || Number(row.payment_bank || 0))}</td>
                <td className="purchase-items-cell">{row.narration || "-"}</td>
                <td>{row.created_by_name || "-"}</td>
                <td>{row.source_type || "-"}</td>
              </tr>
            ))}
          </DataTable>
        </section>
      </div>
    );
  };
  const renderCashBookStatement = () => {
    const cashBookPeriodLabel = (row) => {
      const key = toDateKey(row.date);
      if (cashBookGroupBy === "DATE") return key;
      if (cashBookGroupBy === "MONTH") return key.slice(0, 7);
      return "Selected Period";
    };
    const cashBookGroupLabel = (row) => {
      const key = cashBookPeriodLabel(row);
      if (cashBookGroupBy === "DATE") return formatDisplayDate(key);
      if (cashBookGroupBy === "MONTH") {
        const [year, month] = key.split("-");
        return `${month}/${year}`;
      }
      return `${formatDisplayDate(cashBookData.dateFrom || data.dateFrom)} to ${formatDisplayDate(cashBookData.dateTo || data.dateTo)}`;
    };
    const groupCashBookRows = (rows) => {
      if (cashBookViewMode === "ENTRY") {
        return rows.map((row) => ({ ...row, source_rows: [row], group_label: cashBookGroupLabel(row), ledger_folio: row.reference_no || "-" }));
      }
      return [...rows.reduce((groups, row) => {
        const side = Number(row.receipt_cash || 0) || Number(row.receipt_bank || 0) ? "RECEIPT" : "PAYMENT";
        const periodKey = cashBookPeriodLabel(row);
        const key = [periodKey, side, row.account_type || "", row.account_name || row.party_name || "", row.mode_group || ""].join("|");
        const current = groups.get(key) || {
          date: cashBookGroupBy === "PERIOD" ? (cashBookData.dateFrom || data.dateFrom) : periodKey,
          account_name: row.account_name || row.party_name || "-",
          account_type: row.account_type,
          party_name: row.party_name,
          mode_group: row.mode_group,
          group_label: cashBookGroupLabel(row),
          payment_mode: "Multiple",
          reference_no: "—",
          ledger_folio: "—",
          source_type: side === "RECEIPT" ? "Account Summary Receipt" : "Account Summary Payment",
          receipt_cash: 0,
          receipt_bank: 0,
          payment_cash: 0,
          payment_bank: 0,
          source_rows: [],
        };
        current.receipt_cash += Number(row.receipt_cash || 0);
        current.receipt_bank += Number(row.receipt_bank || 0);
        current.payment_cash += Number(row.payment_cash || 0);
        current.payment_bank += Number(row.payment_bank || 0);
        current.source_rows.push(row);
        groups.set(key, current);
        return groups;
      }, new Map()).values()];
    };
    const displayRows = groupCashBookRows(cashBookRows);
    const receiptRows = displayRows.filter((row) => Number(row.receipt_cash || 0) + Number(row.receipt_bank || 0) > 0);
    const paymentRows = displayRows.filter((row) => Number(row.payment_cash || 0) + Number(row.payment_bank || 0) > 0);
    const receiptSideCashTotal = cashBookOpeningCash + cashBookReceiptsCash;
    const receiptSideBankTotal = cashBookOpeningBank + cashBookReceiptsBank;
    const paymentSideCashTotal = cashBookPaymentsCash + cashBookClosingCash;
    const paymentSideBankTotal = cashBookPaymentsBank + cashBookClosingBank;
    const renderBookRow = (row, side) => (
      <tr className="report-row-clickable" key={`${side}-${row.group_label}-${row.account_name}-${row.mode_group || ""}-${row.source_id || row.reference_no}`} onClick={() => setCashBookDetail(row)}>
        <td className="date-cell">{cashBookViewMode === "ENTRY" ? formatDisplayDate(row.date) : row.group_label}</td>
        <td className="primary-cell">
          {side === "RECEIPT" ? "To " : "By "}{row.account_name || row.party_name || "-"} A/c
          {cashBookViewMode === "ENTRY" && showCashBookRemarks && <small className="cell-note">{row.narration || "-"}</small>}
          {cashBookViewMode === "SUMMARY" && <small className="cell-note">{row.source_rows.length} entr{row.source_rows.length === 1 ? "y" : "ies"}</small>}
        </td>
        <td className="status-cell">{row.ledger_folio || "—"}</td>
        <td className="balance-cell amount-cell">{money(side === "RECEIPT" ? row.receipt_cash : row.payment_cash)}</td>
        <td className="balance-cell amount-cell">{money(side === "RECEIPT" ? row.receipt_bank : row.payment_bank)}</td>
      </tr>
    );
    return (
      <section className="cash-book-statement">
        <div className="pl-title-block cash-book-title">
          <span>Traditional Double-Sided Format</span>
          <h2>CASH BOOK</h2>
          <p>{cashBookAccountLabel} | {cashBookViewMode === "SUMMARY" ? "Account Summary" : "Entry-wise"} | {cashBookGroupBy === "PERIOD" ? "Entire Selected Period" : cashBookGroupBy === "DATE" ? "Date-wise" : "Month-wise"} | {formatDisplayDate(cashBookData.dateFrom || data.dateFrom)} to {formatDisplayDate(cashBookData.dateTo || data.dateTo)}</p>
        </div>
        {(cashBookClosingCash < 0 || cashBookClosingBank < 0) && (
          <div className="cash-book-warning">
            Cash or bank balance is negative. Please verify opening balance and entries.
          </div>
        )}
        <div className="cash-book-sides">
          <section className="cash-book-panel">
            <h3><span>Dr.</span> Receipts / Money Coming In</h3>
            <DataTable headers={["Date", "Particulars", "L.F.", "Cash (₹)", "Bank (₹)"]}>
              <tr className="date-total-row">
                <td>{formatDisplayDate(cashBookData.dateFrom || data.dateFrom)}</td>
                <td className="primary-cell">To Balance b/d</td>
                <td className="status-cell">—</td>
                <td className="balance-cell amount-cell">{money(cashBookOpeningCash)}</td>
                <td className="balance-cell amount-cell">{money(cashBookOpeningBank)}</td>
              </tr>
              {receiptRows.map((row) => renderBookRow(row, "RECEIPT"))}
              {receiptRows.length === 0 && <tr><td colSpan="5" className="empty-cell">No receipts found for this range.</td></tr>}
              <tr className="date-total-row">
                <td colSpan="3">Total Dr. Side</td>
                <td className="balance-cell amount-cell">{money(receiptSideCashTotal)}</td>
                <td className="balance-cell amount-cell">{money(receiptSideBankTotal)}</td>
              </tr>
            </DataTable>
          </section>
          <section className="cash-book-panel">
            <h3><span>Cr.</span> Payments / Money Going Out</h3>
            <DataTable headers={["Date", "Particulars", "L.F.", "Cash (₹)", "Bank (₹)"]}>
              {paymentRows.map((row) => renderBookRow(row, "PAYMENT"))}
              {paymentRows.length === 0 && <tr><td colSpan="5" className="empty-cell">No payments found for this range.</td></tr>}
              <tr className="date-total-row">
                <td>{formatDisplayDate(cashBookData.dateTo || data.dateTo)}</td>
                <td className="primary-cell">By Balance c/d</td>
                <td className="status-cell">—</td>
                <td className="balance-cell amount-cell">{money(cashBookClosingCash)}</td>
                <td className="balance-cell amount-cell">{money(cashBookClosingBank)}</td>
              </tr>
              <tr className="date-total-row">
                <td colSpan="3">Total Cr. Side</td>
                <td className="balance-cell amount-cell">{money(paymentSideCashTotal)}</td>
                <td className="balance-cell amount-cell">{money(paymentSideBankTotal)}</td>
              </tr>
            </DataTable>
          </section>
        </div>
        <div className="cash-book-closing">
          <span>Total Cash Receipts: <strong>{money(cashBookReceiptsCash)}</strong></span>
          <span>Total Bank Receipts: <strong>{money(cashBookReceiptsBank)}</strong></span>
          <span>Total Cash Payments: <strong>{money(cashBookPaymentsCash)}</strong></span>
          <span>Total Bank Payments: <strong>{money(cashBookPaymentsBank)}</strong></span>
          <span>Closing Cash: <strong>{money(cashBookClosingCash)}</strong></span>
          <span>Closing Bank: <strong>{money(cashBookClosingBank)}</strong></span>
          <span>Total Cash + Bank: <strong>{money(cashBookData.total_closing)}</strong></span>
        </div>
      </section>
    );
  };
  if (currentReport) {
    const rows = currentReport.rows || [];
    const handleReportPrintOption = () => {
      if (selectedReport === "purchaseHistory") {
        const includeNarration = window.confirm("Print narration/details?");
        purchasePrintNarrationRef.current = includeNarration;
        setPurchasePrintNarration(includeNarration);
      }
      if (selectedReport === "salesHistory") {
        const includeNarration = window.confirm("Print narration/details?");
        salesPrintNarrationRef.current = includeNarration;
        setSalesPrintNarration(includeNarration);
      }
      if (["customerLedger", "supplierLedger", "accountStatement"].includes(selectedReport)) {
        const includeNarration = window.confirm("Print narration/details also?");
        ledgerPrintNarrationRef.current = includeNarration;
        setLedgerPrintNarration(includeNarration);
      }
      return true;
    };
    const renderPurchaseHistoryRows = () => {
      const renderedRows = [];
      rows.forEach((row, index) => {
        const date = toDateKey(row.purchase_date);
        const nextDate = rows[index + 1] ? toDateKey(rows[index + 1].purchase_date) : "";
        renderedRows.push(currentReport.render(row, index));
        if (date !== nextDate) {
          const total = purchaseDateTotals.get(date) || { net: 0, gross: 0 };
          renderedRows.push(
            <tr className="date-total-row" key={`date-total-${date}`}>
              <td colSpan="3">Net Purchase Total for {formatDisplayDate(date)}</td>
              <td>{money(total.gross)}</td>
              <td className="balance-cell">{money(total.net)}</td>
              <td>Cancelled excluded</td>
            </tr>
          );
        }
      });
      return renderedRows;
    };
    const reportFileName = (() => {
      const from = formatFileDate(data.dateFrom || customRange.date_from);
      const to = formatFileDate(data.dateTo || customRange.date_to);
      const title = safeFileName(currentReport.title);
      if (selectedReport === "balanceSheet") return `Balance_Sheet_As_At_${to}.pdf`;
      if (selectedReport === "cashBook") {
        const mode = cashBookFilters.bookAccount || cashBookFilters.paymentMode || "All";
        return `${mode === "BANK" ? "Bank_Book" : "Cash_Book"}_${cashBookFilters.paymentMode || mode}_${from}_to_${to}.pdf`;
      }
      return `${title}_${from}_to_${to}.pdf`;
    })();
    const reportFilterSummary = (() => {
      const parts = [];
      if (data.dateFrom || data.dateTo || customRange.date_from || customRange.date_to) {
        parts.push(`Range: ${formatDisplayDate(data.dateFrom || customRange.date_from)} to ${formatDisplayDate(data.dateTo || customRange.date_to)}`);
      }
      if (search.trim()) parts.push(`Search: ${search.trim()}`);
      if (selectedReport === "salesHistory") {
        parts.push(`View: ${salesFilters.viewMode === "CUSTOMER" ? "Customer-wise" : salesFilters.viewMode === "INVOICE" ? "Invoice-wise" : salesFilters.viewMode === "LOT" ? "Lot-wise" : "Item-wise"}`);
        parts.push(`Status: ${salesFilters.status}`);
        if (salesFilters.customerMode !== "ALL") parts.push(`Customer: ${salesFilters.customerMode.replaceAll("_", " ")}`);
        if (salesFilters.userMode !== "ALL") parts.push(`Users: ${salesFilters.userMode.replaceAll("_", " ")}`);
        if (salesFilters.paymentMode) parts.push(`Payment: ${salesFilters.paymentMode}`);
        if (salesFilters.product) parts.push(`Product filter active`);
        if (salesFilters.lot) parts.push(`Lot filter active`);
      }
      return parts;
    })();
    return (
      <>
        <section className="settings-layout">
          <ModuleCard eyebrow="Report View" title={currentReport.title} subtitle="Single report workspace with filters, summary, print and export controls.">
            <div className="button-row">
              <button className="secondary-button" onClick={() => setSelectedReport("")}>Back to {currentCategory?.title || "Report List"}</button>
              <button className="secondary-button" onClick={() => { setSelectedReport(""); setSelectedCategory(""); }}>Back to Report Center</button>
              {selectedReport === "purchaseHistory" && <button className="primary-button" onClick={onOpenBlankPurchaseAmendment}>Add/Edit Purchase</button>}
            </div>
            {renderFilters()}
          </ModuleCard>
          <ModuleCard eyebrow={currentCategory?.title || "Reports"} title={currentReport.title} subtitle={`${rows.length} row${rows.length === 1 ? "" : "s"} found.`}>
            <PrintableReport
              beforePdfExport={handleReportPrintOption}
              beforePrint={handleReportPrintOption}
              fileName={reportFileName}
              reportClassName={selectedReport === "salesHistory" ? "sales-history-print-report" : selectedReport === "purchaseHistory" ? "purchase-history-print-report" : selectedReport === "profitLoss" ? "profit-loss-print-report" : selectedReport === "cashBook" ? "cash-book-print-report" : ""}
              title={currentReport.title}
              user={user}
              whatsappRecipients={whatsappRecipients}
            >
              {reportFilterSummary.length > 0 && (
                <div className="report-filter-summary">
                  {reportFilterSummary.map((item) => <span key={item}>{item}</span>)}
                </div>
              )}
              <div className="purchase-summary-grid supplier-payment-preview">
                {(currentReport.summary?.(rows) || []).map(([label, value, featured]) => <SummaryMetric featured={featured} key={label} label={label} value={value} />)}
              </div>
              {selectedReport === "stockInventory" ? (
                <StockInventoryReport
                  auditEndpoint={`${API_URL}/stock-inventory/audit`}
                  canManageStock={canManageStock}
                  lots={Array.isArray(data.stockLotReport) ? data.stockLotReport : []}
                  onLotAction={onOpenLotAction}
                  products={Array.isArray(data.stockReport) ? data.stockReport : []}
                />
              ) : selectedReport === "profitLoss" ? renderProfitLossStatement() : selectedReport === "cashBook" ? renderCashBookStatement() : (
                <>
                  <DataTable headers={currentReport.headers}>
                    {selectedReport === "purchaseHistory" ? renderPurchaseHistoryRows() : rows.map((row, index) => currentReport.render(row, index))}
                  </DataTable>
                  {rows.length === 0 && <div className="cart-empty">No records found for the selected filters.</div>}
                </>
              )}
            </PrintableReport>
          </ModuleCard>
        </section>
        {renderBalanceSheetDetailModal()}
        {renderCashBookDetailModal()}
      </>
    );
  }
  if (currentCategory) {
    return (
      <section className="settings-layout">
        <ModuleCard eyebrow="Report Category" title={currentCategory.title} subtitle={currentCategory.description}>
          <div className="button-row">
            <button className="secondary-button" onClick={() => setSelectedCategory("")}>Back to Report Center</button>
          </div>
        </ModuleCard>
        <section className="report-center-grid">
          {currentCategory.reports.map((reportId) => {
            const report = reports[reportId];
            if (!report) return null;
            return (
              <button className="report-menu-card" key={reportId} onClick={() => { setSearch(""); setSelectedReport(reportId); }}>
                <Icon name={currentCategory.icon} size={22} />
                <strong>{report.title}</strong>
                <span>Open report workspace</span>
              </button>
            );
          })}
        </section>
      </section>
    );
  }
  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Report Center" title="Business Report Center" subtitle="Choose a report category first. Each report opens in its own focused workspace.">
        <div className="purchase-summary-grid supplier-payment-preview">
          <SummaryMetric label="Categories" value={categories.length} featured />
          <SummaryMetric label="Available Reports" value={Object.keys(reports).length} />
          <SummaryMetric label="Current Range" value={range === "custom" ? "Custom" : range} />
        </div>
      </ModuleCard>
      <section className="report-center-grid">
        {categories.map((category) => (
          <button className="report-category-card" key={category.id} onClick={() => setSelectedCategory(category.id)}>
            <span className="report-category-icon"><Icon name={category.icon} size={24} /></span>
            <strong>{category.title}</strong>
            <span>{category.description}</span>
            <em>{category.reports.length} reports</em>
          </button>
        ))}
      </section>
    </section>
  );
}

function StockInventoryReport({ auditEndpoint, canManageStock, lots = [], onLotAction, products = [] }) {
  const [viewMode, setViewMode] = useState(() => localStorage.getItem("froozerp-stock-view-mode") || "PRODUCT");
  const [filters, setFilters] = useState({
    productSearch: "",
    lotSearch: "",
    category: "",
    product: "",
    lot: "",
    supplier: "",
    status: "IN_STOCK",
    unit: "",
    origin: "ALL",
    dateType: "ARRIVAL",
    date_from: "",
    date_to: "",
    showEmpty: false,
    showInactive: false,
  });
  const [sortBy, setSortBy] = useState("PRODUCT_ASC");
  const [pageSize, setPageSize] = useState(50);
  const [expandedProductId, setExpandedProductId] = useState("");
  const [auditRows, setAuditRows] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState("");
  const [auditFocus, setAuditFocus] = useState(null);
  const [selectedLotDetail, setSelectedLotDetail] = useState(null);
  const money = (value) => currency.format(Number(value || 0));
  const qty = (value) => Number(value || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });
  const lotBalance = (lot) => Number(lot.balance_qty ?? lot.remaining_qty ?? 0);
  const lotOpening = (lot) => Number(lot.purchase_qty || 0);
  const lotUsed = (lot) => Number(lot.sold_qty ?? Math.max(lotOpening(lot) - Number(lot.remaining_qty || 0), 0));
  const lotCost = (lot) => Number(lot.effective_cost_per_unit || lot.purchase_rate || 0);
  const lotSaleRate = (lot) => Number(lot.temporary_sale_rate || lot.sale_rate || lot.selling_rate || 0);
  const normalizeUnit = (unit) => String(unit || "UNIT").trim().toUpperCase() || "UNIT";
  const productMinimumStock = (lot) => Number(products.find((product) => Number(product.product_id || product.id) === Number(lot.product_id))?.minimum_stock || 0);
  const lotDateValue = (lot) => {
    if (filters.dateType === "BILL") return lot.purchase_bill_date || lot.bill_date || lot.purchase_date || lot.created_at || "";
    if (filters.dateType === "MOVEMENT") return lot.last_movement_at || lot.last_edited_at || lot.updated_at || lot.created_at || lot.purchase_date || "";
    return lot.purchase_date || lot.arrival_date || lot.created_at || "";
  };
  const lotStatus = (lot) => {
    const status = String(lot.batch_status || "ACTIVE").toUpperCase();
    if (status === "CANCELLED") return "Cancelled";
    if (status === "INACTIVE") return "Inactive";
    if (lot.sync_status === "CONFLICT") return "Sync Conflict";
    if (lotBalance(lot) < 0) return "Negative Stock";
    if (lotBalance(lot) <= 0 && lotUsed(lot) > 0) return "Sold Out";
    if (lotBalance(lot) <= productMinimumStock(lot) && lotBalance(lot) > 0) return "Low Stock";
    return "Active";
  };
  const displayStockStatus = (status) => status === "Active" ? "In Stock" : status;
  const statusClass = (status) => status === "Active" ? "stock-ok" : status === "Sold Out" ? "origin-rate" : "stock-low";
  const formatUnitGroups = (groups) => [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([unit, value]) => `${qty(value)} ${unit}`)
    .join(" • ") || "-";
  const addUnitValue = (groups, unit, value) => {
    const key = normalizeUnit(unit);
    groups.set(key, (groups.get(key) || 0) + Number(value || 0));
  };
  useEffect(() => {
    localStorage.setItem("froozerp-stock-view-mode", viewMode);
  }, [viewMode]);
  const activeLots = lots.filter((lot) => lotStatus(lot) === "Active");
  const productGroups = [...lots.reduce((groups, lot) => {
    const key = String(lot.product_id);
    const current = groups.get(key) || {
      product_id: lot.product_id,
      product_name: lot.product_name,
      category: lot.category || "Fruit",
      unit: lot.unit || "",
      minimum_stock: productMinimumStock(lot),
      sale_rate: lot.selling_rate || 0,
      total_stock: 0,
      quantity_groups: new Map(),
      stock_value: 0,
      active_lots: 0,
      sold_out_lots: 0,
      lots: [],
    };
    const balance = lotBalance(lot);
    const status = lotStatus(lot);
    current.total_stock += status === "Cancelled" || status === "Inactive" ? 0 : balance;
    if (!["Cancelled", "Inactive"].includes(status)) addUnitValue(current.quantity_groups, lot.unit, balance);
    current.stock_value += status === "Cancelled" || status === "Inactive" ? 0 : balance * lotCost(lot);
    current.active_lots += status === "Active" ? 1 : 0;
    current.sold_out_lots += status === "Sold Out" ? 1 : 0;
    current.lots.push(lot);
    groups.set(key, current);
    return groups;
  }, new Map()).values()].map((product) => ({ ...product, total_stock_summary: formatUnitGroups(product.quantity_groups) })).sort((left, right) => `${left.category}-${left.product_name}`.localeCompare(`${right.category}-${right.product_name}`));
  const categoryRows = [...productGroups.reduce((groups, product) => {
    const key = product.category || "Fruit";
    const current = groups.get(key) || { category: key, products: 0, total_quantity: 0, stock_value: 0, low_stock_count: 0, product_rows: [] };
    current.products += 1;
    current.total_quantity += product.total_stock;
    current.stock_value += product.stock_value;
    if (Number(product.total_stock || 0) <= Number(product.minimum_stock || 0)) current.low_stock_count += 1;
    current.product_rows.push(product);
    groups.set(key, current);
    return groups;
  }, new Map()).values()].sort((left, right) => left.category.localeCompare(right.category));
  const categories = [...new Set(lots.map((lot) => lot.category || "Fruit"))].sort();
  const suppliers = [...new Set(lots.map((lot) => lot.supplier_name).filter(Boolean))].sort();
  const productOptions = productGroups.map((product) => [String(product.product_id), product.product_name]);
  const selectedProductLots = filters.product
    ? lots
        .filter((lot) => String(lot.product_id) === filters.product)
        .sort((left, right) => `${lotDateValue(left)}-${left.lot_name || ""}`.localeCompare(`${lotDateValue(right)}-${right.lot_name || ""}`))
    : [];
  const lotOptions = selectedProductLots.map((lot) => [
    String(lot.id),
    [
      lot.lot_name || lot.batch_no || "No Lot Number",
      lot.lot_size,
      lot.supplier_name,
      `${qty(lotBalance(lot))} ${normalizeUnit(lot.unit)}`,
      money(lotSaleRate(lot)),
    ].filter(Boolean).join(" / "),
  ]);
  const updateProductFilter = (productId) => {
    setFilters((current) => ({ ...current, product: productId, lot: "", lotSearch: "" }));
    setExpandedProductId("");
  };
  const matchesNeedle = (needle, values) => {
    const normalized = needle.trim().toLowerCase();
    if (!normalized) return true;
    return values.some((value) => String(value ?? "").toLowerCase().includes(normalized));
  };
  const statusMatches = (lot) => {
    const status = lotStatus(lot);
    if (filters.status === "ALL") return true;
    if (filters.status === "IN_STOCK") return ["Active", "Low Stock"].includes(status);
    if (filters.status === "LOW_STOCK") return status === "Low Stock";
    if (filters.status === "OUT_OF_STOCK") return status === "Sold Out";
    if (filters.status === "NEGATIVE") return status === "Negative Stock";
    if (filters.status === "CONFLICT") return status === "Sync Conflict";
    return true;
  };
  const sortLots = (rows) => [...rows].sort((left, right) => {
    if (sortBy === "LOT_ASC") return String(left.lot_name || left.batch_no || "").localeCompare(String(right.lot_name || right.batch_no || ""));
    if (sortBy === "ARRIVAL_NEW") return String(lotDateValue(right)).localeCompare(String(lotDateValue(left)));
    if (sortBy === "ARRIVAL_OLD") return String(lotDateValue(left)).localeCompare(String(lotDateValue(right)));
    if (sortBy === "STOCK_HIGH") return lotBalance(right) - lotBalance(left);
    if (sortBy === "STOCK_LOW") return lotBalance(left) - lotBalance(right);
    if (sortBy === "RATE_HIGH") return lotSaleRate(right) - lotSaleRate(left);
    if (sortBy === "RATE_LOW") return lotSaleRate(left) - lotSaleRate(right);
    if (sortBy === "SUPPLIER_ASC") return String(left.supplier_name || "").localeCompare(String(right.supplier_name || ""));
    if (sortBy === "UPDATED_NEW") return String(right.last_edited_at || right.updated_at || right.created_at || "").localeCompare(String(left.last_edited_at || left.updated_at || left.created_at || ""));
    return `${left.product_name || ""}-${lotDateValue(left)}-${left.lot_name || ""}`.localeCompare(`${right.product_name || ""}-${lotDateValue(right)}-${right.lot_name || ""}`);
  });
  const matchesText = (values) => {
    const needle = `${filters.productSearch} ${filters.lotSearch}`.trim().toLowerCase();
    if (!needle) return true;
    return values.some((value) => String(value ?? "").toLowerCase().includes(needle));
  };
  const filteredLots = sortLots(lots.filter((lot) => {
    const status = lotStatus(lot);
    if (!filters.showEmpty && status === "Sold Out") return false;
    if (!filters.showInactive && ["Inactive", "Cancelled"].includes(status)) return false;
    if (!statusMatches(lot)) return false;
    if (filters.category && (lot.category || "Fruit") !== filters.category) return false;
    if (filters.product && String(lot.product_id) !== filters.product) return false;
    if (filters.lot && String(lot.id) !== filters.lot) return false;
    if (filters.supplier && lot.supplier_name !== filters.supplier) return false;
    if (filters.origin !== "ALL" && String(lot.origin_type || lot.origin || "LOCAL").toUpperCase() !== filters.origin) return false;
    const dateKey = toDateKey(lotDateValue(lot));
    if (filters.date_from && dateKey < filters.date_from) return false;
    if (filters.date_to && dateKey > filters.date_to) return false;
    const productMatch = matchesNeedle(filters.productSearch, [lot.product_name, lot.barcode, lot.category]);
    const lotMatch = matchesNeedle(filters.lotSearch, [
      lot.lot_name,
      lot.batch_no,
      lot.supplier_lot_number,
      lot.reference_no,
      lot.lot_size,
      lot.unit,
      lotBalance(lot),
      lotSaleRate(lot),
      status,
      lotDateValue(lot),
    ]);
    if (!productMatch || !lotMatch) return false;
    return matchesText([
      lot.product_name,
      lot.category,
      lot.lot_name,
      lot.batch_no,
      lot.lot_size,
      lot.supplier_name,
      lot.purchase_qty,
      lot.remaining_qty,
      lot.purchase_rate,
      lot.effective_cost_per_unit,
      lot.temporary_sale_rate,
      lot.selling_rate,
      status,
      lot.remarks,
    ]);
  }));
  const pagedLots = filteredLots.slice(0, Number(pageSize || 50));
  const filteredProductRows = productGroups
    .map((product) => {
      const visibleLots = filteredLots.filter((lot) => Number(lot.product_id) === Number(product.product_id));
      const unitGroups = visibleLots.reduce((groups, lot) => {
        addUnitValue(groups, lot.unit, lotBalance(lot));
        return groups;
      }, new Map());
      return {
        ...product,
        visible_lots: visibleLots,
        total_stock_summary: formatUnitGroups(unitGroups),
        filtered_stock_value: visibleLots.reduce((sum, lot) => sum + lotBalance(lot) * lotCost(lot), 0),
        filtered_active_lots: visibleLots.filter((lot) => lotStatus(lot) === "Active").length,
      };
    })
    .filter((product) => product.visible_lots.length > 0);
  const filteredCategoryRows = categoryRows
    .map((category) => ({ ...category, product_rows: filteredProductRows.filter((product) => product.category === category.category) }))
    .filter((category) => category.product_rows.length > 0 && matchesText([category.category, category.products, category.total_quantity, category.stock_value]));
  const filteredUnitGroups = filteredLots.reduce((groups, lot) => {
    addUnitValue(groups, lot.unit, lotBalance(lot));
    return groups;
  }, new Map());
  const totalStockValue = filteredLots.filter((lot) => lotStatus(lot) === "Active").reduce((sum, lot) => sum + lotBalance(lot) * lotCost(lot), 0);
  const lowStockItems = filteredLots.filter((lot) => lotStatus(lot) === "Low Stock").length;
  const adjustmentCount = auditRows.filter((row) => row.action === "INVENTORY_LOT_ADJUST").length;

  useEffect(() => {
    let mounted = true;
    const loadAudit = async () => {
      if (!auditEndpoint) return;
      setAuditLoading(true);
      setAuditError("");
      try {
        const response = await axios.get(auditEndpoint);
        if (mounted) setAuditRows(response.data || []);
      } catch (error) {
        if (mounted) setAuditError(getErrorMessage(error, "Unable to load stock audit trail"));
      } finally {
        if (mounted) setAuditLoading(false);
      }
    };
    loadAudit();
    return () => {
      mounted = false;
    };
  }, [auditEndpoint]);

  const openAudit = (lot = null) => {
    setAuditFocus(lot || { all: true });
  };
  const focusedAuditRows = auditFocus?.all ? auditRows : auditRows.filter((row) => String(row.lot_id || "") === String(auditFocus?.id || ""));
  const auditChangeSummary = (row) => {
    const oldValue = row.old_value || {};
    const newValue = row.new_value || {};
    const beforeQty = oldValue.remaining_qty ?? oldValue.purchase_qty ?? "-";
    const afterQty = newValue.remaining_qty ?? newValue.purchase_qty ?? "-";
    const beforeRate = oldValue.purchase_rate ?? oldValue.effective_cost_per_unit ?? "-";
    const afterRate = newValue.purchase_rate ?? newValue.effective_cost_per_unit ?? "-";
    return `Qty ${beforeQty} -> ${afterQty} | Cost ${beforeRate} -> ${afterRate}`;
  };
  const clearFilters = () => setFilters({ productSearch: "", lotSearch: "", category: "", product: "", lot: "", supplier: "", status: "IN_STOCK", unit: "", origin: "ALL", dateType: "ARRIVAL", date_from: "", date_to: "", showEmpty: false, showInactive: false });
  const renderLotActions = (lot) => {
    const status = lotStatus(lot);
    return (
      <div className="table-actions">
        <button className="table-action" disabled={!canManageStock} onClick={() => onLotAction?.("edit", lot)}>Edit Lot</button>
        <button className="table-action" disabled={!canManageStock || status === "Cancelled"} onClick={() => onLotAction?.("adjust", lot)}>Adjust Stock</button>
        <button className="table-action" disabled={!canManageStock || status === "Cancelled" || lotBalance(lot) <= 0} onClick={() => onLotAction?.("transfer", lot)}>Transfer</button>
        <button className="table-action" disabled={!canManageStock || status === "Cancelled"} onClick={() => onLotAction?.("add", lot)}>Add Qty</button>
        {status === "Cancelled" || status === "Inactive" ? (
          <button className="table-action" disabled={!canManageStock} onClick={() => onLotAction?.("reactivate", lot)}>Reactivate</button>
        ) : (
          <button className="remove-button compact-button" disabled={!canManageStock} onClick={() => onLotAction?.("deactivate", lot)}>Deactivate</button>
        )}
        <button className="secondary-button compact-button" onClick={() => openAudit(lot)}>Audit</button>
      </div>
    );
  };
  const openLotDetail = (lot) => setSelectedLotDetail(lot);
  const renderLotRows = (rows) => rows.map((lot) => {
    const status = lotStatus(lot);
    return (
      <tr className="report-row-clickable" key={lot.id} onClick={() => openLotDetail(lot)}>
        <td className="primary-cell">{lot.product_name}<small className="cell-note">{lot.unit}</small></td>
        <td>{lot.category || "Fruit"}</td>
        <td>{lot.supplier_name || "-"}</td>
        <td className="primary-cell">{lot.lot_name || lot.batch_no || `Lot #${lot.id}`}</td>
        <td>{lot.lot_size || "-"}</td>
        <td>{formatDisplayDate(lot.purchase_date || lot.created_at)}</td>
        <td>{qty(lotOpening(lot))}</td>
        <td>{qty(lotUsed(lot))}</td>
        <td>{qty(lot.adjusted_qty)}</td>
        <td><span className={lotBalance(lot) <= 0 ? "origin-rate" : "stock-ok"}>{qty(lotBalance(lot))}</span></td>
        {canManageStock && <td>{money(lotCost(lot))}</td>}
        <td>{money(lotSaleRate(lot))}</td>
        {canManageStock && <td>{money(lotBalance(lot) * lotCost(lot))}</td>}
        <td><span className={statusClass(status)}>{displayStockStatus(status)}</span></td>
        <td className="purchase-items-cell"><span title={lot.remarks || "-"}>{lot.remarks || "-"}</span></td>
        <td>{lot.created_at ? new Date(lot.created_at).toLocaleString("en-IN") : "-"}</td>
        <td>{lot.last_edited_at ? new Date(lot.last_edited_at).toLocaleString("en-IN") : "-"}</td>
      </tr>
    );
  });
  const compactLotHeaders = ["Product", "Lot Number", "Supplier", "Stock", "Unit", "Arrival Date", ...(canManageStock ? ["Purchase / Expected Rate"] : []), "Sale Rate", ...(canManageStock ? ["Stock Value"] : []), "Status"];
  const renderCompactLotRows = (rows) => rows.map((lot) => {
    const status = lotStatus(lot);
    return (
      <tr className="report-row-clickable" key={lot.id} onClick={() => openLotDetail(lot)}>
        <td className="primary-cell">{lot.product_name}<small className="cell-note">{lot.category || ""}</small></td>
        <td className="primary-cell">{lot.lot_name || lot.batch_no || "No Lot Number"}<small className="cell-note">{lot.lot_size || ""}</small></td>
        <td>{lot.supplier_name || "-"}</td>
        <td><span className={lotBalance(lot) <= 0 ? "origin-rate" : "stock-ok"}>{qty(lotBalance(lot))}</span></td>
        <td>{normalizeUnit(lot.unit)}</td>
        <td>{formatDisplayDate(lot.purchase_date || lot.created_at)}</td>
        {canManageStock && <td>{money(lotCost(lot))}</td>}
        <td>{money(lotSaleRate(lot))}</td>
        {canManageStock && <td>{money(lotBalance(lot) * lotCost(lot))}</td>}
        <td><span className={statusClass(status)}>{displayStockStatus(status)}</span></td>
      </tr>
    );
  });

  return (
    <section className="stock-inventory-report">
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric featured label="Total Stock Value" value={canManageStock ? money(totalStockValue) : "Restricted"} />
        <SummaryMetric label="Products" value={filteredProductRows.length} />
        <SummaryMetric label="Active Lots" value={filteredLots.filter((lot) => ["Active", "Low Stock"].includes(lotStatus(lot))).length} />
        <SummaryMetric label="Stock" value={formatUnitGroups(filteredUnitGroups)} />
        <SummaryMetric label="Out-of-Stock Lots" value={filteredLots.filter((lot) => lotStatus(lot) === "Sold Out").length} />
        <SummaryMetric label="Low Stock Items" value={lowStockItems} />
        <SummaryMetric label="Inventory Adjustments" value={auditLoading ? "Loading" : adjustmentCount} />
      </div>
      {auditError && <div className="error-banner">{auditError}</div>}
      <div className="stock-inventory-toolbar sticky-report-filters no-print">
        <div className="stock-filter-row stock-filter-row-primary">
          <Field label="View Mode">
            <select value={viewMode} onChange={(event) => setViewMode(event.target.value)}>
              <option value="PRODUCT">Product View</option>
              <option value="LOT">Lot View</option>
            </select>
          </Field>
          <Field label="Product Search / Selector">
            <div className="stacked-control">
              <input placeholder="Search or select product..." value={filters.productSearch} onChange={(event) => setFilters({ ...filters, productSearch: event.target.value })} />
              <select value={filters.product} onChange={(event) => updateProductFilter(event.target.value)}>
                <option value="">All products</option>
                {productOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </div>
          </Field>
          <Field label="Date Type">
            <select value={filters.dateType} onChange={(event) => setFilters({ ...filters, dateType: event.target.value })}>
              <option value="ARRIVAL">Arrival Date</option>
              <option value="BILL">Purchase Bill Date</option>
              <option value="MOVEMENT">Last Stock Movement Date</option>
            </select>
          </Field>
          <Field label="Date From"><input type="date" value={filters.date_from} onChange={(event) => setFilters({ ...filters, date_from: event.target.value })} /></Field>
          <Field label="Date To"><input type="date" value={filters.date_to} onChange={(event) => setFilters({ ...filters, date_to: event.target.value })} /></Field>
          <Field label="Status">
            <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
              <option value="ALL">All</option>
              <option value="IN_STOCK">In Stock</option>
              <option value="LOW_STOCK">Low Stock</option>
              <option value="OUT_OF_STOCK">Out of Stock</option>
              <option value="NEGATIVE">Negative Stock</option>
              <option value="CONFLICT">Conflict</option>
            </select>
          </Field>
        </div>
        <div className="stock-filter-row stock-filter-row-secondary">
          <Field label="Lot Filter">
            <div className="stacked-control">
              <input
                disabled={!filters.product}
                placeholder={filters.product ? "Search lot number, supplier lot, date, stock or rate..." : "Select product first"}
                value={filters.lotSearch}
                onChange={(event) => setFilters({ ...filters, lotSearch: event.target.value })}
              />
              <select
                disabled={!filters.product}
                value={filters.lot}
                onChange={(event) => setFilters({ ...filters, lot: event.target.value })}
              >
                <option value="">{filters.product ? "All lots for selected product" : "Select product first"}</option>
                {filters.product && lotOptions.length === 0 && <option value="" disabled>No lots found for this product</option>}
                {lotOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
              </select>
            </div>
          </Field>
          <Field label="Category">
            <select value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
              <option value="">All categories</option>
              {categories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </Field>
          <Field label="Supplier">
            <select value={filters.supplier} onChange={(event) => setFilters({ ...filters, supplier: event.target.value })}>
              <option value="">All suppliers</option>
              {suppliers.map((supplier) => <option key={supplier} value={supplier}>{supplier}</option>)}
            </select>
          </Field>
          <Field label="Origin">
            <select value={filters.origin} onChange={(event) => setFilters({ ...filters, origin: event.target.value })}>
              <option value="ALL">All</option>
              <option value="LOCAL">Local</option>
              <option value="IMPORTED">Imported</option>
            </select>
          </Field>
          <Field label="Sort By">
            <select value={sortBy} onChange={(event) => setSortBy(event.target.value)}>
              <option value="PRODUCT_ASC">Product Name</option>
              <option value="LOT_ASC">Lot Number</option>
              <option value="ARRIVAL_OLD">Arrival Date - Oldest</option>
              <option value="ARRIVAL_NEW">Arrival Date - Newest</option>
              <option value="STOCK_HIGH">Available Stock - High</option>
              <option value="STOCK_LOW">Available Stock - Low</option>
              <option value="RATE_HIGH">Sale Rate - High</option>
              <option value="RATE_LOW">Sale Rate - Low</option>
              <option value="SUPPLIER_ASC">Supplier</option>
              <option value="UPDATED_NEW">Last Updated</option>
            </select>
          </Field>
          <Field label="Rows">
            <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>
              <option value="25">25</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
          </Field>
          <button className="secondary-button stock-clear-button" onClick={clearFilters}>Clear All Filters</button>
        </div>
        <div className="stock-toggle-row">
          <label className="check-field report-check-field"><input checked={filters.showEmpty} type="checkbox" onChange={(event) => setFilters({ ...filters, showEmpty: event.target.checked })} /><span>Show Empty Lots</span></label>
          <label className="check-field report-check-field"><input checked={filters.showInactive} type="checkbox" onChange={(event) => setFilters({ ...filters, showInactive: event.target.checked })} /><span>Show Inactive / Cancelled Lots</span></label>
          <button className="secondary-button compact-button" onClick={() => openAudit()}>View Audit Trail</button>
        </div>
      </div>
      <div className="quick-filter-row no-print">
        <button className="filter-chip" onClick={() => setFilters({ ...filters, dateType: "ARRIVAL", date_from: toDateKey(new Date()), date_to: toDateKey(new Date()) })}>Today's Arrivals</button>
        <button className="filter-chip" onClick={() => {
          const date = new Date();
          date.setDate(date.getDate() - 6);
          setFilters({ ...filters, dateType: "ARRIVAL", date_from: toDateKey(date), date_to: toDateKey(new Date()) });
        }}>Last 7 Days</button>
        <button className="filter-chip" onClick={() => {
          const date = new Date();
          date.setDate(date.getDate() - 29);
          setFilters({ ...filters, dateType: "ARRIVAL", date_from: toDateKey(date), date_to: toDateKey(new Date()) });
        }}>Last 30 Days</button>
        <button className="filter-chip" onClick={() => setFilters({ ...filters, status: "LOW_STOCK" })}>Low Stock</button>
        <button className="filter-chip" onClick={() => setFilters({ ...filters, status: "OUT_OF_STOCK", showEmpty: true })}>Out of Stock</button>
        <button className="filter-chip" onClick={() => setFilters({ ...filters, origin: "IMPORTED" })}>Imported</button>
        <button className="filter-chip" onClick={() => setFilters({ ...filters, origin: "LOCAL" })}>Local</button>
        <button className="filter-chip" onClick={() => { setSortBy("UPDATED_NEW"); setFilters({ ...filters, dateType: "MOVEMENT" }); }}>Recently Updated</button>
      </div>
      <div className="active-filter-chip-row no-print">
        {filters.productSearch && <button className="filter-chip" onClick={() => setFilters({ ...filters, productSearch: "" })}>{filters.productSearch} x</button>}
        {filters.lotSearch && <button className="filter-chip" onClick={() => setFilters({ ...filters, lotSearch: "" })}>{filters.lotSearch} x</button>}
        {filters.product && <button className="filter-chip" onClick={() => updateProductFilter("")}>{productOptions.find(([id]) => id === filters.product)?.[1] || "Product"} x</button>}
        {filters.lot && <button className="filter-chip" onClick={() => setFilters({ ...filters, lot: "" })}>{lotOptions.find(([id]) => id === filters.lot)?.[1] || "Lot"} x</button>}
        {filters.date_from && <button className="filter-chip" onClick={() => setFilters({ ...filters, date_from: "" })}>From {formatDisplayDate(filters.date_from)} x</button>}
        {filters.date_to && <button className="filter-chip" onClick={() => setFilters({ ...filters, date_to: "" })}>To {formatDisplayDate(filters.date_to)} x</button>}
        {filters.status !== "IN_STOCK" && <button className="filter-chip" onClick={() => setFilters({ ...filters, status: "IN_STOCK" })}>{filters.status.replaceAll("_", " ")} x</button>}
        {filters.origin !== "ALL" && <button className="filter-chip" onClick={() => setFilters({ ...filters, origin: "ALL" })}>{filters.origin} x</button>}
      </div>
      {viewMode === "PRODUCT" && (
        <DataTable headers={["Product", "Category", "Total Stock", "Available Lots", "Average Cost", "Sale Rate", "Stock Value", "Minimum Stock", "Status"]}>
          {filteredProductRows.map((product) => {
            const visibleBalance = product.visible_lots.reduce((sum, lot) => sum + lotBalance(lot), 0);
            const visibleValue = product.filtered_stock_value;
            const averageCost = visibleBalance > 0 ? visibleValue / visibleBalance : 0;
            const low = product.visible_lots.some((lot) => lotStatus(lot) === "Low Stock");
            const toggleProduct = () => setExpandedProductId(expandedProductId === String(product.product_id) ? "" : String(product.product_id));
            return (
              <React.Fragment key={product.product_id}>
                <tr className="report-row-clickable" onClick={toggleProduct}>
                  <td className="primary-cell">{product.product_name}<small className="cell-note">Click to view lots</small></td>
                  <td>{product.category}</td>
                  <td>{product.total_stock_summary}</td>
                  <td>{product.filtered_active_lots}</td>
                  <td>{canManageStock ? money(averageCost) : "Restricted"}</td>
                  <td>{money(product.sale_rate)}</td>
                  <td>{canManageStock ? money(visibleValue) : "Restricted"}</td>
                  <td>{qty(product.minimum_stock)}</td>
                  <td><span className={low ? "stock-low" : "stock-ok"}>{low ? "Low Stock" : "OK"}</span></td>
                </tr>
                {expandedProductId === String(product.product_id) && (
                  <tr className="sales-history-drilldown-row">
                    <td colSpan="9">
                      <DataTable headers={compactLotHeaders}>
                        {renderCompactLotRows(product.visible_lots)}
                      </DataTable>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
          {filteredProductRows.length === 0 && <tr><td colSpan="9" className="empty-cell">No matching stock products found.</td></tr>}
        </DataTable>
      )}
      {viewMode === "LOT" && (
        <DataTable headers={compactLotHeaders}>
          {renderCompactLotRows(pagedLots)}
          {filteredLots.length === 0 && <tr><td colSpan={compactLotHeaders.length} className="empty-cell">No matching stock lots found.</td></tr>}
        </DataTable>
      )}
      {viewMode === "CATEGORY" && (
        <DataTable headers={["Category", "Products", "Total Quantity", "Stock Value", "Low Stock Count"]}>
          {filteredCategoryRows.map((category) => (
            <tr className="report-row-clickable" key={category.category} onClick={() => { setViewMode("PRODUCT"); setFilters({ ...filters, category: category.category }); }}>
              <td className="primary-cell">{category.category}</td>
              <td>{category.product_rows.length}</td>
              <td>{qty(category.product_rows.reduce((sum, product) => sum + product.total_stock, 0))}</td>
              <td>{money(category.product_rows.reduce((sum, product) => sum + product.stock_value, 0))}</td>
              <td>{category.product_rows.filter((product) => Number(product.total_stock || 0) <= Number(product.minimum_stock || 0)).length}</td>
            </tr>
          ))}
          {filteredCategoryRows.length === 0 && <tr><td colSpan="5" className="empty-cell">No matching stock categories found.</td></tr>}
        </DataTable>
      )}
      {selectedLotDetail && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Stock Lot Detail</span>
                <strong>{selectedLotDetail.product_name} - {selectedLotDetail.lot_name || selectedLotDetail.batch_no || `Lot #${selectedLotDetail.id}`}</strong>
              </div>
              <button aria-label="Close lot detail" className="remove-button" onClick={() => setSelectedLotDetail(null)}><Icon name="close" /></button>
            </div>
            <div className="sale-edit-body">
              <div className="purchase-summary-grid supplier-payment-preview">
                <SummaryMetric label="Balance Qty" value={qty(lotBalance(selectedLotDetail))} featured />
                <SummaryMetric label="Stock Value" value={money(lotBalance(selectedLotDetail) * lotCost(selectedLotDetail))} />
                <SummaryMetric label="Status" value={lotStatus(selectedLotDetail)} />
              </div>
              <DataTable headers={["Field", "Value"]}>
                <tr><td>Product</td><td className="primary-cell">{selectedLotDetail.product_name}</td></tr>
                <tr><td>Category</td><td>{selectedLotDetail.category || "Fruit"}</td></tr>
                <tr><td>Supplier</td><td>{selectedLotDetail.supplier_name || "-"}</td></tr>
                <tr><td>Lot / Size</td><td>{[selectedLotDetail.lot_name || selectedLotDetail.batch_no || `Lot #${selectedLotDetail.id}`, selectedLotDetail.lot_size].filter(Boolean).join(" / ")}</td></tr>
                <tr><td>Opening / Sold / Adjusted</td><td>{qty(lotOpening(selectedLotDetail))} / {qty(lotUsed(selectedLotDetail))} / {qty(selectedLotDetail.adjusted_qty)}</td></tr>
                <tr><td>Cost / Sale Rate</td><td>{money(lotCost(selectedLotDetail))} / {money(lotSaleRate(selectedLotDetail))}</td></tr>
                <tr><td>Opening Date</td><td>{formatDisplayDate(selectedLotDetail.purchase_date || selectedLotDetail.created_at)}</td></tr>
                <tr><td>Remarks</td><td>{selectedLotDetail.remarks || "-"}</td></tr>
              </DataTable>
              <div className="detail-action-bar no-print">
                {renderLotActions(selectedLotDetail)}
              </div>
            </div>
          </section>
        </div>
      )}
      {auditFocus && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Stock Audit Trail</span>
                <strong>{auditFocus.all ? "All Inventory Changes" : `${auditFocus.product_name} - ${auditFocus.lot_name || auditFocus.batch_no || `Lot #${auditFocus.id}`}`}</strong>
              </div>
              <button className="remove-button" onClick={() => setAuditFocus(null)}><Icon name="close" /></button>
            </div>
            <div className="sale-edit-body">
              <DataTable headers={["Date", "Product", "Lot", "Action", "Qty / Rate Change", "Reason", "Edited By"]}>
                {focusedAuditRows.map((row) => (
                  <tr key={row.id}>
                    <td>{row.edited_at ? new Date(row.edited_at).toLocaleString("en-IN") : "-"}</td>
                    <td className="primary-cell">{row.product_name}</td>
                    <td>{row.lot_name || row.lot_id || "-"}</td>
                    <td><span className="tag">{row.action}</span></td>
                    <td>{auditChangeSummary(row)}</td>
                    <td>{row.reason || "-"}</td>
                    <td>{row.edited_by_name || "-"}</td>
                  </tr>
                ))}
                {focusedAuditRows.length === 0 && <tr><td colSpan="7" className="empty-cell">No audit entries found.</td></tr>}
              </DataTable>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

function SaleReturnModule({ onReload, returns, salesHistory, user }) {
  const [invoiceId, setInvoiceId] = useState("");
  const [returnOptions, setReturnOptions] = useState({ sale: null, items: [] });
  const [returnDate, setReturnDate] = useState(toDateKey(new Date()));
  const [refundType, setRefundType] = useState("CASH_REFUND");
  const [returnReason, setReturnReason] = useState("");
  const [quantities, setQuantities] = useState({});
  const activeInvoices = salesHistory.filter((sale) => sale.sale_status !== "CANCELLED");

  const loadReturnOptions = async (saleId) => {
    setInvoiceId(saleId);
    setQuantities({});
    if (!saleId) {
      setReturnOptions({ sale: null, items: [] });
      return;
    }
    const response = await axios.get(`${API_URL}/sale-returns/options/${saleId}`);
    setReturnOptions(response.data);
  };

  const selectedItems = returnOptions.items
    .map((item) => ({ ...item, return_quantity: Number(quantities[item.sale_item_id] || 0) }))
    .filter((item) => item.return_quantity > 0);
  const totalReturnValue = selectedItems.reduce((sum, item) => (
    sum + (Number(item.net_amount || 0) / Number(item.sold_quantity || 1)) * Number(item.return_quantity || 0)
  ), 0);

  const saveReturn = async () => {
    try {
      await axios.post(`${API_URL}/sale-returns`, {
        sale_id: Number(invoiceId),
        customer_name: returnOptions.sale?.customer_name,
        customer_mobile: returnOptions.sale?.customer_mobile,
        return_date: returnDate,
        refund_type: refundType,
        return_reason: returnReason,
        branch_id: user.branch_id,
        created_by: user.id,
        items: selectedItems.map((item) => ({
          sale_item_id: item.sale_item_id,
          return_quantity: item.return_quantity,
        })),
      });
      setInvoiceId("");
      setReturnOptions({ sale: null, items: [] });
      setReturnReason("");
      setQuantities({});
      await onReload();
      alert("Sale return saved and inventory restored");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save sale return"));
    }
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Sale Return / Refund" title="Return Entry" subtitle="Create a separate return record without editing the original invoice.">
        <div className="form-grid supplier-form-grid">
          <Field label="Select Invoice">
            <select value={invoiceId} onChange={(event) => loadReturnOptions(event.target.value)}>
              <option value="">Select invoice</option>
              {activeInvoices.map((sale) => <option key={sale.id} value={sale.id}>{sale.invoice_no || `Invoice #${sale.id}`} - {sale.customer_name || "Walk-in"} - {currency.format(Number(sale.amount || 0))}</option>)}
            </select>
          </Field>
          <Field label="Customer"><input readOnly value={returnOptions.sale?.customer_name || ""} /></Field>
          <Field label="Return Date"><input type="date" value={returnDate} onChange={(event) => setReturnDate(event.target.value)} /></Field>
          <Field label="Refund Option">
            <select value={refundType} onChange={(event) => setRefundType(event.target.value)}>
              <option value="CASH_REFUND">Cash Refund</option>
              <option value="UPI_REFUND">UPI Refund</option>
              <option value="CREDIT_NOTE">Credit Note</option>
              <option value="FUTURE_ADJUSTMENT">Adjustment Against Future Sale</option>
            </select>
          </Field>
          <Field label="Return Reason"><textarea value={returnReason} onChange={(event) => setReturnReason(event.target.value)} /></Field>
        </div>
        <DataTable headers={["Product", "Sold", "Already Returned", "Returnable", "Return Quantity", "Rate", "Return Value"]}>
          {returnOptions.items.map((item) => {
            const quantity = Number(quantities[item.sale_item_id] || 0);
            const value = (Number(item.net_amount || 0) / Number(item.sold_quantity || 1)) * quantity;
            return (
              <tr key={item.sale_item_id}>
                <td className="primary-cell">{item.product_name}<small className="cell-note">{item.unit}</small></td>
                <td>{Number(item.sold_quantity || 0).toLocaleString("en-IN")}</td>
                <td>{Number(item.returned_quantity || 0).toLocaleString("en-IN")}</td>
                <td>{Number(item.returnable_quantity || 0).toLocaleString("en-IN")}</td>
                <td><input className="table-input" min="0" max={Number(item.returnable_quantity || 0)} step="0.001" type="number" value={quantities[item.sale_item_id] || ""} onChange={(event) => setQuantities({ ...quantities, [item.sale_item_id]: event.target.value })} /></td>
                <td>{currency.format(Number(item.selling_rate || 0))}</td>
                <td>{currency.format(value)}</td>
              </tr>
            );
          })}
        </DataTable>
        <div className="purchase-summary-grid supplier-payment-preview">
          <SummaryMetric label="Selected Items" value={selectedItems.length} />
          <SummaryMetric label="Return Value" value={currency.format(totalReturnValue)} featured />
          <SummaryMetric label="Refund Mode" value={refundType.replaceAll("_", " ")} />
        </div>
        <button className="primary-button" onClick={saveReturn}>Save Return / Refund</button>
      </ModuleCard>
      <ModuleCard eyebrow="Return History" title="Sale Return History" subtitle="Returned goods, refund modes and reasons remain separate from original invoices.">
        <DataTable headers={["Return No", "Date", "Invoice", "Customer", "Refund", "Value", "Reason", "Items"]}>
          {returns.map((entry) => (
            <tr key={entry.id}>
              <td><span className="batch-id">{entry.return_no}</span></td>
              <td>{toDateKey(entry.return_date)}</td>
              <td>{entry.invoice_no}</td>
              <td className="primary-cell">{entry.customer_name || "Walk-in"}</td>
              <td><span className="tag">{entry.refund_type}</span></td>
              <td>{currency.format(Number(entry.total_return_amount || 0))}</td>
              <td>{entry.return_reason}</td>
              <td>{(entry.items || []).map((item) => `${item.product_name} x ${item.return_quantity}`).join(", ")}</td>
            </tr>
          ))}
        </DataTable>
      </ModuleCard>
    </section>
  );
}

function WasteManagementModule({ entries, inventory, onReload, products, user }) {
  const [draft, setDraft] = useState({
    product_id: "",
    quantity: "",
    waste_type: "DAAGI",
    waste_date: toDateKey(new Date()),
    remarks: "",
  });
  const stockByProduct = inventory.reduce((stock, item) => {
    stock.set(Number(item.product_id), (stock.get(Number(item.product_id)) || 0) + Number(item.remaining_qty || 0));
    return stock;
  }, new Map());
  const mostWasted = [...entries].reduce((map, entry) => {
    const current = map.get(entry.product_name) || { product_name: entry.product_name, quantity: 0, cost: 0 };
    current.quantity += Number(entry.quantity || 0);
    current.cost += Number(entry.cost_amount || 0);
    map.set(entry.product_name, current);
    return map;
  }, new Map());
  const mostWastedProducts = [...mostWasted.values()].sort((left, right) => right.quantity - left.quantity).slice(0, 5);
  const saveWaste = async () => {
    try {
      await axios.post(`${API_URL}/waste-entries`, {
        ...draft,
        product_id: Number(draft.product_id),
        quantity: Number(draft.quantity || 0),
        branch_id: user.branch_id,
        created_by: user.id,
      });
      setDraft({ product_id: "", quantity: "", waste_type: "DAAGI", waste_date: toDateKey(new Date()), remarks: "" });
      await onReload();
      alert("Waste entry saved and stock reduced");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save waste entry"));
    }
  };
  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Waste Management" title="Waste Entry" subtitle="Record Daagi, sampling, personal use and other fruit waste with automatic FIFO stock reduction.">
        <div className="form-grid supplier-form-grid">
          <Field label="Product">
            <select value={draft.product_id} onChange={(event) => setDraft({ ...draft, product_id: event.target.value })}>
              <option value="">Select product</option>
              {products.filter((product) => product.active !== false).map((product) => <option key={product.id} value={product.id}>{product.product_name} - Stock {stockByProduct.get(Number(product.id)) || 0}</option>)}
            </select>
          </Field>
          <Field label="Quantity"><input min="0" step="0.001" type="number" value={draft.quantity} onChange={(event) => setDraft({ ...draft, quantity: event.target.value })} /></Field>
          <Field label="Waste Type">
            <select value={draft.waste_type} onChange={(event) => setDraft({ ...draft, waste_type: event.target.value })}>
              <option value="DAAGI">Daagi</option>
              <option value="SAMPLING">Sampling</option>
              <option value="PERSONAL_USE">Personal Use</option>
              <option value="OTHER">Other</option>
            </select>
          </Field>
          <Field label="Date"><input type="date" value={draft.waste_date} onChange={(event) => setDraft({ ...draft, waste_date: event.target.value })} /></Field>
          <Field label="Remarks"><textarea value={draft.remarks} onChange={(event) => setDraft({ ...draft, remarks: event.target.value })} /></Field>
        </div>
        <button className="primary-button" onClick={saveWaste}>Save Waste Entry</button>
      </ModuleCard>
      <ModuleCard eyebrow="Business Intelligence" title="Most Wasted Products" subtitle="Highlights products causing the highest waste quantity.">
        <div className="top-product-list">
          {mostWastedProducts.length ? mostWastedProducts.map((item) => (
            <article className="top-product-row" key={item.product_name}>
              <div><strong>{item.product_name}</strong><span>{item.quantity.toLocaleString("en-IN")} quantity wasted</span></div>
              <strong>{currency.format(item.cost)}</strong>
            </article>
          )) : <div className="empty-inline">No waste entries yet.</div>}
        </div>
      </ModuleCard>
      <ModuleCard eyebrow="Waste History" title="Waste Register" subtitle="Waste quantity and FIFO cost are stored for daily and monthly reporting.">
        <DataTable headers={["Date", "Product", "Type", "Quantity", "Cost", "Remarks"]}>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{toDateKey(entry.waste_date)}</td>
              <td className="primary-cell">{entry.product_name}<small className="cell-note">{entry.unit}</small></td>
              <td><span className="tag">{entry.waste_type}</span></td>
              <td>{Number(entry.quantity || 0).toLocaleString("en-IN")}</td>
              <td>{currency.format(Number(entry.cost_amount || 0))}</td>
              <td>{entry.remarks || "-"}</td>
            </tr>
          ))}
        </DataTable>
      </ModuleCard>
    </section>
  );
}

function ExpensesModule({ expenses, onReload, user }) {
  const expenseCategories = ["Rent", "Staff Salary", "Electricity", "Transport", "Loading / Hamali", "Packing Material", "Repair & Maintenance", "Food / Tea / Misc", "Other"];
  const emptyExpense = {
    expense_date: toDateKey(new Date()),
    category: "Other",
    amount: "",
    payment_mode: "CASH",
    reference_number: "",
    vendor_name: "",
    remarks: "",
    active: true,
  };
  const [draft, setDraft] = useState(emptyExpense);
  const [editingId, setEditingId] = useState(null);
  const [filters, setFilters] = useState({ search: "", category: "", payment_mode: "", status: "", date_from: "", date_to: "" });
  const filteredExpenses = expenses.filter((expense) => {
    const status = expense.status || (expense.active !== false ? "ACTIVE" : "CANCELLED");
    const searchText = `${expense.category || ""} ${expense.vendor_name || ""} ${expense.paid_to || ""} ${expense.reference_number || ""} ${expense.remarks || ""}`.toLowerCase();
    if (filters.search && !searchText.includes(filters.search.toLowerCase())) return false;
    if (filters.category && expense.category !== filters.category) return false;
    if (filters.payment_mode && expense.payment_mode !== filters.payment_mode) return false;
    if (filters.status && status !== filters.status) return false;
    if (filters.date_from && toDateKey(expense.expense_date) < filters.date_from) return false;
    if (filters.date_to && toDateKey(expense.expense_date) > filters.date_to) return false;
    return true;
  });
  const totalActiveExpenses = filteredExpenses
    .filter((expense) => expense.active !== false && expense.status !== "CANCELLED")
    .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);

  const saveExpense = async () => {
    try {
      const payload = {
        ...draft,
        amount: Number(draft.amount || 0),
        paid_to: draft.paid_to || draft.vendor_name,
        branch_id: user.branch_id,
        created_by: user.id,
        edited_by: user.id,
      };
      if (editingId) {
        const reason = window.prompt("Enter reason for editing this expense", "Expense updated");
        if (!reason) return;
        await axios.put(`${API_URL}/expenses/${editingId}`, { ...payload, reason });
      }
      else await axios.post(`${API_URL}/expenses`, payload);
      setDraft(emptyExpense);
      setEditingId(null);
      await onReload();
      alert(editingId ? "Expense updated" : "Expense saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save expense"));
    }
  };
  const editExpense = (expense) => {
    setEditingId(expense.id);
    setDraft({
      expense_date: toDateKey(expense.expense_date),
      category: expense.category || "",
      amount: expense.amount || "",
      payment_mode: expense.payment_mode || "CASH",
      reference_number: expense.reference_number || "",
      vendor_name: expense.vendor_name || expense.paid_to || "",
      remarks: expense.remarks || "",
      active: expense.active !== false,
    });
  };
  const cancelExpense = async (expense) => {
    const reason = window.prompt(`Enter cancellation reason for ${expense.category}`);
    if (!reason) return;
    try {
      await axios.post(`${API_URL}/expenses/${expense.id}/cancel`, { reason, cancelled_by: user.id });
      await onReload();
      alert("Expense cancelled");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to cancel expense"));
    }
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Operating Costs" title="Expenses" subtitle="Record and manage daily operating expenses.">
        <div className="purchase-summary-grid supplier-payment-preview">
          <SummaryMetric label="Active Expense Total" value={currency.format(totalActiveExpenses)} featured />
          <SummaryMetric label="Expense Entries" value={expenses.length} />
        </div>
        <div className="form-grid supplier-form-grid">
          <Field label="Expense Date"><input type="date" value={draft.expense_date} onChange={(event) => setDraft({ ...draft, expense_date: event.target.value })} /></Field>
          <Field label="Category">
            <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })}>
              {expenseCategories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </Field>
          <Field label="Amount"><input min="0" step="0.01" type="number" value={draft.amount} onChange={(event) => setDraft({ ...draft, amount: event.target.value })} /></Field>
          <Field label="Payment Mode">
            <select value={draft.payment_mode} onChange={(event) => setDraft({ ...draft, payment_mode: event.target.value })}>
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="BANK_TRANSFER">Bank</option>
            </select>
          </Field>
          <Field label="Reference Number"><input value={draft.reference_number} onChange={(event) => setDraft({ ...draft, reference_number: event.target.value })} /></Field>
          <Field label="Paid To / Vendor Name"><input value={draft.vendor_name} onChange={(event) => setDraft({ ...draft, vendor_name: event.target.value })} /></Field>
          <label className="check-field"><input checked={draft.active} type="checkbox" onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>Active</span></label>
          <Field label="Remarks"><textarea value={draft.remarks} onChange={(event) => setDraft({ ...draft, remarks: event.target.value })} /></Field>
        </div>
        <div className="button-row">
          <button className="primary-button" onClick={saveExpense}>{editingId ? "Update Expense" : "Save Expense"}</button>
          {editingId && <button className="secondary-button" onClick={() => { setEditingId(null); setDraft(emptyExpense); }}>Cancel Edit</button>}
        </div>
      </ModuleCard>
      <ModuleCard eyebrow="Expense Register" title="Recent Expenses" subtitle="Expense rows remain available for reporting and review.">
        <div className="ledger-toolbar">
          <Field label="Search"><input placeholder="Search category, paid to, reference" value={filters.search} onChange={(event) => setFilters({ ...filters, search: event.target.value })} /></Field>
          <Field label="Category">
            <select value={filters.category} onChange={(event) => setFilters({ ...filters, category: event.target.value })}>
              <option value="">All categories</option>
              {expenseCategories.map((category) => <option key={category} value={category}>{category}</option>)}
            </select>
          </Field>
          <Field label="Payment Mode">
            <select value={filters.payment_mode} onChange={(event) => setFilters({ ...filters, payment_mode: event.target.value })}>
              <option value="">All modes</option>
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="BANK_TRANSFER">Bank</option>
            </select>
          </Field>
          <Field label="Status">
            <select value={filters.status} onChange={(event) => setFilters({ ...filters, status: event.target.value })}>
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </Field>
          <Field label="From"><input type="date" value={filters.date_from} onChange={(event) => setFilters({ ...filters, date_from: event.target.value })} /></Field>
          <Field label="To"><input type="date" value={filters.date_to} onChange={(event) => setFilters({ ...filters, date_to: event.target.value })} /></Field>
          <button className="secondary-button" onClick={onReload}>Refresh</button>
        </div>
        <DataTable headers={["Date", "Category", "Vendor", "Mode", "Amount", "Status", "Reference", "Remarks", ""]}>
          {filteredExpenses.map((expense) => {
            const status = expense.status || (expense.active !== false ? "ACTIVE" : "CANCELLED");
            return (
            <tr className={status === "CANCELLED" ? "muted-row" : ""} key={expense.id}>
              <td>{expense.expense_date}</td>
              <td className="primary-cell">{expense.category}</td>
              <td>{expense.paid_to || expense.vendor_name || "-"}</td>
              <td><span className="tag">{expense.payment_mode}</span></td>
              <td>{currency.format(Number(expense.amount || 0))}</td>
              <td><span className={status === "ACTIVE" ? "stock-ok" : "stock-low"}>{status}</span></td>
              <td>{expense.reference_number || "-"}</td>
              <td>{expense.remarks || expense.cancellation_reason || "-"}</td>
              <td>
                <div className="button-row table-actions-row">
                  <button className="table-action" disabled={status === "CANCELLED"} onClick={() => editExpense(expense)}>Edit</button>
                  <button className="remove-button" disabled={status === "CANCELLED"} onClick={() => cancelExpense(expense)}>Cancel</button>
                </div>
              </td>
            </tr>
          );})}
        </DataTable>
        {filteredExpenses.length === 0 && <div className="cart-empty">No records found for selected filters.</div>}
      </ModuleCard>
    </section>
  );
}

function AccountsModule({ accounts, accountLedger, accountOutstanding, accountPayments, ledgerFocusKey, onLedgerLoad, onPaymentsLoad, onReload, user }) {
  const emptyAccount = {
    account_name: "",
    account_type: "CUSTOMER",
    firm_name: "",
    mobile_number: "",
    whatsapp_number: "",
    whatsapp_opt_in: true,
    alternate_number: "",
    address: "",
    city: "",
    gst_number: "",
    bank_name: "",
    account_number: "",
    ifsc_code: "",
    upi_id: "",
    opening_balance: "",
    active: true,
    notes: "",
  };
  const [tab, setTab] = useState(() => (["Owner", "Admin", "Purchase Manager"].includes(user.role) ? "master" : "payments"));
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState(emptyAccount);
  const [editingKey, setEditingKey] = useState("");
  const [ledgerMode, setLedgerMode] = useState("ANY");
  const [ledgerAccountKey, setLedgerAccountKey] = useState("");
  const [ledgerDateRange, setLedgerDateRange] = useState({ date_from: "", date_to: "" });
  const [payment, setPayment] = useState({
    payment_action: user.role === "Purchase Manager" ? "PAY_SUPPLIER" : "RECEIVE_CUSTOMER",
    account_key: "",
    payment_date: toDateKey(new Date()),
    amount: "",
    rebate_amount: "",
    payment_mode: "CASH",
    reference_number: "",
    remarks: "",
  });
  const [editingPaymentKey, setEditingPaymentKey] = useState("");
  const [paymentAudit, setPaymentAudit] = useState(null);
  const [receiptPayment, setReceiptPayment] = useState(null);
  const [ledgerExporting, setLedgerExporting] = useState(false);
  const [ledgerWhatsappOpen, setLedgerWhatsappOpen] = useState(false);
  const ledgerPrintRef = useRef(null);
  const canManageAllAccounts = ["Owner", "Admin"].includes(user.role);
  const canUseSupplierPayments = canManageAllAccounts || user.role === "Purchase Manager";
  const canUseCustomerPayments = canManageAllAccounts || user.role === "Cashier";
  const accountTabs = [
    ...(canManageAllAccounts || user.role === "Purchase Manager" ? [["master", "Account Master"]] : []),
    ["ledger", "Ledger"],
    ["payments", "Payments"],
    ...(canManageAllAccounts || user.role === "Purchase Manager" ? [["outstanding", "Outstanding"]] : []),
  ];
  const paymentActionOptions = accountPaymentActions.filter(([value]) =>
    value === "RECEIVE_CUSTOMER" ? canUseCustomerPayments : canUseSupplierPayments
  );
  const filteredAccounts = accounts.filter((account) =>
    account.account_name.toLowerCase().includes(search.toLowerCase()) ||
    String(account.mobile_number || "").includes(search)
  );
  const ledgerAccounts = accounts.filter((account) =>
    ledgerMode === "ANY" ||
    (ledgerMode === "CUSTOMER" && account.account_type === "CUSTOMER") ||
    (ledgerMode === "SUPPLIER" && ["SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(account.account_type))
  );
  const paymentAccounts = accounts.filter((account) =>
    payment.payment_action === "RECEIVE_CUSTOMER"
      ? account.account_type === "CUSTOMER"
      : ["SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(account.account_type)
  );
  const selectedPaymentAccount = accounts.find((account) => account.account_key === payment.account_key);
  const isSupplierPayment = payment.payment_action !== "RECEIVE_CUSTOMER";
  const paymentAmount = Number(payment.amount || 0);
  const rebateAmount = isSupplierPayment ? Number(payment.rebate_amount || 0) : 0;
  const outstandingBefore = selectedPaymentAccount
    ? Number(isSupplierPayment ? selectedPaymentAccount.payable_balance : selectedPaymentAccount.receivable_balance)
    : 0;
  const outstandingAfter = Math.max(0, roundUi(outstandingBefore - paymentAmount - rebateAmount));
  const selectedCustomerSummary = selectedPaymentAccount && selectedPaymentAccount.account_type === "CUSTOMER"
    ? {
      totalSales: Number(selectedPaymentAccount.total_sales || 0),
      totalPaid: Number(selectedPaymentAccount.total_paid || 0),
      outstanding: Number(selectedPaymentAccount.receivable_balance || 0),
    }
    : null;
  const selectedSupplierSummary = selectedPaymentAccount && isSupplierPayment
    ? {
      totalPurchases: Number(selectedPaymentAccount.total_purchases || 0),
      totalPaid: Number(selectedPaymentAccount.total_paid || 0),
      totalRebate: Number(selectedPaymentAccount.total_rebate_received || 0),
      outstanding: Number(selectedPaymentAccount.payable_balance || 0),
    }
    : null;
  const printableLedgerRows = (accountLedger.ledger || []).filter((row) =>
    (!ledgerDateRange.date_from || toDateKey(row.date) >= ledgerDateRange.date_from) &&
    (!ledgerDateRange.date_to || toDateKey(row.date) <= ledgerDateRange.date_to)
  );
  const exportLedgerPdf = async () => {
    if (!ledgerPrintRef.current) return;
    setLedgerExporting(true);
    try {
      await exportElementToPdf({
        element: ledgerPrintRef.current,
        fileName: `${accountLedger.account?.account_name || "Account_Ledger"}_${formatFileDate(ledgerDateRange.date_from || "all")}_to_${formatFileDate(ledgerDateRange.date_to || toDateKey(new Date()))}.pdf`,
        mode: "A4",
      });
    } catch (error) {
      alert(`Unable to export ledger PDF: ${error.message}`);
    } finally {
      setLedgerExporting(false);
    }
  };
  const ledgerDocumentName = `FroozERP_Ledger_${safeFileName(accountLedger.account?.account_name || accountLedger.account?.customer_name || accountLedger.account?.supplier_name || "Account")}_${formatFileDate(ledgerDateRange.date_from || "all")}_to_${formatFileDate(ledgerDateRange.date_to || toDateKey(new Date()))}.pdf`;
  const ledgerWhatsappRecipients = useMemo(() => buildWhatsappRecipients({
    accounts: accountLedger.account ? [{
      ...accountLedger.account,
      source_id: accountLedger.account.source_id || accountLedger.account.id,
      account_name: accountLedger.account.account_name || accountLedger.account.customer_name || accountLedger.account.supplier_name,
    }] : [],
  }), [accountLedger.account]);
  const generateLedgerWhatsappPdf = async () => {
    if (!ledgerPrintRef.current) throw new Error("Select an account ledger first");
    return exportElementToPdf({
      element: ledgerPrintRef.current,
      fileName: ledgerDocumentName,
      mode: "A4",
      save: false,
    });
  };

  const saveAccount = async () => {
    try {
      const payload = { ...draft, opening_balance: Number(draft.opening_balance || 0) };
      const normalizedName = payload.account_name.trim().toLowerCase();
      const normalizedMobile = String(payload.mobile_number || "");
      const normalizedFirm = String(payload.firm_name || "").trim().toLowerCase();
      const duplicate = accounts.find((account) => {
        if (account.account_key === editingKey) return false;
        if (payload.account_type === "CUSTOMER") {
          return account.account_type === "CUSTOMER" &&
            account.account_name.trim().toLowerCase() === normalizedName &&
            String(account.mobile_number || "") === normalizedMobile;
        }
        if (["SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(payload.account_type)) {
          return ["SUPPLIER", "TRANSPORT_VENDOR", "COMMISSION_AGENT"].includes(account.account_type) &&
            (account.account_name.trim().toLowerCase() === normalizedName ||
              (normalizedFirm && String(account.firm_name || "").trim().toLowerCase() === normalizedFirm));
        }
        return false;
      });
      if (duplicate) {
        alert(payload.account_type === "CUSTOMER" ? "This customer already exists." : "This supplier already exists.");
        return;
      }
      if (editingKey) await axios.put(`${API_URL}/accounts/${editingKey}`, payload);
      else await axios.post(`${API_URL}/accounts`, payload);
      setDraft(emptyAccount);
      setEditingKey("");
      await onReload();
      alert(editingKey ? "Account updated" : "Account saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save account"));
    }
  };
  const editAccount = (account) => {
    setEditingKey(account.account_key);
    setDraft({
      account_name: account.account_name || "",
      account_type: account.account_type || "OTHER",
      firm_name: account.firm_name || "",
      mobile_number: account.mobile_number || "",
      whatsapp_number: account.whatsapp_number || "",
      whatsapp_opt_in: account.whatsapp_opt_in !== false,
      alternate_number: account.alternate_number || "",
      address: account.address || "",
      city: account.city || "",
      gst_number: account.gst_number || "",
      bank_name: account.bank_name || "",
      account_number: account.account_number || "",
      ifsc_code: account.ifsc_code || "",
      upi_id: account.upi_id || "",
      opening_balance: account.opening_balance || "",
      active: account.active !== false,
      notes: account.notes || "",
    });
    setTab("master");
  };
  const loadLedger = async (accountKey) => {
    setLedgerAccountKey(accountKey);
    await onLedgerLoad(accountKey);
  };

  useEffect(() => {
    if (!ledgerFocusKey) return;
    setTab("ledger");
    setLedgerMode(ledgerFocusKey.startsWith("SUPPLIER-") ? "SUPPLIER" : "ANY");
    setLedgerAccountKey(ledgerFocusKey);
  }, [ledgerFocusKey]);
  const savePayment = async () => {
    try {
      const payload = {
        ...payment,
        amount: Number(payment.amount || 0),
        payment_amount: Number(payment.amount || 0),
        rebate_amount: isSupplierPayment ? Number(payment.rebate_amount || 0) : 0,
        branch_id: user.branch_id,
        created_by: user.id,
        edited_by: user.id,
      };
      let response;
      if (editingPaymentKey) {
        const reason = window.prompt("Enter reason for editing this payment");
        if (!reason) return;
        response = await axios.put(`${API_URL}/accounts/payments/${editingPaymentKey}`, { ...payload, reason });
      } else {
        response = await axios.post(`${API_URL}/accounts/payments`, payload);
      }
      setReceiptPayment({
        ...response.data,
        payment_key: editingPaymentKey || `${isSupplierPayment ? "SUPPLIER" : "CUSTOMER"}-${response.data.id}`,
        payment_source: isSupplierPayment ? "SUPPLIER" : "CUSTOMER",
        account_key: payment.account_key,
        account_name: selectedPaymentAccount?.account_name,
        account_type: selectedPaymentAccount?.account_type,
        outstanding_before: outstandingBefore,
        outstanding_after: outstandingAfter,
        mobile_number: selectedPaymentAccount?.whatsapp_number || selectedPaymentAccount?.mobile_number,
        whatsapp_number: selectedPaymentAccount?.whatsapp_number,
        whatsapp_opt_in: selectedPaymentAccount?.whatsapp_opt_in,
      });
      setEditingPaymentKey("");
      setPayment((current) => ({ ...current, amount: "", rebate_amount: "", reference_number: "", remarks: "" }));
      await onReload();
      alert(editingPaymentKey ? "Payment updated" : "Payment saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save payment"));
    }
  };
  const editPayment = (row) => {
    setEditingPaymentKey(row.payment_key);
    setPayment({
      payment_action: row.payment_source === "CUSTOMER" ? "RECEIVE_CUSTOMER" : "PAY_SUPPLIER",
      account_key: row.account_key,
      payment_date: toDateKey(row.payment_date),
      amount: row.payment_amount || "",
      rebate_amount: row.rebate_amount || "",
      payment_mode: row.payment_mode || "CASH",
      reference_number: row.reference_number || "",
      remarks: row.remarks || "",
    });
    setTab("payments");
  };
  const cancelPayment = async (row) => {
    const reason = window.prompt(`Enter cancellation reason for ${row.account_name} payment`);
    if (!reason) return;
    try {
      await axios.post(`${API_URL}/accounts/payments/${row.payment_key}/cancel`, { reason, cancelled_by: user.id });
      await onReload();
      alert("Payment cancelled");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to cancel payment"));
    }
  };
  const viewPaymentHistory = async (row) => {
    try {
      const response = await axios.get(`${API_URL}/accounts/payments/${row.payment_key}/audit`);
      setPaymentAudit({ payment: row, rows: response.data });
    } catch (error) {
      alert(getErrorMessage(error, "Unable to load payment history"));
    }
  };
  const refreshPaymentsForSelection = async (accountKey) => {
    setPayment({ ...payment, account_key: accountKey });
    await onPaymentsLoad(accountKey);
  };

  return (
    <section className="settings-layout">
      <section className="settings-banner">
        <div>
          <span className="eyebrow">Unified Accounts</span>
          <h2>Accounts</h2>
          <p>Customers, suppliers, vendors, staff and other account ledgers in one workspace.</p>
        </div>
      </section>
      <div className="account-tabs">
        {accountTabs.map(([value, label]) => (
          <button className={tab === value ? "account-tab account-tab-active" : "account-tab"} key={value} onClick={() => setTab(value)}>{label}</button>
        ))}
      </div>

      {tab === "master" && (
        <>
          <ModuleCard eyebrow="Account Master" title="Create / Edit Account" subtitle="Use account type to control purchase, POS, ledger and payment behavior.">
            <div className="form-grid supplier-form-grid">
              <Field label="Account Type">
                <select value={draft.account_type} onChange={(event) => setDraft({ ...draft, account_type: event.target.value })}>
                  {accountTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </Field>
              <Field label="Account Name"><input value={draft.account_name} onChange={(event) => setDraft({ ...draft, account_name: event.target.value })} /></Field>
              <Field label="Firm Name"><input value={draft.firm_name} onChange={(event) => setDraft({ ...draft, firm_name: event.target.value })} /></Field>
              <Field label="Mobile"><input value={draft.mobile_number} onChange={(event) => setDraft({ ...draft, mobile_number: event.target.value.replace(/\D/g, "") })} /></Field>
              <Field label="WhatsApp Number"><input placeholder="Blank uses mobile number" value={draft.whatsapp_number} onChange={(event) => setDraft({ ...draft, whatsapp_number: event.target.value.replace(/[^\d+]/g, "") })} /></Field>
              <label className="check-field"><input checked={draft.whatsapp_opt_in !== false} type="checkbox" onChange={(event) => setDraft({ ...draft, whatsapp_opt_in: event.target.checked })} /><span>WhatsApp Opt-in</span></label>
              <Field label="Alternate Number"><input value={draft.alternate_number} onChange={(event) => setDraft({ ...draft, alternate_number: event.target.value.replace(/\D/g, "") })} /></Field>
              <Field label="City"><input value={draft.city} onChange={(event) => setDraft({ ...draft, city: event.target.value })} /></Field>
              <Field label="GST Number"><input value={draft.gst_number} onChange={(event) => setDraft({ ...draft, gst_number: event.target.value })} /></Field>
              <Field label="Bank Name"><input value={draft.bank_name} onChange={(event) => setDraft({ ...draft, bank_name: event.target.value })} /></Field>
              <Field label="Account Number"><input value={draft.account_number} onChange={(event) => setDraft({ ...draft, account_number: event.target.value })} /></Field>
              <Field label="IFSC"><input value={draft.ifsc_code} onChange={(event) => setDraft({ ...draft, ifsc_code: event.target.value })} /></Field>
              <Field label="UPI ID"><input value={draft.upi_id} onChange={(event) => setDraft({ ...draft, upi_id: event.target.value })} /></Field>
              <Field label="Opening Balance"><input min="0" step="0.01" type="number" value={draft.opening_balance} onChange={(event) => setDraft({ ...draft, opening_balance: event.target.value })} /></Field>
              <label className="check-field"><input checked={draft.active} type="checkbox" onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>Active</span></label>
              <Field label="Address"><textarea value={draft.address} onChange={(event) => setDraft({ ...draft, address: event.target.value })} /></Field>
              <Field label="Notes"><textarea value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></Field>
            </div>
            <div className="button-row">
              <button className="primary-button" onClick={saveAccount}>{editingKey ? "Update Account" : "Add Account"}</button>
              {editingKey && <button className="secondary-button" onClick={() => { setDraft(emptyAccount); setEditingKey(""); }}>Cancel Edit</button>}
            </div>
          </ModuleCard>
          <ModuleCard eyebrow="Account List" title="All Accounts" subtitle="Inactive accounts remain in history and can be reactivated.">
            <div className="ledger-toolbar">
              <Field label="Search"><input placeholder="Search account or mobile" value={search} onChange={(event) => setSearch(event.target.value)} /></Field>
              <button className="secondary-button" onClick={onReload}>Refresh</button>
            </div>
            <DataTable headers={["Account", "Type", "Mobile", "Opening", "Receivable", "Payable", "Status", ""]}>
              {filteredAccounts.map((account) => (
                <tr key={account.account_key}>
                  <td className="primary-cell">
                    {account.account_name}
                    <small className="cell-note">{account.system_account ? "System Account" : account.firm_name || account.city || account.address || "-"}</small>
                  </td>
                  <td><span className="tag">{account.account_type}</span></td>
                  <td>{account.mobile_number || "-"}</td>
                  <td>{currency.format(Number(account.opening_balance || 0))}</td>
                  <td>{currency.format(Number(account.receivable_balance || 0))}</td>
                  <td>{currency.format(Number(account.payable_balance || 0))}</td>
                  <td><span className={account.active !== false ? "stock-ok" : "stock-low"}>{account.active !== false ? "Active" : "Inactive"}</span></td>
                  <td><button className="table-action" disabled={account.system_account === true} onClick={() => editAccount(account)}>{account.system_account ? "Protected" : "Edit"}</button></td>
                </tr>
              ))}
            </DataTable>
          </ModuleCard>
        </>
      )}

      {tab === "ledger" && (
        <ModuleCard eyebrow="Ledger" title="Account Ledger" subtitle="Select customer, supplier or any account to review debit, credit and balance.">
          <div className="ledger-toolbar">
            <Field label="Ledger Type">
              <select value={ledgerMode} onChange={(event) => setLedgerMode(event.target.value)}>
                {ledgerModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Account">
              <select value={ledgerAccountKey} onChange={(event) => loadLedger(event.target.value)}>
                <option value="">Select account</option>
                {ledgerAccounts.map((account) => <option key={account.account_key} value={account.account_key}>{account.account_name} - {account.account_type}</option>)}
              </select>
            </Field>
            <button className="secondary-button" onClick={() => loadLedger(ledgerAccountKey)}>Refresh Ledger</button>
          </div>
          <div className="ledger-toolbar">
            <Field label="Statement From"><input type="date" value={ledgerDateRange.date_from} onChange={(event) => setLedgerDateRange({ ...ledgerDateRange, date_from: event.target.value })} /></Field>
            <Field label="Statement To"><input type="date" value={ledgerDateRange.date_to} onChange={(event) => setLedgerDateRange({ ...ledgerDateRange, date_to: event.target.value })} /></Field>
            <button className="secondary-button" onClick={() => window.print()}><Icon name="print" /> Print Statement</button>
            <button className="secondary-button" disabled={ledgerExporting} onClick={exportLedgerPdf}>{ledgerExporting ? "Exporting..." : "PDF Export"}</button>
            <button className="whatsapp-button" disabled={!accountLedger.account || ledgerExporting} onClick={() => setLedgerWhatsappOpen(true)}><Icon name="message" /> WhatsApp</button>
          </div>
          <div ref={ledgerPrintRef} className="print-area report-paper">
            <header className="report-print-header">
              <BrandLogo invoice />
              <div>
                <strong>{accountLedger.account?.account_name || accountLedger.account?.supplier_name || accountLedger.account?.customer_name || "Account Ledger"}</strong>
                <span>Ledger Statement</span>
              </div>
            </header>
            <div className="purchase-summary-grid supplier-payment-preview">
              <SummaryMetric label="Opening Balance" value={currency.format(Number(printableLedgerRows[0]?.balance || 0) - Number(printableLedgerRows[0]?.debit || 0) + Number(printableLedgerRows[0]?.credit || 0))} />
              <SummaryMetric label="Closing Balance" value={currency.format(Number(printableLedgerRows.at(-1)?.balance || 0))} featured />
            </div>
            <DataTable headers={["Date", "Invoice Number", "Transaction Type", "Sale Amount", "Payment Mode", "Debit", "Credit", "Balance", "Narration"]}>
              {printableLedgerRows.map((row, index) => (
                <tr key={`${row.date}-${row.transaction_type}-${index}`}>
                  <td>{row.date}</td>
                  <td>{row.invoice_no || "-"}</td>
                  <td><span className="tag">{row.transaction_type}</span></td>
                  <td>{row.sale_amount ? currency.format(Number(row.sale_amount || 0)) : "-"}</td>
                  <td>{row.payment_mode || "-"}</td>
                  <td>{currency.format(Number(row.debit || 0))}</td>
                  <td>{currency.format(Number(row.credit || 0))}</td>
                  <td className="balance-cell">{currency.format(Number(row.balance || 0))}</td>
                  <td>{row.remarks || "-"}</td>
                </tr>
              ))}
            </DataTable>
          </div>
          {ledgerWhatsappOpen && (
            <WhatsAppSendModal
              caption={`FroozERP ledger statement for ${accountLedger.account?.account_name || accountLedger.account?.customer_name || accountLedger.account?.supplier_name || "account"}.`}
              documentName={ledgerDocumentName}
              generatePdf={generateLedgerWhatsappPdf}
              onClose={() => setLedgerWhatsappOpen(false)}
              recipients={ledgerWhatsappRecipients}
              sourceId={ledgerAccountKey}
              sourceType="ledger"
              title="Send Ledger via WhatsApp"
              user={user}
            />
          )}
        </ModuleCard>
      )}

      {tab === "payments" && (
        <ModuleCard eyebrow="Payments" title="Account Payments" subtitle="Receive customer payments, pay suppliers, or record supplier rebates.">
          <div className="purchase-summary-grid supplier-payment-preview">
            {selectedSupplierSummary ? (
              <>
                <SummaryMetric label="Total Purchase" value={currency.format(selectedSupplierSummary.totalPurchases)} />
                <SummaryMetric label="Total Paid" value={currency.format(selectedSupplierSummary.totalPaid)} />
                <SummaryMetric label="Total Rebate Received" value={currency.format(selectedSupplierSummary.totalRebate)} positive />
                <SummaryMetric label="Outstanding Payable" value={currency.format(selectedSupplierSummary.outstanding)} featured />
              </>
            ) : selectedCustomerSummary ? (
              <>
                <SummaryMetric label="Total Sales" value={currency.format(selectedCustomerSummary.totalSales)} />
                <SummaryMetric label="Total Received" value={currency.format(selectedCustomerSummary.totalPaid)} />
                <SummaryMetric label="Outstanding Receivable" value={currency.format(selectedCustomerSummary.outstanding)} featured />
                <SummaryMetric label="Account Type" value="Customer" />
              </>
            ) : (
              <>
                <SummaryMetric label="Selected Account" value="None" />
                <SummaryMetric label="Outstanding Before" value={currency.format(0)} />
                <SummaryMetric label="Payment Impact" value={currency.format(0)} />
                <SummaryMetric label="Outstanding After" value={currency.format(0)} featured />
              </>
            )}
          </div>
          <div className="form-grid">
            <Field label="Payment Action">
              <select value={payment.payment_action} onChange={(event) => setPayment({ ...payment, payment_action: event.target.value, account_key: "", rebate_amount: "" })}>
                {paymentActionOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Account">
              <select value={payment.account_key} onChange={(event) => refreshPaymentsForSelection(event.target.value)}>
                <option value="">Select account</option>
                {paymentAccounts.map((account) => <option key={account.account_key} value={account.account_key}>{account.account_name} - {account.account_type}</option>)}
              </select>
            </Field>
            <Field label="Payment Date"><input type="date" value={payment.payment_date} onChange={(event) => setPayment({ ...payment, payment_date: event.target.value })} /></Field>
            <Field label={isSupplierPayment ? "Payment Amount" : "Payment Amount / Receipt"}><input min="0" step="0.01" type="number" value={payment.amount} onChange={(event) => setPayment({ ...payment, amount: event.target.value })} /></Field>
            {isSupplierPayment && <Field label="Rebate Received"><input min="0" step="0.01" type="number" value={payment.rebate_amount} onChange={(event) => setPayment({ ...payment, rebate_amount: event.target.value })} /></Field>}
            <Field label="Payment Mode">
              <select value={payment.payment_mode} onChange={(event) => setPayment({ ...payment, payment_mode: event.target.value })}>
                {supplierPaymentModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Reference Number"><input value={payment.reference_number} onChange={(event) => setPayment({ ...payment, reference_number: event.target.value })} /></Field>
            <Field label="Remarks"><textarea value={payment.remarks} onChange={(event) => setPayment({ ...payment, remarks: event.target.value })} /></Field>
          </div>
          <div className="purchase-summary-grid supplier-payment-preview">
            <SummaryMetric label={isSupplierPayment ? "Outstanding Payable Before" : "Outstanding Receivable Before"} value={currency.format(outstandingBefore)} />
            <SummaryMetric label="Payment Amount" value={currency.format(paymentAmount)} />
            {isSupplierPayment && <SummaryMetric label="Rebate Received" value={currency.format(rebateAmount)} positive />}
            <SummaryMetric label="Balance After Payment" value={currency.format(outstandingAfter)} featured />
          </div>
          <div className="button-row">
            <button className="primary-button" onClick={savePayment}>{editingPaymentKey ? "Update Payment" : "Save Payment"}</button>
            {editingPaymentKey && <button className="secondary-button" onClick={() => { setEditingPaymentKey(""); setPayment({ payment_action: "RECEIVE_CUSTOMER", account_key: "", payment_date: toDateKey(new Date()), amount: "", rebate_amount: "", payment_mode: "CASH", reference_number: "", remarks: "" }); }}>Cancel Edit</button>}
          </div>
          <div className="ledger-toolbar">
            <button className="secondary-button" onClick={() => onPaymentsLoad(payment.account_key)}>Refresh Payment History</button>
            <button className="secondary-button" onClick={() => onPaymentsLoad()}>Show All Payments</button>
          </div>
          <DataTable headers={["Date", "Party", "Type", "Payment", "Rebate", "Mode", "Status", "Reference", "Remarks", "Actions"]}>
            {(accountPayments || []).map((row) => (
              <tr key={row.payment_key}>
                <td>{toDateKey(row.payment_date)}</td>
                <td className="primary-cell">{row.account_name}</td>
                <td><span className="tag">{row.payment_source}</span></td>
                <td>{currency.format(Number(row.payment_amount || 0))}</td>
                <td>{Number(row.rebate_amount || 0) ? currency.format(Number(row.rebate_amount || 0)) : "-"}</td>
                <td><span className="tag">{row.payment_mode}</span></td>
                <td><span className={row.cancelled ? "stock-low" : "stock-ok"}>{row.cancelled ? "Cancelled" : "Active"}</span></td>
                <td>{row.reference_number || "-"}</td>
                <td>{row.cancellation_reason || row.edit_reason || row.remarks || "-"}</td>
                <td className="table-actions-row">
                  <button className="table-action" disabled={row.cancelled} onClick={() => editPayment(row)}>Edit</button>
                  <button className="remove-button" disabled={row.cancelled} onClick={() => cancelPayment(row)}>Cancel</button>
                  <button className="table-action" onClick={() => viewPaymentHistory(row)}>History</button>
                  <button className="table-action" onClick={() => setReceiptPayment(row)}>Print</button>
                </td>
              </tr>
            ))}
          </DataTable>
        </ModuleCard>
      )}

      {tab === "outstanding" && (
        <ModuleCard eyebrow="Outstanding" title="Receivable and Payable Summary" subtitle="Customer outstanding and supplier outstanding in one place.">
          <div className="purchase-summary-grid supplier-payment-preview">
            <SummaryMetric label="Total Receivable" value={currency.format(Number(accountOutstanding.totalReceivable || 0))} featured />
            <SummaryMetric label="Total Payable" value={currency.format(Number(accountOutstanding.totalPayable || 0))} featured />
            <SummaryMetric label="Customer Accounts" value={(accountOutstanding.customerOutstanding || []).length} />
            <SummaryMetric label="Supplier Accounts" value={(accountOutstanding.supplierOutstanding || []).length} />
          </div>
          <DataTable headers={["Account", "Type", "Receivable", "Payable", "Status"]}>
            {[...(accountOutstanding.customerOutstanding || []), ...(accountOutstanding.supplierOutstanding || [])].map((account) => (
              <tr key={account.account_key}>
                <td className="primary-cell">{account.account_name}</td>
                <td><span className="tag">{account.account_type}</span></td>
                <td>{currency.format(Number(account.receivable_balance || 0))}</td>
                <td>{currency.format(Number(account.payable_balance || 0))}</td>
                <td><span className={account.active !== false ? "stock-ok" : "stock-low"}>{account.active !== false ? "Active" : "Inactive"}</span></td>
              </tr>
            ))}
          </DataTable>
        </ModuleCard>
      )}
      {receiptPayment && <PaymentReceiptModal payment={receiptPayment} onClose={() => setReceiptPayment(null)} user={user} />}
      {paymentAudit && <PaymentAuditModal audit={paymentAudit} onClose={() => setPaymentAudit(null)} />}
    </section>
  );
}

function SettingsModule({
  applicationFontSize,
  backendHealth,
  canManage,
  cloudDeviceRegistration,
  cloudDiagnostics,
  cloudHealth,
  connectionStatus,
  localBackendService,
  localDbStatus,
  onCheckConnection,
  onQueueSyncTest,
  onReload,
  onRetrySync,
  onRunCloudDiagnostics,
  onRunSync,
  rules,
  settingsData,
  setApplicationFontSize,
  syncMessage,
  syncStatus,
  user,
}) {
  return (
    <section className="settings-layout">
      <section className="settings-banner">
        <div>
          <span className="eyebrow">System Controls</span>
          <h2>Settings</h2>
          <p>{canManage ? "Owner/Admin controls are active." : "Read-only access. Owner/Admin approval is required for changes."}</p>
        </div>
        <span className={canManage ? "stock-ok" : "stock-low"}>{canManage ? "Manager Access" : "Read Only"}</span>
      </section>
      <AppearanceAccessibilitySettings applicationFontSize={applicationFontSize} setApplicationFontSize={setApplicationFontSize} />
      <BusinessSettingsSection businessSettings={settingsData.businessSettings} canManage={canManage} key={settingsData.businessSettings?.updated_at || "business-settings"} onReload={onReload} user={user} />
      <PosSettingsSection canManage={canManage} key={settingsData.posSettings?.updated_at || "pos-settings"} onReload={onReload} posSettings={settingsData.posSettings} user={user} />
      <PaymentSettingsSection canManage={canManage} key={settingsData.paymentSettings?.updated_at || "payment-settings"} onReload={onReload} paymentSettings={settingsData.paymentSettings} user={user} />
      <WhatsAppSettingsSection canManage={canManage} key={settingsData.whatsappSettings?.updated_at || "whatsapp-settings"} onReload={onReload} user={user} whatsappSettings={settingsData.whatsappSettings} />
      <MandiTaxSettings canManage={canManage} onReload={onReload} rules={rules.mandiTaxRules} user={user} />
      <RebateSettings canManage={canManage} onReload={onReload} rules={rules.rebateRules} user={user} />
      <SaleRateSettingsSection canManage={canManage} key={settingsData.saleRateSettings?.updated_at || "sale-rate-settings"} onReload={onReload} saleRateSettings={settingsData.saleRateSettings} user={user} />
      <DiscountSettings canManage={canManage} discountRules={settingsData.discountRules} onReload={onReload} saleRateSettings={settingsData.saleRateSettings} user={user} />
      <PermissionSettings canManage={canManage} key={JSON.stringify(settingsData.roles || [])} onReload={onReload} roles={settingsData.roles} user={user} />
      <UserManagementSection canManage={canManage} key={JSON.stringify(settingsData.users || [])} onReload={onReload} roles={settingsData.roles} user={user} users={settingsData.users || []} />
      <DeviceControlSettingsSection canManage={canManage} deviceControlSettings={settingsData.deviceControlSettings} exitAttemptLogs={settingsData.exitAttemptLogs || []} onReload={onReload} user={user} />
      <SecurityDevicesSection activationCodes={settingsData.activationCodes || []} branches={settingsData.branches || []} canManage={canManage} counters={settingsData.counters || []} devices={settingsData.authorizedDevices || []} onReload={onReload} user={user} />
      <BranchCounterSettings branches={settingsData.branches || []} canManage={canManage} counters={settingsData.counters || []} onReload={onReload} user={user} />
      <UpdateCenterSection canManage={canManage} key={settingsData.updateCenter?.updated_at || "update-center"} onReload={onReload} updateCenter={settingsData.updateCenter} user={user} />
      <SyncSettingsSection
        backendHealth={backendHealth}
        canManage={canManage}
        cloudDeviceRegistration={cloudDeviceRegistration || null}
        cloudDiagnostics={cloudDiagnostics || null}
        cloudHealth={cloudHealth || null}
        connectionStatus={connectionStatus}
        localBackendService={localBackendService || null}
        key={settingsData.syncSettings?.updated_at || "sync-settings"}
        localDbStatus={localDbStatus}
        onCheckConnection={onCheckConnection}
        onQueueSyncTest={onQueueSyncTest}
        onReload={onReload}
        onRetrySync={onRetrySync}
        onRunCloudDiagnostics={onRunCloudDiagnostics}
        onRunSync={onRunSync}
        syncMessage={syncMessage}
        settingsData={settingsData}
        syncSettings={settingsData.syncSettings}
        syncStatus={syncStatus}
        user={user}
      />
      <BackupSettings backupLogs={settingsData.backupLogs || []} backupSettings={settingsData.backupSettings} canManage={canManage} onReload={onReload} user={user} />
      <SystemInfoSection systemInfo={settingsData.systemInfo || {}} />
    </section>
  );
}

function AppearanceAccessibilitySettings({ applicationFontSize, setApplicationFontSize }) {
  const selected = applicationFontSizeOptions.find((option) => option.value === applicationFontSize) || applicationFontSizeOptions[1];
  return (
    <ModuleCard eyebrow="Appearance / Accessibility" title="Display Typography" subtitle="Device-local display preference. This changes the app UI only; invoices and report print typography stay on their own print profiles.">
      <div className="form-grid supplier-form-grid">
        <Field label="Application Font Size">
          <select value={selected.value} onChange={(event) => setApplicationFontSize(normalizeApplicationFontSize(event.target.value))}>
            {applicationFontSizeOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label} - {option.scale}</option>
            ))}
          </select>
        </Field>
        <div className="accessibility-preview-card">
          <span>Current Scale</span>
          <strong>{selected.label}</strong>
          <small>{selected.scale}. Applied immediately on this device and remembered after restart.</small>
        </div>
      </div>
    </ModuleCard>
  );
}

function BusinessSettingsSection({ businessSettings, canManage, onReload, user }) {
  const [draft, setDraft] = useState({ ...defaultBusinessSettings, ...businessSettings });
  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/business`, { ...draft, updated_by: user.id });
      await onReload();
      alert("Business settings updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update business settings"));
    }
  };

  return (
    <ModuleCard eyebrow="Business Settings" title="Business Identity" subtitle="Invoice and application identity details for the retail operation.">
      <div className="form-grid supplier-form-grid">
        <Field label="Business Name"><input disabled={!canManage} value={draft.business_name || ""} onChange={(event) => updateDraft("business_name", event.target.value)} /></Field>
        <Field label="Brand Name"><input disabled={!canManage} value={draft.brand_name || ""} onChange={(event) => updateDraft("brand_name", event.target.value)} /></Field>
        <Field label="Company Name"><input disabled={!canManage} value={draft.company_name || ""} onChange={(event) => updateDraft("company_name", event.target.value)} /></Field>
        <Field label="Phone Number"><input disabled={!canManage} value={draft.phone_number || ""} onChange={(event) => updateDraft("phone_number", event.target.value)} /></Field>
        <Field label="GST Number"><input disabled={!canManage} value={draft.gst_number || ""} onChange={(event) => updateDraft("gst_number", event.target.value)} /></Field>
        <Field label="Logo URL / Path"><input disabled={!canManage} value={draft.logo_url || ""} onChange={(event) => updateDraft("logo_url", event.target.value)} /></Field>
        <Field label="Compact Logo Text"><input disabled={!canManage} value={draft.compact_logo_text || ""} onChange={(event) => updateDraft("compact_logo_text", event.target.value)} /></Field>
        <Field label="Default Printer Type">
          <select disabled={!canManage} value={draft.default_printer_type || "THERMAL"} onChange={(event) => updateDraft("default_printer_type", event.target.value)}>
            <option value="THERMAL">Thermal 80mm / 58mm</option>
            <option value="A4">A4</option>
          </select>
        </Field>
        <Field label="Default Invoice Print">
          <select disabled={!canManage} value={draft.default_invoice_print || "THERMAL_RECEIPT"} onChange={(event) => updateDraft("default_invoice_print", event.target.value)}>
            <option value="A4_INVOICE">A4 Invoice</option>
            <option value="THERMAL_RECEIPT">Thermal Receipt</option>
          </select>
        </Field>
        <Field label="Default Report Print">
          <select disabled={!canManage} value={draft.default_report_print || "A4_REPORT"} onChange={(event) => updateDraft("default_report_print", event.target.value)}>
            <option value="A4_REPORT">A4 Report</option>
          </select>
        </Field>
        <Field label="Receipt Width">
          <select disabled={!canManage} value={draft.receipt_width || "80MM"} onChange={(event) => updateDraft("receipt_width", event.target.value)}>
            <option value="58MM">58mm</option>
            <option value="80MM">80mm</option>
          </select>
        </Field>
        <label className="check-field"><input checked={draft.auto_print_after_billing === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("auto_print_after_billing", event.target.checked)} /><span>Auto print after billing</span></label>
        <label className="check-field"><input checked={draft.show_print_preview_before_print !== false} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("show_print_preview_before_print", event.target.checked)} /><span>Show print preview before print</span></label>
        <label className="check-field"><input checked={draft.show_item_discount_column_pos !== false} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("show_item_discount_column_pos", event.target.checked)} /><span>Show Item Discount Column on POS</span></label>
        <label className="check-field"><input checked={draft.show_item_discount_column_receipt !== false} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("show_item_discount_column_receipt", event.target.checked)} /><span>Show Item Discount Column on Receipt</span></label>
        <label className="check-field"><input checked={draft.show_bill_discount_row_receipt !== false} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("show_bill_discount_row_receipt", event.target.checked)} /><span>Show Bill Discount Row on Receipt</span></label>
        <label className="check-field"><input checked={draft.hide_zero_discount_rows !== false} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("hide_zero_discount_rows", event.target.checked)} /><span>Hide Zero Discount Rows</span></label>
        <Field label="Address"><textarea disabled={!canManage} value={draft.address || ""} onChange={(event) => updateDraft("address", event.target.value)} /></Field>
        <Field label="Invoice Footer Text"><textarea disabled={!canManage} value={draft.invoice_footer_text || ""} onChange={(event) => updateDraft("invoice_footer_text", event.target.value)} /></Field>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={save}>Save Business Settings</button>
    </ModuleCard>
  );
}

function PosSettingsSection({ canManage, onReload, posSettings, user }) {
  const [draft, setDraft] = useState({ ...defaultPosSettings, ...posSettings });
  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/pos`, { ...draft, updated_by: user.id });
      await onReload();
      alert("POS settings updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update POS settings"));
    }
  };
  return (
    <ModuleCard eyebrow="POS Settings" title="Weighing Scale Integration" subtitle="Hardware integration foundation for USB, serial, Bluetooth and manual fallback billing.">
      <div className="form-grid supplier-form-grid">
        <label className="check-field"><input checked={draft.enable_weighing_scale === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("enable_weighing_scale", event.target.checked)} /><span>Enable weighing scale mode</span></label>
        <Field label="Connection Type">
          <select disabled={!canManage} value={draft.scale_connection_type || "MANUAL_FALLBACK"} onChange={(event) => updateDraft("scale_connection_type", event.target.value)}>
            <option value="USB">USB</option>
            <option value="SERIAL">Serial</option>
            <option value="BLUETOOTH">Bluetooth</option>
            <option value="MANUAL_FALLBACK">Manual Fallback</option>
          </select>
        </Field>
        <Field label="COM Port"><input disabled={!canManage} placeholder="Example: COM3" value={draft.scale_com_port || ""} onChange={(event) => updateDraft("scale_com_port", event.target.value)} /></Field>
        <Field label="Baud Rate"><input disabled={!canManage} min="1" type="number" value={draft.scale_baud_rate || 9600} onChange={(event) => updateDraft("scale_baud_rate", event.target.value)} /></Field>
        <label className="check-field"><input checked={draft.scale_auto_read === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("scale_auto_read", event.target.checked)} /><span>Auto-read weight when hardware support is available</span></label>
      </div>
      <p className="form-note">Browser-based hardware reading is prepared but not enabled until a supported local bridge or Web Serial workflow is connected. Manual quantity entry remains available.</p>
      <button className="primary-button" disabled={!canManage} onClick={save}>Save POS Settings</button>
    </ModuleCard>
  );
}

function PaymentSettingsSection({ canManage, onReload, paymentSettings, user }) {
  const [draft, setDraft] = useState({ ...defaultPaymentSettings, ...paymentSettings });
  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/payment`, { ...draft, updated_by: user.id });
      await onReload();
      alert("Payment settings updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update payment settings"));
    }
  };
  return (
    <ModuleCard eyebrow="Payment & Tax Settings" title="UPI, Payment QR and Sales Mandi Tax" subtitle="Configure invoice payment QR and registered-customer Mandi Tax rules used by POS, print, PDF and WhatsApp exports.">
      <div className="form-grid supplier-form-grid">
        <Field label="Business UPI ID"><input disabled={!canManage} placeholder="name@bank" value={draft.business_upi_id || ""} onChange={(event) => updateDraft("business_upi_id", event.target.value)} /></Field>
        <Field label="Payee Name"><input disabled={!canManage} value={draft.upi_payee_name || ""} onChange={(event) => updateDraft("upi_payee_name", event.target.value)} /></Field>
        <Field label="QR Display Size">
          <select disabled={!canManage} value={draft.qr_display_size || "MEDIUM"} onChange={(event) => updateDraft("qr_display_size", event.target.value)}>
            <option value="SMALL">Small</option>
            <option value="MEDIUM">Medium</option>
            <option value="LARGE">Large</option>
          </select>
        </Field>
        <label className="check-field"><input checked={draft.enable_upi_qr_on_invoice === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("enable_upi_qr_on_invoice", event.target.checked)} /><span>Enable UPI QR on Invoice</span></label>
        <label className="check-field"><input checked={draft.show_upi_qr_on_all_bills === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("show_upi_qr_on_all_bills", event.target.checked)} /><span>Show UPI QR on all bills</span></label>
        <label className="check-field"><input checked={draft.enable_sales_mandi_tax === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("enable_sales_mandi_tax", event.target.checked)} /><span>Enable Mandi Tax on registered-customer sales</span></label>
        <Field label="Sales Mandi Tax Rate (%)"><input disabled={!canManage} min="0" step="0.001" type="number" value={draft.sales_mandi_tax_percent || 0} onChange={(event) => updateDraft("sales_mandi_tax_percent", event.target.value)} /></Field>
        <Field label="Customer Applicability">
          <select disabled={!canManage} value={draft.sales_mandi_tax_customer_scope || "REGISTERED_CUSTOMERS"} onChange={(event) => updateDraft("sales_mandi_tax_customer_scope", event.target.value)}>
            <option value="REGISTERED_CUSTOMERS">Registered/Saved Customer Accounts</option>
            <option value="ALL_CUSTOMERS">All Customers</option>
            <option value="NONE">Not Applicable</option>
          </select>
        </Field>
        <Field label="Product / Category Applicability">
          <select disabled={!canManage} value={draft.sales_mandi_tax_product_scope || "ALL_PRODUCTS"} onChange={(event) => updateDraft("sales_mandi_tax_product_scope", event.target.value)}>
            <option value="ALL_PRODUCTS">All Products</option>
            <option value="FRUIT_PRODUCTS">Fruit Products Only</option>
            <option value="CATEGORY_CONFIGURED">Category configured separately</option>
          </select>
        </Field>
        <Field label="Sales Mandi Tax Basis">
          <select disabled={!canManage} value={draft.sales_mandi_tax_basis || "NET_AFTER_ALL_DISCOUNTS"} onChange={(event) => updateDraft("sales_mandi_tax_basis", event.target.value)}>
            <option value="GROSS_BEFORE_DISCOUNTS">Gross item value before discounts</option>
            <option value="AFTER_ITEM_DISCOUNT">Sale value after item discount</option>
            <option value="NET_AFTER_ALL_DISCOUNTS">Net sale value after item and bill discounts</option>
          </select>
        </Field>
        <Field label="Effective Date"><input disabled={!canManage} type="date" value={draft.sales_mandi_tax_effective_date ? toDateKey(draft.sales_mandi_tax_effective_date) : ""} onChange={(event) => updateDraft("sales_mandi_tax_effective_date", event.target.value)} /></Field>
        <Field label="Disable / Not Applicable Reason"><textarea disabled={!canManage || draft.enable_sales_mandi_tax === true} placeholder="Required when Mandi Tax is not applicable for this business." value={draft.sales_mandi_tax_disable_reason || ""} onChange={(event) => updateDraft("sales_mandi_tax_disable_reason", event.target.value)} /></Field>
        {draft.enable_upi_qr_on_invoice === true && !draft.business_upi_id && <p className="form-note stock-low">Please add UPI ID in Settings to show QR code.</p>}
        {draft.enable_sales_mandi_tax === true && Number(draft.sales_mandi_tax_percent || 0) <= 0 && <p className="form-note stock-low">Enter a Mandi Tax rate before saving registered-customer sales with tax.</p>}
        {draft.enable_sales_mandi_tax !== true && <p className="form-note">Mandi Tax warnings stay disabled in POS while this setting is off. Use the reason field to document why it is not applicable.</p>}
      </div>
      <button className="primary-button" disabled={!canManage} onClick={save}>Save Payment Settings</button>
    </ModuleCard>
  );
}

function WhatsAppSettingsSection({ canManage, onReload, user, whatsappSettings }) {
  const [draft, setDraft] = useState({ ...defaultWhatsappSettings, ...whatsappSettings, access_token: "" });
  const [message, setMessage] = useState("");
  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/whatsapp`, { ...draft, updated_by: user.id });
      setDraft((current) => ({ ...current, access_token: "" }));
      await onReload();
      setMessage("WhatsApp settings updated.");
    } catch (error) {
      setMessage(getErrorMessage(error, "Unable to update WhatsApp settings"));
    }
  };
  const testConnection = async () => {
    try {
      const response = await axios.post(`${API_URL}/settings/whatsapp/test`, { updated_by: user.id });
      setMessage(response.data?.success ? `WhatsApp connected: ${response.data.name || response.data.phone || "verified"}` : "WhatsApp connection checked.");
    } catch (error) {
      setMessage(getErrorMessage(error, "Unable to test WhatsApp connection"));
    }
  };
  return (
    <ModuleCard eyebrow="WhatsApp Settings" title="WhatsApp Business Cloud API" subtitle="Send bills, ledgers and reports as PDFs through WhatsApp. If not configured, FroozERP exports the PDF for manual WhatsApp Web attachment.">
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric featured label="Sending" value={draft.enabled ? "Enabled" : "Disabled"} />
        <SummaryMetric label="Access Token" value={whatsappSettings?.access_token_configured ? "Configured" : "Not configured"} />
        <SummaryMetric label="Default Country Code" value={`+${draft.default_country_code || "91"}`} />
      </div>
      <div className="form-grid supplier-form-grid">
        <label className="check-field"><input checked={draft.enabled === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("enabled", event.target.checked)} /><span>Enable WhatsApp Cloud API sending</span></label>
        <Field label="WhatsApp Business Phone Number ID">
          <input disabled={!canManage} placeholder="Meta phone number ID" value={draft.phone_number_id || ""} onChange={(event) => updateDraft("phone_number_id", event.target.value)} />
        </Field>
        <Field label="Access Token">
          <input disabled={!canManage} placeholder={whatsappSettings?.access_token_configured ? whatsappSettings.access_token_masked || "Token configured - enter new token to replace" : "Paste WhatsApp Cloud API access token"} type="password" value={draft.access_token || ""} onChange={(event) => updateDraft("access_token", event.target.value)} />
        </Field>
        <Field label="Default Country Code">
          <input disabled={!canManage} placeholder="91" value={draft.default_country_code || "91"} onChange={(event) => updateDraft("default_country_code", event.target.value.replace(/\D/g, "").slice(0, 5))} />
        </Field>
      </div>
      <p className="form-note">Tokens are stored only on the backend. They are never returned to the frontend after saving.</p>
      <div className="button-row">
        <button className="primary-button" disabled={!canManage} onClick={save}>Save WhatsApp Settings</button>
        <button className="secondary-button" disabled={!canManage || !whatsappSettings?.access_token_configured} onClick={testConnection}>Test Connection</button>
      </div>
      {message && <div className="startup-status-panel"><p>{message}</p></div>}
    </ModuleCard>
  );
}

function MandiTaxSettings({ canManage, onReload, rules, user }) {
  const [newRule, setNewRule] = useState({ origin_type: "", tax_percent: "", active: true });
  const addRule = async () => {
    try {
      await axios.post(`${API_URL}/settings/mandi-tax-rules`, { ...newRule, updated_by: user.id });
      setNewRule({ origin_type: "", tax_percent: "", active: true });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to add mandi tax rule"));
    }
  };
  return (
    <ModuleCard eyebrow="Mandi Tax Settings" title="Origin-Based Mandi Tax" subtitle="Database-backed tax percentages for local and imported fruit purchases.">
      <div className="form-grid settings-add-grid">
        <Field label="Origin Type"><input disabled={!canManage} placeholder="LOCAL or IMPORTED" value={newRule.origin_type} onChange={(event) => setNewRule({ ...newRule, origin_type: event.target.value.toUpperCase() })} /></Field>
        <Field label="Tax Percentage"><input disabled={!canManage} min="0" step="0.001" type="number" value={newRule.tax_percent} onChange={(event) => setNewRule({ ...newRule, tax_percent: event.target.value })} /></Field>
        <label className="check-field"><input disabled={!canManage} checked={newRule.active} type="checkbox" onChange={(event) => setNewRule({ ...newRule, active: event.target.checked })} /><span>Active</span></label>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={addRule}>Add Mandi Tax Rule</button>
      <DataTable headers={["Origin Type", "Tax Percentage", "Status", ""]}>
        {rules.map((rule) => <MandiRuleRow canManage={canManage} key={rule.id} onReload={onReload} rule={rule} user={user} />)}
      </DataTable>
    </ModuleCard>
  );
}

function RebateSettings({ canManage, onReload, rules, user }) {
  const [newRule, setNewRule] = useState({ rule_name: "", pay_within_days: "", rebate_percent: "", active: true });
  const addRebateRule = async () => {
    try {
      await axios.post(`${API_URL}/settings/rebate-rules`, { ...newRule, updated_by: user.id });
      setNewRule({ rule_name: "", pay_within_days: "", rebate_percent: "", active: true });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to add rebate rule"));
    }
  };
  return (
    <ModuleCard eyebrow="Supplier Rebate Settings" title="Payment-Speed Rebate Slabs" subtitle="Owner/Admin can change payment days, rebate percentages and active status from software.">
      <div className="form-grid settings-add-grid">
        <Field label="Rule Name"><input disabled={!canManage} value={newRule.rule_name} onChange={(event) => setNewRule({ ...newRule, rule_name: event.target.value })} /></Field>
        <Field label="Pay Within Days"><input disabled={!canManage} min="0" type="number" value={newRule.pay_within_days} onChange={(event) => setNewRule({ ...newRule, pay_within_days: event.target.value })} /></Field>
        <Field label="Rebate Percentage"><input disabled={!canManage} min="0" step="0.001" type="number" value={newRule.rebate_percent} onChange={(event) => setNewRule({ ...newRule, rebate_percent: event.target.value })} /></Field>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={addRebateRule}>Add Rebate Rule</button>
      <DataTable headers={["Rule", "Pay Within Days", "Rebate Percentage", "Status", ""]}>
        {rules.map((rule) => <RebateRuleRow canManage={canManage} key={rule.id} onReload={onReload} rule={rule} user={user} />)}
      </DataTable>
    </ModuleCard>
  );
}

function SaleRateSettingsSection({ canManage, onReload, saleRateSettings, user }) {
  const [draft, setDraft] = useState({ ...defaultSaleRateSettings, ...saleRateSettings });
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/sale-rate`, { ...draft, updated_by: user.id });
      await onReload();
      alert("Sale rate settings updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update sale rate settings"));
    }
  };
  return (
    <ModuleCard eyebrow="Sale Rate Settings" title="Sale Rate Suggestions" subtitle="Default margin and rounding controls used by owner-approved rate updates.">
      <div className="form-grid settings-add-grid">
        <Field label="Desired Margin %"><input disabled={!canManage} min="0" step="0.1" type="number" value={draft.desired_margin_percent || ""} onChange={(event) => setDraft({ ...draft, desired_margin_percent: event.target.value })} /></Field>
        <Field label="Rounding Rule">
          <select disabled={!canManage} value={draft.rounding_rule || "NEAREST_RUPEE"} onChange={(event) => setDraft({ ...draft, rounding_rule: event.target.value })}>
            {roundingRules.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="POS Lot Selection Mode">
          <select disabled={!canManage} value={draft.pos_lot_selection_mode || "ASK_MULTIPLE"} onChange={(event) => setDraft({ ...draft, pos_lot_selection_mode: event.target.value })}>
            <option value="ASK_MULTIPLE">Ask When Multiple Lots Exist</option>
            <option value="AUTO_FIFO">Auto FIFO</option>
            <option value="MANUAL">Manual Lot Selection</option>
          </select>
        </Field>
        <label className="check-field"><input disabled={!canManage} checked={draft.suggestion_enabled !== false} type="checkbox" onChange={(event) => setDraft({ ...draft, suggestion_enabled: event.target.checked })} /><span>Suggestions Active</span></label>
        <Field label="Notes"><textarea disabled={!canManage} value={draft.notes || ""} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></Field>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={save}>Save Sale Rate Settings</button>
    </ModuleCard>
  );
}

function DiscountSettings({ canManage, discountRules, onReload, saleRateSettings = {}, user }) {
  const [calculationEnabled, setCalculationEnabled] = useState(saleRateSettings.bill_level_slab_discount_enabled !== false);
  const [newRule, setNewRule] = useState({
    rule_name: "",
    minimum_bill_amount: "",
    maximum_bill_amount: "",
    discount_type: "FLAT_AMOUNT",
    discount_value: "",
    payment_mode: "ALL",
    active: true,
  });
  const addRule = async () => {
    try {
      await axios.post(`${API_URL}/settings/discount-rules`, { ...newRule, updated_by: user.id });
      setNewRule({ rule_name: "", minimum_bill_amount: "", maximum_bill_amount: "", discount_type: "FLAT_AMOUNT", discount_value: "", payment_mode: "ALL", active: true });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to add discount rule"));
    }
  };
  const saveCalculationToggle = async () => {
    try {
      await axios.put(`${API_URL}/settings/sale-rate`, {
        ...defaultSaleRateSettings,
        ...saleRateSettings,
        bill_level_slab_discount_enabled: calculationEnabled,
        updated_by: user.id,
      });
      await onReload();
      alert("Discount calculation setting updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update discount calculation setting"));
    }
  };
  return (
    <ModuleCard eyebrow="Overall Sale Discount Settings" title="Bill-Level Discount Slabs" subtitle="Automatic POS invoice discounts based on total bill amount and optional payment mode.">
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric featured label="Discount Calculation" value={calculationEnabled ? "Enabled" : "Disabled"} />
        <SummaryMetric label="Active Slabs" value={discountRules.filter((rule) => rule.active !== false).length} />
      </div>
      <div className="button-row">
        <label className="check-field"><input checked={calculationEnabled} disabled={!canManage} type="checkbox" onChange={(event) => setCalculationEnabled(event.target.checked)} /><span>Enable Bill-Level Slab Discount</span></label>
        <button className="secondary-button" disabled={!canManage} onClick={saveCalculationToggle}>Save Calculation Setting</button>
      </div>
      <div className="form-grid discount-rule-grid">
        <Field label="Rule Name"><input disabled={!canManage} value={newRule.rule_name} onChange={(event) => setNewRule({ ...newRule, rule_name: event.target.value })} /></Field>
        <Field label="Minimum Bill Amount"><input disabled={!canManage} min="0" step="0.01" type="number" value={newRule.minimum_bill_amount} onChange={(event) => setNewRule({ ...newRule, minimum_bill_amount: event.target.value })} /></Field>
        <Field label="Maximum Bill Amount"><input disabled={!canManage} min="0" step="0.01" type="number" value={newRule.maximum_bill_amount} onChange={(event) => setNewRule({ ...newRule, maximum_bill_amount: event.target.value })} /></Field>
        <Field label="Discount Type">
          <select disabled={!canManage} value={newRule.discount_type} onChange={(event) => setNewRule({ ...newRule, discount_type: event.target.value })}>
            {discountTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field label="Discount Value"><input disabled={!canManage} min="0" step="0.01" type="number" value={newRule.discount_value} onChange={(event) => setNewRule({ ...newRule, discount_value: event.target.value })} /></Field>
        <Field label="Payment Mode">
          <select disabled={!canManage} value={newRule.payment_mode} onChange={(event) => setNewRule({ ...newRule, payment_mode: event.target.value })}>
            {discountPaymentModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <label className="check-field"><input disabled={!canManage} checked={newRule.active} type="checkbox" onChange={(event) => setNewRule({ ...newRule, active: event.target.checked })} /><span>Active</span></label>
      </div>
      <button className="primary-button" disabled={!canManage} onClick={addRule}>Add Discount Slab</button>
      <DataTable headers={["Rule", "Range", "Type", "Value", "Payment", "Status", ""]}>
        {discountRules.map((rule) => <DiscountRuleRow canManage={canManage} key={rule.id} onReload={onReload} rule={rule} user={user} />)}
      </DataTable>
    </ModuleCard>
  );
}

function MandiRuleRow({ canManage, onReload, rule, user }) {
  const [taxPercent, setTaxPercent] = useState(rule.tax_percent);
  const [active, setActive] = useState(rule.active);
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/mandi-tax-rules/${rule.id}`, {
        tax_percent: Number(taxPercent),
        active,
        updated_by: user.id,
      });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update mandi tax rule"));
    }
  };
  const remove = async () => {
    try {
      await axios.delete(`${API_URL}/settings/mandi-tax-rules/${rule.id}`, { data: { updated_by: user.id } });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to delete mandi tax rule"));
    }
  };
  return (
    <tr>
      <td className="primary-cell">{rule.origin_type}</td>
      <td><input className="table-input" disabled={!canManage} min="0" step="0.001" type="number" value={taxPercent} onChange={(event) => setTaxPercent(event.target.value)} /></td>
      <td><label className="check-field"><input checked={active} disabled={!canManage} type="checkbox" onChange={(event) => setActive(event.target.checked)} /><span>{active ? "Active" : "Inactive"}</span></label></td>
      <td><div className="button-row"><button className="table-action" disabled={!canManage} onClick={save}>Save</button><button className="remove-button" disabled={!canManage} onClick={remove}><Icon name="trash" size={15} /></button></div></td>
    </tr>
  );
}

function RebateRuleRow({ canManage, onReload, rule, user }) {
  const [draft, setDraft] = useState(rule);
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/rebate-rules/${rule.id}`, { ...draft, updated_by: user.id });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update rebate rule"));
    }
  };
  const remove = async () => {
    try {
      await axios.delete(`${API_URL}/settings/rebate-rules/${rule.id}`, { data: { updated_by: user.id } });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to delete rebate rule"));
    }
  };
  return (
    <tr>
      <td><input className="settings-table-input" disabled={!canManage} value={draft.rule_name} onChange={(event) => setDraft({ ...draft, rule_name: event.target.value })} /></td>
      <td><input className="table-input" disabled={!canManage} min="0" type="number" value={draft.pay_within_days} onChange={(event) => setDraft({ ...draft, pay_within_days: event.target.value })} /></td>
      <td><input className="table-input" disabled={!canManage} min="0" step="0.001" type="number" value={draft.rebate_percent} onChange={(event) => setDraft({ ...draft, rebate_percent: event.target.value })} /></td>
      <td><label className="check-field"><input checked={draft.active} disabled={!canManage} type="checkbox" onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>{draft.active ? "Active" : "Inactive"}</span></label></td>
      <td><div className="button-row"><button className="table-action" disabled={!canManage} onClick={save}>Save</button><button className="remove-button" disabled={!canManage} onClick={remove}><Icon name="trash" size={15} /></button></div></td>
    </tr>
  );
}

function DiscountRuleRow({ canManage, onReload, rule, user }) {
  const [draft, setDraft] = useState(rule);
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/discount-rules/${rule.id}`, { ...draft, updated_by: user.id });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update discount rule"));
    }
  };
  const remove = async () => {
    try {
      await axios.delete(`${API_URL}/settings/discount-rules/${rule.id}`, { data: { updated_by: user.id } });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to delete discount rule"));
    }
  };
  return (
    <tr>
      <td><input className="settings-table-input" disabled={!canManage} value={draft.rule_name} onChange={(event) => setDraft({ ...draft, rule_name: event.target.value })} /></td>
      <td>
        <div className="table-range-inputs">
          <input className="table-input" disabled={!canManage} min="0" step="0.01" type="number" value={draft.minimum_bill_amount} onChange={(event) => setDraft({ ...draft, minimum_bill_amount: event.target.value })} />
          <input className="table-input" disabled={!canManage} min="0" step="0.01" type="number" value={draft.maximum_bill_amount || ""} onChange={(event) => setDraft({ ...draft, maximum_bill_amount: event.target.value })} />
        </div>
      </td>
      <td><select className="settings-table-input" disabled={!canManage} value={draft.discount_type} onChange={(event) => setDraft({ ...draft, discount_type: event.target.value })}>{discountTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
      <td><input className="table-input" disabled={!canManage} min="0" step="0.01" type="number" value={draft.discount_value} onChange={(event) => setDraft({ ...draft, discount_value: event.target.value })} /></td>
      <td><select className="settings-table-input" disabled={!canManage} value={draft.payment_mode} onChange={(event) => setDraft({ ...draft, payment_mode: event.target.value })}>{discountPaymentModes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></td>
      <td><label className="check-field"><input checked={draft.active} disabled={!canManage} type="checkbox" onChange={(event) => setDraft({ ...draft, active: event.target.checked })} /><span>{draft.active ? "Active" : "Inactive"}</span></label></td>
      <td><div className="button-row"><button className="table-action" disabled={!canManage} onClick={save}>Save</button><button className="remove-button" disabled={!canManage} onClick={remove}><Icon name="trash" size={15} /></button></div></td>
    </tr>
  );
}

const permissionLabels = [
  ["dashboard", "View Dashboard"],
  ["settings", "Settings"],
  ["discounts", "Discounts"],
  ["mandi_tax", "Mandi Tax"],
  ["rebate_rules", "Rebate Rules"],
  ["supplier_payments", "Supplier Payments"],
  ["customer_payments", "Customer Payments"],
  ["sale_edit", "Sale Edit"],
  ["invoice_cancellation", "Invoice Cancellation"],
  ["reports", "Reports"],
  ["purchases", "Purchases"],
  ["supplier_accounts", "Supplier Accounts"],
  ["inventory", "Inventory"],
  ["waste_management", "Waste Management"],
  ["billing", "Billing"],
  ["manual_pos_rate_override", "Manual POS Rate Override"],
  ["pos_date_override", "POS Bill Date Override"],
  ["sale_date_edit", "Sale Bill Date Edit"],
  ["device_management", "Authorized Devices"],
  ["activation_codes", "Activation Codes"],
  ["backup_restore", "Backup / Restore"],
  ["branch_settings", "Branch Settings"],
  ["system_info", "System Info"],
  ["whatsapp_send", "WhatsApp Send"],
  ["whatsapp_settings", "WhatsApp Settings"],
  ["ai_assistant_view", "AI Assistant"],
  ["ai_financial_insights", "AI Financial"],
  ["ai_inventory_insights", "AI Inventory"],
  ["ai_reminder_manage", "AI Reminders"],
  ["ai_action_approve", "AI Approvals"],
  ["ai_settings_manage", "AI Settings"],
];

function PermissionSettings({ canManage, onReload, roles, user }) {
  const [drafts, setDrafts] = useState(() => {
    const next = {};
    for (const role of roles || []) next[role.role_name] = role.permissions || {};
    return next;
  });
  const toggle = (roleName, key) => {
    setDrafts((current) => ({
      ...current,
      [roleName]: { ...(current[roleName] || {}), [key]: !current[roleName]?.[key] },
    }));
  };
  const saveRole = async (roleName) => {
    try {
      await axios.put(`${API_URL}/settings/role-permissions/${encodeURIComponent(roleName)}`, {
        permissions: drafts[roleName] || {},
        updated_by: user.id,
      });
      await onReload();
      alert("Role permissions updated");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update role permissions"));
    }
  };
  return (
    <ModuleCard eyebrow="Role Management" title="Permission Matrix" subtitle="Owner/Admin can control access to billing, settings, tax, rebates, payments, reports and inventory functions.">
      <DataTable headers={["Role", ...permissionLabels.map(([, label]) => label), ""]}>
        {(roles || []).map((role) => (
          <tr key={role.role_name}>
            <td className="primary-cell">{role.role_name}</td>
            {permissionLabels.map(([key]) => (
              <td key={key}>
                <input checked={Boolean(drafts[role.role_name]?.[key])} disabled={!canManage || role.role_name === "Owner"} type="checkbox" onChange={() => toggle(role.role_name, key)} />
              </td>
            ))}
            <td><button className="table-action" disabled={!canManage || role.role_name === "Owner"} onClick={() => saveRole(role.role_name)}>Save</button></td>
          </tr>
        ))}
      </DataTable>
    </ModuleCard>
  );
}

function DeviceControlSettingsSection({ canManage, deviceControlSettings = defaultDeviceControlSettings, exitAttemptLogs = [], onReload, user }) {
  const [draft, setDraft] = useState({ ...defaultDeviceControlSettings, ...deviceControlSettings });
  const [currentPassword, setCurrentPassword] = useState("");
  const [exitCode, setExitCode] = useState("");
  const [confirmExitCode, setConfirmExitCode] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => {
    setDraft({ ...defaultDeviceControlSettings, ...deviceControlSettings });
  }, [deviceControlSettings?.updated_at, deviceControlSettings?.fullscreen_lock_enabled, deviceControlSettings?.exit_code_configured]);
  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/device-control`, {
        fullscreen_lock_enabled: draft.fullscreen_lock_enabled === true,
        require_exit_code_to_close: draft.require_exit_code_to_close !== false,
        current_password: currentPassword,
        exit_code: exitCode,
        confirm_exit_code: confirmExitCode,
        updated_by: user.id,
      });
      setCurrentPassword("");
      setExitCode("");
      setConfirmExitCode("");
      setMessage("Device control settings updated");
      await onReload();
    } catch (error) {
      setMessage(getErrorMessage(error, "Unable to update device control settings"));
    }
  };
  return (
    <ModuleCard eyebrow="Security / Device Control" title="Fullscreen Lock & Owner Exit Code" subtitle="App-level kiosk protection for counter devices. Windows administrator controls can still force close the application.">
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric featured label="Fullscreen Lock Mode" value={draft.fullscreen_lock_enabled ? "Enabled" : "Disabled"} />
        <SummaryMetric label="Exit Code" value={draft.exit_code_configured ? "Configured" : "Not Set"} />
        <SummaryMetric label="Close Protection" value={draft.require_exit_code_to_close !== false ? "Exit code required" : "Not required"} />
      </div>
      {message && <div className={message.toLowerCase().includes("unable") || message.toLowerCase().includes("incorrect") ? "error-banner" : "startup-status-panel"}>{message}</div>}
      <div className="form-grid supplier-form-grid device-control-grid">
        <label className="check-field report-check-field">
          <input checked={draft.fullscreen_lock_enabled === true} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("fullscreen_lock_enabled", event.target.checked)} />
          <span>Enable Fullscreen Lock Mode</span>
        </label>
        <label className="check-field report-check-field">
          <input checked={draft.require_exit_code_to_close !== false} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("require_exit_code_to_close", event.target.checked)} />
          <span>Require Exit Code to Close App</span>
        </label>
        <Field label="Current Owner/Admin Password"><input disabled={!canManage} type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="Required only when changing exit code" /></Field>
        <Field label="New Exit Code"><input disabled={!canManage} inputMode="numeric" type="password" value={exitCode} onChange={(event) => setExitCode(event.target.value.replace(/\D/g, ""))} placeholder="Minimum 4 digits, recommended 6" /></Field>
        <Field label="Confirm Exit Code"><input disabled={!canManage} inputMode="numeric" type="password" value={confirmExitCode} onChange={(event) => setConfirmExitCode(event.target.value.replace(/\D/g, ""))} /></Field>
      </div>
      <div className="button-row">
        <button className="primary-button" disabled={!canManage} onClick={save}>Save Device Control</button>
      </div>
      <p className="form-note">Failed exit attempts are logged for Owner/Admin review. If the exit code is forgotten, use Owner/Admin recovery or repair installation without deleting data.</p>
      <DataTable headers={["Attempted At", "User", "Device", "Result", "Reason"]}>
        {exitAttemptLogs.map((row) => (
          <tr key={row.id}>
            <td>{row.attempted_at ? new Date(row.attempted_at).toLocaleString("en-IN") : "-"}</td>
            <td>{row.user_name || row.user_id || "-"}</td>
            <td>{row.device_id || "-"}</td>
            <td><span className={row.success ? "stock-ok" : "stock-low"}>{row.success ? "Allowed" : "Blocked"}</span></td>
            <td>{row.failure_reason || "-"}</td>
          </tr>
        ))}
        {exitAttemptLogs.length === 0 && <tr><td colSpan="5" className="empty-cell">No exit attempts logged yet.</td></tr>}
      </DataTable>
    </ModuleCard>
  );
}

function UserManagementSection({ canManage, onReload, roles = [], user, users = [] }) {
  const emptyForm = {
    full_name: "",
    username: "",
    mobile_number: "",
    email: "",
    recovery_enabled: true,
    staff_self_recovery_enabled: false,
    role: "Cashier",
    password: "",
    confirm_password: "",
    joining_date: toDateKey(new Date()),
    active: true,
    notes: "",
  };
  const [draft, setDraft] = useState(emptyForm);
  const [editingId, setEditingId] = useState(null);
  const [passwordTarget, setPasswordTarget] = useState(null);
  const [recoveryMessage, setRecoveryMessage] = useState("");
  const roleNames = (roles || []).map((role) => role.role_name).filter(Boolean);
  const updateDraft = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const startEdit = (item) => {
    setEditingId(item.id);
    setDraft({
      full_name: item.full_name || "",
      username: item.username || "",
      mobile_number: item.mobile_number || "",
      email: item.email || "",
      recovery_enabled: item.recovery_enabled !== false,
      staff_self_recovery_enabled: item.staff_self_recovery_enabled === true,
      role: item.role || "Cashier",
      password: "",
      confirm_password: "",
      joining_date: toDateKey(item.joining_date || new Date()),
      active: item.active !== false,
      notes: item.notes || "",
    });
  };
  const resetForm = () => {
    setEditingId(null);
    setDraft(emptyForm);
  };
  const saveUser = async () => {
    try {
      const duplicate = users.find((item) =>
        Number(item.id) !== Number(editingId || 0) &&
        (
          item.username?.trim().toLowerCase() === draft.username.trim().toLowerCase() ||
          (draft.mobile_number && item.mobile_number === draft.mobile_number) ||
          (draft.email && item.email?.trim().toLowerCase() === draft.email.trim().toLowerCase())
        )
      );
      if (duplicate) {
        if (duplicate.username?.trim().toLowerCase() === draft.username.trim().toLowerCase()) alert("This username already exists.");
        else if (draft.mobile_number && duplicate.mobile_number === draft.mobile_number) alert("This mobile number already exists.");
        else alert("This email already exists.");
        return;
      }
      if (!draft.full_name.trim() || !draft.username.trim() || !draft.role) {
        alert("Enter full name, username and role.");
        return;
      }
      if (!editingId && (draft.password.length < 4 || draft.password !== draft.confirm_password)) {
        alert("Enter matching password with at least 4 characters.");
        return;
      }
      const payload = { ...draft, updated_by: user.id };
      if (editingId) await axios.put(`${API_URL}/users/${editingId}`, payload);
      else await axios.post(`${API_URL}/users`, payload);
      resetForm();
      await onReload();
      alert(editingId ? "User updated" : "User added");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save user"));
    }
  };
  const changePassword = async () => {
    if (!passwordTarget) return;
    try {
      if (passwordTarget.recoveryAction) {
        const supplied = passwordTarget.password || "";
        if (supplied && supplied !== passwordTarget.confirm_password) {
          setRecoveryMessage("Temporary password and confirmation do not match.");
          return;
        }
        const response = await axios.post(`${API_URL}/users/${passwordTarget.id}/recovery-action`, {
          action: "RESET_PASSWORD",
          temporary_password: supplied,
          updated_by: user.id,
        });
        setRecoveryMessage(response.data.temporary_password
          ? `Temporary password generated. Share it securely once: ${response.data.temporary_password}`
          : "Temporary password set. The user must change it at next login.");
      } else {
        await axios.put(`${API_URL}/users/${passwordTarget.id}/password`, {
          password: passwordTarget.password,
          confirm_password: passwordTarget.confirm_password,
          updated_by: user.id,
        });
        setRecoveryMessage("Password updated and active sessions revoked.");
      }
      setPasswordTarget(null);
      await onReload();
    } catch (error) {
      setRecoveryMessage(getAuthErrorMessage(error, "Unable to update password"));
    }
  };
  const recoveryAction = async (item, action) => {
    try {
      const response = await axios.post(`${API_URL}/users/${item.id}/recovery-action`, {
        action,
        updated_by: user.id,
      });
      setRecoveryMessage(response.data.message || "Recovery action completed.");
      await onReload();
    } catch (error) {
      setRecoveryMessage(getAuthErrorMessage(error, "Unable to complete recovery action"));
    }
  };
  const userAction = async (item, action) => {
    try {
      if (action === "delete") {
        const response = await axios.delete(`${API_URL}/users/${item.id}`, { data: { updated_by: user.id } });
        alert(response.data.message || "User removed");
      } else {
        await axios.post(`${API_URL}/users/${item.id}/${action}`, { updated_by: user.id });
      }
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update user status"));
    }
  };
  return (
    <ModuleCard eyebrow="User Management" title="Owner User Administration" subtitle="Add, edit, reset password, deactivate and protect user records with transaction history.">
      <div className="form-grid supplier-form-grid">
        <Field label="Full Name"><input disabled={!canManage} value={draft.full_name} onChange={(event) => updateDraft("full_name", event.target.value)} /></Field>
        <Field label="Username"><input disabled={!canManage} value={draft.username} onChange={(event) => updateDraft("username", event.target.value)} /></Field>
        <Field label="Mobile"><input disabled={!canManage} value={draft.mobile_number} onChange={(event) => updateDraft("mobile_number", event.target.value)} /></Field>
        <Field label="Email"><input disabled={!canManage} type="email" value={draft.email} onChange={(event) => updateDraft("email", event.target.value)} /></Field>
        <Field label="Role">
          <select disabled={!canManage} value={draft.role} onChange={(event) => updateDraft("role", event.target.value)}>
            {(roleNames.length ? roleNames : ["Owner", "Admin", "Cashier", "Purchase Manager", "Inventory Manager"]).map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
        </Field>
        <Field label="Joining Date"><input disabled={!canManage} type="date" value={draft.joining_date} onChange={(event) => updateDraft("joining_date", event.target.value)} /></Field>
        {!editingId && <Field label="Password"><input disabled={!canManage} type="password" value={draft.password} onChange={(event) => updateDraft("password", event.target.value)} /></Field>}
        {!editingId && <Field label="Confirm Password"><input disabled={!canManage} type="password" value={draft.confirm_password} onChange={(event) => updateDraft("confirm_password", event.target.value)} /></Field>}
        <label className="check-field"><input checked={draft.active} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("active", event.target.checked)} /><span>Active user</span></label>
        <label className="check-field"><input checked={draft.recovery_enabled} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("recovery_enabled", event.target.checked)} /><span>Recovery enabled</span></label>
        <label className="check-field"><input checked={draft.staff_self_recovery_enabled} disabled={!canManage} type="checkbox" onChange={(event) => updateDraft("staff_self_recovery_enabled", event.target.checked)} /><span>Allow staff self-recovery</span></label>
        <Field label="Notes"><textarea disabled={!canManage} value={draft.notes} onChange={(event) => updateDraft("notes", event.target.value)} /></Field>
      </div>
      {recoveryMessage && <div className="startup-status-panel"><p>{recoveryMessage}</p></div>}
      <div className="button-row">
        <button className="primary-button" disabled={!canManage} onClick={saveUser}>{editingId ? "Update User" : "Add User"}</button>
        {editingId && <button className="secondary-button" onClick={resetForm}>Cancel Edit</button>}
      </div>
      <DataTable headers={["Name", "Username", "Role", "Mobile", "Last Login", "Status", "Actions"]}>
        {users.map((item) => (
          <tr key={item.id}>
            <td className="primary-cell">
              {item.full_name}
              <small className="cell-note">{item.email || "No email"}</small>
              <small className="cell-note">
                Recovery {item.recovery_enabled === false ? "disabled" : item.recovery_email_verified || item.recovery_mobile_verified || item.verified_email || item.verified_mobile ? "ready" : "needs verified contact"}
              </small>
            </td>
            <td>{item.username}</td>
            <td><span className="tag">{item.role}</span></td>
            <td>{item.mobile_number || "-"}</td>
            <td>{item.last_login_at ? new Date(item.last_login_at).toLocaleString("en-IN") : "Not recorded"}</td>
            <td><span className={item.active ? "stock-ok" : "stock-low"}>{item.active ? "Active" : "Inactive"}</span></td>
            <td>
              <div className="button-row table-actions-row">
                <button className="table-action" disabled={!canManage} onClick={() => startEdit(item)}>Edit</button>
                <button className="table-action" disabled={!canManage} onClick={() => setPasswordTarget({ id: item.id, name: item.full_name, password: "", confirm_password: "" })}>Password</button>
                <button className="table-action" disabled={!canManage || item.id === user.id} onClick={() => setPasswordTarget({ id: item.id, name: item.full_name, password: "", confirm_password: "", recoveryAction: true })}>Reset Staff Password</button>
                <button className="secondary-button" disabled={!canManage || item.id === user.id} onClick={() => recoveryAction(item, "UNLOCK_ACCOUNT")}>Unlock</button>
                <button className="secondary-button" disabled={!canManage || item.id === user.id} onClick={() => recoveryAction(item, "RESEND_USERNAME")}>Resend Username</button>
                <button className="secondary-button" disabled={!canManage || item.id === user.id} onClick={() => recoveryAction(item, "REVOKE_SESSIONS")}>Revoke Sessions</button>
                <button className="secondary-button" disabled={!canManage || item.id === user.id} onClick={() => recoveryAction(item, "REQUIRE_PASSWORD_CHANGE")}>Require Change</button>
                {item.active ? <button className="secondary-button" disabled={!canManage || item.id === user.id} onClick={() => userAction(item, "deactivate")}>Deactivate</button> : <button className="secondary-button" disabled={!canManage} onClick={() => userAction(item, "reactivate")}>Reactivate</button>}
                <button className="remove-button" disabled={!canManage || item.id === user.id} onClick={() => userAction(item, "delete")}><Icon name="trash" size={15} /></button>
              </div>
            </td>
          </tr>
        ))}
      </DataTable>
      {passwordTarget && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">{passwordTarget.recoveryAction ? "Staff Account Recovery" : "Reset Password"}</span>
                <strong>{passwordTarget.name}</strong>
              </div>
              <button aria-label="Close password reset" className="remove-button" onClick={() => setPasswordTarget(null)}><Icon name="close" /></button>
            </div>
            <div className="sale-edit-body">
              {passwordTarget.recoveryAction && <p className="form-note">Leave the fields blank to generate a one-time temporary password. The user will be required to change it at next login.</p>}
              <div className="form-grid settings-add-grid">
                <Field label={passwordTarget.recoveryAction ? "Temporary Password" : "New Password"}><input type="password" value={passwordTarget.password} onChange={(event) => setPasswordTarget({ ...passwordTarget, password: event.target.value })} /></Field>
                <Field label="Confirm Password"><input type="password" value={passwordTarget.confirm_password} onChange={(event) => setPasswordTarget({ ...passwordTarget, confirm_password: event.target.value })} /></Field>
              </div>
              <button className="primary-button" onClick={changePassword}>{passwordTarget.recoveryAction ? "Reset Staff Access" : "Save Password"}</button>
            </div>
          </section>
        </div>
      )}
    </ModuleCard>
  );
}

function UpdateCenterSection({ canManage }) {
  const [cleanupResult, setCleanupResult] = useState(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [installDiagnostics, setInstallDiagnostics] = useState(null);
  const updateRequestIdRef = useRef(0);
  const autoCheckStartedRef = useRef(false);
  const updateObjectRef = useRef(null);
  const downloadedUpdateRef = useRef(null);
  const feedConfigured = Boolean(UPDATE_FEED_URL);
  const desktopUpdaterAvailable = isDesktopShell();
  const installedVersion = APP_VERSION;
  const normalizeVersion = useCallback((value) => {
    const text = String(value || "").trim();
    const match = text.match(/v?(\d+(?:\.\d+){1,3})(?:[^\d].*)?$/i) || text.match(/v?(\d+(?:\.\d+){1,3})/i);
    return match ? match[1] : "";
  }, []);
  const compareVersions = useCallback((left, right) => {
    const a = normalizeVersion(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
    const b = normalizeVersion(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const diff = (a[index] || 0) - (b[index] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }, [normalizeVersion]);
  const createInitialUpdaterState = () => ({
    phase: "idle",
    installedVersion,
    latestVersion: "",
    publishedAt: "",
    releaseNotes: "",
    feedUrl: UPDATE_FEED_URL || "",
    downloadProgress: { downloaded: 0, total: 0, percent: 0 },
    signatureVerified: false,
    errorCode: "",
    errorMessage: "",
    lastCheckedAt: "",
  });
  const [updaterState, setUpdaterState] = useState(createInitialUpdaterState);
  const updateAvailable = updaterState.phase === "update_available";
  const updateDownloaded = updaterState.phase === "downloaded";
  const canInstallUpdate = updateDownloaded && updaterState.signatureVerified;
  const progressPercent = Math.max(0, Math.min(100, Number(updaterState.downloadProgress.percent || 0)));
  const displayLatestVersion = updaterState.latestVersion || (updaterState.phase === "checking" ? "Checking update feed" : "Not checked");
  const updateStatusText = (() => {
    if (updaterState.phase === "checking") return "Checking update feed";
    if (updaterState.phase === "update_available") return `Update available: ${updaterState.latestVersion}`;
    if (updaterState.phase === "downloading") return `Downloading ${progressPercent || 0}%`;
    if (updaterState.phase === "downloaded") return "Update downloaded and signature verified";
    if (updaterState.phase === "installing") return "Installing update";
    if (updaterState.phase === "error") return updaterState.errorMessage || "Update check failed";
    if (updaterState.phase === "up_to_date") return "FroozERP is up to date";
    return "Ready to check for updates";
  })();
  const downloadStatus = updaterState.phase === "downloading"
    ? `Downloading ${progressPercent || 0}%`
    : updateDownloaded
      ? "Downloaded"
      : updateAvailable
        ? "Ready to download"
        : "Not required";
  const signatureStatus = updaterState.signatureVerified ? "Verified" : updateDownloaded ? "Not verified" : "Not checked";
  const formatBytes = (value) => {
    const bytes = Number(value || 0);
    if (!bytes) return "Not available";
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} bytes`;
  };
  const extractUpdateVersion = useCallback((data = {}) => {
    const candidates = [
      ["version", data.version],
      ["tag_name", data.tag_name],
      ["name", data.name],
      ["latest_version", data.latest_version],
      ["release_title", data.release_title],
    ];
    for (const [field, value] of candidates) {
      const parsed = normalizeVersion(value);
      if (parsed) return { version: parsed, sourceField: field, rawValue: String(value || "") };
    }
    return {
      version: "",
      sourceField: "",
      rawValue: "",
      diagnostic: `No parseable version found in fields: ${candidates.map(([field]) => field).join(", ")}`,
    };
  }, [normalizeVersion]);
  const fetchUpdateManifestDiagnostics = useCallback(async () => {
    try {
      const response = await axios.get(`${API_URL}/api/update/manifest`, {
        params: { url: UPDATE_FEED_URL },
        timeout: 12000,
      });
      return response.data || {};
    } catch {
      const response = await axios.get(UPDATE_FEED_URL, { timeout: 8000 });
      return response.data || {};
    }
  }, []);
  const mergeManifestDiagnostics = useCallback((baseState, manifest) => {
    const parsed = extractUpdateVersion(manifest);
    return {
      ...baseState,
      latestVersion: baseState.latestVersion || parsed.version || "",
      publishedAt: baseState.publishedAt || manifest.pub_date || manifest.published_at || "",
      releaseNotes: baseState.releaseNotes || manifest.notes || manifest.body || manifest.release_notes || "",
    };
  }, [extractUpdateVersion]);
  const checkForUpdates = useCallback(async () => {
    if (!feedConfigured) {
      setUpdaterState((current) => ({
        ...current,
        phase: "error",
        errorCode: "UPDATE_FEED_NOT_CONFIGURED",
        errorMessage: "Hosted update feed is not configured.",
      }));
      return;
    }
    if (["checking", "downloading", "installing"].includes(updaterState.phase)) return;
    const requestId = updateRequestIdRef.current + 1;
    updateRequestIdRef.current = requestId;
    const checkedAt = new Date().toISOString();
    updateObjectRef.current = null;
    downloadedUpdateRef.current = null;
    setUpdaterState((current) => ({
      ...current,
      phase: "checking",
      latestVersion: current.latestVersion && current.latestVersion === installedVersion ? current.latestVersion : "",
      downloadProgress: { downloaded: 0, total: 0, percent: 0 },
      signatureVerified: false,
      errorCode: "",
      errorMessage: "",
      lastCheckedAt: checkedAt,
    }));
    try {
      let update = null;
      let manifest = null;
      if (desktopUpdaterAvailable) {
        const { check } = await import("@tauri-apps/plugin-updater");
        update = await check();
        manifest = await fetchUpdateManifestDiagnostics().catch(() => null);
      } else {
        manifest = await fetchUpdateManifestDiagnostics();
      }
      if (updateRequestIdRef.current !== requestId) return;
      const manifestVersion = manifest ? extractUpdateVersion(manifest).version : "";
      const updateVersion = normalizeVersion(update?.version || "");
      const latestVersion = updateVersion || manifestVersion || "";
      const comparison = latestVersion ? compareVersions(latestVersion, installedVersion) : 0;
      const nextPhase = update ? "update_available" : comparison > 0 ? "update_available" : "up_to_date";
      updateObjectRef.current = update || null;
      setUpdaterState((current) => mergeManifestDiagnostics({
        ...current,
        phase: nextPhase,
        latestVersion: latestVersion || installedVersion,
        publishedAt: update?.date || current.publishedAt,
        releaseNotes: update?.body || current.releaseNotes,
        signatureVerified: false,
        errorCode: "",
        errorMessage: "",
      }, manifest));
    } catch (error) {
      if (updateRequestIdRef.current !== requestId) return;
      setUpdaterState((current) => ({
        ...current,
        phase: "error",
        errorCode: navigator.onLine === false ? "OFFLINE" : "UPDATE_CHECK_FAILED",
        errorMessage: getErrorMessage(error, navigator.onLine === false ? "Offline - unable to check updates" : "Update check failed"),
      }));
    }
  }, [
    compareVersions,
    desktopUpdaterAvailable,
    extractUpdateVersion,
    feedConfigured,
    fetchUpdateManifestDiagnostics,
    installedVersion,
    mergeManifestDiagnostics,
    normalizeVersion,
    updaterState.phase,
  ]);
  useEffect(() => {
    if (autoCheckStartedRef.current) return;
    autoCheckStartedRef.current = true;
    checkForUpdates();
  }, [checkForUpdates]);
  useEffect(() => {
    invokeTauriCommand("install_diagnostics")
      .then((diagnostics) => {
        if (diagnostics) setInstallDiagnostics(diagnostics);
      })
      .catch(() => {});
  }, []);
  const downloadUpdate = async () => {
    if (!updateObjectRef.current) {
      setUpdaterState((current) => ({
        ...current,
        phase: "error",
        errorCode: "NO_UPDATE_OBJECT",
        errorMessage: "Check for updates first in the installed Windows app.",
      }));
      return;
    }
    try {
      setUpdaterState((current) => ({
        ...current,
        phase: "downloading",
        downloadProgress: { downloaded: 0, total: 0, percent: 0 },
        signatureVerified: false,
        errorCode: "",
        errorMessage: "",
      }));
      let downloaded = 0;
      let total = 0;
      await updateObjectRef.current.download((event) => {
        if (event.event === "Started") {
          total = Number(event.data?.contentLength || 0);
        } else if (event.event === "Progress") {
          downloaded += Number(event.data?.chunkLength || 0);
        } else if (event.event === "Finished") {
          downloaded = total || downloaded;
        }
        setUpdaterState((current) => ({
          ...current,
          downloadProgress: {
            downloaded,
            total,
            percent: total ? Math.round((downloaded / total) * 100) : 0,
          },
        }));
      });
      downloadedUpdateRef.current = updateObjectRef.current;
      setUpdaterState((current) => ({
        ...current,
        phase: "downloaded",
        signatureVerified: true,
        downloadProgress: {
          downloaded: downloaded || total,
          total,
          percent: total ? 100 : current.downloadProgress.percent,
        },
      }));
    } catch (error) {
      setUpdaterState((current) => ({
        ...current,
        phase: "error",
        errorCode: "UPDATE_DOWNLOAD_FAILED",
        errorMessage: getErrorMessage(error, "Update download failed. The current version remains usable."),
      }));
    }
  };
  const verifyInstallPreflight = async () => {
    const localStatus = await invokeTauriCommand("local_db_status");
    const pendingSync = await invokeTauriCommand("sync_outbox_count");
    if (pendingSync && Number(pendingSync) > 0) {
      throw new Error(`There are ${pendingSync} pending local sync operation(s). Sync before installing the update.`);
    }
    if (localStatus?.initialized === false) {
      throw new Error("Local database is not ready. Restart FroozERP before installing the update.");
    }
    return { localStatus, pendingSync: Number(pendingSync || 0) };
  };
  const installAndRestart = async () => {
    const updateToInstall = downloadedUpdateRef.current || updateObjectRef.current;
    if (!canInstallUpdate || !updateToInstall) {
      setUpdaterState((current) => ({
        ...current,
        errorCode: "NO_VERIFIED_DOWNLOAD",
        errorMessage: "No newer signature-verified downloaded update is ready to install.",
      }));
      return;
    }
    const confirmed = window.confirm(
      "Install the downloaded FroozERP update and restart now?\n\nConfirm only after POS billing, purchase saving and sync activity are idle. Local SQLite data, device identity and settings remain in the app data folder."
    );
    if (!confirmed) {
      setUpdaterState((current) => ({ ...current, errorMessage: "Install postponed by owner." }));
      return;
    }
    try {
      setUpdaterState((current) => ({ ...current, phase: "installing", errorCode: "", errorMessage: "" }));
      await verifyInstallPreflight();
      await updateToInstall.install();
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    } catch (error) {
      setUpdaterState((current) => ({
        ...current,
        phase: "error",
        errorCode: "UPDATE_INSTALL_FAILED",
        errorMessage: getErrorMessage(error, "Update install failed. The current version remains usable."),
      }));
    }
  };
  const detectOldVersions = async () => {
    try {
      setCleanupBusy(true);
      const result = await invokeTauriCommand("detect_old_froozerp_versions");
      if (!result) {
        setUpdaterState((current) => ({ ...current, errorMessage: "Old version cleanup is available only in the Windows desktop app." }));
        return;
      }
      setCleanupResult(result);
      setUpdaterState((current) => ({ ...current, errorMessage: `${result.candidates?.length || 0} safe cleanup item(s) found. Data path is excluded.` }));
    } catch (error) {
      setUpdaterState((current) => ({ ...current, errorMessage: getErrorMessage(error, "Unable to detect old FroozERP versions") }));
    } finally {
      setCleanupBusy(false);
    }
  };
  const cleanOldVersions = async () => {
    if (!canManage || cleanupBusy) return;
    const count = cleanupResult?.candidates?.length || 0;
    const confirmed = window.confirm(
      `Clean ${count} old FroozERP shortcut/install item(s)?\n\nBusiness data will be preserved:\n${cleanupResult?.data_path || "%APPDATA%\\com.srtcompany.froozerp"}`
    );
    if (!confirmed) return;
    try {
      setCleanupBusy(true);
      const result = await invokeTauriCommand("clean_old_froozerp_versions");
      if (!result) {
        setUpdaterState((current) => ({ ...current, errorMessage: "Old version cleanup is available only in the Windows desktop app." }));
        return;
      }
      setCleanupResult(result);
      setUpdaterState((current) => ({ ...current, errorMessage: `Old application files cleaned. Business data preserved. Removed ${result.removed?.length || 0}; blocked ${result.blocked?.length || 0}.` }));
    } catch (error) {
      setUpdaterState((current) => ({ ...current, errorMessage: getErrorMessage(error, "Unable to clean old FroozERP versions") }));
    } finally {
      setCleanupBusy(false);
    }
  };
  const buttonsBusy = ["checking", "downloading", "installing"].includes(updaterState.phase);
  return (
    <ModuleCard eyebrow="Software Updates" title="FroozERP Windows Updates" subtitle="Signed in-app updates with owner confirmation and local data preservation checks.">
      <div className={updateAvailable ? "update-available-panel" : "update-foundation-panel"}>
        <strong>{updateStatusText}</strong>
        <div className="cleanup-result-grid">
          <SummaryMetric label="Installed App Version" value={updaterState.installedVersion} featured />
          <SummaryMetric label="Latest Available Version" value={displayLatestVersion} />
          <SummaryMetric label="Status" value={updateStatusText} />
          <SummaryMetric label="Published" value={updaterState.publishedAt ? new Date(updaterState.publishedAt).toLocaleString("en-IN") : "Not available"} />
          <SummaryMetric label="Download Status" value={downloadStatus} />
          <SummaryMetric label="Signature Status" value={signatureStatus} />
          <SummaryMetric label="Last Checked" value={updaterState.lastCheckedAt ? new Date(updaterState.lastCheckedAt).toLocaleString("en-IN") : "Not checked"} />
          <SummaryMetric label="Download Size" value={formatBytes(updaterState.downloadProgress.total)} />
          <SummaryMetric label="Current Executable" value={installDiagnostics?.current_executable || "Desktop diagnostic pending"} />
        </div>
        {updaterState.releaseNotes && <span>{updaterState.releaseNotes}</span>}
        <small>Update Feed: {updaterState.feedUrl || "Not Configured"}</small>
        {installDiagnostics?.stale_installations?.map((path) => (
          <small key={path}>Another FroozERP installation was detected at {path}.</small>
        ))}
        {updaterState.errorCode && <small>Error Code: {updaterState.errorCode}</small>}
      </div>
      <p className="form-note">{updaterState.errorMessage || "Tauri updater is authoritative for availability, signature verification, download and installation. Backend manifest is diagnostics only."}</p>
      {updaterState.phase === "downloading" && (
        <div className="update-download-progress">
          <div className="update-download-progress-bar" style={{ width: `${progressPercent}%` }} />
          <small>{progressPercent ? `${progressPercent}%` : "Downloading"} - {formatBytes(updaterState.downloadProgress.downloaded)} of {formatBytes(updaterState.downloadProgress.total)}</small>
        </div>
      )}
      <div className="button-row">
        <button className="secondary-button" disabled={!canManage || !feedConfigured || buttonsBusy} onClick={checkForUpdates}>Check for Updates</button>
        <button className="secondary-button" disabled={!canManage || !desktopUpdaterAvailable || !updateAvailable || updateDownloaded || buttonsBusy} onClick={downloadUpdate}>Download Update</button>
        <button className="primary-button" disabled={!canManage || !desktopUpdaterAvailable || !canInstallUpdate || buttonsBusy} onClick={installAndRestart}>Install and Restart</button>
        {updateAvailable && <button className="secondary-button" disabled={!canManage || buttonsBusy} onClick={() => setUpdaterState((current) => ({ ...current, errorMessage: "Reminder saved for this session." }))}>Remind Me Later</button>}
      </div>
      <div className="maintenance-cleanup-panel">
        <strong>Updates / Maintenance</strong>
        <span>Clean old FroozERP app shortcuts and duplicate install folders. SQLite, backups, logs, device identity, user settings and pending sync data are never removed.</span>
        <div className="button-row">
          <button className="secondary-button" disabled={!canManage || cleanupBusy} onClick={detectOldVersions}>Detect Old FroozERP Versions</button>
          <button className="primary-button" disabled={!canManage || cleanupBusy || !(cleanupResult?.candidates?.length)} onClick={cleanOldVersions}>Clean Old FroozERP Versions</button>
        </div>
        {cleanupResult && (
          <div className="cleanup-result-grid">
            <SummaryMetric label="Install Path" value={cleanupResult.install_path || "Unknown"} />
            <SummaryMetric label="Data Path Preserved" value={cleanupResult.data_path || "Unknown"} />
            <SummaryMetric label="Safe Items" value={cleanupResult.candidates?.length || 0} />
            <SummaryMetric label="Removed" value={cleanupResult.removed?.length || 0} />
            <SummaryMetric label="Blocked / Manual" value={cleanupResult.blocked?.length || 0} />
          </div>
        )}
        {Boolean(cleanupResult?.candidates?.length) && (
          <div className="cleanup-path-list">
            <strong>Safe cleanup candidates</strong>
            {cleanupResult.candidates.map((item) => (
              <small key={`${item.kind}-${item.path}`}>{item.action}: {item.path} — {item.reason}</small>
            ))}
          </div>
        )}
        {Boolean(cleanupResult?.blocked?.length) && (
          <div className="cleanup-path-list cleanup-blocked-list">
            <strong>Blocked / manual review</strong>
            {cleanupResult.blocked.map((item) => (
              <small key={`${item.kind}-${item.path}`}>{item.path} — {item.reason}</small>
            ))}
          </div>
        )}
      </div>
    </ModuleCard>
  );
}

function SyncSettingsSection({
  backendHealth,
  canManage,
  cloudDeviceRegistration,
  cloudDiagnostics,
  cloudHealth,
  connectionStatus,
  localBackendService,
  localDbStatus,
  onCheckConnection,
  onQueueSyncTest,
  onReload,
  onRetrySync,
  onRunCloudDiagnostics,
  onRunSync,
  syncMessage,
  settingsData,
  syncSettings,
  syncStatus,
  user,
}) {
  const [draft, setDraft] = useState(syncSettings || {});
  const [statusMessage, setStatusMessage] = useState("");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [cloudReadiness, setCloudReadiness] = useState(null);
  const [cloudReadinessBusy, setCloudReadinessBusy] = useState(false);
  const [configDraft, setConfigDraft] = useState({
    mode: API_CONFIG.mode,
    cloudConnectionMode: normalizeCloudConnectionMode(SAVED_API_CONFIG.cloudConnectionMode),
    localApiUrl: API_CONFIG.localApiUrl,
    branchLanApiUrl: BRANCH_LAN_API_URL,
    cloudApiUrl: CLOUD_API_URL,
    customApiUrl: CUSTOM_API_URL,
    branchServerBindHost: API_CONFIG.branchServerBindHost,
    branchServerPort: API_CONFIG.branchServerPort,
  });
  const [configMessage, setConfigMessage] = useState("");
  const save = async () => {
    try {
      const response = await axios.put(`${API_URL}/settings/sync-status`, {
        device_display_name: draft.device_display_name || "Main Counter Device",
        updated_by: user.id,
      });
      setDraft((current) => ({ ...current, ...response.data }));
      await onReload();
      setStatusMessage("Device display name saved");
      alert("Device display name saved");
    } catch (error) {
      setStatusMessage(getErrorMessage(error, "Unable to save device display name"));
      alert(getErrorMessage(error, "Unable to save device display name"));
    }
  };
  const modeNeedsBranchUrl = configDraft.mode === API_MODES.BRANCH_LAN_CLIENT;
  const modeNeedsCloudUrl = configDraft.mode === API_MODES.CLOUD_PRODUCTION || configDraft.mode === API_MODES.FIELD_REMOTE_DEVICE;
  const modeNeedsCustomUrl = configDraft.mode === API_MODES.CUSTOM_API_URL;
  const selectedTestUrl = modeNeedsBranchUrl
    ? configDraft.branchLanApiUrl
    : modeNeedsCloudUrl
      ? configDraft.cloudApiUrl
      : modeNeedsCustomUrl
        ? configDraft.customApiUrl
        : configDraft.localApiUrl;
  const testApiUrl = async (url, label = "API") => {
    const apiUrl = normalizeApiBase(url);
    if (!isValidHttpApiUrl(apiUrl)) {
      setConfigMessage(`${label} URL is invalid. Use http:// or https://.`);
      return false;
    }
    try {
      const response = await axios.get(`${apiUrl}/api/health`, { timeout: 3500, headers: { "Cache-Control": "no-store" } });
      const health = response.data || {};
      const healthOk = response.status >= 200 && response.status < 300 && String(health.status || "").toLowerCase() === "ok";
      const cloudIdentityOk = !modeNeedsCloudUrl || (
        health.app === "FroozERP"
        && String(health.api_version) === "1"
        && Boolean(health.version)
        && health.deployment_type === "cloud"
        && health.cloud_ready === true
        && Boolean(health.company_id)
      );
      const ok = healthOk && cloudIdentityOk;
      setConfigMessage(ok
        ? `${label} connection passed`
        : healthOk && modeNeedsCloudUrl
          ? `${label} responded, but it is not a configured FroozERP cloud deployment`
          : `${label} responded but health is not ok`);
      return ok;
    } catch (error) {
      setConfigMessage(`${label} connection failed: ${getErrorMessage(error, "Backend not reachable")}`);
      return false;
    }
  };
  const runCloudReadinessCheck = async () => {
    const cloudUrl = normalizeApiBase(configDraft.cloudApiUrl || CLOUD_API_URL);
    const deviceId = draft.device_id || localDbStatus?.deviceId || localDbStatus?.deviceIdentity?.device_id || "";
    const branchId = String(user?.branch_id || draft.branch_id || localDbStatus?.branchId || localDbStatus?.deviceIdentity?.branch_id || "").trim();
    const setResult = (status, detail) => {
      setCloudReadiness({ status, detail, checkedAt: new Date().toISOString() });
      return status;
    };
    if (configDraft.mode === API_MODES.FIELD_REMOTE_DEVICE) {
      return setResult("Field Remote Not Ready", "Remote purchase/offline sync handlers are not implemented. This mode cannot be marked production-ready.");
    }
    if (normalizeCloudConnectionMode(configDraft.cloudConnectionMode) === CLOUD_CONNECTION_MODES.SIMULATE_OFFLINE) {
      return setResult("Cloud Paused By Owner", "Simulated Offline Mode is active. FroozERP cloud checks and sync are intentionally blocked while local backend stays usable.");
    }
    if (!cloudUrl) {
      return setResult("Cloud Not Configured", "Cloud is not configured yet. Local and LAN modes can still work.");
    }
    if (!isValidHttpApiUrl(cloudUrl) || !isRealCloudUrl(cloudUrl)) {
      return setResult("Cloud URL Invalid", "Use a real hosted HTTPS cloud backend URL. Localhost and LAN IPs are not cloud.");
    }
    if (!deviceId) {
      return setResult("Device Not Registered", "This device identity is not available for cloud sync yet.");
    }
    if (!branchId) {
      return setResult("Branch Not Selected", "Select or assign a branch before enabling cloud sync.");
    }
    if (failed > 0) {
      return setResult("Failed Sync Exists", `${failed} failed sync operation${failed === 1 ? "" : "s"} need review first.`);
    }
    if (pending > 0) {
      return setResult("Pending Sync Exists", `${pending} pending sync operation${pending === 1 ? "" : "s"} must be handled before cloud cutover.`);
    }

    setCloudReadinessBusy(true);
    try {
      const response = await axios.get(`${cloudUrl}/api/health`, { timeout: 5000, headers: { "Cache-Control": "no-store" } });
      const health = response.data || {};
      const ok = response.status >= 200 && response.status < 300 && String(health.status || "").toLowerCase() === "ok";
      const version = health.version || health.appVersion;
      const expectedCloudIdentity = health.app === "FroozERP"
        && String(health.api_version) === "1"
        && Boolean(version)
        && health.deployment_type === "cloud"
        && health.cloud_ready === true
        && Boolean(health.company_id);
      if (!ok) {
        return setResult("Cloud Server Unreachable", "Cloud health endpoint did not report ok.");
      }
      if (!expectedCloudIdentity) {
        return setResult("Cloud Server Unreachable", "Server responded, but the FroozERP app/version/company cloud identity is incomplete.");
      }
      if (String(health.database || health.dbStatus || "").toLowerCase().includes("error")) {
        return setResult("Cloud Server Unreachable", "Cloud backend is reachable, but database health is not ready.");
      }
      const readinessResponse = await axios.get(`${cloudUrl}/api/cloud/readiness`, { timeout: 5000, headers: { "Cache-Control": "no-store" } });
      const readiness = readinessResponse.data || {};
      if (readiness.cloud_ready !== true || readiness.readiness !== "deployment_ready") {
        const blockers = Array.isArray(readiness.blockers) && readiness.blockers.length
          ? ` Missing: ${readiness.blockers.join(", ")}.`
          : "";
        return setResult("Cloud Configuration Incomplete", `Hosted backend responded but deployment readiness checks did not pass.${blockers}`);
      }
      return setResult("Cloud Deployment Ready", `Hosted API and PostgreSQL readiness checks passed at version ${version}. Full business-module sync is still not production-ready.`);
    } catch (error) {
      return setResult("Cloud Server Unreachable", getErrorMessage(error, "Cloud backend health endpoint is not reachable."));
    } finally {
      setCloudReadinessBusy(false);
    }
  };
  const saveApiConfig = async () => {
    if (!canManage) return;
    const nextConfig = {
      mode: normalizeApiMode(configDraft.mode),
      cloudConnectionMode: normalizeCloudConnectionMode(configDraft.cloudConnectionMode),
      localApiUrl: normalizeApiBase(configDraft.localApiUrl) || "http://127.0.0.1:5000",
      branchLanApiUrl: normalizeApiBase(configDraft.branchLanApiUrl),
      cloudApiUrl: normalizeApiBase(configDraft.cloudApiUrl),
      customApiUrl: normalizeApiBase(configDraft.customApiUrl),
      branchServerBindHost: String(configDraft.branchServerBindHost || "0.0.0.0").trim(),
      branchServerPort: String(configDraft.branchServerPort || "5000").trim(),
      companyId: CONFIGURED_COMPANY_ID,
      branchId: CONFIGURED_BRANCH_ID,
      subBranchId: CONFIGURED_SUB_BRANCH_ID,
      deviceId: CONFIGURED_DEVICE_ID,
      deviceName: CONFIGURED_DEVICE_NAME,
    };
    if (nextConfig.mode === API_MODES.BRANCH_LAN_CLIENT) {
      if (!isValidHttpApiUrl(nextConfig.branchLanApiUrl)) {
        setConfigMessage("Branch LAN Client requires a branch server API URL such as http://192.168.1.41:5000.");
        return;
      }
      const ok = await testApiUrl(nextConfig.branchLanApiUrl, "Branch server");
      if (!ok && !window.confirm("Branch server health check failed. Save this URL anyway?")) return;
    }
    if (nextConfig.mode === API_MODES.CLOUD_PRODUCTION && nextConfig.cloudApiUrl && !isRealCloudUrl(nextConfig.cloudApiUrl)) {
      setConfigMessage("Cloud Production requires a real hosted cloud URL. Localhost, LAN IPs and :5000 are not cloud.");
      return;
    }
    if (nextConfig.mode === API_MODES.FIELD_REMOTE_DEVICE) {
      if (!nextConfig.cloudApiUrl) {
        setConfigMessage("Field Remote Device saved as not ready: Cloud Production URL and purchase offline sync are required.");
      } else if (!isRealCloudUrl(nextConfig.cloudApiUrl)) {
        setConfigMessage("Field Remote Device requires a real hosted cloud URL, not localhost or LAN.");
        return;
      }
    }
    if (nextConfig.mode === API_MODES.CUSTOM_API_URL && !isValidHttpApiUrl(nextConfig.customApiUrl)) {
      setConfigMessage("Custom API URL is invalid. Use http:// or https://.");
      return;
    }
    writeSavedApiConfig(nextConfig);
    setConfigMessage("API mode saved. FroozERP will reload to apply it.");
    window.setTimeout(() => window.location.reload(), 500);
  };
  const pending = Number(syncStatus?.pendingOperations ?? draft.pending_count ?? 0);
  const failed = Number(syncStatus?.failedOperations || 0);
  const conflicts = Number(syncStatus?.conflictOperations || 0);
  const appMode = connectionStatus?.apiModeLabel || getApiModeLabel();
  const internetStatus = connectionStatus?.internetStatus || "Not checked";
  const localServerStatus = connectionStatus?.localBackendStatus || "Not checked";
  const cloudStatus = connectionStatus?.cloudBackendStatus || "Cloud Not Configured";
  const syncSummary = connectionStatus?.syncSummary || "Backend status not checked";
  const branchRecord = (settingsData?.branches || []).find((branch) => String(branch.id) === String(user?.branch_id || draft.branch_id || "1"));
  const branchLabel = branchRecord?.branch_name || user?.branch_name || draft.branch_name || "Main Branch";
  const fieldRemoteWarning = API_MODE === API_MODES.FIELD_REMOTE_DEVICE
    ? "Field Remote Device requires Cloud Production + purchase offline sync. Current version can prepare configuration but cannot safely sync remote purchase entries yet."
    : "";
  const nativeDbLabel = localDbStatus?.available
    ? localDbStatus.initialized ? "Local SQLite Ready" : "Local SQLite Error"
    : "Browser Mode";
  const lastSync = syncStatus?.lastSuccessfulSyncAt || draft.last_sync_at;
  const lastPush = syncStatus?.lastPushAt;
  const lastPull = syncStatus?.lastPullAt;
  const cloudRegistrationAvailable = Boolean(cloudDeviceRegistration && typeof cloudDeviceRegistration === "object" && Object.keys(cloudDeviceRegistration).length > 0);
  const cloudDeviceStatus = cloudRegistrationAvailable
    ? cloudDeviceRegistration?.status || "Not checked"
    : "Cloud device registration is not available for the current mode.";
  const cloudDeviceDetail = cloudRegistrationAvailable
    ? cloudDeviceRegistration?.message || cloudDeviceRegistration?.detail || "No registration detail available."
    : "Cloud device registration is not available for the current mode.";
  return (
    <ModuleCard eyebrow="Sync & Connection" title="Connection Status" subtitle="Owner view for live internet, local server and cloud sync readiness.">
      <div className="sync-owner-summary">
        {[
          ["App Mode", appMode],
          ["Internet", internetStatus],
          ["Local Server", localServerStatus],
          ["Cloud", cloudStatus],
          ["Sync Status", syncSummary],
          ["Pending Sync", pending],
          ["Last Sync", lastSync ? new Date(lastSync).toLocaleString("en-IN") : "Not synced"],
        ].map(([label, value]) => (
          <div className="sync-owner-row" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="toolbar-actions">
        <button className="secondary-button" disabled={!onCheckConnection} onClick={onCheckConnection}>Check Connection</button>
        <button className="secondary-button" disabled={!canManage || !onRunSync} onClick={onRunSync}>Sync Now</button>
        <button className="secondary-button" disabled={!canManage || !onRetrySync} onClick={onRetrySync}>Retry Failed</button>
        <button className="secondary-button" onClick={() => setShowDiagnostics((current) => !current)}>Advanced Diagnostics</button>
      </div>
      {showDiagnostics && cloudReadiness && (
        <p className={cloudReadiness.status === "Cloud Deployment Ready" ? "form-note stock-ok" : "form-note"}>
          <strong>{cloudReadiness.status}</strong> - {cloudReadiness.detail}
        </p>
      )}
      {showDiagnostics && (
        <div className="sync-diagnostics-panel">
          <div>
            <span className="eyebrow">Connection Mode Setup</span>
            <h3>Connection Mode Setup</h3>
          </div>
          <div className="toolbar-actions">
            <button className="secondary-button" disabled={!canManage || !onRunCloudDiagnostics} onClick={onRunCloudDiagnostics}>Run Cloud Diagnostics</button>
          </div>
          <div className="form-grid supplier-form-grid">
            <Field label="Select App Mode">
              <select disabled={!canManage} value={configDraft.mode} onChange={(event) => setConfigDraft({ ...configDraft, mode: event.target.value })}>
                {API_MODE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="FroozERP Cloud Connection">
              <select disabled={!canManage} value={configDraft.cloudConnectionMode} onChange={(event) => setConfigDraft({ ...configDraft, cloudConnectionMode: normalizeCloudConnectionMode(event.target.value) })}>
                <option value={CLOUD_CONNECTION_MODES.ONLINE}>Online</option>
                <option value={CLOUD_CONNECTION_MODES.SIMULATE_OFFLINE}>Simulate Offline</option>
              </select>
            </Field>
          </div>
          {configDraft.cloudConnectionMode === CLOUD_CONNECTION_MODES.SIMULATE_OFFLINE && <p className="form-note stock-low">Simulated Offline Mode - Internet stays available, but FroozERP cloud, sync, provider, email and SMS calls are paused inside the app.</p>}
          {configDraft.mode === API_MODES.LOCAL_SINGLE_DEVICE && <p className="form-note">Local Single Device uses this computer's local backend.</p>}
          {configDraft.mode === API_MODES.BRANCH_LAN_SERVER && <p className="form-note">Branch LAN Server is for the main shop computer serving same-branch devices over Wi-Fi/LAN.</p>}
          {configDraft.mode === API_MODES.BRANCH_LAN_CLIENT && <p className="form-note">Branch LAN Client must use the main branch server IP. It is same Wi-Fi/LAN only, not cloud.</p>}
          {configDraft.mode === API_MODES.CLOUD_PRODUCTION && <p className="form-note">Cloud Production requires a real hosted backend URL. Blank, localhost, and LAN URLs remain Cloud Not Configured.</p>}
          {configDraft.mode === API_MODES.FIELD_REMOTE_DEVICE && <p className="form-note stock-low">Field Remote Device is not ready without hosted cloud plus purchase offline sync.</p>}
          {configDraft.mode === API_MODES.CUSTOM_API_URL && <p className="form-note">Custom API URL must pass the FroozERP health check before production use.</p>}
          {fieldRemoteWarning && <p className="form-note stock-low">{fieldRemoteWarning}</p>}
          {configMessage && <p className="form-note">{configMessage}</p>}
          {(statusMessage || syncMessage || syncStatus?.lastError) && <p className="form-note">{syncMessage || statusMessage || syncStatus?.lastError}</p>}
          {localDbStatus?.error && <p className="form-note stock-low">{localDbStatus.error}</p>}
          <div className="form-grid supplier-form-grid">
            {modeNeedsBranchUrl && (
              <Field label="Branch Server URL/IP"><input disabled={!canManage} placeholder="http://192.168.1.41:5000" value={configDraft.branchLanApiUrl} onChange={(event) => setConfigDraft({ ...configDraft, branchLanApiUrl: event.target.value })} /></Field>
            )}
            {modeNeedsCloudUrl && (
              <Field label="Cloud API URL"><input disabled={!canManage} placeholder="https://api.froozerp.com" value={configDraft.cloudApiUrl} onChange={(event) => setConfigDraft({ ...configDraft, cloudApiUrl: event.target.value })} /></Field>
            )}
            {modeNeedsCustomUrl && (
              <Field label="Custom API URL"><input disabled={!canManage} placeholder="https://backend.example.com" value={configDraft.customApiUrl} onChange={(event) => setConfigDraft({ ...configDraft, customApiUrl: event.target.value })} /></Field>
            )}
            <Field label="Branch"><input disabled value={branchLabel} /></Field>
            <Field label="Device ID"><input disabled value={draft.device_id || "LOCAL-STORE"} /></Field>
            <Field label="Device Display Name"><input disabled={!canManage} value={draft.device_display_name || ""} onChange={(event) => setDraft({ ...draft, device_display_name: event.target.value })} /></Field>
            <Field label="Local SQLite Path"><input disabled value={localDbStatus?.databasePath || "Available in FroozERP desktop app"} /></Field>
            <Field label="Local Schema Version"><input disabled value={localDbStatus?.schemaVersion || "Not initialized"} /></Field>
            <Field label="Last Push"><input disabled value={lastPush ? new Date(lastPush).toLocaleString("en-IN") : "Not pushed"} /></Field>
            <Field label="Last Pull"><input disabled value={lastPull ? new Date(lastPull).toLocaleString("en-IN") : "Not pulled"} /></Field>
            <Field label="API Mode"><input disabled value={API_CONFIG.mode} /></Field>
            <Field label="Configured Company ID"><input disabled value={API_CONFIG.companyId} /></Field>
            <Field label="Configured Branch ID"><input disabled value={API_CONFIG.branchId} /></Field>
            <Field label="Configured Sub-Branch ID"><input disabled value={API_CONFIG.subBranchId} /></Field>
            <Field label="Configured Device ID"><input disabled value={API_CONFIG.deviceId} /></Field>
            <Field label="Configured Device Name"><input disabled value={API_CONFIG.deviceName} /></Field>
            <Field label="Selected API URL"><input disabled value={API_CONFIG.apiUrl} /></Field>
            <Field label="Last Health Check"><input disabled value={connectionStatus?.lastHealthCheck || "Not checked"} /></Field>
            <Field label="Pending Queue Count"><input disabled value={connectionStatus?.pending ?? pending} /></Field>
            <Field label="Failed Queue Count"><input disabled value={connectionStatus?.failed ?? failed} /></Field>
            <Field label="Conflict Queue Count"><input disabled value={conflicts} /></Field>
            <Field label="Local Database"><input disabled value={nativeDbLabel} /></Field>
            <Field label="FroozERP Cloud Access"><input disabled value={connectionStatus?.froozErpCloudAccess || "Online"} /></Field>
            <Field label="Local API URL"><input disabled value={API_CONFIG.localApiUrl} /></Field>
            <Field label="Branch LAN API URL"><input disabled value={API_CONFIG.branchLanApiUrl} /></Field>
            <Field label="Cloud API URL"><input disabled value={API_CONFIG.cloudApiUrl} /></Field>
            <Field label="Custom API URL"><input disabled value={API_CONFIG.customApiUrl} /></Field>
            <Field label="Branch Server Bind Host"><input disabled value={API_CONFIG.branchServerBindHost} /></Field>
            <Field label="Branch Server Port"><input disabled value={API_CONFIG.branchServerPort} /></Field>
            <Field label="Settings API Base"><input disabled value={backendHealth?.apiUrl || API_URL} /></Field>
            <Field label="Sync Worker API Base"><input disabled value={syncStatus?.apiUrl || API_URL} /></Field>
            <Field label="Backend Health URL"><input disabled value={backendHealth?.url || `${API_URL}/api/health`} /></Field>
            <Field label="Desktop Backend Status"><input disabled value={localBackendService?.healthy === true ? "Healthy" : localBackendService?.healthy === false ? "Stopped" : "Not checked"} /></Field>
            <Field label="Desktop Backend PID"><input disabled value={localBackendService?.pid || "Not owned by this app"} /></Field>
            <Field label="Desktop Backend Startup Source"><input disabled value={localBackendService?.startup_source || localBackendService?.startupSource || "Not checked"} /></Field>
            <Field label="Desktop Backend Node Runtime"><input disabled value={localBackendService?.node_path || localBackendService?.nodePath || "Not checked"} /></Field>
            <Field label="Desktop Backend Directory"><input disabled value={localBackendService?.backend_dir || localBackendService?.backendDir || "Not checked"} /></Field>
            <Field label="Desktop Backend Detail"><input disabled value={localBackendService?.message || "Not checked"} /></Field>
            <Field label="Cloud Health URL"><input disabled value={cloudHealth?.url || `${CLOUD_API_URL}/api/health`} /></Field>
            <Field label="Cloud Health Detail"><input disabled value={cloudHealth?.message || "Not checked"} /></Field>
            <Field label="Cloud Device Status"><input disabled value={cloudDeviceStatus} /></Field>
            <Field label="Cloud Device Detail"><input disabled value={cloudDeviceDetail} /></Field>
            <Field label="Last Sync Failure"><input disabled value={syncStatus?.lastError || backendHealth?.message || "None"} /></Field>
            <Field label="Current Cursor"><input disabled value={syncStatus?.currentCursor || "0"} /></Field>
            <label className="check-field"><input checked={draft.sync_enabled === true} disabled type="checkbox" /><span>Sync foundation enabled for approved native devices</span></label>
            <Field label="Notes"><textarea disabled value={draft.notes || "Cloud sync foundation is active for reference data and safe test entities."} /></Field>
          </div>
          <div className="toolbar-actions">
            <button className="primary-button" disabled={!canManage} onClick={saveApiConfig}>Save Mode</button>
            <button className="secondary-button" disabled={!canManage || !selectedTestUrl} onClick={() => testApiUrl(selectedTestUrl, "Selected API")}>Test Connection</button>
            <button className="primary-button" disabled={!canManage} onClick={save}>Save Device Name</button>
            <button className="secondary-button" disabled={cloudReadinessBusy} onClick={runCloudReadinessCheck}>{cloudReadinessBusy ? "Checking Cloud..." : "Cloud Readiness Check"}</button>
            <button className="secondary-button" disabled={!canManage || !onQueueSyncTest} onClick={onQueueSyncTest}>Queue Safe Test</button>
          </div>
          {cloudDiagnostics?.results?.length > 0 && (
            <DataTable headers={["Check", "Result", "URL", "HTTP", "Message"]}>
              {cloudDiagnostics.results.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td><span className={row.ok ? "stock-ok" : "stock-low"}>{row.ok ? "Passed" : "Failed"}</span></td>
                  <td><small>{row.url}</small></td>
                  <td>{row.httpStatus || "-"}</td>
                  <td>{row.message}</td>
                </tr>
              ))}
            </DataTable>
          )}
        </div>
      )}
    </ModuleCard>
  );
}

function SecurityDevicesSection({ activationCodes, branches, canManage, counters, devices, onReload, user }) {
  const [generatedCode, setGeneratedCode] = useState("");
  const [codeDraft, setCodeDraft] = useState({ code_label: "Counter device activation", expires_in_hours: 24, branch_id: "1", counter_id: "" });
  const deviceAction = async (device, action) => {
    try {
      await axios.put(`${API_URL}/settings/devices/${encodeURIComponent(device.device_id)}`, {
        action,
        updated_by: user.id,
        device_name: device.device_name,
        assigned_branch_id: device.assigned_branch_id || 1,
        assigned_counter_id: device.assigned_counter_id || null,
      });
      await onReload();
      alert(`Device ${action.toLowerCase()} saved`);
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update device"));
    }
  };
  const generateCode = async () => {
    try {
      const response = await axios.post(`${API_URL}/settings/activation-codes`, {
        ...codeDraft,
        created_by: user.id,
      });
      setGeneratedCode(response.data.code);
      await onReload();
      alert("Activation code generated. Share it only with the device being approved.");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to generate activation code"));
    }
  };
  const revokeCode = async (code) => {
    try {
      await axios.put(`${API_URL}/settings/activation-codes/${code.id}/revoke`, { updated_by: user.id });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to revoke activation code"));
    }
  };
  return (
    <ModuleCard eyebrow="Security" title="Authorized Devices" subtitle="Only approved browsers can use FroozERP after login. New devices stay pending until approved or activated by one-time code.">
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric featured label="Approved Devices" value={devices.filter((device) => device.status === "APPROVED").length} />
        <SummaryMetric label="Pending Requests" value={devices.filter((device) => device.status === "PENDING").length} />
        <SummaryMetric label="Activation Codes" value={activationCodes.filter((code) => code.status === "ACTIVE").length} />
      </div>
      <DataTable headers={["Device", "Type", "Branch / Counter", "Status", "Last Active", "Last Sync", "Actions"]}>
        {devices.map((device) => (
          <tr key={device.device_id}>
            <td className="primary-cell">{device.device_name}<small className="cell-note">{device.device_id}</small></td>
            <td>{device.device_type || "Browser"}</td>
            <td>{device.branch_name || "Main Branch"}<small className="cell-note">{device.counter_name || "No counter assigned"}</small></td>
            <td><span className={device.status === "APPROVED" ? "stock-ok" : device.status === "PENDING" ? "origin-rate" : "stock-low"}>{device.status}</span></td>
            <td>{device.last_active_at ? new Date(device.last_active_at).toLocaleString("en-IN") : "Not active yet"}</td>
            <td>{device.last_sync_at ? new Date(device.last_sync_at).toLocaleString("en-IN") : "Not synced"}<small className="cell-note">{device.sync_status || "IDLE"} {device.app_version ? `- v${device.app_version}` : ""}</small></td>
            <td>
              <div className="button-row table-actions-row">
                <button className="table-action" disabled={!canManage || device.status === "APPROVED"} onClick={() => deviceAction(device, "APPROVE")}>Approve</button>
                <button className="secondary-button" disabled={!canManage} onClick={() => deviceAction(device, "RENAME")}>Save</button>
                <button className="remove-button" disabled={!canManage} onClick={() => deviceAction(device, device.status === "PENDING" ? "REJECT" : "DISABLE")}>{device.status === "PENDING" ? "Reject" : "Disable"}</button>
              </div>
            </td>
          </tr>
        ))}
        {devices.length === 0 && <tr><td colSpan="7" className="empty-cell">No device requests yet.</td></tr>}
      </DataTable>
      <div className="form-grid supplier-form-grid">
        <Field label="Activation Label"><input disabled={!canManage} value={codeDraft.code_label} onChange={(event) => setCodeDraft({ ...codeDraft, code_label: event.target.value })} /></Field>
        <Field label="Expires In Hours"><input disabled={!canManage} min="1" type="number" value={codeDraft.expires_in_hours} onChange={(event) => setCodeDraft({ ...codeDraft, expires_in_hours: event.target.value })} /></Field>
        <Field label="Branch">
          <select disabled={!canManage} value={codeDraft.branch_id} onChange={(event) => setCodeDraft({ ...codeDraft, branch_id: event.target.value })}>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_name}</option>)}
          </select>
        </Field>
        <Field label="Counter Optional">
          <select disabled={!canManage} value={codeDraft.counter_id} onChange={(event) => setCodeDraft({ ...codeDraft, counter_id: event.target.value })}>
            <option value="">No counter limit</option>
            {counters.map((counter) => <option key={counter.id} value={counter.id}>{counter.counter_name}</option>)}
          </select>
        </Field>
      </div>
      <div className="button-row">
        <button className="primary-button" disabled={!canManage} onClick={generateCode}>Generate Activation Code</button>
        {generatedCode && <span className="batch-id">New Code: {generatedCode}</span>}
      </div>
      <DataTable headers={["Label", "Branch", "Counter", "Expires", "Status", "Used By", "Actions"]}>
        {activationCodes.map((code) => (
          <tr key={code.id}>
            <td className="primary-cell">{code.code_label || "Activation Code"}</td>
            <td>{code.branch_name || "Any"}</td>
            <td>{code.counter_name || "Any"}</td>
            <td>{code.expires_at ? new Date(code.expires_at).toLocaleString("en-IN") : "-"}</td>
            <td><span className={code.status === "ACTIVE" ? "stock-ok" : "stock-low"}>{code.status}</span></td>
            <td>{code.used_by_device_id || "-"}</td>
            <td><button className="remove-button" disabled={!canManage || code.status !== "ACTIVE"} onClick={() => revokeCode(code)}>Revoke</button></td>
          </tr>
        ))}
      </DataTable>
    </ModuleCard>
  );
}

function BranchCounterSettings({ branches, canManage, counters, onReload, user }) {
  const [branchDraft, setBranchDraft] = useState({ branch_name: "", address: "", phone_number: "", gst_number: "", active: true });
  const [counterDraft, setCounterDraft] = useState({ branch_id: "1", counter_name: "", counter_type: "RETAIL_COUNTER", active: true });
  const addBranch = async () => {
    try {
      await axios.post(`${API_URL}/settings/branches`, { ...branchDraft, updated_by: user.id });
      setBranchDraft({ branch_name: "", address: "", phone_number: "", gst_number: "", active: true });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save branch"));
    }
  };
  const addCounter = async () => {
    try {
      await axios.post(`${API_URL}/settings/counters`, { ...counterDraft, updated_by: user.id });
      setCounterDraft({ branch_id: "1", counter_name: "", counter_type: "RETAIL_COUNTER", active: true });
      await onReload();
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save counter"));
    }
  };
  return (
    <ModuleCard eyebrow="Multi-Branch Foundation" title="Branch & Counter Master" subtitle="Future-ready branch/counter structure. Current store remains Main Branch unless more branches are added.">
      <div className="form-grid supplier-form-grid">
        <Field label="Branch Name"><input disabled={!canManage} value={branchDraft.branch_name} onChange={(event) => setBranchDraft({ ...branchDraft, branch_name: event.target.value })} /></Field>
        <Field label="Phone"><input disabled={!canManage} value={branchDraft.phone_number} onChange={(event) => setBranchDraft({ ...branchDraft, phone_number: event.target.value })} /></Field>
        <Field label="GST Number"><input disabled={!canManage} value={branchDraft.gst_number} onChange={(event) => setBranchDraft({ ...branchDraft, gst_number: event.target.value })} /></Field>
        <Field label="Address"><input disabled={!canManage} value={branchDraft.address} onChange={(event) => setBranchDraft({ ...branchDraft, address: event.target.value })} /></Field>
        <button className="primary-button" disabled={!canManage || !branchDraft.branch_name.trim()} onClick={addBranch}>Add Branch</button>
      </div>
      <DataTable headers={["Branch", "Address", "Phone", "GST", "Status"]}>
        {branches.map((branch) => <tr key={branch.id}><td className="primary-cell">{branch.branch_name}</td><td>{branch.address || branch.location || "-"}</td><td>{branch.phone_number || "-"}</td><td>{branch.gst_number || "-"}</td><td><span className={branch.active !== false ? "stock-ok" : "stock-low"}>{branch.active !== false ? "Active" : "Inactive"}</span></td></tr>)}
      </DataTable>
      <div className="form-grid supplier-form-grid">
        <Field label="Branch">
          <select disabled={!canManage} value={counterDraft.branch_id} onChange={(event) => setCounterDraft({ ...counterDraft, branch_id: event.target.value })}>
            {branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.branch_name}</option>)}
          </select>
        </Field>
        <Field label="Counter Name"><input disabled={!canManage} value={counterDraft.counter_name} onChange={(event) => setCounterDraft({ ...counterDraft, counter_name: event.target.value })} /></Field>
        <Field label="Counter Type">
          <select disabled={!canManage} value={counterDraft.counter_type} onChange={(event) => setCounterDraft({ ...counterDraft, counter_type: event.target.value })}>
            <option value="RETAIL_COUNTER">Retail Counter</option>
            <option value="OWNER_DASHBOARD">Owner Dashboard</option>
            <option value="BACK_OFFICE">Back Office</option>
          </select>
        </Field>
        <button className="primary-button" disabled={!canManage || !counterDraft.counter_name.trim()} onClick={addCounter}>Add Counter</button>
      </div>
      <DataTable headers={["Counter", "Branch", "Type", "Status"]}>
        {counters.map((counter) => <tr key={counter.id}><td className="primary-cell">{counter.counter_name}</td><td>{counter.branch_name || "-"}</td><td>{counter.counter_type}</td><td><span className={counter.active !== false ? "stock-ok" : "stock-low"}>{counter.active !== false ? "Active" : "Inactive"}</span></td></tr>)}
      </DataTable>
    </ModuleCard>
  );
}

function BackupSettings({ backupLogs = [], backupSettings, canManage, onReload, user }) {
  const [draft, setDraft] = useState({
    auto_backup_enabled: backupSettings?.auto_backup_enabled !== false,
    backup_on_shutdown: backupSettings?.backup_on_shutdown !== false,
    daily_backup_time: backupSettings?.daily_backup_time || "23:59",
    keep_last_backups: backupSettings?.keep_last_backups || 30,
    backup_location: backupSettings?.backup_location || "",
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    try {
      await axios.put(`${API_URL}/settings/backup`, { ...draft, updated_by: user.id });
      await onReload();
      alert("Backup settings saved");
    } catch (error) {
      alert(getErrorMessage(error, "Unable to save backup settings"));
    }
  };
  const backupNow = async (backupType = "Manual") => {
    setBusy(true);
    try {
      const response = await axios.post(`${API_URL}/settings/backup-now`, { created_by: user.id, backup_type: backupType });
      await onReload();
      alert(`Backup created: ${response.data.backup_file_name}`);
    } catch (error) {
      alert(getErrorMessage(error, "Backup failed"));
    } finally {
      setBusy(false);
    }
  };
  const safeShutdown = async () => {
    if (!window.confirm("Run shutdown backup now? After success, close the server window manually.")) return;
    setBusy(true);
    try {
      const response = await axios.post(`${API_URL}/settings/safe-shutdown`, { created_by: user.id });
      await onReload();
      alert(response.data.message || "Backup completed. You may now close the server window.");
    } catch (error) {
      alert(getErrorMessage(error, "Safe shutdown backup failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModuleCard eyebrow="Backup & Restore" title="Auto Backup and Safe Shutdown" subtitle="Manual, scheduled and shutdown backup workflow. Restore is prepared but kept disabled until verified.">
      <div className="purchase-summary-grid">
        <SummaryMetric label="Auto Backup" value={draft.auto_backup_enabled ? "ON" : "OFF"} featured />
        <SummaryMetric label="Backup on Shutdown" value={draft.backup_on_shutdown ? "ON" : "OFF"} />
        <SummaryMetric label="Daily Backup Time" value={draft.daily_backup_time} />
        <SummaryMetric label="Keep Backups" value={draft.keep_last_backups} />
      </div>
      <div className="form-grid supplier-form-grid">
        <label className="check-field"><input checked={draft.auto_backup_enabled} disabled={!canManage} type="checkbox" onChange={(event) => setDraft({ ...draft, auto_backup_enabled: event.target.checked })} /><span>Auto Backup ON/OFF</span></label>
        <label className="check-field"><input checked={draft.backup_on_shutdown} disabled={!canManage} type="checkbox" onChange={(event) => setDraft({ ...draft, backup_on_shutdown: event.target.checked })} /><span>Backup on Shutdown</span></label>
        <Field label="Daily Backup Time"><input disabled={!canManage} type="time" value={draft.daily_backup_time} onChange={(event) => setDraft({ ...draft, daily_backup_time: event.target.value })} /></Field>
        <Field label="Keep Last X Backups"><input disabled={!canManage} min="1" type="number" value={draft.keep_last_backups} onChange={(event) => setDraft({ ...draft, keep_last_backups: event.target.value })} /></Field>
        <Field label="Backup Location"><input disabled={!canManage} value={draft.backup_location} onChange={(event) => setDraft({ ...draft, backup_location: event.target.value })} /></Field>
      </div>
      <div className="button-row">
        <button className="primary-button" disabled={!canManage || busy} onClick={() => backupNow("Manual")}>Backup Now</button>
        <button className="secondary-button" disabled={!canManage || busy} onClick={save}>Save Backup Settings</button>
        <button className="secondary-button" disabled={!canManage || busy} onClick={safeShutdown}>Close Software Safely</button>
        <button className="remove-button" disabled>Restore Prepared - Disabled</button>
      </div>
      <p className="form-note">Restore requires Owner permission and remains disabled until backup verification testing is completed.</p>
      <DataTable headers={["File", "Type", "Size", "Started", "Completed", "Status", "Error"]}>
        {backupLogs.map((log) => (
          <tr key={log.id}>
            <td className="primary-cell">{log.backup_file_name || "-"}<small className="cell-note">{log.backup_path || "-"}</small></td>
            <td>{log.backup_type}</td>
            <td>{Number(log.backup_size || 0).toLocaleString("en-IN")} bytes</td>
            <td>{log.started_at ? new Date(log.started_at).toLocaleString("en-IN") : "-"}</td>
            <td>{log.completed_at ? new Date(log.completed_at).toLocaleString("en-IN") : "-"}</td>
            <td><span className={log.status === "SUCCESS" ? "stock-ok" : log.status === "FAILED" ? "stock-low" : "origin-rate"}>{log.status}</span></td>
            <td>{log.error_message || "-"}</td>
          </tr>
        ))}
      </DataTable>
    </ModuleCard>
  );
}

function SystemInfoSection({ systemInfo }) {
  const device = systemInfo.currentDevice || {};
  const branch = systemInfo.currentBranch || {};
  const backup = systemInfo.lastBackup || {};
  const androidUrl = systemInfo.lanFrontendUrl || (systemInfo.serverIp ? `http://${systemInfo.serverIp}:5173` : "-");
  return (
    <ModuleCard eyebrow="System Info" title="Server, Network and Device Status" subtitle="Use the LAN URL from another device on the same shop network.">
      <section className="about-frooz-panel">
        <BrandLogo />
        <div>
          <span className="eyebrow">About FroozERP</span>
          <h3>{APP_DISPLAY_NAME}</h3>
          <p>By {APP_COMPANY}</p>
          <small>Version {APP_VERSION} - Device {device.device_id || "Not registered"} - Platform {device.device_type || "Windows/Desktop or Browser"}</small>
        </div>
      </section>
      <div className="purchase-summary-grid supplier-payment-preview">
        <SummaryMetric featured label="Backend" value={systemInfo.backendStatus || "Unknown"} />
        <SummaryMetric label="Database" value={systemInfo.databaseStatus || "Unknown"} />
        <SummaryMetric label="Server IP" value={systemInfo.serverIp || "-"} />
        <SummaryMetric label="Device Status" value={device.status || "Not registered"} />
      </div>
      <DataTable headers={["Item", "Value"]}>
        <tr><td>Software Version</td><td>{systemInfo.softwareVersion || APP_VERSION}</td></tr>
        <tr><td>Display Branding</td><td>{APP_DISPLAY_NAME}</td></tr>
        <tr><td>Company</td><td>{APP_COMPANY}</td></tr>
        <tr><td>LAN API URL</td><td>{systemInfo.lanApiUrl || "-"}</td></tr>
        <tr><td>LAN Frontend URL</td><td>{systemInfo.lanFrontendUrl || "-"}</td></tr>
        <tr><td>Android Chrome URL</td><td>{androidUrl}</td></tr>
        <tr><td>Current Device</td><td>{device.device_name || "-"} ({device.device_id || "-"})</td></tr>
        <tr><td>Current Device Type</td><td>{device.device_type || "Browser"}</td></tr>
        <tr><td>Current Branch</td><td>{branch.branch_name || "Main Branch"}</td></tr>
        <tr><td>Current Counter</td><td>{device.counter_name || device.assigned_counter_id || "Not assigned"}</td></tr>
        <tr><td>Last Backup</td><td>{backup.completed_at ? new Date(backup.completed_at).toLocaleString("en-IN") : "Not recorded"}</td></tr>
        <tr><td>Backup Location</td><td>{systemInfo.backupLocation || "-"}</td></tr>
      </DataTable>
      <section className="android-help-card">
        <span className="eyebrow">Android Connection Guide</span>
        <ol>
          <li>Connect the Android phone or tablet to the same Wi-Fi as the FroozERP server computer.</li>
          <li>Open Chrome and enter <strong>{androidUrl}</strong>.</li>
          <li>Login with your FroozERP user. If device approval appears, approve it from an already approved Owner device.</li>
          <li>For counter tablets, assign the device as Retail Counter Tablet from Authorized Devices.</li>
          <li>Use Chrome menu → Add to Home screen to install the FroozERP shortcut.</li>
        </ol>
        <p>Android devices use the same backend and database. No separate phone/tablet database is created.</p>
      </section>
    </ModuleCard>
  );
}

function SaleRateManager({ desiredMargin, history, onRefresh, onReload, rates, setDesiredMargin, user }) {
  const [search, setSearch] = useState("");
  const [origin, setOrigin] = useState("");
  const [category, setCategory] = useState("");
  const [draftRates, setDraftRates] = useState({});
  const [selectedSuggested, setSelectedSuggested] = useState({});
  const [confirmUpdates, setConfirmUpdates] = useState(null);
  const categories = [...new Set(rates.map((rate) => rate.category).filter(Boolean))];
  const filteredRates = rates.filter((rate) =>
    rate.product_name.toLowerCase().includes(search.toLowerCase()) &&
    (!origin || rate.origin_type === origin) &&
    (!category || rate.category === category)
  );

  const buildRateUpdates = () => Object.entries(draftRates)
    .map(([rowId, value]) => {
      const rate = rates.find((item) => String(item.id) === String(rowId));
      return rate ? {
        product_id: Number(rate.product_id || rate.id),
        inventory_batch_id: rate.inventory_batch_id || null,
        product_name: rate.product_name,
        lot_name: rate.lot_name,
        lot_size: rate.lot_size,
        old_rate: Number(rate.selling_rate || 0),
        new_selling_rate: Number(value),
      } : null;
    })
    .filter(Boolean);

  const requestSaveRates = () => {
    const updates = buildRateUpdates();
    if (updates.length === 0) {
      alert("Select at least one product rate to update.");
      return;
    }
    const invalid = updates.find((update) => !Number.isFinite(update.new_selling_rate) || update.new_selling_rate <= 0);
    if (invalid) {
      alert("New Rate must be greater than 0 for every selected product.");
      return;
    }
    setConfirmUpdates(updates);
  };

  const saveRates = async () => {
    const updates = confirmUpdates || buildRateUpdates();
    const invalid = updates.find((update) => !Number.isFinite(update.new_selling_rate) || update.new_selling_rate <= 0);
    if (updates.length === 0 || invalid) {
      alert("Select valid rates before saving.");
      return;
    }
    const payloadUpdates = updates.map((update) => ({
      product_id: update.product_id,
      inventory_batch_id: update.inventory_batch_id || null,
      new_selling_rate: update.new_selling_rate,
    }));
    try {
      await axios.post(`${API_URL}/sale-rates/bulk`, { updates: payloadUpdates, changed_by: user.id });
      setDraftRates({});
      setSelectedSuggested({});
      setConfirmUpdates(null);
      await onReload();
      alert(`${updates.length} selling rate${updates.length === 1 ? "" : "s"} updated successfully.`);
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update selling rates"));
    }
  };

  const toggleSuggestedRate = (rate, checked) => {
    setSelectedSuggested((current) => ({ ...current, [rate.id]: checked }));
    setDraftRates((current) => {
      const next = { ...current };
      if (checked) next[rate.id] = Number(rate.suggested_selling_rate || 0);
      else delete next[rate.id];
      return next;
    });
  };

  const selectVisibleSuggestedRates = () => {
    const selected = {};
    const drafts = {};
    for (const rate of filteredRates) {
      selected[rate.id] = true;
      drafts[rate.id] = Number(rate.suggested_selling_rate || 0);
    }
    setSelectedSuggested((current) => ({ ...current, ...selected }));
    setDraftRates((current) => ({ ...current, ...drafts }));
  };

  const allVisibleSelected = filteredRates.length > 0 && filteredRates.every((rate) => Boolean(selectedSuggested[rate.id]));
  const toggleAllVisible = (checked) => {
    if (checked) {
      selectVisibleSuggestedRates();
      return;
    }
    const visibleIds = new Set(filteredRates.map((rate) => String(rate.id)));
    setSelectedSuggested((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !visibleIds.has(String(id)))));
    setDraftRates((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !visibleIds.has(String(id)))));
  };

  return (
    <section className="settings-layout">
      <ModuleCard eyebrow="Owner Controls" title="Daily Sale Rate Update" subtitle="Review landed costs, suggested rates, and approve daily selling-rate changes. Suggestions never auto-apply.">
        <div className="rate-toolbar">
          <input placeholder="Search products" value={search} onChange={(event) => setSearch(event.target.value)} />
          <select value={origin} onChange={(event) => setOrigin(event.target.value)}><option value="">All Origins</option><option value="LOCAL">Local</option><option value="IMPORTED">Imported</option></select>
          <select value={category} onChange={(event) => setCategory(event.target.value)}><option value="">All Categories</option>{categories.map((item) => <option key={item}>{item}</option>)}</select>
          <input min="0" placeholder="Desired margin %" step="0.1" type="number" value={desiredMargin} onChange={(event) => setDesiredMargin(event.target.value)} />
          <button className="secondary-button" onClick={() => onRefresh(desiredMargin)}>Refresh Suggestions</button>
          <button className="secondary-button" onClick={selectVisibleSuggestedRates}>Select Visible Suggestions</button>
          <button className="primary-button" onClick={requestSaveRates}>Save Rates</button>
        </div>
        <DataTable headers={[
          <label className="table-check-label"><input checked={allVisibleSelected} type="checkbox" onChange={(event) => toggleAllVisible(event.target.checked)} /> Select All Suggested Rates</label>,
          "Product", "Lot", "Size", "Origin", "Current Lot Sale Rate", "Suggested Rate", "New Rate", "Latest Purchase Cost", "Stock", "Pending Bill Stock", "Margin %", "Updated", "Updated By",
        ]}>
          {filteredRates.map((rate) => {
            const sellingRate = Number(draftRates[rate.id] || rate.selling_rate);
            const cost = Number(rate.latest_effective_cost || 0);
            const margin = sellingRate > 0 ? ((sellingRate - cost) / sellingRate) * 100 : 0;
            return (
              <tr key={rate.id}>
                <td><input checked={Boolean(selectedSuggested[rate.id])} type="checkbox" onChange={(event) => toggleSuggestedRate(rate, event.target.checked)} /></td>
                <td className="primary-cell">{rate.product_name}<small className="cell-note">{rate.category}</small></td>
                <td>{rate.lot_name || (rate.inventory_batch_id ? `Lot #${rate.inventory_batch_id}` : "Product default")}</td>
                <td>{rate.lot_size || "-"}</td>
                <td><span className="tag">{rate.origin_type}</span></td>
                <td>{currency.format(Number(rate.selling_rate))}</td>
                <td className="profit-cell">{currency.format(Number(rate.suggested_selling_rate))}</td>
                <td><input className="table-input" min="0" step="0.01" type="number" value={draftRates[rate.id] || ""} onChange={(event) => setDraftRates({ ...draftRates, [rate.id]: event.target.value })} /></td>
                <td>{currency.format(cost)}</td>
                <td>{rate.current_stock}</td>
                <td>{Number(rate.pending_bill_stock || 0) > 0 ? <span className="stock-low">{rate.pending_bill_stock} - provisional profit</span> : "-"}</td>
                <td><span className={margin < 15 ? "stock-low" : "stock-ok"}>{margin.toFixed(1)}%</span></td>
                <td>{rate.selling_rate_updated_at ? new Date(rate.selling_rate_updated_at).toLocaleDateString("en-IN") : "-"}</td>
                <td>{rate.updated_by_name || "-"}</td>
              </tr>
            );
          })}
        </DataTable>
      </ModuleCard>
      <ModuleCard eyebrow="Audit Trail" title="Sale Rate History" subtitle="Every approved selling-rate change is stored for reporting and accountability.">
        <DataTable headers={["Changed At", "Product", "Old Rate", "New Rate", "Changed By", "Reason"]}>
          {history.map((item) => <tr key={item.id}><td>{new Date(item.changed_at).toLocaleString("en-IN")}</td><td className="primary-cell">{item.product_name}</td><td>{currency.format(Number(item.old_selling_rate))}</td><td className="profit-cell">{currency.format(Number(item.new_selling_rate))}</td><td>{item.changed_by_name}</td><td>{item.reason || "-"}</td></tr>)}
        </DataTable>
      </ModuleCard>
      {confirmUpdates && (
        <div className="modal-backdrop">
          <section className="invoice-modal change-history-modal">
            <div className="invoice-toolbar">
              <div>
                <span className="eyebrow">Confirm Sale Rate Update</span>
                <strong>Are you sure you want to update selected sale rates?</strong>
              </div>
              <button aria-label="Close confirmation" className="remove-button" onClick={() => setConfirmUpdates(null)}><Icon name="close" /></button>
            </div>
            <div className="sale-edit-body">
              <div className="purchase-summary-grid supplier-payment-preview">
                <SummaryMetric label="Selected Products" value={confirmUpdates.length} featured />
              </div>
              <DataTable headers={["Product", "Old Rate", "New Rate"]}>
                {confirmUpdates.map((update) => (
                  <tr key={update.product_id}>
                    <td className="primary-cell">{update.product_name}<small className="cell-note">{[update.lot_name, update.lot_size].filter(Boolean).join(" / ") || "Product default"}</small></td>
                    <td>{currency.format(update.old_rate)}</td>
                    <td className="profit-cell">{currency.format(update.new_selling_rate)}</td>
                  </tr>
                ))}
              </DataTable>
              <div className="button-row">
                <button className="primary-button" onClick={saveRates}>Confirm Save Rates</button>
                <button className="secondary-button" onClick={() => setConfirmUpdates(null)}>Cancel</button>
              </div>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}

const calculateDiscountFromRule = (rule, subtotal) => {
  if (!rule || subtotal <= 0) return 0;
  const value = Number(rule.discount_value || 0);
  const amount = rule.discount_type === "PERCENTAGE" ? subtotal * value / 100 : value;
  return Math.min(amount, subtotal);
};

const getMatchingDiscountRule = (rules, subtotal, paymentMode) => {
  if (subtotal <= 0) return null;
  const matches = rules
    .filter((rule) =>
      rule.active !== false &&
      Number(rule.minimum_bill_amount || 0) <= subtotal &&
      (!rule.maximum_bill_amount || Number(rule.maximum_bill_amount) >= subtotal) &&
      (rule.payment_mode === "ALL" || rule.payment_mode === paymentMode)
    )
    .sort((left, right) => {
      if (left.payment_mode === paymentMode && right.payment_mode !== paymentMode) return -1;
      if (right.payment_mode === paymentMode && left.payment_mode !== paymentMode) return 1;
      return Number(right.minimum_bill_amount || 0) - Number(left.minimum_bill_amount || 0) || Number(right.discount_value || 0) - Number(left.discount_value || 0);
    });
  return matches[0] || null;
};

const currentDateTimeLocal = () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

function PosBilling({ canManualRateOverride = false, canPosDateOverride = false, customers = [], deviceInfo = {}, discountRules = [], lotDiscounts = [], inventory, onConfigureMandiTax, onInvoice, onSaved, paymentSettings = {}, posSettings = {}, printSettings = {}, products, refreshToken = 0, saleRateSettings = {}, syncInBackground, user }) {
  const [search, setSearch] = useState("");
  const [barcode, setBarcode] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [lotSelectorProduct, setLotSelectorProduct] = useState(null);
  const [lotSelectorSearch, setLotSelectorSearch] = useState("");
  const [lotFilter, setLotFilter] = useState("AVAILABLE");
  const [lotSizeFilter, setLotSizeFilter] = useState("");
  const [lotUnitFilter, setLotUnitFilter] = useState("");
  const [lotRateMin, setLotRateMin] = useState("");
  const [lotRateMax, setLotRateMax] = useState("");
  const [showSoldOutLots, setShowSoldOutLots] = useState(false);
  const [cart, setCart] = useState([]);
  const [paymentMode, setPaymentMode] = useState("CASH");
  const [quantityMode, setQuantityMode] = useState(posSettings.enable_weighing_scale ? "SCALE" : "MANUAL");
  const [scaleMessage, setScaleMessage] = useState("");
  const [mixedPayments, setMixedPayments] = useState({ CASH: "", UPI: "", CARD: "", BANK_TRANSFER: "" });
  const [customer, setCustomer] = useState({ account_id: "", name: "", mobile: "", notes: "", system_account: false });
  const [creditInfo, setCreditInfo] = useState({ due_date: "", remarks: "" });
  const [billDateTime, setBillDateTime] = useState(currentDateTimeLocal);
  const [saving, setSaving] = useState(false);
  const [lastInvoice, setLastInvoice] = useState(null);
  const searchRef = useRef(null);
  const barcodeRef = useRef(null);
  const quantityRefs = useRef({});

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    setLotSelectorProduct(null);
    setLotSelectorSearch("");
    setLotFilter("AVAILABLE");
    setShowSoldOutLots(false);
    searchRef.current?.focus();
  }, [refreshToken]);

  const effectiveQuantityMode = posSettings.enable_weighing_scale ? quantityMode : "MANUAL";
  const lotSelectionMode = String(saleRateSettings.pos_lot_selection_mode || "ASK_MULTIPLE").toUpperCase();
  const canViewSoldOutLots = ["Owner", "Admin"].includes(user?.role);
  const lotBalance = (lot) => Number(lot?.remaining_qty ?? lot?.balance_qty ?? 0);
  const lotStatus = (lot) => {
    const status = String(lot?.batch_status || lot?.status || "ACTIVE").toUpperCase();
    if (status === "CANCELLED") return "Cancelled";
    if (status === "INACTIVE") return "Inactive";
    if (lotBalance(lot) <= 0) return "Sold Out";
    return "Active";
  };
  const isSelectableLot = (lot) => lotStatus(lot) === "Active" && lotBalance(lot) > 0;
  const lotSaleRateValue = (lot, product) => {
    const rate = Number(lot?.temporary_sale_rate ?? lot?.sale_rate ?? lot?.selling_rate ?? 0);
    return rate > 0 ? rate : Number(product?.selling_rate ?? product?.sale_rate ?? 0);
  };
  const lotDateKey = (lot) => toDateKey(lot?.purchase_date || lot?.opening_date || lot?.created_at || "");
  const lotStableName = (lot) => String(lot?.lot_name || lot?.batch_no || lot?.lot_no || lot?.id || "").trim();
  const newCartLineId = () => {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `pos-line-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  };
  const normalizeCartIdentityPart = (value) => String(value ?? "").trim().toLowerCase();
  const buildCartIdentity = ({ product, lot, unit, sellingRate }) => [
    product?.id,
    lot?.id || "FIFO",
    normalizeCartIdentityPart(lotStableName(lot)),
    normalizeCartIdentityPart(lot?.lot_size || lot?.size_grade || ""),
    normalizeCartIdentityPart(unit || product?.unit || lot?.unit || ""),
    Number(sellingRate || lotSaleRateValue(lot, product) || 0).toFixed(4),
  ].join("|");

  const stockByProduct = useMemo(
    () => inventory.reduce((stock, batch) => {
      if (lotStatus(batch) !== "Active") return stock;
      stock.set(batch.product_id, (stock.get(batch.product_id) || 0) + Math.max(lotBalance(batch), 0));
      return stock;
    }, new Map()),
    [inventory]
  );

  const lotsByProduct = useMemo(
    () => inventory.reduce((lots, batch) => {
      const rows = lots.get(batch.product_id) || [];
      rows.push(batch);
      lots.set(batch.product_id, rows);
      return lots;
    }, new Map()),
    [inventory]
  );

  const costByProduct = useMemo(
    () => inventory.reduce((costs, batch) => {
      const current = costs.get(batch.product_id);
      const cost = Number(batch.effective_cost_per_unit || batch.purchase_rate || 0);
      return costs.set(batch.product_id, current === undefined ? cost : Math.max(current, cost));
    }, new Map()),
    [inventory]
  );

  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase();
    const matchesProduct = (product) => {
      if (!query) return true;
      const lots = lotsByProduct.get(product.id) || [];
      return [
        product.product_name,
        product.category,
        product.category_name,
        product.barcode,
        product.unit,
        product.selling_rate,
        ...lots.flatMap((lot) => [
          lotStableName(lot),
          lot.lot_size,
          lot.size_grade,
          lot.unit || product.unit,
          lotSaleRateValue(lot, product),
          lotBalance(lot),
          lotStatus(lot),
          lotDateKey(lot),
        ]),
      ].some((value) => String(value ?? "").toLowerCase().includes(query));
    };
    return products
      .filter((product) => matchesProduct(product))
      .map((product) => ({ key: `product-${product.id}`, product, lotCount: (lotsByProduct.get(product.id) || []).filter(isSelectableLot).length }))
      .slice(0, 12);
  }, [lotsByProduct, products, search]);

  const salesMandiTaxBasisLabel = {
    GROSS_BEFORE_DISCOUNTS: "Gross item value before discounts",
    AFTER_ITEM_DISCOUNT: "Sale value after item discount",
    NET_AFTER_ALL_DISCOUNTS: "Net sale value after item and bill discounts",
  };

  const totals = useMemo(() => {
    const gross = cart.reduce((sum, item) => sum + item.quantity * Number(item.selling_rate), 0);
    const itemDiscount = cart.reduce((sum, item) => sum + Number(item.discount_amount || 0), 0);
    const subtotalAfterItemDiscounts = Math.max(gross - itemDiscount, 0);
    const discountRule = saleRateSettings.bill_level_slab_discount_enabled === false ? null : getMatchingDiscountRule(discountRules, gross, paymentMode);
    const invoiceDiscountAmount = Math.min(calculateDiscountFromRule(discountRule, gross), subtotalAfterItemDiscounts);
    const basis = String(paymentSettings.sales_mandi_tax_basis || "NET_AFTER_ALL_DISCOUNTS").toUpperCase();
    const customerScope = String(paymentSettings.sales_mandi_tax_customer_scope || "REGISTERED_CUSTOMERS").toUpperCase();
    const customerEligible = customerScope === "ALL_CUSTOMERS" || (customerScope === "REGISTERED_CUSTOMERS" && Boolean(customer.account_id) && customer.system_account !== true);
    const taxEligible = customerScope !== "NONE" && paymentSettings.enable_sales_mandi_tax === true && customerEligible && Number(paymentSettings.sales_mandi_tax_percent || 0) > 0;
    const taxableAmount = taxEligible
      ? Math.max(
          basis === "GROSS_BEFORE_DISCOUNTS"
            ? gross
            : basis === "AFTER_ITEM_DISCOUNT"
              ? subtotalAfterItemDiscounts
              : subtotalAfterItemDiscounts - invoiceDiscountAmount,
          0
        )
      : 0;
    const mandiTaxAmount = roundUi(taxableAmount * Number(paymentSettings.sales_mandi_tax_percent || 0) / 100);
    return {
      gross,
      itemDiscount,
      invoiceDiscount: invoiceDiscountAmount,
      taxableAmount,
      mandiTaxRate: taxEligible ? Number(paymentSettings.sales_mandi_tax_percent || 0) : 0,
      mandiTaxAmount,
      mandiTaxBasis: basis,
      discount: itemDiscount + invoiceDiscountAmount,
      total: Math.max(gross - itemDiscount - invoiceDiscountAmount + mandiTaxAmount, 0),
      itemCount: cart.reduce((sum, item) => sum + Number(item.quantity), 0),
      discountRule,
    };
  }, [cart, customer.account_id, customer.system_account, discountRules, paymentMode, paymentSettings.enable_sales_mandi_tax, paymentSettings.sales_mandi_tax_basis, paymentSettings.sales_mandi_tax_percent, saleRateSettings.bill_level_slab_discount_enabled]);

  const mixedPaymentModes = [
    ["CASH", "Cash Amount"],
    ["UPI", "UPI Amount"],
    ["CARD", "Card Amount"],
    ["BANK_TRANSFER", "Bank Transfer Amount"],
  ];
  const mixedAllocated = roundUi(mixedPaymentModes.reduce((sum, [mode]) => sum + Number(mixedPayments[mode] || 0), 0));
  const mixedRemaining = roundUi(Math.max(totals.total - mixedAllocated, 0));
  const mixedExcess = roundUi(Math.max(mixedAllocated - totals.total, 0));
  const isMixedPaymentBalanced = paymentMode !== "MIXED" || Math.abs(mixedAllocated - totals.total) <= 0.01;
  const hasInvalidMixedPayment = paymentMode === "MIXED" && mixedPaymentModes.some(([mode]) => Number(mixedPayments[mode] || 0) < 0);
  const registeredCustomerSelected = Boolean(customer.account_id) && customer.system_account !== true;
  const salesMandiCustomerScope = String(paymentSettings.sales_mandi_tax_customer_scope || "REGISTERED_CUSTOMERS").toUpperCase();
  const mandiTaxConfigured = paymentSettings.enable_sales_mandi_tax === true && Number(paymentSettings.sales_mandi_tax_percent || 0) > 0;
  const mandiTaxRelevantForCustomer = salesMandiCustomerScope === "ALL_CUSTOMERS" || (salesMandiCustomerScope === "REGISTERED_CUSTOMERS" && registeredCustomerSelected);
  const mandiTaxNeedsConfiguration = mandiTaxRelevantForCustomer && salesMandiCustomerScope !== "NONE" && paymentSettings.enable_sales_mandi_tax === true && Number(paymentSettings.sales_mandi_tax_percent || 0) <= 0;
  const mandiTaxDisabled = mandiTaxRelevantForCustomer && (salesMandiCustomerScope === "NONE" || paymentSettings.enable_sales_mandi_tax !== true);

  const getLotLabel = (lot) => lot ? [lot.lot_name || lot.batch_no, lot.lot_size].filter(Boolean).join(" / ") : "Auto FIFO";
  const getCompactLotName = (lot) => {
    const raw = String(lot?.lot_name || lot?.batch_no || "").trim();
    if (!raw) return "Auto FIFO";
    const parts = raw.split("-");
    if (parts.length >= 3 && /^\d{8,}$/.test(parts[1])) {
      return `${parts[0]}-${parts[parts.length - 1]}`;
    }
    return raw.length > 22 ? `${raw.slice(0, 18)}...` : raw;
  };

  const getActiveLotDiscount = (lotId) => {
    if (!lotId) return null;
    const today = toDateKey(new Date());
    return [...lotDiscounts]
      .filter((discount) =>
        Number(discount.inventory_batch_id) === Number(lotId) &&
        discount.active !== false &&
        (!discount.start_date || toDateKey(discount.start_date) <= today) &&
        (!discount.end_date || toDateKey(discount.end_date) >= today)
      )
      .sort((left, right) => Number(right.id || 0) - Number(left.id || 0))[0] || null;
  };

  const applyLotDiscount = (baseRate, quantity, discount) => {
    const rate = Number(baseRate || 0);
    const qty = Number(quantity || 0);
    if (!discount) return { sellingRate: rate, discountAmount: 0, discountPerUnit: 0 };
    const value = Number(discount.discount_value || 0);
    if (discount.discount_type === "SPECIAL_RATE") {
      return {
        sellingRate: value,
        discountAmount: 0,
        discountPerUnit: 0,
      };
    }
    const discountPerUnit = discount.discount_type === "PERCENTAGE"
      ? roundUi(rate * value / 100)
      : Math.min(value, rate);
    return {
      sellingRate: rate,
      discountAmount: roundUi(discountPerUnit * qty),
      discountPerUnit,
    };
  };

  const getCartQuantityForLot = (lotId, excludeLineId = "") =>
    cart
      .filter((item) => String(item.inventory_batch_id || "") === String(lotId || "") && item.line_id !== excludeLineId)
      .reduce((sum, item) => sum + Number(item.quantity || 0), 0);

  const openLotSelector = (product) => {
    const productLots = (lotsByProduct.get(product.id) || []).filter((lot) => {
      const status = lotStatus(lot);
      if (status === "Cancelled" || status === "Inactive") return false;
      return showSoldOutLots && canViewSoldOutLots ? true : lotBalance(lot) > 0;
    });
    if (productLots.length === 0) {
      alert(`No available stock lots found for ${product.product_name}.`);
      return;
    }
    setLotSelectorProduct(product);
    setLotSelectorSearch("");
    setLotFilter("AVAILABLE");
    setLotSizeFilter("");
    setLotUnitFilter("");
    setLotRateMin("");
    setLotRateMax("");
    setShowSoldOutLots(false);
  };

  const closeLotSelector = () => {
    setLotSelectorProduct(null);
    setLotSelectorSearch("");
  };

  const addProduct = (product, selectedLot = null) => {
    const productLots = (lotsByProduct.get(product.id) || []).filter(isSelectableLot);
    if (!selectedLot) {
      if (lotSelectionMode === "AUTO_FIFO" && productLots.length === 1) {
        selectedLot = productLots[0];
      } else {
        openLotSelector(product);
        return;
      }
    }
    const lot = selectedLot;
    if (!lot || !isSelectableLot(lot)) {
      alert("Please select an active lot with available stock.");
      return;
    }
    const availableStock = lotBalance(lot);
    const lotSaleRate = Number(lot?.temporary_sale_rate || lot?.sale_rate || lot?.selling_rate || 0);
    const defaultRate = lotSaleRate > 0 ? lotSaleRate : Number(product.selling_rate);
    const lotDiscount = getActiveLotDiscount(lot?.id);
    const discounted = applyLotDiscount(defaultRate, 1, lotDiscount);
    const cartIdentity = buildCartIdentity({ product, lot, unit: lot.unit || product.unit, sellingRate: discounted.sellingRate });
    const currentItem = cart.find((item) => item.cart_identity === cartIdentity);
    const nextQuantity = Number(currentItem?.quantity || 0) + 1;
    const nextLotQuantity = getCartQuantityForLot(lot.id) + 1;
    if (availableStock < nextLotQuantity) {
      const moreAvailable = Math.max(availableStock - getCartQuantityForLot(lot.id), 0);
      alert(`Only ${moreAvailable.toLocaleString("en-IN", { maximumFractionDigits: 3 })} more units are available in Lot ${lotStableName(lot) || lot.id}.`);
      return;
    }
    const lineId = currentItem?.line_id || newCartLineId();
    const nextDiscounted = applyLotDiscount(defaultRate, nextQuantity, lotDiscount);

    setCart((items) => currentItem
      ? items.map((item) => item.line_id === currentItem.line_id ? { ...item, quantity: nextQuantity, discount_amount: roundUi(Number(item.lot_discount_per_unit || 0) * nextQuantity) } : item)
      : [...items, {
        line_id: lineId,
        cart_key: lineId,
        cart_identity: cartIdentity,
        product_id: product.id,
        inventory_batch_id: lot.id,
        product_name: product.product_name,
        lot_name: lot.lot_name || lot.batch_no || "",
        lot_size: lot.lot_size || lot.size_grade || "",
        unit: lot.unit || product.unit,
        available_qty: availableStock,
        default_selling_rate: defaultRate,
        selling_rate: nextDiscounted.sellingRate,
        quantity: 1,
        discount_amount: nextDiscounted.discountAmount,
        lot_discount_id: lotDiscount?.id || null,
        lot_discount_type: lotDiscount?.discount_type || null,
        lot_discount_value: lotDiscount ? Number(lotDiscount.discount_value || 0) : 0,
        lot_discount_per_unit: nextDiscounted.discountPerUnit,
      }]
    );
    setSearch("");
    setHighlightedIndex(0);
    closeLotSelector();
    setTimeout(() => {
      const input = quantityRefs.current[lineId];
      input?.focus();
      input?.select();
    }, 0);
  };

  const updateCartItem = (lineId, field, value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return;
    if (field === "selling_rate" && !canManualRateOverride) {
      alert("You do not have permission to change sale rate.");
      return;
    }
    const currentItem = cart.find((item) => item.line_id === lineId);
    if (field === "quantity" && currentItem && number + getCartQuantityForLot(currentItem.inventory_batch_id, currentItem.line_id) > Number(currentItem.available_qty || 0)) {
      const moreAvailable = Math.max(Number(currentItem.available_qty || 0) - getCartQuantityForLot(currentItem.inventory_batch_id, currentItem.line_id), 0);
      alert(currentItem.inventory_batch_id ? `Only ${moreAvailable.toLocaleString("en-IN", { maximumFractionDigits: 3 })} more units are available in Lot ${currentItem.lot_name || currentItem.inventory_batch_id}.` : `Only ${currentItem.available_qty || 0} units are available.`);
      return;
    }
    setCart((items) => items.map((item) => {
      if (item.line_id !== lineId) return item;
      if (field === "quantity" && item.lot_discount_id) {
        return { ...item, quantity: value, discount_amount: roundUi(Number(item.lot_discount_per_unit || 0) * number) };
      }
      const updated = { ...item, [field]: value };
      if (field === "selling_rate") {
        updated.cart_identity = buildCartIdentity({
          product: { id: item.product_id, unit: item.unit, selling_rate: item.default_selling_rate },
          lot: { id: item.inventory_batch_id, lot_name: item.lot_name, lot_size: item.lot_size, unit: item.unit },
          unit: item.unit,
          sellingRate: value,
        });
      }
      return updated;
    }));
  };

  const completeQuantityEntry = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    setSearch("");
    setHighlightedIndex(0);
    searchRef.current?.focus();
  };

  const removeCartItem = (lineId) => {
    setCart((items) => items.filter((item) => item.line_id !== lineId));
  };

  const scanBarcode = () => {
    const code = barcode.trim();
    if (!code) return;
    const product = products.find((item) => item.barcode === code);
    if (!product) {
      alert(`No product is assigned to barcode ${code}`);
      barcodeRef.current?.focus();
    } else {
      openLotSelector(product);
    }
    setBarcode("");
  };

  const readScaleWeight = () => {
    setScaleMessage("Scale not connected - enter quantity manually.");
    const lastItem = cart.at(-1);
    if (lastItem) {
      const input = quantityRefs.current[lastItem.line_id];
      input?.focus();
      input?.select();
    }
  };

  const selectCustomer = (customerId) => {
    const selected = customers.find((item) => String(item.id) === String(customerId));
    if (!selected) {
      setCustomer({ account_id: "", name: "", mobile: "", notes: "", system_account: false });
      return;
    }
    setCustomer({
      account_id: selected.id,
      name: selected.customer_name || "",
      mobile: selected.mobile_number || "",
      notes: selected.notes || "",
      system_account: selected.system_account === true,
    });
  };

  const newSyncId = (prefix) => {
    const id = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${id}`;
  };

  const buildLocalSalePayload = ({ payments, selectedBillDate, dateOverrideReason }) => {
    const invoiceGlobalId = newSyncId("invoice");
    const offlineInvoiceRef = `OFF-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${String(Math.floor(Math.random() * 10000)).padStart(4, "0")}`;
    const savedCustomer = customer.account_id
      ? customer
      : { ...customer, name: "Walk-in Customer", mobile: customer.mobile || "", system_account: true };
    return {
      operation_id: newSyncId("op"),
      invoice_global_id: invoiceGlobalId,
      offline_invoice_ref: offlineInvoiceRef,
      branch_id: String(user.branch_id || 1),
      device_id: deviceInfo.device_id || newSyncId("device"),
      user_id: String(user.id || ""),
      customer: savedCustomer,
      bill_date: selectedBillDate,
      bill_datetime: billDateTime,
      payment_mode: paymentMode,
      gross_total: Number(totals.gross || 0),
      item_discount_total: Number(totals.itemDiscount || 0),
      bill_discount_total: Number(totals.invoiceDiscount || 0),
      taxable_amount: Number(totals.taxableAmount || 0),
      mandi_tax_rate: Number(totals.mandiTaxRate || 0),
      mandi_tax_basis: totals.mandiTaxBasis,
      tax_config_snapshot: totals.mandiTaxAmount > 0 ? {
        tax_type: "MANDI_TAX",
        tax_rate: Number(totals.mandiTaxRate || 0),
        taxable_basis: totals.mandiTaxBasis,
        taxable_amount: Number(totals.taxableAmount || 0),
        tax_amount: Number(totals.mandiTaxAmount || 0),
        effective_date: paymentSettings.sales_mandi_tax_effective_date || null,
        source: "payment_settings",
      } : null,
      tax_total: Number(totals.mandiTaxAmount || 0),
      net_total: Number(totals.total || 0),
      status: "COMPLETED",
      sync_status: "pending",
      entity_version: 1,
      date_override_reason: dateOverrideReason,
      items: cart.map((item) => {
        const itemGlobalId = newSyncId("line");
        const stockMovementId = newSyncId("stock");
        return {
          item_global_id: itemGlobalId,
          invoice_global_id: invoiceGlobalId,
          product_id: String(item.product_id),
          product_name: item.product_name,
          lot_id: item.inventory_batch_id ? String(item.inventory_batch_id) : "",
          lot_name: item.lot_name || "",
          lot_size: item.lot_size || "",
          quantity: Number(item.quantity),
          unit: item.unit || "",
          rate: Number(item.selling_rate),
          discount: Number(item.discount_amount || 0),
          amount: roundUi(Number(item.quantity) * Number(item.selling_rate) - Number(item.discount_amount || 0)),
          stock_movement_id: stockMovementId,
          available_qty: Number(item.available_qty || 0),
          selling_rate: Number(item.selling_rate),
          discount_amount: Number(item.discount_amount || 0),
          inventory_batch_id: item.inventory_batch_id ? Number(item.inventory_batch_id) : null,
          lot_discount_id: item.lot_discount_id || null,
          lot_discount_type: item.lot_discount_type || null,
          lot_discount_value: Number(item.lot_discount_value || 0),
        };
      }),
      payments: payments.map((payment) => ({
        posting_id: newSyncId("posting"),
        mode: payment.mode,
        amount: Number(payment.amount),
      })),
    };
  };

  const checkout = async (printAfterSave = false, confirmations = {}) => {
    if (saving && !confirmations.retry) return;
    if (cart.length === 0) {
      alert("Add at least one product before checkout.");
      return;
    }
    const today = toDateKey(new Date());
    const selectedBillDate = billDateTime ? billDateTime.slice(0, 10) : today;
    if (!canPosDateOverride && selectedBillDate !== today) {
      alert("You do not have permission to change bill date.");
      return;
    }
    const dateConfirmations = {};
    let dateOverrideReason = confirmations.date_override_reason || "";
    if (selectedBillDate < today && !confirmations.backdate_confirmed) {
      if (!window.confirm(`You are creating a backdated POS bill for ${selectedBillDate}. Continue?`)) return;
      dateOverrideReason = window.prompt("Reason for backdated bill (optional)", "Backdated POS bill created") || "Backdated POS bill created";
      dateConfirmations.backdate_confirmed = true;
    }
    if (selectedBillDate > today && !confirmations.future_date_confirmed) {
      if (!["Owner", "Admin"].includes(user.role)) {
        alert("Only Owner/Admin can confirm a future bill date.");
        return;
      }
      if (!window.confirm(`You are creating a future-dated POS bill for ${selectedBillDate}. Continue?`)) return;
      dateOverrideReason = window.prompt("Reason for future bill date (optional)", "Future-dated POS bill created") || "Future-dated POS bill created";
      dateConfirmations.future_date_confirmed = true;
    }
    if (customer.mobile && !/^\d{10,15}$/.test(customer.mobile)) {
      alert("Enter a valid customer mobile number.");
      return;
    }
    if (paymentMode === "CREDIT" && !customer.account_id) {
      if (!["Owner", "Admin"].includes(user.role)) {
        alert("Select a saved customer account for credit sale.");
        return;
      }
      if (!window.confirm("No saved customer selected. Assign this credit sale to Walk-in Customer Credit?")) return;
    }
    let zeroRateConfirmed = confirmations.zero_rate_confirmed === true;
    let belowCostConfirmed = confirmations.below_cost_confirmed === true;
    for (const item of cart) {
      const rate = Number(item.selling_rate);
      const defaultRate = Number(item.default_selling_rate ?? item.selling_rate);
      const rateChanged = roundUi(rate) !== roundUi(defaultRate);
      const discountControlledRate = item.lot_discount_type === "SPECIAL_RATE";
      if (!Number.isFinite(rate) || rate < 0) {
        alert(`Enter a valid sale rate for ${item.product_name}.`);
        return;
      }
      if (rateChanged && !discountControlledRate && !canManualRateOverride) {
        alert("You do not have permission to change sale rate.");
        return;
      }
      if (rateChanged && !discountControlledRate && rate === 0 && !zeroRateConfirmed) {
        if (!["Owner", "Admin"].includes(user.role) || !window.confirm(`Sale rate for ${item.product_name} is zero. Continue?`)) return;
        zeroRateConfirmed = true;
      }
      const estimatedCost = Number(costByProduct.get(item.product_id) || 0);
      if (rateChanged && !discountControlledRate && estimatedCost > 0 && rate < estimatedCost && !belowCostConfirmed) {
        if (!["Owner", "Admin"].includes(user.role) || !window.confirm(`This rate is below cost for ${item.product_name}. Continue?`)) return;
        belowCostConfirmed = true;
      }
    }
    if (totals.invoiceDiscount > totals.gross - totals.itemDiscount) {
      alert("Invoice discount cannot exceed the cart subtotal.");
      return;
    }
    if (hasInvalidMixedPayment) {
      alert("Mixed payment amounts cannot be negative.");
      return;
    }

    const payments = paymentMode === "MIXED"
      ? Object.entries(mixedPayments)
        .filter(([, amount]) => Number(amount) > 0)
        .map(([mode, amount]) => ({ mode, amount: Number(amount) }))
      : [{ mode: paymentMode, amount: totals.total }];
    const paidAmount = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
    if (Math.abs(paidAmount - totals.total) > 0.01) {
      alert("Payment amounts must match the tax-inclusive invoice total.");
      return;
    }

    setSaving(true);
    try {
      if (isTauriRuntime()) {
        if (cart.some((item) => !item.inventory_batch_id)) {
          alert("Desktop local-first POS requires a selected stock lot for every item.");
          return;
        }
        const localSale = buildLocalSalePayload({ payments, selectedBillDate, dateOverrideReason });
        const result = await completeLocalPosSale(localSale);
        const invoice = {
          id: localSale.invoice_global_id,
          invoice_no: localSale.offline_invoice_ref,
          offline_invoice_ref: localSale.offline_invoice_ref,
          sale_date: selectedBillDate,
          bill_datetime: billDateTime,
          customer_name: localSale.customer?.name || "Walk-in Customer",
          customer_mobile: localSale.customer?.mobile || "",
          payment_mode: paymentMode,
          amount: localSale.net_total,
          total_amount: localSale.net_total,
          gross_amount: localSale.gross_total,
          item_discount_amount: localSale.item_discount_total,
          invoice_discount_amount: localSale.bill_discount_total,
          taxable_amount: localSale.taxable_amount,
          mandi_tax_rate: localSale.mandi_tax_rate,
          mandi_tax_basis: localSale.mandi_tax_basis,
          tax_amount: localSale.tax_total,
          sync_status: "pending",
          items: localSale.items.map((item) => ({
            product_id: item.product_id,
            product_name: item.product_name,
            unit: item.unit,
            quantity: item.quantity,
            selling_rate: item.rate,
            inventory_batch_id: item.inventory_batch_id,
            lot_name: item.lot_name,
            lot_size: item.lot_size,
            amount: item.amount,
            discount_amount: item.discount,
            net_amount: item.amount,
          })),
          payments: localSale.payments,
        };
        setCart([]);
        setMixedPayments({ CASH: "", UPI: "", CARD: "", BANK_TRANSFER: "" });
        setPaymentMode("CASH");
        setCustomer({ account_id: "", name: "", mobile: "", notes: "", system_account: false });
        setCreditInfo({ due_date: "", remarks: "" });
        setBillDateTime(currentDateTimeLocal());
        await onSaved?.({ localSale: invoice, pendingOperations: result?.pending_operations });
        setLastInvoice(invoice);
        onInvoice(invoice);
        if (typeof syncInBackground === "function") {
          syncInBackground().catch(() => {});
        }
        if (printAfterSave || printSettings.auto_print_after_billing === true) {
          setTimeout(() => window.print(), 250);
        }
        return;
      }
      const response = await axios.post(`${API_URL}/sales`, {
        items: cart.map((item) => ({
          product_id: item.product_id,
          inventory_batch_id: item.inventory_batch_id,
          quantity: Number(item.quantity),
          selling_rate: Number(item.selling_rate),
          discount_amount: Number(item.discount_amount || 0),
          lot_discount_id: item.lot_discount_id || null,
          lot_discount_type: item.lot_discount_type || null,
          lot_discount_value: Number(item.lot_discount_value || 0),
        })),
        customer,
        invoice_discount: Number(totals.invoiceDiscount || 0),
        discount_rule_id: totals.discountRule?.id || null,
        taxable_amount: Number(totals.taxableAmount || 0),
        mandi_tax_rate: Number(totals.mandiTaxRate || 0),
        mandi_tax_basis: totals.mandiTaxBasis,
        tax_total: Number(totals.mandiTaxAmount || 0),
        payments,
        branch_id: user.branch_id,
        created_by: user.id,
        device_id: deviceInfo.device_id,
        bill_date: selectedBillDate,
        bill_datetime: billDateTime,
        credit_due_date: paymentMode === "CREDIT" ? creditInfo.due_date || null : null,
        credit_remarks: paymentMode === "CREDIT" ? creditInfo.remarks || customer.notes || "" : "",
        date_override_reason: dateOverrideReason,
        backdate_confirmed: confirmations.backdate_confirmed || dateConfirmations.backdate_confirmed || false,
        future_date_confirmed: confirmations.future_date_confirmed || dateConfirmations.future_date_confirmed || false,
        below_cost_confirmed: belowCostConfirmed,
        zero_rate_confirmed: zeroRateConfirmed,
      });
      setCart([]);
      setMixedPayments({ CASH: "", UPI: "", CARD: "", BANK_TRANSFER: "" });
      setPaymentMode("CASH");
      setCustomer({ account_id: "", name: "", mobile: "", notes: "", system_account: false });
      setCreditInfo({ due_date: "", remarks: "" });
      setBillDateTime(currentDateTimeLocal());
      await onSaved();
      setLastInvoice(response.data.sale);
      onInvoice(response.data.sale);
      if (printAfterSave || printSettings.auto_print_after_billing === true) {
        setTimeout(() => window.print(), 250);
      }
    } catch (error) {
      const responseData = error.response?.data || {};
      if (error.response?.status === 409) {
        if (responseData.requires_below_cost_confirmation && window.confirm(responseData.message || "This rate is below cost. Continue?")) {
          setSaving(false);
          setTimeout(() => checkout(printAfterSave, { ...confirmations, below_cost_confirmed: true, retry: true }), 0);
          return;
        }
        if (responseData.requires_zero_rate_confirmation && window.confirm(responseData.message || "Zero sale rate requires confirmation. Continue?")) {
          setSaving(false);
          setTimeout(() => checkout(printAfterSave, { ...confirmations, zero_rate_confirmed: true, retry: true }), 0);
          return;
        }
        if (responseData.requires_backdate_confirmation && window.confirm(responseData.message || "Backdated bill requires confirmation. Continue?")) {
          const reason = window.prompt("Reason for backdated bill (optional)", "Backdated POS bill created") || "Backdated POS bill created";
          setSaving(false);
          setTimeout(() => checkout(printAfterSave, { ...confirmations, backdate_confirmed: true, date_override_reason: reason, retry: true }), 0);
          return;
        }
        if (responseData.requires_future_date_confirmation && window.confirm(responseData.message || "Future bill date requires confirmation. Continue?")) {
          const reason = window.prompt("Reason for future bill date (optional)", "Future-dated POS bill created") || "Future-dated POS bill created";
          setSaving(false);
          setTimeout(() => checkout(printAfterSave, { ...confirmations, future_date_confirmed: true, date_override_reason: reason, retry: true }), 0);
          return;
        }
      }
      alert(getErrorMessage(error, "Unable to complete checkout"));
    } finally {
      setSaving(false);
    }
  };

  const handleSearchKeys = (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.min(index + 1, searchResults.length - 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(index - 1, 0));
    }
    if (event.key === "Enter" && searchResults[highlightedIndex]) {
      event.preventDefault();
      const selected = searchResults[highlightedIndex];
      openLotSelector(selected.product);
    }
  };

  const lotSelectorLots = useMemo(() => {
    if (!lotSelectorProduct) return [];
    const query = lotSelectorSearch.trim().toLowerCase();
    const minRate = lotRateMin === "" ? null : Number(lotRateMin);
    const maxRate = lotRateMax === "" ? null : Number(lotRateMax);
    return (lotsByProduct.get(lotSelectorProduct.id) || [])
      .filter((lot) => {
        const status = lotStatus(lot);
        if (status === "Cancelled" || status === "Inactive") return false;
        if (!showSoldOutLots || !canViewSoldOutLots) {
          if (lotBalance(lot) <= 0) return false;
        }
        if (lotFilter === "ACTIVE" && status !== "Active") return false;
        if (lotFilter === "DISCOUNTED" && !getActiveLotDiscount(lot.id)) return false;
        if (lotFilter === "AVAILABLE" && lotBalance(lot) <= 0) return false;
        if (lotSizeFilter && String(lot.lot_size || lot.size_grade || "") !== lotSizeFilter) return false;
        if (lotUnitFilter && String(lot.unit || lotSelectorProduct.unit || "") !== lotUnitFilter) return false;
        const rate = lotSaleRateValue(lot, lotSelectorProduct);
        if (Number.isFinite(minRate) && minRate !== null && rate < minRate) return false;
        if (Number.isFinite(maxRate) && maxRate !== null && rate > maxRate) return false;
        if (!query) return true;
        return [
          lotStableName(lot),
          lot.lot_name,
          lot.batch_no,
          lot.lot_no,
          lotSelectorProduct.product_name,
          lot.lot_size,
          lot.size_grade,
          lot.unit || lotSelectorProduct.unit,
          rate,
          lotBalance(lot),
          status,
          lotDateKey(lot),
          lot.remarks,
        ].some((value) => String(value ?? "").trim().toLowerCase().includes(query));
      })
      .sort((left, right) => {
        const dateCompare = String(lotDateKey(left) || "9999-12-31").localeCompare(String(lotDateKey(right) || "9999-12-31"));
        if (dateCompare !== 0) return dateCompare;
        const lotCompare = lotStableName(left).localeCompare(lotStableName(right), undefined, { numeric: true, sensitivity: "base" });
        if (lotCompare !== 0) return lotCompare;
        return Number(left.id || 0) - Number(right.id || 0);
      });
  }, [canViewSoldOutLots, lotFilter, lotRateMax, lotRateMin, lotSelectorProduct, lotSelectorSearch, lotSizeFilter, lotUnitFilter, lotsByProduct, showSoldOutLots]);

  const lotSelectorSizeOptions = useMemo(() => {
    if (!lotSelectorProduct) return [];
    return [...new Set((lotsByProduct.get(lotSelectorProduct.id) || []).map((lot) => String(lot.lot_size || lot.size_grade || "").trim()).filter(Boolean))].sort();
  }, [lotSelectorProduct, lotsByProduct]);

  const lotSelectorUnitOptions = useMemo(() => {
    if (!lotSelectorProduct) return [];
    return [...new Set((lotsByProduct.get(lotSelectorProduct.id) || []).map((lot) => String(lot.unit || lotSelectorProduct.unit || "").trim()).filter(Boolean))].sort();
  }, [lotSelectorProduct, lotsByProduct]);

  const handleShortcuts = (event) => {
    if (event.key === "F2") {
      event.preventDefault();
      searchRef.current?.focus();
    }
    if (event.key === "F3") {
      event.preventDefault();
      barcodeRef.current?.focus();
    }
    if (event.key === "F4") {
      event.preventDefault();
      checkout(true);
    }
  };

  const printLastInvoice = () => {
    if (!lastInvoice) {
      alert("Save a bill before printing.");
      return;
    }
    onInvoice(lastInvoice);
    setTimeout(() => window.print(), 250);
  };

  return (
    <section className="pos-layout" onKeyDown={handleShortcuts}>
      <div className="mobile-pos-note">
        POS billing is optimized for tablet and desktop. Phone screens remain supported for quick invoice lookup and emergency billing.
      </div>
      <div className="pos-main">
        <section className="content-card pos-search-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Retail Counter</span>
              <h2>POS Billing</h2>
              <p>Search products or scan a barcode to build the invoice.</p>
            </div>
            <span className="shortcut-hint">F2 Search - F3 Barcode - F4 Checkout</span>
          </div>
          <div className="pos-mode-panel">
            <Field label="Quantity Mode">
              <select value={effectiveQuantityMode} onChange={(event) => setQuantityMode(event.target.value)}>
                <option value="MANUAL">Manual</option>
                <option disabled={!posSettings.enable_weighing_scale} value="SCALE">Weighing Scale Mode</option>
              </select>
            </Field>
            <button className="secondary-button" disabled={effectiveQuantityMode !== "SCALE"} onClick={readScaleWeight}>Read Weight</button>
            <span className={effectiveQuantityMode === "SCALE" ? "stock-low" : "stock-ok"}>
              {effectiveQuantityMode === "SCALE" ? (scaleMessage || "Scale mode ready - manual fallback active") : "Manual quantity entry"}
            </span>
          </div>
          <div className="pos-inputs">
            <label className="icon-input">
              <Icon name="search" />
              <input
                placeholder="Search product name"
                ref={searchRef}
                value={search}
                onChange={(event) => { setSearch(event.target.value); setHighlightedIndex(0); }}
                onKeyDown={handleSearchKeys}
              />
            </label>
            <label className="icon-input">
              <Icon name="barcode" />
              <input
                placeholder="Scan barcode"
                ref={barcodeRef}
                value={barcode}
                onChange={(event) => setBarcode(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && scanBarcode()}
              />
            </label>
          </div>
          <div className="product-results">
            {searchResults.map((option, index) => {
              const { product } = option;
              const lots = lotsByProduct.get(product.id) || [];
              const activeLots = lots.filter(isSelectableLot);
              const stock = activeLots.reduce((sum, lot) => sum + lotBalance(lot), 0);
              const rates = activeLots.map((lot) => lotSaleRateValue(lot, product)).filter((rate) => rate > 0);
              const minRate = rates.length ? Math.min(...rates) : Number(product.selling_rate || 0);
              const maxRate = rates.length ? Math.max(...rates) : minRate;
              const discountedCount = activeLots.filter((lot) => getActiveLotDiscount(lot.id)).length;
              const rateLabel = minRate === maxRate
                ? `${currency.format(minRate)}/${product.unit || "Unit"}`
                : `${currency.format(minRate)} - ${currency.format(maxRate)}`;
              return (
                <button
                  className={index === highlightedIndex ? "product-result product-result-active" : "product-result"}
                  key={option.key}
                  onClick={() => openLotSelector(product)}
                  title={`Select lot for ${product.product_name}`}
                >
                  <span className="product-result-main">
                    <strong>{product.product_name}</strong>
                    <span className="product-result-meta">
                      <span>{activeLots.length} available lot{activeLots.length === 1 ? "" : "s"}</span>
                      <span>Stock: {stock.toLocaleString("en-IN", { maximumFractionDigits: 3 })}</span>
                      <span>Unit: {product.unit || "Unit"}</span>
                    </span>
                    <small>Rate: {rateLabel}{discountedCount ? ` - ${discountedCount} discounted lot${discountedCount === 1 ? "" : "s"}` : ""}</small>
                  </span>
                  <em className={stock <= 5 ? "stock-low" : "stock-ok"}>{stock.toLocaleString("en-IN", { maximumFractionDigits: 3 })} in stock</em>
                </button>
              );
            })}
            {searchResults.length === 0 && <div className="cart-empty">No matching products or lots found.</div>}
          </div>
        </section>

        <section className="content-card cart-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Current Invoice</span>
              <h2>Shopping Cart</h2>
            </div>
            <span className="cart-count">{totals.itemCount} items</span>
          </div>
          {cart.length === 0 ? (
            <div className="cart-empty">Search or scan a product to begin billing.</div>
          ) : (
            <div className="table-wrap cart-table">
              <table>
                <thead><tr><th>Product</th><th>Lot/Size</th><th>Rate</th><th>Qty</th>{printSettings.show_item_discount_column_pos !== false && <th>Item Discount</th>}<th>Total</th><th /></tr></thead>
                <tbody>
                  {cart.map((item) => (
                    <tr key={item.line_id}>
                      <td className="primary-cell">
                        {item.product_name}
                        <small className="cell-note">{item.available_qty || stockByProduct.get(item.product_id) || 0} {item.unit} available</small>
                      </td>
                      <td><span className="batch-id">{[item.lot_name, item.lot_size].filter(Boolean).join(" / ") || "Auto FIFO"}</span></td>
                      <td>
                        <input
                          className="table-input"
                          min="0"
                          readOnly={!canManualRateOverride}
                          step="0.01"
                          title={canManualRateOverride ? "Owner/Admin can override POS sale rate" : "You do not have permission to change sale rate"}
                          type="number"
                          value={item.selling_rate}
                          onChange={(event) => updateCartItem(item.line_id, "selling_rate", event.target.value)}
                        />
                      </td>
                      <td><input className="table-input" min="0.001" ref={(node) => { quantityRefs.current[item.line_id] = node; }} step="0.001" type="number" value={item.quantity} onChange={(event) => updateCartItem(item.line_id, "quantity", event.target.value)} onKeyDown={completeQuantityEntry} /></td>
                      {printSettings.show_item_discount_column_pos !== false && <td><input className="table-input" min="0" step="0.01" type="number" value={item.discount_amount} onChange={(event) => updateCartItem(item.line_id, "discount_amount", event.target.value)} /></td>}
                      <td className="primary-cell">{currency.format(item.quantity * item.selling_rate - Number(item.discount_amount || 0))}</td>
                      <td><button aria-label={`Remove ${item.product_name}`} className="remove-button" onClick={() => removeCartItem(item.line_id)}><Icon name="trash" size={16} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <aside className="checkout-card">
        <span className="eyebrow">Checkout</span>
        <h2>Invoice Summary</h2>
        <div className="checkout-section">
          <Field label="Bill Date">
            <input
              disabled={!canPosDateOverride}
              type="datetime-local"
              value={billDateTime}
              onChange={(event) => setBillDateTime(event.target.value)}
            />
          </Field>
          <p className="form-note">{canPosDateOverride ? "Owner/Admin can select a previous or custom bill date." : "Bill date is locked for your role."}</p>
          <Field label="Saved Customer Account">
            <select value={customer.account_id || ""} onChange={(event) => selectCustomer(event.target.value)}>
              <option value="">Walk-in Customer</option>
              {customers.map((item) => <option key={item.id} value={item.id}>{item.customer_name}{item.mobile_number ? ` - ${item.mobile_number}` : ""}</option>)}
            </select>
          </Field>
          <Field label="Customer Name"><input placeholder="Walk-in customer" value={customer.name} onChange={(event) => setCustomer({ ...customer, name: event.target.value })} /></Field>
          <Field label="Mobile Number"><input inputMode="numeric" placeholder="Optional for WhatsApp" value={customer.mobile} onChange={(event) => setCustomer({ ...customer, mobile: event.target.value.replace(/\D/g, "") })} /></Field>
          <Field label="Notes"><textarea placeholder="Optional notes" value={customer.notes} onChange={(event) => setCustomer({ ...customer, notes: event.target.value })} /></Field>
        </div>
        <div className="checkout-section mandi-tax-panel">
          <div className="section-title-row">
            <strong>Mandi Tax</strong>
            <span className={registeredCustomerSelected && mandiTaxConfigured ? "stock-ok" : "origin-rate"}>
              {registeredCustomerSelected ? (mandiTaxConfigured ? "Applied" : mandiTaxDisabled ? "Disabled" : "Configuration Required") : "Not Applicable"}
            </span>
          </div>
          {!registeredCustomerSelected && <p className="form-note">Mandi Tax is not applicable for the official Walk-in Customer by default.</p>}
          {mandiTaxDisabled && <p className="form-note">Mandi Tax is disabled in Settings for registered-customer sales. Enable it only if this business rule applies.</p>}
          {mandiTaxNeedsConfiguration && (
            <div className="warning-action-row">
              <p className="form-note stock-low">Mandi Tax configuration required for registered-customer sales.</p>
              <button className="secondary-button compact-button" type="button" onClick={onConfigureMandiTax}>Configure Mandi Tax</button>
            </div>
          )}
          {registeredCustomerSelected && mandiTaxConfigured && (
            <div className="tax-preview-grid">
              <div className="total-line"><span>Tax Rate</span><strong>{Number(totals.mandiTaxRate || 0)}%</strong></div>
              <TotalLine label="Taxable Amount" value={totals.taxableAmount} />
              <TotalLine label="Mandi Tax Amount" value={totals.mandiTaxAmount} />
              <small className="form-note">Basis: {salesMandiTaxBasisLabel[totals.mandiTaxBasis] || totals.mandiTaxBasis}</small>
            </div>
          )}
        </div>
        <div className="checkout-section">
          <div className="discount-preview">
            <span>Automatic Bill Discount</span>
            <strong>{currency.format(totals.invoiceDiscount)}</strong>
            <small>{totals.discountRule ? totals.discountRule.rule_name : "No active slab matched"}</small>
          </div>
          <Field label="Payment Mode">
            <select value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)}>
              <option value="CASH">Cash</option>
              <option value="UPI">UPI</option>
              <option value="CARD">Card</option>
              <option value="BANK_TRANSFER">Bank</option>
              <option value="CREDIT">Credit</option>
              <option value="MIXED">Mixed Payment</option>
            </select>
          </Field>
          {paymentMode === "CREDIT" && (
            <div className="credit-panel">
              <p className="form-note">Credit sale will reduce inventory now and create customer receivable. Cash Book updates only when payment is received.</p>
              <Field label="Due Date"><input type="date" value={creditInfo.due_date} onChange={(event) => setCreditInfo({ ...creditInfo, due_date: event.target.value })} /></Field>
              <Field label="Credit Remarks"><input value={creditInfo.remarks} onChange={(event) => setCreditInfo({ ...creditInfo, remarks: event.target.value })} placeholder="Optional credit note" /></Field>
            </div>
          )}
          {paymentSettings.enable_upi_qr_on_invoice && paymentSettings.business_upi_id && ["UPI", "MIXED", "BANK_TRANSFER"].includes(paymentMode) && (
            <p className="form-note">UPI QR will be printed for {paymentSettings.business_upi_id} on this invoice.</p>
          )}
          {paymentMode === "MIXED" && (
            <div className="mixed-payment-panel">
              <div className="mixed-grid">
                {mixedPaymentModes.map(([mode, label], index) => (
                  <Field key={mode} label={label}>
                    <input
                      min="0"
                      step="0.01"
                      type="number"
                      value={mixedPayments[mode]}
                      onChange={(event) => setMixedPayments({ ...mixedPayments, [mode]: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          const next = event.currentTarget.closest(".mixed-payment-panel")?.querySelectorAll("input")?.[index + 1];
                          next?.focus();
                        }
                      }}
                    />
                  </Field>
                ))}
              </div>
              <div className="mixed-payment-summary">
                <TotalLine label="Net Payable" value={totals.total} />
                <TotalLine label="Total Allocated" value={mixedAllocated} />
                <TotalLine label="Remaining Amount" value={mixedRemaining} />
                <TotalLine label="Excess Amount" value={mixedExcess} muted={mixedExcess === 0} />
              </div>
              {!isMixedPaymentBalanced && <p className="form-note stock-low">Mixed payment split must exactly match Net Payable.</p>}
            </div>
          )}
        </div>
        <div className="totals">
          <TotalLine label="Gross Total" value={totals.gross} />
          <TotalLine label="Item Discount" value={-totals.itemDiscount} />
          <TotalLine label="Bill Discount" value={-totals.invoiceDiscount} />
          {totals.mandiTaxAmount > 0 && <TotalLine label="Taxable Amount" value={totals.taxableAmount} />}
          {totals.mandiTaxAmount > 0 && <TotalLine label={`Mandi Tax (${totals.mandiTaxRate}%)`} value={totals.mandiTaxAmount} />}
          {totals.mandiTaxAmount === 0 && <TotalLine label="Tax" value={0} muted />}
          <TotalLine label="Net Payable" value={totals.total} total />
          {totals.mandiTaxAmount > 0 && <p className="form-note">Mandi Tax basis: {salesMandiTaxBasisLabel[totals.mandiTaxBasis] || totals.mandiTaxBasis}</p>}
        </div>
        <div className="button-row checkout-actions">
          <button className="primary-button checkout-button" disabled={saving || !isMixedPaymentBalanced || hasInvalidMixedPayment} onClick={() => checkout(false)}>
            <Icon name="receipt" /> {saving ? "Saving..." : "Save Bill"}
          </button>
          <button className="secondary-button" disabled={!lastInvoice || saving} onClick={printLastInvoice}>
            <Icon name="print" /> Print Bill
          </button>
          <button className="primary-button" disabled={saving || !isMixedPaymentBalanced || hasInvalidMixedPayment} onClick={() => checkout(true)}>
            <Icon name="print" /> Save & Print
          </button>
        </div>
      </aside>
      {lotSelectorProduct && (
        <div className="modal-backdrop lot-selector-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && closeLotSelector()}>
          <section className="invoice-modal lot-selector-modal" role="dialog" aria-modal="true" aria-label={`Select lot for ${lotSelectorProduct.product_name}`}>
            <div className="invoice-toolbar lot-selector-toolbar">
              <div>
                <span className="eyebrow">Lot Selection</span>
                <h2>{lotSelectorProduct.product_name}</h2>
                <p>Select the exact lot being sold. Different lots stay as separate cart rows.</p>
              </div>
              <button className="secondary-button" onClick={closeLotSelector}>Close</button>
            </div>
            <div className="lot-selector-controls">
              <label className="icon-input lot-selector-search">
                <Icon name="search" />
                <input
                  autoFocus
                  placeholder="Search lot, size, rate or stock..."
                  value={lotSelectorSearch}
                  onChange={(event) => setLotSelectorSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") closeLotSelector();
                    if (event.key === "Enter" && lotSelectorLots.length > 0 && isSelectableLot(lotSelectorLots[0])) addProduct(lotSelectorProduct, lotSelectorLots[0]);
                  }}
                />
                {lotSelectorSearch && <button aria-label="Clear lot search" className="clear-search-button" type="button" onClick={() => setLotSelectorSearch("")}>×</button>}
              </label>
              <Field label="Filter">
                <select value={lotFilter} onChange={(event) => setLotFilter(event.target.value)}>
                  <option value="AVAILABLE">All Available Lots</option>
                  <option value="ACTIVE">Active Lots</option>
                  <option value="DISCOUNTED">Discounted Lots</option>
                </select>
              </Field>
              <Field label="Size / Grade">
                <select value={lotSizeFilter} onChange={(event) => setLotSizeFilter(event.target.value)}>
                  <option value="">All sizes</option>
                  {lotSelectorSizeOptions.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
              </Field>
              <Field label="Unit">
                <select value={lotUnitFilter} onChange={(event) => setLotUnitFilter(event.target.value)}>
                  <option value="">All units</option>
                  {lotSelectorUnitOptions.map((unit) => <option key={unit} value={unit}>{unit}</option>)}
                </select>
              </Field>
              <Field label="Min Rate"><input min="0" step="0.01" type="number" value={lotRateMin} onChange={(event) => setLotRateMin(event.target.value)} /></Field>
              <Field label="Max Rate"><input min="0" step="0.01" type="number" value={lotRateMax} onChange={(event) => setLotRateMax(event.target.value)} /></Field>
              {canViewSoldOutLots && (
                <label className="toggle-line lot-sold-out-toggle">
                  <input type="checkbox" checked={showSoldOutLots} onChange={(event) => setShowSoldOutLots(event.target.checked)} />
                  Show Sold-Out Lots
                </label>
              )}
            </div>
            <div className="lot-selector-table-wrap">
              <table className="lot-selector-table">
                <thead>
                  <tr>
                    <th>Lot No.</th>
                    <th>Size / Grade</th>
                    <th>Unit</th>
                    <th>Available Stock</th>
                    <th>Rate</th>
                    <th>Discount</th>
                    <th>Date</th>
                    <th>Status</th>
                    <th>Select</th>
                  </tr>
                </thead>
                <tbody>
                  {lotSelectorLots.map((lot) => {
                    const rate = lotSaleRateValue(lot, lotSelectorProduct);
                    const activeDiscount = getActiveLotDiscount(lot.id);
                    const selectable = isSelectableLot(lot);
                    return (
                      <tr key={lot.id} className={selectable ? "lot-selector-row" : "lot-selector-row lot-selector-row-disabled"} onDoubleClick={() => selectable && addProduct(lotSelectorProduct, lot)}>
                        <td>
                          <strong>{getCompactLotName(lot)}</strong>
                          <small>{lotSelectorProduct.product_name}</small>
                        </td>
                        <td>{lot.lot_size || lot.size_grade || "Standard"}</td>
                        <td>{lot.unit || lotSelectorProduct.unit || "Unit"}</td>
                        <td className={lotBalance(lot) <= 5 ? "stock-low" : "stock-ok"}>{lotBalance(lot).toLocaleString("en-IN", { maximumFractionDigits: 3 })}</td>
                        <td>{currency.format(rate)}</td>
                        <td>{activeDiscount ? <span className="status-badge status-active">Discounted</span> : <span className="status-badge">None</span>}</td>
                        <td>{formatDisplayDate(lotDateKey(lot))}</td>
                        <td><span className={`status-badge status-${lotStatus(lot).toLowerCase().replace(/\s+/g, "-")}`}>{lotStatus(lot)}</span></td>
                        <td>
                          <button className="primary-button select-lot-button" disabled={!selectable} onClick={() => addProduct(lotSelectorProduct, lot)}>
                            Select
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {lotSelectorLots.length === 0 && (
                    <tr><td className="empty-cell" colSpan={9}>No matching lots found.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="form-note">Default view shows active lots with available stock. Sold-out lots are reference-only and cannot be billed.</p>
          </section>
        </div>
      )}
    </section>
  );
}

function TotalLine({ label, muted, total, value }) {
  return <div className={`${total ? "total-line total-line-main" : "total-line"} ${muted ? "total-line-muted" : ""}`}><span>{label}</span><strong>{currency.format(value)}</strong></div>;
}

function ThermalTotalLine({ label, total, value }) {
  return <div className={total ? "total-line total-line-main" : "total-line"}><span>{label}</span><strong>{receiptCurrency.format(value)}</strong></div>;
}

function SaleCancelModal({ draft, onClose, onConfirm, onReasonChange }) {
  const sale = draft.sale || {};
  const payments = sale.payments || [];
  const items = sale.items || [];
  return (
    <div className="modal-backdrop">
      <section className="invoice-modal sale-cancel-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">Cancel Bill</span>
            <strong>{sale.invoice_no || `Invoice #${sale.id || sale.sale_id}`}</strong>
          </div>
          <button aria-label="Close cancellation" className="remove-button" disabled={draft.saving} onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="sale-edit-body">
          <section className="purchase-summary">
            <div className="purchase-summary-grid">
              <SummaryMetric label="Customer" value={sale.customer_name || "Walk-in Customer"} />
              <SummaryMetric label="Bill Date" value={formatDisplayDate(sale.sale_date || sale.transaction_date || sale.created_at)} />
              <SummaryMetric label="Status" value={sale.sale_status || "COMPLETED"} />
              <SummaryMetric label="Bill Amount" value={currency.format(Number(sale.total_amount || sale.net_total || 0))} featured />
            </div>
          </section>
          <DataTable headers={["Payment Mode", "Amount"]}>
            {payments.length > 0 ? payments.map((payment, index) => (
              <tr key={`${payment.mode || payment.payment_mode}-${index}`}>
                <td>{payment.mode || payment.payment_mode}</td>
                <td>{currency.format(Number(payment.amount || 0))}</td>
              </tr>
            )) : (
              <tr><td>{sale.payment_mode || "-"}</td><td>{currency.format(Number(sale.total_amount || sale.net_total || 0))}</td></tr>
            )}
          </DataTable>
          <DataTable headers={["Item", "Lot / Size", "Qty", "Rate", "Amount"]}>
            {items.map((item, index) => (
              <tr key={item.id || item.sale_item_id || `${item.product_id}-${index}`}>
                <td className="primary-cell">{item.product_name}</td>
                <td>{[item.lot_name, item.lot_size].filter(Boolean).join(" / ") || "-"}</td>
                <td>{Number(item.quantity || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })} {item.unit || ""}</td>
                <td>{currency.format(Number(item.selling_rate || item.rate || 0))}</td>
                <td>{currency.format(Number(item.net_amount || item.amount || 0))}</td>
              </tr>
            ))}
          </DataTable>
          <Field label="Cancellation Reason">
            <textarea value={draft.reason || ""} onChange={(event) => onReasonChange(event.target.value)} placeholder="Reason is required for audit, ledger reversal and stock restoration." />
          </Field>
          <p className="form-note stock-low">This will mark the invoice as CANCELLED, restore exact lot stock, and reverse cash/bank/customer ledger impact. The invoice will remain visible with a cancelled badge.</p>
          <div className="button-row">
            <button className="remove-button" disabled={draft.saving || !draft.reason?.trim()} onClick={onConfirm}>{draft.saving ? "Cancelling..." : "Confirm Cancel Bill"}</button>
            <button className="secondary-button" disabled={draft.saving} onClick={onClose}>Keep Bill</button>
          </div>
        </div>
      </section>
    </div>
  );
}

function SaleEditModal({ canSaleDateEdit = false, customers = [], deviceInfo, inventory = [], invoice, offlineMode = false, onAddCustomer, onClose, onSaved, paymentSettings = {}, products, user }) {
  const activeCustomers = customers.filter((entry) => entry.active !== false);
  const walkInCustomer = activeCustomers.find((entry) => entry.system_account === true && String(entry.customer_name || "").toLowerCase().includes("walk-in")) || null;
  const customerFromAccount = (account) => account ? ({
    account_id: account.id || "",
    name: account.customer_name || "Walk-in Customer",
    mobile: account.mobile_number || "",
    notes: account.notes || "",
    system_account: account.system_account === true,
  }) : ({
    account_id: "",
    name: "Walk-in Customer",
    mobile: "",
    notes: "",
    system_account: true,
  });
  const initialCustomer = (() => {
    const matched = activeCustomers.find((entry) => String(entry.id) === String(invoice.customer_id || ""));
    if (matched) return customerFromAccount(matched);
    if (!invoice.customer_id) return walkInCustomer ? customerFromAccount(walkInCustomer) : customerFromAccount(null);
    return {
      account_id: invoice.customer_id || "",
      name: invoice.customer_name || "",
      mobile: invoice.customer_mobile || "",
      notes: invoice.customer_notes || "",
      system_account: false,
    };
  })();
  const invoicePayments = invoice.payments || [];
  const initialMixedPayments = (() => {
    const draft = { CASH: "", UPI: "", CARD: "", BANK_TRANSFER: "" };
    for (const payment of invoicePayments) {
      const mode = String(payment.mode || payment.payment_mode || "").toUpperCase();
      if (Object.prototype.hasOwnProperty.call(draft, mode)) draft[mode] = String(Number(payment.amount || 0));
    }
    return draft;
  })();
  const [items, setItems] = useState(() => (invoice.items || []).map((item) => ({
    id: item.id || item.sale_item_id,
    product_id: item.product_id,
    product_name: item.product_name,
    unit: item.unit,
    inventory_batch_id: item.inventory_batch_id || "",
    lot_name: item.lot_name || "",
    lot_size: item.lot_size || "",
    quantity: item.quantity,
    selling_rate: item.selling_rate,
    discount_amount: item.discount_amount || 0,
    lot_discount_id: item.lot_discount_id || null,
    lot_discount_type: item.lot_discount_type || null,
    lot_discount_value: item.lot_discount_value || 0,
  })));
  const [customer, setCustomer] = useState(initialCustomer);
  const [customerSearch, setCustomerSearch] = useState("");
  const [paymentMode, setPaymentMode] = useState(invoice.payment_mode === "MIXED" || invoicePayments.length > 1 ? "MIXED" : invoice.payment_mode || "CASH");
  const [mixedPayments, setMixedPayments] = useState(initialMixedPayments);
  const [billDate, setBillDate] = useState(toDateKey(invoice.sale_date || invoice.transaction_date || new Date()));
  const [invoiceDiscount, setInvoiceDiscount] = useState(invoice.invoice_discount_amount || 0);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const canChangeRate = ["Owner", "Admin"].includes(user.role);
  const mixedPaymentModes = [
    ["CASH", "Cash Amount"],
    ["UPI", "UPI Amount"],
    ["CARD", "Card Amount"],
    ["BANK_TRANSFER", "Bank Transfer Amount"],
  ];
  const activeLotsForProduct = (productId) => inventory.filter((lot) =>
    Number(lot.product_id) === Number(productId) &&
    Number(lot.remaining_qty ?? lot.balance_qty ?? 0) > 0 &&
    !["CANCELLED", "INACTIVE"].includes(String(lot.batch_status || "ACTIVE").toUpperCase())
  );
  const gross = items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.selling_rate || 0), 0);
  const itemDiscount = items.reduce((sum, item) => sum + Number(item.discount_amount || 0), 0);
  const subtotalAfterItemDiscounts = Math.max(gross - itemDiscount, 0);
  const basis = String(paymentSettings.sales_mandi_tax_basis || "NET_AFTER_ALL_DISCOUNTS").toUpperCase();
  const editCustomerScope = String(paymentSettings.sales_mandi_tax_customer_scope || "REGISTERED_CUSTOMERS").toUpperCase();
  const editCustomerTaxEligible = editCustomerScope === "ALL_CUSTOMERS" || (editCustomerScope === "REGISTERED_CUSTOMERS" && Boolean(customer.account_id) && customer.system_account !== true);
  const editTaxEligible = editCustomerScope !== "NONE" && paymentSettings.enable_sales_mandi_tax === true && editCustomerTaxEligible && Number(paymentSettings.sales_mandi_tax_percent || 0) > 0;
  const taxableAmount = editTaxEligible
    ? Math.max(
        basis === "GROSS_BEFORE_DISCOUNTS"
          ? gross
          : basis === "AFTER_ITEM_DISCOUNT"
            ? subtotalAfterItemDiscounts
            : subtotalAfterItemDiscounts - Number(invoiceDiscount || 0),
        0
      )
    : 0;
  const mandiTaxAmount = roundUi(taxableAmount * Number(paymentSettings.sales_mandi_tax_percent || 0) / 100);
  const netPayable = Math.max(gross - itemDiscount - Number(invoiceDiscount || 0) + mandiTaxAmount, 0);
  const mixedAllocated = roundUi(mixedPaymentModes.reduce((sum, [mode]) => sum + Number(mixedPayments[mode] || 0), 0));
  const mixedRemaining = roundUi(Math.max(netPayable - mixedAllocated, 0));
  const mixedExcess = roundUi(Math.max(mixedAllocated - netPayable, 0));
  const hasInvalidMixedPayment = paymentMode === "MIXED" && mixedPaymentModes.some(([mode]) => Number(mixedPayments[mode] || 0) < 0);
  const isMixedPaymentBalanced = paymentMode !== "MIXED" || Math.abs(mixedAllocated - netPayable) <= 0.01;
  const availableProducts = products.filter((product) => product.active !== false);
  const normalizedCustomerSearch = customerSearch.trim().toLowerCase();
  const filteredCustomers = activeCustomers.filter((entry) => {
    if (!normalizedCustomerSearch) return true;
    return [
      entry.customer_name,
      entry.mobile_number,
      entry.gst_number,
      entry.account_code,
      entry.notes,
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedCustomerSearch);
  });
  const selectEditCustomer = (customerId) => {
    if (!customerId || customerId === "__WALK_IN__") {
      setCustomer(walkInCustomer ? customerFromAccount(walkInCustomer) : customerFromAccount(null));
      return;
    }
    const selected = activeCustomers.find((entry) => String(entry.id) === String(customerId));
    if (!selected) return;
    setCustomer(customerFromAccount(selected));
  };

  const updateItem = (index, field, value) => {
    setItems((current) => current.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item));
  };
  const addItem = (productId) => {
    const product = products.find((item) => String(item.id) === String(productId));
    if (!product) return;
    const availableLots = activeLotsForProduct(product.id);
    const selectedLot = availableLots[0] || {};
    const lotSaleRate = Number(selectedLot.temporary_sale_rate || selectedLot.sale_rate || 0);
    setItems((current) => [...current, {
      product_id: product.id,
      product_name: product.product_name,
      unit: product.unit,
      inventory_batch_id: selectedLot.id || "",
      lot_name: selectedLot.lot_name || selectedLot.batch_no || "",
      lot_size: selectedLot.lot_size || "",
      quantity: 1,
      selling_rate: lotSaleRate > 0 ? lotSaleRate : product.selling_rate,
      discount_amount: 0,
    }]);
  };
  const changeItemProduct = (index, productId) => {
    const product = products.find((entry) => String(entry.id) === String(productId));
    if (!product) return;
    const availableLots = activeLotsForProduct(product.id);
    const selectedLot = availableLots[0] || {};
    updateItem(index, "product_id", product.id);
    updateItem(index, "product_name", product.product_name);
    updateItem(index, "unit", product.unit);
    updateItem(index, "inventory_batch_id", selectedLot.id || "");
    updateItem(index, "lot_name", selectedLot.lot_name || selectedLot.batch_no || "");
    updateItem(index, "lot_size", selectedLot.lot_size || "");
    updateItem(index, "selling_rate", Number(selectedLot.temporary_sale_rate || selectedLot.sale_rate || 0) > 0 ? Number(selectedLot.temporary_sale_rate || selectedLot.sale_rate || 0) : product.selling_rate);
  };
  const changeItemLot = (index, lotId) => {
    const lot = inventory.find((entry) => String(entry.id) === String(lotId));
    if (!lot) {
      updateItem(index, "inventory_batch_id", "");
      updateItem(index, "lot_name", "");
      updateItem(index, "lot_size", "");
      return;
    }
    updateItem(index, "inventory_batch_id", lot.id);
    updateItem(index, "lot_name", lot.lot_name || lot.batch_no || "");
    updateItem(index, "lot_size", lot.lot_size || "");
    const lotSaleRate = Number(lot.temporary_sale_rate || lot.sale_rate || 0);
    if (lotSaleRate > 0) updateItem(index, "selling_rate", lotSaleRate);
  };
  const removeItem = (index) => setItems((current) => current.filter((_, itemIndex) => itemIndex !== index));
  const save = async () => {
    if (saving) return;
    if (!reason.trim()) {
      alert("Edit reason is required.");
      return;
    }
    if (items.length === 0) {
      alert("Invoice must contain at least one item.");
      return;
    }
    if (customer.mobile && !/^\d{10,15}$/.test(customer.mobile)) {
      alert("Enter a valid customer mobile number.");
      return;
    }
    if (Number(invoiceDiscount || 0) > subtotalAfterItemDiscounts) {
      alert("Bill discount cannot exceed sale value after item discounts.");
      return;
    }
    if (hasInvalidMixedPayment) {
      alert("Mixed payment amounts cannot be negative.");
      return;
    }
    const payments = paymentMode === "MIXED"
      ? mixedPaymentModes
        .map(([mode]) => ({ mode, amount: roundUi(Number(mixedPayments[mode] || 0)) }))
        .filter((payment) => payment.amount > 0)
      : [{ mode: paymentMode, amount: netPayable }];
    const paidAmount = roundUi(payments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0));
    if (paymentMode === "MIXED" && (!isMixedPaymentBalanced || Math.abs(paidAmount - netPayable) > 0.01)) {
      alert("Mixed payment split must exactly match Net Payable.");
      return;
    }
    setSaving(true);
    try {
      const editItems = items.map((item) => ({
          id: Number(item.id || 0) || undefined,
          item_global_id: String(item.id || `sale-item-${crypto.randomUUID?.() || Date.now()}`),
          product_id: String(item.product_id),
          product_name: item.product_name || products.find((product) => String(product.id) === String(item.product_id))?.product_name || "",
          lot_id: String(item.inventory_batch_id || item.lot_id || ""),
          inventory_batch_id: String(item.inventory_batch_id || item.lot_id || ""),
          lot_name: item.lot_name || "",
          lot_size: item.lot_size || "",
          unit: item.unit || "",
          quantity: Number(item.quantity),
          rate: Number(item.selling_rate),
          selling_rate: Number(item.selling_rate),
          discount: Number(item.discount_amount || 0),
          discount_amount: Number(item.discount_amount || 0),
          amount: Math.max(Number(item.quantity || 0) * Number(item.selling_rate || 0) - Number(item.discount_amount || 0), 0),
          lot_discount_id: item.lot_discount_id || null,
          lot_discount_type: item.lot_discount_type || null,
          lot_discount_value: Number(item.lot_discount_value || 0),
          stock_movement_id: item.stock_movement_id || `stock-edit-${crypto.randomUUID?.() || Date.now()}`,
        }));
      const payload = {
        invoice_global_id: String(invoice.sale_id || invoice.id),
        items: editItems,
        customer,
        invoice_discount: Number(invoiceDiscount || 0),
        bill_discount_total: Number(invoiceDiscount || 0),
        gross_total: gross,
        item_discount_total: itemDiscount,
        taxable_amount: taxableAmount,
        mandi_tax_rate: editTaxEligible ? Number(paymentSettings.sales_mandi_tax_percent || 0) : 0,
        mandi_tax_basis: basis,
        tax_config_snapshot: mandiTaxAmount > 0 ? {
          tax_type: "MANDI_TAX",
          tax_rate: editTaxEligible ? Number(paymentSettings.sales_mandi_tax_percent || 0) : 0,
          taxable_basis: basis,
          taxable_amount: taxableAmount,
          tax_amount: mandiTaxAmount,
          effective_date: paymentSettings.sales_mandi_tax_effective_date || null,
          source: "payment_settings",
        } : null,
        tax_total: mandiTaxAmount,
        net_total: netPayable,
        payments,
        branch_id: invoice.branch_id || user.branch_id,
        user_id: String(user.id || ""),
        edited_by: user.id,
        device_id: deviceInfo?.device_id || "",
        bill_date: billDate,
        bill_datetime: `${billDate}T00:00`,
        payment_mode: paymentMode,
        reason,
      };
      const localEligible = isTauriRuntime() && (
        offlineMode ||
        invoice.sync_status ||
        String(invoice.id || invoice.sale_id || "").startsWith("invoice-") ||
        String(invoice.id || invoice.sale_id || "").startsWith("pos-invoice-")
      );
      if (localEligible) {
        const result = await editLocalPosSale(payload);
        await onSaved({ localSale: localSnapshotToInvoice(result.invoice), pendingOperations: result.pending_operations });
        alert("Invoice updated locally. Pending sync.");
      } else {
        await axios.put(`${API_URL}/sales/${invoice.id}`, {
          ...payload,
          items: editItems.map((item) => ({
            id: Number(item.id || 0) || undefined,
            product_id: Number(item.product_id),
            inventory_batch_id: Number(item.inventory_batch_id || 0) || null,
            quantity: Number(item.quantity),
            selling_rate: Number(item.selling_rate),
            discount_amount: Number(item.discount_amount || 0),
            lot_discount_id: item.lot_discount_id || null,
            lot_discount_type: item.lot_discount_type || null,
            lot_discount_value: Number(item.lot_discount_value || 0),
          })),
        });
        await onSaved();
        alert("Invoice updated");
      }
    } catch (error) {
      alert(getErrorMessage(error, "Unable to update invoice"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <section className="invoice-modal sale-edit-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">Edit Completed Sale</span>
            <strong>{invoice.invoice_no}</strong>
          </div>
          <div className="invoice-actions">
            <button className="primary-button" disabled={saving || hasInvalidMixedPayment || !isMixedPaymentBalanced} onClick={save}>{saving ? "Saving..." : "Save Edit"}</button>
            <button aria-label="Close editor" className="remove-button" onClick={onClose}><Icon name="close" /></button>
          </div>
        </div>
        <div className="sale-edit-body">
          <div className="form-grid supplier-form-grid">
            <Field label="Bill Date"><input disabled={!canSaleDateEdit} type="date" value={billDate} onChange={(event) => setBillDate(event.target.value)} /></Field>
            <Field label="Customer Account">
              <input
                placeholder="Search customer name, mobile or GST..."
                value={customerSearch}
                onChange={(event) => setCustomerSearch(event.target.value)}
              />
              <select value={customer.account_id || "__WALK_IN__"} onChange={(event) => selectEditCustomer(event.target.value)}>
                <option value="__WALK_IN__">Walk-in Customer</option>
                {customer.account_id && !activeCustomers.some((entry) => String(entry.id) === String(customer.account_id)) && (
                  <option value={customer.account_id}>{customer.name || `Customer #${customer.account_id}`} - current bill customer</option>
                )}
                {filteredCustomers.map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.customer_name}{entry.mobile_number ? ` - ${entry.mobile_number}` : ""}{entry.system_account ? " (System)" : ""}</option>
                ))}
                {filteredCustomers.length === 0 && (
                  <option disabled value="__NO_CUSTOMERS__">No matching saved customers</option>
                )}
              </select>
              <small className="field-hint">Only saved customers or the official Walk-in Customer can be selected.</small>
            </Field>
            <Field label="Selected Customer"><input readOnly value={customer.name || "Walk-in Customer"} /></Field>
            <Field label="Mobile Number"><input readOnly value={customer.mobile || ""} /></Field>
            <Field label="Payment Mode">
              <select value={paymentMode} onChange={(event) => setPaymentMode(event.target.value)}>
                <option value="CASH">Cash</option>
                <option value="UPI">UPI</option>
                <option value="CARD">Card</option>
                <option value="BANK_TRANSFER">Bank Transfer</option>
                <option value="CREDIT">Credit</option>
                <option value="MIXED">Mixed Payment</option>
              </select>
            </Field>
            <Field label="Bill Discount"><input min="0" step="0.01" type="number" value={invoiceDiscount} onChange={(event) => setInvoiceDiscount(event.target.value)} /></Field>
            <Field label="Customer Notes"><textarea readOnly value={customer.notes || ""} /></Field>
            <Field label="Edit Reason"><textarea value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
          </div>
          <div className="sale-edit-add-row">
            <button className="secondary-button" type="button" onClick={onAddCustomer}>Add New Customer</button>
          </div>
          {paymentMode === "MIXED" && (
            <div className="mixed-payment-panel sale-edit-mixed-panel">
              <div className="mixed-grid">
                {mixedPaymentModes.map(([mode, label], index) => (
                  <Field key={mode} label={label}>
                    <input
                      min="0"
                      step="0.01"
                      type="number"
                      value={mixedPayments[mode]}
                      onChange={(event) => setMixedPayments({ ...mixedPayments, [mode]: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          const next = event.currentTarget.closest(".mixed-payment-panel")?.querySelectorAll("input")?.[index + 1];
                          next?.focus();
                        }
                      }}
                    />
                  </Field>
                ))}
              </div>
              <div className="mixed-payment-summary">
                <TotalLine label="Net Payable" value={netPayable} />
                <TotalLine label="Total Allocated" value={mixedAllocated} />
                <TotalLine label="Remaining Amount" value={mixedRemaining} />
                <TotalLine label="Excess Amount" value={mixedExcess} muted={mixedExcess === 0} />
              </div>
              {!isMixedPaymentBalanced && <p className="form-note stock-low">Mixed payment split must exactly match Net Payable.</p>}
            </div>
          )}
          <div className="sale-edit-add-row">
            <select defaultValue="" onChange={(event) => { addItem(event.target.value); event.target.value = ""; }}>
              <option value="">Add item</option>
              {availableProducts.map((product) => <option key={product.id} value={product.id}>{product.product_name}</option>)}
            </select>
          </div>
          <DataTable headers={["Product", "Lot / Size", "Qty", "Rate", "Discount", "Net", ""]}>
            {items.map((item, index) => (
              <tr key={`${item.product_id}-${item.inventory_batch_id || "fifo"}-${index}`}>
                <td className="primary-cell">
                  <select className="settings-table-input" value={item.product_id} onChange={(event) => changeItemProduct(index, event.target.value)}>
                    {products.map((product) => <option key={product.id} value={product.id}>{product.product_name}</option>)}
                  </select>
                  <small className="cell-note">{item.unit}</small>
                </td>
                <td>
                  <select className="settings-table-input" value={item.inventory_batch_id || ""} onChange={(event) => changeItemLot(index, event.target.value)}>
                    <option value="">FIFO / Auto</option>
                    {activeLotsForProduct(item.product_id).map((lot) => (
                      <option key={lot.id} value={lot.id}>
                        {(lot.lot_name || lot.batch_no || `Lot #${lot.id}`)}{lot.lot_size ? ` / ${lot.lot_size}` : ""} - Avl {Number(lot.remaining_qty ?? lot.balance_qty ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 3 })}
                      </option>
                    ))}
                    {item.inventory_batch_id && !activeLotsForProduct(item.product_id).some((lot) => String(lot.id) === String(item.inventory_batch_id)) && (
                      <option value={item.inventory_batch_id}>{[item.lot_name, item.lot_size].filter(Boolean).join(" / ") || `Lot #${item.inventory_batch_id}`} - original lot</option>
                    )}
                  </select>
                </td>
                <td><input className="table-input" min="0.001" step="0.001" type="number" value={item.quantity} onChange={(event) => updateItem(index, "quantity", event.target.value)} /></td>
                <td><input className="settings-table-input" disabled={!canChangeRate} min="0.01" step="0.01" type="number" value={item.selling_rate} onChange={(event) => updateItem(index, "selling_rate", event.target.value)} /></td>
                <td><input className="table-input" min="0" step="0.01" type="number" value={item.discount_amount} onChange={(event) => updateItem(index, "discount_amount", event.target.value)} /></td>
                <td>{currency.format(Number(item.quantity || 0) * Number(item.selling_rate || 0) - Number(item.discount_amount || 0))}</td>
                <td><button className="remove-button" onClick={() => removeItem(index)}><Icon name="trash" size={15} /></button></td>
              </tr>
            ))}
          </DataTable>
          <section className="purchase-summary sale-edit-summary">
            <div className="purchase-summary-grid">
              <SummaryMetric label="Gross Total" value={currency.format(gross)} />
              <SummaryMetric label="Item Discount" value={currency.format(itemDiscount)} />
              <SummaryMetric label="Bill Discount" value={currency.format(Number(invoiceDiscount || 0))} />
              <SummaryMetric label="Taxable Amount" value={currency.format(taxableAmount)} />
              <SummaryMetric label={`Mandi Tax (${editTaxEligible ? Number(paymentSettings.sales_mandi_tax_percent || 0) : 0}%)`} value={currency.format(mandiTaxAmount)} />
              <SummaryMetric label="Net Payable" value={currency.format(netPayable)} featured />
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

const formatSaleAuditLines = (row) => {
  if (row.action === "CANCEL") {
    return [
      "Invoice Cancelled",
      `Reason: ${row.reason || "-"}`,
      `Cancelled By: ${row.edited_by_name || "-"}`,
      `Cancelled At: ${row.edited_at ? new Date(row.edited_at).toLocaleString("en-IN") : "-"}`,
    ];
  }
  const oldValue = row.old_value || {};
  const newValue = row.new_value || {};
  const oldSale = oldValue.sale || {};
  const newSale = newValue.sale || {};
  const lines = [];
  const addMoneyChange = (label, key) => {
    if (Number(oldSale[key] || 0) !== Number(newSale[key] || 0)) {
      lines.push(`${label}: ${currency.format(Number(oldSale[key] || 0))} -> ${currency.format(Number(newSale[key] || 0))}`);
    }
  };
  if ((oldSale.customer_name || "") !== (newSale.customer_name || "")) lines.push(`Customer: ${oldSale.customer_name || "Walk-in"} -> ${newSale.customer_name || "Walk-in"}`);
  if (toDateKey(oldSale.sale_date || "") !== toDateKey(newSale.sale_date || "")) lines.push(`Bill Date: ${formatDisplayDate(oldSale.sale_date)} -> ${formatDisplayDate(newSale.sale_date)}`);
  if ((oldSale.payment_mode || "") !== (newSale.payment_mode || "")) lines.push(`Payment Mode: ${oldSale.payment_mode || "-"} -> ${newSale.payment_mode || "-"}`);
  addMoneyChange("Gross Total", "gross_amount");
  addMoneyChange("Discount", "invoice_discount_amount");
  addMoneyChange("Net Amount", "total_amount");
  const oldItems = new Map((oldValue.items || []).map((item) => [String(item.product_id), item]));
  const newItems = new Map((newValue.items || []).map((item) => [String(item.product_id), item]));
  for (const [productId, oldItem] of oldItems) {
    const newItem = newItems.get(productId);
    if (!newItem) {
      lines.push(`Removed: Product #${productId}, ${Number(oldItem.quantity || 0)} units, ${currency.format(Number(oldItem.amount || 0))}`);
      continue;
    }
    if (Number(oldItem.quantity || 0) !== Number(newItem.quantity || 0)) {
      lines.push(`Item Product #${productId} Quantity: ${Number(oldItem.quantity || 0)} -> ${Number(newItem.quantity || 0)}`);
    }
    if (Number(oldItem.selling_rate || 0) !== Number(newItem.selling_rate || 0)) {
      lines.push(`Item Product #${productId} Rate: ${currency.format(Number(oldItem.selling_rate || 0))} -> ${currency.format(Number(newItem.selling_rate || 0))}`);
    }
    if (Number(oldItem.net_amount || oldItem.amount || 0) !== Number(newItem.net_amount || newItem.amount || 0)) {
      lines.push(`Item Product #${productId} Amount: ${currency.format(Number(oldItem.net_amount || oldItem.amount || 0))} -> ${currency.format(Number(newItem.net_amount || newItem.amount || 0))}`);
    }
  }
  for (const [productId, newItem] of newItems) {
    if (!oldItems.has(productId)) {
      lines.push(`Added: Product #${productId}, ${Number(newItem.quantity || 0)} units, ${currency.format(Number(newItem.net_amount || newItem.amount || 0))}`);
    }
  }
  return lines.length ? lines : ["No business fields changed."];
};

function ChangeHistoryModal({ history, onClose }) {
  return (
    <div className="modal-backdrop">
      <section className="invoice-modal change-history-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">Sale Audit Trail</span>
            <strong>Invoice #{history.saleId}</strong>
          </div>
          <button aria-label="Close history" className="remove-button" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="sale-edit-body">
          <DataTable headers={["Action", "Edited At", "Edited By", "Reason", "Readable Changes"]}>
            {history.rows.map((row) => (
              <tr key={row.id}>
                <td><span className="tag">{row.action}</span></td>
                <td>{new Date(row.edited_at).toLocaleString("en-IN")}</td>
                <td>{row.edited_by_name || "-"}</td>
                <td>{row.reason}</td>
                <td><div className="audit-readable">{formatSaleAuditLines(row).map((line) => <span key={line}>{line}</span>)}</div></td>
              </tr>
            ))}
          </DataTable>
          {history.rows.length === 0 && <div className="cart-empty">No changes recorded for this invoice.</div>}
        </div>
      </section>
    </div>
  );
}

const formatPaymentAuditLines = (row) => {
  const oldValue = row.old_value || {};
  const newValue = row.new_value || {};
  if (row.action === "CANCEL") {
    return [
      "Payment Cancelled",
      `Reason: ${row.reason || "-"}`,
      `Cancelled By: ${row.edited_by_name || "-"}`,
      `Cancelled At: ${row.edited_at ? new Date(row.edited_at).toLocaleString("en-IN") : "-"}`,
    ];
  }
  const fields = [
    ["payment_date", "Date", (value) => toDateKey(value || "")],
    ["payment_amount", "Payment Amount", (value) => currency.format(Number(value || 0))],
    ["rebate_amount", "Rebate Amount", (value) => currency.format(Number(value || 0))],
    ["payment_mode", "Payment Mode", (value) => value || "-"],
    ["reference_number", "Reference", (value) => value || "-"],
    ["remarks", "Remarks", (value) => value || "-"],
  ];
  const lines = fields
    .filter(([key]) => String(oldValue[key] ?? "") !== String(newValue[key] ?? ""))
    .map(([key, label, formatter]) => `${label}: ${formatter(oldValue[key])} -> ${formatter(newValue[key])}`);
  return lines.length ? lines : ["No payment fields changed."];
};

function PaymentAuditModal({ audit, onClose }) {
  return (
    <div className="modal-backdrop">
      <section className="invoice-modal change-history-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">Payment Audit Trail</span>
            <strong>{audit.payment.account_name}</strong>
          </div>
          <button aria-label="Close payment history" className="remove-button" onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="sale-edit-body">
          <DataTable headers={["Action", "Edited At", "Edited By", "Reason", "Readable Changes"]}>
            {audit.rows.map((row) => (
              <tr key={row.id}>
                <td><span className="tag">{row.action}</span></td>
                <td>{new Date(row.edited_at).toLocaleString("en-IN")}</td>
                <td>{row.edited_by_name || "-"}</td>
                <td>{row.reason}</td>
                <td><div className="audit-readable">{formatPaymentAuditLines(row).map((line) => <span key={line}>{line}</span>)}</div></td>
              </tr>
            ))}
          </DataTable>
          {audit.rows.length === 0 && <div className="cart-empty">No edits or cancellations recorded for this payment.</div>}
        </div>
      </section>
    </div>
  );
}

function PaymentReceiptModal({ payment, onClose, user }) {
  const paymentAmount = Number(payment.payment_amount || 0);
  const rebateAmount = Number(payment.rebate_amount || 0);
  const totalImpact = paymentAmount + rebateAmount;
  const receiptRef = useRef(null);
  const [exporting, setExporting] = useState(false);
  const [whatsappOpen, setWhatsappOpen] = useState(false);
  const receiptFileName = `FroozERP_Payment_Receipt_${payment.payment_key || payment.id || toDateKey(new Date())}.pdf`;
  const receiptRecipients = useMemo(() => buildWhatsappRecipients({
    accounts: [{
      id: payment.id,
      source_id: payment.id,
      account_name: payment.account_name,
      account_type: payment.payment_source || payment.account_type || "account",
      mobile_number: payment.mobile_number,
      whatsapp_number: payment.whatsapp_number,
      whatsapp_opt_in: payment.whatsapp_opt_in,
    }],
  }), [payment]);
  const exportReceiptPdf = async () => {
    if (!receiptRef.current) return;
    setExporting(true);
    try {
      await exportElementToPdf({
        element: receiptRef.current,
        fileName: receiptFileName,
        mode: "A4",
      });
    } catch (error) {
      alert(`Unable to export receipt PDF: ${error.message}`);
    } finally {
      setExporting(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <section className="invoice-modal">
        <div className="invoice-toolbar no-print">
          <div>
            <span className="eyebrow">Payment Receipt</span>
            <strong>{payment.account_name || "Account Payment"}</strong>
          </div>
          <div className="invoice-actions">
            <button className="secondary-button" onClick={() => window.print()}><Icon name="print" /> Print Receipt</button>
            <button className="secondary-button" disabled={exporting} onClick={exportReceiptPdf}>{exporting ? "Exporting..." : "Save PDF"}</button>
            <button className="whatsapp-button" disabled={exporting} onClick={() => setWhatsappOpen(true)}><Icon name="message" /> WhatsApp</button>
            <button aria-label="Close receipt" className="remove-button" onClick={onClose}><Icon name="close" /></button>
          </div>
        </div>
        <article ref={receiptRef} className="invoice-paper print-area">
          <header className="invoice-header">
            <BrandLogo invoice />
            <div className="invoice-meta">
              <strong>Payment Receipt</strong>
              <span>Receipt #{payment.payment_key || payment.id}</span>
              <span>{payment.payment_date ? new Date(payment.payment_date).toLocaleDateString("en-IN") : toDateKey(new Date())}</span>
            </div>
          </header>
          <section className="invoice-customer">
            <div><small>Party Name</small><strong>{payment.account_name || "-"}</strong><span>{payment.account_type || payment.payment_source || "-"}</span></div>
            <div><small>Payment Mode</small><strong>{payment.payment_mode || "-"}</strong><span>{payment.reference_number || "No reference"}</span></div>
          </section>
          <section className="receipt-summary">
            <TotalLine label="Outstanding Before" value={Number(payment.outstanding_before || 0)} />
            <TotalLine label="Payment Amount" value={paymentAmount} />
            {rebateAmount > 0 && <TotalLine label="Rebate Received" value={rebateAmount} />}
            <TotalLine label="Total Balance Reduction" value={totalImpact} />
            <TotalLine label="Outstanding After" value={Number(payment.outstanding_after || 0)} total />
          </section>
          <p className="invoice-footer">{payment.remarks || "Thank you. This receipt is generated from FroozERP Accounts."}</p>
        </article>
        {whatsappOpen && (
          <WhatsAppSendModal
            caption={`FroozERP payment receipt for ${payment.account_name || "account"} - ${receiptCurrency.format(paymentAmount)}.`}
            documentName={receiptFileName}
            generatePdf={() => exportElementToPdf({ element: receiptRef.current, fileName: receiptFileName, mode: "A4", save: false })}
            onClose={() => setWhatsappOpen(false)}
            recipients={receiptRecipients}
            sourceId={payment.payment_key || payment.id}
            sourceType="receipt"
            title="Send Payment Receipt via WhatsApp"
            user={user}
          />
        )}
      </section>
    </div>
  );
}

function InvoiceModal({ autoPrintMode = null, canCancel = false, canEdit = false, invoice, onCancel, onClose, onEdit, paymentSettings = {}, printSettings = {}, user }) {
  const storedInvoiceProfile = readStoredPrintProfile("invoice");
  const [printMode, setPrintMode] = useState(storedInvoiceProfile === "A4_INVOICE" ? "A4" : storedInvoiceProfile === "THERMAL_RECEIPT" ? "THERMAL" : printSettings.default_invoice_print === "A4_INVOICE" || printSettings.default_printer_type === "A4" ? "A4" : "THERMAL");
  const [upiQrDataUrl, setUpiQrDataUrl] = useState("");
  const [exporting, setExporting] = useState(false);
  const [whatsappOpen, setWhatsappOpen] = useState(false);
  const [pdfPreview, setPdfPreview] = useState(null);
  const invoiceRef = useRef(null);
  const autoPrintedRef = useRef(false);
  const activePrintMode = printMode === "A4" ? "A4" : "THERMAL";
  const invoicePayments = invoice.payments || [];
  const showItemDiscountOnReceipt = printSettings.show_item_discount_column_receipt !== false;
  const showBillDiscountRow = printSettings.show_bill_discount_row_receipt !== false;
  const hideZeroDiscountRows = printSettings.hide_zero_discount_rows !== false;
  const billDiscountAmount = Number(invoice.invoice_discount_amount || 0);
  const shouldRenderBillDiscountRow = showBillDiscountRow && (billDiscountAmount > 0 || !hideZeroDiscountRows);
  const hasUpiPayment = invoice.payment_mode === "UPI" || invoice.payment_mode === "MIXED" || invoicePayments.some((payment) => (payment.mode || payment.payment_mode) === "UPI");
  const qrSizeMap = { SMALL: 110, MEDIUM: 145, LARGE: 180 };
  const qrDisplaySize = String(paymentSettings.qr_display_size || "MEDIUM").toUpperCase();
  const qrCodeWidth = activePrintMode === "THERMAL"
    ? Math.min(qrSizeMap[qrDisplaySize] || 145, printSettings.receipt_width === "58MM" ? 118 : 145)
    : (qrSizeMap[qrDisplaySize] || 145);
  const isUpiQrEnabled = paymentSettings.enable_upi_qr_on_invoice === true;
  const shouldShowUpiQr = isUpiQrEnabled && Boolean(paymentSettings.business_upi_id) && (hasUpiPayment || paymentSettings.show_upi_qr_on_all_bills === true || isUpiQrEnabled);
  const shouldShowUpiWarning = isUpiQrEnabled && !paymentSettings.business_upi_id;
  const upiPayload = shouldShowUpiQr ? [
    "upi://pay?",
    `pa=${encodeURIComponent(paymentSettings.business_upi_id)}`,
    `&pn=${encodeURIComponent(paymentSettings.upi_payee_name || "FEEL THE FREAKIN' FROOZ")}`,
    `&am=${encodeURIComponent(Number(invoice.total_amount || 0).toFixed(2))}`,
    "&cu=INR",
    `&tn=${encodeURIComponent(`FroozERP-Invoice-${invoice.invoice_no || invoice.id}`)}`,
  ].join("") : "";
  useEffect(() => {
    let active = true;
    if (!upiPayload) {
      setUpiQrDataUrl("");
      return undefined;
    }
    QRCode.toDataURL(upiPayload, { errorCorrectionLevel: "M", margin: 1, width: qrCodeWidth })
      .then((url) => active && setUpiQrDataUrl(url))
      .catch(() => active && setUpiQrDataUrl(""));
    return () => {
      active = false;
    };
  }, [qrCodeWidth, upiPayload]);
  const invoiceDateKey = toDateKey(invoice.sale_date || invoice.transaction_date || invoice.created_at);
  const invoiceFileName = () => `FroozERP-Invoice-${safeFileName(invoice.invoice_no || `SALE-${invoice.id}`)}.pdf`;
  const invoiceEntryTime = formatEntryTime(invoice);
  const printWithMode = (mode) => {
    setPrintMode(mode);
    const nextProfile = mode === "A4" ? "A4_PORTRAIT" : printSettings.receipt_width === "58MM" ? "THERMAL_58" : "THERMAL_80";
    rememberPrintProfile("invoice", mode === "A4" ? "A4_INVOICE" : "THERMAL_RECEIPT");
    applyPrintPageProfile(nextProfile);
    withDocumentTitle(invoiceFileName(), () => setTimeout(() => window.print(), 100));
    schedulePrintPageProfileCleanup();
  };
  useEffect(() => {
    if (!autoPrintMode || autoPrintedRef.current) return;
    autoPrintedRef.current = true;
    printWithMode(autoPrintMode === "A4" ? "A4" : "THERMAL");
  }, [autoPrintMode]);
  const exportInvoicePdf = async (mode = activePrintMode, save = true) => {
    setPrintMode(mode);
    setExporting(true);
    try {
      await new Promise((resolve) => setTimeout(resolve, upiPayload && !upiQrDataUrl ? 250 : 80));
      rememberPrintProfile("invoice", mode === "A4" ? "A4_INVOICE" : "THERMAL_RECEIPT");
      return await exportElementToPdf({
        element: invoiceRef.current,
        fileName: invoiceFileName(),
        mode,
        receiptWidth: printSettings.receipt_width || "80MM",
        printProfile: mode === "A4" ? "A4_PORTRAIT" : "",
        save,
      });
    } finally {
      setExporting(false);
    }
  };
  const viewInvoicePdf = async (mode = activePrintMode) => {
    setExporting(true);
    try {
      const result = await exportInvoicePdf(mode, false);
      setPdfPreview({ ...result });
    } catch (error) {
      alert(`Unable to view invoice PDF: ${error.message}`);
    } finally {
      setExporting(false);
    }
  };
  const invoiceWhatsappMessage = () => [
      "Thank you for shopping with FEEL THE FREAKIN' FROOZ. Your invoice is ready.",
      `Invoice: ${invoice.invoice_no}`,
      `Bill Date: ${formatDisplayDate(invoiceDateKey)}`,
      `Amount: ${currency.format(Number(invoice.total_amount))}`,
      "We appreciate your business.",
    ].join("\n");
  const invoiceWhatsappRecipients = useMemo(() => buildWhatsappRecipients({
    customers: invoice.customer_name || invoice.customer_mobile || invoice.whatsapp_number ? [{
      id: invoice.customer_id,
      customer_name: invoice.customer_name || "Customer",
      mobile_number: invoice.customer_mobile,
      whatsapp_number: invoice.customer_whatsapp_number || invoice.whatsapp_number,
      whatsapp_opt_in: invoice.whatsapp_opt_in,
    }] : [],
  }), [invoice]);

  return (
    <div className="modal-backdrop">
      <section className="invoice-modal">
        <div className="invoice-toolbar">
          <div>
            <span className="eyebrow">Invoice Saved</span>
            <strong>{invoice.invoice_no}</strong>
          </div>
          <div className="invoice-actions">
            {canEdit && <button className="primary-button" onClick={onEdit}>Edit Bill</button>}
            <button className="secondary-button" onClick={() => printWithMode("THERMAL")}><Icon name="print" /> POS Thermal Print</button>
            <button className="secondary-button" onClick={() => printWithMode("A4")}><Icon name="print" /> A4 Invoice Print</button>
            <button className="secondary-button" disabled={exporting} onClick={() => viewInvoicePdf(activePrintMode)}>{exporting ? "Preparing..." : "View PDF"}</button>
            <button className="secondary-button" disabled={exporting} onClick={() => exportInvoicePdf(activePrintMode, true)}>{exporting ? "Exporting..." : "Save PDF"}</button>
            <button className="whatsapp-button" disabled={exporting} onClick={() => setWhatsappOpen(true)}><Icon name="message" /> Send on WhatsApp</button>
            {canCancel && <button className="remove-button" onClick={onCancel}>Cancel Bill</button>}
            <button aria-label="Close invoice" className="remove-button" onClick={onClose}><Icon name="close" /></button>
          </div>
        </div>
        <article ref={invoiceRef} className={`invoice-paper ${activePrintMode === "A4" ? "invoice-a4 print-profile-a4-portrait" : "invoice-thermal"} ${printSettings.receipt_width === "58MM" ? "invoice-58mm print-profile-thermal-58" : "invoice-80mm print-profile-thermal-80"}`}>
          <header className="invoice-header">
            <BrandLogo invoice />
            <div className="invoice-meta">
              <strong>Tax Invoice</strong>
              <span>{printSettings.business_name || "FroozERP Retail"}</span>
              <span>{invoice.invoice_no}</span>
              <span>Bill Date: {formatDisplayDate(invoiceDateKey)}</span>
              <span>Entry Time: {invoiceEntryTime}</span>
            </div>
          </header>
          <section className="invoice-customer">
            <div><small>Billed To</small><strong>{invoice.customer_name || "Walk-in Customer"}</strong><span>{invoice.customer_mobile || "No mobile number"}</span></div>
            <div><small>Payment</small><strong>{invoice.payment_mode}</strong><span>{invoice.branch_name || "SRT Retail Store"}</span></div>
            <div><small>Status</small><strong>{invoice.sale_status || "COMPLETED"}</strong><span>{invoice.cancellation_reason || invoice.edit_reason || "No changes recorded"}</span></div>
          </section>
          {activePrintMode === "THERMAL" ? (
            <section className="thermal-items-list">
              {(invoice.items || []).map((item) => {
                const lotText = [item.lot_name, item.lot_size].filter(Boolean).join(" / ") || "-";
                const discountAmount = Number(item.discount_amount || 0);
                return (
                  <article className="thermal-item-block" key={item.id || `${item.product_id}-${item.inventory_batch_id || "FIFO"}`}>
                    <div className="thermal-item-name">{item.product_name}</div>
                    <div className="thermal-item-detail">
                      <span>Lot: {lotText}</span>
                      <span>Qty: {item.quantity} {item.unit}</span>
                      <span>Rate: {receiptCurrency.format(Number(item.selling_rate))}</span>
                    </div>
                    {showItemDiscountOnReceipt && (discountAmount > 0 || !hideZeroDiscountRows) && (
                      <div className="thermal-item-discount">
                        <span>Discount</span>
                        <strong>{receiptCurrency.format(discountAmount)}</strong>
                      </div>
                    )}
                    <div className="thermal-item-amount">
                      <span>Amount</span>
                      <strong>{receiptCurrency.format(Number(item.net_amount))}</strong>
                    </div>
                  </article>
                );
              })}
            </section>
          ) : (
            <table className="invoice-table">
              <thead><tr><th>Item</th><th>Lot/Size</th><th>Qty</th><th>Rate</th>{showItemDiscountOnReceipt && <th>Item Discount</th>}<th>Amount</th></tr></thead>
              <tbody>
                {invoice.items?.map((item) => (
                  <tr key={item.id || `${item.product_id}-${item.inventory_batch_id || "FIFO"}`}>
                    <td>{item.product_name}</td>
                    <td>{[item.lot_name, item.lot_size].filter(Boolean).join(" / ") || "-"}</td>
                    <td>{item.quantity} {item.unit}</td>
                    <td>{receiptCurrency.format(Number(item.selling_rate))}</td>
                    {showItemDiscountOnReceipt && <td>{receiptCurrency.format(Number(item.discount_amount || 0))}</td>}
                    <td>{receiptCurrency.format(Number(item.net_amount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <section className="invoice-total-box">
            <ThermalTotalLine label="Gross Total" value={Number(invoice.gross_amount)} />
            {shouldRenderBillDiscountRow && <ThermalTotalLine label="Bill Discount" value={-billDiscountAmount} />}
            {Number(invoice.taxable_amount || 0) > 0 && <ThermalTotalLine label="Taxable Amount" value={Number(invoice.taxable_amount || 0)} />}
            <ThermalTotalLine label={Number(invoice.mandi_tax_rate || 0) > 0 ? `Mandi Tax (${Number(invoice.mandi_tax_rate || 0)}%)` : "Tax"} value={Number(invoice.tax_amount || 0)} />
            <ThermalTotalLine label="Net Payable" total value={Number(invoice.total_amount)} />
          </section>
          {shouldShowUpiWarning && <p className="form-note stock-low">Please add UPI ID in Settings to show QR code.</p>}
          {shouldShowUpiQr && upiQrDataUrl && (
            <section className="upi-qr-box">
              <img alt="UPI payment QR" src={upiQrDataUrl} style={{ width: `${qrCodeWidth}px`, height: `${qrCodeWidth}px` }} />
              <div>
                <strong>Scan to pay</strong>
                <span>{paymentSettings.business_upi_id}</span>
                <small>{receiptCurrency.format(Number(invoice.total_amount || 0))} - {invoice.invoice_no}</small>
              </div>
            </section>
          )}
          <footer className="invoice-footer">
            <strong>Thank you for shopping with FEEL THE FREAKIN&apos; FROOZ.</strong>
            <span>We appreciate your business.</span>
            <small>GST-ready invoice - Powered by SRT Company</small>
          </footer>
        </article>
        {pdfPreview && (
          <PdfPreviewModal
            fileName={pdfPreview.fileName}
            blob={pdfPreview.blob}
            onClose={() => setPdfPreview(null)}
            onSave={() => savePdfResult(pdfPreview)}
          />
        )}
        {whatsappOpen && (
          <WhatsAppSendModal
            caption={invoiceWhatsappMessage()}
            documentName={invoiceFileName()}
            generatePdf={() => exportInvoicePdf(activePrintMode, false)}
            onClose={() => setWhatsappOpen(false)}
            recipients={invoiceWhatsappRecipients}
            sourceId={invoice.id || invoice.sale_id || invoice.invoice_no}
            sourceType="bill"
            title={`Send Bill ${invoice.invoice_no} via WhatsApp`}
            user={user}
          />
        )}
      </section>
    </div>
  );
}

function PurchaseSummary({ summary }) {
  return (
    <section className="purchase-summary">
      <div className="purchase-summary-heading">
        <div>
          <span className="eyebrow">Landed Cost Preview</span>
          <h3>Purchase Calculation</h3>
        </div>
        <span className="origin-rate">Mandi Tax {summary.mandiTaxPercent}%</span>
      </div>
      <div className="purchase-summary-grid">
        <SummaryMetric label="Basic Amount" value={currency.format(summary.basicAmount)} />
        <SummaryMetric label={`Mandi Tax (${summary.mandiTaxPercent}%)`} value={currency.format(summary.mandiTaxAmount)} />
        <SummaryMetric label="Freight Charges" value={currency.format(summary.freightCharges)} />
        <SummaryMetric label="Labour Charges" value={currency.format(summary.labourCharges)} />
        <SummaryMetric label="Other Charges" value={currency.format(summary.otherCharges)} />
        <SummaryMetric label="Gross Amount" value={currency.format(summary.grossAmount)} />
        <SummaryMetric label={`Supplier Rebate (${summary.rebatePercent}%)`} value={`-${currency.format(summary.rebateAmount)}`} positive />
        <SummaryMetric label="Net Payable" value={currency.format(summary.netPayable)} featured />
        <SummaryMetric label="Pending Balance" value={currency.format(summary.balanceAmount)} />
        <SummaryMetric label="Payment Status" value={summary.paymentStatus} />
        <SummaryMetric label="Effective Cost / Unit" value={currency.format(summary.effectiveCostPerUnit)} featured />
      </div>
    </section>
  );
}

const chartSize = { width: 640, height: 250, padding: 34 };
const chartCurrency = new Intl.NumberFormat("en-IN", {
  maximumFractionDigits: 0,
  notation: "compact",
});

const formatChartDate = (date) =>
  new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

const formatChartMoney = (value) => `INR ${chartCurrency.format(Number(value || 0))}`;

const getChartPoints = (data, valueKey, maxValue) => {
  const innerWidth = chartSize.width - chartSize.padding * 2;
  const innerHeight = chartSize.height - chartSize.padding * 2;
  return data.map((row, index) => {
    const x = chartSize.padding + (data.length > 1 ? (index / (data.length - 1)) * innerWidth : innerWidth / 2);
    const y = chartSize.height - chartSize.padding - (Number(row[valueKey] || 0) / maxValue) * innerHeight;
    return { x, y, value: Number(row[valueKey] || 0), date: row.date };
  });
};

function ChartFrame({ children, empty, subtitle, title }) {
  return (
    <section className="chart-card">
      <div className="chart-card-heading">
        <div>
          <span className="eyebrow">{subtitle}</span>
          <h3>{title}</h3>
        </div>
      </div>
      {empty ? <div className="chart-empty">No values recorded for this period.</div> : children}
    </section>
  );
}

function LineChart({ color = "#f59e0b", data, subtitle, title, valueKey }) {
  const rows = data || [];
  const maxValue = Math.max(1, ...rows.map((row) => Number(row[valueKey] || 0)));
  const points = getChartPoints(rows, valueKey, maxValue);
  const pointString = points.map((point) => `${point.x},${point.y}`).join(" ");

  return (
    <ChartFrame empty={!rows.length} subtitle={subtitle} title={title}>
      <svg className="chart-svg" role="img" viewBox={`0 0 ${chartSize.width} ${chartSize.height}`}>
        {[0.25, 0.5, 0.75].map((mark) => (
          <line
            className="chart-grid-line"
            key={mark}
            x1={chartSize.padding}
            x2={chartSize.width - chartSize.padding}
            y1={chartSize.padding + mark * (chartSize.height - chartSize.padding * 2)}
            y2={chartSize.padding + mark * (chartSize.height - chartSize.padding * 2)}
          />
        ))}
        <polyline className="chart-line-glow" points={pointString} style={{ stroke: color }} />
        <polyline className="chart-line" points={pointString} style={{ stroke: color }} />
        {points.map((point) => (
          <circle className="chart-point" cx={point.x} cy={point.y} key={`${point.date}-${point.x}`} r="4" style={{ fill: color }}>
            <title>{`${formatChartDate(point.date)}: ${formatChartMoney(point.value)}`}</title>
          </circle>
        ))}
        <text className="chart-axis-label" x={chartSize.padding} y={chartSize.height - 8}>{rows[0] ? formatChartDate(rows[0].date) : ""}</text>
        <text className="chart-axis-label chart-axis-label-end" x={chartSize.width - chartSize.padding} y={chartSize.height - 8}>{rows.at(-1) ? formatChartDate(rows.at(-1).date) : ""}</text>
        <text className="chart-axis-label" x={chartSize.padding} y="20">{formatChartMoney(maxValue)}</text>
      </svg>
    </ChartFrame>
  );
}

function BarChart({ color = "#f59e0b", data, subtitle, title, valueKey }) {
  const rows = data || [];
  const maxValue = Math.max(1, ...rows.map((row) => Number(row[valueKey] || 0)));
  const innerWidth = chartSize.width - chartSize.padding * 2;
  const innerHeight = chartSize.height - chartSize.padding * 2;
  const barSlot = rows.length ? innerWidth / rows.length : innerWidth;
  return (
    <ChartFrame empty={!rows.length} subtitle={subtitle} title={title}>
      <svg className="chart-svg" role="img" viewBox={`0 0 ${chartSize.width} ${chartSize.height}`}>
        {[0.25, 0.5, 0.75].map((mark) => (
          <line
            className="chart-grid-line"
            key={mark}
            x1={chartSize.padding}
            x2={chartSize.width - chartSize.padding}
            y1={chartSize.padding + mark * innerHeight}
            y2={chartSize.padding + mark * innerHeight}
          />
        ))}
        {rows.map((row, index) => {
          const value = Number(row[valueKey] || 0);
          const height = (value / maxValue) * innerHeight;
          const x = chartSize.padding + index * barSlot + barSlot * 0.18;
          const y = chartSize.height - chartSize.padding - height;
          return (
            <rect className="chart-bar" height={Math.max(height, value > 0 ? 3 : 0)} key={row.date} rx="5" style={{ fill: color }} width={barSlot * 0.64} x={x} y={y}>
              <title>{`${formatChartDate(row.date)}: ${formatChartMoney(value)}`}</title>
            </rect>
          );
        })}
        <text className="chart-axis-label" x={chartSize.padding} y={chartSize.height - 8}>{rows[0] ? formatChartDate(rows[0].date) : ""}</text>
        <text className="chart-axis-label chart-axis-label-end" x={chartSize.width - chartSize.padding} y={chartSize.height - 8}>{rows.at(-1) ? formatChartDate(rows.at(-1).date) : ""}</text>
        <text className="chart-axis-label" x={chartSize.padding} y="20">{formatChartMoney(maxValue)}</text>
      </svg>
    </ChartFrame>
  );
}

function DualLineChart({ data, firstKey, firstLabel, secondKey, secondLabel, subtitle, title }) {
  const rows = data || [];
  const maxValue = Math.max(1, ...rows.flatMap((row) => [Number(row[firstKey] || 0), Number(row[secondKey] || 0)]));
  const firstPoints = getChartPoints(rows, firstKey, maxValue);
  const secondPoints = getChartPoints(rows, secondKey, maxValue);
  return (
    <ChartFrame empty={!rows.length} subtitle={subtitle} title={title}>
      <div className="chart-legend">
        <span><i className="legend-dot legend-dot-sales" />{firstLabel}</span>
        <span><i className="legend-dot legend-dot-purchase" />{secondLabel}</span>
      </div>
      <svg className="chart-svg" role="img" viewBox={`0 0 ${chartSize.width} ${chartSize.height}`}>
        {[0.25, 0.5, 0.75].map((mark) => (
          <line
            className="chart-grid-line"
            key={mark}
            x1={chartSize.padding}
            x2={chartSize.width - chartSize.padding}
            y1={chartSize.padding + mark * (chartSize.height - chartSize.padding * 2)}
            y2={chartSize.padding + mark * (chartSize.height - chartSize.padding * 2)}
          />
        ))}
        <polyline className="chart-line" points={firstPoints.map((point) => `${point.x},${point.y}`).join(" ")} style={{ stroke: "#f59e0b" }} />
        <polyline className="chart-line" points={secondPoints.map((point) => `${point.x},${point.y}`).join(" ")} style={{ stroke: "#38bdf8" }} />
        {[...firstPoints, ...secondPoints].map((point, index) => (
          <circle className="chart-point" cx={point.x} cy={point.y} key={`${point.date}-${index}`} r="3.5" style={{ fill: index < firstPoints.length ? "#f59e0b" : "#38bdf8" }}>
            <title>{`${formatChartDate(point.date)}: ${formatChartMoney(point.value)}`}</title>
          </circle>
        ))}
        <text className="chart-axis-label" x={chartSize.padding} y={chartSize.height - 8}>{rows[0] ? formatChartDate(rows[0].date) : ""}</text>
        <text className="chart-axis-label chart-axis-label-end" x={chartSize.width - chartSize.padding} y={chartSize.height - 8}>{rows.at(-1) ? formatChartDate(rows.at(-1).date) : ""}</text>
        <text className="chart-axis-label" x={chartSize.padding} y="20">{formatChartMoney(maxValue)}</text>
      </svg>
    </ChartFrame>
  );
}

function DashboardAnalytics({ analytics, customRange, onApplyCustomRange, onCustomRangeChange, onNavigate, onRangeChange, range }) {
  const data = analytics || emptyDashboardAnalytics;
  const topProducts = data.topSellingProducts || [];
  const lowStockItems = data.lowStockItems || [];
  const insights = data.insights || [];

  return (
    <section className="dashboard-analytics">
      <section className="content-card analytics-toolbar">
        <div>
          <span className="eyebrow">Owner Analytics</span>
          <h2>Business Graphs</h2>
          <p>Day-wise sales, profit, expenses and stock movement from live FroozERP records.</p>
        </div>
        <div className="dashboard-range-controls">
          <div className="range-buttons">
            {dashboardRanges.map(([value, label]) => (
              <button className={range === value ? "range-button range-button-active" : "range-button"} key={value} onClick={() => onRangeChange(value)} type="button">
                {label}
              </button>
            ))}
          </div>
          {range === "custom" && (
            <div className="dashboard-custom-range">
              <input type="date" value={customRange.date_from} onChange={(event) => onCustomRangeChange((current) => ({ ...current, date_from: event.target.value }))} />
              <input type="date" value={customRange.date_to} onChange={(event) => onCustomRangeChange((current) => ({ ...current, date_to: event.target.value }))} />
              <button className="primary-button" onClick={onApplyCustomRange} type="button">Apply</button>
            </div>
          )}
        </div>
      </section>

      <section className="chart-grid">
        <LineChart color="#f59e0b" data={data.salesTrend} subtitle="Revenue" title="Daily Sales Trend" valueKey="sales" />
        <LineChart color="#22c55e" data={data.profitTrend} subtitle="FIFO Landed Cost" title="Daily Profit Trend" valueKey="grossProfit" />
        <BarChart color="#fb7185" data={data.expenseTrend} subtitle="Operating Cost" title="Daily Expense Trend" valueKey="expenses" />
        <LineChart color="#a78bfa" data={data.netProfitTrend} subtitle="Profit After Expenses" title="Net Profit Trend" valueKey="netProfit" />
        <DualLineChart
          data={data.purchaseSalesComparison}
          firstKey="sales"
          firstLabel="Sales"
          secondKey="purchases"
          secondLabel="Purchases"
          subtitle="Movement"
          title="Purchase vs Sales Comparison"
        />
      </section>

      <section className="dashboard-side-grid">
        <section className="content-card insight-panel">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Owner Insights</span>
              <h2>What Changed</h2>
            </div>
          </div>
          <div className="insight-list">
            {insights.length ? insights.map((insight) => <p key={insight}>{insight}</p>) : <p>No insights available yet.</p>}
          </div>
        </section>

        <section className="content-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Products</span>
              <h2>Top Selling Products</h2>
            </div>
          </div>
          <div className="top-product-list">
            {topProducts.length ? topProducts.map((product) => (
              <article className="top-product-row" key={product.product_id}>
                <div>
                  <strong>{product.product_name}</strong>
                  <span>{Number(product.quantity_sold || 0).toLocaleString("en-IN")} {product.unit || "units"} sold</span>
                </div>
                <strong>{currency.format(Number(product.revenue || 0))}</strong>
              </article>
            )) : <div className="empty-inline">No product sales in this period.</div>}
          </div>
        </section>

        <section className="content-card">
          <div className="card-heading">
            <div>
              <span className="eyebrow">Inventory</span>
              <h2>Low Stock Alerts</h2>
            </div>
            <button className="secondary-button" onClick={() => onNavigate("reports")} type="button">Open Stock Inventory</button>
          </div>
          <div className="low-stock-list">
            {lowStockItems.length ? lowStockItems.map((item) => (
              <button className="low-stock-row" key={item.product_id} onClick={() => onNavigate("reports")} type="button">
                <div>
                  <strong>{item.product_name}</strong>
                  <span>Minimum {Number(item.minimum_stock || 0).toLocaleString("en-IN")} {item.unit || ""}</span>
                </div>
                <strong>{Number(item.current_stock || 0).toLocaleString("en-IN")} left</strong>
              </button>
            )) : <div className="empty-inline">No low stock products right now.</div>}
          </div>
        </section>
      </section>
    </section>
  );
}

function SummaryMetric({ featured = false, label, positive = false, value }) {
  const displayValue = value ?? "-";
  return (
    <div className={featured ? "summary-metric summary-metric-featured" : "summary-metric"} title={`${label}: ${displayValue}`}>
      <span>{label}</span>
      <strong className={positive ? "metric-value profit-cell" : "metric-value"}>{displayValue}</strong>
    </div>
  );
}

function Field({ children, label }) {
  return <label><span>{label}</span>{children}</label>;
}

function ModuleCard({ children, eyebrow, subtitle, title }) {
  return (
    <section className="content-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function DataTable({ children, className = "", headers }) {
  return (
    <div className={`table-wrap ${className}`.trim()}>
      <table>
        <thead><tr>{headers.map((header, index) => <th key={typeof header === "string" ? header : index}>{header}</th>)}</tr></thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export default App;
