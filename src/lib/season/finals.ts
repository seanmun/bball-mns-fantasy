import { and, eq } from 'drizzle-orm'
import { mnsMatchups, mnsPlayoffBrackets, mnsPrizePayouts, mnsTeams } from '../db/schema.js'
import { computeStandings } from './score.js'
import type { Seeded } from './playoffs.js'
import type { LeagueConfig } from '../../types/leagueConfig.js'

// The season's last word. When a league is crowned, ONE record is
// written: who finished where, and what the pot was worth at that
// moment. The Prizes tab and the offseason home read this record, so
// a wallet that moves overnight or a pot edited in November never
// rewrites who won what.
//
// Written once per league and season (the row id is the pair), from
// the season tick rather than inside the crowning, so a wallet hiccup
// at the flip simply heals on the next tick.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export interface PlayoffMatchupLite {
  matchupWeek: number
  homeTeamId: string
  awayTeamId: string
  homeScore: number | string | null
  awayScore: number | string | null
}

export interface Placed {
  teamId: string
  place: number
  via: 'champion' | 'runner_up' | 'playoffs' | 'standings'
}

// Final places once a bracket exists: the champion, the runner-up,
// then the losers of each earlier round (later exit first, better seed
// first within a round), then everyone else by regular-season
// standings. With no bracket, standings order is the whole story.
// Category ties break to the better seed, exactly as the bracket did.
export function finalPlaces(
  teamIds: string[],
  standings: Map<string, { wins: number; pointsFor: number }>,
  seeds: Seeded[],
  playoff: PlayoffMatchupLite[]
): Placed[] {
  const seedOf = new Map(seeds.map((s) => [s.teamId, s.seed]))
  const seed = (id: string) => seedOf.get(id) ?? 99
  const winnerOf = (m: PlayoffMatchupLite) => {
    const home = Number(m.homeScore ?? 0)
    const away = Number(m.awayScore ?? 0)
    const homeWins = home > away || (home === away && seed(m.homeTeamId) < seed(m.awayTeamId))
    return homeWins
      ? { winner: m.homeTeamId, loser: m.awayTeamId }
      : { winner: m.awayTeamId, loser: m.homeTeamId }
  }

  const ordered: Array<{ teamId: string; via: Placed['via'] }> = []
  const taken = new Set<string>()
  const push = (teamId: string, via: Placed['via']) => {
    if (taken.has(teamId)) return
    taken.add(teamId)
    ordered.push({ teamId, via })
  }

  const weeks = [...new Set(playoff.map((m) => m.matchupWeek))].sort((a, b) => b - a)
  for (const [i, week] of weeks.entries()) {
    const round = playoff.filter((m) => m.matchupWeek === week).map(winnerOf)
    if (i === 0 && round.length === 1) {
      push(round[0].winner, 'champion')
      push(round[0].loser, 'runner_up')
      continue
    }
    // A round that is not a single final: winners outrank losers,
    // better seed first on each side.
    for (const r of [...round].sort((a, b) => seed(a.winner) - seed(b.winner))) {
      push(r.winner, 'playoffs')
    }
    for (const r of [...round].sort((a, b) => seed(a.loser) - seed(b.loser))) {
      push(r.loser, 'playoffs')
    }
  }

  const rest = teamIds
    .filter((id) => !taken.has(id))
    .map((id) => ({ id, ...(standings.get(id) ?? { wins: 0, pointsFor: 0 }) }))
    .sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor || seed(a.id) - seed(b.id))
  for (const t of rest) push(t.id, 'standings')

  return ordered.map((o, i) => ({ teamId: o.teamId, place: i + 1, via: o.via }))
}

export interface FinalSnapshot {
  finalizedAt: string
  seasonYear: number
  champion: { teamId: string; name: string } | null
  runnerUp: { teamId: string; name: string } | null
  places: Array<{ place: number; teamId: string; name: string; via: Placed['via'] }>
  pot: {
    potUsd: number
    walletAddress: string | null
    walletUsd: number | null
    totalUsd: number
  }
  splits: Array<{
    place: number
    label: string
    share: number
    amountUsd: number
    teamId: string | null
    name: string | null
  }>
}

