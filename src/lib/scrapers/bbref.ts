// NBA salaries from Basketball-Reference's contracts page: one table,
// every player under contract, a column per season. ESPN's roster feed
// lists past contract years and often not the coming one (Reaves,
// Kessler, Grimes stopped at 2026 while signed through 2029), which
// sent half the league to the minimum. One page, read once a week.

export const BBREF_CONTRACTS_URL = 'https://www.basketball-reference.com/contracts/players.html'

// Basketball-Reference's club codes where they differ from ESPN's.
const CODE_ALIAS: Record<string, string> = {
  BRK: 'BKN', CHO: 'CHA', GSW: 'GS', NOP: 'NO', NYK: 'NY', PHO: 'PHX', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH',
}
export const bbrefCode = (code: string): string => CODE_ALIAS[code] ?? code

export interface BbrefContract {
  name: string
  team: string // our code
  salary: number // this season
  // Every season the page lists, by label ("2027-28" → dollars), and
  // what is guaranteed — the full contract, for the player card.
  seasons: Record<string, number>
  guaranteed: number | null
}

const strip = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
const money = (s: string): number | null => {
  const m = s.replace(/[$,\s]/g, '')
  if (!/^\d+$/.test(m)) return null
  return Number(m)
}

// The season column is found by its header text ("2026-27"), never by
// position: the page shifts a column every summer.
export function parseBbrefContracts(
  html: string,
  seasonLabel: string
): { players: BbrefContract[]; column: string | null } {
  const thead = html.match(/<thead>([\s\S]*?)<\/thead>/)?.[1] ?? ''
  // Season columns by label; the one asked for is this season's.
  const seasonColumns: Array<[string, string]> = []
  let column: string | null = null
  for (const m of thead.matchAll(/<th[^>]*data-stat="([^"]+)"[^>]*>([\s\S]*?)<\/th>/g)) {
    const label = strip(m[2])
    if (/^\d{4}-\d{2}$/.test(label)) seasonColumns.push([m[1], label])
    if (label === seasonLabel) column = m[1]
  }
  if (!column) return { players: [], column: null }
  const players: BbrefContract[] = []
  for (const row of html.matchAll(/<tr[^>]*>(<th[^>]*data-stat="ranker"[\s\S]*?)<\/tr>/g)) {
    const cells: Record<string, string> = {}
    for (const c of row[1].matchAll(/<t[dh][^>]*data-stat="([^"]+)"[^>]*>([\s\S]*?)<\/t[dh]>/g)) {
      cells[c[1]] = strip(c[2])
    }
    const name = cells.player
    const salary = money(cells[column] ?? '')
    if (!name || salary == null || salary <= 0) continue
    const seasons: Record<string, number> = {}
    for (const [key, label] of seasonColumns) {
      const v = money(cells[key] ?? '')
      if (v != null && v > 0) seasons[label] = v
    }
    players.push({
      name,
      team: bbrefCode(cells.team_id ?? ''),
      salary,
      seasons,
      guaranteed: money(cells.remain_gtd ?? ''),
    })
  }
  return { players, column }
}

// Names on the two sites differ by suffix ("Ronald Holland II" vs "Ron
// Holland") and nickname; the club breaks ties. Returns the id of the
// one player it is sure of, else null.
const SUFFIX = /\b(jr|sr|ii|iii|iv)\b/g
const NICK: Record<string, string> = { ron: 'ronald', rob: 'robert', bob: 'robert', mike: 'michael', nick: 'nicolas', cam: 'cameron', pj: 'pj' }
export const looseName = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(SUFFIX, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w, i) => (i === 0 && NICK[w] ? NICK[w] : w))
    .join(' ')

export function matchBbrefPlayer(
  contract: { name: string; team: string },
  pool: Array<{ id: string; name: string; teamCode: string }>
): string | null {
  const key = looseName(contract.name)
  const exact = pool.filter((p) => looseName(p.name) === key)
  if (exact.length === 1) return exact[0].id
  if (exact.length > 1) return exact.find((p) => p.teamCode === contract.team)?.id ?? null
  // Same club, same last name, first name starting the same way.
  const [first, ...rest] = key.split(' ')
  const lastName = rest.at(-1) ?? ''
  const near = pool.filter((p) => {
    const k = looseName(p.name).split(' ')
    return p.teamCode === contract.team && k.at(-1) === lastName && k[0].startsWith(first.slice(0, 3))
  })
  return near.length === 1 ? near[0].id : null
}

export async function scrapeBbrefContracts(
  seasonLabel: string
): Promise<{ players: BbrefContract[]; column: string | null; sourceStatus: { status: number; bytes: number } }> {
  const res = await fetch(BBREF_CONTRACTS_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MNS-FantasyApp/1.0)' },
  })
  const html = await res.text()
  if (!res.ok) throw new Error(`basketball-reference ${res.status}`)
  const parsed = parseBbrefContracts(html, seasonLabel)
  return { ...parsed, sourceStatus: { status: res.status, bytes: html.length } }
}
