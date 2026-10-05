import { eq } from 'drizzle-orm'
import {
  mnsNotifyLog,
  mnsPlayers,
  mnsTeams,
  mnsSportPlayers,
} from '../db/schema.js'
import { capExposure, computeApronFees, type CapExposure } from '../../rules/capRules.js'
import { bookApronDues, teamFees, type FeeEntry } from './fees.js'
import { capUsed } from './roster.js'
import { easternToday } from './score.js'
import type { LeagueConfig } from '../../types/leagueConfig.js'

// Cap dues book at the day's FIRST TIP, from the roster each team
// carried into game day — once per league per day, never twice, never
// undone. The first apron is a one-time fee for the season; the second
// apron is a watermark that only rises. Before the tip, the same math
// is a forecast: what WILL book unless the team gets under.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export const apronsConfigured = (config: LeagueConfig): boolean =>
  !!config.cap?.enabled && ((config.cap.firstApron ?? 0) > 0 || (config.cap.secondApron ?? 0) > 0)

export interface TeamExposure {
  capUsed: number
  exposure: CapExposure
}

// Where every team stands against the aprons right now, net of what
// its ledger already booked.
export async function teamExposures(
  db: Db,
  leagueId: string,
  seasonYear: number,
  config: LeagueConfig,
  onlyTeamIds?: string[]
): Promise<Map<string, TeamExposure>> {
  const out = new Map<string, TeamExposure>()
  if (!apronsConfigured(config)) return out
  const players = (await db
    .select({ teamId: mnsPlayers.teamId, salary: mnsSportPlayers.salary, slot: mnsPlayers.slot })
    .from(mnsPlayers).innerJoin(mnsSportPlayers, eq(mnsSportPlayers.id, mnsPlayers.sportPlayerId))
    .where(eq(mnsPlayers.leagueId, leagueId))) as Array<{
    teamId: string | null
    salary: number | null
    slot: string | null
  }>
  const teams = (await db
    .select({ id: mnsTeams.id })
    .from(mnsTeams)
    .where(eq(mnsTeams.leagueId, leagueId))) as Array<{ id: string }>
  for (const t of teams) {
    if (onlyTeamIds && !onlyTeamIds.includes(t.id)) continue
    const used = capUsed(players, t.id)
    const ledger = await teamFees(db, leagueId, t.id, seasonYear)
    const booked = {
      firstApronFee: Number(ledger?.firstApronFee ?? 0),
      secondApronPenalty: Number(ledger?.secondApronPenalty ?? 0),
    }
    out.set(t.id, { capUsed: used, exposure: capExposure(used, config, booked) })
  }
  return out
}

export interface DuesReceipt {
  teamId: string
  capUsed: number
  entries: FeeEntry[]
  totalOwed: number
}

export async function bookCapDuesAtTip(
  db: Db,
  league: { id: string; seasonYear: number },
  config: LeagueConfig,
  firstTip: string | null,
  now = new Date()
): Promise<{ booked: DuesReceipt[] }> {
  if (!apronsConfigured(config)) return { booked: [] }
  if (!firstTip || now.getTime() < Date.parse(firstTip)) return { booked: [] }

  // Claim the day. The claim comes first: booking twice is the worse
  // failure, and a team the pass misses shows up as a forecast until
  // the next game day.
  const today = easternToday(now)
  const claimed = await db
    .insert(mnsNotifyLog)
    .values({ leagueId: league.id, kind: 'cap_lock', dateKey: today })
    .onConflictDoNothing()
    .returning()
  if (claimed.length === 0) return { booked: [] }

  const players = (await db
    .select({ teamId: mnsPlayers.teamId, salary: mnsSportPlayers.salary, slot: mnsPlayers.slot })
    .from(mnsPlayers).innerJoin(mnsSportPlayers, eq(mnsSportPlayers.id, mnsPlayers.sportPlayerId))
    .where(eq(mnsPlayers.leagueId, league.id))) as Array<{
    teamId: string | null
    salary: number | null
    slot: string | null
  }>
  const teams = (await db
    .select({ id: mnsTeams.id })
    .from(mnsTeams)
    .where(eq(mnsTeams.leagueId, league.id))) as Array<{ id: string }>

  const booked: DuesReceipt[] = []
  for (const t of teams) {
    const used = capUsed(players, t.id)
    const ledger = await teamFees(db, league.id, t.id, league.seasonYear)
    const current = {
      firstApronFee: Number(ledger?.firstApronFee ?? 0),
      secondApronPenalty: Number(ledger?.secondApronPenalty ?? 0),
    }
    const next = computeApronFees({ capUsed: used, config, current })
    if (!next.firstApronTriggered && !next.secondApronWatermarkRaised) continue
    const entries = await bookApronDues(db, league.id, t.id, league.seasonYear, next, current, used, now)
    if (entries.length === 0) continue
    const after = await teamFees(db, league.id, t.id, league.seasonYear)
    booked.push({ teamId: t.id, capUsed: used, entries, totalOwed: Number(after?.totalFees ?? 0) })
  }
  return { booked }
}
