import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticatedUser } from '../auth/guard';
import type { GroupReadModel } from '../db/groups';
import type { RegistrationStore } from '../db/registrations';
import { envelope, paginationFields } from '../lib/pagination';
import { invalidRequest } from './errors';

/**
 * Group endpoints.
 *
 * Every read here is a report of what the contracts did, read from the indexer's
 * tables. Nothing decides an amount, a recipient, or eligibility.
 *
 * The one write, `POST /groups`, is not a group either. It registers an address the
 * chain has just produced so that the creator can invite people before the indexer
 * has seen the creation event; see `db/registrations.ts` for what it is and is not,
 * and why a bounded claim is the right shape for the gap.
 *
 * The chain is authoritative, so read responses can be stale: the index trails
 * the chain by up to one scheduled indexing run. The short `cache-control` below
 * acknowledges the same thing, and a client that needs certainty reads the
 * contract.
 */

/**
 * Chain-derived data is public and changes only when the indexer runs, so it is
 * cacheable — briefly. The window is deliberately short: a client usually looks
 * immediately after sending a transaction, and a cached "no contribution yet"
 * is precisely the wrong answer to serve at that moment.
 */
const CACHE_CONTROL = 'public, max-age=5, stale-while-revalidate=25';

/** A Soroban contract address: `C` followed by 55 base-32 characters. */
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/**
 * A Soroban address.
 *
 * `G` is a classic account and `C` a contract, and both are valid members,
 * creators and recipients: a wallet-contract member is a `C` address, so a
 * `G`-only pattern would reject real groups.
 */
const ADDRESS_PATTERN = /^[GC][A-Z2-7]{55}$/;

const contractIdParams = z.object({
  contractId: z.string().regex(CONTRACT_ID_PATTERN, 'must be a Soroban contract address'),
});

const listGroupsQuery = z.object({
  status: z.enum(['open', 'active', 'completed']).optional(),
  creator: z.string().regex(ADDRESS_PATTERN, 'must be a Stellar address').optional(),
  member: z.string().regex(ADDRESS_PATTERN, 'must be a Stellar address').optional(),
  ...paginationFields,
});

const pageQuery = z.object(paginationFields);

const registerBody = z.object({
  contractId: z.string().regex(CONTRACT_ID_PATTERN, 'must be a Soroban contract address'),
});

export type GroupRoutesOptions = {
  readModel: GroupReadModel;
  /** The authenticated-route guard. Injected, as elsewhere, for testability. */
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  registrations: RegistrationStore;
};

function groupNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'group_not_found' });
}

/**
 * Answers whether a group is known, reporting it missing when it is not.
 *
 * Sub-resources read from tables that cascade on the group, so an unknown group
 * and a group with nothing in it look identical in the data. Asking first keeps
 * "this group has no payouts yet" distinct from "there is no such group", which
 * are very different answers to a client.
 */
async function requireGroup(
  readModel: GroupReadModel,
  contractId: string,
  reply: FastifyReply,
): Promise<boolean> {
  if (await readModel.groupExists(contractId)) return true;
  groupNotFound(reply);
  return false;
}

