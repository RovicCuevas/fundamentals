---
name: verify
description: Prove a change actually works before saying it is done. Use after ANY code change, before writing a final answer, committing, or when asked to "verify", "check", "test", "make sure it works", or "review your work".
---

# Verify skill

Goal: replace "I think it works" with evidence. Never report success without completing this.

## Steps
1. **List what you changed**: run `git status --short` and `git diff --stat`. Confirm there are no unrelated files, no `.env`, no database files.
2. **Run the full check** from the repo root: `bash scripts/verify.sh` (add `--build` if you touched Next config, fonts, routing or layouts). Copy the real PASS/FAIL lines.
3. **Run the specific test for your change.** Backend: `cd backend && node --test test/<file>.test.js`. If you fixed a bug, show the test failing on the old code (`git stash` the fix, or describe the failing output you saw earlier) and passing now.
4. **Exercise the behavior, not just the tests.** Backend: call the endpoint (in-memory app or `curl` against a local server with demo data) and show status code + body. Frontend: state the exact click path you expect and what you saw; if you cannot open a browser, say "UI NOT RUN".
5. **Re-read your own diff** like a hostile reviewer. Check:
   - Did I call any function/field/endpoint I did not confirm exists? (grep it)
   - Right argument types? (e.g. `ctx.config` vs `ctx`)
   - Error path and empty/null input handled?
   - Works on **both** SQLite and Postgres? (`dual-db-check`)
   - Auth/ownership check present on every new route?
   - Any `any`, `@ts-ignore`, `eslint-disable`, skipped test, swallowed `catch`? Remove it.
6. **Write the report** in this exact shape:

```
VERIFY REPORT
Changed: <files>
Commands run: <command -> PASS/FAIL, key output line>
Behavior checked: <what you called/clicked and the result>
NOT verified: <honest list: browser UI, real PayMongo, Postgres, load, etc.>
Risks: <anything a human must double-check>
```

## Rules
- If any step fails: fix it and re-run from step 2. Do not report partial success as success.
- Never edit or skip a test to make verify pass.
- "NOT verified" must never be empty — there is always something (usually the real browser or real Supabase).
- If `scripts/verify.sh` itself is broken, say so and run the underlying commands manually.
