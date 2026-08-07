# Contributing to the Susu API

Thanks for your interest. This service sits next to on-chain money, so the bar for
database and authorization changes is high.

## Before you start

- Read `README.md` and `SECURITY.md`.
- Any change to RLS, grants, financial presentation, wallet linking, or transaction
  preparation needs maintainer review first. Open an issue before a PR.

## Ground rules

1. **Never** move financial authority into this service. The API does not decide balances,
   recipients, eligibility, or authorization.
2. **Never** disable, weaken, or omit RLS. Every migration that creates a table must enable
   RLS in the same migration.
3. **Never** use `USING (true)` / `WITH CHECK (true)` without explicit security review.
4. **Never** log or return secrets, tokens, keys, or connection strings.
5. **Never** use floating-point arithmetic for money.
6. **Never** treat wallet signature success as transaction success.
7. Prefer simple, auditable code over clever abstractions.

## Development setup

```bash
pnpm install
cp .env.example .env
pnpm dev
```

## Checks before opening a PR

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm db:security-test   # required for any migration change
```

## Migration requirements

Every migration that adds or alters an application table must:

- [ ] Enable RLS on the table in the same migration.
- [ ] Add deny-by-default policies using `auth.uid()` / ownership / membership checks.
- [ ] Revoke unnecessary `anon` and `authenticated` privileges; grant only what is required.
- [ ] Grant browser clients **no** write access to chain-derived tables.
- [ ] Index the columns used by RLS filters.
- [ ] Keep functions `SECURITY INVOKER` unless justified, with safe `search_path` and
      restricted `EXECUTE`.
- [ ] Update the database security tests.

## Commit messages

Clear, imperative subject lines. Reference issues where applicable. Do not add co-author
trailers for tooling.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
