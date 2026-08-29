import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { getEnv } from './lib/env';
import { buildLoggerOptions } from './lib/logger';
import { createGroupReadModel, type GroupReadModel } from './db/groups';
import { createAccountReadModel, type AccountReadModel } from './db/me';
import { createWalletLinkStore, type WalletLinkStore } from './db/wallet';
import { createInviteStore, type InviteStore } from './db/invites';
import { createRegistrationStore, type RegistrationStore } from './db/registrations';
import { createNotificationReadModel, type NotificationReadModel } from './db/notifications';
import { createTransactionReadModel, type TransactionReadModel } from './db/transactions';
import { createNonceIssuer, type NonceIssuer } from './lib/nonce';
import { getDb } from './db/client';
import { createRequireAuth } from './auth/guard';
import { createTokenVerifier, type TokenVerifier } from './auth/verify';
import {
  createAccountDeleter,
  createSupabaseAdminClient,
  type AccountDeleter,
} from './supabase/admin';
import { healthRoutes } from './routes/health';
import { groupRoutes } from './routes/groups';
import { inviteRoutes } from './routes/invites';
import { meRoutes } from './routes/me';
import { notificationRoutes } from './routes/notifications';
import { transactionRoutes } from './routes/transactions';
import { walletRoutes } from './routes/wallet';

/**
 * Dependencies a caller may substitute.
 *
 * All are injectable so tests can exercise the routes — including the failure
 * paths, which are the ones worth testing — without a database or a Supabase
 * project. Production passes none of them and gets the real implementations.
 */
export type BuildServerOptions = {
  readModel?: GroupReadModel;
  probeDatabase?: () => Promise<void>;
  accountReadModel?: AccountReadModel;
  verifyToken?: TokenVerifier;
  deleteAccount?: AccountDeleter;
  walletLinkStore?: WalletLinkStore;
  nonceIssuer?: NonceIssuer;
  inviteStore?: InviteStore;
  registrations?: RegistrationStore;
  notificationReadModel?: NotificationReadModel;
  transactionReadModel?: TransactionReadModel;
};

/**
 * Builds the API server.
 *
 * SECURITY POSTURE
 * - Strict CORS allowlist: an empty allowlist means no cross-origin access.
 * - Secure headers via helmet.
 * - Rate limiting enabled globally.
 * - Small request body limit.
 * - Secret-free structured logging with redaction.
 *
 * This service is an application layer only. It never holds custody and never
 * decides balances, payout recipients, eligibility, or financial authorization.
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const env = getEnv();

  const app = Fastify({
    logger: buildLoggerOptions(env.NODE_ENV),
    bodyLimit: 64 * 1024,
    trustProxy: true,
  });

  await app.register(helmet, {
    // This service returns JSON only; CSP is applied by the web app host.
    contentSecurityPolicy: false,
  });

  const allowedOrigins = env.CORS_ALLOWED_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  await app.register(cors, {
    origin: allowedOrigins.length > 0 ? allowedOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  await app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  await app.register(healthRoutes, { probeDatabase: options.probeDatabase });

  // One Supabase client, shared by token verification and account deletion.
  // Constructing it opens no connection, so this costs nothing on routes that
  // never touch Supabase.
  const supabase = createSupabaseAdminClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const verifyToken = options.verifyToken ?? createTokenVerifier(supabase);
  const deleteAccount = options.deleteAccount ?? createAccountDeleter(supabase);

  // Account routes are the authenticated surface: each declares `requireAuth`,
  // and identity comes from the verified token rather than from the request.
  await app.register(meRoutes, {
    prefix: '/api/v1',
    accountReadModel: options.accountReadModel ?? createAccountReadModel(getDb()),
    requireAuth: createRequireAuth(verifyToken),
    deleteAccount,
  });

  // Wallet linking is a two-step authenticated handshake. The nonce issuer holds
  // the signing secret and the message shape; the store owns the two facts the
  // database enforces — that a nonce is spent once, and that an address belongs
  // to one account.
  await app.register(walletRoutes, {
    prefix: '/api/v1',
    requireAuth: createRequireAuth(verifyToken),
    store: options.walletLinkStore ?? createWalletLinkStore(getDb()),
    nonces:
      options.nonceIssuer ??
      createNonceIssuer({
        secret: env.WALLET_NONCE_SECRET,
        networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE,
      }),
  });

  // Versioned application surface. `getDb()` builds a connection pool lazily, so
  // constructing the read model opens no connection until the first query. One
  // instance is shared by the public group routes and by the invite routes, which
  // need it to tell "this group has nothing yet" from "there is no such group".
  const groupReadModel = options.readModel ?? createGroupReadModel(getDb());

  // The registrations a creator makes when the indexer has not yet seen their
  // group. Shared by the route that records them and the invite gate that honours
  // them, so the two cannot disagree about what "known" means.
  const registrations = options.registrations ?? createRegistrationStore(getDb());

  /**
   * Whether an address may be treated as a group.
   *
   * The index is the authority, but it trails the chain by up to one indexing run,
   * and the creator is the person most likely to need the API to recognise a group
   * in exactly that window. An unexpired registration is the same answer for a
   * bounded while; see `db/registrations.ts` for why a claim is acceptable here.
   */
  const isKnownGroup = async (contractId: string): Promise<boolean> => {
    if (await groupReadModel.groupExists(contractId)) return true;
    return registrations.isRegistered(contractId);
  };

  const requireAuth = createRequireAuth(verifyToken);

  await app.register(groupRoutes, {
    prefix: '/api/v1',
    readModel: groupReadModel,
    requireAuth,
    registrations,
  });

  await app.register(inviteRoutes, {
    prefix: '/api/v1',
    requireAuth,
    store: options.inviteStore ?? createInviteStore(getDb()),
    isKnownGroup,
  });

  // Notifications are user-owned and injected as a model, like the account routes
  // above: the API connects as the database owner, so RLS does not apply to these
  // queries and each statement scopes to the caller itself.
  await app.register(notificationRoutes, {
    prefix: '/api/v1',
    requireAuth: createRequireAuth(verifyToken),
    readModel: options.notificationReadModel ?? createNotificationReadModel(getDb()),
  });

  // Public and read-only, like the group routes: a transaction's events are on
  // the ledger already, so there is nothing here to authorise.
  await app.register(transactionRoutes, {
    prefix: '/api/v1',
    readModel: options.transactionReadModel ?? createTransactionReadModel(getDb()),
  });

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send({ error: 'not_found' });
  });

  app.setErrorHandler(async (error: FastifyError, request, reply) => {
    request.log.error({ err: error }, 'request failed');

    // Never surface internal error details to clients.
    const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    await reply.code(statusCode).send({
      error: statusCode === 500 ? 'internal_error' : error.code || 'request_error',
    });
  });

  return app;
}
