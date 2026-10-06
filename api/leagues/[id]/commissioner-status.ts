import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, desc, eq, gte } from 'drizzle-orm'
import { verifyAuth, canManageLeague } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsLeagueMessages,
  mnsLeagueWeeks,
  mnsLeagues,
  mnsPlayers,
  mnsTeamFees,
  mnsTeams,
  mnsTradeProposals,
  mnsWaiverClaims,
} from '../../../src/lib/db/schema.js'
import { rosterSpots } from '../../../src/lib/season/roster.js'
import { easternToday } from '../../../src/lib/season/score.js'
import { logger } from '../../_logger.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'

// What needs the commissioner RIGHT NOW, in one read: trades waiting
// on an answer, rosters over the limit, dues on the books, the next
// folded week, claims in the queue, the last thing they told the
// league. The hub leads with this in season.
//
// GET /api/leagues/:id/commissioner-status
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const leagueId = String(req.query.id ?? '')
  if (!(await canManageLeague(userId, leagueId))) {
    return res.status(403).json({ error: 'Only the commissioner can see this.' })
  }

  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })
    const config = league.config as LeagueConfig
    const today = easternToday()

    const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
    const teamName = new Map(teams.map((t) => [t.id, t.name]))

    const pending = await db
      .select({ id: mnsTradeProposals.id, createdAt: mnsTradeProposals.createdAt, by: mnsTradeProposals.proposedByTeamId })
      .from(mnsTradeProposals)
      .where(and(eq(mnsTradeProposals.leagueId, leagueId), eq(mnsTradeProposals.status, 'pending')))
      .orderBy(mnsTradeProposals.createdAt)

    const players = await db
      .select({ teamId: mnsPlayers.teamId, slot: mnsPlayers.slot })
      .from(mnsPlayers)
      .where(eq(mnsPlayers.leagueId, leagueId))
    const activeSize = config.roster?.activeSize ?? 10
    const overLimit = teams
      .map((t) => ({ teamId: t.id, name: t.name, spots: rosterSpots(players, t.id).length }))
      .filter((t) => t.spots > activeSize)

    const ledger = await db
      .select({ teamId: mnsTeamFees.teamId, total: mnsTeamFees.totalFees })
      .from(mnsTeamFees)
      .where(and(eq(mnsTeamFees.leagueId, leagueId), eq(mnsTeamFees.seasonYear, league.seasonYear)))
    const buyIn = config.fees?.buyIn ?? 0
    const dues = teams
      .map((t) => ({
        teamId: t.id,
        name: t.name,
        amount: buyIn + Number(ledger.find((l) => l.teamId === t.id)?.total ?? 0),
      }))
      .sort((a, b) => b.amount - a.amount)

    const claims = await db
      .select({ id: mnsWaiverClaims.id })
      .from(mnsWaiverClaims)
      .where(and(eq(mnsWaiverClaims.leagueId, leagueId), eq(mnsWaiverClaims.status, 'pending')))

    // The next week that is folded (a combined matchup week) from
    // today on, by the weeks the schedule actually wrote.
    const weeks = await db
      .select()
      .from(mnsLeagueWeeks)
      .where(
        and(
          eq(mnsLeagueWeeks.leagueId, leagueId),
          eq(mnsLeagueWeeks.seasonYear, league.seasonYear),
          gte(mnsLeagueWeeks.endDate, today)
        )
      )
      .orderBy(mnsLeagueWeeks.startDate)
    const byMatchup = new Map<number, typeof weeks>()
    for (const w of weeks) byMatchup.set(w.matchupWeek, [...(byMatchup.get(w.matchupWeek) ?? []), w])
    const nextFold = [...byMatchup.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([matchupWeek, rows]) => ({
        matchupWeek,
        label: rows[0].label,
        startDate: rows.reduce((a, r) => (r.startDate < a ? r.startDate : a), rows[0].startDate),
        endDate: rows.reduce((a, r) => (r.endDate > a ? r.endDate : a), rows[0].endDate),
      }))
      .sort((a, b) => a.startDate.localeCompare(b.startDate))[0] ?? null
    const current = weeks.find((w) => w.startDate <= today && today <= w.endDate) ?? null

    const [last] = await db
      .select({ subject: mnsLeagueMessages.subject, createdAt: mnsLeagueMessages.createdAt, sent: mnsLeagueMessages.sent })
      .from(mnsLeagueMessages)
      .where(eq(mnsLeagueMessages.leagueId, leagueId))
      .orderBy(desc(mnsLeagueMessages.createdAt))
      .limit(1)

    return res.status(200).json({
      phase: league.leaguePhase,
      today,
      currentWeek: current ? { matchupWeek: current.matchupWeek, label: current.label, endDate: current.endDate } : null,
      pendingTrades: pending.map((p) => ({
        id: p.id,
        by: teamName.get(p.by) ?? p.by,
        days: Math.floor((Date.now() - new Date(p.createdAt).getTime()) / 86400000),
      })),
      overLimit: overLimit.map((t) => ({ name: t.name, spots: t.spots, limit: activeSize })),
      dues,
      pendingClaims: claims.length,
      nextFold,
      lastMessage: last ? { subject: last.subject, at: last.createdAt, sent: last.sent } : null,
    })
  } catch (err) {
    logger.error('GET /api/leagues/[id]/commissioner-status failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to load the commissioner view' })
  }
}
