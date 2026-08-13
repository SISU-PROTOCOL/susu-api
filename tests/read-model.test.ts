import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createGroupReadModel, toGroupStatus, toGroupSummary } from '../src/db/groups';
import type * as schema from '../src/db/schema';
import { GROUP_CONTRACT_ID } from './support/fixtures';

/**
 * The read model is the boundary where database values become API values, so
 * these tests are about what happens when the database returns something
 * unexpected — which is exactly the case a happy-path test cannot see.
 */

const dialect = new PgDialect();

function stubDb(rows: readonly unknown[]) {
  const execute = vi.fn(async (_statement: unknown) => ({ rows }));
  return {
    execute,
    db: { execute } as unknown as NodePgDatabase<typeof schema>,
  };
}

/**
 * A stub that answers each successive query differently.
 *
 * `getGroup` issues three statements and stops early when the first finds
 * nothing, so a stub that answers every call the same way cannot reach the
 * later ones.
 */
function stubDbSequence(results: readonly (readonly unknown[])[]) {
  let index = 0;
  const execute = vi.fn(async (_statement: unknown) => ({
    rows: results[index++] ?? [],
  }));
  return {
    execute,
    db: { execute } as unknown as NodePgDatabase<typeof schema>,
  };
}

/** The SQL and bound parameters a captured `execute` call would have sent. */
function renderedQuery(statement: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(statement as SQL);
  return { sql: query.sql, params: query.params };
}

/** The SQL a captured `execute` call would have sent. */
function rendered(statement: unknown): string {
  return renderedQuery(statement).sql;
}

type GroupRowInput = Parameters<typeof toGroupSummary>[0];

function groupRow(overrides: Record<string, unknown> = {}): GroupRowInput {
  return {
    contract_id: GROUP_CONTRACT_ID,
    factory_contract_id: `C${'E'.repeat(55)}`,
    group_id: '1',
    creator: `G${'C'.repeat(55)}`,
    token: `C${'F'.repeat(55)}`,
    contribution_amount: '100000000',
    member_capacity: '3',
    created_ledger: '4606483',
    status: 'active',
    member_count: '3',
    current_round: '1',
    completed_rounds: '0',
    contributed_total: '300000000',
    paid_out_total: '0',
    fee_total: '0',
    last_event_ledger: '4606500',
    // Cast through `unknown` so a test can deliberately violate the row's type,
    // which is how the guard's behaviour on bad input gets exercised.
    ...overrides,
  } as unknown as GroupRowInput;
}

describe('money is cast in SQL, not converted afterwards', () => {
  it('casts every monetary column to text in the group query', async () => {
    const { db, execute } = stubDb([]);
    await createGroupReadModel(db).getGroup(GROUP_CONTRACT_ID);

    const groupSql = rendered(execute.mock.calls[0]?.[0]);
    for (const column of [
      'contribution_amount',
      'contributed_total',
      'paid_out_total',
      'fee_total',
    ]) {
      expect(groupSql, column).toContain(`${column}::text`);
    }
  });

  it('casts amounts in each list query', async () => {
    const { db, execute } = stubDb([]);
    const model = createGroupReadModel(db);

    await model.listGroups({ limit: 1, offset: 0 });
    expect(rendered(execute.mock.calls[0]?.[0])).toContain('contribution_amount::text');

    await model.listContributions(GROUP_CONTRACT_ID, { limit: 1, offset: 0 });
    expect(rendered(execute.mock.calls[1]?.[0])).toContain('amount::text');

    await model.listPayouts(GROUP_CONTRACT_ID, { limit: 1, offset: 0 });
    expect(rendered(execute.mock.calls[2]?.[0])).toContain('recipient_amount::text');
  });

  it('sums the per-round pot in the database, not in JavaScript', async () => {
    // The total is never assembled from values that have been through a
    // JavaScript number: `sum()` stays a `numeric` and is cast on the way out.
    const { db, execute } = stubDbSequence([[groupRow()], [], []]);
    await createGroupReadModel(db).getGroup(GROUP_CONTRACT_ID);

    // The third statement `getGroup` issues is the per-round aggregate. The
    // SQL is collapsed first so the assertion does not depend on how the
    // formatter wrapped the query.
    const roundsSql = rendered(execute.mock.calls[2]?.[0]).replace(/\s+/g, ' ');
    expect(roundsSql).toContain('coalesce(sum(c.amount), 0)::text');
  });

  it('refuses an amount that arrived as a number instead of failing silently', async () => {
    // Simulates a lost `::text` cast, or a global type parser turning `numeric`
    // into a double. Returning the rounded value would be undetectable later.
    const { db } = stubDb([groupRow({ contributed_total: 300000000 })]);
    await expect(createGroupReadModel(db).getGroup(GROUP_CONTRACT_ID)).rejects.toThrow(
      /::text cast/,
    );
  });
});

