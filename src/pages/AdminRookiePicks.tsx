import { useState, useEffect, useMemo, useCallback } from 'react'
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
            {currentLeague.name} · the first step of the season. A rookie is priced by her slot
            here; everyone else by last year's round.
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
          players={players}
          onPicksChange={setPicks}
          onPlayersChange={setPlayers}
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
  const [editing, setEditing] = useState(false)
  // Recording: a draft that already happened is written down pick by
  // pick, in any order, until the season starts. Live picks happen on
  // the members' draft page; this board shows them the same way.
  const canRecord = !league.seasonStartedAt
  const [openPick, setOpenPick] = useState<string | null>(null)

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

  // One order per round, being edited: seeded from the existing board
  // (the slot's original owner, before trades), else team creation
  // order. Round 1 is often a lottery and round 2 the standings, so
  // they are separate lists; new rounds start as a copy of round 1.
  const [orders, setOrders] = useState<string[][]>([])
  useEffect(() => {
    const byRound = new Map<number, string[]>()
    for (const p of seasonPicks) {
      const list = byRound.get(p.round) ?? []
      list[p.pickInRound - 1] = p.originalTeamId ?? p.teamId
      byRound.set(p.round, list)
    }
    const base = byRound.get(1) ?? teams.map((t) => t.id)
    setOrders(
      Array.from({ length: Math.max(1, byRound.size) }, (_, i) => byRound.get(i + 1) ?? [...base])
    )
  }, [seasonPicks, teams])
  // The round count changes: keep what's been ordered, add rounds as
  // copies of round 1, drop extras.
  useEffect(() => {
    setOrders((prev) =>
      Array.from({ length: rounds }, (_, i) => prev[i] ?? [...(prev[0] ?? teams.map((t) => t.id))])
    )
  }, [rounds, teams])

  const anySelected = seasonPicks.some((p) => p.playerId !== null)
  const showBuilder = editing || seasonPicks.length === 0

  const move = useCallback((round: number, idx: number, delta: number) => {
    setOrders((prev) => {
      const list = [...(prev[round] ?? [])]
      const target = idx + delta
      if (target < 0 || target >= list.length) return prev
      ;[list[idx], list[target]] = [list[target], list[idx]]
      const next = [...prev]
      next[round] = list
      return next
    })
  }, [])

  const assign = async (pick: RookieDraftPickRow, teamId: string) => {
    if (teamId === pick.teamId) return
    setSaving(true)
    try {
      const r = await apiFetch<{ team: string; moved: string | null }>(
        `/api/leagues/${league.id}/rookie-picks`,
        { method: 'POST', body: JSON.stringify({ action: 'assign', pickId: pick.id, teamId }) }
      )
      onPicksChange(picks.map((p) => (p.id === pick.id ? { ...p, teamId } : p)))
      if (pick.playerId) {
        onPlayersChange(players.map((pl) => (pl.id === pick.playerId ? { ...pl, teamId } : pl)))
      }
      toast.success(
        `${pick.round}.${pick.pickInRound} now ${r.team}${r.moved ? ` · ${r.moved} moved too` : ''}`
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not move that pick')
    } finally {
      setSaving(false)
    }
  }

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
            teamOrder: orders[0] ?? [],
            teamOrders: orders,
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
        `Rookie board set: ${rounds} round${rounds === 1 ? '' : 's'} × ${orders[0]?.length ?? 0} teams`
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
          Board · {sport.rookieClassYear(league.seasonYear)} class
        </h2>
        {!showBuilder && !anySelected && (
          <button
            onClick={() => setEditing(true)}
            className="text-sm text-green-400 hover:text-green-300"
          >
            Edit order
          </button>
        )}
        {!showBuilder && anySelected && canRecord && (
          <span className="text-xs text-gray-500">Clear every pick to change the order.</span>
        )}
      </div>
      {!showBuilder && canRecord && (
        <p className="text-sm text-gray-400 mb-4">
          Write each pick down: type a name, tap the player. Any order. A traded pick: change
          the team on it, and the slot shows who it came from. A pick can be changed or cleared
          until the season starts, and a player already on another team moves to the team
          that picked him.
        </p>
      )}

      {showBuilder ? (
        <div className="bg-mns-card border border-gray-800 rounded-lg p-5">
          <p className="text-sm text-gray-400 mb-4">
            Set each round's order as the slots were BEFORE any trades (a
            lottery, worst finish first, or per your league's agreement).
            Traded picks change hands on the board afterwards, pick by pick.
          </p>
          {orders.map((order, round) => (
            <div key={round} className="mb-5">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
                  Round {round + 1} order
                </h3>
                {round > 0 && (
                  <button
                    onClick={() =>
                      setOrders((prev) => {
                        const next = [...prev]
                        next[round] = [...prev[0]]
                        return next
                      })
                    }
                    className="text-xs text-green-400 hover:text-green-300"
                  >
                    Same as round 1
                  </button>
                )}
              </div>
              <ol className="divide-y divide-gray-800 border border-gray-800 rounded-lg overflow-hidden">
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
                        onClick={() => move(round, idx, -1)}
                        disabled={idx === 0}
                        aria-label={`Move ${team?.name ?? teamId} up in round ${round + 1}`}
                        className="px-2 py-1 min-h-[2.5rem] text-gray-400 hover:text-white disabled:opacity-30"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => move(round, idx, 1)}
                        disabled={idx === order.length - 1}
                        aria-label={`Move ${team?.name ?? teamId} down in round ${round + 1}`}
                        className="px-2 py-1 min-h-[2.5rem] text-gray-400 hover:text-white disabled:opacity-30"
                      >
                        ↓
                      </button>
                    </li>
                  )
                })}
              </ol>
            </div>
          ))}
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
                              onChange={(e) => assign(p, e.target.value)}
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
                          {p.originalTeamId && p.originalTeamId !== p.teamId && (
                            <span className="text-xs text-gray-500">
                              from {teamById.get(p.originalTeamId)?.abbrev ?? '?'}
                            </span>
                          )}
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
      )}
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
