---
description: C1 - make the server refuse to start with a missing/default JWT secret; stop secret leaks.
agent: agent
---
Use skills: `plan-first`, `security-review`, `verify`. Do NOT open any `.env` file.

Problem: `backend/src/config.js` falls back to a hardcoded dev JWT secret unless `NODE_ENV=production`. A deployment that forgets `NODE_ENV` accepts forged admin tokens.

Task:
1. Plan first (show me the plan, wait for "go").
2. Change config so `JWT_SECRET` is **required always** (min 32 chars). Only allow a dev fallback when `ALLOW_INSECURE_DEV_SECRET=true` is explicitly set, and log a loud warning when used. Same treatment for `FACE_DESCRIPTOR_KEY`.
3. Update `backend/.env.example` and `backend/README.md` (variable names only, no real values).
4. Ensure `.gitignore` covers `.env*` (except `.env.example`), `*.db`, `*.db-wal`, `*.db-shm`, `.next/`, `node_modules/`.
5. Tests: server config throws when secret missing/short; works when set; dev flag works.
6. Tell me (as text, don't do it yourself) the manual steps: rotate the Supabase DB password, PayMongo keys, face key, admin password, and remove `.env` from any git history.

Done when: `bash scripts/verify.sh` passes and tests prove startup refuses without a secret.
