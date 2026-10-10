import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { verifyAuth, canManageLeague } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsLeagues,
  mnsPlayers,
  mnsRosters,
  mnsTeamOwners,
  mnsTeams,
} from '../../../src/lib/db/schema.js'
import { leaguePlayers } from '../../../src/lib/players/leaguePlayers.js'
import { writeDraftRounds } from '../../../src/lib/players/carry.js'
import {
  blocking,
  evaluatePlan,
  planOptions,
  reconcileEntries,
  type PlanPlayer,
} from '../../../src/rules/keeperPlan.js'
import type { Decision, RosterEntry, SavedScenario } from '../../../src/types/roster.js'
import type { RookieDraftInfo } from '../../../src/types/player.js'
import { logger } from '../../_logger.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'

// Keeper season, the way MNS ran it: each owner works a plan on their
// own team page — Keep / Drop / Redshirt / Int Stash per player — saves
// scenarios to compare, and submits one. Private until the commissioner
// locks. The lock keeps the keepers, parks redshirts and stashes, and
// sends everyone else back to the pool for the draft.
//
// GET  → my roster with each player's price and options, my plan
//        (entries, status, saved scenarios), every team's status
// POST { action: 'save', entries }               — the working plan
// POST { action: 'scenario', name, entries }     — save a named scenario
// POST { action: 'deleteScenario', scenarioId }
// POST { action: 'submit', entries }             — final; locks the owner out
// POST { action: 'unlock', teamId }              — commissioner: back to draft
// POST { action: 'lock' }                        — commissioner: the turn
const DECISIONS: Decision[] = ['KEEP', 'DROP', 'REDSHIRT', 'INT_STASH']

type PlayerRow = Awaited<ReturnType<ReturnType<typeof leaguePlayers>['where']>>[number]

const toPlanPlayer = (p: PlayerRow): PlanPlayer => ({
  id: p.id,
  name: p.name,
  position: p.position,
  teamCode: p.teamCode,
  salary: p.salary,
  slot: p.slot,
  isRookie: p.isRookie,
  yearsPro: p.yearsPro,
  careerGp: p.careerGp,
  redshirtUsed: p.redshirtUsed,
  leaguePresence: p.leaguePresence,
  presenceOverride: p.presenceOverride,
  intEligible: p.intEligible,
  rookieDraftInfo: (p.rookieDraftInfo ?? null) as RookieDraftInfo | null,
  keeperPriorYearRound: p.keeperPriorYearRound,
  migratedKeeperRound: p.migratedKeeperRound,
  injuryStatus: p.injuryStatus,
})

