import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq, sql } from 'drizzle-orm'
import { verifyAuth } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsLeagues,
  mnsPlayers,
  mnsTeamOwners,
  mnsTeams,
  mnsWaiverClaims,
} from '../../../src/lib/db/schema.js'
import {
  faWindow,
  logTransaction,
  nextClearDate,
  processWaivers,
  waiverLog,
  waiverPriority,
} from '../../../src/lib/season/waivers.js'
import { seasonAverages } from '../../../src/lib/season/stats.js'
import { sendWaiverResults } from '../../_notify.js'
import { capUsed, rosterSpots } from '../../../src/lib/season/roster.js'
import { clearFutureSlots } from '../../../src/lib/season/lineups.js'
import { dayGames } from '../../../src/lib/season/statSources.js'
import { lockReason, playerLocked, tipClock } from '../../../src/lib/season/locks.js'
import { capNotice } from '../../../src/rules/capRules.js'
import { teamExposures } from '../../../src/lib/season/capLock.js'
import { easternToday } from '../../../src/lib/season/score.js'
import { logger } from '../../_logger.js'

// The waiver wire. Teams queue as many claims as they like; tomorrow
// at 8am ET they clear as a SNAKE — round one takes each team's top
// claim in priority order, round two reverses, until the queues empty.
//
// GET    /api/leagues/:id/waivers — my roster, free agents, my queued
//        claims, the priority order (public — knowing you pick third
//        is the point), and the transaction log
// POST   { addPlayerIds: string[], dropPlayerId? } — append a claim to
//        my queue
// PATCH  { claimIds: string[] } — reorder my queue
// DELETE ?claimId= — withdraw one claim; without it, the whole queue
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
  if (!league) return res.status(404).json({ error: 'League not found' })

  // The caller's team: waivers are an OWNER act.
  const [mine] = await db
    .select({ teamId: mnsTeamOwners.teamId, teamName: mnsTeams.name })
    .from(mnsTeamOwners)
    .innerJoin(mnsTeams, eq(mnsTeams.id, mnsTeamOwners.teamId))
    .where(and(eq(mnsTeams.leagueId, leagueId), eq(mnsTeamOwners.userId, userId)))
    .limit(1)

  try {
    if (req.method === 'GET') {
      const players = await db
        .select()
        .from(mnsPlayers)
        .where(eq(mnsPlayers.leagueId, leagueId))

      const avgByPlayer = await seasonAverages(db, leagueId)

      const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
      const teamName = new Map(teams.map((t) => [t.id, t.name]))
      const playerName = new Map(players.map((p) => [p.id, p.name]))

      const window = await faWindow()
      // The slate members are actually shopping for: tonight while
      // adds are instant, the clear-day slate once claims queue.
      const slateDate = window.mode === 'open' ? easternToday() : nextClearDate()
      const slate = await dayGames(slateDate)
      const order = await waiverPriority(db, leagueId)
      const myClaims = mine
        ? await db
            .select()
            .from(mnsWaiverClaims)
            .where(
              and(eq(mnsWaiverClaims.teamId, mine.teamId), eq(mnsWaiverClaims.status, 'pending'))
            )
            .orderBy(mnsWaiverClaims.rank, mnsWaiverClaims.createdAt)
        : []

      const log = await waiverLog(db, leagueId)

      const cfg = league.config as import('../../../src/types/leagueConfig.js').LeagueConfig
      return res.status(200).json({
        myTeamId: mine?.teamId ?? null,
        activeSize: cfg.roster?.activeSize ?? 10,
        // 'open' = instant add/drop until today's first tip; 'waivers'
        // = claims queue for tomorrow morning's clear.
        window: window.mode,
        firstTip: window.firstTip,
        clearsOn: nextClearDate(),
        slateDate,
        slateToday: slateDate === easternToday(),
        games: Object.fromEntries(slate),
        priority: order.map((id, i) => ({ position: i + 1, teamId: id, teamName: teamName.get(id) ?? id, isMe: mine?.teamId === id })),
        myRoster: players
          .filter((p) => mine && p.teamId === mine.teamId)
          .map((p) => ({ id: p.id, name: p.name, position: p.position, teamCode: p.teamCode, salary: p.salary, injuryStatus: p.injuryStatus, injuryUpdatedAt: p.injuryUpdatedAt, avg: avgByPlayer.get(p.id) ?? null }))
          .sort((a, b) => (b.avg?.ppg ?? 0) - (a.avg?.ppg ?? 0)),
        freeAgents: players
          .filter((p) => p.teamId == null)
          .map((p) => ({ id: p.id, name: p.name, position: p.position, teamCode: p.teamCode, salary: p.salary, injuryStatus: p.injuryStatus, injuryUpdatedAt: p.injuryUpdatedAt, avg: avgByPlayer.get(p.id) ?? null }))
          .sort((a, b) => (b.avg?.ppg ?? 0) - (a.avg?.ppg ?? 0)),
        myClaims: myClaims.map((c: typeof mnsWaiverClaims.$inferSelect) => ({
          id: c.id,
          clearsOn: c.clearsOn,
          addPlayerIds: c.addPlayerIds,
          addNames: (c.addPlayerIds as string[]).map((id) => playerName.get(id) ?? id),
          dropPlayerId: c.dropPlayerId,
          dropName: c.dropPlayerId ? playerName.get(c.dropPlayerId) ?? c.dropPlayerId : null,
        })),
        log: log.map((c: typeof mnsWaiverClaims.$inferSelect) => ({
          teamName: teamName.get(c.teamId) ?? c.teamId,
          status: c.status,
          granted: c.grantedPlayerId ? playerName.get(c.grantedPlayerId) ?? c.grantedPlayerId : null,
          dropped:
            c.status === 'granted' && c.dropPlayerId
              ? playerName.get(c.dropPlayerId) ?? c.dropPlayerId
              : null,
          reason: c.failureReason,
          processedAt: c.processedAt,
        })),
      })
    }

    if (!mine) return res.status(403).json({ error: "You don't own a team in this league." })

    if (req.method === 'POST') {
      if (league.leaguePhase === 'champion') {
        return res.status(400).json({ error: 'The season is complete — rosters reopen when the next season starts.' })
      }
      const addPlayerIds = (req.body?.addPlayerIds ?? []) as string[]
      const dropPlayerId: string | null = req.body?.dropPlayerId ? String(req.body.dropPlayerId) : null
      if (!Array.isArray(addPlayerIds) || addPlayerIds.length === 0) {
        return res.status(400).json({ error: 'Pick at least one player to add.' })
      }
      const players = await db
        .select({
          id: mnsPlayers.id,
          name: mnsPlayers.name,
          teamId: mnsPlayers.teamId,
          slot: mnsPlayers.slot,
          teamCode: mnsPlayers.teamCode,
        })
        .from(mnsPlayers)
        .where(eq(mnsPlayers.leagueId, leagueId))
      const byId = new Map(players.map((p) => [p.id, p]))
      // The tip-off lock: a player whose game has tipped stays on the
      // team until tomorrow, so she cannot be the drop in an instant
      // add. A queued claim clears in the morning, before any tip.
      if (dropPlayerId) {
        const dropRow = byId.get(dropPlayerId)
        const game = dropRow?.teamCode ? (await dayGames(easternToday())).get(dropRow.teamCode) : undefined
        if (dropRow && playerLocked(game)) {
          return res.status(400).json({ error: lockReason(dropRow.name, game!) })
        }
      }
      const config = league.config as import('../../../src/types/leagueConfig.js').LeagueConfig
      const activeSize = config.roster?.activeSize ?? 10
      // IR doesn't occupy a spot — that's what the slots are FOR. A
      // team over the limit (a 2-for-1 trade) is frozen out of adds
      // entirely until it gets legal.
      const myCount = rosterSpots(players, mine.teamId).length
      if (myCount > activeSize) {
        return res.status(400).json({
          error: `Your roster is over the limit (${myCount} for ${activeSize} spots) — drop or IR someone before adding.`,
        })
      }
      if (!dropPlayerId && myCount >= activeSize) {
        return res.status(400).json({ error: 'Your roster is full — pick someone to drop.' })
      }
      if (dropPlayerId && byId.get(dropPlayerId)?.teamId !== mine.teamId) {
        return res.status(400).json({ error: 'That drop is not on your roster.' })
      }
      const notFree = addPlayerIds.filter((id) => byId.get(id)?.teamId != null || !byId.has(id))
      if (notFree.length) {
        return res.status(400).json({ error: 'Someone on your add list is already rostered.' })
      }

      // Before the day's first tip, free agency is OPEN: the move
      // executes right now, first tap wins, no priority cost.
      const window = await faWindow()
      if (window.mode === 'open') {
        // The queue clears BEFORE anyone's instant add — otherwise the
        // first person awake at 8am could snipe a player someone
        // claimed overnight, before the tick has run. Idempotent and
        // self-gated, so calling it here is free when nothing is due.
        const cleared = await processWaivers(db, leagueId, league.config as import('../../../src/types/leagueConfig.js').LeagueConfig)
        await sendWaiverResults(leagueId, cleared.outcomes)
        const addId = addPlayerIds[0]
        if (config.cap?.enabled) {
          const rows = await db
            .select({ teamId: mnsPlayers.teamId, salary: mnsPlayers.salary, id: mnsPlayers.id, slot: mnsPlayers.slot })
            .from(mnsPlayers)
            .where(eq(mnsPlayers.leagueId, leagueId))
          const rosterSalary = capUsed(rows, mine.teamId)
          const addSal = rows.find((p) => p.id === addId)?.salary ?? 0
          const dropSal = dropPlayerId ? rows.find((p) => p.id === dropPlayerId)?.salary ?? 0 : 0
          if (rosterSalary - dropSal + addSal > config.cap.hardCap) {
            return res.status(400).json({ error: 'That pickup would put you over the hard cap.' })
          }
        }
        // Two updates guarded by current state — if someone else took
        // the player a second ago, the first update writes zero rows
        // and the move honestly fails.
        const took = await db
          .update(mnsPlayers)
          .set({ teamId: mine.teamId, slot: 'active' })
          .where(
            and(
              eq(mnsPlayers.leagueId, leagueId),
              eq(mnsPlayers.id, addId),
              sql`${mnsPlayers.teamId} is null`
            )
          )
          .returning({ id: mnsPlayers.id, name: mnsPlayers.name })
        if (took.length === 0) {
          return res.status(409).json({ error: 'Somebody beat you to that player — refresh and pick again.' })
        }
        let droppedName: string | null = null
        if (dropPlayerId) {
          const [droppedRow] = await db
            .update(mnsPlayers)
            .set({ teamId: null, slot: 'active', onIR: false, isInternationalStash: false, redshirtedAt: null })
            .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, dropPlayerId)))
            .returning({ name: mnsPlayers.name })
          droppedName = droppedRow?.name ?? dropPlayerId
          await clearFutureSlots(db, leagueId, mine.teamId, dropPlayerId, easternToday())
        }
        await logTransaction(db, leagueId, 'add_drop', [mine.teamId], {
          added: took[0].name,
          ...(droppedName ? { dropped: droppedName } : {}),
        })
        // New salary on the books: say what it costs at first tip.
        const ex = (await teamExposures(db, leagueId, league.seasonYear, config, [mine.teamId])).get(mine.teamId)
        const notice = ex ? capNotice(ex.exposure, window.firstTip ? tipClock(window.firstTip) : null) : null
        return res.status(200).json({ ok: true, instant: true, added: took[0].name, capNotice: notice })
      }

      // Append to the back of my queue for the clearing day.
      const clearsOn = nextClearDate()
      const [last] = await db
        .select({ max: sql<number>`coalesce(max(${mnsWaiverClaims.rank}), 0)` })
        .from(mnsWaiverClaims)
        .where(
          and(eq(mnsWaiverClaims.teamId, mine.teamId), eq(mnsWaiverClaims.status, 'pending'))
        )
      const [claim] = await db
        .insert(mnsWaiverClaims)
        .values({ leagueId, teamId: mine.teamId, clearsOn, rank: (last?.max ?? 0) + 1, addPlayerIds, dropPlayerId })
        .returning()
      return res.status(200).json({ ok: true, claim: { id: claim.id, clearsOn: claim.clearsOn, rank: claim.rank } })
    }

    if (req.method === 'PATCH') {
      const claimIds = (req.body?.claimIds ?? []) as string[]
      if (!Array.isArray(claimIds) || claimIds.length === 0) {
        return res.status(400).json({ error: 'claimIds is required.' })
      }
      // Ranks rewrite in the order given — only my own pending claims.
      for (let i = 0; i < claimIds.length; i++) {
        await db
          .update(mnsWaiverClaims)
          .set({ rank: i + 1, updatedAt: new Date() })
          .where(
            and(
              eq(mnsWaiverClaims.id, claimIds[i]),
              eq(mnsWaiverClaims.teamId, mine.teamId),
              eq(mnsWaiverClaims.status, 'pending')
            )
          )
      }
      return res.status(200).json({ ok: true })
    }

    if (req.method === 'DELETE') {
      const claimId = req.query.claimId ? String(req.query.claimId) : null
      await db
        .update(mnsWaiverClaims)
        .set({ status: 'withdrawn', updatedAt: new Date() })
        .where(
          and(
            eq(mnsWaiverClaims.teamId, mine.teamId),
            eq(mnsWaiverClaims.status, 'pending'),
            ...(claimId ? [eq(mnsWaiverClaims.id, claimId)] : [])
          )
        )
      return res.status(200).json({ ok: true })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (err) {
    logger.error('waivers endpoint failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Waivers hit an error. Try again.' })
  }
}
