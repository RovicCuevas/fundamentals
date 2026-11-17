import { conflict, invalid, notFound } from "../lib/errors.js";
import { addDays, clinicNow, fromMin, overlaps, toMin, weekdayOf } from "../lib/time.js";

export const ACTIVE_STATUSES = ["pending", "confirmed"];
export const BOOKING_DURATION_MIN = 60;
const BOOKING_STEP_MIN = 60;
const MAX_BOOKING_ADVANCE_DAYS = 90;

function wholeHourStarts(blocks) {
  const starts = new Set();
  for (const block of blocks) {
    const start = Math.ceil(toMin(block.start_time) / BOOKING_STEP_MIN) * BOOKING_STEP_MIN;
    const end = toMin(block.end_time);
    for (let slotStart = start; slotStart + BOOKING_DURATION_MIN <= end; slotStart += BOOKING_STEP_MIN) {
      starts.add(slotStart);
    }
  }
  return [...starts].sort((a, b) => a - b);
}

export function expireStalePendingAppointments(db, config) {
  const candidates = db.prepare(
    `SELECT a.id, a.created_at, pay.status AS payment_status
     FROM appointments a
     LEFT JOIN appointment_payments pay ON pay.appointment_id = a.id
     WHERE a.status = 'pending'
       AND (pay.status IS NULL OR pay.status NOT IN ('paid', 'expired'))`,
  ).all();
  for (const appointment of candidates) {
    const createdAt = Date.parse(`${appointment.created_at.replace(" ", "T")}Z`);
    const ttlMin = appointment.payment_status === null ? config.slotHoldMin : config.pendingPaymentTtlMin;
    if (Number.isFinite(createdAt) && createdAt <= config.clock().getTime() - ttlMin * 60_000) {
      db.prepare(
        `UPDATE appointments
         SET status = 'cancelled', status_reason = 'payment_timeout', updated_at = datetime('now')
         WHERE id = ? AND status = 'pending'`,
      ).run(appointment.id);
    }
  }
}

export function purgeExpiredHolds(db, config) {
  db.prepare("DELETE FROM slot_holds WHERE expires_at <= ?").run(config.clock().getTime());
}

export function getDentistOrThrow(db, dentistId) {
  const d = db.prepare("SELECT * FROM dentists WHERE id = ? AND active = 1").get(dentistId);
  if (!d) throw notFound("Dentist");
  return d;
}
export function getServiceOrThrow(db, serviceId) {
  const s = db.prepare("SELECT * FROM services WHERE id = ? AND active = 1").get(serviceId);
  if (!s) throw notFound("Service");
  return s;
}

export function assertServiceDentist(db, service, dentistId) {
  if (!/ortho|braces/i.test(`${service.name} ${service.category}`)) return;
  const dentist = db.prepare(
    "SELECT u.full_name FROM dentists d JOIN users u ON u.id = d.user_id WHERE d.id = ? AND d.active = 1",
  ).get(dentistId);
  if (!dentist || !/petil/i.test(dentist.full_name)) {
    throw invalid("Orthodontic and braces services are only available with Doc Petil", {
      dentistId: "Choose Doc Petil for this service",
    });
  }
}

/** 
 * Bookable start times are reserved in one-hour blocks, regardless of procedure duration.
 * Booked / held / past slots are returned with available:false so the UI can render them disabled.
 */
export function getDaySlots(app, { dentistId, date, durationMin, holdOwnerUserId = 0, ignoreApptId = 0 }) {
  const { db, config } = app;
  expireStalePendingAppointments(db, config);
  purgeExpiredHolds(db, config);
  const now = clinicNow(config);

  if (date > addDays(now.date, Math.min(config.maxAdvanceDays, MAX_BOOKING_ADVANCE_DAYS))) {
    return { slots: [], dayStatus: "outside_booking_window" };
  }

  const blocks = db
    .prepare("SELECT start_time, end_time FROM dentist_schedules WHERE dentist_id = ? AND weekday = ? ORDER BY start_time")
    .all(dentistId, weekdayOf(date));
  const timeOff = db.prepare("SELECT reason FROM dentist_time_off WHERE dentist_id = ? AND date = ?").get(dentistId, date);
  if (timeOff) return { slots: [], dayStatus: "time_off", reason: timeOff.reason ?? null };
  if (!blocks.length) return { slots: [], dayStatus: "closed" };

  const busy = [
    ...db.prepare(
      `SELECT start_time, end_time FROM appointments
       WHERE dentist_id = ? AND date = ? AND status IN ('pending','confirmed') AND id != ?`,
    ).all(dentistId, date, ignoreApptId),
    ...db.prepare(
      `SELECT start_time, end_time FROM slot_holds
       WHERE dentist_id = ? AND date = ? AND expires_at > ? AND user_id != ?`,
    ).all(dentistId, date, config.clock().getTime(), holdOwnerUserId),
  ].map((b) => [toMin(b.start_time), toMin(b.end_time)]);

  const nowMin = toMin(now.time);
  const slots = [];
  for (const s of wholeHourStarts(blocks)) {
    const e = s + BOOKING_DURATION_MIN;
    let available = true;
    let reason;
    if (date < now.date || (date === now.date && s < nowMin + config.minLeadMin)) {
      available = false; reason = "past";
    } else if (busy.some(([bS, bE]) => overlaps(s, e, bS, bE))) {
      available = false; reason = "booked";
    }
    slots.push({ startTime: fromMin(s), endTime: fromMin(e), available, ...(reason ? { reason } : {}) });
  }
  return { slots, dayStatus: "open" };
}

