import { and, eq, sql } from 'drizzle-orm'
import {
  mnsLeagues,
  mnsLeagueWeeks,
  mnsMatchups,
  mnsPlayoffBrackets,
  mnsTeams,
} from '../db/schema.js'
import { computeStandings, easternHour, easternToday } from './score.js'
import type { LeagueConfig } from '../../types/leagueConfig.js'

// The playoff engine. Regular season hands off automatically: once
// every regular-season matchup is final and its last day has passed,
// the tick seeds the bracket from the standings and flips the phase.
// Each round is one league week; when the last round finals, the
// winner gets the crown and a banner year on their team row.
//
// Pure functions do the thinking (seeding, pairing, advancement) so
// the whole bracket is unit-testable without a season to burn.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export interface Seeded {
  teamId: string
  seed: number
}

// Standard bracket seeding: 1 plays the worst surviving seed, 2 the
// next, and so on (1vN, 2vN-1...). Byes go to the top seeds and are
// resolved by pairing them against nobody — the caller advances them.
export function firstRoundPairings(
  seeds: Seeded[],
  byes: number
): { round: Array<{ home: Seeded; away: Seeded }>; byesTo: Seeded[] } {
  const byesTo = seeds.slice(0, byes)
  const field = seeds.slice(byes)
  const round: Array<{ home: Seeded; away: Seeded }> = []
  for (let i = 0; i < Math.floor(field.length / 2); i++) {
    round.push({ home: field[i], away: field[field.length - 1 - i] })
  }
  return { round, byesTo }
}

// Winners of a finished round, paired for the next: best surviving
// seed hosts the worst, byes rejoin at the front of the line.
export function nextRoundPairings(
  winners: Seeded[],
  byesTo: Seeded[] = []
): Array<{ home: Seeded; away: Seeded }> {
  const field = [...byesTo, ...winners].sort((a, b) => a.seed - b.seed)
  const round: Array<{ home: Seeded; away: Seeded }> = []
  for (let i = 0; i < Math.floor(field.length / 2); i++) {
    round.push({ home: field[i], away: field[field.length - 1 - i] })
  }
  return round
}

export function roundLabel(teamsLeft: number): string {
  if (teamsLeft <= 2) return 'Championship'
  if (teamsLeft <= 4) return 'Semifinal'
  if (teamsLeft <= 8) return 'Quarterfinal'
  return `Round of ${teamsLeft}`
}

