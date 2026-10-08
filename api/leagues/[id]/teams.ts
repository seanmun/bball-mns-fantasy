import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, eq, sql } from 'drizzle-orm'
import { verifyAuth, canManageLeague } from '../../_middleware.js'
import { db } from '../../_db.js'
import {
  mnsLeagues,
  mnsTeams,
  mnsTeamOwners,
  users,
  mnsPlayers,
} from '../../../src/lib/db/schema.js'
import { esc, sendAll } from '../../_email.js'
import { emailNote, emailShell } from '../../_emailTemplate.js'
import { createTeamSchema, parseBody } from '../../_validation.js'
import { pickBoard, type FuturePick } from '../../../src/lib/season/picks.js'
import type { LeagueConfig } from '../../../src/types/leagueConfig.js'
import { sport } from '../../../src/lib/sport/index.js'
import { logger } from '../../_logger.js'
import type { Team, TeamOwner } from '../../../src/types/team.js'

interface TeamWithOwners extends Team {
  owners: TeamOwner[]
}

function mapTeamRow(row: typeof mnsTeams.$inferSelect): Team {
  return {
    id: row.id,
    leagueId: row.leagueId,
    name: row.name,
    abbrev: row.abbrev,
    logo: row.logo,
    telegramUsername: row.telegramUsername,
    capAdjustments: row.capAdjustments,
    banners: row.banners,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function mapOwnerRow(row: typeof mnsTeamOwners.$inferSelect): TeamOwner {
  return {
    teamId: row.teamId,
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    isPrimary: row.isPrimary,
    emailPrefs: (row.emailPrefs ?? {}) as Record<string, boolean>,
    invitedAt: row.invitedAt ? row.invitedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

function generateTeamId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 24) || 'team'
  const suffix = Math.random().toString(36).slice(2, 8)
  return `${slug}-${suffix}`
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })

  const leagueId = req.query.id as string | undefined
  if (!leagueId) return res.status(400).json({ error: 'Missing league id' })

  if (req.method === 'GET') return handleGet(res, leagueId, userId)

  if (req.method === 'POST') {
    if (!(await canManageLeague(userId, leagueId))) {
      return res.status(403).json({ error: 'Only the commissioner can add teams' })
    }
    if (req.body?.action === 'invite') return handleInvite(req, res, leagueId)
    return handlePost(req, res, leagueId)
  }

  if (req.method === 'PATCH') return handlePatch(req, res, leagueId, userId)

  if (req.method === 'DELETE') {
    if (!(await canManageLeague(userId, leagueId))) {
      return res.status(403).json({ error: 'Only the commissioner can remove a team' })
    }
    return handleDelete(req, res, leagueId)
  }

  return res.status(405).json({ error: 'Method not allowed' })
}

