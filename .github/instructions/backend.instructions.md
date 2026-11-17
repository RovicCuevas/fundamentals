---
applyTo: "backend/src/**"
---
# Backend rules
- Pure Node ESM, no Express. Routes are registered on the router and receive `ctx` (`ctx.req`, `ctx.res`, `ctx.user`, `ctx.body`, `ctx.query`, `ctx.params`, `ctx.config`, `ctx.db`). Open one existing route file first and copy its shape.
- **Pass `ctx.config` to helpers that need config, not `ctx`.** (A real past bug: `payMongoRequest(ctx, ...)` instead of `ctx.config`.) Check each helper's signature before calling it.
- Validate input with `lib/validate.js`; throw `ApiError` from `lib/errors.js`. Return 404 (not 403) for records the user may not know exist.
- Multi-step writes go inside `db.tx(...)`. Do not `await` inside a transaction callback.
- Every new query must work on SQLite and Postgres (see the `dual-db-check` skill).
- New endpoint checklist: auth required? role check? ownership check? input validated? rate limit needed? test added? `docs/API.md` updated?
- Never log request bodies, tokens, passwords, face descriptors or payment data.
- Tests live in `backend/test/*.test.js`, run with `npm test` inside `backend/`. Use the in-memory app pattern from `api.test.js`. Mock PayMongo via `globalThis.fetch`; never call real PayMongo.