const shiftDate = (date: string, days: number) =>
  new Date(new Date(`${date}T12:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10)

// A week is SETTLED at noon Eastern on the day after its last date —
// not at midnight. Late finals and the morning's stat corrections land
// before noon, and a corrected box can flip a semifinal. Every phase
// transition (season → playoffs, round → round, round → champion)
// waits for this.
export function weekSettled(endDate: string, now = new Date()): boolean {
  const today = easternToday(now)
  const dayAfter = shiftDate(endDate, 1)
  return today > dayAfter || (today === dayAfter && easternHour(now) >= 12)
}

async function createRound(
  db: Db,
  league: { id: string; seasonYear: number },
  pairings: Array<{ home: Seeded; away: Seeded }>,
  matchupWeek: number,
  startDate: string,
  endDate: string,
  label: string
) {
  await db.insert(mnsLeagueWeeks).values({
    id: `${league.id}_${league.seasonYear}_w${matchupWeek}`,
    leagueId: league.id,
    seasonYear: league.seasonYear,
    weekNumber: matchupWeek,
    matchupWeek,
    startDate,
    endDate,
    label,
  })
  for (const p of pairings) {
    await db.insert(mnsMatchups).values({
      id: `${league.id}_${league.seasonYear}_w${matchupWeek}_${p.home.teamId}_${p.away.teamId}`,
      leagueId: league.id,
      seasonYear: league.seasonYear,
      matchupWeek,
      homeTeamId: p.home.teamId,
      awayTeamId: p.away.teamId,
      isPlayoff: true,
      label,
    })
  }
}

// Called every tick while a league is in regular_season: does nothing
// until the season is fully graded and its last day is over, then
// seeds the bracket and opens round one.
export async function maybeStartPlayoffs(
  db: Db,
  league: { id: string; seasonYear: number; leaguePhase: string },
  config: LeagueConfig,
  now = new Date()
): Promise<boolean> {
  if (league.leaguePhase !== 'regular_season') return false
  const playoffTeams = config.schedule?.playoffTeams ?? 0
  if (playoffTeams < 2) return false

  const weeks = await db
    .select()
    .from(mnsLeagueWeeks)
    .where(
      and(eq(mnsLeagueWeeks.leagueId, league.id), eq(mnsLeagueWeeks.seasonYear, league.seasonYear))
    )
  if (weeks.length === 0) return false
  const lastEnd = weeks.reduce(
    (max: string, w: { endDate: string }) => (w.endDate > max ? w.endDate : max),
    weeks[0].endDate
  )
  if (!weekSettled(lastEnd, now)) return false

  const matchups = await db
    .select()
    .from(mnsMatchups)
    .where(
      and(
        eq(mnsMatchups.leagueId, league.id),
        eq(mnsMatchups.isPlayoff, false),
        eq(mnsMatchups.seasonYear, league.seasonYear)
      )
    )
  if (matchups.length === 0) return false
  if (matchups.some((m: { status: string }) => m.status !== 'final')) return false

  // Seed straight from the banked standings.
  const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, league.id))
  const rec = await computeStandings(db, league.id, league.seasonYear)
  const seeds: Seeded[] = teams
    .map((t: { id: string }) => ({
      teamId: t.id,
      ...(rec.get(t.id) ?? { wins: 0, losses: 0, ties: 0, pointsFor: 0 }),
    }))
    .sort(
      (a: { wins: number; pointsFor: number }, b: { wins: number; pointsFor: number }) =>
        b.wins - a.wins || b.pointsFor - a.pointsFor
    )
    .slice(0, playoffTeams)
    .map((t: { teamId: string }, i: number) => ({ teamId: t.teamId, seed: i + 1 }))

  const byes = Math.min(config.schedule?.playoffByeTeams ?? 0, Math.max(0, seeds.length - 2))
  const { round, byesTo } = firstRoundPairings(seeds, byes)
  const maxWeek = Math.max(...weeks.map((w: { matchupWeek: number }) => w.matchupWeek))
  const start = shiftDate(lastEnd, 1)
  const label = roundLabel(seeds.length)
  await createRound(
    db,
    league,
    round,
    maxWeek + 1,
    start,
    shiftDate(start, 6),
    label
  )

  await db
    .insert(mnsPlayoffBrackets)
    .values({
      id: `${league.id}_${league.seasonYear}`,
      leagueId: league.id,
      seasonYear: league.seasonYear,
      bracket: { seeds, byes: byesTo, rounds: [{ label, pairings: round }] },
    })
    .onConflictDoNothing()

  await db
    .update(mnsLeagues)
    .set({ leaguePhase: 'playoffs', updatedAt: new Date() })
    .where(eq(mnsLeagues.id, league.id))
  return true
}

// Called every tick while a league is in playoffs: when the current
// round is fully final, either opens the next round or crowns the
// champion (phase → champion, banner year on the team).
export async function advancePlayoffs(
  db: Db,
  league: { id: string; seasonYear: number; leaguePhase: string },
  _config: LeagueConfig,
  now = new Date()
): Promise<{ advanced: boolean; champion?: string }> {
  if (league.leaguePhase !== 'playoffs') return { advanced: false }

  const playoffMatchups = await db
    .select()
    .from(mnsMatchups)
    .where(
      and(
        eq(mnsMatchups.leagueId, league.id),
        eq(mnsMatchups.isPlayoff, true),
        eq(mnsMatchups.seasonYear, league.seasonYear)
      )
    )
  if (playoffMatchups.length === 0) return { advanced: false }
  const lastWeek = Math.max(
    ...playoffMatchups.map((m: { matchupWeek: number }) => m.matchupWeek)
  )
  const current = playoffMatchups.filter(
    (m: { matchupWeek: number }) => m.matchupWeek === lastWeek
  )
  if (current.some((m: { status: string }) => m.status !== 'final')) return { advanced: false }

  const weekRows = await db
    .select()
    .from(mnsLeagueWeeks)
    .where(
      and(
        eq(mnsLeagueWeeks.leagueId, league.id),
        eq(mnsLeagueWeeks.matchupWeek, lastWeek),
        eq(mnsLeagueWeeks.seasonYear, league.seasonYear)
      )
    )
  const lastEnd = weekRows[0]?.endDate ?? easternToday(now)
  if (!weekSettled(lastEnd, now)) return { advanced: false }

  // Bracket memory: who was seeded what.
  const [bracket] = await db
    .select()
    .from(mnsPlayoffBrackets)
    .where(
      and(
        eq(mnsPlayoffBrackets.leagueId, league.id),
        eq(mnsPlayoffBrackets.seasonYear, league.seasonYear)
      )
    )
    .limit(1)
  const seedOf = new Map<string, number>(
    ((bracket?.bracket as { seeds?: Seeded[] })?.seeds ?? []).map((s) => [s.teamId, s.seed])
  )

  const winners: Seeded[] = current.map(
    (m: { homeTeamId: string; awayTeamId: string; homeScore: string | null; awayScore: string | null }) => {
      // Category ties break to the better seed — the reward for the
      // regular season, and the only tiebreak that needs no extra data.
      const home = Number(m.homeScore ?? 0)
      const away = Number(m.awayScore ?? 0)
      const homeSeed = seedOf.get(m.homeTeamId) ?? 99
      const awaySeed = seedOf.get(m.awayTeamId) ?? 99
      const homeWins = home > away || (home === away && homeSeed < awaySeed)
      const teamId = homeWins ? m.homeTeamId : m.awayTeamId
      return { teamId, seed: seedOf.get(teamId) ?? 99 }
    }
  )

  // Byes only join after round one.
  const isFirstPlayoffWeek =
    lastWeek === Math.min(...playoffMatchups.map((m: { matchupWeek: number }) => m.matchupWeek))
  const byesTo: Seeded[] = isFirstPlayoffWeek
    ? ((bracket?.bracket as { byes?: Seeded[] })?.byes ?? [])
    : []

  const survivors = byesTo.length + winners.length
  if (survivors >= 2) {
    const pairings = nextRoundPairings(winners, byesTo)
    const start = shiftDate(lastEnd, 1)
    await createRound(
      db,
      league,
      pairings,
      lastWeek + 1,
      start,
      shiftDate(start, 6),
      roundLabel(survivors)
    )
    return { advanced: true }
  }

  // One team stands: crown them.
  const champion = winners[0]
  await db
    .update(mnsLeagues)
    .set({ leaguePhase: 'champion', updatedAt: new Date() })
    .where(eq(mnsLeagues.id, league.id))
  await db
    .update(mnsTeams)
    .set({ banners: sql`array_append(${mnsTeams.banners}, ${league.seasonYear})` })
    .where(eq(mnsTeams.id, champion.teamId))
  return { advanced: true, champion: champion.teamId }
}
