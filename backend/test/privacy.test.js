import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { DEMO_PASSWORD } from "../src/seed.js";

const apps = [];

async function startApp(overrides = {}) {
  const app = createApp({
    dbPath: ":memory:",
    seedOnStart: true,
    demoMode: true,
    jwtSecret: "t".repeat(40),
    faceDescriptorKey: "a".repeat(64),
    clock: () => new Date("2026-11-06T08:00:00+08:00"),
    ...overrides,
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  apps.push(app);
  return `http://localhost:${app.server.address().port}`;
}

async function api(base, method, path, { token, body, headers } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

test("time-off reasons are private to admins", async () => {
  const base = await startApp();
  const adminLogin = await api(base, "POST", "/api/auth/login", {
    body: { email: "admin@smartcare.test", password: DEMO_PASSWORD },
  });
  const dentistId = (await api(base, "GET", "/api/dentists/me/schedule", { token: adminLogin.body.token })).body.dentistId;
  const date = "2026-11-13";
  assert.equal((await api(base, "POST", "/api/dentists/me/time-off", {
    token: adminLogin.body.token,
    body: { date, reason: "Private staff meeting" },
  })).status, 201);

  const publicSchedule = await api(base, "GET", `/api/dentists/${dentistId}/schedule`);
  assert.equal(publicSchedule.status, 200);
  assert.equal(publicSchedule.body.timeOff[0].reason, "Unavailable");

  const patient = await api(base, "POST", "/api/auth/demo-login", { body: { role: "patient" } });
  const patientSchedule = await api(base, "GET", `/api/dentists/${dentistId}/schedule`, { token: patient.body.token });
  assert.equal(patientSchedule.body.timeOff[0].reason, "Unavailable");

  const adminSchedule = await api(base, "GET", `/api/dentists/${dentistId}/schedule`, { token: adminLogin.body.token });
  assert.equal(adminSchedule.body.timeOff[0].reason, "Private staff meeting");

  const service = (await api(base, "GET", "/api/services")).body.items[0];
  const publicAvailability = await api(
    base,
    "GET",
    `/api/dentists/${dentistId}/availability?date=${date}&serviceId=${service.id}`,
  );
  assert.equal(publicAvailability.body.reason, "Unavailable");
  assert.equal(publicAvailability.body.dayStatus, "time_off");
});

test("public catalog SSE enforces per-IP and global caps and cleans up", async () => {
  const base = await startApp({ trustProxy: 1, publicSseMaxConnections: 2, publicSseMaxPerIp: 1 });
  const controllers = [];
  const open = async (ip) => {
    const controller = new AbortController();
    controllers.push(controller);
    const response = await fetch(`${base}/api/catalog/stream`, {
      headers: { "X-Forwarded-For": ip },
      signal: controller.signal,
    });
    return response;
  };

  const first = await open("198.51.100.10");
  assert.equal(first.status, 200);
  assert.equal((await open("198.51.100.10")).status, 503);
  const second = await open("198.51.100.11");
  assert.equal(second.status, 200);
  assert.equal((await open("198.51.100.12")).status, 503);

  controllers[0].abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await open("198.51.100.12")).status, 200);
  for (const controller of controllers) controller.abort();
});
