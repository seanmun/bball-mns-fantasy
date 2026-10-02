import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import { mnsPlayers, mnsTeams, mnsTransactions, mnsWaiverClaims } from '../db/schema.js'
import { easternToday } from './score.js'
import { capUsed, rosterSpots } from './roster.js'
import { sport } from '../sport/index.js'
import type { LeagueConfig } from '../../types/leagueConfig.js'

// Free agency, Sean's spec from the live beta (2026-09-17):
// - Until the day's FIRST TIPOFF, the pool is open — anyone picks up
//   anyone instantly, naming the drop in the same move. Instant
//   pickups cost nothing in priority.
// - From first tip until early morning, FA moves queue as WAIVER
//   CLAIMS that clear at the first tick at/after 8am ET next day.
// - Waiver priority is a rolling line: least recent GRANTED waiver
//   move first; a grant sends you to the back. Never-claimed teams
//   head the line (team creation order between them).
// Teams queue as many claims as they like (rank orders the queue).
// Clearing is a SNAKE: round one takes every team's top claim in line
// order, round two reverses, back and forth until the queues empty —
// then the line re-forms from tonight's grants, latest grant to the
// back. Within one claim the preference list still means being sniped
// costs that player, not the slot.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

const ET_HOUR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  hour12: false,
})

export function nextClearDate(now = new Date()): string {
  // The overnight window belongs to the MORNING it ends in: a claim at
  // 12:10am clears at 8am the same day, not a day later.
  if (Number(ET_HOUR.format(now)) < 8) return easternToday(now)
  return easternToday(new Date(now.getTime() + 24 * 3600 * 1000))
}

export interface WaiverOutcome {
  teamId: string
  granted: string[]
  failed: Array<{ name: string; reason: string }>
}
export interface WaiverResult {
  processed: number
  granted: number
  failed: number
  outcomes: WaiverOutcome[]
}

// Priority: a rolling line ordered by each team's most recent GRANTED
// waiver move — least recent (or never) first, team creation order as
// the tiebreak. Instant pregame pickups deliberately don't appear
// here: only waiver grants cost position.
export async function waiverPriority(db: Db, leagueId: string): Promise<string[]> {
  const teams = await db
    .select()
    .from(mnsTeams)
    .where(eq(mnsTeams.leagueId, leagueId))
    .orderBy(mnsTeams.createdAt)
  const grants = await db
    .select({
      teamId: mnsWaiverClaims.teamId,
      last: sql<string | null>`max(${mnsWaiverClaims.processedAt})`,
    })
    .from(mnsWaiverClaims)
    .where(and(eq(mnsWaiverClaims.leagueId, leagueId), eq(mnsWaiverClaims.status, 'granted')))
    .groupBy(mnsWaiverClaims.teamId)
  const lastByTeam = new Map(
    grants.map((g: { teamId: string; last: string | null }) => [g.teamId, g.last ? new Date(g.last).getTime() : 0])
  )
  return teams
    .map((t: { id: string }, i: number) => ({ id: t.id, i, last: lastByTeam.get(t.id) ?? 0 }))
    .sort(
      (a: { last: number; i: number }, b: { last: number; i: number }) =>
        a.last - b.last || a.i - b.i
    )
    .map((t: { id: string }) => t.id)
}

// Where free agency stands right now, from today's real schedule: the
// pool is OPEN until the first tipoff of the Eastern day (or all day
// when nobody plays), then claims-only until tomorrow's clear.
const ESPN_BOARD = `https://site.api.espn.com/apis/site/v2/sports/${sport.espn.league}/scoreboard`

