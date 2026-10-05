import { describe, expect, it } from 'vitest'
import { summarizeWeeks, suggestCombinedWeeks, type CalendarWeek, type GameDay } from '../rules/scheduleRules'

const day = (date: string, games: number, teams: string[]): GameDay => ({ date, games, teams })

describe('summarizeWeeks — the sport calendar in a league\'s own weeks', () => {
  it('sums seven days from the league start date, per club, with the empty days named', () => {
    const days = [
      day('2026-10-20', 2, ['BOS', 'DET', 'PHI', 'NY']),
      day('2026-10-21', 1, ['OKC', 'SA']),
      day('2026-10-27', 3, ['BOS', 'DET', 'PHI', 'NY', 'OKC', 'SA']),
    ]
    const weeks = summarizeWeeks(days, '2026-10-20', 2)
    expect(weeks[0]).toMatchObject({ week: 1, startDate: '2026-10-20', endDate: '2026-10-26', games: 3 })
    // six clubs known, six appearances in week one → 1.0 per club; all six light (≤1 game)
    expect(weeks[0].avgPerTeam).toBe(1)
    expect(weeks[0].teamsLight).toBe(6)
    expect(weeks[0].zeroDays).toEqual(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26'])
    expect(weeks[1]).toMatchObject({ week: 2, startDate: '2026-10-27', games: 3 })
  })
})

const wk = (week: number, avgPerTeam: number, games = Math.round(avgPerTeam * 15)): CalendarWeek => ({
  week,
  startDate: `2026-11-${String(week).padStart(2, '0')}`,
  endDate: `2026-11-${String(week + 6).padStart(2, '0')}`,
  games,
  avgPerTeam,
  teamsLight: 0,
  zeroDays: [],
})

describe('suggestCombinedWeeks — measured from the 2026-27 NBA and 2026 WNBA schedules', () => {
  it('NBA: folds the two Cup weeks together and the two All-Star weeks together, nothing else', () => {
    // games per club per week, Oct 19 → Apr 11, from ESPN on Oct 5 2026
    const avgs = [2.87, 3.27, 3.6, 3.4, 3.4, 3.2, 2.0, 1.0, 3.67, 3.53, 3.47, 3.6, 3.47, 3.47, 3.6, 3.6, 3.53, 2.0, 2.13, 3.27, 3.53, 3.47, 3.6, 3.67, 3.8]
    const s = suggestCombinedWeeks(avgs.map((a, i) => wk(i + 1, a)))
    expect(s.map((x) => [x.kind, x.calendarWeeks])).toEqual([
      ['combine', [7, 8]],
      ['combine', [18, 19]],
    ])
  })
  it('WNBA: a lone light week folds into its emptier neighbour; the FIBA weeks, even as playoff weeks, are a warning, not a fold', () => {
    const avgs = [2.27, 2.4, 2.27, 2.53, 2.67, 2.67, 2.93, 1.33, 2.8, 2.53, 1.47, 2.53, 2.8, 2.53, 2.67, 2.53, 0, 0]
    // sixteen regular weeks; the two dead weeks are where the playoffs would land
    const s = suggestCombinedWeeks(avgs.map((a, i) => wk(i + 1, a, a === 0 ? 0 : Math.round(a * 15))), 16)
    expect(s.map((x) => [x.kind, x.calendarWeeks])).toEqual([
      ['combine', [8, 9]], // Jun 29 folds forward: Jul 6 (2.8, 42 games) is emptier than Jun 22 (2.93, 44)
      ['combine', [10, 11]], // Jul 20 folds back: both neighbours have 38 games, ties go to the earlier week
      ['no_games', [17, 18]],
    ])
    expect(s[2].reason).toMatch(/2 straight weeks with no games/)
  })
  it('a normal season suggests nothing', () => {
    expect(suggestCombinedWeeks([3.4, 3.5, 3.6, 3.4].map((a, i) => wk(i + 1, a)))).toEqual([])
  })
})

describe('suggestCombinedWeeks — the regular season ends in a light week', () => {
  it('never folds a regular week into a playoff week', () => {
    const weeks = [3.4, 3.5, 3.6, 1.2, 3.5].map((a, i) => wk(i + 1, a))
    // four regular weeks, the fifth is playoffs: week 4 can only fold back into 3
    expect(suggestCombinedWeeks(weeks, 4).map((x) => x.calendarWeeks)).toEqual([[3, 4]])
  })
})
