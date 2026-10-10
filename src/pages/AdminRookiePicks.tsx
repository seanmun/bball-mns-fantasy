import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { useUser } from '@clerk/clerk-react'
import { toast } from 'sonner'
import { useApi } from '../hooks/useApi'
import { useLeague } from '../contexts/LeagueContext'
import type { League } from '../types/league'
import type { RookieDraftPickRow } from '../types/draft'
import type { Team } from '../types/team'
import type { Player } from '../types/player'
import { sport } from '../lib/sport'

export function AdminRookiePicks() {
  const { user } = useUser()
  const { currentLeague, loading: leagueLoading } = useLeague()
  const { apiFetch } = useApi()

  const [league, setLeague] = useState<League | null>(null)
  const [teams, setTeams] = useState<Team[]>([])
  const [picks, setPicks] = useState<RookieDraftPickRow[]>([])
  const [players, setPlayers] = useState<Player[]>([])
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
        const [l, t, p, pl] = await Promise.all([
          apiFetch<League>(`/api/leagues/${leagueId}`),
          apiFetch<Team[]>(`/api/leagues/${leagueId}/teams`),
          apiFetch<RookieDraftPickRow[]>(`/api/leagues/${leagueId}/rookie-picks`),
          apiFetch<Player[]>(`/api/leagues/${leagueId}/players`),
        ])
        if (cancelled) return
        setLeague(l)
        setTeams(t)
        setPicks(p)
        setPlayers(pl)
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
          <h1 className="text-3xl font-bold">
            {sport.rookieClassYear(league?.seasonYear ?? currentLeague.seasonYear)} rookie draft
          </h1>
          <p className="text-gray-400 mt-1">
            {currentLeague.name} · who picked whom. A rookie's keeper price comes from this slot.
          </p>
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
        <RookiePickBoard
          league={league}
          teams={teams}
          picks={picks}
          players={players}
          onPicksChange={setPicks}
          onPlayersChange={setPlayers}
        />
      )}
    </div>
  )
}

