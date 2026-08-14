import { sql } from 'drizzle-orm';
import { getDb } from './client';

/**
 * Readiness probe.
 *
 * The API serves exclusively from the indexer's tables, so it is not ready to
 * serve traffic if it cannot reach them. The probe is deliberately a trivial
 * query: it answers "can this process reach the database", not "is the index
 * up to date". Index lag is the indexer's own health signal
 * (`indexer_checkpoints`, `indexer_runs`) and is not something a readiness probe
 * should decide, since a lagging index still serves correct, if older, answers.
 *
 * Throws on failure so the caller can decide the response; it does not swallow
 * the error, because a readiness failure that reports nothing is worse than no
 * readiness check.
 */
export async function probeDatabase(): Promise<void> {
  await getDb().execute(sql`select 1`);
}
