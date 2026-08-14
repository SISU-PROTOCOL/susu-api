import type { FastifyInstance } from 'fastify';
import { probeDatabase as defaultProbeDatabase } from '../db/probe';

/**
 * Liveness and readiness endpoints.
 *
 * `/health` answers whether the process is alive. It deliberately does no I/O: a
 * liveness check that depends on the database restarts a healthy process when
 * the database is down, which is the opposite of helpful.
 *
 * `/ready` answers whether the service can serve traffic, which for this API
 * means reaching the indexer's tables. It reports each check individually rather
 * than a single verdict, so a failure says which dependency failed.
 */

export type HealthRoutesOptions = {
  /**
   * Readiness probe. Injectable so tests can exercise both outcomes without a
   * database; production uses the real one.
   */
  probeDatabase?: () => Promise<void>;
};

export async function healthRoutes(
  app: FastifyInstance,
  options: HealthRoutesOptions = {},
): Promise<void> {
  const probeDatabase = options.probeDatabase ?? defaultProbeDatabase;

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (request, reply) => {
    try {
      await probeDatabase();
    } catch (error) {
      // Logged in full, reported as a bare status: the client learns which
      // dependency is down, and the details stay in the server log.
      request.log.error({ err: error }, 'readiness probe failed');
      return reply.code(503).send({
        status: 'unavailable',
        checks: { config: 'ok', database: 'unavailable' },
      });
    }

    return reply.send({
      status: 'ready',
      checks: { config: 'ok', database: 'ok' },
    });
  });
}
