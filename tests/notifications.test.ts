import { afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type {
  MarkReadOutcome,
  NotificationReadModel,
  NotificationView,
} from '../src/db/notifications';
import type { TokenVerifier } from '../src/auth/verify';
import { configureTestEnv } from './support/fixtures';

configureTestEnv();

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_USER_ID = '22222222-2222-2222-2222-222222222222';
const NOTIFICATION_ID = '99999999-9999-9999-9999-999999999999';
const AUTH = { authorization: 'Bearer a-good-token' };

const built: FastifyInstance[] = [];

afterAll(async () => {
  await Promise.all(built.map(async (app) => app.close()));
});

function view(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id: NOTIFICATION_ID,
    kind: 'payout_confirmed',
    title: 'Payout confirmed',
    body: 'You received 25.00 USDC.',
    data: { contractId: 'C'.padEnd(56, 'A') },
    readAt: null,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

type FakeModel = NotificationReadModel & {
  list: ReturnType<typeof vi.fn>;
  unreadCount: ReturnType<typeof vi.fn>;
  markRead: ReturnType<typeof vi.fn>;
};

function fakeModel(
  overrides: Partial<Record<keyof NotificationReadModel, unknown>> = {},
): FakeModel {
  return {
    list: vi.fn(async () => ({ items: [view()], hasMore: false })),
    unreadCount: vi.fn(async () => 1),
    markRead: vi.fn(async () => 'read' as MarkReadOutcome),
    ...overrides,
  } as unknown as FakeModel;
}

async function harness(options: { model?: FakeModel } = {}): Promise<{
  app: FastifyInstance;
  model: FakeModel;
}> {
  const { buildServer } = await import('../src/server');

  const model = options.model ?? fakeModel();
  const verify = vi.fn(async () => ({ id: USER_ID, email: 'ada@example.com' }));

  const app = await buildServer({
    probeDatabase: async () => {},
    verifyToken: verify as unknown as TokenVerifier,
    notificationReadModel: model,
    readModel: {
      groupExists: vi.fn(),
      listGroups: vi.fn(),
      getGroup: vi.fn(),
      listContributions: vi.fn(),
      listPayouts: vi.fn(),
      listActivity: vi.fn(),
    } as never,
  });
  built.push(app);

  return { app, model };
}

describe('GET /api/v1/notifications', () => {
  it('refuses an unauthenticated request', async () => {
    const { app, model } = await harness();

    const response = await app.inject({ method: 'GET', url: '/api/v1/notifications' });

    expect(response.statusCode).toBe(401);
    expect(model.list).not.toHaveBeenCalled();
  });

  it('returns the caller’s notifications, newest first, in a page envelope', async () => {
    const { app, model } = await harness();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(1);
    expect(response.json().page).toEqual({ limit: 20, offset: 0, hasMore: false });
    expect(model.list).toHaveBeenCalledWith(USER_ID, { limit: 20, offset: 0 });
  });

  it('reports the unread count alongside the page', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: AUTH,
    });

    // A badge needs a count, and a page of read notifications cannot supply it.
    expect(response.json().unreadCount).toBe(1);
  });

  it('scopes to the token’s user, never a query parameter', async () => {
    const { app, model } = await harness();

    await app.inject({
      method: 'GET',
      url: `/api/v1/notifications?userId=${OTHER_USER_ID}`,
      headers: AUTH,
    });

    // An extra parameter is not a way to read somebody else's inbox: unknown
    // fields are dropped by the schema, and the id comes from the token.
    expect(model.list).toHaveBeenCalledWith(USER_ID, { limit: 20, offset: 0 });
    expect(model.unreadCount).toHaveBeenCalledWith(USER_ID);
  });

  it('filters to unread when asked', async () => {
    const { app, model } = await harness();

    await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?unread=true',
      headers: AUTH,
    });

    expect(model.list).toHaveBeenCalledWith(USER_ID, {
      limit: 20,
      offset: 0,
      unreadOnly: true,
    });
  });

  it('does not filter when unread is false', async () => {
    const { app, model } = await harness();

    await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?unread=false',
      headers: AUTH,
    });

    // `false` means "no filter", which must be distinct from an absent parameter
    // only in intent, not in effect.
    expect(model.list).toHaveBeenCalledWith(USER_ID, {
      limit: 20,
      offset: 0,
      unreadOnly: false,
    });
  });

  it('refuses an unread value that is neither true nor false', async () => {
    const { app, model } = await harness();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?unread=1',
      headers: AUTH,
    });

    // Also guards against `unread=anything` silently returning a full list, which
    // is the failure mode a truthiness check would produce.
    expect(response.statusCode).toBe(400);
    expect(model.list).not.toHaveBeenCalled();
  });

  it('refuses a limit beyond the maximum', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?limit=5000',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(400);
  });

  it('forbids caching a user’s inbox', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications',
      headers: AUTH,
    });

    // This URL is identical for every user, so a shared cache would serve one
    // account's notifications to another.
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('POST /api/v1/notifications/:notificationId/read', () => {
  it('refuses an unauthenticated request', async () => {
    const { app, model } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${NOTIFICATION_ID}/read`,
    });

    expect(response.statusCode).toBe(401);
    expect(model.markRead).not.toHaveBeenCalled();
  });

  it('marks a notification read for the token’s user', async () => {
    const { app, model } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${NOTIFICATION_ID}/read`,
      headers: AUTH,
    });

    expect(response.statusCode).toBe(204);
    expect(model.markRead).toHaveBeenCalledWith(USER_ID, NOTIFICATION_ID);
  });

  it('returns no body when it succeeds', async () => {
    const { app } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${NOTIFICATION_ID}/read`,
      headers: AUTH,
    });

    expect(response.body).toBe('');
  });

  it('treats an already-read notification as success', async () => {
    const model = fakeModel({ markRead: vi.fn(async () => 'already_read' as MarkReadOutcome) });
    const { app } = await harness({ model });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${NOTIFICATION_ID}/read`,
      headers: AUTH,
    });

    // Marking read is idempotent by nature; a retry after a dropped response must
    // not look like a failure.
    expect(response.statusCode).toBe(204);
  });

  it('reports another user’s notification as absent', async () => {
    const model = fakeModel({ markRead: vi.fn(async () => 'not_found' as MarkReadOutcome) });
    const { app } = await harness({ model });

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${NOTIFICATION_ID}/read`,
      headers: AUTH,
    });

    // A 403 here would confirm the id is real, which is the one thing a
    // not-yours notification should not disclose.
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'notification_not_found' });
  });

  it('refuses a malformed notification id', async () => {
    const { app, model } = await harness();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/notifications/not-an-id/read',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(400);
    expect(model.markRead).not.toHaveBeenCalled();
  });

  it('refuses a user id supplied in the body', async () => {
    const { app, model } = await harness();

    await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${NOTIFICATION_ID}/read`,
      headers: AUTH,
      payload: { userId: OTHER_USER_ID, readAt: new Date(0).toISOString() },
    });

    // The body is not read at all: identity and the read timestamp are the
    // server's to decide.
    expect(model.markRead).toHaveBeenCalledWith(USER_ID, NOTIFICATION_ID);
  });
});
