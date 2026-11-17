import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { addDays, clinicNow } from "../src/lib/time.js";

let srv;
let base;

async function api(method, path, { token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  srv = createApp({
    dbPath: ":memory:",
    seedOnStart: true,
    demoMode: true,
    jwtSecret: "t".repeat(40),
    faceDescriptorKey: "a".repeat(64),
    payMongoSecretKey: "",
    notificationProvider: () => {},
    port: 0,
  });
  await new Promise((resolve) => srv.server.listen(0, resolve));
  base = `http://localhost:${srv.server.address().port}`;
});

after(async () => {
  await srv.close();
});

test("unpaid pending appointment can be released after checkout fails", async () => {
  const login = await api("POST", "/api/auth/demo-login", { body: { role: "patient" } });
  const token = login.body.token;
  const dentist = srv.app.db.prepare("SELECT id FROM dentists WHERE active = 1 ORDER BY id LIMIT 1").get();
  const service = srv.app.db.prepare("SELECT id FROM services WHERE active = 1 ORDER BY id LIMIT 1").get();
  const patient = srv.app.db.prepare("SELECT id FROM patients WHERE user_id = (SELECT id FROM users WHERE role = 'patient' ORDER BY id LIMIT 1)").get();
  const appointmentId = Number(srv.app.db.prepare(
    `INSERT INTO appointments
     (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status, source)
     VALUES (?, ?, ?, ?, '2099-01-02', '08:00', '09:00', 'pending', 'online_portal')`,
  ).run("SC-CHECKOUT-ABANDON", patient.id, dentist.id, service.id).lastInsertRowid);

  const cancelled = await api("POST", `/api/appointments/${appointmentId}/abandon-payment`, {
    token,
    body: {},
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
});

test("failed checkout can be followed by immediate slot release", async () => {
  const login = await api("POST", "/api/auth/demo-login", { body: { role: "patient" } });
  const token = login.body.token;
  const dentist = srv.app.db.prepare("SELECT id FROM dentists WHERE active = 1 ORDER BY id LIMIT 1").get();
  const service = srv.app.db.prepare("SELECT id FROM services WHERE active = 1 ORDER BY id LIMIT 1").get();
  const patient = srv.app.db.prepare("SELECT id FROM patients WHERE user_id = (SELECT id FROM users WHERE role = 'patient' ORDER BY id LIMIT 1)").get();
  const appointmentId = Number(srv.app.db.prepare(
    `INSERT INTO appointments
     (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status, source)
     VALUES (?, ?, ?, ?, '2099-01-03', '08:00', '09:00', 'pending', 'online_portal')`,
  ).run("SC-CHECKOUT-FAILED", patient.id, dentist.id, service.id).lastInsertRowid);

  const checkout = await api("POST", "/api/payments/checkout", {
    token,
    body: { appointmentId },
  });
  assert.equal(checkout.status, 503);

  const released = await api("POST", `/api/appointments/${appointmentId}/abandon-payment`, {
    token,
    body: {},
  });
  assert.equal(released.status, 200);
  assert.equal(released.body.status, "cancelled");
  assert.equal(released.body.statusReason, "payment_checkout_failed");
});

test("patient can cancel an unpaid pending appointment inside the normal cancellation window", async () => {
  const login = await api("POST", "/api/auth/demo-login", { body: { role: "patient" } });
  const token = login.body.token;
  const dentist = srv.app.db.prepare("SELECT id FROM dentists WHERE active = 1 ORDER BY id LIMIT 1").get();
  const service = srv.app.db.prepare("SELECT id FROM services WHERE active = 1 ORDER BY id LIMIT 1").get();
  const patient = srv.app.db.prepare("SELECT id FROM patients WHERE user_id = (SELECT id FROM users WHERE role = 'patient' ORDER BY id LIMIT 1)").get();
  const date = addDays(clinicNow(srv.app.config).date, 1);
  const appointmentId = Number(srv.app.db.prepare(
    `INSERT INTO appointments
     (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status, source)
     VALUES (?, ?, ?, ?, ?, '08:00', '09:00', 'pending', 'online_portal')`,
  ).run("SC-UNPAID-CANCEL", patient.id, dentist.id, service.id, date).lastInsertRowid);

  const cancelled = await api("PATCH", `/api/appointments/${appointmentId}/status`, {
    token,
    body: { status: "cancelled" },
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.status, "cancelled");
});

test("booking still returns the created appointment when notification delivery fails", async () => {
  const failing = createApp({
    dbPath: ":memory:",
    seedOnStart: true,
    demoMode: true,
    jwtSecret: "t".repeat(40),
    faceDescriptorKey: "a".repeat(64),
    payMongoSecretKey: "",
    notificationProvider: async () => {
      throw new Error("notification provider unavailable");
    },
    port: 0,
  });

  await new Promise((resolve) => failing.server.listen(0, resolve));
  const failingBase = `http://localhost:${failing.server.address().port}`;
  const request = async (method, path, options = {}) => {
    const response = await fetch(failingBase + path, {
      method,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const login = await request("POST", "/api/auth/demo-login", { body: { role: "patient" } });
    const dentist = failing.app.db.prepare("SELECT id FROM dentists WHERE active = 1 ORDER BY id LIMIT 1").get();
    const service = failing.app.db.prepare("SELECT id FROM services WHERE active = 1 ORDER BY id LIMIT 1").get();
    const date = addDays(clinicNow(failing.app.config).date, 2);
    const hold = await request("POST", "/api/slot-holds", {
      token: login.body.token,
      body: { serviceId: service.id, dentistId: dentist.id, date, startTime: "08:00" },
    });
    const booking = await request("POST", "/api/appointments", {
      token: login.body.token,
      body: { serviceId: service.id, dentistId: dentist.id, date, startTime: "08:00", holdId: hold.body.id },
    });
    assert.equal(booking.status, 201);
    assert.equal(booking.body.status, "pending");
  } finally {
    await failing.close();
  }
});

test("retrying the same slot releases the patient's orphaned unpaid appointment", async () => {
  const login = await api("POST", "/api/auth/demo-login", { body: { role: "patient" } });
  const token = login.body.token;
  const dentist = srv.app.db.prepare("SELECT id FROM dentists WHERE active = 1 ORDER BY id LIMIT 1").get();
  const service = srv.app.db.prepare("SELECT id FROM services WHERE active = 1 ORDER BY id LIMIT 1").get();
  const patient = srv.app.db.prepare("SELECT id FROM patients WHERE user_id = (SELECT id FROM users WHERE role = 'patient' ORDER BY id LIMIT 1)").get();
  const date = addDays(clinicNow(srv.app.config).date, 3);
  srv.app.db.prepare(
    `INSERT INTO appointments
     (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status, source)
     VALUES (?, ?, ?, ?, ?, '15:00', '16:00', 'pending', 'online_portal')`,
  ).run("SC-ORPHANED-RETRY", patient.id, dentist.id, service.id, date);

  const hold = await api("POST", "/api/slot-holds", {
    token,
    body: { serviceId: service.id, dentistId: dentist.id, date, startTime: "15:00" },
  });
  assert.equal(hold.status, 201);
  assert.equal(
    srv.app.db.prepare("SELECT COUNT(*) AS count FROM appointments WHERE reference = 'SC-ORPHANED-RETRY' AND status = 'pending'").get().count,
    0,
  );
});
