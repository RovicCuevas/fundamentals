---
name: fix-with-test
description: Fix a bug the safe way - reproduce it with a failing test first, fix it, show the test passing, and add a regression test. Use for any bug report, error message, or "this is broken" task.
---

# Fix-with-test skill

1. **Reproduce.** Find the code path. Write the smallest test that fails *because of the bug* (backend: `backend/test/`, in-memory app pattern from `api.test.js`). Run it and paste the failing output. If you cannot reproduce, say so — do not "fix" blindly.
2. **Find the root cause.** State it in one sentence with file + line. Distinguish the cause from the symptom.
3. **Fix minimally.** Change only what the root cause needs.
4. **Prove it.** Re-run the new test (now passing), then `bash scripts/verify.sh`.
5. **Look for siblings.** `grep` for the same mistake elsewhere (e.g. other calls with the wrong argument, other queries with the same flaw). Fix or list them.
6. **Report** using the `verify` skill's report format, including "test failed before / passes after".

Never: change the test to match the bug, add a try/catch that hides the error, or fix several unrelated bugs in one change.
