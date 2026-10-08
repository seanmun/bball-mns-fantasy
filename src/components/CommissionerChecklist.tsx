import { sport } from '../lib/sport/index'
import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useApi } from '../hooks/useApi'
import { type League } from '../types/league'
import type { LeagueSetup } from '../types/leagueConfig'

interface SetupStatus {
  teamsCount: number
  playersPoolCount: number
  playersAssignedCount: number
  keepersLocked: boolean
  rookiePicksCount: number
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

  const showAssign = setup.rosterSource === 'import'
  const showKeepers =
    setup.entryPhase === 'rookie_draft' || setup.entryPhase === 'keeper_season'
  const showDraft = setup.entryPhase !== 'regular_season'

  const doneTeams = (status?.teamsCount ?? 0) > 0
  const doneAssign = (status?.playersAssignedCount ?? 0) > 0
  const doneKeepers = !!status?.keepersLocked && (status?.rookiePicksCount ?? 0) > 0
  const doneDraft = !!status?.draftStatus && status.draftStatus !== 'setup'
  const seasonStarted = !!status?.seasonStarted

  let n = 0
  const num = () => ++n

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Commissioner setup</h2>
        {!seasonStarted ? (
          <button onClick={() => setChanging(true)} className="text-sm text-gray-400 hover:text-white">
            Change starting point
          </button>
        ) : null}
        <Link to={`/league/${leagueId}/lm`} className="text-sm text-green-400 hover:text-green-300">
          Commissioner tools →
        </Link>
      </div>
      <div className="bg-mns-card border border-gray-800 rounded-lg divide-y divide-gray-800">
        <StaticStep
          n={num()}
          done={doneTeams}
          title="Add teams"
          description={
            doneTeams
              ? `${status?.teamsCount} team${status?.teamsCount === 1 ? '' : 's'} in this league.`
              : 'Create 4-12 teams and invite owners by email.'
          }
          cta={doneTeams ? 'Manage teams' : 'Add teams'}
          href={`/league/${leagueId}/lm/teams`}
        />
        <StaticStep
          n={num()}
          done={false}
          title="League settings"
          description={`Override cap, fees, schedule, scoring — anything from the ${sport.leagueLabel} preset.`}
          cta="League settings"
          href={`/league/${leagueId}/lm/league`}
        />
        {showAssign && (
          <StaticStep
            n={num()}
            done={doneAssign}
            title="Assign players to teams"
            description={
              doneAssign
                ? `${status?.playersAssignedCount} player${status?.playersAssignedCount === 1 ? '' : 's'} assigned to teams.`
                : 'Search players from the pool, pick their team, set their prior keeper round.'
            }
            cta="Manage rosters"
            href={`/league/${leagueId}/lm/rosters`}
          />
        )}
        {showKeepers && (
          <StaticStep
            n={num()}
            done={doneKeepers}
            title={
              setup.entryPhase === 'keeper_season'
                ? 'Lock keepers, record rookie picks'
                : 'Lock keepers, set rookie picks'
            }
            description={
              setup.entryPhase === 'keeper_season'
                ? 'Record the rookie draft results, then lock the keeper phase once owners submit.'
                : 'Once owners submit, lock the keeper phase. Assign rookie draft picks.'
            }
            cta="Rookie picks"
            href={`/league/${leagueId}/lm/rookie-picks`}
          />
        )}
        {showDraft && (
          <StaticStep
            n={num()}
            done={doneDraft}
            title="Set up the draft"
            description={
              doneDraft
                ? `Draft status: ${status?.draftStatus}.`
                : 'Configure draft order, slot keeper picks into rounds, start the draft.'
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
            onSeasonStarted()
            void refresh()
          }}
        />
      </div>
      <p className="mt-3 text-xs text-gray-500">
        League ID: <code className="text-gray-400">{leagueId}</code>
      </p>
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
          config: { ...league.config, setup: scenario.setup },
        }),
      })
      onSaved(scenario.setup)
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

