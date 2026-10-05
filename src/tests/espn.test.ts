import { describe, expect, it } from 'vitest'
import { ageFrom, athleteIdFromLinks, contractSalaryFor, parseBox, salaryFor } from '../lib/season/espn'

describe('contractSalaryFor — the contract that pays THIS season', () => {
  const doncic = [
    { season: { year: 2027 }, salary: 49_500_000 },
    { season: { year: 2026 }, salary: 54_126_450 },
  ]
  it('picks by season year, not position in the list', () => {
    expect(contractSalaryFor(doncic, 2027)).toBe(49_500_000)
    expect(contractSalaryFor(doncic, 2026)).toBe(54_126_450)
  })
  it('no contract for the year: null', () => {
    expect(contractSalaryFor(doncic, 2028)).toBeNull()
    expect(contractSalaryFor([], 2027)).toBeNull()
    expect(contractSalaryFor(undefined, 2027)).toBeNull()
  })
  it('accepts the flat year shape too', () => {
    expect(contractSalaryFor([{ year: 2027, salary: 6_000_000 }], 2027)).toBe(6_000_000)
  })
})

describe('salaryFor — league minimum fills the gaps', () => {
  it('contract wins', () => {
    expect(salaryFor([{ season: { year: 2027 }, salary: 8_741_209 }], 2027, 1_357_763)).toEqual({
      salary: 8_741_209,
      source: 'espn-contract',
    })
  })
  it('no contract line: the minimum, never zero', () => {
    expect(salaryFor([], 2027, 1_357_763)).toEqual({ salary: 1_357_763, source: 'league-minimum' })
  })
  it('a sport with no minimum defined: unknown, zero', () => {
    expect(salaryFor(undefined, 2026, undefined)).toEqual({ salary: 0, source: 'unknown' })
  })
})

describe('athleteIdFromLinks', () => {
  it('reads the id out of the player-card link', () => {
    expect(
      athleteIdFromLinks([{ href: 'https://www.espn.com/nba/player/_/id/5105571/henri-veesaar' }])
    ).toBe('5105571')
  })
  it('no usable link: null', () => {
    expect(athleteIdFromLinks([{ href: 'https://www.espn.com/nba/team/_/name/atl' }])).toBeNull()
    expect(athleteIdFromLinks(undefined)).toBeNull()
  })
})

describe('ageFrom', () => {
  it('counts a birthday that has passed this year, not one still to come', () => {
    const now = new Date('2026-10-04T12:00:00Z')
    expect(ageFrom('1999-02-28T08:00Z', now)).toBe(27)
    expect(ageFrom('1999-12-01T08:00Z', now)).toBe(26)
    expect(ageFrom(undefined, now)).toBeNull()
    expect(ageFrom('garbage', now)).toBeNull()
  })
})

describe('parseBox — ESPN box by athlete id', () => {
  const summary = {
    boxscore: {
      players: [
        {
          team: { abbreviation: 'NY' },
          statistics: [
            {
              names: ['MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'TO', 'STL', 'BLK', 'OREB', 'DREB', 'PF', '+/-'],
              athletes: [
                { athlete: { id: '3934719', displayName: 'OG Anunoby' }, stats: ['37', '17', '5-10', '2-5', '5-5', '4', '3', '0', '2', '2', '0', '4', '4', '-9'] },
                { athlete: { id: '111', displayName: 'Did Not Play' }, stats: [] },
              ],
            },
          ],
        },
      ],
    },
  }
  it('maps the columns by name and skips DNP rows', () => {
    const lines = parseBox(summary)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      playerId: '3934719',
      name: 'OG Anunoby',
      teamAbbreviation: 'NY',
      min: 37, pts: 17, fgm: 5, fga: 10, tpm: 2, ftm: 5, fta: 5, reb: 4, ast: 3, tov: 0, stl: 2, blk: 2,
    })
  })
})