const rosterId = (leagueId: string, teamId: string, seasonYear: number) =>
  `${leagueId}:${teamId}:${seasonYear}`

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })
    const config = league.config as LeagueConfig
    const maxKeepers = config.roster?.maxKeepers ?? 0
    const isCommissioner = await canManageLeague(userId, leagueId)

    const [mine] = await db
      .select({ teamId: mnsTeamOwners.teamId })
      .from(mnsTeamOwners)
      .innerJoin(mnsTeams, eq(mnsTeams.id, mnsTeamOwners.teamId))
      .where(and(eq(mnsTeams.leagueId, leagueId), eq(mnsTeamOwners.userId, userId)))
      .limit(1)

    const rosterRows = await db
      .select()
      .from(mnsRosters)
      .where(and(eq(mnsRosters.leagueId, leagueId), eq(mnsRosters.seasonYear, league.seasonYear)))
    const rosterOf = (teamId: string) => rosterRows.find((r) => r.teamId === teamId) ?? null

    if (req.method === 'GET') {
      const players = await leaguePlayers(db).where(
        and(eq(mnsPlayers.leagueId, leagueId), sql`${mnsPlayers.teamId} is not null`)
      )
      const myPlayers = players.filter((p) => mine && p.teamId === mine.teamId).map(toPlanPlayer)
      const myRoster = myPlayers
        .map((p) => ({ ...p, ...planOptions(p, config) }))
        .sort(
          (a, b) =>
            (a.baseRound ?? 99) - (b.baseRound ?? 99) || (b.salary ?? 0) - (a.salary ?? 0)
        )
      const myRow = mine ? rosterOf(mine.teamId) : null
      const plan = myRow
        ? {
            entries: reconcileEntries(myRow.entries as RosterEntry[], myPlayers, config),
            status: myRow.status,
            savedScenarios: (myRow.savedScenarios ?? []) as SavedScenario[],
          }
        : null

      const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
      const declared = teams.map((t) => {
        const row = rosterOf(t.id)
        const entries = (row?.entries ?? []) as RosterEntry[]
        return {
          teamId: t.id,
          teamName: t.name,
          status: (row?.status ?? 'none') as 'none' | 'draft' | 'submitted' | 'adminLocked',
          count: row
            ? entries.filter((e) => e.decision === 'KEEP').length
            : players.filter((p) => p.teamId === t.id && p.isKeeper).length,
        }
      })

      return res.status(200).json({
        phase: league.leaguePhase,
        maxKeepers,
        rounds: config.draft?.rounds ?? 13,
        cap: config.cap?.enabled ? config.cap : null,
        fees: config.fees ?? null,
        keepersLocked: league.keepersLocked,
        isCommissioner,
        myTeamId: mine?.teamId ?? null,
        myRoster,
        plan,
        declared,
      })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const action = String(req.body?.action ?? '')

    // ---- Commissioner acts ------------------------------------------------
    if (action === 'unlock') {
      if (!isCommissioner) return res.status(403).json({ error: 'Only the commissioner can unlock a team.' })
      const teamId = String(req.body?.teamId ?? '')
      const row = rosterOf(teamId)
      if (!row) return res.status(404).json({ error: 'That team has not started a plan.' })
      await db
        .update(mnsRosters)
        .set({ status: 'draft', updatedAt: new Date() })
        .where(eq(mnsRosters.id, row.id))
      return res.status(200).json({ ok: true })
    }

    if (action === 'lock') {
      if (!isCommissioner) return res.status(403).json({ error: 'Only the commissioner can lock keepers.' })
      if (league.leaguePhase !== 'keeper_season') {
        return res.status(400).json({ error: 'Keepers lock during the keeper phase.' })
      }
      const players = await leaguePlayers(db).where(
        and(eq(mnsPlayers.leagueId, leagueId), sql`${mnsPlayers.teamId} is not null`)
      )
      const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, leagueId))
      const keepIds: string[] = []
      const redshirtIds: string[] = []
      const stashIds: string[] = []
      const occupied: Array<{ id: string; draftRound: number }> = []
      for (const t of teams) {
        const row = rosterOf(t.id)
        // A team that submitted nothing keeps nobody.
        if (!row || row.status !== 'submitted') continue
        const teamPlayers = players.filter((p) => p.teamId === t.id).map(toPlanPlayer)
        const entries = reconcileEntries(row.entries as RosterEntry[], teamPlayers, config)
        const ev = evaluatePlan(entries, teamPlayers, config)
        for (const e of ev.entries) {
          if (e.decision === 'KEEP') {
            keepIds.push(e.playerId)
            if (e.keeperRound) occupied.push({ id: e.playerId, draftRound: e.keeperRound })
          } else if (e.decision === 'REDSHIRT') redshirtIds.push(e.playerId)
          else if (e.decision === 'INT_STASH') stashIds.push(e.playerId)
        }
      }
      const staying = [...keepIds, ...redshirtIds, ...stashIds]
      const now = new Date()
      const released = await db
        .update(mnsPlayers)
        .set({
          teamId: null,
          slot: 'active',
          onIR: false,
          isInternationalStash: false,
          redshirtedAt: null,
          isKeeper: false,
          draftRound: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(mnsPlayers.leagueId, leagueId),
            sql`${mnsPlayers.teamId} is not null`,
            staying.length > 0 ? notInArray(mnsPlayers.id, staying) : sql`true`
          )
        )
        .returning({ id: mnsPlayers.id })
      // Keepers start the year active; the flag is consumed.
      if (keepIds.length > 0) {
        await db
          .update(mnsPlayers)
          .set({ slot: 'active', onIR: false, isInternationalStash: false, redshirtedAt: null, isKeeper: false, updatedAt: now })
          .where(and(eq(mnsPlayers.leagueId, leagueId), inArray(mnsPlayers.id, keepIds)))
      }
      if (redshirtIds.length > 0) {
        await db
          .update(mnsPlayers)
          .set({ slot: 'redshirt', onIR: false, isInternationalStash: false, redshirtedAt: now, isKeeper: false, updatedAt: now })
          .where(and(eq(mnsPlayers.leagueId, leagueId), inArray(mnsPlayers.id, redshirtIds)))
      }
      if (stashIds.length > 0) {
        await db
          .update(mnsPlayers)
          .set({ slot: 'international', onIR: false, isInternationalStash: true, redshirtedAt: null, isKeeper: false, updatedAt: now })
          .where(and(eq(mnsPlayers.leagueId, leagueId), inArray(mnsPlayers.id, stashIds)))
      }
      // Each keeper's stacked round is the round she occupies this
      // season; the turn of the year prices next season from it.
      await writeDraftRounds(db, leagueId, occupied)
      await db
        .update(mnsRosters)
        .set({ status: 'adminLocked', updatedAt: now })
        .where(and(eq(mnsRosters.leagueId, leagueId), eq(mnsRosters.seasonYear, league.seasonYear)))
      // The one lock: the checklist reads the flag, the phase moves on.
      await db
        .update(mnsLeagues)
        .set({ leaguePhase: 'draft', keepersLocked: true, updatedAt: now })
        .where(eq(mnsLeagues.id, leagueId))
      return res.status(200).json({
        ok: true,
        released: released.length,
        kept: keepIds.length,
        redshirted: redshirtIds.length,
        stashed: stashIds.length,
      })
    }

    // ---- Owner acts -------------------------------------------------------
    if (!mine) return res.status(403).json({ error: "You don't own a team in this league." })
    if (league.leaguePhase !== 'keeper_season') {
      return res.status(400).json({ error: 'Keeper plans are open during the keeper phase only.' })
    }
    const myRow = rosterOf(mine.teamId)
    if (myRow && myRow.status !== 'draft') {
      return res
        .status(409)
        .json({ error: 'Your keepers are submitted. Ask the commissioner to unlock if something needs fixing.' })
    }
    const myPlayers = (
      await leaguePlayers(db).where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.teamId, mine.teamId)))
    ).map(toPlanPlayer)

    // Entries come from the client; only this team's players, only known
    // decisions, and every price recomputed here — the client's numbers
    // are a preview, never the record.
    const readEntries = (): RosterEntry[] | null => {
      const raw = req.body?.entries
      if (!Array.isArray(raw)) return null
      const ids = new Set(myPlayers.map((p) => p.id))
      const clean: RosterEntry[] = []
      for (const e of raw) {
        if (!e || typeof e.playerId !== 'string' || !ids.has(e.playerId)) continue
        if (!DECISIONS.includes(e.decision)) continue
        clean.push({
          playerId: e.playerId,
          decision: e.decision,
          priority: Number.isInteger(e.priority) ? e.priority : undefined,
        })
      }
      return reconcileEntries(clean, myPlayers, config)
    }
    const upsert = async (fields: Partial<typeof mnsRosters.$inferInsert>) => {
      const now = new Date()
      if (myRow) {
        await db
          .update(mnsRosters)
          .set({ ...fields, updatedAt: now })
          .where(eq(mnsRosters.id, myRow.id))
      } else {
        await db.insert(mnsRosters).values({
          id: rosterId(leagueId, mine.teamId, league.seasonYear),
          leagueId,
          teamId: mine.teamId,
          seasonYear: league.seasonYear,
          entries: [],
          summary: {},
          status: 'draft',
          savedScenarios: [],
          createdAt: now,
          updatedAt: now,
          ...fields,
        })
      }
    }

    if (action === 'save' || action === 'submit' || action === 'scenario') {
      const entries = readEntries()
      if (!entries) return res.status(400).json({ error: 'entries must be a list.' })
      const ev = evaluatePlan(entries, myPlayers, config)
      if (action === 'submit') {
        const errs = blocking(ev.errors)
        if (errs.length > 0) {
          return res.status(400).json({
            error: `Fix these first: ${errs.map((e) => e.message).join(' ')}`,
            errors: errs,
          })
        }
      }
      let savedScenarios = (myRow?.savedScenarios ?? []) as SavedScenario[]
      if (action === 'scenario') {
        const name = String(req.body?.name ?? '').trim().slice(0, 60)
        if (!name) return res.status(400).json({ error: 'Give the scenario a name.' })
        savedScenarios = [
          ...savedScenarios,
          {
            scenarioId: `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            name,
            timestamp: Date.now(),
            savedBy: userId,
            entries: ev.entries,
            summary: ev.summary,
          },
        ]
      }
      await upsert({
        entries: ev.entries,
        summary: ev.summary,
        savedScenarios,
        status: action === 'submit' ? 'submitted' : 'draft',
      })
      if (action === 'submit') {
        // The flag the declarations and the checklist count on.
        const staying = ev.entries
          .filter((e) => e.decision !== 'DROP')
          .map((e) => e.playerId)
        await db
          .update(mnsPlayers)
          .set({ isKeeper: false, updatedAt: new Date() })
          .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.teamId, mine.teamId)))
        if (staying.length > 0) {
          await db
            .update(mnsPlayers)
            .set({ isKeeper: true, updatedAt: new Date() })
            .where(and(eq(mnsPlayers.leagueId, leagueId), inArray(mnsPlayers.id, staying)))
        }
      }
      return res.status(200).json({
        ok: true,
        status: action === 'submit' ? 'submitted' : 'draft',
        summary: ev.summary,
        savedScenarios,
      })
    }

    if (action === 'deleteScenario') {
      const scenarioId = String(req.body?.scenarioId ?? '')
      const savedScenarios = ((myRow?.savedScenarios ?? []) as SavedScenario[]).filter(
        (s) => s.scenarioId !== scenarioId
      )
      await upsert({ savedScenarios })
      return res.status(200).json({ ok: true, savedScenarios })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    logger.error('/api/leagues/[id]/keepers failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Keepers hit an error. Try again.' })
  }
}