function RookiePickBoard({
  league,
  teams,
  picks,
  players,
  onPicksChange,
  onPlayersChange,
}: {
  league: League
  teams: Team[]
  picks: RookieDraftPickRow[]
  players: Player[]
  onPicksChange: (p: RookieDraftPickRow[]) => void
  onPlayersChange: (p: Player[]) => void
}) {
  const { apiFetch } = useApi()
  const [saving, setSaving] = useState(false)
  // Until the season starts the commissioner writes the draft down here:
  // who holds each pick, who was taken, where a traded pick came from.
  // Live picks happen on the members' draft page and show here the same.
  const canRecord = !league.seasonStartedAt
  const [openPick, setOpenPick] = useState<string | null>(null)
  const [fromOpen, setFromOpen] = useState<string | null>(null)
  const [roundCount, setRoundCount] = useState<number>(
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
  const anySelected = seasonPicks.some((p) => p.playerId !== null)

  // The board exists the moment the page opens: one slot per team per
  // round, teams in the order they were added. Whose pick each slot is
  // gets set on the slot itself — that IS the order.
  const build = useCallback(
    async (rounds: number) => {
      const updated = await apiFetch<RookieDraftPickRow[]>(
        `/api/leagues/${league.id}/rookie-picks`,
        {
          method: 'PUT',
          body: JSON.stringify({
            seasonYear: league.seasonYear,
            rounds,
            teamOrder: teams.map((t) => t.id),
          }),
        }
      )
      onPicksChange([...picks.filter((p) => p.seasonYear !== league.seasonYear), ...updated])
    },
    [apiFetch, league.id, league.seasonYear, teams, picks, onPicksChange]
  )
  const building = useRef(false)
  useEffect(() => {
    if (!canRecord || teams.length < 2 || seasonPicks.length > 0 || building.current) return
    building.current = true
    build(roundCount)
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Could not set up the board'))
      .finally(() => {
        building.current = false
      })
  }, [canRecord, teams.length, seasonPicks.length, build, roundCount])

  const applyRounds = async () => {
    setSaving(true)
    try {
      await build(roundCount)
      toast.success(`${roundCount} round${roundCount === 1 ? '' : 's'} × ${teams.length} teams`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change the rounds')
    } finally {
      setSaving(false)
    }
  }

  const assign = async (
    pick: RookieDraftPickRow,
    change: { teamId?: string; originalTeamId?: string | null }
  ) => {
    setSaving(true)
    try {
      const r = await apiFetch<{ team: string | null; moved: string | null }>(
        `/api/leagues/${league.id}/rookie-picks`,
        { method: 'POST', body: JSON.stringify({ action: 'assign', pickId: pick.id, ...change }) }
      )
      onPicksChange(picks.map((p) => (p.id === pick.id ? { ...p, ...change } : p)))
      if (change.teamId && pick.playerId) {
        const teamId = change.teamId
        onPlayersChange(players.map((pl) => (pl.id === pick.playerId ? { ...pl, teamId } : pl)))
      }
      if (change.teamId) {
        toast.success(
          `${pick.round}.${pick.pickInRound} now ${r.team}${r.moved ? ` · ${r.moved} moved too` : ''}`
        )
      }
      setFromOpen(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not change that pick')
    } finally {
      setSaving(false)
    }
  }

  const record = async (pick: RookieDraftPickRow, player: Player) => {
    setSaving(true)
    try {
      const r = await apiFetch<{ slot: string; movedFrom: string | null }>(
        `/api/leagues/${league.id}/rookie-picks`,
        { method: 'POST', body: JSON.stringify({ action: 'record', pickId: pick.id, playerId: player.id }) }
      )
      onPicksChange(
        picks.map((p) => {
          if (p.id === pick.id) return { ...p, playerId: player.id, playerName: player.name }
          // The same player recorded elsewhere on this board leaves that pick.
          if (p.seasonYear === pick.seasonYear && p.playerId === player.id)
            return { ...p, playerId: null, playerName: null }
          return p
        })
      )
      onPlayersChange(
        players.map((pl) => (pl.id === player.id ? { ...pl, teamId: pick.teamId } : pl))
      )
      setOpenPick(null)
      toast.success(
        `${player.name} · ${r.slot}${r.movedFrom ? ` — moved from ${r.movedFrom}` : ''}`
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not record that pick')
    } finally {
      setSaving(false)
    }
  }

  const clear = async (pick: RookieDraftPickRow) => {
    setSaving(true)
    try {
      await apiFetch(`/api/leagues/${league.id}/rookie-picks`, {
        method: 'POST',
        body: JSON.stringify({ action: 'clear', pickId: pick.id }),
      })
      onPicksChange(
        picks.map((p) => (p.id === pick.id ? { ...p, playerId: null, playerName: null } : p))
      )
      toast.success(`${pick.round}.${pick.pickInRound} cleared`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not clear that pick')
    } finally {
      setSaving(false)
    }
  }

  if (teams.length < 2) {
    return (
      <section>
        <div className="bg-mns-card border border-gray-800 rounded-lg p-8 text-center text-gray-400">
          <p className="font-semibold text-gray-300 mb-1">Not enough teams yet</p>
          <p className="text-sm mb-4">Add at least two teams and the board builds itself.</p>
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

  if (seasonPicks.length === 0) {
    return (
      <section>
        <div className="bg-mns-card border border-gray-800 rounded-lg p-8 text-center text-gray-400">
          {canRecord ? 'Setting up the board…' : 'No rookie draft was recorded for this season.'}
        </div>
      </section>
    )
  }

  return (
    <section>
      <div className="flex flex-wrap items-center justify-end gap-3 mb-3">
        {canRecord && !anySelected && (
          <label className="flex items-center gap-2 text-sm text-gray-300">
            Rounds
            <input
              type="number"
              min={1}
              max={5}
              value={roundCount}
              onChange={(e) =>
                setRoundCount(Math.max(1, Math.min(5, Number(e.target.value) || 1)))
              }
              className="w-16 px-2 py-1 min-h-[2.5rem] bg-mns-dark border border-gray-700 rounded text-white text-center"
            />
            <button
              onClick={applyRounds}
              disabled={saving || roundCount === Math.max(...seasonPicks.map((p) => p.round))}
              className="px-3 py-1 min-h-[2.5rem] text-sm bg-mns-dark hover:bg-mns-hover border border-gray-700 text-white rounded disabled:opacity-40"
            >
              Apply
            </button>
          </label>
        )}
      </div>
      {canRecord && (
        <p className="text-sm text-gray-400 mb-4">
          Pick the team, type the name, tap the player. Everything saves as you go.
        </p>
      )}
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
                    const from = p.originalTeamId ? teamById.get(p.originalTeamId) : null
                    const searching = canRecord && (openPick === p.id || !p.playerId)
                    return (
                      <li
                        key={p.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm"
                      >
                        <span className="w-10 text-gray-500 tabular-nums">
                          {p.round}.{p.pickInRound}
                        </span>
                        {canRecord ? (
                          <select
                            value={p.teamId}
                            onChange={(e) => assign(p, { teamId: e.target.value })}
                            disabled={saving}
                            aria-label={`Team holding pick ${p.round}.${p.pickInRound}`}
                            className="w-24 min-h-[2.5rem] px-1 text-sm font-semibold bg-mns-dark border border-gray-700 rounded text-white"
                          >
                            {teams.map((t) => (
                              <option key={t.id} value={t.id}>
                                {t.abbrev}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="w-16 font-semibold text-white truncate">
                            {team ? team.abbrev : p.teamId}
                          </span>
                        )}
                        {canRecord && fromOpen === p.id ? (
                          <select
                            value={p.originalTeamId ?? ''}
                            onChange={(e) =>
                              assign(p, { originalTeamId: e.target.value === '' ? null : e.target.value })
                            }
                            disabled={saving}
                            aria-label={`Pick ${p.round}.${p.pickInRound} came from`}
                            className="min-h-[2.5rem] px-1 text-xs bg-mns-dark border border-gray-700 rounded text-gray-300"
                          >
                            <option value="">not traded</option>
                            {teams
                              .filter((t) => t.id !== p.teamId)
                              .map((t) => (
                                <option key={t.id} value={t.id}>
                                  from {t.abbrev}
                                </option>
                              ))}
                          </select>
                        ) : from && from.id !== p.teamId ? (
                          <button
                            onClick={canRecord ? () => setFromOpen(p.id) : undefined}
                            className="text-xs text-gray-500 min-h-[2.5rem]"
                          >
                            from {from.abbrev}
                          </button>
                        ) : canRecord ? (
                          <button
                            onClick={() => setFromOpen(p.id)}
                            className="text-xs text-gray-600 hover:text-gray-400 min-h-[2.5rem]"
                          >
                            traded?
                          </button>
                        ) : null}
                        {searching ? (
                          <PickSearch
                            pick={p}
                            players={players}
                            teamById={teamById}
                            disabled={saving}
                            onPick={(player) => record(p, player)}
                            onCancel={p.playerId ? () => setOpenPick(null) : undefined}
                          />
                        ) : (
                          <>
                            <span className="flex-1 text-gray-200 truncate">
                              {p.playerName ?? '—'}
                            </span>
                            {canRecord && p.playerId && (
                              <span className="flex items-center gap-2">
                                <button
                                  onClick={() => setOpenPick(p.id)}
                                  disabled={saving}
                                  className="text-xs text-green-400 hover:text-green-300 min-h-[2.5rem] px-1"
                                >
                                  Change
                                </button>
                                <button
                                  onClick={() => clear(p)}
                                  disabled={saving}
                                  aria-label={`Clear pick ${p.round}.${p.pickInRound}`}
                                  className="text-xs text-gray-400 hover:text-white min-h-[2.5rem] px-1"
                                >
                                  Clear
                                </button>
                              </span>
                            )}
                          </>
                        )}
                      </li>
                    )
                  })}
              </ol>
            </div>
          ))}
      </div>
    </section>
  )
}


// One pick's search: type a name, tap the player. Rookies and free
// agents rank first; a player on a team shows whose, since recording
// moves him.
function PickSearch({
  pick,
  players,
  teamById,
  disabled,
  onPick,
  onCancel,
}: {
  pick: RookieDraftPickRow
  players: Player[]
  teamById: Map<string, Team>
  disabled: boolean
  onPick: (p: Player) => void
  onCancel?: () => void
}) {
  const [q, setQ] = useState('')
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (needle.length < 2) return []
    const rank = (p: Player) => {
      const n = p.name.toLowerCase()
      if (n.startsWith(needle)) return 0
      if (n.split(' ').some((w) => w.startsWith(needle))) return 1
      return n.includes(needle) ? 2 : 9
    }
    return players
      .filter((p) => rank(p) < 9)
      .sort(
        (x, y) =>
          rank(x) - rank(y) ||
          Number(!!x.teamId) - Number(!!y.teamId) ||
          Number(!x.isRookie) - Number(!y.isRookie) ||
          x.name.localeCompare(y.name)
      )
      .slice(0, 8)
  }, [q, players])

  return (
    <>
      <span className="flex-1 min-w-[12rem] flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={pick.playerName ? `Replace ${pick.playerName}` : 'Type a name'}
          aria-label={`Player for pick ${pick.round}.${pick.pickInRound}`}
          disabled={disabled}
          className="flex-1 min-h-[2.5rem] px-3 py-1 text-sm bg-mns-dark border border-gray-700 rounded text-white placeholder:text-gray-500"
        />
        {onCancel && (
          <button
            onClick={onCancel}
            className="text-xs text-gray-400 hover:text-white min-h-[2.5rem] px-1"
          >
            Cancel
          </button>
        )}
      </span>
      {matches.length > 0 && (
        <ul className="basis-full mt-1 bg-mns-dark border border-gray-700 rounded-lg overflow-hidden">
          {matches.map((m) => {
            const on = m.teamId ? teamById.get(m.teamId) : null
            return (
              <li key={m.id}>
                <button
                  onClick={() => onPick(m)}
                  disabled={disabled}
                  className="w-full text-left px-3 py-2 min-h-[2.5rem] hover:bg-mns-hover flex items-center gap-2"
                >
                  <span className="flex-1 font-semibold text-white truncate">{m.name}</span>
                  <span className="text-xs text-gray-400 tabular-nums">
                    {[m.position, m.teamCode, on ? on.abbrev : 'FA'].filter(Boolean).join(' · ')}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="mns-page py-12 text-center text-gray-300">
      {children}
    </div>
  )
}
