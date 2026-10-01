import type { VercelRequest, VercelResponse } from '@vercel/node'
import { eq, inArray } from 'drizzle-orm'
import { db } from '../_db.js'
import { mnsLeagues } from '../../src/lib/db/schema.js'
import { logger } from '../_logger.js'
import { ingestBios, ingestEspnDay, ingestInjuries, ingestSimDay } from '../../src/lib/season/statSources.js'
import { mnsNotifyLog } from '../../src/lib/db/schema.js'
import { easternToday, matchupWeekFor, scoreLeagueWeek } from '../../src/lib/season/score.js'
import { processWaivers } from '../../src/lib/season/waivers.js'
import { applyLineupsForToday } from '../../src/lib/season/lineups.js'
import { advancePlayoffs, maybeStartPlayoffs } from '../../src/lib/season/playoffs.js'
import { faWindow } from '../../src/lib/season/waivers.js'
import { sendFeeReceipts, sendLineupWarnings, sendWaiverResults } from '../_notify.js'
import { bookCapDuesAtTip } from '../../src/lib/season/capLock.js'
import { ensureFinalSnapshot } from '../../src/lib/season/finals.js'
import { valueWallet } from '../_wallet.js'
import type { LeagueConfig } from '../../src/types/leagueConfig.js'

// The season heartbeat, hourly. For every league in its regular season:
// ingest yesterday's and today's stat lines (yesterday again because
// late finals and ESPN corrections land after midnight), then rescore
// the affected weeks. Scoring is a full recompute, so running this
// twice — or after a correction — always lands on the same answer.
//
// The stat source is per-league config (season.statSource): 'sim' keeps
// a test season alive through the FIBA break; 'espn' is the real thing.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = req.headers['authorization']
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const now = new Date()
  const today = easternToday(now)
  const yesterday = easternToday(new Date(now.getTime() - 24 * 3600 * 1000))

  // Playoffs tick exactly like the regular season — ingest, score,
  // waivers — plus the phase transitions at the end of the pass.
  const leagues = await db
    .select()
    .from(mnsLeagues)
    .where(inArray(mnsLeagues.leaguePhase, ['regular_season', 'playoffs']))

  const report: Array<Record<string, unknown>> = []
  for (const league of leagues) {
    try {
      const config = league.config as LeagueConfig
      const source =
        (config.season as { statSource?: string }).statSource === 'sim' ? 'sim' : 'espn'

      // Rollover first: a lineup set for a day that has now arrived
      // becomes the live one before anything scores.
      await applyLineupsForToday(db, league.id, now)

      const days = [yesterday, today]
      let written = 0
      const unmatched: string[] = []
      for (const day of days) {
        // Only ingest days inside the season — the simulator would
        // happily invent games in the offseason.
        const week = await matchupWeekFor(db, league.id, day)
        if (week == null) continue
        if (source === 'sim') {
          written += (await ingestSimDay(db, league.id, day)).written
        } else {
          const r = await ingestEspnDay(db, league.id, day)
          written += r.written
          unmatched.push(...r.unmatched)
        }
      }

      const weeks = new Set<number>()
      for (const day of days) {
        const w = await matchupWeekFor(db, league.id, day)
        if (w != null) weeks.add(w)
      }
      let scored = 0
      let finalized = 0
      for (const w of weeks) {
        const r = await scoreLeagueWeek(db, league.id, config, w, now)
        scored += r.scored
        finalized += r.finalized
      }

      // Waivers clear daily at the first pass at/after 8am ET — the
      // engine gates itself, so calling every tick is safe.
      const waivers = await processWaivers(db, league.id, config, now)
      await sendWaiverResults(league.id, waivers.outcomes)

      // The lineup warning fires inside the last three hours before
      // first tip, once per day (notify_log holds the key).
      const window = await faWindow(now)
      if (source === 'espn') {
        await sendLineupWarnings(
          { id: league.id, name: league.name, seasonYear: league.seasonYear, config },
          window.firstTip,
          now
        )
      }

      // Cap dues book at first tip from the roster each team carried
      // in — once per day, never undone. Receipts go out as they book.
      const dues = await bookCapDuesAtTip(db, { id: league.id, seasonYear: league.seasonYear }, config, window.firstTip, now)
      if (dues.booked.length > 0) {
        await sendFeeReceipts({ id: league.id, name: league.name }, dues.booked)
      }

      // The injury report, full-refresh (sim leagues skip it — their
      // players never really get hurt).
      const injuries = source === 'espn' ? await ingestInjuries(db, league.id) : { updated: 0 }

      // Bios refresh weekly — the notify_log key makes one tick a week
      // do the work.
      if (source === 'espn') {
        const week = `${today.slice(0, 4)}-w${Math.ceil(
          (Date.parse(today) - Date.parse(`${today.slice(0, 4)}-01-01`)) / (7 * 86400000)
        )}`
        const claimed = await db
          .insert(mnsNotifyLog)
          .values({ leagueId: league.id, kind: 'bios', dateKey: week })
          .onConflictDoNothing()
          .returning()
        if (claimed.length > 0) await ingestBios(db, league.id)
      }

      // Phase transitions: regular season → playoffs once everything
      // is banked; round → round → champion as playoff weeks final.
      const started = await maybeStartPlayoffs(db, league, config, now)
      const playoff = await advancePlayoffs(
        db,
        started ? { ...league, leaguePhase: 'playoffs' } : league,
        config,
        now
      )

      if (unmatched.length) {
        logger.error('season-tick: unmatched ESPN names', {
          leagueId: league.id,
          unmatched: [...new Set(unmatched)].slice(0, 30),
        })
      }
      report.push({
        league: league.name,
        source,
        linesWritten: written,
        matchupsScored: scored,
        finalized,
        waiversGranted: waivers.granted,
        waiversFailed: waivers.failed,
        duesBooked: dues.booked.length,
        injuriesUpdated: injuries.updated,
        playoffsStarted: started,
        playoffsAdvanced: playoff.advanced,
        ...(playoff.champion ? { champion: playoff.champion } : {}),
        unmatched: [...new Set(unmatched)].length,
      })
    } catch (err) {
      logger.error('season-tick failed for league', {
        leagueId: league.id,
        err: err instanceof Error ? err.message : String(err),
      })
      report.push({ league: league.name, failed: String(err) })
    }
  }

  // Season-end records. Every crowned league gets ONE frozen snapshot
  // of the final places and the pot. Idempotent, so a league crowned
  // on this very tick and a league whose flip missed its snapshot
  // both land here.
  const crowned = await db.select().from(mnsLeagues).where(eq(mnsLeagues.leaguePhase, 'champion'))
  const finalsWritten: string[] = []
  for (const league of crowned) {
    try {
      const r = await ensureFinalSnapshot(
        db,
        { id: league.id, seasonYear: league.seasonYear, config: league.config as LeagueConfig },
        async (address) => (await valueWallet(address)).usdValue,
        now
      )
      if (r.written) finalsWritten.push(league.name)
    } catch (err) {
      logger.error('season-tick: final snapshot failed', {
        leagueId: league.id,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return res.status(200).json({ ok: true, today, leagues: report, finalsWritten })
}
