import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  ActivityRecord,
  ContributionRecord,
  GroupDetail,
  GroupReadModel,
  GroupSummary,
  ListGroupsQuery,
  PayoutRecord,
} from '../src/db/groups';
import {
  ACCOUNT_ADDRESS,
  CONTRACT_MEMBER_ADDRESS,
  configureTestEnv,
  GROUP_CONTRACT_ID,
  groupSummary,
  OTHER_CONTRACT_ID,
} from './support/fixtures';

configureTestEnv();

function emptyPage<T>(): { items: readonly T[]; hasMore: boolean } {
  return { items: [], hasMore: false };
}

type FakeReadModel = {
  [K in keyof GroupReadModel]: ReturnType<typeof vi.fn>;
};

function fakeReadModel(overrides: Partial<GroupReadModel> = {}): GroupReadModel & FakeReadModel {
  const base = {
    listGroups: vi.fn(async (_query: ListGroupsQuery) => emptyPage<GroupSummary>()),
    getGroup: vi.fn(async (_contractId: string) => undefined as GroupDetail | undefined),
    groupExists: vi.fn(async (_contractId: string) => true),
    listContributions: vi.fn(async (_contractId: string, _page: unknown) =>
      emptyPage<ContributionRecord>(),
    ),
    listPayouts: vi.fn(async (_contractId: string, _page: unknown) => emptyPage<PayoutRecord>()),
    listActivity: vi.fn(async (_contractId: string, _page: unknown) => emptyPage<ActivityRecord>()),
    ...overrides,
  };
  return base as unknown as GroupReadModel & FakeReadModel;
}

async function buildTestServer(readModel: GroupReadModel): Promise<FastifyInstance> {
  const { buildServer } = await import('../src/server');
  // A healthy readiness probe: these tests are about the group surface, and an
  // unreachable database would otherwise make /ready the only failing route.
  return await buildServer({ readModel, probeDatabase: async () => {} });
}

describe('GET /api/v1/groups', () => {
  let app: FastifyInstance;
  let readModel: GroupReadModel & FakeReadModel;

  beforeAll(async () => {
    readModel = fakeReadModel();
    app = await buildTestServer(readModel);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns a page envelope', async () => {
    readModel.listGroups.mockResolvedValueOnce({
      items: [groupSummary()],
      hasMore: false,
    });

    const response = await app.inject({ method: 'GET', url: '/api/v1/groups' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: GroupSummary[]; page: Record<string, unknown> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.contractId).toBe(GROUP_CONTRACT_ID);
    expect(body.page).toEqual({ limit: 20, offset: 0, hasMore: false });
  });

  it('passes no absent filters through to the read model', async () => {
    readModel.listGroups.mockClear();
    await app.inject({ method: 'GET', url: '/api/v1/groups' });

    // `toStrictEqual` rather than `toEqual`: an explicitly-undefined key must
    // fail here, so a filter cannot be passed as present-but-empty.
    expect(readModel.listGroups.mock.calls[0]?.[0]).toStrictEqual({ limit: 20, offset: 0 });
  });

  it('passes filters and pagination through', async () => {
    readModel.listGroups.mockClear();
    await app.inject({
      method: 'GET',
      url:
        `/api/v1/groups?status=active&creator=${ACCOUNT_ADDRESS}` +
        `&member=${CONTRACT_MEMBER_ADDRESS}&limit=5&offset=10`,
    });

    expect(readModel.listGroups.mock.calls[0]?.[0]).toStrictEqual({
      status: 'active',
      creator: ACCOUNT_ADDRESS,
      member: CONTRACT_MEMBER_ADDRESS,
      limit: 5,
      offset: 10,
    });
  });

  it('accepts a contract address as a member, not only an account', async () => {
    // A wallet-contract member is a real case; a `G`-only pattern would reject it.
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/groups?member=${CONTRACT_MEMBER_ADDRESS}`,
    });
    expect(response.statusCode).toBe(200);
  });

  it('reports hasMore when the read model says so', async () => {
    readModel.listGroups.mockResolvedValueOnce({ items: [groupSummary()], hasMore: true });
    const response = await app.inject({ method: 'GET', url: '/api/v1/groups?limit=1' });
    const body = response.json() as { page: { hasMore: boolean } };
    expect(body.page.hasMore).toBe(true);
  });

  it('rejects an unknown status rather than ignoring it', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/groups?status=closed' });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe('invalid_request');
  });

  it('rejects a malformed member address', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/groups?member=not-an-address',
    });
    expect(response.statusCode).toBe(400);
  });

  it('bounds the page size instead of trusting the client', async () => {
    for (const limit of ['0', '101', '-1', 'abc']) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/groups?limit=${limit}` });
      expect(response.statusCode, `limit=${limit}`).toBe(400);
    }
  });

  it('bounds the offset so a request cannot walk the table', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/groups?offset=100000' });
    expect(response.statusCode).toBe(400);
  });

  it('marks the response cacheable for a short window', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/groups' });
    expect(response.headers['cache-control']).toContain('max-age=5');
  });
});

