# SmartCare Dental — rules for the coding agent

Project: dental appointment booking. `backend/` = plain Node 22 (ESM, no framework, `node:test`), SQLite **and** Postgres (Supabase). `frontend/` = Next.js 16 + React 19 + TypeScript + Tailwind. Frontend calls the backend through the `/api/*` rewrite (same-origin cookies).

## Hard rules (never break these)
1. **Never read, print, edit, create or commit `.env*` files or any secret.** Use `.env.example` for names only. Never paste a real key, token or password into code, tests, docs or chat.
2. **Never claim something works unless you ran it.** "Should work" is not allowed. Run `scripts/verify.sh` (or the specific command) and quote the real result. If you could not run it, say "NOT RUN" explicitly.
3. **Do not invent APIs, files, functions, env vars, columns or package versions.** Search the repo first (`grep`/usages). If you cannot find it, say so and ask. Check `node_modules/<pkg>` or official docs for library APIs. Next.js 16 and React 19 differ from older versions you may remember.
4. **Small, reviewable changes.** One issue per task, max ~5 files per change. No drive-by refactors, renames, formatting sweeps or dependency upgrades. If you want to do more, list it as a follow-up.
5. **Plan first, code second.** For anything beyond a 1-line fix, state: files to change, risk, and how you will verify. Wait for approval on money, auth, database schema, and deletion changes.
6. **Reproduce before fixing.** Write or run a test that fails for the bug, then fix, then show it passes. Add a regression test for every bug fix.
7. **Do not weaken checks to make them pass.** Never delete/skip tests, loosen assertions, add `// @ts-ignore`, `eslint-disable`, `any`, or catch-and-swallow errors to get green.
8. **Auth, money, privacy are high-risk.** Anything touching login, JWT, rate limits, payments/refunds, patient data, face data needs the `security-review` skill and explicit human approval.
9. **Database changes go through the migration path in `backend/src/db.js` AND the Postgres schema `backend/supabase/schema.sql`.** Never change only one. Use the `dual-db-check` skill.
10. **Be honest about uncertainty.** If a requirement is ambiguous, ask one precise question instead of guessing. If you made a mistake, say so and fix it.

## Working style
- Read the existing code and tests for the area before editing. Match existing patterns (`ctx`, `app.router`, `validate.js`, `errors.js`).
- Backend validation uses `src/lib/validate.js`; errors use `src/lib/errors.js`. Do not hand-roll replacements.
- All SQL is parameterized (`?`). Never build SQL with string concatenation of user input.
- Clinic time is Asia/Manila; use helpers in `src/lib/time.js`, never `new Date()` date math in routes.
- Money: integers (PHP pesos / centavos). Never floats.
- Frontend: TypeScript strict, no `any`; call the API only through `frontend/lib/*`; show loading, error and empty states.

## Definition of done (every task)
- [ ] `scripts/verify.sh` passes (tests, tsc, eslint) and you pasted the real output summary
- [ ] New/changed behavior has a test
- [ ] No secrets, no `.env`, no unrelated file changes (`git diff --stat` reviewed)
- [ ] Summary written: what changed, what was verified, what was NOT verified, risks, follow-ups

## Final answer format
**Changed:** files + one line each · **Verified:** commands + results · **Not verified:** honest list · **Risks / follow-ups:** list
