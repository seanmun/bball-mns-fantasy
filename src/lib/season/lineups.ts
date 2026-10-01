import { and, eq, gt, lte, sql } from 'drizzle-orm'
import { mnsDailyLineups, mnsPlayers } from '../db/schema.js'
import { easternToday } from './score.js'

// Daily lineups, Sean's spec (2026-09-17): My Team shows one date at a
// time. Past days are LOCKED — the lineup that played is history. Today
// and future days are editable, and a slot set for a future day carries
// forward until changed (set Thursday's bench today; Thursday wakes up
// benched). Built date-first for the NBA leagues to come, where setting
// lineups days ahead is the whole game.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export type Slot = 'active' | 'bench' | 'ir' | 'redshirt' | 'international'

// Redshirt and the international stash are SEASON acts, not daily
// lineup moves: no date, a fee or an eligibility check, and the
// player's base slot is the truth. A daily snapshot never overrides a
// parked player — that is how a redshirt silently came back to life
// once a team had a snapshot on file.
export const isParked = (slot: string | null | undefined): boolean =>
  slot === 'redshirt' || slot === 'international'

const DAY_MS = 24 * 3600 * 1000

// YYYY-MM-DD arithmetic in Eastern terms — dates are calendar strings,
// so shifting via UTC noon avoids every DST edge.
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`)
  return new Date(d.getTime() + days * DAY_MS).toISOString().slice(0, 10)
}

export function isLockedDate(date: string, now = new Date()): boolean {
  return date < easternToday(now)
}

interface LineupRow {
  teamId: string
  gameDate: string
  slots: Record<string, string>
}

// A resolver over every lineup row through `throughDate`: effective
// slot = the latest snapshot at/before the date that the team wrote,
// falling back to the player's base slot (covers never-touched teams
// and players picked up after the snapshot).
export async function lineupResolver(db: Db, leagueId: string, throughDate: string) {
  const rows = (await db
    .select({
      teamId: mnsDailyLineups.teamId,
      gameDate: mnsDailyLineups.gameDate,
      slots: mnsDailyLineups.slots,
    })
    .from(mnsDailyLineups)
    .where(
      and(eq(mnsDailyLineups.leagueId, leagueId), lte(mnsDailyLineups.gameDate, throughDate))
    )
    .orderBy(mnsDailyLineups.gameDate)) as LineupRow[]
  const byTeam = new Map<string, LineupRow[]>()
  for (const r of rows) {
    const list = byTeam.get(r.teamId) ?? []
    list.push(r) // already date-ascending
    byTeam.set(r.teamId, list)
  }
  return (teamId: string, playerId: string, date: string, baseSlot: string | null): Slot =>
    resolveFromRows(byTeam.get(teamId), playerId, date, baseSlot)
}

// The resolver's pure core: parked wins outright; otherwise the latest
// snapshot at/before the date, then the base slot.
export function resolveFromRows(
  rows: Array<{ gameDate: string; slots: Record<string, string> }> | undefined,
  playerId: string,
  date: string,
  baseSlot: string | null
): Slot {
  if (isParked(baseSlot)) return baseSlot as Slot
  if (rows) {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].gameDate <= date) {
        const s = rows[i].slots[playerId]
        return (s ?? baseSlot ?? 'active') as Slot
      }
    }
  }
  return (baseSlot ?? 'active') as Slot
}

// Forget a player in every snapshot AFTER a date — on un-parking,
// trading, or dropping, so a slot set days ahead cannot resurrect a
// state the season act just ended.
export async function clearFutureSlots(
  db: Db,
  leagueId: string,
  teamId: string,
  playerId: string,
  afterDate: string
): Promise<void> {
  await db
    .update(mnsDailyLineups)
    .set({
      slots: sql`${mnsDailyLineups.slots} - ${playerId}::text`,
      activePlayerIds: sql`array_remove(${mnsDailyLineups.activePlayerIds}, ${playerId}::text)`,
    })
    .where(
      and(
        eq(mnsDailyLineups.leagueId, leagueId),
        eq(mnsDailyLineups.teamId, teamId),
        gt(mnsDailyLineups.gameDate, afterDate)
      )
    )
}

// One team's full effective lineup for one date, over its CURRENT
// roster. This is both what the My Team page renders and the starting
// point every write snapshots from.
export async function effectiveSlots(
  db: Db,
  leagueId: string,
  teamId: string,
  date: string
): Promise<Map<string, Slot>> {
  const resolve = await lineupResolver(db, leagueId, date)
  const roster = (await db
    .select({ id: mnsPlayers.id, slot: mnsPlayers.slot })
    .from(mnsPlayers)
    .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.teamId, teamId)))) as Array<{
    id: string
    slot: string | null
  }>
  return new Map(roster.map((p) => [p.id, resolve(teamId, p.id, date, p.slot)]))
}

// Write one slot change for one date: snapshot the effective lineup,
// overlay the change, upsert the row. Same-day changes also land on
// mnsPlayers.slot so everything reading "now" (live scoring, free
// agency) stays true without knowing dates exist.
export async function setSlotForDate(
  db: Db,
  leagueId: string,
  teamId: string,
  playerId: string,
  slot: Slot,
  date: string,
  userId: string | null,
  now = new Date()
): Promise<void> {
  const slots = Object.fromEntries(await effectiveSlots(db, leagueId, teamId, date))
  slots[playerId] = slot
  const activePlayerIds = Object.keys(slots).filter((id) => slots[id] === 'active')
  await db
    .insert(mnsDailyLineups)
    .values({ leagueId, teamId, gameDate: date, slots, activePlayerIds, updatedBy: userId })
    .onConflictDoUpdate({
      target: [mnsDailyLineups.teamId, mnsDailyLineups.gameDate],
      set: { slots, activePlayerIds, updatedBy: userId, updatedAt: now },
    })
  if (date === easternToday(now)) {
    await db
      .update(mnsPlayers)
      .set({ slot, onIR: slot === 'ir' })
      .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
  }
}

// The morning rollover, run from the season tick: materialize today's
// effective lineup into mnsPlayers.slot, so a lineup set days ago
// becomes "the" lineup the moment its day arrives.
export async function applyLineupsForToday(db: Db, leagueId: string, now = new Date()) {
  const today = easternToday(now)
  const resolve = await lineupResolver(db, leagueId, today)
  const roster = (await db
    .select({ id: mnsPlayers.id, teamId: mnsPlayers.teamId, slot: mnsPlayers.slot })
    .from(mnsPlayers)
    .where(and(eq(mnsPlayers.leagueId, leagueId), sql`${mnsPlayers.teamId} is not null`))) as Array<{
    id: string
    teamId: string
    slot: string | null
  }>
  let changed = 0
  for (const p of roster) {
    // Parked players are season acts — the daily rollover never
    // touches them.
    if (isParked(p.slot)) continue
    const eff = resolve(p.teamId, p.id, today, p.slot)
    if (isParked(eff)) continue
    if (eff !== (p.slot ?? 'active')) {
      await db
        .update(mnsPlayers)
        .set({ slot: eff, onIR: eff === 'ir' })
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, p.id)))
      changed++
    }
  }
  return { changed }
}
