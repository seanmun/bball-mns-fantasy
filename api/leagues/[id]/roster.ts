import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq } from 'drizzle-orm'
import { verifyAuth } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsLeagues,
  mnsPlayers,
  mnsTeamOwners,
  mnsTeams,
} from '../../../src/lib/db/schema.js'
import { logger } from '../../_logger.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'
import { logTransaction } from '../../../src/lib/season/waivers.js'
import { effectiveSlots, isLockedDate, setSlotForDate, shiftDate } from '../../../src/lib/season/lineups.js'
import { easternToday } from '../../../src/lib/season/score.js'
import { intStashEligible, redshirtEligible } from '../../../src/lib/season/roster.js'
import { assignSlots, noSlotReason } from '../../../src/lib/season/positions.js'
import { chargeFee } from '../../../src/lib/season/fees.js'
import { mnsPlayerStatLines } from '../../../src/lib/db/schema.js'

// Roster slots, an OWNER act: move your own players between Active,
// Bench and IR — for a DATE. Only ACTIVE players score, judged per
// date. Past dates are locked history; today and future dates are
// editable, and a slot set ahead carries forward once its day arrives.
// IR is capped by config.roster.irSlots. 'drop' is immediate (always
// today): the player hits free agency now.
//
// Redshirt is its own act: a rookie who has never played parks for the
// season — no roster spot, no cap hit, a league fee each way, and
// activating spends the eligibility for good.
//
// POST /api/leagues/:id/roster { playerId, slot: 'active'|'bench'|'ir'|'redshirt'|'drop', date? }
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  const playerId = String(req.body?.playerId ?? '')
  const slot = String(req.body?.slot ?? '')
  if (!playerId || !['active', 'bench', 'ir', 'redshirt', 'international', 'drop'].includes(slot)) {
    return res.status(400).json({
      error: 'playerId and a slot (active, bench, ir, redshirt, international, drop) are required.',
    })
  }
  const today = easternToday()
  const date = String(req.body?.date ?? today)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD.' })
  }
  if (isLockedDate(date)) {
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

    const [player] = await db
      .select()
      .from(mnsPlayers)
      .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
      .limit(1)
    if (!player || player.teamId !== mine.teamId) {
      return res.status(403).json({ error: 'That player is not on your roster.' })
    }

    if (slot === 'ir') {
      // The cap is judged against the lineup of the date being edited.
      const irCap = config.roster?.irSlots ?? 3
      const dated = await effectiveSlots(db, leagueId, mine.teamId, date)
      const irCount = [...dated.entries()].filter(([id, s]) => s === 'ir' && id !== playerId).length
      if (irCount >= irCap) {
        return res.status(400).json({ error: `IR is full — this league allows ${irCap}.` })
      }
    }

    // Games on file — the shared half of both stash tests.
    const gamesPlayedFor = async () => {
      const lines = await db
        .select({ min: mnsPlayerStatLines.min })
        .from(mnsPlayerStatLines)
        .where(
          and(eq(mnsPlayerStatLines.leagueId, leagueId), eq(mnsPlayerStatLines.playerId, playerId))
        )
      return lines.filter((l) => (l.min ?? 0) > 0).length
    }

    // International stash: she is under contract somewhere else. No
    // roster spot, no cap hit, no fee — and no eligibility to spend,
    // so she can come back whenever she reports.
    if (slot === 'international') {
      if (!config.roster?.intStashAllowed) {
        return res.status(400).json({ error: 'This league does not use international stashes.' })
      }
      const verdict = intStashEligible(player, await gamesPlayedFor())
      if (!verdict.ok) return res.status(400).json({ error: verdict.reason })
      await db
        .update(mnsPlayers)
        .set({ slot: 'international', onIR: false, isInternationalStash: true })
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
      await logTransaction(db, leagueId, 'add_drop', [mine.teamId], { stashed: player.name })
      return res.status(200).json({ ok: true, playerId, slot: 'international' })
    }

    // Coming off a stash costs nothing — she simply reported.
    if (player.slot === 'international' && slot !== 'drop') {
      await db
        .update(mnsPlayers)
        .set({ slot: slot === 'ir' ? 'ir' : slot, onIR: slot === 'ir', isInternationalStash: false })
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
      await logTransaction(db, leagueId, 'add_drop', [mine.teamId], { returned: player.name })
      return res.status(200).json({ ok: true, playerId, slot })
    }

    // Going ON redshirt: rookies who are with a club and have never
    // played, only while the league allows it, for the redshirt fee.
    if (slot === 'redshirt') {
      if (!config.roster?.redshirtsAllowed) {
        return res.status(400).json({ error: 'This league does not use redshirts.' })
      }
      const verdict = redshirtEligible(player, await gamesPlayedFor())
      if (!verdict.ok) return res.status(400).json({ error: verdict.reason })

      await db
        .update(mnsPlayers)
        .set({ slot: 'redshirt', onIR: false, redshirtedAt: new Date() })
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
      const fee = config.fees?.redshirtFee ?? 0
      await chargeFee(db, leagueId, mine.teamId, league.seasonYear, 'redshirt', fee, player.name)
      await logTransaction(db, leagueId, 'add_drop', [mine.teamId], {
        redshirted: player.name,
        fee,
      })
      return res.status(200).json({ ok: true, playerId, slot: 'redshirt', fee })
    }

    // Coming OFF redshirt mid-season: costs the activation fee and
    // burns the eligibility — she can never be redshirted again.
    if (player.slot === 'redshirt' && slot !== 'drop') {
      const fee = config.fees?.activationFee ?? 0
      await db
        .update(mnsPlayers)
        .set({
          slot: slot === 'ir' ? 'ir' : slot,
          onIR: slot === 'ir',
          redshirtUsed: true,
          redshirtedAt: null,
        })
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
      await chargeFee(db, leagueId, mine.teamId, league.seasonYear, 'unredshirt', fee, player.name)
      await logTransaction(db, leagueId, 'add_drop', [mine.teamId], {
        activated: player.name,
        fee,
      })
      return res.status(200).json({ ok: true, playerId, slot, fee, redshirtSpent: true })
    }

    if (slot === 'drop') {
      // A straight drop: the player hits free agency now, the roster
      // runs short, and the hole is filled add-only from the wire.
      await db
        .update(mnsPlayers)
        .set({ teamId: null, slot: 'active', onIR: false })
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.id, playerId)))
      await logTransaction(db, leagueId, 'add_drop', [mine.teamId], {
        dropped: player.name,
      })
      return res.status(200).json({ ok: true, playerId, dropped: true })
    }

    // Positional shape: a league can name its lineup (2 C, 4 F, 4 G) or
    // run all-flex. Going ACTIVE has to leave every active player a
    // distinct slot she qualifies for — dual-eligible players float,
    // so this is a matching, not a tally.
    const shape = config.roster?.positionSlots ?? []
    if (slot === 'active' && shape.length > 0) {
      const dated = await effectiveSlots(db, leagueId, mine.teamId, date)
      const roster = await db
        .select({ id: mnsPlayers.id, position: mnsPlayers.position })
        .from(mnsPlayers)
        .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.teamId, mine.teamId)))
      const actives = roster.filter(
        (r) => r.id === playerId || dated.get(r.id) === 'active'
      )
      const fit = assignSlots(actives, shape)
      if (!fit.ok) {
        // Name the player who cannot be placed — usually the one just
        // moved, but the matching decides.
        const stuck = fit.unplaced.includes(playerId) ? player : null
        const without = assignSlots(
          actives.filter((r) => r.id !== playerId),
          shape
        )
        return res.status(400).json({
          error: noSlotReason((stuck ?? player).position, without.openSlots),
        })
      }
    }

    await setSlotForDate(
      db,
      leagueId,
      mine.teamId,
      playerId,
      slot as 'active' | 'bench' | 'ir',
      date,
      userId
    )

    return res.status(200).json({ ok: true, playerId, slot, date })
  } catch (err) {
    logger.error('roster endpoint failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Roster move failed. Try again.' })
  }
}
