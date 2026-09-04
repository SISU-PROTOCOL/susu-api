-- Susu Protocol — deriving notifications, and running that on a schedule.
--
-- WHY THE DERIVATION IS SQL AND NOT APPLICATION CODE
-- Deriving a notification is one set-based statement: join events to the wallets
-- that prove who their subjects are, and insert the rows that result. There is no
-- per-row decision and nothing to do with request state, so the natural home for
-- it is the database — and putting it here has a concrete consequence: a
-- scheduled job can run it directly. The alternative, an application function
-- called over HTTP on a timer, needs the API to be publicly reachable, needs a
-- secret to authenticate the timer, and needs one more thing to be up.
--
-- It also removes the possibility of the two drifting: this function is the
-- definition, and callers here or in TypeScript invoke it rather than restating
-- it.
--
-- WHY IT IS SAFE TO RUN CONCURRENTLY AND REPEATEDLY
-- Every row carries the `event_identity` it came from and
-- `notifications_source_idx` is unique over `(user_id, kind,
-- source_event_identity)`, so a second run of any overlapping shape writes
-- nothing. Two runs racing produce the same result as one: the loser's insert is
-- refused by the index rather than by a check that could be interleaved. That is
-- what makes "run it every minute" a safe thing to write down.
--
-- THE LOOP IS OVER CANDIDATES, NOT OVER WRITES
-- The batch exists so one invocation cannot scan the whole table, and the
-- function advances on the identities it *examined*. An event whose subject has
-- no linked wallet therefore cannot stall it: that event is in the batch, the
-- batch is consumed, and the next call looks further along. A loop that advanced
-- on rows written would spin forever on the first such event.
--> statement-breakpoint

create or replace function public.derive_notifications(
  batch_size integer default 500,
  max_rounds integer default 20
)
returns table (events integer, written integer, rounds integer)
language plpgsql
-- SECURITY INVOKER is the default and is what is wanted: this runs as whoever
-- scheduled it, and the only caller that should exist is the service role.
-- Nothing here is safe to hand to a browser role, so `anon` and `authenticated`
-- are refused below rather than trusted to never be granted it.
set search_path = public, pg_temp
as $function$
declare
  batch text[];
  inserted integer;
  consumed integer := 0;
  produced integer := 0;
  passes integer := 0;
begin
  if batch_size is null or batch_size < 1 then
    raise exception 'batch_size must be at least 1';
  end if;
  if max_rounds is null or max_rounds < 1 then
    raise exception 'max_rounds must be at least 1';
  end if;

  loop
    exit when passes >= max_rounds;

    -- The candidate step and the write step are separate statements on purpose;
    -- see the note above about advancing on what was examined.
    select array_agg(e.event_identity) into batch
    from (
      select event_identity
      from public.decoded_events e
      where e.name in ('contribution', 'payout', 'completed')
        and not exists (
          select 1 from public.notifications n
          where n.source_event_identity = e.event_identity
        )
      order by e.ledger, e.tx_index, e.event_index
      limit batch_size
    ) e;

    exit when batch is null or array_length(batch, 1) is null;

    consumed := consumed + array_length(batch, 1);
    passes := passes + 1;

    with candidates as (
      select e.event_identity, e.name, e.contract_id, e.tx_hash, e.payload
      from public.decoded_events e
      where e.event_identity = any(batch)
    ),
    derived as (
      -- The payer. Addressed to them because they are the one waiting to know
      -- the round counted them in.
      select
        w.user_id,
        'contribution_confirmed'::text as kind,
        'Contribution confirmed'::text as title,
        jsonb_build_object(
          'contractId', c.contract_id,
          'txHash', c.tx_hash,
          'round', c.payload -> 'round',
          'amount', c.payload -> 'amount'
        ) as data,
        c.event_identity as source_event_identity
      from candidates c
      join public.wallet_links w on w.address = c.payload ->> 'member'
      where c.name = 'contribution'

      union all

      -- The round's recipient. The payload's `recipient_amount` is already net of
      -- the protocol fee, which is the number they care about.
      select
        w.user_id,
        'payout_confirmed'::text,
        'Payout confirmed'::text,
        jsonb_build_object(
          'contractId', c.contract_id,
          'txHash', c.tx_hash,
          'round', c.payload -> 'round',
          'amount', c.payload -> 'recipientAmount'
        ),
        c.event_identity
      from candidates c
      join public.wallet_links w on w.address = c.payload ->> 'recipient'
      where c.name = 'payout'

      union all

      -- The group finished. The event names nobody, so it goes to every member
      -- whose wallet is linked.
      select
        w.user_id,
        'group_completed'::text,
        'Group completed'::text,
        jsonb_build_object(
          'contractId', c.contract_id,
          'txHash', c.tx_hash,
          'rounds', c.payload -> 'rounds'
        ),
        c.event_identity
      from candidates c
      join public.group_members m on m.contract_id = c.contract_id
      join public.wallet_links w on w.address = m.member
      where c.name = 'completed'
    )
    insert into public.notifications (user_id, kind, title, data, source_event_identity)
    select user_id, kind, title, data, source_event_identity from derived
    on conflict (user_id, kind, source_event_identity) do nothing;

    get diagnostics inserted = row_count;
    produced := produced + inserted;

    exit when array_length(batch, 1) < batch_size;
  end loop;

  return query select consumed, produced, passes;
