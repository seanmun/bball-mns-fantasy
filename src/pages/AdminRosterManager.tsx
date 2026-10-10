import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useUser } from '@clerk/clerk-react'
import { toast } from 'sonner'
import { Plus, Search, X } from 'lucide-react'
import { useApi } from '../hooks/useApi'
import { useLeague } from '../contexts/LeagueContext'
import { Button, EmptyState, Skeleton } from '../ui/components'
import { PlayerName } from '../components/InjuryTag'
import { COUNTS_AGAINST_CAP, HOLDS_ROSTER_SPOT } from '../lib/season/roster'
import type { StatAvg } from '../lib/playerView'
import type { Player, PlayerSlot } from '../types/player'
import type { Team } from '../types/team'
import { baseKeeperRound } from '../rules/keeperRules'
import {
  formatRoundEntry,
  parseRoundEntry,
  slotForLastYearRedshirt,
  slotFromThisBoard,
} from '../rules/rookieSlots'

// Building a league's rosters by hand — the migration tool. It used to
// be one table of every player with a team dropdown on each row: to
// fill four rosters you scrolled three hundred rows and worked forty
// dropdowns. This is the draft board instead: pick a team once, then
// type-and-Enter your way through the pool. The team you're filling is
// always on screen with its cap and its count, so you can see the
// roster take shape.

const M = 1_000_000
const fmtM = (n: number) => (n >= M ? `$${(n / M).toFixed(2)}M` : `$${(n / 1000).toFixed(0)}k`)

const SLOTS: Array<{ value: PlayerSlot; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'bench', label: 'Bench' },
  { value: 'ir', label: 'IR' },
  { value: 'redshirt', label: 'Redshirt' },
  { value: 'international', label: 'Intl' },
]

