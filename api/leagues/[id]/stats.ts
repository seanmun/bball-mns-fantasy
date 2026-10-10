import type { VercelRequest, VercelResponse } from '@vercel/node'
import { verifyAuth } from '../../_middleware.js'
import { db } from '../../_db.js'
import { eq } from 'drizzle-orm'
import {
  mnsLeagues,
  mnsPlayers,
  mnsSportPlayers,
} from '../../../src/lib/db/schema.js'
import { averagesForRanges } from '../../../src/lib/season/stats.js'
import { logger } from '../../_logger.js'

// GET /api/leagues/:id/stats — per-player averages for every research
// window at once (season, last 30 days, last 10 days, last season), so
// the client flips ranges instantly. lastSeason comes from the sport's
// per-season averages when no prior-year lines exist, and is null only
// when those are missing too.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  try {
    const [league] = await db
      .select({ seasonYear: mnsLeagues.seasonYear })
      .from(mnsLeagues)
      .where(eq(mnsLeagues.id, leagueId))
      .limit(1)
    const ranges = await averagesForRanges(db, leagueId, new Date(), league?.seasonYear)
    // CAT$ — Cat Score per $1M of salary, the value-density number.
    const salaries = await db
      .select({ id: mnsPlayers.id, salary: mnsSportPlayers.salary })
      .from(mnsPlayers).innerJoin(mnsSportPlayers, eq(mnsSportPlayers.id, mnsPlayers.sportPlayerId))
      .where(eq(mnsPlayers.leagueId, leagueId))
    const salaryOf = new Map(salaries.map((p) => [p.id, p.salary ?? 0]))
    for (const key of ['season', 'last30', 'last10', 'lastSeason'] as const) {
      for (const [id, avg] of Object.entries(ranges[key])) {
        const sal = salaryOf.get(id) ?? 0
        avg.catD =
          avg.cat != null && sal > 0 ? Math.round((avg.cat / (sal / 1_000_000)) * 100) / 100 : null
      }
    }
    return res.status(200).json({
      season: ranges.season,
      last30: ranges.last30,
      last10: ranges.last10,
      lastSeason: Object.keys(ranges.lastSeason).length > 0 ? ranges.lastSeason : null,
    })
  } catch (err) {
    logger.error('GET /api/leagues/[id]/stats failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to load stats' })
  }
}
