---
description: C3 - expire unpaid pending bookings, cap pending per patient, throttle registration.
agent: agent
---
Use skills: `plan-first`, `fix-with-test`, `security-review`, `dual-db-check`, `payments-safety`, `verify`.

Problem (reproduced): one new account booked 53 unpaid slots and blocked a dentist's calendar. Nothing expires `pending` appointments; registration has no throttle or verification.

Task (plan first):
1. First write a failing test that books many unpaid slots with one account.
2. Config values (env with defaults): `PENDING_PAYMENT_TTL_MIN=30`, `MAX_PENDING_PER_PATIENT=2`.
3. Extend the existing 60-second lifecycle timer: pending + unpaid + older than TTL -> `cancelled` (reason `payment_timeout`), payment row -> `expired`, slot freed, SSE event pushed. Do not touch pending appointments that are paid.
4. Enforce the per-patient pending cap in the create-appointment route with a clear error code and message.
5. Rate-limit `POST /api/auth/register` (per IP) using the existing limiter. Do not break the existing tests.
6. Frontend: show the remaining time to pay on pending appointments and handle the new error code in the booking form.
Done when: the original abuse test now fails to hog slots, verify passes.
