import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
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

let base;

async function request(method, path, token, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function futureWorkday() {
  let date = addDays(clinicNow(app.app.config).date, 7);
  while (![2, 3, 4, 5].includes(weekdayOf(date))) date = addDays(date, 1);
  return date;
}

await new Promise((resolve) => app.server.listen(0, resolve));
base = `http://localhost:${app.server.address().port}`;

after(async () => {
  await app.close();
});

test("reschedule slot holds can ignore the appointment being moved", async () => {
  const login = await fetch(`${base}/api/auth/demo-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: "patient" }),
  });
  const { token } = await login.json();
  const dentist = app.app.db.prepare("SELECT id FROM dentists WHERE active = 1 ORDER BY id LIMIT 1").get();
  const service = app.app.db.prepare("SELECT id FROM services WHERE active = 1 ORDER BY id LIMIT 1").get();
  const date = futureWorkday();
  const booking = await request("POST", "/api/appointments", token, {
    serviceId: service.id,
    dentistId: dentist.id,
    date,
    startTime: "14:00",
  });
  assert.equal(booking.status, 201);
  app.app.db.prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ?").run(booking.body.id);

  const hold = await request("POST", "/api/slot-holds", token, {
    serviceId: service.id,
    dentistId: dentist.id,
    date,
    startTime: "14:00",
    ignoreApptId: booking.body.id,
  });
  assert.equal(hold.status, 201, JSON.stringify(hold.body));
});
