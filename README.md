# Susu Protocol — API

[![CI](https://github.com/SISU-PROTOCOL/susu-api/actions/workflows/ci.yml/badge.svg)](https://github.com/SISU-PROTOCOL/susu-api/actions/workflows/ci.yml)

Backend API for **Susu Protocol** — a non-custodial rotating savings protocol on Stellar.

> **Status: Phase 6 — group read model.** Health endpoints, configuration validation,
> the read-only group API over the indexer's chain-derived tables, accounts, wallet
> linking, invites and notifications are in place. Nothing here is audited.

## This service is not a custodian

The API is an **application layer only**. It may handle sessions, profiles, invites,
notifications, read APIs, transaction preparation, indexing, reconciliation, and rate
limiting.

It may **not** decide balances, payout recipients, eligibility, or financial
authorization, and it may **not** override contract state. If database state ever conflicts
with Stellar/Soroban state, **the chain wins** and reconciliation repairs the database.

## Stack

Node.js · TypeScript · Fastify · Zod · Drizzle ORM · PostgreSQL (Supabase) · Stellar SDK

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness. Does no I/O. |
| `GET` | `/ready` | Readiness, including a database probe. |
| `GET` | `/api/v1/groups` | List groups. Filters: `status`, `creator`, `member`. |
| `GET` | `/api/v1/groups/:contractId` | One group, with its members and per-round summary. |
| `GET` | `/api/v1/groups/:contractId/contributions` | Contributions, in round then ledger order. |
| `GET` | `/api/v1/groups/:contractId/payouts` | Payouts, net of the protocol fee. |
| `GET` | `/api/v1/groups/:contractId/activity` | Every decoded event, as the audit trail. |
| `POST` | `/api/v1/groups` | Records a group address the chain has just produced, for a bounded window. See below. |

Lists are paginated with `limit` (default 20, max 100) and `offset` (max 10000), and
return `{ data, page: { limit, offset, hasMore } }`.

Filtering by `member` is how a wallet's groups are read — there is no separate
wallet endpoint, because the answer is the same list under a different filter.

Planned surface (from Phase 7): `/api/v1/me`, `/api/v1/wallet/nonce`,
`/api/v1/wallet/verify`, `/api/v1/groups/:id/join`, `/api/v1/groups/:id/invites`,
`/api/v1/transactions/:hash`, `/api/v1/notifications`.

One path from the document's surface is deliberately absent: `POST
/api/v1/transactions/prepare`. Building or simulating a transaction is the browser's job
in this design — it holds the key, it simulates against Soroban RPC, and it signs — so a
server-side "prepare" would either duplicate work the client already does or become the
one place a transaction's contents are decided away from the user's key. The endpoint has
a legitimate form only if it means *fee sponsorship*: the server holds a funded account
and wraps the client's signed transaction in a fee bump, so members need no XLM. That
would put a spending key in this service and is a product decision, not an implementation
detail, so it is not done unnoticed.

## Why `POST /api/v1/groups` exists and does not create a group

A group's address is the hash of its own deployment, so the only way to learn that a
group exists is to watch the Factory emit it. The indexer does that on a schedule, which
means there is a window after a creator's confirmation in which the address is real, is
on the public ledger, and is unknown to this API. Creating an invite requires the API to
recognise the group, so without this endpoint a creator could create a group and then be
unable to invite anyone to it until the indexer's next run — the middle of the product's
core journey, blocked by a scheduler.

The body is `{ "contractId": "C…" }` and nothing else. The response is the address and
when the claim lapses. What is stored is an address, the account that claimed it, and an
expiry: no amount, no membership, no status. It cannot make a contract exist, nothing
financial reads it, and it is believed only until it expires — after which the index is
the only thing that can vouch for the address. An account may hold a handful of live
claims at once, so the window cannot be held open across many addresses.

The claim is **not** verified against the chain. Verifying it would mean this service
decoding Soroban event XDR, and the exposure it would close is a code naming an address
that turns out not to be a group — which grants nothing, because the contract decides
who may join. Rate limiting invitation abuse is the proper mitigation and is separate
work.

## The read model

These endpoints report what the contracts did. They read the tables `susu-indexer`
writes — `groups`, `group_members`, `contributions`, `payouts`, `protocol_fees`,
`decoded_events` — and never write them. Nothing here decides an amount, a recipient,
or eligibility.

**Amounts are base-unit strings, never numbers.** A group's `contributionAmount` is
`"100000000"`, not `100000000`. A JSON number is an IEEE-754 double and holds integers
exactly only up to 2^53, while an `i128` runs to 39 digits, so an amount that travels
as a number can be silently rounded — and a rounded balance is indistinguishable from a
correct one. Every monetary column is selected with an explicit `::text` cast and
validated on the way out (`src/lib/base-units.ts`), so a lost cast fails loudly instead
of rounding quietly. Clients format base units for display; they do not do arithmetic
on them except in integers.

**The chain-derived tables are not declared in `src/db/schema.ts`.** `susu-indexer` owns
their DDL, and declaring them here would give `drizzle-kit generate` the impression that
this repository owns them and make it emit migrations for another service's tables. See
the comment in that file: the ownership boundary is drawn where the generator enforces it.

**Responses can be stale.** The index trails the chain by up to one scheduled indexing
run, so these endpoints answer "what the index knows", not "what is true now". Responses
carry a five-second `cache-control` for the same reason. A client that needs certainty
reads the contract.

## Security controls

- **Strict CORS allowlist.** An empty allowlist means no cross-origin access.
- **Secure headers** via helmet, **rate limiting** globally, small body limit.
- **Zod validation** at the boundary.
- **Secret-free structured logging** with explicit redaction paths.
- **Elevated-credential guards** that refuse to start when configuration is unsafe:
  - A non-`service_role` token in `SUPABASE_SERVICE_ROLE_KEY`.
  - `PROTOCOL_FEE_BPS` differing from the on-chain `50` bps.
  - `STELLAR_NETWORK=mainnet` without explicit `ALLOW_MAINNET=true`.

## Database security

The database is a rebuildable index of chain activity, never the source of truth.

Row Level Security and least-privilege grants are mandatory for every table exposed through
the Supabase Data API. Guards run in CI and **must** be run for any migration change:

```bash
DATABASE_URL=postgresql://... pnpm db:security-test
```

The guards fail if any table in the exposed schema has RLS disabled, or if any policy is
unconditionally permissive (`USING (true)` / `WITH CHECK (true)`). CI additionally verifies
the guard itself by creating an unprotected table and asserting detection.

The chain-derived tables are covered by the same guards even though this service does not
create them: they have RLS enabled with no policies, and `anon` and `authenticated` hold no
privileges on them.

## Connecting to a hosted database

`pg` does not enable TLS by default, and hosted Postgres — Supabase included — refuses an
unencrypted connection. Left alone, every query fails with `Connection terminated due to
connection timeout`, which reads as a network fault rather than a missing TLS handshake.
The connection therefore configures TLS explicitly (`src/db/ssl.ts`) instead of leaving it to
the connection string.

Supabase serves its pooler from a **private certificate authority**, not a public one:

```
CN=*.pooler.supabase.com
CN=Supabase Intermediate 2021 CA
CN=Supabase Root 2021 CA        <- self-signed
```

Node's trust store will never carry that root, so the connection can be encrypted without the
server being authenticated. Three consequences:

- **The API refuses to start** against a remote database with neither a CA nor an explicit
  acknowledgement. Encrypted-and-unverified is indistinguishable from encrypted-and-verified at
  runtime, so a deployment that quietly fell back to the weaker one would go unnoticed.
- **Take `DATABASE_SSL_CA` from the dashboard**, at Project Settings → Database → SSL
  configuration. Do not scrape it from the connection: a CA captured over the channel it is
  meant to secure is trust-on-first-use, and an attacker present at capture time would supply
  their own root to be pinned permanently.
- **`DATABASE_SSL_ALLOW_UNVERIFIED=true` accepts the gap deliberately.** Until a CA is supplied,
  anything between this service and the database could terminate the TLS session undetected.

Do **not** append `sslmode=` to `DATABASE_URL`. Modern `pg` reads `sslmode=require` as
`verify-full`, which fails against the pooler's chain; the parameter is ignored on purpose so
there is one source of truth for TLS.

The Supabase direct host (`db.<ref>.supabase.co`) publishes only an IPv6 address, so a network
without IPv6 must use the pooler:
`postgresql://postgres.<ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres`.
Local development against the Supabase CLI stack needs no TLS and is detected automatically.

## Development

Requires Node ≥ 22 and pnpm.

```bash
pnpm install
cp .env.example .env    # then fill in values
pnpm dev
```

## Checks

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:security-test   # requires DATABASE_URL and psql
```

## Configuration

All configuration is **server-only**. Never add a value from `.env` to any `VITE_`-prefixed
variable — those are bundled into the browser.

## Security

Unaudited. See [`SECURITY.md`](SECURITY.md) for reporting.

## License

[MIT](LICENSE)
