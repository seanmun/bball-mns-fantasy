import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useApi } from '../hooks/useApi'
import { useLeague } from '../contexts/LeagueContext'
import { Banner, Button, Card, ConfirmPanel, PageHeader } from '../ui/components'
import { PlayerName } from './InjuryTag'
import { Slider } from './Slider'
import { Globe, Shirt, Star } from 'lucide-react'
import { RangeChips, type RangeKey, type StatAvg } from './StatTable'
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

// Keeper season on My Team, built to the approved mockup: every player
// with last season's line, the price and the stacked round, a decision
// each, the cap and fees moving as you go, ideas to save and compare,
// the 13 rounds, and one Submit. Phones get cards; desktops get the
// sortable table in a slider with its own arrows.

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
}
type Ranges = Record<RangeKey, Record<string, StatAvg> | null>
type SortKey = 'cat' | 'ppg' | 'rpg' | 'apg' | 'spg' | 'bpg' | 'tpg' | 'tov' | 'fgPct' | 'ftPct' | 'mpg' | 'gp' | 'catD' | 'salary' | 'rd'

const M = 1_000_000
const fmtM = (n: number) => `$${(n / M).toFixed(1)}M`
const last = (name: string) => name.split(' ').slice(-1)[0]
const f1 = (v: number | null | undefined) => (v == null ? '—' : v.toFixed(1))
const f2 = (v: number | null | undefined) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`)

const SORTS: Array<[SortKey, string]> = [
  ['cat', 'Cat'],
  ['ppg', 'PTS'],
  ['rpg', 'REB'],
  ['apg', 'AST'],
  ['salary', '$'],
  ['rd', 'Rd'],
]
const COLUMNS: Array<[SortKey, string]> = [
  ['gp', 'GP'], ['mpg', 'MIN'], ['ppg', 'PTS'], ['rpg', 'REB'], ['apg', 'AST'], ['spg', 'STL'], ['bpg', 'BLK'],
  ['tpg', '3PM'], ['tov', 'TO'], ['fgPct', 'FG%'], ['ftPct', 'FT%'], ['cat', 'Cat'], ['catD', 'Cat$'],
]

export function KeeperPlanner({ leagueId, teamName, logo }: { leagueId: string; teamName: string; logo?: string | null }) {
  const { apiFetch } = useApi()
  const { currentLeague } = useLeague()
  const config = currentLeague?.config as LeagueConfig
  const [data, setData] = useState<Payload | null>(null)
  const [ranges, setRanges] = useState<Ranges | null>(null)
  const [range, setRange] = useState<RangeKey>('lastSeason')
  const [sortKey, setSortKey] = useState<SortKey>('cat')
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
    apiFetch<Ranges>(`/api/leagues/${leagueId}/stats`)
      .then((r) => {
        setRanges(r)
        setRange(r.lastSeason ? 'lastSeason' : 'season')
      })
      .catch(() => setRanges({ season: {}, last30: {}, last10: {}, lastSeason: null }))
  }, [apiFetch, leagueId, config])
  useEffect(load, [load])

  const ev = useMemo(() => (data ? evaluatePlan(entries, data.myRoster, config) : null), [data, entries, config])
  const submitted = data?.plan?.status === 'submitted' || data?.plan?.status === 'adminLocked'
  const inPhase = data?.phase === 'keeper_season'
  const editable = inPhase && !submitted
  const stat = useCallback((id: string): StatAvg | null => ranges?.[range]?.[id] ?? null, [ranges, range])

  // The working plan autosaves, so it is there on the next phone too.
  const timer = useRef<number | null>(null)
  const change = (next: RosterEntry[]) => {
    setEntries(next)
    setSaveState('dirty')
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(async () => {
      setSaveState('saving')
      try {
        await apiFetch(`/api/leagues/${leagueId}/keepers`, { method: 'POST', body: JSON.stringify({ action: 'save', entries: next }) })
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
    if (!name.trim()) return toast.error('Give the idea a name')
    setBusy(true)
    try {
      const r = await apiFetch<{ savedScenarios: SavedScenario[] }>(`/api/leagues/${leagueId}/keepers`, {
        method: 'POST',
        body: JSON.stringify({ action: 'scenario', name: name.trim(), entries }),
      })
      setData((d) => (d ? { ...d, plan: { entries, status: d.plan?.status ?? 'draft', savedScenarios: r.savedScenarios } } : d))
      setScenarioId(r.savedScenarios[r.savedScenarios.length - 1]?.scenarioId ?? '')
      toast.success(`Saved "${name.trim()}"`)
      setName('')
      setSaveState('saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not save the idea')
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
      await apiFetch(`/api/leagues/${leagueId}/keepers`, { method: 'POST', body: JSON.stringify({ action: 'submit', entries }) })
      toast.success('Keepers submitted')
      setConfirm(false)
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Submit failed')
    } finally {
      setBusy(false)
    }
  }

  if (error) return <div className="mns-page py-6"><Banner tone="crit">{error}</Banner></div>
  if (!data || !ev) return <div className="mns-page py-6 text-[var(--color-muted-foreground)]">Loading…</div>

  const s = ev.summary
  const cap = data.cap
  const fees = data.fees
  const entryOf = (id: string) => ev.entries.find((e) => e.playerId === id)
  const conflictOf = (p: RosterRow) =>
    p.baseRound != null && entries.filter((e) => e.decision === 'KEEP' && e.baseRound === p.baseRound).length > 1
  const errs = blocking(ev.errors)
  const warns = ev.errors.filter((e) => e.type === 'warning')
  const feeLines: Array<[string, number]> = (
    [
      [`Franchise tags${s.franchiseTags ? ` (${s.franchiseTags} × $${fees?.franchiseTagFee ?? 0})` : ''}`, s.franchiseTagDues],
      [`Redshirts${s.redshirtsCount ? ` (${s.redshirtsCount} × $${fees?.redshirtFee ?? 0})` : ''}`, s.redshirtDues],
      ['First apron fee', s.firstApronFee],
      [`Second apron${s.overSecondApronByM ? ` (${s.overSecondApronByM}M over)` : ''}`, s.penaltyDues],
    ] as Array<[string, number]>
  ).filter(([, v]) => v > 0)
  // Money in plain terms: what a keeper costs on average, and what is
  // left per open roster spot under each line the league uses.
  const rosterSize = config.roster?.activeSize ?? 13
  const openSpots = Math.max(0, rosterSize - s.keepersCount)
  const avgKeeper = s.keepersCount > 0 ? s.capUsed / s.keepersCount : null
  const perSpot = (line: number) => (openSpots > 0 ? (line - s.capUsed) / openSpots : null)
  const salaryCeil = Math.max(1, ...data.myRoster.map((p) => p.salary ?? 0))
  const value = (p: RosterRow): number => {
    if (sortKey === 'salary') return p.salary ?? 0
    if (sortKey === 'rd') return -(p.baseRound ?? 99)
    const st = stat(p.id)
    const v = st ? (st[sortKey as keyof StatAvg] as number | null | undefined) : null
    return v ?? -999
  }
  const sorted = [...data.myRoster].sort((a, b) => value(b) - value(a) || (b.salary ?? 0) - (a.salary ?? 0))
  const rangeNote = range === 'lastSeason' ? 'Last season' : range === 'season' ? 'This season so far' : range === 'last30' ? 'Last 30 days' : 'Last 10 days'

  // Tap an icon to decide; tap it again to drop. Keep stops at the
  // league's limit — the ninth star says why instead of lighting up.
  const toggle = (p: RosterRow, d: Decision) => {
    const current = entryOf(p.id)?.decision ?? 'DROP'
    if (current === d) return change(setDecision(entries, p.id, 'DROP'))
    if (d === 'KEEP' && s.keepersCount >= data.maxKeepers) {
      toast.error(`You're keeping ${data.maxKeepers} already — drop one to keep ${last(p.name)}.`)
      return
    }
    change(setDecision(entries, p.id, d))
  }
  const iconClass = (on: boolean, tone: 'accent' | 'key') =>
    `inline-flex items-center justify-center min-h-[2.5rem] min-w-[2.5rem] rounded-lg border ${
      on
        ? tone === 'accent'
          ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-soft)]'
          : 'border-[var(--color-key,#ffb000)] text-[var(--color-key,#ffb000)] bg-[var(--color-key-soft,rgba(255,176,0,0.15))]'
        : 'border-[var(--color-border)] text-[var(--color-muted-foreground)] bg-mns-card'
    } disabled:opacity-35`
  const decisionIcons = (p: RosterRow, d: Decision) => {
    const atCap = d !== 'KEEP' && s.keepersCount >= data.maxKeepers
    return (
      <span className="inline-flex gap-1 shrink-0">
        <button
          onClick={() => toggle(p, 'KEEP')}
          disabled={p.baseRound == null}
          aria-pressed={d === 'KEEP'}
          aria-label={`Keep ${p.name}`}
          title={p.baseRound == null ? 'No round — cannot be kept' : atCap ? `Keeping ${data.maxKeepers} already` : d === 'KEEP' ? 'Kept — tap to drop' : 'Keep'}
          className={iconClass(d === 'KEEP', 'accent')}
        >
          <Star aria-hidden className="w-5 h-5" fill={d === 'KEEP' ? 'currentColor' : 'none'} />
        </button>
        {p.redshirtOk || d === 'REDSHIRT' ? (
          <button
            onClick={() => toggle(p, 'REDSHIRT')}
            aria-pressed={d === 'REDSHIRT'}
            aria-label={`Redshirt ${p.name}`}
            title={d === 'REDSHIRT' ? 'Redshirted — tap to drop' : 'Redshirt'}
            className={iconClass(d === 'REDSHIRT', 'key')}
          >
            <Shirt aria-hidden className="w-5 h-5" fill={d === 'REDSHIRT' ? 'currentColor' : 'none'} />
          </button>
        ) : null}
        {p.intStashOk || d === 'INT_STASH' ? (
          <button
            onClick={() => toggle(p, 'INT_STASH')}
            aria-pressed={d === 'INT_STASH'}
            aria-label={`Stash ${p.name}`}
            title={d === 'INT_STASH' ? 'Stashed — tap to drop' : 'International stash'}
            className={iconClass(d === 'INT_STASH', 'key')}
          >
            <Globe aria-hidden className="w-5 h-5" />
          </button>
        ) : null}
      </span>
    )
  }
  const decisionTag = (d: Decision) => (
    <span className={`text-xs font-bold uppercase tracking-wide ${d === 'KEEP' ? 'text-[var(--color-accent)]' : d === 'DROP' ? 'text-[var(--color-muted-foreground)]' : 'text-[var(--color-key,#ffb000)]'}`}>
      {d === 'INT_STASH' ? 'Stash' : d.toLowerCase()}
    </span>
  )
  const priority = (p: RosterRow) => (
    <span className="ml-2 inline-flex gap-1 align-middle">
      <button onClick={() => change(movePriority(entries, p.id, 'up'))} aria-label={`${p.name} takes the earlier round`} className="px-1.5 min-h-[2rem] rounded border border-[var(--color-border-interactive)] text-[var(--color-accent)]">▲</button>
      <button onClick={() => change(movePriority(entries, p.id, 'down'))} aria-label={`${p.name} takes the later round`} className="px-1.5 min-h-[2rem] rounded border border-[var(--color-border-interactive)] text-[var(--color-accent)]">▼</button>
    </span>
  )
  const rowTone = (d: Decision) => (d === 'KEEP' ? 'border-[var(--color-accent)]' : d === 'DROP' ? 'border-[var(--color-border)]' : 'border-[var(--color-key,#ffb000)]')

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
        <div className="mb-4"><Banner tone="ok">Submitted. Your keepers are in. The commissioner can unlock if something needs fixing.</Banner></div>
      ) : !inPhase ? (
        <div className="mb-4"><Banner tone="info">Keeper plans open during keeper season.</Banner></div>
      ) : null}

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:gap-5 lg:items-start">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            {ranges ? <RangeChips value={range} onChange={setRange} hasLastSeason={!!ranges.lastSeason} /> : <span />}
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Sort by">
              <span className="text-sm text-[var(--color-muted-foreground)]">Sort</span>
              {SORTS.map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setSortKey(k)}
                  aria-pressed={sortKey === k}
                  className={`min-h-[2.2rem] px-3 rounded-full border text-sm font-semibold ${sortKey === k ? 'border-[var(--color-accent)] text-[var(--color-accent)] bg-[var(--color-accent-soft)]' : 'border-[var(--color-border)] bg-mns-card'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {editable ? (
            <div className="mb-3 flex items-center gap-2">
              <label className="text-sm text-[var(--color-muted-foreground)] shrink-0" htmlFor="kp-scenario">Idea</label>
              <select
                id="kp-scenario"
                value={scenarioId}
                onChange={(e) => loadScenario(e.target.value)}
                className="flex-1 min-w-0 min-h-[3rem] px-3 rounded bg-[var(--color-background)] border border-[var(--color-border-interactive)] text-[var(--color-foreground)]"
              >
                <option value="">Blank slate — everyone dropped</option>
                {(data.plan?.savedScenarios ?? []).map((sc) => (
                  <option key={sc.scenarioId} value={sc.scenarioId}>
                    {sc.name} — {sc.summary.keepersCount} keepers, {fmtM(sc.summary.capUsed)}, ${sc.summary.totalFees} fees
                  </option>
                ))}
              </select>
              {scenarioId ? <Button variant="quiet" onClick={() => deleteScenario(scenarioId)} disabled={busy}>Delete</Button> : null}
            </div>
          ) : null}

          {/* One row per player at every width: the player column pinned,
              the stats slide sideways (swipe on phones, arrows on desktop). */}
          <div className="mb-3">
            <Slider label="Scroll stats" className="rounded-xl border border-[var(--color-border)] bg-mns-card">
              <table className="w-full text-sm tabular-nums">
                <thead>
                  <tr className="text-[0.68rem] uppercase tracking-wider text-[var(--color-muted-foreground)]">
                    <th className="sticky left-0 z-[1] bg-mns-card text-left px-2 py-2">Player</th>
                    <th className="text-right px-2 py-2 cursor-pointer" onClick={() => setSortKey('salary')} aria-sort={sortKey === 'salary' ? 'descending' : undefined}>$</th>
                    <th className="text-right px-2 py-2 cursor-pointer" onClick={() => setSortKey('rd')} aria-sort={sortKey === 'rd' ? 'descending' : undefined}>Rd</th>
                    <th className="text-right px-2 py-2">Final</th>
                    {COLUMNS.map(([k, label]) => (
                      <th key={k} className={`text-right px-2 py-2 cursor-pointer ${sortKey === k ? 'text-[var(--color-accent)]' : ''}`} onClick={() => setSortKey(k)} aria-sort={sortKey === k ? 'descending' : undefined}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((p) => {
                    const d: Decision = entryOf(p.id)?.decision ?? 'DROP'
                    const e = entryOf(p.id)
                    const st = stat(p.id)
                    return (
                      <tr key={p.id} className="border-t border-[var(--color-border)]">
                        <td className={`sticky left-0 z-[1] bg-mns-card px-2 py-1.5 border-l-4 ${rowTone(d)}`}>
                          <div className="flex items-center gap-2 w-[12.5rem] lg:w-[15rem]">
                            {editable ? decisionIcons(p, d) : <span className="w-[4.5rem] shrink-0">{decisionTag(d)}</span>}
                            <div className="min-w-0">
                              <b className="block truncate"><PlayerName name={p.name} injuryStatus={p.injuryStatus} /></b>
                              <div className="text-xs text-[var(--color-muted-foreground)] truncate">{[p.position, p.teamCode].filter(Boolean).join(' · ')}</div>
                            </div>
                          </div>
                        </td>
                        <td className="relative isolate text-right px-2 py-1.5 overflow-hidden">
                          {p.salary != null ? (
                            <span
                              aria-hidden
                              className="absolute inset-y-0 left-0 -z-10 pointer-events-none"
                              style={{
                                width: `${Math.max(2, ((p.salary ?? 0) / salaryCeil) * 100)}%`,
                                background: 'linear-gradient(to right, color-mix(in srgb, var(--color-accent) 18%, transparent) 70%, transparent)',
                              }}
                            />
                          ) : null}
                          {p.salary != null ? fmtM(p.salary) : '—'}
                        </td>
                        <td className="text-right px-2 py-1.5">{p.baseRound ?? <span className="text-[var(--color-key,#ffb000)]">none</span>}</td>
                        <td className="text-right px-2 py-1.5 whitespace-nowrap">
                          {d === 'KEEP' && e?.keeperRound ? <b className="text-[var(--color-accent)]">{e.keeperRound}</b> : '—'}
                          {d === 'KEEP' && editable && conflictOf(p) ? priority(p) : null}
                        </td>
                        {st ? (
                          COLUMNS.map(([k]) => {
                            const v = st[k as keyof StatAvg] as number | null | undefined
                            return (
                              <td key={k} className={`text-right px-2 py-1.5 ${k === 'cat' && v != null && v > 0 ? 'text-[var(--color-accent)] font-bold' : ''}`}>
                                {k === 'gp' ? (v ?? '—') : k === 'cat' ? f2(v) : k === 'catD' ? (v == null ? '—' : v.toFixed(2)) : f1(v)}
                              </td>
                            )
                          })
                        ) : (
                          <td colSpan={COLUMNS.length} className="px-2 py-1.5 text-left text-[var(--color-muted-foreground)] whitespace-nowrap">
                            {p.rookieDraftInfo ? `Rookie — no ${rangeNote.toLowerCase()} line. Slot ${p.rookieDraftInfo.round}.${p.rookieDraftInfo.pick} prices him at Rd ${p.baseRound ?? '—'}.` : `No ${rangeNote.toLowerCase()} line.`}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </Slider>
          </div>
          <p className="text-xs text-[var(--color-muted-foreground)] mb-3">
            <span className="lg:hidden">Swipe the table sideways for the stats. </span>Tap ★ to keep, the jersey to redshirt; tap again to drop.{' '}
            {rangeNote}. Cat = mean z-score across the nine categories against the league pool. Cat$ = Cat per $1M.
          </p>

          {errs.length > 0 || warns.length > 0 ? (
            <ul className="mb-4 text-sm flex flex-col gap-1">
              {errs.map((x, i) => <li key={`e${i}`} className="text-[var(--color-pick-loss,#ff453a)]">{x.message}</li>)}
              {warns.map((x, i) => <li key={`w${i}`} className="text-[var(--color-key,#ffb000)]">{x.message}</li>)}
            </ul>
          ) : null}

          {editable ? (
            <>
              <div className="mb-4 flex items-end gap-2">
                <div className="flex-1">
                  <label htmlFor="kp-name" className="block text-sm text-[var(--color-muted-foreground)] mb-1">Save this idea as</label>
                  <input
                    id="kp-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Keep the bigs"
                    className="w-full min-h-[3rem] px-3 rounded bg-[var(--color-background)] border border-[var(--color-border-interactive)] text-[var(--color-foreground)]"
                  />
                </div>
                <Button variant="quiet" onClick={saveScenario} disabled={busy || !name.trim()}>Save idea</Button>
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
                <Button full onClick={() => setConfirm(true)} disabled={busy || errs.length > 0}>Submit final keepers</Button>
              )}
              <p className="mt-2 text-xs text-[var(--color-muted-foreground)] text-center">
                {saveState === 'saving' ? 'Saving…' : saveState === 'dirty' ? 'Unsaved changes' : 'Plan saved'} ·{' '}
                <Link to={`/league/${leagueId}/keepers`} className="underline">who has submitted</Link>
              </p>
            </>
          ) : (
            <p className="text-xs text-[var(--color-muted-foreground)] text-center">
              <Link to={`/league/${leagueId}/keepers`} className="underline">who has submitted</Link>
            </p>
          )}
        </div>

        <aside className="flex flex-col gap-3 mt-4 lg:mt-0 lg:sticky lg:top-4">
          {cap ? (
            <Card>
              <div className="flex items-baseline justify-between text-sm mb-2 tabular-nums">
                <span><b>{fmtM(s.capUsed)}</b> <span className="text-[var(--color-muted-foreground)]">kept salary</span></span>
                <span className="text-[var(--color-muted-foreground)]">hard cap {fmtM(cap.hardCap)}</span>
              </div>
              <div className="relative h-3 rounded-full bg-[var(--color-background)] border border-[var(--color-border)] overflow-hidden">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (s.capUsed / cap.hardCap) * 100)}%`,
                    background: s.capUsed > cap.secondApron ? 'var(--color-pick-loss, #ff453a)' : s.capUsed > cap.firstApron ? 'var(--color-key, #ffb000)' : 'var(--color-accent)',
                  }}
                />
                {cap.firstApron > 0 ? <span className="absolute top-0 h-full w-0.5 bg-[var(--color-foreground)] opacity-60" style={{ left: `${(cap.firstApron / cap.hardCap) * 100}%` }} title={`First apron ${fmtM(cap.firstApron)}`} /> : null}
                {cap.secondApron > 0 ? <span className="absolute top-0 h-full w-0.5 bg-[var(--color-foreground)] opacity-60" style={{ left: `${(cap.secondApron / cap.hardCap) * 100}%` }} title={`Second apron ${fmtM(cap.secondApron)}`} /> : null}
              </div>
              <div className="mt-1 flex justify-between text-xs text-[var(--color-muted-foreground)] tabular-nums">
                <span>{cap.firstApron > 0 ? `first apron ${fmtM(cap.firstApron)}` : ''}</span>
                <span>{cap.secondApron > 0 ? `second apron ${fmtM(cap.secondApron)}` : ''}</span>
              </div>
            </Card>
          ) : null}
          <Card>
            <div className="grid grid-cols-3 gap-2 text-center tabular-nums">
              <div><div className="text-2xl font-bold">{s.keepersCount}<span className="text-base font-normal text-[var(--color-muted-foreground)]">/{data.maxKeepers}</span></div><div className="text-xs text-[var(--color-muted-foreground)]">keepers</div></div>
              <div><div className="text-2xl font-bold">{s.redshirtsCount + s.intStashCount}</div><div className="text-xs text-[var(--color-muted-foreground)]">parked</div></div>
              <div><div className="text-2xl font-bold">${s.totalFees}</div><div className="text-xs text-[var(--color-muted-foreground)]">fees</div></div>
            </div>
            {feeLines.length > 0 ? (
              <ul className="mt-3 text-sm divide-y divide-[var(--color-border)] tabular-nums">
                {feeLines.map(([label, v]) => <li key={label} className="flex justify-between py-1"><span className="text-[var(--color-muted-foreground)]">{label}</span><span>${v}</span></li>)}
              </ul>
            ) : null}
            <ul className="mt-3 text-sm divide-y divide-[var(--color-border)] tabular-nums border-t border-[var(--color-border)]">
              <li className="flex justify-between py-1">
                <span className="text-[var(--color-muted-foreground)]">Average per keeper</span>
                <span>{avgKeeper != null ? fmtM(avgKeeper) : '—'}</span>
              </li>
              {cap ? (
                <>
                  <li className="flex justify-between py-1">
                    <span className="text-[var(--color-muted-foreground)]">Left per open spot, to first apron</span>
                    <span className={perSpot(cap.firstApron) != null && perSpot(cap.firstApron)! < 0 ? 'text-[var(--color-pick-loss,#ff453a)]' : ''}>
                      {perSpot(cap.firstApron) != null ? fmtM(perSpot(cap.firstApron)!) : '—'}
                    </span>
                  </li>
                  <li className="flex justify-between py-1">
                    <span className="text-[var(--color-muted-foreground)]">Left per open spot, to hard cap</span>
                    <span className={perSpot(cap.hardCap) != null && perSpot(cap.hardCap)! < 0 ? 'text-[var(--color-pick-loss,#ff453a)]' : ''}>
                      {perSpot(cap.hardCap) != null ? fmtM(perSpot(cap.hardCap)!) : '—'}
                    </span>
                  </li>
                </>
              ) : null}
              <li className="flex justify-between py-1 text-xs text-[var(--color-muted-foreground)]">
                <span>Open spots</span>
                <span>{openSpots} of {rosterSize}</span>
              </li>
            </ul>
          </Card>
          <div>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wider text-[var(--color-muted-foreground)]">Your draft rounds</h2>
            <ol className="grid grid-cols-2 lg:grid-cols-1 gap-1.5 text-sm">
              {ev.board.map((b) => {
                const tag = b.names.length > 0 && b.round !== 1 && ev.entries.some((e) => e.decision === 'KEEP' && e.keeperRound === b.round && e.baseRound === 1)
                return (
                  <li key={b.round} className={`rounded-lg border px-2 py-1.5 min-h-[3rem] ${b.names.length > 0 ? `bg-mns-card ${tag ? 'border-[var(--color-key,#ffb000)]' : 'border-[var(--color-accent)]'}` : 'border-[var(--color-border)] text-[var(--color-muted-foreground)]'}`}>
                    <b className="block text-[0.7rem] uppercase tracking-wider">Rd {b.round}{tag ? ' · franchise tag' : ''}</b>
                    <span className="block truncate">{b.names.length > 0 ? b.names.map(last).join(', ') : 'open'}</span>
                  </li>
                )
              })}
            </ol>
          </div>
        </aside>
      </div>
    </div>
  )
}
