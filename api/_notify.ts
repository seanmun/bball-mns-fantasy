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
import type { LeagueConfig } from '../src/types/leagueConfig.js'
import { capNotice } from '../src/rules/capRules.js'
import { teamExposures, type DuesReceipt } from '../src/lib/season/capLock.js'
import { sport } from '../src/lib/sport/index.js'
import { tipClock } from '../src/lib/season/locks.js'

// The league's voice in the inbox. Three transactional notes — waiver
// results, trade offers, the lineup warning — each best-effort: a mail
// hiccup never breaks the move that triggered it. An in-app inbox
// joins these after the merge; the sending lives here because members
// are live NOW.

const APP_URL = process.env.VITE_APP_URL || sport.appUrl

// Owners who haven't opted out of this KIND of email — a missing
// pref key means on.
async function ownersOf(teamIds: string[], kind: 'waivers' | 'trades' | 'lineup' | 'fees') {
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
          subheading: esc(league?.name ?? sport.appName),
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
        subheading: esc(league?.name ?? sport.appName),
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
  league: { id: string; name: string; seasonYear: number; config: LeagueConfig },
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
    const byTeam = new Map<string, string[]>()
    for (const p of flagged) {
      byTeam.set(p.teamId!, [...(byTeam.get(p.teamId!) ?? []), p.name])
    }

    // Cap exposure rides in the same note: what books at first tip
    // unless the roster gets under. One email per team, never two.
    const expo = await teamExposures(db, league.id, league.seasonYear, league.config, playing)
    const tipClockStr = tipClock(firstTip)
    const noticeFor = (teamId: string) => {
      const ex = expo.get(teamId)?.exposure
      return ex ? capNotice(ex, tipClockStr) : null
    }
    const teamIds = [...new Set([...byTeam.keys(), ...playing.filter((id) => noticeFor(id))])]
    if (teamIds.length === 0) return

    const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, league.id))
    const teamName = new Map(teams.map((t) => [t.id, t.name]))
    const owners = await ownersOf(teamIds, 'lineup')
    const messages = teamIds.flatMap((teamId) => {
      const names = byTeam.get(teamId) ?? []
      const notice = noticeFor(teamId)
      const outNote =
        names.length > 0
          ? emailNote(
              `${names.map((n) => `<b style="color:#ff453a">${esc(n)}</b>`).join(', ')} ${
                names.length === 1 ? 'is' : 'are'
              } ruled OUT but still active for tonight. First tip is ${esc(tipClockStr)} ET — each player locks the moment their own game tips.`
            )
          : ''
      const capNote = notice ? emailNote(esc(notice)) : ''
      const subject =
        names.length > 0
          ? `${names.length === 1 ? `${names[0]} is` : `${names.length} of your starters are`} OUT tonight`
          : `Cap dues book at first tip tonight — ${teamName.get(teamId) ?? league.name}`
      return (owners.get(teamId) ?? []).map((o) => ({
        to: o.email,
        subject,
        html: emailShell({
          preheader:
            names.length > 0
              ? `First tip ${tipClockStr} ET — your lineup still starts ${names.join(', ')}.`
              : notice ?? '',
          heading: names.length > 0 ? 'OUT players in tonight’s lineup' : 'Over the apron tonight',
          subheading: esc(teamName.get(teamId) ?? league.name),
          bodyHtml: outNote + capNote,
          ctaLabel: names.length > 0 ? 'Fix my lineup' : 'See my cap',
          ctaUrl: `${APP_URL}/league/${league.id}/my-team`,
          footerLine: prefsFootnote(league.id, `Sent because you own ${esc(teamName.get(teamId) ?? 'a team')} in ${esc(league.name)}.`),
        }),
        text: [
          names.length > 0 ? `OUT tonight but still in your active lineup: ${names.join(', ')}.` : '',
          notice ?? '',
          `First tip ${tipClockStr} ET.`,
          `${APP_URL}/league/${league.id}/my-team`,
        ]
          .filter(Boolean)
          .join('\n'),
      }))
    })
    const r = await sendAll(messages)
    if (r.failed.length) logger.error('lineup warning emails failed', { leagueId: league.id, failed: r.failed })
  } catch (err) {
    logger.error('sendLineupWarnings failed', {
      leagueId: league.id,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}

// The receipt: cap dues just booked at first tip, with the running
// total the commissioner will settle. Sent once, because the booking
// itself happens once.
export async function sendFeeReceipts(league: { id: string; name: string }, receipts: DuesReceipt[]) {
  try {
    if (receipts.length === 0) return
    const teams = await db.select().from(mnsTeams).where(eq(mnsTeams.leagueId, league.id))
    const teamName = new Map(teams.map((t) => [t.id, t.name]))
    const owners = await ownersOf(
      receipts.map((r) => r.teamId),
      'fees'
    )
    const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    const messages = receipts.flatMap((r) => {
      const booked = r.entries.reduce((n, e) => n + e.amount, 0)
      const lines = r.entries.map((e) => `<b>${usd(e.amount)}</b> — ${esc(e.detail)}`).join('<br/>')
      return (owners.get(r.teamId) ?? []).map((o) => ({
        to: o.email,
        subject: `Cap dues booked: ${usd(booked)} — ${teamName.get(r.teamId) ?? league.name}`,
        html: emailShell({
          preheader: `${usd(booked)} in cap dues booked at first tip. Season total ${usd(r.totalOwed)}.`,
          heading: 'Cap dues booked',
          subheading: esc(teamName.get(r.teamId) ?? league.name),
          bodyHtml: emailNote(
            `${lines}<br/><br/>Booked at tonight’s first tip from the roster you carried in. Your season total in league dues is now <b>${usd(r.totalOwed)}</b>. Tracked here, settled with the commissioner.`
          ),
          ctaLabel: 'See my fees',
          ctaUrl: `${APP_URL}/league/${league.id}/my-team`,
          footerLine: prefsFootnote(league.id, `Sent because you own ${esc(teamName.get(r.teamId) ?? 'a team')} in ${esc(league.name)}.`),
        }),
        text: [
          ...r.entries.map((e) => `${usd(e.amount)} — ${e.detail}`),
          `Season total in league dues: ${usd(r.totalOwed)}.`,
          `${APP_URL}/league/${league.id}/my-team`,
        ].join('\n'),
      }))
    })
    const res = await sendAll(messages)
    if (res.failed.length) logger.error('fee receipt emails failed', { leagueId: league.id, failed: res.failed })
  } catch (err) {
    logger.error('sendFeeReceipts failed', {
      leagueId: league.id,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}
