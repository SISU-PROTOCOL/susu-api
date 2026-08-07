#!/usr/bin/env bash
#
# Runs the database security guards against DATABASE_URL.
#
# These guards are mandatory for any migration change. They verify that RLS is
# enabled on every exposed table and that no policy is unconditionally permissive.
#
# Requires the `psql` client.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"

if ! command -v psql >/dev/null 2>&1; then
  echo "error: psql was not found on PATH." >&2
  echo "Install the PostgreSQL client, or run these guards from a CI job that provides it." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD_FILE="${SCRIPT_DIR}/../tests/db/rls_enabled_guard.sql"

echo "Running database security guards against the configured database..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$GUARD_FILE"
echo "Database security guards passed."
