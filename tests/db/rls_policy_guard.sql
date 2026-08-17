-- Susu Protocol — RLS policy guard
--
-- Run with:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/db/rls_policy_guard.sql
--
-- Requires the migrations to have been applied, and the Supabase shims
-- (`bootstrap_supabase_shims.sql`) to exist so `auth.uid()` resolves.
--
-- WHY THIS IS SEPARATE FROM `rls_enabled_guard.sql`
-- That guard answers "is RLS switched on?". This one answers "does it actually
-- keep anyone out?". The two are not the same question, and only the first can
-- be answered by reading catalog flags. A table can have RLS enabled and a
-- policy that is subtly too broad — `using (true)`, a missing `with check`, a
-- comparison against the wrong column — and every structural check still passes.
--
-- So these tests act as the roles themselves and assert on outcomes: what a user
-- can see, what they can change, and what they are refused. Where an operation
-- must be refused, the test fails if it *succeeds*.
--
-- WHY ROLE AND CLAIMS ARE SET AT SESSION LEVEL
-- An earlier draft used `set local role` / `set local "request.jwt.claim.sub"`
-- inside `begin ... rollback`. That works in psql, but it makes every assertion
-- depend on transaction-scoped settings surviving correctly across a caught
-- exception, and it cannot be exercised by a driver that manages transactions
-- differently. Setting the role and the claim for the session, and resetting
-- them explicitly, keeps each assertion self-contained: it does not matter what
-- the previous test did, or how the statements were batched.
--
-- Data-mutating assertions are still wrapped in a transaction that is rolled
-- back, so the guard leaves no rows behind and can be run repeatedly.

\set ON_ERROR_STOP on

-- Fixed identifiers so failures name a specific user rather than a value that
-- changes each run.
\set user_one '''11111111-1111-1111-1111-111111111111'''
\set user_two '''22222222-2222-2222-2222-222222222222'''

-- ---------------------------------------------------------------------------
-- Fixtures.
--
-- Seeded as the connecting (super)user, which owns the table and so is not
-- subject to its policies. `on conflict` keeps re-runs safe.
-- ---------------------------------------------------------------------------
insert into auth.users (id) values (:user_one), (:user_two)
on conflict (id) do nothing;

insert into public.profiles (user_id, display_name) values
  (:user_one, 'User One'),
  (:user_two, 'User Two')
on conflict (user_id) do nothing;

-- Fail before the assertions if referential behaviour is wrong, so the cause is
-- named rather than showing up as a confusing count mismatch later.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'f'
      and confdeltype = 'c'
  ) then
    raise exception
      'profiles has no ON DELETE CASCADE foreign key. Deleting a user would leave their profile behind.';
  end if;
  raise notice 'ok: profiles cascades from auth.users';
end
$$;

-- ---------------------------------------------------------------------------
-- 1. Anonymous users are refused, by privilege rather than by policy.
-- ---------------------------------------------------------------------------
reset role;
select set_config('request.jwt.claim.sub', '', false);
set role anon;

do $$
declare denied boolean := false;
begin
  begin
    perform count(*) from public.profiles;
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'anon was able to read public.profiles';
  end if;
  raise notice 'ok: anon cannot read profiles';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    insert into public.profiles (user_id, display_name)
    values ('33333333-3333-3333-3333-333333333333', 'anon');
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'anon was able to write to public.profiles';
  end if;
  raise notice 'ok: anon cannot write profiles';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 2. A signed-in user sees their own profile and no one else's.
--    The second assertion is the ownership boundary: two rows exist, and one
--    must be invisible.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claim.sub', :user_one, false);
set role authenticated;

do $$
declare n int;
begin
  select count(*) into n from public.profiles
  where user_id = '11111111-1111-1111-1111-111111111111';
  if n <> 1 then
    raise exception 'user one could not read their own profile (saw % row(s))', n;
  end if;
  raise notice 'ok: user reads their own profile';
end
$$;

do $$
declare n int;
begin
  select count(*) into n from public.profiles;
  if n <> 1 then
    raise exception 'user one saw % profile(s); the policy is not restricting rows to the owner', n;
  end if;
  raise notice 'ok: user cannot see other profiles';
