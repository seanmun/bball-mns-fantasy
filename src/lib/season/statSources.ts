import { CODE_ALIAS, ESPN_BASE, ESPN_SCOREBOARD } from './espn.js'

// The day's schedule from ESPN, for the lineup page, the tip-off lock
// and the pre-tip warnings. Everything else ESPN once did here —
// rosters, injuries, box scores — now happens ONCE per sport in
// sportSync.ts and lands in the sport tables; no league reads ESPN.
export { CODE_ALIAS, ESPN_SCOREBOARD }
const ESPN = ESPN_BASE

export interface DayGame {
  opp: string
  home: boolean
  tip: string // ISO kickoff
  state: 'pre' | 'in' | 'post'
}

// Who plays on an Eastern date, keyed by OUR team code. Empty map on
// any ESPN hiccup — the lineup page then just shows no game notes.
export async function dayGames(date: string): Promise<Map<string, DayGame>> {
  try {
    const yyyymmdd = date.replace(/-/g, '')
    const board = (await (await fetch(`${ESPN}/scoreboard?dates=${yyyymmdd}`)).json()) as {
      events?: Array<{
        date: string
        status: { type: { state: string } }
        competitions?: Array<{
          competitors?: Array<{ homeAway: string; team: { abbreviation: string } }>
        }>
      }>
    }
    const map = new Map<string, DayGame>()
    for (const e of board.events ?? []) {
      const comps = e.competitions?.[0]?.competitors ?? []
      const sides = comps.map((c) => ({
        code: CODE_ALIAS[c.team.abbreviation] ?? c.team.abbreviation,
        home: c.homeAway === 'home',
      }))
      for (const side of sides) {
        const opp = sides.find((x) => x.code !== side.code)
        map.set(side.code, {
          opp: opp?.code ?? '',
          home: side.home,
          tip: e.date,
          state: (e.status.type.state as DayGame['state']) ?? 'pre',
        })
      }
    }
    return map
  } catch {
    return new Map()
  }
}