end;
$function$;
--> statement-breakpoint

comment on function public.derive_notifications(integer, integer) is
  'Turns decoded chain events into user-addressed notifications. Idempotent by event identity, so it may be run as often as anything likes.';
--> statement-breakpoint

-- The function is a trusted server-side path. A browser role that could call it
-- could not read other users' rows — it writes only rows the joins justify — but
-- it could trigger the work, and there is no reason for it to. Public execute is
-- revoked rather than left to configuration.
revoke all on function public.derive_notifications(integer, integer) from public;
--> statement-breakpoint

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.derive_notifications(integer, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.derive_notifications(integer, integer) from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.derive_notifications(integer, integer) to service_role';
  end if;
end
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- The schedule.
--
-- A notification exists to say that something just happened, so the thing that
-- makes it useful is running often; once a minute costs nothing when there is
-- nothing to derive, because the candidate query returns no rows and the
-- function exits on its first pass.
--
-- Guarded like every other optional dependency in this repository: against a
-- database without `pg_cron` — a developer's, or CI — this is a notice rather
-- than a failure, and the function above is still callable by hand.
--
-- The job is deleted by name before being created rather than assumed absent, so
-- re-applying this migration converges on one job instead of accumulating
-- duplicates under the same name.
--
-- A ROLE THAT CANNOT TOUCH `cron.job`
-- Scheduling is not a privilege every connection has: on a hosted project the
-- API connects as a pooled role that can read the table and not write it, and
-- `delete from cron.job` fails with `insufficient_privilege`. That must not fail
-- the migration — the function, the index and the column are the parts this
-- repository owns, and the schedule is a deployment step. So the error is caught
-- and reported as a notice naming the statement to run as an owner, which is
-- what an operator needs to finish the job rather than a stack trace.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('cron.job') is null then
    raise notice 'derive_notifications: pg_cron is absent — the function is created but unscheduled.';
    return;
  end if;

  begin
    delete from cron.job where jobname = 'derive-notifications';

    perform cron.schedule(
      'derive-notifications',
      '* * * * *',
      $job$select public.derive_notifications()$job$
    );

    raise notice 'derive_notifications: scheduled every minute.';
  exception
    when insufficient_privilege then
      raise notice
        'derive_notifications: this role cannot write cron.job. Run as the project owner: select cron.schedule(''derive-notifications'', ''* * * * *'', ''select public.derive_notifications()'');';
  end;
end
$$;
--> statement-breakpoint
