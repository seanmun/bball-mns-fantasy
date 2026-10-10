import type { VercelRequest, VercelResponse } from '@vercel/node'
import { eq, and, inArray, sql } from 'drizzle-orm'
import { verifyAuth, canManageLeague } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsFuturePicks,
  mnsLeagues,
  mnsPlayers,
  mnsRookieDraftPicks,
  mnsTeamOwners,
  mnsTeams,
} from '../../../src/lib/db/schema.js'
import { leaguePlayers } from '../../../src/lib/players/leaguePlayers.js'
import { computeStandings } from '../../../src/lib/season/score.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'
import { setRookiePicksSchema, parseBody } from '../../_validation.js'
import { logger } from '../../_logger.js'
import type { RookieDraftPickRow } from '../../../src/types/draft.js'
import { slotForBoardPick } from '../../../src/rules/rookieSlots.js'

function mapPickRow(
  row: typeof mnsRookieDraftPicks.$inferSelect
): RookieDraftPickRow {
  return {
    id: row.id,
    leagueId: row.leagueId,
    seasonYear: row.seasonYear,
    round: row.round,
    pickInRound: row.pickInRound,
    overallPick: row.overallPick,
    teamId: row.teamId,
    originalTeamId: row.originalTeamId ?? null,
    playerId: row.playerId,
    playerName: row.playerName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = req.query.id as string | undefined
  if (!leagueId) return res.status(400).json({ error: 'Missing league id' })

  if (req.method === 'GET') return handleGet(res, leagueId)

  if (req.method === 'POST') return handlePost(req, res, leagueId, userId)

  if (req.method === 'PUT') {
    if (!(await canManageLeague(userId, leagueId))) {
      return res
        .status(403)
        .json({ error: 'Only the commissioner can set rookie picks' })
    }
    return handlePut(req, res, leagueId)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

async function handleGet(res: VercelResponse, leagueId: string) {
  try {
    const rows = await db
      .select()
      .from(mnsRookieDraftPicks)
      .where(eq(mnsRookieDraftPicks.leagueId, leagueId))
      .orderBy(mnsRookieDraftPicks.seasonYear, mnsRookieDraftPicks.overallPick)
    return res.status(200).json(rows.map(mapPickRow))
  } catch (err) {
    logger.error('GET /api/leagues/[id]/rookie-picks failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to load rookie picks' })
  }
}

// POST { action: 'generate' } — commissioner: build this season's
// board from REVERSE standings of the season just played, rounds from
// config, each slot owned by whoever holds the traded pick.
// POST { action: 'pick', pickId, playerId } — the owner on the clock
// (or the commissioner) drafts a player; the last pick advances the
// league to keepers (or straight to the draft).
// POST { action: 'record', pickId, playerId } — commissioner: write down
// a pick of a draft that already happened, any order, until the season
// starts. POST { action: 'clear', pickId } empties one.
// POST { action: 'assign', pickId, teamId } — commissioner: a traded pick
// changes hands; a player recorded on it moves with it.
async function handlePost(
  req: VercelRequest,
  res: VercelResponse,
  leagueId: string,
  userId: string
) {
  const action = String(req.body?.action ?? '')
  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })
    const config = league.config as LeagueConfig

    if (action === 'generate') {
      if (!(await canManageLeague(userId, leagueId))) {
        return res.status(403).json({ error: 'Only the commissioner can generate the board.' })
      }
      const existing = await db
        .select({ playerId: mnsRookieDraftPicks.playerId })
        .from(mnsRookieDraftPicks)
        .where(
          and(
            eq(mnsRookieDraftPicks.leagueId, leagueId),
            eq(mnsRookieDraftPicks.seasonYear, league.seasonYear)
          )
        )
      if (existing.some((p) => p.playerId !== null)) {
        return res.status(409).json({ error: 'Picks are already being made — the board is set.' })
      }

      // Worst record picks first, from the season just completed.
      const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
      const rec = await computeStandings(db, leagueId, league.seasonYear - 1)
      const order = teams
        .map((t) => ({ id: t.id, ...(rec.get(t.id) ?? { wins: 0, losses: 0, ties: 0, pointsFor: 0 }) }))
        .sort((a, b) => a.wins - b.wins || a.pointsFor - b.pointsFor)
        .map((t) => t.id)

      // Traded picks: the slot stays in its original position, the
      // OWNER changes.
      const overrides = await db
        .select()
        .from(mnsFuturePicks)
        .where(
          and(eq(mnsFuturePicks.leagueId, leagueId), eq(mnsFuturePicks.seasonYear, league.seasonYear))
        )
      const ownerOf = new Map(overrides.map((r) => [`${r.round}:${r.originalTeamId}`, r.currentTeamId]))

      const rounds = config.draft?.rookieRounds ?? 2
      const now = new Date()
      const suffix = Math.random().toString(36).slice(2, 8)
      const inserts = []
      for (let round = 1; round <= rounds; round++) {
        for (let i = 0; i < order.length; i++) {
          const original = order[i]
          inserts.push({
            id: `rk-${league.seasonYear}-${round}-${i + 1}-${suffix}`,
            leagueId,
            seasonYear: league.seasonYear,
            round,
            pickInRound: i + 1,
            overallPick: (round - 1) * order.length + i + 1,
            teamId: ownerOf.get(`${round}:${original}`) ?? original,
            originalTeamId: original,
            playerId: null,
            playerName: null,
            createdAt: now,
            updatedAt: now,
          })
        }
      }
      await db
        .delete(mnsRookieDraftPicks)
        .where(
          and(
            eq(mnsRookieDraftPicks.leagueId, leagueId),
            eq(mnsRookieDraftPicks.seasonYear, league.seasonYear)
          )
        )
      const rows = await db.insert(mnsRookieDraftPicks).values(inserts).returning()
      return res.status(200).json(rows.sort((a, b) => a.overallPick - b.overallPick).map(mapPickRow))
    }

    if (action === 'pick' || action === 'record') {
      const pickId = String(req.body?.pickId ?? '')
      const playerId = String(req.body?.playerId ?? '')
      const [pick] = await db
        .select()
        .from(mnsRookieDraftPicks)
        .where(and(eq(mnsRookieDraftPicks.leagueId, leagueId), eq(mnsRookieDraftPicks.id, pickId)))
        .limit(1)
      if (!pick) return res.status(404).json({ error: 'Pick not found.' })
      const isCommish = await canManageLeague(userId, leagueId)

      if (action === 'pick') {
        // Live: the pick ON THE CLOCK, during the rookie draft, by its
        // owner (or the commissioner).
        if (league.leaguePhase !== 'rookie_draft') {
          return res.status(400).json({ error: 'The rookie draft is not running.' })
        }
        if (pick.playerId) return res.status(409).json({ error: 'That pick is already made.' })
        const [onClock] = await db
          .select()
          .from(mnsRookieDraftPicks)
          .where(
            and(
              eq(mnsRookieDraftPicks.leagueId, leagueId),
              eq(mnsRookieDraftPicks.seasonYear, league.seasonYear),
              sql`${mnsRookieDraftPicks.playerId} is null`
            )
          )
          .orderBy(mnsRookieDraftPicks.overallPick)
          .limit(1)
        if (!onClock || onClock.id !== pick.id) {
          return res.status(409).json({ error: 'That pick is not on the clock yet.' })
        }
        if (!isCommish) {
          const owners = await db
            .select()
            .from(mnsTeamOwners)
            .where(eq(mnsTeamOwners.teamId, pick.teamId))
          if (!owners.some((o) => o.userId === userId)) {
            return res.status(403).json({ error: "This pick isn't yours to make." })
          }
        }
      } else {
        // Record: the commissioner writes down a draft that already
        // happened — any pick, any order, re-doable — until the season
        // starts. The board is the authority on where a rookie belongs.
        if (!isCommish) {
          return res.status(403).json({ error: 'Only the commissioner can record picks.' })
        }
        if (league.seasonStartedAt) {
          return res.status(400).json({ error: 'The season has started — the rookie draft is history now.' })
        }
      }

      const [picked] = await leaguePlayers(db)
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
        .limit(1)
      if (!picked) return res.status(404).json({ error: 'That player is not in this league.' })

      // Every pick, live or recorded, stamps the slot on the player: that
      // is what prices a rookie by the rookie table instead of minus-one,
      // and what puts redshirt on the table for her.
      const stamp = {
        teamId: pick.teamId,
        slot: 'active' as const,
        rookieDraftInfo: slotForBoardPick(pick, pick.seasonYear),
        isRookie: true,
        updatedAt: new Date(),
      }
      if (action === 'pick') {
        // First-tap-wins on the player, same guard as the waiver wire.
        const took = await db
          .update(mnsPlayers)
          .set(stamp)
          .where(
            and(
              eq(mnsPlayers.leagueId, leagueId),
              eq(mnsPlayers.id, playerId),
              sql`${mnsPlayers.teamId} is null`
            )
          )
          .returning({ id: mnsPlayers.id })
        if (took.length === 0) {
          return res.status(409).json({ error: 'That player is gone — pick another.' })
        }
      } else {
        // A different player recorded here before keeps his team, loses
        // the slot. The same player recorded elsewhere leaves that pick.
        if (pick.playerId && pick.playerId !== playerId) {
          await db
            .update(mnsPlayers)
            .set({ rookieDraftInfo: null, updatedAt: new Date() })
            .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, pick.playerId)))
        }
        await db
          .update(mnsRookieDraftPicks)
          .set({ playerId: null, playerName: null, updatedAt: new Date() })
          .where(
            and(
              eq(mnsRookieDraftPicks.leagueId, leagueId),
              eq(mnsRookieDraftPicks.seasonYear, pick.seasonYear),
              eq(mnsRookieDraftPicks.playerId, playerId),
              sql`${mnsRookieDraftPicks.id} <> ${pick.id}`
            )
          )
        await db
          .update(mnsPlayers)
          .set(stamp)
          .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
      }
      await db
        .update(mnsRookieDraftPicks)
        .set({ playerId, playerName: picked.name, updatedAt: new Date() })
        .where(eq(mnsRookieDraftPicks.id, pick.id))

      // Recording moved him off another team? Say so by name.
      let movedFrom: string | null = null
      if (picked.teamId && picked.teamId !== pick.teamId) {
        const [from] = await db
          .select({ name: mnsTeams.name })
          .from(mnsTeams)
          .where(eq(mnsTeams.id, picked.teamId))
          .limit(1)
        movedFrom = from?.name ?? null
      }

      // Last pick made during a live rookie draft → the year rolls
      // forward. A recorded board never moves the phase on its own.
      let nextPhase: 'keeper_season' | 'draft' | null = null
      if (league.leaguePhase === 'rookie_draft') {
        const [remaining] = await db
          .select({ n: sql<number>`count(*)` })
          .from(mnsRookieDraftPicks)
          .where(
            and(
              eq(mnsRookieDraftPicks.leagueId, leagueId),
              eq(mnsRookieDraftPicks.seasonYear, league.seasonYear),
              sql`${mnsRookieDraftPicks.playerId} is null`
            )
          )
        if (Number(remaining?.n ?? 0) === 0) {
          nextPhase = (config.roster?.maxKeepers ?? 0) > 0 ? 'keeper_season' : 'draft'
          await db
            .update(mnsLeagues)
            .set({ leaguePhase: nextPhase, updatedAt: new Date() })
            .where(eq(mnsLeagues.id, leagueId))
        }
      }
      return res.status(200).json({
        ok: true,
        picked: picked.name,
        slot: `${pick.round}.${pick.pickInRound}`,
        movedFrom,
        nextPhase,
      })
    }

    // POST { action: 'assign', pickId, teamId } — commissioner: a traded
    // pick changes hands. The slot keeps its place and its original
    // owner; whoever holds it picks, and a player already recorded on it
    // moves with it.
    if (action === 'assign') {
      if (!(await canManageLeague(userId, leagueId))) {
        return res.status(403).json({ error: 'Only the commissioner can move picks.' })
      }
      if (league.seasonStartedAt) {
        return res.status(400).json({ error: 'The season has started — the rookie draft is history now.' })
      }
      const pickId = String(req.body?.pickId ?? '')
      const teamId = String(req.body?.teamId ?? '')
      const [pick] = await db
        .select()
        .from(mnsRookieDraftPicks)
        .where(and(eq(mnsRookieDraftPicks.leagueId, leagueId), eq(mnsRookieDraftPicks.id, pickId)))
        .limit(1)
      if (!pick) return res.status(404).json({ error: 'Pick not found.' })
      const [team] = await db
        .select({ id: mnsTeams.id, name: mnsTeams.name })
        .from(mnsTeams)
        .where(and(eq(mnsTeams.leagueId, leagueId), eq(mnsTeams.id, teamId)))
        .limit(1)
      if (!team) return res.status(400).json({ error: 'That team is not in this league.' })
      await db
        .update(mnsRookieDraftPicks)
        .set({ teamId: team.id, updatedAt: new Date() })
        .where(eq(mnsRookieDraftPicks.id, pick.id))
      if (pick.playerId) {
        await db
          .update(mnsPlayers)
          .set({ teamId: team.id, updatedAt: new Date() })
          .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, pick.playerId)))
      }
      return res.status(200).json({ ok: true, team: team.name, moved: pick.playerName })
    }

    // POST { action: 'clear', pickId } — commissioner: the pick empties
    // and the player loses the slot; he stays on his team.
    if (action === 'clear') {
      if (!(await canManageLeague(userId, leagueId))) {
        return res.status(403).json({ error: 'Only the commissioner can clear picks.' })
      }
      if (league.seasonStartedAt) {
        return res.status(400).json({ error: 'The season has started — the rookie draft is history now.' })
      }
      const pickId = String(req.body?.pickId ?? '')
      const [pick] = await db
        .select()
        .from(mnsRookieDraftPicks)
        .where(and(eq(mnsRookieDraftPicks.leagueId, leagueId), eq(mnsRookieDraftPicks.id, pickId)))
        .limit(1)
      if (!pick) return res.status(404).json({ error: 'Pick not found.' })
      if (pick.playerId) {
        await db
          .update(mnsPlayers)
          .set({ rookieDraftInfo: null, updatedAt: new Date() })
          .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, pick.playerId)))
      }
      await db
        .update(mnsRookieDraftPicks)
        .set({ playerId: null, playerName: null, updatedAt: new Date() })
        .where(eq(mnsRookieDraftPicks.id, pick.id))
      return res.status(200).json({ ok: true })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    logger.error('POST /api/leagues/[id]/rookie-picks failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Rookie draft hit an error. Try again.' })
  }
}

