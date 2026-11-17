---
name: plan-first
description: Make a short written plan and get approval before changing code. Use for any task that touches more than one file, auth, payments, refunds, database schema, deletion, or when the request is ambiguous or large.
---

# Plan-first skill

Do NOT edit files until the plan below is written and the human replies "go" (or equivalent).

## Produce this plan
1. **Restatement** (1–2 lines): what problem, what "done" looks like.
2. **Evidence**: files/functions you actually opened (paths + line ranges). If you have not read it, you cannot plan around it.
3. **Change list**: each file -> what changes -> why. Max ~5 files. If more, split into phases.
4. **Risks**: what could break (auth, money, data loss, SQLite vs Postgres, existing tests).
5. **Test plan**: which tests you will add/run, and the failing-first test for bugs.
6. **Out of scope**: things you noticed but will NOT change now.
7. **Open questions**: max 3, only ones that block you.

## Rules
- Prefer the smallest change that solves the problem.
- If two designs are plausible, present both in 2 lines each and recommend one.
- For schema changes: show the exact migration SQL for SQLite and Postgres in the plan.
- After approval, implement exactly the plan. If you discover the plan is wrong, stop and update the plan instead of improvising.
