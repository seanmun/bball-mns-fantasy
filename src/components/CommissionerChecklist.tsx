import { sport } from '../lib/sport/index'
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useApi } from '../hooks/useApi'
import { type League } from '../types/league'
import type { LeagueSetup } from '../types/leagueConfig'

interface SetupStatus {
  teamsCount: number
  teamsWithOwners: number
  settingsSaved: boolean
  playersPoolCount: number
  playersAssignedCount: number
  playersUnpricedCount: number
  rookiePicksTotal: number
  rookiePicksMade: number
  keepersDeclaredTeams: number
  keepersLocked: boolean
  draftStatus: string | null
  seasonStarted: boolean
}

const SCENARIOS: Array<{
  label: string
  description: string
  setup: LeagueSetup
}> = [
  {
    label: 'Brand new league',
    description:
      'Fresh start — empty rosters, everyone enters the draft pool. Draft now or schedule it later.',
    setup: { entryPhase: 'draft', rosterSource: 'fresh' },
  },
  {
    label: 'Importing — before the rookie draft',
    description:
      'Bring in prior-year rosters and keeper rounds, then run the full cycle: keepers, rookie draft, veteran draft.',
    setup: { entryPhase: 'rookie_draft', rosterSource: 'import' },
  },
  {
    label: 'Importing — rookie draft already happened',
    description:
      'Rosters include drafted rookies. Record rookie results, run keepers and the veteran draft in-app.',
    setup: { entryPhase: 'keeper_season', rosterSource: 'import' },
  },
  {
    label: 'Importing — mid-season',
    description:
      'Rosters are final (including IR/redshirts). Skip all draft steps and go straight to the regular season.',
    setup: { entryPhase: 'regular_season', rosterSource: 'import' },
  },
]

