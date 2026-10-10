import { and, eq, isNotNull, sql } from 'drizzle-orm'
import { mnsSportPlayers, mnsSportSeasonAverages } from '../db/schema.js'
import { sport } from '../sport/index.js'
import { fetchJson } from './espn.js'

// Last season's line for every player, pulled ONCE per sport from
// ESPN's per-athlete season averages and kept on the sport tables.
// Keeper season happens in October, before a box score of the new
// year exists, and the decision needs numbers.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export const ESPN_ATHLETE_STATS = (espnId: string) =>
  // sport.espn.league is already "basketball/nba" (the same segment ESPN_BASE uses).
  `https://site.web.api.espn.com/apis/common/v3/sports/${sport.espn.league}/athletes/${espnId}/stats`

export interface SeasonAverageRow {
  label: string
  gp: number
  gs: number
  min: number
  pts: number
  reb: number
  ast: number
  stl: number
  blk: number
  tov: number
  fgm: number
  fga: number
  tpm: number
  tpa: number
  ftm: number
  fta: number
  fgPct: number
  tpPct: number
  ftPct: number
}

interface EspnStatsPayload {
  categories?: Array<{
    name?: string
    labels?: string[]
    statistics?: Array<{
      season?: { displayName?: string; year?: number }
      stats?: string[]
    }>
  }>
}

const num = (v: string | undefined): number => {
  if (v == null) return 0
  const n = Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}
// "11.4-24.0" → made, attempted
const made = (v: string | undefined): [number, number] => {
  const [m, a] = String(v ?? '').split('-')
  return [num(m), num(a)]
}

// Career games: every season row's GP, summed. A player ESPN lists
// with no seasons has played none.
export function careerGames(payload: EspnStatsPayload): number {
  const cat = payload.categories?.find((c) => c.name === 'averages')
  if (!cat?.labels || !cat.statistics) return 0
  const gpAt = cat.labels.indexOf('GP')
  if (gpAt < 0) return 0
  return cat.statistics
    .filter((s) => /\d/.test(s.season?.displayName ?? ''))
    .reduce((n, s) => n + num(s.stats?.[gpAt]), 0)
}

// ESPN labels its columns; the order differs by sport, so read by name.
export function parseSeasonAverages(
  payload: EspnStatsPayload,
  label: string
): SeasonAverageRow | null {
  const cat = payload.categories?.find((c) => c.name === 'averages')
  if (!cat?.labels || !cat.statistics) return null
  const season = cat.statistics.find((s) => s.season?.displayName === label)
  if (!season?.stats) return null
  const at = (name: string) => {
    const i = cat.labels!.indexOf(name)
    return i >= 0 ? season.stats![i] : undefined
  }
  const [fgm, fga] = made(at('FG'))
  const [tpm, tpa] = made(at('3PT'))
  const [ftm, fta] = made(at('FT'))
  return {
    label,
    gp: num(at('GP')),
    gs: num(at('GS')),
    min: num(at('MIN')),
    pts: num(at('PTS')),
    reb: num(at('REB')),
    ast: num(at('AST')),
    stl: num(at('STL')),
    blk: num(at('BLK')),
    tov: num(at('TO')),
    fgm,
    fga,
    tpm,
    tpa,
    ftm,
    fta,
    fgPct: num(at('FG%')),
    tpPct: num(at('3P%')),
    ftPct: num(at('FT%')),
  }
}

// Fill the table for one season: every sport player with an ESPN id
// and no row yet, `limit` at a time (the tick takes a slice per run;
// the script takes everyone). A player ESPN has no line for gets a
// zero row, so she is not asked for again.
export async function syncSeasonAverages(
  db: Db,
  seasonYear: number,
  opts: { limit?: number; concurrency?: number; refresh?: boolean } = {}
): Promise<{ seasonYear: number; label: string; fetched: number; withLine: number; remaining: number }> {
  const label = sport.espnSeasonLabel(seasonYear)
  const limit = opts.limit ?? 60
  const concurrency = opts.concurrency ?? 4
  // Players still without a row for this season — or, on refresh,
  // everyone with an ESPN id.
  const pending = (await db
    .select({ id: mnsSportPlayers.id, espnId: mnsSportPlayers.espnId })
    .from(mnsSportPlayers)
    .leftJoin(
      mnsSportSeasonAverages,
      and(
        eq(mnsSportSeasonAverages.playerId, mnsSportPlayers.id),
        eq(mnsSportSeasonAverages.seasonYear, seasonYear)
      )
    )
    .where(
      opts.refresh
        ? isNotNull(mnsSportPlayers.espnId)
        : and(isNotNull(mnsSportPlayers.espnId), sql`${mnsSportSeasonAverages.playerId} is null`)
    )
    .orderBy(mnsSportPlayers.id)
    .limit(limit + 1)) as Array<{ id: string; espnId: string }>
  const batch = pending.slice(0, limit)
  let withLine = 0
  const now = new Date()
  for (let i = 0; i < batch.length; i += concurrency) {
    const rows = await Promise.all(
      batch.slice(i, i + concurrency).map(async (p) => {
        const payload = await fetchJson<EspnStatsPayload>(ESPN_ATHLETE_STATS(p.espnId)).catch(() => null)
        const line = payload ? parseSeasonAverages(payload, label) : null
        if (line) withLine++
        const z: SeasonAverageRow = line ?? {
          label, gp: 0, gs: 0, min: 0, pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0,
          fgm: 0, fga: 0, tpm: 0, tpa: 0, ftm: 0, fta: 0, fgPct: 0, tpPct: 0, ftPct: 0,
        }
        // Career games ride along from the same payload; a failed fetch
        // leaves what was known.
        if (payload) {
          await db
            .update(mnsSportPlayers)
            .set({ careerGp: careerGames(payload), updatedAt: now })
            .where(eq(mnsSportPlayers.id, p.id))
        }
        return { playerId: p.id, seasonYear, ...z, fetchedAt: now }
      })
    )
    if (rows.length > 0) {
      await db
        .insert(mnsSportSeasonAverages)
        .values(rows)
        .onConflictDoUpdate({
          target: [mnsSportSeasonAverages.playerId, mnsSportSeasonAverages.seasonYear],
          set: {
            label: sql`excluded.label`, gp: sql`excluded.gp`, gs: sql`excluded.gs`, min: sql`excluded.min`,
            pts: sql`excluded.pts`, reb: sql`excluded.reb`, ast: sql`excluded.ast`, stl: sql`excluded.stl`,
            blk: sql`excluded.blk`, tov: sql`excluded.tov`, fgm: sql`excluded.fgm`, fga: sql`excluded.fga`,
            tpm: sql`excluded.tpm`, tpa: sql`excluded.tpa`, ftm: sql`excluded.ftm`, fta: sql`excluded.fta`,
            fgPct: sql`excluded.fg_pct`, tpPct: sql`excluded.tp_pct`, ftPct: sql`excluded.ft_pct`,
            fetchedAt: sql`excluded.fetched_at`,
          },
        })
    }
  }
  return {
    seasonYear,
    label,
    fetched: batch.length,
    withLine,
    remaining: Math.max(0, pending.length - batch.length),
  }
}
