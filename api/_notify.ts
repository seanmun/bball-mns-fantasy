import { and, eq, inArray } from 'drizzle-orm'
import { db } from './_db.js'
import {
  mnsLeagues,
  mnsMatchups,
  mnsNotifyLog,
  mnsPlayers,
  mnsTeamOwners,
  mnsTeams,
} from '../src/lib/db/schema.js'
import { esc, sendAll } from './_email.js'
import { emailNote, emailShell } from './_emailTemplate.js'
import { logger } from './_logger.js'
import { easternToday, matchupWeekFor } from '../src/lib/season/score.js'
import { dayGames } from '../src/lib/season/statSources.js'
import type { WaiverOutcome } from '../src/lib/season/waivers.js'

// The league's voice in the inbox. Three transactional notes — waiver
// results, trade offers, the lineup warning — each best-effort: a mail
// hiccup never breaks the move that triggered it. An in-app inbox
// joins these after the merge; the sending lives here because members
// are live NOW.

const APP_URL = process.env.VITE_APP_URL || 'https://wnba.mnsfantasy.com'

// Owners who haven't opted out of this KIND of email — a missing
// pref key means on.
async function ownersOf(teamIds: string[], kind: 'waivers' | 'trades' | 'lineup') {
  if (teamIds.length === 0) return new Map<string, Array<{ email: string }>>()
  const rows = await db
    .select({
      teamId: mnsTeamOwners.teamId,
      email: mnsTeamOwners.email,
      emailPrefs: mnsTeamOwners.emailPrefs,
    })
    .from(mnsTeamOwners)
    .where(inArray(mnsTeamOwners.teamId, teamIds))
  const map = new Map<string, Array<{ email: string }>>()
  for (const r of rows) {
    if ((r.emailPrefs as Record<string, boolean>)?.[kind] === false) continue
    map.set(r.teamId, [...(map.get(r.teamId) ?? []), { email: r.email }])
  }
  return map
}

// Every notify email points at the per-category switches, so opting
// out of one kind never means unsubscribing from the league.
const prefsFootnote = (leagueId: string, base: string) =>
  `${base} <a href="${APP_URL}/league/${leagueId}/my-team" style="color:#43d675">Choose which emails you get</a> — team settings, the gear on My Team.`

