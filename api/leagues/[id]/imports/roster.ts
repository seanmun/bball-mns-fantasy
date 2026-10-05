import type { VercelRequest, VercelResponse } from '@vercel/node'
import { eq } from 'drizzle-orm'
import { verifyAuth, canManageLeague } from '../../../_middleware.js'
import { db } from '../../../_db.js'
import {
  mnsPlayers,
  mnsTeams,
  mnsLeagueImports,
  mnsSportPlayers,
} from '../../../../src/lib/db/schema.js'
import { bulkRosterImportSchema, parseBody } from '../../../_validation.js'
import { logger } from '../../../_logger.js'

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z ]/g, '')
    .trim()
}

interface RowResult {
  rowIndex: number
  playerName: string
  status: 'updated' | 'no_player_match' | 'no_team_match' | 'error'
  message?: string
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = req.query.id as string | undefined
  if (!leagueId) return res.status(400).json({ error: 'Missing league id' })

  if (!(await canManageLeague(userId, leagueId))) {
    return res.status(403).json({ error: 'Only the commissioner can import rosters' })
  }

  const parsed = parseBody(bulkRosterImportSchema, req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error })

  // Load all players and teams in this league for matching
  const [playerRows, teamRows] = await Promise.all([
    db.select({ id: mnsPlayers.id, name: mnsSportPlayers.name })
      .from(mnsPlayers).innerJoin(mnsSportPlayers, eq(mnsSportPlayers.id, mnsPlayers.sportPlayerId))
      .where(eq(mnsPlayers.leagueId, leagueId)),
    db.select({ id: mnsTeams.id, abbrev: mnsTeams.abbrev })
      .from(mnsTeams)
      .where(eq(mnsTeams.leagueId, leagueId)),
  ])

  const playerByName = new Map<string, string>() // normalized name → playerId
  for (const p of playerRows) playerByName.set(normalizeName(p.name), p.id)
  const teamByAbbrev = new Map<string, string>() // upper abbrev → teamId
  for (const t of teamRows) teamByAbbrev.set(t.abbrev.toUpperCase(), t.id)

  const results: RowResult[] = []
  let updated = 0

  for (let i = 0; i < parsed.data.rows.length; i++) {
    const row = parsed.data.rows[i]
    const key = normalizeName(row.playerName)
    const playerId = playerByName.get(key)
    if (!playerId) {
      results.push({
        rowIndex: i,
        playerName: row.playerName,
        status: 'no_player_match',
        message: 'Player not found in league pool. Populate pool first or check spelling.',
      })
      continue
    }

    let teamId: string | null | undefined = undefined
    if (row.teamAbbrev !== undefined && row.teamAbbrev !== null) {
      if (row.teamAbbrev === '') {
        teamId = null
      } else {
        const matched = teamByAbbrev.get(row.teamAbbrev.toUpperCase())
        if (!matched) {
          results.push({
            rowIndex: i,
            playerName: row.playerName,
            status: 'no_team_match',
            message: `Team abbrev '${row.teamAbbrev}' not found in this league.`,
          })
          continue
        }
        teamId = matched
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() }
    if (teamId !== undefined) updates.teamId = teamId
    if (row.slot !== undefined) updates.slot = row.slot
    if (row.keeperPriorYearRound !== undefined)
      updates.keeperPriorYearRound = row.keeperPriorYearRound
    if (row.isRookie !== undefined) updates.isRookie = row.isRookie

    try {
      await db.update(mnsPlayers).set(updates).where(eq(mnsPlayers.id, playerId))
      updated++
      results.push({ rowIndex: i, playerName: row.playerName, status: 'updated' })
    } catch (err) {
      results.push({
        rowIndex: i,
        playerName: row.playerName,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  try {
    await db.insert(mnsLeagueImports).values({
      leagueId,
      importer: 'bulk_roster',
      ranBy: userId,
      resultSummary: {
        totalRows: parsed.data.rows.length,
        updated,
        unmatchedPlayer: results.filter((r) => r.status === 'no_player_match').length,
        unmatchedTeam: results.filter((r) => r.status === 'no_team_match').length,
        errors: results.filter((r) => r.status === 'error').length,
      },
    })
  } catch (err) {
    logger.warn('Failed to write league_imports audit', {
      err: err instanceof Error ? err.message : String(err),
    })
  }

  return res.status(200).json({
    totalRows: parsed.data.rows.length,
    updated,
    results,
  })
}
