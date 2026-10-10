import type { LeagueConfig } from '../types/leagueConfig'
import type { Player, RookieDraftInfo } from '../types/player'
import type { Decision, RosterEntry, RosterSummary } from '../types/roster'
import { baseKeeperRound, computeSummary, stackKeeperRounds } from './keeperRules.js'
import { validateRoster, type ValidationError } from './validationRules.js'
import { intStashEligible, redshirtEligible } from '../lib/season/roster.js'

// A keeper plan: one decision per rostered player — Keep, Drop,
// Redshirt or Int Stash — priced, stacked into rounds and summed. The
// API and the My Team page run the same functions, so what the owner
// sees is what the lock does.

export interface PlanPlayer {
  id: string
  name: string
  position: string | null
  teamCode: string | null
  salary: number | null
  slot: string | null
  isRookie: boolean
  yearsPro?: number | null
  redshirtUsed?: boolean
  leaguePresence?: string | null
  presenceOverride?: string | null
  intEligible: boolean
  rookieDraftInfo: RookieDraftInfo | null
  keeperPriorYearRound: number | null
  migratedKeeperRound: number | null
  injuryStatus?: string | null
}

export interface PlanOptions {
  baseRound: number | null
  redshirtOk: boolean
  redshirtWhy?: string
  intStashOk: boolean
  intStashWhy?: string
}

// What this player may become next season, and at what price.
export function planOptions(p: PlanPlayer, config: LeagueConfig): PlanOptions {
  const baseRound = baseKeeperRound(p, config)
  let redshirtOk = false
  let redshirtWhy: string | undefined
  if (!config.roster.redshirtsAllowed) {
    redshirtWhy = 'This league has no redshirts.'
  } else if (p.rookieDraftInfo && p.rookieDraftInfo.redshirtEligible === false) {
    redshirtWhy = 'Redshirted already — a player gets one.'
  } else {
    // Keeper season is the offseason: nobody has played this season yet.
    const r = redshirtEligible({ ...p, slot: null }, 0)
    redshirtOk = r.ok
    redshirtWhy = r.reason
  }
  let intStashOk = false
  let intStashWhy: string | undefined
  if (!config.roster.intStashAllowed) {
    intStashWhy = 'This league has no international stash.'
  } else if (p.intEligible) {
    intStashOk = true
  } else {
    const r = intStashEligible({ ...p, slot: null }, 0)
    intStashOk = r.ok
    intStashWhy = r.reason
  }
  return { baseRound, redshirtOk, redshirtWhy, intStashOk, intStashWhy }
}

// Everyone dropped until the owner says otherwise — the blank slate.
export function blankEntries(players: PlanPlayer[], config: LeagueConfig): RosterEntry[] {
  return players.map((p) => ({
    playerId: p.id,
    decision: 'DROP',
    baseRound: baseKeeperRound(p, config) ?? undefined,
  }))
}

// A saved plan meets today's roster: players traded away fall out,
// players added since come in as Drop, and every price is recomputed
// from the player's current round data.
export function reconcileEntries(
  saved: RosterEntry[],
  players: PlanPlayer[],
  config: LeagueConfig
): RosterEntry[] {
  const byId = new Map(players.map((p) => [p.id, p]))
  const kept = saved
    .filter((e) => byId.has(e.playerId))
    .map((e) => ({
      ...e,
      keeperRound: undefined,
      baseRound: baseKeeperRound(byId.get(e.playerId)!, config) ?? undefined,
    }))
  const seen = new Set(kept.map((e) => e.playerId))
  return [...kept, ...blankEntries(players.filter((p) => !seen.has(p.id)), config)]
}

export function setDecision(
  entries: RosterEntry[],
  playerId: string,
  decision: Decision
): RosterEntry[] {
  return entries.map((e) => (e.playerId === playerId ? { ...e, decision } : e))
}

