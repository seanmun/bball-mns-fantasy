import { describe, it, expect } from 'vitest'
import { bbrefCode, looseName, matchBbrefPlayer, parseBbrefContracts } from '../lib/scrapers/bbref'

const page = `
<table id="player-contracts"><thead>
<tr class="over_header"><th colspan="3"></th><th colspan="6" data-stat="header_salary">Salary</th></tr>
<tr><th data-stat="ranker">Rk</th><th data-stat="player">Player</th><th data-stat="team_id">Tm</th>
<th data-stat="y1">2026-27</th><th data-stat="y2">2027-28</th><th data-stat="remain_gtd">Guaranteed</th></tr>
</thead><tbody>
<tr><th data-stat="ranker">1</th><td data-stat="player"><a href="/players/d/doncilu01.html">Luka Dončić</a></td><td data-stat="team_id"><a href="/teams/LAL/2027.html">LAL</a></td><td data-stat="y1">$49,800,000</td><td data-stat="y2">$53,784,000</td><td data-stat="remain_gtd">$161,352,000</td></tr>
<tr><th data-stat="ranker">2</th><td data-stat="player"><a href="/players/w/whiteco01.html">Coby White</a></td><td data-stat="team_id"><a href="/teams/CHO/2027.html">CHO</a></td><td data-stat="y1">$22,839,506</td><td data-stat="y2"></td><td data-stat="remain_gtd">$22,839,506</td></tr>
<tr class="thead"><th data-stat="ranker">Rk</th><td data-stat="player">Player</td><td data-stat="team_id">Tm</td><td data-stat="y1">2026-27</td><td data-stat="y2">2027-28</td><td data-stat="remain_gtd">Guaranteed</td></tr>
<tr><th data-stat="ranker">3</th><td data-stat="player"><a href="/players/x/nobody01.html">Two Way</a></td><td data-stat="team_id">BRK</td><td data-stat="y1"></td><td data-stat="y2"></td><td data-stat="remain_gtd"></td></tr>
</tbody></table>`

describe('parseBbrefContracts', () => {
  it('finds the season column by its label and reads every player with a figure', () => {
    const r = parseBbrefContracts(page, '2026-27')
    expect(r.column).toBe('y1')
    expect(r.players).toEqual([
      {
        name: 'Luka Dončić', team: 'LAL', salary: 49_800_000,
        seasons: { '2026-27': 49_800_000, '2027-28': 53_784_000 }, guaranteed: 161_352_000,
      },
      { name: 'Coby White', team: 'CHA', salary: 22_839_506, seasons: { '2026-27': 22_839_506 }, guaranteed: 22_839_506 },
    ])
  })
  it('reads next season from its own column', () => {
    const r = parseBbrefContracts(page, '2027-28')
    expect(r.column).toBe('y2')
    expect(r.players.map((p) => p.name)).toEqual(['Luka Dončić'])
  })
  it('is empty when the season is not on the page', () => {
    expect(parseBbrefContracts(page, '2031-32')).toEqual({ players: [], column: null })
  })
  it('maps Basketball-Reference club codes onto ours', () => {
    expect(bbrefCode('BRK')).toBe('BKN')
    expect(bbrefCode('PHO')).toBe('PHX')
    expect(bbrefCode('BOS')).toBe('BOS')
  })
})

describe('matchBbrefPlayer', () => {
  const pool = [
    { id: '1', name: 'Ronald Holland II', teamCode: 'DET' },
    { id: '2', name: 'Walter Clayton Jr.', teamCode: 'MEM' },
    { id: '3', name: 'Christian Anderson', teamCode: 'CHA' },
    { id: '4', name: 'Jimmy Butler III', teamCode: 'GS' },
    { id: '5', name: 'Jalen Williams', teamCode: 'OKC' },
    { id: '6', name: 'Jalen Williams', teamCode: 'MIA' },
    { id: '7', name: 'Luka Doncic', teamCode: 'LAL' },
  ]
  it('ignores suffixes and diacritics', () => {
    expect(looseName('Jimmy Butler III')).toBe('jimmy butler')
    expect(matchBbrefPlayer({ name: 'Luka Dončić', team: 'LAL' }, pool)).toBe('7')
    expect(matchBbrefPlayer({ name: 'Walter Clayton', team: 'MEM' }, pool)).toBe('2')
    expect(matchBbrefPlayer({ name: 'Christian Anderson Jr.', team: 'CHA' }, pool)).toBe('3')
    expect(matchBbrefPlayer({ name: 'Jimmy Butler', team: 'GS' }, pool)).toBe('4')
  })
  it('resolves a known nickname wherever the unique name sits', () => {
    expect(matchBbrefPlayer({ name: 'Ron Holland', team: 'DET' }, pool)).toBe('1')
    expect(matchBbrefPlayer({ name: 'Ron Holland', team: 'MIA' }, pool)).toBe('1')
  })
  it('takes an unknown short name only on the same club, same last name', () => {
    const p2 = [...pool, { id: '8', name: 'Bogoljub Markovic', teamCode: 'MEM' }]
    expect(matchBbrefPlayer({ name: 'Bogi Markovic', team: 'MEM' }, p2)).toBe('8')
    expect(matchBbrefPlayer({ name: 'Bogi Markovic', team: 'DAL' }, p2)).toBeNull()
  })
  it('breaks a shared name by club and refuses a tie', () => {
    expect(matchBbrefPlayer({ name: 'Jalen Williams', team: 'OKC' }, pool)).toBe('5')
    expect(matchBbrefPlayer({ name: 'Jalen Williams', team: 'BOS' }, pool)).toBeNull()
  })
})