export function getMonthAvailability(app, { dentistId, month, holdOwnerUserId = 0 }) {
  const { db, config } = app;
  expireStalePendingAppointments(db, config);
  const firstDate = `${month}-01`;
  const dates = [];
  for (let date = firstDate; date.startsWith(month); date = addDays(date, 1)) dates.push(date);
  const lastDate = dates.at(-1);
  const now = clinicNow(config);
  const bookingLimit = addDays(now.date, Math.min(config.maxAdvanceDays, MAX_BOOKING_ADVANCE_DAYS));

  const scheduleRows = db.prepare(
    "SELECT weekday, start_time, end_time FROM dentist_schedules WHERE dentist_id = ? ORDER BY weekday, start_time",
  ).all(dentistId);
  const schedules = new Map();
  for (const row of scheduleRows) {
    if (!schedules.has(row.weekday)) schedules.set(row.weekday, []);
    schedules.get(row.weekday).push(row);
  }

  const timeOffRows = db.prepare(
    "SELECT date FROM dentist_time_off WHERE dentist_id = ? AND date >= ? AND date <= ?",
  ).all(dentistId, firstDate, lastDate);
  const timeOff = new Set(timeOffRows.map((row) => row.date));

  const bookedRows = db.prepare(
    `SELECT date, start_time, end_time FROM appointments
     WHERE dentist_id = ? AND date >= ? AND date <= ? AND status IN ('pending','confirmed')
     UNION ALL
     SELECT date, start_time, end_time FROM slot_holds
     WHERE dentist_id = ? AND date >= ? AND date <= ? AND expires_at > ? AND user_id != ?`,
  ).all(
    dentistId, firstDate, lastDate,
    dentistId, firstDate, lastDate, config.clock().getTime(), holdOwnerUserId,
  );
  const busyByDate = new Map();
  for (const row of bookedRows) {
    if (!busyByDate.has(row.date)) busyByDate.set(row.date, []);
    busyByDate.get(row.date).push([toMin(row.start_time), toMin(row.end_time)]);
  }

  return dates.map((date) => {
    if (date > bookingLimit) return { date, dayStatus: "outside_booking_window", availableSlots: 0 };
    if (timeOff.has(date)) return { date, dayStatus: "time_off", availableSlots: 0 };
    const blocks = schedules.get(weekdayOf(date)) ?? [];
    if (!blocks.length) return { date, dayStatus: "closed", availableSlots: 0 };

    let availableSlots = 0;
    const busy = busyByDate.get(date) ?? [];
    const nowMin = toMin(now.time);
    for (const slotStart of wholeHourStarts(blocks)) {
      const slotEnd = slotStart + BOOKING_DURATION_MIN;
      const isPast = date < now.date || (date === now.date && slotStart < nowMin + config.minLeadMin);
      if (!isPast && !busy.some(([busyStart, busyEnd]) => overlaps(slotStart, slotEnd, busyStart, busyEnd))) {
        availableSlots++;
      }
    }
    return { date, dayStatus: "open", availableSlots };
  });
}

export function assertWithinBookingWindow(app, date) {
  const now = clinicNow(app.config);
  if (date < now.date) throw invalid("Date is in the past", { date: "Choose today or a future date" });
  const maxAdvanceDays = Math.min(app.config.maxAdvanceDays, MAX_BOOKING_ADVANCE_DAYS);
  if (date > addDays(now.date, maxAdvanceDays)) {
    throw invalid("Date is too far ahead", { date: `Bookings open up to ${maxAdvanceDays} days in advance` });
  }
}

/** Throws a descriptive error unless `startTime` is a free slot. Returns the slot. */
export function assertSlotBookable(app, { dentistId, date, startTime, holdOwnerUserId = 0, ignoreApptId = 0 }) {
  assertWithinBookingWindow(app, date);
  const { slots, dayStatus, reason } = getDaySlots(app, { dentistId, date, durationMin: BOOKING_DURATION_MIN, holdOwnerUserId, ignoreApptId });
  if (dayStatus === "time_off") throw conflict("dentist_unavailable", "The dentist is not available on this date", { reason });
  const slot = slots.find((s) => s.startTime === startTime);
  if (!slot) throw invalid("That time is outside the dentist's working hours for this service", { startTime: "Not an offered time slot" });
  if (!slot.available) {
    throw conflict(
      slot.reason === "past" ? "slot_in_past" : "slot_unavailable",
      slot.reason === "past" ? "That time has already passed or is too soon to book" : "That time slot was just taken. Please pick another.",
    );
  }
  return slot;
}

export function assertPatientFree(db, { patientId, date, startTime, endTime, ignoreApptId = 0 }) {
  const rows = db.prepare(
    `SELECT start_time, end_time FROM appointments
     WHERE patient_id = ? AND date = ? AND status IN ('pending','confirmed') AND id != ?`,
  ).all(patientId, date, ignoreApptId);
  if (rows.some((r) => overlaps(toMin(startTime), toMin(endTime), toMin(r.start_time), toMin(r.end_time)))) {
    throw conflict("patient_double_booked", "This patient already has an appointment at that time");
  }
}
