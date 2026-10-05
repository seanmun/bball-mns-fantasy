import { sport } from '../sport/index.js'

// ESPN's public site API for this sport, and the small pure helpers
// every pass shares. Nothing here touches the database.

export const ESPN_BASE = `https://site.api.espn.com/apis/site/v2/sports/${sport.espn.league}`
export const ESPN_SCOREBOARD = `${ESPN_BASE}/scoreboard`

// ESPN's team-code spelling -> ours, per sport.
export const CODE_ALIAS: Record<string, string> = sport.espn.codeAlias
export const ourCode = (espnAbbreviation: string): string =>
  sport.espn.codeAlias[espnAbbreviation] ?? espnAbbreviation

export function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// "5-10" -> [5, 10]; anything else -> [0, 0].
export function pair(v: string): [number, number] {
  const m = v.match(/^(\d+)-(\d+)$/)
  return m ? [Number(m[1]), Number(m[2])] : [0, 0]
}

export interface EspnContract {
  salary?: number
  season?: { year?: number }
  year?: number
}

// The contract that pays THIS season, by ESPN's season year — never
// contracts[0], which is simply the latest one listed.
export function contractSalaryFor(
  contracts: EspnContract[] | undefined | null,
  seasonYear: number
): number | null {
  for (const c of contracts ?? []) {
    const year = c.season?.year ?? c.year
    if (year === seasonYear && typeof c.salary === 'number' && c.salary > 0) return c.salary
  }
  return null
}

// Salary a player carries: the contract when ESPN has one, else the
// sport's league minimum when it defines one, else nothing (0).
export function salaryFor(
  contracts: EspnContract[] | undefined | null,
  seasonYear: number,
  minimum: number | undefined
): { salary: number; source: 'espn-contract' | 'league-minimum' | 'unknown' } {
  const contract = contractSalaryFor(contracts, seasonYear)
  if (contract != null) return { salary: contract, source: 'espn-contract' }
  if (minimum && minimum > 0) return { salary: minimum, source: 'league-minimum' }
  return { salary: 0, source: 'unknown' }
}

// The injuries feed names athletes without an id; their player-card
// link carries it: .../player/_/id/5105571/henri-veesaar
export function athleteIdFromLinks(links: Array<{ href?: string }> | undefined | null): string | null {
  for (const l of links ?? []) {
    const m = l.href?.match(/\/id\/(\d+)(?:\/|$)/)
    if (m) return m[1]
  }
  return null
}

export function ageFrom(dateOfBirth: string | undefined | null, now = new Date()): number | null {
  if (!dateOfBirth) return null
  const dob = new Date(dateOfBirth)
  if (Number.isNaN(dob.getTime())) return null
  let age = now.getUTCFullYear() - dob.getUTCFullYear()
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate())
  if (beforeBirthday) age--
  return age
}

export interface BoxLine {
  playerId: string
  name: string
  teamAbbreviation: string | null
  min: number
  pts: number
  fgm: number
  fga: number
  ftm: number
  fta: number
  tpm: number
  reb: number
  ast: number
  stl: number
  blk: number
  tov: number
}

export interface EspnSummary {
  boxscore?: {
    players?: Array<{
      team?: { abbreviation?: string }
      statistics?: Array<{
        names: string[]
        athletes: Array<{ athlete: { id: string; displayName: string }; stats: string[] }>
      }>
    }>
  }
}

// One game's box, both teams, keyed by ESPN athlete id. DNP rows
// (empty stats) are skipped.
export function parseBox(summary: EspnSummary): BoxLine[] {
  const out: BoxLine[] = []
  for (const teamBox of summary.boxscore?.players ?? []) {
    const stats = teamBox.statistics?.[0]
    if (!stats) continue
    const col = (name: string) => stats.names.indexOf(name)
    const iMin = col('MIN'), iPts = col('PTS'), iFg = col('FG'), i3 = col('3PT'), iFt = col('FT')
    const iReb = col('REB'), iAst = col('AST'), iTo = col('TO'), iStl = col('STL'), iBlk = col('BLK')
    for (const a of stats.athletes) {
      const s = a.stats
      if (!s || s.length === 0 || !a.athlete?.id) continue
      const [fgm, fga] = pair(s[iFg] ?? '')
      const [tpm] = pair(s[i3] ?? '')
      const [ftm, fta] = pair(s[iFt] ?? '')
      out.push({
        playerId: String(a.athlete.id),
        name: a.athlete.displayName,
        teamAbbreviation: teamBox.team?.abbreviation ?? null,
        min: Number(s[iMin]) || 0,
        pts: Number(s[iPts]) || 0,
        fgm, fga, ftm, fta, tpm,
        reb: Number(s[iReb]) || 0,
        ast: Number(s[iAst]) || 0,
        stl: Number(s[iStl]) || 0,
        blk: Number(s[iBlk]) || 0,
        tov: Number(s[iTo]) || 0,
      })
    }
  }
  return out
}

export async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`)
  return (await res.json()) as T
}
