import { and, eq } from 'drizzle-orm'
import { mnsPlayers, mnsSportSeasonAverages } from '../db/schema.js'
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
  mpg?: number
  tov?: number
  ftPct?: number
  /** 3P% — only where the source carries attempts (the per-season table). */
  tpPct?: number
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
  now = new Date(),
  // The league's season year: last season is the one before it, read
  // from the sport's per-season averages when no prior-year box scores
  // are on file (a sport's first year here).
  seasonYear?: number
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

  type Acc = { gp: number; min: number; pts: number; reb: number; ast: number; stl: number; blk: number; tpm: number; fgm: number; fga: number; ftm: number; fta: number; tov: number }
  const zero = (): Acc => ({ gp: 0, min: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tov: 0 })
  const buckets: Record<StatRange, Map<string, Acc>> = {
    season: new Map(),
    last30: new Map(),
    last10: new Map(),
    lastSeason: new Map(),
  }
  const add = (m: Map<string, Acc>, r: (typeof rows)[number]) => {
    const a = m.get(r.playerId) ?? zero()
    if (r.min > 0) a.gp++
    a.min += r.min
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
        mpg: per(a.min, a.gp),
        tov: per(a.tov, a.gp),
        ftPct: a.fta > 0 ? Math.round((a.ftm / a.fta) * 1000) / 10 : 0,
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
    for (const [id, cat] of catScores(vectors)) out[id].cat = cat
    return out
  }
  const ranges = {
    season: finish(buckets.season),
    last30: finish(buckets.last30),
    last10: finish(buckets.last10),
    lastSeason: finish(buckets.lastSeason),
  }
  if (Object.keys(ranges.lastSeason).length === 0 && seasonYear) {
    ranges.lastSeason = await lastSeasonFromAverages(db, leagueId, seasonYear - 1)
  }
  return ranges
}

// Cat Score: z-score each category across everyone who played, average
// the nine. 0 = league average, +1 = a deviation better.
export function catScores(vectors: Map<string, number[]>): Map<string, number> {
  const ids = [...vectors.keys()]
  const out = new Map<string, number>()
  if (ids.length < 3) return out
  const dims = 9
  const mean: number[] = Array(dims).fill(0)
  for (const v of vectors.values()) for (let d = 0; d < dims; d++) mean[d] += v[d]
  for (let d = 0; d < dims; d++) mean[d] /= ids.length
  const sd: number[] = Array(dims).fill(0)
  for (const v of vectors.values()) for (let d = 0; d < dims; d++) sd[d] += (v[d] - mean[d]) ** 2
  for (let d = 0; d < dims; d++) sd[d] = Math.sqrt(sd[d] / ids.length)
  for (const id of ids) {
    const v = vectors.get(id)!
    let sum = 0
    for (let d = 0; d < dims; d++) sum += sd[d] > 0 ? (v[d] - mean[d]) / sd[d] : 0
    out.set(id, Math.round((sum / dims) * 100) / 100)
  }
  return out
}

// Last season's averages for a league's players, from the sport's
// per-season table, keyed by LEAGUE player id, with the Cat Score
// against the league's own pool.
export async function lastSeasonFromAverages(
  db: Db,
  leagueId: string,
  seasonYear: number
): Promise<Record<string, SeasonAvg>> {
  const rows = (await db
    .select({
      id: mnsPlayers.id,
      gp: mnsSportSeasonAverages.gp,
      min: mnsSportSeasonAverages.min,
      pts: mnsSportSeasonAverages.pts,
      reb: mnsSportSeasonAverages.reb,
      ast: mnsSportSeasonAverages.ast,
      stl: mnsSportSeasonAverages.stl,
      blk: mnsSportSeasonAverages.blk,
      tov: mnsSportSeasonAverages.tov,
      tpm: mnsSportSeasonAverages.tpm,
      fgm: mnsSportSeasonAverages.fgm,
      fga: mnsSportSeasonAverages.fga,
      ftm: mnsSportSeasonAverages.ftm,
      fta: mnsSportSeasonAverages.fta,
      fgPct: mnsSportSeasonAverages.fgPct,
      tpPct: mnsSportSeasonAverages.tpPct,
      ftPct: mnsSportSeasonAverages.ftPct,
    })
    .from(mnsPlayers)
    .innerJoin(
      mnsSportSeasonAverages,
      and(
        eq(mnsSportSeasonAverages.playerId, mnsPlayers.sportPlayerId),
        eq(mnsSportSeasonAverages.seasonYear, seasonYear)
      )
    )
    .where(eq(mnsPlayers.leagueId, leagueId))) as Array<{
    id: string; gp: number; min: number; pts: number; reb: number; ast: number; stl: number; blk: number
    tov: number; tpm: number; fgm: number; fga: number; ftm: number; fta: number; fgPct: number; tpPct: number; ftPct: number
  }>
  const out: Record<string, SeasonAvg> = {}
  const vectors = new Map<string, number[]>()
  for (const r of rows) {
    if (r.gp === 0) continue
    out[r.id] = {
      gp: r.gp, ppg: r.pts, rpg: r.reb, apg: r.ast, spg: r.stl, bpg: r.blk, tpg: r.tpm, fgPct: r.fgPct,
      mpg: r.min, tov: r.tov, ftPct: r.ftPct, tpPct: r.tpPct,
    }
    vectors.set(r.id, [
      r.pts, r.reb, r.ast, r.stl, r.blk, r.tpm,
      r.fga > 0 ? r.fgm / r.fga : 0,
      r.fta > 0 ? r.ftm / r.fta : 0,
      r.tov > 0 ? r.ast / r.tov : r.ast,
    ])
  }
  for (const [id, cat] of catScores(vectors)) out[id].cat = cat
  return out
}
