import { HttpError } from "../lib/errors.js";
import { clientIp } from "../lib/security.js";
import { requireRole } from "../lib/router.js";
import { parse } from "../lib/validate.js";
import { compareFaces } from "../services/facepp.js";
import { ocrIdImage } from "../services/ocr-space.js";

const CONSENT_POLICY_VERSION = "2026-11-11";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const RATE_WINDOW_MS = 15 * 60_000;
const MAX_FAILURES = 5;

function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function decodeImage(value, field) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new HttpError(422, "identity_image_invalid", `${field} is not valid image data.`);
  }
  const data = Buffer.from(value, "base64");
  if (!data.length || data.length > MAX_IMAGE_BYTES) {
    throw new HttpError(422, "identity_image_invalid", "Identity images must be 5 MB or smaller.");
  }
  const contentType = detectImageType(data);
  if (!contentType) throw new HttpError(422, "identity_image_invalid", `${field} must be a JPEG, PNG, or WebP image.`);
  return { data, contentType };
}

function failureKeys(ctx) {
  return {
    account: `identity-verification|account|${ctx.user.id}`,
    ip: `identity-verification|ip|${clientIp(ctx.req, ctx.config.trustProxy)}`,
  };
}

function allowed(db, key, now = Date.now()) {
  const row = db.prepare("SELECT failures, reset_at FROM rate_limit_counters WHERE scope_key = ?").get(key);
  return !row || row.reset_at <= now || row.failures < MAX_FAILURES;
}

function recordFailure(db, key, now = Date.now()) {
  db.prepare(
    `INSERT INTO rate_limit_counters (scope_key, failures, reset_at)
     VALUES (?, 1, ?)
     ON CONFLICT (scope_key) DO UPDATE SET
       failures = CASE
         WHEN rate_limit_counters.reset_at <= ? THEN 1
         ELSE rate_limit_counters.failures + 1
       END,
       reset_at = CASE
         WHEN rate_limit_counters.reset_at <= ? THEN excluded.reset_at
         ELSE rate_limit_counters.reset_at
       END
     RETURNING scope_key`,
  ).run(key, now + RATE_WINDOW_MS, now, now);
}

function clearFailure(db, key) {
  db.prepare("DELETE FROM rate_limit_counters WHERE scope_key = ?").run(key);
}

function lastFour(value) {
  const digits = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  return digits.length >= 4 ? digits.slice(-4) : null;
}

function labeledField(text, labels) {
  const pattern = labels.join("|");
  const match = text.match(new RegExp(`^\\s*(?:${pattern})\\s*(?:[:\\-]\\s*|\\s+)(.+?)\\s*$`, "im"));
  return match?.[1]?.trim() || null;
}

function ocrFields(result) {
  const text = result.ParsedResults
    .map((item) => typeof item?.ParsedText === "string" ? item.ParsedText : "")
    .join("\n");
  if (!text.trim()) {
    throw new HttpError(422, "identity_ocr_failed", "OCR.space could not read the government ID.");
  }
  return {
    fullName: labeledField(text, ["full\\s+name", "name"]),
    birthDate: labeledField(text, ["birth\\s*date", "date\\s+of\\s+birth", "birthday"]),
    idNumberLast4: lastFour(labeledField(text, ["id\\s*(?:number|no\\.?|#)", "document\\s*(?:number|no\\.?)"])),
    expiryDate: labeledField(text, ["expiry\\s*date", "expiration\\s*date", "valid\\s+until"]),
  };
}

function comparisonScore(result) {
  const score = Number(result.confidence);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new HttpError(502, "identity_provider_invalid_response", "Face++ returned an invalid face comparison score.");
  }
  return score;
}

