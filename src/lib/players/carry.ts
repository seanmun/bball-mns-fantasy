import { sql } from 'drizzle-orm'
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http'
import { mnsPlayers } from '../db/schema.js'
import type { RookieDraftInfo } from '../../types/player.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NeonHttpDatabase<any>

// Neon HTTP is a round trip per statement, so a league's worth of rows
// goes in ONE update from a VALUES list.

// The round each player occupied in this season's draft — a keeper's
// stacked round at lock, a drafted player's board round at sync.
export async function writeDraftRounds(
  db: Db,
  leagueId: string,
  rows: Array<{ id: string; draftRound: number }>
): Promise<void> {
  if (rows.length === 0) return
  const values = sql.join(
    rows.map((r) => sql`(${r.id}::text, ${r.draftRound}::int)`),
    sql`, `
  )
  await db.execute(sql`
    update ${mnsPlayers} as p
    set draft_round = v.round, updated_at = now()
    from (values ${values}) as v(id, round)
    where p.id = v.id and p.league_id = ${leagueId}
  `)
}

// The turn of the year: next season's starting point for every player,
// and the occupied round is consumed.
export async function writeCarry(
  db: Db,
  leagueId: string,
  rows: Array<{
    id: string
    keeperPriorYearRound: number | null
    rookieDraftInfo: RookieDraftInfo | null
  }>
): Promise<void> {
  if (rows.length === 0) return
  const values = sql.join(
    rows.map(
      (r) =>
        sql`(${r.id}::text, ${r.keeperPriorYearRound}::int, ${
          r.rookieDraftInfo ? JSON.stringify(r.rookieDraftInfo) : null
        }::jsonb)`
    ),
    sql`, `
  )
  await db.execute(sql`
    update ${mnsPlayers} as p
    set keeper_prior_year_round = v.prior,
        rookie_draft_info = v.slot,
        draft_round = null,
        updated_at = now()
    from (values ${values}) as v(id, prior, slot)
    where p.id = v.id and p.league_id = ${leagueId}
  `)
}