end
$$;

-- ---------------------------------------------------------------------------
-- 3. A user may edit their own fields, and may not reach another user's row.
--    The successful update is transactional so it leaves no trace.
-- ---------------------------------------------------------------------------
begin;
do $$
declare n int;
begin
  update public.profiles set display_name = 'Renamed'
  where user_id = '11111111-1111-1111-1111-111111111111';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'user one could not update their own profile (% row(s))', n;
  end if;
  raise notice 'ok: user updates their own profile';
end
$$;
rollback;

do $$
declare n int;
begin
  update public.profiles set display_name = 'Taken over'
  where user_id = '22222222-2222-2222-2222-222222222222';
  get diagnostics n = row_count;
  if n <> 0 then
    raise exception 'user one updated % row(s) belonging to another user', n;
  end if;
  raise notice 'ok: cannot update another user''s profile';
end
$$;

-- ---------------------------------------------------------------------------
-- 4. A user cannot create a profile under another identity.
--    This is what `with check` exists for: without it the policy would decide
--    only whether the statement runs, not what it may write.
-- ---------------------------------------------------------------------------
do $$
declare denied boolean := false;
begin
  begin
    insert into public.profiles (user_id, display_name)
    values ('22222222-2222-2222-2222-222222222222', 'forged');
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a user was able to create a profile for another user';
  end if;
  raise notice 'ok: cannot insert a profile for another user';
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Column-level grants hold the line that RLS cannot.
--
--    RLS filters rows, not columns. Were `update` granted on the table rather
--    than on specific columns, a user could reassign their own `user_id` — which
--    from their point of view means handing the profile to someone else and
--    losing access to it — and could rewrite `created_at`, a historical fact.
--    These assertions are what justify the narrower grant.
-- ---------------------------------------------------------------------------
do $$
declare denied boolean := false;
begin
  begin
    update public.profiles set user_id = '22222222-2222-2222-2222-222222222222'
    where user_id = '11111111-1111-1111-1111-111111111111';
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a user was able to reassign their profile to another user';
  end if;
  raise notice 'ok: user_id is not updatable by the client';
end
$$;

do $$
declare denied boolean := false;
begin
  begin
    update public.profiles set created_at = now()
    where user_id = '11111111-1111-1111-1111-111111111111';
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a user was able to rewrite created_at';
  end if;
  raise notice 'ok: created_at is not updatable by the client';
end
$$;

-- ---------------------------------------------------------------------------
-- 6. Deletion is not reachable from the browser.
--
--    Account deletion is a server-side operation with consequences for
--    application data. A user cannot trigger it with one call against the row
--    that holds their identity.
-- ---------------------------------------------------------------------------
do $$
declare denied boolean := false;
begin
  begin
    delete from public.profiles where user_id = '11111111-1111-1111-1111-111111111111';
  exception when insufficient_privilege then
    denied := true;
  end;

  if not denied then
    raise exception 'a user was able to delete their own profile row';
  end if;
  raise notice 'ok: clients cannot delete profiles';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- 7. The server path still sees everything.
--
--    A guard that only proves denial can pass while access that is required is
--    also broken. `service_role` bypasses RLS, and this asserts it, so a future
--    policy change that inadvertently locked out the server would be caught
--    here rather than in production.
-- ---------------------------------------------------------------------------
set role service_role;

do $$
declare n int;
begin
  select count(*) into n from public.profiles;
  if n < 2 then
    raise exception 'service_role saw % row(s); the server path cannot read profiles', n;
  end if;
  raise notice 'ok: service_role reads across owners';
end
$$;

reset role;

-- ---------------------------------------------------------------------------
-- Clean up. The mutating assertion was rolled back, so only the fixtures
-- remain. Removing them here keeps the guard re-runnable and leaves a shared
-- test database as it was found.
-- ---------------------------------------------------------------------------
delete from public.profiles where user_id in (:user_one, :user_two);
delete from auth.users where id in (:user_one, :user_two);

do $$
begin
  raise notice 'RLS policy guard passed: ownership, column grants and denial all verified.';
end
$$;