function verificationView(row) {
  if (!row) return { status: "not_started" };
  return {
    status: row.status,
    consentAt: row.consent_at,
    idFullName: row.id_full_name,
    idBirthDate: row.id_birth_date,
    idNumberLast4: row.id_number_last4,
    idExpiryDate: row.id_expiry_date,
    faceMatchScore: row.face_match_score,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function saveVerification(db, userId, values) {
  const updated = db.prepare(
    `UPDATE identity_verifications SET status = ?, consent_at = ?, consent_policy_version = ?,
       id_full_name = ?, id_birth_date = ?, id_number_last4 = ?, id_expiry_date = ?,
       face_match_score = ?, provider_reference = ?, failure_reason = ?, updated_at = ?
     WHERE user_id = ?`,
  ).run(...values, userId);
  if (updated.changes > 0) return;

  db.prepare(
    `INSERT INTO identity_verifications
      (user_id, status, consent_at, consent_policy_version, id_full_name, id_birth_date,
       id_number_last4, id_expiry_date, face_match_score, provider_reference, failure_reason, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET status = excluded.status,
       consent_at = excluded.consent_at, consent_policy_version = excluded.consent_policy_version,
       id_full_name = excluded.id_full_name, id_birth_date = excluded.id_birth_date,
       id_number_last4 = excluded.id_number_last4, id_expiry_date = excluded.id_expiry_date,
       face_match_score = excluded.face_match_score, provider_reference = excluded.provider_reference,
       failure_reason = excluded.failure_reason, updated_at = excluded.updated_at`,
  ).run(userId, ...values);
}

export default function register(router) {
  router.get("/api/identity-verification", requireRole("dentist", "admin"), (ctx) => {
    const row = ctx.db.prepare("SELECT * FROM identity_verifications WHERE user_id = ?").get(ctx.user.id);
    return verificationView(row);
  });

  router.delete("/api/identity-verification", requireRole("dentist", "admin"), (ctx) => {
    ctx.db.prepare("DELETE FROM identity_verifications WHERE user_id = ?").run(ctx.user.id);
    return { status: "not_started" };
  });

  router.post("/api/identity-verification", requireRole("dentist", "admin"), async (ctx) => {
    const data = parse(ctx.body, {
      idImageBase64: { type: "string", required: true, max: 7_000_000 },
      selfieImageBase64: { type: "string", required: true, max: 7_000_000 },
      consent: { type: "bool", required: true },
    });
    const { account: accountKey, ip: ipKey } = failureKeys(ctx);
    if (!allowed(ctx.db, accountKey) || !allowed(ctx.db, ipKey)) {
      throw new HttpError(429, "too_many_identity_attempts", "Too many verification attempts. Try again later.");
    }

    try {
      if (data.consent !== true) throw new HttpError(422, "identity_consent_required", "Consent is required for identity verification.");
      const idImage = decodeImage(data.idImageBase64, "Government ID");
      const selfieImage = decodeImage(data.selfieImageBase64, "Selfie");
      const ocr = ocrFields(await ocrIdImage(ctx.config, idImage));
      const comparison = await compareFaces(ctx.config, selfieImage, idImage);
      const score = comparisonScore(comparison);
      const status = score >= ctx.config.facePlusPlusMatchThreshold ? "verified" : "rejected";
      const reason = status === "verified" ? null : "The selfie did not sufficiently match the ID photo.";
      const now = new Date().toISOString();
      saveVerification(ctx.db, ctx.user.id, [
        status,
        now,
        CONSENT_POLICY_VERSION,
        ocr.fullName,
        ocr.birthDate,
        ocr.idNumberLast4,
        ocr.expiryDate,
        score,
        typeof comparison.request_id === "string" ? comparison.request_id : null,
        reason,
        now,
      ]);
      clearFailure(ctx.db, accountKey);
      clearFailure(ctx.db, ipKey);
      return verificationView(ctx.db.prepare("SELECT * FROM identity_verifications WHERE user_id = ?").get(ctx.user.id));
    } catch (error) {
      if (error?.code === "23505" || error?.code === "ERR_SQLITE_CONSTRAINT_UNIQUE") {
        console.error("Identity verification save conflict", {
          constraint: error.constraint,
          message: error.message,
        });
      }
      recordFailure(ctx.db, accountKey);
      recordFailure(ctx.db, ipKey);
      throw error;
    }
  });
}
