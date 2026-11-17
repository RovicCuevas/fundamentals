---
description: C5 - patient cancel/reschedule UI + cancellation policy + PayMongo refunds.
agent: agent
---
Use skills: `plan-first`, `payments-safety`, `security-review`, `dual-db-check`, `verify`. HUMAN APPROVAL REQUIRED before merge.

Problem: patients can cancel only unpaid pending bookings; no reschedule UI (API exists: POST reschedule); no refund code anywhere.

Step 0: ask me for the clinic's policy (e.g. free cancel/reschedule until N hours before; otherwise deposit forfeited; clinic-initiated cancel = full refund). Put N and rules in config. Do NOT invent a policy.

Phase A (plan, then implement after approval):
1. Draw the appointment x payment state machine in the plan.
2. Migration: `appointment_refunds` table (SQLite + Postgres), idempotent.
3. Backend: refund helper calling PayMongo's refund endpoint; idempotent; only mark refunded after provider confirms; extend webhook to handle refund events and payment failed/expired.
4. Backend: cancellation applies the policy (refund or forfeit) and returns what happened. Clinic-initiated cancel always refunds.
5. Tests with mocked PayMongo: refund success, provider error, duplicate request, outside policy window, patient cannot cancel someone else's booking.
Phase B (separate change): frontend Cancel + Reschedule buttons for all upcoming states, policy text shown before confirming, refund status displayed, reschedule slot picker reusing the booking components.
