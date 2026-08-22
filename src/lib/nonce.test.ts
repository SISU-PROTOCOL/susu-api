import { describe, expect, it } from 'vitest';
import { createNonceIssuer, NONCE_TTL_SECONDS } from './nonce';

const SECRET = 'a'.repeat(32);
const PASSPHRASE = 'Test SDF Network ; September 2015';
const USER = '11111111-1111-1111-1111-111111111111';
const ADDRESS = `G${'A'.repeat(55)}`;

/** A fixed clock, so expiry is asserted rather than waited for. */
function issuerAt(clock: { now: number }, secret = SECRET) {
  return createNonceIssuer({
    secret,
    networkPassphrase: PASSPHRASE,
    now: () => clock.now,
  });
}

describe('createNonceIssuer', () => {
  it('reads back the claims it issued', () => {
    const clock = { now: 1_700_000_000_000 };
    const issuer = issuerAt(clock);

    const issued = issuer.issue({ userId: USER, address: ADDRESS });
    const claims = issuer.read(issued.nonce);

    expect(claims).toBeDefined();
    expect(claims?.userId).toBe(USER);
    expect(claims?.address).toBe(ADDRESS);
    expect(claims?.issuedAt).toBe(1_700_000_000);
    expect(claims?.expiresAt).toBe(1_700_000_000 + NONCE_TTL_SECONDS);
  });

  it('gives every nonce a distinct id', () => {
    const clock = { now: 1_700_000_000_000 };
    const issuer = issuerAt(clock);

    const ids = new Set(
      Array.from(
        { length: 50 },
        () => issuer.read(issuer.issue({ userId: USER, address: ADDRESS }).nonce)?.jti,
      ),
    );

    // A repeated id would let one nonce's replay record cover another's.
    expect(ids.size).toBe(50);
  });

  it('refuses a nonce whose payload was altered', () => {
    const clock = { now: 1_700_000_000_000 };
    const issuer = issuerAt(clock);
    const issued = issuer.issue({ userId: USER, address: ADDRESS });

    const [payload, mac] = issued.nonce.split('.');
    // Re-encode the claims naming a different address, keeping the original MAC.
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    claims.a = `G${'B'.repeat(55)}`;
    const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${mac}`;

    expect(issuer.read(forged)).toBeUndefined();
  });

  it('refuses a nonce whose signature was altered', () => {
    const clock = { now: 1_700_000_000_000 };
    const issuer = issuerAt(clock);
    const issued = issuer.issue({ userId: USER, address: ADDRESS });

    const [payload, mac] = issued.nonce.split('.');
    const flipped = `${mac.slice(0, -1)}${mac.at(-1) === 'A' ? 'B' : 'A'}`;

    expect(issuer.read(`${payload}.${flipped}`)).toBeUndefined();
  });

  it('refuses a nonce signed with a different secret', () => {
    const clock = { now: 1_700_000_000_000 };
    const issued = issuerAt(clock, 'b'.repeat(32)).issue({ userId: USER, address: ADDRESS });

    // The whole point of the secret: rotating it must invalidate outstanding
    // nonces, which means another server's nonce must not be accepted here.
    expect(issuerAt(clock).read(issued.nonce)).toBeUndefined();
  });

  it('refuses an expired nonce', () => {
    const clock = { now: 1_700_000_000_000 };
    const issuer = issuerAt(clock);
    const issued = issuer.issue({ userId: USER, address: ADDRESS });

    expect(issuer.read(issued.nonce)).toBeDefined();

    // One millisecond past expiry, so the boundary is where it is claimed.
    clock.now = (1_700_000_000 + NONCE_TTL_SECONDS) * 1000 + 1;

    expect(issuer.read(issued.nonce)).toBeUndefined();
  });

  it('accepts a nonce until the instant it expires', () => {
    const clock = { now: 1_700_000_000_000 };
    const issuer = issuerAt(clock);
    const issued = issuer.issue({ userId: USER, address: ADDRESS });

    // One millisecond before expiry. `expiresAt` names the instant the nonce
    // stops being valid, so the boundary is exclusive: at exactly `expiresAt`
    // the nonce is already expired, which the test above pins from the other
    // side.
    clock.now = (1_700_000_000 + NONCE_TTL_SECONDS) * 1000 - 1;

    expect(issuer.read(issued.nonce)).toBeDefined();
  });

  it('refuses a nonce issued in the future', () => {
    const clock = { now: 1_700_000_000_000 };
    const issued = issuerAt(clock).issue({ userId: USER, address: ADDRESS });

    // A clock that has gone backwards by more than the tolerance. Accepting it
    // would mean accepting a token whose lifetime has not started, and the
    // expiry check would be measured from the wrong end.
    const rewound = issuerAt({ now: 1_700_000_000_000 - 120_000 });

    expect(rewound.read(issued.nonce)).toBeUndefined();
  });

  it('refuses malformed tokens without throwing', () => {
    const clock = { now: 1_700_000_000_000 };
    const issuer = issuerAt(clock);

    for (const token of ['', '.', 'no-separator', '.onlymac', 'onlypayload.', 'a.b.c', '!!!.???']) {
      expect(issuer.read(token)).toBeUndefined();
    }
  });

  it('refuses a token whose payload is valid base64 but not valid JSON', () => {
    const clock = { now: 1_700_000_000_000 };
    const issuer = issuerAt(clock);

    // Signed correctly, so the MAC check passes, and the failure has to be the
    // claims validation rather than the signature.
    const payload = Buffer.from('not json at all').toString('base64url');
    const signed = issuer.issue({ userId: USER, address: ADDRESS });
    const mac = signed.nonce.split('.')[1];

    expect(issuer.read(`${payload}.${mac}`)).toBeUndefined();
  });

  it('refuses a token whose claims are the wrong shape', () => {
    const clock = { now: 1_700_000_000_000 };
    const issuer = issuerAt(clock);

    // Correctly signed, but `a` is not an address. The token is authentic and
    // still unusable, which is the case a MAC-only check would let through.
    const payload = Buffer.from(
      JSON.stringify({
        u: USER,
        a: 'not-an-address',
        i: 1_700_000_000,
        e: 1_700_000_300,
        j: 'x'.repeat(43),
      }),
    ).toString('base64url');
    const forged = issuer.issue({ userId: USER, address: ADDRESS });
    const mac = forged.nonce.split('.')[1];

    expect(issuer.read(`${payload}.${mac}`)).toBeUndefined();
  });
});

describe('walletLinkMessage', () => {
  const clock = { now: 1_700_000_000_000 };

  it('names the account, the address, the network and the nonce', () => {
    const issuer = issuerAt(clock);
    const issued = issuer.issue({ userId: USER, address: ADDRESS });
    const claims = issuer.read(issued.nonce);
    const message = issuer.message(claims!);

    expect(message).toContain(`Account: ${USER}`);
    expect(message).toContain(`Address: ${ADDRESS}`);
    expect(message).toContain(`Network: ${PASSPHRASE}`);
    expect(message).toContain(`Nonce: ${claims?.jti}`);
    // The protocol name is what stops the same bytes meaning something else
    // somewhere else.
    expect(message).toContain('Susu Protocol');
  });

  it('is byte-for-byte what was issued', () => {
    const issuer = issuerAt(clock);
    const issued = issuer.issue({ userId: USER, address: ADDRESS });

    // The verifier rebuilds the message rather than accepting one, so if these
    // two ever disagree every signature would fail.
    expect(issuer.message(issuer.read(issued.nonce)!)).toBe(issued.message);
  });

  it('says that no money moves', () => {
    const issuer = issuerAt(clock);
    const issued = issuer.issue({ userId: USER, address: ADDRESS });

    // This text is what a user reads in their wallet before approving. Telling
    // them plainly that it authorises nothing is the point of showing it.
    expect(issued.message).toContain('authorises no payment');
  });

  it('differs between two nonces for the same account', () => {
    const issuer = issuerAt(clock);
    const first = issuer.issue({ userId: USER, address: ADDRESS });
    const second = issuer.issue({ userId: USER, address: ADDRESS });

    // Otherwise a signature collected once could be replayed against the other.
    expect(first.message).not.toBe(second.message);
  });

  it('differs when the same nonce id is rendered for a different network', () => {
    const issuer = issuerAt(clock);
    const issued = issuer.issue({ userId: USER, address: ADDRESS });
    const claims = issuer.read(issued.nonce)!;

    const mainnet = createNonceIssuer({
      secret: SECRET,
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    });

    expect(mainnet.message(claims)).not.toBe(issuer.message(claims));
  });
});
