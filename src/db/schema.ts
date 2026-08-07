/**
 * Database schema.
 *
 * Phase 0: intentionally empty. Tables are introduced in Phase 4 (profiles and
 * auth-adjacent data) and Phase 5 (groups, members, rounds, contributions,
 * payouts, transactions, notifications, invites, indexed events, audit logs).
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
 *
 * Unique constraints required by the specification:
 *   - groups.contract_address            unique
 *   - group_members (group, wallet)      unique
 *   - group_rounds  (group, round)       unique
 *   - contributions (group, round, member) unique, and tx hash unique
 *   - payouts       (group, round)       unique, and tx hash unique
 *   - transactions.hash                  unique
 *   - invite_links.code                  unique
 *   - indexed_events event identity      unique
 */

export {};