describe('GET /api/v1/groups/:contractId', () => {
  let app: FastifyInstance;
  let readModel: GroupReadModel & FakeReadModel;

  beforeAll(async () => {
    readModel = fakeReadModel();
    app = await buildTestServer(readModel);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('returns the group with its members and rounds', async () => {
    const detail: GroupDetail = {
      ...groupSummary(),
      members: [{ member: ACCOUNT_ADDRESS, position: 1, joinedLedger: 4_606_490 }],
      rounds: [
        {
          round: 1,
          contributionCount: 3,
          contributed: '300000000',
          payout: null,
          recipient: null,
          fee: null,
        },
      ],
    };
    readModel.getGroup.mockResolvedValueOnce(detail);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: GroupDetail };
    expect(body.data.members).toHaveLength(1);
    expect(body.data.rounds[0]?.contributed).toBe('300000000');
  });

  it('returns 404 for a valid address that is not indexed', async () => {
    readModel.getGroup.mockResolvedValueOnce(undefined);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/groups/${OTHER_CONTRACT_ID}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'group_not_found' });
  });

  it('rejects an address that is not a contract', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/groups/${ACCOUNT_ADDRESS}` });
    expect(response.statusCode).toBe(400);
  });
});

describe('group sub-resources', () => {
  let app: FastifyInstance;
  let readModel: GroupReadModel & FakeReadModel;

  beforeAll(async () => {
    readModel = fakeReadModel();
    app = await buildTestServer(readModel);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves contributions, payouts and activity as page envelopes', async () => {
    readModel.listContributions.mockResolvedValueOnce({
      items: [
        {
          eventIdentity: 'evt-1',
          member: ACCOUNT_ADDRESS,
          round: 1,
          amount: '100000000',
          ledger: 4_606_495,
          txHash: 'a'.repeat(64),
        },
      ],
      hasMore: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/contributions`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { data: ContributionRecord[]; page: { hasMore: boolean } };
    expect(body.data[0]?.amount).toBe('100000000');
    expect(body.page.hasMore).toBe(false);

    for (const path of ['payouts', 'activity']) {
      const sub = await app.inject({
        method: 'GET',
        url: `/api/v1/groups/${GROUP_CONTRACT_ID}/${path}`,
      });
      expect(sub.statusCode, path).toBe(200);
    }
  });

  it('distinguishes an empty group from an unknown one', async () => {
    readModel.groupExists.mockResolvedValue(false);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/groups/${OTHER_CONTRACT_ID}/payouts`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'group_not_found' });
    // The list is not consulted at all for an unknown group.
    expect(readModel.listPayouts).not.toHaveBeenCalled();
  });

  it('validates pagination on sub-resources', async () => {
    readModel.groupExists.mockResolvedValue(true);
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/activity?limit=5000`,
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('amount precision over the wire', () => {
  let app: FastifyInstance;
  let readModel: GroupReadModel & FakeReadModel;

  beforeAll(async () => {
    readModel = fakeReadModel();
    app = await buildTestServer(readModel);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serialises the largest i128 as exact digits, not a rounded number', async () => {
    // The value that would be rounded if it travelled as an IEEE-754 double.
    const maxI128 = '170141183460469231731687303715884105727';
    readModel.getGroup.mockResolvedValueOnce({
      ...groupSummary({
        contributionAmount: maxI128,
        contributedTotal: maxI128,
        paidOutTotal: maxI128,
        feeTotal: maxI128,
      }),
      members: [],
      rounds: [],
    });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}`,
    });

    // Asserted against the raw body: `response.json()` would parse it back into
    // a number and hide exactly the corruption this test exists to catch.
    expect(response.body).toContain(`"contributedTotal":"${maxI128}"`);
    expect(response.body).not.toContain('170141183460469231731687303700000000');
  });
});
