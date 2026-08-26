/**
 * Invite endpoints: create a code, and join by redeeming one.
 *
 * NEITHER OF THESE GRANTS ACCESS
 * The contract decides who may join a group and enforces the member capacity.
 * Creating an invite is therefore not an authorization decision — there is
 * nothing to authorize, because an invite carries no authority. What the code
 * buys is discoverability: it lets someone who was told about a group find it
 * without knowing its contract address. That is why the code must be unguessable
 * and why the table it lives in is readable by no browser role at all.
 *
 * This also means the "may this user invite?" question has no useful answer here.
 * The natural rule — only members may invite — cannot be checked, because the API
 * does not know which wallet a user controls unless they have linked one, and the
 * chain decides membership by address. Refusing when we cannot check would break
 * inviting for the majority of users and protect nothing, since the group and its
 * contract address are already public.
 *
 * JOIN CLAIMS A USE, IT DOES NOT JOIN
 * The blockchain is the only thing that can add a member, so redemption cannot be
 * the join. What `POST /invites/redeem` does is validate the code, claim one of its
 * uses, and report which group the code admits to, so the client can send the
 * transaction that actually joins. A use is claimed before that transaction
 * succeeds, which is the conservative direction: a failed transaction wastes a use
 * rather than letting a limited code admit more members than it should.
 *
 * WHY REDEMPTION IS NOT GROUP-SCOPED
 * An invite link carries a code and nothing else — that is what makes it opaque.
 * The code is unique and its row names the group, so a caller holding only the
 * code can still redeem; requiring the contract address would mean the link could
 * never satisfy the request. Creation is still group-scoped, because a code is
 * created *for* a group.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticatedUser } from '../auth/guard';
import { generateInviteCode, isWellFormedInviteCode } from '../lib/invite-code';
import type { InviteStore } from '../db/invites';
import { invalidRequest } from './errors';

/** A Soroban contract address. Matches the group routes' pattern. */
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/;

/** Default lifetime for an invite that does not specify one. */
export const DEFAULT_INVITE_TTL_HOURS = 24 * 7;

/** Longest lifetime the API will issue. Beyond this a leaked code is long-lived. */
export const MAX_INVITE_TTL_HOURS = 24 * 30;

export type InviteRoutesOptions = {
  store: InviteStore;
  /** Answers whether the indexer knows this group. Injected to keep this narrow. */
  groupExists: (contractId: string) => Promise<boolean>;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Injectable so tests can assert the expiry rather than race a clock. */
  now?: () => Date;
};

const params = z.object({
  contractId: z.string().regex(CONTRACT_ID_PATTERN, 'must be a Soroban contract address'),
});

const createBody = z.object({
  /**
   * Hours until the code stops working. Optional, with a default rather than no
   * expiry: the document requires expiring codes, and "never" is the one value
   * that cannot be walked back after a code leaks.
   */
  expiresInHours: z.coerce
    .number()
    .int()
    .min(1, 'must be at least 1 hour')
    .max(MAX_INVITE_TTL_HOURS, `must be at most ${MAX_INVITE_TTL_HOURS} hours`)
    .optional(),
  /** Omitted means limited only by the contract's own member capacity. */
  maxUses: z.coerce.number().int().min(1, 'must be a positive number of uses').max(1000).optional(),
});

const redeemBody = z.object({
  code: z.string().trim().min(1, 'must be an invite code'),
});

function groupNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'group_not_found' });
}

/**
 * A code that cannot be redeemed, reported as absent.
 *
 * Revoked, expired, wrong-group and unknown codes all get the same answer for the
 * same reason: any distinction confirms that a guessed code is real, which is
 * exactly what an unguessable code is protecting.
 */
function inviteNotFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: 'invite_not_found' });
}

export async function inviteRoutes(
  app: FastifyInstance,
  options: InviteRoutesOptions,
): Promise<void> {
  const { store, groupExists, requireAuth } = options;
  const now = options.now ?? (() => new Date());

  app.post('/groups/:contractId/invites', { preHandler: requireAuth }, async (request, reply) => {
    const parsedParams = params.safeParse(request.params);
    if (!parsedParams.success) return invalidRequest(reply, parsedParams.error);

    const parsedBody = createBody.safeParse(request.body ?? {});
    if (!parsedBody.success) return invalidRequest(reply, parsedBody.error);

    const { contractId } = parsedParams.data;
    if (!(await groupExists(contractId))) return groupNotFound(reply);

    const user = authenticatedUser(request);
    const ttlHours = parsedBody.data.expiresInHours ?? DEFAULT_INVITE_TTL_HOURS;
    const expiresAt = new Date(now().getTime() + ttlHours * 60 * 60 * 1000);

    const invite = await store.create({
      code: generateInviteCode(),
      groupContractId: contractId,
      createdBy: user.id,
      expiresAt,
      maxUses: parsedBody.data.maxUses ?? null,
    });

    // The code is returned once, here, and cannot be read back afterwards: the
    // table has no policy granting a browser role anything, including to its
    // creator. That is what stops an invite from being enumerated after the fact.
    reply.header('cache-control', 'no-store');
    return reply.code(201).send({
      data: {
        code: invite.code,
        groupContractId: invite.groupContractId,
        expiresAt: invite.expiresAt,
        maxUses: invite.maxUses,
        uses: invite.uses,
      },
    });
  });

  app.post('/invites/redeem', { preHandler: requireAuth }, async (request, reply) => {
    const parsedBody = redeemBody.safeParse(request.body);
    if (!parsedBody.success) return invalidRequest(reply, parsedBody.error);

    const { code } = parsedBody.data;
    // Refused on shape before any lookup. A stream of short or address-shaped
    // codes would otherwise be a stream of indexed queries.
    if (!isWellFormedInviteCode(code)) return inviteNotFound(reply);

    const user = authenticatedUser(request);
    const result = await store.redeem({ code, userId: user.id });

    switch (result.outcome) {
      case 'redeemed':
        // Either this is the first redemption or this user redeemed before; both
        // are success, which is what makes retrying a join safe. The group comes
        // from the code, not from the request.
        return reply.send({
          data: { groupContractId: result.groupContractId, inviteId: result.inviteId },
        });
      case 'exhausted':
        // Distinct from not_found because the caller did nothing wrong and a
        // fresh invite is a real remedy — and knowing the code was real tells
        // them nothing they did not already have.
        return reply.code(409).send({ error: 'invite_exhausted' });
      case 'revoked':
      case 'expired':
      case 'not_found':
        return inviteNotFound(reply);
    }
  });
}
