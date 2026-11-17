import crypto from "node:crypto";
import { tx } from "../db.js";
import { conflict, forbidden, invalid, notFound } from "../lib/errors.js";
import { RAW, created, requireAuth, requireRole } from "../lib/router.js";
import { hashPassword } from "../lib/security.js";
import { addDays, clinicNow, toMin } from "../lib/time.js";
import { isDate, parse, parseQuery } from "../lib/validate.js";
import { assertServiceDentist, BOOKING_DURATION_MIN, getDaySlots, getMonthAvailability, getServiceOrThrow } from "../services/scheduling.js";
import { dentistOfUser } from "../services/lookup.js";

const DEFAULT_HOURS = [[8, 17]];
const MAX_PROFILE_IMAGE_BYTES = 5 * 1024 * 1024;

function detectImageType(buffer) {
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

function imageDimensions(buffer, type) {
  if (type === "image/png" && buffer.length >= 24) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (type === "image/jpeg") {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9) continue;
      if (offset + 2 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
      }
      offset += segmentLength;
    }
  }
  if (type === "image/webp" && buffer.length >= 30 && buffer.subarray(12, 16).toString("ascii") === "VP8X") {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    };
  }
  return null;
}

function parseProfileImage(data) {
  if (data.imageBase64 === undefined) {
    if (data.contentType !== undefined) throw invalid("Profile picture data is required.");
    return undefined;
  }
  if (!data.contentType) throw invalid("Choose a valid profile picture type.");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.imageBase64)) {
    throw invalid("Profile picture data is invalid.");
  }
  const image = Buffer.from(data.imageBase64, "base64");
  if (!image.length || image.length > MAX_PROFILE_IMAGE_BYTES || image.toString("base64") !== data.imageBase64) {
    throw invalid("Profile pictures must be 5 MB or smaller.");
  }
  const imageType = detectImageType(image);
  if (imageType !== data.contentType) throw invalid("Profile picture content does not match its file type.");
  const dimensions = imageDimensions(image, imageType);
  if (!dimensions || dimensions.width < 200 || dimensions.height < 200) {
    throw invalid("Profile pictures must be at least 200 by 200 pixels.");
  }
  return image;
}

function dentistView(db, d, { admin = false } = {}) {
  const u = db.prepare("SELECT full_name, email, phone FROM users WHERE id = ?").get(d.user_id);
  const weekly = db.prepare("SELECT weekday, start_time, end_time FROM dentist_schedules WHERE dentist_id = ? ORDER BY weekday, start_time").all(d.id);
  const reviewSummary = db.prepare(
    "SELECT ROUND(AVG(rating), 1) AS average_rating, COUNT(*) AS review_count FROM dentist_reviews WHERE dentist_id = ?",
  ).get(d.id);
  const reviews = db.prepare(
    `SELECT rating, comment, created_at FROM dentist_reviews
     WHERE dentist_id = ? AND is_public = 1 AND trim(comment) != ''
     ORDER BY created_at DESC, id DESC LIMIT 3`,
  ).all(d.id);
  return {
    id: d.id,
    name: u.full_name,
    specialty: d.specialty,
    bio: d.bio,
    status: d.status,
    active: Boolean(d.active),
    ratingAverage: reviewSummary.average_rating,
    reviewCount: reviewSummary.review_count,
    ...(d.profile_image_type ? {
      profileImageUrl: `/api/dentists/${d.id}/image?v=${encodeURIComponent(d.profile_image_updated_at ?? "")}`,
    } : {}),
    reviews: reviews.map((review) => ({
      rating: review.rating,
      comment: review.comment,
      createdAt: review.created_at,
    })),
    schedule: weekly.map((w) => ({ weekday: w.weekday, startTime: w.start_time, endTime: w.end_time })),
    ...(admin ? { ...(u.active ? { email: u.email, phone: u.phone } : {}), userId: d.user_id } : {}),
  };
}

