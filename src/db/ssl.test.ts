import { describe, expect, it } from 'vitest';
import { connectionHost, resolveSsl, withoutSslModeParams } from './ssl';

const HOSTED = 'postgresql://postgres.abc:pw@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';
const LOCAL = 'postgresql://postgres:postgres@localhost:54322/postgres';
const LOOPBACK = 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';

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

describe('resolveSsl', () => {
  it('encrypts a hosted connection', () => {
    // Without this every query against Supabase times out, which reads as a
    // network fault rather than a missing TLS handshake.
    expect(resolveSsl(HOSTED)).toEqual({ rejectUnauthorized: false });
  });

  it('does not require TLS for a local database', () => {
    expect(resolveSsl(LOCAL)).toBe(false);
    expect(resolveSsl(LOOPBACK)).toBe(false);
  });

  it('verifies the server when a CA is supplied', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    expect(resolveSsl(HOSTED, ca)).toEqual({ rejectUnauthorized: true, ca });
  });

  it('ignores a blank CA rather than treating it as verification', () => {
    // A variable that exists but is empty must not silently disable verification
    // by making the CA `undefined`-like but "set".
    expect(resolveSsl(HOSTED, '   ')).toEqual({ rejectUnauthorized: false });
    expect(resolveSsl(HOSTED, '')).toEqual({ rejectUnauthorized: false });
  });

  it('does not verify a local database even when a CA is supplied', () => {
    expect(resolveSsl(LOCAL, 'ca')).toBe(false);
  });

  it('encrypts when the host cannot be parsed', () => {
    // Fails safe: an unparseable URL must not be assumed local, which would send
    // credentials in clear text to whatever pg ends up connecting to.
    expect(resolveSsl('nonsense')).toEqual({ rejectUnauthorized: false });
  });
});
