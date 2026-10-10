import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm'
import { mnsSportGameDays, mnsSportPlayers, mnsSportStatLines, mnsSportSync } from '../db/schema.js'
import { sport } from '../sport/index.js'
import {
  ESPN_BASE,
  ESPN_SCOREBOARD,
  ageFrom,
  athleteIdFromLinks,
  fetchJson,
  normName,
  ourCode,
  parseBox,
  salaryFor,
  type EspnContract,
  type EspnSummary,
} from './espn.js'
import { easternToday } from './score.js'
import { syncSeasonAverages } from './seasonAverages.js'
import { scrapeWnbaPlayers } from '../scrapers/wnba.js'

// The sport pass. ESPN is read ONCE per sport per tick and written to
// the sport tables; leagues never touch ESPN. Rosters (and, where the
// sport scrapes them, salaries) refresh once a day; injuries and the
// box scores for yesterday and today refresh every tick. Everything
// keys on ESPN's athlete id — a name is only used to meet a player the
// first time, when a salary source knew her before ESPN did.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

interface EspnAthlete {
  id?: string | number
  displayName?: string
  fullName?: string
  jersey?: string | null
  age?: number
  dateOfBirth?: string
  experience?: { years?: number }
  position?: { abbreviation?: string }
  contracts?: EspnContract[]
  links?: Array<{ href?: string }>
}

interface Known {
  id: string
  espnId: string | null
  name: string
}

const weekKey = (today: string) =>
  `${today.slice(0, 4)}-w${Math.ceil((Date.parse(today) - Date.parse(`${today.slice(0, 4)}-01-01`)) / (7 * 86400000))}`

async function loadKnown(db: Db): Promise<{ byEspn: Map<string, Known>; byName: Map<string, Known> }> {
  const rows = (await db
    .select({ id: mnsSportPlayers.id, espnId: mnsSportPlayers.espnId, name: mnsSportPlayers.name })
    .from(mnsSportPlayers)) as Known[]
  const byEspn = new Map<string, Known>()
  const byName = new Map<string, Known>()
  for (const r of rows) {
    if (r.espnId) byEspn.set(r.espnId, r)
    byName.set(normName(r.name), r)
  }
  return { byEspn, byName }
}

// Claim a kind for a day. The claim lands first so two ticks never run
// the same daily job twice; a job that throws releases its claim so
// the next tick tries again.
async function claim(db: Db, kind: string, dateKey: string): Promise<boolean> {
  const rows = await db
    .insert(mnsSportSync)
    .values({ kind, dateKey })
    .onConflictDoNothing()
    .returning({ kind: mnsSportSync.kind })
  return rows.length > 0
}
async function release(db: Db, kind: string, dateKey: string) {
  await db.delete(mnsSportSync).where(and(eq(mnsSportSync.kind, kind), eq(mnsSportSync.dateKey, dateKey)))
}
async function note(db: Db, kind: string, dateKey: string, detail: unknown) {
  await db
    .update(mnsSportSync)
    .set({ detail: detail as Record<string, unknown>, ranAt: new Date() })
    .where(and(eq(mnsSportSync.kind, kind), eq(mnsSportSync.dateKey, dateKey)))
}

