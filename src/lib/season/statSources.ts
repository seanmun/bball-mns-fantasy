import { and, eq, sql } from 'drizzle-orm'
import { mnsPlayerStatLines, mnsPlayers } from '../db/schema.js'
import { sport } from '../sport/index.js'

// Two sources, one contract: given a league and an Eastern date, write
// player_stat_lines rows. The scorer never knows which one ran.
//
// 'sim'  — deterministic box scores for every rostered player, seeded
//          by (playerId, date). Exists because the FIBA break (and any
//          future gap) must not stall a test season.
// 'espn' — real box scores from ESPN's public WNBA API, matched to the
//          league pool by normalized name. Unmatched names are returned
//          so nobody silently scores zero.

export interface StatLine {
  playerId: string
  min: number
  pts: number
  fgm: number
  fga: number
  ftm: number
  fta: number
  tpm: number
  reb: number
  ast: number
  stl: number
  blk: number
  tov: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

async function upsertLines(db: Db, leagueId: string, date: string, source: string, lines: StatLine[]) {
  for (const l of lines) {
    await db
      .insert(mnsPlayerStatLines)
      .values({ leagueId, playerId: l.playerId, date, source, ...statCols(l) })
      .onConflictDoUpdate({
        target: [mnsPlayerStatLines.leagueId, mnsPlayerStatLines.playerId, mnsPlayerStatLines.date],
        set: { source, ...statCols(l) },
      })
  }
  return lines.length
}

function statCols(l: StatLine) {
  return {
    min: l.min, pts: l.pts, fgm: l.fgm, fga: l.fga, ftm: l.ftm, fta: l.fta,
    tpm: l.tpm, reb: l.reb, ast: l.ast, stl: l.stl, blk: l.blk, tov: l.tov,
  }
}

// ── Simulator ────────────────────────────────────────────────────────
// mulberry32 over a stable seed: the same player on the same date
// always produces the same line, so re-runs are idempotent and "the
// app made it up" is fully reproducible.
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedFrom(playerId: string, date: string): number {
  let h = 2166136261
  for (const c of `${playerId}|${date}`) {
    h ^= c.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export async function ingestSimDay(
  db: Db,
  leagueId: string,
  date: string
): Promise<{ written: number }> {
  // Only ROSTERED players produce sim lines — free agents scoring
  // phantom points would make the waiver wire lie.
  const roster = await db
    .select({ id: mnsPlayers.id, salary: mnsPlayers.salary })
    .from(mnsPlayers)
    .where(and(eq(mnsPlayers.leagueId, leagueId), sql`${mnsPlayers.teamId} is not null`))

  const salaries = roster.map((p: { salary: number | null }) => p.salary ?? 0)
  const maxSalary = Math.max(1, ...salaries)

  const lines: StatLine[] = roster.map((p: { id: string; salary: number | null }) => {
    const rnd = mulberry32(seedFrom(p.id, date))
    // Better players (salary as the quality proxy the pool already
    // carries) get better baselines; everyone varies game to game.
    const quality = 0.35 + 0.65 * ((p.salary ?? 0) / maxSalary)
    const played = rnd() < 0.92 // occasional DNP keeps it honest
    if (!played) {
      return { playerId: p.id, min: 0, pts: 0, fgm: 0, fga: 0, ftm: 0, fta: 0, tpm: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 }
    }
    const min = Math.round(14 + quality * 18 + rnd() * 6)
    const fga = Math.round(4 + quality * 12 + rnd() * 4)
    const fgm = Math.round(fga * (0.34 + quality * 0.14 + rnd() * 0.1))
    const tpa = Math.round(fga * (0.2 + rnd() * 0.25))
    const tpm = Math.round(tpa * (0.25 + quality * 0.12 + rnd() * 0.1))
    const fta = Math.round(1 + quality * 4 + rnd() * 3)
    const ftm = Math.round(fta * (0.72 + quality * 0.12 + rnd() * 0.1))
    return {
      playerId: p.id,
      min,
      pts: (fgm - tpm) * 2 + tpm * 3 + ftm,
      fgm,
      fga,
      ftm,
      fta,
      tpm,
      reb: Math.round(1 + quality * 7 + rnd() * 3),
      ast: Math.round(quality * 5 + rnd() * 3),
      stl: Math.round(rnd() * (1 + quality * 2)),
      blk: Math.round(rnd() * (0.5 + quality * 1.5)),
      tov: Math.round(0.5 + rnd() * 3),
    }
  })

  const written = await upsertLines(db, leagueId, date, 'sim', lines)
  return { written }
}

// ── ESPN ─────────────────────────────────────────────────────────────

const ESPN = `https://site.api.espn.com/apis/site/v2/sports/${sport.espn.league}`

function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function pair(v: string): [number, number] {
  const m = v.match(/^(\d+)-(\d+)$/)
  return m ? [Number(m[1]), Number(m[2])] : [0, 0]
}

// ESPN's team-code spelling -> ours, per sport.
export const CODE_ALIAS: Record<string, string> = sport.espn.codeAlias
export const ESPN_SCOREBOARD = `${ESPN}/scoreboard`

export interface DayGame {
  opp: string
  home: boolean
  tip: string // ISO kickoff
  state: 'pre' | 'in' | 'post'
}

// Who plays on an Eastern date, keyed by OUR team code. Empty map on
// any ESPN hiccup — the lineup page then just shows no game notes.
export async function dayGames(date: string): Promise<Map<string, DayGame>> {
  try {
    const yyyymmdd = date.replace(/-/g, '')
    const board = (await (await fetch(`${ESPN}/scoreboard?dates=${yyyymmdd}`)).json()) as {
      events?: Array<{
        date: string
        status: { type: { state: string } }
        competitions?: Array<{
          competitors?: Array<{ homeAway: string; team: { abbreviation: string } }>
        }>
      }>
    }
    const map = new Map<string, DayGame>()
    for (const e of board.events ?? []) {
      const comps = e.competitions?.[0]?.competitors ?? []
      const sides = comps.map((c) => ({
        code: CODE_ALIAS[c.team.abbreviation] ?? c.team.abbreviation,
        home: c.homeAway === 'home',
      }))
      for (const side of sides) {
        const opp = sides.find((x) => x.code !== side.code)
        map.set(side.code, {
          opp: opp?.code ?? '',
          home: side.home,
          tip: e.date,
          state: (e.status.type.state as DayGame['state']) ?? 'pre',
        })
      }
    }
    return map
  } catch {
    return new Map()
  }
}

// ESPN's league-wide injury report → players.injuryStatus/Note.
// Full refresh each pass: players missing from the report are CLEARED
// (healthy again), matched by normalized name like the stat ingest.
// Player bios from ESPN team rosters: age, years pro, and WHERE SHE
// ACTUALLY IS. Weekly cadence is plenty; matched by normalized name
// like everything else.
//
// The presence read is what keeps a redshirt apart from an
// international stash — both look like "0 games" from the box scores:
//   rostered    — listed with a jersey: really with the club
//   rights_only — listed with no jersey: drafted, never reported
//   absent      — on no WNBA roster at all: playing elsewhere
// ESPN has no explicit "did not report" flag, so rights_only is a
// heuristic and the commissioner's presence_override always wins.
export async function ingestBios(
  db: Db,
  leagueId: string
): Promise<{ updated: number }> {
  const teams = (await (await fetch(`${ESPN}/teams`)).json()) as {
    sports?: Array<{ leagues?: Array<{ teams?: Array<{ team: { id: string } }> }> }>
  }
  const ids = (teams.sports?.[0]?.leagues?.[0]?.teams ?? []).map((t) => t.team.id)
  interface Bio {
    age: number | null
    yearsPro: number | null
    position: string | null
    leaguePresence: 'rostered' | 'rights_only'
  }
  const byName = new Map<string, Bio>()
  for (const id of ids) {
    try {
      const roster = (await (await fetch(`${ESPN}/teams/${id}/roster`)).json()) as {
        athletes?: Array<{
          displayName?: string
          fullName?: string
          age?: number
          jersey?: string
          experience?: { years?: number }
          position?: { abbreviation?: string }
        }>
      }
      for (const a of roster.athletes ?? []) {
        const name = a.displayName ?? a.fullName
        if (!name) continue
        byName.set(normName(name), {
          age: a.age ?? null,
          yearsPro: a.experience?.years ?? null,
          position: a.position?.abbreviation ?? null,
          // Where she actually is — the sport decides what the feed's
          // shape means (a missing number means "never reported" in the
          // WNBA and nothing at all in the NBA).
          leaguePresence: sport.presence(a),
        })
      }
    } catch {
      /* one team down never sinks the pass */
    }
  }
  // An empty sweep means ESPN was unreachable — never rewrite the whole
  // pool as "absent" off a failed fetch.
  if (byName.size === 0) return { updated: 0 }

  const pool = (await db
    .select({
      id: mnsPlayers.id,
      name: mnsPlayers.name,
      age: mnsPlayers.age,
      yearsPro: mnsPlayers.yearsPro,
      position: mnsPlayers.position,
      leaguePresence: mnsPlayers.leaguePresence,
    })
    .from(mnsPlayers)
    .where(eq(mnsPlayers.leagueId, leagueId))) as Array<{
    id: string
    name: string
    age: number | null
    yearsPro: number | null
    position: string | null
    leaguePresence: string | null
  }>
  let updated = 0
  for (const p of pool) {
    const hit = byName.get(normName(p.name))
    const age = hit?.age ?? p.age
    const yearsPro = hit?.yearsPro ?? null
    const position = hit?.position ?? p.position
    const presence = hit ? hit.leaguePresence : 'absent'
    if (
      age === p.age &&
      yearsPro === p.yearsPro &&
      position === p.position &&
      presence === p.leaguePresence
    )
      continue
    await db
      .update(mnsPlayers)
      .set({
        age,
        yearsPro,
        position,
        leaguePresence: presence,
        // The flag every other page reads becomes real here.
        ...(yearsPro != null ? { isRookie: yearsPro === 0 } : {}),
      })
      .where(eq(mnsPlayers.id, p.id))
    updated++
  }
  return { updated }
}

export async function ingestInjuries(
  db: Db,
  leagueId: string
): Promise<{ updated: number; unmatched: string[] }> {
  const report = (await (await fetch(`${ESPN}/injuries`)).json()) as {
    injuries?: Array<{
      injuries?: Array<{
        status?: string
        shortComment?: string
        longComment?: string
        athlete?: { displayName?: string }
      }>
    }>
  }
  const byName = new Map<string, { status: string; note: string | null }>()
  const unmatched: string[] = []
  for (const team of report.injuries ?? []) {
    for (const inj of team.injuries ?? []) {
      const name = inj.athlete?.displayName
      if (!name || !inj.status) continue
      byName.set(normName(name), {
        status: inj.status,
        note: inj.shortComment ?? inj.longComment ?? null,
      })
    }
  }

  const pool = (await db
    .select({
      id: mnsPlayers.id,
      name: mnsPlayers.name,
      injuryStatus: mnsPlayers.injuryStatus,
      injuryNote: mnsPlayers.injuryNote,
      injuryUpdatedAt: mnsPlayers.injuryUpdatedAt,
    })
    .from(mnsPlayers)
    .where(eq(mnsPlayers.leagueId, leagueId))) as Array<{
    id: string
    name: string
    injuryStatus: string | null
    injuryNote: string | null
    injuryUpdatedAt: Date | null
  }>
  const matchedNames = new Set<string>()
  let updated = 0
  for (const p of pool) {
    const hit = byName.get(normName(p.name))
    if (hit) {
      matchedNames.add(normName(p.name))
      // Only a CHANGED report is news — same status and note leaves
      // the freshness stamp alone.
      const changed =
        p.injuryStatus !== hit.status || p.injuryNote !== hit.note || p.injuryUpdatedAt == null
      await db
        .update(mnsPlayers)
        .set({
          injuryStatus: hit.status,
          injuryNote: hit.note,
          ...(changed ? { injuryUpdatedAt: new Date() } : {}),
        })
        .where(eq(mnsPlayers.id, p.id))
      if (changed) updated++
    } else if (p.injuryStatus != null) {
      await db
        .update(mnsPlayers)
        .set({ injuryStatus: null, injuryNote: null, injuryUpdatedAt: new Date() })
        .where(eq(mnsPlayers.id, p.id))
      updated++
    }
  }
  for (const name of byName.keys()) {
    if (!matchedNames.has(name)) unmatched.push(name)
  }
  return { updated, unmatched }
}

export async function ingestEspnDay(
  db: Db,
  leagueId: string,
  date: string // YYYY-MM-DD Eastern
): Promise<{ written: number; games: number; unmatched: string[] }> {
  const yyyymmdd = date.replace(/-/g, '')
  const board = (await (await fetch(`${ESPN}/scoreboard?dates=${yyyymmdd}`)).json()) as {
    events?: Array<{ id: string; status: { type: { state: string; completed: boolean } } }>
  }
  // In-progress games count too — totals recompute from scratch every
  // pass, so a partial box tonight is simply replaced by the final one.
  // That is what makes scoring feel LIVE during games.
  const events = (board.events ?? []).filter((e) => e.status.type.state !== 'pre')

  const pool = (await db
    .select({ id: mnsPlayers.id, name: mnsPlayers.name })
    .from(mnsPlayers)
    .where(eq(mnsPlayers.leagueId, leagueId))) as Array<{ id: string; name: string }>
  const byName = new Map(pool.map((p) => [normName(p.name), p.id]))

  const lines: StatLine[] = []
  const unmatched: string[] = []

  for (const event of events) {
    const summary = (await (await fetch(`${ESPN}/summary?event=${event.id}`)).json()) as {
      boxscore?: {
        players?: Array<{
          statistics?: Array<{
            names: string[]
            athletes: Array<{ athlete: { displayName: string }; stats: string[] }>
          }>
        }>
      }
    }
    for (const teamBox of summary.boxscore?.players ?? []) {
      const stats = teamBox.statistics?.[0]
      if (!stats) continue
      const col = (name: string) => stats.names.indexOf(name)
      const iMin = col('MIN'), iPts = col('PTS'), iFg = col('FG'), i3 = col('3PT'), iFt = col('FT')
      const iReb = col('REB'), iAst = col('AST'), iTo = col('TO'), iStl = col('STL'), iBlk = col('BLK')
      for (const a of stats.athletes) {
        const playerId = byName.get(normName(a.athlete.displayName))
        if (!playerId) {
          unmatched.push(a.athlete.displayName)
          continue
        }
        const s = a.stats
        if (!s || s.length === 0) continue // DNP row
        const [fgm, fga] = pair(s[iFg] ?? '')
        const [tpm] = pair(s[i3] ?? '')
        const [ftm, fta] = pair(s[iFt] ?? '')
        lines.push({
          playerId,
          min: Number(s[iMin]) || 0,
          pts: Number(s[iPts]) || 0,
          fgm, fga, ftm, fta, tpm,
          reb: Number(s[iReb]) || 0,
          ast: Number(s[iAst]) || 0,
          stl: Number(s[iStl]) || 0,
          blk: Number(s[iBlk]) || 0,
          tov: Number(s[iTo]) || 0,
        })
      }
    }
  }

  const written = await upsertLines(db, leagueId, date, 'espn', lines)
  return { written, games: events.length, unmatched: [...new Set(unmatched)] }
}
