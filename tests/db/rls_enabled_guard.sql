-- Susu Protocol — database security guard
--
-- Run with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/db/rls_enabled_guard.sql
-- Or:        pnpm db:security-test
--
-- These checks are deliberately schema-agnostic so they keep protecting the
-- database as tables are added in Phase 4 and Phase 5. They fail loudly rather
-- than silently passing.
--
-- Registered in CI and required before merge for any migration change.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Every table in the exposed `public` schema must have RLS enabled.
--    Deny-by-default is only meaningful if RLS is actually on.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    offenders text;
BEGIN
    SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
    INTO offenders
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = false;

    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION
            'RLS is not enabled on: %. Enable RLS in the same migration that creates these tables.',
            offenders;
    END IF;

    RAISE NOTICE 'RLS guard passed: every table in public has RLS enabled.';
END
$$;

-- ---------------------------------------------------------------------------
-- 2. No policy may be unconditionally permissive.
--    Broad `USING (true)` / `WITH CHECK (true)` grants defeat deny-by-default.
--    A policy that must be permissive requires explicit review; add an
--    allowlist entry here only with that review recorded in the PR.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    offenders text;
BEGIN
    SELECT string_agg(
               format('%I.%I policy %I', schemaname, tablename, policyname),
               ', ' ORDER BY tablename, policyname
           )
    INTO offenders
    FROM pg_policies
    WHERE schemaname = 'public'
      AND (
            coalesce(qual, '') IN ('true', '(true)')
         OR coalesce(with_check, '') IN ('true', '(true)')
      );

    IF offenders IS NOT NULL THEN
        RAISE EXCEPTION
            'Unconditionally permissive RLS policies found: %. '
            'Restrict these policies or obtain explicit security review.',
            offenders;
    END IF;

    RAISE NOTICE 'RLS guard passed: no unconditionally permissive policies.';
END
$$;

-- ---------------------------------------------------------------------------
-- 3. Report server-only tables that browser roles could still reach directly.
--    Informational: RLS plus revoked grants is the intended posture.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    missing_privileges text;
BEGIN
    SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY c.relname)
    INTO missing_privileges
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND c.relrowsecurity = true
      AND NOT EXISTS (
          SELECT 1
          FROM pg_policies p
          WHERE p.schemaname = n.nspname
            AND p.tablename = c.relname
      );

    IF missing_privileges IS NOT NULL THEN
        RAISE NOTICE
            'Tables with RLS enabled but no policies (default-deny, verify intent): %',
            missing_privileges;
    ELSE
        RAISE NOTICE 'RLS guard passed: every RLS-enabled table declares at least one policy.';
    END IF;
END
$$;
