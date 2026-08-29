import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { RegistrationStore } from '../src/db/registrations';
import type { TokenVerifier } from '../src/auth/verify';
import { configureTestEnv, GROUP_CONTRACT_ID } from './support/fixtures';

/**
 * `POST /groups`: the one write on the group surface.
 *
 * It records an address the chain has just produced so the creator can invite
 * people before the indexer's next run. The tests worth having are about what it
 * refuses — an unauthenticated caller, an address that is not a contract, a claim
 * beyond the cap — and about the one thing it must never do, which is take the
 * account to register as from the request.
 */

configureTestEnv();

const USER_ID = '11111111-1111-1111-1111-111111111111';
const AUTH = { authorization: 'Bearer a-good-token' };

const built: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(built.splice(0).map(async (app) => app.close()));
});

type FakeStore = RegistrationStore & { register: ReturnType<typeof vi.fn> };

function fakeStore(): FakeStore {
  return {
    register: vi.fn(async () => ({
      outcome: 'registered',
      contractId: GROUP_CONTRACT_ID,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
    isRegistered: vi.fn(async () => true),
  } as unknown as FakeStore;
}

async function harness(store: FakeStore = fakeStore()): Promise<{
  app: FastifyInstance;
  store: FakeStore;
}> {
  const { buildServer } = await import('../src/server');
  const verify = vi.fn(async () => ({ id: USER_ID, email: 'ada@example.com' }));

  const app = await buildServer({
    probeDatabase: async () => {},
    verifyToken: verify as unknown as TokenVerifier,
    registrations: store,
  });
  built.push(app);

  return { app, store };
}

describe('POST /api/v1/groups', () => {
  it('refuses an unauthenticated request', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      payload: { contractId: GROUP_CONTRACT_ID },
    });

    expect(response.statusCode).toBe(401);
    expect(store.register).not.toHaveBeenCalled();
  });

  it('registers the address for the authenticated account', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: AUTH,
      payload: { contractId: GROUP_CONTRACT_ID },
    });

    expect(response.statusCode).toBe(201);
    const data = response.json().data as { contractId: string; expiresAt: string };
    expect(data.contractId).toBe(GROUP_CONTRACT_ID);
    expect(typeof data.expiresAt).toBe('string');

    // The account is the authenticated one. A user id in the body would let a
    // caller make claims in someone else's name, so there is no field for it.
    expect(store.register).toHaveBeenCalledWith({ contractId: GROUP_CONTRACT_ID, userId: USER_ID });
  });

  it('does not let the response be cached', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: AUTH,
      payload: { contractId: GROUP_CONTRACT_ID },
    });

    // The body reports the outcome of this caller's claim. A shared cache holding
    // it would report one account's registration to another.
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('refuses an address that is not a contract', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: AUTH,
      // A classic account address: a valid Stellar address, but a group is a
      // contract, and a registration for a `G` address could never resolve.
      payload: { contractId: `G${'A'.repeat(55)}` },
    });

    expect(response.statusCode).toBe(400);
    expect(store.register).not.toHaveBeenCalled();
  });

  it('refuses a body with no address', async () => {
    const { app, store } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(store.register).not.toHaveBeenCalled();
  });

  it('reports the cap rather than registering beyond it', async () => {
    const store = fakeStore();
    store.register.mockResolvedValueOnce({ outcome: 'too_many' });
    const { app } = await harness(store);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/groups',
      headers: AUTH,
      payload: { contractId: GROUP_CONTRACT_ID },
    });

    // A conflict rather than a validation error: the request was well-formed and
    // the caller is doing something the account is currently not allowed to do.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'too_many_registrations' });
  });
});