// "Your claims cleared" — one email per team that had claims due,
// wins and misses in one honest list.
export async function sendWaiverResults(leagueId: string, outcomes: WaiverOutcome[]) {
  if (outcomes.length === 0) return
  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    const owners = await ownersOf(outcomes.map((o) => o.teamId), 'waivers')
    const messages = outcomes.flatMap((o) => {
      const got = o.granted.map((n) => `<b style="color:#43d675">＋ ${esc(n)}</b>`).join('<br>')
      const missed = o.failed
        .map((f) => `— ${esc(f.name)} <span style="color:#9aa3ad">(${esc(f.reason)})</span>`)
        .join('<br>')
      const bodyHtml = emailNote(
        [got, missed].filter(Boolean).join('<br><br>') || 'No moves this morning.'
      )
      const subject =
        o.granted.length > 0
          ? `Waivers cleared: you landed ${o.granted[0]}${o.granted.length > 1 ? ` +${o.granted.length - 1}` : ''}`
          : 'Waivers cleared — your claims missed'
      return (owners.get(o.teamId) ?? []).map((owner) => ({
        to: owner.email,
        subject,
        html: emailShell({
          preheader: 'This morning’s waiver results.',
          heading: 'Waivers cleared',
          subheading: esc(league?.name ?? 'MNS WNBA'),
          bodyHtml,
          ctaLabel: 'See my roster',
          ctaUrl: `${APP_URL}/league/${leagueId}/my-team`,
          footerLine: prefsFootnote(leagueId, `Sent because you own a team in ${esc(league?.name ?? 'an MNS league')}.`),
        }),
        text: [
          'Waiver results:',
          ...o.granted.map((n) => `+ ${n}`),
          ...o.failed.map((f) => `- ${f.name} (${f.reason})`),
          `${APP_URL}/league/${leagueId}/my-team`,
        ].join('\n'),
      }))
    })
    const r = await sendAll(messages)
    if (r.failed.length) logger.error('waiver result emails failed', { leagueId, failed: r.failed })
  } catch (err) {
    logger.error('sendWaiverResults failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

// Trade lifecycle notes: the other owner hears about a proposal the
// moment it lands; the proposer hears the verdict.
export async function sendTradeNote(
  leagueId: string,
  toTeamId: string,
  kind: 'proposed' | 'accepted' | 'rejected',
  detail: { fromTeamName: string; assetLines: string[] }
) {
  try {
    const [league] = await db.select().from(mnsLeagues).where(eq(mnsLeagues.id, leagueId)).limit(1)
    const owners = await ownersOf([toTeamId], 'trades')
    const heading =
      kind === 'proposed'
        ? `${detail.fromTeamName} wants to deal`
        : kind === 'accepted'
          ? 'Trade executed'
          : 'Trade rejected'
    const subject =
      kind === 'proposed'
        ? `Trade offer from ${detail.fromTeamName}`
        : kind === 'accepted'
          ? 'Your trade was accepted — it already executed'
          : `${detail.fromTeamName} passed on your trade`
    const messages = (owners.get(toTeamId) ?? []).map((o) => ({
      to: o.email,
      subject,
      html: emailShell({
        preheader: subject,
        heading,
        subheading: esc(league?.name ?? 'MNS WNBA'),
        bodyHtml: emailNote(detail.assetLines.map(esc).join('<br>')),
        ctaLabel: kind === 'proposed' ? 'Answer the offer' : 'See the trade',
        ctaUrl: `${APP_URL}/league/${leagueId}/trade-machine`,
        footerLine: prefsFootnote(leagueId, `Sent because you own a team in ${esc(league?.name ?? 'an MNS league')}.`),
      }),
      text: [subject, ...detail.assetLines, `${APP_URL}/league/${leagueId}/trade-machine`].join('\n'),
    }))
    const r = await sendAll(messages)
    if (r.failed.length) logger.error('trade emails failed', { leagueId, failed: r.failed })
  } catch (err) {
    logger.error('sendTradeNote failed', {
      leagueId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

// The retention email: OUT players sitting ACTIVE with a game tonight,
// sent once per league per day inside the three hours before first
// tip. The notify_log unique key is the idempotency; the tick calls
// this freely every 20 minutes.
export async function sendLineupWarnings(
  league: { id: string; name: string; seasonYear: number },
  firstTip: string | null,
  now = new Date()
) {
  try {
    if (!firstTip) return
    const tip = new Date(firstTip).getTime()
    if (now.getTime() < tip - 3 * 3600 * 1000 || now.getTime() >= tip) return

    const today = easternToday(now)
    // Claim the day; a second tick loses the race and walks away.
    const claimed = await db
      .insert(mnsNotifyLog)
      .values({ leagueId: league.id, kind: 'lineup_warning', dateKey: today })
      .onConflictDoNothing()
      .returning()
    if (claimed.length === 0) return

    // Only a team with a matchup THIS week has a lineup that matters.
    // Outside the schedule there is nobody to warn; in the playoffs an
    // eliminated team (or a bye) is left alone.
    const week = await matchupWeekFor(db, league.id, today)
    if (week == null) return
    const live = await db
      .select({ homeTeamId: mnsMatchups.homeTeamId, awayTeamId: mnsMatchups.awayTeamId })
      .from(mnsMatchups)
      .where(
        and(
          eq(mnsMatchups.leagueId, league.id),
          eq(mnsMatchups.seasonYear, league.seasonYear),
          eq(mnsMatchups.matchupWeek, week)
        )
      )
    const playing = [...new Set(live.flatMap((m) => [m.homeTeamId, m.awayTeamId]))]
    if (playing.length === 0) return

    const games = await dayGames(today)
    const players = await db
      .select()
      .from(mnsPlayers)
      .where(
        and(
          eq(mnsPlayers.leagueId, league.id),
          eq(mnsPlayers.slot, 'active'),
          inArray(mnsPlayers.teamId, playing),
          eq(mnsPlayers.injuryStatus, 'Out')
        )
      )
    const flagged = players.filter((p) => p.teamCode && games.has(p.teamCode))
    if (flagged.length === 0) return

    const byTeam = new Map<string, string[]>()
    for (const p of flagged) {
      byTeam.set(p.teamId!, [...(byTeam.get(p.teamId!) ?? []), p.name])
    }
    const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, league.id))
    const teamName = new Map(teams.map((t) => [t.id, t.name]))
    const owners = await ownersOf([...byTeam.keys()], 'lineup')
    const tipClock = new Date(firstTip).toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
    })
    const messages = [...byTeam.entries()].flatMap(([teamId, names]) =>
      (owners.get(teamId) ?? []).map((o) => ({
        to: o.email,
        subject: `${names.length === 1 ? `${names[0]} is` : `${names.length} of your starters are`} OUT tonight`,
        html: emailShell({
          preheader: `First tip ${tipClock} ET — your lineup still starts ${names.join(', ')}.`,
          heading: 'OUT players in tonight’s lineup',
          subheading: esc(teamName.get(teamId) ?? league.name),
          bodyHtml: emailNote(
            `${names.map((n) => `<b style="color:#ff453a">${esc(n)}</b>`).join(', ')} ${
              names.length === 1 ? 'is' : 'are'
            } ruled OUT but still active for tonight. First tip is ${esc(tipClock)} ET — after that, tonight is locked in.`
          ),
          ctaLabel: 'Fix my lineup',
          ctaUrl: `${APP_URL}/league/${league.id}/my-team`,
          footerLine: prefsFootnote(league.id, `Sent because you own ${esc(teamName.get(teamId) ?? 'a team')} in ${esc(league.name)}.`),
        }),
        text: [
          `OUT tonight but still in your active lineup: ${names.join(', ')}.`,
          `First tip ${tipClock} ET.`,
          `${APP_URL}/league/${league.id}/my-team`,
        ].join('\n'),
      }))
    )
    const r = await sendAll(messages)
    if (r.failed.length) logger.error('lineup warning emails failed', { leagueId: league.id, failed: r.failed })
  } catch (err) {
    logger.error('sendLineupWarnings failed', {
      leagueId: league.id,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}
