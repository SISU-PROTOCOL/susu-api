/**
 * Verifying a Stellar wallet's signature over a message.
 *
 * This is the one place a wallet binding is decided. Everything else in the
 * linking flow — a session, a nonce, an expiry — establishes *when* a claim was
 * made; this establishes that the claimant holds the private key.
 *
 * WHY THE PUBLIC KEY COMES FROM THE CLAIMED ADDRESS
 * `Keypair.fromPublicKey(address)` derives the key from the address itself, so
 * the signature is checked against the key the address names. There is no
 * separate "public key" field for a caller to supply, and therefore no way to
 * present key A's address with key B's signature.
 *
 * WHICH SCHEME, AND WHY BOTH ARE ACCEPTED
 * Ed25519 signatures over a message come in two shapes and the wallet, not this
 * server, chooses which one to produce:
 *
 *   * SEP-53 — `SHA256("Stellar Signed Message:\n" || message)`, which is what
 *     Stellar wallets implement for "sign this text".
 *   * A raw signature over the message bytes, which some versions produce.
 *
 * Both are accepted, and accepting more than one does not weaken anything: each
 * requires a valid Ed25519 signature by the key named in the address over *the
 * message this server constructed*. The domain separation that stops a signature
 * being reused elsewhere lives in the message text, which the client does not
 * choose. Rejecting the scheme a user's wallet happens to use would only mean
 * wallet linking does not work.
 *
 * A `C` address — a wallet contract — is deliberately not supported here. Its
 * authority comes from `__check_auth` on chain, which is not something a plain
 * signature check can stand in for.
 */
import { Keypair, StrKey } from '@stellar/stellar-sdk/base';

/** A signature is 64 bytes, base64-encoded by every Stellar wallet. */
const SIGNATURE_BYTES = 64;

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export type SignatureCheck = {
  readonly address: string;
  readonly message: string;
  /** Base64, as the wallet returned it. */
  readonly signature: string;
};

/**
 * Decodes a base64 signature, rejecting anything that cannot be one.
 *
 * `Buffer.from(value, 'base64')` never throws: it skips characters it does not
 * recognise and returns whatever it managed to decode. A malformed signature
 * would therefore become a short buffer and be reported as an invalid signature,
 * which hides the difference between "you signed the wrong thing" and "that is
 * not a signature". The shape is checked before decoding for that reason.
 */
export function decodeSignature(signature: string): Buffer | undefined {
  const trimmed = signature.trim();
  if (trimmed.length === 0 || !BASE64_PATTERN.test(trimmed)) return undefined;

  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length !== SIGNATURE_BYTES) return undefined;
  return bytes;
}

/**
 * Answers whether `signature` is a valid signature by `address` over `message`.
 *
 * Returns `false` for every failure, including a malformed address. A caller
 * cannot act differently on "this address is not an address" than on "this
 * signature is wrong", and distinguishing them in a response would turn the
 * endpoint into an address validator.
 */
export function verifyWalletSignature(check: SignatureCheck): boolean {
  // Only classic accounts can sign with a key. A contract address is refused
  // here rather than being passed to `fromPublicKey`, which would throw for a
  // `C` prefix and report it as a malformed address.
  if (!StrKey.isValidEd25519PublicKey(check.address)) return false;

  const signature = decodeSignature(check.signature);
  if (signature === undefined) return false;

  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(check.address);
  } catch {
    return false;
  }

  const messageBytes = Buffer.from(check.message, 'utf8');

  // SEP-53 first: it is what Stellar wallets implement for arbitrary text, so it
  // is the expected case and the one worth trying first.
  try {
    if (keypair.verifyMessage(messageBytes, signature)) return true;
  } catch {
    // A library-level rejection is not an answer about this signature; fall
    // through to the raw scheme rather than reporting a forged one.
  }

  try {
    return keypair.verify(messageBytes, signature);
  } catch {
    return false;
  }
}
