import { COOKIE_NAME } from "../config.js";
import { tx } from "../db.js";
import { HttpError, unauthorized } from "../lib/errors.js";
import { RAW, created, requireAuth, requireRole } from "../lib/router.js";
import { clientIp, hashPassword, hashToken, randomToken, signToken, verifyPassword } from "../lib/security.js";
import { parse } from "../lib/validate.js";
import { dentistOfUser, nextPatientCode, patientOfUser } from "../services/lookup.js";
import {
  decryptFaceDescriptor,
  encryptFaceDescriptor,
  euclideanDistance,
  isFaceDescriptor,
} from "../lib/face-descriptors.js";

const FACE_MATCH_THRESHOLD = 0.6;
const REGISTRATION_CONSENT_POLICY_VERSION = "2026-11-04";
const RATE_WINDOW_MS = 15 * 60_000;
const PASSWORD_PAIR_MAX_FAILURES = 10;
const PASSWORD_IP_MAX_FAILURES = 30;
const FACE_IP_MAX_FAILURES = 10;
const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;

function utcAfter(minutes) {
  return new Date(Date.now() + minutes * 60_000).toISOString().slice(0, 19).replace("T", " ");
}

const TITLES = { patient: "Patient", clerk: "Clinic Assistant", dentist: "Attending Dentist", admin: "Dentist & Clinic Administrator" };

