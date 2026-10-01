// What a roster slot MEANS, in one place. Three slots hold a player
// without holding a spot, and they differ in what else they cost:
//
//   active   — scores, holds a spot, counts against the cap
//   bench    — no scoring, holds a spot, counts against the cap
//   ir       — no scoring, NO spot, still counts against the cap
//   redshirt — no scoring, NO spot, NO cap hit, costs a fee each way
//   international — a stash: playing abroad, NO spot, NO cap hit
//
// Every count and every cap sum goes through these predicates. The
// rules lived scattered as `slot !== 'ir'` and raw salary sums, which
// is exactly how redshirt silently ate a roster spot and a cap hit.

export const HOLDS_ROSTER_SPOT = (slot: string | null | undefined): boolean =>
  slot !== 'ir' && slot !== 'redshirt' && slot !== 'international'

export type MoveTarget = 'active' | 'bench' | 'ir' | 'redshirt' | 'international' | 'drop'

const PARKED = (slot: string | null | undefined) => slot === 'redshirt' || slot === 'international'

// What a move IS, judged from where the player stands and where she
// is going — so every path (stash, redshirt, cross-moves between them,
// a plain activation) pays what it owes and checks what it must.
//   leavesRedshirt — activation fee, eligibility spent. Any exit but a drop.
//   entersRedshirt — rookie eligibility + redshirt fee, from anywhere.
//   entersStash    — stash eligibility, no fee.
//   unparks        — salary returns to the cap: hard-cap check first.
//   seasonAct      — carries no date; always today.
export function moveShape(from: string | null | undefined, to: MoveTarget) {
  const f = from ?? 'active'
  return {
    leavesRedshirt: f === 'redshirt' && to !== 'redshirt' && to !== 'drop',
    entersRedshirt: to === 'redshirt' && f !== 'redshirt',
    entersStash: to === 'international' && f !== 'international',
    leavesStash: f === 'international' && to !== 'international' && to !== 'drop',
    unparks: PARKED(f) && !PARKED(to) && to !== 'drop',
    seasonAct: to === 'drop' || PARKED(f) || PARKED(to),
  }
}

export const COUNTS_AGAINST_CAP = (slot: string | null | undefined): boolean =>
  slot !== 'redshirt' && slot !== 'international'

interface SlotPlayer {
  teamId?: string | null
  slot?: string | null
  salary?: number | null
}

// Players on a team occupying one of its roster spots.
export function rosterSpots<T extends SlotPlayer>(players: T[], teamId: string): T[] {
  return players.filter((p) => p.teamId === teamId && HOLDS_ROSTER_SPOT(p.slot))
}

// A team's salary against the cap — redshirts ride free.
export function capUsed(players: SlotPlayer[], teamId: string): number {
  return players
    .filter((p) => p.teamId === teamId && COUNTS_AGAINST_CAP(p.slot))
    .reduce((n, p) => n + (p.salary ?? 0), 0)
}

// Where a player actually is, as the bios pass reads ESPN — the
// commissioner's override always wins over the heuristic.
export type Presence = 'rostered' | 'rights_only' | 'absent'

export interface EligibilityPlayer {
  isRookie?: boolean
  yearsPro?: number | null
  redshirtUsed?: boolean
  slot?: string | null
  leaguePresence?: string | null
  presenceOverride?: string | null
}

export const presenceOf = (p: EligibilityPlayer): Presence =>
  ((p.presenceOverride ?? p.leaguePresence ?? 'absent') as Presence)

// Rookie by the league's own definition: first year of service. Falls
// back to the is_rookie flag only while years_pro is unknown.
export const isRookieYear = (p: EligibilityPlayer): boolean =>
  p.yearsPro != null ? p.yearsPro === 0 : !!p.isRookie

// Redshirt: a rookie who is HERE and has not debuted. Both halves
// matter — a drafted player who stayed overseas is also "0 years, 0
// games", and she is a stash, not a redshirt (Elena Buenavida vs
// Elizabeth Balogun, 2026).
export function redshirtEligible(
  player: EligibilityPlayer,
  gamesPlayed: number
): { ok: boolean; reason?: string } {
  if (player.slot === 'redshirt') return { ok: false, reason: 'Already on redshirt.' }
  if (player.redshirtUsed) {
    return { ok: false, reason: 'Redshirt already used — a player only gets one.' }
  }
  if (!isRookieYear(player)) return { ok: false, reason: 'Only rookies can be redshirted.' }
  if (gamesPlayed > 0) {
    return { ok: false, reason: 'She has already played — redshirt is for rookies who have not debuted.' }
  }
  if (presenceOf(player) !== 'rostered') {
    return {
      ok: false,
      reason:
        'She is not with a WNBA club — that is an international stash, not a redshirt. The commissioner can correct this if she really has reported.',
    }
  }
  return { ok: true }
}

// International stash: under contract somewhere else. Open to anyone
// not with a WNBA club who has not played here — veteran or draftee.
export function intStashEligible(
  player: EligibilityPlayer,
  gamesPlayed: number
): { ok: boolean; reason?: string } {
  if (player.slot === 'international') return { ok: false, reason: 'Already stashed.' }
  if (gamesPlayed > 0) {
    return { ok: false, reason: 'She has played in the league this season — she cannot be stashed.' }
  }
  if (presenceOf(player) === 'rostered') {
    return {
      ok: false,
      reason:
        'She is on a WNBA roster — a stash is for players playing elsewhere. The commissioner can correct this if she is actually abroad.',
    }
  }
  return { ok: true }
}
