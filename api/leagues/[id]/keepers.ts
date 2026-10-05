import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { verifyAuth, canManageLeague } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsLeagues,
  mnsPlayers,
  mnsTeamOwners,
  mnsTeams,
} from '../../../src/lib/db/schema.js'
import { leaguePlayers } from '../../../src/lib/players/leaguePlayers.js'
import { logger } from '../../_logger.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'

// Keeper season: each owner names who survives the turn of the year.
// Kept players stay rostered (their salary rides into the new cap);
// everyone else goes back in the pool when the commissioner locks and
// the draft phase opens. Declarations are editable all phase long —
// saving REPLACES your set.
//
// GET  /api/leagues/:id/keepers — my roster with flags, limits, cap
//      math, and (commissioner) every team's declared count
// POST { playerIds: string[] } — declare my keepers (replaces)
// POST { action: 'lock' } — commissioner: release non-keepers, open draft
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })
    const config = league.config as LeagueConfig
    const maxKeepers = config.roster?.maxKeepers ?? 0

    const [mine] = await db
      .select({ teamId: mnsTeamOwners.teamId })
      .from(mnsTeamOwners)
      .innerJoin(mnsTeams, eq(mnsTeams.id, mnsTeamOwners.teamId))
      .where(and(eq(mnsTeams.leagueId, leagueId), eq(mnsTeamOwners.userId, userId)))
      .limit(1)

    if (req.method === 'GET') {
      const players = await leaguePlayers(db)
        .where(and(eq(mnsPlayers.leagueId, leagueId), sql`${mnsPlayers.teamId} is not null`))
      const myRoster = players
        .filter((p) => mine && p.teamId === mine.teamId)
        .map((p) => ({
          id: p.id,
          name: p.name,
          position: p.position,
          teamCode: p.teamCode,
          salary: p.salary,
          slot: p.slot,
          isKeeper: p.isKeeper,
          injuryStatus: p.injuryStatus,
        }))
        .sort((a, b) => (b.salary ?? 0) - (a.salary ?? 0))

      const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
      const declared = teams.map((t) => ({
        teamId: t.id,
        teamName: t.name,
        count: players.filter((p) => p.teamId === t.id && p.isKeeper).length,
      }))

      return res.status(200).json({
        phase: league.leaguePhase,
        maxKeepers,
        cap: config.cap?.enabled ? config.cap : null,
        myTeamId: mine?.teamId ?? null,
        myRoster,
        declared,
        isCommissioner: league.commissionerId === userId,
      })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

    // Commissioner lock: keepers stay, everyone else re-enters the pool.
    if (req.body?.action === 'lock') {
      if (!(await canManageLeague(userId, leagueId))) {
        return res.status(403).json({ error: 'Only the commissioner can lock keepers.' })
      }
      if (league.leaguePhase !== 'keeper_season') {
        return res.status(400).json({ error: 'Keepers lock during the keeper phase.' })
      }
      const released = await db
        .update(mnsPlayers)
        .set({
          teamId: null,
          slot: 'active',
          onIR: false,
          isInternationalStash: false,
          redshirtedAt: null,
        })
        .where(
          and(
            eq(mnsPlayers.leagueId, leagueId),
            sql`${mnsPlayers.teamId} is not null`,
            eq(mnsPlayers.isKeeper, false)
          )
        )
        .returning({ id: mnsPlayers.id })
      // The flag is consumed — kept players are simply "rostered" now.
      // Parked slots end with the season too: a kept redshirt or stash
      // starts the new year active, and next year's eligibility is
      // re-derived from fresh years-pro and presence data.
      await db
        .update(mnsPlayers)
        .set({ isKeeper: false })
        .where(eq(mnsPlayers.leagueId, leagueId))
      await db
        .update(mnsPlayers)
        .set({ slot: 'active', onIR: false, isInternationalStash: false, redshirtedAt: null })
        .where(
          and(
            eq(mnsPlayers.leagueId, leagueId),
            inArray(mnsPlayers.slot, ['redshirt', 'international'])
          )
        )
      await db
        .update(mnsLeagues)
        .set({ leaguePhase: 'draft', updatedAt: new Date() })
        .where(eq(mnsLeagues.id, leagueId))
      return res.status(200).json({ ok: true, released: released.length })
    }

    // Owner declaration: replace my keeper set.
    if (!mine) return res.status(403).json({ error: "You don't own a team in this league." })
    if (league.leaguePhase !== 'keeper_season') {
      return res.status(400).json({ error: 'Keepers are declared during the keeper phase.' })
    }
    const playerIds = (req.body?.playerIds ?? []) as string[]
    if (!Array.isArray(playerIds)) return res.status(400).json({ error: 'playerIds required.' })
    if (playerIds.length > maxKeepers) {
      return res.status(400).json({ error: `This league keeps at most ${maxKeepers}.` })
    }
    if (playerIds.length > 0) {
      const owned = await db
        .select({ id: mnsPlayers.id })
        .from(mnsPlayers)
        .where(
          and(
            eq(mnsPlayers.leagueId, leagueId),
            eq(mnsPlayers.teamId, mine.teamId),
            inArray(mnsPlayers.id, playerIds)
          )
        )
      if (owned.length !== playerIds.length) {
        return res.status(400).json({ error: 'Every keeper must be on your roster.' })
      }
    }
    await db
      .update(mnsPlayers)
      .set({ isKeeper: false })
      .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.teamId, mine.teamId)))
    if (playerIds.length > 0) {
      await db
        .update(mnsPlayers)
        .set({ isKeeper: true })
        .where(and(eq(mnsPlayers.leagueId, leagueId), inArray(mnsPlayers.id, playerIds)))
    }
    return res.status(200).json({ ok: true, kept: playerIds.length })
  } catch (err) {
    logger.error('keepers endpoint failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Keepers hit an error. Try again.' })
  }
}
