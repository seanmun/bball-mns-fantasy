import type { VercelRequest, VercelResponse } from '@vercel/node'
import { eq, sql } from 'drizzle-orm'
import { verifyAuth, canManageLeague } from '../../../_middleware.js'
import { db } from '../../../_db.js'
import { mnsLeagues, mnsLeagueImports, mnsPlayers, mnsSportPlayers } from '../../../../src/lib/db/schema.js'
import { logger } from '../../../_logger.js'
import { sport } from '../../../../src/lib/sport/index.js'

// Give a league its player pool: one league row per sport player, no
// network call. The sport tables are the truth (filled once per sport
// by the tick); this only links. Idempotent — running it again adds
// whoever is new to the sport and touches nobody already in the league,
// so a mid-season re-run never resets a roster.
//
// POST /api/leagues/:id/players/populate-pool
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = req.query.id as string | undefined
  if (!leagueId) return res.status(400).json({ error: 'Missing league id' })
  if (!(await canManageLeague(userId, leagueId))) {
    return res.status(403).json({ error: 'Only the commissioner can populate the player pool' })
  }

  const [league] = await db
    .select({ seasonYear: mnsLeagues.seasonYear, sport: mnsLeagues.sport })
    .from(mnsLeagues)
    .where(eq(mnsLeagues.id, leagueId))
    .limit(1)
  if (!league) return res.status(404).json({ error: 'League not found' })
  if (league.sport !== sport.key) {
    return res.status(400).json({ error: `This deployment populates ${sport.leagueLabel} pools only.` })
  }

  try {
    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(mnsSportPlayers)
    if (Number(total) === 0) {
      // The tick fills the sport table within twenty minutes of a deploy;
      // say so instead of creating an empty pool.
      return res.status(409).json({
        error: `The ${sport.leagueLabel} player pool has not been pulled yet — try again in a few minutes.`,
      })
    }

    // One statement: every sport player not yet in this league gets a
    // league row carrying nothing but the link and league state.
    const inserted = await db.execute(sql`
      insert into ${mnsPlayers} (id, league_id, sport_player_id, sport, slot)
      select ${leagueId} || ':' || sp.id, ${leagueId}, sp.id, ${sport.key}, 'active'
      from ${mnsSportPlayers} sp
      where not exists (
        select 1 from ${mnsPlayers} p where p.league_id = ${leagueId} and p.sport_player_id = sp.id
      )
    `)
    const added = Number((inserted as { rowCount?: number }).rowCount ?? 0)

    await db.insert(mnsLeagueImports).values({
      leagueId,
      importer: `${sport.key}_player_pool`,
      ranBy: userId,
      resultSummary: { sportPlayers: Number(total), added },
    })

    return res.status(200).json({ success: true, sportPlayers: Number(total), inserted: added, updated: 0 })
  } catch (err) {
    logger.error('populate-pool failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({
      error: 'Player pool population failed',
      detail: err instanceof Error ? err.message : String(err),
    })
  }
}
