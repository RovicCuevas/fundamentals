---
name: security-review
description: Security checklist for changes to login, JWT, cookies, rate limiting, passwords, face login, roles/permissions, patient data, file/image uploads, or public endpoints. Use before finishing any such change.
---

# Security-review skill

Answer every item with **yes / no / n.a. + file:line evidence**. Any "no" must be fixed or explicitly escalated to the human.

## Auth & sessions
- [ ] No secret has a hardcoded fallback. Server refuses to start without `JWT_SECRET` (unless an explicit dev flag).
- [ ] Cookies: `HttpOnly`, `SameSite`, `Secure` in production. Token never stored in localStorage.
- [ ] Passwords hashed (scrypt, existing helper). Compared with timing-safe equality.
- [ ] Password change/reset invalidates old sessions or uses short-lived tokens. Reset tokens are random, single-use, hashed in DB, expire quickly.

## Authorization
- [ ] Every new route checks the role AND ownership (a patient can only touch their own records).
- [ ] Unknown/forbidden records return 404 where existence should not leak.
- [ ] Public endpoints return only public fields (no time-off reasons, emails, phone numbers, notes).

## Abuse resistance
- [ ] Rate limit on login, register, face login, password reset, message sending, booking creation.
- [ ] Limiter uses the real client IP from a *trusted* proxy header, counts failures (not successes), is per-account AND per-IP.
- [ ] Caps exist: pending bookings per patient, open SSE connections, upload size, message length.

## Input & data
- [ ] All input validated via `lib/validate.js`; all SQL parameterized.
- [ ] No sensitive data in logs (tokens, passwords, face descriptors, card/payment data, full request bodies).
- [ ] Uploads: type + size checked; served with safe headers.
- [ ] Errors do not leak stack traces or SQL to clients.

## Biometrics (face data)
- [ ] Consent recorded before enrollment; can be withdrawn and data deleted.
- [ ] Descriptors encrypted at rest; key from env, never in code.
- [ ] Face login is documented as lower assurance (no liveness). Not used for admin without a second factor.

Output: the checklist with evidence, plus a list of residual risks for a human reviewer.
