import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, desc, eq } from 'drizzle-orm'
import { verifyAuth, canManageLeague } from '../../../_middleware.js'
import { db } from '../../../_db.js'
import {
  mnsPlayers,
  mnsTeams,
  mnsSportStatLines,
} from '../../../../src/lib/db/schema.js'
import { leagueStatLines } from '../../../../src/lib/players/statLines.js'
import { leaguePlayers } from '../../../../src/lib/players/leaguePlayers.js'
import { updatePlayerSchema, parseBody } from '../../../_validation.js'
import { logger } from '../../../_logger.js'
import { slotForLastYearRedshirt } from '../../../../src/rules/rookieSlots.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = req.query.id as string | undefined
  const playerId = req.query.playerId as string | undefined
  if (!leagueId || !playerId) {
    return res.status(400).json({ error: 'Missing league id or player id' })
  }

  // GET — the player card: details, injury news, recent game log.
  if (req.method === 'GET') {
    try {
      const [p] = await leaguePlayers(db)
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
        .limit(1)
      if (!p) return res.status(404).json({ error: 'Player not found' })
      let teamName: string | null = null
      if (p.teamId) {
        const [t] = await db
          .select({ name: mnsTeams.name })
          .from(mnsTeams)
          .where(eq(mnsTeams.id, p.teamId))
          .limit(1)
        teamName = t?.name ?? null
      }
      const log = await leagueStatLines(db)
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
        .orderBy(desc(mnsSportStatLines.date))
        .limit(12)
      return res.status(200).json({
        player: {
          id: p.id,
          name: p.name,
          position: p.position,
          teamCode: p.teamCode,
          salary: p.salary,
          slot: p.slot,
          isRookie: p.isRookie,
          yearsPro: p.yearsPro,
          leaguePresence: p.leaguePresence,
          presenceOverride: p.presenceOverride,
          redshirtUsed: p.redshirtUsed,
          teamId: p.teamId,
          teamName,
          injuryStatus: p.injuryStatus,
          injuryNote: p.injuryNote,
          injuryUpdatedAt: p.injuryUpdatedAt,
        },
        log: log.map((l) => ({
          date: l.date,
          min: l.min, pts: l.pts, reb: l.reb, ast: l.ast, stl: l.stl, blk: l.blk,
          tpm: l.tpm, fgm: l.fgm, fga: l.fga, tov: l.tov,
        })),
      })
    } catch (err) {
      logger.error('GET player card failed', {
        leagueId,
        playerId,
        err: err instanceof Error ? err.message : String(err),
      })
      return res.status(500).json({ error: 'Failed to load the player' })
    }
  }

  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!(await canManageLeague(userId, leagueId))) {
    return res
      .status(403)
      .json({ error: 'Only the commissioner can edit players' })
  }

  const parsed = parseBody(updatePlayerSchema, req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error })

  // If teamId is set, verify the team belongs to this league
  if (parsed.data.teamId) {
    const [team] = await db
      .select({ leagueId: mnsTeams.leagueId })
      .from(mnsTeams)
      .where(eq(mnsTeams.id, parsed.data.teamId))
      .limit(1)
    if (!team || team.leagueId !== leagueId) {
      return res.status(400).json({ error: 'Team does not belong to this league' })
    }
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() }
  if (parsed.data.teamId !== undefined) updates.teamId = parsed.data.teamId
  if (parsed.data.slot !== undefined) updates.slot = parsed.data.slot
  // The commissioner's correction to ESPN's presence heuristic: is she
  // really with a club, holding rights only, or abroad? This decides
  // redshirt vs international-stash eligibility, so it belongs to a
  // person, not a jersey lookup. null clears it back to the feed.
  if (req.body?.presenceOverride !== undefined) {
    const v = req.body.presenceOverride
    if (v !== null && !['rostered', 'rights_only', 'absent'].includes(String(v))) {
      return res
        .status(400)
        .json({ error: 'presenceOverride must be rostered, rights_only, absent, or null.' })
    }
    updates.presenceOverride = v === null ? null : String(v)
  }
  if (parsed.data.keeperPriorYearRound !== undefined)
    updates.keeperPriorYearRound = parsed.data.keeperPriorYearRound
  if (parsed.data.rookieDraftInfo !== undefined) {
    const s = parsed.data.rookieDraftInfo
    updates.rookieDraftInfo = s ? slotForLastYearRedshirt(s.round, s.pick) : null
  }
  if (parsed.data.migratedKeeperRound !== undefined)
    updates.migratedKeeperRound = parsed.data.migratedKeeperRound
  if (parsed.data.isRookie !== undefined) updates.isRookie = parsed.data.isRookie
  if (parsed.data.intEligible !== undefined) updates.intEligible = parsed.data.intEligible

  try {
    const result = await db
      .update(mnsPlayers)
      .set(updates)
      .where(and(eq(mnsPlayers.id, playerId), eq(mnsPlayers.leagueId, leagueId)))
      .returning({ id: mnsPlayers.id })
    if (result.length === 0) {
      return res.status(404).json({ error: 'Player not found in this league' })
    }
    return res.status(200).json({ success: true })
  } catch (err) {
    logger.error('PATCH /api/leagues/[id]/players/[playerId] failed', {
      leagueId,
      playerId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to update player' })
  }
}
