// Shared vocabulary for the player surfaces. It lives here, in a plain
// module, because StatTable and PlayerCard each needed something from
// the other — a circular import, which in a production bundle shows up
// as "Cannot access X before initialization" depending on which module
// the bundler happens to initialise first.

export interface StatAvg {
  gp: number
  ppg: number
  rpg: number
  apg: number
  spg: number
  bpg: number
  tpg: number
  fgPct: number
  mpg?: number
  tov?: number
  ftPct?: number
  tpPct?: number
  /** Cat Score: mean z-score across the nine categories. */
  cat?: number | null
  /** CAT$: Cat Score per $1M of salary. */
  catD?: number | null
}

export type RangeKey = 'season' | 'last30' | 'last10' | 'lastSeason'

export const RANGE_LABELS: Array<[RangeKey, string]> = [
  ['season', 'Season'],
  ['last30', 'Last 30'],
  ['last10', 'Last 10'],
  ['lastSeason', 'Last season'],
]

// "New news" = the injury report changed inside the last 48 hours.
export const isFreshNews = (updatedAt?: string | null, status?: string | null): boolean =>
  !!status && !!updatedAt && Date.now() - new Date(updatedAt).getTime() < 48 * 3600 * 1000