async function handlePut(
  req: VercelRequest,
  res: VercelResponse,
  leagueId: string
) {
  const parsed = parseBody(setRookiePicksSchema, req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error })

  const { seasonYear, rounds, teamOrder } = parsed.data
  const orders = parsed.data.teamOrders ?? Array.from({ length: rounds }, () => teamOrder)

  try {
    const leagueTeams = await db
      .select({ id: mnsTeams.id })
      .from(mnsTeams)
      .where(
        and(eq(mnsTeams.leagueId, leagueId), inArray(mnsTeams.id, teamOrder))
      )
    if (leagueTeams.length !== teamOrder.length) {
      const known = new Set(leagueTeams.map((t) => t.id))
      const bad = teamOrder.filter((id) => !known.has(id))
      return res
        .status(400)
        .json({ error: `Teams not in this league: ${bad.join(', ')}` })
    }

    const existing = await db
      .select({ id: mnsRookieDraftPicks.id, playerId: mnsRookieDraftPicks.playerId })
      .from(mnsRookieDraftPicks)
      .where(
        and(
          eq(mnsRookieDraftPicks.leagueId, leagueId),
          eq(mnsRookieDraftPicks.seasonYear, seasonYear)
        )
      )
    if (existing.some((p) => p.playerId !== null)) {
      return res.status(409).json({
        error:
          'Rookie picks for this season already have players selected — the board cannot be regenerated.',
      })
    }

    const now = new Date()
    const suffix = Math.random().toString(36).slice(2, 8)
    const inserts = []
    for (let round = 1; round <= rounds; round++) {
      const order = orders[round - 1]
      for (let i = 0; i < order.length; i++) {
        const pickInRound = i + 1
        inserts.push({
          id: `rk-${seasonYear}-${round}-${pickInRound}-${suffix}`,
          leagueId,
          seasonYear,
          round,
          pickInRound,
          overallPick: (round - 1) * order.length + pickInRound,
          teamId: order[i],
          originalTeamId: order[i],
          playerId: null,
          playerName: null,
          createdAt: now,
          updatedAt: now,
        })
      }
    }

    if (existing.length > 0) {
      await db
        .delete(mnsRookieDraftPicks)
        .where(
          and(
            eq(mnsRookieDraftPicks.leagueId, leagueId),
            eq(mnsRookieDraftPicks.seasonYear, seasonYear)
          )
        )
    }
    const rows = await db.insert(mnsRookieDraftPicks).values(inserts).returning()
    rows.sort((a, b) => a.overallPick - b.overallPick)
    return res.status(200).json(rows.map(mapPickRow))
  } catch (err) {
    logger.error('PUT /api/leagues/[id]/rookie-picks failed', {
      leagueId,
      seasonYear,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to set rookie picks' })
  }
}
