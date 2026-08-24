import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNotificationReadModel } from '../src/db/notifications';
import type { NotificationReadModel } from '../src/db/notifications';
import { createTestDb, type TestDb } from './support/pglite';

/**
 * The notification model against a real Postgres.
 *
 * The route tests inject a fake model, so they pass whether or not the SQL is
 * right. These run the real migrations and the real queries, and the cases below
 * are chosen for the mistakes a fake cannot catch: the ones that return data
 * rather than errors.
 *
 * Every test seeds its own user and never relies on another test's rows. A
 * shared fixture would make these order-dependent, and an order-dependent
 * assertion about a *query* is the kind of test that passes for the wrong
 * reason after somebody reorders the file.
 */

let testDb: TestDb;
let model: NotificationReadModel;

beforeAll(async () => {
  testDb = await createTestDb();
  model = createNotificationReadModel(testDb.db);
});

afterAll(async () => {
  await testDb.close();
});

/**
 * A distinct user id per fixture.
 *
 * Valid uuid shape, so the columns accept it, and version 4 in the third group
 * so nothing that validates versions rejects it either.
 */
let userCounter = 0;
function nextUserId(): string {
  userCounter += 1;
  return `${String(userCounter).padStart(8, '0')}-0000-4000-8000-000000000000`;
}

type Seeded = {
  readonly title: string;
  readonly createdAt: string;
  readonly readAt?: string | null;
};

/** Creates a user with the given notifications, and returns the user id. */
async function seed(rows: readonly Seeded[]): Promise<string> {
  const userId = nextUserId();
  await testDb.createUser(userId);

  for (const row of rows) {
    await testDb.query(
      `insert into public.notifications (user_id, kind, title, created_at, read_at)
       values ($1, 'payout_confirmed', $2, $3, $4)`,
      [userId, row.title, row.createdAt, row.readAt ?? null],
    );
  }

  return userId;
}

const READING = {
  title: 'read one',
  createdAt: '2026-08-01T00:00:00Z',
  readAt: '2026-08-02T00:00:00Z',
};
const UNREAD_LATE = { title: 'unread late', createdAt: '2026-08-03T00:00:00Z' };
const UNREAD_EARLY = { title: 'unread early', createdAt: '2026-07-30T00:00:00Z' };

describe('list', () => {
  it('returns only the caller’s notifications', async () => {
    const mine = await seed([READING, UNREAD_LATE]);
    await seed([{ title: 'not mine', createdAt: '2026-08-04T00:00:00Z' }]);

    const result = await model.list(mine, { limit: 20, offset: 0 });

    // Not a tautology: the API connects as the table owner, so no policy stands
    // between a missing `where user_id` and another user's rows.
    expect(result.items.map((item) => item.title)).toEqual(['unread late', 'read one']);
  });

  it('orders newest first', async () => {
    const mine = await seed([UNREAD_EARLY, READING, UNREAD_LATE]);

    const result = await model.list(mine, { limit: 20, offset: 0 });

    expect(result.items.map((item) => item.title)).toEqual([
      'unread late',
      'read one',
      'unread early',
    ]);
  });

  it('filters to unread when asked, and only then', async () => {
    const mine = await seed([READING, UNREAD_LATE]);

    const unread = await model.list(mine, { limit: 20, offset: 0, unreadOnly: true });
    const all = await model.list(mine, { limit: 20, offset: 0, unreadOnly: false });

    expect(unread.items.map((item) => item.title)).toEqual(['unread late']);
    expect(all.items).toHaveLength(2);
  });

  it('reports whether more rows exist', async () => {
    const mine = await seed([READING, UNREAD_LATE]);

    const first = await model.list(mine, { limit: 1, offset: 0 });
    const second = await model.list(mine, { limit: 1, offset: 1 });
    const past = await model.list(mine, { limit: 1, offset: 2 });

    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(past.items).toHaveLength(0);
    expect(past.hasMore).toBe(false);
  });

  it('never reports more rows when the page exactly exhausts them', async () => {
    const mine = await seed([READING, UNREAD_LATE]);

    // The off-by-one a `limit + 1` lookahead is for: two rows and a limit of two
    // is the last page, not a page with more behind it.
    const result = await model.list(mine, { limit: 2, offset: 0 });

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(false);
  });

  it('pages without repeating or skipping a row', async () => {
    // Two identical timestamps, which is the case a tiebreaker exists for:
    // without a total order Postgres may return them in either order per query,
    // so one row can be served twice and another never.
    const mine = await seed([
      { title: 'twin', createdAt: '2026-08-05T00:00:00Z' },
      { title: 'twin', createdAt: '2026-08-05T00:00:00Z' },
      { title: 'twin', createdAt: '2026-08-05T00:00:00Z' },
      { title: 'twin', createdAt: '2026-08-05T00:00:00Z' },
    ]);

    const pageOne = await model.list(mine, { limit: 2, offset: 0 });
    const pageTwo = await model.list(mine, { limit: 2, offset: 2 });
    const seen = [...pageOne.items, ...pageTwo.items].map((item) => item.id);

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
  });

  it('returns an empty page rather than an error for a user with nothing', async () => {
    const empty = await seed([]);

    const result = await model.list(empty, { limit: 20, offset: 0 });

    expect(result.items).toEqual([]);
    expect(result.hasMore).toBe(false);
  });
});