function dentistViews(db, rows, { admin = false } = {}) {
  const views = new Map();
  for (const row of rows) {
    if (!views.has(row.id)) {
      views.set(row.id, {
        dentist: row,
        schedules: new Map(),
        reviews: new Map(),
      });
    }
    const view = views.get(row.id);
    if (row.schedule_weekday !== null) {
      const key = `${row.schedule_weekday}:${row.schedule_start_time}:${row.schedule_end_time}`;
      view.schedules.set(key, {
        weekday: row.schedule_weekday,
        startTime: row.schedule_start_time,
        endTime: row.schedule_end_time,
      });
    }
    if (row.review_position !== null) {
      view.reviews.set(row.review_position, {
        rating: row.review_rating,
        comment: row.review_comment,
        createdAt: row.review_created_at,
      });
    }
  }

  return [...views.values()].map(({ dentist: d, schedules, reviews }) => ({
    id: d.id,
    name: d.full_name,
    specialty: d.specialty,
    bio: d.bio,
    status: d.status,
    active: Boolean(d.active),
    ratingAverage: d.average_rating,
    reviewCount: d.review_count ?? 0,
    ...(d.profile_image_type ? {
      profileImageUrl: `/api/dentists/${d.id}/image?v=${encodeURIComponent(d.profile_image_updated_at ?? "")}`,
    } : {}),
    reviews: [...reviews.values()],
    schedule: [...schedules.values()],
    ...(admin ? { ...(d.user_active ? { email: d.email, phone: d.phone } : {}), userId: d.user_id } : {}),
  }));
}

function resolveDentist(ctx, { allowInactive = false } = {}) {
  let d;
  if (ctx.params.id === "me") {
    if (!["dentist", "admin"].includes(ctx.user?.role)) throw forbidden("Only the dentist can use /me");
    d = dentistOfUser(ctx.db, ctx.user.id);
  } else {
    d = ctx.db.prepare("SELECT * FROM dentists WHERE id = ?").get(ctx.params.id);
  }
  if (!d || (!d.active && !allowInactive)) throw notFound("Dentist");
  return d;
}
const assertCanManage = (ctx, d) => {
  if (ctx.user.role === "admin") return;
  if (ctx.user.role === "dentist" && d.user_id === ctx.user.id) return;
  throw forbidden("You can only manage your own schedule");
};

function replaceSchedule(db, dentistId, blocks) {
  db.prepare("DELETE FROM dentist_schedules WHERE dentist_id = ?").run(dentistId);
  const ins = db.prepare("INSERT INTO dentist_schedules (dentist_id, weekday, start_time, end_time) VALUES (?,?,?,?)");
  for (const b of blocks) ins.run(dentistId, b.weekday, b.startTime, b.endTime);
}