// Two keepers priced at the same round: the owner says who takes it
// (priority 0 first). Moving one up moves the other down.
export function movePriority(
  entries: RosterEntry[],
  playerId: string,
  direction: 'up' | 'down'
): RosterEntry[] {
  const me = entries.find((e) => e.playerId === playerId)
  if (!me || me.decision !== 'KEEP' || me.baseRound === undefined) return entries
  const group = entries
    .filter((e) => e.decision === 'KEEP' && e.baseRound === me.baseRound)
    .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
  const i = group.findIndex((e) => e.playerId === playerId)
  const j = direction === 'up' ? i - 1 : i + 1
  if (j < 0 || j >= group.length) return entries
  ;[group[i], group[j]] = [group[j], group[i]]
  const prio = new Map(group.map((e, idx) => [e.playerId, idx]))
  return entries.map((e) => (prio.has(e.playerId) ? { ...e, priority: prio.get(e.playerId) } : e))
}

export interface PlanEvaluation {
  entries: RosterEntry[] // with keeperRound filled by stacking
  summary: RosterSummary
  franchiseTags: number
  errors: ValidationError[]
  // Round → the keepers who land there (after stacking).
  board: Array<{ round: number; names: string[] }>
}

export function evaluatePlan(
  entries: RosterEntry[],
  players: PlanPlayer[],
  config: LeagueConfig
): PlanEvaluation {
  const byId = new Map(players.map((p) => [p.id, p]))
  const stacked = stackKeeperRounds(
    entries.map((e) => ({ ...e })),
    config
  )
  const allPlayers = new Map(
    players.map((p) => [p.id, { ...p, salary: p.salary ?? 0 } as unknown as Player])
  )
  const summary = computeSummary({
    entries: stacked.entries,
    allPlayers,
    config,
    tradeDelta: 0,
    franchiseTags: stacked.franchiseTags,
  })
  const errors = validateRoster(stacked.entries, allPlayers, config).filter(
    // Stacking already placed every keeper; the assistant warnings don't apply.
    (e) => e.field !== 'unassignedRound' && e.field !== 'roundCollisions'
  )
  for (const e of stacked.entries) {
    const p = byId.get(e.playerId)
    if (!p) continue
    const opts = planOptions(p, config)
    if (e.decision === 'REDSHIRT' && !opts.redshirtOk) {
      errors.push({
        type: 'error',
        field: 'redshirtEligibility',
        message: `${p.name}: ${opts.redshirtWhy ?? 'cannot be redshirted.'}`,
        playerId: p.id,
      })
    }
    if (e.decision === 'INT_STASH' && !opts.intStashOk) {
      // validateRoster already covers the intEligible flag; this adds the why.
      if (!errors.some((x) => x.field === 'intStashEligibility' && x.playerId === p.id)) {
        errors.push({
          type: 'error',
          field: 'intStashEligibility',
          message: `${p.name}: ${opts.intStashWhy ?? 'cannot be stashed.'}`,
          playerId: p.id,
        })
      }
    }
  }
  if (config.cap?.enabled && summary.capUsed > config.cap.hardCap) {
    errors.push({
      type: 'warning',
      field: 'hardCap',
      message: `Over the hard cap by $${((summary.capUsed - config.cap.hardCap) / 1_000_000).toFixed(1)}M — the draft will have to fix that.`,
    })
  }
  const rounds = config.draft.rounds
  const board = Array.from({ length: rounds }, (_, i) => ({ round: i + 1, names: [] as string[] }))
  for (const e of stacked.entries) {
    if (e.decision !== 'KEEP' || !e.keeperRound) continue
    const cell = board[Math.min(rounds, e.keeperRound) - 1]
    cell.names.push(byId.get(e.playerId)?.name ?? e.playerId)
  }
  return { entries: stacked.entries, summary, franchiseTags: stacked.franchiseTags, errors, board }
}

export const blocking = (errors: ValidationError[]) => errors.filter((e) => e.type === 'error')
