---
description: H8 - email/SMS notifications, reminders, forgot-password and email verification.
agent: agent
---
Use skills: `plan-first`, `security-review`, `dual-db-check`, `verify`. Do this in 3 separate changes, each verified and committed.

Ask me first: which email provider and SMS provider I will use (do not pick one), and the sender details.

Change 1 - notification layer: `services/notifier.js` with a provider interface and a `console` provider for dev/tests; `notification_log` table (SQLite + Postgres); templates for: booking received, confirmed, cancelled by clinic, payment received, reminder 24h and 2h before. Providers read keys from env only.
Change 2 - reminders: scheduled job (existing timer) that sends each reminder once (idempotent via the log), skips cancelled/past appointments, and respects patient opt-out.
Change 3 - accounts: forgot-password (random single-use token, store only its hash, 30 min expiry, rate-limited, same response whether email exists or not, invalidate sessions after reset) and email verification on registration.
Tests use the console provider; no real sends.
