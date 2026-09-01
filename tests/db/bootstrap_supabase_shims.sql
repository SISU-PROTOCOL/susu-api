-- Susu Protocol — Supabase shims for plain PostgreSQL
--
-- Run BEFORE migrations:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/db/bootstrap_supabase_shims.sql
--
-- WHY THIS EXISTS
-- A hosted Supabase project supplies the roles `anon`, `authenticated` and
-- `service_role`, the `auth` schema, the `auth.users` table and the `auth.uid()`
-- function. Plain PostgreSQL supplies none of them.
--
-- Without these shims, CI would apply the migrations to a database where
-- `auth.users` does not exist, so the conditional foreign key in
-- `drizzle/0000_profiles.sql` would silently take its "skip" branch on every
-- run. The constraint that this project depends on in production — deleting a
-- user removes their profile — would then never be exercised, and the guard
-- would pass no matter what the constraint said. A test that cannot fail is not
-- a test, so the shims exist to make CI match the environment the migration was
-- written for.
--
-- This file creates only what is absent, so running it against a real project is
-- a no-op. It is test scaffolding and is never applied outside CI or a local
-- test database.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- Browser and server roles.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- The auth schema and the table the profile cascades from.
--
-- Only the primary key is modelled. The guard tests referential behaviour, not
-- the columns Supabase manages, and a faithful copy of `auth.users` would be a
-- copy that drifts the moment Supabase changes it.
-- ---------------------------------------------------------------------------
create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key
);

-- ---------------------------------------------------------------------------
-- auth.uid(), matching the definition Supabase installs.
--
-- It reads the subject out of the request claims, which is what makes it
-- trustworthy: the value comes from the verified JWT the platform placed in the
-- session, not from anything the client sent as a parameter. The two settings
-- mirror Supabase, which has used both spellings; supporting both means a test
-- written either way behaves the same.
--
-- SECURITY INVOKER and STABLE, as in Supabase. It reads session state and
-- writes nothing, so there is no reason for it to run with any other privilege.
-- ---------------------------------------------------------------------------
create or replace function auth.uid()
returns uuid
language sql
stable
security invoker
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;

-- `authenticated` must be able to call it; Supabase grants this too.
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

do $$
begin
  raise notice 'Supabase shims ready: roles, auth.users, auth.uid().';
end
$$;

-- ---------------------------------------------------------------------------
-- Storage, as far as this project's migrations touch it.
--
-- The avatar bucket and its policies live in `storage`, which a hosted project
-- supplies and plain PostgreSQL does not. Without a model of it, the migration
-- that creates `profile-images` would take its "storage is not installed" branch
-- on every CI run, and the policies that are the entire access control for a
-- user's photo would never be executed by a test. That is the same reasoning as
-- the `auth` shim above: the guard has to be able to fail.
--
-- Only the columns the policies and their tests read are modelled. `foldername`
-- and `filename` are reimplemented with Supabase's semantics — the path split on
-- `/`, dropping the last segment — because a policy written against a different
-- notion of "folder" would pass here and deny in production. Both are created
-- only if absent, so this file remains a no-op against a real project rather
-- than a replacement for Storage's own functions.
-- ---------------------------------------------------------------------------
create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  public boolean default false not null,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets (id),
  name text not null,
  owner uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  unique (bucket_id, name)
);

-- Matches Supabase: every object is denied until a policy allows it.
alter table storage.objects enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'storage' and p.proname = 'foldername'
  ) then
    execute $fn$
      create function storage.foldername(name text)
      returns text[]
      language plpgsql
      immutable
      as $body$
      declare
        parts text[];
      begin
        parts := string_to_array(name, '/');
        return parts[1 : array_length(parts, 1) - 1];
      end;
      $body$
    $fn$;
  end if;

  if not exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'storage' and p.proname = 'filename'
  ) then
    execute $fn$
      create function storage.filename(name text)
      returns text
      language plpgsql
      immutable
      as $body$
      declare
        parts text[];
      begin
        parts := string_to_array(name, '/');
        return parts[array_length(parts, 1)];
      end;
      $body$
    $fn$;
  end if;
end
$$;

grant usage on schema storage to anon, authenticated, service_role;

-- Hosted Supabase grants the browser roles broad table privileges on
-- `storage.objects` and relies on RLS alone to deny: the platform's own policies
-- are the control, and a missing grant would deny for a reason that has nothing
-- to do with this project's policies. Mirroring that here keeps the guard
-- honest — a denial in CI is a policy denial, as it would be in production.
grant all on storage.objects to anon, authenticated, service_role;
grant select on storage.buckets to service_role;

do $$
begin
  raise notice 'Supabase storage shims ready: buckets, objects, foldername, filename.';
end
$$;
