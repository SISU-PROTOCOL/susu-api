/**
 * Reading the indexer's tables.
 *
 * These tables are not declared in `src/db/schema.ts` — that file explains why —
 * so the queries against them are raw SQL, and the results arrive as untyped row
 * objects rather than as a builder's inferred shape. These helpers are the small
 * amount of shared machinery that needs: getting at the rows, and turning a page
 * of them into a page result.
 *
 * The casts are deliberate. A raw query's result is `unknown` all the way down,
 * and the mappers in each model are where a row becomes a typed value with its
 * invariants checked; anything that lets a caller skip the check would move
 * database representation into the API's types unexamined.
 */
import type { SQL } from 'drizzle-orm';
import type { PageResult } from '../lib/pagination';

/**
 * The rows out of an `execute` result.
 *
 * Throws rather than defaulting to an empty array. An empty array is also what a
 * query that legitimately matched nothing returns, so defaulting would turn "the
 * driver changed shape" into "there is no data" — the failure that looks like a
 * correct answer.
 */
export function rowsOf(result: { rows?: unknown }): readonly unknown[] {
  const rows = result.rows;
  if (!Array.isArray(rows)) {
    throw new Error('Database read returned no row array');
  }
  return rows;
}

/** Whatever can run a raw statement: the drizzle client, or a test double. */
type Executor = {
  execute(statement: SQL): Promise<{ rows?: unknown }>;
};

/** Runs a raw statement and returns its rows. */
export function queryRows(db: Executor, statement: SQL): Promise<readonly unknown[]> {
  return db.execute(statement).then(rowsOf);
}

/**
 * Splits rows fetched with `limit + 1` into a page and a "there is more" flag.
 *
 * Fetching one extra row avoids a `count(*)` over the whole table on every
 * request, and the extra row is dropped here so it cannot leak into a response.
 */
export function paginate<T>(rows: readonly T[], limit: number): PageResult<T> {
  const hasMore = rows.length > limit;
  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore };
}
