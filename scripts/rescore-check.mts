// Prove the sport-level stat lines reproduce a finished season: rescore
// every week of a league with the current code and report any matchup
// whose score changed. Writes the same rows scoring writes (the values
// must come out identical, so nothing visible changes).
//   VITE_SPORT=wnba npx tsx scripts/rescore-check.mts <leagueId>
import { config } from 'dotenv'
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { scoreLeagueWeek } from '../src/lib/season/score.js'
import { sport } from '../src/lib/sport/index.js'
import type { LeagueConfig } from '../src/types/leagueConfig.js'

config({ path: '.env.local', quiet: true })
const leagueId = process.argv[2]
if (!leagueId) throw new Error('league id required')
const client = neon(process.env.DATABASE_URL!)
const db = drizzle(client)
const schema = sport.schema
const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await client.query(text, params)) as T[]

const [league] = await q<{ config: LeagueConfig; season_year: number }>(`select config, season_year from ${schema}.leagues where id = $1`, [leagueId])
const before = await q<{ id: string; matchup_week: number; home_score: string; away_score: string; status: string }>(
  `select id, matchup_week, home_score, away_score, status from ${schema}.matchups where league_id = $1 order by matchup_week, id`, [leagueId])
const weeks = [...new Set(before.map((m) => m.matchup_week))]
const ends = await q<{ matchup_week: number; end_date: string }>(`select matchup_week, end_date from ${schema}.league_weeks where league_id = $1`, [leagueId])
for (const w of weeks) {
  const end = ends.find((e) => e.matchup_week === w)?.end_date ?? '2099-01-01'
  // "now" the Eastern day AFTER the week's end, so a finished week
  // stays final (Eastern midnight is 04:00Z; noon is safely past it).
  const next = new Date(new Date(`${end}T12:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10)
  const r = await scoreLeagueWeek(db, leagueId, league.config, w, new Date(`${next}T16:00:00Z`))
  console.log(`week ${w}: scored ${r.scored}`)
}
const after = await q<typeof before[number]>(
  `select id, matchup_week, home_score, away_score, status from ${schema}.matchups where league_id = $1 order by matchup_week, id`, [leagueId])
let diffs = 0
for (const b of before) {
  const a = after.find((x) => x.id === b.id)!
  if (a.home_score !== b.home_score || a.away_score !== b.away_score || a.status !== b.status) {
    diffs++
    console.log(`CHANGED ${b.id}: ${b.home_score}-${b.away_score} ${b.status} -> ${a.home_score}-${a.away_score} ${a.status}`)
  }
}
console.log(diffs === 0 ? `IDENTICAL: all ${before.length} matchups reproduce from sport-level lines` : `${diffs} matchups changed`)
