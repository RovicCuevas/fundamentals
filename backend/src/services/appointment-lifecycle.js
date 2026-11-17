import { tx } from "../db.js";
import { addDays, clinicNow } from "../lib/time.js";

const NO_SHOW_GRACE_MS = 24 * 60 * 60 * 1000;

function clinicDateTime(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

export function markOverdueAppointmentsNeedsAttention({ db, hub, config }) {
  const now = config.clock();
  const cutoff = clinicDateTime(new Date(now.getTime() - NO_SHOW_GRACE_MS), config.clinicTz);
  const rows = db.prepare(
    `SELECT id, reference, patient_id, dentist_id, date, start_time
     FROM appointments
     WHERE status = 'confirmed' AND datetime(date || ' ' || end_time) <= datetime(?)`,
  ).all(cutoff);

  for (const appointment of rows) {
    const payload = {
      id: appointment.id,
      reference: appointment.reference,
      status: "confirmed",
      needsAttention: true,
      date: appointment.date,
      startTime: appointment.start_time,
    };
    const patientUserId = db.prepare("SELECT user_id FROM patients WHERE id = ?").get(appointment.patient_id)?.user_id;
    const dentistUserId = db.prepare("SELECT user_id FROM dentists WHERE id = ?").get(appointment.dentist_id)?.user_id;
    if (patientUserId) hub.toUser(patientUserId, "appointment.updated", payload);
    if (dentistUserId) hub.toUser(dentistUserId, "appointment.updated", payload);
    hub.toRoles(["clerk", "admin"], "appointment.updated", payload);
  }
  return rows.length;
}

export function expireUnpaidPendingAppointments({ db, hub, config }) {
  const candidates = db.prepare(
    `SELECT a.id, a.reference, a.patient_id, a.dentist_id, a.date, a.start_time, a.created_at,
            pay.status AS payment_status
     FROM appointments a
     LEFT JOIN appointment_payments pay ON pay.appointment_id = a.id
     WHERE a.status = 'pending'
       AND (pay.status IS NULL OR pay.status NOT IN ('paid', 'expired'))`,
  ).all();
  const expired = candidates.filter((appointment) => {
    const createdAt = Date.parse(`${appointment.created_at.replace(" ", "T")}Z`);
    const ttlMin = appointment.payment_status === null ? config.slotHoldMin : config.pendingPaymentTtlMin;
    return Number.isFinite(createdAt) && createdAt <= config.clock().getTime() - ttlMin * 60_000;
  });

  if (!expired.length) return 0;
  tx(db, () => {
    for (const appointment of expired) {
      const changed = db.prepare(
        `UPDATE appointments
         SET status = 'cancelled', status_reason = 'payment_timeout', updated_at = datetime('now')
         WHERE id = ? AND status = 'pending'`,
      ).run(appointment.id);
      if (!changed.changes) continue;
      db.prepare(
        `UPDATE appointment_payments
         SET status = 'expired', updated_at = datetime('now')
         WHERE appointment_id = ? AND status NOT IN ('paid', 'expired')`,
      ).run(appointment.id);
      const payload = {
        id: appointment.id,
        reference: appointment.reference,
        status: "cancelled",
        statusReason: "payment_timeout",
        date: appointment.date,
        startTime: appointment.start_time,
      };
      const patientUserId = db.prepare("SELECT user_id FROM patients WHERE id = ?").get(appointment.patient_id)?.user_id;
      const dentistUserId = db.prepare("SELECT user_id FROM dentists WHERE id = ?").get(appointment.dentist_id)?.user_id;
      if (patientUserId) hub.toUser(patientUserId, "appointment.updated", payload);
      if (dentistUserId) hub.toUser(dentistUserId, "appointment.updated", payload);
      hub.toRoles(["clerk", "admin"], "appointment.updated", payload);
    }

  });
  return expired.length;
}

export async function sendAppointmentReminders({ db, notifier, config }) {
  const now = config.clock().getTime();
  const current = clinicNow(config);
  const rows = db.prepare(
    `SELECT a.id, a.reference, a.patient_id, a.date, a.start_time,
            p.user_id, u.notification_opt_out
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     JOIN users u ON u.id = p.user_id
     WHERE a.status = 'confirmed'
       AND a.date BETWEEN ? AND ?
       AND u.active = 1`,
  ).all(current.date, addDays(current.date, 2));
  let sent = 0;
  for (const appointment of rows) {
    if (appointment.notification_opt_out) continue;
    const appointmentTime = Date.parse(`${appointment.date}T${appointment.start_time}:00+08:00`);
    const hours = (appointmentTime - now) / 3_600_000;
    const reminder = Math.abs(hours - 24) <= 0.5 ? "reminder_24h" : Math.abs(hours - 2) <= (1 / 60) ? "reminder_2h" : null;
    if (!reminder) continue;
    if (await notifier.send({
      userId: appointment.user_id,
      appointmentId: appointment.id,
      template: reminder,
      dedupeKey: `appointment:${appointment.id}:${reminder}:email`,
      data: appointment,
    })) sent += 1;
  }
  return sent;
}
