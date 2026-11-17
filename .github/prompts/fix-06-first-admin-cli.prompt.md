---
description: C6 - safe first-admin creation for production and demo-account cleanup.
agent: agent
---
Use skills: `plan-first`, `security-review`, `verify`.

Problem: in production there is no supported way to create the first admin; `SEED_ON_START` would create a demo admin with a published password.

Task:
1. Add `backend/scripts/create-admin.js` + `npm run create-admin`: prompts for email and password (hidden input, min 12 chars), refuses if an admin exists unless `--force`, hashes with the existing scrypt helper, never prints the password.
2. Make seeding refuse to run when `NODE_ENV=production`.
3. Add `npm run purge-demo` to delete all `is_demo` users/patients/appointments, with a dry-run flag and a confirmation prompt.
4. Document both in `backend/README.md`.
5. Tests for create-admin logic (extract a pure function) and for the production seed guard.
Never print or log passwords.
