---
description: C2 - add "Mark completed" to the admin UI and stop auto no-show from mislabeling attended visits.
agent: agent
---
Use skills: `plan-first`, `fix-with-test`, `verify`.

Problem: no UI path sets an appointment to `completed`. `frontend/lib/appointments.ts` `updateAppointmentStatus` type excludes it; `frontend/app/admin/schedule/page.tsx` only offers confirm/decline/no-show. The backend status route (`backend/src/routes/appointments.js`) supports it. A background job (`backend/src/services/appointment-lifecycle.js`) flips unattended confirmed appointments to `no_show` 24h after the end.

Task (plan first, then implement):
1. Frontend: allow `completed` in the type; add a "Mark completed" button on confirmed appointments in the admin schedule and the workspace page, with a confirm step and error handling. Only enabled once the appointment start time has passed.
2. Backend: reject `completed`/`no_show` for appointments that have not started yet (the current `too_early` check lets same-day future ones through). Add a test.
3. Replace the automatic `no_show` flip with a "needs attention" state: keep the data, but do NOT change status automatically. Add an admin list/badge "Past appointments awaiting outcome". Ask me before choosing between "flag only" and "auto-flip after N days"; default to flag-only.
4. Verify analytics (`completedRevenuePhp`, ledger CSV, settlement) now work end-to-end with a test: book -> confirm -> complete -> settle -> appears in ledger.
5. Patient side: after completion the review form must appear (check `patient-appointments.tsx`).

Done when: verify passes + an API-level test covers the full flow + you list what UI you could not click.
