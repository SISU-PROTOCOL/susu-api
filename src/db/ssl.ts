/**
 * TLS configuration for the database connection.
 *
 * Hosted Postgres — Supabase included — refuses an unencrypted connection, so
 * `pg`'s default of no TLS makes every query time out. That failure is worth
 * stating plainly because it looks like a network problem rather than a
 * configuration one: `Connection terminated due to connection timeout`, with no
 * hint that a TLS handshake is what never happened.
 *
 * WHY VERIFICATION IS OFF BY DEFAULT
 * The Supabase pooler presents a chain rooted in its own CA, which Node's trust
 * store does not carry, so verifying against that store fails with
 * `self-signed certificate in certificate chain`. Turning verification off keeps
 * the connection encrypted but does not authenticate the server, which is a real
 * gap: an attacker positioned between this service and the database could
 * terminate the TLS session without being detected.
 *
 * `DATABASE_SSL_CA` closes it. Supplying Supabase's CA bundle (Project Settings →
 * Database → SSL configuration) switches verification on, and connection
 * failures then mean what they say. The default is a deliberate, documented
 * concession for the MVP, not an oversight.
 *
 * The decision is a pure function of the connection string and the CA so it can
 * be tested without a database, because getting it wrong is a silent security
 * regression rather than a visible error.
 */

export type PgSslConfig = false | { readonly rejectUnauthorized: boolean; readonly ca?: string };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Extracts the host from a connection string, or `undefined` if it cannot be
 * parsed.
 */
export function connectionHost(connectionString: string): string | undefined {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Strips `sslmode` and `uselibpqcompat` from a connection string.
 *
 * Modern `pg` reads `sslmode=require` as `verify-full`, so a URL copied from the
 * Supabase dashboard fails against the pooler's self-signed chain. Since this
 * module decides TLS explicitly, leaving a second, conflicting source of truth in
 * the URL only produces confusing failures. Only touched when such a parameter is
 * actually present, so a connection string is otherwise passed through byte for
 * byte — a round trip through `URL` can re-encode a password.
 */
export function withoutSslModeParams(connectionString: string): string {
  if (!/[?&](sslmode|uselibpqcompat)=/.test(connectionString)) return connectionString;

  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('uselibpqcompat');
    return url.toString();
  } catch {
    return connectionString;
  }
}

/**
 * Decides how to encrypt the database connection.
 *
 * @param connectionString - `DATABASE_URL`.
 * @param ca - PEM contents of the server's CA, if the operator supplied one.
 */
export function resolveSsl(connectionString: string, ca?: string): PgSslConfig {
  const host = connectionHost(connectionString);

  // Local development runs Postgres without TLS (the Supabase CLI stack, or a
  // container). Requiring TLS there would break `pnpm dev` for no gain: the
  // traffic never leaves the machine.
  if (host !== undefined && LOCAL_HOSTS.has(host)) return false;

  const trimmedCa = ca?.trim();
  if (trimmedCa !== undefined && trimmedCa.length > 0) {
    return { rejectUnauthorized: true, ca: trimmedCa };
  }

  return { rejectUnauthorized: false };
}
