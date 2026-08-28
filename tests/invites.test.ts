import { afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InviteStore, RedeemOutcome } from '../src/db/invites';
import type { TokenVerifier } from '../src/auth/verify';
import { configureTestEnv, GROUP_CONTRACT_ID, OTHER_CONTRACT_ID } from './support/fixtures';

configureTestEnv();

const USER_ID = '11111111-1111-1111-1111-111111111111';
const CODE = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const AUTH = { authorization: 'Bearer a-good-token' };

const built: FastifyInstance[] = [];

afterAll(async () => {
  await Promise.all(built.map(async (app) => app.close()));
});

type FakeStore = InviteStore & {
  create: ReturnType<typeof vi.fn>;
  redeem: ReturnType<typeof vi.fn>;
};

function fakeStore(): FakeStore {
  return {
    create: vi.fn(async (input: Record<string, unknown>) => ({
      id: '99999999-9999-9999-9999-999999999999',
      code: input['code'] as string,
      groupContractId: input['groupContractId'] as string,
      createdBy: input['createdBy'] as string,
      expiresAt: (input['expiresAt'] as Date | null)?.toISOString() ?? null,
      maxUses: (input['maxUses'] as number | null) ?? null,
      uses: 0,
      createdAt: new Date(0).toISOString(),
    })),
    redeem: vi.fn(
      async () =>
        ({
          outcome: 'redeemed',
          inviteId: 'invite-id',
          groupContractId: GROUP_CONTRACT_ID,
        }) as RedeemOutcome,
    ),
  } as unknown as FakeStore;
}

type Harness = { app: FastifyInstance; store: FakeStore; groupExists: ReturnType<typeof vi.fn> };

async function harness(options: { store?: FakeStore; known?: boolean } = {}): Promise<Harness> {
  const { buildServer } = await import('../src/server');

  const store = options.store ?? fakeStore();
  const groupExists = vi.fn(async () => options.known ?? true);
  const verify = vi.fn(async () => ({ id: USER_ID, email: 'ada@example.com' }));

  const app = await buildServer({
    probeDatabase: async () => {},
    verifyToken: verify as unknown as TokenVerifier,
    inviteStore: store,
    readModel: {
      groupExists,
      listGroups: vi.fn(),
      getGroup: vi.fn(),
      listContributions: vi.fn(),
      listPayouts: vi.fn(),
      listActivity: vi.fn(),
    } as never,
  });
  built.push(app);

  return { app, store, groupExists };
}

