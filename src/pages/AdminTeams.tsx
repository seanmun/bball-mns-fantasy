import { sport } from '../lib/sport/index'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import { useUser } from '@clerk/clerk-react'
import { useApi } from '../hooks/useApi'
import { useLeague } from '../contexts/LeagueContext'
import type { Team, TeamOwner } from '../types/team'

interface TeamWithOwners extends Team {
  owners: TeamOwner[]
}

export function AdminTeams() {
  const { user } = useUser()
  const { currentLeague, currentLeagueId, loading: leagueLoading } = useLeague()
  const { apiFetch } = useApi()

  const [teams, setTeams] = useState<TeamWithOwners[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const isCommissioner =
    !!user && !!currentLeague && currentLeague.commissionerId === user.id

  const fetchTeams = useCallback(async () => {
    if (!currentLeagueId) return
    try {
      setLoading(true)
      const data = await apiFetch<TeamWithOwners[]>(
        `/api/leagues/${currentLeagueId}/teams`
      )
      setTeams(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load teams')
    } finally {
      setLoading(false)
    }
  }, [currentLeagueId, apiFetch])

  useEffect(() => {
    void fetchTeams()
  }, [fetchTeams])

  if (leagueLoading) return <Centered>Loading…</Centered>

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
        <p className="mb-4">Only the commissioner can manage teams.</p>
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
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 sm:py-12">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Teams</h1>
          <p className="text-gray-400 mt-1">
            {currentLeague.name} · {teams.length} team
            {teams.length === 1 ? '' : 's'}
          </p>
        </div>
        <Link
          to={`/league/${currentLeague.id}`}
          className="text-sm text-gray-400 hover:text-white"
        >
          ← Back to league
        </Link>
      </div>

      <div className="bg-mns-card border border-gray-800 rounded-lg p-3 mb-6 text-sm text-gray-400">
        Recommended: 4–12 teams. Add them one at a time below, with or without an owner&rsquo;s email. Nothing is sent until you press Send invites; then each owner gets one email and full access once they sign in at <span className="text-gray-300">{sport.appHost}</span>.
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-900/30 border border-red-500/30 rounded-lg text-red-300 text-sm">
          {error}
        </div>
      )}

      <AddTeamForm leagueId={currentLeague.id} onCreated={fetchTeams} />

      <section className="mt-8">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="text-xl font-bold">Teams</h2>
          <InviteButton
            leagueId={currentLeague.id}
            pending={teams.reduce((n, t) => n + t.owners.filter((o) => !o.invitedAt).length, 0)}
            onSent={fetchTeams}
          />
        </div>
        {loading ? (
          <Centered>Loading teams…</Centered>
        ) : teams.length === 0 ? (
          <div className="bg-mns-card border border-gray-800 rounded-lg p-8 text-center text-gray-400">
            No teams yet. Add your first one above.
          </div>
        ) : (
          <div className="space-y-3">
            {teams.map((team) => (
              <div
                key={team.id}
                className="bg-mns-card border border-gray-800 rounded-lg p-5"
              >
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <div>
                    <div className="text-lg font-bold text-white">
                      {team.name}{' '}
                      <span className="text-sm font-mono text-gray-500">
                        ({team.abbrev})
                      </span>
                    </div>
                  </div>
                </div>
                <div className="text-sm text-gray-400">
                  <span className="text-gray-500">Owners:</span>{' '}
                  {team.owners.length === 0
                    ? '—'
                    : team.owners.map((o, i) => (
                        <span key={o.email}>
                          {i > 0 && ', '}
                          {o.displayName ? (
                            <>
                              <span className="text-white">{o.displayName}</span>
                              <span className="text-gray-500"> ({o.email})</span>
                            </>
                          ) : (
                            <span>{o.email}</span>
                          )}
                          <span className="ml-1 text-xs text-gray-500">
                            {o.userId
                              ? '· signed in'
                              : o.invitedAt
                                ? `· invited ${new Date(o.invitedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                                : '· not invited yet'}
                          </span>
                        </span>
                      ))}
                </div>
                <AddOwner leagueId={currentLeague.id} teamId={team.id} onAdded={fetchTeams} />
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="mns-page py-12 text-center text-gray-300">
      {children}
    </div>
  )
}

function AddTeamForm({
  leagueId,
  onCreated,
}: {
  leagueId: string
  onCreated: () => void
}) {
  const { apiFetch } = useApi()
  const [name, setName] = useState('')
  const [abbrev, setAbbrev] = useState('')
  const [emails, setEmails] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const ownerEmails = emails
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (!name.trim() || !abbrev.trim()) return

    setSubmitting(true)
    setErr(null)
    try {
      await apiFetch(`/api/leagues/${leagueId}/teams`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          abbrev: abbrev.trim().toUpperCase(),
          ownerEmails,
        }),
      })
      setName('')
      setAbbrev('')
      setEmails('')
      onCreated()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add team')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-mns-card border border-gray-800 rounded-lg p-5 space-y-4"
    >
      <h2 className="text-lg font-bold">Add Team</h2>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="sm:col-span-2">
          <label className="block text-xs font-semibold text-gray-400 mb-1">
            Team Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Twinjas"
            maxLength={50}
            required
            className="w-full px-3 py-2 bg-mns-dark border border-gray-700 rounded text-white placeholder-gray-500 focus:border-green-400 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-400 mb-1">
            Abbrev (1-6)
          </label>
          <input
            type="text"
            value={abbrev}
            onChange={(e) => setAbbrev(e.target.value.toUpperCase())}
            placeholder="TWJ"
            maxLength={6}
            required
            className="w-full px-3 py-2 bg-mns-dark border border-gray-700 rounded text-white uppercase font-mono placeholder-gray-500 focus:border-green-400 focus:outline-none"
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-semibold text-gray-400 mb-1">
          Owner emails — optional, comma or newline separated, first is primary
        </label>
        <textarea
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
          placeholder="Leave empty to add owners later"
          rows={2}
          className="w-full px-3 py-2 bg-mns-dark border border-gray-700 rounded text-white placeholder-gray-500 focus:border-green-400 focus:outline-none"
        />
        <p className="mt-1 text-xs text-gray-500">
          No email goes out when you add a team. Send invites when the league is ready.
        </p>
      </div>

      {err && (
        <div className="p-3 bg-red-900/30 border border-red-500/30 rounded text-red-300 text-sm">
          {err}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className="px-5 py-2 bg-green-500 hover:bg-green-400 disabled:bg-gray-700 disabled:text-gray-500 disabled:cursor-not-allowed text-black font-bold rounded transition-colors"
      >
        {submitting ? 'Adding…' : 'Add Team'}
      </button>
    </form>
  )
}

// One button for the whole league: everyone added since the last
// send gets their email, nobody gets it twice.
function InviteButton({ leagueId, pending, onSent }: { leagueId: string; pending: number; onSent: () => void }) {
  const { apiFetch } = useApi()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  if (pending === 0) return <span className="text-xs text-gray-500">Everyone with an email has been invited.</span>
  const send = async () => {
    setBusy(true)
    try {
      const r = await apiFetch<{ sent: number; failed: number }>(`/api/leagues/${leagueId}/teams`, {
        method: 'POST',
        body: JSON.stringify({ action: 'invite' }),
      })
      toast.success(r.failed ? `Sent ${r.sent}, ${r.failed} failed.` : `Sent ${r.sent} invite${r.sent === 1 ? '' : 's'}.`)
      setConfirm(false)
      onSent()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Send failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={() => (confirm ? send() : setConfirm(true))}
        disabled={busy}
        className={
          'px-3 py-1.5 min-h-[2.5rem] text-sm font-semibold rounded transition-colors ' +
          (confirm ? 'bg-red-500 hover:bg-red-400 text-black' : 'bg-green-500 hover:bg-green-400 text-black')
        }
      >
        {busy ? 'Sending…' : confirm ? `Yes — email ${pending} owner${pending === 1 ? '' : 's'}` : `Send invites (${pending})`}
      </button>
      {confirm ? (
        <button type="button" onClick={() => setConfirm(false)} className="text-sm text-gray-400 hover:text-white">
          Not yet
        </button>
      ) : null}
    </span>
  )
}

// Add an owner to a team that was created without one — or a
// co-owner — without sending anything.
function AddOwner({ leagueId, teamId, onAdded }: { leagueId: string; teamId: string; onAdded: () => void }) {
  const { apiFetch } = useApi()
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true)
    try {
      await apiFetch(`/api/leagues/${leagueId}/teams`, {
        method: 'PATCH',
        body: JSON.stringify({ teamId, addOwnerEmail: email.trim() }),
      })
      setEmail('')
      onAdded()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add that owner')
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="mt-2 flex gap-2">
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Add an owner's email"
        aria-label="Add an owner's email"
        className="flex-1 min-w-0 px-3 py-1.5 min-h-[2.5rem] bg-mns-dark border border-gray-700 rounded text-sm text-white placeholder-gray-500 focus:border-green-400 focus:outline-none"
      />
      <button
        type="submit"
        disabled={busy || !email.trim()}
        className="px-3 py-1.5 min-h-[2.5rem] text-sm font-semibold rounded bg-mns-dark border border-gray-700 text-gray-300 hover:text-white disabled:opacity-50"
      >
        {busy ? 'Adding…' : 'Add'}
      </button>
    </form>
  )
}
