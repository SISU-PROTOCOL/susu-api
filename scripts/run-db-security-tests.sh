#!/usr/bin/env bash
#
# Runs the database security guards against DATABASE_URL.
#
# These guards are mandatory for any migration change. They verify two different
# things, and both are needed:
#
#   1. `rls_enabled_guard.sql`  — that RLS is enabled and no policy is
#      unconditionally permissive. These read the catalog.
#   2. `rls_policy_guard.sql`   — that the policies actually restrict access,
#      asserted by acting as each role and checking outcomes.
#
# A table can pass the first and fail the second: RLS enabled, with a policy that
# is subtly too broad. Running only the structural check would report success for
# a table whose rows are readable by anyone.
#
# Requires:
#   * the `psql` client
#   * the migrations already applied (a guard against an empty database passes
#     vacuously and verifies nothing)
#   * the Supabase shims, so `auth.uid()` resolves — see
#     `tests/db/bootstrap_supabase_shims.sql`
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

if ! command -v psql >/dev/null 2>&1; then
  echo "error: psql was not found on PATH." >&2
  echo "Install the PostgreSQL client, or run these guards from a CI job that provides it." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_TESTS_DIR="${SCRIPT_DIR}/../tests/db"

readonly GUARDS=(
  "rls_enabled_guard.sql"
  "rls_policy_guard.sql"
)

# The policy guard asserts on row ownership, so it needs rows to exist and must
# not run against a database where the tables were never created. Check that the
# table it inspects is present, and say so plainly rather than reporting a
# confusing failure from deep inside a plpgsql block.
if ! psql "$DATABASE_URL" -tAc \
  "select 1 from information_schema.tables where table_schema='public' and table_name='profiles'" \
  | grep -q 1; then
  echo "error: public.profiles does not exist." >&2
  echo "Apply the migrations first (pnpm db:migrate), and the Supabase shims if this is not a hosted project." >&2
  exit 1
fi

for guard in "${GUARDS[@]}"; do
  echo "Running ${guard}..."
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "${DB_TESTS_DIR}/${guard}"
done

echo "Database security guards passed."