// Team settings, an OWNER act: rename, set a logo, add a co-owner.
// The commissioner can do the same for any team.
// PATCH { teamId, name?, logo?, addOwnerEmail? }
async function handlePatch(
  req: VercelRequest,
  res: VercelResponse,
  leagueId: string,
  userId: string
) {
  const teamId = String(req.body?.teamId ?? '')
  if (!teamId) return res.status(400).json({ error: 'teamId is required.' })

  try {
    const [team] = await db
      .select()
      .from(mnsTeams)
      .where(eq(mnsTeams.id, teamId))
      .limit(1)
    if (!team || team.leagueId !== leagueId) {
      return res.status(404).json({ error: 'Team not found.' })
    }
    const owners = await db
      .select()
      .from(mnsTeamOwners)
      .where(eq(mnsTeamOwners.teamId, teamId))
    const isOwner = owners.some((o) => o.userId === userId)
    if (!isOwner && !(await canManageLeague(userId, leagueId))) {
      return res.status(403).json({ error: 'Only this team\'s owners can change its settings.' })
    }

    const set: Record<string, unknown> = { updatedAt: new Date() }
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim()
      if (name.length < 1 || name.length > 60) {
        return res.status(400).json({ error: 'Team name must be 1-60 characters.' })
      }
      set.name = name
    }
    if (req.body?.abbrev !== undefined) {
      const abbrev = String(req.body.abbrev).trim().toUpperCase()
      if (abbrev.length < 1 || abbrev.length > 6) {
        return res.status(400).json({ error: 'Abbreviation must be 1-6 characters.' })
      }
      set.abbrev = abbrev
    }
    if (req.body?.aiPrefs !== undefined) {
      const raw = req.body.aiPrefs as Record<string, unknown>
      const clean: Record<string, unknown> = {}
      for (const k of ['timeline', 'spending', 'rosterShape', 'assetTaste', 'risk', 'activity']) {
        const v = Number(raw?.[k])
        if (Number.isFinite(v)) clean[k] = Math.max(0, Math.min(100, Math.round(v)))
      }
      if (typeof raw?.notes === 'string') clean.notes = raw.notes.slice(0, 600)
      set.aiPrefs = clean
    }
    if (req.body?.logo !== undefined) {
      const logo = req.body.logo === null ? null : String(req.body.logo)
      if (logo != null) {
        // A small client-resized image travels as a data URL; anything
        // else (or anything huge) is refused.
        if (!/^data:image\/(png|jpeg|webp);base64,/.test(logo)) {
          return res.status(400).json({ error: 'Logo must be a PNG, JPEG or WebP image.' })
        }
        if (logo.length > 300_000) {
          return res.status(400).json({ error: 'That image is too large — it should be under ~200KB.' })
        }
      }
      set.logo = logo
    }
    if (Object.keys(set).length > 1) {
      await db.update(mnsTeams).set(set).where(eq(mnsTeams.id, teamId))
    }

    // Email preferences are PERSONAL: they land on the caller's own
    // owner row, never the team's other owners.
    if (req.body?.emailPrefs !== undefined) {
      const prefs = req.body.emailPrefs as Record<string, boolean>
      const clean: Record<string, boolean> = {}
      for (const k of ['waivers', 'trades', 'lineup']) {
        if (typeof prefs?.[k] === 'boolean') clean[k] = prefs[k]
      }
      await db
        .update(mnsTeamOwners)
        .set({ emailPrefs: clean })
        .where(and(eq(mnsTeamOwners.teamId, teamId), eq(mnsTeamOwners.userId, userId)))
    }

    const invitesSent = 0
    if (req.body?.addOwnerEmail) {
      const email = String(req.body.addOwnerEmail).trim().toLowerCase()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ error: 'That email address doesn\'t look right.' })
      }
      if (owners.some((o) => o.email.toLowerCase() === email)) {
        return res.status(400).json({ error: 'That address already co-owns this team.' })
      }
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      await db.insert(mnsTeamOwners).values({
        teamId,
        email,
        userId: existing?.id ?? null,
        displayName: null,
        isPrimary: false,
        createdAt: new Date(),
      })
      // No mail here: the commissioner sends invites when ready.
    }

    const [fresh] = await db.select().from(mnsTeams).where(eq(mnsTeams.id, teamId)).limit(1)
    const freshOwners = await db
      .select()
      .from(mnsTeamOwners)
      .where(eq(mnsTeamOwners.teamId, teamId))
    return res.status(200).json({
      ...mapTeamRow(fresh),
      owners: freshOwners.map(mapOwnerRow),
      invitesSent,
    })
  } catch (err) {
    logger.error('PATCH /api/leagues/[id]/teams failed', {
      leagueId,
      teamId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to save team settings.' })
  }
}

async function handleGet(res: VercelResponse, leagueId: string, userId: string) {
  try {
    const teamRows = await db
      .select()
      .from(mnsTeams)
      .where(eq(mnsTeams.leagueId, leagueId))
      .orderBy(mnsTeams.createdAt)

    if (teamRows.length === 0) return res.status(200).json([])

    const ownerRows = await db
      .select()
      .from(mnsTeamOwners)
      .where(
        sql`${mnsTeamOwners.teamId} IN (${sql.join(
          teamRows.map((t) => sql`${t.id}`),
          sql`, `
        )})`
      )

    const ownersByTeam = new Map<string, TeamOwner[]>()
    for (const row of ownerRows) {
      const list = ownersByTeam.get(row.teamId) ?? []
      list.push(mapOwnerRow(row))
      ownersByTeam.set(row.teamId, list)
    }

    // Each team's future rookie picks ride along — public holdings,
    // same board the trade machine deals from.
    let picksByTeam = new Map<string, FuturePick[]>()
    const [league] = await db
      .select()
      .from(mnsLeagues)
      .where(eq(mnsLeagues.id, leagueId))
      .limit(1)
    if (league) {
      const board = await pickBoard(db, {
        id: leagueId,
        seasonYear: league.seasonYear,
        config: league.config as LeagueConfig,
      })
      picksByTeam = board.reduce((m, pk) => {
        m.set(pk.ownerTeamId, [...(m.get(pk.ownerTeamId) ?? []), pk])
        return m
      }, new Map<string, FuturePick[]>())
    }

    const result = teamRows.map((t) => {
      const owners = ownersByTeam.get(t.id) ?? []
      // Strategy is the team's private playbook: only its own owners
      // see the dials.
      const mine = owners.some((o) => o.userId === userId)
      return {
        ...mapTeamRow(t),
        owners,
        picks: picksByTeam.get(t.id) ?? [],
        ...(mine ? { aiPrefs: (t.aiPrefs ?? {}) as Record<string, unknown> } : {}),
      }
    })

    return res.status(200).json(result)
  } catch (err) {
    logger.error('GET /api/leagues/[id]/teams failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to load teams' })
  }
}

