import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import {
  mnsLeagueWeeks,
  mnsMatchups,
  mnsPlayers,
  mnsSportStatLines,
} from '../db/schema.js'
import { leagueStatLines } from '../players/statLines.js'
import { computeMatchupResult, type CategoryStats } from '../../rules/scoringRules.js'
import { lineupResolver } from './lineups.js'
import type { LeagueConfig } from '../../types/leagueConfig.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

// Category values from raw sums. Ratio categories are computed HERE,
// never summed from per-game percentages — a 1-of-1 night must not
// count the same as 10-of-10.
export function categoryValues(t: {
  pts: number; fgm: number; fga: number; ftm: number; fta: number
  tpm: number; reb: number; ast: number; stl: number; blk: number; tov: number
}): CategoryStats {
  return {
    'PTS': t.pts,
    'REB': t.reb,
    'AST': t.ast,
    'STL': t.stl,
    'BLK': t.blk,
    '3PM': t.tpm,
    'FG%': t.fga > 0 ? t.fgm / t.fga : 0,
    'FT%': t.fta > 0 ? t.ftm / t.fta : 0,
    'A/TO': t.tov > 0 ? t.ast / t.tov : t.ast,
  }
}

const ET_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function easternToday(now = new Date()): string {
  return ET_DAY.format(now)
}

const ET_HOUR = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  hour12: false,
})

// 0-23 in Eastern time. Some engines print midnight as "24".
export function easternHour(now = new Date()): number {
  return Number(ET_HOUR.format(now)) % 24
}

// Score every matchup of one league week from the stat lines on file.
// Idempotent: totals are recomputed from scratch each pass, so a
// corrected box or a re-run always lands on the same answer. Rosters
// are read AS OF NOW — waivers and trades change the team that scores
// going forward, which for a weekly total means the current roster
// owns the week. Slots are per-date: each stat line counts only if its
// player was ACTIVE in that team's lineup on that date.
export async function scoreLeagueWeek(
  db: Db,
  leagueId: string,
  config: LeagueConfig,
  matchupWeek: number,
  now = new Date()
): Promise<{ scored: number; finalized: number }> {
  // Week numbers repeat every season; the config's year names which
  // season's week this is.
  const seasonYear = config.season.year
  const weekRows = await db
    .select()
    .from(mnsLeagueWeeks)
    .where(
      and(
        eq(mnsLeagueWeeks.leagueId, leagueId),
        eq(mnsLeagueWeeks.matchupWeek, matchupWeek),
        eq(mnsLeagueWeeks.seasonYear, seasonYear)
      )
    )
  if (weekRows.length === 0) return { scored: 0, finalized: 0 }
  const startDate = weekRows.reduce(
    (min: string, w: { startDate: string }) => (w.startDate < min ? w.startDate : min),
    weekRows[0].startDate
  )
  const endDate = weekRows.reduce(
    (max: string, w: { endDate: string }) => (w.endDate > max ? w.endDate : max),
    weekRows[0].endDate
  )

  const matchups = await db
    .select()
    .from(mnsMatchups)
    .where(
      and(
        eq(mnsMatchups.leagueId, leagueId),
        eq(mnsMatchups.matchupWeek, matchupWeek),
        eq(mnsMatchups.seasonYear, seasonYear)
      )
    )
  if (matchups.length === 0) return { scored: 0, finalized: 0 }

  // ACTIVE players only — bench and IR are real decisions with real
  // cost: their lines exist but never count. Active is judged PER DATE
  // from the daily lineups (the slot set that day owns that day), while
  // the current roster still owns the week's membership.
  const teamIds = [
    ...new Set(matchups.flatMap((m: { homeTeamId: string; awayTeamId: string }) => [m.homeTeamId, m.awayTeamId])),
  ] as string[]
  const rostered = await db
    .select({ id: mnsPlayers.id, teamId: mnsPlayers.teamId, slot: mnsPlayers.slot })
    .from(mnsPlayers)
    .where(and(eq(mnsPlayers.leagueId, leagueId), inArray(mnsPlayers.teamId, teamIds)))
  const rosterByPlayer = new Map(
    rostered.map((p: { id: string; teamId: string; slot: string | null }) => [p.id, p])
  )
  const resolveSlot = await lineupResolver(db, leagueId, endDate)

  const lines = rostered.length
    ? await leagueStatLines(db).where(
        and(
          eq(mnsPlayers.leagueId, leagueId),
          gte(mnsSportStatLines.date, startDate),
          lte(mnsSportStatLines.date, endDate),
          inArray(mnsPlayers.id, rostered.map((p: { id: string }) => p.id))
        )
      )
    : []

  const zero = () => ({ pts: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 })
  const totals = new Map<string, ReturnType<typeof zero>>()
  for (const l of lines) {
    const p = rosterByPlayer.get(l.playerId) as { teamId: string; slot: string | null } | undefined
    if (!p) continue
    const teamId = p.teamId
    if (resolveSlot(teamId, l.playerId, l.date, p.slot) !== 'active') continue
    const t = totals.get(teamId as string) ?? zero()
    t.pts += l.pts; t.fgm += l.fgm; t.fga += l.fga; t.ftm += l.ftm; t.fta += l.fta
    t.tpm += l.tpm; t.reb += l.reb; t.ast += l.ast; t.stl += l.stl; t.blk += l.blk; t.tov += l.tov
    totals.set(teamId as string, t)
  }

  // The week is over once Eastern "today" is past its end date; the
  // scoring pass after that moment settles it.
  const weekOver = easternToday(now) > endDate

  let scored = 0
  let finalized = 0
  for (const m of matchups) {
    const home = categoryValues(totals.get(m.homeTeamId) ?? zero())
    const away = categoryValues(totals.get(m.awayTeamId) ?? zero())
    const result = computeMatchupResult(home, away, config)
    const status = weekOver ? 'final' : 'live'
    await db
      .update(mnsMatchups)
      .set({
        homeScore: String(result.homeCategoryWins),
        awayScore: String(result.awayCategoryWins),
        status,
        result: {
          categories: config.scoring.categories,
          home,
          away,
          homeRecord: result.homeRecord,
          awayRecord: result.awayRecord,
          rawTotals: { home: totals.get(m.homeTeamId) ?? zero(), away: totals.get(m.awayTeamId) ?? zero() },
        },
      })
      .where(eq(mnsMatchups.id, m.id))
    scored++
    if (status === 'final' && m.status !== 'final') finalized++
  }
  return { scored, finalized }
}

