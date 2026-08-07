import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getEnv } from '../lib/env';
import * as schema from './schema';

/**
 * PostgreSQL access.
 *
 * The database is a rebuildable index of chain activity — never the source of
 * truth. If database state ever conflicts with Stellar/Soroban state, the chain
 * wins and reconciliation repairs the database.
 *
 * The connection uses a privileged role and must be used only from server code.
 * Browser clients never receive these credentials.
 */

let pool: Pool | undefined;
let database: NodePgDatabase<typeof schema> | undefined;

export function getPool(): Pool {
  if (pool === undefined) {
    const env = getEnv();
    pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (database === undefined) {
    database = drizzle(getPool(), { schema });
  }
  return database;
}

export async function closeDb(): Promise<void> {
  if (pool !== undefined) {
    await pool.end();
    pool = undefined;
    database = undefined;
  }
}