export async function groupRoutes(
  app: FastifyInstance,
  options: GroupRoutesOptions,
): Promise<void> {
  const { readModel, requireAuth, registrations } = options;

  /**
   * Registers a group address the chain has just produced.
   *
   * WHY THIS IS A WRITE AND WHY IT IS SAFE TO BE ONE
   * A group's address is the hash of its own deployment, so the only way to know
   * it is to watch the Factory emit it. The indexer does that on a schedule, and
   * until its next run the API cannot answer "does this group exist" for a group
   * that plainly does. The document's journey creates a group and invites people
   * to it in one sitting, so without this the creator has to wait for the indexer
   * to share the group they are looking at.
   *
   * The body carries the address and nothing else: no amount, no membership, no
   * status. Nothing financial reads the row, and it cannot make a contract exist —
   * the contract does, or the join fails on chain. The row is believed for a fixed
   * window and then stops being believed by itself, and an account may hold only a
   * few live at once. See `db/registrations.ts`.
   *
   * The address is not checked against the chain. Verifying it would mean decoding
   * Soroban event XDR in this service, and the exposure it would close — a code
   * naming an address that turns out not to be a group — is bounded by the window
   * and grants nothing, because a join is decided by the contract.
   *
   * `201` rather than `200`: this creates the fact that the address is known, and a
   * client that distinguishes "already registered" from "registered now" can do so
   * from the outcome of the call it made.
   */
  app.post('/groups', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = registerBody.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error);

    const user = authenticatedUser(request);
    const result = await registrations.register({
      contractId: parsed.data.contractId,
      userId: user.id,
    });

    if (result.outcome === 'too_many') {
      return reply.code(409).send({ error: 'too_many_registrations' });
    }

    // Never cached: the response is the outcome of this caller's claim, and a
    // shared cache serving it to another account would be reporting a fact about
    // someone else's registration.
    reply.header('cache-control', 'no-store');
    return reply.code(201).send({
      data: { contractId: result.contractId, expiresAt: result.expiresAt },
    });
  });

  app.get('/groups', async (request, reply) => {
    const parsed = listGroupsQuery.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply, parsed.error);

    const { limit, offset, status, creator, member } = parsed.data;
    // Built explicitly so that an absent filter stays absent rather than being
    // passed as `undefined` and relying on the read model to ignore it.
    const result = await readModel.listGroups({
      limit,
      offset,
      ...(status === undefined ? {} : { status }),
      ...(creator === undefined ? {} : { creator }),
      ...(member === undefined ? {} : { member }),
    });

    reply.header('cache-control', CACHE_CONTROL);
    return reply.send(envelope(result, limit, offset));
  });

  app.get('/groups/:contractId', async (request, reply) => {
    const parsed = contractIdParams.safeParse(request.params);
    if (!parsed.success) return invalidRequest(reply, parsed.error);

    const group = await readModel.getGroup(parsed.data.contractId);
    if (group === undefined) return groupNotFound(reply);

    reply.header('cache-control', CACHE_CONTROL);
    return reply.send({ data: group });
  });

  app.get('/groups/:contractId/contributions', async (request, reply) => {
    const params = contractIdParams.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error);

    const query = pageQuery.safeParse(request.query);
    if (!query.success) return invalidRequest(reply, query.error);

    const { contractId } = params.data;
    if (!(await requireGroup(readModel, contractId, reply))) return reply;

    const { limit, offset } = query.data;
    const result = await readModel.listContributions(contractId, { limit, offset });

    reply.header('cache-control', CACHE_CONTROL);
    return reply.send(envelope(result, limit, offset));
  });

  app.get('/groups/:contractId/payouts', async (request, reply) => {
    const params = contractIdParams.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error);

    const query = pageQuery.safeParse(request.query);
    if (!query.success) return invalidRequest(reply, query.error);

    const { contractId } = params.data;
    if (!(await requireGroup(readModel, contractId, reply))) return reply;

    const { limit, offset } = query.data;
    const result = await readModel.listPayouts(contractId, { limit, offset });

    reply.header('cache-control', CACHE_CONTROL);
    return reply.send(envelope(result, limit, offset));
  });

  app.get('/groups/:contractId/activity', async (request, reply) => {
    const params = contractIdParams.safeParse(request.params);
    if (!params.success) return invalidRequest(reply, params.error);

    const query = pageQuery.safeParse(request.query);
    if (!query.success) return invalidRequest(reply, query.error);

    const { contractId } = params.data;
    if (!(await requireGroup(readModel, contractId, reply))) return reply;

    const { limit, offset } = query.data;
    const result = await readModel.listActivity(contractId, { limit, offset });

    reply.header('cache-control', CACHE_CONTROL);
    return reply.send(envelope(result, limit, offset));
  });
}
