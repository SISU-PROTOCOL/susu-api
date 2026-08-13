/**
 * Database schema owned by this service.
 *
 * Phase 0 onward: API-owned tables (profiles, wallet links, invite links,
 * notifications) are declared here and migrated through `drizzle-kit`.
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

export {};
