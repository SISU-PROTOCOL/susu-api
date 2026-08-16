import { describe, expect, it } from 'vitest';
import { connectionHost, resolveSslPolicy, withoutSslModeParams } from './ssl';

const HOSTED = 'postgresql://postgres.abc:pw@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';
const LOCAL = 'postgresql://postgres:postgres@localhost:54322/postgres';
const LOOPBACK = 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';

/** The common case: a remote host with no CA and no explicit acknowledgement. */
const bare = (overrides: Partial<Parameters<typeof resolveSslPolicy>[0]> = {}) =>
  resolveSslPolicy({ connectionString: HOSTED, allowUnverified: false, ...overrides });

describe('connectionHost', () => {
  it('extracts the host', () => {
    expect(connectionHost(HOSTED)).toBe('aws-1-eu-west-1.pooler.supabase.com');
    expect(connectionHost(LOCAL)).toBe('localhost');
  });

  it('returns undefined for an unparseable string rather than throwing', () => {
    expect(connectionHost('not a url')).toBeUndefined();
  });
});

describe('withoutSslModeParams', () => {
  it('returns the string untouched when no ssl parameter is present', () => {
    // Byte-for-byte, so a password needing no escaping is never re-encoded.
    expect(withoutSslModeParams(HOSTED)).toBe(HOSTED);
  });

  it('removes sslmode so it cannot contradict the explicit configuration', () => {
    // `sslmode=require` now means `verify-full` to pg, which fails against the
    // pooler's self-signed chain even though TLS is configured correctly here.
    const stripped = withoutSslModeParams(`${HOSTED}?sslmode=require`);
    expect(stripped).not.toContain('sslmode');
    expect(stripped).toContain('pooler.supabase.com');
  });

  it('removes uselibpqcompat too', () => {
    const stripped = withoutSslModeParams(`${HOSTED}?uselibpqcompat=true&sslmode=require`);
    expect(stripped).not.toContain('uselibpqcompat');
    expect(stripped).not.toContain('sslmode');
  });

  it('keeps unrelated parameters', () => {
    const stripped = withoutSslModeParams(`${HOSTED}?sslmode=require&application_name=susu-api`);
    expect(stripped).toContain('application_name=susu-api');
  });
});

describe('resolveSslPolicy — refusing an unauthenticated connection', () => {
  it('refuses a remote host with no CA and no acknowledgement', () => {
    // The regression this whole policy exists for. Encrypted and
    // unauthenticated looks identical to encrypted and verified at runtime, so a
    // deployment that fell back to the weaker one would never be noticed.
    const result = bare();
    expect(result.ok).toBe(false);
  });

  it('explains both remedies rather than just refusing', () => {
    // A refusal an operator cannot act on gets worked around, not fixed.
    const result = bare();
    if (result.ok) throw new Error('expected the policy to refuse');
    expect(result.remedy).toContain('DATABASE_SSL_CA');
    expect(result.remedy).toContain('DATABASE_SSL_ALLOW_UNVERIFIED');
    expect(result.reason).toContain('aws-1-eu-west-1.pooler.supabase.com');
  });

  it('refuses when the host cannot be parsed', () => {
    // Fails closed: an unparseable URL must not be assumed local, which would
    // send credentials in clear text to whatever pg ends up connecting to.
    const result = resolveSslPolicy({ connectionString: 'nonsense', allowUnverified: false });
    expect(result.ok).toBe(false);
  });

  it('accepts an unverified remote connection only once acknowledged', () => {
    const result = bare({ allowUnverified: true });
    expect(result).toEqual({ ok: true, ssl: { rejectUnauthorized: false } });
  });
});

describe('resolveSslPolicy — verified and local connections', () => {
  it('verifies the server when a CA is supplied', () => {
    expect(bare({ ca: CA })).toEqual({
      ok: true,
      ssl: { rejectUnauthorized: true, ca: CA },
    });
  });

  it('verifies without needing the acknowledgement flag', () => {
    // A CA is the fix; the flag is only for accepting the gap.
    expect(bare({ ca: CA, allowUnverified: false }).ok).toBe(true);
  });

  it('ignores a blank CA rather than treating it as verification', () => {
    // A variable that exists but is empty must not silently count as configured,
    // which would either disable verification or fail confusingly.
    expect(bare({ ca: '   ' }).ok).toBe(false);
    expect(bare({ ca: '' }).ok).toBe(false);
  });

  it('does not require TLS for a local database', () => {
    // The Supabase CLI stack and containers speak plain TCP; requiring TLS there
    // would break local development for no gain.
    for (const connectionString of [LOCAL, LOOPBACK]) {
      expect(resolveSslPolicy({ connectionString, allowUnverified: false })).toEqual({
        ok: true,
        ssl: false,
      });
    }
  });

  it('does not verify a local database even when a CA is supplied', () => {
    expect(resolveSslPolicy({ connectionString: LOCAL, ca: CA, allowUnverified: false })).toEqual({
      ok: true,
      ssl: false,
    });
  });
});
