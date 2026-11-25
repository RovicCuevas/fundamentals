import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createNotifier } from "../src/services/notifier.js";
import { addDays, clinicNow, weekdayOf } from "../src/lib/time.js";
import { signToken } from "../src/lib/security.js";
import { createHmac } from "node:crypto";
import { DEMO_PASSWORD } from "../src/seed.js";
import { encryptFaceDescriptor } from "../src/lib/face-descriptors.js";

let srv, base;
let paymentProviderStatus = "active";
const notifications = [];
const nativeFetch = globalThis.fetch;
const tzCfg = { clinicTz: "Asia/Manila", clock: () => new Date() };

async function api(method, path, { token, body, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}
const demo = async (role) => (await api("POST", "/api/auth/demo-login", { body: { role } })).body.token;
const errCode = (r) => r.body?.error?.code;

// a Tue-Fri at least a week ahead: both dentists work these days
function futureWorkday(minAhead = 7) {
  let d = addDays(clinicNow(tzCfg).date, minAhead);
  while (![2, 3, 4, 5].includes(weekdayOf(d))) d = addDays(d, 1);
  return d;
}

before(async () => {
  srv = createApp({
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
    notificationProvider: (message) => notifications.push(message),
  });
  await new Promise((r) => srv.server.listen(0, r));
  base = `http://localhost:${srv.server.address().port}`;
});
after(async () => {
  globalThis.fetch = nativeFetch;
  await srv.close();
});

describe("auth & access control", () => {
  test("health + unauthenticated access", async () => {
    assert.equal((await api("GET", "/api/health")).status, 200);
    assert.equal((await api("GET", "/api/auth/me")).status, 401);
    assert.equal((await api("GET", "/api/appointments")).status, 401);
    assert.equal((await api("GET", "/api/nope")).status, 404);
    assert.equal((await api("DELETE", "/api/health")).status, 405);
  });

  test("admin can update its own profile name and picture", async () => {
    const admin = await demo("admin");
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const updated = await api("PATCH", "/api/auth/profile", {
      token: admin,
      body: { fullName: "Dr. Admin Profile", imageBase64: tinyPng, contentType: "image/png" },
    });

    assert.equal(updated.status, 200);
    assert.equal(updated.body.fullName, "Dr. Admin Profile");
    assert.match(updated.body.profileImageUrl, /^\/api\/auth\/profile\/image\?v=/);

    const session = await api("GET", "/api/auth/me", { token: admin });
    assert.equal(session.body.user.fullName, "Dr. Admin Profile");
    assert.match(session.body.user.profileImageUrl, /^\/api\/auth\/profile\/image\?v=/);
    const patient = await demo("patient");
    assert.equal((await api("PATCH", "/api/auth/profile", {
      token: patient,
      body: { fullName: "Not Allowed" },
    })).status, 403);

    const image = await fetch(`${base}/api/auth/profile/image`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await image.arrayBuffer()).toString("base64"), tinyPng);
  });


  describe("notifications", () => {
    test("booking writes one console notification log entry", async () => {
      const registration = await api("POST", "/api/auth/register", {
        body: {
          fullName: "Notification Patient",
          email: "notification.patient@example.test",
          password: "Passw0rdOK",
          phone: "09175550123",
          consent: true,
        },
      });

      test("forgot password resets once, invalidates the old session, and verifies email", async () => {
        const email = "reset-flow@example.test";
        const registered = await api("POST", "/api/auth/register", {
          body: { fullName: "Reset Flow", email, password: "Passw0rdOK", phone: "09175550124", consent: true },
        });
        assert.equal(registered.status, 201);
        const oldToken = registered.body.token;
        const unknown = await api("POST", "/api/auth/forgot-password", { body: { email: "missing-reset@example.test" } });
        const known = await api("POST", "/api/auth/forgot-password", { body: { email } });
        assert.equal(known.status, unknown.status);
        assert.deepEqual(known.body, unknown.body);
        const resetMessage = notifications.at(-1);
        const resetToken = new URL(resetMessage.body.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
        assert.ok(resetToken);
        const reset = await api("POST", "/api/auth/reset-password", {
          body: { token: resetToken, newPassword: "NewPassw0rdOK" },
        });
        assert.equal(reset.status, 200);
        assert.equal((await api("GET", "/api/auth/me", { token: oldToken })).status, 401);
        assert.equal((await api("POST", "/api/auth/reset-password", {
          body: { token: resetToken, newPassword: "AnotherPassw0rdOK" },
        })).status, 422);
        assert.equal((await api("POST", "/api/auth/login", {
          body: { email, password: "NewPassw0rdOK" },
        })).status, 200);

        const verificationMessage = notifications.find((message) => message.subject === "Verify your SmartCare email" && message.recipient === email);
        const verificationToken = new URL(verificationMessage.body.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
        assert.equal((await api("POST", "/api/auth/verify-email", { body: { token: verificationToken } })).status, 200);
        assert.ok(srv.app.db.prepare("SELECT email_verified_at FROM users WHERE email = ?").get(email).email_verified_at);
      });
      const service = srv.app.db.prepare("SELECT id FROM services WHERE active = 1 ORDER BY id LIMIT 1").get();
      const dentist = srv.app.db.prepare("SELECT id FROM dentists WHERE active = 1 ORDER BY id LIMIT 1").get();
      const date = futureWorkday(60);
      const booking = await api("POST", "/api/appointments", {
        token: registration.body.token,
        body: { serviceId: service.id, dentistId: dentist.id, date, startTime: "15:00" },
      });
      assert.equal(booking.status, 201);
      const first = srv.app.db.prepare(
        "SELECT template, channel, status, dedupe_key FROM notification_log WHERE appointment_id = ?",
      ).all(booking.body.id);
      assert.equal(first.length, 1);
      assert.equal(first[0].template, "booking_received");
      assert.equal(first[0].channel, "email");
      assert.equal(first[0].status, "sent");
      assert.equal(first[0].dedupe_key, `appointment:${booking.body.id}:booking_received:email`);
    });

    test("appointment reminders are idempotent and honor opt-out", async () => {
      const appointment = srv.app.db.prepare("SELECT id, patient_id, date, start_time FROM appointments WHERE reference = 'SC-DEMO01'").get();
      const user = srv.app.db.prepare("SELECT user_id FROM patients WHERE id = ?").get(appointment.patient_id);
      const originalClock = srv.app.config.clock;
      srv.app.config.clock = () => new Date(Date.parse(`${appointment.date}T${appointment.start_time}:00+08:00`) - 24 * 60 * 60_000);
      srv.app.db.prepare("DELETE FROM notification_log WHERE appointment_id = ? AND template = 'reminder_24h'").run(appointment.id);
      srv.app.db.prepare("UPDATE users SET notification_opt_out = 0 WHERE id = ?").run(user.user_id);
      assert.equal(await srv.app.sendAppointmentReminders(), 1);
      assert.equal(await srv.app.sendAppointmentReminders(), 0);
      srv.app.db.prepare("DELETE FROM notification_log WHERE appointment_id = ? AND template = 'reminder_24h'").run(appointment.id);
      srv.app.db.prepare("UPDATE users SET notification_opt_out = 1 WHERE id = ?").run(user.user_id);
      assert.equal(await srv.app.sendAppointmentReminders(), 0);
      srv.app.db.prepare("UPDATE users SET notification_opt_out = 0 WHERE id = ?").run(user.user_id);
      srv.app.config.clock = originalClock;
    });

    test("Brevo API provider sends the configured message without logging its body", async () => {
      const calls = [];
      const originalFetch = globalThis.fetch;
      const originalInfo = console.info;
      const infoCalls = [];
      console.info = (...args) => infoCalls.push(args);
      globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ messageId: "test-message-id" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      };
      try {
        const config = loadConfig({
          jwtSecret: "t".repeat(40),
          faceDescriptorKey: "a".repeat(64),
          notificationProvider: "brevo-api",
          brevoApiKey: "  test-key \t",
          notificationFromEmail: "sender@example.test",
          notificationFromName: "SmartCare Dental Clinic",
        });
        const notifier = createNotifier({ db: srv.app.db, config });
        const user = srv.app.db.prepare("SELECT id FROM users WHERE email = ?").get("maria.santos@smartcare.test");
        assert.equal(await notifier.send({
          userId: user.id,
          template: "booking_received",
          dedupeKey: "brevo-api-test",
          data: { reference: "SC-TEST", date: "2026-12-01", startTime: "10:00" },
        }), true);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].url, "https://api.brevo.com/v3/smtp/email");
        assert.equal(calls[0].init.headers["api-key"], "test-key");
        assert.equal(JSON.parse(calls[0].init.body).sender.email, "sender@example.test");
        const brevoResponseLog = infoCalls.find(([label]) => label === "[brevo] response");
        assert.deepEqual(brevoResponseLog?.[1], {
          status: 201,
          ok: true,
          body: JSON.stringify({ messageId: "test-message-id" }),
        });
      } finally {
        globalThis.fetch = originalFetch;
        console.info = originalInfo;
      }
    });

    test("Brevo API failures preserve safe provider diagnostics without secrets", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async () => new Response(
        JSON.stringify({ code: "unauthorized", message: "Invalid API key" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
      try {
        const config = loadConfig({
          jwtSecret: "t".repeat(40),
          faceDescriptorKey: "a".repeat(64),
          notificationProvider: "brevo-api",
          brevoApiKey: "secret-test-key",
          notificationFromEmail: "sender@example.test",
        });
        const notifier = createNotifier({ db: srv.app.db, config });
        const user = srv.app.db.prepare("SELECT id FROM users WHERE email = ?").get("maria.santos@smartcare.test");
        await assert.rejects(
          () => notifier.send({
            userId: user.id,
            template: "appointment_rescheduled",
            dedupeKey: "brevo-error-test",
            data: { reference: "SC-ERROR", date: "2026-12-01", startTime: "10:00" },
          }),
          (error) => {
            assert.match(error.message, /HTTP 401/);
            assert.match(error.message, /Invalid API key/);
            assert.doesNotMatch(error.message, /secret-test-key/);
            assert.doesNotMatch(error.message, /SC-ERROR/);
            return true;
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("Brevo API times out safely without leaking request data", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (_url, init) => {
        await new Promise((resolve) => {
          init.signal.addEventListener("abort", resolve, { once: true });
        });
        const abort = new Error("This operation was aborted");
        abort.name = "AbortError";
        throw abort;
      };
      try {
        const config = loadConfig({
          jwtSecret: "t".repeat(40),
          faceDescriptorKey: "a".repeat(64),
          notificationProvider: "brevo-api",
          brevoApiKey: "secret-test-key",
          notificationFromEmail: "sender@example.test",
        });
        config.brevoTimeoutMs = 10;
        const notifier = createNotifier({ db: srv.app.db, config });
        const user = srv.app.db.prepare("SELECT id FROM users WHERE email = ?").get("maria.santos@smartcare.test");
        await assert.rejects(
          () => notifier.send({
            userId: user.id,
            template: "appointment_rescheduled",
            dedupeKey: "brevo-timeout-test",
            data: { reference: "SC-TIMEOUT", date: "2026-12-01", startTime: "10:00" },
          }),
          (error) => {
            assert.match(error.message, /timed out/i);
            assert.doesNotMatch(error.message, /secret-test-key/);
            assert.doesNotMatch(error.message, /SC-TIMEOUT/);
            return true;
          },
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    test("failed notification delivery can be retried", async () => {
      const user = srv.app.db.prepare("SELECT id FROM users WHERE email = ?").get("maria.santos@smartcare.test");
      let attempts = 0;
      const notifier = createNotifier({
        db: srv.app.db,
        provider: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error("temporary Brevo failure");
        },
      });
      await assert.rejects(() => notifier.send({
        userId: user.id,
        template: "booking_received",
        dedupeKey: "retry-notification-test",
        data: { reference: "SC-RETRY", date: "2026-12-01", startTime: "10:00" },
      }));
      assert.equal(await notifier.send({
        userId: user.id,
        template: "booking_received",
        dedupeKey: "retry-notification-test",
        data: { reference: "SC-RETRY", date: "2026-12-01", startTime: "10:00" },
      }), true);
      assert.equal(attempts, 2);
      assert.equal(
        srv.app.db.prepare("SELECT status FROM notification_log WHERE dedupe_key = ?").get("retry-notification-test").status,
        "sent",
      );
    });

    test("authenticated users can list their own notifications", async () => {
      const patient = await demo("patient");
      const response = await api("GET", "/api/notifications", { token: patient });
      assert.equal(response.status, 200);
      assert.ok(Array.isArray(response.body.notifications));
    });
  });

  test("register validates, creates patient profile, blocks duplicates", async () => {
    const bad = await api("POST", "/api/auth/register", { body: { fullName: "A", email: "nope", password: "short", phone: "123" } });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.error.details.email && bad.body.error.details.password && bad.body.error.details.phone && bad.body.error.details.consent);

    const missingConsent = await api("POST", "/api/auth/register", { body: { fullName: "Pedro Penduko", email: "pedro-no-consent@example.com", password: "Passw0rdOK", phone: "0917 555 1234", consent: false } });
    assert.equal(missingConsent.status, 422);
    assert.equal(missingConsent.body.error.code, "consent_required");

    const ok = await api("POST", "/api/auth/register", { body: { fullName: "Pedro Penduko", email: "Pedro@Example.com", password: "Passw0rdOK", phone: "0917 555 1234", consent: true } });
    assert.equal(ok.status, 201);
    assert.match(ok.body.user.patientCode, /^SC-\d{5}$/);
    assert.match(ok.headers.get("set-cookie"), /HttpOnly/);
    const consent = srv.app.db.prepare("SELECT consent_at, consent_policy_version FROM users WHERE email = ?").get("pedro@example.com");
    assert.ok(consent.consent_at);
    assert.equal(consent.consent_policy_version, "2026-11-04");

    const dup = await api("POST", "/api/auth/register", { body: { fullName: "Pedro Two", email: "pedro@example.com", password: "Passw0rdOK", phone: "0917 555 1234", consent: true } });
    assert.equal(dup.status, 409);

    const login = await api("POST", "/api/auth/login", { body: { email: "pedro@example.com", password: "Passw0rdOK" } });
    assert.equal(login.status, 200);
    const me = await api("GET", "/api/auth/me", { token: login.body.token });
    assert.equal(me.body.user.role, "patient");
  });

  test("patient and dentist-administrator accounts use password login", async () => {
    const login = await api("POST", "/api/auth/login", {
      body: { email: "admin@smartcare.test", password: DEMO_PASSWORD },
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, "admin");
    assert.ok(login.body.user.dentistId);
    assert.equal((await api("GET", "/api/dentists/me", { token: login.body.token })).status, 200);

    for (const email of ["clerk@smartcare.test"]) {
      const staffLogin = await api("POST", "/api/auth/login", {
        body: { email, password: DEMO_PASSWORD },
      });
      assert.equal(staffLogin.status, 401);
    }

    const configuredAdmin = await api("POST", "/api/auth/login", {
      body: { email: "bootstrap-admin@example.test", password: "BootstrapAdmin123!" },
    });
    assert.equal(configuredAdmin.status, 200);
    assert.equal(configuredAdmin.body.user.role, "admin");

    const dentistLogin = await api("POST", "/api/auth/login", {
      body: { email: "doc.petil@smartcare.test", password: DEMO_PASSWORD },
    });
    assert.equal(dentistLogin.status, 401);
    assert.equal((await api("POST", "/api/auth/demo-login", { body: { role: "dentist" } })).status, 422);
    const oldDentistSession = signToken(
      { sub: srv.app.db.prepare("SELECT id FROM users WHERE role = 'dentist' LIMIT 1").get().id, role: "dentist" },
      srv.app.config.jwtSecret,
      60,
    );
    assert.equal((await api("GET", "/api/auth/me", { token: oldDentistSession })).status, 401);
  });

  test("face login requires an enrolled descriptor and issues a session", async () => {
    const adminLogin = await api("POST", "/api/auth/login", {
      body: { email: "admin@smartcare.test", password: DEMO_PASSWORD },
    });
    const adminDescriptor = Array.from({ length: 128 }, (_, index) => index / 1000);
    const enrolled = await api("POST", "/api/auth/face-enroll", {
      token: adminLogin.body.token,
      body: { descriptor: adminDescriptor, consent: true },
    });
    assert.equal(enrolled.status, 200);
    assert.equal(enrolled.body.success, true);

    const faceLogin = await api("POST", "/api/auth/face-login", {
      body: { descriptor: adminDescriptor },
    });
    assert.equal(faceLogin.status, 200);
    assert.equal(faceLogin.body.role, "admin");
    assert.equal(faceLogin.body.redirectUrl, "/admin");
    assert.equal(typeof faceLogin.body.token, "string");
    assert.match(faceLogin.headers.get("set-cookie"), /HttpOnly/);
    assert.equal(
      (await api("GET", "/api/auth/me", { token: faceLogin.body.token })).status,
      200,
    );
    const storedAdminBiometrics = srv.app.db.prepare(
      "SELECT face_descriptor, face_descriptor_consent_at FROM users WHERE email = ?",
    ).get("admin@smartcare.test");
    assert.match(storedAdminBiometrics.face_descriptor, /^v1\./);
    assert.notEqual(storedAdminBiometrics.face_descriptor, JSON.stringify(adminDescriptor));
    assert.ok(storedAdminBiometrics.face_descriptor_consent_at);

    const insideThreshold = [...adminDescriptor];
    insideThreshold[0] += 0.59;
    assert.equal((await api("POST", "/api/auth/face-login", {
      body: { descriptor: insideThreshold },
    })).body.role, "admin");
    const atThreshold = [...adminDescriptor];
    atThreshold[0] += 0.6;
    assert.equal((await api("POST", "/api/auth/face-login", {
      body: { descriptor: atThreshold },
    })).status, 401);

    const patientLogin = await api("POST", "/api/auth/login", {
      body: { email: "maria.santos@smartcare.test", password: DEMO_PASSWORD },
    });
    const patientDescriptor = Array.from({ length: 128 }, (_, index) =>
      index % 2 === 0 ? -0.1 : 0.1,
    );
    assert.equal((await api("POST", "/api/auth/face-enroll", {
      token: patientLogin.body.token,
      body: { descriptor: patientDescriptor, consent: true },
    })).status, 200);
    const patientFaceLogin = await api("POST", "/api/auth/face-login", {
      body: { descriptor: patientDescriptor },
    });
    assert.equal(patientFaceLogin.body.role, "patient");
    assert.equal(patientFaceLogin.body.redirectUrl, "/patient/book");

    const unrecognized = await api("POST", "/api/auth/face-login", {
      body: { descriptor: Array(128).fill(0.8) },
    });
    assert.equal(unrecognized.status, 401);
    assert.equal(errCode(unrecognized), "unauthorized");

    const invalid = await api("POST", "/api/auth/face-login", { body: { descriptor: [0] } });
    assert.equal(invalid.status, 422);

    const noConsent = await api("POST", "/api/auth/face-enroll", {
      token: patientLogin.body.token,
      body: { descriptor: patientDescriptor, consent: false },
    });
    assert.equal(noConsent.status, 422);

    assert.equal((await api("DELETE", "/api/auth/face-enroll", {
      token: patientLogin.body.token,
    })).status, 200);
    const removedConsent = srv.app.db.prepare(
      "SELECT face_descriptor, face_descriptor_consent_at FROM users WHERE email = ?",
    ).get("maria.santos@smartcare.test");
    assert.equal(removedConsent.face_descriptor, null);
    assert.equal(removedConsent.face_descriptor_consent_at, null);
    assert.equal((await api("POST", "/api/auth/face-login", {
      body: { descriptor: patientDescriptor },
    })).status, 401);
  });

  test("wrong password -> 401, repeated failures -> 429", async () => {
    const attempt = () => api("POST", "/api/auth/login", { body: { email: "ghost@example.com", password: "whatever1" } });
    assert.equal((await attempt()).status, 401);
    let last; for (let i = 0; i < 11; i++) last = await attempt();
    assert.equal(last.status, 429);
  });

  test("tampered / forged tokens are rejected", async () => {
    const t = await demo("patient");
    const [h, p, s] = t.split(".");
    const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 1, role: "admin", exp: 9999999999 })).toString("base64url")}.${s}`;
    assert.equal((await api("GET", "/api/admin/analytics", { token: forged })).status, 401);
    assert.equal((await api("GET", "/api/admin/analytics", { token: t })).status, 403);
  });

  test("admin manages patient profiles; patients and legacy dentist accounts cannot", async () => {
    for (const role of ["patient"]) {
      const tk = await demo(role);
      assert.equal((await api("GET", "/api/patients", { token: tk })).status, 403, `${role} list`);
      assert.equal((await api("POST", "/api/patients", { token: tk, body: {} })).status, 403, `${role} create`);
    }
    const admin = await demo("admin");
    assert.equal((await api("GET", "/api/patients?q=maria", { token: admin })).status, 200);
    const clerk = await demo("clerk");
    const list = await api("GET", "/api/patients?q=maria", { token: clerk });
    assert.equal(list.status, 200);
    assert.equal(list.body.items[0].code, "SC-98214");
    const firstPage = await api("GET", "/api/patients?page=1&pageSize=1", { token: clerk });
    assert.equal(firstPage.status, 200);
    assert.ok(firstPage.body.total > firstPage.body.items.length);
    const emptyPage = await api("GET", `/api/patients?page=999&pageSize=1`, { token: clerk });
    assert.equal(emptyPage.status, 200);
    assert.equal(emptyPage.body.items.length, 0);
    assert.equal(emptyPage.body.total, firstPage.body.total);

    const patientId = list.body.items[0].id;
    assert.equal((await api("PATCH", `/api/patients/${patientId}/dentist-notes`, {
      token: clerk,
      body: { notes: "private note" },
    })).status, 403);
    assert.equal((await api("GET", `/api/patients/${patientId}/dentist-notes`, { token: clerk })).status, 403);

    const savedNotes = await api("PATCH", `/api/patients/${patientId}/dentist-notes`, {
      token: admin,
      body: { notes: "Follow up on sensitivity at next visit." },
    });
    assert.equal(savedNotes.status, 200);
    assert.equal(savedNotes.body.notes, "Follow up on sensitivity at next visit.");
    assert.equal((await api("GET", `/api/patients/${patientId}/dentist-notes`, { token: admin })).body.notes, savedNotes.body.notes);
    assert.equal((await api("GET", `/api/patients/${patientId}`, { token: admin })).body.dentistNotes, undefined);

    const createdNote = await api("POST", `/api/patients/${patientId}/dentist-notes/entries`, {
      token: admin,
      body: { body: "Check sensitivity and review bite at follow-up." },
    });
    assert.equal(createdNote.status, 201);
    assert.equal(createdNote.body.patientId, patientId);
    const noteId = createdNote.body.id;

    const noteStreamController = new AbortController();
    const noteStream = await fetch(base + "/api/stream", {
      headers: { Authorization: "Bearer " + admin },
      signal: noteStreamController.signal,
    });
    const noteReader = noteStream.body.getReader();
    const noteEvent = (async () => {
      const decoder = new TextDecoder();
      let content = "";
      while (!content.includes("event: dentist.note.updated")) {
        const { value, done } = await noteReader.read();
        if (done) break;
        content += decoder.decode(value);
      }
      return content;
    })();
    const realtimeNote = await api("POST", `/api/patients/${patientId}/dentist-notes/entries`, {
      token: admin,
      body: { body: "This should appear immediately in open workspaces." },
    });
    assert.equal(realtimeNote.status, 201);
    const pushedEvent = await Promise.race([
      noteEvent,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Dentist note SSE timeout")), 3000)),
    ]);
    assert.match(pushedEvent, /"patientId"/);
    noteStreamController.abort();

    const noteList = await api("GET", `/api/patients/${patientId}/dentist-notes/entries`, { token: admin });
    assert.ok(noteList.body.items.some((note) => note.id === noteId && note.body === createdNote.body.body));

    const updatedNote = await api("PATCH", `/api/patients/${patientId}/dentist-notes/entries/${noteId}`, {
      token: admin,
      body: { body: "Updated treatment follow-up note." },
    });
    assert.equal(updatedNote.status, 200);
    assert.equal(updatedNote.body.body, "Updated treatment follow-up note.");
    assert.equal((await api("PATCH", `/api/patients/${patientId}/dentist-notes/entries/99999`, {
      token: admin,
      body: { body: "Not found" },
    })).status, 404);
    assert.equal((await api("DELETE", `/api/patients/${patientId}/dentist-notes/entries/${noteId}`, { token: admin })).body.deleted, true);
    assert.equal((await api("GET", `/api/patients/${patientId}/dentist-notes/entries`, { token: admin })).body.items.some((note) => note.id === noteId), false);
    assert.equal((await api("POST", `/api/patients/${patientId}/dentist-notes/entries`, {
      token: clerk,
      body: { body: "Must be admin only" },
    })).status, 403);
  });
});

test("chat messages can be edited and deleted by their sender", async () => {
  const patientToken = await demo("patient");
  const otherPatientToken = (await api("POST", "/api/auth/register", {
    body: { fullName: "Other Patient", email: "other-edit-delete@example.com", password: "Passw0rdOK", phone: "09175550001", consent: true },
  })).body.token;
  const dentistId = (await api("GET", "/api/dentists")).body.items[0].id;
  assert.ok(dentistId);

  const conversation = await api("POST", "/api/conversations", {
    token: patientToken,
    body: { dentistId },
  });
  assert.equal(conversation.status, 201);

  const sent = await api("POST", `/api/conversations/${conversation.body.id}/messages`, {
    token: patientToken,
    body: { body: "Original message" },
  });
  assert.equal(sent.status, 201);

  const edited = await api("PATCH", `/api/conversations/${conversation.body.id}/messages/${sent.body.id}`, {
    token: patientToken,
    body: { body: "Updated message" },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.body, "Updated message");

  const forbiddenEdit = await api("PATCH", `/api/conversations/${conversation.body.id}/messages/${sent.body.id}`, {
    token: otherPatientToken,
    body: { body: "Not allowed" },
  });
  assert.equal(forbiddenEdit.status, 404);

  const deleted = await api("DELETE", `/api/conversations/${conversation.body.id}/messages/${sent.body.id}`, {
    token: patientToken,
  });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, true);

  const history = await api("GET", `/api/conversations/${conversation.body.id}/messages`, { token: patientToken });
  assert.equal(history.body.items.some((item) => item.id === sent.body.id), false);
});

describe("legacy account migration", () => {
  test("disables staff logins and preserves patient and appointment records", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "smartcare-auth-"));
    let db;
    try {
      const dbPath = path.join(directory, "legacy.db");
      db = openDb(dbPath);
      const addUser = (role, email, name) => Number(db.prepare(
        "INSERT INTO users (role, email, password_hash, full_name) VALUES (?,?,?,?)",
      ).run(role, email, "legacy-hash", name).lastInsertRowid);
      const adminId = addUser("admin", "admin@example.test", "Admin");
      const dentistId = addUser("dentist", "dentist@example.test", "Dr. Clinic");
      const otherDentistId = addUser("dentist", "other@example.test", "Dr. Former");
      const clerkId = addUser("clerk", "clerk@example.test", "Front Desk");
      const firstProfile = Number(db.prepare("INSERT INTO dentists (user_id) VALUES (?)").run(dentistId).lastInsertRowid);
      db.prepare("INSERT INTO dentists (user_id) VALUES (?)").run(otherDentistId);
      const patientId = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Existing Patient')").run().lastInsertRowid);
      const serviceId = Number(db.prepare(
        "INSERT INTO services (name, category, price_php, duration_min) VALUES ('Checkup', 'General', 500, 30)",
      ).run().lastInsertRowid);
      db.prepare(
        "INSERT INTO appointments (reference, patient_id, dentist_id, service_id, date, start_time, end_time) VALUES ('SC-KEEP01', ?, ?, ?, '2026-11-01', '09:00', '09:30')",
      ).run(patientId, firstProfile, serviceId);
      db.close();

      db = openDb(dbPath);
      assert.equal(db.prepare("SELECT id FROM dentists WHERE user_id = ?").get(adminId).id, firstProfile);
      assert.equal(db.prepare("SELECT active FROM users WHERE id = ?").get(dentistId).active, 0);
      assert.equal(db.prepare("SELECT active FROM users WHERE id = ?").get(otherDentistId).active, 1);
      assert.equal(db.prepare("SELECT active FROM users WHERE id = ?").get(clerkId).active, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM patients").get().n, 1);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM appointments").get().n, 1);
      assert.equal(db.prepare("SELECT active FROM dentists WHERE user_id = ?").get(adminId).active, 1);
    } finally {
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("hourly schedule migration", () => {
  test("migrates future active appointments to a one-hour block without changing history", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "smartcare-hours-"));
    let db;
    try {
      const dbPath = path.join(directory, "hours.db");
      db = openDb(dbPath);
      const adminId = Number(db.prepare(
        "INSERT INTO users (role, email, password_hash, full_name) VALUES ('admin', 'hours-admin@example.test', 'hash', 'Hours Admin')",
      ).run().lastInsertRowid);
      const dentistId = Number(db.prepare("INSERT INTO dentists (user_id) VALUES (?)").run(adminId).lastInsertRowid);
      db.prepare(
        "INSERT INTO dentist_schedules (dentist_id, weekday, start_time, end_time) VALUES (?,1,'09:00','12:00')",
      ).run(dentistId);
      const patientId = Number(db.prepare("INSERT INTO patients (full_name) VALUES ('Hours Patient')").run().lastInsertRowid);
      const serviceId = Number(db.prepare(
        "INSERT INTO services (name, category, price_php, duration_min) VALUES ('Hours Checkup', 'General', 500, 30)",
      ).run().lastInsertRowid);
      db.prepare(
        `INSERT INTO appointments (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status)
         VALUES ('SC-HOUR01', ?, ?, ?, date('now','+5 days'), '09:00', '09:30', 'confirmed'),
                ('SC-HOUR02', ?, ?, ?, date('now','-5 days'), '09:00', '09:30', 'completed')`,
      ).run(patientId, dentistId, serviceId, patientId, dentistId, serviceId);
      db.prepare("DELETE FROM schema_migrations WHERE id = '20261018_hourly_appointments_8_to_5'").run();
      db.prepare("DELETE FROM schema_migrations WHERE id = '20261018_one_hour_active_appointments'").run();
      db.close();

      db = openDb(dbPath);
      assert.equal(
        db.prepare("SELECT end_time FROM appointments WHERE reference='SC-HOUR01'").get().end_time,
        "10:00",
      );
      assert.equal(
        db.prepare("SELECT end_time FROM appointments WHERE reference='SC-HOUR02'").get().end_time,
        "09:30",
      );
      assert.ok(db.prepare(
        "SELECT 1 FROM dentist_schedules WHERE dentist_id = ? AND start_time='08:00' AND end_time='17:00'",
      ).get(dentistId));
    } finally {
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("service catalog & dentists", () => {
  test("public catalog with prices, duration and prep guidelines", async () => {
    const r = await api("GET", "/api/services");
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 8);
    assert.ok(r.body.items[0].prepGuidelines && r.body.items[0].durationMin && r.body.items[0].pricePhp >= 0);
    assert.ok(r.body.categories.includes("Preventive"));
  });
  test("admin manages services; others cannot", async () => {
    const body = { name: "Dental Sealant", category: "Preventive", pricePhp: 700, durationMin: 30 };
    assert.equal((await api("POST", "/api/services", { token: await demo("patient"), body })).status, 403);
    const made = await api("POST", "/api/services", { token: await demo("admin"), body });
    assert.equal(made.status, 201);
    const edited = await api("PATCH", `/api/services/${made.body.id}`, {
      token: await demo("admin"),
      body: { pricePhp: 800 },
    });
    assert.equal(edited.body.pricePhp, 800);
    await api("DELETE", `/api/services/${made.body.id}`, { token: await demo("admin") });
    assert.equal((await api("GET", `/api/services/${made.body.id}`)).status, 404);
  });
  test("admin manages directory-only dentists without adding login roles", async () => {
    const admin = await demo("admin");
    const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const profilePngBuffer = Buffer.from(tinyPng, "base64");
    profilePngBuffer.writeUInt32BE(200, 16);
    profilePngBuffer.writeUInt32BE(200, 20);
    const profilePng = profilePngBuffer.toString("base64");
    const undersized = await api("POST", "/api/dentists", {
      token: admin,
      body: { fullName: "Dr. Too Small", imageBase64: tinyPng, contentType: "image/png" },
    });
    assert.equal(undersized.status, 422);
    assert.equal(errCode(undersized), "validation_error");
    const made = await api("POST", "/api/dentists", {
      token: admin,
      body: { fullName: "Dr. Clinic Setup", specialty: "Endodontics", bio: "Root canal care", imageBase64: profilePng, contentType: "image/png" },
    });
    assert.equal(made.status, 201);
    assert.equal(made.body.name, "Dr. Clinic Setup");
    assert.match(made.body.profileImageUrl, /^\/api\/dentists\/\d+\/image\?v=/);
    const image = await fetch(`${base}${made.body.profileImageUrl}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await image.arrayBuffer()).toString("base64"), profilePng);
    assert.equal(JSON.stringify(made.body).includes(tinyPng), false);
    const user = srv.app.db.prepare("SELECT role, active FROM users WHERE id = ?").get(made.body.userId);
    assert.equal(user.role, "dentist");
    assert.equal(user.active, 0);

    const publicStream = await fetch(`${base}/api/catalog/stream`);
    assert.equal(publicStream.status, 200);
    const reader = publicStream.body.getReader();
    try {
      const ready = await reader.read();
      assert.match(new TextDecoder().decode(ready.value), /event: ready/);
      const updated = await api("PATCH", `/api/dentists/${made.body.id}`, {
        token: admin,
        body: { fullName: "Dr. Setup Updated" },
      });
      assert.equal(updated.body.name, "Dr. Setup Updated");
      const updateEvent = await reader.read();
      assert.match(new TextDecoder().decode(updateEvent.value), /event: clinic\.catalog\.updated/);
    } finally {
      await reader.cancel();
    }
    assert.ok((await api("GET", "/api/dentists")).body.items.some((dentist) => dentist.id === made.body.id));

    assert.equal((await api("DELETE", `/api/dentists/${made.body.id}`, { token: admin })).status, 204);
    assert.ok(!(await api("GET", "/api/dentists")).body.items.some((dentist) => dentist.id === made.body.id));
    const restore = await api("PATCH", `/api/dentists/${made.body.id}`, { token: admin, body: { active: true } });
    assert.equal(restore.body.active, true);
    await api("DELETE", `/api/dentists/${made.body.id}`, { token: admin });
  });
  test("dentist directory is public", async () => {
    const r = await api("GET", "/api/dentists");
    assert.equal(r.body.items.length, 3);
    assert.equal(r.body.items[0].email, undefined); // contact details not exposed publicly
    assert.ok(r.body.items.some((dentist) => dentist.name === "Doc Petil"));
  });
});

describe("booking flow", { concurrency: false }, () => {
  const date = futureWorkday();
  let maria, other, svc30, svc60, elena, holdId, apptId;

  before(async () => {
    maria = await demo("patient");
    other = (await api("POST", "/api/auth/register", { body: { fullName: "Other Patient", email: "other@example.com", password: "Passw0rdOK", phone: "09175550000", consent: true } })).body.token;
    const services = (await api("GET", "/api/services")).body.items;
    svc30 = services.find((s) => s.name.startsWith("Oral Prophylaxis")).id;
    svc60 = services.find((s) => s.name.startsWith("Composite")).id;
    elena = (await api("GET", "/api/dentists")).body.items.find((d) => d.name.includes("Elena")).id;
  });

  test("availability offers one-hour starts between 8am and 5pm", async () => {
    const r = await api("GET", `/api/dentists/${elena}/availability?date=${date}&serviceId=${svc30}`);
    assert.equal(r.status, 200);
    const times = r.body.slots.map((s) => s.startTime);
    assert.ok(times.includes("08:00") && times.includes("16:00"));
    assert.ok(!times.includes("07:00") && !times.includes("17:00") && !times.includes("16:30"));
    assert.ok(r.body.slots.every((s) => s.available));
    assert.ok(r.body.slots.every((slot) => slot.endTime === `${String(Number(slot.startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`));
  });

  test("monthly availability matches daily availability without per-day queries", async () => {
    const month = date.slice(0, 7);
    const [calendar, day] = await Promise.all([
      api("GET", `/api/dentists/${elena}/availability/calendar?month=${month}&serviceId=${svc30}`),
      api("GET", `/api/dentists/${elena}/availability?date=${date}&serviceId=${svc30}`),
    ]);
    assert.equal(calendar.status, 200);
    assert.equal(calendar.body.days.length, new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate());
    const calendarDay = calendar.body.days.find((entry) => entry.date === date);
    assert.equal(calendarDay.dayStatus, day.body.dayStatus);
    assert.equal(calendarDay.availableSlots, day.body.slots.filter((slot) => slot.available).length);
  });

  test("every procedure uses a one-hour booking block including 90-minute services", async () => {
    const services = (await api("GET", "/api/services")).body.items;
    const rootCanal = services.find((service) => service.name === "Root Canal Treatment");
    const availability = await api("GET", `/api/dentists/${elena}/availability?date=${date}&serviceId=${rootCanal.id}`);
    assert.ok(availability.body.slots.some((slot) => slot.startTime === "16:00" && slot.endTime === "17:00"));
    const booking = await api("POST", "/api/appointments", {
      token: other,
      body: { serviceId: rootCanal.id, dentistId: elena, date, startTime: "12:00" },
    });
    assert.equal(booking.status, 201);
    assert.equal(booking.body.endTime, "13:00");
    assert.equal(booking.body.service.durationMin, 60);
  });

  test("caps unpaid pending bookings per patient", async () => {
    const patient = (await api("POST", "/api/auth/register", {
      body: { fullName: "Pending Cap Patient", email: "pending-cap@example.com", password: "Passw0rdOK", phone: "09175550001", consent: true },
      headers: { "X-Forwarded-For": "198.51.100.10" },
    })).body.token;
    const capDate = futureWorkday(30);
    const starts = ["08:00", "09:00", "10:00"];
    const bookings = [];
    for (const startTime of starts) {
      bookings.push(await api("POST", "/api/appointments", {
        token: patient,
        body: { serviceId: svc30, dentistId: elena, date: capDate, startTime },
      }));
    }
    assert.equal(bookings[0].status, 201);
    assert.equal(bookings[1].status, 201);
    assert.equal(bookings[2].status, 429);
    assert.equal(errCode(bookings[2]), "pending_booking_limit");
  });

  test("expires old unpaid pending appointments but preserves paid pending appointments", async () => {
    const db = srv.app.db;
    const patientId = db.prepare("SELECT id FROM patients WHERE code = 'SC-98214'").get().id;
    const oldDate = "2026-12-18";
    const expiredId = Number(db.prepare(
      `INSERT INTO appointments
       (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, '08:00', '09:00', 'pending', 'online_portal', '2026-01-01 00:00:00')`,
    ).run("SC-EXPIRE1", patientId, elena, svc30, oldDate).lastInsertRowid);
    db.prepare(
      `INSERT INTO appointment_payments
       (appointment_id, provider_checkout_id, checkout_url, amount_centavos, status, created_at)
       VALUES (?, ?, ?, 50000, 'pending', '2026-01-01 00:00:00')`,
    ).run(expiredId, "checkout-expire-1", "https://checkout.test/expire-1");

    const paidId = Number(db.prepare(
      `INSERT INTO appointments
       (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, '09:00', '10:00', 'pending', 'online_portal', '2026-01-01 00:00:00')`,
    ).run("SC-EXPIRE2", patientId, elena, svc30, oldDate).lastInsertRowid);
    db.prepare(
      `INSERT INTO appointment_payments
       (appointment_id, provider_checkout_id, checkout_url, amount_centavos, status, created_at)
       VALUES (?, ?, ?, 50000, 'paid', '2026-01-01 00:00:00')`,
    ).run(paidId, "checkout-expire-2", "https://checkout.test/expire-2");

    assert.equal(srv.app.expireUnpaidPendingAppointments(), 1);
    assert.equal(db.prepare("SELECT status, status_reason FROM appointments WHERE id = ?").get(expiredId).status, "cancelled");
    assert.equal(db.prepare("SELECT status FROM appointment_payments WHERE appointment_id = ?").get(expiredId).status, "expired");
    assert.equal(db.prepare("SELECT status FROM appointments WHERE id = ?").get(paidId).status, "pending");
  });

  test("confirmed appointments remain confirmed 24 hours after their scheduled end and need attention", async () => {
    const admin = await demo("admin");
    const db = srv.app.db;
    const patientId = db.prepare("SELECT id FROM patients WHERE code = 'SC-98214'").get().id;
    const originalClock = srv.app.config.clock;
    const id = Number(db.prepare(
      `INSERT INTO appointments
       (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'walk_in')`,
    ).run("SC-AUTO24", patientId, elena, svc30, "2026-10-20", "07:02", "08:02").lastInsertRowid);

    try {
      srv.app.config.clock = () => new Date("2026-10-21T00:01:00.000Z");
      const beforeGracePeriod = await api("GET", `/api/appointments/${id}`, { token: admin });
      assert.equal(beforeGracePeriod.body.status, "confirmed");

      srv.app.config.clock = () => new Date("2026-10-21T00:02:00.000Z");
      srv.app.markOverdueAppointmentsNeedsAttention();
      const afterGracePeriod = await api("GET", `/api/appointments/${id}`, { token: admin });
      assert.equal(afterGracePeriod.body.status, "confirmed");
      assert.equal(afterGracePeriod.body.needsAttention, true);
    } finally {
      srv.app.config.clock = originalClock;
    }
  });

  test("cannot mark a same-day future appointment completed or no-show", async () => {
    const admin = await demo("admin");
    const db = srv.app.db;
    const patientId = db.prepare("SELECT id FROM patients WHERE code = 'SC-98214'").get().id;
    const originalClock = srv.app.config.clock;
    const id = Number(db.prepare(
      `INSERT INTO appointments
       (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', 'walk_in')`,
    ).run("SC-FUTURETODAY", patientId, elena, svc30, "2026-10-21", "18:00", "19:00").lastInsertRowid);

    try {
      srv.app.config.clock = () => new Date("2026-10-21T08:00:00.000Z");
      const completed = await api("PATCH", `/api/appointments/${id}/status`, {
        token: admin,
        body: { status: "completed" },
      });
      assert.equal(errCode(completed), "too_early");
      const noShow = await api("PATCH", `/api/appointments/${id}/status`, {
        token: admin,
        body: { status: "no_show" },
      });
      assert.equal(errCode(noShow), "too_early");
    } finally {
      srv.app.config.clock = originalClock;
    }
  });

  test("orthodontic and braces services are restricted to Doc Petil", async () => {
    const service = (await api("GET", "/api/services")).body.items.find((item) => /braces/i.test(item.name));
    const dentists = (await api("GET", "/api/dentists")).body.items;
    const docPetil = dentists.find((dentist) => dentist.name === "Doc Petil");
    assert.ok(service && docPetil);
    const rejected = await api("GET", `/api/dentists/${elena}/availability?date=${date}&serviceId=${service.id}`);
    assert.equal(rejected.status, 422);
    const allowed = await api("GET", `/api/dentists/${docPetil.id}/availability?date=${date}&serviceId=${service.id}`);
    assert.equal(allowed.status, 200);
  });

  test("slot hold blocks other patients but not the holder", async () => {
    const h = await api("POST", "/api/slot-holds", { token: maria, body: { serviceId: svc30, dentistId: elena, date, startTime: "10:00" } });
    assert.equal(h.status, 201);
    holdId = h.body.id;
    const theirView = await api("GET", `/api/dentists/${elena}/availability?date=${date}&serviceId=${svc30}`, { token: other });
    assert.equal(theirView.body.slots.find((s) => s.startTime === "10:00").available, false);
    const myView = await api("GET", `/api/dentists/${elena}/availability?date=${date}&serviceId=${svc30}`, { token: maria });
    assert.equal(myView.body.slots.find((s) => s.startTime === "10:00").available, true);
    const steal = await api("POST", "/api/appointments", { token: other, body: { serviceId: svc30, dentistId: elena, date, startTime: "10:00" } });
    assert.equal(steal.status, 409);
    assert.equal(errCode(steal), "slot_unavailable");
  });

  test("patient books with the hold -> pending; slot is now taken", async () => {
    const r = await api("POST", "/api/appointments", { token: maria, body: { serviceId: svc30, dentistId: elena, date, startTime: "10:00", holdId, notes: "Sensitive tooth" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, "pending");
    assert.equal(r.body.source, "online_portal");
    assert.match(r.body.reference, /^SC-[A-Z2-9]{6}$/);
    assert.equal(r.body.endTime, "11:00");
    apptId = r.body.id;
    const again = await api("POST", "/api/appointments", { token: other, body: { serviceId: svc30, dentistId: elena, date, startTime: "10:00" } });
    assert.equal(again.status, 409);
  });

  test("payment checkout reports missing PayMongo configuration explicitly", async () => {
    const config = await api("GET", "/api/payments/config");
    assert.deepEqual(config.body, {
      enabled: false,
      depositPercent: 50,
      paymentMethods: ["card", "gcash", "grab_pay", "paymaya"],
      message: "The clinic's backend must be configured with a PayMongo secret key beginning with sk_test_ or sk_live_.",
    });
    const checkout = await api("POST", "/api/payments/checkout", { token: maria, body: { appointmentId: apptId } });
    assert.equal(checkout.status, 503);
    assert.equal(errCode(checkout), "payment_not_configured");

    srv.app.config.payMongoSecretKey = "sk_test_mock";
    const mismatchedAmount = await api("POST", "/create-checkout-session", {
      token: maria,
      body: { appointmentId: apptId, totalServiceAmount: 1 },
    });
    assert.equal(mismatchedAmount.status, 422);
    assert.equal(errCode(mismatchedAmount), "amount_mismatch");
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith("https://api.paymongo.com/v1/")) {
        return new Response(JSON.stringify({
          errors: [{ code: "payment_method_not_available", detail: "Payment method is not enabled for this account." }],
        }), { status: 422, headers: { "Content-Type": "application/json" } });
      }
      return nativeFetch(input, init);
    };
    const rejectedCheckout = await api("POST", "/create-checkout-session", {
      token: maria,
      body: { appointmentId: apptId, totalServiceAmount: 800 },
    });
    assert.equal(rejectedCheckout.status, 502);
    assert.match(rejectedCheckout.body.error.message, /Payment method is not enabled/);

    let checkoutAttributes;
    globalThis.fetch = async (input, init) => {
      if (String(input).startsWith("https://api.paymongo.com/v1/")) {
        if (String(input).endsWith("/refunds")) {
          return new Response(JSON.stringify({
            data: { id: "rf_mock", attributes: { status: "succeeded" } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        if (init?.method === "POST") {
          const payload = JSON.parse(init.body);
          checkoutAttributes = payload.data.attributes;
          assert.equal(payload.data.attributes.line_items[0].amount, 40_000);
          assert.equal(payload.data.attributes.line_items[0].currency, "PHP");
          assert.deepEqual(payload.data.attributes.payment_method_types, ["card", "gcash", "grab_pay", "paymaya"]);
          const checkoutId = `cs_mock_${payload.data.attributes.metadata.appointment_id}`;
          return new Response(JSON.stringify({
            data: { id: checkoutId, attributes: { checkout_url: "https://checkout.test/session", status: "active" } },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        const checkoutId = String(input).split("/").at(-1);
        return new Response(JSON.stringify({
          data: {
            id: checkoutId,
            attributes: {
              status: "active",
              amount: 40_000,
              payments: paymentProviderStatus === "paid"
                ? [{ id: `pay_mock_${checkoutId}`, attributes: { status: "paid", amount: 40_000 } }]
                : [],
            },
          },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return nativeFetch(input, init);
    };
    const created = await api("POST", "/create-checkout-session", {
      token: maria,
      body: { appointmentId: apptId, totalServiceAmount: 800 },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.depositAmountPhp, 400);
    assert.equal(created.body.remainingAmountPhp, 400);
    assert.equal(created.body.checkoutUrl, "https://checkout.test/session");
    assert.equal(new URL(checkoutAttributes.success_url).searchParams.get("payment"), "success");
    assert.equal(new URL(checkoutAttributes.cancel_url).searchParams.get("payment"), "cancelled");
  });

  test("failed PayMongo payments can be retried with a new checkout session", async () => {
    srv.app.config.payMongoSecretKey = "sk_test_mock";
    const previousFetch = globalThis.fetch;
    let checkoutNumber = 0;
    try {
      globalThis.fetch = async (input, init) => {
        if (String(input).startsWith("https://api.paymongo.com/v1/")) {
          if (init?.method === "POST") {
            checkoutNumber += 1;
            return new Response(JSON.stringify({
              data: {
                id: `cs_retry_${checkoutNumber}`,
                attributes: { checkout_url: `https://checkout.test/retry-${checkoutNumber}`, status: "active" },
              },
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          if (String(input).includes("/payments/")) {
            return new Response(JSON.stringify({
              data: { id: "pay_failed", attributes: { status: "failed", amount: 40_000 } },
            }), { status: 200, headers: { "Content-Type": "application/json" } });
          }
          return new Response(JSON.stringify({
            data: {
              id: "cs_failed",
              attributes: {
                status: "active",
                payments: [{ id: "pay_failed", attributes: { status: "failed", amount: 40_000 } }],
              },
            },
          }), { status: 200, headers: { "Content-Type": "application/json" } });
        }
        return nativeFetch(input, init);
      };

      const failedPayment = await api("GET", `/api/payments/${apptId}`, { token: maria });
      assert.equal(failedPayment.status, 200, JSON.stringify(failedPayment.body));
      assert.equal(failedPayment.body.status, "failed");

      const retry = await api("POST", "/api/payments/checkout", {
        token: maria,
        body: { appointmentId: apptId },
      });
      assert.equal(retry.status, 201, JSON.stringify(retry.body));
      assert.equal(retry.body.checkoutUrl, "https://checkout.test/retry-1");
      assert.equal(checkoutNumber, 1);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("payment request calls always pass the config object", () => {
    const source = readFileSync(path.join(process.cwd(), "src", "routes", "payments.js"), "utf8");
    assert.doesNotMatch(source, /payMongoRequest\(ctx,/);
  });

  test("reserved hourly blocks prevent a second appointment at the same time", async () => {
    const r = await api("POST", "/api/appointments", { token: other, body: { serviceId: svc60, dentistId: elena, date, startTime: "10:00" } });
    assert.equal(r.status, 409);
    const av = await api("GET", `/api/dentists/${elena}/availability?date=${date}&serviceId=${svc60}`);
    assert.equal(av.body.slots.find((s) => s.startTime === "10:00").available, false);
    assert.equal(av.body.slots.find((s) => s.startTime === "11:00").available, true);
  });

  test("a patient cannot be double-booked with another dentist at the same time", async () => {
    const docPetil = (await api("GET", "/api/dentists")).body.items.find((d) => d.name === "Doc Petil").id;
    const r = await api("POST", "/api/appointments", { token: maria, body: { serviceId: svc30, dentistId: docPetil, date, startTime: "10:00" } });
    assert.equal(r.status, 409);
    assert.equal(errCode(r), "patient_double_booked");
  });

  test("rejects past dates, off-hours and bad input", async () => {
    const past = await api("POST", "/api/appointments", { token: maria, body: { serviceId: svc30, dentistId: elena, date: "2020-01-07", startTime: "10:00" } });
    assert.equal(past.status, 422);
    const tooFarAheadDate = addDays(clinicNow(srv.app.config).date, 91);
    const tooFarAhead = await api("POST", "/api/appointments", {
      token: maria,
      body: { serviceId: svc30, dentistId: elena, date: tooFarAheadDate, startTime: "10:00" },
    });
    assert.equal(tooFarAhead.status, 422);
    assert.equal(errCode(tooFarAhead), "validation_error");
    const beyondWindowAvailability = await api(
      "GET",
      `/api/dentists/${elena}/availability?date=${tooFarAheadDate}&serviceId=${svc30}`,
    );
    assert.equal(beyondWindowAvailability.status, 200);
    assert.equal(beyondWindowAvailability.body.dayStatus, "outside_booking_window");
    assert.deepEqual(beyondWindowAvailability.body.slots, []);
    const night = await api("POST", "/api/appointments", { token: maria, body: { serviceId: svc30, dentistId: elena, date, startTime: "20:00" } });
    assert.equal(night.status, 422);
    const junk = await api("POST", "/api/appointments", { token: maria, body: { serviceId: "x", date: "tomorrow" } });
    assert.equal(junk.status, 422);
  });

  test("privacy: patients only see their own appointments", async () => {
    assert.equal((await api("GET", `/api/appointments/${apptId}`, { token: other })).status, 404);
    const mine = await api("GET", "/api/appointments?scope=upcoming", { token: maria });
    assert.ok(mine.body.items.length >= 3 && mine.body.items.every((a) => a.patient.code === "SC-98214"));
    const theirs = await api("GET", "/api/appointments", { token: other });
    assert.equal(theirs.body.total, 1);
    assert.equal(theirs.body.items[0].service.name, "Root Canal Treatment");

    const adminAppointments = await api("GET", "/api/appointments?page=1&pageSize=100", { token: await demo("admin") });
    assert.ok(adminAppointments.body.items.every((appointment) => !["SC-98214", "SC-10001", "SC-10002"].includes(appointment.patient.code)));
    const seededDemoBooking = adminAppointments.body.items.find((appointment) => appointment.patient.code === "SC-98214");
    assert.equal(seededDemoBooking, undefined, "seeded demo bookings must not appear in the dentist portal");
    const patientList = await api("GET", "/api/patients?q=maria", { token: await demo("admin") });
    assert.equal(patientList.body.total, 0, "seeded demo patients must not be shown in the dentist patient list");
    const newPatient = await api("POST", "/api/auth/register", {
      body: { fullName: "Real Portal Patient", email: "real.portal@example.test", password: "Passw0rdOK", phone: "09175550001", consent: true },
    });
    assert.equal(newPatient.status, 201);
    const registeredUser = srv.app.db.prepare("SELECT is_demo FROM users WHERE email = ?").get("real.portal@example.test");
    assert.equal(registeredUser.is_demo, 0, "new patient accounts remain eligible for real patient messaging");
  });

  test("paid online deposits automatically confirm the appointment", async () => {
    srv.app.config.payMongoSecretKey = "sk_test_mock";
    assert.match(srv.app.config.payMongoSecretKey, /^sk_test_/);
    assert.equal((await api("PATCH", `/api/appointments/${apptId}/status`, { token: maria, body: { status: "confirmed" } })).status, 403);
    const dentist = await demo("admin");
    const unpaid = await api("GET", `/api/payments/${apptId}`, { token: maria });
    assert.equal(unpaid.body.status, "pending", JSON.stringify(unpaid.body));
    const blocked = await api("PATCH", `/api/appointments/${apptId}/status`, { token: dentist, body: { status: "confirmed" } });
    assert.equal(blocked.status, 409);
    assert.equal(errCode(blocked), "deposit_required");
    paymentProviderStatus = "paid";
    const confirmedByStaff = await api("PATCH", `/api/appointments/${apptId}/status`, {
      token: dentist,
      body: { status: "confirmed" },
    });
    assert.equal(confirmedByStaff.status, 200);
    assert.equal(confirmedByStaff.body.status, "confirmed");
    const paid = await api("GET", `/api/payments/${apptId}`, { token: maria });
    assert.equal(paid.body.status, "paid");
    assert.equal(paid.body.paymentStatus, "Deposit Paid");
    assert.equal(paid.body.bookingStatus, "confirmed");
    assert.equal(paid.body.depositAmountPhp, 400);
    assert.equal(paid.body.amountPaidPhp, 400);
    assert.match(paid.body.paymentId, /^pay_mock_/);
    const transaction = srv.app.db.prepare(
      "SELECT provider_payment_id, amount_paid_centavos, status FROM payment_transactions WHERE appointment_id = ?",
    ).get(apptId);
    assert.equal(transaction.provider_payment_id, paid.body.paymentId);
    assert.equal(transaction.amount_paid_centavos, 40_000);
    assert.equal(transaction.status, "paid");
    srv.app.db.prepare("UPDATE appointment_payments SET status = 'pending' WHERE appointment_id = ?").run(apptId);
    srv.app.db.prepare("UPDATE appointments SET status = 'pending' WHERE id = ?").run(apptId);
    const reconciledByPaymentSync = await api("GET", `/api/payments/${apptId}`, { token: maria });
    assert.equal(reconciledByPaymentSync.status, 200);
    assert.equal(reconciledByPaymentSync.body.bookingStatus, "confirmed");
    const paidSyncNotifications = srv.app.db.prepare(
      "SELECT template FROM notification_log WHERE appointment_id = ? AND status = 'sent'",
    ).all(apptId);
    assert.ok(
      paidSyncNotifications.some(({ template }) => template === "appointment_confirmed"),
      "a payment reconciliation that confirms an appointment must send the confirmation email",
    );
    const reconciledFromTransaction = await api("PATCH", `/api/appointments/${apptId}/status`, {
      token: dentist,
      body: { status: "confirmed" },
    });
    assert.equal(reconciledFromTransaction.status, 200);
    assert.equal(reconciledFromTransaction.body.status, "confirmed");
    const confirmed = await api("GET", `/api/appointments/${apptId}`, { token: maria });
    assert.equal(confirmed.body.status, "confirmed");
    const early = await api("PATCH", `/api/appointments/${apptId}/status`, { token: dentist, body: { status: "completed" } });
    assert.equal(errCode(early), "too_early");

    const flowDate = futureWorkday(30);
    const flowBooking = await api("POST", "/api/appointments", {
      token: other,
      body: { serviceId: svc30, dentistId: elena, date: flowDate, startTime: "14:00" },
    });
    assert.equal(flowBooking.status, 201);
    const flowCheckout = await api("POST", "/api/payments/checkout", {
      token: other,
      body: { appointmentId: flowBooking.body.id },
    });
    assert.equal(flowCheckout.status, 201);
    paymentProviderStatus = "paid";
    const flowConfirmed = await api("PATCH", `/api/appointments/${flowBooking.body.id}/status`, {
      token: dentist,
      body: { status: "confirmed" },
    });
    assert.equal(flowConfirmed.status, 200, JSON.stringify(flowConfirmed.body));
    const originalClock = srv.app.config.clock;
    try {
      srv.app.config.clock = () => new Date(`${flowDate}T16:00:00+08:00`);
      const completed = await api("PATCH", `/api/appointments/${flowBooking.body.id}/status`, {
        token: dentist,
        body: { status: "completed" },
      });
      assert.equal(completed.status, 200, JSON.stringify(completed.body));
      assert.equal(completed.body.status, "completed");
      const settlement = await api("POST", `/api/admin/appointments/${flowBooking.body.id}/settlement`, {
        token: dentist,
        body: {},
      });
      assert.equal(settlement.status, 200);
      const ledger = await fetch(`${base}/api/admin/ledger.csv?date=${flowDate}`, {
        headers: { Authorization: "Bearer " + dentist },
      });
      assert.equal(ledger.status, 200);
      assert.match(await ledger.text(), new RegExp(completed.body.reference));
    } finally {
      srv.app.config.clock = originalClock;
    }
  });

  test("PayMongo webhook verifies and settles a paid checkout without a redirect", async () => {
    srv.app.config.payMongoSecretKey = "sk_test_mock";
    const webhookDate = futureWorkday(21);
    const booking = await api("POST", "/api/appointments", {
      token: other,
      body: { serviceId: svc30, dentistId: elena, date: webhookDate, startTime: "10:00" },
    });
    assert.equal(booking.status, 201);
    const checkout = await api("POST", "/api/payments/checkout", {
      token: other,
      body: { appointmentId: booking.body.id },
    });
    assert.equal(checkout.status, 201);
    const checkoutId = `cs_mock_${booking.body.id}`;
    const rawBody = JSON.stringify({
      data: {
        attributes: {
          type: "checkout_session.payment.paid",
          data: { id: checkoutId, attributes: { metadata: { appointment_id: String(booking.body.id) } } },
        },
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", "whsec_mock").update(`${timestamp}.${rawBody}`).digest("hex");
    const webhookResponse = await nativeFetch(`${base}/api/webhooks/paymongo`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Paymongo-Signature": `t=${timestamp},te=${signature}`,
      },
      body: rawBody,
    });
    assert.equal(webhookResponse.status, 200, await webhookResponse.text());
    const appointment = await api("GET", `/api/appointments/${booking.body.id}`, { token: other });
    assert.equal(appointment.body.status, "confirmed");
    const payment = await api("GET", `/api/payments/${booking.body.id}`, { token: other });
    assert.equal(payment.body.status, "paid");
    assert.equal(payment.body.paymentId, `pay_mock_${checkoutId}`);
    const transaction = srv.app.db.prepare(
      "SELECT amount_paid_centavos, provider_payment_id FROM payment_transactions WHERE appointment_id = ?",
    ).get(booking.body.id);
    assert.equal(transaction.amount_paid_centavos, 40_000);
    assert.equal(transaction.provider_payment_id, `pay_mock_${checkoutId}`);
  });

  test("reschedule moves to pending for re-confirmation; cancel frees the slot", async () => {
    const r = await api("POST", `/api/appointments/${apptId}/reschedule`, { token: maria, body: { date, startTime: "14:00" } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.startTime, "14:00");
    assert.equal(r.body.status, "pending");
    assert.ok(notifications.some((message) => message.subject === "Appointment rescheduled"));
    const freed = await api("GET", `/api/dentists/${elena}/availability?date=${date}&serviceId=${svc30}`);
    assert.equal(freed.body.slots.find((s) => s.startTime === "10:00").available, true);

    const c = await api("PATCH", `/api/appointments/${apptId}/status`, { token: maria, body: { status: "cancelled", reason: "Conflict at work" } });
    assert.equal(c.body.status, "cancelled");
    assert.ok(notifications.some((message) => message.subject === "Appointment cancelled"));
    assert.equal(c.body.cancellation.refundStatus, "succeeded");
    assert.equal(srv.app.db.prepare("SELECT status FROM appointment_payments WHERE appointment_id = ?").get(apptId).status, "refunded");
    assert.equal((await api("PATCH", `/api/appointments/${apptId}/status`, { token: maria, body: { status: "cancelled" } })).status, 409);
    const freed2 = await api("GET", `/api/dentists/${elena}/availability?date=${date}&serviceId=${svc30}`);
    assert.equal(freed2.body.slots.find((s) => s.startTime === "14:00").available, true);
  });

  test("cancellation policy blocks late patient changes and protects ownership", async () => {
    const policyDate = futureWorkday(40);
    const booking = await api("POST", "/api/appointments", {
      token: maria,
      body: { serviceId: svc30, dentistId: elena, date: policyDate, startTime: "08:00" },
    });
    assert.equal(booking.status, 201);
    const originalClock = srv.app.config.clock;
    try {
      srv.app.config.clock = () => new Date(`${policyDate}T00:00:00+08:00`);
      const late = await api("PATCH", `/api/appointments/${booking.body.id}/status`, {
        token: maria,
        body: { status: "cancelled" },
      });
      assert.equal(late.status, 409);
      assert.equal(errCode(late), "cancellation_policy");
      assert.equal((await api("PATCH", `/api/appointments/${booking.body.id}/status`, {
        token: other,
        body: { status: "cancelled" },
      })).status, 404);
    } finally {
      srv.app.config.clock = originalClock;
    }
  });

  test("clinic cancellation does not cancel before PayMongo confirms the refund", async () => {
    const dateForRefundFailure = futureWorkday(50);
    const booking = await api("POST", "/api/appointments", {
      token: other,
      body: { serviceId: svc30, dentistId: elena, date: dateForRefundFailure, startTime: "09:00" },
    });
    assert.equal(booking.status, 201);
    const appointmentId = booking.body.id;
    srv.app.db.prepare("UPDATE appointments SET status = 'confirmed' WHERE id = ?").run(appointmentId);
    srv.app.db.prepare(
      `INSERT INTO appointment_payments
       (appointment_id, provider_checkout_id, checkout_url, amount_centavos, status, paid_at)
       VALUES (?,?,?,?, 'paid', datetime('now'))`,
    ).run(appointmentId, `cs_refund_failure_${appointmentId}`, "https://checkout.test/refund-failure", 40_000);
    srv.app.db.prepare(
      `INSERT INTO payment_transactions
       (appointment_id, provider_checkout_id, provider_payment_id, amount_paid_centavos, status)
       VALUES (?,?,?,?,'paid')`,
    ).run(appointmentId, `cs_refund_failure_${appointmentId}`, `pay_refund_failure_${appointmentId}`, 40_000);
    const previousFetch = globalThis.fetch;
    const admin = await demo("admin");
    try {
      globalThis.fetch = async (input, init) => {
        if (String(input).endsWith("/refunds")) {
          return new Response(JSON.stringify({ errors: [{ code: "refund_unavailable", detail: "Refund service unavailable" }] }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          });
        }
        return nativeFetch(input, init);
      };
      const cancelled = await api("PATCH", `/api/appointments/${appointmentId}/status`, {
        token: admin,
        body: { status: "cancelled" },
      });
      assert.equal(cancelled.status, 502);
      assert.equal(srv.app.db.prepare("SELECT status FROM appointments WHERE id = ?").get(appointmentId).status, "confirmed");
      assert.equal(srv.app.db.prepare("SELECT status FROM appointment_refunds WHERE appointment_id = ?").get(appointmentId).status, "failed");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  test("dentist time-off closes the day; weekly schedule is editable by owner only", async () => {
    const dentist = await demo("admin");
    const d2 = addDays(date, 7);
    const off = await api("POST", "/api/dentists/me/time-off", { token: dentist, body: { date: d2, reason: "Seminar" } });
    assert.equal(off.status, 201);
    const av = await api("GET", `/api/dentists/${elena}/availability?date=${d2}&serviceId=${svc30}`);
    assert.equal(av.body.dayStatus, "time_off");
    assert.equal(av.body.slots.length, 0);
    assert.equal((await api("PUT", `/api/dentists/${elena}/schedule`, { token: maria, body: { blocks: [] } })).status, 403);
    const put = await api("PUT", "/api/dentists/me/schedule", { token: dentist, body: { blocks: [{ weekday: 1, startTime: "08:00", endTime: "12:00" }, { weekday: 1, startTime: "11:00", endTime: "13:00" }] } });
    assert.equal(put.status, 422, "overlapping blocks rejected");
  });

  test("clerk books on behalf of a walk-in / Messenger patient -> confirmed", async () => {
    const clerk = await demo("clerk");
    const juan = (await api("GET", "/api/patients?q=Juan", { token: clerk })).body.items[0];
    const r = await api("POST", "/api/appointments", { token: clerk, body: { patientId: juan.id, serviceId: svc30, dentistId: elena, date, startTime: "09:00", source: "messenger" } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, "confirmed");
    assert.equal(r.body.source, "messenger");
    assert.equal(r.body.endTime, "10:00");
  });

  test("admin can add a patient and book a confirmed one-hour walk-in", async () => {
    const admin = await demo("admin");
    const patient = await api("POST", "/api/patients", {
      token: admin,
      body: {
        fullName: "Walk In Patient",
        birthDate: "1990-01-01",
        sex: "other",
      },
    });
    assert.equal(patient.status, 201);
    assert.equal(patient.body.phone, null);
    const date = futureWorkday(21);
    const booking = await api("POST", "/api/appointments", {
      token: admin,
      body: {
        patientId: patient.body.id,
        dentistId: elena,
        serviceId: svc30,
        date,
        startTime: "08:00",
        source: "walk_in",
        notes: "Patient reports sensitivity in a molar.",
      },
    });
    assert.equal(booking.status, 201);
    assert.equal(booking.body.status, "confirmed");
    assert.equal(booking.body.source, "walk_in");
    assert.equal(booking.body.endTime, "09:00");
    assert.equal(booking.body.notes, "Patient reports sensitivity in a molar.");
  });

  test("walk-in slot holds block competing staff and are consumed by booking", async () => {
    const admin = await demo("admin");
    const clerk = await demo("clerk");
    const patient = await api("POST", "/api/patients", {
      token: admin,
      body: { fullName: "Reserved Walk In", birthDate: "1990-01-01", sex: "other" },
    });
    assert.equal(patient.status, 201);
    const bookingDate = futureWorkday(28);
    const hold = await api("POST", "/api/slot-holds", {
      token: admin,
      body: { serviceId: svc30, dentistId: elena, date: bookingDate, startTime: "08:00" },
    });
    assert.equal(hold.status, 201);
    assert.ok(hold.body.expiresAt);
    assert.ok(hold.body.secondsLeft > 0);

    const competingHold = await api("POST", "/api/slot-holds", {
      token: clerk,
      body: { serviceId: svc30, dentistId: elena, date: bookingDate, startTime: "08:00" },
    });
    assert.equal(competingHold.status, 409);
    assert.equal(errCode(competingHold), "slot_unavailable");

    const booking = await api("POST", "/api/appointments", {
      token: admin,
      body: {
        patientId: patient.body.id,
        serviceId: svc30,
        dentistId: elena,
        date: bookingDate,
        startTime: "08:00",
        source: "walk_in",
        holdId: hold.body.id,
      },
    });
    assert.equal(booking.status, 201, JSON.stringify(booking.body));
    assert.equal(booking.body.status, "confirmed");
    assert.equal(booking.body.source, "walk_in");
    assert.equal(srv.app.db.prepare("SELECT 1 FROM slot_holds WHERE id = ?").get(hold.body.id), undefined);
  });

  test("expired holds are rejected", async () => {
    const t0 = Date.now();
    const s2 = createApp({
      dbPath: ":memory:",
      seedOnStart: true,
      jwtSecret: "t".repeat(40),
      faceDescriptorKey: "a".repeat(64),
      demoMode: true,
      clock: () => new Date(t0 + (globalThis.__skew ?? 0)),
    });
    await new Promise((r) => s2.server.listen(0, r));
    const b2 = `http://localhost:${s2.server.address().port}`;
    const call = async (m, p, tk, body) => (await fetch(b2 + p, { method: m, headers: { "Content-Type": "application/json", Authorization: `Bearer ${tk}` }, body: body ? JSON.stringify(body) : undefined })).json();
    const tk = (await (await fetch(b2 + "/api/auth/demo-login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ role: "patient" }) })).json()).token;
    const hold = await call("POST", "/api/slot-holds", tk, { serviceId: svc30, dentistId: elena, date, startTime: "11:00" });
    assert.ok(hold.id);
    globalThis.__skew = 6 * 60_000; // 6 minutes later (hold is 5)
    const r = await call("POST", "/api/appointments", tk, { serviceId: svc30, dentistId: elena, date, startTime: "11:00", holdId: hold.id });
    assert.equal(r.error.code, "hold_expired");
    globalThis.__skew = 0;
    await s2.close();
  });

  test("only a patient with a completed appointment can submit one dentist review", async () => {
    const booking = await api("POST", "/api/appointments", {
      token: other,
      body: { serviceId: svc30, dentistId: elena, date, startTime: "15:00" },
    });
    assert.equal(booking.status, 201);
    const reviewPath = `/api/appointments/${booking.body.id}/review`;
    const payload = { rating: 5, comment: "The visit was comfortable and the dentist explained each step.", isPublic: true };

    const premature = await api("POST", reviewPath, { token: other, body: payload });
    assert.equal(premature.status, 409);
    const unauthorized = await api("POST", reviewPath, { token: maria, body: payload });
    assert.equal(unauthorized.status, 404);

    srv.app.db.prepare("UPDATE appointments SET status = 'completed' WHERE id = ?").run(booking.body.id);
    const submitted = await api("POST", reviewPath, { token: other, body: payload });
    assert.equal(submitted.status, 201);
    assert.equal(submitted.body.isPublic, true);

    const listed = await api("GET", "/api/appointments?scope=past&pageSize=100", { token: other });
    const ownAppointment = listed.body.items.find((item) => item.id === booking.body.id);
    assert.equal(ownAppointment.patientReview.rating, 5);
    assert.equal(ownAppointment.patientReview.isPublic, true);

    const duplicate = await api("POST", reviewPath, { token: other, body: payload });
    assert.equal(duplicate.status, 409);
    const dentist = await api("GET", `/api/dentists/${elena}`);
    assert.equal(dentist.body.reviewCount, 1);
    assert.equal(dentist.body.ratingAverage, 5);
    assert.equal(dentist.body.reviews[0].comment, payload.comment);
  });
});

describe("patient <-> dentist messaging", () => {
  test("clinic admin can privately message any patient with a booking", async () => {
    const patientResponse = await api("POST", "/api/auth/register", {
      body: {
        fullName: "Booked Ortho Patient",
        email: "booked.ortho@example.com",
        password: "Passw0rdOK",
        phone: "09175550123",
        consent: true,
      },
    });
    assert.equal(patientResponse.status, 201);
    const patientToken = patientResponse.body.token;
    const patientId = patientResponse.body.user.patientId;
    const services = (await api("GET", "/api/services")).body.items;
    const dentists = (await api("GET", "/api/dentists")).body.items;
    const docPetil = dentists.find((dentist) => dentist.name === "Doc Petil");
    const braces = services.find((service) => /braces/i.test(service.name));
    assert.ok(docPetil && braces);
    const date = futureWorkday(7);
    const availability = await api(
      "GET",
      `/api/dentists/${docPetil.id}/availability?date=${date}&serviceId=${braces.id}`,
    );
    const slot = availability.body.slots.find((item) => item.available);
    assert.ok(slot);
    const booking = await api("POST", "/api/appointments", {
      token: patientToken,
      body: { dentistId: docPetil.id, serviceId: braces.id, date, startTime: slot.startTime },
    });
    assert.equal(booking.status, 201);

    const admin = await demo("admin");
    const conversation = await api("POST", "/api/conversations", {
      token: admin,
      body: { patientId },
    });
    assert.equal(conversation.status, 201);
    const sent = await api("POST", `/api/conversations/${conversation.body.id}/messages`, {
      token: admin,
      body: { body: "Your clinic booking is received." },
    });
    assert.equal(sent.status, 201);

    const patientConversations = await api("GET", "/api/conversations", { token: patientToken });
    assert.ok(patientConversations.body.items.some((item) => item.id === conversation.body.id));
    const history = await api(
      "GET",
      `/api/conversations/${conversation.body.id}/messages`,
      { token: patientToken },
    );
    assert.equal(history.body.items[0].body, "Your clinic booking is received.");
  });

  test("chat works, is private, and pushes real-time events over SSE", async () => {
    const maria = await demo("patient");
    const dentistTk = await demo("admin");
    const clerk = await demo("clerk");
    const elena = (await api("GET", "/api/dentists")).body.items.find((d) => d.name.includes("Elena")).id;

    const conv = await api("POST", "/api/conversations", { token: maria, body: { dentistId: elena } });
    assert.equal(conv.status, 200); // seed already created the thread -> get-or-create returns it
    const id = conv.body.id;

    // dentist opens an SSE stream
    const ac = new AbortController();
    const stream = await fetch(base + "/api/stream", { headers: { Authorization: `Bearer ${dentistTk}` }, signal: ac.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type"), /text\/event-stream/);
    const reader = stream.body.getReader();
    let buf = "";
    const seen = (async () => {
      const dec = new TextDecoder();
      while (!buf.includes("event: message.new")) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value); }
      return buf;
    })();

    const sent = await api("POST", `/api/conversations/${id}/messages`, { token: maria, body: { body: "Can I eat before my filling?" } });
    assert.equal(sent.status, 201);
    const got = await Promise.race([seen, new Promise((_, rej) => setTimeout(() => rej(new Error("SSE timeout")), 3000))]);
    assert.match(got, /Can I eat before my filling\?/);
    ac.abort();

    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFYoAAAAASUVORK5CYII=", "base64");
    const imageMessage = await api("POST", `/api/conversations/${id}/images`, {
      token: dentistTk,
      body: { fileName: "teeth.png", contentType: "image/png", imageBase64: png.toString("base64") },
    });
    assert.equal(imageMessage.status, 201, JSON.stringify(imageMessage.body));
    assert.equal(imageMessage.body.image.fileName, "teeth.png");
    const imageHistory = await api("GET", `/api/conversations/${id}/messages`, { token: maria });
    assert.ok(imageHistory.body.items.some((item) => item.image?.id === imageMessage.body.image.id));
    const privateImage = await fetch(base + imageMessage.body.image.url, { headers: { Authorization: "Bearer " + dentistTk } });
    assert.equal(privateImage.status, 200);
    assert.equal(privateImage.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await privateImage.arrayBuffer()), png);

    const dView = await api("GET", "/api/conversations", { token: dentistTk });
    assert.ok(dView.body.unreadTotal >= 1);
    await api("POST", `/api/conversations/${id}/read`, { token: dentistTk });
    const after = await api("GET", "/api/conversations", { token: dentistTk });
    assert.equal(after.body.unreadTotal, 0);

    const history = await api("GET", `/api/conversations/${id}/messages`, { token: dentistTk });
    assert.ok(history.body.items.length >= 3);
    const poll = await api("GET", `/api/conversations/${id}/messages?after=${history.body.items[0].id}`, { token: maria });
    assert.equal(poll.body.items.length, history.body.items.length - 1);

    // privacy
    assert.equal((await api("GET", `/api/conversations/${id}/messages`, { token: clerk })).status, 403);
    const intruder = (await api("POST", "/api/auth/register", { body: { fullName: "Nosy Person", email: "nosy@example.com", password: "Passw0rdOK", phone: "09175559999", consent: true } })).body.token;
    assert.equal((await api("GET", `/api/conversations/${id}/messages`, { token: intruder })).status, 404);
    assert.equal((await fetch(base + imageMessage.body.image.url, { headers: { Authorization: "Bearer " + intruder } })).status, 404);
    assert.equal((await api("POST", `/api/conversations/${id}/messages`, { token: maria, body: { body: "   " } })).status, 422);
    assert.equal((await api("POST", `/api/conversations/${id}/images`, {
      token: maria,
      body: { fileName: "fake.png", contentType: "image/png", imageBase64: Buffer.from("not an image").toString("base64") },
    })).status, 422);
  });
});

describe("queue removal", () => {
  test("queue and room endpoints are no longer available", async () => {
    assert.equal((await api("GET", "/api/queue/board")).status, 404);
    assert.equal((await api("GET", "/api/queue")).status, 404);
    assert.equal((await api("GET", "/api/rooms")).status, 404);
  });
});

describe("admin analytics & ledger", () => {
  test("insights provide diagnostic breakdowns and labeled forecast inputs to admins only", async () => {
    const admin = await demo("admin");
    const from = addDays(clinicNow(tzCfg).date, -29);
    const to = clinicNow(tzCfg).date;
    const response = await api("GET", `/api/admin/insights?from=${from}&to=${to}`, { token: admin });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.servicePerformance);
    assert.ok(response.body.cancellationSlots.some((slot) => slot.time === "08:00"));
    assert.ok(Array.isArray(response.body.demographics));
    assert.equal(response.body.paymentAudit.counterSettlementsTracked, true);
    assert.ok(typeof response.body.paymentAudit.onlineDepositExpectedPhp === "number");
    assert.equal(response.body.demandForecast.days.length, 30);
    assert.ok(response.body.revenueProjection.month);
    assert.ok(Array.isArray(response.body.noShowRisk));
    assert.ok(Array.isArray(response.body.supplyForecast));

    const patient = await demo("patient");
    assert.equal((await api("GET", "/api/admin/insights", { token: patient })).status, 403);
    assert.equal((await api("GET", `/api/admin/insights?from=${to}&to=${from}`, { token: admin })).status, 422);

    const { db } = srv.app;
    const patientId = Number(db.prepare(
      "INSERT INTO patients (code, full_name, is_demo) VALUES ('SC-REAL01', 'Real Analytics Patient', 0)",
    ).run().lastInsertRowid);
    const dentistId = db.prepare("SELECT id FROM dentists WHERE active = 1 ORDER BY id LIMIT 1").get().id;
    const service = db.prepare("SELECT id, price_php FROM services ORDER BY id LIMIT 1").get();
    const appointmentId = Number(db.prepare(
      `INSERT INTO appointments (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status, source)
       VALUES ('SC-AUDIT1', ?, ?, ?, ?, '08:00', '09:00', 'completed', 'walk_in')`,
    ).run(patientId, dentistId, service.id, to).lastInsertRowid);
    const settlement = await api("POST", `/api/admin/appointments/${appointmentId}/settlement`, { token: admin, body: {} });
    assert.equal(settlement.status, 200);
    assert.equal(settlement.body.amountPhp, service.price_php);
    assert.equal(settlement.body.status, "settled");
    assert.equal((await api("POST", `/api/admin/appointments/${appointmentId}/settlement`, { token: admin, body: {} })).status, 409);
    assert.equal((await api("POST", `/api/admin/appointments/${appointmentId}/settlement`, { token: patient, body: {} })).status, 403);
    const audited = await api("GET", `/api/admin/insights?from=${to}&to=${to}`, { token: admin });
    assert.equal(audited.body.paymentAudit.counterBalanceSettledPhp, service.price_php);
    assert.equal(audited.body.paymentAudit.counterPayments.some((item) => item.appointmentId === appointmentId), false);
  });

  test("analytics aggregate appointments", async () => {
    const admin = await demo("admin");
    const from = addDays(clinicNow(tzCfg).date, -90);
    const to = addDays(clinicNow(tzCfg).date, 30);
    const r = await api("GET", `/api/admin/analytics?from=${from}&to=${to}`, { token: admin });
    assert.equal(r.status, 200);
    const expected = srv.app.db.prepare(
      `SELECT COUNT(*) AS appointments,
              SUM(a.status = 'completed') AS completed,
              SUM(a.status = 'no_show') AS no_show
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE a.date BETWEEN ? AND ? AND p.is_demo = 0`,
    ).get(from, to);
    assert.equal(r.body.totals.appointments, expected.appointments, "demo appointments are excluded from dentist analytics");
    assert.equal(r.body.totals.completed, expected.completed ?? 0);
    assert.equal(r.body.totals.noShow, expected.no_show ?? 0);
    assert.equal(r.body.appointmentsByService.reduce((sum, item) => sum + item.count, 0), expected.appointments);
    assert.equal((await api("GET", "/api/admin/analytics?from=2026-12-01&to=2026-01-01", { token: admin })).status, 422);
  });

  test("daily ledger exports CSV (pay at counter) and neutralises formulas", async () => {
    const admin = await demo("admin");
    const today = clinicNow(tzCfg).date;
    const { db } = srv.app;
    const ledgerPatientId = Number(db.prepare(
      "INSERT INTO patients (code, full_name) VALUES ('SC-LEDG01', '=HYPERLINK(\"http://evil\")')",
    ).run().lastInsertRowid);
    db.prepare(`INSERT INTO appointments (reference, patient_id, dentist_id, service_id, date, start_time, end_time, status, source)
                VALUES ('SC-LEDGR1', ?, 1, 4, ?, '09:00', '10:00', 'completed', 'walk_in')`).run(ledgerPatientId, today);
    const res = await fetch(`${base}/api/admin/ledger.csv?date=${today}`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/csv/);
    assert.match(res.headers.get("content-disposition"), /smartcare-ledger-/);
    const csv = await res.text();
    assert.match(csv, /SC-LEDGR1/);
    assert.match(csv, /Online deposit \(PHP\)/);
    assert.match(csv, /"1200"/);
    assert.ok(csv.includes(`"'=HYPERLINK`), "formula injection neutralised");
    assert.equal((await api("GET", "/api/admin/ledger.csv", { token: await demo("clerk") })).status, 403);
  });
});

describe("hardening", () => {
  test("CORS: allowed origin echoed, foreign origin blocked on writes", async () => {
    const ok = await api("GET", "/api/health", { headers: { Origin: "http://localhost:3000" } });
    assert.equal(ok.headers.get("access-control-allow-origin"), "http://localhost:3000");
    for (const origin of ["http://localhost:3001", "http://127.0.0.1:3000", "http://[::1]:4173"]) {
      const local = await api("POST", "/api/auth/login", {
        headers: { Origin: origin },
        body: { email: "origin-check@example.test", password: "wrongPassword1" },
      });
      assert.equal(local.status, 401, `${origin} should pass CORS and reach authentication`);
      assert.equal(local.headers.get("access-control-allow-origin"), origin);
    }
    const evil = await api("POST", "/api/auth/login", { headers: { Origin: "http://evil.example" }, body: { email: "a@b.co", password: "x" } });
    assert.equal(evil.status, 403);
    const blockedPreflight = await api("OPTIONS", "/api/auth/login", { headers: { Origin: "http://evil.example" } });
    assert.equal(blockedPreflight.status, 403);
    assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  });
  test("invalid JSON and oversized bodies", async () => {
    const bad = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
    assert.equal(bad.status, 400);
    const big = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.co", password: "x".repeat(200_000) }) });
    assert.equal(big.status, 413);
  });
  test("SQL-injection style input is treated as data", async () => {
    const r = await api("GET", "/api/services?q=" + encodeURIComponent("'; DROP TABLE services;--"));
    assert.equal(r.status, 200);
    assert.equal((await api("GET", "/api/services")).body.items.length, 8);
  });
  test("production guards", async () => {
    const { loadConfig } = await import("../src/config.js");
    const validFaceKey = "a".repeat(64);
    const validJwtSecret = "j".repeat(32);
    assert.throws(() => loadConfig({
      isProd: false,
      jwtSecret: "",
      faceDescriptorKey: validFaceKey,
      allowInsecureDevSecret: false,
    }), /JWT_SECRET/);
    assert.throws(() => loadConfig({
      isProd: false,
      jwtSecret: "x".repeat(31),
      faceDescriptorKey: validFaceKey,
      allowInsecureDevSecret: false,
    }), /JWT_SECRET/);
    assert.throws(() => loadConfig({
      isProd: false,
      jwtSecret: validJwtSecret,
      faceDescriptorKey: "",
      allowInsecureDevSecret: false,
    }), /FACE_DESCRIPTOR_KEY/);
    assert.throws(() => loadConfig({
      isProd: false,
      jwtSecret: validJwtSecret,
      faceDescriptorKey: "z".repeat(64),
      allowInsecureDevSecret: false,
    }), /FACE_DESCRIPTOR_KEY/);
    const configured = loadConfig({
      isProd: false,
      jwtSecret: validJwtSecret,
      faceDescriptorKey: validFaceKey,
      allowInsecureDevSecret: false,
    });
    assert.equal(configured.jwtSecret, validJwtSecret);
    assert.equal(configured.faceDescriptorKey, validFaceKey);
    const insecureDev = loadConfig({
      isProd: false,
      jwtSecret: "",
      faceDescriptorKey: "",
      allowInsecureDevSecret: true,
    });
    assert.equal(insecureDev.jwtSecret, "dev-only-secret-do-not-use-in-production");
    assert.equal(insecureDev.faceDescriptorKey, validFaceKey);
    assert.throws(() => loadConfig({
      isProd: true,
      jwtSecret: "",
      faceDescriptorKey: validFaceKey,
      allowInsecureDevSecret: true,
    }), /JWT_SECRET/);
    assert.throws(() => loadConfig({
      isProd: true,
      jwtSecret: validJwtSecret,
      faceDescriptorKey: "",
      allowInsecureDevSecret: true,
    }), /FACE_DESCRIPTOR_KEY/);
    assert.throws(() => loadConfig({
      isProd: true,
      jwtSecret: validJwtSecret,
      faceDescriptorKey: validFaceKey,
      corsOrigins: ["https://example.test"],
      demoMode: true,
    }), /DEMO_MODE/);
  });
});
