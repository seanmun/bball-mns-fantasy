import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../../_db.js'
import { verifyAuth, canManageLeague } from '../../_middleware.js'
import {
  mnsDrafts,
  mnsLeagues,
  mnsPlayers,
  mnsTeamOwners,
  mnsTeams,
} from '../../../src/lib/db/schema.js'
import { leaguePlayers } from '../../../src/lib/players/leaguePlayers.js'
import { sport } from '../../../src/lib/sport/index.js'
import { logger } from '../../_logger.js'
import {
  createDraft,
  controlDraft,
  getDraftState,
  findDraftByScope,
} from '../../_draftService.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'

// The league's veteran draft, run by the HUB's draft engine — this app
// owns who is in it and what happens to the picks; the hub owns order,
// clock and the board. Same integration golf proved out.
//
// GET  /api/leagues/:id/draft            — { draftId, status } for the room
// POST /api/leagues/:id/draft { action } — create / start / pause /
//        resume / restart / sync (commissioner; sync open to any member)
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  const [league] = await db
    .select()
    .from(mnsLeagues)
    .where(eq(mnsLeagues.id, leagueId))
    .limit(1)
  if (!league) return res.status(404).json({ error: 'League not found' })

  const [draftRow] = await db
    .select()
    .from(mnsDrafts)
    .where(eq(mnsDrafts.leagueId, leagueId))
    .limit(1)

  if (req.method === 'GET') {
    const pace =
      ((draftRow?.settings as { pace?: string } | null)?.pace ?? 'live') === 'slow'
        ? 'slow'
        : 'live'
    return res.status(200).json(
      draftRow
        ? { draftId: draftRow.id, status: draftRow.status, pace }
        : { draftId: null, status: null, pace: null }
    )
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const action = String(req.body?.action ?? '')

  try {
    // Sync is deliberately open to any member: the draft room fires it
    // when the board completes, and rosters must never sit unsaved
    // because the commissioner closed their laptop.
    if (action === 'sync') {
      if (!draftRow) return res.status(400).json({ error: 'No draft has been created yet' })
      const result = await syncDraftToRosters(leagueId, draftRow.id)
      return res.status(200).json({ ok: true, ...result })
    }

    if (!(await canManageLeague(userId, leagueId))) {
      return res.status(403).json({ error: 'Only the commissioner can manage the draft' })
    }

    const config = league.config as LeagueConfig

    // Order is team creation order for now — the 4-team test doesn't
    // need a lottery. Every team must have a SIGNED-UP owner: the hub
    // notifies and authorizes pickers by userId, so an unlinked email
    // would be a team that can never pick.
    const buildParticipants = async () => {
      const teams = await db
        .select()
        .from(mnsTeams)
        .where(eq(mnsTeams.leagueId, leagueId))
        .orderBy(mnsTeams.createdAt)
      const out: Array<{ userId: string; email: string | null; teamName: string; slot: number }> = []
      const missing: string[] = []
      const seenUser = new Map<string, string>()
      for (const [i, t] of teams.entries()) {
        const [owner] = await db
          .select()
          .from(mnsTeamOwners)
          .where(and(eq(mnsTeamOwners.teamId, t.id), sql`${mnsTeamOwners.userId} is not null`))
          .limit(1)
        if (!owner?.userId) {
          missing.push(t.name)
          continue
        }
        // Picks map back to teams THROUGH the owner's userId, so one
        // person cannot own two drafting teams.
        const clash = seenUser.get(owner.userId)
        if (clash) throw new Error(`${owner.email} owns both ${clash} and ${t.name} — one drafting team per person`)
        seenUser.set(owner.userId, t.name)
        out.push({ userId: owner.userId, email: owner.email, teamName: t.name, slot: i + 1 })
      }
      return { participants: out, missing }
    }

    // The draftable pool: every league player not already on a roster
    // (keepers stay kept — they are simply absent from the board).
    const buildItems = async () => {
      const pool = await leaguePlayers(db)
        .where(and(eq(mnsPlayers.leagueId, leagueId), isNull(mnsPlayers.teamId)))
      return pool
        .sort((a, b) => (b.salary ?? 0) - (a.salary ?? 0))
        .map((p, i) => ({
          ref: p.id,
          name: p.name,
          rankHint: i + 1,
          meta: { position: p.position, teamCode: p.teamCode, salary: p.salary, isRookie: p.isRookie },
        }))
    }

    const appUrl = process.env.VITE_APP_URL || sport.appUrl
    const rounds = config.draft?.rounds ?? config.roster?.activeSize ?? 10
    const draftName = `${league.name} · ${league.seasonYear} veteran draft`

    // Pace: 'live' = 2-minute clock, everyone in the room. 'slow' = no
    // clock, 12 hours a pick, the hub emails whoever is up. Chosen at
    // create, stored in settings, honoured again at start.
    const storedPace = (draftRow?.settings as { pace?: string } | null)?.pace
    const pace = (req.body?.pace ?? storedPace) === 'slow' ? 'slow' : 'live'
    const pickSeconds = pace === 'slow' ? null : 120

    if (action === 'create') {
      if (draftRow) return res.status(409).json({ error: 'Draft already created' })

      // Adopt a draft the hub already holds for this league — a prior
      // attempt that died before saving its id must not wedge us.
      const existing = await findDraftByScope(league.gameSlug, 'league', leagueId).catch(() => null)
      let draftId = existing?.draft?.id ?? null

      if (!draftId) {
        const { participants, missing } = await buildParticipants()
        if (missing.length) {
          return res.status(400).json({
            error: `These teams have no signed-up owner yet: ${missing.join(', ')}. Owners must create an account with their invited email first.`,
          })
        }
        if (participants.length < 2) {
          return res.status(400).json({ error: 'Need at least 2 teams with owners before drafting' })
        }
        const items = await buildItems()
        if (items.length === 0) {
          return res.status(400).json({ error: 'The player pool is empty — populate it first' })
        }
        const { draft } = await createDraft({
          gameSlug: league.gameSlug,
          scopeType: 'league',
          scopeId: leagueId,
          name: draftName,
          lobbyUrl: `${appUrl}/league/${leagueId}/draft`,
          mode: 'draft',
          // Auction isn't a thing the hub engine speaks; everything the
          // config could ask for maps onto snake for now.
          orderType: 'snake',
          rounds,
          pickSeconds,
          slowPickHours: 12,
          createdBy: userId,
          participants,
          items,
        })
        draftId = draft.id
      }

      await db.insert(mnsDrafts).values({
        id: draftId,
        leagueId,
        seasonYear: league.seasonYear,
        status: 'setup',
        createdBy: userId,
        settings: { pace },
      })
      return res.status(201).json({ draftId, pace })
    }

    if (!draftRow) return res.status(400).json({ error: 'No draft has been created yet' })

    if (action === 'start') {
      // Everything can change between create and start — teams, owners,
      // the pool, the round count. Re-send it all so the draft can never
      // run on stale settings. Queues survive: the hub upserts items on
      // (draftId, ref) rather than replacing rows.
      const { participants, missing } = await buildParticipants()
      if (missing.length) {
        return res.status(400).json({
          error: `These teams have no signed-up owner yet: ${missing.join(', ')}.`,
        })
      }
      if (participants.length < 2) {
        return res.status(400).json({ error: 'Need at least 2 teams with owners before drafting' })
      }
      const items = await buildItems()
      await controlDraft(draftRow.id, { action: 'set_participants', participants })
      await controlDraft(draftRow.id, { action: 'set_items', items })
      await controlDraft(draftRow.id, {
        action: 'set_config',
        rounds,
        pickSeconds,
        slowPickHours: 12,
        name: draftName,
      })
      const result = await controlDraft(draftRow.id, { action: 'start' })
      await db
        .update(mnsDrafts)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(mnsDrafts.id, draftRow.id))
      return res.status(200).json(result)
    }

    if (action === 'restart') {
      // Clear the hub board AND the rosters it wrote — a reset board
      // that leaves players assigned would double-assign on the redo.
      // Exactly the players the board placed go back in the pool;
      // keepers and anyone the commissioner placed by hand stay.
      const before = (await getDraftState(draftRow.id)) as {
        board: Array<{ item: { ref: string } | null }>
      }
      const placed = before.board.map((b) => b.item?.ref).filter((r): r is string => !!r)
      await controlDraft(draftRow.id, { action: 'reset' })
      if (placed.length > 0) {
        await db
          .update(mnsPlayers)
          .set({ teamId: null, slot: 'active', draftRound: null })
          .where(and(eq(mnsPlayers.leagueId, leagueId), inArray(mnsPlayers.id, placed)))
      }
      await db
        .update(mnsDrafts)
        .set({ status: 'setup', updatedAt: new Date() })
        .where(eq(mnsDrafts.id, draftRow.id))
      return res.status(200).json({ ok: true })
    }

    if (action === 'pause' || action === 'resume') {
      const result = await controlDraft(draftRow.id, { action })
      return res.status(200).json(result)
    }

    // Pace is changeable until the first pick exists — the hub refuses
    // set_config after start, which is the real guard; this just keeps
    // our stored copy honest.
    if (action === 'set_pace') {
      const nextPace = req.body?.pace === 'slow' ? 'slow' : 'live'
      await controlDraft(draftRow.id, {
        action: 'set_config',
        pickSeconds: nextPace === 'slow' ? null : 120,
        slowPickHours: 12,
      })
      await db
        .update(mnsDrafts)
        .set({ settings: sql`settings || ${JSON.stringify({ pace: nextPace })}::jsonb`, updatedAt: new Date() })
        .where(eq(mnsDrafts.id, draftRow.id))
      return res.status(200).json({ ok: true, pace: nextPace })
    }

    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (error) {
    logger.error('POST /api/leagues/[id]/draft failed', {
      leagueId,
      action,
      err: error instanceof Error ? error.message : String(error),
    })
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    })
  }
}

