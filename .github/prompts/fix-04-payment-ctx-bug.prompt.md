---
description: C4 - fix payMongoRequest(ctx) -> ctx.config bug with a regression test.
agent: agent
---
Use skills: `fix-with-test`, `payments-safety`, `verify`.

Bug: `backend/src/routes/payments.js` (~line 176) calls `payMongoRequest(ctx, ...)` in the branch that fetches a payment that is not paid yet. The function expects the config object (`ctx.config`), so it throws 503 `payment_not_configured`.

Task:
1. Find every call to `payMongoRequest` and list its first argument. Show the list.
2. Add a test (mock `globalThis.fetch`) where the checkout session lists a payment whose status is `failed`/`pending`. It must fail now with 503.
3. Fix all wrong call sites. Re-run: test passes.
4. Add a second test: after a failed attempt, the patient can create a new checkout session.
5. Also add a lint-like guard: a test that greps `src/` for `payMongoRequest(ctx,` and fails if found.
Done when: failing-before / passing-after is shown, verify passes.
