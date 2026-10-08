import type { VercelRequest, VercelResponse } from '@vercel/node'
import { eq, inArray } from 'drizzle-orm'
import { verifyAuth } from '../_middleware.js'
import { db } from '../_db.js'
import { mnsLeagues, mnsTeams, mnsTeamOwners } from '../../src/lib/db/schema.js'
import { createLeagueSchema, parseBody } from '../_validation.js'
import { logger } from '../_logger.js'
import { sport } from '../../src/lib/sport/index.js'
import { ensureLeaguePool } from '../../src/lib/players/pool.js'
import type { League } from '../../src/types/league.js'
import type { Sport } from '../../src/types/leagueConfig.js'
import type { LeaguePhase, ScoringMode } from '../../src/types/league.js'

function mapLeagueRow(row: typeof mnsLeagues.$inferSelect): League {
  return {
    id: row.id,
    name: row.name,
    seasonYear: row.seasonYear,
    sport: row.sport as Sport,
    gameSlug: row.gameSlug,
    config: row.config,
    leaguePhase: row.leaguePhase as LeaguePhase,
    keepersLocked: row.keepersLocked,
    commissionerId: row.commissionerId,
    scoringMode: row.scoringMode as ScoringMode,
    seasonStartedAt: row.seasonStartedAt?.toISOString() ?? null,
    seasonStartedBy: row.seasonStartedBy,
    telegramChatId: row.telegramChatId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function generateLeagueId(name: string, year: number): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 30) || 'league'
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${slug}-${year}-${suffix}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  if (req.method === 'GET') return handleGet(res, userId)
  if (req.method === 'POST') return handlePost(req, res, userId)
  return res.status(405).json({ error: 'Method not allowed' })
}

async function handleGet(res: VercelResponse, userId: string) {
  try {
    const commLeagues = await db
      .select()
      .from(mnsLeagues)
      .where(eq(mnsLeagues.commissionerId, userId))

    const ownerLeagueRefs = await db
      .selectDistinct({ leagueId: mnsTeams.leagueId })
      .from(mnsTeamOwners)
      .innerJoin(mnsTeams, eq(mnsTeams.id, mnsTeamOwners.teamId))
      .where(eq(mnsTeamOwners.userId, userId))

    const ownerLeagueIds = ownerLeagueRefs.map((r) => r.leagueId)
    const ownerLeagues = ownerLeagueIds.length
      ? await db.select().from(mnsLeagues).where(inArray(mnsLeagues.id, ownerLeagueIds))
      : []

    const seen = new Set<string>()
    const unique = [...commLeagues, ...ownerLeagues].filter((l) => {
      if (seen.has(l.id)) return false
      seen.add(l.id)
      return true
    })

    return res.status(200).json(unique.map(mapLeagueRow))
  } catch (err) {
    logger.error('GET /api/leagues failed', {
      userId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to load leagues' })
  }
}

async function handlePost(req: VercelRequest, res: VercelResponse, userId: string) {
  const parsed = parseBody(createLeagueSchema, req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error })

  const { name } = parsed.data
  const year = sport.preset.season.year
  const id = generateLeagueId(name, year)
  const gameSlug = sport.hub.gameSlug(year)

  try {
    const [row] = await db
      .insert(mnsLeagues)
      .values({
        id,
        name,
        seasonYear: year,
        sport: sport.key,
        gameSlug,
        config: sport.preset,
        leaguePhase: 'keeper_season',
        scoringMode: sport.preset.scoring.mode,
        commissionerId: userId,
      })
      .returning()
    // The league's pool is the sport's pool, from the first second.
    await ensureLeaguePool(db, row.id)
    return res.status(201).json(mapLeagueRow(row))
  } catch (err) {
    logger.error('POST /api/leagues failed', {
      userId,
      name,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to create league' })
  }
}
