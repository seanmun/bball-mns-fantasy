import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { verifyAuth } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsFuturePicks,
  mnsLeagues,
  mnsPlayers,
  mnsTeamOwners,
  mnsTeams,
  mnsTradeProposals,
  mnsTradeProposalResponses,
  mnsSportPlayers,
} from '../../../src/lib/db/schema.js'
import { leaguePlayers } from '../../../src/lib/players/leaguePlayers.js'
import { isTradeDeadlinePassed } from '../../../src/rules/tradeRules.js'
import { pickBoard as sharedPickBoard } from '../../../src/lib/season/picks.js'
import { logTransaction } from '../../../src/lib/season/waivers.js'
import { sendTradeNote } from '../../_notify.js'
import { capUsed, rosterSpots } from '../../../src/lib/season/roster.js'
import { clearFutureSlots } from '../../../src/lib/season/lineups.js'
import { easternToday } from '../../../src/lib/season/score.js'
import { logger } from '../../_logger.js'
import type { TradeAsset } from '../../../src/types/trade.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'

// Trades: two teams, players AND future rookie draft picks, propose →
// accept/reject → executed immediately on accept, validated at ACCEPT
// time (rosters and pick ownership move between propose and accept —
// waivers, other trades — so acceptance revalidates everything and
// refuses stale deals rather than executing fiction). A pick's
// identity is (season, round, original team); ownership lives in
// future_picks, absent row = still with its original team.
//
// GET  /api/leagues/:id/trades — proposals + the tradable pick board
// POST { action: 'propose', toTeamId, givePlayerIds, getPlayerIds,
//        givePickIds?, getPickIds?, note? }
// POST { action: 'respond', proposalId, accept: boolean }
// POST { action: 'cancel', proposalId }
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
  if (!league) return res.status(404).json({ error: 'League not found' })
  const config = league.config as LeagueConfig

  const [mine] = await db
    .select({ teamId: mnsTeamOwners.teamId })
    .from(mnsTeamOwners)
    .innerJoin(mnsTeams, eq(mnsTeams.id, mnsTeamOwners.teamId))
    .where(and(eq(mnsTeams.leagueId, leagueId), eq(mnsTeamOwners.userId, userId)))
    .limit(1)

  // The pick board, shared with the roster page — see lib/season/picks.
  const pickBoard = () =>
    sharedPickBoard(db, { id: leagueId, seasonYear: league.seasonYear, config })

  try {
    if (req.method === 'GET') {
      const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
      const teamName = new Map(teams.map((t) => [t.id, t.name]))
      const proposals = await db
        .select()
        .from(mnsTradeProposals)
        .where(eq(mnsTradeProposals.leagueId, leagueId))
        .orderBy(sql`${mnsTradeProposals.createdAt} desc`)
        .limit(50)
      return res.status(200).json({
        myTeamId: mine?.teamId ?? null,
        deadlinePassed: isTradeDeadlinePassed(config),
        picks: await pickBoard(),
        proposals: proposals.map((p) => ({
          id: p.id,
          status: p.status,
          proposedByTeamId: p.proposedByTeamId,
          proposedByTeamName: teamName.get(p.proposedByTeamId) ?? p.proposedByTeamId,
          involvedTeamIds: p.involvedTeamIds,
          involvedTeamNames: (p.involvedTeamIds as string[]).map((t) => teamName.get(t) ?? t),
          assets: p.assets,
          note: p.note,
          createdAt: p.createdAt,
          mineToAnswer:
            !!mine &&
            p.status === 'pending' &&
            (p.involvedTeamIds as string[]).includes(mine.teamId) &&
            p.proposedByTeamId !== mine.teamId,
          mineToCancel: !!mine && p.status === 'pending' && p.proposedByTeamId === mine.teamId,
        })),
      })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    if (!mine) return res.status(403).json({ error: "You don't own a team in this league." })
    if (isTradeDeadlinePassed(config)) {
      return res.status(400).json({ error: 'The trade deadline has passed.' })
    }

    const action = String(req.body?.action ?? '')

    // Dry-run the math the accept path enforces — the assistant's
    // calculator, and never a write.
    if (action === 'evaluate') {
      const toTeamId = String(req.body?.toTeamId ?? '')
      const givePlayerIds = (req.body?.givePlayerIds ?? []) as string[]
      const getPlayerIds = (req.body?.getPlayerIds ?? []) as string[]
      if (!toTeamId) return res.status(400).json({ error: 'toTeamId required.' })
      const all = await leaguePlayers(db).where(eq(mnsPlayers.leagueId, leagueId))
      const byId = new Map(all.map((p) => [p.id, p]))
      const { averagesForRanges } = await import('../../../src/lib/season/stats.js')
      const season = (await averagesForRanges(db, leagueId)).season
      const sumCat = (ids: string[], k: 'ppg' | 'rpg' | 'apg' | 'spg' | 'bpg' | 'tpg') =>
        ids.reduce((n, id) => n + (season[id]?.[k] ?? 0), 0)
      const swing = {
        pts: sumCat(getPlayerIds, 'ppg') - sumCat(givePlayerIds, 'ppg'),
        reb: sumCat(getPlayerIds, 'rpg') - sumCat(givePlayerIds, 'rpg'),
        ast: sumCat(getPlayerIds, 'apg') - sumCat(givePlayerIds, 'apg'),
        stl: sumCat(getPlayerIds, 'spg') - sumCat(givePlayerIds, 'spg'),
        blk: sumCat(getPlayerIds, 'bpg') - sumCat(givePlayerIds, 'bpg'),
        tpm: sumCat(getPlayerIds, 'tpg') - sumCat(givePlayerIds, 'tpg'),
        cat:
          getPlayerIds.reduce((n, id) => n + (season[id]?.cat ?? 0), 0) -
          givePlayerIds.reduce((n, id) => n + (season[id]?.cat ?? 0), 0),
      }
      const activeSize = config.roster?.activeSize ?? 10
      const sideView = (teamId: string, outIds: string[], inIds: string[]) => {
        const salary = capUsed(all, teamId)
        const outSal = outIds.reduce((n, id) => n + (byId.get(id)?.salary ?? 0), 0)
        const inSal = inIds.reduce((n, id) => n + (byId.get(id)?.salary ?? 0), 0)
        const nonIr = rosterSpots(all, teamId).length
        return {
          teamId,
          salaryBefore: salary,
          salaryAfter: salary - outSal + inSal,
          overHardCap: config.cap?.enabled ? salary - outSal + inSal > config.cap.hardCap : false,
          rosterAfter: nonIr - outIds.length + inIds.length,
          overRosterLimit: nonIr - outIds.length + inIds.length > activeSize,
        }
      }
      return res.status(200).json({
        // Swing is from the CALLER's side: incoming minus outgoing.
        categorySwingPerGame: swing,
        me: sideView(mine.teamId, givePlayerIds, getPlayerIds),
        them: sideView(toTeamId, getPlayerIds, givePlayerIds),
      })
    }

    if (action === 'propose') {
      const toTeamId = String(req.body?.toTeamId ?? '')
      const givePlayerIds = (req.body?.givePlayerIds ?? []) as string[]
      const getPlayerIds = (req.body?.getPlayerIds ?? []) as string[]
      const givePickIds = (req.body?.givePickIds ?? []) as string[]
      const getPickIds = (req.body?.getPickIds ?? []) as string[]
      if (!toTeamId || toTeamId === mine.teamId) {
        return res.status(400).json({ error: 'Pick another team to trade with.' })
      }
      if (givePlayerIds.length + givePickIds.length === 0 || getPlayerIds.length + getPickIds.length === 0) {
        return res.status(400).json({ error: 'A trade needs something on both sides.' })
      }
      const players = await leaguePlayers(db)
        .where(
          and(
            eq(mnsPlayers.leagueId, leagueId),
            inArray(mnsPlayers.id, [...givePlayerIds, ...getPlayerIds])
          )
        )
      const byId = new Map(players.map((p) => [p.id, p]))
      const wrongGive = givePlayerIds.filter((id) => byId.get(id)?.teamId !== mine.teamId)
      const wrongGet = getPlayerIds.filter((id) => byId.get(id)?.teamId !== toTeamId)
      if (wrongGive.length || wrongGet.length) {
        return res.status(400).json({ error: 'Every player must be on the team offering them.' })
      }

      const board = await pickBoard()
      const pickById = new Map(board.map((p) => [p.id, p]))
      const wrongPickGive = givePickIds.filter((id) => pickById.get(id)?.ownerTeamId !== mine.teamId)
      const wrongPickGet = getPickIds.filter((id) => pickById.get(id)?.ownerTeamId !== toTeamId)
      if (wrongPickGive.length || wrongPickGet.length) {
        return res.status(400).json({ error: 'Every pick must belong to the team offering it.' })
      }

      const assets: TradeAsset[] = [
        ...givePlayerIds.map((id) => ({
          type: 'player' as const,
          id,
          displayName: byId.get(id)!.name,
          salary: byId.get(id)!.salary ?? undefined,
          fromTeamId: mine.teamId,
          toTeamId,
        })),
        ...getPlayerIds.map((id) => ({
          type: 'player' as const,
          id,
          displayName: byId.get(id)!.name,
          salary: byId.get(id)!.salary ?? undefined,
          fromTeamId: toTeamId,
          toTeamId: mine.teamId,
        })),
        ...givePickIds.map((id) => ({
          type: 'pick' as const,
          id,
          displayName: pickById.get(id)!.displayName,
          fromTeamId: mine.teamId,
          toTeamId,
        })),
        ...getPickIds.map((id) => ({
          type: 'pick' as const,
          id,
          displayName: pickById.get(id)!.displayName,
          fromTeamId: toTeamId,
          toTeamId: mine.teamId,
        })),
      ]

      const proposalId = `trade-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      await db.insert(mnsTradeProposals).values({
        id: proposalId,
        leagueId,
        seasonYear: league.seasonYear,
        proposedByTeamId: mine.teamId,
        proposedByUserId: userId,
        status: 'pending',
        assets,
        involvedTeamIds: [mine.teamId, toTeamId],
        note: (req.body?.note ? String(req.body.note) : null) as string | null,
        expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      })
      await db.insert(mnsTradeProposalResponses).values({
        id: `${proposalId}-resp`,
        proposalId,
        teamId: toTeamId,
        status: 'pending',
      })
      {
        const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
        const nameOf = new Map(teams.map((t) => [t.id, t.name]))
        await sendTradeNote(leagueId, toTeamId, 'proposed', {
          fromTeamName: nameOf.get(mine.teamId) ?? 'A team',
          assetLines: assets.map(
            (a) => `${a.displayName} → ${nameOf.get(a.toTeamId) ?? a.toTeamId}`
          ),
        })
      }
      return res.status(201).json({ ok: true, proposalId })
    }

    const proposalId = String(req.body?.proposalId ?? '')
    const [proposal] = await db
      .select()
      .from(mnsTradeProposals)
      .where(and(eq(mnsTradeProposals.id, proposalId), eq(mnsTradeProposals.leagueId, leagueId)))
      .limit(1)
    if (!proposal) return res.status(404).json({ error: 'Trade not found.' })
    if (proposal.status !== 'pending') {
      return res.status(409).json({ error: `That trade is already ${proposal.status}.` })
    }

    if (action === 'cancel') {
      if (proposal.proposedByTeamId !== mine.teamId) {
        return res.status(403).json({ error: 'Only the proposer can cancel.' })
      }
      await db
        .update(mnsTradeProposals)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(mnsTradeProposals.id, proposalId))
      return res.status(200).json({ ok: true })
    }

    if (action === 'respond') {
      const involved = proposal.involvedTeamIds as string[]
      if (!involved.includes(mine.teamId) || proposal.proposedByTeamId === mine.teamId) {
        return res.status(403).json({ error: 'This trade is not yours to answer.' })
      }
      const accept = req.body?.accept === true

      if (!accept) {
        await db
          .update(mnsTradeProposals)
          .set({ status: 'rejected', updatedAt: new Date() })
          .where(eq(mnsTradeProposals.id, proposalId))
        await db
          .update(mnsTradeProposalResponses)
          .set({ status: 'rejected', respondedBy: userId, respondedAt: new Date(), updatedAt: new Date() })
          .where(eq(mnsTradeProposalResponses.proposalId, proposalId))
        {
          const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
          const nameOf = new Map(teams.map((t) => [t.id, t.name]))
          await sendTradeNote(leagueId, proposal.proposedByTeamId, 'rejected', {
            fromTeamName: nameOf.get(mine.teamId) ?? 'The other owner',
            assetLines: (proposal.assets as TradeAsset[]).map(
              (a) => `${a.displayName} → ${nameOf.get(a.toTeamId) ?? a.toTeamId}`
            ),
          })
        }
        return res.status(200).json({ ok: true, status: 'rejected' })
      }

      // Revalidate at accept time: every asset must still sit on the
      // team the proposal says it does — waivers or another trade may
      // have moved someone since. Refuse stale deals; never execute
      // fiction.
      const assets = proposal.assets as TradeAsset[]
      const playerAssets = assets.filter((a) => a.type === 'player')
      const pickAssets = assets.filter((a) => a.type !== 'player')
      const ids = playerAssets.map((a) => a.id)
      const players = ids.length
        ? await db
            .select({ id: mnsPlayers.id, teamId: mnsPlayers.teamId, salary: mnsSportPlayers.salary })
            .from(mnsPlayers).innerJoin(mnsSportPlayers, eq(mnsSportPlayers.id, mnsPlayers.sportPlayerId))
            .where(and(eq(mnsPlayers.leagueId, leagueId), inArray(mnsPlayers.id, ids)))
        : []
      const byId = new Map(players.map((p) => [p.id, p]))
      const board = pickAssets.length ? await pickBoard() : []
      const pickOwner = new Map(board.map((p) => [p.id, p.ownerTeamId]))
      const stale = [
        ...playerAssets.filter((a) => byId.get(a.id)?.teamId !== a.fromTeamId),
        ...pickAssets.filter((a) => pickOwner.get(a.id) !== a.fromTeamId),
      ]
      if (stale.length) {
        await db
          .update(mnsTradeProposals)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(eq(mnsTradeProposals.id, proposalId))
        return res.status(409).json({
          error: `${stale.map((a) => a.displayName).join(', ')} ${stale.length === 1 ? 'is' : 'are'} no longer where this trade left ${stale.length === 1 ? 'them' : 'them'} — the proposal has been voided.`,
        })
      }

      // Roster capacity: an asymmetric deal (2-for-1) is legal — the
      // over team fixes it after — but a team ALREADY over the limit
      // can't take on even more bodies.
      const activeSize = config.roster?.activeSize ?? 10
      const allForCount = await db
        .select({ teamId: mnsPlayers.teamId, slot: mnsPlayers.slot })
        .from(mnsPlayers).innerJoin(mnsSportPlayers, eq(mnsSportPlayers.id, mnsPlayers.sportPlayerId))
        .where(eq(mnsPlayers.leagueId, leagueId))
      const nonIr = (teamId: string) =>
        rosterSpots(allForCount, teamId).length
      for (const teamId of involved) {
        const current = nonIr(teamId)
        const outN = playerAssets.filter((a) => a.fromTeamId === teamId).length
        const inN = playerAssets.filter((a) => a.toTeamId === teamId).length
        if (current > activeSize && inN > outN) {
          return res.status(400).json({
            error:
              'A roster in this deal is already over the limit — it has to get legal (drop or IR someone) before taking on more players.',
          })
        }
      }

      // Hard-cap check for both sides, same rule the waiver wire uses.
      if (config.cap?.enabled) {
        const all = await db
          .select({ teamId: mnsPlayers.teamId, salary: mnsSportPlayers.salary, slot: mnsPlayers.slot })
          .from(mnsPlayers).innerJoin(mnsSportPlayers, eq(mnsSportPlayers.id, mnsPlayers.sportPlayerId))
          .where(eq(mnsPlayers.leagueId, leagueId))
        for (const teamId of involved) {
          const current = capUsed(all, teamId)
          const out = assets.filter((a) => a.fromTeamId === teamId).reduce((n, a) => n + (a.salary ?? 0), 0)
          const inn = assets.filter((a) => a.toTeamId === teamId).reduce((n, a) => n + (a.salary ?? 0), 0)
          if (current - out + inn > config.cap.hardCap) {
            return res.status(400).json({ error: 'This trade would put a team over the hard cap.' })
          }
        }
      }

      // A traded player keeps her slot and her history: a redshirt
      // stays a redshirt (eligibility intact), IR stays IR. Only the
      // team changes — and the old team's days-ahead snapshots forget
      // her so nothing stale follows her back.
      for (const a of playerAssets) {
        await db
          .update(mnsPlayers)
          .set({ teamId: a.toTeamId })
          .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, a.id)))
        await clearFutureSlots(db, leagueId, a.fromTeamId, a.id, easternToday())
      }
      for (const a of pickAssets) {
        // pick:<year>:r<round>:<originalTeamId> → materialize (or
        // update) the ownership row.
        const m = a.id.match(/^pick:(\d+):r(\d+):(.+)$/)
        if (!m) continue
        const [, y, r, orig] = m
        await db
          .insert(mnsFuturePicks)
          .values({
            id: `${leagueId}_${y}_r${r}_${orig}`,
            leagueId,
            seasonYear: Number(y),
            round: Number(r),
            originalTeamId: orig,
            currentTeamId: a.toTeamId,
          })
          .onConflictDoUpdate({
            target: [
              mnsFuturePicks.leagueId,
              mnsFuturePicks.seasonYear,
              mnsFuturePicks.round,
              mnsFuturePicks.originalTeamId,
            ],
            set: { currentTeamId: a.toTeamId, updatedAt: new Date() },
          })
      }
      await db
        .update(mnsTradeProposals)
        .set({ status: 'executed', updatedAt: new Date() })
        .where(eq(mnsTradeProposals.id, proposalId))
      await logTransaction(db, leagueId, 'trade', involved, {
        assets: assets.map((a) => ({ name: a.displayName, fromTeamId: a.fromTeamId, toTeamId: a.toTeamId })),
      })
      await db
        .update(mnsTradeProposalResponses)
        .set({ status: 'accepted', respondedBy: userId, respondedAt: new Date(), updatedAt: new Date() })
        .where(eq(mnsTradeProposalResponses.proposalId, proposalId))
      {
        const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
        const nameOf = new Map(teams.map((t) => [t.id, t.name]))
        await sendTradeNote(leagueId, proposal.proposedByTeamId, 'accepted', {
          fromTeamName: nameOf.get(mine.teamId) ?? 'The other owner',
          assetLines: assets.map(
            (a) => `${a.displayName} → ${nameOf.get(a.toTeamId) ?? a.toTeamId}`
          ),
        })
      }
      // Who leaves this deal with homework: more bodies than spots.
      const needsFix = involved
        .map((teamId) => {
          const after =
            nonIr(teamId) -
            playerAssets.filter((a) => a.fromTeamId === teamId).length +
            playerAssets.filter((a) => a.toTeamId === teamId).length
          return { teamId, over: Math.max(0, after - activeSize) }
        })
        .filter((t) => t.over > 0)
      return res.status(200).json({ ok: true, status: 'executed', needsFix })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    logger.error('trades endpoint failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Trades hit an error. Try again.' })
  }
}
