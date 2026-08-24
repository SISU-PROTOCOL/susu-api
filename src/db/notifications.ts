/**
 * The notification read model.
 *
 * Notifications are user-owned but not user-written: the browser is granted
 * `select` on its own rows and `update` on `read_at`, and nothing else. Rows are
 * produced by trusted paths — the API and the indexer — with the service role, so
 * that a notification saying a payout was confirmed is one the user can trust.
 *
 * Because the API connects as the owner, RLS is not in force for these queries.
 * Every statement here therefore scopes by `user_id` explicitly. That is not
 * belt-and-braces: without it, `mark` would let any authenticated user mark any
 * notification read by id, and the RLS policy that protects the browser would be
 * silently doing nothing for the path that actually runs.
 */
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { assertCount } from '../lib/base-units';
import type { Page, PageResult } from '../lib/pagination';
import * as schema from './schema';
import { notifications, type Notification } from './schema';

type Database = NodePgDatabase<typeof schema>;

export type NotificationView = {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly body: string | null;
  readonly data: unknown;
  readonly readAt: string | null;
  readonly createdAt: string;
};

export type ListNotificationsQuery = Page & {
  /** When true, only unread rows are returned. */
  readonly unreadOnly?: boolean;
};

export type MarkReadOutcome = 'read' | 'already_read' | 'not_found';

export type NotificationReadModel = {
  list(userId: string, query: ListNotificationsQuery): Promise<PageResult<NotificationView>>;
  /** How many notifications are unread, for a badge. */
  unreadCount(userId: string): Promise<number>;
  /**
   * Marks one notification read.
   *
   * Scoped to `userId`, so a notification id belonging to another user is
   * `not_found` rather than a row that changes.
   */
  markRead(userId: string, notificationId: string): Promise<MarkReadOutcome>;
};

/**
 * Maps a row to the API's shape.
 *
 * The parameter is the inferred select type rather than a hand-written row type.
 * A hand-written one in snake_case compiles — nothing checks that a parameter
 * type matches what the query actually returns — and then reads `undefined` for
 * every field, because Drizzle returns the schema's property names, not the
 * column names. That is a silent 500 on every request, so the type here is the
 * schema's.
 */
function toView(row: Notification): NotificationView {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    data: row.data,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createNotificationReadModel(db: Database): NotificationReadModel {
  return {
    async list(userId, query) {
      const conditions = [eq(notifications.userId, userId)];
      if (query.unreadOnly === true) conditions.push(isNull(notifications.readAt));

      const rows = await db
        .select()
        .from(notifications)
        .where(and(...conditions))
        // Newest first, with the id as a tiebreaker so that two notifications
        // written in the same transaction still page deterministically. Without
        // it a row can appear on two pages or on none.
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(query.limit + 1)
        .offset(query.offset);

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;

      return { items: page.map(toView), hasMore };
    },

    async unreadCount(userId) {
      const [row] = await db
        .select({ count: sql<string>`count(*)` })
        .from(notifications)
        .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

      // `count(*)` is a `bigint`, which arrives as a string; a badge count is
      // small, but the conversion is checked rather than assumed.
      return assertCount(row?.count ?? '0', 'unread notification count');
    },

    async markRead(userId, notificationId) {
      // `read_at is null` in the predicate makes this a one-way transition, and
      // the returned row tells us whether it happened. Setting it again would
      // overwrite the moment the user first saw the notification, which is the
      // only thing the column is for.
      const updated = await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.id, notificationId),
            eq(notifications.userId, userId),
            isNull(notifications.readAt),
          ),
        )
        .returning({ id: notifications.id });

      if (updated.length > 0) return 'read';

      // Nothing changed. Either it does not exist, or it belongs to somebody
      // else, or it was already read — and those are different answers. Scoped by
      // user, so an id belonging to another account is reported as absent rather
      // than revealing that it exists.
      const [existing] = await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)))
        .limit(1);

      return existing === undefined ? 'not_found' : 'already_read';
    },
  };
}
