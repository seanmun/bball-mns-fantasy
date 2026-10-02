import { config as loadEnv } from 'dotenv'
import type { Config } from 'drizzle-kit'

// Read .env.local first (Vite convention for local overrides), then
// fall back to .env. Drizzle-kit doesn't autoload either.
loadEnv({ path: '.env.local' })
loadEnv()

export default {
  schema: './src/lib/db/schema.ts',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  // All WNBA game tables live in the `wnba` Postgres schema. Shared
  // cross-game tables (users, marketing_*) live in `public` and are NOT
  // managed by this app's push — users is defined in schema.ts for
  // runtime queries only. Never add 'public' here: with our generic
  // table names (leagues, players, ...) drizzle would match other games'
  // public tables and try to DROP them.
  schemaFilter: [
    (() => {
      const key = process.env.VITE_SPORT
      if (key !== 'wnba' && key !== 'nba') {
        throw new Error(`VITE_SPORT must be wnba or nba for drizzle-kit — got ${JSON.stringify(key)}`)
      }
      return key
    })(),
  ],
  verbose: true,
  strict: true,
} satisfies Config
