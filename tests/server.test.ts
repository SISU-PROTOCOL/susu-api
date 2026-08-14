import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { configureTestEnv } from './support/fixtures';

configureTestEnv();

let app: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import('../src/server');
  // The readiness probe is injected so the suite does not need a database. The
  // real probe's failure path is covered explicitly below.
  app = await buildServer({ probeDatabase: async () => {} });
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

  it('reports readiness with each check named', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: { config: 'ok', database: 'ok' },
    });
  });
});

describe('readiness when the database is unreachable', () => {
  it('reports unavailable without leaking the failure', async () => {
    const { buildServer } = await import('../src/server');
    const failing = await buildServer({
      probeDatabase: async () => {
        throw new Error('connection refused to postgresql://user:password@localhost:5432');
      },
    });

    try {
      const response = await failing.inject({ method: 'GET', url: '/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'unavailable',
        checks: { config: 'ok', database: 'unavailable' },
      });
      // The connection string must not reach the client, even inside an error.
      expect(response.body).not.toContain('password');
    } finally {
      await failing.close();
    }
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
