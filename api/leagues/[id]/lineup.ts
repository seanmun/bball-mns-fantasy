import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq } from 'drizzle-orm'
import { verifyAuth } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsLeagues,
  mnsTeamOwners,
  mnsTeams,
  mnsPlayers,
  mnsSportStatLines,
} from '../../../src/lib/db/schema.js'
import { leagueStatLines } from '../../../src/lib/players/statLines.js'
import { effectiveSlots, isLockedDate } from '../../../src/lib/season/lineups.js'
import { easternToday } from '../../../src/lib/season/score.js'
import { dayGames } from '../../../src/lib/season/statSources.js'
import { logger } from '../../_logger.js'

// One team's day: the lineup as set for that date, who plays that day,
// and the box lines once they exist. This is what the My Team date
// carousel reads — past days come back locked, today and ahead come
// back editable (for the owner).
//
// GET /api/leagues/:id/lineup?date=YYYY-MM-DD&teamId=...
//   date defaults to Eastern today; teamId defaults to the caller's team.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  const today = easternToday()
  const date = String(req.query.date ?? today)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD.' })
  }

  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })

    const [mine] = await db
      .select({ teamId: mnsTeamOwners.teamId })
      .from(mnsTeamOwners)
      .innerJoin(mnsTeams, eq(mnsTeams.id, mnsTeamOwners.teamId))
      .where(and(eq(mnsTeams.leagueId, leagueId), eq(mnsTeamOwners.userId, userId)))
      .limit(1)

    const teamId = String(req.query.teamId ?? mine?.teamId ?? '')
    if (!teamId) return res.status(400).json({ error: "You don't own a team here — name one with ?teamId." })

    const slots = await effectiveSlots(db, leagueId, teamId, date)
    const games = await dayGames(date)
    const lineRows = await leagueStatLines(db).where(
      and(eq(mnsPlayers.leagueId, leagueId), eq(mnsSportStatLines.date, date))
    )
    const lines: Record<string, { min: number; pts: number; reb: number; ast: number; stl: number; blk: number; fgm: number; fga: number }> = {}
    for (const l of lineRows) {
      if (!slots.has(l.playerId)) continue
      lines[l.playerId] = {
        min: l.min, pts: l.pts, reb: l.reb, ast: l.ast, stl: l.stl, blk: l.blk, fgm: l.fgm, fga: l.fga,
      }
    }

    const locked = isLockedDate(date)
    return res.status(200).json({
      date,
      today,
      locked,
      editable: !locked && mine?.teamId === teamId && league.leaguePhase !== 'champion',
      slots: Object.fromEntries(slots),
      games: Object.fromEntries(games),
      lines,
    })
  } catch (err) {
    logger.error('GET /api/leagues/[id]/lineup failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to load the day.' })
  }
}
