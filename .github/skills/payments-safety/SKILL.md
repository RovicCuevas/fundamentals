---
name: payments-safety
description: Rules for anything involving PayMongo, deposits, refunds, cancellations, settlement, revenue, or receipts. Use for any change in payments.js, appointment cancellation/reschedule, or money display.
---

# Payments-safety skill

1. **Money is integers.** Pesos in `price_php`, centavos in payment rows. No floats, no `toFixed` math. Display-only formatting at the edge.
2. **Server decides amounts.** Never trust an amount from the client. Re-derive from the service price and compare with PayMongo's reported amount (existing mismatch check must stay).
3. **Idempotent.** A webhook and a polling sync can both fire. Settling twice must not double-record. Use unique keys / `ON CONFLICT`.
4. **Signature first.** Webhook handlers verify the HMAC signature and timestamp window before reading the body.
5. **Helper signatures.** `payMongoRequest(config, path, init)` takes `ctx.config`, NOT `ctx`. Check every call site.
6. **State machine.** Draw the states before coding: `appointment: pending -> confirmed -> completed | cancelled | no_show` and `payment: unpaid -> pending -> paid -> refunded | expired | failed`. List every allowed transition and who can trigger it. Reject all others.
7. **Refunds** must call PayMongo's refund API, store a refund row (amount, reason, provider id, status), and be idempotent. Never mark "refunded" in our DB before the provider confirms.
8. **Tests mock PayMongo** via `globalThis.fetch`. Cover: success, failed/pending payment object, duplicate webhook, bad signature, amount mismatch, provider 5xx.
9. **Human approval required** before merging anything in this skill's scope. Say so in the final report.
10. **Policy first.** Do not invent a cancellation/refund policy. Ask the clinic owner for the rule (e.g. free cancel until X hours before) and encode it as a config value, not a magic number.
