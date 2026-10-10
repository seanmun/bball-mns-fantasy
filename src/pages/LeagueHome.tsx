import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useUser } from '@clerk/clerk-react'
import { useApi } from '../hooks/useApi'
import { useLeague } from '../contexts/LeagueContext'
import { ChevronLeft, ChevronRight, Trophy } from 'lucide-react'
import { Button } from '../ui/components'
import { LEAGUE_PHASE_LABELS, LEAGUE_PHASE_ORDER, type LeaguePhase } from '../types/league'

export function LeagueHome() {
  const { leagueId } = useParams<{ leagueId: string }>()
  const { user } = useUser()
  const { userLeagues, loading } = useLeague()

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-green-500 border-r-transparent" />
      </div>
    )
  }

  const league = userLeagues.find((l) => l.id === leagueId)

  if (!league) {
    return (
      <div className="mns-page py-16 text-center">
        <h1 className="text-2xl font-bold mb-2">League not found</h1>
        <p className="text-gray-400 mb-6">
          You don't have access to this league, or it doesn't exist.
        </p>
        <Link
          to="/teams"
          className="inline-block px-5 py-2.5 bg-mns-card hover:bg-mns-hover border border-gray-700 text-white font-semibold rounded-lg"
        >
          ← Back to your leagues
        </Link>
      </div>
    )
  }

  const isCommissioner = league.commissionerId === user?.id
  const leaguePhase = league.leaguePhase

  return (
    <div className="mns-page py-8 sm:py-12">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl sm:text-4xl font-bold">{league.name}</h1>
          {isCommissioner && (
            <span className="px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide bg-green-400/15 text-green-400 border border-green-400/30 rounded-full">
              Commissioner
            </span>
          )}
        </div>
        <div className="text-sm text-gray-400 mb-2">
          {league.sport.toUpperCase()} · {league.seasonYear}
          {userLeagues.length > 1 ? (
            <>
              {' · '}
              <Link to="/teams" className="text-green-400 hover:text-green-300 font-semibold">
                Switch league ⇄
              </Link>
            </>
          ) : null}
        </div>
        {/* Phase chain, legacy-mns style: where the league is in its
            year, at a glance. */}
        <div className="flex items-center gap-1 flex-wrap">
          {LEAGUE_PHASE_ORDER.map((phase: LeaguePhase, idx: number) => {
            const isCurrent = leaguePhase === phase
            const isComplete = LEAGUE_PHASE_ORDER.indexOf(leaguePhase) > idx
            return (
              <span key={phase} className="flex items-center gap-1">
                {idx > 0 ? (
                  <span className={'w-3 h-px ' + (isComplete || isCurrent ? 'bg-green-400/40' : 'bg-gray-700')} />
                ) : null}
                <span
                  className={
                    'px-2 py-0.5 rounded-full text-[0.68rem] font-semibold ' +
                    (isCurrent
                      ? 'bg-green-400/20 text-green-400 border border-green-400/50'
                      : isComplete
                        ? 'bg-gray-800 text-gray-500 border border-gray-700'
                        : 'bg-gray-900 text-gray-600 border border-gray-800')
                  }
                >
                  {LEAGUE_PHASE_LABELS[phase]}
                </span>
              </span>
            )
          })}
        </div>
      </div>

      {/* Manager tools live in their own portal — the home page is a
          member screen for everyone, commissioner included. */}
      {isCommissioner && (
        <Link
          to={`/league/${league.id}/lm`}
          className="mb-8 flex items-center justify-between bg-mns-card hover:bg-mns-hover border border-green-400/30 rounded-lg px-4 py-3"
        >
          <span>
            <b className="text-green-400">Manage league</b>
            <span className="block text-sm text-gray-400">Setup, teams, rosters, draft — the commissioner's tools.</span>
          </span>
          <span className="text-green-400 text-xl">→</span>
        </Link>
      )}

      {/* This week's matchups — the season's front door, mine first
          and loudest */}
      {leaguePhase === 'rookie_draft' ? (
        <Link
          to={`/league/${league.id}/rookie-draft`}
          className="mb-6 flex items-center justify-between bg-mns-card hover:bg-mns-hover border border-[var(--color-accent)]/40 rounded-lg px-4 py-3"
        >
          <span>
            <b className="text-[var(--color-accent)]">The rookie draft is on</b>
            <span className="block text-sm text-gray-400">
              Worst record picks first — traded picks belong to whoever holds them.
            </span>
          </span>
          <span className="text-[var(--color-accent)] text-xl">→</span>
        </Link>
      ) : null}

      {leaguePhase === 'keeper_season' ? (
        <Link
          to={`/league/${league.id}/my-team`}
          className="mb-6 flex items-center justify-between bg-mns-card hover:bg-mns-hover border border-[var(--color-key,#ffb000)]/40 rounded-lg px-4 py-3"
        >
          <span>
            <b style={{ color: 'var(--color-key, #ffb000)' }}>Keeper season is open</b>
            <span className="block text-sm text-gray-400">
              Set your keepers on My Team — plan, compare, submit. Everyone else hits the draft pool.
            </span>
          </span>
          <span className="text-xl" style={{ color: 'var(--color-key, #ffb000)' }}>→</span>
        </Link>
      ) : null}

      {leaguePhase === 'regular_season' || leaguePhase === 'playoffs' ? (
        // Phones read top to bottom: pot, matchups, standings. A desktop
        // keeps that DOM order but places matchups in a wide left column
        // with the pot and standings stacked beside them.
        <div className="lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-x-8 lg:items-start">
          <div className="lg:col-start-2 lg:row-start-1">
            <PrizesTeaser leagueId={league.id} />
          </div>
          <div className="lg:col-start-1 lg:row-start-1 lg:row-span-2">
            <WeekMatchups leagueId={league.id} myUserId={user?.id ?? null} />
          </div>
          <div className="lg:col-start-2 lg:row-start-2">
            <StandingsSection leagueId={league.id} myUserId={user?.id ?? null} />
          </div>
        </div>
      ) : leaguePhase === 'champion' ? (
        // The season is over. The record comes first — who won, who
        // gets paid — then the final table, then every week's results
        // to walk back through. Nothing on this screen is live.
        <>
          <SeasonResults leagueId={league.id} seasonYear={league.seasonYear} />
          <div className="lg:grid lg:grid-cols-2 lg:gap-x-8 lg:items-start">
            <StandingsSection leagueId={league.id} myUserId={user?.id ?? null} />
            <WeekMatchups leagueId={league.id} myUserId={user?.id ?? null} browse />
          </div>
        </>
      ) : (
        <TeamsSection leagueId={league.id} isCommissioner={isCommissioner} myUserId={user?.id ?? null} />
      )}
    </div>
  )
}