// Every club's roster. New players are created, known ones refreshed,
// and — only when every club answered — anyone no club listed is
// marked absent (abroad, unsigned, retired).
export async function syncRosters(db: Db, now = new Date()) {
  const teams = await fetchJson<{
    sports?: Array<{ leagues?: Array<{ teams?: Array<{ team: { id: string; abbreviation: string } }> }> }>
  }>(`${ESPN_BASE}/teams`)
  const clubs = teams.sports?.[0]?.leagues?.[0]?.teams ?? []
  const known = await loadKnown(db)
  const seen = new Set<string>()
  let failed = 0
  let created = 0
  let refreshed = 0

  for (const c of clubs) {
    try {
      const roster = await fetchJson<{ team?: { abbreviation?: string }; athletes?: EspnAthlete[] }>(
        `${ESPN_BASE}/teams/${c.team.id}/roster`
      )
      const teamCode = ourCode(roster.team?.abbreviation ?? c.team.abbreviation)
      for (const a of roster.athletes ?? []) {
        const espnId = a.id != null ? String(a.id) : null
        const name = a.displayName ?? a.fullName
        if (!espnId || !name) continue
        const salary =
          sport.salary.source === 'espn-contracts'
            ? salaryFor(a.contracts, sport.calendar.seasonYear, sport.salary.minimum)
            : null
        const fields = {
          espnId,
          name,
          teamCode,
          position: a.position?.abbreviation ?? '',
          jersey: a.jersey ?? null,
          age: a.age ?? ageFrom(a.dateOfBirth, now),
          dateOfBirth: a.dateOfBirth ?? null,
          yearsPro: a.experience?.years ?? null,
          presence: sport.presence(a),
          rosterSeenAt: now,
          updatedAt: now,
          ...(salary
            ? { salary: salary.salary, salarySource: salary.source, salarySeasonYear: sport.calendar.seasonYear }
            : {}),
        }
        // By ESPN id first; then a player a salary source met before
        // ESPN did (same name, no ESPN id yet) adopts this id.
        const row = known.byEspn.get(espnId) ?? known.byName.get(normName(name))
        if (row && (row.espnId === espnId || row.espnId == null)) {
          await db.update(mnsSportPlayers).set(fields).where(eq(mnsSportPlayers.id, row.id))
          row.espnId = espnId
          known.byEspn.set(espnId, row)
          seen.add(row.id)
          refreshed++
        } else {
          await db.insert(mnsSportPlayers).values({ id: espnId, ...fields }).onConflictDoNothing()
          const fresh = { id: espnId, espnId, name }
          known.byEspn.set(espnId, fresh)
          known.byName.set(normName(name), fresh)
          seen.add(espnId)
          created++
        }
      }
    } catch {
      failed++
    }
  }

  let absent = 0
  if (failed === 0 && seen.size > 0) {
    const gone = await db
      .update(mnsSportPlayers)
      .set({ presence: 'absent', updatedAt: now })
      .where(and(notInArray(mnsSportPlayers.id, [...seen]), sql`${mnsSportPlayers.presence} <> 'absent'`))
      .returning({ id: mnsSportPlayers.id })
    absent = gone.length
  }
  return { clubs: clubs.length, failed, created, refreshed, absent }
}

// WNBA salaries from Her Hoop Stats. Matches by slug, then by name; a
// player HHS knows and no ESPN roster lists (abroad, unsigned) gets
// her own row so she can be stashed and drafted.
export async function syncSalariesScraped(db: Db, seasonYear: number, now = new Date()) {
  const scrape = await scrapeWnbaPlayers(seasonYear)
  const rows = (await db
    .select({ id: mnsSportPlayers.id, name: mnsSportPlayers.name, externalIds: mnsSportPlayers.externalIds })
    .from(mnsSportPlayers)) as Array<{ id: string; name: string; externalIds: { hhs?: string } }>
  const bySlug = new Map(rows.filter((r) => r.externalIds?.hhs).map((r) => [r.externalIds.hhs!, r.id]))
  const byName = new Map(rows.map((r) => [normName(r.name), r.id]))
  let matched = 0
  let created = 0
  for (const p of scrape.players) {
    if (!p.slug || !p.name) continue
    const id = bySlug.get(p.slug) ?? byName.get(normName(p.name))
    const money = {
      salary: p.salary,
      salarySource: 'herhoopstats',
      salarySeasonYear: seasonYear,
      externalIds: sql`${mnsSportPlayers.externalIds} || ${JSON.stringify({ hhs: p.slug })}::jsonb`,
      updatedAt: now,
    }
    if (id) {
      await db.update(mnsSportPlayers).set(money).where(eq(mnsSportPlayers.id, id))
      matched++
    } else {
      await db
        .insert(mnsSportPlayers)
        .values({
          id: `hhs:${p.slug}`,
          name: p.name,
          teamCode: p.team ?? '',
          position: p.position || 'F',
          presence: 'absent',
          salary: p.salary,
          salarySource: 'herhoopstats',
          salarySeasonYear: seasonYear,
          externalIds: { hhs: p.slug },
          updatedAt: now,
        })
        .onConflictDoNothing()
      byName.set(normName(p.name), `hhs:${p.slug}`)
      created++
    }
  }
  return { scraped: scrape.players.length, matched, created, sourceStatus: scrape.sourceStatus }
}

