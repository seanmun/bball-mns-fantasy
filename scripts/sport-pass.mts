// Run the sport pass by hand — the same jobs the tick runs, for the
// sport named by VITE_SPORT, with a summary. Rosters and salaries are
// forced (the tick claims them once a day; this ignores the claim).
//
//   VITE_SPORT=nba npx tsx scripts/sport-pass.mts [YYYY-MM-DD ...]
//
// Dates default to yesterday and today (Eastern).
import { config } from 'dotenv'
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { syncInjuries, syncRosters, syncSalariesScraped, syncStatLines } from '../src/lib/season/sportSync.js'
import { easternToday } from '../src/lib/season/score.js'
import { sport } from '../src/lib/sport/index.js'

config({ path: '.env.local', quiet: true })
const client = neon(process.env.DATABASE_URL!)
const db = drizzle(client)
const now = new Date()
const dates = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a))
if (dates.length === 0) dates.push(easternToday(new Date(now.getTime() - 86400000)), easternToday(now))

console.log(`sport=${sport.key} schema=${sport.schema}`)
console.time('rosters')
console.log('rosters:', JSON.stringify(await syncRosters(db, now)))
console.timeEnd('rosters')
if (sport.salary.source === 'herhoopstats') {
  console.time('salaries')
  const s = await syncSalariesScraped(db, sport.calendar.seasonYear, now)
  console.log('salaries:', JSON.stringify({ scraped: s.scraped, matched: s.matched, created: s.created, hhs: s.sourceStatus.herhoopstats }))
  console.timeEnd('salaries')
}
console.log('injuries:', JSON.stringify(await syncInjuries(db, now)))
for (const d of dates) console.log(`lines ${d}:`, JSON.stringify(await syncStatLines(db, d, now)))

const [sum] = (await client.query(
  `select count(*)::int as players,
          count(*) filter (where salary_source='espn-contract')::int as contracts,
          count(*) filter (where salary_source='league-minimum')::int as minimum,
          count(*) filter (where salary_source='herhoopstats')::int as scraped,
          count(*) filter (where salary_source='unknown')::int as unknown,
          count(*) filter (where presence='rostered')::int as rostered,
          count(*) filter (where presence='rights_only')::int as rights_only,
          count(*) filter (where presence='absent')::int as absent,
          count(distinct team_code)::int as teams,
          count(*) filter (where injury_status is not null)::int as injured
   from ${sport.schema}.sport_players`
)) as Record<string, number>[]
console.log('sport_players:', JSON.stringify(sum))
const top = (await client.query(
  `select name, team_code, position, salary, salary_source, years_pro, age from ${sport.schema}.sport_players order by salary desc limit 3`
)) as Record<string, unknown>[]
console.log('top salaries:', JSON.stringify(top))
const [lines] = (await client.query(
  `select count(*)::int as lines, count(distinct player_id)::int as players, min(date) as first, max(date) as last from ${sport.schema}.sport_stat_lines`
)) as Record<string, unknown>[]
console.log('sport_stat_lines:', JSON.stringify(lines))
