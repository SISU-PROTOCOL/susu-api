import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit configuration.
 *
 * Migrations are generated into `drizzle/` and reviewed before merge. Every
 * migration that creates or alters an application table exposed through the
 * Supabase Data API must keep RLS enabled and must never widen access silently.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
