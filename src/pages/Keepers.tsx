import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'
import { useApi } from '../hooks/useApi'
import { Button, Chip, ConfirmPanel, EmptyState, PageHeader, Skeleton } from '../ui/components'

interface Payload {
  phase: string
  maxKeepers: number
  keepersLocked: boolean
  isCommissioner: boolean
  myTeamId: string | null
  plan: { status: string } | null
  declared: Array<{ teamId: string; teamName: string; status: string; count: number }>
}

// Who has submitted. Owners plan and submit on My Team; this page is
// the league's homework board and the commissioner's lock.
export function Keepers() {
  const { leagueId = '' } = useParams()
  const { apiFetch } = useApi()
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmLock, setConfirmLock] = useState(false)

  const load = () => {
    apiFetch<Payload>(`/api/leagues/${leagueId}/keepers`)
      .then(setData)
      .catch((e: Error) => setError(e.message))
  }
  useEffect(load, [apiFetch, leagueId])

  if (error) return <EmptyState title="Something went wrong">{error}</EmptyState>
  if (!data) {
    return (
      <div className="mns-page py-6 flex flex-col gap-2">
        <Skeleton h="2.2rem" w="55%" />
        <Skeleton h="3.4rem" />
      </div>
    )
  }
  const inPhase = data.phase === 'keeper_season'
  const submittedTeams = data.declared.filter((d) => d.status === 'submitted' || d.status === 'adminLocked')
  const waiting = data.declared.filter((d) => d.status !== 'submitted' && d.status !== 'adminLocked')

  const act = async (body: Record<string, unknown>, done: string) => {
    setBusy(true)
    try {
      await apiFetch(`/api/leagues/${leagueId}/keepers`, { method: 'POST', body: JSON.stringify(body) })
      toast.success(done)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed')
    } finally {
      setBusy(false)
      setConfirmLock(false)
    }
  }

  const label = (status: string) =>
    status === 'submitted' ? 'Submitted' : status === 'adminLocked' ? 'Locked' : status === 'draft' ? 'Working on it' : 'Nothing yet'

  return (
    <div className="mns-page py-2 pb-24">
      <PageHeader
        back={`/league/${leagueId}`}
        backLabel="League home"
        title="Keepers"
        status={
          inPhase
            ? `${submittedTeams.length} of ${data.declared.length} teams submitted.`
            : data.keepersLocked
              ? 'Locked. Keepers stay; everyone else is in the draft pool.'
              : 'Keeper season opens between the rollover and the draft.'
        }
      />

      {data.myTeamId && inPhase ? (
        <div className="mb-5 rounded-lg border border-[var(--color-key,#ffb000)]/40 bg-mns-card p-4">
          <b>Your keepers live on My Team.</b>
          <p className="text-sm text-[var(--color-muted-foreground)] mt-1 mb-3">
            Decide each player, save ideas to compare, submit one. Status: {label(data.plan?.status ?? 'none')}.
          </p>
          <Button to={`/league/${leagueId}/my-team`}>Open My Team</Button>
        </div>
      ) : null}

      <ul className="flex flex-col gap-1 text-sm mb-6">
        {data.declared.map((d) => (
          <li
            key={d.teamId}
            className="flex items-center justify-between gap-2 rounded bg-mns-card border border-[var(--color-border)] px-3 py-2 tabular-nums min-h-[3rem]"
          >
            <span className="min-w-0 truncate">{d.teamName}</span>
            <span className="flex items-center gap-2 shrink-0">
              <Chip tone={d.status === 'submitted' || d.status === 'adminLocked' ? 'win' : d.status === 'draft' ? 'key' : 'default'}>
                {label(d.status)}
              </Chip>
              {data.keepersLocked || data.isCommissioner ? (
                <b>
                  {d.count}/{data.maxKeepers}
                </b>
              ) : null}
              {data.isCommissioner && inPhase && d.status === 'submitted' ? (
                <Button variant="quiet" disabled={busy} onClick={() => act({ action: 'unlock', teamId: d.teamId }, `${d.teamName} unlocked`)}>
                  Unlock
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>

      {data.isCommissioner && inPhase ? (
        confirmLock ? (
          <ConfirmPanel
            title="Lock keepers and open the draft?"
            detail={
              waiting.length > 0
                ? `${waiting.length} team${waiting.length === 1 ? ' has' : 's have'} not submitted and will keep nobody: ${waiting.map((w) => w.teamName).join(', ')}.`
                : 'Every team has submitted. Keepers stay, redshirts and stashes park, everyone else goes back in the pool.'
            }
            confirmLabel="Lock keepers"
            pending={busy}
            onConfirm={() => act({ action: 'lock' }, 'Keepers locked. The draft phase is open.')}
            onCancel={() => setConfirmLock(false)}
          />
        ) : (
          <div className="rounded-lg border border-[var(--color-border-interactive)] bg-mns-card p-4">
            <b>Lock keepers &amp; open the draft</b>
            <p className="text-sm text-[var(--color-muted-foreground)] mt-1 mb-3">
              Keepers stay, redshirts and stashes park, everyone else goes back in the pool. Each
              keeper's round is recorded for next year.
            </p>
            <Button onClick={() => setConfirmLock(true)} disabled={busy}>
              Lock keepers
            </Button>
          </div>
        )
      ) : null}
    </div>
  )
}
