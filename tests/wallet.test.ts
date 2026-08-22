import { afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Keypair } from '@stellar/stellar-sdk/base';
import { createNonceIssuer, type NonceIssuer } from '../src/lib/nonce';
import type { WalletLinkStore } from '../src/db/wallet';
import type { TokenVerifier } from '../src/auth/verify';
import { configureTestEnv } from './support/fixtures';

configureTestEnv();

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';
const PASSPHRASE = 'Test SDF Network ; September 2015';

const AUTH = { authorization: 'Bearer a-good-token' };

const built: FastifyInstance[] = [];

afterAll(async () => {
  await Promise.all(built.map(async (app) => app.close()));
});

type FakeStore = WalletLinkStore & {
  consumeNonce: ReturnType<typeof vi.fn>;
  link: ReturnType<typeof vi.fn>;
  findAddress: ReturnType<typeof vi.fn>;
  reap: ReturnType<typeof vi.fn>;
};

function fakeStore(): FakeStore {
  const consumed = new Set<string>();
  return {
    consumeNonce: vi.fn(async ({ jti }: { jti: string }) => {
      if (consumed.has(jti)) return false;
      consumed.add(jti);
      return true;
    }),
    link: vi.fn(async () => ({ outcome: 'linked' as const })),
    findAddress: vi.fn(async () => undefined),
    reap: vi.fn(async () => 0),
  } as unknown as FakeStore;
}

type Harness = {
  app: FastifyInstance;
  store: FakeStore;
  nonces: NonceIssuer;
};

async function harness(
  options: {
    store?: FakeStore;
    verify?: TokenVerifier;
    now?: () => number;
  } = {},
): Promise<Harness> {
  const { buildServer } = await import('../src/server');

  const store = options.store ?? fakeStore();
  const verify = vi.fn(async () => ({ id: USER_ID, email: 'ada@example.com' }));
  const nonces = createNonceIssuer({
    secret: 'a'.repeat(32),
    networkPassphrase: PASSPHRASE,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const app = await buildServer({
    probeDatabase: async () => {},
    verifyToken: (options.verify ?? verify) as TokenVerifier,
    walletLinkStore: store,
    nonceIssuer: nonces,
  });
  built.push(app);

  return { app, store, nonces };
}

/** Issues a nonce through the real endpoint, so the flow is exercised end to end. */
async function issueNonce(
  app: FastifyInstance,
  address: string,
): Promise<{ nonce: string; message: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/wallet/nonce',
    headers: AUTH,
    payload: { address },
  });

  expect(response.statusCode).toBe(200);
  return response.json().data as { nonce: string; message: string };
}