async function handlePost(
  req: VercelRequest,
  res: VercelResponse,
  leagueId: string
) {
  const parsed = parseBody(createTeamSchema, req.body)
  if (!parsed.success) return res.status(400).json({ error: parsed.error })

  const { name, abbrev, telegramUsername } = parsed.data
  const ownerEmails = parsed.data.ownerEmails ?? []
  const teamId = generateTeamId(name)
  const now = new Date()

  try {
    const [teamRow] = await db
      .insert(mnsTeams)
      .values({
        id: teamId,
        leagueId,
        name,
        abbrev,
        telegramUsername: telegramUsername ?? null,
      })
      .returning()

    // Look up existing users by email (to link user_id on invite if they
    // already have an account). Pending invites get user_id = null and
    // get linked when they sign in (via api/users/sync).
    const lookup = new Map<string, string>()
    for (const email of ownerEmails) {
      const [existing] = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
      if (existing) lookup.set(email, existing.id)
    }

    const ownerInserts = ownerEmails.map((email, idx) => ({
      teamId,
      email,
      userId: lookup.get(email) ?? null,
      displayName: null,
      isPrimary: idx === 0,
      createdAt: now,
    }))

    if (ownerInserts.length > 0) await db.insert(mnsTeamOwners).values(ownerInserts)

    // Nothing is sent here. Owners wait with invitedAt null until the
    // commissioner presses Send invites.
    const invitesSent = 0
    const invitesFailed = 0

    const ownerRows = await db
      .select()
      .from(mnsTeamOwners)
      .where(eq(mnsTeamOwners.teamId, teamId))

    const result: TeamWithOwners = {
      ...mapTeamRow(teamRow),
      owners: ownerRows.map(mapOwnerRow),
    }
    return res.status(201).json({ ...result, invitesSent, invitesFailed })
  } catch (err) {
    logger.error('POST /api/leagues/[id]/teams failed', {
      leagueId,
      teamId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Failed to create team' })
  }
}

// Send the "you own this team" email to every owner who has not had
// one — the whole league, or one team — and stamp invitedAt. Re-runs
// only reach owners added since. Best-effort per address; failures are
// reported, not thrown.
async function handleInvite(req: VercelRequest, res: VercelResponse, leagueId: string) {
  const onlyTeamId = req.body?.teamId ? String(req.body.teamId) : null
  try {
    const [league] = await db
      .select({ name: mnsLeagues.name })
      .from(mnsLeagues)
      .where(eq(mnsLeagues.id, leagueId))
      .limit(1)
    const rows = await db
      .select({
        email: mnsTeamOwners.email,
        invitedAt: mnsTeamOwners.invitedAt,
        teamId: mnsTeams.id,
        teamName: mnsTeams.name,
      })
      .from(mnsTeamOwners)
      .innerJoin(mnsTeams, eq(mnsTeams.id, mnsTeamOwners.teamId))
      .where(eq(mnsTeams.leagueId, leagueId))
    const pending = rows.filter(
      (r) => !r.invitedAt && r.email && (!onlyTeamId || r.teamId === onlyTeamId)
    )
    if (pending.length === 0) return res.status(200).json({ sent: 0, failed: 0, pending: 0 })

    const appUrl = process.env.VITE_APP_URL || sport.appUrl
    const result = await sendAll(
      pending.map((r) => ({
        to: r.email,
        subject: `You're in: ${r.teamName} — ${league?.name ?? sport.appName}`,
        html: emailShell({
          preheader: `You've been given ${r.teamName} in ${league?.name ?? `a ${sport.leagueLabel} dynasty league`}.`,
          heading: `You own ${esc(r.teamName)}`,
          subheading: esc(league?.name ?? `${sport.appName} dynasty`),
          bodyHtml: emailNote(
            `The commissioner handed you the keys. Sign in — or create an account — with <b style="color:#f0f4f8">this email address</b> (${esc(r.email)}) and the team links to you automatically.`
          ),
          ctaLabel: 'Claim my team',
          ctaUrl: `${appUrl}/sign-up`,
          footerLine: `Sent because the commissioner of ${esc(league?.name ?? 'an MNS league')} added this address on ${sport.appHost}.`,
        }),
        text: [
          `You own ${r.teamName} in ${league?.name ?? `an ${sport.appName} dynasty league`}.`,
          '',
          `Sign in or create an account with this email address (${r.email}) and the team links to you automatically.`,
          `${appUrl}/sign-up`,
        ].join('\n'),
      }))
    )
    const failedTo = new Set(result.failed.map((f) => f.to))
    const now = new Date()
    for (const r of pending) {
      if (failedTo.has(r.email)) continue
      await db
        .update(mnsTeamOwners)
        .set({ invitedAt: now })
        .where(and(eq(mnsTeamOwners.teamId, r.teamId), eq(mnsTeamOwners.email, r.email)))
    }
    if (result.failed.length) logger.error('owner invite emails failed', { leagueId, failed: result.failed })
    return res.status(200).json({ sent: result.sent, failed: result.failed.length, pending: pending.length })
  } catch (err) {
    logger.error('invite failed', { leagueId, err: err instanceof Error ? err.message : String(err) })
    return res.status(500).json({ error: 'The invites could not be sent. Try again.' })
  }
}

// Remove a team before the season starts: its players go back to the
// pool, its owners go with it. Once a schedule exists the team is in
// matchups and history, and removal is refused in one sentence.
// DELETE /api/leagues/:id/teams?teamId=
async function handleDelete(req: VercelRequest, res: VercelResponse, leagueId: string) {
  const teamId = String(req.query.teamId ?? req.body?.teamId ?? '')
  if (!teamId) return res.status(400).json({ error: 'teamId is required.' })
  try {
    const [team] = await db.select().from(mnsTeams).where(eq(mnsTeams.id, teamId)).limit(1)
    if (!team || team.leagueId !== leagueId) return res.status(404).json({ error: 'Team not found.' })
    const [league] = await db
      .select({ seasonStartedAt: mnsLeagues.seasonStartedAt })
      .from(mnsLeagues)
      .where(eq(mnsLeagues.id, leagueId))
      .limit(1)
    if (league?.seasonStartedAt) {
      return res.status(400).json({
        error: 'The season has started, so this team is in the schedule — rename it or hand it to a new owner instead.',
      })
    }
    const released = await db
      .update(mnsPlayers)
      .set({ teamId: null, slot: 'active', onIR: false, isInternationalStash: false, redshirtedAt: null })
      .where(and(eq(mnsPlayers.leagueId, leagueId), eq(mnsPlayers.teamId, teamId)))
      .returning({ id: mnsPlayers.id })
    await db.delete(mnsTeamOwners).where(eq(mnsTeamOwners.teamId, teamId))
    await db.delete(mnsTeams).where(eq(mnsTeams.id, teamId))
    return res.status(200).json({ ok: true, removed: team.name, playersReleased: released.length })
  } catch (err) {
    logger.error('DELETE /api/leagues/[id]/teams failed', {
      leagueId,
      teamId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'Could not remove that team. Try again.' })
  }
}