// ESPN's league-wide injury report, full refresh: players missing from
// the report are cleared (healthy again). Matched by the id in the
// player-card link, by name when the link is missing.
export async function syncInjuries(db: Db, now = new Date()) {
  const report = await fetchJson<{
    injuries?: Array<{
      injuries?: Array<{
        status?: string
        shortComment?: string
        longComment?: string
        athlete?: { displayName?: string; links?: Array<{ href?: string }> }
      }>
    }>
  }>(`${ESPN_BASE}/injuries`)
  const known = await loadKnown(db)
  const hits = new Map<string, { status: string; note: string | null }>()
  let unmatched = 0
  for (const team of report.injuries ?? []) {
    for (const inj of team.injuries ?? []) {
      const name = inj.athlete?.displayName
      if (!name || !inj.status) continue
      const espnId = athleteIdFromLinks(inj.athlete?.links)
      const row = (espnId && known.byEspn.get(espnId)) || known.byName.get(normName(name))
      if (!row) {
        unmatched++
        continue
      }
      hits.set(row.id, { status: inj.status, note: inj.shortComment ?? inj.longComment ?? null })
    }
  }
  const current = (await db
    .select({ id: mnsSportPlayers.id, injuryStatus: mnsSportPlayers.injuryStatus, injuryNote: mnsSportPlayers.injuryNote })
    .from(mnsSportPlayers)
    .where(sql`${mnsSportPlayers.injuryStatus} is not null or ${mnsSportPlayers.id} in ${hits.size ? sql`(${sql.join([...hits.keys()].map((k) => sql`${k}`), sql`, `)})` : sql`('')`}`)) as Array<{
    id: string
    injuryStatus: string | null
    injuryNote: string | null
  }>
  let changed = 0
  const seenIds = new Set<string>()
  for (const p of current) {
    seenIds.add(p.id)
    const hit = hits.get(p.id)
    if (hit) {
      if (p.injuryStatus !== hit.status || p.injuryNote !== hit.note) {
        await db
          .update(mnsSportPlayers)
          .set({ injuryStatus: hit.status, injuryNote: hit.note, injuryUpdatedAt: now, updatedAt: now })
          .where(eq(mnsSportPlayers.id, p.id))
        changed++
      }
    } else if (p.injuryStatus != null) {
      await db
        .update(mnsSportPlayers)
        .set({ injuryStatus: null, injuryNote: null, injuryUpdatedAt: now, updatedAt: now })
        .where(eq(mnsSportPlayers.id, p.id))
      changed++
    }
  }
  // Newly reported players whose rows had no status yet.
  for (const [id, hit] of hits) {
    if (seenIds.has(id)) continue
    await db
      .update(mnsSportPlayers)
      .set({ injuryStatus: hit.status, injuryNote: hit.note, injuryUpdatedAt: now, updatedAt: now })
      .where(eq(mnsSportPlayers.id, id))
    changed++
  }
  return { reported: hits.size, changed, unmatched }
}

