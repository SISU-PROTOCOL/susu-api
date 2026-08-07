import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function fakeJwt(payload: Record<string, unknown>): string {
  return `${encodeSegment({ alg: 'HS256', typ: 'JWT' })}.${encodeSegment(payload)}.signature`;
}

// Configure the environment before the server module reads it.
process.env['NODE_ENV'] = 'test';
process.env['PORT'] = '3000';
process.env['HOST'] = '0.0.0.0';
process.env['DATABASE_URL'] = 'postgresql://user:password@localhost:5432/postgres';
process.env['SUPABASE_URL'] = 'https://example.supabase.co';
process.env['SUPABASE_SERVICE_ROLE_KEY'] = fakeJwt({ role: 'service_role' });
process.env['STELLAR_NETWORK'] = 'testnet';
process.env['STELLAR_RPC_URL'] = 'https://soroban-testnet.stellar.org';
process.env['STELLAR_NETWORK_PASSPHRASE'] = 'Test SDF Network ; September 2015';
process.env['FACTORY_CONTRACT_ID'] = '';
process.env['USDC_CONTRACT_ID'] = '';
process.env['TREASURY_ADDRESS'] = '';
process.env['PROTOCOL_FEE_BPS'] = '50';
process.env['WALLET_NONCE_SECRET'] = 'a'.repeat(32);
process.env['ALLOW_MAINNET'] = 'false';
process.env['CORS_ALLOWED_ORIGINS'] = 'http://localhost:5173';

let app: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import('../src/server');
  app = await buildServer();
});

afterAll(async () => {
  await app?.close();
});

describe('health routes', () => {
  it('reports liveness', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness without claiming unverified checks', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { status: string; checks: Record<string, string> };
    expect(body.status).toBe('ready');
    expect(body.checks['config']).toBe('ok');
  });
});

describe('unknown routes', () => {
  it('returns a generic 404 without internal detail', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });
});

describe('CORS allowlist', () => {
  it('allows a configured origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not allow an origin outside the allowlist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('response headers', () => {
  it('applies secure headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBeDefined();
  });
});
