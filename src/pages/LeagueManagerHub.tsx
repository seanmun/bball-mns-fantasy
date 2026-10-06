import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useUser } from '@clerk/clerk-react'
import { toast } from 'sonner'
import { useApi } from '../hooks/useApi'
import { useLeague } from '../contexts/LeagueContext'
import { CommissionerChecklist } from '../components/CommissionerChecklist'
import { Button, EmptyState } from '../ui/components'

// The manager's portal: every LM tool in one place, off the member
// screens. The setup checklist lives here; the quick links cover the
// tools it doesn't walk through.
export function LeagueManagerHub() {
  const { leagueId = '' } = useParams()
  const { user } = useUser()
  const { apiFetch } = useApi()
  const { userLeagues, loading, refreshLeagues } = useLeague()
  const league = userLeagues.find((l) => l.id === leagueId)
  const [confirmRollover, setConfirmRollover] = useState(false)
  const [busy, setBusy] = useState(false)

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
    ['Rookie picks', `${base}/rookie-picks`, 'The rookie draft board'],
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

      <CommissionerChecklist league={league} onSeasonStarted={() => window.location.reload()} />
    </div>
  )
}
