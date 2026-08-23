/**
 * Invite codes.
 *
 * The one requirement that shapes everything here is that a code must not be
 * *derivable*. This project's first invite implementation used the group's
 * contract address as the code, reasoning that it grants no authority — which is
 * true about authority and false about secrecy. A contract address is published
 * on chain and enumerable by walking the address space, so "the code is the
 * contract address" means "everyone has the code".
 *
 * A code is therefore 32 bytes from the CSPRNG, in base64url, unrelated to any
 * address. 256 bits is far more than the ~2^128 that makes guessing hopeless; the
 * cost is 43 characters, which is not carried by a human.
 *
 * The database enforces the same shape in `invite_links`, including a constraint
 * that rejects address-shaped codes specifically. That is not redundancy: this
 * module protects the write path, the constraint protects the table, and the
 * constraint is the one that would still hold if a future code path forgot to
 * call this function.
 */
import { randomBytes } from 'node:crypto';

/** 32 bytes, base64url, no padding: 43 characters. */
const CODE_BYTES = 32;

/**
 * Matches the database's `invite_links_code_shape` constraint exactly.
 *
 * Kept in step with the migration deliberately. If the two disagree, either the
 * generator can produce a code the table rejects, or the table accepts codes
 * shorter than this module believes are safe.
 */
export const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;

/** A Stellar address shape, which a code must never be. */
const ADDRESS_LIKE = /^[GC][A-Z2-7]{55}$/;

export function generateInviteCode(): string {
  return randomBytes(CODE_BYTES).toString('base64url');
}

/**
 * Answers whether a presented code is worth a database lookup.
 *
 * A caller that sends something short, or shaped like an address, is refused
 * before any query runs. The refusal is not a security boundary — the lookup
 * would find nothing — but it keeps a stream of junk from becoming a stream of
 * indexed lookups.
 */
export function isWellFormedInviteCode(code: string): boolean {
  return INVITE_CODE_PATTERN.test(code) && !ADDRESS_LIKE.test(code);
}
