import type { VercelRequest, VercelResponse } from '@vercel/node'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { verifyAuth, canManageLeague } from '../../_middleware.js'
import { db } from '../../_db.js'
import { mnsLeagueMessages, mnsLeagues, mnsTeamOwners, mnsTeams } from '../../../src/lib/db/schema.js'
import { esc, sendAll } from '../../_email.js'
import { emailNote, emailShell } from '../../_emailTemplate.js'
import { logger } from '../../_logger.js'
import { sport } from '../../../src/lib/sport/index.js'

// The commissioner's voice to the whole league: one subject, one plain
// body, sent to every owner with an email, with a record of who got
// it. The third manager tool — the thing a commissioner actually does
// every week.
//
// GET  /api/leagues/:id/message        — recipients count + history
// POST /api/leagues/:id/message        { subject, body }
const APP_URL = process.env.VITE_APP_URL || sport.appUrl

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = await verifyAuth(req)
  if (!userId) return res.status(401).json({ error: 'Unauthorized' })
  const leagueId = String(req.query.id ?? '')
  if (!(await canManageLeague(userId, leagueId))) {
    return res.status(403).json({ error: 'Only the commissioner can message the league.' })
  }

  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    if (!league) return res.status(404).json({ error: 'League not found' })

    // Every owner with an address, once — a person with two teams gets
    // one email.
    const owners = await db
      .select({ email: mnsTeamOwners.email, teamName: mnsTeams.name })
      .from(mnsTeamOwners)
      .innerJoin(mnsTeams, eq(mnsTeams.id, mnsTeamOwners.teamId))
      .where(and(eq(mnsTeams.leagueId, leagueId), isNotNull(mnsTeamOwners.email)))
    const byEmail = new Map<string, string>()
    for (const o of owners) {
      const e = (o.email ?? '').trim().toLowerCase()
      if (e && !byEmail.has(e)) byEmail.set(e, o.teamName)
    }

    if (req.method === 'GET') {
      const history = await db
        .select()
        .from(mnsLeagueMessages)
        .where(eq(mnsLeagueMessages.leagueId, leagueId))
        .orderBy(desc(mnsLeagueMessages.createdAt))
        .limit(20)
      return res.status(200).json({
        recipients: byEmail.size,
        history: history.map((m) => ({
          id: m.id,
          subject: m.subject,
          body: m.body,
          recipients: m.recipients,
          sent: m.sent,
          failed: m.failed.length,
          createdAt: m.createdAt,
        })),
      })
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
    const subject = String(req.body?.subject ?? '').trim()
    const body = String(req.body?.body ?? '').trim()
    if (!subject || !body) return res.status(400).json({ error: 'A subject and a message are both needed.' })
    if (subject.length > 120) return res.status(400).json({ error: 'Keep the subject under 120 characters.' })
    if (body.length > 4000) return res.status(400).json({ error: 'Keep the message under 4,000 characters.' })
    if (byEmail.size === 0) return res.status(400).json({ error: 'No owners have an email address yet.' })

    const paragraphs = body
      .split(/\n{2,}/)
      .map((p) => esc(p).replace(/\n/g, '<br/>'))
      .map((p) => emailNote(p))
      .join('')
    const messages = [...byEmail.entries()].map(([to, teamName]) => ({
      to,
      subject: `${league.name}: ${subject}`,
      html: emailShell({
        preheader: body.slice(0, 120),
        heading: esc(subject),
        subheading: `From the commissioner of ${esc(league.name)}`,
        bodyHtml: paragraphs,
        ctaLabel: 'Open the league',
        ctaUrl: `${APP_URL}/league/${leagueId}`,
        footerLine: `Sent to every owner of ${esc(league.name)} by its commissioner. You own ${esc(teamName)}.`,
      }),
      text: `${subject}\n\n${body}\n\n${APP_URL}/league/${leagueId}`,
    }))
    const result = await sendAll(messages)
    const [row] = await db
      .insert(mnsLeagueMessages)
      .values({
        leagueId,
        sentBy: userId,
        subject,
        body,
        recipients: byEmail.size,
        sent: result.sent,
        failed: result.failed,
      })
      .returning({ id: mnsLeagueMessages.id })
    if (result.failed.length) {
      logger.error('league message: some sends failed', { leagueId, failed: result.failed })
    }
    return res.status(200).json({
      ok: true,
      id: row.id,
      recipients: byEmail.size,
      sent: result.sent,
      failed: result.failed.length,
    })
  } catch (err) {
    logger.error('league message failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
    return res.status(500).json({ error: 'The message could not be sent. Try again.' })
  }
}
