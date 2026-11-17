---
applyTo: "**/*.test.{js,ts,tsx}"
---
# Test rules
- A bug-fix test must **fail before** the fix and **pass after**. Show both runs.
- Test behavior, not implementation. Assert specific status codes, error codes and values, not just "does not throw".
- Never delete, skip (`.skip`, `.todo`) or loosen an existing test to get green. If a test is wrong, explain why and get approval.
- Each test sets up its own data; no dependence on test order, the real `.env`, or a real database.
- Money, auth and permission paths need both an "allowed" test and a "forbidden or invalid" test.
