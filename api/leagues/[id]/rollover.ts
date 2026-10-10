import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq } from 'drizzle-orm'
import { verifyAuth, canManageLeague } from '../../_middleware.js'
import { db } from '../../_db.js'
import { inArray } from 'drizzle-orm'
import { mnsLeagues, mnsPlayers, mnsWaiverClaims } from '../../../src/lib/db/schema.js'
import { logger } from '../../_logger.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'
import type { PlayerSlot } from '../../../src/types/player.js'
import { carryKeeperFields } from '../../../src/rules/rookieSlots.js'
import { writeCarry } from '../../../src/lib/players/carry.js'

// The turn of the year, a COMMISSIONER act from the champion phase:
// season year advances, the cap ladder grows by the configured annual
// percent, pending waiver claims clear out, and the phase lands on the
// first stop of the new year — rookie draft if the league runs one,
// else keepers, else straight to the draft. Rosters, picks, banners
// and all history stay: that is the dynasty.
//
// POST /api/leagues/:id/rollover
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  if (!(await canManageLeague(userId, leagueId))) {
    return res.status(403).json({ error: 'Only the commissioner can start the next season.' })
  }

  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })
    if (league.leaguePhase !== 'champion') {
      return res.status(400).json({ error: 'The season has to finish before the next one starts.' })
    }

    const config = league.config as LeagueConfig
    const newYear = league.seasonYear + 1
    const pct = config.cap?.annualIncreasePct ?? 0
    const grow = (v: number) => Math.round((v * (1 + pct / 100)) / 1000) * 1000

    const newConfig: LeagueConfig = {
      ...config,
      season: { ...config.season, year: newYear, startDate: '' },
      cap: config.cap?.enabled
        ? {
            ...config.cap,
            floor: grow(config.cap.floor),
            base: grow(config.cap.base),
            firstApron: grow(config.cap.firstApron),
            secondApron: grow(config.cap.secondApron),
            hardCap: grow(config.cap.hardCap),
          }
        : config.cap,
    }

    const nextPhase = newConfig.draft?.rookieDraftEnabled
      ? 'rookie_draft'
      : (newConfig.roster?.maxKeepers ?? 0) > 0
        ? 'keeper_season'
        : 'draft'

    await db
      .update(mnsLeagues)
      .set({
        seasonYear: newYear,
        config: newConfig,
        leaguePhase: nextPhase,
        seasonStartedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(mnsLeagues.id, leagueId))

    // Every player's next-season starting point: the round she actually
    // occupied becomes her prior-year round, a redshirted rookie carries
    // her slot, a free agent carries nothing. Before the slot reset
    // below, which is what tells a redshirt apart.
    const players = await db
      .select({
        id: mnsPlayers.id,
        teamId: mnsPlayers.teamId,
        slot: mnsPlayers.slot,
        rookieDraftInfo: mnsPlayers.rookieDraftInfo,
        keeperPriorYearRound: mnsPlayers.keeperPriorYearRound,
        migratedKeeperRound: mnsPlayers.migratedKeeperRound,
        draftRound: mnsPlayers.draftRound,
      })
      .from(mnsPlayers)
      .where(eq(mnsPlayers.leagueId, leagueId))
    await writeCarry(
      db,
      leagueId,
      players.map((p) => ({
        id: p.id,
        ...carryKeeperFields({ ...p, slot: p.slot as PlayerSlot }, config),
      }))
    )
    // Redshirts and stashes are single-season parks: the new year
    // starts everyone active, and eligibility is re-derived from the
    // fresh years-pro and presence the bios pass reads.
    await db
      .update(mnsPlayers)
      .set({ slot: 'active', onIR: false, isInternationalStash: false, redshirtedAt: null })
      .where(
        and(
          eq(mnsPlayers.leagueId, leagueId),
          inArray(mnsPlayers.slot, ['redshirt', 'international'])
        )
      )

    // A queue aimed at last season means nothing now.
    await db
      .update(mnsWaiverClaims)
      .set({ status: 'withdrawn', updatedAt: new Date() })
      .where(and(eq(mnsWaiverClaims.leagueId, leagueId), eq(mnsWaiverClaims.status, 'pending')))

    return res.status(200).json({ ok: true, seasonYear: newYear, leaguePhase: nextPhase })
  } catch (err) {
    logger.error('POST /api/leagues/[id]/rollover failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Rollover failed. Nothing changed — try again.' })
  }
}
