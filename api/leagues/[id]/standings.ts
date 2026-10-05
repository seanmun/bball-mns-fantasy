import type { VercelRequest, VercelResponse } from '@vercel/node'
import { eq, gte } from 'drizzle-orm'
import { and } from 'drizzle-orm'
import { verifyAuth } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsLeagues,
  mnsPlayers,
  mnsTeamOwners,
  mnsTeams,
  mnsSportPlayers,
  mnsSportStatLines,
} from '../../../src/lib/db/schema.js'
import { leagueStatLines } from '../../../src/lib/players/statLines.js'
import { computeStandings } from '../../../src/lib/season/score.js'
import { COUNTS_AGAINST_CAP } from '../../../src/lib/season/roster.js'
import { logger } from '../../_logger.js'

// GET /api/leagues/:id/standings — teams with banked records from
// FINAL matchup weeks. pointsFor = total category wins, the tiebreak.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = String(req.query.id ?? '')
  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    const teams = await db
      .select()
      .from(mnsTeams)
      .where(eq(mnsTeams.leagueId, leagueId))
    const owners = await db
      .select()
      .from(mnsTeamOwners)
    const ownersByTeam = new Map<string, typeof owners>()
    for (const o of owners) {
      if (!teams.some((t) => t.id === o.teamId)) continue
      const list = ownersByTeam.get(o.teamId) ?? []
      list.push(o)
      ownersByTeam.set(o.teamId, list)
    }

    const rec = await computeStandings(db, leagueId, league?.seasonYear)
    const salaries = await db
      .select({ teamId: mnsPlayers.teamId, salary: mnsSportPlayers.salary, id: mnsPlayers.id, slot: mnsPlayers.slot })
      .from(mnsPlayers).innerJoin(mnsSportPlayers, eq(mnsSportPlayers.id, mnsPlayers.sportPlayerId))
      .where(eq(mnsPlayers.leagueId, leagueId))
    const salaryByTeam = new Map<string, number>()
    const teamOfPlayer = new Map<string, string>()
    for (const p of salaries) {
      if (!p.teamId) continue
      if (COUNTS_AGAINST_CAP(p.slot)) {
        salaryByTeam.set(p.teamId, (salaryByTeam.get(p.teamId) ?? 0) + (p.salary ?? 0))
      }
      teamOfPlayer.set(p.id, p.teamId)
    }

    // Season production per CURRENT roster — the research lens: what
    // each roster generates in every category, ratios from raw sums.
    const year = new Date().getFullYear()
    const lines = await leagueStatLines(db).where(
      and(eq(mnsPlayers.leagueId, leagueId), gte(mnsSportStatLines.date, `${year}-01-01`))
    )
    type Prod = { pts: number; reb: number; ast: number; stl: number; blk: number; tpm: number; tov: number; fgm: number; fga: number; ftm: number; fta: number }
    const zeroProd = (): Prod => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tpm: 0, tov: 0, fgm: 0, fga: 0, ftm: 0, fta: 0 })
    const prodByTeam = new Map<string, Prod>()
    for (const l of lines) {
      const teamId = teamOfPlayer.get(l.playerId)
      if (!teamId) continue
      const t = prodByTeam.get(teamId) ?? zeroProd()
      t.pts += l.pts; t.reb += l.reb; t.ast += l.ast; t.stl += l.stl; t.blk += l.blk
      t.tpm += l.tpm; t.tov += l.tov; t.fgm += l.fgm; t.fga += l.fga; t.ftm += l.ftm; t.fta += l.fta
      prodByTeam.set(teamId, t)
    }
    const rows = teams.map((t) => {
      const r = rec.get(t.id) ?? { wins: 0, losses: 0, ties: 0, pointsFor: 0 }
      return {
        id: t.id,
        name: t.name,
        logo: t.logo,
        owners: (ownersByTeam.get(t.id) ?? []).map((o) => ({
          userId: o.userId,
          displayName: o.displayName,
          email: o.email,
        })),
        wins: r.wins,
        losses: r.losses,
        ties: r.ties,
        pointsFor: r.pointsFor,
        salary: salaryByTeam.get(t.id) ?? 0,
        production: (() => {
          const pr = prodByTeam.get(t.id) ?? zeroProd()
          return {
            ...pr,
            fgPct: pr.fga > 0 ? Math.round((pr.fgm / pr.fga) * 1000) / 10 : 0,
            ftPct: pr.fta > 0 ? Math.round((pr.ftm / pr.fta) * 1000) / 10 : 0,
            ato: pr.tov > 0 ? Math.round((pr.ast / pr.tov) * 100) / 100 : pr.ast,
          }
        })(),
      }
    })
    return res.status(200).json(rows)
  } catch (err) {
    logger.error('GET /api/leagues/[id]/standings failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to load standings' })
  }
}
