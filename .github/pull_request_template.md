# Pull Request

## Summary

<!-- What does this change and why? -->

## Repository

- [ ] `susu-api`
- [ ] `susu-contracts`
- [ ] `susu-web`
- [ ] `susu-indexer`

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Refactor (no behavior change)
- [ ] Documentation
- [ ] CI / tooling
- [ ] Security hardening
- [ ] Database migration

## Financial & authority impact

- [ ] This change does **not** move any financial authority into the API.
- [ ] This change **does** affect financial presentation or authorization — a maintainer
      approved the approach in an issue.

- [ ] No floating-point arithmetic is used for money.
- [ ] The API still cannot decide balances, recipients, eligibility, or override chain state.
- [ ] Transaction success is reported only after chain confirmation.

## Database / migration impact

- [ ] No database or migration changes.
- [ ] Database or migration changes included.
      - [ ] RLS is enabled on every new/altered table in the same migration.
      - [ ] Policies are deny-by-default using `auth.uid()` / ownership / membership checks.
      - [ ] No `USING (true)` / `WITH CHECK (true)` without recorded security review.
      - [ ] Unnecessary `anon`/`authenticated` privileges revoked; grants follow least privilege.
      - [ ] Browser clients have no write access to chain-derived tables.
      - [ ] Columns used by RLS filters are indexed.
      - [ ] Functions remain `SECURITY INVOKER` unless justified and reviewed.
      - [ ] `pnpm db:security-test` passes.
      - [ ] Migration is reversible or has a documented forward-fix plan.

## Security impact

- [ ] No secrets, service-role keys, or database passwords are logged, returned, or committed.
- [ ] New endpoints validate input with Zod.
- [ ] CORS, rate limiting, and secure headers still apply to new routes.

## Testing

- [ ] New or updated tests cover the change, including negative paths.
- [ ] `format`, `lint`, `typecheck`, `test`, `build` pass.

## Checklist

- [ ] Docs updated to match the implementation.
- [ ] No claims of being audited, secure, or production-ready were added.
