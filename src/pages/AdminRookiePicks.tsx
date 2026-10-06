import { useState, useEffect, useMemo, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useUser } from '@clerk/clerk-react'
import { toast } from 'sonner'
import { useApi } from '../hooks/useApi'
import { useLeague } from '../contexts/LeagueContext'
import type { League } from '../types/league'
import type { RookieDraftPickRow } from '../types/draft'
import type { Team } from '../types/team'

export function AdminRookiePicks() {
  const { user } = useUser()
  const { currentLeague, loading: leagueLoading } = useLeague()
  const { apiFetch } = useApi()

  const [league, setLeague] = useState<League | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  const [picks, setPicks] = useState<RookieDraftPickRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const leagueId = currentLeague?.id
  const isCommissioner =
    !!user && !!currentLeague && currentLeague.commissionerId === user.id

  useEffect(() => {
    if (!leagueId) return
    let cancelled = false
    const load = async () => {
      try {
        setLoading(true)
        const [l, t, p] = await Promise.all([
          apiFetch<League>(`/api/leagues/${leagueId}`),
          apiFetch<Team[]>(`/api/leagues/${leagueId}/teams`),
          apiFetch<RookieDraftPickRow[]>(`/api/leagues/${leagueId}/rookie-picks`),
        ])
        if (cancelled) return
        setLeague(l)
        setTeams(t)
        setPicks(p)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [leagueId, apiFetch])

  if (leagueLoading || (loading && !league)) return <Centered>Loading…</Centered>

  if (!currentLeague) {
    return (
      <Centered>
        <p className="mb-4">No league selected.</p>
        <Link to="/teams" className="text-green-400 hover:text-green-300">
          ← Pick a league
        </Link>
      </Centered>
    )
  }

  if (!isCommissioner) {
    return (
      <Centered>
        <p className="mb-4">Only the commissioner can manage keepers and rookie picks.</p>
        <Link
          to={`/league/${currentLeague.id}`}
          className="text-green-400 hover:text-green-300"
        >
          ← Back to league
        </Link>
      </Centered>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Rookie picks</h1>
          <p className="text-gray-400 mt-1">{currentLeague.name}</p>
        </div>
        <Link
          to={`/league/${currentLeague.id}`}
          className="text-sm text-gray-400 hover:text-white"
        >
          ← Back to league
        </Link>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-900/30 border border-red-500/30 rounded-lg text-red-300 text-sm">
          {error}
        </div>
      )}

      {league && (
        <KeeperLockCard
          league={league}
          onChange={(updated) => setLeague(updated)}
        />
      )}

      {league && (
        <RookiePickBoard
          league={league}
          teams={teams}
          picks={picks}
          onPicksChange={setPicks}
        />
      )}
    </div>
  )
}

function KeeperLockCard({
  league,
  onChange,
}: {
  league: League
  onChange: (l: League) => void
}) {
  const { apiFetch } = useApi()
  const [saving, setSaving] = useState(false)

  const toggle = async () => {
    setSaving(true)
    try {
      const updated = await apiFetch<League>(`/api/leagues/${league.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ keepersLocked: !league.keepersLocked }),
      })
      onChange(updated)
      toast.success(
        updated.keepersLocked
          ? 'Keepers locked. Owners can no longer change keeper decisions.'
          : 'Keepers unlocked.'
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update keeper lock')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="mb-8">
      <div className="bg-mns-card border border-gray-800 rounded-lg p-5 flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold">Keeper phase</h2>
            {league.keepersLocked ? (
              <span className="px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide bg-green-400/15 text-green-400 border border-green-400/30 rounded-full">
                Locked
              </span>
            ) : (
              <span className="px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide bg-yellow-400/15 text-yellow-400 border border-yellow-400/30 rounded-full">
                Open
              </span>
            )}
          </div>
          <p className="text-sm text-gray-400 mt-1">
            {league.keepersLocked
              ? 'Keeper decisions are frozen. Unlock only if something needs fixing before the draft.'
              : 'Once every owner has submitted keeper decisions, lock the phase to freeze rosters for draft prep.'}
          </p>
        </div>
        <button
          onClick={toggle}
          disabled={saving}
          className={
            league.keepersLocked
              ? 'flex-shrink-0 px-4 py-2 text-sm bg-mns-dark hover:bg-mns-hover border border-gray-700 text-white font-semibold rounded-lg disabled:opacity-50'
              : 'flex-shrink-0 px-4 py-2 text-sm bg-green-500 hover:bg-green-400 text-black font-semibold rounded-lg disabled:opacity-50'
          }
        >
          {saving ? 'Saving…' : league.keepersLocked ? 'Unlock keepers' : 'Lock keepers'}
        </button>
      </div>
    </section>
  )
}

function RookiePickBoard({
  league,
  teams,
  picks,
  onPicksChange,
}: {
  league: League
  teams: Team[]
  picks: RookieDraftPickRow[]
  onPicksChange: (p: RookieDraftPickRow[]) => void
}) {
  const { apiFetch } = useApi()
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [rounds, setRounds] = useState<number>(
    league.config.draft?.rookieRounds ?? 2
  )

  const teamById = useMemo(() => {
    const m = new Map<string, Team>()
    for (const t of teams) m.set(t.id, t)
    return m
  }, [teams])

  const seasonPicks = useMemo(
    () =>
      picks
        .filter((p) => p.seasonYear === league.seasonYear)
        .sort((a, b) => a.overallPick - b.overallPick),
    [picks, league.seasonYear]
  )

  // Order being edited: seeded from round 1 of the existing board,
  // falling back to team creation order.
  const [order, setOrder] = useState<string[]>([])
  useEffect(() => {
    const round1 = seasonPicks.filter((p) => p.round === 1)
    setOrder(
      round1.length > 0 ? round1.map((p) => p.teamId) : teams.map((t) => t.id)
    )
  }, [seasonPicks, teams])

  const anySelected = seasonPicks.some((p) => p.playerId !== null)
  const showBuilder = editing || seasonPicks.length === 0

  const move = useCallback((idx: number, delta: number) => {
    setOrder((prev) => {
      const next = [...prev]
      const target = idx + delta
      if (target < 0 || target >= next.length) return prev
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }, [])

  const generate = async () => {
    setSaving(true)
    try {
      const updated = await apiFetch<RookieDraftPickRow[]>(
        `/api/leagues/${league.id}/rookie-picks`,
        {
          method: 'PUT',
          body: JSON.stringify({
            seasonYear: league.seasonYear,
            rounds,
            teamOrder: order,
          }),
        }
      )
      // Keep picks from other seasons, replace this season's board.
      onPicksChange([
        ...picks.filter((p) => p.seasonYear !== league.seasonYear),
        ...updated,
      ])
      setEditing(false)
      toast.success(
        `Rookie board set: ${rounds} round${rounds === 1 ? '' : 's'} × ${order.length} teams`
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to set rookie picks')
    } finally {
      setSaving(false)
    }
  }

  if (teams.length < 2) {
    return (
      <section>
        <h2 className="text-xl font-bold mb-4">
          Rookie draft board · {league.seasonYear}
        </h2>
        <div className="bg-mns-card border border-gray-800 rounded-lg p-8 text-center text-gray-400">
          <p className="font-semibold text-gray-300 mb-1">Not enough teams yet</p>
          <p className="text-sm mb-4">
            Add at least two teams before setting the rookie draft order.
          </p>
          <Link
            to="../teams"
            className="inline-block px-5 py-2 bg-green-500 hover:bg-green-400 text-black font-bold rounded-lg"
          >
            Manage teams
          </Link>
        </div>
      </section>
    )
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">
          Rookie draft board · {league.seasonYear}
        </h2>
        {!showBuilder && !anySelected && (
          <button
            onClick={() => setEditing(true)}
            className="text-sm text-green-400 hover:text-green-300"
          >
            Edit order
          </button>
        )}
      </div>

      {showBuilder ? (
        <div className="bg-mns-card border border-gray-800 rounded-lg p-5">
          <p className="text-sm text-gray-400 mb-4">
            Set the round 1 order (worst finish picks first, or per your
            league's agreement). The same order repeats each round.
          </p>
          <ol className="mb-5 divide-y divide-gray-800 border border-gray-800 rounded-lg overflow-hidden">
            {order.map((teamId, idx) => {
              const team = teamById.get(teamId)
              return (
                <li
                  key={teamId}
                  className="flex items-center gap-3 px-4 py-2.5 bg-mns-dark"
                >
                  <span className="w-8 text-gray-500 font-bold tabular-nums">
                    {idx + 1}.
                  </span>
                  <span className="flex-1 font-semibold text-white">
                    {team ? `${team.name} (${team.abbrev})` : teamId}
                  </span>
                  <button
                    onClick={() => move(idx, -1)}
                    disabled={idx === 0}
                    aria-label={`Move ${team?.name ?? teamId} up`}
                    className="px-2 py-1 text-gray-400 hover:text-white disabled:opacity-30"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() => move(idx, 1)}
                    disabled={idx === order.length - 1}
                    aria-label={`Move ${team?.name ?? teamId} down`}
                    className="px-2 py-1 text-gray-400 hover:text-white disabled:opacity-30"
                  >
                    ↓
                  </button>
                </li>
              )
            })}
          </ol>
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-300">
              Rounds
              <input
                type="number"
                min={1}
                max={5}
                value={rounds}
                onChange={(e) =>
                  setRounds(Math.max(1, Math.min(5, Number(e.target.value) || 1)))
                }
                className="w-16 px-2 py-1 bg-mns-dark border border-gray-700 rounded text-white text-center"
              />
            </label>
            <button
              onClick={generate}
              disabled={saving}
              className="px-4 py-2 text-sm bg-green-500 hover:bg-green-400 text-black font-semibold rounded-lg disabled:opacity-50"
            >
              {saving
                ? 'Saving…'
                : seasonPicks.length > 0
                  ? 'Regenerate board'
                  : 'Generate board'}
            </button>
            {seasonPicks.length > 0 && (
              <button
                onClick={() => setEditing(false)}
                className="text-sm text-gray-400 hover:text-white"
              >
                Cancel
              </button>
            )}
          </div>
          {seasonPicks.length > 0 && (
            <p className="mt-3 text-xs text-yellow-400/80">
              Regenerating replaces the existing board for {league.seasonYear}.
            </p>
          )}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from(new Set(seasonPicks.map((p) => p.round)))
            .sort((a, b) => a - b)
            .map((round) => (
              <div
                key={round}
                className="bg-mns-card border border-gray-800 rounded-lg overflow-hidden"
              >
                <div className="px-4 py-2 bg-mns-hover text-xs uppercase text-gray-400 font-semibold">
                  Round {round}
                </div>
                <ol className="divide-y divide-gray-800">
                  {seasonPicks
                    .filter((p) => p.round === round)
                    .map((p) => {
                      const team = teamById.get(p.teamId)
                      return (
                        <li
                          key={p.id}
                          className="flex items-center gap-3 px-4 py-2 text-sm"
                        >
                          <span className="w-10 text-gray-500 tabular-nums">
                            {p.round}.{p.pickInRound}
                          </span>
                          <span className="flex-1 font-semibold text-white">
                            {team ? team.abbrev : p.teamId}
                          </span>
                          <span className="text-gray-400">
                            {p.playerName ?? '—'}
                          </span>
                        </li>
                      )
                    })}
                </ol>
              </div>
            ))}
        </div>
      )}
    </section>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="mns-page py-12 text-center text-gray-300">
      {children}
    </div>
  )
}
