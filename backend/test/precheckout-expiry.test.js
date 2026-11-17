import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { assertSlotBookable, getDaySlots } from "../src/services/scheduling.js";
import { addDays, clinicNow, weekdayOf } from "../src/lib/time.js";

const app = createApp({
  dbPath: ":memory:",
  seedOnStart: true,
  demoMode: true,
  jwtSecret: "t".repeat(40),
  faceDescriptorKey: "a".repeat(64),
  port: 0,
  bootstrapAdminEmail: "bootstrap-admin@example.test",
  bootstrapAdminPassword: "BootstrapAdmin123!",
  payMongoSecretKey: "",
  payMongoWebhookSecret: "whsec_mock",
  notificationProvider: () => {},
});

after(async () => {
  await app.close();
});

test("releases stale pre-checkout bookings after the slot hold window", () => {
  const db = app.app.db;
  const patientId = db.prepare("SELECT id FROM patients WHERE code = 'SC-98214'").get().id;
  const dentistId = db.prepare("SELECT d.id FROM dentists d JOIN users u ON u.id = d.user_id WHERE u.full_name LIKE '%Elena%'").get().id;
  const serviceId = db.prepare("SELECT id FROM services WHERE name LIKE 'Oral Prophylaxis%'").get().id;
  const createdAt = new Date(Date.now() - (app.app.config.slotHoldMin + 1) * 60_000).toISOString().slice(0, 19).replace("T", " ");
  const appointmentId = Number(db.prepare(
    `INSERT INTO appointments
     (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status, source, created_at)
     VALUES (?, ?, ?, ?, '2099-01-02', '08:00', '09:00', 'pending', 'online_portal', ?)`,
  ).run("SC-PRECHECKOUT", patientId, dentistId, serviceId, createdAt).lastInsertRowid);

  assert.equal(app.app.expireUnpaidPendingAppointments(), 1);
  const appointment = db.prepare("SELECT status, status_reason FROM appointments WHERE id = ?").get(appointmentId);
  assert.equal(appointment.status, "cancelled");
  assert.equal(appointment.status_reason, "payment_timeout");
});

test("availability releases stale pre-checkout bookings before the lifecycle timer runs", () => {
  const db = app.app.db;
  const patientId = db.prepare("SELECT id FROM patients WHERE code = 'SC-98214'").get().id;
  const dentistId = db.prepare("SELECT d.id FROM dentists d JOIN users u ON u.id = d.user_id WHERE u.full_name LIKE '%Elena%'").get().id;
  const serviceId = db.prepare("SELECT id FROM services WHERE name LIKE 'Oral Prophylaxis%'").get().id;
  const createdAt = new Date(Date.now() - (app.app.config.slotHoldMin + 1) * 60_000).toISOString().slice(0, 19).replace("T", " ");
  let date = addDays(clinicNow(app.app.config).date, 7);
  while (weekdayOf(date) !== 2) date = addDays(date, 1);
  db.prepare(
    `INSERT INTO appointments
     (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status, source, created_at)
     VALUES (?, ?, ?, ?, ?, '08:00', '09:00', 'pending', 'online_portal', ?)`,
  ).run("SC-PRECHECKOUT-AVAILABILITY", patientId, dentistId, serviceId, date, createdAt);

  const result = getDaySlots(app.app, { dentistId, date, durationMin: 60 });
  assert.equal(result.slots.find((slot) => slot.startTime === "08:00").available, true);
});

test("availability uses unique whole-hour slots inside non-aligned schedule blocks", () => {
  const db = app.app.db;
  const dentistId = db.prepare("SELECT id FROM dentists WHERE active = 1 ORDER BY id LIMIT 1").get().id;
  const date = addDays(clinicNow(app.app.config).date, 7);
  const weekday = weekdayOf(date);
  db.prepare("DELETE FROM dentist_schedules WHERE dentist_id = ? AND weekday = ?").run(dentistId, weekday);
  db.prepare("INSERT INTO dentist_schedules (dentist_id, weekday, start_time, end_time) VALUES (?, ?, ?, ?), (?, ?, ?, ?)")
    .run(dentistId, weekday, "08:30", "12:30", dentistId, weekday, "10:30", "14:30");

  const result = getDaySlots(app.app, { dentistId, date, durationMin: 15 });

  assert.deepEqual(result.slots.map((slot) => slot.startTime), ["09:00", "10:00", "11:00", "12:00", "13:00"]);
  assert.ok(result.slots.every((slot) => slot.endTime === `${String(Number(slot.startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`));
  assert.equal(assertSlotBookable(app.app, { dentistId, date, startTime: "09:00" }).endTime, "10:00");
  assert.throws(
    () => assertSlotBookable(app.app, { dentistId, date, startTime: "08:30" }),
    (error) => error.details?.startTime === "Not an offered time slot",
  );
});
