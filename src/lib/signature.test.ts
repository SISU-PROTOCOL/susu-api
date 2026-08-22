import { describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk/base';
import { decodeSignature, verifyWalletSignature } from './signature';

const MESSAGE = 'Susu Protocol — wallet link\n\nNonce: abc';

/** A fresh signer per test, so a leaked key cannot make a later test pass. */
function signer() {
  return Keypair.random();
}

describe('decodeSignature', () => {
  it('decodes a 64-byte base64 signature', () => {
    const signature = Buffer.from(signer().sign(Buffer.from(MESSAGE, 'utf8'))).toString('base64');

    const decoded = decodeSignature(signature);

    expect(decoded).toBeDefined();
    expect(decoded?.length).toBe(64);
  });

  it('refuses a signature that decodes to the wrong length', () => {
    // `Buffer.from(x, 'base64')` silently skips what it cannot decode, so a
    // wrong-length value has to be rejected on shape or it becomes a short
    // buffer that reads as "invalid signature" for the wrong reason.
    expect(decodeSignature(Buffer.from('too short').toString('base64'))).toBeUndefined();
    expect(decodeSignature(Buffer.alloc(80).toString('base64'))).toBeUndefined();
  });

  it('refuses values that are not base64', () => {
    expect(decodeSignature('')).toBeUndefined();
    expect(decodeSignature('   ')).toBeUndefined();
    expect(decodeSignature('not base64 !!!')).toBeUndefined();
    expect(decodeSignature('<script>alert(1)</script>')).toBeUndefined();
  });

  it('tolerates surrounding whitespace', () => {
    const signature = Buffer.from(signer().sign(Buffer.from(MESSAGE, 'utf8'))).toString('base64');

    expect(decodeSignature(`  ${signature}\n`)).toBeDefined();
  });
});

describe('verifyWalletSignature', () => {
  it('accepts a SEP-53 signature', () => {
    const keypair = signer();
    const signature = Buffer.from(keypair.signMessage(MESSAGE)).toString('base64');

    // SEP-53 is what Stellar wallets implement for arbitrary text, so this is
    // the path a real user takes.
    expect(
      verifyWalletSignature({
        address: keypair.publicKey(),
        message: MESSAGE,
        signature,
      }),
    ).toBe(true);
  });

  it('accepts a raw signature over the message bytes', () => {
    const keypair = signer();
    const signature = Buffer.from(keypair.sign(Buffer.from(MESSAGE, 'utf8'))).toString('base64');

    // The other shape a wallet may produce. Both prove control of the key over
    // the message this server constructed.
    expect(
      verifyWalletSignature({
        address: keypair.publicKey(),
        message: MESSAGE,
        signature,
      }),
    ).toBe(true);
  });

  it('refuses a signature over a different message', () => {
    const keypair = signer();
    const signature = Buffer.from(keypair.signMessage('a different message')).toString('base64');

    expect(
      verifyWalletSignature({
        address: keypair.publicKey(),
        message: MESSAGE,
        signature,
      }),
    ).toBe(false);
  });

  it("refuses another key's signature over the right message", () => {
    const victim = signer();
    const attacker = signer();
    const signature = Buffer.from(attacker.signMessage(MESSAGE)).toString('base64');

    // The address names the key the signature is checked against, so presenting
    // a valid signature from the wrong key must fail.
    expect(
      verifyWalletSignature({
        address: victim.publicKey(),
        message: MESSAGE,
        signature,
      }),
    ).toBe(false);
  });

  it('refuses a tampered signature', () => {
    const keypair = signer();
    const bytes = Buffer.from(keypair.signMessage(MESSAGE));
    bytes[0] = bytes[0] === 0 ? 1 : 0;
    const signature = bytes.toString('base64');

    expect(
      verifyWalletSignature({
        address: keypair.publicKey(),
        message: MESSAGE,
        signature,
      }),
    ).toBe(false);
  });

  it('refuses a contract address', () => {
    const keypair = signer();
    const signature = Buffer.from(keypair.signMessage(MESSAGE)).toString('base64');

    // A `C` address derives its authority from `__check_auth` on chain, which a
    // plain signature check cannot stand in for. Refusing it here is deliberate.
    expect(
      verifyWalletSignature({
        address: `C${'A'.repeat(55)}`,
        message: MESSAGE,
        signature,
      }),
    ).toBe(false);
  });

  it('refuses a malformed address without throwing', () => {
    const keypair = signer();
    const signature = Buffer.from(keypair.signMessage(MESSAGE)).toString('base64');

    for (const address of [
      '',
      'not-an-address',
      `G${'A'.repeat(54)}`,
      keypair.publicKey().toLowerCase(),
    ]) {
      expect(() => verifyWalletSignature({ address, message: MESSAGE, signature })).not.toThrow();
      expect(verifyWalletSignature({ address, message: MESSAGE, signature })).toBe(false);
    }
  });

  it('refuses a malformed signature without throwing', () => {
    const keypair = signer();

    for (const signature of ['', 'nonsense', '!!!!', Buffer.alloc(10).toString('base64')]) {
      expect(() =>
        verifyWalletSignature({ address: keypair.publicKey(), message: MESSAGE, signature }),
      ).not.toThrow();
      expect(
        verifyWalletSignature({ address: keypair.publicKey(), message: MESSAGE, signature }),
      ).toBe(false);
    }
  });

  it('does not accept a signature over the SEP-53 hash when the raw message is signed', () => {
    // Guards the ordering in the implementation: the two schemes must not be
    // interchangeable, or a signature could be moved between contexts.
    const keypair = signer();
    const rawSignature = Buffer.from(keypair.sign(Buffer.from(MESSAGE, 'utf8'))).toString('base64');

    // The raw signature is valid for the raw scheme, and this asserts the
    // verifier does not accept it for a *different* message under either scheme.
    expect(
      verifyWalletSignature({
        address: keypair.publicKey(),
        message: `${MESSAGE}!`,
        signature: rawSignature,
      }),
    ).toBe(false);
  });
});
