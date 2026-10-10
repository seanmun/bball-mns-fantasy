import type { LeagueConfig } from '../types/leagueConfig'
import type { Player } from '../types/player'
import type { RosterEntry, RosterSummary } from '../types/roster'
import { lookupRookieKeeperRound } from './rookieKeeperMap.js'

// Derive a player's base keeper round (before stacking). Returns null if
// no source rule applies and config.keeper.fallbackRound is null — the
// caller must surface that to the user or importer, not paper over it.
export function baseKeeperRound(
  player: Pick<Player, 'rookieDraftInfo' | 'keeperPriorYearRound' | 'migratedKeeperRound'>,
  config: LeagueConfig
): number | null {
  if (player.rookieDraftInfo) {
    const mapped = lookupRookieKeeperRound(
      player.rookieDraftInfo.round,
      player.rookieDraftInfo.pick,
      config
    )
    return mapped ?? config.keeper.fallbackRound
  }
  if (player.keeperPriorYearRound != null) {
    if (config.keeper.advanceRule === 'minus_one') {
      return Math.max(1, player.keeperPriorYearRound - 1)
    }
    if (config.keeper.advanceRule === 'flat') {
      return player.keeperPriorYearRound
    }
    return player.keeperPriorYearRound
  }
  if (player.migratedKeeperRound != null) {
    return player.migratedKeeperRound
  }
  return config.keeper.fallbackRound
}

export interface StackingResult {
  entries: RosterEntry[]
  franchiseTags: number
}

// Resolve keeper-round conflicts using bottom-of-draft stacking.
// Mutates entries in place (matches mns/ behavior) and returns the
// franchise-tag count for fee calculation.
export function stackKeeperRounds(
  entries: RosterEntry[],
  config: LeagueConfig
): StackingResult {
  const maxRound = config.draft.rounds
  const keepers = entries.filter(
    (e) => e.decision === 'KEEP' && e.baseRound !== undefined
  )

  const round1Keepers = keepers.filter((k) => k.baseRound === 1)
  const otherKeepers = keepers.filter((k) => k.baseRound !== 1)

  let franchiseTags = 0
  const occupied = new Set<number>()

  if (round1Keepers.length > 0) {
    round1Keepers.sort((a, b) => {
      if (a.priority !== undefined && b.priority !== undefined) {
        return a.priority - b.priority
      }
      return 0
    })

    const [firstR1, ...extraR1] = round1Keepers
    firstR1.keeperRound = 1
    occupied.add(1)
    franchiseTags = extraR1.length

    let nextRound = 2
    for (const k of extraR1) {
      k.keeperRound = nextRound
      occupied.add(nextRound)
      nextRound++
    }

    otherKeepers.sort((a, b) => {
      if (a.baseRound !== b.baseRound) return a.baseRound! - b.baseRound!
      if (a.priority !== undefined && b.priority !== undefined) {
        return a.priority - b.priority
      }
      return 0
    })

    for (const keeper of otherKeepers) {
      assignKeeperRound(keeper, occupied, maxRound, 2)
    }
  } else {
    otherKeepers.sort((a, b) => {
      if (a.baseRound !== b.baseRound) return b.baseRound! - a.baseRound!
      if (a.priority !== undefined && b.priority !== undefined) {
        return b.priority - a.priority
      }
      return 0
    })

    for (const keeper of otherKeepers) {
      assignKeeperRound(keeper, occupied, maxRound, 1)
    }
  }

  entries.forEach((entry) => {
    if (entry.decision !== 'KEEP') entry.keeperRound = undefined
  })

  return { entries, franchiseTags }
}

function assignKeeperRound(
  keeper: RosterEntry,
  occupied: Set<number>,
  maxRound: number,
  backwardMin: number
): void {
  const baseRound = keeper.baseRound!

  if (!occupied.has(baseRound)) {
    keeper.keeperRound = baseRound
    occupied.add(baseRound)
    return
  }

  let foundRound: number | null = null

  let backward = baseRound - 1
  while (backward >= backwardMin && occupied.has(backward)) backward--
  if (backward >= backwardMin) {
    foundRound = backward
  } else {
    let forward = baseRound + 1
    while (forward <= maxRound && occupied.has(forward)) forward++
    if (forward <= maxRound) foundRound = forward
  }

  if (foundRound !== null) {
    keeper.keeperRound = foundRound
    occupied.add(foundRound)
  } else {
    keeper.keeperRound = maxRound
  }
}

export interface ComputeSummaryParams {
  entries: RosterEntry[]
  allPlayers: Map<string, Player>
  config: LeagueConfig
  tradeDelta: number
  franchiseTags: number
  draftedPlayers?: Player[]
}

export function computeSummary(params: ComputeSummaryParams): RosterSummary {
  const {
    entries,
    allPlayers,
    config,
    tradeDelta,
    franchiseTags,
    draftedPlayers = [],
  } = params

  const keptIds = entries
    .filter((e) => e.decision === 'KEEP')
    .map((e) => e.playerId)
  const redshirtIds = entries
    .filter((e) => e.decision === 'REDSHIRT')
    .map((e) => e.playerId)
  const intStashIds = entries
    .filter((e) => e.decision === 'INT_STASH')
    .map((e) => e.playerId)

  let capUsed = keptIds.reduce((sum, pid) => {
    const player = allPlayers.get(pid)
    return sum + (player?.salary ?? 0)
  }, 0)
  capUsed += draftedPlayers.reduce((sum, p) => sum + p.salary, 0)

  const capEffective = Math.max(
    config.cap.floor,
    Math.min(config.cap.hardCap, config.cap.base + tradeDelta)
  )

  const overBy = Math.max(0, capUsed - config.cap.secondApron)
  const overByM = Math.ceil(overBy / 1_000_000)
  const penaltyDues =
    config.cap.secondApron > 0 ? overByM * config.cap.penaltyRatePerM : 0

  const franchiseTagDues = franchiseTags * config.fees.franchiseTagFee
  const redshirtDues = redshirtIds.length * config.fees.redshirtFee
  const firstApronFee =
    config.cap.firstApron > 0 && capUsed > config.cap.firstApron
      ? config.fees.firstApronFee
      : 0

  const totalFees =
    penaltyDues + franchiseTagDues + redshirtDues + firstApronFee

  return {
    keepersCount: keptIds.length,
    draftedCount: draftedPlayers.length,
    redshirtsCount: redshirtIds.length,
    intStashCount: intStashIds.length,
    capUsed,
    capBase: config.cap.base,
    capTradeDelta: tradeDelta,
    capEffective,
    overSecondApronByM: overByM,
    penaltyDues,
    franchiseTags,
    franchiseTagDues,
    redshirtDues,
    firstApronFee,
    activationDues: 0,
    totalFees,
  }
}
