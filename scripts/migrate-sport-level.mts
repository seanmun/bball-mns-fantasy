// One-time migration to sport-level data, per deployment.
//
//   VITE_SPORT=wnba npx tsx scripts/migrate-sport-level.mts [--apply]
//
// Without --apply it only REPORTS: how many league players link to a
// sport player by exact name, who does not, and how many stat lines
// would move. With --apply it writes players.sport_player_id and copies
// each league's stat lines into sport_stat_lines (first writer wins on
// a player+date; the values are the same box score). It never drops
// anything — the drops are a separate schema step after this report is
// clean. Reads the old identity columns by raw SQL so it does not depend
// on them staying in the drizzle schema.
import { config } from 'dotenv'
import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import { sql } from 'drizzle-orm'
import { syncRosters, syncSalariesScraped } from '../src/lib/season/sportSync.js'
import { normName } from '../src/lib/season/espn.js'
import { sport } from '../src/lib/sport/index.js'

config({ path: '.env.local', quiet: true })
const apply = process.argv.includes('--apply')
const client = neon(process.env.DATABASE_URL!)
const db = drizzle(client)
const schema = sport.schema

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  (await client.query(text, params)) as T[]

console.log(`sport=${sport.key} schema=${schema} mode=${apply ? 'APPLY' : 'report only'}`)

// 1. The sport table must be filled before anything links to it.
const [{ n: sportCount }] = await q<{ n: number }>(`select count(*)::int as n from ${schema}.sport_players`)
console.log(`sport_players rows: ${sportCount}`)
if (sportCount === 0) {
  if (!apply) {
    console.log('sport_players is empty — --apply will fill it from ESPN (and Her Hoop Stats for the WNBA) first.')
  } else {
    console.log('filling sport_players from ESPN rosters…')
    console.log('  rosters:', JSON.stringify(await syncRosters(db)))
    if (sport.salary.source === 'herhoopstats') {
      console.log('  salaries:', JSON.stringify(await syncSalariesScraped(db, sport.calendar.seasonYear)))
    }
  }
}

// 2. Link league players to sport players by exact normalized name.
const sportRows = await q<{ id: string; name: string }>(`select id, name from ${schema}.sport_players`)
const byName = new Map<string, string[]>()
for (const r of sportRows) {
  const k = normName(r.name)
  byName.set(k, [...(byName.get(k) ?? []), r.id])
}
const leagueRows = await q<{ id: string; league_id: string; name: string; sport_player_id: string | null }>(
  `select id, league_id, name, sport_player_id from ${schema}.players`
)
let linked = 0
let already = 0
const ambiguous: string[] = []
const unmatched: string[] = []
const links: Array<[string, string]> = []
for (const p of leagueRows) {
  if (p.sport_player_id) { already++; continue }
  const hits = byName.get(normName(p.name)) ?? []
  if (hits.length === 1) { links.push([p.id, hits[0]]); linked++ }
  else if (hits.length > 1) ambiguous.push(`${p.name} (${p.league_id})`)
  else unmatched.push(`${p.name} (${p.league_id})`)
}
console.log(`league players: ${leagueRows.length} — already linked ${already}, link by name ${linked}, ambiguous ${ambiguous.length}, unmatched ${unmatched.length}`)
if (ambiguous.length) console.log('  ambiguous:', ambiguous.join('; '))
if (unmatched.length) console.log('  unmatched:', unmatched.slice(0, 60).join('; '), unmatched.length > 60 ? `… +${unmatched.length - 60}` : '')

if (apply && links.length) {
  for (const [id, sportId] of links) {
    await q(`update ${schema}.players set sport_player_id = $1 where id = $2`, [sportId, id])
  }
  console.log(`wrote ${links.length} links`)
}

// 3. Stat lines: league lines → sport lines through the link.
const [{ n: lineCount }] = await q<{ n: number }>(
  `select count(*)::int as n from ${schema}.player_stat_lines l join ${schema}.players p on p.id = l.player_id where p.sport_player_id is not null`
)
const [{ n: orphanLines }] = await q<{ n: number }>(
  `select count(*)::int as n from ${schema}.player_stat_lines l join ${schema}.players p on p.id = l.player_id where p.sport_player_id is null`
)
console.log(`stat lines linkable: ${lineCount}, on unlinked players: ${orphanLines}`)
if (apply && lineCount > 0) {
  const r = await q(`
    insert into ${schema}.sport_stat_lines (player_id, date, min, pts, fgm, fga, ftm, fta, tpm, reb, ast, stl, blk, tov)
    select distinct on (p.sport_player_id, l.date) p.sport_player_id, l.date, l.min, l.pts, l.fgm, l.fga, l.ftm, l.fta, l.tpm, l.reb, l.ast, l.stl, l.blk, l.tov
    from ${schema}.player_stat_lines l join ${schema}.players p on p.id = l.player_id
    where p.sport_player_id is not null
    order by p.sport_player_id, l.date, l.created_at desc
    on conflict (player_id, date) do nothing
    returning player_id`)
  console.log(`copied ${r.length} sport stat lines`)
}

const [{ n: afterLinked }] = await q<{ n: number }>(`select count(*)::int as n from ${schema}.players where sport_player_id is not null`)
const [{ n: afterLines }] = await q<{ n: number }>(`select count(*)::int as n from ${schema}.sport_stat_lines`)
console.log(`now: linked league players ${afterLinked}/${leagueRows.length}, sport stat lines ${afterLines}`)
