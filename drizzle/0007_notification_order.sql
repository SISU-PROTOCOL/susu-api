-- Susu Protocol — the order notifications arrive in.
--
-- THE BUG THIS FIXES
-- `derive_notifications` picked its batch in chain order — that has always been
-- right, `order by e.ledger, e.tx_index, e.event_index` — and then threw the
-- order away. The identities were collected into an array, matched back with
-- `= any(batch)`, unioned across three shapes, and inserted. None of those steps
-- preserves a sequence, so the insertion order was whatever the planner found
-- convenient.
--
-- That was invisible while every row in a sweep shared one `created_at`, because
-- `now()` is transaction-start time and a sweep is one statement. It stopped
-- being invisible the moment anything ordered by that column: the list endpoint
-- sorts `created_at desc, id desc`, and `id` is `gen_random_uuid()` — random. So
-- for the ordinary case of a sweep catching up on a backlog, the order within the
-- batch was arbitrary, and a member could be shown "payout confirmed, round 2"
-- above "contribution confirmed, round 1".
--
-- It surfaced as a test that failed about half the time, which is the honest
-- signature of a coin flip rather than a race.
--
-- THE FIX
-- Carry the event's chain position through to the insert and use it to make
-- `created_at` strictly increasing in chain order, one microsecond apart within a
-- sweep. The timestamps stay what they always were — the moment the notification
-- was derived — but they now encode the sequence as well, which is enough for
-- every existing reader to be correct. The read model, its pagination and its
-- index are all untouched.
--
-- `offset_base` makes the offset global across rounds rather than per round. Each
-- round restarts `row_number()` at 1, and all rounds in one call share a
-- transaction, so a per-round offset would let the second batch land on top of the
-- first — reintroducing the same tie one batch later.
--
-- WHAT THIS IS NOT
-- `created_at` is derivation time, not event time, so a backlog swept in one pass
-- carries the time of the sweep. Ordering correctly is what the feed needs;
-- showing when a thing *happened* would additionally need a ledger-to-time
-- mapping this service does not have, and inventing one would be a larger claim
-- than the column supports.
--> statement-breakpoint

create or replace function public.derive_notifications(
  batch_size integer default 500,
  max_rounds integer default 20
)
returns table (events integer, written integer, rounds integer)
language plpgsql
set search_path = public, pg_temp
as $function$
declare
  batch text[];
  inserted integer;
  consumed integer := 0;
  produced integer := 0;
  passes integer := 0;
  offset_base integer;
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
    -- see the note in 0006 about advancing on what was examined.
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

    offset_base := consumed;
    consumed := consumed + array_length(batch, 1);
    passes := passes + 1;

    with candidates as (
      -- The chain position travels with the event. It is the only total order the
      -- decoded events have, and the reason the resulting notifications can be
      -- ordered at all.
      select
        e.event_identity, e.name, e.contract_id, e.tx_hash, e.payload,
        e.ledger, e.tx_index, e.event_index
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
        c.event_identity as source_event_identity,
        c.ledger as ledger,
        c.tx_index as tx_index,
        c.event_index as event_index
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
        c.event_identity,
        c.ledger,
        c.tx_index,
        c.event_index
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
        c.event_identity,
        c.ledger,
        c.tx_index,
        c.event_index
      from candidates c
      join public.group_members m on m.contract_id = c.contract_id
      join public.wallet_links w on w.address = m.member
      where c.name = 'completed'
    )
    insert into public.notifications (
      user_id, kind, title, data, source_event_identity, created_at
    )
    select
      user_id,
      kind,
      title,
      data,
      source_event_identity,
      -- One microsecond per step through the batch, offset by everything already
      -- written in this call, so the sequence is strictly increasing across rounds
      -- as well as within one. Distinct timestamps also mean the `id` tiebreak in
      -- the list query is never reached, which is what removes the coin flip.
      now() + (
        (offset_base + row_number() over (order by ledger, tx_index, event_index))
        * interval '1 microsecond'
      )
    from derived
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
  'Turns decoded chain events into user-addressed notifications, in chain order. Idempotent by event identity, so it may be run as often as anything likes.';
--> statement-breakpoint

-- `create or replace` keeps the existing grants and owner, but they are restated
-- so this migration describes the function's access posture on its own rather
-- than relying on the reader having 0006 to hand.
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