export async function faWindow(now = new Date()): Promise<{
  mode: 'open' | 'waivers'
  firstTip: string | null
}> {
  try {
    // The overnight hold: midnight flips the calendar but NOT the
    // window. If yesterday had games, waivers stay closed until the
    // 8am clear — otherwise 12:01am would reopen instant adds while
    // last night's claims are still waiting in line.
    if (Number(ET_HOUR.format(now)) < 8) {
      const yesterday = easternToday(new Date(now.getTime() - 24 * 3600 * 1000)).replace(/-/g, '')
      const yBoard = (await (await fetch(`${ESPN_BOARD}?dates=${yesterday}`)).json()) as {
        events?: Array<{ date: string }>
      }
      if ((yBoard.events ?? []).length > 0) return { mode: 'waivers', firstTip: null }
    }
    const yyyymmdd = easternToday(now).replace(/-/g, '')
    const board = (await (await fetch(`${ESPN_BOARD}?dates=${yyyymmdd}`)).json()) as {
      events?: Array<{ date: string }>
    }
    const tips = (board.events ?? []).map((e) => new Date(e.date).getTime())
    if (tips.length === 0) return { mode: 'open', firstTip: null }
    const first = Math.min(...tips)
    return {
      mode: now.getTime() < first ? 'open' : 'waivers',
      firstTip: new Date(first).toISOString(),
    }
  } catch {
    // If the schedule is unreachable, fail toward waivers — a queued
    // claim is recoverable; a wrongly-instant pickup is not.
    return { mode: 'waivers', firstTip: null }
  }
}

export async function logTransaction(
  db: Db,
  leagueId: string,
  type: 'add_drop' | 'waiver' | 'trade',
  teamIds: string[],
  detail: Record<string, unknown>
) {
  await db.insert(mnsTransactions).values({ leagueId, type, teamIds, detail })
}

