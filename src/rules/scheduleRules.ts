import type { LeagueConfig } from '../types/leagueConfig'

export interface GeneratedWeek {
  id: string
  leagueId: string
  seasonYear: number
  weekNumber: number
  matchupWeek: number
  startDate: string
  endDate: string
  isTradeDeadlineWeek: boolean
  label: string | null
}

export interface CombinedWeekConfig {
  calendarWeeks: number[]
  label: string
}

// Generate week rows from a league config + an optional list of
// combined weeks (e.g. NBA Cup knockouts, All-Star break). Each week
// is Monday-Sunday (7 days). Post-season playoff weeks are appended
// after the regular-season count.
export function generateWeeks(params: {
  leagueId: string
  config: LeagueConfig
  combinedWeeks?: CombinedWeekConfig[]
}): GeneratedWeek[] {
  const { leagueId, config, combinedWeeks = [] } = params
  const seasonStart = config.season.startDate
  const numWeeks = config.season.weeks
  const seasonYear = config.season.year
  const tradeDeadlineWeek = config.schedule.tradeDeadlineWeek

  if (!seasonStart) return []

  const combinedMap = new Map<number, { matchupWeek: number; label: string }>()
  for (const cw of combinedWeeks) {
    for (const wn of cw.calendarWeeks) {
      combinedMap.set(wn, {
        matchupWeek: cw.calendarWeeks[0],
        label: cw.label,
      })
    }
  }

  const weeks: GeneratedWeek[] = []
  const start = new Date(seasonStart + 'T00:00:00')

  for (let i = 0; i < numWeeks; i++) {
    const weekNum = i + 1
    const weekStart = new Date(start)
    weekStart.setDate(start.getDate() + i * 7)
    const weekEnd = new Date(weekStart)
    weekEnd.setDate(weekStart.getDate() + 6)

    const combined = combinedMap.get(weekNum)

    weeks.push({
      id: `${leagueId}_${seasonYear}_week_${weekNum}`,
      leagueId,
      seasonYear,
      weekNumber: weekNum,
      matchupWeek: combined ? combined.matchupWeek : weekNum,
      startDate: weekStart.toISOString().slice(0, 10),
      endDate: weekEnd.toISOString().slice(0, 10),
      isTradeDeadlineWeek: weekNum === tradeDeadlineWeek,
      label: combined ? combined.label : null,
    })
  }

  const playoffWeeks = config.schedule.playoffWeeks
  const consolationWeeks = config.schedule.consolationWeeks
  if (playoffWeeks > 0 || consolationWeeks > 0) {
    const postSeasonWeeks = Math.max(playoffWeeks, consolationWeeks)
    const playoffLabels = ['Round 1', 'Quarterfinals', 'Semifinals', 'Finals']
    const labels = playoffLabels.slice(
      Math.max(0, playoffLabels.length - playoffWeeks)
    )

    for (let p = 0; p < postSeasonWeeks; p++) {
      const weekNum = numWeeks + p + 1
      const weekStart = new Date(start)
      weekStart.setDate(start.getDate() + (numWeeks + p) * 7)
      const weekEnd = new Date(weekStart)
      weekEnd.setDate(weekStart.getDate() + 6)

      const isPlayoffWeek = p < playoffWeeks
      let label: string
      if (isPlayoffWeek) {
        label = labels[p] ?? 'Playoffs'
      } else {
        label = 'Consolation'
      }

      weeks.push({
        id: `${leagueId}_${seasonYear}_week_${weekNum}`,
        leagueId,
        seasonYear,
        weekNumber: weekNum,
        matchupWeek: weekNum,
        startDate: weekStart.toISOString().slice(0, 10),
        endDate: weekEnd.toISOString().slice(0, 10),
        isTradeDeadlineWeek: false,
        label,
      })
    }
  }

  return weeks
}

export function getCurrentWeek(
  weeks: GeneratedWeek[],
  today: Date = new Date()
): number | null {
  if (weeks.length === 0) return null
  const todayStr = today.toISOString().slice(0, 10)

  for (const week of weeks) {
    if (todayStr >= week.startDate && todayStr <= week.endDate) {
      return week.weekNumber
    }
  }

  const sorted = [...weeks].sort((a, b) => a.weekNumber - b.weekNumber)
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (todayStr < first.startDate) return null
  if (todayStr > last.endDate) return last.weekNumber
  return null
}

export function formatCountdown(
  targetDate: string,
  now: Date = new Date()
): string {
  const todayStr =
    now.getFullYear() +
    '-' +
    String(now.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(now.getDate()).padStart(2, '0')

  if (targetDate < todayStr) return 'Passed'
  if (targetDate === todayStr) return 'Today'

  const target = new Date(targetDate + 'T00:00:00')
  const today = new Date(todayStr + 'T00:00:00')
  const diffDays = Math.round(
    (target.getTime() - today.getTime()) / 86_400_000
  )

  if (diffDays === 1) return '1 day'
  if (diffDays < 7) return `${diffDays} days`
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7)
    return weeks === 1 ? '1 week' : `${weeks} weeks`
  }
  const months = Math.floor(diffDays / 30)
  return months === 1 ? '1 month' : `${months} months`
}

export function computePlayoffDefaults(playoffTeams: number): {
  weeks: number
  byes: number
} {
  if (playoffTeams <= 1) return { weeks: 0, byes: 0 }
  const weeks = Math.ceil(Math.log2(playoffTeams))
  const bracketSize = Math.pow(2, weeks)
  const byes = bracketSize - playoffTeams
  return { weeks, byes }
}


// ── The season calendar, in a league's own weeks ───────────────────

export interface GameDay {
  date: string
  games: number
  teams: string[]
}

