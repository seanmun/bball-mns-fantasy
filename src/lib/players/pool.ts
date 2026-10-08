import { eq, sql } from 'drizzle-orm'
import { mnsLeagues, mnsPlayers, mnsSportPlayers } from '../db/schema.js'
import { sport } from '../sport/index.js'

// A league's pool IS the sport's pool. Every league gets a row for
// every sport player the moment it exists, and every tick adds rows
// for players the sport has learned about since — a trade, a signing,
// a call-up — to every league. Nobody populates anything.
//
// One statement, idempotent: rows that exist are never touched, so a
// mid-season run never resets a roster.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export async function ensureLeaguePool(db: Db, leagueId: string): Promise<number> {
  const r = await db.execute(sql`
    insert into ${mnsPlayers} (id, league_id, sport_player_id, sport, slot)
    select ${leagueId} || ':' || sp.id, ${leagueId}, sp.id, ${sport.key}, 'active'
    from ${mnsSportPlayers} sp
    where not exists (
      select 1 from ${mnsPlayers} p where p.league_id = ${leagueId} and p.sport_player_id = sp.id
    )
  `)
  return Number((r as { rowCount?: number }).rowCount ?? 0)
}

// Every league of this sport, so a new signing shows up on every wire.
export async function ensureAllLeaguePools(db: Db): Promise<{ leagues: number; added: number }> {
  const leagues = (await db
    .select({ id: mnsLeagues.id })
    .from(mnsLeagues)
    .where(eq(mnsLeagues.sport, sport.key))) as Array<{ id: string }>
  let added = 0
  for (const l of leagues) added += await ensureLeaguePool(db, l.id)
  return { leagues: leagues.length, added }
}
