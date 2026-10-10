import { describe, it, expect } from 'vitest'
import {
  planOptions,
  blankEntries,
  reconcileEntries,
  setDecision,
  movePriority,
  evaluatePlan,
  blocking,
  type PlanPlayer,
} from '../rules/keeperPlan'
import { NBA_LEAGUE_PRESET } from '../lib/sport/nba'

const cfg = NBA_LEAGUE_PRESET
const player = (over: Partial<PlanPlayer> & { id: string }): PlanPlayer => ({
  name: over.id,
  position: 'G',
  teamCode: 'BOS',
  salary: 10_000_000,
  slot: 'active',
  isRookie: false,
  yearsPro: 5,
  redshirtUsed: false,
  leaguePresence: 'rostered',
  presenceOverride: null,
  intEligible: false,
  rookieDraftInfo: null,
  keeperPriorYearRound: null,
  migratedKeeperRound: null,
  ...over,
})

describe('planOptions', () => {
  it('prices a veteran minus one and a rookie by slot', () => {
    expect(planOptions(player({ id: 'v', keeperPriorYearRound: 6 }), cfg).baseRound).toBe(5)
    expect(
      planOptions(
        player({ id: 'r', isRookie: true, yearsPro: 0, rookieDraftInfo: { round: 1, pick: 2, redshirtEligible: true } }),
        cfg
      ).baseRound
    ).toBe(4)
    expect(planOptions(player({ id: 'x' }), cfg).baseRound).toBeNull()
  })
  it('offers redshirt only to a rookie in his draft year who is here', () => {
    const rookie = player({ id: 'r', isRookie: true, yearsPro: 0, rookieDraftInfo: { round: 1, pick: 2, redshirtEligible: true } })
    expect(planOptions(rookie, cfg).redshirtOk).toBe(true)
    expect(planOptions(player({ id: 'v' }), cfg).redshirtOk).toBe(false)
    const last = player({ id: 'l', isRookie: true, yearsPro: 0, rookieDraftInfo: { round: 1, pick: 2, redshirtEligible: false, redshirtedLastYear: true } })
    expect(planOptions(last, cfg).redshirtOk).toBe(false)
    expect(planOptions(last, cfg).redshirtWhy).toMatch(/one/)
  })
  it('offers int stash only to a player not on a roster here with zero career games, or one the commissioner flagged', () => {
    expect(planOptions(player({ id: 'a', leaguePresence: 'absent', careerGp: 0 }), cfg).intStashOk).toBe(true)
    expect(planOptions(player({ id: 'f', intEligible: true }), cfg).intStashOk).toBe(true)
    const vet = planOptions(player({ id: 'v', leaguePresence: 'absent', careerGp: 212 }), cfg)
    expect(vet.intStashOk).toBe(false)
    expect(vet.intStashWhy).toMatch(/212 games/)
    const unknown = planOptions(player({ id: 'u', leaguePresence: 'absent', careerGp: null }), cfg)
    expect(unknown.intStashOk).toBe(false)
    expect(unknown.intStashWhy).toMatch(/unknown/)
    expect(planOptions(player({ id: 'h', careerGp: 0 }), cfg).intStashOk).toBe(false)
  })
})

describe('entries', () => {
  const ps = [player({ id: 'a', keeperPriorYearRound: 5 }), player({ id: 'b', keeperPriorYearRound: 5 })]
  it('starts everyone dropped with a price', () => {
    expect(blankEntries(ps, cfg)).toEqual([
      { playerId: 'a', decision: 'DROP', baseRound: 4 },
      { playerId: 'b', decision: 'DROP', baseRound: 4 },
    ])
  })
  it('reconciles a saved plan with today\'s roster', () => {
    const saved = [
      { playerId: 'a', decision: 'KEEP' as const, baseRound: 9, keeperRound: 9 },
      { playerId: 'gone', decision: 'KEEP' as const, baseRound: 2 },
    ]
    expect(reconcileEntries(saved, ps, cfg)).toEqual([
      { playerId: 'a', decision: 'KEEP', baseRound: 4, keeperRound: undefined },
      { playerId: 'b', decision: 'DROP', baseRound: 4 },
    ])
  })
  it('priority swaps two keepers priced at the same round', () => {
    let e = setDecision(setDecision(blankEntries(ps, cfg), 'a', 'KEEP'), 'b', 'KEEP')
    e = movePriority(e, 'b', 'up')
    expect(e.find((x) => x.playerId === 'b')?.priority).toBe(0)
    expect(e.find((x) => x.playerId === 'a')?.priority).toBe(1)
    expect(movePriority(e, 'b', 'up')).toBe(e)
  })
})

describe('evaluatePlan', () => {
  it('stacks, sums and draws the board', () => {
    const ps = [
      player({ id: 'a', name: 'A', keeperPriorYearRound: 5, salary: 50_000_000 }),
      player({ id: 'b', name: 'B', keeperPriorYearRound: 5, salary: 40_000_000 }),
      player({ id: 'c', name: 'C', keeperPriorYearRound: 1, salary: 30_000_000 }),
      player({ id: 'd', name: 'D', keeperPriorYearRound: 1, salary: 20_000_000 }),
    ]
    let e = blankEntries(ps, cfg)
    for (const id of ['a', 'b', 'c', 'd']) e = setDecision(e, id, 'KEEP')
    const ev = evaluatePlan(e, ps, cfg)
    expect(ev.summary.keepersCount).toBe(4)
    expect(ev.summary.capUsed).toBe(140_000_000)
    expect(ev.franchiseTags).toBe(1)
    expect(ev.summary.franchiseTagDues).toBe(cfg.fees.franchiseTagFee)
    const rounds = Object.fromEntries(ev.board.map((b) => [b.round, b.names]))
    expect(rounds[1].length).toBe(1)
    expect(rounds[2].length).toBe(1) // the franchise tag takes round 2
    expect(rounds[4].length + rounds[3].length).toBe(2) // 5→4, the other slides to 3
    expect(ev.board.length).toBe(cfg.draft.rounds)
    expect(blocking(ev.errors)).toEqual([])
  })
  it('blocks a keeper with no round and too many keepers', () => {
    const ps = Array.from({ length: cfg.roster.maxKeepers + 1 }, (_, i) =>
      player({ id: `p${i}`, name: `P${i}`, keeperPriorYearRound: i === 0 ? null : 10 })
    )
    let e = blankEntries(ps, cfg)
    for (const p of ps) e = setDecision(e, p.id, 'KEEP')
    const errs = blocking(evaluatePlan(e, ps, cfg).errors)
    expect(errs.some((x) => x.field === 'keepersCount')).toBe(true)
    expect(errs.some((x) => x.field === 'missingBaseRound' && x.playerId === 'p0')).toBe(true)
  })
  it('blocks an ineligible redshirt or stash, by name', () => {
    const ps = [player({ id: 'v', name: 'Vet', keeperPriorYearRound: 5 })]
    const errs = blocking(evaluatePlan(setDecision(blankEntries(ps, cfg), 'v', 'REDSHIRT'), ps, cfg).errors)
    expect(errs[0].message).toMatch(/^Vet:/)
    const errs2 = blocking(evaluatePlan(setDecision(blankEntries(ps, cfg), 'v', 'INT_STASH'), ps, cfg).errors)
    expect(errs2.some((x) => x.field === 'intStashEligibility')).toBe(true)
  })
})
