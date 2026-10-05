import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq } from 'drizzle-orm'
import { verifyAuth } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsLeagues,
  mnsPlayers,
  mnsTeamOwners,
  mnsTeams,
  mnsSportPlayers,
} from '../../../src/lib/db/schema.js'
import { leagueStatLines } from '../../../src/lib/players/statLines.js'
import { leaguePlayers } from '../../../src/lib/players/leaguePlayers.js'
import { logger } from '../../_logger.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'
import { faWindow, logTransaction } from '../../../src/lib/season/waivers.js'
import {
  clearFutureSlots,
  effectiveSlots,
  isLockedDate,
  setSlotForDate,
  shiftDate,
  type Slot,
} from '../../../src/lib/season/lineups.js'
import { easternToday } from '../../../src/lib/season/score.js'
import {
  capUsed,
  intStashEligible,
  moveShape,
  redshirtEligible,
  type MoveTarget,
} from '../../../src/lib/season/roster.js'
import { assignSlots, noSlotReason } from '../../../src/lib/season/positions.js'
import { chargeFee } from '../../../src/lib/season/fees.js'
import { dayGames } from '../../../src/lib/season/statSources.js'
import { lockReason, playerLocked, tipClock } from '../../../src/lib/season/locks.js'
import { capNotice } from '../../../src/rules/capRules.js'
import { teamExposures } from '../../../src/lib/season/capLock.js'