export function AdminRosterManager() {
  const { user } = useUser()
  const { currentLeague, loading: leagueLoading } = useLeague()
  const { apiFetch } = useApi()

  const [players, setPlayers] = useState<Player[] | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  const [stats, setStats] = useState<Record<string, StatAvg>>({})
  const [error, setError] = useState<string | null>(null)
  const [activeTeam, setActiveTeam] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  // What's being typed in a "Rd" box, until it's committed on blur/Enter.
  const [roundDrafts, setRoundDrafts] = useState<Record<string, string>>({})
  const searchRef = useRef<HTMLInputElement>(null)

  const leagueId = currentLeague?.id
  const isCommissioner =
    !!user && !!currentLeague && currentLeague.commissionerId === user.id

  useEffect(() => {
    if (!leagueId) return
    let cancelled = false
    Promise.all([
      apiFetch<Player[]>(`/api/leagues/${leagueId}/players`),
      apiFetch<Team[]>(`/api/leagues/${leagueId}/teams`),
    ])
      .then(([p, t]) => {
        if (cancelled) return
        setPlayers(p)
        setTeams(t)
        setActiveTeam((cur) => cur ?? t[0]?.id ?? null)
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    apiFetch<{ season: Record<string, StatAvg> }>(`/api/leagues/${leagueId}/stats`)
      .then((r) => !cancelled && setStats(r.season ?? {}))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [leagueId, apiFetch])

  // Optimistic: the board must feel instant, and a failure puts the
  // player back where she was rather than leaving a lie on screen.
  const patch = useCallback(
    async (playerId: string, body: Partial<Player>, previous: Partial<Player>) => {
      if (!leagueId) return
      setPlayers((prev) =>
        (prev ?? []).map((p) => (p.id === playerId ? { ...p, ...body } : p))
      )
      try {
        await apiFetch(`/api/leagues/${leagueId}/players/${playerId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        })
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Save failed')
        setPlayers((prev) =>
          (prev ?? []).map((p) => (p.id === playerId ? { ...p, ...previous } : p))
        )
      }
    },
    [leagueId, apiFetch]
  )

  // One box carries both prices: a bare round is last year's round
  // (this year costs one less); round.pick is the rookie slot of a
  // rookie redshirted last year (priced by the rookie table).
  const commitRound = useCallback(
    (p: Player, text: string) => {
      setRoundDrafts((d) => {
        const next = { ...d }
        delete next[p.id]
        return next
      })
      const entry = parseRoundEntry(text)
      const previous = {
        keeperPriorYearRound: p.keeperPriorYearRound,
        rookieDraftInfo: p.rookieDraftInfo,
      }
      if (entry.kind === 'invalid') {
        toast.error('Type a round (4) or a rookie slot (1.4)')
        return
      }
      if (entry.kind === 'empty') {
        if (p.keeperPriorYearRound == null && !p.rookieDraftInfo) return
        void patch(p.id, { keeperPriorYearRound: null, rookieDraftInfo: null }, previous)
        return
      }
      if (entry.kind === 'round') {
        if (p.keeperPriorYearRound === entry.round && !p.rookieDraftInfo) return
        void patch(p.id, { keeperPriorYearRound: entry.round, rookieDraftInfo: null }, previous)
        return
      }
      void patch(
        p.id,
        {
          keeperPriorYearRound: null,
          rookieDraftInfo: slotForLastYearRedshirt(entry.round, entry.pick),
        },
        previous
      )
    },
    [patch]
  )
  const pool = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (players ?? [])
      .filter((p) => p.teamId == null)
      .filter(
        (p) =>
          !q ||
          p.name.toLowerCase().includes(q) ||
          (p.teamCode ?? '').toLowerCase().includes(q) ||
          (p.position ?? '').toLowerCase().includes(q)
      )
      .sort((a, b) => (stats[b.id]?.cat ?? -99) - (stats[a.id]?.cat ?? -99))
  }, [players, search, stats])

  if (leagueLoading || (!players && !error)) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8 flex flex-col gap-2">
        <Skeleton h="2.2rem" w="40%" />
        <Skeleton h="4rem" />
        <Skeleton h="20rem" />
      </div>
    )
  }
  if (!currentLeague) {
    return (
      <EmptyState title="No league selected">
        <Link to="/teams" className="text-[var(--color-accent)]">
          Pick a league
        </Link>
      </EmptyState>
    )
  }
  if (!isCommissioner) {
    return <EmptyState title="Commissioner only">Rosters belong to whoever runs the league.</EmptyState>
  }
  if (error) return <EmptyState title="Something went wrong">{error}</EmptyState>

  const all = players ?? []
  const activeSize = currentLeague.config.roster?.activeSize ?? 10
  const cap = currentLeague.config.cap?.enabled ? currentLeague.config.cap : null
  // Leagues with keepers carry each player's prior-year round in from
  // the old platform here — the number that sets this year's cost.
  const keepers = (currentLeague?.config.roster?.maxKeepers ?? 0) > 0
  const rosterOf = (teamId: string) => all.filter((p) => p.teamId === teamId)
  const spotsOf = (teamId: string) => rosterOf(teamId).filter((p) => HOLDS_ROSTER_SPOT(p.slot)).length
  const capOf = (teamId: string) =>
    rosterOf(teamId)
      .filter((p) => COUNTS_AGAINST_CAP(p.slot))
      .reduce((n, p) => n + (p.salary ?? 0), 0)

  const add = (p: Player) => {
    if (!activeTeam) return
    patch(p.id, { teamId: activeTeam, slot: 'active' }, { teamId: null })
    setSearch('')
    searchRef.current?.focus()
  }
  const remove = (p: Player) =>
    patch(p.id, { teamId: null, slot: 'active' }, { teamId: p.teamId, slot: p.slot })

  const current = teams.find((t) => t.id === activeTeam) ?? null
  const currentRoster = activeTeam ? rosterOf(activeTeam) : []
  const unassigned = all.filter((p) => p.teamId == null).length

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 pb-24">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Rosters</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {currentLeague.name} · {all.length} players · {unassigned} still free
          </p>
        </div>
        <Link
          to={`/league/${currentLeague.id}/lm`}
          className="text-sm text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] shrink-0"
        >
          ← Commissioner
        </Link>
      </div>

      {teams.length === 0 ? (
        <EmptyState title="No teams yet">
          <Link to={`/league/${currentLeague.id}/lm/teams`} className="text-[var(--color-accent)]">
            Add teams first
          </Link>
          , then fill their rosters here.
        </EmptyState>
      ) : (
        <>
          {/* Every team's progress, and the switch between them. A phone
              scrolls the strip sideways; a desktop wraps it so every
              team is one click away without a trackpad. */}
          <div className="flex gap-1.5 overflow-x-auto pb-2 mb-4 lg:flex-wrap lg:overflow-visible">
            {teams.map((t) => {
              const filled = spotsOf(t.id)
              const on = t.id === activeTeam
              return (
                <button
                  key={t.id}
                  onClick={() => setActiveTeam(t.id)}
                  aria-pressed={on}
                  className={
                    'shrink-0 rounded-lg px-3 py-2 min-h-[3rem] border text-left ' +
                    (on
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/10'
                      : 'border-[var(--color-border)]')
                  }
                >
                  <span className={'block text-sm font-semibold ' + (on ? 'text-[var(--color-accent)]' : '')}>
                    {t.name}
                  </span>
                  <span className="block text-xs tabular-nums text-[var(--color-muted-foreground)]">
                    {filled}/{activeSize}
                    {filled === activeSize ? ' ✓' : ''}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            {/* The pool: type, press Enter, she lands on the roster. */}
            <section>
              <div className="relative mb-2">
                <Search
                  aria-hidden
                  className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-muted-foreground)]"
                />
                <input
                  ref={searchRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && pool[0]) add(pool[0])
                    if (e.key === 'Escape') setSearch('')
                  }}
                  placeholder={`Search the pool — Enter adds to ${current?.name ?? 'the team'}`}
                  className="w-full pl-9 pr-3 py-2.5 min-h-[3rem] rounded-lg bg-mns-card border border-[var(--color-border-interactive)] text-[var(--color-foreground)] placeholder:text-[var(--color-muted-foreground)] focus:outline-none focus:border-[var(--color-accent)]"
                />
              </div>
              <ul className="flex flex-col gap-1 max-h-[28rem] overflow-y-auto">
                {pool.slice(0, 60).map((p, i) => (
                  <li key={p.id}>
                    <button
                      onClick={() => add(p)}
                      className={
                        'w-full flex items-center gap-2 text-left rounded-lg px-3 py-2 min-h-[3rem] border hover:border-[var(--color-accent)] transition-colors ' +
                        (i === 0 && search
                          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/5'
                          : 'border-[var(--color-border)] bg-mns-card')
                      }
                    >
                      <Plus aria-hidden className="w-4 h-4 shrink-0 text-[var(--color-accent)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold truncate">
                          <PlayerName name={p.name} injuryStatus={p.injuryStatus} />
                        </span>
                        <span className="block text-xs text-[var(--color-muted-foreground)] tabular-nums">
                          {[p.position, p.teamCode, p.salary != null ? fmtM(p.salary) : null]
                            .filter(Boolean)
                            .join(' · ')}
                          {stats[p.id]?.cat != null ? ` · CAT ${stats[p.id].cat?.toFixed(2)}` : ''}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
                {pool.length === 0 ? (
                  <li className="text-sm text-[var(--color-muted-foreground)] px-3 py-4">
                    {all.length === 0
                      ? 'The player pool is on its way — it fills on its own within a few minutes of the league being created.'
                      : 'No free agents match.'}
                  </li>
                ) : null}
              </ul>
            </section>

            {/* The team taking shape. */}
            <section>
              <div className="mb-2 rounded-lg border border-[var(--color-border)] bg-mns-card px-3 py-2 flex items-baseline justify-between tabular-nums">
                <b className="truncate">{current?.name}</b>
                <span className="text-sm shrink-0">
                  <b
                    style={{
                      color:
                        spotsOf(activeTeam ?? '') > activeSize
                          ? 'var(--color-pick-loss, #ff453a)'
                          : undefined,
                    }}
                  >
                    {spotsOf(activeTeam ?? '')}/{activeSize}
                  </b>
                  {cap ? (
                    <span
                      className="ml-2"
                      style={{
                        color:
                          capOf(activeTeam ?? '') > cap.hardCap
                            ? 'var(--color-pick-loss, #ff453a)'
                            : 'var(--color-muted-foreground)',
                      }}
                    >
                      {fmtM(capOf(activeTeam ?? ''))} / {fmtM(cap.hardCap)}
                    </span>
                  ) : null}
                </span>
              </div>
              <ul className="flex flex-col gap-1 max-h-[28rem] overflow-y-auto">
                {currentRoster.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-mns-card px-3 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold truncate">
                        <PlayerName name={p.name} injuryStatus={p.injuryStatus} />
                      </span>
                      <span className="block text-xs text-[var(--color-muted-foreground)] tabular-nums">
                        {[
                          p.position,
                          p.teamCode,
                          p.salary != null ? fmtM(p.salary) : null,
                          keepers
                            ? (() => {
                                const cost = baseKeeperRound(p, currentLeague.config)
                                return cost != null ? `keeps at Rd ${cost}` : 'no round yet'
                              })()
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    {keepers ? (
                      slotFromThisBoard(p.rookieDraftInfo, currentLeague.seasonYear) ? (
                        <span
                          title="Set on the rookie draft board"
                          className="shrink-0 w-14 text-xs px-2 py-1 min-h-[2.5rem] inline-flex items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-muted-foreground)] tabular-nums"
                        >
                          {formatRoundEntry(p)}
                        </span>
                      ) : (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={roundDrafts[p.id] ?? formatRoundEntry(p)}
                          placeholder="Rd"
                          title="Last year's round (4) — this year costs one less. A rookie redshirted last year: her rookie slot (1.4) instead."
                          aria-label={`Last year's round or rookie slot for ${p.name}`}
                          onChange={(e) =>
                            setRoundDrafts((d) => ({ ...d, [p.id]: e.target.value }))
                          }
                          onBlur={(e) => commitRound(p, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                          }}
                          className="shrink-0 w-14 text-xs px-2 py-1 min-h-[2.5rem] rounded bg-[var(--color-background)] border border-[var(--color-border-interactive)] text-[var(--color-foreground)] tabular-nums"
                        />
                      )
                    ) : null}
                    <select
                      value={p.slot ?? 'active'}
                      onChange={(e) =>
                        patch(p.id, { slot: e.target.value as PlayerSlot }, { slot: p.slot })
                      }
                      aria-label={`Slot for ${p.name}`}
                      className="shrink-0 text-xs px-2 py-1 min-h-[2.5rem] rounded bg-[var(--color-background)] border border-[var(--color-border-interactive)] text-[var(--color-foreground)]"
                    >
                      {SLOTS.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <button
                      onClick={() => remove(p)}
                      aria-label={`Remove ${p.name}`}
                      className="shrink-0 p-2 text-[var(--color-muted-foreground)] hover:text-[var(--color-pick-loss,#ff453a)]"
                    >
                      <X aria-hidden className="w-4 h-4" />
                    </button>
                  </li>
                ))}
                {currentRoster.length === 0 ? (
                  <li className="text-sm text-[var(--color-muted-foreground)] px-3 py-4">
                    Empty — search on the left and press Enter to add.
                    {keepers
                      ? ' "Rd" is last year\'s round (4), or the rookie slot (1.4) for a rookie redshirted last year.'
                      : ''}
                  </li>
                ) : null}
              </ul>
            </section>
          </div>

          <div className="mt-6">
            <Button to={`/league/${currentLeague.id}/lm/teams`} variant="quiet">
              Teams &amp; invites
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
