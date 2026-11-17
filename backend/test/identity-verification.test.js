import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { signToken } from "../src/lib/security.js";

let srv;
let base;
const nativeFetch = globalThis.fetch;
const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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
    facePlusPlusApiKey: "test-key",
    facePlusPlusApiSecret: "test-secret",
    facePlusPlusBaseUrl: "https://api-us.faceplusplus.com",
    ocrSpaceApiKey: "ocr-test-key",
    ocrSpaceApiUrl: "https://api.ocr.space/parse/image",
    port: 0,
  });
  const dentist = srv.app.db.prepare("SELECT id, role, session_version FROM users WHERE role = 'dentist' ORDER BY id LIMIT 1").get();
  srv.dentistId = dentist.id;
  srv.dentistToken = signToken({ sub: dentist.id, role: dentist.role, sessionVersion: dentist.session_version }, srv.app.config.jwtSecret, srv.app.config.tokenTtlSec);
  await new Promise((resolve) => srv.server.listen(0, resolve));
  base = `http://localhost:${srv.server.address().port}`;
  srv.patientToken = (await api("POST", "/api/auth/demo-login", { body: { role: "patient" } })).body.token;
});

after(async () => {
  globalThis.fetch = nativeFetch;
  await srv.close();
});

describe("identity verification", () => {
  test("requires a dentist or admin session", async () => {
    assert.equal((await api("GET", "/api/identity-verification")).status, 401);
    assert.equal((await api("GET", "/api/identity-verification", { token: srv.patientToken })).status, 403);
  });

  test("validates consent and image content before calling Face++", async () => {
    let calls = 0;
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("https://api.ocr.space")) return nativeFetch(url, init);
      calls += 1;
      return new Response("{}");
    };
    const response = await api("POST", "/api/identity-verification", {
      token: srv.dentistToken,
      body: { idImageBase64: "not-an-image", selfieImageBase64: imageBase64, consent: true },
    });
    assert.equal(response.status, 422);
    assert.equal(calls, 0);
  });

  test("stores only the selected OCR fields and face score", async () => {
    const calls = [];
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("https://api.ocr.space") && !String(url).startsWith("https://api-us.faceplusplus.com")) return nativeFetch(url, init);
      calls.push(String(url));
      const body = String(url).startsWith("https://api.ocr.space")
        ? { IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: "Full Name: Dr Test\nBirth Date: 1990-01-02\nID Number: ABC-123456\nExpiry Date: 2030-01-02" }] }
        : { request_id: "compare-1", confidence: 92.4 };
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const response = await api("POST", "/api/identity-verification", {
      token: srv.dentistToken,
      body: { idImageBase64: imageBase64, selfieImageBase64: imageBase64, consent: true },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      status: "verified",
      consentAt: response.body.consentAt,
      idFullName: "Dr Test",
      idBirthDate: "1990-01-02",
      idNumberLast4: "3456",
      idExpiryDate: "2030-01-02",
      faceMatchScore: 92.4,
      failureReason: null,
      createdAt: response.body.createdAt,
      updatedAt: response.body.updatedAt,
    });
    assert.deepEqual(calls, [
      "https://api.ocr.space/parse/image",
      "https://api-us.faceplusplus.com/facepp/v3/compare",
    ]);
    assert.deepEqual((await api("DELETE", "/api/identity-verification", { token: srv.dentistToken })).body, { status: "not_started" });
    assert.deepEqual((await api("GET", "/api/identity-verification", { token: srv.dentistToken })).body, { status: "not_started" });
  });

  test("updates an existing verification when the user re-verifies", async () => {
    let confidence = 91;
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("https://api.ocr.space") && !String(url).startsWith("https://api-us.faceplusplus.com")) return nativeFetch(url, init);
      const body = String(url).startsWith("https://api.ocr.space")
        ? { IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: "Name: Reverify User" }] }
        : { request_id: `reverify-${confidence}`, confidence: confidence++ };
      return new Response(JSON.stringify(body), { status: 200 });
    };

    const first = await api("POST", "/api/identity-verification", {
      token: srv.dentistToken,
      body: { idImageBase64: imageBase64, selfieImageBase64: imageBase64, consent: true },
    });
    const second = await api("POST", "/api/identity-verification", {
      token: srv.dentistToken,
      body: { idImageBase64: imageBase64, selfieImageBase64: imageBase64, consent: true },
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.body.faceMatchScore, 92);
    assert.equal(srv.app.db.prepare("SELECT COUNT(*) AS count FROM identity_verifications WHERE user_id = ?").get(srv.dentistId).count, 1);
  });

  test("overwrites a pre-existing verification record", async () => {
    srv.app.db.prepare("DELETE FROM identity_verifications WHERE user_id = ?").run(srv.dentistId);
    srv.app.db.prepare(
      `INSERT INTO identity_verifications
        (user_id, status, consent_at, consent_policy_version, id_full_name, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(srv.dentistId, "rejected", "2026-01-01T00:00:00.000Z", "old-policy", "Old Name", "2026-01-01T00:00:00.000Z");
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("https://api.ocr.space") && !String(url).startsWith("https://api-us.faceplusplus.com")) return nativeFetch(url, init);
      const body = String(url).startsWith("https://api.ocr.space")
        ? { IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: "Name: Updated User" }] }
        : { request_id: "overwrite-1", confidence: 95 };
      return new Response(JSON.stringify(body), { status: 200 });
    };

    const response = await api("POST", "/api/identity-verification", {
      token: srv.dentistToken,
      body: { idImageBase64: imageBase64, selfieImageBase64: imageBase64, consent: true },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.status, "verified");
    assert.equal(response.body.idFullName, "Updated User");
    assert.equal(srv.app.db.prepare("SELECT COUNT(*) AS count FROM identity_verifications WHERE user_id = ?").get(srv.dentistId).count, 1);
  });

  test("parses common OCR ID labels without requiring exact punctuation", async () => {
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("https://api.ocr.space") && !String(url).startsWith("https://api-us.faceplusplus.com")) return nativeFetch(url, init);
      const body = String(url).startsWith("https://api.ocr.space")
        ? { IsErroredOnProcessing: false, ParsedResults: [{ ParsedText: "NAME DOE, JANE\nDATE OF BIRTH 01/02/1990\nID NO. ABC-123456\nVALID UNTIL 01/02/2030" }] }
        : { request_id: "compare-2", confidence: 91 };
      return new Response(JSON.stringify(body), { status: 200 });
    };

    const response = await api("POST", "/api/identity-verification", {
      token: srv.dentistToken,
      body: { idImageBase64: imageBase64, selfieImageBase64: imageBase64, consent: true },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.idFullName, "DOE, JANE");
    assert.equal(response.body.idBirthDate, "01/02/1990");
    assert.equal(response.body.idNumberLast4, "3456");
    assert.equal(response.body.idExpiryDate, "01/02/2030");
  });

  test("returns safe OCR provider details to the frontend", async () => {
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://api.ocr.space")) {
        return new Response(JSON.stringify({
          IsErroredOnProcessing: true,
          ErrorMessage: ["Invalid API key"],
        }), { status: 403 });
      }
      return nativeFetch(url, init);
    };
    const response = await api("POST", "/api/identity-verification", {
      token: srv.dentistToken,
      body: { idImageBase64: imageBase64, selfieImageBase64: imageBase64, consent: true },
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.message, "OCR.space could not process the ID: Invalid API key");
    const counter = srv.app.db.prepare(
      "SELECT failures FROM rate_limit_counters WHERE scope_key LIKE 'identity-verification|account|%'",
    ).get();
    assert.equal(counter.failures, 1);
  });

  test("increments an existing identity failure counter without a duplicate conflict", async () => {
    const key = `identity-verification|account|${srv.dentistId}`;
    srv.app.db.prepare("DELETE FROM rate_limit_counters WHERE scope_key = ?").run(key);
    srv.app.db.prepare(
      "INSERT INTO rate_limit_counters (scope_key, failures, reset_at) VALUES (?, ?, ?)",
    ).run(key, 1, Date.now() + 60_000);
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://api.ocr.space")) {
        return new Response(JSON.stringify({
          IsErroredOnProcessing: true,
          ErrorMessage: ["Temporary OCR failure"],
        }), { status: 502 });
      }
      return nativeFetch(url, init);
    };

    const response = await api("POST", "/api/identity-verification", {
      token: srv.dentistToken,
      body: { idImageBase64: imageBase64, selfieImageBase64: imageBase64, consent: true },
    });

    assert.equal(response.status, 502);
    assert.equal(srv.app.db.prepare("SELECT failures FROM rate_limit_counters WHERE scope_key = ?").get(key).failures, 2);
  });

  test("returns safe Face++ provider details to the frontend", async () => {
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith("https://api.ocr.space")) {
        return new Response(JSON.stringify({
          IsErroredOnProcessing: false,
          ParsedResults: [{ ParsedText: "Name: Test User" }],
        }), { status: 200 });
      }
      if (String(url).startsWith("https://api-us.faceplusplus.com")) {
        return new Response(JSON.stringify({
          error_code: "MISSING_ARGUMENT",
          error_message: "image_file2 is missing",
        }), { status: 400 });
      }
      return nativeFetch(url, init);
    };
    const response = await api("POST", "/api/identity-verification", {
      token: srv.dentistToken,
      body: { idImageBase64: imageBase64, selfieImageBase64: imageBase64, consent: true },
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.error.message, "Face++ could not compare the images (MISSING_ARGUMENT): image_file2 is missing");
  });
});
