-- Susu Protocol — the identity of the event a notification was derived from.
--
-- WHY THIS COLUMN EXISTS
-- A notification is not authored, it is *derived*: "your payout was confirmed"
-- is a statement about one decoded chain event. Derivation is therefore
-- repeatable, and a sweep that derives notifications will be run again — after a
-- gap in the schedule, or by an operator catching up. Without a way to say "this
-- row is the notification for that event", the second run writes a second copy of
-- every notification and the user sees the same payout confirmed three times.
--
-- The alternative — remembering a watermark ("we have derived up to ledger N") —
-- is worse for exactly the reason `indexer_checkpoints` has an age-out problem:
-- the moment the watermark is stale or the pass is partial, notifications are
-- silently skipped rather than safely repeated. Idempotency by identity means the
-- sweep may be re-run as often as anyone likes, and re-derived rows are refused
-- by the index rather than by a check that could race.
--
-- WHY NOT A FOREIGN KEY TO `decoded_events`
-- It would read well, but it ties a user-owned row's lifetime to an indexer-owned
-- one. A re-index that rebuilds a contract's events could delete a decoded row
-- and take the user's notification with it — a message about something that did
-- happen, removed because a table was rebuilt. The identity is a value here, not
-- a relationship.
--
-- NULL IS MEANINGFUL
-- A notification written by an operator, or by a future path that is not about a
-- chain event, has no source identity and leaves this null. Postgres treats nulls
-- as distinct in a unique index, so any number of those coexist; the uniqueness
-- applies to derived rows.
--> statement-breakpoint

alter table public.notifications
  add column source_event_identity text;
--> statement-breakpoint

-- One notification per (user, kind, event). The column order puts the scoping
-- column first, so the same index also serves "this user's notifications", which
-- is the query the list endpoint runs.
create unique index notifications_source_idx
  on public.notifications (user_id, kind, source_event_identity);
--> statement-breakpoint
