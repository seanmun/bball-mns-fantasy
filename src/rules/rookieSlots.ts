import type { LeagueConfig } from '../types/leagueConfig'
import type { Player, RookieDraftInfo } from '../types/player'
import { baseKeeperRound } from './keeperRules.js'

// What the commissioner types in the Rosters "Rd" box. A bare round
// ("4") is the round the player was kept or drafted in last year, and
// this year costs one less. A slot ("1.4") is the rookie draft slot of
// a rookie redshirted last year: she is priced by the rookie table, the
// same as a rookie in her draft year, because she has not used a round.
export type RoundEntry =
  | { kind: 'empty' }
  | { kind: 'round'; round: number }
  | { kind: 'slot'; round: number; pick: number }
  | { kind: 'invalid' }

export function parseRoundEntry(text: string): RoundEntry {
  const t = text.trim()
  if (t === '') return { kind: 'empty' }
  const slot = t.match(/^(\d{1,2})\.(\d{1,2})$/)
  if (slot) {
    const round = Number(slot[1])
    const pick = Number(slot[2])
    if (round >= 1 && round <= 10 && pick >= 1 && pick <= 60) {
      return { kind: 'slot', round, pick }
    }
    return { kind: 'invalid' }
  }
  if (/^\d{1,2}$/.test(t)) {
    const round = Number(t)
    if (round >= 1 && round <= 20) return { kind: 'round', round }
  }
  return { kind: 'invalid' }
}

export function formatRoundEntry(
  p: Pick<Player, 'rookieDraftInfo' | 'keeperPriorYearRound'>
): string {
  if (p.rookieDraftInfo) return `${p.rookieDraftInfo.round}.${p.rookieDraftInfo.pick}`
  return p.keeperPriorYearRound != null ? String(p.keeperPriorYearRound) : ''
}

// The slot a pick on the rookie board stamps on the player it takes.
// Redshirt is on the table for a rookie in her draft year.
export function slotForBoardPick(
  pick: { round: number; pickInRound: number },
  seasonYear: number
): RookieDraftInfo {
  return { round: pick.round, pick: pick.pickInRound, redshirtEligible: true, seasonYear }
}

// A rookie redshirted last year keeps her slot price this year and has
// no second redshirt.
export function slotForLastYearRedshirt(round: number, pick: number): RookieDraftInfo {
  return { round, pick, redshirtEligible: false, redshirtedLastYear: true }
}

// Did this season's board stamp the slot? Then the board owns it and
// Rosters shows it read-only.
export function slotFromThisBoard(
  info: RookieDraftInfo | null | undefined,
  seasonYear: number
): boolean {
  return !!info && info.seasonYear === seasonYear
}

// The turn of the year, per player: what next season's keeper pricing
// starts from. A rostered player's prior-year round becomes the round
// she actually occupied this season — kept there, or picked there. A
// pickup who occupied no round counts as the last round. A redshirted
// rookie carries her slot forward and loses the second redshirt. A free
// agent carries nothing.
export function carryKeeperFields(
  player: Pick<
    Player,
    | 'teamId'
    | 'slot'
    | 'rookieDraftInfo'
    | 'keeperPriorYearRound'
    | 'migratedKeeperRound'
    | 'draftRound'
  >,
  config: LeagueConfig
): { keeperPriorYearRound: number | null; rookieDraftInfo: RookieDraftInfo | null } {
  if (!player.teamId) return { keeperPriorYearRound: null, rookieDraftInfo: null }
  if (player.slot === 'redshirt' && player.rookieDraftInfo) {
    return {
      keeperPriorYearRound: null,
      rookieDraftInfo: {
        ...player.rookieDraftInfo,
        redshirtEligible: false,
        redshirtedLastYear: true,
      },
    }
  }
  const occupied =
    player.draftRound ?? baseKeeperRound(player, config) ?? config.draft.rounds
  return { keeperPriorYearRound: occupied, rookieDraftInfo: null }
}
