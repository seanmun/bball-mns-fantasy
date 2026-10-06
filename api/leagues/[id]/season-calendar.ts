import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq, gte, lte } from 'drizzle-orm'
import { verifyAuth } from '../../_middleware.js'
import { db } from '../../_db.js'
import { mnsLeagues, mnsSportGameDays } from '../../../src/lib/db/schema.js'
import { summarizeWeeks, suggestCombinedWeeks } from '../../../src/rules/scheduleRules.js'
import { logger } from '../../_logger.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'

// The sport's real schedule, summed into THIS league's weeks: games
// and games per club for every week of the regular season and the
// playoffs, which weeks run light, and what to fold into what. Read by
// league settings so a commissioner sees the Cup final week or a FIBA
// break before the schedule exists.
//
// GET /api/leagues/:id/season-calendar?startDate=YYYY-MM-DD&weeks=N&playoffWeeks=N
//   query values override the saved config so unsaved edits preview.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })
    const config = league.config as LeagueConfig
    const startDate = String(req.query.startDate ?? config.season.startDate ?? '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      return res.status(400).json({ error: 'Set a season start date first.' })
    }
    const regular = Math.max(1, Number(req.query.weeks ?? config.season.weeks ?? 1))
    const playoffs = Math.max(0, Number(req.query.playoffWeeks ?? config.schedule?.playoffWeeks ?? 0))
    const total = regular + playoffs
    const endDate = new Date(new Date(`${startDate}T12:00:00Z`).getTime() + (total * 7 - 1) * 86400000)
      .toISOString()
      .slice(0, 10)

    const days = await db
      .select({ date: mnsSportGameDays.date, games: mnsSportGameDays.games, teams: mnsSportGameDays.teams })
      .from(mnsSportGameDays)
      .where(and(gte(mnsSportGameDays.date, startDate), lte(mnsSportGameDays.date, endDate)))
    const weeks = summarizeWeeks(days, startDate, total).map((w) => ({
      ...w,
      playoff: w.week > regular,
    }))
    const suggestions = suggestCombinedWeeks(weeks, regular)
    const coveredThrough = days.length ? days.map((d) => d.date).sort().at(-1)! : null
    return res.status(200).json({
      startDate,
      regularWeeks: regular,
      playoffWeeks: playoffs,
      // How far the sport's calendar pull reaches so far; weeks past it
      // read as empty until the next pass fills them.
      coveredThrough,
      weeks,
      suggestions,
      combinedWeeks: config.schedule?.combinedWeeks ?? [],
    })
  } catch (err) {
    logger.error('GET /api/leagues/[id]/season-calendar failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to load the season calendar' })
  }
}
