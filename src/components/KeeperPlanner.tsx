import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useApi } from '../hooks/useApi'
import { useLeague } from '../contexts/LeagueContext'
import { Banner, Button, Card, ConfirmPanel, ListRow, PageHeader } from '../ui/components'
import { PlayerName } from './InjuryTag'
import {
  blankEntries,
  blocking,
  evaluatePlan,
  movePriority,
  reconcileEntries,
  setDecision,
  type PlanOptions,
  type PlanPlayer,
} from '../rules/keeperPlan'
import type { Decision, RosterEntry, SavedScenario } from '../types/roster'
import type { LeagueConfig } from '../types/leagueConfig'

// Keeper season on My Team, the way MNS ran it: one decision per
// player, the cap and the fees moving as you go, scenarios to save and
// compare, the 13 rounds showing who sits where, and one Submit.

type RosterRow = PlanPlayer & PlanOptions
interface Payload {
  phase: string
  maxKeepers: number
  rounds: number
  cap: LeagueConfig['cap'] | null
  fees: LeagueConfig['fees'] | null
  keepersLocked: boolean
  isCommissioner: boolean
  myTeamId: string | null
  myRoster: RosterRow[]
  plan: { entries: RosterEntry[]; status: string; savedScenarios: SavedScenario[] } | null
  declared: Array<{ teamId: string; teamName: string; status: string; count: number }>
}

const M = 1_000_000
const fmtM = (n: number) => `$${(n / M).toFixed(1)}M`
const last = (name: string) => name.split(' ').slice(-1)[0]

