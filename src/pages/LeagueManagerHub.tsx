import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useUser } from '@clerk/clerk-react'
import { toast } from 'sonner'
import { useApi } from '../hooks/useApi'
import { useLeague } from '../contexts/LeagueContext'
import { CommissionerChecklist } from '../components/CommissionerChecklist'
import { Button, EmptyState } from '../ui/components'

interface Status {
  phase: string
  today: string
  currentWeek: { matchupWeek: number; label: string | null; endDate: string } | null
  pendingTrades: Array<{ id: string; by: string; days: number }>
  overLimit: Array<{ name: string; spots: number; limit: number }>
  dues: Array<{ teamId: string; name: string; amount: number }>
  pendingClaims: number
  nextFold: { matchupWeek: number; label: string | null; startDate: string; endDate: string } | null
  lastMessage: { subject: string; at: string; sent: number } | null
}

const fmtDay = (d: string) => {
  const [, m, day] = d.split('-')
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1]} ${Number(day)}`
}
const usd = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

// The commissioner's portal, state-aware like Home. Before the season
// it IS the setup checklist. In season it leads with what needs the
// commissioner now — trades waiting, rosters over the limit, dues on
// the books, the next folded week — and the tools sit below. After the
// crown, the rollover card.
export function LeagueManagerHub() {
  const { leagueId = '' } = useParams()
  const { user } = useUser()
  const { apiFetch } = useApi()
  const { userLeagues, loading, refreshLeagues } = useLeague()
  const league = userLeagues.find((l) => l.id === leagueId)
  const [confirmRollover, setConfirmRollover] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<Status | null>(null)
  const inSeason = league?.leaguePhase === 'regular_season' || league?.leaguePhase === 'playoffs'
  const isMine = !!league && league.commissionerId === user?.id

  useEffect(() => {
    if (!isMine || !inSeason) return
    let cancelled = false
    apiFetch<Status>(`/api/leagues/${leagueId}/commissioner-status`)
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {
        if (!cancelled) setStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [apiFetch, leagueId, isMine, inSeason])

  const rollover = async () => {
    setBusy(true)
    try {
      const r = await apiFetch<{ seasonYear: number; leaguePhase: string }>(
        `/api/leagues/${leagueId}/rollover`,
        { method: 'POST' }
      )
      toast.success(`Welcome to ${r.seasonYear} — next stop: ${r.leaguePhase.replace('_', ' ')}`)
      refreshLeagues()
      setConfirmRollover(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rollover failed')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-green-500 border-r-transparent" />
      </div>
    )
  }
  if (!league) return <EmptyState title="League not found">Check the link.</EmptyState>
  if (league.commissionerId !== user?.id) {
    return (
      <EmptyState title="Commissioner only">
        These tools belong to whoever runs the league.
      </EmptyState>
    )
  }

  const base = `/league/${leagueId}/lm`
  const links: Array<[string, string, string]> = [
    ['League settings', `${base}/league`, 'Season, roster, cap, fees, scoring'],
    ['Teams', `${base}/teams`, 'Add teams, invite owners'],
    ['Rosters', `${base}/rosters`, 'Pick a team, search a player, place them'],
    ['Rookie draft', `${base}/rookie-picks`, 'Record or run the rookie draft'],
    ['Draft setup', `${base}/draft-setup`, 'Pace, readiness, create the draft'],
    ['Message', `${base}/message`, 'Email every owner at once'],
  ]

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 pb-24">
      <h1 className="text-3xl font-bold mb-1">Commissioner</h1>
      <p className="text-sm text-[var(--color-muted-foreground)] mb-6">{league.name}</p>

      {league.leaguePhase === 'champion' ? (
        <div className="mb-6 rounded-lg border border-[var(--color-accent)] bg-mns-card p-4">
          <b>The season is done — a champion is crowned.</b>
          <p className="text-sm text-[var(--color-muted-foreground)] mt-1">
            Starting {league.seasonYear + 1} advances the year, grows the cap ladder by your
            configured annual percent, clears stale waiver queues, and opens{' '}
            {league.config.draft?.rookieDraftEnabled
              ? 'the rookie draft'
              : (league.config.roster?.maxKeepers ?? 0) > 0
                ? 'keeper declarations'
                : 'the draft'}
            . Rosters, picks and banners carry over — that's the dynasty.
          </p>
          <div className="mt-3 flex gap-2">
            <Button
              variant={confirmRollover ? 'danger' : 'primary'}
              onClick={() => (confirmRollover ? rollover() : setConfirmRollover(true))}
              disabled={busy}
            >
              {busy
                ? 'Working…'
                : confirmRollover
                  ? `Yes — start ${league.seasonYear + 1}`
                  : `Start the ${league.seasonYear + 1} season`}
            </Button>
            {confirmRollover ? (
              <Button variant="quiet" onClick={() => setConfirmRollover(false)}>
                Not yet
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {inSeason ? <ThisWeek status={status} base={base} /> : null}

      {!inSeason && league.leaguePhase !== 'champion' ? (
        <CommissionerChecklist league={league} onSeasonStarted={() => window.location.reload()} />
      ) : null}

      <h2 className="text-lg font-bold mb-2">Tools</h2>
      <div className="grid sm:grid-cols-2 gap-2 mb-8">
        {links.map(([label, to, desc]) => (
          <Link
            key={to}
            to={to}
            className="bg-mns-card hover:bg-mns-hover border border-[var(--color-border)] rounded-lg px-4 py-3"
          >
            <b className="block">{label}</b>
            <span className="text-sm text-[var(--color-muted-foreground)]">{desc}</span>
          </Link>
        ))}
      </div>
    </div>
  )
}

// What needs the commissioner now. Every line is something they act
// on, with the tap that acts on it; a quiet week says so in one line.
function ThisWeek({ status, base }: { status: Status | null; base: string }) {
  if (!status) return null
  const items: Array<{ key: string; text: string; to: string; urgent: boolean }> = []
  for (const t of status.pendingTrades) {
    items.push({
      key: `trade-${t.id}`,
      text: `A trade from ${t.by} has waited ${t.days === 0 ? 'since today' : `${t.days} day${t.days === 1 ? '' : 's'}`} for an answer.`,
      to: `${base.replace(/\/lm$/, '')}/trades`,
      urgent: t.days >= 2,
    })
  }
  for (const t of status.overLimit) {
    items.push({
      key: `over-${t.name}`,
      text: `${t.name} carries ${t.spots} players on a ${t.limit}-spot roster and cannot add until they drop or IR someone.`,
      to: `${base}/rosters`,
      urgent: true,
    })
  }
  if (status.nextFold) {
    items.push({
      key: 'fold',
      text: `${status.nextFold.label ?? 'A folded week'}: ${fmtDay(status.nextFold.startDate)} – ${fmtDay(status.nextFold.endDate)} plays as one matchup week. Worth a message before it starts.`,
      to: `${base}/message`,
      urgent: false,
    })
  }
  const owed = status.dues.filter((d) => d.amount > 0)
  const total = owed.reduce((n, d) => n + d.amount, 0)
  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-lg font-bold">
          {status.currentWeek
            ? `${status.currentWeek.label ?? `Week ${status.currentWeek.matchupWeek}`} · ends ${fmtDay(status.currentWeek.endDate)}`
            : 'This week'}
        </h2>
        {status.pendingClaims > 0 ? (
          <span className="text-sm text-[var(--color-muted-foreground)] tabular-nums">
            {status.pendingClaims} waiver claim{status.pendingClaims === 1 ? '' : 's'} queued
          </span>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="rounded-lg border border-[var(--color-border)] bg-mns-card px-4 py-3 text-sm text-[var(--color-accent)]">
          Nothing needs you. Trades answered, rosters legal, no folded week ahead.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((it) => (
            <li key={it.key}>
              <Link
                to={it.to}
                className={
                  'block rounded-lg border bg-mns-card px-4 py-3 text-sm hover:bg-mns-hover ' +
                  (it.urgent ? 'border-l-4 border-[var(--color-key,#ffb000)]' : 'border-[var(--color-border)]')
                }
              >
                {it.text}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm text-[var(--color-muted-foreground)] tabular-nums">
        <span>
          Dues on the books: <b className="text-[var(--color-foreground)]">{usd(total)}</b>
          {owed.length ? ` across ${owed.length} team${owed.length === 1 ? '' : 's'}` : ''}
        </span>
        <span>
          {status.lastMessage
            ? `Last message: "${status.lastMessage.subject}", ${fmtDay(status.lastMessage.at.slice(0, 10))}`
            : 'No message sent yet.'}
        </span>
      </div>
    </section>
  )
}
