---
name: dual-db-check
description: Make sure any database or SQL change works on BOTH SQLite (local) and Postgres/Supabase (production). Use whenever you add or change a table, column, index, migration, or SQL query.
---

# Dual-DB check

This project runs on SQLite locally and PostgreSQL (Supabase) in production. `backend/src/postgres-db.js` translates SQLite-flavored SQL to Postgres with regular expressions, so unusual SQL can silently break in production while tests (SQLite) pass.

## Steps
1. **Schema**: any new table/column must be added in BOTH `backend/src/db.js` (SQLite migration, idempotent, run-once safe) AND `backend/supabase/schema.sql`. Show both diffs.
2. **Queries**: read `postgres-db.js` and list which translation rules your SQL relies on (`datetime()`, `LIKE`, `SUM(a = 'x')`, `INSERT OR IGNORE`, `ON CONFLICT`, `COUNT(*) OVER()`...). Prefer plain portable SQL: `CASE WHEN`, `COALESCE`, standard joins, `ON CONFLICT ... DO UPDATE`.
3. **Avoid**: SQLite-only functions (`strftime`, `julianday`, `IFNULL`, `GROUP_CONCAT`), implicit type tricks, booleans stored as ints compared as booleans, `AUTOINCREMENT` assumptions, `LIMIT` inside subqueries with odd ordering.
4. **Dates/times** are TEXT in clinic timezone or UTC ISO. Compare strings only in the same format; use helpers in `lib/time.js`.
5. **Test**: add a test that runs on SQLite. If a Postgres URL is available in CI (`TEST_POSTGRES_URL`), run it there too; otherwise say "Postgres NOT run" in the verify report and give the exact SQL for a human to try in the Supabase SQL editor.
6. **Row-level security**: new Supabase tables must `ENABLE ROW LEVEL SECURITY` like the existing ones.

Never "fix" a Postgres problem by editing only `postgres-db.js` regexes without adding a test for that exact statement.
