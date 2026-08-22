/**
 * Wallet-link nonces.
 *
 * A nonce is the thing a user is asked to sign, and the reason it exists is that
 * a wallet binding is a claim to control a keypair. Without a proof, `POST
 * /wallet/link` would be "tell us any address you like", and the address column
 * would be a free-text field that the rest of the system treats as an identity.
 *
 * WHY THE NONCE IS SIGNED RATHER THAN STORED
 * The token is `base64url(claims) . base64url(HMAC-SHA256(secret, claims))`. The
 * server can therefore validate one without a database read: issuing costs no
 * write, and rotating `WALLET_NONCE_SECRET` invalidates every outstanding nonce
 * at once. The alternative — a row per issued nonce — costs a write per request
 * and turns every abandoned link attempt into garbage to reap.
 *
 * A signature cannot make a token single-use, so it does not try to. The nonce
 * id (`jti`) is recorded when the nonce is spent, and that record is what makes
 * replay fail; see `wallet_link_nonces` in `src/db/schema.ts`.
 *
 * WHY THE MESSAGE IS BUILT HERE AND NEVER ACCEPTED FROM THE CLIENT
 * The client signs a message this module constructs, and the verifying endpoint
 * rebuilds it from the signed claims rather than trusting a `message` field.
 * If the caller could supply the message, it could supply one that says
 * something else — and a signature over a message we did not choose proves
 * much less than it appears to.
 *
 * The message names the protocol, the account, the address and the network. The
 * network matters: Testnet and Mainnet signatures are otherwise interchangeable,
 * and a Mainnet wallet should not be asked to sign something that reads as
 * Testnet activity, or the reverse.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** How long a nonce stays valid. Short enough that a captured one is stale. */
export const NONCE_TTL_SECONDS = 5 * 60;

/** The id is 32 random bytes in base64url, which is 43 characters. */
const JTI_BYTES = 32;

const claimsSchema = z.object({
  // The user id, validated for shape rather than by RFC 4122 rules.
  //
  // The token is already authenticated by its MAC, so this check exists to catch
  // a code bug producing a malformed claim — not to establish identity, which
  // happened at authentication. `z.string().uuid()` additionally enforces the
  // version and variant nibbles, which are statements about how an id was
  // generated; that is Supabase's business. Rejecting on variant would mean a
  // real account whose id is not a v4 could not link a wallet, which is a
  // production failure for a check that buys nothing here.
  u: z
    .string()
    .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
  a: z.string().regex(/^[GC][A-Z2-7]{55}$/),
  i: z.number().int().nonnegative(),
  e: z.number().int().nonnegative(),
  j: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
});

/** A validated nonce, as read back from a token. */
export type NonceClaims = {
  readonly userId: string;
  readonly address: string;
  /** Issued-at, in whole seconds since the epoch. */
  readonly issuedAt: number;
  /** Expires-at, in whole seconds since the epoch. */
  readonly expiresAt: number;
  readonly jti: string;
};

export type IssuedNonce = {
  /** The opaque token the client sends back, along with its signature. */
  readonly nonce: string;
  /** The exact text to sign. Byte-for-byte what the verifier will rebuild. */
  readonly message: string;
  /** ISO 8601, for the client to display or use to refresh early. */
  readonly expiresAt: string;
};

export type NonceIssuer = {
  issue(input: { userId: string; address: string }): IssuedNonce;
  /**
   * Validates a token and returns its claims, or `undefined` if the token is
   * malformed, forged, or outside its validity window.
   *
   * Expiry is checked here rather than by the caller so that no caller can forget
   * it: a token that has expired is indistinguishable from a forged one as far as
   * this function's contract goes, and both are `undefined`.
   */
  read(nonce: string): NonceClaims | undefined;
  /**
   * Renders the message a wallet signs for these claims.
   *
   * On the issuer rather than left to the caller so that the text a client signs
   * and the text the verifier rebuilds cannot drift: there is one function that
   * knows the shape, and it is the same one that produced the nonce.
   */
  message(claims: NonceClaims): string;
};