export function buildFinalSnapshot(args: {
  seasonYear: number
  now: Date
  teams: Array<{ id: string; name: string }>
  places: Placed[]
  prizes: LeagueConfig['prizes'] | undefined
  walletUsd: number | null
}): FinalSnapshot {
  const name = new Map(args.teams.map((t) => [t.id, t.name]))
  const places = args.places.map((p) => ({ ...p, name: name.get(p.teamId) ?? '' }))
  const who = (via: Placed['via']) => {
    const p = places.find((x) => x.via === via)
    return p ? { teamId: p.teamId, name: p.name } : null
  }
  const potUsd = args.prizes?.potUsd ?? 0
  const walletAddress = args.prizes?.walletAddress ?? null
  const walletUsd = walletAddress ? args.walletUsd : null
  const totalUsd = potUsd + (walletUsd ?? 0)
  const splits = (args.prizes?.splits ?? []).map((sp, i) => ({
    place: i + 1,
    label: sp.label,
    share: sp.share,
    amountUsd: Math.round(totalUsd * sp.share) / 100,
    teamId: places[i]?.teamId ?? null,
    name: places[i]?.name ?? null,
  }))
  return {
    finalizedAt: args.now.toISOString(),
    seasonYear: args.seasonYear,
    champion: who('champion'),
    runnerUp: who('runner_up'),
    places,
    pot: { potUsd, walletAddress, walletUsd, totalUsd },
    splits,
  }
}

export async function readFinalSnapshot(
  db: Db,
  leagueId: string,
  seasonYear: number
): Promise<FinalSnapshot | null> {
  const [row] = await db
    .select()
    .from(mnsPrizePayouts)
    .where(and(eq(mnsPrizePayouts.leagueId, leagueId), eq(mnsPrizePayouts.seasonYear, seasonYear)))
    .limit(1)
  return (row?.payouts as FinalSnapshot | undefined) ?? null
}

// Idempotent: returns the existing record if there is one, otherwise
// computes and writes it. Safe to call on every tick for every crowned
// league — that is exactly how a missed flip catches up.
export async function ensureFinalSnapshot(
  db: Db,
  league: { id: string; seasonYear: number; config: LeagueConfig },
  valueWalletUsd: (address: string) => Promise<number | null>,
  now = new Date()
): Promise<{ written: boolean; snapshot: FinalSnapshot }> {
  const existing = await readFinalSnapshot(db, league.id, league.seasonYear)
  if (existing) return { written: false, snapshot: existing }

  const teams = (await db
    .select({ id: mnsTeams.id, name: mnsTeams.name })
    .from(mnsTeams)
    .where(eq(mnsTeams.leagueId, league.id))) as Array<{ id: string; name: string }>
  const standings = await computeStandings(db, league.id, league.seasonYear)
  const [bracket] = await db
    .select()
    .from(mnsPlayoffBrackets)
    .where(
      and(eq(mnsPlayoffBrackets.leagueId, league.id), eq(mnsPlayoffBrackets.seasonYear, league.seasonYear))
    )
    .limit(1)
  const seeds = ((bracket?.bracket as { seeds?: Seeded[] } | undefined)?.seeds ?? []) as Seeded[]
  const playoff = (await db
    .select({
      matchupWeek: mnsMatchups.matchupWeek,
      homeTeamId: mnsMatchups.homeTeamId,
      awayTeamId: mnsMatchups.awayTeamId,
      homeScore: mnsMatchups.homeScore,
      awayScore: mnsMatchups.awayScore,
    })
    .from(mnsMatchups)
    .where(
      and(
        eq(mnsMatchups.leagueId, league.id),
        eq(mnsMatchups.isPlayoff, true),
        eq(mnsMatchups.seasonYear, league.seasonYear)
      )
    )) as PlayoffMatchupLite[]

  const places = finalPlaces(
    teams.map((t) => t.id),
    standings,
    seeds,
    playoff
  )
  const address = league.config.prizes?.walletAddress ?? null
  const walletUsd = address && /^0x[a-fA-F0-9]{40}$/.test(address) ? await valueWalletUsd(address) : null
  const snapshot = buildFinalSnapshot({
    seasonYear: league.seasonYear,
    now,
    teams,
    places,
    prizes: league.config.prizes,
    walletUsd,
  })
  await db
    .insert(mnsPrizePayouts)
    .values({
      id: `${league.id}_${league.seasonYear}`,
      leagueId: league.id,
      seasonYear: league.seasonYear,
      zone: 'final',
      totalPool: String(snapshot.pot.totalUsd),
      payouts: snapshot,
    })
    .onConflictDoNothing()
  // Someone else may have won the race; the stored row is the record.
  const stored = await readFinalSnapshot(db, league.id, league.seasonYear)
  return { written: true, snapshot: stored ?? snapshot }
}
