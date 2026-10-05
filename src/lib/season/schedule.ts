import { and, eq } from 'drizzle-orm'
import { generateWeeks } from '../../rules/scheduleRules.js'
import { mnsLeagueWeeks, mnsMatchups, mnsTeams } from '../db/schema.js'
import type { LeagueConfig } from '../../types/leagueConfig.js'

// Round-robin pairings via the circle method: team 0 fixed, the rest
// rotate. Odd team counts get a bye (null opponent, no matchup row).
// 4 teams / 2 weeks: wk1 A-D B-C, wk2 A-C D-B — every pairing distinct
// until the cycle repeats after (n-1) weeks.
export function roundRobinPairings(teamIds: string[], week: number): Array<[string, string]> {
  const n = teamIds.length
  if (n < 2) return []
  const ids = [...teamIds]
  const odd = n % 2 === 1
  if (odd) ids.push('__bye__')
  const m = ids.length
  const rot = (week - 1) % (m - 1)
  // rotate all but the first
  const rest = ids.slice(1)
  const rotated = [...rest.slice(rest.length - rot), ...rest.slice(0, rest.length - rot)]
  const order = [ids[0], ...rotated]
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < m / 2; i++) {
    const a = order[i]
    const b = order[m - 1 - i]
    if (a === '__bye__' || b === '__bye__') continue
    // Alternate home/away by week so nobody is "home" all season.
    pairs.push(week % 2 === 0 ? [b, a] : [a, b])
  }
  return pairs
}

// Write the league's full schedule: week rows from the tested
// scheduleRules generator, one matchup row per pairing per matchup
// week. Idempotent — clears and rebuilds, which is safe exactly until
// the first game counts; the caller must not invoke it after that.
export async function generateSeasonSchedule(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  leagueId: string,
  config: LeagueConfig
): Promise<{ weeks: number; matchups: number }> {
  const teams = await db
    .select({ id: mnsTeams.id })
    .from(mnsTeams)
    .where(eq(mnsTeams.leagueId, leagueId))
    .orderBy(mnsTeams.createdAt)
  const teamIds = teams.map((t: { id: string }) => t.id)

  const weeks = generateWeeks({ leagueId, config, combinedWeeks: config.schedule.combinedWeeks ?? [] })
  if (weeks.length === 0) {
    throw new Error('League config has no season.startDate — set it before starting the season')
  }

  // Only THIS season regenerates — prior years are history and stay.
  const seasonYear = weeks[0].seasonYear
  await db
    .delete(mnsMatchups)
    .where(and(eq(mnsMatchups.leagueId, leagueId), eq(mnsMatchups.seasonYear, seasonYear)))
  await db
    .delete(mnsLeagueWeeks)
    .where(and(eq(mnsLeagueWeeks.leagueId, leagueId), eq(mnsLeagueWeeks.seasonYear, seasonYear)))

  await db.insert(mnsLeagueWeeks).values(
    weeks.map((w) => ({
      id: w.id,
      leagueId: w.leagueId,
      seasonYear: w.seasonYear,
      weekNumber: w.weekNumber,
      matchupWeek: w.matchupWeek,
      startDate: w.startDate,
      endDate: w.endDate,
      isTradeDeadlineWeek: w.isTradeDeadlineWeek,
      label: w.label,
    }))
  )

  // One set of pairings per distinct matchup week (combined weeks share
  // their pairings by definition — same matchupWeek, same rows).
  const matchupWeeks = [...new Set(weeks.map((w) => w.matchupWeek))]
  const rows: Array<Record<string, unknown>> = []
  for (const mw of matchupWeeks) {
    for (const [home, away] of roundRobinPairings(teamIds, mw)) {
      rows.push({
        id: `${leagueId}_${weeks[0].seasonYear}_w${mw}_${home}_${away}`,
        leagueId,
        seasonYear: weeks[0].seasonYear,
        matchupWeek: mw,
        homeTeamId: home,
        awayTeamId: away,
        status: 'scheduled',
      })
    }
  }
  if (rows.length) await db.insert(mnsMatchups).values(rows)

  return { weeks: weeks.length, matchups: rows.length }
}
