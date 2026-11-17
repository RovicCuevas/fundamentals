import path from "node:path";
import { fileURLToPath } from "node:url";

try {
  const configDirectory = path.dirname(fileURLToPath(import.meta.url));
  process.loadEnvFile(path.resolve(configDirectory, "..", ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

export const COOKIE_NAME = "sc_token";

const bool = (v, d) => (v === undefined ? d : ["1", "true", "yes"].includes(String(v).toLowerCase()));
const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const ALLOWED_PAYMONGO_METHODS = new Set(["card", "gcash", "grab_pay", "paymaya"]);
const NOTIFICATION_PROVIDERS = new Set(["console", "brevo-api", "brevo-smtp"]);

function parsePayMongoMethods(value) {
  if (value === undefined || value.trim() === "") return ["card", "gcash", "grab_pay", "paymaya"];
  const methods = [...new Set(value.split(",").map((method) => method.trim()).filter(Boolean))];
  const invalid = methods.filter((method) => !ALLOWED_PAYMONGO_METHODS.has(method));
  if (!methods.length || invalid.length) {
    throw new Error(`PAYMONGO_PAYMENT_METHODS must be a comma-separated list of: ${[...ALLOWED_PAYMONGO_METHODS].join(", ")}`);
  }
  return methods;
}

function parseCorsOrigins(value) {
  return value.split(",").map((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return "";
    let url;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error(`Invalid CORS_ORIGIN entry: ${trimmed}`);
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new Error(`CORS_ORIGIN must contain HTTP(S) origins: ${trimmed}`);
    }
    return url.origin;
  }).filter(Boolean);
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  const isProd = env.NODE_ENV === "production";

  const config = {
    isProd,
    port: num(env.PORT, 4000),
    dbPath: env.DB_PATH || path.resolve("data", "smartcare.db"),
    supabaseDbUrl: env.SUPABASE_DB_URL || "",
    jwtSecret: env.JWT_SECRET || "",
    faceDescriptorKey: env.FACE_DESCRIPTOR_KEY || "",
    facePlusPlusApiKey: env.FACEPP_API_KEY || "",
    facePlusPlusApiSecret: env.FACEPP_API_SECRET || "",
    facePlusPlusBaseUrl: env.FACEPP_API_BASE_URL || "https://api-us.faceplusplus.com",
    facePlusPlusComparePath: env.FACEPP_COMPARE_PATH || "/facepp/v3/compare",
    facePlusPlusTimeoutMs: num(env.FACEPP_TIMEOUT_MS, 15_000),
    facePlusPlusMatchThreshold: num(env.FACEPP_MATCH_THRESHOLD, 80),
    ocrSpaceApiKey: env.OCR_SPACE_API_KEY || "",
    ocrSpaceApiUrl: env.OCR_SPACE_API_URL || "https://api.ocr.space/parse/image",
    ocrSpaceLanguage: env.OCR_SPACE_LANGUAGE || "eng",
    ocrSpaceTimeoutMs: num(env.OCR_SPACE_TIMEOUT_MS, 15_000),
    allowInsecureDevSecret: bool(env.ALLOW_INSECURE_DEV_SECRET, false),
    corsOrigins: parseCorsOrigins(env.CORS_ORIGIN || "http://localhost:3000"),
    clinicTz: env.CLINIC_TZ || "Asia/Manila",
    demoMode: bool(env.DEMO_MODE, false),
    seedOnStart: bool(env.SEED_ON_START, !isProd),
    cookieSecure: bool(env.COOKIE_SECURE, isProd),
    bootstrapAdminEmail: env.BOOTSTRAP_ADMIN_EMAIL || "allyssagrace@gmail.com",
    bootstrapAdminPassword: env.BOOTSTRAP_ADMIN_PASSWORD || "",
    payMongoSecretKey: env.PAYMONGO_SECRET_KEY || "",
    payMongoWebhookSecret: env.PAYMONGO_WEBHOOK_SECRET || "",
    payMongoPaymentMethods: parsePayMongoMethods(env.PAYMONGO_PAYMENT_METHODS),
    frontendUrl: env.FRONTEND_URL || "http://localhost:3000",
    trustProxy: num(env.TRUST_PROXY, 0),
    publicSseMaxConnections: num(env.PUBLIC_SSE_MAX_CONNECTIONS, 100),
    publicSseMaxPerIp: num(env.PUBLIC_SSE_MAX_PER_IP, 10),
    tokenTtlSec: 60 * 60 * 12,
    slotHoldMin: num(env.SLOT_HOLD_MIN, 5),
    pendingPaymentTtlMin: num(env.PENDING_PAYMENT_TTL_MIN, 30),
    maxPendingPerPatient: num(env.MAX_PENDING_PER_PATIENT, 2),
    minLeadMin: num(env.MIN_LEAD_MIN, 30),
    maxAdvanceDays: num(env.MAX_ADVANCE_DAYS, 90),
    patientCancelRescheduleHours: num(env.PATIENT_CANCEL_RESCHEDULE_HOURS, 24),
    clinicCancellationRefunds: bool(env.CLINIC_CANCELLATION_REFUNDS, true),
    notificationProvider: env.NOTIFICATION_PROVIDER ||
      (env.BREVO_API_KEY && (env.BREVO_SENDER_EMAIL || env.NOTIFICATION_FROM_EMAIL) ? "brevo-api" : "console"),
    brevoApiKey: env.BREVO_API_KEY || "",
    brevoApiUrl: env.BREVO_API_URL || "https://api.brevo.com/v3/smtp/email",
    brevoSenderEmail: env.BREVO_SENDER_EMAIL || "",
    brevoSmtpHost: env.BREVO_SMTP_HOST || "smtp-relay.brevo.com",
    brevoSmtpPort: num(env.BREVO_SMTP_PORT, 587),
    brevoSmtpUser: env.BREVO_SMTP_USER || "",
    brevoSmtpPassword: env.BREVO_SMTP_PASSWORD || "",
    notificationFromEmail: env.NOTIFICATION_FROM_EMAIL || env.BREVO_SENDER_EMAIL || overrides.brevoSenderEmail || "",
    notificationFromName: env.NOTIFICATION_FROM_NAME || "SmartCare Dental Clinic",
    clock: () => new Date(), // overridable in tests
    silent: false,
    ...overrides,
  };

  if (!config.jwtSecret || config.jwtSecret.length < 32) {
    if (!config.allowInsecureDevSecret || config.isProd) {
      throw new Error("JWT_SECRET is required and must be at least 32 characters");
    }
    console.warn("[security] WARNING: using an insecure development JWT_SECRET fallback; never use this outside local development");
    config.jwtSecret = "dev-only-secret-do-not-use-in-production";
  }
  if (!/^[\da-f]{64}$/i.test(config.faceDescriptorKey)) {
    if (!config.allowInsecureDevSecret || config.isProd) {
      throw new Error("FACE_DESCRIPTOR_KEY is required and must be a 64-character hex-encoded key");
    }
    console.warn("[security] WARNING: using an insecure development FACE_DESCRIPTOR_KEY fallback; never use this outside local development");
    config.faceDescriptorKey = "a".repeat(64);
  }
  if (config.facePlusPlusApiKey || config.facePlusPlusApiSecret) {
    if (!config.facePlusPlusApiKey || !config.facePlusPlusApiSecret) {
      throw new Error("FACEPP_API_KEY and FACEPP_API_SECRET must be configured together");
    }
    try {
      const baseUrl = new URL(config.facePlusPlusBaseUrl);
      if (baseUrl.protocol !== "https:") throw new Error("FACEPP_API_BASE_URL must use HTTPS");
      config.facePlusPlusBaseUrl = baseUrl.origin;
    } catch {
      throw new Error("FACEPP_API_BASE_URL must be a valid HTTPS URL");
    }
  }
  if (!Number.isInteger(config.facePlusPlusTimeoutMs) || config.facePlusPlusTimeoutMs < 1000 || config.facePlusPlusTimeoutMs > 60_000) {
    throw new Error("FACEPP_TIMEOUT_MS must be an integer between 1000 and 60000");
  }
  if (!Number.isFinite(config.facePlusPlusMatchThreshold) || config.facePlusPlusMatchThreshold < 0 || config.facePlusPlusMatchThreshold > 100) {
    throw new Error("FACEPP_MATCH_THRESHOLD must be a number between 0 and 100");
  }
  try {
    const ocrUrl = new URL(config.ocrSpaceApiUrl);
    if (ocrUrl.protocol !== "https:") throw new Error("OCR_SPACE_API_URL must use HTTPS");
    config.ocrSpaceApiUrl = ocrUrl.toString();
  } catch {
    throw new Error("OCR_SPACE_API_URL must be a valid HTTPS URL");
  }
  if (!Number.isInteger(config.ocrSpaceTimeoutMs) || config.ocrSpaceTimeoutMs < 1000 || config.ocrSpaceTimeoutMs > 60_000) {
    throw new Error("OCR_SPACE_TIMEOUT_MS must be an integer between 1000 and 60000");
  }
  if (config.isProd && config.demoMode) {
    throw new Error("DEMO_MODE must be false when NODE_ENV=production");
  }
  if (config.isProd && !env.CORS_ORIGIN) {
    throw new Error("CORS_ORIGIN must list the deployed frontend origin when NODE_ENV=production");
  }
  if (config.isProd && config.bootstrapAdminPassword) {
    throw new Error("Bootstrap account passwords must not be configured in production");
  }
  if (!NOTIFICATION_PROVIDERS.has(config.notificationProvider)) {
    throw new Error("NOTIFICATION_PROVIDER must be console, brevo-api, or brevo-smtp");
  }
  if (config.notificationProvider === "brevo-api" && (!config.brevoApiKey || !config.notificationFromEmail)) {
    throw new Error("BREVO_API_KEY and NOTIFICATION_FROM_EMAIL are required for brevo-api notifications");
  }
  if (config.notificationProvider === "brevo-smtp" &&
      (!config.brevoSmtpUser || !config.brevoSmtpPassword || !config.notificationFromEmail)) {
    throw new Error("BREVO_SMTP_USER, BREVO_SMTP_PASSWORD, and NOTIFICATION_FROM_EMAIL are required for brevo-smtp notifications");
  }
  if (!Number.isInteger(config.trustProxy) || config.trustProxy < 0) {
    throw new Error("TRUST_PROXY must be a non-negative integer");
  }
  if (!Number.isInteger(config.publicSseMaxConnections) || config.publicSseMaxConnections < 1) {
    throw new Error("PUBLIC_SSE_MAX_CONNECTIONS must be a positive integer");
  }
  if (!Number.isInteger(config.publicSseMaxPerIp) || config.publicSseMaxPerIp < 1) {
    throw new Error("PUBLIC_SSE_MAX_PER_IP must be a positive integer");
  }
  return config;
}