interface FinalRecord {
  at: string
  seasonYear: number
  champion: { teamId: string; name: string } | null
  runnerUp: { teamId: string; name: string } | null
  places: Array<{ place: number; teamId: string; name: string; via: string }>
}
interface PrizesSummary {
  totalUsd: number
  configured: boolean
  splits: Array<{ label: string; share: number; amountUsd: number; holder: string | null }>
  final?: FinalRecord
}

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: n >= 1000 ? 0 : 2 })

// The season's record, frozen at the crown: champion, runner-up, and
// what each paid place took home. Reads the same frozen snapshot the
// Prizes tab shows, so the two never disagree.
function SeasonResults({ leagueId, seasonYear }: { leagueId: string; seasonYear: number }) {
  const { apiFetch } = useApi()
  const [data, setData] = useState<PrizesSummary | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    apiFetch<PrizesSummary>(`/api/leagues/${leagueId}/prizes`)
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch(() => {
        if (!cancelled) setData(null)
      })
    return () => {
      cancelled = true
    }
  }, [apiFetch, leagueId])

  if (data === undefined) return null
  const final = data?.final
  if (!final) {
    // Crowned, record not written yet — the tick lands it within the
    // hour. Say so rather than show a live number as if it were final.
    return (
      <section className="mb-8 rounded-lg border border-[var(--color-border)] bg-mns-card p-5">
        <p className="text-[0.72rem] font-bold tracking-[0.14em] uppercase text-[var(--color-accent)] mb-1">
          {seasonYear} season complete
        </p>
        <p className="text-[var(--color-muted-foreground)]">
          The final record is being written. Check back shortly.
        </p>
      </section>
    )
  }
  const finalDate = new Date(final.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return (
    <section className="mb-8 rounded-lg border border-[var(--color-accent)] bg-mns-card p-5">
      <p className="text-[0.72rem] font-bold tracking-[0.14em] uppercase text-[var(--color-accent)] mb-2">
        {final.seasonYear} season · Final
      </p>
      {final.champion ? (
        <h2 className="text-2xl sm:text-3xl font-bold flex items-center gap-2 leading-tight">
          <Trophy aria-hidden className="w-7 h-7 shrink-0 text-[var(--color-key,#ffb000)]" />
          <span>
            {final.champion.name}
            <span className="block text-sm font-semibold text-[var(--color-muted-foreground)]">Champion</span>
          </span>
        </h2>
      ) : null}
      {final.runnerUp ? (
        <p className="mt-2 text-lg">
          <span className="text-[var(--color-muted-foreground)]">Runner-up</span>{' '}
          <b>{final.runnerUp.name}</b>
        </p>
      ) : null}

      {data?.configured && data.splits.length > 0 ? (
        <ul className="mt-4 divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
          {data.splits.map((sp, i) => (
            <li key={i} className="flex items-baseline justify-between gap-3 py-2.5 tabular-nums">
              <span className="min-w-0">
                <b className="block truncate">{sp.holder ?? '—'}</b>
                <span className="block text-sm text-[var(--color-muted-foreground)]">
                  {sp.label} · {sp.share}%
                </span>
              </span>
              <b className="shrink-0 text-lg">{usd(sp.amountUsd)}</b>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 flex items-baseline justify-between gap-3 text-sm text-[var(--color-muted-foreground)]">
        <span>
          {data?.configured ? `Pot ${usd(data.totalUsd)} · ` : ''}final as of {finalDate}
        </span>
        <Link to={`/league/${leagueId}/prizes`} className="shrink-0 font-semibold text-[var(--color-accent)]">
          Prizes →
        </Link>
      </div>
    </section>
  )
}

interface WeekMatchup {
  id: string
  status: string
  label?: string | null
  homeTeamId: string
  awayTeamId: string
  homeTeamName: string
  awayTeamName: string
  homeScore: number
  awayScore: number
}

interface WeekPayload {
  week: number | null
  firstWeek?: number
  totalWeeks?: number
  matchups: WeekMatchup[]
}

// This week's matchups in season; with `browse`, any week's results
// with arrows to walk the schedule — the offseason reading room.
function WeekMatchups({
  leagueId,
  myUserId,
  browse = false,
}: {
  leagueId: string
  myUserId: string | null
  browse?: boolean
}) {
  const { apiFetch } = useApi()
  const [week, setWeek] = useState<number | null>(null)
  const [data, setData] = useState<WeekPayload | null>(null)
  const [myTeamId, setMyTeamId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      apiFetch<WeekPayload>(`/api/leagues/${leagueId}/matchups${week != null ? `?week=${week}` : ''}`),
      apiFetch<Array<{ id: string; owners: Array<{ userId: string | null }> }>>(`/api/leagues/${leagueId}/teams`),
    ])
      .then(([d, teams]) => {
        if (cancelled) return
        setData(d)
        setMyTeamId(teams.find((t) => t.owners.some((o) => o.userId === myUserId))?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) setData({ week: null, matchups: [] })
      })
    return () => {
      cancelled = true
    }
  }, [apiFetch, leagueId, myUserId, week])

  if (!data || data.week == null) return null
  if (!browse && data.matchups.length === 0) return null
  const isMine = (m: WeekMatchup) => m.homeTeamId === myTeamId || m.awayTeamId === myTeamId
  const sorted = [...data.matchups].sort((a, b) => Number(isMine(b)) - Number(isMine(a)))
  const labels = new Set(data.matchups.map((m) => m.label).filter(Boolean))
  const title = labels.size === 1 ? `${[...labels][0]} · week ${data.week}` : `Week ${data.week} matchups`
  const first = data.firstWeek ?? 1
  const last = data.totalWeeks ?? data.week

  return (
    <section className="mb-8">
      {browse ? (
        <div className="flex items-center justify-between gap-2 mb-4">
          <Button
            variant="quiet"
            aria-label="Previous week"
            disabled={data.week <= first}
            onClick={() => setWeek(data.week! - 1)}
          >
            <ChevronLeft aria-hidden />
          </Button>
          <h2 className="text-xl font-bold text-center">{title}</h2>
          <Button
            variant="quiet"
            aria-label="Next week"
            disabled={data.week >= last}
            onClick={() => setWeek(data.week! + 1)}
          >
            <ChevronRight aria-hidden />
          </Button>
        </div>
      ) : (
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-xl font-bold">{title}</h2>
          <Link to={`/league/${leagueId}/standings`} className="text-sm text-green-400 hover:text-green-300">
            Standings →
          </Link>
        </div>
      )}
      {browse && sorted.length === 0 ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">No matchups this week.</p>
      ) : null}
      <ul className="grid gap-2 sm:grid-cols-2">
        {sorted.map((m, i) => (
          <li
            key={m.id}
            className={
              // Mine leads full width; a lone straggler in the 2-col
              // grid (odd count of others) also spans, so no card ever
              // sits half-width next to an empty slot.
              isMine(m) ||
              (i === sorted.length - 1 && sorted.filter((x) => !isMine(x)).length % 2 === 1)
                ? 'sm:col-span-2'
                : ''
            }
          >
            <Link
              to={`/league/${leagueId}/matchup/${m.id}`}
              className={
                'block bg-mns-card hover:bg-mns-hover border rounded-lg px-4 py-3 transition-colors ' +
                (isMine(m) ? 'border-l-4 border-[var(--color-accent)] text-lg' : 'border-gray-800')
              }
            >
              <span className="flex items-center justify-between tabular-nums">
                <span className="font-semibold truncate">{m.awayTeamName}</span>
                <b className="shrink-0 px-2">{m.awayScore}</b>
              </span>
              <span className="flex items-center justify-between tabular-nums">
                <span className="font-semibold truncate">{m.homeTeamName}</span>
                <b className="shrink-0 px-2">{m.homeScore}</b>
              </span>
              <span className="block mt-1 text-[0.68rem] font-bold uppercase tracking-wider text-[var(--color-muted-foreground)]">
                {m.status === 'final' ? 'Final' : m.status === 'live' ? 'Live — category score' : 'Scheduled'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

interface HomeTeamOwner {
  id: string
  userId: string | null
  email: string
  displayName: string | null
}
interface HomeTeam {
  id: string
  name: string
  owners: HomeTeamOwner[]
}

interface StandingRow {
  id: string
  name: string
  logo?: string | null
  owners: Array<{ userId: string | null; displayName: string | null; email: string }>
  wins: number
  losses: number
  ties: number
  pointsFor: number
  salary: number
}

// The legacy-mns home standings table: rank, team, record, salary —
// tap through to the team page. The full Standings tab stays the
// canonical board; this is the at-a-glance version.
function StandingsSection({ leagueId, myUserId }: { leagueId: string; myUserId: string | null }) {
  const { apiFetch } = useApi()
  const { currentLeague } = useLeague()
  const cap = currentLeague?.config.cap?.enabled ? currentLeague.config.cap : null
  const [rows, setRows] = useState<StandingRow[] | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch<StandingRow[]>(`/api/leagues/${leagueId}/standings`)
      .then((r) => {
        if (!cancelled) setRows(r)
      })
      .catch(() => {
        if (!cancelled) setRows([])
      })
    return () => {
      cancelled = true
    }
  }, [apiFetch, leagueId])

  if (!rows || rows.length === 0) return null
  const sorted = [...rows].sort((a, b) => b.wins - a.wins || b.pointsFor - a.pointsFor)

  return (
    <section className="mb-8">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-xl font-bold">Standings</h2>
        <Link to={`/league/${leagueId}/standings`} className="text-sm text-green-400 hover:text-green-300">
          Full standings →
        </Link>
      </div>
      <div className="bg-mns-card rounded-lg border border-gray-800 divide-y divide-gray-800">
        {sorted.map((t, i) => {
          const mine = t.owners.some((o) => o.userId === myUserId)
          return (
            <Link
              key={t.id}
              to={`/league/${leagueId}/team/${t.id}`}
              className={
                'flex items-center gap-3 px-4 py-3 hover:bg-mns-hover transition-colors ' +
                (mine ? 'bg-green-400/5' : '')
              }
            >
              <span className={'w-6 text-lg font-bold tabular-nums ' + (i === 0 ? 'text-green-400' : 'text-gray-500')}>
                {i + 1}
              </span>
              {t.logo ? (
                <img src={t.logo} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
              ) : null}
              <span className="flex-1 min-w-0">
                <span className="block font-semibold truncate">
                  {t.name}
                  {mine ? <span className="ml-2 text-xs text-green-400/80">(you)</span> : null}
                </span>
                <span className="block text-xs text-gray-500 truncate">
                  {t.owners.map((o) => o.displayName ?? o.email.split('@')[0]).join(' · ')}
                </span>
              </span>
              <span className="text-sm font-semibold tabular-nums">
                {t.wins}-{t.losses}
                {t.ties ? `-${t.ties}` : ''}
              </span>
              <span className="w-20 flex flex-col items-end gap-1">
                <span
                  className="text-xs tabular-nums"
                  style={{
                    color: cap
                      ? t.salary > cap.secondApron
                        ? 'var(--color-pick-loss, #ff453a)'
                        : t.salary > cap.firstApron
                          ? 'var(--color-key, #ffb000)'
                          : 'var(--color-muted-foreground)'
                      : 'var(--color-muted-foreground)',
                  }}
                >
                  ${(t.salary / 1_000_000).toFixed(1)}M
                  {cap && t.salary > cap.secondApron
                    ? ' · 2nd'
                    : cap && t.salary > cap.firstApron
                      ? ' · apron'
                      : ''}
                </span>
                {/* Everyone's cap position on one scale — the mini
                    version of the team page's bar, same colors. */}
                {cap ? (
                  <span className="relative block w-16 h-1.5 rounded-full bg-[var(--color-border)] overflow-hidden">
                    <span
                      className="absolute inset-y-0 left-0"
                      style={{
                        width: `${Math.min(100, (t.salary / cap.hardCap) * 100)}%`,
                        background:
                          t.salary > cap.secondApron
                            ? 'var(--color-pick-loss, #ff453a)'
                            : t.salary > cap.firstApron
                              ? 'var(--color-key, #ffb000)'
                              : 'var(--color-accent)',
                      }}
                    />
                  </span>
                ) : null}
              </span>
            </Link>
          )
        })}
      </div>
    </section>
  )
}

function TeamsSection({
  leagueId,
  isCommissioner,
  myUserId,
}: {
  leagueId: string
  isCommissioner: boolean
  myUserId: string | null
}) {
  const { apiFetch } = useApi()
  const [teams, setTeams] = useState<HomeTeam[] | null>(null)

  useEffect(() => {
    let cancelled = false
    apiFetch<HomeTeam[]>(`/api/leagues/${leagueId}/teams`)
      .then((t) => {
        if (!cancelled) setTeams(t)
      })
      .catch(() => {
        if (!cancelled) setTeams([])
      })
    return () => {
      cancelled = true
    }
  }, [apiFetch, leagueId])

  if (teams == null) return null

  if (teams.length === 0) {
    return (
      <section className="mb-8">
        <h2 className="text-xl font-bold mb-4">Teams</h2>
        <div className="bg-mns-card border border-gray-800 rounded-lg p-8 text-center text-gray-400">
          <div className="text-4xl mb-3">📋</div>
          <p className="font-semibold text-gray-300 mb-1">No teams yet</p>
          <p className="text-sm">
            {isCommissioner
              ? 'Add teams from the commissioner tools to get this league moving.'
              : 'The commissioner is still setting up. Hang tight.'}
          </p>
        </div>
      </section>
    )
  }

  return (
    <section className="mb-8">
      <h2 className="text-xl font-bold mb-4">Teams</h2>
      <ul className="grid gap-2 sm:grid-cols-2">
        {teams.map((t) => {
          const mine = t.owners.some((o) => o.userId != null && o.userId === myUserId)
          return (
            <li key={t.id}>
              <Link
                to={`/league/${leagueId}/team/${t.id}`}
                className={
                  'block bg-mns-card hover:bg-mns-hover border rounded-lg px-4 py-3 transition-colors ' +
                  (mine ? 'border-[var(--color-accent)]' : 'border-gray-800')
                }
              >
                <span className="font-semibold text-[var(--color-foreground)]">
                  {t.name}
                  {mine ? (
                    <span className="ml-2 text-[0.68rem] font-bold uppercase tracking-wider text-[var(--color-accent)]">
                      you
                    </span>
                  ) : null}
                </span>
                <span className="block text-sm text-[var(--color-muted-foreground)] truncate">
                  {t.owners.length
                    ? t.owners
                        .map((o) => o.displayName ?? `${o.email.split('@')[0]} (invited)`)
                        .join(' · ')
                    : 'No owner yet'}
                </span>
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

// One line on the pot — the full picture lives on the Prizes page.
// Renders nothing until the commissioner sets a pot.
function PrizesTeaser({ leagueId }: { leagueId: string }) {
  const { apiFetch } = useApi()
  const [pot, setPot] = useState<{ totalUsd: number; configured: boolean } | null>(null)
  useEffect(() => {
    apiFetch<{ totalUsd: number; configured: boolean }>(`/api/leagues/${leagueId}/prizes`)
      .then(setPot)
      .catch(() => setPot(null))
  }, [apiFetch, leagueId])
  if (!pot?.configured) return null
  return (
    <section className="mb-6">
      <Link
        to={`/league/${leagueId}/prizes`}
        className="flex items-center justify-between bg-mns-card hover:bg-mns-hover border border-gray-800 rounded-lg px-4 py-3 transition-colors"
      >
        <span className="flex items-center gap-2 font-bold">
          <Trophy aria-hidden className="w-5 h-5 text-[var(--color-key,#ffb000)]" /> Prize pool
        </span>
        <span className="tabular-nums font-bold">
          {pot.totalUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}
          <span className="ml-2 text-sm font-normal text-[var(--color-muted-foreground)]">payouts →</span>
        </span>
      </Link>
    </section>
  )
}
