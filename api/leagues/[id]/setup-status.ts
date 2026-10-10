import type { VercelRequest, VercelResponse } from '@vercel/node'
import { eq, isNotNull, isNull, inArray, and, sql } from 'drizzle-orm'
import { verifyAuth } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsLeagues,
  mnsTeams,
  mnsTeamOwners,
  mnsPlayers,
  mnsDrafts,
  mnsRookieDraftPicks,
  mnsRosters,
} from '../../../src/lib/db/schema.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'

// One number per stage of the Commissioner setup checklist, measured,
// so each stage turns done when the league actually meets it.
export interface SetupStatus {
  teamsCount: number
  teamsWithOwners: number
  settingsSaved: boolean
  playersPoolCount: number
  playersAssignedCount: number
  // Rostered players with no round of any kind (keeper leagues): they
  // cannot be kept until the commissioner prices them.
  playersUnpricedCount: number
  rookiePicksTotal: number
  rookiePicksMade: number
  rookiePicksCount: number
  // Teams with at least one keeper declared this keeper season.
  keepersDeclaredTeams: number
  keepersLocked: boolean
  draftStatus: string | null
  seasonStarted: boolean
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = req.query.id as string | undefined
  if (!leagueId) return res.status(400).json({ error: 'Missing league id' })

  try {
    const [league] = await db
      .select({
        keepersLocked: mnsLeagues.keepersLocked,
        seasonStartedAt: mnsLeagues.seasonStartedAt,
        seasonYear: mnsLeagues.seasonYear,
        config: mnsLeagues.config,
      })
      .from(mnsLeagues)
      .where(eq(mnsLeagues.id, leagueId))
      .limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })
    const config = league.config as LeagueConfig

    const count = sql<number>`count(*)::int`
    const [teamsRow, ownersRow, poolRow, assignedRow, unpricedRow, picksRow, keepersRow, draftRow] =
      await Promise.all([
        db.select({ n: count }).from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId)),
        db
          .select({ n: sql<number>`count(distinct ${mnsTeamOwners.teamId})::int` })
          .from(mnsTeamOwners)
          .innerJoin(mnsTeams, eq(mnsTeams.id, mnsTeamOwners.teamId))
          .where(eq(mnsTeams.leagueId, leagueId)),
        db.select({ n: count }).from(mnsPlayers).where(eq(mnsPlayers.leagueId, leagueId)),
        db
          .select({ n: count })
          .from(mnsPlayers)
          .where(and(eq(mnsPlayers.leagueId, leagueId), isNotNull(mnsPlayers.teamId))),
        db
          .select({ n: count })
          .from(mnsPlayers)
          .where(
            and(
              eq(mnsPlayers.leagueId, leagueId),
              isNotNull(mnsPlayers.teamId),
              isNull(mnsPlayers.keeperPriorYearRound),
              isNull(mnsPlayers.rookieDraftInfo),
              isNull(mnsPlayers.migratedKeeperRound)
            )
          ),
        db
          .select({
            total: count,
            made: sql<number>`count(${mnsRookieDraftPicks.playerId})::int`,
          })
          .from(mnsRookieDraftPicks)
          .where(
            and(
              eq(mnsRookieDraftPicks.leagueId, leagueId),
              eq(mnsRookieDraftPicks.seasonYear, league.seasonYear)
            )
          ),
        db
          .select({ n: count })
          .from(mnsRosters)
          .where(
            and(
              eq(mnsRosters.leagueId, leagueId),
              eq(mnsRosters.seasonYear, league.seasonYear),
              inArray(mnsRosters.status, ['submitted', 'adminLocked'])
            )
          ),
        db
          .select({ status: mnsDrafts.status })
          .from(mnsDrafts)
          .where(eq(mnsDrafts.leagueId, leagueId))
          .limit(1),
      ])

    const status: SetupStatus = {
      teamsCount: teamsRow[0]?.n ?? 0,
      teamsWithOwners: ownersRow[0]?.n ?? 0,
      settingsSaved: !!config.setup?.settingsSaved,
      playersPoolCount: poolRow[0]?.n ?? 0,
      playersAssignedCount: assignedRow[0]?.n ?? 0,
      playersUnpricedCount: unpricedRow[0]?.n ?? 0,
      rookiePicksTotal: picksRow[0]?.total ?? 0,
      rookiePicksMade: picksRow[0]?.made ?? 0,
      rookiePicksCount: picksRow[0]?.total ?? 0,
      keepersDeclaredTeams: keepersRow[0]?.n ?? 0,
      keepersLocked: league.keepersLocked,
      draftStatus: draftRow[0]?.status ?? null,
      seasonStarted: league.seasonStartedAt !== null,
    }
    return res.status(200).json(status)
  } catch (err) {
    return res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to load setup status',
    })
  }
}
