/**
 * The wallet-link endpoints.
 *
 * Two steps, because one is not enough to prove anything:
 *
 *   1. `POST /wallet/nonce` — an authenticated session asks for something to
 *      sign. The nonce is bound to the account and the address it names.
 *   2. `POST /wallet/verify` — the wallet's signature over that nonce is checked,
 *      the nonce is spent, and the address is bound.
 *
 * WHY BOTH STEPS ARE AUTHENTICATED
 * The binding is between an *account* and an address, so both halves have to be
 * present at the same moment. If the nonce were issued to anonymous callers, a
 * signature could be collected first and attached to whichever account claimed
 * it later, and the "one account per wallet" rule would be a race rather than a
 * rule.
 *
 * WHAT THIS DOES NOT DO
 * Nothing here can move money, and the chain is never consulted: an address is
 * not a member of anything until the contracts say so. A wallet binding is the
 * app's record of which keypair a user controls, so that the UI can show them
 * their own groups; the contract decides membership by address regardless.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticatedUser } from '../auth/guard';
import type { NonceIssuer } from '../lib/nonce';
import { verifyWalletSignature } from '../lib/signature';
import type { WalletLinkStore } from '../db/wallet';
import { invalidRequest } from './errors';

/** A classic Stellar account. A `C` address cannot produce a signature. */
const ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/;

/** Base64, as every Stellar wallet returns a signature. Length is checked in the verifier. */
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type WalletRoutesOptions = {
  nonces: NonceIssuer;
  store: WalletLinkStore;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
};

const nonceBody = z.object({
  address: z.string().regex(ADDRESS_PATTERN, 'must be a Stellar account address starting with G'),
});

const verifyBody = z.object({
  address: z.string().regex(ADDRESS_PATTERN, 'must be a Stellar account address starting with G'),
  nonce: z.string().min(1, 'must be the nonce that was issued'),
  signature: z.string().regex(SIGNATURE_PATTERN, 'must be a base64 signature'),
});

export async function walletRoutes(
  app: FastifyInstance,
  options: WalletRoutesOptions,
): Promise<void> {
  const { nonces, store, requireAuth } = options;

  app.post('/wallet/nonce', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = nonceBody.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error);

    const user = authenticatedUser(request);
    const issued = nonces.issue({ userId: user.id, address: parsed.data.address });

    // Never stored by an intermediary: two users behind one cache would be
    // handed each other's nonce.
    reply.header('cache-control', 'no-store');
    return reply.send({ data: issued });
  });

  app.post('/wallet/verify', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = verifyBody.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error);

    const user = authenticatedUser(request);
    const { address, nonce, signature } = parsed.data;

    const claims = nonces.read(nonce);
    // One answer for a forged token, an expired one and a malformed one. A
    // caller cannot act differently on those, and reporting which it was tells
    // an attacker which part of a forgery to fix.
    if (claims === undefined) return reply.code(400).send({ error: 'invalid_nonce' });

    // The nonce names the account and the address it was issued for. Checking
    // both is what stops a nonce issued to one user, for one address, being spent
    // by another — the nonce is not a bearer token.
    if (claims.userId !== user.id || claims.address !== address) {
      return reply.code(400).send({ error: 'invalid_nonce' });
    }

    // Rebuilt from the verified claims by the issuer, which owns the message
    // shape, and never taken from the request body. If the caller could supply
    // the message it could supply one that says something else, and a signature
    // over a message we did not choose proves far less than it appears to.
    if (!verifyWalletSignature({ address, message: nonces.message(claims), signature })) {
      return reply.code(400).send({ error: 'invalid_signature' });
    }

    // Spent before the write, not after. If the binding failed and the nonce had
    // already been released, a retry would be free; spending first means the
    // caller asks for a fresh nonce, which is the cheaper mistake.
    const spent = await store.consumeNonce({
      jti: claims.jti,
      userId: claims.userId,
      expiresAt: new Date(claims.expiresAt * 1000),
    });
    if (!spent) return reply.code(409).send({ error: 'nonce_reused' });

    const result = await store.link({ userId: user.id, address });
    if (result.outcome === 'address_taken') {
      // Deliberately after the signature check: reaching this means the caller
      // proved control of an address that is already bound to another account,
      // which is a real conflict rather than a malformed request.
      return reply.code(409).send({ error: 'wallet_already_linked' });
    }

    reply.header('cache-control', 'no-store');
    return reply.send({ data: { walletAddress: address } });
  });
}
