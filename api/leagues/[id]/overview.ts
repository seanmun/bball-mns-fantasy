import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq } from 'drizzle-orm'
import { verifyAuth } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsLeagues,
  mnsLeagueWeeks,
  mnsPlayers,
  mnsPortfolios,
  mnsTeamOwners,
  mnsTeams,
} from '../../../src/lib/db/schema.js'
import { leaguePlayers } from '../../../src/lib/players/leaguePlayers.js'
import { computeStandings, easternToday } from '../../../src/lib/season/score.js'
import { dayGames } from '../../../src/lib/season/statSources.js'
import { faWindow, nextClearDate } from '../../../src/lib/season/waivers.js'
import { capUsed, rosterSpots } from '../../../src/lib/season/roster.js'
import { logger } from '../../_logger.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'

// The league in one read — built for the assistant, honest for anyone:
// phase and week, standings with per-team category production, cap
// ladder, the FA window, the pot, and how many games each WNBA club
// still plays this league week (the streaming number).
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })
    const config = league.config as LeagueConfig
    const today = easternToday()

    const weeks = await db
      .select()
      .from(mnsLeagueWeeks)
      .where(and(eq(mnsLeagueWeeks.leagueId, leagueId), eq(mnsLeagueWeeks.seasonYear, league.seasonYear)))
    const currentWeek = weeks.find((w) => w.startDate <= today && today <= w.endDate) ?? null

    const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
    const owners = await db.select().from(mnsTeamOwners)
    const rec = await computeStandings(db, leagueId, league.seasonYear)
    const players = await leaguePlayers(db)
      .where(eq(mnsPlayers.leagueId, leagueId))

    const [mine] = owners.filter(
      (o) => o.userId === userId && teams.some((t) => t.id === o.teamId)
    )

    const rows = teams
      .map((t) => {
        const r = rec.get(t.id) ?? { wins: 0, losses: 0, ties: 0, pointsFor: 0 }
        const roster = players.filter((p) => p.teamId === t.id)
        return {
          teamId: t.id,
          name: t.name,
          isMine: mine?.teamId === t.id,
          wins: r.wins,
          losses: r.losses,
          ties: r.ties,
          categoryPoints: r.pointsFor,
          rosterCount: rosterSpots(players, t.id).length,
          redshirts: roster.filter((p) => p.slot === 'redshirt').length,
          salary: capUsed(players, t.id),
        }
      })
      .sort((a, b) => b.wins - a.wins || b.categoryPoints - a.categoryPoints)

    // Games left this league week per WNBA club — today through the
    // week's end. The 4-games-left player is the streaming prize.
    const gamesLeft: Record<string, number> = {}
    if (currentWeek) {
      let d = today
      let guard = 0
      while (d <= currentWeek.endDate && guard < 8) {
        const slate = await dayGames(d)
        for (const [code] of slate) gamesLeft[code] = (gamesLeft[code] ?? 0) + 1
        d = new Date(new Date(`${d}T12:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)
        guard++
      }
    }

    const window = await faWindow()
    const [portfolio] = await db
      .select()
      .from(mnsPortfolios)
      .where(eq(mnsPortfolios.id, leagueId))
      .limit(1)
    const prizes = config.prizes ?? null

    return res.status(200).json({
      league: {
        id: league.id,
        name: league.name,
        seasonYear: league.seasonYear,
        phase: league.leaguePhase,
        week: currentWeek?.matchupWeek ?? null,
        weekEnds: currentWeek?.endDate ?? null,
      },
      myTeamId: mine?.teamId ?? null,
      standings: rows,
      cap: config.cap?.enabled ? config.cap : null,
      rosterRules: { activeSize: config.roster?.activeSize ?? 10, irSlots: config.roster?.irSlots ?? 3, maxKeepers: config.roster?.maxKeepers ?? 0 },
      freeAgency: { window: window.mode, firstTip: window.firstTip, clearsOn: nextClearDate() },
      gamesLeftThisWeek: gamesLeft,
      prizePool: prizes
        ? {
            potUsd: prizes.potUsd,
            walletUsd: portfolio?.cachedUsdValue != null ? Number(portfolio.cachedUsdValue) : null,
            splits: prizes.splits,
          }
        : null,
    })
  } catch (err) {
    logger.error('GET /api/leagues/[id]/overview failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to load the overview' })
  }
}