const base64url = (input: Buffer | string): string =>
  Buffer.isBuffer(input)
    ? input.toString('base64url')
    : Buffer.from(input, 'utf8').toString('base64url');

/**
 * Renders the claims as the message a wallet signs.
 *
 * Exported so the client can be written against the same shape, and so a test can
 * assert the two agree rather than assuming it.
 */
export function walletLinkMessage(claims: NonceClaims, networkPassphrase: string): string {
  const expires = new Date(claims.expiresAt * 1000).toISOString();
  return [
    'Susu Protocol — wallet link',
    '',
    'Signing this proves you control this Stellar account.',
    'It authorises no payment and no on-chain action.',
    '',
    `Account: ${claims.userId}`,
    `Address: ${claims.address}`,
    `Network: ${networkPassphrase}`,
    `Nonce: ${claims.jti}`,
    `Expires: ${expires}`,
  ].join('\n');
}

export function createNonceIssuer(options: {
  secret: string;
  networkPassphrase: string;
  /** Injectable so expiry can be tested without waiting five minutes. */
  now?: () => number;
  ttlSeconds?: number;
}): NonceIssuer {
  const { secret, networkPassphrase } = options;
  const now = options.now ?? (() => Date.now());
  const ttl = options.ttlSeconds ?? NONCE_TTL_SECONDS;

  function sign(payload: string): string {
    return createHmac('sha256', secret).update(payload).digest('base64url');
  }

  return {
    issue({ userId, address }) {
      const issuedAt = Math.floor(now() / 1000);
      const claims: NonceClaims = {
        userId,
        address,
        issuedAt,
        expiresAt: issuedAt + ttl,
        jti: randomBytes(JTI_BYTES).toString('base64url'),
      };

      // Short keys, because the payload is carried in a token and every byte is
      // paid for on each request. `claimsSchema` is the only place they are
      // mapped back to readable names.
      const payload = base64url(
        JSON.stringify({ u: userId, a: address, i: issuedAt, e: claims.expiresAt, j: claims.jti }),
      );

      return {
        nonce: `${payload}.${sign(payload)}`,
        message: walletLinkMessage(claims, networkPassphrase),
        expiresAt: new Date(claims.expiresAt * 1000).toISOString(),
      };
    },

    message(claims) {
      return walletLinkMessage(claims, networkPassphrase);
    },

    read(nonce) {
      const separator = nonce.indexOf('.');
      if (separator <= 0 || separator === nonce.length - 1) return undefined;

      const payload = nonce.slice(0, separator);
      const presented = nonce.slice(separator + 1);

      // Compared in constant time. A byte-by-byte comparison that returns early
      // leaks how much of a forged MAC was correct, which is enough to forge one
      // given enough attempts.
      const expected = sign(payload);
      const expectedBytes = Buffer.from(expected, 'utf8');
      const presentedBytes = Buffer.from(presented, 'utf8');
      if (expectedBytes.length !== presentedBytes.length) return undefined;
      if (!timingSafeEqual(expectedBytes, presentedBytes)) return undefined;

      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      } catch {
        return undefined;
      }

      const parsed = claimsSchema.safeParse(decoded);
      if (!parsed.success) return undefined;

      const claims: NonceClaims = {
        userId: parsed.data.u,
        address: parsed.data.a,
        issuedAt: parsed.data.i,
        expiresAt: parsed.data.e,
        jti: parsed.data.j,
      };

      // Expiry, checked last so an expired token costs the same work as a valid
      // one up to this point: a cheaper rejection for expired tokens would be a
      // cheap way to distinguish them.
      if (claims.expiresAt * 1000 <= now()) return undefined;

      // A token issued in the future is either a clock problem or a forgery we
      // cannot otherwise see, and neither is a reason to accept it. The tolerance
      // is small because the claims carry a second-resolution timestamp.
      if (claims.issuedAt * 1000 > now() + 60_000) return undefined;

      return claims;
    },
  };
}
