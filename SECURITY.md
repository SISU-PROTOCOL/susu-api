# Security Policy

## Status

The Susu Protocol API is **in active development and has not been audited**. It serves
Stellar **Testnet only**. Do not use it with real funds.

We do not claim this software is secure, audited, or production-ready.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately using GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository, or email the maintainers listed in `CODEOWNERS`.

Include a description, reproduction steps or a proof of concept, the affected commit, and
any suggested remediation. We aim to acknowledge reports within **72 hours**.

## In scope

- Authentication, session, or authorization flaws.
- Row Level Security bypasses, missing RLS, or over-broad Postgres grants.
- Service-role or other elevated credentials exposed to a client or written to logs.
- Wallet-linking flaws: reusable nonces, non-expiring nonces, or signature verification
  bypass.
- Injection (SQL, command, template) or unsafe deserialization.
- Missing validation at API boundaries.
- Invite-code enumeration or race conditions that let a caller exceed group capacity.
- Any path that would let the API override chain-derived financial state.
- Storage policy flaws for profile images.

## Out of scope

- Contract-level vulnerabilities (report in `susu-contracts`).
- Web client vulnerabilities (report in `susu-web`).
- Indexer vulnerabilities (report in `susu-indexer`).
- Dependencies (report upstream).
- Issues that require an already-compromised server or database.

## Non-negotiables

- The API is **never** a custodian and holds **no** financial authority.
- Chain state is authoritative; the database is a rebuildable index.
- RLS is never silently disabled, and never replaced by application-level checks alone.
- Service-role credentials never reach a browser, a log, or a response body.
- Money is never computed with floating-point arithmetic.

## Disclosure

We follow coordinated disclosure and will publish an advisory once a fix is available.