// Which matchup week does an Eastern date fall in? Null outside the
// season — the caller skips scoring entirely.
export async function matchupWeekFor(
  db: Db,
  leagueId: string,
  date: string
): Promise<number | null> {
  const [row] = await db
    .select({ matchupWeek: mnsLeagueWeeks.matchupWeek })
    .from(mnsLeagueWeeks)
    .where(
      and(
        eq(mnsLeagueWeeks.leagueId, leagueId),
        lte(mnsLeagueWeeks.startDate, date),
        gte(mnsLeagueWeeks.endDate, date)
      )
    )
    .limit(1)
  return row?.matchupWeek ?? null
}

// Standings straight from graded matchups — final weeks count fully,
// the live week rides along so the page always shows the present.
export async function computeStandings(db: Db, leagueId: string, seasonYear?: number) {
  const matchups = await db
    .select()
    .from(mnsMatchups)
    .where(
      and(
        eq(mnsMatchups.leagueId, leagueId),
        eq(mnsMatchups.isPlayoff, false),
        sql`${mnsMatchups.status} != 'scheduled'`,
        ...(seasonYear != null ? [eq(mnsMatchups.seasonYear, seasonYear)] : [])
      )
    )

  const rec = new Map<string, { wins: number; losses: number; ties: number; pointsFor: number }>()
  const bump = (teamId: string, r: { wins: number; losses: number; ties: number }, catWins: number) => {
    const t = rec.get(teamId) ?? { wins: 0, losses: 0, ties: 0, pointsFor: 0 }
    t.wins += r.wins
    t.losses += r.losses
    t.ties += r.ties
    t.pointsFor += catWins
    rec.set(teamId, t)
  }
  for (const m of matchups) {
    const result = m.result as {
      homeRecord?: { wins: number; losses: number; ties: number }
      awayRecord?: { wins: number; losses: number; ties: number }
    } | null
    if (!result?.homeRecord || !result?.awayRecord) continue
    // Live weeks show but only FINAL weeks bank the record — a Tuesday
    // lead is not a win yet.
    if (m.status !== 'final') continue
    bump(m.homeTeamId, result.homeRecord, Number(m.homeScore ?? 0))
    bump(m.awayTeamId, result.awayRecord, Number(m.awayScore ?? 0))
  }
  return rec
}