export function KeeperPlanner({
  leagueId,
  teamName,
  logo,
}: {
  leagueId: string
  teamName: string
  logo?: string | null
}) {
  const { apiFetch } = useApi()
  const { currentLeague } = useLeague()
  const config = currentLeague?.config as LeagueConfig
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [entries, setEntries] = useState<RosterEntry[]>([])
  const [scenarioId, setScenarioId] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving'>('saved')

  const load = useCallback(() => {
    apiFetch<Payload>(`/api/leagues/${leagueId}/keepers`)
      .then((d) => {
        setData(d)
        setEntries(d.plan ? d.plan.entries : blankEntries(d.myRoster, config))
        setSaveState('saved')
      })
      .catch((e: Error) => setError(e.message))
  }, [apiFetch, leagueId, config])
  useEffect(load, [load])

  const ev = useMemo(
    () => (data ? evaluatePlan(entries, data.myRoster, config) : null),
    [data, entries, config]
  )
  const submitted = data?.plan?.status === 'submitted' || data?.plan?.status === 'adminLocked'
  const inPhase = data?.phase === 'keeper_season'
  const editable = inPhase && !submitted

  // The working plan autosaves, so it is there on the next phone too.
  const timer = useRef<number | null>(null)
  const change = (next: RosterEntry[]) => {
    setEntries(next)
    setSaveState('dirty')
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(async () => {
      setSaveState('saving')
      try {
        await apiFetch(`/api/leagues/${leagueId}/keepers`, {
          method: 'POST',
          body: JSON.stringify({ action: 'save', entries: next }),
        })
        setSaveState('saved')
      } catch (e) {
        setSaveState('dirty')
        toast.error(e instanceof Error ? e.message : 'Could not save the plan')
      }
    }, 800)
  }

  const loadScenario = (id: string) => {
    if (!data) return
    setScenarioId(id)
    if (id === '') return change(blankEntries(data.myRoster, config))
    const s = data.plan?.savedScenarios.find((x) => x.scenarioId === id)
    if (s) change(reconcileEntries(s.entries, data.myRoster, config))
  }

  const saveScenario = async () => {
    if (!name.trim()) return toast.error('Give the scenario a name')
    setBusy(true)
    try {
      const r = await apiFetch<{ savedScenarios: SavedScenario[] }>(`/api/leagues/${leagueId}/keepers`, {
        method: 'POST',
        body: JSON.stringify({ action: 'scenario', name: name.trim(), entries }),
      })
      setData((d) => (d && d.plan ? { ...d, plan: { ...d.plan, savedScenarios: r.savedScenarios } } : d))
      if (data && !data.plan) load()
      setScenarioId(r.savedScenarios[r.savedScenarios.length - 1]?.scenarioId ?? '')
      setName('')
      setSaveState('saved')
      toast.success(`Saved "${name.trim()}"`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the scenario')
    } finally {
      setBusy(false)
    }
  }

  const deleteScenario = async (id: string) => {
    setBusy(true)
    try {
      const r = await apiFetch<{ savedScenarios: SavedScenario[] }>(`/api/leagues/${leagueId}/keepers`, {
        method: 'POST',
        body: JSON.stringify({ action: 'deleteScenario', scenarioId: id }),
      })
      setData((d) => (d && d.plan ? { ...d, plan: { ...d.plan, savedScenarios: r.savedScenarios } } : d))
      if (scenarioId === id) setScenarioId('')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete')
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    setBusy(true)
    try {
      if (timer.current) window.clearTimeout(timer.current)
      await apiFetch(`/api/leagues/${leagueId}/keepers`, {
        method: 'POST',
        body: JSON.stringify({ action: 'submit', entries }),
      })
      toast.success('Keepers submitted')
      setConfirm(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Submit failed')
    } finally {
      setBusy(false)
    }
  }

  if (error) return <Banner tone="crit">{error}</Banner>
  if (!data || !ev) return <div className="mns-page py-6 text-[var(--color-muted-foreground)]">Loading…</div>

  const s = ev.summary
  const cap = data.cap
  const fees = data.fees
  const conflictOf = (p: RosterRow) =>
    p.baseRound != null &&
    entries.filter((e) => e.decision === 'KEEP' && e.baseRound === p.baseRound).length > 1
  const entryOf = (id: string) => ev.entries.find((e) => e.playerId === id)
  const errs = blocking(ev.errors)
  const warns = ev.errors.filter((e) => e.type === 'warning')
  const allFees: Array<[string, number]> = [
    [`Franchise tags${s.franchiseTags ? ` (${s.franchiseTags} × $${fees?.franchiseTagFee ?? 0})` : ''}`, s.franchiseTagDues],
    [`Redshirts${s.redshirtsCount ? ` (${s.redshirtsCount} × $${fees?.redshirtFee ?? 0})` : ''}`, s.redshirtDues],
    ['First apron fee', s.firstApronFee],
    [`Second apron${s.overSecondApronByM ? ` (${s.overSecondApronByM}M over)` : ''}`, s.penaltyDues],
  ]
  const feeLines = allFees.filter(([, v]) => v > 0)

  return (
    <div className="mns-page py-2 pb-24">
      <PageHeader
        back={`/league/${leagueId}`}
        backLabel="League home"
        eyebrow="Keeper season"
        title={
          <span className="flex items-center gap-3">
            {logo ? <img src={logo} alt="" className="w-14 h-14 rounded-xl object-cover shrink-0" /> : null}
            <span className="min-w-0">{teamName}</span>
          </span>
        }
        status={`Keep up to ${data.maxKeepers}. Decide each player, save ideas to compare, then submit one.`}
      />

      {submitted ? (
        <div className="mb-4">
          <Banner tone="ok">
            Submitted. Your keepers are in. The commissioner can unlock if something needs fixing.
          </Banner>
        </div>
      ) : !inPhase ? (
        <div className="mb-4">
          <Banner tone="info">Keeper plans open during keeper season.</Banner>
        </div>
      ) : null}

      {/* The cap, with the aprons and the hard cap marked. */}
      {cap ? (
        <Card className="mb-3">
          <div className="flex items-baseline justify-between text-sm mb-2 tabular-nums">
            <span>
              <b>{fmtM(s.capUsed)}</b>
              <span className="text-[var(--color-muted-foreground)]"> kept salary</span>
            </span>
            <span className="text-[var(--color-muted-foreground)]">hard cap {fmtM(cap.hardCap)}</span>
          </div>
          <div className="relative h-3 rounded-full bg-[var(--color-background)] border border-[var(--color-border)] overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min(100, (s.capUsed / cap.hardCap) * 100)}%`,
                background:
                  s.capUsed > cap.secondApron
                    ? 'var(--color-pick-loss, #ff453a)'
                    : s.capUsed > cap.firstApron
                      ? 'var(--color-key, #ffb000)'
                      : 'var(--color-accent)',
              }}
            />
            {cap.firstApron > 0 ? (
              <span
                className="absolute top-0 h-full w-px bg-[var(--color-foreground)]/60"
                style={{ left: `${(cap.firstApron / cap.hardCap) * 100}%` }}
                title={`First apron ${fmtM(cap.firstApron)}`}
              />
            ) : null}
            {cap.secondApron > 0 ? (
              <span
                className="absolute top-0 h-full w-px bg-[var(--color-foreground)]/60"
                style={{ left: `${(cap.secondApron / cap.hardCap) * 100}%` }}
                title={`Second apron ${fmtM(cap.secondApron)}`}
              />
            ) : null}
          </div>
          <div className="mt-1 flex justify-between text-xs text-[var(--color-muted-foreground)] tabular-nums">
            <span>{cap.firstApron > 0 ? `first apron ${fmtM(cap.firstApron)}` : ''}</span>
            <span>{cap.secondApron > 0 ? `second apron ${fmtM(cap.secondApron)}` : ''}</span>
          </div>
        </Card>
      ) : null}

      <Card className="mb-4">
        <div className="grid grid-cols-3 gap-2 text-center tabular-nums">
          <div>
            <div className="text-2xl font-bold">
              {s.keepersCount}
              <span className="text-base font-normal text-[var(--color-muted-foreground)]">/{data.maxKeepers}</span>
            </div>
            <div className="text-xs text-[var(--color-muted-foreground)]">keepers</div>
          </div>
          <div>
            <div className="text-2xl font-bold">
              {s.redshirtsCount + s.intStashCount}
            </div>
            <div className="text-xs text-[var(--color-muted-foreground)]">parked</div>
          </div>
          <div>
            <div className="text-2xl font-bold">${s.totalFees}</div>
            <div className="text-xs text-[var(--color-muted-foreground)]">fees</div>
          </div>
        </div>
        {feeLines.length > 0 ? (
          <ul className="mt-3 text-sm divide-y divide-[var(--color-border)] tabular-nums">
            {feeLines.map(([label, v]) => (
              <li key={label} className="flex justify-between py-1">
                <span className="text-[var(--color-muted-foreground)]">{label}</span>
                <span>${v}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {editable ? (
        <div className="mb-4 flex items-center gap-2">
          <label className="text-sm text-[var(--color-muted-foreground)] shrink-0" htmlFor="kp-scenario">
            Idea
          </label>
          <select
            id="kp-scenario"
            value={scenarioId}
            onChange={(e) => loadScenario(e.target.value)}
            className="flex-1 min-h-[3rem] px-3 rounded bg-[var(--color-background)] border border-[var(--color-border-interactive)] text-[var(--color-foreground)]"
          >
            <option value="">Blank slate — everyone dropped</option>
            {(data.plan?.savedScenarios ?? []).map((sc) => (
              <option key={sc.scenarioId} value={sc.scenarioId}>
                {sc.name} — {sc.summary.keepersCount} keepers, {fmtM(sc.summary.capUsed)}, ${sc.summary.totalFees} fees
              </option>
            ))}
          </select>
          {scenarioId ? (
            <Button variant="quiet" onClick={() => deleteScenario(scenarioId)} disabled={busy}>
              Delete
            </Button>
          ) : null}
        </div>
      ) : null}

      <ul className="flex flex-col gap-1.5 mb-4">
        {data.myRoster.map((p) => {
          const e = entryOf(p.id)
          const d: Decision = e?.decision ?? 'DROP'
          const kept = d !== 'DROP'
          return (
            <li key={p.id}>
              <ListRow
                mine={kept}
                title={<PlayerName name={p.name} injuryStatus={p.injuryStatus} />}
                sub={
                  <span className="tabular-nums">
                    {[p.position, p.teamCode, p.salary != null ? fmtM(p.salary) : null].filter(Boolean).join(' · ')}
                    {' · '}
                    {p.baseRound != null ? (
                      <span>Rd {p.baseRound}</span>
                    ) : (
                      <span className="text-[var(--color-key,#ffb000)]">no round</span>
                    )}
                    {d === 'KEEP' && e?.keeperRound && e.keeperRound !== p.baseRound ? (
                      <span className="text-[var(--color-accent)]"> → takes Rd {e.keeperRound}</span>
                    ) : null}
                    {d === 'KEEP' && editable && conflictOf(p) ? (
                      <span className="ml-2 inline-flex gap-1">
                        <button
                          onClick={() => change(movePriority(entries, p.id, 'up'))}
                          aria-label={`${p.name} takes the earlier round`}
                          className="px-1.5 min-h-[2rem] rounded border border-[var(--color-border-interactive)] text-[var(--color-accent)]"
                        >
                          ▲
                        </button>
                        <button
                          onClick={() => change(movePriority(entries, p.id, 'down'))}
                          aria-label={`${p.name} takes the later round`}
                          className="px-1.5 min-h-[2rem] rounded border border-[var(--color-border-interactive)] text-[var(--color-accent)]"
                        >
                          ▼
                        </button>
                      </span>
                    ) : null}
                  </span>
                }
                end={
                  editable ? (
                    <select
                      value={d}
                      onChange={(ev2) => change(setDecision(entries, p.id, ev2.target.value as Decision))}
                      aria-label={`Decision for ${p.name}`}
                      className="min-h-[3rem] px-2 rounded bg-[var(--color-background)] border border-[var(--color-border-interactive)] text-[var(--color-foreground)]"
                    >
                      <option value="DROP">Drop</option>
                      <option value="KEEP" disabled={p.baseRound == null}>
                        Keep{p.baseRound == null ? ' (no round)' : ''}
                      </option>
                      <option value="REDSHIRT" disabled={!p.redshirtOk} title={p.redshirtWhy}>
                        Redshirt{!p.redshirtOk ? ' (n/a)' : ''}
                      </option>
                      <option value="INT_STASH" disabled={!p.intStashOk} title={p.intStashWhy}>
                        Int stash{!p.intStashOk ? ' (n/a)' : ''}
                      </option>
                    </select>
                  ) : (
                    <span
                      className={
                        'text-xs font-bold uppercase tracking-wide ' +
                        (d === 'KEEP'
                          ? 'text-[var(--color-accent)]'
                          : d === 'DROP'
                            ? 'text-[var(--color-muted-foreground)]'
                            : 'text-[var(--color-key,#ffb000)]')
                      }
                    >
                      {d === 'INT_STASH' ? 'Stash' : d.toLowerCase()}
                    </span>
                  )
                }
              />
            </li>
          )
        })}
      </ul>

      {/* The draft, round by round: who you already hold, what is open. */}
      <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-[var(--color-muted-foreground)]">
        Your draft rounds
      </h2>
      <ol className="mb-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-1.5 text-sm">
        {ev.board.map((b) => (
          <li
            key={b.round}
            className={
              'rounded-lg border px-2 py-1.5 min-h-[3rem] ' +
              (b.names.length > 0
                ? 'border-[var(--color-accent)] bg-mns-card'
                : 'border-[var(--color-border)] text-[var(--color-muted-foreground)]')
            }
          >
            <span className="tabular-nums font-bold">Rd {b.round}</span>{' '}
            <span className="block truncate">{b.names.length > 0 ? b.names.map(last).join(', ') : 'open'}</span>
          </li>
        ))}
      </ol>

      {errs.length > 0 || warns.length > 0 ? (
        <ul className="mb-4 text-sm flex flex-col gap-1">
          {errs.map((x, i) => (
            <li key={`e${i}`} className="text-[var(--color-pick-loss,#ff453a)]">{x.message}</li>
          ))}
          {warns.map((x, i) => (
            <li key={`w${i}`} className="text-[var(--color-key,#ffb000)]">{x.message}</li>
          ))}
        </ul>
      ) : null}

      {editable ? (
        <>
          <div className="mb-4 flex items-end gap-2">
            <div className="flex-1">
              <label htmlFor="kp-name" className="block text-sm text-[var(--color-muted-foreground)] mb-1">
                Save this idea as
              </label>
              <input
                id="kp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Keep the bigs"
                className="w-full min-h-[3rem] px-3 rounded bg-[var(--color-background)] border border-[var(--color-border-interactive)] text-[var(--color-foreground)]"
              />
            </div>
            <Button onClick={saveScenario} disabled={busy || !name.trim()}>
              Save idea
            </Button>
          </div>
          {confirm ? (
            <ConfirmPanel
              title={`Submit ${s.keepersCount} keeper${s.keepersCount === 1 ? '' : 's'}?`}
              detail="This is your declaration. It locks for you; the commissioner can unlock it."
              confirmLabel="Submit final keepers"
              pending={busy}
              onConfirm={submit}
              onCancel={() => setConfirm(false)}
            />
          ) : (
            <Button full onClick={() => setConfirm(true)} disabled={busy || errs.length > 0}>
              Submit final keepers
            </Button>
          )}
          <p className="mt-2 text-xs text-[var(--color-muted-foreground)] text-center">
            {saveState === 'saving' ? 'Saving…' : saveState === 'dirty' ? 'Unsaved changes' : 'Plan saved'} ·{' '}
            <Link to={`/league/${leagueId}/keepers`} className="underline">
              who has submitted
            </Link>
          </p>
        </>
      ) : (
        <p className="text-xs text-[var(--color-muted-foreground)] text-center">
          <Link to={`/league/${leagueId}/keepers`} className="underline">
            who has submitted
          </Link>
        </p>
      )}
    </div>
  )
}
