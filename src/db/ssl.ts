/**
 * TLS policy for the database connection.
 *
 * Hosted Postgres — Supabase included — refuses an unencrypted connection, so
 * `pg`'s default of no TLS makes every query time out. That failure is worth
 * stating plainly because it looks like a network problem rather than a
 * configuration one: `Connection terminated due to connection timeout`, with no
 * hint that a TLS handshake is what never happened.
 *
 * WHY VERIFICATION IS NOT SIMPLY A MATTER OF SUPPLYING A CA
 * Supabase serves the connection pooler from its own private certificate
 * authority, not a public one:
 *
 *     CN=*.pooler.supabase.com
 *     CN=Supabase Intermediate 2021 CA
 *     CN=Supabase Root 2021 CA        <- self-signed
 *
 * Node's trust store does not carry that root and never will, so verifying
 * against the default store fails with `self-signed certificate in certificate
 * chain`. The connection can therefore be encrypted without the server being
 * authenticated, which is a real gap: an attacker positioned between this
 * service and the database could terminate the TLS session undetected.
 *
 * `DATABASE_SSL_CA` closes it. The CA must come from an authenticated source —
 * Supabase's dashboard (Project Settings -> Database -> SSL configuration)
 * serves it over HTTPS. It must NOT be scraped from the connection itself: a CA
 * captured over the very channel it is meant to secure is trust-on-first-use,
 * and an attacker present at capture time would simply supply their own root to
 * be pinned permanently.
 *
 * WHY AN UNVERIFIED CONNECTION IS REFUSED BY DEFAULT
 * Encrypted-but-unauthenticated and encrypted-and-verified are indistinguishable
 * once the service is running, so a deployment that quietly fell back to the
 * weaker one would never be noticed. Rather than let that be the default, an
 * unverified connection to a remote host is refused until it is either given a
 * CA or explicitly acknowledged with `DATABASE_SSL_ALLOW_UNVERIFIED=true`. The
 * flag is named for what it permits, so that setting it reads as accepting a
 * risk rather than enabling a feature.
 *
 * Every decision here is a pure function of its inputs so it can be tested
 * without a database, because getting it wrong is a silent security regression
 * rather than a visible error.
 */

export type PgSslConfig = false | { readonly rejectUnauthorized: boolean; readonly ca?: string };

export type SslPolicyInput = {
  readonly connectionString: string;
  /** PEM contents of the server's CA, if the operator supplied one. */
  readonly ca?: string;
  /** Explicit acknowledgement that the server will not be authenticated. */
  readonly allowUnverified: boolean;
};

export type SslPolicyResult =
  | { readonly ok: true; readonly ssl: PgSslConfig }
  | { readonly ok: false; readonly reason: string; readonly remedy: string };

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
 * Decides how to encrypt the database connection, and whether the result is
 * acceptable.
 *
 * Returns a structured result rather than throwing, so the caller that can act
 * on the decision chooses how to report it — the API refuses to start.
 */
export function resolveSslPolicy(input: SslPolicyInput): SslPolicyResult {
  const host = connectionHost(input.connectionString);

  // Local development runs Postgres without TLS (the Supabase CLI stack, or a
  // container). Requiring TLS there would break `pnpm dev` for no gain: the
  // traffic never leaves the machine.
  if (host !== undefined && LOCAL_HOSTS.has(host)) {
    return { ok: true, ssl: false };
  }

  const ca = input.ca?.trim();
  if (ca !== undefined && ca.length > 0) {
    return { ok: true, ssl: { rejectUnauthorized: true, ca } };
  }

  if (input.allowUnverified) {
    return { ok: true, ssl: { rejectUnauthorized: false } };
  }

  return {
    ok: false,
    // An unparseable URL is treated as remote rather than local, so a typo fails
    // closed instead of sending credentials in clear text to whatever `pg`
    // happens to resolve.
    reason: `refusing to connect to ${
      host ?? 'the configured database'
    } without authenticating the server`,
    remedy:
      'The server would be encrypted but unverified, so anything between this service and the ' +
      'database could terminate the TLS session undetected. Set DATABASE_SSL_CA to the server’s ' +
      'CA bundle (Supabase: Project Settings -> Database -> SSL configuration; the CA must come ' +
      'from the dashboard, not from the connection itself), or acknowledge the risk explicitly ' +
      'with DATABASE_SSL_ALLOW_UNVERIFIED=true.',
  };
}