export default function register(router) {
  router.get("/api/dentists", (ctx) => {
    const admin = ctx.user?.role === "admin";
    const includeInactive = admin && ctx.query.includeInactive === "1";
    const rows = ctx.db.prepare(
      `WITH review_summary AS (
         SELECT dentist_id, ROUND(AVG(rating), 1) AS average_rating, COUNT(*) AS review_count
         FROM dentist_reviews GROUP BY dentist_id
       ), ranked_reviews AS (
         SELECT dentist_id, rating, comment, created_at,
           ROW_NUMBER() OVER (PARTITION BY dentist_id ORDER BY created_at DESC, id DESC) AS position
         FROM dentist_reviews WHERE is_public = 1 AND trim(comment) != ''
       )
       SELECT d.*, u.full_name, u.email, u.phone, u.active AS user_active,
         review_summary.average_rating, review_summary.review_count,
         schedule.weekday AS schedule_weekday, schedule.start_time AS schedule_start_time,
         schedule.end_time AS schedule_end_time,
         ranked_reviews.position AS review_position, ranked_reviews.rating AS review_rating,
         ranked_reviews.comment AS review_comment, ranked_reviews.created_at AS review_created_at
       FROM dentists d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN review_summary ON review_summary.dentist_id = d.id
       LEFT JOIN dentist_schedules schedule ON schedule.dentist_id = d.id
       LEFT JOIN ranked_reviews ON ranked_reviews.dentist_id = d.id AND ranked_reviews.position <= 3
       ${includeInactive ? "" : "WHERE d.active = 1"}
       ORDER BY u.full_name, schedule.weekday, schedule.start_time, ranked_reviews.position`,
    ).all();
    return { items: dentistViews(ctx.db, rows, { admin }) };
  });

  router.post("/api/dentists", requireRole("admin"), (ctx) => {
    const data = parse(ctx.body, {
      fullName: { type: "string", required: true, min: 2, max: 120 },
      specialty: { type: "string", max: 100, default: "General Dentistry" },
      bio: { type: "string", max: 1000, default: "" },
      imageBase64: { type: "string", max: 7_000_000 },
      contentType: { type: "enum", values: ["image/jpeg", "image/png", "image/webp"] },
    });
    const image = parseProfileImage(data);
    const id = tx(ctx.db, () => {
      const email = `directory-${crypto.randomUUID()}@clinic.invalid`;
      const password = crypto.randomBytes(32).toString("hex");
      const u = ctx.db.prepare(
        "INSERT INTO users (role, email, password_hash, full_name, active) VALUES ('dentist',?,?,?,0)",
      ).run(email, hashPassword(password), data.fullName);
      const d = ctx.db.prepare(
        "INSERT INTO dentists (user_id, specialty, bio, profile_image_type, profile_image_data, profile_image_updated_at) VALUES (?,?,?,?,?,?)",
      ).run(u.lastInsertRowid, data.specialty, data.bio, data.contentType ?? null, image ?? null, image ? new Date().toISOString() : null);
      const blocks = [];
      for (let wd = 1; wd <= 5; wd++) for (const [s, e] of DEFAULT_HOURS) blocks.push({ weekday: wd, startTime: `${String(s).padStart(2, "0")}:00`, endTime: `${String(e).padStart(2, "0")}:00` });
      replaceSchedule(ctx.db, d.lastInsertRowid, blocks);
      return d.lastInsertRowid;
    });
    const item = dentistView(ctx.db, ctx.db.prepare("SELECT * FROM dentists WHERE id = ?").get(id), { admin: true });
    ctx.hub.toCatalog("clinic.catalog.updated", { kind: "dentist", action: "created", id });
    return created(item);
  });

  router.get("/api/dentists/:id", (ctx) => dentistView(ctx.db, resolveDentist(ctx), { admin: ctx.user?.role === "admin" }));

  router.get("/api/dentists/:id/image", (ctx) => {
    const dentist = resolveDentist(ctx, { allowInactive: ctx.user?.role === "admin" });
    const image = ctx.db.prepare("SELECT profile_image_type, profile_image_data FROM dentists WHERE id = ?").get(dentist.id);
    if (!image?.profile_image_data) throw notFound("Dentist profile picture");
    ctx.res.writeHead(200, {
      "Content-Type": image.profile_image_type,
      "Content-Length": image.profile_image_data.length,
      "Cache-Control": "public, max-age=3600",
      "Content-Disposition": "inline",
      "X-Content-Type-Options": "nosniff",
    });
    ctx.res.end(image.profile_image_data);
    return RAW;
  });

  router.patch("/api/dentists/:id", requireRole("admin"), (ctx) => {
    const d = resolveDentist(ctx, { allowInactive: true });
    const data = parse(ctx.body, {
      fullName: { type: "string", min: 2, max: 120 },
      phone: { type: "phone" },
      specialty: { type: "string", max: 100 },
      bio: { type: "string", max: 1000 },
      active: { type: "bool" },
      imageBase64: { type: "string", max: 7_000_000 },
      contentType: { type: "enum", values: ["image/jpeg", "image/png", "image/webp"] },
    });
    const image = parseProfileImage(data);
    if (data.imageBase64 !== undefined && !image) throw invalid("Profile picture is invalid.");
    const imageUpdatedAt = image ? new Date().toISOString() : null;
    tx(ctx.db, () => {
      ctx.db.prepare(
        `UPDATE dentists SET specialty = ?, bio = ?, active = ?,
         profile_image_type = COALESCE(?, profile_image_type),
         profile_image_data = COALESCE(?, profile_image_data),
         profile_image_updated_at = COALESCE(?, profile_image_updated_at)
         WHERE id = ?`,
      ).run(data.specialty ?? d.specialty, data.bio ?? d.bio, data.active === undefined ? d.active : Number(data.active),
        data.contentType ?? null, image ?? null, imageUpdatedAt, d.id);
      if (data.fullName) ctx.db.prepare("UPDATE users SET full_name = ? WHERE id = ?").run(data.fullName, d.user_id);
      if (data.phone) ctx.db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(data.phone, d.user_id);
    });
    const item = dentistView(ctx.db, ctx.db.prepare("SELECT * FROM dentists WHERE id = ?").get(d.id), { admin: true });
    ctx.hub.toCatalog("clinic.catalog.updated", { kind: "dentist", action: data.active === false ? "deleted" : "updated", id: d.id });
    return item;
  });

  router.delete("/api/dentists/:id", requireRole("admin"), (ctx) => {
    const d = resolveDentist(ctx, { allowInactive: true });
    ctx.db.prepare("UPDATE dentists SET active = 0 WHERE id = ?").run(d.id);
    ctx.hub.toCatalog("clinic.catalog.updated", { kind: "dentist", action: "deleted", id: d.id });
    return undefined;
  });

  // Duty status toggle: Available / On Break / Off Duty
  router.patch("/api/dentists/:id/status", requireAuth, (ctx) => {
    const d = resolveDentist(ctx);
    assertCanManage(ctx, d);
    const { status } = parse(ctx.body, { status: { type: "enum", values: ["available", "on_break", "off_duty"], required: true } });
    ctx.db.prepare("UPDATE dentists SET status = ? WHERE id = ?").run(status, d.id);
    ctx.hub.toAll("dentist.status", { dentistId: d.id, status });
    return { id: d.id, status };
  });

  // ---- availability (drives the booking calendar & time slots) ----
  router.get("/api/dentists/:id/availability", (ctx) => {
    const d = resolveDentist(ctx);
    const q = parseQuery(ctx.query, { date: { type: "date", required: true }, serviceId: { type: "int", required: true } });
    const service = getServiceOrThrow(ctx.db, q.serviceId);
    assertServiceDentist(ctx.db, service, d.id);
    const day = getDaySlots(ctx.app, { dentistId: d.id, date: q.date, durationMin: BOOKING_DURATION_MIN, holdOwnerUserId: ctx.user?.id ?? 0 });
    const availability = ctx.user?.role === "admin"
      ? day
      : { ...day, ...(day.dayStatus === "time_off" ? { reason: "Unavailable" } : {}) };
    return { date: q.date, dentistId: d.id, service: { id: service.id, name: service.name, durationMin: BOOKING_DURATION_MIN }, ...availability };
  });

  router.get("/api/dentists/:id/availability/calendar", (ctx) => {
    const d = resolveDentist(ctx);
    const q = parseQuery(ctx.query, { month: { type: "string", required: true, min: 7, max: 7 }, serviceId: { type: "int", required: true } });
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(q.month)) throw invalid("month must be YYYY-MM", { month: "Invalid month" });
    const service = getServiceOrThrow(ctx.db, q.serviceId);
    assertServiceDentist(ctx.db, service, d.id);
    const days = getMonthAvailability(ctx.app, {
      dentistId: d.id,
      month: q.month,
      holdOwnerUserId: ctx.user?.id ?? 0,
    });
    return { month: q.month, dentistId: d.id, days };
  });

  // ---- weekly schedule & time off (dentist portal) ----
  router.get("/api/dentists/:id/schedule", (ctx) => {
    const d = resolveDentist(ctx);
    const today = clinicNow(ctx.config).date;
    const timeOff = ctx.db.prepare("SELECT date, reason FROM dentist_time_off WHERE dentist_id = ? AND date >= ? ORDER BY date").all(d.id, today);
    return {
      dentistId: d.id,
      weekly: dentistView(ctx.db, d).schedule,
      timeOff: ctx.user?.role === "admin"
        ? timeOff
        : timeOff.map(({ date }) => ({ date, reason: "Unavailable" })),
    };
  });

  router.put("/api/dentists/:id/schedule", requireAuth, (ctx) => {
    const d = resolveDentist(ctx);
    assertCanManage(ctx, d);
    if (!Array.isArray(ctx.body?.blocks) || ctx.body.blocks.length > 50) throw invalid("blocks must be an array (max 50)");
    const blocks = ctx.body.blocks.map((b, i) => {
      try { return parse(b, { weekday: { type: "int", required: true, min: 0, max: 6 }, startTime: { type: "time", required: true }, endTime: { type: "time", required: true } }); }
      catch (e) { throw invalid(`Invalid block at index ${i}`, e.details); }
    });
    for (const b of blocks) if (b.startTime >= b.endTime) throw invalid("startTime must be before endTime", { weekday: b.weekday });
    const sorted = [...blocks].sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime));
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].weekday === sorted[i - 1].weekday && toMin(sorted[i].startTime) < toMin(sorted[i - 1].endTime)) {
        throw invalid("Schedule blocks overlap on the same day", { weekday: sorted[i].weekday });
      }
    }
    tx(ctx.db, () => replaceSchedule(ctx.db, d.id, sorted));
    // Warn about already-booked future appointments that now fall outside working hours
    const today = clinicNow(ctx.config).date;
    const future = ctx.db.prepare(
      "SELECT id, reference, date, start_time, end_time FROM appointments WHERE dentist_id = ? AND date >= ? AND status IN ('pending','confirmed')",
    ).all(d.id, today);
    const affected = future.filter((a) => {
      const wd = new Date(`${a.date}T00:00:00Z`).getUTCDay();
      return !sorted.some((b) => b.weekday === wd && b.startTime <= a.start_time && b.endTime >= a.end_time);
    });
    return { weekly: dentistView(ctx.db, d).schedule, affectedAppointments: affected.map((a) => ({ id: a.id, reference: a.reference, date: a.date, startTime: a.start_time })) };
  });

  router.post("/api/dentists/:id/time-off", requireAuth, (ctx) => {
    const d = resolveDentist(ctx);
    assertCanManage(ctx, d);
    const data = parse(ctx.body, { date: { type: "date", required: true }, reason: { type: "string", max: 200 }, force: { type: "bool" } });
    if (data.date < clinicNow(ctx.config).date) throw invalid("Date is in the past", { date: "Choose today or later" });
    const booked = ctx.db.prepare("SELECT COUNT(*) AS n FROM appointments WHERE dentist_id = ? AND date = ? AND status IN ('pending','confirmed')").get(d.id, data.date).n;
    if (booked && !data.force) {
      throw conflict("has_appointments", `${booked} appointment(s) are already booked on this date. Resend with force:true to block the day anyway, then decline/reschedule them.`, { count: booked });
    }
    ctx.db.prepare("INSERT OR REPLACE INTO dentist_time_off (dentist_id, date, reason) VALUES (?,?,?)").run(d.id, data.date, data.reason ?? null);
    return created({ date: data.date, reason: data.reason ?? null, affectedAppointments: booked });
  });

  router.delete("/api/dentists/:id/time-off/:date", requireAuth, (ctx) => {
    const d = resolveDentist(ctx);
    assertCanManage(ctx, d);
    if (!isDate(ctx.params.date)) throw invalid("Invalid date");
    const r = ctx.db.prepare("DELETE FROM dentist_time_off WHERE dentist_id = ? AND date = ?").run(d.id, ctx.params.date);
    if (!r.changes) throw notFound("Time-off entry");
    return undefined;
  });
}