// Copy every made pick into the roster it belongs to. Idempotent — it
// rewrites assignments from the authoritative hub board, so calling it
// twice (or mid-draft) is always safe.
export async function syncDraftToRosters(leagueId: string, draftId: string) {
  const state = (await getDraftState(draftId)) as {
    draft: { status: string }
    participants: Array<{ id: string; userId: string }>
    board: Array<{ participantId: string; round: number; item: { ref: string } | null }>
  }

  // participant userId → their team in THIS league.
  const owners = await db
    .select({ userId: mnsTeamOwners.userId, teamId: mnsTeamOwners.teamId })
    .from(mnsTeamOwners)
    .innerJoin(mnsTeams, eq(mnsTeams.id, mnsTeamOwners.teamId))
    .where(and(eq(mnsTeams.leagueId, leagueId), sql`${mnsTeamOwners.userId} is not null`))
  const teamByUser = new Map(owners.map((o) => [o.userId as string, o.teamId]))
  const userByParticipant = new Map(state.participants.map((p) => [p.id, p.userId]))

  let assigned = 0
  for (const slot of state.board) {
    if (!slot.item) continue
    const uid = userByParticipant.get(slot.participantId)
    const teamId = uid ? teamByUser.get(uid) : null
    if (!teamId) continue
    // The board round is the round this player occupied: it becomes
    // his prior-year round at the turn of the year.
    await db
      .update(mnsPlayers)
      .set({ teamId, slot: 'active', draftRound: slot.round })
      .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, slot.item.ref)))
    assigned++
  }

  if (state.draft.status === 'complete') {
    await db
      .update(mnsDrafts)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(mnsDrafts.id, draftId))
  }

  return { draftStatus: state.draft.status, playersAssigned: assigned }
}
