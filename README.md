# Susu Protocol — API

[![CI](https://github.com/Susu-Protocol/susu-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Susu-Protocol/susu-api/actions/workflows/ci.yml)

Backend API for **Susu Protocol** — a non-custodial rotating savings protocol on Stellar.

> **Status: Phase 0 — scaffolding.** Health endpoints and configuration validation are in
> place. Application endpoints land from Phase 4 onwards. Nothing here is audited.

## This service is not a custodian

The API is an **application layer only**. It may handle sessions, profiles, invites,
notifications, read APIs, transaction preparation, indexing, reconciliation, and rate
limiting.

It may **not** decide balances, payout recipients, eligibility, or financial
authorization, and it may **not** override contract state. If database state ever conflicts
with Stellar/Soroban state, **the chain wins** and reconciliation repairs the database.

## Stack

Node.js · TypeScript · Fastify · Zod · Drizzle ORM · PostgreSQL (Supabase) · Stellar SDK

## Endpoints (Phase 0)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/ready` | Readiness |

Planned surface (implemented from Phase 4/5): `/api/v1/me`, `/api/v1/wallet/nonce`,
`/api/v1/wallet/verify`, `/api/v1/groups`, `/api/v1/groups/:id`, `/api/v1/groups/:id/join`,
`/api/v1/groups/:id/invites`, `/api/v1/groups/:id/activity`, `/api/v1/transactions/prepare`,
`/api/v1/transactions/:hash`, `/api/v1/notifications`, `/api/v1/notifications/:id/read`.

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