describe('POST /api/v1/wallet/nonce', () => {
  it('refuses an unauthenticated request', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/nonce',
      payload: { address: Keypair.random().publicKey() },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('issues a nonce and the message to sign', async () => {
    const { app } = await harness();
    const address = Keypair.random().publicKey();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/nonce',
      headers: AUTH,
      payload: { address },
    });

    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(typeof data.nonce).toBe('string');
    expect(data.message).toContain(`Address: ${address}`);
    expect(data.message).toContain(`Account: ${USER_ID}`);
    expect(typeof data.expiresAt).toBe('string');
  });

  it('binds the nonce to the authenticated account', async () => {
    const { app, nonces } = await harness();
    const address = Keypair.random().publicKey();

    const { nonce } = await issueNonce(app, address);

    // The account comes from the token, not from anything the caller sent. If it
    // came from the body, a nonce could be minted for another user.
    expect(nonces.read(nonce)?.userId).toBe(USER_ID);
  });

  it('refuses a contract address, which cannot sign', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/nonce',
      headers: AUTH,
      payload: { address: `C${'A'.repeat(55)}` },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });

  it('refuses a malformed address', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/nonce',
      headers: AUTH,
      payload: { address: 'not-an-address' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
  });

  it('forbids caching a nonce', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/nonce',
      headers: AUTH,
      payload: { address: Keypair.random().publicKey() },
    });

    // A shared cache holding one user's nonce under a URL another user can
    // request would hand them the other's nonce.
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/v1/wallet/verify', () => {
  it('refuses an unauthenticated request', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      payload: { address: Keypair.random().publicKey(), nonce: 'x', signature: 'y' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('links a wallet whose signature checks out', async () => {
    const { app, store, nonces } = await harness();
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const { nonce } = await issueNonce(app, address);
    const claims = nonces.read(nonce)!;
    const signature = Buffer.from(keypair.signMessage(nonces.message(claims))).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload: { address, nonce, signature },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: { walletAddress: address } });
    expect(store.link).toHaveBeenCalledWith({ userId: USER_ID, address });
  });

  it('accepts a raw signature as well as a SEP-53 one', async () => {
    const { app, nonces } = await harness();
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const { nonce } = await issueNonce(app, address);
    const claims = nonces.read(nonce)!;
    const message = nonces.message(claims);
    const signature = Buffer.from(keypair.sign(Buffer.from(message, 'utf8'))).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload: { address, nonce, signature },
    });

    // Which scheme a wallet produces is the wallet's choice, not ours; both
    // prove control of the key over the message we built.
    expect(response.statusCode).toBe(200);
  });

  it('refuses a signature over a different message', async () => {
    const { app, store } = await harness();
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const { nonce } = await issueNonce(app, address);
    const signature = Buffer.from(keypair.signMessage('something else entirely')).toString(
      'base64',
    );

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload: { address, nonce, signature },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_signature' });
    expect(store.link).not.toHaveBeenCalled();
  });

  it("refuses another key's signature for the claimed address", async () => {
    const { app, store } = await harness();
    const victim = Keypair.random();
    const attacker = Keypair.random();

    const { nonce, message } = await issueNonce(app, victim.publicKey());
    const signature = Buffer.from(attacker.signMessage(message)).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload: { address: victim.publicKey(), nonce, signature },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_signature' });
    expect(store.link).not.toHaveBeenCalled();
  });

  it('refuses a nonce issued for a different address', async () => {
    const { app, store, nonces } = await harness();
    const keypair = Keypair.random();
    const other = Keypair.random();

    // A nonce for `other`, signed correctly, presented for `keypair`.
    const { nonce } = await issueNonce(app, other.publicKey());
    const claims = nonces.read(nonce)!;
    const signature = Buffer.from(other.signMessage(nonces.message(claims))).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload: { address: keypair.publicKey(), nonce, signature },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_nonce' });
    expect(store.link).not.toHaveBeenCalled();
  });

  it("refuses another account's nonce", async () => {
    const { buildServer } = await import('../src/server');

    // Issue the nonce as a different authenticated user, then present it here.
    const store = fakeStore();
    const nonces = createNonceIssuer({ secret: 'a'.repeat(32), networkPassphrase: PASSPHRASE });
    const verifyAsOther = vi.fn(async () => ({ id: OTHER_ID, email: 'other@example.com' }));

    const other = await buildServer({
      probeDatabase: async () => {},
      verifyToken: verifyAsOther as unknown as TokenVerifier,
      walletLinkStore: store,
      nonceIssuer: nonces,
    });
    built.push(other);

    const keypair = Keypair.random();
    const { nonce } = await issueNonce(other, keypair.publicKey());
    const claims = nonces.read(nonce)!;
    const signature = Buffer.from(keypair.signMessage(nonces.message(claims))).toString('base64');

    const { app } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload: { address: keypair.publicKey(), nonce, signature },
    });

    // The nonce is not a bearer token: it names the account it was issued to.
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_nonce' });
  });

  it('refuses a forged nonce', async () => {
    const { app, store } = await harness();
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const { nonce, message } = await issueNonce(app, address);
    const forged = `${nonce.split('.')[0]}.${'A'.repeat(43)}`;
    const signature = Buffer.from(keypair.signMessage(message)).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload: { address, nonce: forged, signature },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_nonce' });
    expect(store.link).not.toHaveBeenCalled();
  });

  it('refuses a replayed nonce', async () => {
    const { app, store, nonces } = await harness();
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const { nonce } = await issueNonce(app, address);
    const claims = nonces.read(nonce)!;
    const signature = Buffer.from(keypair.signMessage(nonces.message(claims))).toString('base64');
    const payload = { address, nonce, signature };

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload,
    });

    expect(first.statusCode).toBe(200);
    // Single use is the property that makes a captured request worthless.
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'nonce_reused' });
    expect(store.link).toHaveBeenCalledTimes(1);
  });

  it('reports an address already bound to another account', async () => {
    const store = fakeStore();
    store.link = vi.fn(async () => ({ outcome: 'address_taken' as const }));

    const { app, nonces } = await harness({ store });
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const { nonce } = await issueNonce(app, address);
    const claims = nonces.read(nonce)!;
    const signature = Buffer.from(keypair.signMessage(nonces.message(claims))).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload: { address, nonce, signature },
    });

    // A genuine conflict: the caller proved control of an address the app has
    // already given to somebody else.
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'wallet_already_linked' });
  });

  it('refuses an expired nonce', async () => {
    const clock = { now: 1_700_000_000_000 };
    const { app, store } = await harness({ now: () => clock.now });
    const keypair = Keypair.random();
    const address = keypair.publicKey();

    const { nonce, message } = await issueNonce(app, address);
    const signature = Buffer.from(keypair.signMessage(message)).toString('base64');

    clock.now += 6 * 60 * 1000;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload: { address, nonce, signature },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'invalid_nonce' });
    expect(store.link).not.toHaveBeenCalled();
  });

  it('refuses a malformed signature', async () => {
    const { app, store } = await harness();
    const address = Keypair.random().publicKey();
    const { nonce } = await issueNonce(app, address);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload: { address, nonce, signature: 'not base64 !!!' },
    });

    expect(response.statusCode).toBe(400);
    expect(store.link).not.toHaveBeenCalled();
  });

  it('refuses a contract address as the claimed address', async () => {
    const { app, store } = await harness();
    const keypair = Keypair.random();
    const { nonce, message } = await issueNonce(app, keypair.publicKey());
    const signature = Buffer.from(keypair.signMessage(message)).toString('base64');

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload: { address: `C${'A'.repeat(55)}`, nonce, signature },
    });

    expect(response.statusCode).toBe(400);
    expect(store.link).not.toHaveBeenCalled();
  });

  it('does not spend the nonce when the signature is wrong', async () => {
    const { app, store } = await harness();
    const keypair = Keypair.random();
    const address = keypair.publicKey();
    const { nonce } = await issueNonce(app, address);

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/wallet/verify',
      headers: AUTH,
      payload: {
        address,
        nonce,
        signature: Buffer.from(keypair.signMessage('wrong')).toString('base64'),
      },
    });

    expect(response.statusCode).toBe(400);
    // A failed attempt must not burn the nonce, or a mistyped wallet would
    // require starting over rather than trying again.
    expect(store.consumeNonce).not.toHaveBeenCalled();
  });
});
