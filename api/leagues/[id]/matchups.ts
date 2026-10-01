import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq, gte, inArray, lte } from 'drizzle-orm'
import { verifyAuth } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsLeagues,
  mnsLeagueWeeks,
  mnsMatchups,
  mnsPlayers,
  mnsPlayerStatLines,
  mnsTeams,
} from '../../../src/lib/db/schema.js'
import { easternToday } from '../../../src/lib/season/score.js'
import { lineupResolver } from '../../../src/lib/season/lineups.js'
import { dayGames } from '../../../src/lib/season/statSources.js'
import { logger } from '../../_logger.js'

// GET /api/leagues/:id/matchups?week=N     — the week's matchups
// GET /api/leagues/:id/matchups?matchupId=&date= — one matchup with
//     rosters, per-player week lines, and the chosen DAY: both sides'
//     slots as set for that date, who plays, and that day's box lines.
//     date defaults to today, clamped into the matchup week.
// Omitting week returns the CURRENT week (today inside its dates),
// falling back to the last week of the season once it's over.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  const matchupId = req.query.matchupId ? String(req.query.matchupId) : null

  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })
    const weeks = await db
      .select()
      .from(mnsLeagueWeeks)
      .where(
        and(eq(mnsLeagueWeeks.leagueId, leagueId), eq(mnsLeagueWeeks.seasonYear, league.seasonYear))
      )
    if (weeks.length === 0) return res.status(200).json({ week: null, matchups: [] })

    const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
    const teamName = new Map(teams.map((t) => [t.id, t.name]))

    if (matchupId) {
      const [m] = await db
        .select()
        .from(mnsMatchups)
        .where(and(eq(mnsMatchups.leagueId, leagueId), eq(mnsMatchups.id, matchupId)))
        .limit(1)
      if (!m) return res.status(404).json({ error: 'Matchup not found' })
      const weekRows = weeks.filter((w) => w.matchupWeek === m.matchupWeek)
      const startDate = weekRows.reduce((a, w) => (w.startDate < a ? w.startDate : a), weekRows[0].startDate)
      const endDate = weekRows.reduce((a, w) => (w.endDate > a ? w.endDate : a), weekRows[0].endDate)

      const roster = await db
        .select()
        .from(mnsPlayers)
        .where(
          and(
            eq(mnsPlayers.leagueId, leagueId),
            inArray(mnsPlayers.teamId, [m.homeTeamId, m.awayTeamId])
          )
        )
      const lines = roster.length
        ? await db
            .select()
            .from(mnsPlayerStatLines)
            .where(
              and(
                eq(mnsPlayerStatLines.leagueId, leagueId),
                gte(mnsPlayerStatLines.date, startDate),
                lte(mnsPlayerStatLines.date, endDate),
                inArray(
                  mnsPlayerStatLines.playerId,
                  roster.map((p) => p.id)
                )
              )
            )
        : []
      const byPlayer = new Map<string, { pts: number; reb: number; ast: number; stl: number; blk: number; tpm: number; games: number }>()
      for (const l of lines) {
        const t = byPlayer.get(l.playerId) ?? { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, games: 0 }
        t.pts += l.pts; t.reb += l.reb; t.ast += l.ast; t.stl += l.stl; t.blk += l.blk; t.tpm += l.tpm
        if (l.min > 0) t.games++
        byPlayer.set(l.playerId, t)
      }
      // The day view: which date of the week, clamped inside it.
      const today = easternToday()
      let date = String(req.query.date ?? today)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = today
      if (date < startDate) date = startDate
      if (date > endDate) date = endDate
      const resolve = await lineupResolver(db, leagueId, date)
      const daySlots: Record<string, string> = {}
      for (const p of roster) {
        daySlots[p.id] = resolve(p.teamId as string, p.id, date, p.slot)
      }
      const games = await dayGames(date)
      const dayLines: Record<string, { min: number; pts: number; reb: number; ast: number; stl: number; blk: number; fgm: number; fga: number }> = {}
      for (const l of lines) {
        if (l.date !== date) continue
        dayLines[l.playerId] = { min: l.min, pts: l.pts, reb: l.reb, ast: l.ast, stl: l.stl, blk: l.blk, fgm: l.fgm, fga: l.fga }
      }

      const side = (teamId: string) =>
        roster
          .filter((p) => p.teamId === teamId)
          .map((p) => ({
            id: p.id,
            name: p.name,
            position: p.position,
            teamCode: p.teamCode,
            injuryStatus: p.injuryStatus,
            week: byPlayer.get(p.id) ?? null,
          }))
          .sort((a, b) => (b.week?.pts ?? 0) - (a.week?.pts ?? 0))

      return res.status(200).json({
        matchup: {
          id: m.id,
          matchupWeek: m.matchupWeek,
          status: m.status,
          isPlayoff: m.isPlayoff,
          label: m.label,
          homeTeamId: m.homeTeamId,
          awayTeamId: m.awayTeamId,
          homeTeamName: teamName.get(m.homeTeamId) ?? '',
          awayTeamName: teamName.get(m.awayTeamId) ?? '',
          homeScore: Number(m.homeScore ?? 0),
          awayScore: Number(m.awayScore ?? 0),
          result: m.result,
          startDate,
          endDate,
        },
        home: side(m.homeTeamId),
        away: side(m.awayTeamId),
        day: {
          date,
          today,
          games: Object.fromEntries(games),
          slots: daySlots,
          lines: dayLines,
        },
      })
    }

    let week: number | null = req.query.week ? Number(req.query.week) : null
    if (week == null) {
      const today = easternToday()
      const current = weeks.find((w) => w.startDate <= today && today <= w.endDate)
      week =
        current?.matchupWeek ??
        (today > weeks[weeks.length - 1].endDate
          ? weeks[weeks.length - 1].matchupWeek
          : weeks[0].matchupWeek)
    }

    const matchups = await db
      .select()
      .from(mnsMatchups)
      .where(
        and(
          eq(mnsMatchups.leagueId, leagueId),
          eq(mnsMatchups.matchupWeek, week),
          eq(mnsMatchups.seasonYear, league.seasonYear)
        )
      )

    return res.status(200).json({
      week,
      firstWeek: Math.min(...weeks.map((w) => w.matchupWeek)),
      totalWeeks: Math.max(...weeks.map((w) => w.matchupWeek)),
      matchups: matchups.map((m) => ({
        id: m.id,
        status: m.status,
        isPlayoff: m.isPlayoff,
        label: m.label,
        homeTeamId: m.homeTeamId,
        awayTeamId: m.awayTeamId,
        homeTeamName: teamName.get(m.homeTeamId) ?? '',
        awayTeamName: teamName.get(m.awayTeamId) ?? '',
        homeScore: Number(m.homeScore ?? 0),
        awayScore: Number(m.awayScore ?? 0),
      })),
    })
  } catch (err) {
    logger.error('GET /api/leagues/[id]/matchups failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to load matchups' })
  }
}
