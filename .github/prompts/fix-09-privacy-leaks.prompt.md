---
description: H7 - hide time-off reasons publicly, cap SSE connections, other small leaks.
agent: agent
---
Use skills: `fix-with-test`, `security-review`, `verify`.

1. Reproduce: unauthenticated `GET /api/dentists/:id/schedule` (and availability) returns time-off `reason`. Write a failing test that asserts it is absent for anonymous users and patients, present for admin.
2. Fix: public/patient responses show only "Unavailable".
3. Public SSE (`/api/catalog/stream`): add a global cap and per-IP cap (config), return 503 over the cap, and clean up on close. Test with many connections.
4. Audit every unauthenticated route (list them in a table: route, fields returned, sensitive?) and report any other leaks; fix only the clear ones.
