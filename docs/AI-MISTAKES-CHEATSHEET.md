# How AI coding agents go wrong - and the guard for each

| Mistake | Real example from this project | Guard |
|---|---|---|
| Wrong argument, code "looks right" | `payMongoRequest(ctx, ...)` instead of `ctx.config` | Types/tests, `verify` step 5, CI grep guard |
| Claims success without running anything | An earlier draft of `verify.sh` reported PASS while a test was failing | Rule 2; always run `scripts/verify.sh` yourself |
| Invents functions, columns, env vars, APIs | - | Rule 3: grep first, ask when not found |
| Fixes the symptom, not the cause | Hiding a 503 instead of fixing the call | `fix-with-test` skill |
| Weakens tests/types to get green | `@ts-ignore`, `.skip`, loosened asserts | Rule 7 + `tests.instructions.md` + reviewer |
| Works on SQLite, breaks on Postgres | Regex-translated SQL | `dual-db-check` skill |
| Big sprawling diffs | Renames + refactors mixed in | Rule 4: one issue, ~5 files |
| Silent scope creep | "While I was here I also..." | "Out of scope" section in `plan-first` |
| Stale library knowledge | Next.js 16 / React 19 changes | Rule 3: check `node_modules` / official docs |
| Touching secrets | Reading or printing `.env` | Rule 1, CI secret check |
| Confident tone hiding uncertainty | "This should fix it" | Required "NOT verified" section |
| Looping on the same error | Repeats a failed approach | `/stuck-help` prompt |

## Tips for smaller / cheaper models
- Give ONE task, with file paths. Say which files to read first.
- Ask for the plan separately from the code (two messages).
- If it drifts after ~15 turns, start a **new chat** and run `/00-start-session` again; long chats degrade.
- Paste exact error text, not a paraphrase.
- Use a different model for `/review-my-changes` than the one that wrote the code.
- Instructions are advice; **tests and CI are the enforcement**. Keep them green.
