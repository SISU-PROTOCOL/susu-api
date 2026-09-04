/**
 * Deriving notifications from the events the contracts emitted.
 *
 * THE DEFINITION IS IN SQL, AND THIS ONLY CALLS IT
 * `public.derive_notifications(batch_size, max_rounds)` — created by
 * `drizzle/0006_notification_schedule.sql` — holds the whole of the logic. It is
 * there rather than here because it is one set-based statement, and because
 * Postgres can run it on a schedule without the API being reachable or
 * authenticated. This module exists so the same derivation can be triggered from
 * the application — at boot, or by hand while investigating — without restating
 * the query and creating a second version of it that can drift.
 *
 * WHY A NOTIFICATION IS NOT A SOURCE OF TRUTH
 * The indexer writes `decoded_events`, which is the faithful record of what the
 * chain said. A notification is a different kind of thing: it is addressed to a
 * *user*, and the chain has never heard of a user — it knows wallet addresses.
 * Turning one into the other needs `wallet_links`, which the indexer has no
 * business reading, which is why the two are separate steps over the same source.
 * A member who wants to know whether they were paid reads the contract; a
 * notification that never arrived costs them a look rather than a fact.
 *
 * WHY RUNNING IT TWICE IS SAFE
 * Every row carries the `event_identity` it was derived from, and the unique
 * index over `(user_id, kind, source_event_identity)` refuses a second copy. The
 * sweep is therefore idempotent by identity rather than by remembering how far it
 * got, so a missed run, a partial run and an operator catching up all produce the
 * same rows. A watermark would have the opposite property: a stale one skips
 * notifications silently, which is the failure nobody notices.
 *
 * WHAT IS DELIBERATELY NOT NOTIFIED
 * Only events addressed to a person: a contribution the member made, a payout
 * they received, and their group finishing. `fee` is the protocol paying itself,
 * and `join`/`start` for other people are not news to anyone, so a feed of them
 * would be noise that makes the three that matter easy to miss.
 *
 * A member who links a wallet *after* a payout does not receive a notification
 * for it. That is not an oversight: back-filling would mean treating a
 * notification as a historical record rather than a message about something that
 * just happened, and the activity feed already answers the historical question.
 */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';

type Database = NodePgDatabase<typeof schema>;

export type SweepOptions = {
  /** Events considered per pass. */
  readonly batchSize?: number;
  /** A ceiling on passes, so one invocation cannot run unbounded. */
  readonly maxRounds?: number;
};

export type SweepResult = {
  /** The decoded events the sweep looked at. */
  readonly events: number;
  /** The notifications actually written. */
  readonly written: number;
  /** How many passes ran. More than one means the sweep was catching up. */
  readonly rounds: number;
};

export type NotificationSweeper = {
  sweep(options?: SweepOptions): Promise<SweepResult>;
};

type SweepRow = { events: number; written: number; rounds: number };

export function createNotificationSweeper(db: Database): NotificationSweeper {
  return {
    async sweep(options = {}) {
      const batchSize = options.batchSize ?? 500;
      const maxRounds = options.maxRounds ?? 20;

      // The counts come from the function rather than from a follow-up query: a
      // separate `select count(*)` would be a different moment in time, and two
      // runs racing would make "how many were written" unanswerable.
      const result = (await db.execute(
        sql`select events, written, rounds from public.derive_notifications(${batchSize}, ${maxRounds})`,
      )) as unknown as { rows: SweepRow[] };

      const row = result.rows[0];
      if (row === undefined) {
        // `returns table` always yields exactly one row, so this would mean the
        // function was replaced by something else. Reporting zeroes would hide
        // that; the caller sees a failure instead.
        throw new Error('derive_notifications returned no row.');
      }

      return { events: row.events, written: row.written, rounds: row.rounds };
    },
  };
}
