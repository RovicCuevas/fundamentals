#!/usr/bin/env bash
# One command to prove a change is safe. Run from anywhere:  bash scripts/verify.sh
# Optional: bash scripts/verify.sh --build   (also runs the Next production build; needs internet for Google Fonts)
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2
FAILED=0
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[32mPASS\033[0m %s\n' "$1"; }
bad()  { printf '\033[31mFAIL\033[0m %s\n' "$1"; FAILED=1; }

# run LABEL DIR TAIL_LINES COMMAND...   -> runs in DIR, prints last lines, records the REAL exit code
run() {
  local label="$1" dir="$2" lines="$3"; shift 3
  ( cd "$dir" && "$@" ) >"$TMP" 2>&1
  local rc=$?
  tail -n "$lines" "$TMP"
  if [ "$rc" -eq 0 ]; then ok "$label"; else bad "$label (exit code $rc)"; fi
}

step "1. Secret hygiene"
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git ls-files | grep -E '(^|/)\.env' | grep -vE '\.example$' | grep -q .; then
    bad ".env file is tracked by git -> git rm --cached <file>, then ROTATE the secrets"
  else ok "no .env files tracked"; fi
  if git ls-files | grep -E '\.(db|db-wal|db-shm|sqlite)$' | grep -q .; then
    bad "database file is tracked by git (may contain patient data)"
  else ok "no database files tracked"; fi
  if git diff --cached --name-only | xargs -r grep -lE '(sk_(test|live)_[A-Za-z0-9]{10,}|whsec_[A-Za-z0-9]{10,}|postgres(ql)?://[^ ]*:[^ ]*@)' 2>/dev/null | grep -q .; then
    bad "possible secret in staged changes"
  else ok "no obvious secrets in staged changes"; fi
else
  echo "(not a git repo - git checks skipped)"
fi

step "2. Backend tests"
if [ -d backend ]; then
  [ -d backend/node_modules ] || (cd backend && npm ci >/dev/null 2>&1)
  # Hide .env so tests can never touch the real database or payment account.
  HIDDEN=0
  if [ -f backend/.env ]; then mv backend/.env backend/.env.verify-hidden && HIDDEN=1; fi
  run "backend tests" backend 25 npm test
  if [ "$HIDDEN" = 1 ]; then mv backend/.env.verify-hidden backend/.env; fi
fi

if [ -d frontend ]; then
  [ -d frontend/node_modules ] || (cd frontend && npm ci >/dev/null 2>&1)
  step "3. Frontend types (tsc)"
  (cd frontend && npx next typegen >/dev/null 2>&1)
  run "tsc" frontend 30 npx tsc --noEmit

  step "4. Frontend lint"
  run "eslint" frontend 30 npx eslint

  if [ "${1:-}" = "--build" ]; then
    step "5. Frontend production build"
    BACKEND_URL="${BACKEND_URL:-http://localhost:4000}" run "next build" frontend 30 npx next build
  fi
fi

step "Result"
if [ "$FAILED" -eq 0 ]; then printf '\033[32mALL CHECKS PASSED\033[0m\n'; else printf '\033[31mSOME CHECKS FAILED\033[0m - do not claim the task is done\n'; fi
exit $FAILED