// Every box score for an Eastern date, in-progress games included
// (totals recompute every pass, so a partial box is replaced by the
// final one — that is what makes scoring feel live). A player who
// appears in a box but on no roster yet (just signed) gets a row so no
// line is ever lost.
export async function syncStatLines(db: Db, date: string, now = new Date()) {
  const yyyymmdd = date.replace(/-/g, '')
  const board = await fetchJson<{
    events?: Array<{ id: string; status: { type: { state: string } } }>
  }>(`${ESPN_SCOREBOARD}?dates=${yyyymmdd}`)
  const events = (board.events ?? []).filter((e) => e.status.type.state !== 'pre')
  if (events.length === 0) return { games: 0, written: 0, created: 0 }

  const known = await loadKnown(db)
  let written = 0
  let created = 0
  for (const event of events) {
    const summary = await fetchJson<EspnSummary>(`${ESPN_BASE}/summary?event=${event.id}`)
    for (const line of parseBox(summary)) {
      let row = known.byEspn.get(line.playerId) ?? known.byName.get(normName(line.name))
      if (row && row.espnId == null) {
        await db.update(mnsSportPlayers).set({ espnId: line.playerId, updatedAt: now }).where(eq(mnsSportPlayers.id, row.id))
        row.espnId = line.playerId
        known.byEspn.set(line.playerId, row)
      }
      if (!row) {
        await db
          .insert(mnsSportPlayers)
          .values({
            id: line.playerId,
            espnId: line.playerId,
            name: line.name,
            teamCode: line.teamAbbreviation ? ourCode(line.teamAbbreviation) : '',
            presence: 'rostered',
            rosterSeenAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
        row = { id: line.playerId, espnId: line.playerId, name: line.name }
        known.byEspn.set(line.playerId, row)
        known.byName.set(normName(line.name), row)
        created++
      }
      const { playerId: _espn, name: _n, teamAbbreviation: _t, ...stats } = line
      void _espn; void _n; void _t
      await db
        .insert(mnsSportStatLines)
        .values({ playerId: row.id, date, eventId: event.id, ...stats, updatedAt: now })
        .onConflictDoUpdate({
          target: [mnsSportStatLines.playerId, mnsSportStatLines.date],
          set: { eventId: event.id, ...stats, updatedAt: now },
        })
      written++
    }
  }
  return { games: events.length, written, created }
}

// The calendar: game counts per date from the scoreboard, one month
// per call so a tick never waits on the whole season. Ten requests at
// a time; a failed day keeps its old row.
export async function syncCalendarMonth(db: Db, month: string, now = new Date()) {
  const [y, m] = month.split('-').map(Number)
  const first = new Date(Date.UTC(y, m - 1, 1))
  const last = new Date(Date.UTC(y, m, 0))
  const from = sport.calendar.seasonStart
  const to = sport.calendar.seasonEnd
  const dates: string[] = []
  for (let d = first; d <= last; d = new Date(d.getTime() + 86400000)) {
    const iso = d.toISOString().slice(0, 10)
    if (iso >= from && iso <= to) dates.push(iso)
  }
  let written = 0
  let failed = 0
  for (let i = 0; i < dates.length; i += 10) {
    const batch = dates.slice(i, i + 10)
    const results = await Promise.all(
      batch.map(async (date) => {
        try {
          const board = await fetchJson<{
            events?: Array<{ competitions?: Array<{ competitors?: Array<{ team: { abbreviation: string } }> }> }>
          }>(`${ESPN_SCOREBOARD}?dates=${date.replace(/-/g, '')}`)
          const events = board.events ?? []
          const teams = new Set<string>()
          for (const e of events) for (const c of e.competitions?.[0]?.competitors ?? []) teams.add(ourCode(c.team.abbreviation))
          return { date, games: events.length, teams: [...teams] }
        } catch {
          return null
        }
      })
    )
    for (const r of results) {
      if (!r) {
        failed++
        continue
      }
      await db
        .insert(mnsSportGameDays)
        .values({ date: r.date, games: r.games, teams: r.teams, updatedAt: now })
        .onConflictDoUpdate({ target: mnsSportGameDays.date, set: { games: r.games, teams: r.teams, updatedAt: now } })
      written++
    }
  }
  return { month, days: dates.length, written, failed }
}

// Every month of the season, in order, oldest claim first — one month
// per tick, refreshed each week.
export async function syncCalendar(db: Db, now = new Date()) {
  const months: string[] = []
  const [sy, sm] = sport.calendar.seasonStart.split('-').map(Number)
  const [ey, em] = sport.calendar.seasonEnd.split('-').map(Number)
  for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m === 12 ? (y++, (m = 1)) : m++) {
    months.push(`${y}-${String(m).padStart(2, '0')}`)
  }
  const week = weekKey(easternToday(now))
  for (const month of months) {
    const key = `calendar:${month}:${week}`
    if (!(await claim(db, 'calendar', key))) continue
    try {
      const r = await syncCalendarMonth(db, month, now)
      await note(db, 'calendar', key, r)
      return r
    } catch (err) {
      await release(db, 'calendar', key)
      throw err
    }
  }
  return { skipped: true as const }
}

export interface SportPassReport {
  calendar?: Awaited<ReturnType<typeof syncCalendar>> | { error: string }
  rosters?: Awaited<ReturnType<typeof syncRosters>> | { skipped: true } | { error: string }
  salaries?: Awaited<ReturnType<typeof syncSalariesScraped>> | { skipped: true } | { error: string }
  injuries?: Awaited<ReturnType<typeof syncInjuries>> | { error: string }
  lines?: Record<string, Awaited<ReturnType<typeof syncStatLines>> | { error: string }>
  seasonAverages?: Awaited<ReturnType<typeof syncSeasonAverages>> | { error: string }
}

// One sport pass per tick: the daily jobs claim their day, the live
// jobs just run. A failing step is reported, never fatal to the rest.
export async function runSportPass(db: Db, now = new Date()): Promise<SportPassReport> {
  const today = easternToday(now)
  const yesterday = easternToday(new Date(now.getTime() - 24 * 3600 * 1000))
  const report: SportPassReport = {}

  if (await claim(db, 'rosters', today)) {
    try {
      report.rosters = await syncRosters(db, now)
      await note(db, 'rosters', today, report.rosters)
    } catch (err) {
      await release(db, 'rosters', today)
      report.rosters = { error: err instanceof Error ? err.message : String(err) }
    }
  } else {
    report.rosters = { skipped: true }
  }

  if (sport.salary.source === 'herhoopstats') {
    const key = weekKey(today)
    if (await claim(db, 'salaries', key)) {
      try {
        report.salaries = await syncSalariesScraped(db, sport.calendar.seasonYear, now)
        await note(db, 'salaries', key, report.salaries)
      } catch (err) {
        await release(db, 'salaries', key)
        report.salaries = { error: err instanceof Error ? err.message : String(err) }
      }
    } else {
      report.salaries = { skipped: true }
    }
  }

  try {
    report.calendar = await syncCalendar(db, now)
  } catch (err) {
    report.calendar = { error: err instanceof Error ? err.message : String(err) }
  }

  try {
    report.injuries = await syncInjuries(db, now)
  } catch (err) {
    report.injuries = { error: err instanceof Error ? err.message : String(err) }
  }

  report.lines = {}
  for (const day of [yesterday, today]) {
    try {
      report.lines[day] = await syncStatLines(db, day, now)
    } catch (err) {
      report.lines[day] = { error: err instanceof Error ? err.message : String(err) }
    }
  }
  // Last season's averages, a slice per tick until everyone has a row;
  // a cheap no-op once they do.
  try {
    report.seasonAverages = await syncSeasonAverages(db, sport.calendar.seasonYear - 1, { limit: 60 })
  } catch (err) {
    report.seasonAverages = { error: err instanceof Error ? err.message : String(err) }
  }
  return report
}

// Which sport players are on ESPN rosters right now — handy for the
// pool copy and for tests.
export async function rosteredIds(db: Db): Promise<string[]> {
  const rows = (await db
    .select({ id: mnsSportPlayers.id })
    .from(mnsSportPlayers)
    .where(and(isNotNull(mnsSportPlayers.rosterSeenAt), inArray(mnsSportPlayers.presence, ['rostered', 'rights_only'])))) as Array<{ id: string }>
  return rows.map((r) => r.id)
}
