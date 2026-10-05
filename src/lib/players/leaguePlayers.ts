import { eq, getTableColumns } from 'drizzle-orm'
import type { NeonHttpDatabase } from 'drizzle-orm/neon-http'
import { mnsPlayers, mnsSportPlayers } from '../db/schema.js'

// One shape for "a player in a league": the league's own state for her
// (team, slot, keeper, redshirt, the commissioner's presence override)
// joined to the sport's truth about her (name, position, team, salary,
// age, years, presence, injury). Every read goes through here. A
// league row never carries identity of its own.
export const leaguePlayerColumns = {
  ...getTableColumns(mnsPlayers),
  sportPlayerId: mnsPlayers.sportPlayerId,
  espnId: mnsSportPlayers.espnId,
  name: mnsSportPlayers.name,
  position: mnsSportPlayers.position,
  salary: mnsSportPlayers.salary,
  salarySource: mnsSportPlayers.salarySource,
  teamCode: mnsSportPlayers.teamCode,
  externalIds: mnsSportPlayers.externalIds,
  yearsPro: mnsSportPlayers.yearsPro,
  age: mnsSportPlayers.age,
  jersey: mnsSportPlayers.jersey,
  leaguePresence: mnsSportPlayers.presence,
  injuryStatus: mnsSportPlayers.injuryStatus,
  injuryNote: mnsSportPlayers.injuryNote,
  injuryUpdatedAt: mnsSportPlayers.injuryUpdatedAt,
}

// Typed against the real driver so callers get typed rows back; the
// schema generic is irrelevant to the query builder.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = NeonHttpDatabase<any>

// `leaguePlayers(db).where(eq(mnsPlayers.leagueId, id))` — the join is
// already made; filter on mnsPlayers.* or mnsSportPlayers.* as needed.
export function leaguePlayers(db: Db) {
  return db
    .select(leaguePlayerColumns)
    .from(mnsPlayers)
    .innerJoin(mnsSportPlayers, eq(mnsSportPlayers.id, mnsPlayers.sportPlayerId))
}

export type LeaguePlayer = Awaited<ReturnType<typeof leaguePlayers>>[number]
