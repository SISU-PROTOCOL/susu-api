import type { FastifyInstance } from 'fastify';

/**
 * Liveness and readiness endpoints.
 *
 * `/health` answers whether the process is alive.
 * `/ready` answers whether the service is ready to serve traffic.
 *
 * Database and chain-connectivity probes are added in Phase 4 and Phase 5, once
 * the schema and indexer exist. Until then `/ready` reports configuration only,
 * and says so explicitly rather than implying a deeper check occurred.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async () => ({
    status: 'ready',
    checks: {
      config: 'ok',
    },
    note: 'Database and chain readiness probes are added in Phase 4 and Phase 5.',
  }));
}
