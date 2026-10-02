import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq, sql } from 'drizzle-orm'
import { verifyAuth, canManageLeague } from '../../../_middleware.js'
import { db } from '../../../_db.js'
import {
  mnsLeagues,
  mnsPlayers,
  mnsLeagueImports,
} from '../../../../src/lib/db/schema.js'
import { logger } from '../../../_logger.js'
import { resolveIdentity } from '../../../../src/lib/players/identity.js'
import { sport } from '../../../../src/lib/sport/index.js'
import { scrapeWnbaPlayers } from '../../../../src/lib/scrapers/wnba.js'
import type { ExternalIds } from '../../../../src/types/player.js'

function generatePlayerId(slug: string): string {
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${sport.key}-${slug}-${suffix}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = req.query.id as string | undefined
  if (!leagueId) return res.status(400).json({ error: 'Missing league id' })

  if (!(await canManageLeague(userId, leagueId))) {
    return res.status(403).json({ error: 'Only the commissioner can populate the player pool' })
  }

  // Pull league season + sport
  const [league] = await db
    .select({
      seasonYear: mnsLeagues.seasonYear,
      sport: mnsLeagues.sport,
    })
    .from(mnsLeagues)
    .where(eq(mnsLeagues.id, leagueId))
    .limit(1)
  if (!league) return res.status(404).json({ error: 'League not found' })
  if (league.sport !== sport.key) {
    return res.status(400).json({ error: `This deployment populates ${sport.leagueLabel} pools only.` })
  }

  try {
    const scrape = await scrapeWnbaPlayers(league.seasonYear)

    // Upsert by external_ids.hhs (the HHS slug). For each scraped player:
    //   - If a row exists in this league with that slug → UPDATE salary,
    //     team_code, position, stats fields, leave id stable.
    //   - Else → INSERT new row with a fresh id.
    let inserted = 0
    let updated = 0
    for (const p of scrape.players) {
      if (!p.slug) continue

      // Find existing by leagueId + external_ids.hhs slug
      const existing = await db
        .select({ id: mnsPlayers.id })
        .from(mnsPlayers)
        .where(
          and(
            eq(mnsPlayers.leagueId, leagueId),
            sql`${mnsPlayers.externalIds}->>'hhs' = ${p.slug}`
          )
        )
        .limit(1)

      const externalIds: ExternalIds = { hhs: p.slug }
      // Identity first: the person exists independently of this league,
      // and the crosswalk is what keeps later source joins exact.
      const resolved = await resolveIdentity(db, league.sport, {
        source: 'hhs',
        sourceId: p.slug,
        name: p.name,
      })

      if (existing.length > 0) {
        await db
          .update(mnsPlayers)
          .set({
            name: p.name,
            position: p.position || 'F',
            salary: p.salary,
            teamCode: p.team,
            externalIds,
            ...(resolved ? { identityId: resolved.identityId } : {}),
            updatedAt: new Date(),
          })
          .where(eq(mnsPlayers.id, existing[0].id))
        updated++
      } else {
        await db.insert(mnsPlayers).values({
          id: generatePlayerId(p.slug),
          externalIds,
          ...(resolved ? { identityId: resolved.identityId } : {}),
          name: p.name,
          position: p.position || 'F',
          salary: p.salary,
          teamCode: p.team,
          leagueId,
          teamId: null,
          sport: sport.key,
          slot: 'active',
        })
        inserted++
      }
    }

    // Audit log
    await db.insert(mnsLeagueImports).values({
      leagueId,
      importer: `${sport.key}_player_pool`,
      ranBy: userId,
      resultSummary: {
        totalScraped: scrape.totalCount,
        inserted,
        updated,
        sourceStatus: scrape.sourceStatus,
      },
    })

    return res.status(200).json({
      success: true,
      totalScraped: scrape.totalCount,
      inserted,
      updated,
      sourceStatus: scrape.sourceStatus,
    })
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