describe('toGroupSummary', () => {
  it('maps a valid row, keeping money as strings', () => {
    const summary = toGroupSummary(groupRow());
    expect(summary.contractId).toBe(GROUP_CONTRACT_ID);
    expect(summary.groupId).toBe(1);
    expect(summary.contributedTotal).toBe('300000000');
    expect(summary.status).toBe('active');
  });

  it('preserves an amount that a double could not hold', () => {
    const maxI128 = '170141183460469231731687303715884105727';
    expect(toGroupSummary(groupRow({ contributed_total: maxI128 })).contributedTotal).toBe(maxI128);
  });

  it('rejects a status the contracts do not use', () => {
    expect(() => toGroupSummary(groupRow({ status: 'cancelled' }))).toThrow(/unrecognised value/);
  });

  it('rejects a ledger that is not a safe integer', () => {
    expect(() => toGroupSummary(groupRow({ created_ledger: '1e9' }))).toThrow(/safe integer/);
  });
});

describe('toGroupStatus', () => {
  it('accepts only the statuses the contracts emit', () => {
    expect(toGroupStatus('open')).toBe('open');
    expect(toGroupStatus('active')).toBe('active');
    expect(toGroupStatus('completed')).toBe('completed');
    expect(() => toGroupStatus('OPEN')).toThrow(/unrecognised value/);
  });
});

describe('pagination', () => {
  it('drops the extra row and reports that more exist', async () => {
    const rows = [1, 2, 3].map((round) => ({
      event_identity: `evt-${round}`,
      member: `G${'C'.repeat(55)}`,
      round,
      amount: '100000000',
      ledger: 4_606_500 + round,
      tx_hash: 'a'.repeat(64),
    }));

    const { db, execute } = stubDb(rows);
    const result = await createGroupReadModel(db).listContributions(GROUP_CONTRACT_ID, {
      limit: 2,
      offset: 0,
    });

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    // `limit + 1` is requested precisely so the extra row can be dropped here.
    // Asserted on the bound parameter, not the SQL text: the placeholder index
    // is an artefact of parameter ordering and not what this test is about.
    const { params } = renderedQuery(execute.mock.calls[0]?.[0]);
    expect(params[1]).toBe(3);
  });

  it('reports no more rows when the page is not full', async () => {
    const { db } = stubDb([]);
    const result = await createGroupReadModel(db).listPayouts(GROUP_CONTRACT_ID, {
      limit: 20,
      offset: 0,
    });
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});

describe('group existence', () => {
  it('is false when the group is not in the index', async () => {
    const { db } = stubDb([]);
    expect(await createGroupReadModel(db).groupExists(GROUP_CONTRACT_ID)).toBe(false);
  });

  it('is true when the group is present', async () => {
    const { db } = stubDb([{ present: 1 }]);
    expect(await createGroupReadModel(db).groupExists(GROUP_CONTRACT_ID)).toBe(true);
  });
});
