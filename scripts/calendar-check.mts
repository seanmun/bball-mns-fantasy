// Print a season as a league would see it in settings: weeks from a
// start date, games per club, light weeks, and the suggested folds —
// straight from the sport's pulled calendar.
//   VITE_SPORT=nba npx tsx scripts/calendar-check.mts 2026-10-20 22 3
import { config } from 'dotenv'
import { neon } from '@neondatabase/serverless'
import { summarizeWeeks, suggestCombinedWeeks } from '../src/rules/scheduleRules.js'
import { sport } from '../src/lib/sport/index.js'

config({ path: '.env.local', quiet: true })
const [startDate, weeksArg, playoffArg] = process.argv.slice(2)
if (!startDate) throw new Error('usage: calendar-check.mts <startDate> [weeks] [playoffWeeks]')
const regular = Number(weeksArg ?? sport.preset.season.weeks)
const playoffs = Number(playoffArg ?? sport.preset.schedule.playoffWeeks)
const client = neon(process.env.DATABASE_URL!)
const days = (await client.query(`select date, games, teams from ${sport.schema}.sport_game_days order by date`)) as Array<{
  date: string
  games: number
  teams: string[]
}>
const weeks = summarizeWeeks(days, startDate, regular + playoffs)
console.log(`${sport.key}: ${regular} regular + ${playoffs} playoff weeks from ${startDate}`)
for (const w of weeks) {
  console.log(
    `${w.week > regular ? 'PO' : 'Wk'} ${String(w.week).padStart(2)}  ${w.startDate}..${w.endDate}  games ${String(w.games).padStart(3)}  per club ${w.avgPerTeam.toFixed(2)}  light clubs ${String(w.teamsLight).padStart(2)}  dark days ${w.zeroDays.length}`
  )
}
for (const s of suggestCombinedWeeks(weeks, regular)) console.log(`→ ${s.kind}: ${s.label} — ${s.reason}`)
