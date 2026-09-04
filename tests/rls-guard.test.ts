/**
 * The RLS guard, run against the schema the tests build.
 *
 * `tests/db/rls_enabled_guard.sql` is mandatory for any migration change and is
 * run by CI against a real Postgres. Until this file existed it ran *only*
 * there: a developer could not run a check that is required before pushing
 * without provisioning a database, so the first report of a failure was a red
 * build.
 *
 * That is not hypothetical. A shim added for the chain-derived tables — tables
 * this service reads but does not own — omitted the `enable row level security`
 * that the real ones carry. Every local check passed, because none of them ran
 * the guard; CI failed on a table this repository does not own, which is exactly
 * the finding the guard exists to produce, arriving at the worst moment.
 *
 * So the guard runs here too, against the same shims and migrations, and a
 * failure now shows up in `pnpm test` before it shows up in CI.
 *
 * WHY THIS IS NOT A REPLACEMENT FOR THE CI JOB
 * PGlite is Postgres, but it is not the database CI uses, and the guard is
 * written for `psql`. Two differences matter and neither is hidden: PGlite does
 * not implement meta-commands, so the `\set` line is stripped, and it does not
 * have the `session_replication_role` or role-switching behaviour the policy
 * guard depends on, which is why `rls_policy_guard.sql` still belongs to CI
 * alone. This covers the catalog check, which is the half that reads structure.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTestDb, stripMetaCommands } from './support/pglite';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the RLS guard', () => {
  it('passes against a database built from the shims and the migrations', async () => {
    const test = await createTestDb();

    try {
      const guard = stripMetaCommands(
        readFileSync(join(repoRoot, 'tests/db/rls_enabled_guard.sql'), 'utf8'),
      );

      // The guard raises on failure, so completing without a throw is the pass.
      await expect(test.exec(guard)).resolves.toBeDefined();

      // Asserted directly as well, because a guard that examined nothing would
      // also complete without a throw — and the tables below are the ones most
      // likely to be added to a shim without their access posture.
      const { rows } = await test.query(
        `select c.relname, c.relrowsecurity
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and c.relname in ('decoded_events', 'groups', 'group_members')
         order by c.relname`,
      );

      expect(rows.map((row) => row['relname'])).toEqual([
        'decoded_events',
        'group_members',
        'groups',
      ]);
      for (const row of rows) {
        expect(row['relrowsecurity'], `${String(row['relname'])} has RLS enabled`).toBe(true);
      }
    } finally {
      await test.close();
    }
  }, 60_000);
});
