import { describe, it, expect } from 'vitest'
import {
  parseRoundEntry,
  formatRoundEntry,
  slotForBoardPick,
  slotForLastYearRedshirt,
  slotFromThisBoard,
  carryKeeperFields,
} from '../rules/rookieSlots'
import { WNBA_LEAGUE_PRESET } from '../lib/presets/wnba'

const cfg = WNBA_LEAGUE_PRESET
const base = {
  teamId: 't1' as string | null,
  slot: 'active' as const,
  rookieDraftInfo: null,
  keeperPriorYearRound: null,
  migratedKeeperRound: null,
  draftRound: null,
}

describe('parseRoundEntry — the one Rosters box', () => {
  it('reads a bare round as last year\'s round', () => {
    expect(parseRoundEntry('4')).toEqual({ kind: 'round', round: 4 })
    expect(parseRoundEntry(' 13 ')).toEqual({ kind: 'round', round: 13 })
  })
  it('reads round.pick as a rookie slot', () => {
    expect(parseRoundEntry('1.4')).toEqual({ kind: 'slot', round: 1, pick: 4 })
    expect(parseRoundEntry('2.12')).toEqual({ kind: 'slot', round: 2, pick: 12 })
  })
  it('is empty on blank and invalid on anything else', () => {
    expect(parseRoundEntry('')).toEqual({ kind: 'empty' })
    expect(parseRoundEntry('0')).toEqual({ kind: 'invalid' })
    expect(parseRoundEntry('1.0')).toEqual({ kind: 'invalid' })
    expect(parseRoundEntry('rd 4')).toEqual({ kind: 'invalid' })
    expect(parseRoundEntry('99')).toEqual({ kind: 'invalid' })
  })
  it('formats back the same way', () => {
    expect(formatRoundEntry({ rookieDraftInfo: null, keeperPriorYearRound: 7 })).toBe('7')
    expect(
      formatRoundEntry({
        rookieDraftInfo: { round: 1, pick: 4, redshirtEligible: true },
        keeperPriorYearRound: 13,
      })
    ).toBe('1.4')
    expect(formatRoundEntry({ rookieDraftInfo: null, keeperPriorYearRound: null })).toBe('')
  })
})

describe('slots', () => {
  it('a board pick stamps a redshirt-eligible slot for its season', () => {
    expect(slotForBoardPick({ round: 1, pickInRound: 4 }, 2027)).toEqual({
      round: 1,
      pick: 4,
      redshirtEligible: true,
      seasonYear: 2027,
    })
  })
  it('a last-year redshirt keeps the slot and loses the second redshirt', () => {
    expect(slotForLastYearRedshirt(1, 2)).toEqual({
      round: 1,
      pick: 2,
      redshirtEligible: false,
      redshirtedLastYear: true,
    })
  })
  it('only this season\'s board owns a slot', () => {
    expect(slotFromThisBoard(slotForBoardPick({ round: 1, pickInRound: 1 }, 2027), 2027)).toBe(true)
    expect(slotFromThisBoard(slotForBoardPick({ round: 1, pickInRound: 1 }, 2026), 2027)).toBe(false)
    expect(slotFromThisBoard(slotForLastYearRedshirt(1, 1), 2027)).toBe(false)
    expect(slotFromThisBoard(null, 2027)).toBe(false)
  })
})

describe('carryKeeperFields — the turn of the year', () => {
  it('a free agent carries nothing', () => {
    expect(
      carryKeeperFields({ ...base, teamId: null, keeperPriorYearRound: 3, draftRound: 2 }, cfg)
    ).toEqual({ keeperPriorYearRound: null, rookieDraftInfo: null })
  })
  it('a kept or drafted player carries the round she occupied', () => {
    expect(carryKeeperFields({ ...base, keeperPriorYearRound: 6, draftRound: 4 }, cfg)).toEqual({
      keeperPriorYearRound: 4,
      rookieDraftInfo: null,
    })
    expect(carryKeeperFields({ ...base, draftRound: 9 }, cfg)).toEqual({
      keeperPriorYearRound: 9,
      rookieDraftInfo: null,
    })
  })
  it('a rookie who played carries the round her slot priced, and loses the slot', () => {
    const rookie = { ...base, rookieDraftInfo: slotForBoardPick({ round: 1, pickInRound: 2 }, 2026) }
    expect(carryKeeperFields(rookie, cfg)).toEqual({ keeperPriorYearRound: 4, rookieDraftInfo: null })
  })
  it('a redshirted rookie carries her slot forward with no second redshirt', () => {
    const rookie = {
      ...base,
      slot: 'redshirt' as const,
      rookieDraftInfo: slotForBoardPick({ round: 1, pickInRound: 2 }, 2026),
    }
    expect(carryKeeperFields(rookie, cfg)).toEqual({
      keeperPriorYearRound: null,
      rookieDraftInfo: {
        round: 1,
        pick: 2,
        redshirtEligible: false,
        redshirtedLastYear: true,
        seasonYear: 2026,
      },
    })
  })
  it('a player with only a prior round carries the round she was priced at', () => {
    expect(carryKeeperFields({ ...base, keeperPriorYearRound: 6 }, cfg)).toEqual({
      keeperPriorYearRound: 5,
      rookieDraftInfo: null,
    })
  })
  it('a pickup who occupied no round counts as the last round', () => {
    expect(carryKeeperFields(base, cfg)).toEqual({
      keeperPriorYearRound: cfg.draft.rounds,
      rookieDraftInfo: null,
    })
  })
})
