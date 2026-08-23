/**
 * The invite store: creating codes, and redeeming them exactly once.
 *
 * Redemption is the interesting operation. `invite_links.uses` is a counter with
 * a ceiling, and two things have to be true at the same time that a counter
 * alone cannot express:
 *
 *   1. Concurrent joins must not exceed `max_uses`. That needs a lock, not a
 *      read-then-write, or two requests can both read `uses = 4` against a
 *      ceiling of 5 and both write 5.
 *   2. A member redeeming the same code twice must not consume two uses. That
 *      needs the identity of the redeemer, which is what `invite_redemptions`
 *      records; the unique key on the pair makes the second attempt a no-op
 *      rather than a second increment.
 *
 * So the whole redemption is one transaction: the invite row is locked, the
 * existing redemption is looked for, capacity is checked, and the redemption row
 * and the counter are written together. The lock is what makes the capacity check
 * meaningful; the unique index is what makes the redemption idempotent.
 *
 * The chain is still the authority on who may join and how large a group is.
 * This endpoint resolves a code and claims a use so that a limited invite is not
 * issued more times than it allows — nothing more.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { inviteLinks, inviteRedemptions } from './schema';

type Database = NodePgDatabase<typeof schema>;

export type InviteRecord = {
  readonly id: string;
  readonly code: string;
  readonly groupContractId: string;
  readonly createdBy: string;
  readonly expiresAt: string | null;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly createdAt: string;
};

export type RedeemOutcome =
  /** The use was claimed, or had already been claimed by this same user. */
  | { readonly outcome: 'redeemed'; readonly inviteId: string }
  /** No such code. Also returned for a code that belongs to another group. */
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'revoked' }
  | { readonly outcome: 'expired' }
  | { readonly outcome: 'exhausted' };

export type InviteStore = {
  create(input: {
    code: string;
    groupContractId: string;
    createdBy: string;
    expiresAt: Date | null;
    maxUses: number | null;
  }): Promise<InviteRecord>;

  /**
   * Claims a use of the invite identified by `code`, for a join to
   * `groupContractId` by `userId`.
   *
   * Idempotent per (invite, user): redeeming twice succeeds both times and
   * consumes one use.
   */
  redeem(input: { code: string; groupContractId: string; userId: string }): Promise<RedeemOutcome>;
};

function toRecord(row: schema.InviteLink): InviteRecord {
  return {
    id: row.id,
    code: row.code,
    groupContractId: row.groupContractId,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    maxUses: row.maxUses,
    uses: row.uses,
    createdAt: row.createdAt.toISOString(),
  };
}

export function createInviteStore(db: Database): InviteStore {
  return {
    async create(input) {
      const [row] = await db
        .insert(inviteLinks)
        .values({
          code: input.code,
          groupContractId: input.groupContractId,
          createdBy: input.createdBy,
          expiresAt: input.expiresAt,
          maxUses: input.maxUses,
        })
        .returning();

      if (row === undefined) throw new Error('invite insert returned no row');
      return toRecord(row);
    },

    async redeem({ code, groupContractId, userId }) {
      return db.transaction(async (tx) => {
        // `for update` is the whole reason this is a transaction. Without it the
        // capacity check below is advisory: two concurrent joins would both read
        // the same `uses` and both be told there is room.
        const locked = await tx
          .select()
          .from(inviteLinks)
          .where(eq(inviteLinks.code, code))
          .for('update');

        const invite = locked[0];
        if (invite === undefined) return { outcome: 'not_found' } as const;
        if (invite.revokedAt !== null) return { outcome: 'revoked' } as const;
        if (invite.expiresAt !== null && invite.expiresAt.getTime() <= Date.now()) {
          return { outcome: 'expired' } as const;
        }

        // A code for a different group is reported as absent rather than as a
        // mismatch. Telling the caller it exists would confirm the code is real,
        // which is the one thing an unguessable code is supposed to withhold.
        if (invite.groupContractId !== groupContractId) return { outcome: 'not_found' } as const;

        // Checked before capacity, so a member who already redeemed is idempotent
        // even when the invite has since filled up. Reporting "exhausted" to
        // someone who is already in would be true about the invite and wrong
        // about their situation.
        const [existing] = await tx
          .select({ id: inviteRedemptions.id })
          .from(inviteRedemptions)
          .where(
            and(eq(inviteRedemptions.inviteId, invite.id), eq(inviteRedemptions.userId, userId)),
          )
          .limit(1);

        if (existing !== undefined) return { outcome: 'redeemed', inviteId: invite.id } as const;

        if (invite.maxUses !== null && invite.uses >= invite.maxUses) {
          return { outcome: 'exhausted' } as const;
        }

        await tx.insert(inviteRedemptions).values({ inviteId: invite.id, userId });

        // Incremented in SQL rather than from the value read above, so the
        // update cannot write back a stale count if anything else has touched
        // the row. The lock makes that unlikely; this makes it harmless.
        await tx
          .update(inviteLinks)
          .set({ uses: sql`${inviteLinks.uses} + 1` })
          .where(eq(inviteLinks.id, invite.id));

        return { outcome: 'redeemed', inviteId: invite.id } as const;
      });
    },
  };
}