function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function counterAllowed(db, key, max, now = Date.now()) {
  const counter = db.prepare("SELECT failures, reset_at FROM rate_limit_counters WHERE scope_key = ?").get(key);
  return !counter || counter.reset_at <= now || counter.failures < max;
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

function clearCounter(db, key) {
  db.prepare("DELETE FROM rate_limit_counters WHERE scope_key = ?").run(key);
}

export function userView(db, u) {
  const base = {
    id: u.id,
    role: u.role,
    fullName: u.full_name ?? u.fullName,
    email: u.email,
    title: TITLES[u.role],
    ...(u.profile_image_type ? {
      profileImageUrl: `/api/auth/profile/image?v=${encodeURIComponent(u.profile_image_updated_at ?? "")}`,
    } : {}),
  };
  if (u.role === "patient") {
    const p = patientOfUser(db, u.id);
    return { ...base, patientId: p?.id ?? null, patientCode: p?.code ?? null };
  }
  if (u.role === "dentist" || u.role === "admin") return { ...base, dentistId: dentistOfUser(db, u.id)?.id ?? null };
  return base;
}

export function startSession(ctx, userRow) {
  const { config } = ctx;
  const token = signToken({ sub: userRow.id, role: userRow.role, sessionVersion: userRow.session_version }, config.jwtSecret, config.tokenTtlSec);
  ctx.setCookie.push(
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${config.tokenTtlSec}${config.cookieSecure ? "; Secure" : ""}`,
  );
  return { token, user: userView(ctx.db, userRow) };
}

export default function register(router, app) {
  router.patch("/api/auth/profile", requireRole("admin"), (ctx) => {
    const data = parse(ctx.body, {
      fullName: { type: "string", min: 2, max: 120 },
      imageBase64: { type: "string", max: 7_000_000 },
      contentType: { type: "enum", values: ["image/jpeg", "image/png", "image/webp"] },
    });
    if (!data.fullName && !data.imageBase64) {
      throw new HttpError(422, "profile_update_empty", "Provide a name or profile picture to update.");
    }
    let image;
    if (data.imageBase64 !== undefined) {
      if (!data.contentType) throw new HttpError(422, "profile_image_type_required", "Choose a valid profile picture type.");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.imageBase64)) {
        throw new HttpError(422, "profile_image_invalid", "Profile picture data is invalid.");
      }
      image = Buffer.from(data.imageBase64, "base64");
      if (!image.length || image.length > MAX_PROFILE_IMAGE_BYTES || image.toString("base64") !== data.imageBase64) {
        throw new HttpError(422, "profile_image_invalid", "Profile pictures must be 5 MB or smaller.");
      }
      if (detectImageType(image) !== data.contentType) {
        throw new HttpError(422, "profile_image_invalid", "Profile picture content does not match its file type.");
      }
    }
    const updatedAt = new Date().toISOString();
    ctx.db.prepare(
      `UPDATE users SET full_name = COALESCE(?, full_name),
       profile_image_type = COALESCE(?, profile_image_type),
       profile_image_data = COALESCE(?, profile_image_data),
       profile_image_updated_at = COALESCE(?, profile_image_updated_at)
       WHERE id = ? AND role = 'admin'`,
    ).run(data.fullName ?? null, data.contentType ?? null, image ?? null, image ? updatedAt : null, ctx.user.id);
    const user = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(ctx.user.id);
    return userView(ctx.db, user);
  });

  router.get("/api/auth/profile/image", requireAuth, (ctx) => {
    const image = ctx.db.prepare("SELECT profile_image_type, profile_image_data FROM users WHERE id = ?").get(ctx.user.id);
    if (!image?.profile_image_data) throw new HttpError(404, "profile_image_not_found", "Profile picture not found.");
    ctx.res.writeHead(200, {
      "Content-Type": image.profile_image_type,
      "Content-Length": image.profile_image_data.length,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    ctx.res.end(image.profile_image_data);
    return RAW;
  });

  router.post("/api/auth/register", async (ctx) => {
    const key = `register|${clientIp(ctx.req, ctx.config.trustProxy)}`;
    if (!app.registerLimiter.take(key)) {
      throw new HttpError(429, "too_many_registrations", "Too many registration attempts. Try again in 15 minutes.");
    }
    const data = parse(ctx.body, {
      fullName: { type: "string", required: true, min: 2, max: 120 },
      email: { type: "email", required: true },
      password: { type: "password", required: true },
      phone: { type: "phone", required: true },
      consent: { type: "bool", required: true },
      birthDate: { type: "birthDate" },
      sex: { type: "enum", values: ["female", "male", "other"] },
    });
    if (data.consent !== true) {
      throw new HttpError(422, "consent_required", "You must agree to the Privacy Policy and Terms of Care to register", {
        consent: "Required",
      });
    }
    const userRow = tx(ctx.db, () => {
      if (ctx.db.prepare("SELECT 1 FROM users WHERE email = ?").get(data.email)) {
        throw new HttpError(409, "email_taken", "An account with this email already exists", { email: "Already registered" });
      }
      const { lastInsertRowid: uid } = ctx.db
        .prepare("INSERT INTO users (role, email, password_hash, full_name, phone, consent_at, consent_policy_version) VALUES ('patient', ?, ?, ?, ?, datetime('now'), ?)")
        .run(data.email, hashPassword(data.password), data.fullName, data.phone, REGISTRATION_CONSENT_POLICY_VERSION);
      const { lastInsertRowid: pid } = ctx.db
        .prepare("INSERT INTO patients (user_id, full_name, birth_date, sex, phone, email, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(uid, data.fullName, data.birthDate ?? null, data.sex ?? null, data.phone, data.email, uid);
      ctx.db.prepare("UPDATE patients SET code = ? WHERE id = ?").run(nextPatientCode(ctx.db, Number(pid)), pid);
      return ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(uid);
    });
    const verificationToken = randomToken();
    ctx.db.prepare(
      "INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    ).run(userRow.id, hashToken(verificationToken), utcAfter(24 * 60));
    await ctx.app.notifier.send({
      userId: userRow.id,
      template: "email_verification",
      dedupeKey: `user:${userRow.id}:email_verification`,
      data: { verificationUrl: `${ctx.config.frontendUrl}/verify-email?token=${encodeURIComponent(verificationToken)}` },
    });
    return created(startSession(ctx, userRow));
  });

  router.post("/api/auth/login", (ctx) => {
    const { email, password } = parse(ctx.body, {
      email: { type: "email", required: true },
      password: { type: "string", required: true, max: 128 },
    });
    const ip = clientIp(ctx.req, ctx.config.trustProxy);
    const pairKey = `password-pair|${ip}|${email}`;
    const ipKey = `password-ip|${ip}`;
    if (!counterAllowed(ctx.db, pairKey, PASSWORD_PAIR_MAX_FAILURES) ||
        !counterAllowed(ctx.db, ipKey, PASSWORD_IP_MAX_FAILURES)) {
      throw new HttpError(429, "too_many_attempts", "Too many sign-in attempts. Try again in 15 minutes.");
    }
    const u = ctx.db.prepare("SELECT * FROM users WHERE email = ? AND active = 1").get(email);
    // Always run a hash comparison so response time doesn't reveal whether the email exists
    const ok = verifyPassword(password, u?.password_hash ?? "scrypt$00$00");
    if (!u || !ok || !["patient", "admin"].includes(u.role)) {
      recordFailure(ctx.db, pairKey);
      recordFailure(ctx.db, ipKey);
      throw unauthorized("Incorrect email or password");
    }
    clearCounter(ctx.db, pairKey);
    clearCounter(ctx.db, ipKey);
    return startSession(ctx, u);
  });

  router.post("/api/auth/face-enroll", requireAuth, (ctx) => {
    if (!["patient", "admin"].includes(ctx.user.role)) {
      throw unauthorized("This account cannot enroll for face login");
    }
    if (ctx.body?.consent !== true) {
      throw new HttpError(422, "consent_required", "Explicit consent is required to store a face descriptor");
    }
    if (!isFaceDescriptor(ctx.body?.descriptor)) {
      throw new HttpError(422, "invalid_descriptor", "A 128-number face descriptor is required");
    }
    if (!/^[\da-f]{64}$/i.test(ctx.config.faceDescriptorKey)) {
      throw new HttpError(503, "face_login_unavailable", "Face login is not configured");
    }

    const encryptedDescriptor = encryptFaceDescriptor(ctx.body.descriptor, ctx.config.faceDescriptorKey);
    ctx.db.prepare(
      `UPDATE users SET face_descriptor = ?, face_descriptor_consent_at = datetime('now')
       WHERE id = ? AND active = 1`,
    )
      .run(encryptedDescriptor, ctx.user.id);
    return { success: true };
  });

  router.delete("/api/auth/face-enroll", requireAuth, (ctx) => {
    ctx.db.prepare(
      "UPDATE users SET face_descriptor = NULL, face_descriptor_consent_at = NULL WHERE id = ?",
    ).run(ctx.user.id);
    return { success: true };
  });

  router.post("/api/auth/face-login", (ctx) => {
    const ip = clientIp(ctx.req, ctx.config.trustProxy);
    const key = `face-ip|${ip}`;
    if (!counterAllowed(ctx.db, key, FACE_IP_MAX_FAILURES)) {
      throw new HttpError(429, "too_many_attempts", "Too many face sign-in attempts. Try again later.");
    }
    if (!isFaceDescriptor(ctx.body?.descriptor)) {
      throw new HttpError(422, "invalid_descriptor", "A 128-number face descriptor is required");
    }
    if (!/^[\da-f]{64}$/i.test(ctx.config.faceDescriptorKey)) {
      throw new HttpError(503, "face_login_unavailable", "Face login is not configured");
    }

    const candidates = ctx.db.prepare(
      `SELECT id, role, email, full_name, face_descriptor
       FROM users
       WHERE active = 1 AND role IN ('admin','patient') AND face_descriptor IS NOT NULL`,
    ).all();
    let match = null;
    let closestDistance = FACE_MATCH_THRESHOLD;

    for (const candidate of candidates) {
      const storedDescriptor = decryptFaceDescriptor(
        candidate.face_descriptor,
        ctx.config.faceDescriptorKey,
      );
      if (!storedDescriptor) {
        console.error(`Ignoring unreadable face descriptor for user ${candidate.id}`);
        continue;
      }
      const distance = euclideanDistance(ctx.body.descriptor, storedDescriptor);
      if (distance < closestDistance) {
        match = candidate;
        closestDistance = distance;
      }
    }

    if (!match) {
      recordFailure(ctx.db, key);
      throw unauthorized("Unrecognized Face");
    }
    clearCounter(ctx.db, key);
    const session = startSession(ctx, ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(match.id));
    const redirectUrl = match.role === "admin" ? "/admin" : "/patient/book";
    return {
      success: true,
      token: session.token,
      role: match.role,
      redirectUrl,
      user: session.user,
    };
  });

  // Role-picker login used by the demo UI. Disabled unless DEMO_MODE=true.
  router.post("/api/auth/demo-login", (ctx) => {
    if (!ctx.config.demoMode) throw new HttpError(404, "not_found", "Endpoint not found");
    const { role } = parse(ctx.body, { role: { type: "enum", values: ["patient", "clerk", "admin"], required: true } });
    const u = ctx.db.prepare("SELECT * FROM users WHERE role = ? AND active = 1 ORDER BY id LIMIT 1").get(role);
    if (!u) throw new HttpError(404, "not_found", `No ${role} account exists. Run the seed script.`);
    return startSession(ctx, u);
  });

  router.post("/api/auth/logout", (ctx) => {
    ctx.setCookie.push(`${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    return undefined;
  });

  router.get("/api/auth/me", requireAuth, (ctx) => {
    const user = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(ctx.user.id);
    return { user: userView(ctx.db, user) };
  });

  router.post("/api/auth/change-password", requireAuth, (ctx) => {
    const data = parse(ctx.body, {
      currentPassword: { type: "string", required: true, max: 128 },
      newPassword: { type: "password", required: true },
    });
    const u = ctx.db.prepare("SELECT * FROM users WHERE id = ?").get(ctx.user.id);
    if (!verifyPassword(data.currentPassword, u.password_hash)) {
      throw new HttpError(422, "validation_error", "Current password is incorrect", { currentPassword: "Incorrect" });
    }
    ctx.db.prepare("UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?").run(hashPassword(data.newPassword), u.id);
    return undefined;
  });

  router.post("/api/auth/forgot-password", async (ctx) => {
    const { email } = parse(ctx.body, { email: { type: "email", required: true } });
    const key = `password-reset|${clientIp(ctx.req, ctx.config.trustProxy)}|${email}`;
    if (!app.passwordResetLimiter.take(key)) {
      throw new HttpError(429, "too_many_attempts", "Too many password reset attempts. Try again later.");
    }
    const user = ctx.db.prepare("SELECT id, email FROM users WHERE email = ? AND active = 1").get(email);
    if (user) {
      const token = randomToken();
      ctx.db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE user_id = ? AND used_at IS NULL").run(user.id);
      ctx.db.prepare(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
      ).run(user.id, hashToken(token), utcAfter(30));
      await app.notifier.send({
        userId: user.id,
        template: "password_reset",
        dedupeKey: `user:${user.id}:password_reset:${hashToken(token)}`,
        data: { resetUrl: `${ctx.config.frontendUrl}/reset-password?token=${encodeURIComponent(token)}` },
      });
    }
    return { message: "If an account exists for that email, password reset instructions have been sent." };
  });

  router.post("/api/auth/reset-password", (ctx) => {
    const data = parse(ctx.body, {
      token: { type: "string", required: true, min: 20, max: 200 },
      newPassword: { type: "password", required: true },
    });
    const row = ctx.db.prepare(
      `SELECT * FROM password_reset_tokens
       WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`,
    ).get(hashToken(data.token));
    if (!row) throw new HttpError(422, "invalid_reset_token", "This password reset link is invalid or expired.");
    tx(ctx.db, () => {
      ctx.db.prepare("UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?").run(hashPassword(data.newPassword), row.user_id);
      ctx.db.prepare("UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL").run(row.id);
    });
    return { message: "Your password has been reset. Please sign in again." };
  });

  router.post("/api/auth/verify-email", (ctx) => {
    const { token } = parse(ctx.body, { token: { type: "string", required: true, min: 20, max: 200 } });
    const row = ctx.db.prepare(
      "SELECT * FROM email_verification_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')",
    ).get(hashToken(token));
    if (!row) throw new HttpError(422, "invalid_verification_token", "This email verification link is invalid or expired.");
    tx(ctx.db, () => {
      ctx.db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").run(row.user_id);
      ctx.db.prepare("UPDATE email_verification_tokens SET used_at = datetime('now') WHERE id = ? AND used_at IS NULL").run(row.id);
    });
    return { message: "Your email has been verified." };
  });
}
