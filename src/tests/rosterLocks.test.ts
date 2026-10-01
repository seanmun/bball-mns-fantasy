import { describe, expect, it } from 'vitest'
import { lockReason, playerLocked } from '../lib/season/locks'
import { resolveFromRows } from '../lib/season/lineups'
import { moveShape } from '../lib/season/roster'
import { capExposure, capNotice, computeApronFees } from '../rules/capRules'
import { WNBA_LEAGUE_PRESET } from '../lib/presets/wnba'
import type { LeagueConfig } from '../types/leagueConfig'

describe('playerLocked — the tip-off lock', () => {
  const tip = '2026-10-21T23:30:00Z' // 7:30pm ET
  it('no game today: never locked', () => {
    expect(playerLocked(undefined, new Date('2026-10-21T23:59:00Z'))).toBe(false)
    expect(playerLocked(null)).toBe(false)
  })
  it('before tip: open', () => {
    expect(playerLocked({ tip, state: 'pre' }, new Date('2026-10-21T23:29:59Z'))).toBe(false)
  })
  it('at tip: locked', () => {
    expect(playerLocked({ tip, state: 'pre' }, new Date('2026-10-21T23:30:00Z'))).toBe(true)
  })
  it('ESPN says the game is live or over: locked whatever the clock says', () => {
    expect(playerLocked({ tip, state: 'in' }, new Date('2026-10-21T20:00:00Z'))).toBe(true)
    expect(playerLocked({ tip, state: 'post' }, new Date('2026-10-21T20:00:00Z'))).toBe(true)
  })
  it('names the player and the Eastern tip time', () => {
    expect(lockReason('A’ja Wilson', { tip, state: 'in' })).toBe(
      "A’ja Wilson's game tipped at 7:30 PM ET — locked in place until tomorrow."
    )
  })
})

describe('resolveFromRows — parked slots win over snapshots', () => {
  const rows = [
    { gameDate: '2026-10-20', slots: { p1: 'bench', p2: 'active' } },
    { gameDate: '2026-10-22', slots: { p1: 'active', p2: 'ir' } },
  ]
  it('a snapshot at/before the date wins for a normal player', () => {
    expect(resolveFromRows(rows, 'p1', '2026-10-21', 'active')).toBe('bench')
    expect(resolveFromRows(rows, 'p1', '2026-10-22', 'active')).toBe('active')
  })
  it('a redshirt stays a redshirt even when an old snapshot says active', () => {
    expect(resolveFromRows(rows, 'p2', '2026-10-21', 'redshirt')).toBe('redshirt')
  })
  it('a stash stays a stash even when a future-dated snapshot says IR', () => {
    expect(resolveFromRows(rows, 'p2', '2026-10-23', 'international')).toBe('international')
  })
  it('no rows: the base slot', () => {
    expect(resolveFromRows(undefined, 'p9', '2026-10-21', null)).toBe('active')
  })
})

describe('moveShape — what every move owes', () => {
  it('bench to active is a plain lineup move for a date', () => {
    expect(moveShape('bench', 'active')).toEqual({
      leavesRedshirt: false,
      entersRedshirt: false,
      entersStash: false,
      leavesStash: false,
      unparks: false,
      seasonAct: false,
    })
  })
  it('redshirt to stash still leaves the redshirt: fee, eligibility spent, today', () => {
    const s = moveShape('redshirt', 'international')
    expect(s.leavesRedshirt).toBe(true)
    expect(s.entersStash).toBe(true)
    expect(s.unparks).toBe(false)
    expect(s.seasonAct).toBe(true)
  })
  it('stash to redshirt enters the redshirt (eligibility + fee) and leaves the stash free', () => {
    const s = moveShape('international', 'redshirt')
    expect(s.entersRedshirt).toBe(true)
    expect(s.leavesStash).toBe(true)
    expect(s.leavesRedshirt).toBe(false)
  })
  it('redshirt to IR un-parks: activation fee and the hard-cap check', () => {
    const s = moveShape('redshirt', 'ir')
    expect(s.leavesRedshirt).toBe(true)
    expect(s.unparks).toBe(true)
    expect(s.seasonAct).toBe(true)
  })
  it('dropping a redshirt costs nothing and spends nothing', () => {
    const s = moveShape('redshirt', 'drop')
    expect(s.leavesRedshirt).toBe(false)
    expect(s.unparks).toBe(false)
    expect(s.seasonAct).toBe(true)
  })
  it('a null slot reads as active', () => {
    expect(moveShape(null, 'bench').seasonAct).toBe(false)
  })
})

describe('capExposure — the forecast matches the booking', () => {
  const nba: LeagueConfig = {
    ...WNBA_LEAGUE_PRESET,
    cap: {
      ...WNBA_LEAGUE_PRESET.cap,
      enabled: true,
      firstApron: 209_015_000,
      secondApron: 221_686_000,
      hardCap: 240_000_000,
      penaltyRatePerM: 10,
    },
    fees: { ...WNBA_LEAGUE_PRESET.fees, firstApronFee: 25 },
  }
  const clean = { firstApronFee: 0, secondApronPenalty: 0 }

  it('under both aprons: nothing pending', () => {
    const x = capExposure(200_000_000, nba, clean)
    expect(x.pendingTotal).toBe(0)
    expect(capNotice(x, '7:00 PM')).toBeNull()
  })
  it('over the first apron, nothing booked: the one-time fee is pending', () => {
    const x = capExposure(210_000_000, nba, clean)
    expect(x).toMatchObject({ overFirst: true, firstApronPending: 25, secondApronPending: 0, pendingTotal: 25 })
    expect(capNotice(x, '7:00 PM')).toBe(
      "You're over the first apron — a $25 first-apron fee books at tonight's first tip (7:00 PM ET) unless you get under."
    )
  })
  it('first apron already booked: nothing more pending for it', () => {
    const x = capExposure(210_000_000, nba, { firstApronFee: 25, secondApronPenalty: 0 })
    expect(x.pendingTotal).toBe(0)
  })
  it('over the second apron by $1.2M: $20 pending at $10/M, rounded up like the booking', () => {
    const x = capExposure(222_886_000, nba, { firstApronFee: 25, secondApronPenalty: 0 })
    expect(x.overSecondBy).toBe(1_200_000)
    expect(x.secondApronPending).toBe(20)
    const booked = computeApronFees({ capUsed: 222_886_000, config: nba, current: { firstApronFee: 25, secondApronPenalty: 0 } })
    expect(booked.secondApronPenalty).toBe(20)
  })
  it('watermark already higher than today: nothing pending, nothing refunded', () => {
    const x = capExposure(222_000_000, nba, { firstApronFee: 25, secondApronPenalty: 50 })
    expect(x.secondApronPending).toBe(0)
  })
  it('WNBA preset: aprons off, nothing ever pending', () => {
    const x = capExposure(1_600_000, WNBA_LEAGUE_PRESET, clean)
    expect(x.pendingTotal).toBe(0)
  })
})
