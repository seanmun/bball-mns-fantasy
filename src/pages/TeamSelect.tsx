import { sport } from '../lib/sport/index'
import { Link } from 'react-router-dom'
import { useUser } from '@clerk/clerk-react'
import { useLeague } from '../contexts/LeagueContext'
import { LEAGUE_PHASE_LABELS } from '../types/league'

export function TeamSelect() {
  const { user } = useUser()
  const { userLeagues, loading } = useLeague()

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-4 border-solid border-green-500 border-r-transparent" />
          <div className="mt-4 text-gray-400">Loading your leagues...</div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold">
            {user?.firstName ? `Welcome back, ${user.firstName}` : 'Your Leagues'}
          </h1>
          {userLeagues.length > 0 && (
            <p className="text-gray-400 mt-1">
              You're in {userLeagues.length} league{userLeagues.length === 1 ? '' : 's'}.
            </p>
          )}
        </div>
        <Link
          to="/create-league"
          className="hidden sm:inline-flex items-center gap-2 px-4 py-2 bg-green-500 hover:bg-green-400 text-black font-bold rounded-lg transition-colors"
        >
          + New League
        </Link>
      </div>

      {userLeagues.length === 0 ? (
        <div className="bg-mns-card border border-gray-800 rounded-lg p-10 text-center">
          <div className="text-6xl mb-4">🏀</div>
          <h2 className="text-2xl font-bold mb-2">No leagues yet</h2>
          <p className="text-gray-400 mb-6 max-w-md mx-auto">
            You're not in any {sport.leagueLabel} leagues. Start a new dynasty as commissioner, or wait for a league invite to land in your inbox.
          </p>
          <Link
            to="/create-league"
            className="inline-block px-6 py-3 bg-green-500 hover:bg-green-400 text-black font-bold rounded-lg transition-colors"
          >
            Create a League
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {userLeagues.map((league) => (
            <Link
              key={league.id}
              to={`/league/${league.id}`}
              className="block bg-mns-card hover:bg-mns-hover border border-gray-800 hover:border-green-400/40 rounded-lg p-5 transition-colors"
            >
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <div className="text-lg font-bold text-white">{league.name}</div>
                  <div className="mt-1 flex items-center gap-3 text-sm text-gray-400">
                    <span>{league.sport.toUpperCase()} · {league.seasonYear}</span>
                    <span className="text-gray-600">·</span>
                    <span>{LEAGUE_PHASE_LABELS[league.leaguePhase]}</span>
                    {league.commissionerId === user?.id && (
                      <>
                        <span className="text-gray-600">·</span>
                        <span className="text-green-400">Commissioner</span>
                      </>
                    )}
                  </div>
                </div>
                <div className="text-gray-500">→</div>
              </div>
            </Link>
          ))}

          <Link
            to="/create-league"
            className="sm:hidden inline-flex w-full justify-center items-center gap-2 mt-4 px-4 py-3 bg-green-500 hover:bg-green-400 text-black font-bold rounded-lg transition-colors"
          >
            + New League
          </Link>
        </div>
      )}
    </div>
  )
}
