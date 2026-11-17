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
    ...overrides,
  });
  await new Promise((resolve) => app.server.listen(0, resolve));
  apps.push(app);
  return `http://localhost:${app.server.address().port}`;
}

async function api(base, method, path, { body, headers } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

after(async () => {
  await Promise.all(apps.map((app) => app.close()));
});

test("successful face logins do not consume the failure limit", async () => {
  const base = await startApp();
  const passwordLogin = await api(base, "POST", "/api/auth/login", {
    body: { email: "admin@smartcare.test", password: DEMO_PASSWORD },
  });
  const descriptor = Array.from({ length: 128 }, (_, index) => index / 1000);
  assert.equal((await api(base, "POST", "/api/auth/face-enroll", {
    headers: { Authorization: `Bearer ${passwordLogin.body.token}` },
    body: { descriptor, consent: true },
  })).status, 200);

  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await api(base, "POST", "/api/auth/face-login", {
      body: { descriptor },
    })).status, 200);
  }
});

test("existing face-login failure counters are updated without a duplicate conflict", async () => {
  const app = createApp({
    dbPath: ":memory:",
    seedOnStart: true,
    demoMode: true,
    jwtSecret: "t".repeat(40),
    faceDescriptorKey: "a".repeat(64),
  });
  apps.push(app);
  await new Promise((resolve) => app.server.listen(0, resolve));
  const base = `http://localhost:${app.server.address().port}`;
  const key = "face-ip|::1";
  app.app.db.prepare(
    "INSERT INTO rate_limit_counters (scope_key, failures, reset_at) VALUES (?, ?, ?)",
  ).run(key, 1, Date.now() + 60_000);

  const response = await api(base, "POST", "/api/auth/face-login", {
    body: { descriptor: Array.from({ length: 128 }, () => 0) },
  });

  assert.equal(response.status, 401);
  assert.equal(app.app.db.prepare("SELECT failures FROM rate_limit_counters WHERE scope_key = ?").get(key).failures, 2);
});

test("forwarded IP spoofing is ignored when TRUST_PROXY is zero", async () => {
  const base = await startApp({ trustProxy: 0 });
  const body = { email: "admin@smartcare.test", password: "wrong-password" };
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await api(base, "POST", "/api/auth/login", {
      headers: { "X-Forwarded-For": `198.51.100.${attempt}` },
      body,
    })).status, 401);
  }
  assert.equal((await api(base, "POST", "/api/auth/login", {
    headers: { "X-Forwarded-For": "198.51.100.250" },
    body,
  })).status, 429);
});

test("a failed-login IP cannot lock a different IP's account login", async () => {
  const base = await startApp({ trustProxy: 1 });
  const failedBody = { email: "admin@smartcare.test", password: "wrong-password" };
  for (let attempt = 0; attempt < 10; attempt++) {
    assert.equal((await api(base, "POST", "/api/auth/login", {
      headers: { "X-Forwarded-For": "198.51.100.10" },
      body: failedBody,
    })).status, 401);
  }
  const login = await api(base, "POST", "/api/auth/login", {
    headers: { "X-Forwarded-For": "198.51.100.11" },
    body: { email: "admin@smartcare.test", password: DEMO_PASSWORD },
  });
  assert.equal(login.status, 200);
});