describe('POST /api/v1/groups/:contractId/invites', () => {
  it('refuses an unauthenticated request', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('creates a code for an existing group', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(201);
    const data = response.json().data;
    // 32 bytes in base64url.
    expect(data.code).toHaveLength(43);
    expect(data.groupContractId).toBe(GROUP_CONTRACT_ID);
    expect(data.maxUses).toBeNull();
    expect(typeof data.expiresAt).toBe('string');

    // The creator is the authenticated user, never a value from the body.
    expect(store.create).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: USER_ID, groupContractId: GROUP_CONTRACT_ID }),
    );
  });

  it('issues a code that is not the group address', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: {},
    });

    // The failure this project already made once: a contract address is public
    // and enumerable, so using it as a code means everyone has the code.
    expect(response.json().data.code).not.toBe(GROUP_CONTRACT_ID);
    expect(response.json().data.code).not.toMatch(/^[GC][A-Z2-7]{55}$/);
  });

  it('defaults the expiry rather than issuing a code that never expires', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: {},
    });

    const expiresAt = Date.parse(response.json().data.expiresAt);
    // The document requires expiring codes; "never" is the one value that cannot
    // be walked back after a leak.
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 8 * 24 * 60 * 60 * 1000);
  });

  it('honours an explicit expiry and use limit', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: { expiresInHours: 2, maxUses: 3 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data.maxUses).toBe(3);
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ maxUses: 3 }));
  });

  it('refuses an expiry beyond the maximum', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: { expiresInHours: 24 * 365 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });

  it('refuses a non-positive use limit', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: { maxUses: 0 },
    });

    // Zero uses is far likelier to be a bug than an intention, and omitting the
    // field already means unlimited.
    expect(response.statusCode).toBe(400);
  });

  it('reports an unknown group rather than creating a code for it', async () => {
    const { app, store } = await harness({ known: false });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'group_not_found' });
    expect(store.create).not.toHaveBeenCalled();
  });

  it('refuses a malformed contract id', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/not-a-contract/invites`,
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('forbids caching the code', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/invites`,
      headers: AUTH,
      payload: {},
    });

    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/v1/invites/redeem', () => {
  it('refuses an unauthenticated request', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(401);
  });

  it('redeems a code for the authenticated user', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      groupContractId: GROUP_CONTRACT_ID,
      inviteId: 'invite-id',
    });
    // The user is the token's, never the body's. The store is not told which
    // group: the code names it, which is what lets an invite link work without
    // carrying an address.
    expect(store.redeem).toHaveBeenCalledWith({ code: CODE, userId: USER_ID });
  });

  it('needs no group address, because the code identifies the group', async () => {
    const { app, store } = await harness();

    // The code is the whole request. An invite link carries a code and nothing
    // else, so a redemption that required a contract id could never be made from
    // one.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(200);
    expect(store.redeem).toHaveBeenCalledTimes(1);
  });

  it('reports the group the code admits to', async () => {
    const store = fakeStore();
    store.redeem = vi.fn(
      async () =>
        ({
          outcome: 'redeemed',
          inviteId: 'invite-id',
          groupContractId: OTHER_CONTRACT_ID,
        }) as RedeemOutcome,
    );
    const { app } = await harness({ store });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    // The caller has no other way to learn it, and needs it to send the on-chain
    // join.
    expect(response.json().data.groupContractId).toBe(OTHER_CONTRACT_ID);
  });

  it('refuses a code shaped like a Stellar address without a lookup', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: `C${'A'.repeat(55)}` },
    });

    expect(response.statusCode).toBe(404);
    // Refused on shape, so junk codes do not become indexed lookups.
    expect(store.redeem).not.toHaveBeenCalled();
  });

  it('refuses a code that is too short without a lookup', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: 'short' },
    });

    expect(response.statusCode).toBe(404);
    expect(store.redeem).not.toHaveBeenCalled();
  });

  it('reports an unknown, expired or revoked code identically', async () => {
    // One answer for all three. Any distinction would confirm that a guessed
    // code is real, which is the one thing an unguessable code must not reveal.
    for (const outcome of ['not_found', 'expired', 'revoked'] as const) {
      const store = fakeStore();
      store.redeem = vi.fn(async () => ({ outcome }) as RedeemOutcome);
      const { app } = await harness({ store });

      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/invites/redeem',
        headers: AUTH,
        payload: { code: CODE },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: 'invite_not_found' });
    }
  });

  it('reports an exhausted code distinctly', async () => {
    const store = fakeStore();
    store.redeem = vi.fn(async () => ({ outcome: 'exhausted' }) as RedeemOutcome);
    const { app } = await harness({ store });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    // Distinct from not_found because the caller did nothing wrong and a fresh
    // invite is a real remedy.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'invite_exhausted' });
  });

  it('succeeds twice for the same user, because redemption is idempotent', async () => {
    const { app, store } = await harness();

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(store.redeem).toHaveBeenCalledTimes(2);
  });

  it('refuses a missing code', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
  });

  it('does not leak the code into a cacheable response', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/invites/redeem',
      headers: AUTH,
      payload: { code: CODE },
    });

    // The response names the group rather than echoing the code, so a shared
    // cache never holds the secret.
    expect(response.json().data.code).toBeUndefined();
  });
});
describe('POST /api/v1/groups/:contractId/join', () => {
  it('refuses an unauthenticated request', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/join`,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(401);
    expect(store.redeem).not.toHaveBeenCalled();
  });

  it('redeems a code for the authenticated user', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/join`,
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      groupContractId: GROUP_CONTRACT_ID,
      inviteId: 'invite-id',
    });
    expect(store.redeem).toHaveBeenCalledWith({ code: CODE, userId: USER_ID });
  });

  it('reports a code for a different group as absent', async () => {
    const store = fakeStore();
    store.redeem = vi.fn(
      async () =>
        ({
          outcome: 'redeemed',
          inviteId: 'invite-id',
          groupContractId: OTHER_CONTRACT_ID,
        }) as RedeemOutcome,
    );
    const { app } = await harness({ store });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/join`,
      headers: AUTH,
      payload: { code: CODE },
    });

    // The whole reason this shape exists: a client whose code and group came from
    // different places gets told, rather than being quietly joined to the other
    // group. Reported as absent rather than as a mismatch, so it confirms nothing
    // about the code.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'invite_not_found' });
  });

  it('accepts a code whose group matches the path', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/join`,
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(200);
  });

  it('refuses a malformed contract id without a lookup', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/groups/not-a-contract/join',
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(400);
    expect(store.redeem).not.toHaveBeenCalled();
  });

  it('reports an exhausted code distinctly, as the code-scoped shape does', async () => {
    const store = fakeStore();
    store.redeem = vi.fn(async () => ({ outcome: 'exhausted' }) as RedeemOutcome);
    const { app } = await harness({ store });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/groups/${GROUP_CONTRACT_ID}/join`,
      headers: AUTH,
      payload: { code: CODE },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'invite_exhausted' });
  });
});
