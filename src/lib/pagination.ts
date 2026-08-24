/**
 * Shared pagination.
 *
 * These lived in the group routes until a second paginated resource arrived.
 * Two modules that each define their own defaults is how one endpoint ends up
 * with a different ceiling than another, and a client that pages one list
 * correctly then gets a 400 from the next.
 *
 * The offset ceiling is not tidiness. A deep offset makes the database walk every
 * skipped row, so an unbounded offset is a cheap way to request an expensive
 * query; a client needing to page past the ceiling should narrow its filter
 * instead.
 */
import { z } from 'zod';

/** Default page size when a request does not ask for one. */
export const DEFAULT_LIMIT = 20;

/** Largest page the API will serve, regardless of what is asked for. */
export const MAX_LIMIT = 100;

/** Furthest offset the API will serve. */
export const MAX_OFFSET = 10_000;

export type Page = {
  readonly limit: number;
  readonly offset: number;
};

export type PageResult<T> = {
  readonly items: readonly T[];
  readonly hasMore: boolean;
};

/** The `limit`/`offset` pair, as a validated query fragment. */
export const paginationFields = {
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).max(MAX_OFFSET).default(0),
};

/** The response body every paginated list shares. */
export function envelope<T>(result: PageResult<T>, limit: number, offset: number) {
  return {
    data: result.items,
    page: { limit, offset, hasMore: result.hasMore },
  };
}
