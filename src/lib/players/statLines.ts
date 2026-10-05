import { eq } from 'drizzle-orm'
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http'
import { mnsPlayers, mnsSportStatLines } from '../db/schema.js'

// Box scores for a league's players: the SPORT's stat lines joined
// through the league row's link, keyed back to the LEAGUE player id so
// every surface keeps the shape it had. Filter on mnsPlayers.leagueId
// (and mnsPlayers.id / mnsSportStatLines.date as needed).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NeonHttpDatabase<any>

export function leagueStatLines(db: Db) {
  return db
    .select({
      playerId: mnsPlayers.id,
      sportPlayerId: mnsSportStatLines.playerId,
      date: mnsSportStatLines.date,
      eventId: mnsSportStatLines.eventId,
      min: mnsSportStatLines.min,
      pts: mnsSportStatLines.pts,
      fgm: mnsSportStatLines.fgm,
      fga: mnsSportStatLines.fga,
      ftm: mnsSportStatLines.ftm,
      fta: mnsSportStatLines.fta,
      tpm: mnsSportStatLines.tpm,
      reb: mnsSportStatLines.reb,
      ast: mnsSportStatLines.ast,
      stl: mnsSportStatLines.stl,
      blk: mnsSportStatLines.blk,
      tov: mnsSportStatLines.tov,
    })
    .from(mnsSportStatLines)
    .innerJoin(mnsPlayers, eq(mnsPlayers.sportPlayerId, mnsSportStatLines.playerId))
}

export type LeagueStatLine = Awaited<ReturnType<typeof leagueStatLines>>[number]
