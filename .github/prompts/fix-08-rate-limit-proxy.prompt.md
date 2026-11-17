---
description: H2 - correct client IP behind a proxy, count only failures, per-account + per-IP limits.
agent: agent
---
Use skills: `plan-first`, `fix-with-test`, `security-review`, `verify`.

Problem: `backend/src/lib/security.js` + `routes/auth.js` key limits on `req.socket.remoteAddress`. Behind the Next rewrite proxy everyone shares one IP. Face login counts successes and never resets, so one global bucket of 10 per 15 minutes locks the whole clinic; password lockout lets an attacker lock the admin out.

Task:
1. Add `TRUST_PROXY` config (number of proxy hops, default 0). Add `clientIp(req)` reading `X-Forwarded-For` only when trusted.
2. Count failed attempts only; clear on success (including face login).
3. Keys: per-IP and per-account; password failures lock the (IP+account) pair, with a separate higher per-IP ceiling. Never lock an admin out purely from anonymous traffic - add a generic delay instead.
4. Persist counters in the DB table (SQLite + Postgres) or document the single-instance limitation.
5. Tests: 10 successful face logins don't lock; spoofed `X-Forwarded-For` ignored when `TRUST_PROXY=0`; attacker IP cannot lock a different IP's login.
