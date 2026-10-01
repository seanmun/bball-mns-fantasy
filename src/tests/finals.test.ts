import { describe, expect, it } from 'vitest'
import { buildFinalSnapshot, finalPlaces } from '../lib/season/finals'
import { weekSettled } from '../lib/season/playoffs'

const seed = (n: number) => ({ teamId: `t${n}`, seed: n })
const rec = (wins: number, pointsFor = 0) => ({ wins, pointsFor })

describe('weekSettled', () => {
  // 2026-09-30 is the week's last day. Eastern is UTC-4 then.
  const endDate = '2026-09-30'
  it('is not settled at midnight Eastern the next day', () => {
    expect(weekSettled(endDate, new Date('2026-10-01T04:00:00Z'))).toBe(false)
  })
  it('is not settled at 11:59am Eastern the next day', () => {
    expect(weekSettled(endDate, new Date('2026-10-01T15:59:00Z'))).toBe(false)
  })
  it('is settled at noon Eastern the next day', () => {
    expect(weekSettled(endDate, new Date('2026-10-01T16:00:00Z'))).toBe(true)
  })
  it('is settled any time two days later', () => {
    expect(weekSettled(endDate, new Date('2026-10-02T04:30:00Z'))).toBe(true)
  })
  it('is not settled on the last day itself', () => {
    expect(weekSettled(endDate, new Date('2026-09-30T20:00:00Z'))).toBe(false)
  })
})

describe('finalPlaces', () => {
  it('two-team final: champion, runner-up, then the rest by standings', () => {
    const standings = new Map([
      ['t1', rec(10, 50)],
      ['t2', rec(8, 40)],
      ['t3', rec(6, 30)],
      ['t4', rec(6, 20)],
    ])
    const places = finalPlaces(
      ['t4', 't3', 't2', 't1'],
      standings,
      [seed(1), seed(2)],
      [{ matchupWeek: 3, homeTeamId: 't1', awayTeamId: 't2', homeScore: 4, awayScore: 5 }]
    )
    expect(places).toEqual([
      { teamId: 't2', place: 1, via: 'champion' },
      { teamId: 't1', place: 2, via: 'runner_up' },
      { teamId: 't3', place: 3, via: 'standings' },
      { teamId: 't4', place: 4, via: 'standings' },
    ])
  })

  it('four-team bracket: semifinal losers rank by seed, ahead of non-playoff teams', () => {
    const standings = new Map([
      ['t1', rec(10)],
      ['t2', rec(9)],
      ['t3', rec(8)],
      ['t4', rec(7)],
      ['t5', rec(6)],
      ['t6', rec(1)],
    ])
    const places = finalPlaces(
      ['t1', 't2', 't3', 't4', 't5', 't6'],
      standings,
      [1, 2, 3, 4].map(seed),
      [
        { matchupWeek: 10, homeTeamId: 't1', awayTeamId: 't4', homeScore: 3, awayScore: 6 },
        { matchupWeek: 10, homeTeamId: 't2', awayTeamId: 't3', homeScore: 5, awayScore: 4 },
        { matchupWeek: 11, homeTeamId: 't2', awayTeamId: 't4', homeScore: 6, awayScore: 3 },
      ]
    )
    expect(places.map((p) => [p.teamId, p.via])).toEqual([
      ['t2', 'champion'],
      ['t4', 'runner_up'],
      ['t1', 'playoffs'],
      ['t3', 'playoffs'],
      ['t5', 'standings'],
      ['t6', 'standings'],
    ])
  })

  it('a tied final goes to the better seed', () => {
    const places = finalPlaces(
      ['t1', 't2'],
      new Map(),
      [seed(1), seed(2)],
      [{ matchupWeek: 2, homeTeamId: 't2', awayTeamId: 't1', homeScore: 4, awayScore: 4 }]
    )
    expect(places[0]).toEqual({ teamId: 't1', place: 1, via: 'champion' })
  })

  it('no bracket at all: standings order is the whole story', () => {
    const standings = new Map([
      ['a', rec(3, 10)],
      ['b', rec(3, 12)],
      ['c', rec(5, 0)],
    ])
    expect(finalPlaces(['a', 'b', 'c'], standings, [], []).map((p) => p.teamId)).toEqual(['c', 'b', 'a'])
  })
})

describe('buildFinalSnapshot', () => {
  const teams = [
    { id: 't1', name: 'Goggles' },
    { id: 't2', name: 'Veep' },
    { id: 't3', name: 'Kinetic' },
  ]
  const places = [
    { teamId: 't1', place: 1, via: 'champion' as const },
    { teamId: 't2', place: 2, via: 'runner_up' as const },
    { teamId: 't3', place: 3, via: 'standings' as const },
  ]

  it('freezes pot, wallet and each paid place by name', () => {
    const snap = buildFinalSnapshot({
      seasonYear: 2026,
      now: new Date('2026-10-01T16:00:00Z'),
      teams,
      places,
      prizes: {
        potUsd: 200,
        walletAddress: '0xd36b40b6599850a06af7fbd6c979e8ab98178d0a',
        splits: [
          { label: '1st place', share: 80 },
          { label: '2nd place', share: 20 },
        ],
      },
      walletUsd: 50,
    })
    expect(snap.champion).toEqual({ teamId: 't1', name: 'Goggles' })
    expect(snap.runnerUp).toEqual({ teamId: 't2', name: 'Veep' })
    expect(snap.pot).toEqual({
      potUsd: 200,
      walletAddress: '0xd36b40b6599850a06af7fbd6c979e8ab98178d0a',
      walletUsd: 50,
      totalUsd: 250,
    })
    expect(snap.splits).toEqual([
      { place: 1, label: '1st place', share: 80, amountUsd: 200, teamId: 't1', name: 'Goggles' },
      { place: 2, label: '2nd place', share: 20, amountUsd: 50, teamId: 't2', name: 'Veep' },
    ])
    expect(snap.finalizedAt).toBe('2026-10-01T16:00:00.000Z')
  })

  it('no pot configured: places still recorded, splits empty, total zero', () => {
    const snap = buildFinalSnapshot({
      seasonYear: 2026,
      now: new Date(),
      teams,
      places,
      prizes: undefined,
      walletUsd: 999,
    })
    expect(snap.pot.totalUsd).toBe(0)
    expect(snap.pot.walletUsd).toBeNull()
    expect(snap.splits).toEqual([])
    expect(snap.places.map((p) => p.name)).toEqual(['Goggles', 'Veep', 'Kinetic'])
  })
})