describe('unreadCount', () => {
  it('counts only the caller’s unread rows', async () => {
    const mine = await seed([READING, UNREAD_LATE, UNREAD_EARLY]);
    const theirs = await seed([
      READING,
      { title: 'theirs unread', createdAt: '2026-08-06T00:00:00Z' },
    ]);

    expect(await model.unreadCount(mine)).toBe(2);
    expect(await model.unreadCount(theirs)).toBe(1);
  });

  it('counts nothing for a user with no notifications', async () => {
    const empty = await seed([]);

    // `count(*)` over no rows is `0`, and `0` is a real badge value rather than a
    // reason to fall over.
    expect(await model.unreadCount(empty)).toBe(0);
  });
});

describe('markRead', () => {
  it('marks an unread notification read', async () => {
    const mine = await seed([UNREAD_LATE]);
    const [row] = (
      await testDb.query(`select id from public.notifications where user_id = $1`, [mine])
    ).rows;

    expect(await model.markRead(mine, row!['id'] as string)).toBe('read');

    const unread = await model.list(mine, { limit: 20, offset: 0, unreadOnly: true });
    expect(unread.items).toHaveLength(0);
  });

  it('records when it was read', async () => {
    const mine = await seed([UNREAD_LATE]);
    const [row] = (
      await testDb.query(`select id from public.notifications where user_id = $1`, [mine])
    ).rows;

    const before = Date.now();
    await model.markRead(mine, row!['id'] as string);

    const [after] = (
      await testDb.query(`select read_at from public.notifications where id = $1`, [row!['id']])
    ).rows;
    expect(Date.parse(after!['read_at'] as string)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('reports a second mark as already read rather than moving the timestamp', async () => {
    const mine = await seed([READING]);
    const [row] = (
      await testDb.query(`select id, read_at from public.notifications where user_id = $1`, [mine])
    ).rows;

    expect(await model.markRead(mine, row!['id'] as string)).toBe('already_read');

    const [after] = (
      await testDb.query(`select read_at from public.notifications where id = $1`, [row!['id']])
    ).rows;

    // `read_at` records when the user first saw it, which is the only thing the
    // column is for; a repeat must not overwrite that with a later time.
    expect(after!['read_at']).toEqual(row!['read_at']);
  });

  it('refuses to mark another user’s notification', async () => {
    const owner = await seed([UNREAD_LATE]);
    const stranger = await seed([]);
    const [row] = (
      await testDb.query(`select id from public.notifications where user_id = $1`, [owner])
    ).rows;

    // `not_found`, not `already_read` and not a success: the update is scoped, so
    // the row is untouched and the caller learns nothing about whose it is.
    expect(await model.markRead(stranger, row!['id'] as string)).toBe('not_found');

    const [after] = (
      await testDb.query(`select read_at from public.notifications where id = $1`, [row!['id']])
    ).rows;
    expect(after!['read_at']).toBeNull();
  });

  it('reports an unknown id as not found', async () => {
    const mine = await seed([]);

    expect(await model.markRead(mine, '00000000-0000-4000-8000-000000000000')).toBe('not_found');
  });
});