export async function processWaivers(
  db: Db,
  leagueId: string,
  config: LeagueConfig,
  now = new Date()
): Promise<WaiverResult> {
  const result: WaiverResult = { processed: 0, granted: 0, failed: 0, outcomes: [] }
  // The clearing moment is 8am Eastern — before that, today's due
  // claims stay pending so late-night submitters aren't racing the
  // clock at 12:01.
  if (Number(ET_HOUR.format(now)) < 8) return result

  const due = await db
    .select()
    .from(mnsWaiverClaims)
    .where(
      and(
        eq(mnsWaiverClaims.leagueId, leagueId),
        eq(mnsWaiverClaims.status, 'pending'),
        lte(mnsWaiverClaims.clearsOn, easternToday(now))
      )
    )
  if (due.length === 0) return result

  // Each team's queue, in the order they ranked it.
  const queues = new Map<string, typeof due>()
  for (const c of due.sort(
    (a: { rank: number; createdAt: Date }, b: { rank: number; createdAt: Date }) =>
      a.rank - b.rank || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  )) {
    const q = queues.get(c.teamId) ?? []
    q.push(c)
    queues.set(c.teamId, q)
  }
  const order = (await waiverPriority(db, leagueId)).filter((id) => queues.has(id))

  // The snake: forward, then reverse, until every queue is empty.
  const passes: typeof due = []
  let round = 0
  while ([...queues.values()].some((q) => q.length > 0)) {
    const seq = round % 2 === 0 ? order : [...order].reverse()
    for (const teamId of seq) {
      const next = queues.get(teamId)?.shift()
      if (next) passes.push(next)
    }
    round++
  }

  const players = await db
    .select({ id: mnsPlayers.id, name: mnsPlayers.name, teamId: mnsPlayers.teamId, salary: mnsPlayers.salary, slot: mnsPlayers.slot })
    .from(mnsPlayers)
    .where(eq(mnsPlayers.leagueId, leagueId))
  const byId = new Map(players.map((p: { id: string }) => [p.id, p]))

  const hardCap = config.cap?.enabled ? config.cap.hardCap : null

  const activeSize = config.roster?.activeSize ?? 10
  const outcomeOf = new Map<string, WaiverOutcome>()
  const outcome = (teamId: string) => {
    let o = outcomeOf.get(teamId)
    if (!o) {
      o = { teamId, granted: [], failed: [] }
      outcomeOf.set(teamId, o)
      result.outcomes.push(o)
    }
    return o
  }
  let grantSeq = 0
  for (const claim of passes) {
    result.processed++
    const drop = claim.dropPlayerId
      ? (byId.get(claim.dropPlayerId) as { id: string; teamId: string | null; salary: number; name?: string } | undefined)
      : null
    let grantedId: string | null = null
    let reason: string | null = null

    // IR players don't hold a spot; an over-limit roster can't add.
    const rosterCount = rosterSpots(
      players as Array<{ teamId: string | null; slot: string | null }>,
      claim.teamId
    ).length
    if (rosterCount > activeSize) {
      await db
        .update(mnsWaiverClaims)
        .set({ status: 'failed', failureReason: 'Your roster is over the limit — drop or IR someone.', processedAt: now, updatedAt: now })
        .where(eq(mnsWaiverClaims.id, claim.id))
      result.failed++
      outcome(claim.teamId).failed.push({
        name: (byId.get((claim.addPlayerIds as string[])[0]) as { name?: string })?.name ?? 'claim',
        reason: 'roster over the limit',
      })
      continue
    }
    if (claim.dropPlayerId && (!drop || drop.teamId !== claim.teamId)) {
      reason = 'The player you offered to drop is no longer on your roster.'
    } else if (!claim.dropPlayerId && rosterCount >= activeSize) {
      reason = 'Your roster is full — resubmit with a drop.'
    } else {
      for (const addId of claim.addPlayerIds as string[]) {
        const add = byId.get(addId) as { id: string; teamId: string | null; salary: number } | undefined
        if (!add || add.teamId != null) continue // taken (possibly by a better-ranked claim this pass)
        if (hardCap != null) {
          const rosterSalary = capUsed(
            players as Array<{ teamId: string | null; slot: string | null; salary: number }>,
            claim.teamId
          )
          if (rosterSalary - (drop?.salary ?? 0) + (add.salary ?? 0) > hardCap) {
            reason = 'That add would put you over the hard cap.'
            continue
          }
        }
        grantedId = addId
        break
      }
      if (!grantedId && !reason) reason = 'Everyone on your list was already taken.'
    }

    if (grantedId) {
      await db
        .update(mnsPlayers)
        .set({ teamId: claim.teamId, slot: 'active' })
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, grantedId)))
      if (claim.dropPlayerId) {
        await db
          .update(mnsPlayers)
          .set({ teamId: null, slot: 'active' })
          .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, claim.dropPlayerId)))
        ;(byId.get(claim.dropPlayerId) as { teamId: string | null }).teamId = null
      }
      // Keep the in-memory picture current so later claims this pass
      // see the grant — contention is decided HERE, in priority order.
      ;(byId.get(grantedId) as { teamId: string | null }).teamId = claim.teamId
      // Stamp grants milliseconds apart in snake sequence, so the
      // rolling line "resets" deterministically: tonight's later
      // grants stand further back tomorrow.
      const stamp = new Date(now.getTime() + grantSeq++)
      await db
        .update(mnsWaiverClaims)
        .set({ status: 'granted', grantedPlayerId: grantedId, processedAt: stamp, updatedAt: now })
        .where(eq(mnsWaiverClaims.id, claim.id))
      await logTransaction(db, leagueId, 'waiver', [claim.teamId], {
        added: (byId.get(grantedId) as { name?: string })?.name ?? grantedId,
        ...(claim.dropPlayerId
          ? { dropped: (byId.get(claim.dropPlayerId) as { name?: string })?.name ?? claim.dropPlayerId }
          : {}),
      })
      result.granted++
      outcome(claim.teamId).granted.push(
        (byId.get(grantedId) as { name?: string })?.name ?? grantedId
      )
    } else {
      await db
        .update(mnsWaiverClaims)
        .set({ status: 'failed', failureReason: reason, processedAt: now, updatedAt: now })
        .where(eq(mnsWaiverClaims.id, claim.id))
      result.failed++
      const firstAdd = (claim.addPlayerIds as string[])[0]
      outcome(claim.teamId).failed.push({
        name: (byId.get(firstAdd) as { name?: string })?.name ?? firstAdd,
        reason: reason ?? 'not available',
      })
    }
  }

  return result
}

// Referenced by the API for the transaction log.
export async function waiverLog(db: Db, leagueId: string, limit = 30) {
  return db
    .select()
    .from(mnsWaiverClaims)
    .where(
      and(
        eq(mnsWaiverClaims.leagueId, leagueId),
        inArray(mnsWaiverClaims.status, ['granted', 'failed'])
      )
    )
    .orderBy(sql`${mnsWaiverClaims.processedAt} desc nulls last`)
    .limit(limit)
}
