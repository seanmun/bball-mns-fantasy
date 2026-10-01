# bball-mns-fantasy

WNBA-only build of the Money Never Sleeps dynasty fantasy basketball platform, hosted at `wnba.mnsfantasy.com`.

This repo is the v2 platform — built fresh on Clerk + Neon + Drizzle + Vercel — succeeding the Supabase-based [`mns/`](../mns/) app, which stays frozen until cutover.

## Stack

- **Framework:** Vite + React 19 + TypeScript (strict)
- **Styling:** Tailwind 4
- **Auth:** Clerk (shared session across `*.mnsfantasy.com`)
- **DB:** Neon Postgres (shared with sibling games; tables prefixed `wnba_`)
- **ORM:** Drizzle (`drizzle-kit` for migrations)
- **API:** Vercel serverless functions in `api/`
- **State:** TanStack Query (polling — no realtime)
- **Tests:** Vitest (target >80% line coverage on `src/rules/`)

## Plan documents

- [FEATURES.md](./FEATURES.md) — feature inventory the build must preserve
- [REFACTOR_PLAN.md](./REFACTOR_PLAN.md) — architecture + build phases
- [SCAFFOLD_PLAN.md](./SCAFFOLD_PLAN.md) — file-by-file scaffold spec

## Local dev

Prerequisites: Node 20+ (`nvm use`), npm.

```bash
nvm use
npm install
cp .env.example .env
# fill in Clerk + Neon credentials
npm run dev
```

App runs at <http://localhost:5173>.

## Database

```bash
npm run db:generate    # generate migration from schema changes
npm run db:push        # apply to Neon (use carefully)
npm run db:studio      # browse data
npm run db:check       # validate migration consistency
```

Schema source of truth: [`src/lib/db/schema.ts`](./src/lib/db/schema.ts).

## Tests

```bash
npm run test           # one-shot
npm run test:watch     # watch mode
```

## Deployment

Hosted on Vercel. Push to `main` → auto-deploy. Domain: `wnba.mnsfantasy.com`.
