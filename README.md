# Susu Protocol — API

[![CI](https://github.com/SISU-PROTOCOL/susu-api/actions/workflows/ci.yml/badge.svg)](https://github.com/SISU-PROTOCOL/susu-api/actions/workflows/ci.yml)

Backend API for **Susu Protocol** — a non-custodial rotating savings protocol on Stellar.

> **Status: Phase 6 — group read model.** Health endpoints, configuration validation and
> the read-only group API over the indexer's chain-derived tables are in place. Write
> endpoints and wallet linking land from Phase 7 onwards. Nothing here is audited.

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

Lists are paginated with `limit` (default 20, max 100) and `offset` (max 10000), and
return `{ data, page: { limit, offset, hasMore } }`.

Filtering by `member` is how a wallet's groups are read — there is no separate
wallet endpoint, because the answer is the same list under a different filter.

Planned surface (from Phase 7): `/api/v1/me`, `/api/v1/wallet/nonce`,
`/api/v1/wallet/verify`, `/api/v1/groups/:id/join`, `/api/v1/groups/:id/invites`,
`/api/v1/transactions/prepare`, `/api/v1/transactions/:hash`, `/api/v1/notifications`.

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
