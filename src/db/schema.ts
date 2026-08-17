/**
 * Database schema owned by this service.
 *
 * Phase 4 adds the application tables. The document's phase list places
 * "Supabase Auth + Postgres + RLS + profiles" together because the three are one
 * decision: a table without RLS is a table the browser can read, so the profile
 * table and its policies ship in the same migration.
 *
 * Only `profiles` is declared here. `wallet_links`, `invite_links` and
 * `notifications` belong to later phases ("Backend + invites"), and declaring
 * them now would mean shipping tables nothing writes to.
 *
 * WHY THE CHAIN-DERIVED TABLES ARE NOT DECLARED HERE
 * `groups`, `group_members`, `contributions`, `payouts`, `protocol_fees` and
 * `decoded_events` belong to the indexer: `susu-indexer` owns their DDL, in
 * `supabase/migrations/20260816000000_chain_derived.sql`. This service only
 * reads them.
 *
 * Declaring them here as well would give `drizzle-kit generate` the impression
 * that this repository owns them, and it would emit `create table` and
 * `alter table` statements for tables another service migrates. Two
 * repositories generating migrations for one table is how a schema drifts, so
 * the ownership boundary is drawn in the one place that enforces it: the
 * generator's schema file.
 *
 * They are read through explicit SQL in `src/db/groups.ts`, which selects each
 * amount with a `::text` cast. That is not belt-and-braces: the indexer's
 * migration documents that a `numeric` read can reach JavaScript as a JSON
 * number, and `src/lib/base-units.ts` explains why that must be a loud failure
 * rather than a round number.
 *
 * MANDATORY REQUIREMENTS FOR EVERY TABLE ADDED HERE
 *
 * 1. Row Level Security is enabled in the same migration that creates the table.
 *    RLS is never silently disabled by a later migration.
 * 2. Policies are deny-by-default, then grant the minimum required operation.
 *    Policies use `auth.uid()` and ownership/membership checks.
 * 3. Postgres grants are tightened alongside RLS: unnecessary `anon` and
 *    `authenticated` privileges are revoked, and only required operations are granted.
 *    RLS does not replace grants.
 * 4. Chain-derived tables (contributions, payouts, transactions, indexed events)
 *    grant browser clients NO insert/update/delete access. Only trusted
 *    server/indexer paths write to them.
 * 5. Columns used by RLS filters (`user_id`, `group_id`, membership keys) are indexed.
 * 6. Database functions default to SECURITY INVOKER. SECURITY DEFINER requires a
 *    safe `search_path`, fully qualified relations, restricted EXECUTE, and review.
 * 7. pgTAP/Supabase security tests cover anonymous denial, ownership and group
 *    boundaries, denied CRUD, Storage policies, and server-only tables.
 */

import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * A user's public profile.
 *
 * Keyed by `user_id`, which is the Supabase Auth user id — the same value
 * `auth.uid()` returns inside a policy. That is what makes the ownership check a
 * direct comparison rather than a lookup through a second table.
 *
 * `display_name` and `avatar_path` are both nullable, and that is deliberate:
 * the document requires that a profile photo "must not block signup", and the
 * same reasoning applies to a display name. A row can therefore exist with
 * nothing in it but the key, and a user who never sets a name is still a valid
 * user. Defaulting either to a placeholder string would make "unset" and
 * "deliberately set to this value" indistinguishable.
 *
 * `avatar_path` stores an object key, never a URL. The document is explicit on
 * this: a stored URL outlives the bucket layout, leaks the storage host into the
 * database, and cannot be re-signed when access policy changes.
 *
 * PRIMARY KEY, NOT A UNIQUE CONSTRAINT
 * The document says `user_id unique`. A primary key is that uniqueness plus a
 * NOT NULL that a bare unique constraint would not add, and it gives the
 * ownership lookup an index for free. A nullable `user_id` would mean a profile
 * nobody can reach — visible to no one and owned by no one.
 *
 * NO FOREIGN KEY IS DECLARED HERE
 * In Supabase this should cascade from `auth.users`, so that deleting a user
 * removes their profile. Drizzle cannot express "add this constraint only if the
 * auth schema exists", and that condition is not hypothetical: CI runs plain
 * Postgres, where `auth.users` does not exist, so an unconditional foreign key
 * would fail to apply there. The constraint is added conditionally in
 * `drizzle/0000_profiles.sql` instead, where the guard can be written out. See
 * that file for the reasoning.
 *
 * `avatar_path` is intentionally not backed by Storage policies yet. The bucket
 * and its owner-scoped policies land with the upload UI in the settings phase;
 * adding the column now keeps the profile a single row rather than a migration
 * later, and the column is unreachable until a policy exists to write it.
 */
export const profiles = pgTable('profiles', {
  userId: uuid('user_id').primaryKey(),

  displayName: text('display_name'),
  avatarPath: text('avatar_path'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
