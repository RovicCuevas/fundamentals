---
description: H1 - make face login a safer optional second factor.
agent: agent
---
Use skills: `plan-first`, `security-review`, `verify`. HUMAN APPROVAL REQUIRED.

Problem: no liveness; raw descriptors accepted by API; 1:N search at threshold 0.6 across all users.
Task options - present both and recommend one before coding:
A) Face as optional second step AFTER password (1:1 match against that account), threshold ~0.45-0.5, never allowed for admin alone.
B) Replace with passkeys (WebAuthn).
Whatever is chosen: stricter threshold in config, rate limits (see fix-08), consent + delete-my-face-data endpoint and button, audit log of face enrollments/logins, tests for mismatch/replay-of-wrong-user.
