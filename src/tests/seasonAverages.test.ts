import { describe, it, expect } from 'vitest'
import { ESPN_ATHLETE_STATS, parseSeasonAverages } from '../lib/season/seasonAverages'
import { sport } from '../lib/sport/index'

// ESPN's real column orders: NBA and WNBA differ, so the parser reads by label.
const NBA_LABELS = ['GP','GS','MIN','FG','FG%','3PT','3P%','FT','FT%','OR','DR','REB','AST','BLK','STL','PF','TO','PTS']
const WNBA_LABELS = ['GP','GS','MIN','PTS','OR','DR','REB','AST','STL','BLK','TO','FG','FG%','3PT','3P%','FT','FT%','PF']

const payload = (labels: string[], seasons: Array<[string, string[]]>) => ({
  categories: [
    { name: 'totals', labels, statistics: [] },
    { name: 'averages', labels, statistics: seasons.map(([displayName, stats]) => ({ season: { displayName }, stats })) },
  ],
})

describe('parseSeasonAverages', () => {
  it('reads an NBA season by label, made-attempted pairs split', () => {
    const p = payload(NBA_LABELS, [
      ['2024-25', ['70','70','36.0','10.0-20.0','50.0','3.0-8.0','37.5','5.0-6.0','83.3','1.0','7.0','8.0','9.0','0.5','1.6','2.0','4.0','28.0']],
      ['2025-26', ['64','64','35.8','11.4-24.0','47.6','3.5-9.6','36.6','7.2-9.2','78.0','0.9','6.8','7.7','8.3','0.5','1.6','2.1','4.0','33.5']],
    ])
    expect(parseSeasonAverages(p, '2025-26')).toEqual({
      label: '2025-26', gp: 64, gs: 64, min: 35.8, pts: 33.5, reb: 7.7, ast: 8.3, stl: 1.6, blk: 0.5, tov: 4.0,
      fgm: 11.4, fga: 24.0, tpm: 3.5, tpa: 9.6, ftm: 7.2, fta: 9.2, fgPct: 47.6, tpPct: 36.6, ftPct: 78.0,
    })
  })
  it('reads a WNBA season with its own column order', () => {
    const p = payload(WNBA_LABELS, [
      ['2025', ['33','33','33.5','23.2','1.5','6.2','7.7','3.5','1.6','1.5','2.1','8.5-16.3','52.1','1.6-4.0','40.0','4.6-5.2','88.4','2.0']],
    ])
    const r = parseSeasonAverages(p, '2025')!
    expect(r.pts).toBe(23.2)
    expect(r.reb).toBe(7.7)
    expect(r.fgm).toBe(8.5)
    expect(r.fga).toBe(16.3)
    expect(r.ftPct).toBe(88.4)
  })
  it('is null when the season or the averages are missing', () => {
    expect(parseSeasonAverages(payload(NBA_LABELS, [['2024-25', []]]), '2025-26')).toBeNull()
    expect(parseSeasonAverages({ categories: [] }, '2025-26')).toBeNull()
    expect(parseSeasonAverages({}, '2025-26')).toBeNull()
  })
  it('reads thousands separators and tolerates blanks', () => {
    const stats = NBA_LABELS.map(() => '')
    stats[NBA_LABELS.indexOf('MIN')] = '1,234.5'
    const r = parseSeasonAverages(payload(NBA_LABELS, [['2025-26', stats]]), '2025-26')!
    expect(r.min).toBe(1234.5)
    expect(r.pts).toBe(0)
  })
})

describe('ESPN_ATHLETE_STATS', () => {
  it('names the sport segment once', () => {
    const url = ESPN_ATHLETE_STATS('3945274')
    expect(url).toBe(`https://site.web.api.espn.com/apis/common/v3/sports/${sport.espn.league}/athletes/3945274/stats`)
    expect(url).not.toMatch(/basketball\/basketball/)
    expect(url).toMatch(/\/sports\/basketball\/(nba|wnba)\/athletes\//)
  })
})