// Roster moves, an OWNER act. Two kinds of move share this door:
//
//   Lineup moves — Active, Bench, IR — for a DATE. Only ACTIVE players
//   score, judged per date. Past dates are locked history; today and
//   future dates are editable, and a slot set ahead carries forward.
//   IR is capped by config.roster.irSlots.
//
//   Season acts — redshirt, international stash, drop, and coming
//   back off either — carry no date: they are always today. What each
//   one owes is decided by moveShape() from where the player stands
//   and where she is going, so no path skips a fee or a check.
//
// The tip-off lock cuts across both: once a player's own game has
// tipped today she stays exactly where she is, on this team, until
// tomorrow. Players whose games have not started are still in play.
//
// POST /api/leagues/:id/roster
//   { playerId, slot: 'active'|'bench'|'ir'|'redshirt'|'international'|'drop', date? }
const TARGETS: MoveTarget[] = ['active', 'bench', 'ir', 'redshirt', 'international', 'drop']

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  const playerId = String(req.body?.playerId ?? '')
  const to = String(req.body?.slot ?? '') as MoveTarget
  if (!playerId || !TARGETS.includes(to)) {
    return res.status(400).json({
      error: 'playerId and a slot (active, bench, ir, redshirt, international, drop) are required.',
    })
  }
  const now = new Date()
  const today = easternToday(now)
  const date = String(req.body?.date ?? today)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD.' })
  }
  if (isLockedDate(date, now)) {
    return res.status(400).json({ error: 'That day is over — past lineups are locked.' })
  }
  if (date > shiftDate(today, 13)) {
    return res.status(400).json({ error: 'Lineups can be set up to two weeks ahead.' })
  }

  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })
    if (league.leaguePhase === 'champion') {
      return res.status(400).json({ error: 'The season is complete — rosters reopen when the next season starts.' })
    }
    const config = league.config as LeagueConfig

    const [mine] = await db
      .select({ teamId: mnsTeamOwners.teamId })
      .from(mnsTeamOwners)
      .innerJoin(mnsTeams, eq(mnsTeams.id, mnsTeamOwners.teamId))
      .where(and(eq(mnsTeams.leagueId, leagueId), eq(mnsTeamOwners.userId, userId)))
      .limit(1)
    if (!mine) return res.status(403).json({ error: "You don't own a team in this league." })

    const [player] = await leaguePlayers(db)
      .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
      .limit(1)
    if (!player || player.teamId !== mine.teamId) {
      return res.status(403).json({ error: 'That player is not on your roster.' })
    }

    const from = player.slot ?? 'active'
    const shape = moveShape(from, to)
    // Season acts are always today; lineup moves honour the date asked.
    const effDate = shape.seasonAct ? today : date

    // The tip-off lock, judged by HER game, today only.
    if (effDate === today) {
      const games = await dayGames(today)
      const game = player.teamCode ? games.get(player.teamCode) : undefined
      if (playerLocked(game, now)) {
        return res.status(400).json({ error: lockReason(player.name, game!) })
      }
    }

    // Salary coming back onto the books has to fit under the hard cap,
    // the same rule the waiver wire and trades enforce.
    const hardCap = config.cap?.enabled ? config.cap.hardCap : null
    if (shape.unparks && hardCap != null) {
      const rows = await db
        .select({ teamId: mnsPlayers.teamId, salary: mnsSportPlayers.salary, slot: mnsPlayers.slot })
        .from(mnsPlayers).innerJoin(mnsSportPlayers, eq(mnsSportPlayers.id, mnsPlayers.sportPlayerId))
        .where(eq(mnsPlayers.leagueId, leagueId))
      if (capUsed(rows, mine.teamId) + (player.salary ?? 0) > hardCap) {
        return res.status(400).json({
          error: `Bringing ${player.name} back would put you over the hard cap — clear room first.`,
        })
      }
    }

    if (to === 'ir') {
      // The cap is judged against the lineup of the date being edited.
      const irCap = config.roster?.irSlots ?? 3
      const dated = await effectiveSlots(db, leagueId, mine.teamId, effDate)
      const irCount = [...dated.entries()].filter(([id, s]) => s === 'ir' && id !== playerId).length
      if (irCount >= irCap) {
        return res.status(400).json({ error: `IR is full — this league allows ${irCap}.` })
      }
    }

    // Games on file — the shared half of both stash tests.
    const gamesPlayedFor = async () => {
      const lines = await leagueStatLines(db).where(
        and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId))
      )
      return lines.filter((l) => (l.min ?? 0) > 0).length
    }

    if (to === 'drop') {
      // A straight drop: the player hits free agency now, the roster
      // runs short, and the hole is filled add-only from the wire.
      await db
        .update(mnsPlayers)
        .set({ teamId: null, slot: 'active', onIR: false, isInternationalStash: false, redshirtedAt: null })
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
      await clearFutureSlots(db, leagueId, mine.teamId, playerId, today)
      await logTransaction(db, leagueId, 'add_drop', [mine.teamId], { dropped: player.name })
      return res.status(200).json({ ok: true, playerId, dropped: true })
    }

    // International stash: she is under contract somewhere else. No
    // roster spot, no cap hit, no fee of its own — but leaving a
    // redshirt for a stash is still leaving the redshirt.
    if (to === 'international') {
      if (!config.roster?.intStashAllowed) {
        return res.status(400).json({ error: 'This league does not use international stashes.' })
      }
      const verdict = intStashEligible(player, await gamesPlayedFor())
      if (!verdict.ok) return res.status(400).json({ error: verdict.reason })
      const fee = shape.leavesRedshirt ? (config.fees?.activationFee ?? 0) : 0
      await db
        .update(mnsPlayers)
        .set({
          slot: 'international',
          onIR: false,
          isInternationalStash: true,
          redshirtedAt: null,
          ...(shape.leavesRedshirt ? { redshirtUsed: true } : {}),
        })
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
      await setSlotForDate(db, leagueId, mine.teamId, playerId, 'international', today, userId, now)
      await clearFutureSlots(db, leagueId, mine.teamId, playerId, today)
      if (fee) await chargeFee(db, leagueId, mine.teamId, league.seasonYear, 'unredshirt', fee, player.name, now)
      await logTransaction(db, leagueId, 'add_drop', [mine.teamId], {
        stashed: player.name,
        ...(fee ? { fee } : {}),
      })
      return res.status(200).json({
        ok: true,
        playerId,
        slot: 'international',
        fee,
        redshirtSpent: shape.leavesRedshirt,
      })
    }

    // Going ON redshirt, from anywhere: rookies who are with a club and
    // have never played, only while the league allows it, for the fee.
    if (to === 'redshirt') {
      if (!config.roster?.redshirtsAllowed) {
        return res.status(400).json({ error: 'This league does not use redshirts.' })
      }
      const verdict = redshirtEligible(player, await gamesPlayedFor())
      if (!verdict.ok) return res.status(400).json({ error: verdict.reason })
      const fee = config.fees?.redshirtFee ?? 0
      await db
        .update(mnsPlayers)
        .set({ slot: 'redshirt', onIR: false, isInternationalStash: false, redshirtedAt: now })
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
      await setSlotForDate(db, leagueId, mine.teamId, playerId, 'redshirt', today, userId, now)
      await clearFutureSlots(db, leagueId, mine.teamId, playerId, today)
      await chargeFee(db, leagueId, mine.teamId, league.seasonYear, 'redshirt', fee, player.name, now)
      await logTransaction(db, leagueId, 'add_drop', [mine.teamId], { redshirted: player.name, fee })
      return res.status(200).json({ ok: true, playerId, slot: 'redshirt', fee })
    }

    // Lineup moves from here: active, bench, ir.
    // Positional shape: a league can name its lineup (2 C, 4 F, 4 G) or
    // run all-flex. Going ACTIVE has to leave every active player a
    // distinct slot she qualifies for — dual-eligible players float,
    // so this is a matching, not a tally.
    const positionShape = config.roster?.positionSlots ?? []
    if (to === 'active' && positionShape.length > 0) {
      const dated = await effectiveSlots(db, leagueId, mine.teamId, effDate)
      const roster = await db
        .select({ id: mnsPlayers.id, position: mnsSportPlayers.position })
        .from(mnsPlayers).innerJoin(mnsSportPlayers, eq(mnsSportPlayers.id, mnsPlayers.sportPlayerId))
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.teamId, mine.teamId)))
      const actives = roster.filter((r) => r.id === playerId || dated.get(r.id) === 'active')
      const fit = assignSlots(actives, positionShape)
      if (!fit.ok) {
        // Name the player who cannot be placed — usually the one just
        // moved, but the matching decides.
        const stuck = fit.unplaced.includes(playerId) ? player : null
        const without = assignSlots(actives.filter((r) => r.id !== playerId), positionShape)
        return res.status(400).json({
          error: noSlotReason((stuck ?? player).position, without.openSlots),
        })
      }
    }

    // Coming back from a parked slot: a redshirt costs the activation
    // fee and spends the eligibility for good; a stash simply reports.
    let fee = 0
    if (shape.leavesRedshirt) {
      fee = config.fees?.activationFee ?? 0
      await db
        .update(mnsPlayers)
        .set({ redshirtUsed: true, redshirtedAt: null, isInternationalStash: false })
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
    } else if (shape.leavesStash) {
      await db
        .update(mnsPlayers)
        .set({ isInternationalStash: false })
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
    }

    await setSlotForDate(db, leagueId, mine.teamId, playerId, to as Slot, effDate, userId, now)
    if (shape.unparks) await clearFutureSlots(db, leagueId, mine.teamId, playerId, effDate)

    if (shape.leavesRedshirt) {
      await chargeFee(db, leagueId, mine.teamId, league.seasonYear, 'unredshirt', fee, player.name, now)
      await logTransaction(db, leagueId, 'add_drop', [mine.teamId], { activated: player.name, fee })
    } else if (shape.leavesStash) {
      await logTransaction(db, leagueId, 'add_drop', [mine.teamId], { returned: player.name })
    }

    // Salary just came back onto the books: say what that costs at
    // tonight's first tip, if anything.
    let notice: string | null = null
    if (shape.unparks) {
      const ex = (await teamExposures(db, leagueId, league.seasonYear, config, [mine.teamId])).get(mine.teamId)
      if (ex) {
        const window = await faWindow(now)
        notice = capNotice(ex.exposure, window.firstTip ? tipClock(window.firstTip) : null)
      }
    }

    return res.status(200).json({
      ok: true,
      playerId,
      slot: to,
      date: effDate,
      ...(shape.leavesRedshirt ? { fee, redshirtSpent: true } : {}),
      capNotice: notice,
    })
  } catch (err) {
    logger.error('roster endpoint failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Roster move failed. Try again.' })
  }
}
