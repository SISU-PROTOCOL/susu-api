# Deploying `susu-api` to Render

This service is the one part of Susu that has to be *running* to be useful. The contracts are on
chain, the client is static files, the indexer is a Supabase Edge Function on a schedule — this is
the only piece that answers a request when someone makes one.

It is also the piece with the most configuration, and it **refuses to start** if that configuration
is wrong. That is a deliberate design choice (`src/lib/env.ts` validates everything at boot), and it
means a mistake here shows up as a failed deploy with a specific message rather than as a service
that runs and returns subtly wrong answers. This document exists to make the first deploy boring.

`render.yaml` in the repository root is the blueprint. Render reads it; most of this page is about
the handful of values it deliberately does not contain.

---

## What Render runs

| | |
| --- | --- |
| Runtime | **Docker**, from `./Dockerfile` |
| Plan | `free` |
| Health check | `/health` |
| Port | `10000` (Render's default, stated explicitly) |
| Region | `frankfurt` |

Docker rather than Render's Node runtime, because the Dockerfile already does the things worth
doing — pins Node 22 to match `engines.node`, installs from the lockfile with `--frozen-lockfile`,
keeps `devDependencies` out of the runtime image, and runs as the unprivileged `node` user. Choosing
the Node runtime instead would mean restating all of that as build and start commands, where it
could drift away from what CI builds.

**Do not set a Root Directory.** It is the repository root. Render's field means "where the project
is", not "where the source is", and pointing it at `src` leaves it with no `package.json`, no
lockfile and no Dockerfile.

---

## Before you start

Three things to collect. Two of them are the reason deploys fail the first time.

**1. The Supabase pooler connection string.** Not `db.<ref>.supabase.co` — that host publishes only
an IPv6 address and Render's egress is IPv4, so the connection will hang rather than fail cleanly.
Use the pooler:

```
postgresql://postgres.<ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres
```

Supabase's dashboard gives you this under **Connect** → **Connection pooling**.

**2. The Supabase SSL CA.** Project Settings → Database → **SSL configuration**. Take it from the
dashboard, never from the connection itself: a CA captured over the channel it is meant to secure is
trust-on-first-use, and anyone present at capture time would supply their own root to be pinned
permanently. Multi-line PEM is fine.

If you genuinely cannot get it, the alternative is `DATABASE_SSL_ALLOW_UNVERIFIED=true`, which is an
acknowledgement of a machine-in-the-middle risk rather than a feature. See
[the two settings that stop it booting](#the-two-settings-that-stop-it-booting).

**3. Your Testnet contract IDs**, from
[`susu-contracts/docs/TESTNET.md`](https://github.com/susu-labs/susu-contracts/blob/main/docs/TESTNET.md) —
`FACTORY_CONTRACT_ID`, `USDC_CONTRACT_ID`, and the `TREASURY_ADDRESS`.

**4. The web client's origin.** If you have not deployed `susu-web` yet, you do not have it. That is
fine and it is the normal order — see [Deploy order](#deploy-order) — but the service will not
answer a browser until it is set.

---

## Deploy

1. Render Dashboard → **New** → **Blueprint**.
2. Connect the `susu-labs/susu-api` repository.
3. Render reads `render.yaml` and shows the service. It then prompts for each variable marked
   `sync: false` — the nine secrets, listed below.
4. Fill them in and create the service.

`WALLET_NONCE_SECRET` is not among the prompts: it uses `generateValue`, so Render produces a random
base64 256-bit value. Do not hand-pick this one.

Once it deploys, note the service URL — `https://<name>.onrender.com`. You need it twice: here, for
`CORS_ALLOWED_ORIGINS`, and in the web client, for `VITE_API_BASE_URL`.

### The values Render prompts for

| Variable | Where it comes from |
| --- | --- |
| `DATABASE_URL` | Supabase **pooler** string, above |
| `DATABASE_SSL_CA` | Supabase SSL configuration, above. Or set `DATABASE_SSL_ALLOW_UNVERIFIED` |
| `DATABASE_SSL_ALLOW_UNVERIFIED` | `'false'` if the CA is set. `'true'` only to accept the gap |
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Project API keys. **Bypasses RLS — server-only** |
| `FACTORY_CONTRACT_ID` | [`susu-contracts/docs/TESTNET.md`](https://github.com/susu-labs/susu-contracts/blob/main/docs/TESTNET.md) |
| `USDC_CONTRACT_ID` | Same file |
| `TREASURY_ADDRESS` | Same file |
| `CORS_ALLOWED_ORIGINS` | The web app's origin, e.g. `https://susu-web.onrender.com` |

Everything else — the network, the RPC URL, the passphrase, the fee, `ALLOW_MAINNET=false` — is in
the blueprint, because none of it is a secret and none of it should be retyped per deployment.

---

## The two settings that stop it booting

Both are deliberate. Both produce a clear message in the logs. Neither is a bug.

**`DATABASE_SSL_CA` (or the acknowledgement).** `src/db/ssl.ts` refuses to connect to a remote
database it cannot *authenticate*. An encrypted-but-unverified connection behaves identically to a
verified one from the outside, so the difference would never be noticed — the refusal is what makes
the gap visible instead of silent.

Do not append `sslmode=` to `DATABASE_URL`. Modern `pg` reads `sslmode=require` as `verify-full`,
which then fails against Supabase's pooler chain even though TLS is configured correctly here. The
service strips those parameters for exactly this reason.

**`PROTOCOL_FEE_BPS`.** Must be `50`, matching the deployed contracts. The API refuses to start if it
differs, because a service that disagrees with the contract about the fee is a service whose output
cannot be trusted. It is already `50` in the blueprint; this is a warning against "fixing" it later.

---

## Verify

```bash
# Liveness. Deliberately I/O-free: a failure means the process is gone, not that a
# dependency is slow — which is why it is safe for Render to poll.
curl -sS https://<name>.onrender.com/health
# {"status":"ok"}

# Readiness. Probes the database. This is the one that proves DATABASE_URL and the
# SSL configuration are both right.
curl -sS -i https://<name>.onrender.com/ready

# CORS, from the origin the browser will actually use. Look for
# `access-control-allow-origin` in the response; its absence is the failure people
# spend the longest finding, because it appears in the browser console and nowhere
# in this service's logs.
curl -sS -i -H 'Origin: https://<web-origin>' https://<name>.onrender.com/api/v1/groups | head -20
```

`/health` and `/ready` are the only two routes not under `/api/v1`. That prefix is not decoration: a
client base URL without it produces 404s that look like unimplemented routes.

---

## Deploy order

The two services reference each other, so there is a small chicken-and-egg problem. The order that
avoids a second round trip:

1. **Deploy the API first.** It does not need the web origin to start — only to answer a browser.
2. **Deploy the web client**, setting `VITE_API_BASE_URL` to `https://<api>.onrender.com/api/v1`.
   Note the prefix.
3. **Come back and set `CORS_ALLOWED_ORIGINS`** on the API to the web origin, and redeploy.

Step 3 is easy to forget, and forgetting it produces a working API and a broken client. It is also
why the order is this way round: doing the web client first means setting a value you cannot know.

While you are there, add the web origin to Supabase under **Authentication → URL Configuration →
Redirect URLs**, as `{web-url}/app` and `{web-url}/reset-password`. Supabase substitutes the
project's Site URL rather than refusing when they are missing, so the email arrives and the link
appears broken — a missing setting that presents as a bug in this application.

---

## The free plan, plainly

Free instances **spin down after about fifteen minutes of inactivity**, and the next request pays a
cold start of roughly a minute. For a demo this is fine; for anything a person is waiting on, it is
not. It is also worth knowing before concluding that the API is slow — the first request after a
pause is the instance starting, not a database query.

Render's free plan also carries a monthly hours allowance shared across free services. A service
that has spun down is not consuming it; one that is being polled continuously is.

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Deploy fails, "no such file: package.json" | Root Directory is set to `src`. Clear it |
| Exit on boot, mentions `DATABASE_SSL_CA` or authentication | Neither the CA nor `DATABASE_SSL_ALLOW_UNVERIFIED` is set |
| Exit on boot, mentions `PROTOCOL_FEE_BPS` | It is not `50`, or the contracts deployed are not the ones `susu-contracts/docs/TESTNET.md` records |
| Exit on boot, "Invalid server environment configuration" | A required variable is missing or malformed; the message names it |
| Deploy builds, then never answers | `PORT` is not `10000`. Render routes to `10000`; `src/lib/env.ts` falls back to `3000` if unset |
| Connection hangs rather than failing | `DATABASE_URL` is the direct `db.<ref>.supabase.co` host, which is IPv6-only |
| Browser blocked by CORS, nothing in these logs | `CORS_ALLOWED_ORIGINS` is empty or does not match the web origin exactly. An empty allowlist means no cross-origin access at all. No trailing slash |
| Client gets 404s on every call | `VITE_API_BASE_URL` is missing the `/api/v1` prefix |
| "expected a JavaScript module, got text/html" | Not this service. See the web client's deployment notes |

---

## What this does not do

- **It does not deploy to Mainnet, and cannot be made to by configuration alone.** `ALLOW_MAINNET`
  is `false`, and `STELLAR_NETWORK` is `testnet`. Mainnet requires the readiness gate in
  [`susu-contracts/docs/MAINNET_READINESS.md`](https://github.com/susu-labs/susu-contracts/blob/main/docs/MAINNET_READINESS.md)
  to be passed first, which is a decision rather than a setting.
- **It does not make the service a custodian.** It holds no key, signs nothing, and can be deleted
  without affecting a single balance. If database state ever conflicts with chain state, the chain
  wins and this service is wrong.
- **It does not host the indexer.** That is a Supabase Edge Function invoked by `pg_cron`; see
  [`susu-indexer/docs/RUNBOOK.md`](https://github.com/susu-labs/susu-indexer/blob/main/docs/RUNBOOK.md).
  Deploying it to Render would be wrong in kind, not just in detail: it is a scheduled job, not a
  web server.