export function CommissionerChecklist({
  league,
  onSeasonStarted,
}: {
  league: League
  onSeasonStarted: () => void
}) {
  const { apiFetch } = useApi()
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [setup, setSetup] = useState<LeagueSetup | null>(
    league.config.setup ?? null
  )
  // A wrong first pick is not a dead end: the starting point can be
  // changed until the season starts, and the steps simply re-read it.
  const [changing, setChanging] = useState(false)

  const leagueId = league.id

  const refresh = useCallback(async () => {
    try {
      const s = await apiFetch<SetupStatus>(`/api/leagues/${leagueId}/setup-status`)
      setStatus(s)
    } catch {
      // silent — leave status null, steps stay grey
    }
  }, [apiFetch, leagueId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (!setup || changing) {
    return (
      <ScenarioSelector
        league={league}
        current={setup}
        onSaved={(s) => {
          setSetup(s)
          setChanging(false)
        }}
        onCancel={setup ? () => setChanging(false) : undefined}
      />
    )
  }

  // Which stages this league passes through, in the order the season
  // runs: teams → settings → rosters → rookie draft → keepers → veteran
  // draft → start. A stage a scenario skips is simply not shown.
  const keeperLeague = (league.config.roster?.maxKeepers ?? 0) > 0
  const showRosters = setup.rosterSource === 'import'
  const showRookie =
    (setup.entryPhase === 'rookie_draft' || setup.entryPhase === 'keeper_season') &&
    league.config.draft?.rookieDraftEnabled !== false
  const showKeepers =
    (setup.entryPhase === 'rookie_draft' || setup.entryPhase === 'keeper_season') && keeperLeague
  const showDraft = setup.entryPhase !== 'regular_season'
  const seasonStarted = !!status?.seasonStarted

  const teams = status?.teamsCount ?? 0
  const owners = status?.teamsWithOwners ?? 0
  const assigned = status?.playersAssignedCount ?? 0
  const unpriced = status?.playersUnpricedCount ?? 0
  const picksTotal = status?.rookiePicksTotal ?? 0
  const picksMade = status?.rookiePicksMade ?? 0
  const declared = status?.keepersDeclaredTeams ?? 0
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`

  let n = 0
  const num = () => ++n

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Commissioner setup</h2>
        <Link to={`/league/${leagueId}/lm`} className="text-sm text-green-400 hover:text-green-300">
          Commissioner tools →
        </Link>
      </div>
      <div className="bg-mns-card border border-gray-800 rounded-lg divide-y divide-gray-800">
        <StaticStep
          n={num()}
          done={teams >= 2 && owners === teams}
          title="Teams"
          description={
            teams === 0
              ? 'Add the teams. Owner emails can wait; invites go out when you send them.'
              : `${plural(teams, 'team')} · ${owners} of ${teams} with an owner.`
          }
          cta={teams === 0 ? 'Add teams' : 'Teams'}
          href={`/league/${leagueId}/lm/teams`}
        />
        <StaticStep
          n={num()}
          done={!!status?.settingsSaved}
          title="Settings"
          description={
            status?.settingsSaved
              ? 'Cap, fees, schedule and scoring decided. Change them any time before the season.'
              : `Decide the cap ladder, fees, schedule and scoring, or keep the ${sport.leagueLabel} preset and save.`
          }
          cta="Settings"
          href={`/league/${leagueId}/lm/league`}
        />
        {showRosters && (
          <StaticStep
            n={num()}
            done={assigned > 0 && (!keeperLeague || unpriced === 0)}
            title="Rosters"
            description={
              assigned === 0
                ? 'Pick a team, search a player, place them. Last year\'s round goes in the Rd box.'
                : keeperLeague
                  ? `${plural(assigned, 'player')} placed · ${
                      unpriced === 0 ? 'every one priced.' : `${unpriced} without a round.`
                    }`
                  : `${plural(assigned, 'player')} placed.`
            }
            cta="Rosters"
            href={`/league/${leagueId}/lm/rosters`}
          />
        )}
        {showRookie && (
          <StaticStep
            n={num()}
            done={picksTotal > 0 && picksMade === picksTotal}
            title="Rookie draft"
            description={
              picksTotal === 0
                ? setup.entryPhase === 'keeper_season'
                  ? 'Write down who picked whom. Each rookie is priced by that slot.'
                  : 'Run the rookie draft here. Each rookie is priced by their slot.'
                : `${picksMade} of ${picksTotal} picks ${
                    setup.entryPhase === 'keeper_season' ? 'recorded' : 'made'
                  }.`
            }
            cta="Rookie draft"
            href={`/league/${leagueId}/lm/rookie-picks`}
          />
        )}
        {showKeepers && (
          <StaticStep
            n={num()}
            done={!!status?.keepersLocked}
            title="Keepers"
            description={
              status?.keepersLocked
                ? 'Locked. Keepers stay; everyone else is back in the pool.'
                : `${declared} of ${teams} teams submitted. Lock when all are in.`
            }
            cta="Keepers"
            href={`/league/${leagueId}/keepers`}
          />
        )}
        {showDraft && (
          <StaticStep
            n={num()}
            done={!!status?.draftStatus && status.draftStatus !== 'setup'}
            title="Veteran draft"
            description={
              !status?.draftStatus
                ? 'Create the draft room, then start it when everyone is in.'
                : status.draftStatus === 'setup'
                  ? 'Room created. Start it when everyone is in.'
                  : status.draftStatus === 'completed'
                    ? 'Drafted.'
                    : 'Drafting now.'
            }
            cta="Draft setup"
            href={`/league/${leagueId}/lm/draft-setup`}
          />
        )}
        <StartSeasonStep
          leagueId={leagueId}
          n={num()}
          done={seasonStarted}
          onStarted={() => {
            void refresh()
            onSeasonStarted()
          }}
        />
      </div>
      {!seasonStarted ? (
        <button
          onClick={() => setChanging(true)}
          className="mt-3 text-xs text-gray-500 hover:text-gray-300"
        >
          Change starting point
        </button>
      ) : null}
    </section>
  )
}

function ScenarioSelector({
  league,
  current,
  onSaved,
  onCancel,
}: {
  league: League
  current: LeagueSetup | null
  onSaved: (s: LeagueSetup) => void
  onCancel?: () => void
}) {
  const { apiFetch } = useApi()
  const [saving, setSaving] = useState<string | null>(null)

  const choose = async (scenario: (typeof SCENARIOS)[number]) => {
    setSaving(scenario.label)
    try {
      await apiFetch(`/api/leagues/${league.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          config: {
            ...league.config,
            setup: { ...scenario.setup, settingsSaved: current?.settingsSaved },
          },
        }),
      })
      onSaved({ ...scenario.setup, settingsSaved: current?.settingsSaved })
      toast.success(`Starting point set: ${scenario.label}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(null)
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-xl font-bold mb-1">Where is this league starting?</h2>
      <p className="text-sm text-gray-400 mb-4">
        This decides which setup steps apply. You can change it any time before the season starts.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {SCENARIOS.map((s) => {
          const isCurrent =
            !!current && current.entryPhase === s.setup.entryPhase && current.rosterSource === s.setup.rosterSource
          return (
            <button
              key={s.label}
              onClick={() => choose(s)}
              disabled={saving !== null}
              aria-pressed={isCurrent}
              className={
                'text-left bg-mns-card border rounded-lg p-4 disabled:opacity-50 transition-colors ' +
                (isCurrent ? 'border-green-400' : 'border-gray-800 hover:border-green-400/50')
              }
            >
              <div className="font-semibold text-white mb-1">
                {saving === s.label ? 'Saving…' : s.label}
                {isCurrent ? <span className="ml-2 text-xs text-green-400">current</span> : null}
              </div>
              <p className="text-sm text-gray-400">{s.description}</p>
            </button>
          )
        })}
      </div>
      {onCancel ? (
        <button onClick={onCancel} className="mt-3 text-sm text-gray-400 hover:text-white">
          Keep the current starting point
        </button>
      ) : null}
    </section>
  )
}

function StartSeasonStep({
  leagueId,
  n,
  done,
  onStarted,
}: {
  leagueId: string
  n: number
  done: boolean
  onStarted: () => void
}) {
  const { apiFetch } = useApi()
  const [running, setRunning] = useState(false)

  const start = async () => {
    if (!window.confirm('Start the regular season? This moves the league out of setup.')) {
      return
    }
    setRunning(true)
    try {
      await apiFetch(`/api/leagues/${leagueId}/start-season`, { method: 'POST' })
      toast.success('Season started. Welcome to the regular season.')
      onStarted()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to start season')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="p-5 flex items-start gap-4">
      <StepNumber n={n} done={done} />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-white">Start the season</div>
        <p className="text-sm text-gray-400 mt-1">
          {done
            ? 'The regular season is live.'
            : 'When the steps above are handled, flip the league into the regular season.'}
        </p>
      </div>
      {!done && (
        <button
          onClick={start}
          disabled={running}
          className="flex-shrink-0 px-3 py-1.5 text-sm bg-pink-500 hover:bg-pink-400 disabled:bg-gray-700 disabled:text-gray-500 text-black font-semibold rounded-lg transition-colors whitespace-nowrap"
        >
          {running ? 'Starting…' : 'Start season'}
        </button>
      )}
    </div>
  )
}

function StaticStep({
  n,
  done,
  title,
  description,
  cta,
  href,
}: {
  n: number
  done: boolean
  title: string
  description: string
  cta: string
  href: string
}) {
  return (
    <div className="p-5 flex items-start gap-4">
      <StepNumber n={n} done={done} />
      <div className="flex-1 min-w-0">
        <div className="font-semibold text-white">{title}</div>
        <p className="text-sm text-gray-400 mt-1">{description}</p>
      </div>
      <Link
        to={href}
        className="flex-shrink-0 px-3 py-1.5 text-sm bg-green-500 hover:bg-green-400 text-black font-semibold rounded-lg transition-colors whitespace-nowrap"
      >
        {cta}
      </Link>
    </div>
  )
}

function StepNumber({ n, done }: { n: number; done: boolean }) {
  if (done) {
    return (
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-400/15 border-2 border-green-400 flex items-center justify-center text-green-400 font-bold text-sm">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M16.704 5.29a1 1 0 0 1 .006 1.414l-7.5 7.6a1 1 0 0 1-1.42.005l-4-4a1 1 0 1 1 1.414-1.414l3.29 3.29 6.793-6.889a1 1 0 0 1 1.417-.006Z"
            clipRule="evenodd"
          />
        </svg>
        <span className="sr-only">Step {n} complete</span>
      </div>
    )
  }
  return (
    <div className="flex-shrink-0 w-8 h-8 rounded-full border-2 border-gray-700 flex items-center justify-center text-gray-500 font-bold text-sm">
      {n}
    </div>
  )
}

