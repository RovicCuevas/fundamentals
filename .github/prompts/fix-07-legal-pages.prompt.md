---
description: C7 - correct Terms/Help/Privacy wording and add consent at registration (draft for lawyer review).
agent: agent
---
Use skills: `plan-first`, `verify`.

Problem: `frontend/app/privacy/page.tsx`, `terms/page.tsx`, `patient/help/page.tsx` are placeholders and say "Payment is over-the-counter only", which contradicts the 50% online PayMongo deposit. Contact details look fake. No consent checkbox on sign-up.

Task:
1. Ask me for: clinic legal name, address, real phone/email, data-protection contact, cancellation policy.
2. Draft the privacy notice covering: what data (identity, contact, appointment, health notes, chat, payments, optional face data), why, who receives it (PayMongo, hosting/Supabase), retention, patient rights (access, correction, deletion, withdraw consent), face-data consent and withdrawal, breach contact. Mark the file header "DRAFT - review by a lawyer/privacy officer (Philippine Data Privacy Act RA 10173)".
3. Fix the payment and cancellation wording in Terms and Help so it matches reality.
4. Add a required consent checkbox (links to Privacy + Terms) in registration; store consent timestamp + policy version in the DB (both SQLite and Postgres); reject registration without it (API + UI + test).
Do not present legal text as final or as legal advice.