export interface CalendarWeek {
  // 1-based league week number (calendar week, before any combining).
  week: number
  startDate: string
  endDate: string
  games: number
  // Mean games per club over the clubs the season knows.
  avgPerTeam: number
  // Clubs with at most one game this week.
  teamsLight: number
  zeroDays: string[]
}

const shift = (date: string, days: number) =>
  new Date(new Date(`${date}T12:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10)

// Sum per-day counts into weeks that start on the league's own start
// date (seven days each), for the regular season plus the playoffs.
export function summarizeWeeks(
  days: GameDay[],
  startDate: string,
  numWeeks: number
): CalendarWeek[] {
  const byDate = new Map(days.map((d) => [d.date, d]))
  // The clubs that really play the season: a code that shows up only a
  // handful of times is an All-Star squad or a "TBD" playoff slot, and
  // must not dilute the per-club average.
  const seen = new Map<string, number>()
  for (const d of days) for (const t of d.teams) seen.set(t, (seen.get(t) ?? 0) + 1)
  const most = Math.max(0, ...seen.values())
  const clubs = new Set([...seen.entries()].filter(([, n]) => n >= most * 0.25).map(([t]) => t))
  const nClubs = Math.max(1, clubs.size)
  const out: CalendarWeek[] = []
  for (let i = 0; i < numWeeks; i++) {
    const start = shift(startDate, i * 7)
    const end = shift(start, 6)
    let games = 0
    const perClub = new Map<string, number>()
    const zeroDays: string[] = []
    for (let k = 0; k < 7; k++) {
      const date = shift(start, k)
      const d = byDate.get(date)
      if (!d || d.games === 0) zeroDays.push(date)
      if (!d) continue
      games += d.games
      for (const t of d.teams) if (clubs.has(t)) perClub.set(t, (perClub.get(t) ?? 0) + 1)
    }
    const appearances = [...perClub.values()].reduce((a, b) => a + b, 0)
    const teamsLight = nClubs - [...perClub.values()].filter((n) => n >= 2).length
    out.push({
      week: i + 1,
      startDate: start,
      endDate: end,
      games,
      avgPerTeam: Math.round((appearances / nClubs) * 100) / 100,
      teamsLight,
      zeroDays,
    })
  }
  return out
}

export interface WeekSuggestion {
  kind: 'combine' | 'no_games'
  calendarWeeks: number[]
  label: string
  reason: string
}

// A week is LIGHT when its games per club fall well under the season's
// typical week (under 70% of the median). Consecutive light weeks fold
// together; a lone light week folds into its emptier neighbour — only
// within the regular season (the first `regularWeeks`). Weeks with no
// games at all are never folded, playoff weeks included: they are a
// warning — end the regular season before them or run the playoffs
// after. A championship scheduled into a blackout is the one mistake
// this exists to catch.
export function suggestCombinedWeeks(weeks: CalendarWeek[], regularWeeks = weeks.length): WeekSuggestion[] {
  const played = weeks.filter((w) => w.games > 0).map((w) => w.avgPerTeam).sort((a, b) => a - b)
  if (played.length === 0) return []
  const median = played[Math.floor(played.length / 2)]
  const isLight = (w: CalendarWeek) => w.week <= regularWeeks && w.games > 0 && w.avgPerTeam < median * 0.7
  const isZero = (w: CalendarWeek) => w.games === 0
  const fmt = (d: string) => {
    const [, m, day] = d.split('-')
    return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]} ${Number(day)}`
  }
  const span = (a: CalendarWeek, b: CalendarWeek) => `${fmt(a.startDate)} – ${fmt(b.endDate)}`

  const out: WeekSuggestion[] = []
  const taken = new Set<number>()
  let i = 0
  while (i < weeks.length) {
    const w = weeks[i]
    if (isZero(w)) {
      let j = i
      while (j + 1 < weeks.length && isZero(weeks[j + 1])) j++
      const run = weeks.slice(i, j + 1)
      out.push({
        kind: 'no_games',
        calendarWeeks: run.map((x) => x.week),
        label: `No games ${span(run[0], run[run.length - 1])}`,
        reason:
          run.length === 1
            ? 'A week with no games cannot be a matchup week — end the regular season before it, or schedule the playoffs after it.'
            : `${run.length} straight weeks with no games — end the regular season before them, or schedule the playoffs after.`,
      })
      i = j + 1
      continue
    }
    if (isLight(w) && !taken.has(w.week)) {
      let j = i
      while (j + 1 < weeks.length && isLight(weeks[j + 1])) j++
      let run = weeks.slice(i, j + 1)
      if (run.length === 1) {
        // Fold into the emptier playable neighbour.
        const prev = i > 0 && !isZero(weeks[i - 1]) && !taken.has(weeks[i - 1].week) ? weeks[i - 1] : null
        const next =
          i + 1 < weeks.length && weeks[i + 1].week <= regularWeeks && !isZero(weeks[i + 1]) ? weeks[i + 1] : null
        const partner =
          prev && next ? (prev.games <= next.games ? prev : next) : (prev ?? next)
        if (partner) run = [w, partner].sort((a, b) => a.week - b.week)
      }
      if (run.length >= 2) {
        for (const x of run) taken.add(x.week)
        out.push({
          kind: 'combine',
          calendarWeeks: run.map((x) => x.week),
          label: `Combine weeks ${run[0].week}–${run[run.length - 1].week} (${span(run[0], run[run.length - 1])})`,
          reason: `${run.map((x) => `${x.avgPerTeam}`).join(' and ')} games per club, against ${median} in a normal week.`,
        })
      }
      i = j + 1
      continue
    }
    i++
  }
  return out
}
