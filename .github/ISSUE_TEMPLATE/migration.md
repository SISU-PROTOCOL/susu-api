---
name: Database migration
about: Propose a schema change (RLS, grants and security tests are mandatory)
title: "[migration] "
labels: ["task", "database"]
assignees: ""
---

> Every migration that adds or alters an application table must enable RLS in the same
> migration and must pass the database security guards. Migrations that widen access
> require explicit security review.

## Purpose

<!-- Why is this schema change needed? -->

## Tables and columns

<!-- List each table added or altered. -->

## RLS plan

- [ ] RLS enabled on every new/altered table in the same migration.
- [ ] Policies are deny-by-default.
- [ ] Policies use `auth.uid()` / ownership / membership checks.
- [ ] No `USING (true)` / `WITH CHECK (true)` without review.
- [ ] Chain-derived tables have no browser write access.
- [ ] RLS filter columns are indexed.

## Grants plan

- [ ] Unnecessary `anon`/`authenticated` privileges revoked.
- [ ] Only required operations granted.
- [ ] Functions remain `SECURITY INVOKER` unless justified and reviewed.

## Data origin

- [ ] Chain-derived (written by trusted server/indexer paths only).
- [ ] User-generated (owner-scoped).
- [ ] Server/internal only.

## Rollback / forward-fix plan

<!-- How is this undone or corrected if it goes wrong? -->

## Verification

- [ ] `pnpm db:security-test` passes locally.
- [ ] Security tests added or updated for anonymous denial, ownership boundaries, and denied CRUD.
