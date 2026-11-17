---
description: Start every coding session with this. Loads the rules and picks ONE task.
agent: agent
---
Before doing anything:
1. Read `.github/copilot-instructions.md`, `AGENTS.md`, and `docs/FIX-PLAN.md`.
2. Run `git status --short` and `git log --oneline -5`. Tell me if the working tree is dirty.
3. Run `bash scripts/verify.sh` and show me the baseline result (so we know what was already broken).
4. Do NOT change any file yet. Tell me which task in `docs/FIX-PLAN.md` is next and ask me to confirm.
Rules: never open `.env`; one task at a time; no claims without evidence.
