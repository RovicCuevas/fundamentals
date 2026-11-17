## What & why
<!-- one issue per PR; link the FIX-PLAN item (e.g. C4) -->

## Verification (paste real output, no "should work")
- [ ] `bash scripts/verify.sh` -> PASS
- [ ] New/changed behavior has a test (bug fixes: failed before, passes after)
- [ ] Tried it manually: <exact steps and result>

## Not verified
<!-- be honest: browser UI, real PayMongo, Postgres, ... -->

## High-risk checklist (auth / money / patient data / schema)
- [ ] `security-review` checklist done
- [ ] SQLite AND Postgres schema updated (`dual-db-check`)
- [ ] No secrets, no `.env`, no unrelated changes
