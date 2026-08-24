/**
 * The notification endpoints.
 *
 * Both are authenticated and both scope to the caller. A notification is written
 * by the system, not by the user, so the only thing a user can do to one is mark
 * it read — and the only ones they can see are their own.
 *
 * `no-store` rather than the short shared cache the group routes use. Group data
 * is public and identical for everyone; this is one user's inbox under a URL that
 * another user can request, which is the classic way a shared cache leaks one
 * account's data to another.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticatedUser } from '../auth/guard';
import type { NotificationReadModel } from '../db/notifications';
import { envelope, paginationFields } from '../lib/pagination';
import { UUID_SHAPE } from '../lib/uuid';
import { invalidRequest } from './errors';

const NO_STORE = 'no-store';

export type NotificationRoutesOptions = {
  readModel: NotificationReadModel;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

const listQuery = z.object({
  ...paginationFields,
  /**
   * `true` restricts to unread. Coerced from the string a query parameter always
   * is, and accepting only `true`/`false` means a typo is a 400 rather than a
   * silently unfiltered list.
   */
  unread: z.enum(['true', 'false']).optional(),
});

const notificationIdParams = z.object({
  notificationId: z.string().regex(UUID_SHAPE, 'must be a notification id'),
});

export async function notificationRoutes(
  app: FastifyInstance,
  options: NotificationRoutesOptions,
): Promise<void> {
  const { readModel, requireAuth } = options;

  app.get('/notifications', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply, parsed.error);

    const user = authenticatedUser(request);
    const { limit, offset, unread } = parsed.data;

    const result = await readModel.list(user.id, {
      limit,
      offset,
      ...(unread === undefined ? {} : { unreadOnly: unread === 'true' }),
    });
    const unreadCount = await readModel.unreadCount(user.id);

    reply.header('cache-control', NO_STORE);
    return reply.send({ ...envelope(result, limit, offset), unreadCount });
  });

  app.post(
    '/notifications/:notificationId/read',
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = notificationIdParams.safeParse(request.params);
      if (!parsed.success) return invalidRequest(reply, parsed.error);

      const user = authenticatedUser(request);
      const outcome = await readModel.markRead(user.id, parsed.data.notificationId);

      // A notification that does not exist *for this user* is a 404, and that
      // includes one belonging to somebody else: the answer must not reveal that
      // the id is real.
      if (outcome === 'not_found') return reply.code(404).send({ error: 'notification_not_found' });

      // `already_read` succeeds too. Marking read is idempotent by nature — the
      // caller's intent is "this should be read", and it is — so a retry after a
      // dropped response must not look like a failure.
      return reply.code(204).send();
    },
  );
}
