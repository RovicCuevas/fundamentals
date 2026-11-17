# Fix plan (from the system analysis report)

Work **one item at a time**, in this order. For each: open Copilot Chat in Agent mode, run the prompt, review the plan, say "go", then run `/review-my-changes`, then commit.

| # | Item | Prompt | Risk |
|---|------|--------|------|
| 0 | Rotate secrets by hand (DB password, PayMongo keys, face key, admin password); remove `.env` from git history | (manual) | HIGH |
| 1 | C4 payment `ctx` bug (smallest, quick win, builds trust in the workflow) | `/fix-04-payment-ctx-bug` | low |
| 2 | C1 mandatory JWT secret | `/fix-01-secrets-and-jwt` | HIGH |
| 3 | C2 mark completed | `/fix-02-mark-completed` | med |
| 4 | C3 expire unpaid bookings | `/fix-03-expire-unpaid-bookings` | med |
| 5 | C6 first-admin CLI + demo purge | `/fix-06-first-admin-cli` | HIGH |
| 6 | H7 privacy leaks | `/fix-09-privacy-leaks` | low |
| 7 | H2 rate limiter behind proxy | `/fix-08-rate-limit-proxy` | HIGH |
| 8 | C7 legal pages + consent (needs lawyer review) | `/fix-07-legal-pages` | HIGH |
| 9 | C5 cancel/reschedule/refund (needs clinic policy) | `/fix-05-cancel-reschedule-refund` | HIGH |
| 10 | H8 notifications, reminders, password reset | `/fix-10-notifications-and-password-reset` | med |
| 11 | H1 face login hardening | `/fix-11-face-login-hardening` | HIGH |

Later (from the report, no prompt yet): H3 database/async decision, H4 service durations, H5 hardcoded "petil" rule, H6 staff roles, dependents, intake forms, audit log, waitlist, treatment plans. Write them as prompts using the same pattern when you get there.

Mark items done here with the commit hash.

## The daily loop
1. `/00-start-session`
2. Run the next prompt. **Read the plan before saying "go".**
3. Agent implements -> it must produce a VERIFY REPORT.
4. You run `bash scripts/verify.sh` yourself (never trust the report alone).
5. `/review-my-changes` (read-only reviewer agent; ideally switch to a *different* model for this).
6. Click through the feature yourself in the browser for 2 minutes.
7. Commit small, push, check CI is green.
