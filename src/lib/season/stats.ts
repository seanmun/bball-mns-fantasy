import { eq } from 'drizzle-orm'
import { mnsPlayers } from '../db/schema.js'
import { leagueStatLines } from '../players/statLines.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export interface SeasonAvg {
  gp: number
  ppg: number
  rpg: number
  apg: number
  spg: number
  bpg: number
  tpg: number
  fgPct: number
  /** Cat Score: mean z-score across all nine categories vs the pool. */
  cat?: number | null
  /** CAT$: Cat Score per $1M of salary — value density. */
  catD?: number | null
}

// Season averages from the real box scores on file — one query, one
// map, shared by every surface that shows a player (wire, team page).
export async function seasonAverages(db: Db, leagueId: string): Promise<Map<string, SeasonAvg>> {
  const rows = (await leagueStatLines(db).where(eq(mnsPlayers.leagueId, leagueId))) as Array<{
    playerId: string
    min: number; pts: number; reb: number; ast: number; stl: number; blk: number; tpm: number; fgm: number; fga: number
  }>
  type Acc = { gp: number; pts: number; reb: number; ast: number; stl: number; blk: number; tpm: number; fgm: number; fga: number }
  const acc = new Map<string, Acc>()
  for (const r of rows) {
    const a = acc.get(r.playerId) ?? { gp: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, fgm: 0, fga: 0 }
    if (r.min > 0) a.gp++
    a.pts += r.pts; a.reb += r.reb; a.ast += r.ast; a.stl += r.stl; a.blk += r.blk
    a.tpm += r.tpm; a.fgm += r.fgm; a.fga += r.fga
    acc.set(r.playerId, a)
  }
  const per = (v: number, gp: number) => (gp > 0 ? Math.round((v / gp) * 10) / 10 : 0)
  return new Map(
    [...acc.entries()].map(([id, a]) => [
      id,
      {
        gp: a.gp,
        ppg: per(a.pts, a.gp),
        rpg: per(a.reb, a.gp),
        apg: per(a.ast, a.gp),
        spg: per(a.stl, a.gp),
        bpg: per(a.blk, a.gp),
        tpg: per(a.tpm, a.gp),
        fgPct: a.fga > 0 ? Math.round((a.fgm / a.fga) * 1000) / 10 : 0,
      },
    ])
  )
}


export type StatRange = 'season' | 'last30' | 'last10' | 'lastSeason'

// All four research windows in ONE pass over the lines: this calendar
// year's season, the trailing 30 and 10 days, and last calendar year
// (empty until a league carries history — the UI hides it then).
export async function averagesForRanges(
  db: Db,
  leagueId: string,
  now = new Date()
): Promise<Record<StatRange, Record<string, SeasonAvg>>> {
  const rows = (await leagueStatLines(db).where(eq(mnsPlayers.leagueId, leagueId))) as Array<{
    playerId: string
    date: string
    min: number
    pts: number
    reb: number
    ast: number
    stl: number
    blk: number
    tpm: number
    fgm: number
    fga: number
    ftm: number
    fta: number
    tov: number
  }>

  const day = (offset: number) =>
    new Date(now.getTime() - offset * 86400000).toISOString().slice(0, 10)
  const year = String(now.getFullYear())
  const cut30 = day(30)
  const cut10 = day(10)

  type Acc = { gp: number; pts: number; reb: number; ast: number; stl: number; blk: number; tpm: number; fgm: number; fga: number; ftm: number; fta: number; tov: number }
  const zero = (): Acc => ({ gp: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tov: 0 })
  const buckets: Record<StatRange, Map<string, Acc>> = {
    season: new Map(),
    last30: new Map(),
    last10: new Map(),
    lastSeason: new Map(),
  }
  const add = (m: Map<string, Acc>, r: (typeof rows)[number]) => {
    const a = m.get(r.playerId) ?? zero()
    if (r.min > 0) a.gp++
    a.pts += r.pts; a.reb += r.reb; a.ast += r.ast; a.stl += r.stl
    a.blk += r.blk; a.tpm += r.tpm; a.fgm += r.fgm; a.fga += r.fga
    a.ftm += r.ftm; a.fta += r.fta; a.tov += r.tov
    m.set(r.playerId, a)
  }
  for (const r of rows) {
    if (r.date.startsWith(year)) {
      add(buckets.season, r)
      if (r.date >= cut30) add(buckets.last30, r)
      if (r.date >= cut10) add(buckets.last10, r)
    } else if (r.date.startsWith(String(now.getFullYear() - 1))) {
      add(buckets.lastSeason, r)
    }
  }

  const per = (v: number, gp: number) => (gp > 0 ? Math.round((v / gp) * 10) / 10 : 0)
  const finish = (m: Map<string, Acc>): Record<string, SeasonAvg> => {
    const out: Record<string, SeasonAvg> = {}
    // The nine category values per player (ratios from raw sums, the
    // scorer's rule), kept for the z-pass below.
    const vectors = new Map<string, number[]>()
    for (const [id, a] of m) {
      if (a.gp === 0 && a.fga === 0) continue
      out[id] = {
        gp: a.gp,
        ppg: per(a.pts, a.gp),
        rpg: per(a.reb, a.gp),
        apg: per(a.ast, a.gp),
        spg: per(a.stl, a.gp),
        bpg: per(a.blk, a.gp),
        tpg: per(a.tpm, a.gp),
        fgPct: a.fga > 0 ? Math.round((a.fgm / a.fga) * 1000) / 10 : 0,
      }
      if (a.gp > 0) {
        vectors.set(id, [
          a.pts / a.gp,
          a.reb / a.gp,
          a.ast / a.gp,
          a.stl / a.gp,
          a.blk / a.gp,
          a.tpm / a.gp,
          a.fga > 0 ? a.fgm / a.fga : 0,
          a.fta > 0 ? a.ftm / a.fta : 0,
          a.tov > 0 ? a.ast / a.tov : a.ast / a.gp,
        ])
      }
    }
    // Cat Score: z-score each category across everyone who played,
    // average the nine. 0 = league average, +1 = a deviation better.
    const ids = [...vectors.keys()]
    if (ids.length >= 3) {
      const dims = 9
      const mean: number[] = Array(dims).fill(0)
      for (const v of vectors.values()) for (let d = 0; d < dims; d++) mean[d] += v[d]
      for (let d = 0; d < dims; d++) mean[d] /= ids.length
      const sd: number[] = Array(dims).fill(0)
      for (const v of vectors.values())
        for (let d = 0; d < dims; d++) sd[d] += (v[d] - mean[d]) ** 2
      for (let d = 0; d < dims; d++) sd[d] = Math.sqrt(sd[d] / ids.length)
      for (const id of ids) {
        const v = vectors.get(id)!
        let sum = 0
        for (let d = 0; d < dims; d++) sum += sd[d] > 0 ? (v[d] - mean[d]) / sd[d] : 0
        out[id].cat = Math.round((sum / dims) * 100) / 100
      }
    }
    return out
  }
  return {
    season: finish(buckets.season),
    last30: finish(buckets.last30),
    last10: finish(buckets.last10),
    lastSeason: finish(buckets.lastSeason),
  }
}
